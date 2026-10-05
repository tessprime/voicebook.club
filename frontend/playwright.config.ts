import { defineConfig } from '@playwright/test'

// End-to-end tests against the local ATmosphere. Requires dev/localnet to be
// up and seeded and the backend running; starts the Vite dev server if needed.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
  },
})
