import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { viteSingleFile } from 'vite-plugin-singlefile'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      // @filen/sdk expects a Node-like environment (Buffer, crypto, stream, etc.)
      globals: { Buffer: true, global: true, process: true },
    }),
    viteSingleFile(),
  ],
  resolve: {
    alias: {
      // @filen/sdk's browser build still imports fs-extra at the top of several
      // core modules; fs-extra's init code crashes against any minimal fs
      // polyfill. See src/stubs/fs-extra-stub.ts for details.
      'fs-extra': fileURLToPath(new URL('./src/stubs/fs-extra-stub.ts', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
