import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    // ATProto loopback OAuth clients must redirect to 127.0.0.1, not
    // "localhost", so the app is served there.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // The backend; e2e tests point this at a development backend.
      '/api': process.env.VOICEBOOK_API ?? 'http://127.0.0.1:8080',
    },
  },
})
