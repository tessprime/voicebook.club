# voicebook.club

A social voice-practice app. Users read passages or chapters aloud, record
them, and build a visible history of practice that friends can see.

Identity and user data live on [ATProto](https://atproto.com) (Bluesky):
recordings are stored as `club.voicebook.recording` records and audio blobs in
each user's own repository. The browser signs in with ATProto OAuth and
writes to the user's PDS directly. The Rust backend only reads public data: it
follows Jetstream, keeps a SQLite index of Voicebook members, their recordings
and their follows, and serves the calendar and friends-activity queries. The
index can be deleted and rebuilt from ATProto at any time.

See [`docs/mvp-local.md`](docs/mvp-local.md) for the full local MVP
specification.

## Status

Early prototype, local development only.

- [x] Local ATProto network (PLC + PDS + Jetstream) with seeded test accounts
- [x] Spike confirming the required ATProto calls work locally
- [x] Rust backend: Jetstream indexer, SQLite, read API
- [x] Delete-and-rebuild test (§21) passes against the local network
- [x] TypeScript frontend: OAuth sign-in, in-browser recording, upload, playback, calendar, friends
- [x] Playwright end-to-end test against the local network
- [ ] Smoke test against real Bluesky accounts

## Layout

```text
docs/                    MVP specification
dev/localnet/            local PLC, PDS and Jetstream (Docker Compose)
backend/                 Rust indexer and API (axum, sqlx/SQLite)
frontend/                React + TypeScript app (Vite)
scripts/                 maintenance scripts
lexicons/                club.voicebook.recording schema
```

## Local development

Development runs entirely against a local ATProto network (PLC directory, PDS
and Jetstream in Docker); no Bluesky account is needed.

Requirements: Docker with the Compose plugin (`sudo apt install
docker-compose-v2` on Ubuntu), plus `curl`, `jq`, `openssl` and `xxd`;
`ffmpeg` for the spike script.

```bash
cd dev/localnet
./init.sh                 # first time only: generates .env with fresh secrets
docker compose up -d      # PLC :2582, PDS :2583, Jetstream :6008
./seed.sh                 # test accounts and follows; safe to re-run
./spike.sh                # upload, record, list, fetch, follows
```

Test accounts `alice.test`, `bob.test`, `carol.test` and `dave.test` share the
password `password`. State persists across restarts; `./reset.sh` wipes it.
`./record.sh bob "Middlemarch" 3` posts a test recording as an account.
See [`dev/localnet/README.md`](dev/localnet/README.md) for details.

### Backend

```bash
cd backend
cargo run                                  # environments/development.json: local network, API on 127.0.0.1:3000
cargo run -- --environment production      # environments/production.json: real Bluesky network
cargo test
```

Settings live in `backend/environments/<name>.json` (`bind`, `database`,
`plcUrl`, `jetstreamUrl`); `--config <path>` loads any other file. `RUST_LOG`
sets log levels. Each environment has its own SQLite file under
`backend/data/`.

| Endpoint | Returns |
|---|---|
| `GET /api/health` | status and the Jetstream cursor |
| `GET /api/members` | known Voicebook members |
| `POST /api/members/{did}/refresh` | re-read an account's repo now, instead of waiting for Jetstream |
| `GET /api/users/{did}/recordings?limit&before` | a user's recordings, newest first |
| `GET /api/users/{did}/calendar?month=YYYY-MM&tzOffsetMinutes` | practice days in the viewer's time zone |
| `GET /api/users/{did}/friends/activity?limit&before` | recent recordings by members `did` follows |
| `POST /api/dev/reindex` | re-fetch every member from their PDS |

Recordings include an `audioUrl` that the browser plays straight from the
author's PDS.

The backend keeps two live Jetstream subscriptions, for Voicebook recordings
and for follows (plus members' identity and account changes). History comes
from members' own PDSes: when an account is first seen, and whenever the
frontend asks the backend to refresh it after sign-in.

If the database is lost, delete `backend/data/<environment>.sqlite*` and
restart: members reappear as they sign in. Jetstream replay isn't used for
recovery; the public instances keep only about a day and a half of events.

### Scripts

`scripts/voicebook_records.py` lists or deletes an account's Voicebook
recordings (Python 3, standard library only):

```bash
scripts/voicebook_records.py alice.bsky.social                     # list (public, no login)
scripts/voicebook_records.py alice.bsky.social --delete <id>       # delete one, by record key
scripts/voicebook_records.py alice.bsky.social --clear             # delete all
scripts/voicebook_records.py alice.test --env development --clear  # against the local network
```

Deleting prompts for the account's password (an app password for real
Bluesky accounts) and asks for confirmation; `--yes` skips the confirmation,
and `VOICEBOOK_PASSWORD` supplies the password non-interactively.
