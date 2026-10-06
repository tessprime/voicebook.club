//! Read-only JSON API over the index. Everything it serves is public ATProto
//! data, so no endpoint requires authentication.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{FromRow, QueryBuilder, Sqlite, SqlitePool};
use tracing::error;

use crate::atproto;
use crate::indexer::Indexer;
use crate::jetstream;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub indexer: Indexer,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/members", get(members))
        .route("/api/users/{did}/recordings", get(recordings))
        .route("/api/users/{did}/calendar", get(calendar))
        .route("/api/users/{did}/friends/activity", get(friends_activity))
        .route("/api/dev/reindex", post(reindex))
        .with_state(state)
}

pub struct ApiError(anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(err: E) -> Self {
        Self(err.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        error!(error = %format!("{:#}", self.0), "request failed");
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "internal error" }))).into_response()
    }
}

type ApiResult<T> = Result<Json<T>, ApiError>;

async fn health(State(state): State<AppState>) -> ApiResult<serde_json::Value> {
    let mut cursors = serde_json::Map::new();
    for subscription in [jetstream::RECORDINGS, jetstream::FOLLOWS] {
        cursors.insert(subscription.name.into(), json!(state.indexer.cursor(&subscription.cursor_key()).await?));
    }
    Ok(Json(json!({ "ok": true, "jetstreamCursors": cursors })))
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct Member {
    did: String,
    handle: Option<String>,
    active: bool,
    recording_count: i64,
    last_practice_at: Option<String>,
}

async fn members(State(state): State<AppState>) -> ApiResult<Vec<Member>> {
    let rows = sqlx::query_as(
        "SELECT m.did, m.handle, m.active, count(r.uri) AS recording_count, max(r.created_at) AS last_practice_at
         FROM members m LEFT JOIN recordings r ON r.did = m.did
         GROUP BY m.did ORDER BY m.handle",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(FromRow)]
struct RecordingRow {
    uri: String,
    did: String,
    handle: Option<String>,
    pds_url: Option<String>,
    created_at: String,
    work: String,
    chapter: Option<String>,
    duration_ms: Option<i64>,
    notes: Option<String>,
    blob_cid: String,
    mime_type: Option<String>,
    size_bytes: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Recording {
    uri: String,
    did: String,
    handle: Option<String>,
    created_at: String,
    work: String,
    chapter: Option<String>,
    duration_ms: Option<i64>,
    notes: Option<String>,
    mime_type: Option<String>,
    size_bytes: Option<i64>,
    /// Served directly by the author's PDS; the backend never proxies audio.
    audio_url: Option<String>,
}

impl From<RecordingRow> for Recording {
    fn from(row: RecordingRow) -> Self {
        let audio_url = row.pds_url.as_deref().map(|pds| atproto::blob_url(pds, &row.did, &row.blob_cid));
        Self {
            uri: row.uri,
            did: row.did,
            handle: row.handle,
            created_at: row.created_at,
            work: row.work,
            chapter: row.chapter,
            duration_ms: row.duration_ms,
            notes: row.notes,
            mime_type: row.mime_type,
            size_bytes: row.size_bytes,
            audio_url,
        }
    }
}

const RECORDING_COLUMNS: &str = "SELECT r.uri, r.did, m.handle, m.pds_url, r.created_at, r.work, r.chapter, r.duration_ms,
            r.notes, r.blob_cid, r.mime_type, r.size_bytes
     FROM recordings r JOIN members m ON m.did = r.did";

#[derive(Deserialize)]
struct Page {
    limit: Option<i64>,
    /// Only recordings created strictly before this RFC 3339 UTC timestamp.
    before: Option<String>,
}

impl Page {
    fn limit(&self) -> i64 {
        self.limit.unwrap_or(50).clamp(1, 200)
    }
}

async fn recordings(
    State(state): State<AppState>,
    Path(did): Path<String>,
    Query(page): Query<Page>,
) -> ApiResult<Vec<Recording>> {
    let rows: Vec<RecordingRow> = sqlx::query_as(&format!(
        "{RECORDING_COLUMNS} WHERE r.did = ? AND (? IS NULL OR r.created_at < ?) ORDER BY r.created_at DESC LIMIT ?"
    ))
    .bind(&did)
    .bind(&page.before)
    .bind(&page.before)
    .bind(page.limit())
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(Recording::from).collect()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarQuery {
    /// YYYY-MM, in the viewer's local time.
    month: String,
    /// The viewer's UTC offset in minutes (e.g. -420 for UTC-7), so practice
    /// days match their local calendar.
    #[serde(default)]
    tz_offset_minutes: i64,
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
struct PracticeDay {
    date: String,
    recording_count: i64,
    duration_ms: Option<i64>,
}

async fn calendar(
    State(state): State<AppState>,
    Path(did): Path<String>,
    Query(query): Query<CalendarQuery>,
) -> Result<Json<Vec<PracticeDay>>, Response> {
    let valid_month = query.month.len() == 7
        && query.month.as_bytes()[4] == b'-'
        && query.month.chars().enumerate().all(|(i, c)| i == 4 || c.is_ascii_digit());
    if !valid_month || query.tz_offset_minutes.abs() > 14 * 60 {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "expected month=YYYY-MM and |tzOffsetMinutes| <= 840" }))).into_response());
    }
    let shift = format!("{:+} minutes", query.tz_offset_minutes);
    let days = sqlx::query_as(
        "SELECT date(created_at, ?1) AS date, count(*) AS recording_count, sum(duration_ms) AS duration_ms
         FROM recordings
         WHERE did = ?2 AND strftime('%Y-%m', created_at, ?1) = ?3
         GROUP BY 1 ORDER BY 1",
    )
    .bind(&shift)
    .bind(&did)
    .bind(&query.month)
    .fetch_all(&state.db)
    .await
    .map_err(|err| ApiError::from(err).into_response())?;
    Ok(Json(days))
}

async fn friends_activity(
    State(state): State<AppState>,
    Path(did): Path<String>,
    Query(page): Query<Page>,
) -> ApiResult<Vec<Recording>> {
    let follows = state.indexer.follows_of(&did).await?;
    if follows.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let mut query: QueryBuilder<Sqlite> = QueryBuilder::new(RECORDING_COLUMNS);
    query.push(" WHERE m.active = 1 AND r.did IN (");
    let mut dids = query.separated(", ");
    for followed in &follows {
        dids.push_bind(followed);
    }
    query.push(")");
    if let Some(before) = &page.before {
        query.push(" AND r.created_at < ").push_bind(before);
    }
    query.push(" ORDER BY r.created_at DESC LIMIT ").push_bind(page.limit());
    let rows: Vec<RecordingRow> = query.build_query_as().fetch_all(&state.db).await?;
    Ok(Json(rows.into_iter().map(Recording::from).collect()))
}

async fn reindex(State(state): State<AppState>) -> ApiResult<serde_json::Value> {
    let members = state.indexer.reindex_all().await?;
    Ok(Json(json!({ "reindexedMembers": members })))
}
