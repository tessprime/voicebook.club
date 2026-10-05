# Voicebook.club MVP — Local Development Specification

## 1. Scope

This document defines the first local-only MVP for **voicebook.club**.

The goal is to validate the core product and architecture before any production deployment, monitoring, alerts, backups, or hosted infrastructure are added.

The MVP uses:

- **Backend:** Rust
- **Frontend:** TypeScript
- **Primary identity/authentication:** AT Protocol / Bluesky OAuth
- **Canonical user-owned app data:** ATProto repositories and blobs
- **Local application index/cache:** SQLite
- **Environment:** local development only

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

The MVP should treat **ATProto as canonical storage** and **SQLite as reconstructible application state** wherever possible.

Conceptually:

```text
Browser
   |
   v
TypeScript Frontend
   |
   v
Rust Backend
   |
   +--> SQLite
   |      - indexed recordings
   |      - known users / DIDs
   |      - derived social/activity data
   |      - local session/application state
   |
   +--> ATProto
          - OAuth identity
          - user repositories
          - recording metadata records
          - audio blobs
```

The most important design rule is:

> If the local SQLite database is deleted, the application should be able to reconstruct its user-content index from a known set of ATProto DIDs.

The MVP should explicitly test this.

---

## 4. Local Development Goals

The local prototype should validate:

- ATProto OAuth from localhost.
- Session persistence across local backend restarts.
- Creation of custom application records in a user's ATProto repository.
- Upload of audio blobs to the user's PDS.
- Reading recordings back from ATProto.
- Local indexing into SQLite.
- Rebuilding the SQLite index from ATProto.
- Playback of uploaded recordings in the frontend.
- Derivation of calendar activity from indexed recordings.
- Retrieval of Bluesky follow relationships for known Voicebook users.

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
- Native browser recording if upload-first is easier initially.
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

The simplest MVP flow should be:

1. User clicks `Start Practice`.
2. User selects or enters:
   - Book/work title.
   - Chapter or passage identifier.
3. User selects an audio file from disk.
4. Frontend submits metadata and audio to the backend.
5. Backend uploads the audio blob to the authenticated user's PDS.
6. Backend creates an ATProto record referencing the uploaded blob.
7. Backend adds or updates the corresponding SQLite index row.
8. Frontend displays the completed recording.

Native in-browser microphone recording can be added later.

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

The Friends view should show recent practice activity from other known Voicebook users whom the current user follows on Bluesky.

For the first version, define a Voicebook "friend" as:

> A known Voicebook user whose DID appears in the signed-in user's Bluesky follow graph.

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

The local backend may derive this from:

- Known Voicebook user DIDs.
- The current user's Bluesky follow graph.
- Indexed Voicebook recording records.

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

The backend should:

1. Receive audio from the frontend.
2. Upload it using the authenticated user's ATProto session.
3. Receive the ATProto blob reference.
4. Create the recording record referencing that blob.

The application should treat:

```text
upload blob + create record
```

as one logical operation.

If blob upload succeeds but record creation fails, the backend should report the failure clearly and may retry record creation.

For the MVP, sophisticated cleanup of orphaned temporary uploads is not required.

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

Local development should use ATProto's localhost development OAuth support.

The backend is responsible for:

- Beginning the OAuth flow.
- Handling the callback.
- Associating the authenticated session with the user's DID.
- Persisting enough OAuth session state locally to survive backend restarts.
- Refreshing sessions as required by the ATProto OAuth implementation.

OAuth implementation should be isolated behind a backend module so that ATProto library choices can change without affecting the rest of the application.

Suggested Rust abstraction:

```rust
trait AtprotoSession {
    async fn did(&self) -> Result<String>;
    async fn upload_blob(&self, data: &[u8], mime_type: &str) -> Result<BlobRef>;
    async fn create_record<T>(&self, collection: &str, record: &T) -> Result<RecordRef>;
}
```

The exact trait shape can evolve.

---

## 15. Rust Backend

Suggested stack:

```text
axum
tokio
serde
serde_json
sqlx
reqwest
tower-http
tracing
```

ATProto functionality may come from a suitable Rust community library where practical.

Candidates to evaluate include:

- `jacquard`
- `atproto-crates`
- `rsky`

The MVP should not commit deeply to one library until the following spike succeeds:

