import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Set by `tauri android dev` / `tauri ios dev`: the address a phone reaches this machine on.
const host = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // Keep Rust errors visible in the terminal.
  clearScreen: false,

  // Tauri expects a fixed port (`devUrl` in src-tauri/tauri.conf.json) and fails if it isn't available.
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      // The Rust side is rebuilt by cargo, not Vite.
      ignored: ['**/src-tauri/**'],
    },
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
