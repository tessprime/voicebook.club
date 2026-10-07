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
docs/                    MVP specification; design/ for design notes; api/ for the API
dev/localnet/            local PLC, PDS and Jetstream (Docker Compose)
backend/                 Rust indexer and API (axum, sqlx/SQLite)
frontend/                React + TypeScript app (Vite)
deploy/                  the container image: Dockerfile, build and test scripts
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
cargo run                                  # environments/development.json: local network, API on 127.0.0.1:8080
cargo run -- --environment local-bluesky   # environments/local-bluesky.json: real Bluesky network
cargo test
```

Settings live in `backend/environments/<name>.json` (`development`: the local
network; `local-bluesky`: the real network, run from this repo; `droplet` and
`app-platform`: inside the container image) ; `--config <path>` loads any other file. The schema is
`backend/src/config.rs`. Each environment has its own SQLite file under `backend/data/`.

Telemetry (see [`docs/design/logging.md`](docs/design/logging.md)): traces and
logs go over OTLP to `telemetry.otlpEndpoint`, metrics are served at
`GET /metrics` for Prometheus, every log event and request is mirrored as JSON
lines to `logs/backend-<environment>.<date>.jsonl` (rotated daily, 3 days
kept), and stderr carries a diagnostic channel (warnings, errors, lifecycle). Locally, Grafana at
http://localhost:3000 shows all of it. To watch everything in the terminal:

```bash
VOICEBOOK_STDERR=info cargo run 2>&1 | ../scripts/logview
```

Each endpoint is documented, with a sequence diagram, in
[`docs/api/`](docs/api/README.md).

| Endpoint | Returns |
|---|---|
| `GET /api/health` | status and the Jetstream cursors |
| `GET /metrics` | Prometheus metrics |
| `GET /api/members` | known Voicebook members |
| `POST /api/members/{did}/refresh` | re-read an account's repo now, instead of waiting for Jetstream |
| `GET /api/users/{did}/recordings?limit&before` | a user's recordings, newest first |
| `GET /api/users/{did}/calendar?month=YYYY-MM&tzOffsetMinutes` | practice days in the viewer's time zone |
| `GET /api/users/{did}/friends/activity?limit&before` | recent recordings by members `did` follows |
| `POST /api/admin/reindex` | re-fetch every member and listed account from their PDSes (admins only) |
| `GET/POST/DELETE /api/session` | sign-in to the backend with a service-auth token, and sign-out |

Recordings include an `audioUrl` that the browser plays straight from the
author's PDS. Every endpoint except `/api/health` and `/api/session`
requires a session, created from an ATProto service-auth token; refreshing
another account and reindexing need an admin (`access.admins`). See
[`docs/design/auth.md`](docs/design/auth.md), and
[`docs/design/security.md`](docs/design/security.md) for the security
checklist and open items.

The backend keeps two live Jetstream subscriptions, for Voicebook recordings
and for follows (plus members' identity and account changes). History comes
from members' own PDSes: when an account is first seen, and whenever the
frontend asks the backend to refresh it after sign-in.

If the database is lost, the index rebuilds from members' PDSes. On an
invite-only instance that happens at startup, from the accounts listed in
`access.allowlist` and `access.admins`; otherwise members reappear as they
sign in. Jetstream replay isn't used for recovery; the public instances keep
only about a day and a half of events.

### Scripts

`scripts/voicebook_records.py` lists or deletes an account's Voicebook
recordings (Python 3, standard library only):

```bash
scripts/voicebook_records.py alice.bsky.social                     # list (public, no login)
scripts/voicebook_records.py alice.bsky.social --delete <id>       # delete one, by record key
scripts/voicebook_records.py alice.bsky.social --clear             # delete all
scripts/voicebook_records.py alice.test --env development --clear  # against the local network
```

`scripts/audit.sh` checks the Rust and npm dependencies for known
vulnerabilities (`--image` also scans the container image, with Trivy);
Dependabot does the same continuously on GitHub.

`scripts/logview` pretty-prints the backend's JSON log lines:
`tail -f logs/backend-local-bluesky.*.jsonl | scripts/logview`, with `--level`
and `--trace` filters.

Deleting prompts for the account's password (an app password for real
Bluesky accounts) and asks for confirmation; `--yes` skips the confirmation,
and `VOICEBOOK_PASSWORD` supplies the password non-interactively.

## Deployment

Voicebook ships as one container image (the backend serving the built
frontend). See [`deploy/README.md`](deploy/README.md) for building it, its
contract (ports, volumes, config), hosting notes for a Droplet or App
Platform, and how secrets will work.

```bash
deploy/build.sh            # voicebook:<sha>, voicebook:latest
deploy/test-image.sh       # the Playwright suite against the container
```