1. Local OAuth login.
2. Backend restart with session restoration.
3. Custom record write.
4. Record readback.
5. Blob upload.

### Backend responsibilities

The Rust backend should own:

- ATProto OAuth.
- Session handling.
- Audio upload.
- ATProto record creation.
- ATProto record reads.
- SQLite indexing.
- Rebuild/index jobs.
- Friend/follow relationship queries.
- API consumed by the TypeScript frontend.

---

## 16. TypeScript Frontend

The frontend should be a small single-page application.

A framework is optional, but reasonable choices include:

- React
- Preact
- Solid
- Svelte

For the MVP, prefer whichever keeps iteration fastest.

The frontend should not directly own long-lived ATProto credentials.

Suggested responsibility split:

```text
Frontend
  - rendering
  - forms
  - file selection
  - audio playback
  - calendar UI

Backend
  - OAuth/session
  - ATProto writes
  - indexing
  - SQLite
```

---

## 17. Local API Shape

Possible local backend API:

```text
GET  /api/me
GET  /api/oauth/login
GET  /api/oauth/callback

GET  /api/practice/calendar
GET  /api/recordings
POST /api/recordings
GET  /api/recordings/:id/audio

GET  /api/friends/activity

POST /api/dev/reindex
GET  /api/dev/index-status
```

This is illustrative rather than final.

---

## 18. SQLite

SQLite is an application index and local persistence layer.

Suggested initial schema:

```sql
CREATE TABLE users (
    did TEXT PRIMARY KEY,
    handle TEXT,
    display_name TEXT,
    discovered_at TEXT NOT NULL,
    last_indexed_at TEXT
);

CREATE TABLE recordings (
    uri TEXT PRIMARY KEY,
    cid TEXT NOT NULL,
    did TEXT NOT NULL,
    created_at TEXT NOT NULL,
    work TEXT NOT NULL,
    chapter TEXT,
    duration_ms INTEGER,
    blob_cid TEXT,
    mime_type TEXT,
    size_bytes INTEGER,
    indexed_at TEXT NOT NULL,
    FOREIGN KEY (did) REFERENCES users(did)
);

CREATE INDEX recordings_by_user_date
    ON recordings(did, created_at);

CREATE INDEX recordings_by_work
    ON recordings(work);

CREATE TABLE follows (
    actor_did TEXT NOT NULL,
    subject_did TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    PRIMARY KEY (actor_did, subject_did)
);
```

Additional OAuth/session tables may be required by the chosen ATProto OAuth implementation.

---

## 19. Reindexing and Reconstruction

The backend must support rebuilding application content indexes from ATProto.

A local developer action should exist to:

```text
1. Read known Voicebook DIDs.
2. Discover each user's current PDS.
3. Enumerate club.voicebook.recording records.
4. Rebuild the recordings table.
5. Refresh cached handles/profile data.
6. Recompute or refresh social relationships as needed.
```

The implementation may initially be a development-only CLI command or HTTP endpoint.

Example:

```bash
cargo run -- reindex
```

or:

```text
POST /api/dev/reindex
```

---

## 20. Irreducible Local State

The MVP should identify exactly what cannot be reconstructed from public ATProto data.

Likely examples:

- The list of users considered members of the Voicebook community.
- OAuth session/token state.
- Any local-only development configuration.
- Future moderation/admin state.

The project should keep this set intentionally small.

The known-user seed should use DIDs.

Example:

```text
did:plc:abc...
did:plc:def...
did:plc:ghi...
```

---

## 21. Deletion Test

A core MVP acceptance test is:

> Delete the SQLite content index and successfully rebuild it from ATProto.

Suggested test procedure:

1. Create several test recordings across two or more ATProto accounts.
2. Verify the UI displays them.
3. Stop the backend.
4. Delete the reconstructible SQLite tables or the entire disposable index DB.
5. Start with only the known-user seed and required OAuth/session state.
6. Run reindex.
7. Verify all recordings reappear.
8. Verify calendar days match.
9. Verify Friends activity matches.

This test validates the architecture.

---

## 22. Practice Calendar Derivation

Practice days should initially be derived from recordings rather than stored separately.

Conceptually:

