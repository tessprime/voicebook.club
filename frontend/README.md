# Voicebook frontend

React + TypeScript (Vite). Signs in with ATProto OAuth in the browser
(`@atproto/oauth-client-browser`), writes recordings straight to the user's
PDS, and reads calendars, history and friends' activity from the backend.

```bash
nvm use
npm install
npm run dev          # http://127.0.0.1:5173 (not "localhost": OAuth loopback redirects need the IP)
npm run dev:production  # same, but against the real Bluesky network (.env.production)
npm run test:e2e     # Playwright; needs dev/localnet up and seeded, and a development backend
                     # (VOICEBOOK_API, default http://127.0.0.1:3000); runs its own Vite on :5174
```

`.env.development` points identity resolution at the local network
(`VITE_PLC_URL`, `VITE_HANDLE_RESOLVER`); `.env.production` at the real
network. Pair each with the backend environment of the same name. `/api` is proxied to the backend on
`127.0.0.1:3000`.

Notes:

- The app is an OAuth loopback client: its client ID is an
  `http://localhost?redirect_uri=…&scope=…` URL, so no client registration is
  needed locally. Production needs a hosted `client-metadata.json`.
- Scopes are granular: `repo:club.voicebook.recording` and `blob:audio/*`.
- PDSes don't honor Range requests, so the player fetches the whole blob into
  an object URL before playing; otherwise Ogg files have no duration and
  can't seek.
- **Recording** uses `MediaRecorder` (Opus in WebM, Ogg or MP4, whichever the
  browser supports) with echo cancellation, noise suppression and automatic
  gain turned off, since they alter the voice being practiced. Each second of
  audio is written to IndexedDB (`voicebook-drafts`) as it's recorded, so a
  closed tab or a failed upload loses nothing: the Practice view offers any
  unsaved recording back, and the draft is deleted only after the record is
  created on the PDS. The record's `createdAt` is when recording started.
- Chrome's WebM recordings carry no duration; `fix-webm-duration` writes it
  into the header so players can show a length and seek.

