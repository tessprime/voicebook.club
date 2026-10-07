import { defineConfig } from '@playwright/test'

// End-to-end tests against the local ATmosphere. Requires dev/localnet to be
// up and seeded and a development backend running (VOICEBOOK_API, default
// http://127.0.0.1:8080). Starts its own Vite dev server on port 5174 in
// development mode, so a dev server on 5173 can keep running.
//
// E2E_BASE_URL tests an already-running app instead (e.g. the container
// image, see deploy/README.md), without starting Vite.
const PORT = 5174
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {
    baseURL,
    trace: 'retain-on-failure',
    permissions: ['microphone'],
    launchOptions: {
      // A fake microphone that plays a tone.
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx vite --mode development --port ${PORT}`,
        url: baseURL,
        reuseExistingServer: false,
      },
})
