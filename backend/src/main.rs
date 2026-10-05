mod api;
mod atproto;
mod config;
mod indexer;
mod jetstream;

use std::str::FromStr;

use anyhow::{Context, Result};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::indexer::Indexer;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,sqlx=warn".into()))
        .init();
    let config = Config::from_env()?;

    let options = SqliteConnectOptions::from_str(&config.database_url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true);
    if let Some(dir) = options.get_filename().parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let db = SqlitePoolOptions::new().connect_with(options).await?;
    sqlx::migrate!().run(&db).await?;

    let indexer = Indexer::new(db.clone(), atproto::Client::new(&config.plc_url));
    tokio::spawn(jetstream::run(config.jetstream_url.clone(), indexer.clone()));

    // Local development only: the frontend runs on its own dev-server port.
    let app = api::router(api::AppState { db, indexer })
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    info!(addr = %config.bind, "listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
