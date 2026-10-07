mod api;
mod atproto;
mod config;
mod indexer;
mod jetstream;
mod telemetry;
mod web;

use std::time::Duration;

use anyhow::{Context, Result};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use tower_http::cors::CorsLayer;
use tracing::{error, info, warn};

use crate::config::Config;
use crate::indexer::Indexer;

#[tokio::main]
async fn main() {
    // Nothing is set up to report errors yet, so this one goes straight to stderr.
    let config = match Config::from_args() {
        Ok(config) => config,
        Err(err) => {
            eprintln!("{{\"level\":\"ERROR\",\"target\":\"lifecycle\",\"message\":\"invalid configuration\",\"error\":{:?}}}", format!("{err:#}"));
            std::process::exit(2);
        }
    };
    let telemetry = match telemetry::init(&config) {
        Ok(telemetry) => telemetry,
        Err(err) => {
            eprintln!("{{\"level\":\"ERROR\",\"target\":\"lifecycle\",\"message\":\"telemetry setup failed\",\"error\":{:?}}}", format!("{err:#}"));
            std::process::exit(2);
        }
    };
    let result = run(config, &telemetry).await;
    if let Err(err) = &result {
        error!(target: "lifecycle", error = %format!("{err:#}"), "backend failed");
    }
    info!(target: "lifecycle", "stopped");
    drop(telemetry); // flush OTLP before exiting
    std::process::exit(if result.is_ok() { 0 } else { 1 });
}

async fn run(config: Config, telemetry: &telemetry::Telemetry) -> Result<()> {
    info!(
        target: "lifecycle",
        environment = %config.environment,
        bind = %config.bind,
        database = %config.database.display(),
        plc_url = %config.plc_url,
        jetstream_url = %config.jetstream_url,
        otlp_endpoint = config.telemetry.otlp_endpoint.as_deref().unwrap_or("disabled"),
        "starting"
    );
    // reqwest and tokio-tungstenite each enable a different rustls crypto
    // backend; with both present rustls needs one chosen explicitly.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    let options = SqliteConnectOptions::new()
        .filename(&config.database)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        // Safe with WAL (a crash can lose the last commits, never corrupt);
        // the cursor makes lost commits replay.
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true);
    if let Some(dir) = options.get_filename().parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let db = SqlitePoolOptions::new().connect_with(options).await?;
    sqlx::migrate!().run(&db).await?;

    let indexer = Indexer::new(db.clone(), atproto::Client::new(&config.plc_url));
    for subscription in [jetstream::RECORDINGS, jetstream::FOLLOWS] {
        tokio::spawn(jetstream::run(config.jetstream_url.clone(), indexer.clone(), subscription));
    }
    tokio::spawn(record_index_sizes(db.clone()));

    let state = api::AppState { db, indexer, metrics: telemetry.metrics.clone(), public_url: config.public_url.clone() };
    if let Some(addr) = config.metrics_bind {
        let listener = tokio::net::TcpListener::bind(addr).await.with_context(|| format!("binding metrics listener {addr}"))?;
        info!(target: "lifecycle", %addr, "serving metrics");
        let metrics = api::metrics_router(state.clone());
        tokio::spawn(async move { axum::serve(listener, metrics).await });
    }
    let options = api::RouterOptions { metrics: config.metrics_bind.is_none(), frontend_dir: config.frontend_dir.clone() };
    // Local development only: the frontend runs on its own dev-server port.
    // Deployed, the frontend is same-origin and CORS doesn't come into play.
    let app = api::router(state, options).layer(CorsLayer::permissive());
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    info!(target: "lifecycle", addr = %config.bind, "listening");
    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate.recv() => {}
    }
    info!(target: "lifecycle", "shutting down");
}

/// Keeps the index-size gauges current.
async fn record_index_sizes(db: SqlitePool) {
    let mut interval = tokio::time::interval(Duration::from_secs(15));
    loop {
        interval.tick().await;
        let counts: Result<(i64, i64, i64), sqlx::Error> = sqlx::query_as(
            "SELECT (SELECT count(*) FROM members), (SELECT count(*) FROM recordings), (SELECT count(*) FROM follows)",
        )
        .fetch_one(&db)
        .await;
        match counts {
            Ok((members, recordings, follows)) => {
                metrics::gauge!("index_members").set(members as f64);
                metrics::gauge!("index_recordings").set(recordings as f64);
                metrics::gauge!("index_follows").set(follows as f64);
            }
            Err(err) => warn!(error = %err, "counting index rows failed"),
        }
    }
}
