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

- [x] Local ATProto network (PLC + PDS) with seeded test accounts
- [x] Spike confirming the required ATProto calls work locally
- [ ] Rust backend (axum + SQLite)
- [ ] TypeScript frontend
- [ ] Smoke test against real Bluesky accounts

## Layout

```text
docs/                    MVP specification
dev/localnet/            local PLC directory + PDS for development
```

Planned: `backend/` (Rust), `frontend/` (TypeScript), `lexicons/`.

## Local development

Development runs entirely against a local ATProto network; no Bluesky account
is needed.

Requirements: [nvm](https://github.com/nvm-sh/nvm) (or any Node 22+; the repo
pins 24 via `.nvmrc`), plus `curl`, `jq` and `ffmpeg` for the spike script.

```bash
source ~/.nvm/nvm.sh   # only if nvm isn't loaded by your shell startup
cd dev/localnet
nvm install            # first time only; installs the version in .nvmrc
nvm use
npm install
npm start              # PLC on :2582, PDS on :2583; Ctrl-C to stop
./spike.sh             # in another shell: upload, record, list, fetch, follows
```

Test accounts `alice.test`, `bob.test`, `carol.test` and `dave.test` share the
password `password`. The network is ephemeral: each restart creates new DIDs,
written to `dev/localnet/localnet.json`. See
[`dev/localnet/README.md`](dev/localnet/README.md) for details.
