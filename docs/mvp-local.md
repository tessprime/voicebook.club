# Voicebook.club MVP — Local Development Specification

## 1. Scope

This document defines the first local-only MVP for **voicebook.club**.

The goal is to validate the core product and architecture before any production deployment, monitoring, alerts, backups, or hosted infrastructure are added.

The MVP uses:

- **Backend:** Rust (a read-only indexer and query API)
- **Frontend:** TypeScript (owns sign-in and all writes)
- **Primary identity/authentication:** AT Protocol / Bluesky OAuth, performed in the browser
- **Canonical user-owned app data:** ATProto repositories and blobs
- **Event stream:** Jetstream
- **Local application index/cache:** SQLite
- **Environment:** local development only, against a local ATProto network (§31)

Production hosting, monitoring, backup policy, CDN behavior, and deployment automation are explicitly out of scope for this phase.

---

## 2. Product Goal

Voicebook.club is a social voice-practice application.

Users practice by reading passages or chapters aloud, uploading or recording audio, and building a visible history of practice.

The local MVP should prove that a user can:

1. Sign in with an ATProto/Bluesky identity.
2. Create a voice-practice recording.
3. Store the recording and its metadata in the user's ATProto account.
4. Reconstruct the app's local SQLite index from ATProto data.
5. Review their past recordings.
6. See a calendar of practice days.
7. See recent practice activity from other known Voicebook users they follow on Bluesky.

---

## 3. Core Architectural Principle

The MVP treats **ATProto as canonical storage** and **SQLite as reconstructible application state**.

Everything a user writes is public ATProto data in their own repository, so the browser writes it directly to the user's PDS and the backend never needs user credentials:

```text
Browser (TypeScript)
   |  OAuth session (DPoP-bound, held by the browser)
   |
   +--> User's PDS
   |      - uploadBlob (audio)
   |      - createRecord (club.voicebook.recording)
   |      - listRecords / getBlob (own data, playback)
   |
   +--> Rust Backend (read-only, public data)
          - /api/... queries: calendar, recordings, friends activity
          |
          +--> SQLite
          |      - known members (DIDs)
          |      - indexed recordings
          |      - members' follows
          |      - Jetstream cursor
          |
          +--> Jetstream  (live recording and follow events)
          +--> PLC / PDSes (DID resolution, backfill via listRecords)
```

The backend's one job that the browser cannot do cheaply is knowing **who uses Voicebook**, so it can answer "which of the people I follow have practiced recently?" without the browser crawling every followed account's repository.

The most important design rule is:

> If the SQLite database is lost, nothing is lost: each member's data is rebuilt from their own PDS when they next sign in.

The MVP explicitly tests this (§21).

---

## 4. Local Development Goals

The local prototype should validate:

- ATProto OAuth in the browser against a local PDS.
- Session persistence across page reloads.
- Creation of custom application records in a user's ATProto repository.
- Upload of audio blobs to the user's PDS.
- Playback of recordings directly from the PDS.
- Indexing of recordings and follows from Jetstream into SQLite.
- Discovery of new members from the event stream, with backfill from their PDS.
- Rebuilding the SQLite index from ATProto after deleting it.
- Derivation of calendar activity from indexed recordings.
- Friends activity from members' Bluesky follows.

---

## 5. Non-Goals

The local MVP does **not** need:

- Production deployment.
- Public registration.
- Billing.
- Email.
- Push notifications.
- Bluesky reminder automation.
- Moderation tooling beyond minimal local controls.
- Admin dashboard.
- Distributed services.
- Redis.
- PostgreSQL.
- Object storage such as S3/R2/B2.
- CDN.
- Full-text search.
- Mobile application.
- Sophisticated privacy/access controls.
- End-to-end encryption.
- Production-grade observability.
- Production backup automation.

These can be added after the core architecture is proven.

---

## 6. User Experience

### 6.1 Primary Navigation

The MVP should have three main views:

```text
Practice | Recordings | Friends
```

The initial home view should be **Practice**.

