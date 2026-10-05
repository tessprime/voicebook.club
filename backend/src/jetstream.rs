//! Jetstream consumer: one subscription for recordings and follows, resumed
//! from the stored cursor after restarts and disconnects.

use std::time::Duration;

use futures_util::StreamExt;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

use crate::atproto::{FOLLOW, RECORDING};
use crate::indexer::{Event, Indexer};

const MAX_BACKOFF: Duration = Duration::from_secs(30);

pub async fn run(base_url: String, indexer: Indexer) {
    let mut backoff = Duration::from_secs(1);
    loop {
        match consume(&base_url, &indexer, &mut backoff).await {
            Ok(()) => warn!("jetstream closed the connection"),
            Err(err) => warn!(error = %err, "jetstream connection failed"),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

async fn consume(base_url: &str, indexer: &Indexer, backoff: &mut Duration) -> anyhow::Result<()> {
    // With no stored cursor, start at 0: Jetstream replays its archive, which
    // is how a fresh database rebuilds itself.
    let cursor = indexer.cursor().await?.unwrap_or(0);
    let url = format!(
        "{}/subscribe?wantedCollections={RECORDING}&wantedCollections={FOLLOW}&cursor={cursor}",
        base_url.trim_end_matches('/')
    );
    let (mut stream, _) = tokio_tungstenite::connect_async(&url).await?;
    info!(%url, "subscribed to jetstream");
    *backoff = Duration::from_secs(1);
    while let Some(message) = stream.next().await {
        let text = match message? {
            Message::Text(text) => text,
            Message::Close(_) => return Ok(()),
            _ => continue,
        };
        let event: Event = match serde_json::from_str(&text) {
            Ok(event) => event,
            Err(err) => {
                warn!(error = %err, "skipping unparseable jetstream event");
                continue;
            }
        };
        debug!(did = %event.did, kind = %event.kind, cursor = ?event.cursor, "event");
        // A database error ends the connection; reconnecting resumes from the
        // last committed cursor, so the event is retried.
        indexer.handle(&event).await?;
    }
    Ok(())
}
