import { defineConfig } from '@playwright/test'

// End-to-end tests against the local ATmosphere. Requires dev/localnet to be
// up and seeded and a development backend running (VOICEBOOK_API, default
// http://127.0.0.1:3000). Starts its own Vite dev server on port 5174 in
// development mode, so a dev server on 5173 can keep running.
const PORT = 5174

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    permissions: ['microphone'],
    launchOptions: {
      // A fake microphone that plays a tone.
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  webServer: {
    command: `npx vite --mode development --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
  },
})
