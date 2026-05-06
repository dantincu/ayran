import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), nodePolyfills()],
  clearScreen: false,
  resolve: {
    alias: {
      // @filen/sdk pulls in graceful-fs → fs-extra which crashes on import in
      // Tauri's webview because the fs polyfill has no realpath. This shim
      // provides the minimum surface needed so imports succeed; network-based
      // SDK operations (login, listing) work fine without real fs.
      "graceful-fs": resolve(__dirname, "src/shims/graceful-fs.js"),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));