//! Jetstream consumers, on the `network.bsky.jetstream.subscribeEvents`
//! endpoint. Each subscription resumes from its own stored cursor after
//! restarts and disconnects.

use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

use crate::atproto::{FOLLOW, RECORDING};
use crate::indexer::{AccountEvent, Commit, Event, IdentityEvent, Indexer};

const ENDPOINT: &str = "xrpc/network.bsky.jetstream.subscribeEvents";
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// How often the cursor is saved while only skipped events arrive. Replaying
/// a few seconds of skipped events after a restart is harmless.
const SKIPPED_CURSOR_INTERVAL: Duration = Duration::from_secs(2);

pub struct Subscription {
    pub name: &'static str,
    pub collections: &'static [&'static str],
    /// Event kinds to receive. A collection filter only applies to commits;
    /// identity and account events for the whole network arrive unless kinds
    /// excludes them.
    pub kinds: &'static [&'static str],
}

// Both subscriptions only carry changes: with no stored cursor they start
// live. History comes from members' PDSes (backfill on discovery, and the
// refresh the frontend requests at sign-in), never from replaying Jetstream,
// whose archive is short and slow to scan.

pub const RECORDINGS: Subscription = Subscription {
    name: "recordings",
    collections: &[RECORDING],
    kinds: &["commit"],
};

/// Also carries identity and account events, for members' handle changes and
/// account deletion.
pub const FOLLOWS: Subscription = Subscription {
    name: "follows",
    collections: &[FOLLOW],
    kinds: &["commit", "identity", "account"],
};

impl Subscription {
    pub fn cursor_key(&self) -> String {
        format!("jetstream_cursor:{}", self.name)
    }
}

