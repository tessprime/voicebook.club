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
- [x] TypeScript frontend: OAuth sign-in, upload, playback, calendar, friends
- [x] Playwright end-to-end test against the local network
- [ ] Smoke test against real Bluesky accounts

## Layout

```text
docs/                    MVP specification
dev/localnet/            local PLC, PDS and Jetstream (Docker Compose)
backend/                 Rust indexer and API (axum, sqlx/SQLite)
frontend/                React + TypeScript app (Vite)
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
cargo run                 # API on 127.0.0.1:3000
cargo test
```

Configuration is by environment variable; the defaults target the local
network: `VOICEBOOK_BIND` (`127.0.0.1:3000`), `VOICEBOOK_DATABASE_URL`
(`sqlite://data/voicebook.sqlite`), `VOICEBOOK_PLC_URL`
(`http://localhost:2582`), `VOICEBOOK_JETSTREAM_URL` (`ws://localhost:6008`).
`RUST_LOG` sets log levels.

| Endpoint | Returns |
|---|---|
| `GET /api/health` | status and the Jetstream cursor |
| `GET /api/members` | known Voicebook members |
| `GET /api/users/{did}/recordings?limit&before` | a user's recordings, newest first |
| `GET /api/users/{did}/calendar?month=YYYY-MM&tzOffsetMinutes` | practice days in the viewer's time zone |
| `GET /api/users/{did}/friends/activity?limit&before` | recent recordings by members `did` follows |
| `POST /api/dev/reindex` | re-fetch every member from their PDS |

Recordings include an `audioUrl` that the browser plays straight from the
author's PDS.

To rebuild the index from scratch, stop the backend, delete
`backend/data/voicebook.sqlite*` and start it again: with no stored cursor it
replays Jetstream from the beginning and backfills each member from their PDS.

### Frontend

Needs Node 22+; the repo pins 24 in `.nvmrc`.

```bash
source ~/.nvm/nvm.sh   # only if nvm isn't loaded by your shell startup
nvm install            # first time only; installs the version in .nvmrc
cd frontend
nvm use
npm install
npm run dev            # http://127.0.0.1:5173 — sign in as alice.test / password
npm run test:e2e       # Playwright, against the running localnet and backend
```

Open `http://127.0.0.1:5173`, not `localhost:5173`: ATProto's OAuth loopback
redirects must use the IP. See [`frontend/README.md`](frontend/README.md).
