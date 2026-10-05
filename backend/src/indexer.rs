//! Applies Jetstream events and PDS backfills to the SQLite index.
//!
//! Every write is idempotent (upserts keyed by AT URI or follow rkey) because
//! Jetstream delivery is at-least-once and its cursor is inclusive.

use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;
use sqlx::{SqlitePool, Sqlite, Transaction};
use tracing::{info, warn};

use crate::atproto::{self, FOLLOW, RECORDING, Record};

const CURSOR_KEY: &str = "jetstream_cursor";

#[derive(Debug, Deserialize)]
pub struct Event {
    pub did: String,
    pub cursor: Option<i64>,
    pub kind: String,
    pub commit: Option<Commit>,
    pub identity: Option<IdentityEvent>,
    pub account: Option<AccountEvent>,
}

#[derive(Debug, Deserialize)]
pub struct Commit {
    pub operation: String,
    pub collection: String,
    pub rkey: String,
    pub record: Option<Value>,
    pub cid: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct IdentityEvent {
    pub handle: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AccountEvent {
    pub active: bool,
    pub status: Option<String>,
}

/// The fields of a club.voicebook.recording record the index needs.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingRecord {
    created_at: String,
    work: String,
    chapter: Option<String>,
    duration_ms: Option<i64>,
    notes: Option<String>,
    audio: BlobRef,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlobRef {
    #[serde(rename = "ref")]
    link: Link,
    mime_type: Option<String>,
    size: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct Link {
    #[serde(rename = "$link")]
    cid: String,
}

#[derive(Debug, Deserialize)]
struct FollowRecord {
    subject: String,
}

/// A member's full repo state as fetched from their PDS.
struct Snapshot {
    identity: Option<atproto::Identity>,
    recordings: Vec<Record>,
    follows: Vec<Record>,
}

#[derive(Clone)]
pub struct Indexer {
    db: SqlitePool,
    client: atproto::Client,
}

impl Indexer {
    pub fn new(db: SqlitePool, client: atproto::Client) -> Self {
        Self { db, client }
    }

    pub async fn cursor(&self) -> Result<Option<i64>> {
        let value: Option<String> = sqlx::query_scalar("SELECT value FROM state WHERE key = ?")
            .bind(CURSOR_KEY)
            .fetch_optional(&self.db)
            .await?;
        Ok(value.and_then(|v| v.parse().ok()))
    }

    /// Applies one event and advances the cursor in the same transaction.
    pub async fn handle(&self, event: &Event) -> Result<()> {
        // Network work happens before the transaction opens.
        let snapshot = if self.is_new_member(event).await? {
            Some(self.fetch_snapshot(&event.did).await)
        } else {
            None
        };

        let mut tx = self.db.begin().await?;
        if let Some(snapshot) = snapshot {
            info!(did = %event.did, recordings = snapshot.recordings.len(), follows = snapshot.follows.len(), "new member");
            apply_snapshot(&mut tx, &event.did, &snapshot).await?;
        }
        match event.kind.as_str() {
            "commit" => {
                if let Some(commit) = &event.commit {
                    apply_commit(&mut tx, &event.did, commit).await?;
                }
            }
            "identity" => {
                if is_member(&mut tx, &event.did).await? {
                    let handle = event.identity.as_ref().and_then(|i| i.handle.clone());
                    // The DID document may have changed too (e.g. a PDS move).
                    let pds_url = match self.client.resolve(&event.did).await {
                        Ok(identity) => Some(identity.pds_url),
                        Err(err) => {
                            warn!(did = %event.did, error = %err, "re-resolving identity failed");
                            None
                        }
                    };
                    sqlx::query(
                        "UPDATE members SET handle = coalesce(?, handle), pds_url = coalesce(?, pds_url) WHERE did = ?",
                    )
                    .bind(handle)
                    .bind(pds_url)
                    .bind(&event.did)
                    .execute(&mut *tx)
                    .await?;
                }
            }
            "account" => {
                if let Some(account) = &event.account {
                    if account.status.as_deref() == Some("deleted") {
                        // Cascades to recordings and follows.
                        let deleted = sqlx::query("DELETE FROM members WHERE did = ?")
                            .bind(&event.did)
                            .execute(&mut *tx)
                            .await?;
                        if deleted.rows_affected() > 0 {
                            info!(did = %event.did, "member account deleted; purged");
                        }
                    } else {
                        sqlx::query("UPDATE members SET active = ? WHERE did = ?")
                            .bind(account.active)
                            .bind(&event.did)
                            .execute(&mut *tx)
                            .await?;
                    }
                }
            }
            _ => {}
        }
        if let Some(cursor) = event.cursor {
            sqlx::query("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
                .bind(CURSOR_KEY)
                .bind(cursor.to_string())
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Re-fetches every member's recordings and follows from their PDS and
    /// replaces what the index holds for them.
    pub async fn reindex_all(&self) -> Result<usize> {
        let dids: Vec<String> = sqlx::query_scalar("SELECT did FROM members").fetch_all(&self.db).await?;
        for did in &dids {
            let snapshot = self.fetch_snapshot(did).await;
            let mut tx = self.db.begin().await?;
            apply_snapshot(&mut tx, did, &snapshot).await?;
            tx.commit().await?;
        }
        info!(members = dids.len(), "reindex complete");
        Ok(dids.len())
    }

    /// Fetches the DIDs `did` follows: from the index for members, otherwise
    /// live from their PDS.
    pub async fn follows_of(&self, did: &str) -> Result<Vec<String>> {
        let member: Option<i64> = sqlx::query_scalar("SELECT 1 FROM members WHERE did = ?")
            .bind(did)
            .fetch_optional(&self.db)
            .await?;
        if member.is_some() {
            return Ok(sqlx::query_scalar("SELECT DISTINCT subject_did FROM follows WHERE actor_did = ?")
                .bind(did)
                .fetch_all(&self.db)
                .await?);
        }
        let identity = self.client.resolve(did).await?;
        let follows = self.client.list_records(&identity.pds_url, did, FOLLOW).await?;
        Ok(follows
            .iter()
            .filter_map(|r| serde_json::from_value::<FollowRecord>(r.value.clone()).ok())
            .map(|f| f.subject)
            .collect())
    }

    /// A recording create from an account not yet in `members`.
    async fn is_new_member(&self, event: &Event) -> Result<bool> {
        let Some(commit) = &event.commit else { return Ok(false) };
        if commit.collection != RECORDING || commit.operation == "delete" {
            return Ok(false);
        }
        let valid = commit
            .record
            .as_ref()
            .is_some_and(|r| serde_json::from_value::<RecordingRecord>(r.clone()).is_ok());
        if !valid {
            return Ok(false);
        }
        let mut conn = self.db.acquire().await?;
        Ok(!is_member(&mut conn, &event.did).await?)
    }

    /// Fetches a member's identity, recordings and follows. Failures are
    /// logged and yield a partial snapshot: a broken PDS must not stall the
    /// stream, and a later reindex fills the gaps.
    async fn fetch_snapshot(&self, did: &str) -> Snapshot {
        let identity = match self.client.resolve(did).await {
            Ok(identity) => Some(identity),
            Err(err) => {
                warn!(did, error = %err, "resolving new member failed");
                None
            }
        };
        let mut snapshot = Snapshot { identity, recordings: Vec::new(), follows: Vec::new() };
        let Some(pds) = snapshot.identity.as_ref().map(|i| i.pds_url.clone()) else {
            return snapshot;
        };
        for (collection, out) in [(RECORDING, &mut snapshot.recordings), (FOLLOW, &mut snapshot.follows)] {
            match self.client.list_records(&pds, did, collection).await {
                Ok(records) => *out = records,
                Err(err) => warn!(did, collection, error = %err, "backfill failed"),
            }
        }
        snapshot
    }
}

async fn is_member(conn: &mut sqlx::SqliteConnection, did: &str) -> Result<bool> {
    let found: Option<i64> = sqlx::query_scalar("SELECT 1 FROM members WHERE did = ?")
        .bind(did)
        .fetch_optional(conn)
        .await?;
    Ok(found.is_some())
}

async fn apply_snapshot(tx: &mut Transaction<'_, Sqlite>, did: &str, snapshot: &Snapshot) -> Result<()> {
    let handle = snapshot.identity.as_ref().and_then(|i| i.handle.clone());
    let pds_url = snapshot.identity.as_ref().map(|i| i.pds_url.clone());
    let complete = snapshot.identity.is_some();
    sqlx::query(
        "INSERT INTO members (did, handle, pds_url, discovered_at, backfilled_at)
         VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ'), CASE WHEN ?4 THEN strftime('%Y-%m-%dT%H:%M:%fZ') END)
         ON CONFLICT (did) DO UPDATE SET
           handle = coalesce(excluded.handle, handle),
           pds_url = coalesce(excluded.pds_url, pds_url),
           backfilled_at = coalesce(excluded.backfilled_at, backfilled_at)",
    )
    .bind(did)
    .bind(handle)
    .bind(pds_url)
    .bind(complete)
    .execute(&mut **tx)
    .await?;
    if !complete {
        return Ok(());
    }
    // Replace rather than merge, so records deleted while we weren't looking
    // disappear too.
    sqlx::query("DELETE FROM recordings WHERE did = ?").bind(did).execute(&mut **tx).await?;
    sqlx::query("DELETE FROM follows WHERE actor_did = ?").bind(did).execute(&mut **tx).await?;
    for record in &snapshot.recordings {
        if let Some((_, _, rkey)) = atproto::parse_at_uri(&record.uri) {
            upsert_recording(tx, did, rkey, &record.cid, &record.value).await?;
        }
    }
    for record in &snapshot.follows {
        if let Some((_, _, rkey)) = atproto::parse_at_uri(&record.uri) {
            upsert_follow(tx, did, rkey, &record.value).await?;
        }
    }
    Ok(())
}

async fn apply_commit(tx: &mut Transaction<'_, Sqlite>, did: &str, commit: &Commit) -> Result<()> {
    let upsert = matches!(commit.operation.as_str(), "create" | "update");
    match commit.collection.as_str() {
        RECORDING => match (&commit.record, &commit.cid) {
            (Some(record), Some(cid)) if upsert => upsert_recording(tx, did, &commit.rkey, cid, record).await,
            _ if commit.operation == "delete" => {
                sqlx::query("DELETE FROM recordings WHERE did = ? AND rkey = ?")
                    .bind(did)
                    .bind(&commit.rkey)
                    .execute(&mut **tx)
                    .await?;
                Ok(())
            }
            _ => Ok(()),
        },
        FOLLOW if is_member(tx, did).await? => match &commit.record {
            Some(record) if upsert => upsert_follow(tx, did, &commit.rkey, record).await,
            _ if commit.operation == "delete" => {
                sqlx::query("DELETE FROM follows WHERE actor_did = ? AND rkey = ?")
                    .bind(did)
                    .bind(&commit.rkey)
                    .execute(&mut **tx)
                    .await?;
                Ok(())
            }
            _ => Ok(()),
        },
        _ => Ok(()),
    }
}

async fn upsert_recording(tx: &mut Transaction<'_, Sqlite>, did: &str, rkey: &str, cid: &str, value: &Value) -> Result<()> {
    let uri = format!("at://{did}/{RECORDING}/{rkey}");
    let record: RecordingRecord = match serde_json::from_value(value.clone()) {
        Ok(record) => record,
        Err(err) => {
            warn!(%uri, error = %err, "skipping invalid recording record");
            return Ok(());
        }
    };
    // Normalizes any RFC 3339 offset to UTC; NULL means unparseable.
    let created_at: Option<String> = sqlx::query_scalar("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?)")
        .bind(&record.created_at)
        .fetch_one(&mut **tx)
        .await?;
    let Some(created_at) = created_at else {
        warn!(%uri, created_at = record.created_at, "skipping recording with invalid createdAt");
        return Ok(());
    };
    sqlx::query(
        "INSERT INTO recordings (uri, did, rkey, cid, created_at, work, chapter, duration_ms, notes, blob_cid, mime_type, size_bytes, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ'))
         ON CONFLICT (uri) DO UPDATE SET
           cid = excluded.cid, created_at = excluded.created_at, work = excluded.work,
           chapter = excluded.chapter, duration_ms = excluded.duration_ms, notes = excluded.notes,
           blob_cid = excluded.blob_cid, mime_type = excluded.mime_type,
           size_bytes = excluded.size_bytes, indexed_at = excluded.indexed_at",
    )
    .bind(&uri)
    .bind(did)
    .bind(rkey)
    .bind(cid)
    .bind(created_at)
    .bind(&record.work)
    .bind(&record.chapter)
    .bind(record.duration_ms)
    .bind(&record.notes)
    .bind(&record.audio.link.cid)
    .bind(&record.audio.mime_type)
    .bind(record.audio.size)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn upsert_follow(tx: &mut Transaction<'_, Sqlite>, did: &str, rkey: &str, value: &Value) -> Result<()> {
    let Ok(follow) = serde_json::from_value::<FollowRecord>(value.clone()) else {
        warn!(did, rkey, "skipping invalid follow record");
        return Ok(());
    };
    sqlx::query(
        "INSERT INTO follows (actor_did, rkey, subject_did) VALUES (?, ?, ?)
         ON CONFLICT (actor_did, rkey) DO UPDATE SET subject_did = excluded.subject_did",
    )
    .bind(did)
    .bind(rkey)
    .bind(&follow.subject)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    const ALICE: &str = "did:plc:alice";
    const BOB: &str = "did:plc:bob";

    async fn indexer() -> Indexer {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys = ON").execute(&db).await.unwrap();
        sqlx::migrate!().run(&db).await.unwrap();
        // Nothing listens here: discovery's backfill fails fast and the
        // member is recorded without a snapshot.
        Indexer::new(db, atproto::Client::new("http://127.0.0.1:1"))
    }

    fn event(value: serde_json::Value) -> Event {
        serde_json::from_value(value).unwrap()
    }

    fn recording(did: &str, cursor: i64, rkey: &str, created_at: &str) -> Event {
        event(json!({
            "did": did, "cursor": cursor, "kind": "commit",
            "commit": {
                "operation": "create", "collection": RECORDING, "rkey": rkey, "cid": "bafyrecord",
                "record": {
                    "$type": RECORDING, "createdAt": created_at, "work": "Pride and Prejudice", "chapter": "3",
                    "durationMs": 1000,
                    "audio": {"$type": "blob", "ref": {"$link": "bafkblob"}, "mimeType": "audio/ogg", "size": 10}
                }
            }
        }))
    }

    fn follow(did: &str, cursor: i64, operation: &str, rkey: &str, subject: &str) -> Event {
        let record = (operation != "delete").then(|| json!({"$type": FOLLOW, "subject": subject, "createdAt": "2026-10-05T00:00:00Z"}));
        event(json!({
            "did": did, "cursor": cursor, "kind": "commit",
            "commit": {"operation": operation, "collection": FOLLOW, "rkey": rkey, "cid": "bafyfollow", "record": record}
        }))
    }

    async fn count(indexer: &Indexer, sql: &str) -> i64 {
        sqlx::query_scalar(sql).fetch_one(&indexer.db).await.unwrap()
    }

    #[tokio::test]
    async fn first_recording_makes_a_member_and_replay_is_idempotent() {
        let ix = indexer().await;
        let create = recording(ALICE, 7, "r1", "2026-10-05T09:00:00+02:00");
        ix.handle(&create).await.unwrap();
        ix.handle(&create).await.unwrap();
        assert_eq!(count(&ix, "SELECT count(*) FROM members").await, 1);
        assert_eq!(count(&ix, "SELECT count(*) FROM recordings").await, 1);
        let created_at: String = sqlx::query_scalar("SELECT created_at FROM recordings").fetch_one(&ix.db).await.unwrap();
        assert_eq!(created_at, "2026-10-05T07:00:00.000Z", "normalized to UTC");
        assert_eq!(ix.cursor().await.unwrap(), Some(7));
    }

    #[tokio::test]
    async fn follows_are_kept_only_for_members() {
        let ix = indexer().await;
        ix.handle(&follow(BOB, 1, "create", "f1", ALICE)).await.unwrap();
        assert_eq!(count(&ix, "SELECT count(*) FROM follows").await, 0, "bob isn't a member");

        ix.handle(&recording(ALICE, 2, "r1", "2026-10-05T09:00:00Z")).await.unwrap();
        ix.handle(&follow(ALICE, 3, "create", "f2", BOB)).await.unwrap();
        assert_eq!(count(&ix, "SELECT count(*) FROM follows").await, 1);

        ix.handle(&follow(ALICE, 4, "delete", "f2", "")).await.unwrap();
        assert_eq!(count(&ix, "SELECT count(*) FROM follows").await, 0);
    }

    #[tokio::test]
    async fn recording_delete_and_account_deletion() {
        let ix = indexer().await;
        ix.handle(&recording(ALICE, 1, "r1", "2026-10-05T09:00:00Z")).await.unwrap();
        ix.handle(&recording(ALICE, 2, "r2", "2026-10-06T09:00:00Z")).await.unwrap();
        ix.handle(&follow(ALICE, 3, "create", "f1", BOB)).await.unwrap();

        ix.handle(&event(json!({
            "did": ALICE, "cursor": 4, "kind": "commit",
            "commit": {"operation": "delete", "collection": RECORDING, "rkey": "r1"}
        })))
        .await
        .unwrap();
        assert_eq!(count(&ix, "SELECT count(*) FROM recordings").await, 1);

        ix.handle(&event(json!({"did": ALICE, "cursor": 5, "kind": "account", "account": {"active": false, "status": "deactivated"}})))
            .await
            .unwrap();
        assert_eq!(count(&ix, "SELECT active FROM members").await, 0);

        ix.handle(&event(json!({"did": ALICE, "cursor": 6, "kind": "account", "account": {"active": false, "status": "deleted"}})))
            .await
            .unwrap();
        assert_eq!(count(&ix, "SELECT count(*) FROM members").await, 0);
        assert_eq!(count(&ix, "SELECT count(*) FROM recordings").await, 0);
        assert_eq!(count(&ix, "SELECT count(*) FROM follows").await, 0);
    }

    #[tokio::test]
    async fn invalid_records_are_skipped_but_advance_the_cursor() {
        let ix = indexer().await;
        ix.handle(&recording(ALICE, 1, "r1", "not a date")).await.unwrap();
        ix.handle(&event(json!({
            "did": ALICE, "cursor": 2, "kind": "commit",
            "commit": {"operation": "create", "collection": RECORDING, "rkey": "r2", "cid": "bafy", "record": {"work": "no audio"}}
        })))
        .await
        .unwrap();
        assert_eq!(count(&ix, "SELECT count(*) FROM recordings").await, 0);
        assert_eq!(count(&ix, "SELECT count(*) FROM members").await, 1, "a well-formed record with a bad date still counts");
        assert_eq!(ix.cursor().await.unwrap(), Some(2));
    }
}