---

## 7. Practice View

The Practice view should show:

- Current month calendar.
- Days on which practice occurred.
- Number of practice days in the current month.
- Current practice streak, if implemented.
- A clear `Start Practice` or `Upload Recording` action.

Example:

```text
October 2026

Mon Tue Wed Thu Fri Sat Sun
              1   2   3   4
              ●   ●       ●
 5   6   7   8   9  10  11
 ●

7 practice days this month
Current streak: 3 days

[ Start Practice ]
```

For the MVP, a day counts as a practice day if at least one recording exists for that user on that calendar date.

No separate "practice happened" record is required initially.

---

## 8. Recording Flow

The simplest MVP flow is:

1. User clicks `Start Practice`.
2. User selects or enters:
   - Book/work title.
   - Chapter or passage identifier.
3. User records in the browser, or selects an audio file from disk.
   - Browser recordings are written to IndexedDB chunk by chunk while recording, and kept there until saved: a closed tab or failed upload loses nothing, and unsaved recordings are offered back on the Practice view.
   - The record's `createdAt` is when recording started, not when it was saved.
4. The browser uploads the audio to the user's PDS (`com.atproto.repo.uploadBlob`).
5. The browser creates a `club.voicebook.recording` record referencing the blob (`com.atproto.repo.createRecord`).
6. The PDS emits the commit on its firehose; Jetstream relays it; the backend indexes it.
7. The browser deletes its draft copy, and shows the completed recording once the backend has indexed it.

Recording disables echo cancellation, noise suppression and automatic gain control, which are designed for calls and alter the voice being practiced.

---

## 9. Recordings View

The Recordings view should show a chronological list of the user's recordings.

Each item should include at minimum:

- Date/time.
- Book/work.
- Chapter/passage.
- Duration if known.
- Audio playback control.

Optional fields:

- Freeform notes.
- File size.
- MIME type.
- AT URI.
- Blob CID.

Useful filters for later:

- Book.
- Date range.
- Chapter.
- Duration.

For the MVP, chronological ordering is sufficient.

---

## 10. Friends View

The Friends view shows recent practice activity from other known Voicebook users whom the current user follows on Bluesky.

A Voicebook "friend" is:

> A known Voicebook member whose DID appears in the signed-in user's Bluesky follow graph.

No separate Voicebook friend-request system is needed.

Example:

```text
Recent Practice

Alice
Practiced 18 minutes today
Pride and Prejudice — Chapter 3

Bob
Practiced yesterday
The Left Hand of Darkness — Chapter 7
```

Follows are `app.bsky.graph.follow` records in each user's own repository, so no Bluesky AppView is needed. The backend:

