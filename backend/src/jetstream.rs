//! Jetstream consumers. Each subscription resumes from its own stored cursor
//! after restarts and disconnects.

use std::time::Duration;

use futures_util::StreamExt;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

use crate::atproto::{FOLLOW, RECORDING};
use crate::indexer::{Event, Indexer};

const MAX_BACKOFF: Duration = Duration::from_secs(30);

pub struct Subscription {
    pub name: &'static str,
    pub collections: &'static [&'static str],
    /// With no stored cursor: replay Jetstream's archive (true) or start live.
    pub replay_from_start: bool,
}

/// Voicebook records are rare, so replaying them from the start is cheap and
/// is how a fresh database rediscovers members.
pub const RECORDINGS: Subscription = Subscription {
    name: "recordings",
    collections: &[RECORDING],
    replay_from_start: true,
};

/// Follows are network-wide and huge, so they're only followed live. Members'
/// earlier follows come from the backfill when they're discovered.
pub const FOLLOWS: Subscription = Subscription {
    name: "follows",
    collections: &[FOLLOW],
    replay_from_start: false,
};

impl Subscription {
    pub fn cursor_key(&self) -> String {
        format!("jetstream_cursor:{}", self.name)
    }
}

pub async fn run(base_url: String, indexer: Indexer, subscription: Subscription) {
    let mut backoff = Duration::from_secs(1);
    loop {
        match consume(&base_url, &indexer, &subscription, &mut backoff).await {
            Ok(()) => warn!(subscription = subscription.name, "jetstream closed the connection"),
            Err(err) => warn!(subscription = subscription.name, error = %err, "jetstream connection failed"),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

async fn consume(base_url: &str, indexer: &Indexer, subscription: &Subscription, backoff: &mut Duration) -> anyhow::Result<()> {
    let cursor_key = subscription.cursor_key();
    let mut params: Vec<String> = subscription.collections.iter().map(|c| format!("wantedCollections={c}")).collect();
    match indexer.cursor(&cursor_key).await? {
        Some(cursor) => params.push(format!("cursor={cursor}")),
        None if subscription.replay_from_start => params.push("cursor=0".into()),
        None => {} // no cursor: start live
    }
    let url = format!("{}/subscribe?{}", base_url.trim_end_matches('/'), params.join("&"));
    let (mut stream, _) = tokio_tungstenite::connect_async(&url).await?;
    info!(subscription = subscription.name, %url, "subscribed to jetstream");
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
        debug!(subscription = subscription.name, did = %event.did, kind = %event.kind, cursor = ?event.cursor, "event");
        // A database error ends the connection; reconnecting resumes from the
        // last committed cursor, so the event is retried.
        indexer.handle(&event, &cursor_key).await?;
    }
    Ok(())
}