pub async fn run(base_url: String, indexer: Indexer, subscription: Subscription) {
    let mut backoff = Duration::from_secs(1);
    loop {
        let result = consume(&base_url, &indexer, &subscription, &mut backoff).await;
        metrics::gauge!("jetstream_connected", "subscription" => subscription.name).set(0.0);
        let reason = match &result {
            Ok(()) => "closed",
            Err(err) if is_cursor_too_old(err) => "cursor_too_old",
            Err(_) => "error",
        };
        metrics::counter!("jetstream_reconnects_total", "subscription" => subscription.name, "reason" => reason).increment(1);
        match result {
            Ok(()) => warn!(subscription = subscription.name, "jetstream closed the connection"),
            Err(err) if is_cursor_too_old(&err) => {
                // The stored cursor fell out of Jetstream's lookback window
                // (e.g. the backend was down for a long time). Go live; members
                // heal from their PDSes when they next sign in.
                warn!(subscription = subscription.name, error = %err, "stored cursor is too old; resuming live, events in the gap are skipped");
                if let Err(err) = indexer.clear_cursor(&subscription.cursor_key()).await {
                    warn!(subscription = subscription.name, error = %err, "clearing cursor failed");
                }
                continue;
            }
            Err(err) => warn!(subscription = subscription.name, error = %err, "jetstream connection failed"),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

async fn consume(base_url: &str, indexer: &Indexer, subscription: &Subscription, backoff: &mut Duration) -> anyhow::Result<()> {
    let cursor_key = subscription.cursor_key();
    let mut params: Vec<String> = subscription.collections.iter().map(|c| format!("collections={c}")).collect();
    params.extend(subscription.kinds.iter().map(|k| format!("kinds={k}")));
    if let Some(cursor) = indexer.cursor(&cursor_key).await? {
        params.push(format!("cursor={cursor}"));
    }
    let url = format!("{}/{ENDPOINT}?{}", base_url.trim_end_matches('/'), params.join("&"));
    let (mut stream, _) = tokio_tungstenite::connect_async(&url).await?;
    info!(target: "lifecycle", subscription = subscription.name, %url, "subscribed to jetstream");
    metrics::gauge!("jetstream_connected", "subscription" => subscription.name).set(1.0);
    *backoff = Duration::from_secs(1);

    // Cursor of the newest skipped event not yet saved.
    let mut unsaved: Option<i64> = None;
    let mut last_save = Instant::now();
    while let Some(message) = stream.next().await {
        let text = match message? {
            Message::Text(text) => text,
            Message::Close(_) => return Ok(()),
            _ => continue,
        };
        let (event, time) = match parse(&text) {
            Ok(Some(parsed)) => parsed,
            Ok(None) => continue,
            Err(err) => {
                warn!(error = %err, "skipping unparseable jetstream message");
                continue;
            }
        };
        debug!(subscription = subscription.name, did = %event.did, kind = %event.kind, cursor = ?event.cursor, "event");
        // A database error ends the connection; reconnecting resumes from the
        // last saved cursor, so the event is retried.
        if let Some(time) = time.as_deref().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()) {
            let lag = chrono::Utc::now().signed_duration_since(time).num_milliseconds() as f64 / 1000.0;
            metrics::gauge!("jetstream_lag_seconds", "subscription" => subscription.name).set(lag.max(0.0));
        }
        let applied = indexer.handle(&event, &cursor_key).await?;
        let outcome = if applied { "applied" } else { "skipped" };
        metrics::counter!("jetstream_events_total", "subscription" => subscription.name, "outcome" => outcome).increment(1);
        if applied {
            unsaved = None; // handle() saved the cursor with its writes
        } else if let Some(cursor) = event.cursor {
            unsaved = Some(cursor);
        }
        if let Some(cursor) = unsaved {
            if last_save.elapsed() >= SKIPPED_CURSOR_INTERVAL {
                indexer.save_cursor(&cursor_key, cursor).await?;
                unsaved = None;
                last_save = Instant::now();
            }
        }
    }
    Ok(())
}

/// Jetstream refuses a cursor below its lookback floor during the handshake:
/// HTTP 400 with `{"error":"CursorTooOld",...}`.
fn is_cursor_too_old(err: &anyhow::Error) -> bool {
    use tokio_tungstenite::tungstenite::Error;
    matches!(
        err.downcast_ref::<Error>(),
        Some(Error::Http(response)) if response.status() == 400
            && response.body().as_deref().is_some_and(|b| String::from_utf8_lossy(b).contains("CursorTooOld"))
    )
}

#[derive(Deserialize)]
struct Envelope {
    #[serde(rename = "$type")]
    kind: String,
    payload: Option<Value>,
}

/// A subscribeEvents payload: `#commit`, `#identity`, `#account` or `#sync`.
#[derive(Deserialize)]
struct Payload {
    #[serde(rename = "$type")]
    kind: String,
    did: String,
    seq: Option<i64>,
    time: Option<String>,
    operation: Option<String>,
    collection: Option<String>,
    rkey: Option<String>,
    record: Option<Value>,
    cid: Option<String>,
    identity: Option<IdentityEvent>,
    account: Option<AccountEvent>,
}

/// Converts a subscribeEvents message into an indexer event and the time
/// Jetstream received it (RFC 3339). Non-event messages yield None.
fn parse(text: &str) -> anyhow::Result<Option<(Event, Option<String>)>> {
    let envelope: Envelope = serde_json::from_str(text)?;
    let Some(payload) = envelope.payload.filter(|_| envelope.kind == "message") else {
        return Ok(None);
    };
    let p: Payload = serde_json::from_value(payload)?;
    let kind = p.kind.rsplit('#').next().unwrap_or_default().to_owned();
    let commit = match (kind.as_str(), p.operation, p.collection, p.rkey) {
        ("commit", Some(operation), Some(collection), Some(rkey)) => Some(Commit { operation, collection, rkey, record: p.record, cid: p.cid }),
        _ => None,
    };
    Ok(Some((Event { did: p.did, cursor: p.seq, kind, commit, identity: p.identity, account: p.account }, p.time)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_subscribe_events_messages() {
        let commit = parse(r#"{"$type":"message","payload":{"$type":"network.bsky.jetstream.subscribeEvents#commit","cid":"bafy","collection":"club.voicebook.recording","did":"did:plc:a","operation":"create","record":{"work":"x"},"rev":"r","rkey":"k","seq":14,"time":"t"}}"#)
            .unwrap()
            .unwrap()
            .0;
        assert_eq!((commit.kind.as_str(), commit.cursor), ("commit", Some(14)));
        let c = commit.commit.unwrap();
        assert_eq!((c.operation.as_str(), c.collection.as_str(), c.rkey.as_str()), ("create", RECORDING, "k"));

        let delete = parse(r#"{"$type":"message","payload":{"$type":"network.bsky.jetstream.subscribeEvents#commit","collection":"app.bsky.graph.follow","did":"did:plc:a","operation":"delete","rev":"r","rkey":"k","seq":20}}"#)
            .unwrap()
            .unwrap()
            .0;
        assert!(delete.commit.unwrap().record.is_none());

        let account = parse(r#"{"$type":"message","payload":{"$type":"network.bsky.jetstream.subscribeEvents#account","account":{"active":false,"did":"did:plc:a","seq":2,"status":"deleted"},"did":"did:plc:a","seq":2}}"#)
            .unwrap()
            .unwrap()
            .0;
        assert_eq!(account.kind, "account");
        assert_eq!(account.account.unwrap().status.as_deref(), Some("deleted"));

        assert!(parse(r#"{"$type":"info","name":"OutdatedCursor"}"#).unwrap().is_none());
    }
}
