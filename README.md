# voicebook.club

A social voice-practice app. Users read passages or chapters aloud, record
them, and build a visible history of practice that friends can see.

Identity and user data live on [ATProto](https://atproto.com) (Bluesky):
recordings are stored as `club.voicebook.recording` records and audio blobs in
each user's own repository. The app keeps a SQLite index that can be rebuilt
from ATProto at any time.

See [`docs/mvp-local.md`](docs/mvp-local.md) for the full local MVP
specification.

## Status

Early prototype, local development only.

- [x] Local ATProto network (PLC + PDS + Jetstream) with seeded test accounts
- [x] Spike confirming the required ATProto calls work locally
- [ ] Rust backend (axum + SQLite)
- [ ] TypeScript frontend
- [ ] Smoke test against real Bluesky accounts

## Layout

```text
docs/                    MVP specification
dev/localnet/            local PLC, PDS and Jetstream (Docker Compose)
```

Planned: `backend/` (Rust), `frontend/` (TypeScript), `lexicons/`.

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
See [`dev/localnet/README.md`](dev/localnet/README.md) for details.

### Node

The frontend needs Node 22+. The repo pins 24 in `.nvmrc`:

```bash
source ~/.nvm/nvm.sh   # only if nvm isn't loaded by your shell startup
nvm install            # first time only; installs the version in .nvmrc
nvm use
```
