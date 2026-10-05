# Local ATProto network

A PLC directory (`localhost:2582`) and a PDS (`localhost:2583`) for local
Voicebook development, via `@atproto/dev-env`. No Bluesky AppView.

```bash
source ~/.nvm/nvm.sh   # only if nvm isn't loaded by your shell startup
cd dev/localnet
nvm install            # first time only; Node 24 from .nvmrc (dev-env needs >= 22)
nvm use
npm install
npm start              # Ctrl-C to stop
./spike.sh             # in another shell: exercises every ATProto call the MVP needs
```

Seeded accounts (password `password`): `alice.test`, `bob.test`,
`carol.test`, `dave.test`. Follows: alice → bob, carol, dave; bob → alice;
carol → bob. dave stands in for a Bluesky user who doesn't use Voicebook.

**State is ephemeral.** The PLC stores DIDs in memory and the PDS uses temp
directories, so each restart creates new DIDs. The current DIDs and URLs are
written to `localnet.json` (deleted on shutdown).
