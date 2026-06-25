# Ayran LAN Streamer

See [CLAUDE.md](./CLAUDE.md) for the product spec. This is a v1 end-to-end skeleton:

- `api/` — Node.js + TypeScript API (Express + `ws`). HTTPS-only, self-signed dev cert auto-generated into `api/certs/`. Filen.io login via `@filen/sdk` issues an opaque session token; streams are persisted to `api/data/streams.json`, scoped per Filen account. Multi-host audio is mixed by summing 20ms 48kHz mono PCM frames and rebroadcast to listeners over WebSocket.
- `desktop/` — Tauri 2 + React 19 desktop client (`io.ayran.lanstreamer.desktop`, dev port 1420). Used as either a streaming host (microphone or system/speaker-loopback capture via `getDisplayMedia`) or a listener (one merged stream at a time).
- `mobile/` — Same feature set as `desktop/`, packaged for Android/iOS (`io.ayran.lanstreamer.mobile`, dev port 1421). Source is a duplicate of `desktop/`'s, not shared, matching the pattern used in the other Ayran Tauri apps.

## Running

```
cd api && npm install && npm run dev          # https://localhost:8443
cd desktop && npm install && npm run tauri dev
cd mobile && npm install && npm run tauri android dev   # or: npm run tauri ios dev
```

## Known limitation: self-signed cert

The API generates a self-signed dev certificate on first run (SAN covers `localhost`, `127.0.0.1`, and detected LAN IPv4 addresses). Tauri's webview is a real browser engine (WebView2 on Windows) and will reject it (`ERR_INVALID_CERT_AUTHORITY` in devtools, "Failed to fetch" in the app) unless it's trusted. For LAN use, either:

- Trust `api/certs/dev-cert.pem` on each client machine, then **fully restart the Tauri app** (WebView2 needs a fresh process to pick up the updated trust store):
  - Windows, current user only (no admin needed): `certutil -user -addstore Root api\certs\dev-cert.pem`
  - Windows, machine-wide (run as admin, needed so other LAN devices' browsers/webviews trust it too — copy the `.pem` to each device first): `certutil -addstore Root <path-to-dev-cert.pem>`
- Or replace it with a certificate from a real CA (e.g. via a local CA or a domain + Let's Encrypt) for anything beyond local testing.

If you ever delete `api/certs/` and let the server regenerate it, the new cert won't be trusted until you re-import it.

## Not yet implemented

- System/speaker-loopback capture relies on the browser's "share audio" picker (`getDisplayMedia`); a native loopback capture (e.g. via `cpal` in Rust) would be more reliable and is a good next step.
- No reconnect/backoff on dropped WebSocket connections.