```sql
SELECT
    date(created_at) AS practice_date,
    COUNT(*) AS recording_count,
    SUM(duration_ms) AS duration_ms
FROM recordings
WHERE did = ?
GROUP BY date(created_at)
ORDER BY practice_date;
```

Timezone handling should be explicitly defined before production.

For local MVP development, timestamps should be stored in UTC, while the frontend may render dates using the user's local timezone.

---

## 23. Audio Playback

The frontend should be able to play a user's recording.

Implementation options include:

1. Backend retrieves/proxies the ATProto blob.
2. Backend generates or exposes a suitable PDS blob URL where safe.
3. Frontend requests audio through a backend endpoint.

For the MVP, prioritize correctness and simplicity over CDN efficiency.

A backend playback endpoint is acceptable:

```text
GET /api/recordings/:id/audio
```

The backend may stream the blob from the user's PDS.

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

Developer logs should include structured context such as:

- DID.
- AT URI.
- collection.
- operation.
- HTTP status.
- error chain.

Never log secrets or access tokens.

---

## 25. Local Logging

Use Rust `tracing`.

Initial log levels:

```text
INFO
- server start
- login complete
- recording indexed
- reindex start/end

WARN
- transient PDS failures
- unavailable blobs
- stale handles

ERROR
- OAuth failures
- record creation failures
- database failures
```

Production metrics and alerting are out of scope for this document.

---

## 26. Repository Layout

Suggested monorepo:

```text
voicebook/
├── README.md
├── docs/
│   └── mvp-local.md
├── backend/
│   ├── Cargo.toml
│   ├── migrations/
│   └── src/
│       ├── main.rs
│       ├── api/
│       ├── auth/
│       ├── atproto/
│       ├── db/
│       ├── indexer/
│       └── models/
├── frontend/
│   ├── package.json
│   ├── src/
│   └── public/
└── lexicons/
    └── club.voicebook.recording.json
```

---

## 27. Suggested Development Order

### Milestone 1 — Local Rust Server

- Axum starts.
- SQLite opens.
- Frontend can call `/api/health`.

### Milestone 2 — ATProto Login

- Login with a real Bluesky/ATProto account.
- Callback succeeds on localhost.
- DID is displayed in the frontend.
- Session survives backend restart.

### Milestone 3 — Metadata-Only Test Record

- Define the Voicebook Lexicon.
- Create a test record.
- Read it back.
- Index it into SQLite.

### Milestone 4 — Audio Blob

- Upload one audio file.
- Create a recording record referencing the blob.
- Play it back.

### Milestone 5 — Recording History

- Show recordings chronologically.
- Show work/chapter/date.
- Playback works.

### Milestone 6 — Calendar

- Derive practice days from recording timestamps.
- Render current month.
- Clicking a day shows that day's recordings.

### Milestone 7 — Multiple Users

- Add at least one additional test user/DID.
- Index both users.
- Display current user's own data correctly.

### Milestone 8 — Friends Activity

- Read Bluesky follows.
- Intersect follows with known Voicebook DIDs.
- Show recent practice activity.

### Milestone 9 — Destructive Rebuild Test

- Delete reconstructible SQLite state.
- Rebuild from known DIDs.
- Confirm UI returns to the same user-visible state.

At that point, the local MVP architecture is considered proven.

---

## 28. MVP Acceptance Criteria

The local MVP is complete when all of the following are true:

- [ ] Rust backend runs locally.
- [ ] TypeScript frontend runs locally.
- [ ] User can authenticate using ATProto OAuth.
- [ ] OAuth session can survive backend restart.
- [ ] User can upload an audio recording.
- [ ] Audio is stored as an ATProto blob.
- [ ] Recording metadata is stored in a custom ATProto record.
- [ ] Recording appears in local SQLite index.
- [ ] User can list and replay recordings.
- [ ] Calendar shows days with recordings.
- [ ] At least two ATProto users can be indexed.
- [ ] Friend activity can be derived from Bluesky follows and known Voicebook users.
- [ ] SQLite recording indexes can be deleted and reconstructed from ATProto.
- [ ] Handles are treated as mutable; DIDs are canonical.
- [ ] No production infrastructure is required.

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
- Feed/event-stream indexing instead of per-user crawling.
- PDS blob limits and fallback object storage.
- CDN/caching.
- Native browser audio recording.
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