- stores the follows of members, kept current from Jetstream (creates and deletes);
- answers for a non-member (e.g. someone who signed in but hasn't recorded yet) by fetching their follows live from their PDS;
- intersects follows with known members and returns their recent recordings.

Follows are public data, but storing members' follow graphs should be disclosed in a privacy policy before production, and deletions must be honored (§19).

---

## 11. ATProto Data Model

The MVP should define one custom record type for recordings.

Use a namespace owned by the project domain.

Example NSID:

```text
club.voicebook.recording
```

A conceptual record:

```json
{
  "$type": "club.voicebook.recording",
  "createdAt": "2026-10-05T07:12:00Z",
  "work": "Pride and Prejudice",
  "chapter": "3",
  "durationMs": 847000,
  "audio": {
    "$type": "blob",
    "ref": {
      "$link": "bafk..."
    },
    "mimeType": "audio/ogg",
    "size": 5230123
  }
}
```

The exact Lexicon should be versioned in the repository.

### Required fields

- `createdAt`
- `work`
- `audio`

### Recommended fields

- `chapter`
- `durationMs`
- `notes`

The local MVP should prefer a small schema that can evolve later.

---

## 12. Blob Handling

The browser:

1. Uploads the audio with the user's OAuth session (`uploadBlob`).
2. Receives the blob reference.
3. Creates the recording record referencing that blob.

The two steps form one logical operation. If the upload succeeds but record creation fails, the frontend reports the failure clearly and may retry record creation with the same blob reference. An unreferenced blob is eventually garbage-collected by the PDS, so no cleanup is required.

The PDS may normalize the MIME type (e.g. `audio/ogg` becomes `audio/ogg; codecs=opus`); the record should use the blob reference the PDS returned, unchanged.

bsky.social's PDS labels browser-recorded WebM audio as `video/webm`, since it sniffs the container. Browsers play it, but it doesn't match the Lexicon's `accept: ["audio/*"]`; decide before publishing the Lexicon whether to accept `video/webm` or record in another container.

---

## 13. Identity

The stable user identifier should always be the user's **DID**, not their handle.

Store:

```text
did:plc:...
```

as the canonical identity.

Handles such as:

```text
alice.bsky.social
alice.example.com
```

should be treated as mutable display/lookup data.

The backend may cache handles in SQLite, but code should not use the handle as a database primary key.

---

## 14. ATProto OAuth

OAuth runs in the browser using Bluesky's maintained client library, `@atproto/oauth-client-browser`.

Locally, the app is a **loopback client**: its client ID is an `http://localhost` URL encoding the redirect URI and scopes, and needs no registration or hosted metadata. In production, the app instead hosts a static `client-metadata.json`.

The browser is responsible for:

- Resolving the user's handle to a DID and PDS.
- Running the authorization flow (PAR, PKCE, DPoP) against the PDS's authorization server.
- Storing the session (the DPoP key is non-extractable, kept in IndexedDB).
- Refreshing tokens.

Scopes: request only what Voicebook needs: write access to `club.voicebook.recording` and audio blob uploads, using granular permission scopes where the PDS supports them, falling back to `transition:generic`.

Loopback and other public clients receive shorter-lived refresh tokens than confidential clients. That is acceptable for the MVP.

The backend never sees user tokens. It serves only public data, so its API needs no authentication.

---

## 15. Rust Backend

Stack:

```text
axum
tokio
sqlx (SQLite)
tokio-tungstenite (Jetstream)
reqwest (DID resolution, listRecords)
rustls (TLS for both clients)
serde / serde_json
tracing
```

The backend uses no ATProto library: it only resolves DIDs, pages through `listRecords`, and parses Jetstream's JSON events, which plain HTTP and JSON cover.

### Backend responsibilities

The Rust backend owns:

- Consuming Jetstream (§19).
- Discovering members and backfilling them from their PDS.
- SQLite indexing, including the Jetstream cursor.
- Calendar, recordings and friends-activity queries.
- Reindex/rebuild.

It does not own OAuth, sessions, audio upload or record creation.

---

## 16. TypeScript Frontend

The frontend is a small single-page application, built with Vite.

Responsibilities:

```text
Frontend
  - OAuth sign-in and session (in the browser)
  - audio upload and record creation (direct to the PDS)
  - audio playback (direct from the PDS)
  - rendering, forms, file selection, calendar UI
  - queries to the backend for calendar, history and friends

Backend
  - Jetstream consumption
  - member discovery and backfill
  - SQLite index
  - query API
```

---

## 17. Local API Shape

The backend API is read-only and unauthenticated:

```text
GET  /api/health
GET  /api/members
GET  /api/users/:did/recordings?limit&before
GET  /api/users/:did/calendar?month=YYYY-MM&tzOffsetMinutes
GET  /api/users/:did/friends/activity?limit&before

POST /api/dev/reindex
```

Each recording includes an `audioUrl` pointing at `com.atproto.sync.getBlob` on the author's PDS.

---

## 18. SQLite

SQLite is a reconstructible index plus the Jetstream cursor. Schema (see `backend/migrations/`):

```sql
CREATE TABLE members (
    did TEXT PRIMARY KEY,
    handle TEXT,                         -- mutable display data, never a key
    pds_url TEXT,
    active INTEGER NOT NULL DEFAULT 1,   -- 0 while deactivated or taken down
    discovered_at TEXT NOT NULL,
    backfilled_at TEXT
);

CREATE TABLE recordings (
    uri TEXT PRIMARY KEY,
    did TEXT NOT NULL REFERENCES members(did) ON DELETE CASCADE,
    rkey TEXT NOT NULL,
    cid TEXT NOT NULL,
    created_at TEXT NOT NULL,            -- normalized to UTC
    work TEXT NOT NULL,
    chapter TEXT,
    duration_ms INTEGER,
    notes TEXT,
    blob_cid TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    indexed_at TEXT NOT NULL
);

-- Keyed by rkey: a delete event carries only the record key.
CREATE TABLE follows (
    actor_did TEXT NOT NULL REFERENCES members(did) ON DELETE CASCADE,
    rkey TEXT NOT NULL,
    subject_did TEXT NOT NULL,
    PRIMARY KEY (actor_did, rkey)
);

CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

A **member** is any account that has written at least one well-formed `club.voicebook.recording` record. Membership is permanent: deleting all recordings does not remove it, since a member with no recordings is indistinguishable from someone who just joined. Only account deletion removes a member.

---

## 19. Indexing, Reindexing and Reconstruction

The backend keeps two Jetstream subscriptions, each with its own stored cursor. Both carry only changes: with no stored cursor they start live. History always comes from members' PDSes, never from replaying Jetstream (see Reconstruction below).

```text
/xrpc/network.bsky.jetstream.subscribeEvents?...
  recordings: collections=club.voicebook.recording&kinds=commit[&cursor=<stored>]
  follows:    collections=app.bsky.graph.follow&kinds=commit&kinds=identity&kinds=account[&cursor=<stored>]
```

A collection filter only applies to commits: without `kinds`, identity and account events for the entire network arrive too. (The legacy `/subscribe` endpoint ignores `kinds`.) Events that can't affect the index, such as follows by non-members, are skipped without a write transaction; their cursor is saved every few seconds.

For each event, in one SQLite transaction together with the new cursor:

- **Recording create/update:** if the author is not yet a member, add them and backfill their recordings and follows from their PDS via `listRecords`; then upsert the recording.
- **Recording delete:** delete it.
- **Follow create/delete:** applied only if the author is a member.
- **Identity:** refresh a member's handle and PDS from their DID document.
- **Account:** `deleted` purges the member and their data; other inactive states hide them.

Jetstream delivery is at-least-once and its cursor is inclusive, so every write is idempotent.

The two subscriptions write concurrently, so write transactions start with `BEGIN IMMEDIATE`: a deferred SQLite transaction that reads and then writes fails at once with `SQLITE_BUSY` when another connection holds the write lock, rather than waiting. Network calls (backfill, DID resolution) happen before the transaction opens.

Backfill on discovery is required, not an optimization: follows usually predate a user's first recording, and are ignored until the user is a member.

**Announcing members:** `POST /api/members/{did}/refresh` makes the backend read an account's repo immediately and replace what the index holds for it. The frontend calls it after sign-in and after each save. Only public data is read, but the endpoint needs rate limiting before production.

**Reconstruction:** if the database is lost, members reappear as they sign in: the sign-in refresh restores their recordings and follows from their PDS. Until a member signs in again, they're missing from their friends' activity. `POST /api/dev/reindex` re-fetches every member the index knows.

Replaying Jetstream is not a reconstruction path. The public instances keep about 50 million events (roughly a day and a half, measured 2026-10-06), reject older cursors with HTTP 400 `CursorTooOld`, and must scan the whole window to find Voicebook's few commits, which takes a long time and restarts on every reconnect. When a stored cursor is rejected as too old (e.g. after long downtime), the backend drops it and resumes live; events in the gap reach the index when the affected members next sign in.

---

## 20. Irreducible Local State

None. Members, recordings and follows all come from members' PDSes, restored at sign-in. The only local state is configuration (`backend/environments/`) and the Jetstream cursors, which are disposable.

OAuth sessions live in each user's browser, not on the server.

The cost of losing the database is temporary: members who haven't signed in since are missing from friends' activity. Backing up the member list (just DIDs) would let `POST /api/dev/reindex` restore everyone at once; that's an optional production nicety.

A member with no recordings left is not restored, since their repo is indistinguishable from someone who never used Voicebook.

---

## 21. Deletion Test

A core MVP acceptance test is:

> Delete the SQLite database; each member's data is restored when they sign in.

Procedure:

1. Create several test recordings across two or more ATProto accounts.
2. Snapshot the API's responses (members, recordings, calendars, friends activity).
3. Start a backend on an empty database.
4. Sign in as each member (or `POST /api/members/{did}/refresh` for each).
5. Verify the API responses match the snapshot.

Passed against the local network on 2026-10-06; the only difference was a former member with no recordings left, which is intended (§20).

---

## 22. Practice Calendar Derivation

Practice days should initially be derived from recordings rather than stored separately.

Timestamps are stored in UTC. The viewer's calendar day depends on their time zone, so the calendar query takes the viewer's UTC offset and shifts timestamps before grouping:

```sql
SELECT
    date(created_at, :offset) AS practice_date,      -- e.g. '-420 minutes'
    COUNT(*) AS recording_count,
    SUM(duration_ms) AS duration_ms
FROM recordings
WHERE did = :did AND strftime('%Y-%m', created_at, :offset) = :month
GROUP BY 1
ORDER BY 1;
```

A fixed offset is wrong across daylight-saving changes within a month; using IANA time zone names is a pre-production decision.

---

## 23. Audio Playback

The browser plays recordings directly from the author's PDS:

```text
<audio src="{pds}/xrpc/com.atproto.sync.getBlob?did={did}&cid={blob cid}">
```

`getBlob` is public, so playback needs no session, and the backend never proxies audio. The backend supplies the URL as `audioUrl`.

PDSes do not honor HTTP Range requests, so a browser cannot seek in a streamed Ogg file or determine its duration. The player therefore fetches the whole blob into an object URL on first play. Practice recordings are small enough for this; revisit if long recordings or a CDN change the picture.

---

## 24. Error Handling

The UI should provide understandable errors for at least:

- OAuth/login failure.
- Expired/invalid ATProto session.
- PDS unavailable.
- Blob upload failure.
- Record creation failure.
- Invalid audio file.
- SQLite error.
- Reindex failure.
- Recording unavailable from PDS.

Logs follow [`design/logging.md`](design/logging.md). Developer logs should include structured context such as:

- DID.
- AT URI.
- collection.
- operation.
- HTTP status.
- error chain.

Never log secrets or access tokens.

---

## 25. Logging, Tracing and Metrics

See [`design/logging.md`](design/logging.md): OTLP traces and logs, a stderr diagnostic channel, Prometheus metrics, and the local Grafana stack.

---

## 26. Repository Layout

```text
voicebook.club/
├── README.md
├── docs/
│   └── mvp-local.md
├── dev/
│   └── localnet/           local PLC, PDS and Jetstream (Docker Compose)
├── backend/
│   ├── Cargo.toml
│   ├── migrations/
│   └── src/
│       ├── main.rs
│       ├── api.rs          query API
│       ├── atproto.rs      DID resolution, listRecords
│       ├── config.rs
│       ├── indexer.rs      event application, backfill
│       └── jetstream.rs    subscription and reconnects
├── frontend/
│   ├── package.json
│   └── src/
└── lexicons/
    └── club.voicebook.recording.json
```

---

## 27. Suggested Development Order

### Milestone 1 — Local ATmosphere ✅

- PLC, PDS and Jetstream running locally in Docker.
- Seeded test accounts and follows.

### Milestone 2 — Backend Indexer ✅

- Jetstream subscription with a persisted cursor.
- Member discovery and backfill.
- Recordings, calendar and friends-activity queries.

### Milestone 3 — Destructive Rebuild Test ✅

- Delete SQLite; members' data returns as they sign in.

### Milestone 4 — Browser Login ✅

- OAuth sign-in against the local PDS.
- DID and handle displayed.
- Session survives a page reload.

### Milestone 5 — Upload ✅

- Upload an audio file and create a recording record from the browser.
- Recording appears via the backend.
- Playback from the PDS.

### Milestone 6 — Views ✅

- Practice view with calendar; clicking a day shows its recordings.
- Recordings view.
- Friends view.

### Milestone 7 — Real Network Smoke Test

- Sign in with real Bluesky accounts.
- Backend against a public Jetstream and `plc.directory` (`--environment local-bluesky`).

---

## 28. MVP Acceptance Criteria

The local MVP is complete when all of the following are true:

- [x] Local ATProto network (PLC, PDS, Jetstream) runs in Docker.
- [x] Rust backend runs locally.
- [x] TypeScript frontend runs locally.
- [x] User can authenticate using ATProto OAuth in the browser.
- [x] Session survives a page reload.
- [x] User can upload an audio recording.
- [x] Audio is stored as an ATProto blob.
- [x] Recording metadata is stored in a custom ATProto record.
- [x] Recordings are indexed into SQLite from Jetstream.
- [x] User can list and replay recordings.
- [x] Calendar shows days with recordings.
- [x] At least two ATProto users can be indexed.
- [x] Friend activity is derived from Bluesky follows and known members.
- [x] The SQLite index can be deleted; members' data is restored from their PDSes at sign-in.
- [x] Handles are treated as mutable; DIDs are canonical.
- [x] No production infrastructure is required.

---

## 29. Deferred Decisions

These should be revisited after the local MVP works:

- Production hosting provider.
- Domain/TLS setup.
- Monitoring and metrics.
- Alerting.
- SQLite backup strategy.
- Backblaze B2 archival.
- Bluesky reminder bot.
- Reminder preferences.
- Public vs private activity controls.
- Recording visibility model.
- App-level moderation.
- PDS blob limits and fallback object storage.
- CDN/caching.
- Backing up the member list for faster recovery (§20).
- A `dids` filter on the follows subscription, so Jetstream sends only members' events.
- Scaling the follow subscription beyond what one filtered stream handles.
- Mobile UX.
- Streak/goal semantics.
- Multiple recordings per practice session.
- Book metadata model.
- Shared book/chapter catalog.
- Comments/reactions.
- Production database migration policy.

---

## 30. Guiding Principle

The first implementation should optimize for **proving the architecture**, not completeness.

A successful MVP demonstrates:

```text
ATProto identity
      +
user-owned records/blobs
      +
small Rust application
      +
reconstructible SQLite index
      +
simple TypeScript interface
```

If those pieces work cleanly together locally, production hardening can follow without substantially changing the application's core data model.

---

## 31. Local ATmosphere and Environments

The backend reads its settings from `backend/environments/<name>.json`: `development.json` targets the local network below, `local-bluesky.json` the real Bluesky network (`plc.directory`, a public Jetstream), and `droplet.json` / `app-platform.json` are for the container image (see `deploy/README.md`). Each uses its own SQLite file.

Development runs against a local ATProto network in `dev/localnet/`, all unmodified upstream software:

| Port | Service | Source |
|---|---|---|
| 2582 | PLC directory | `did-method-plc`, built from a pinned commit, with Postgres |
| 2583 | PDS | official `ghcr.io/bluesky-social/pds` image |
| 6008 | Jetstream | official `ghcr.io/bluesky-social/jetstream` image, reading the PDS firehose |

Accounts use `.test` handles. The PDS signs PLC operations with a rotation key generated into a gitignored `.env`, which must stay paired with the Docker volumes.

The npm-published PLC server (`@did-plc/server` 0.0.1, from 2023) emits a legacy DID-document key format that current tools, including Jetstream, reject; the upstream source emits `Multikey` and is used instead.
