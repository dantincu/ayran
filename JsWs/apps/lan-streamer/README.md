# Ayran LAN Streamer

See [CLAUDE.md](./CLAUDE.md) for the product spec. This is a v1 end-to-end skeleton:

- `api/` — Node.js + TypeScript API (Express + `ws`). HTTPS-only, self-signed dev cert auto-generated into `api/certs/`. Filen.io login via `@filen/sdk` issues an opaque session token; streams are persisted to `api/data/streams.json`, scoped per Filen account. Multi-host audio is mixed by summing 20ms 48kHz mono PCM frames and rebroadcast to listeners over WebSocket.
- `desktop/` — Tauri 2 + React 19 desktop client (`io.ayran.lanstreamer.desktop`, dev port 1420). Used as either a streaming host (microphone, or system/speaker-loopback capture via a native `cpal` Rust backend — see below) or a listener (one merged stream at a time).
- `mobile/` — Same feature set as `desktop/`, packaged for Android/iOS (`io.ayran.lanstreamer.mobile`, dev port 1421). Source is a duplicate of `desktop/`'s, not shared, matching the pattern used in the other Ayran Tauri apps. System-audio loopback hosting is desktop-only (see below) — mobile only offers microphone.

## Running

```
cd api && npm install && npm run dev          # https://localhost:8443
cd desktop && npm install && npm run tauri dev
cd mobile && npm install && npm run tauri android dev   # or: npm run tauri ios dev
```

## Deploying the API

`npm run build` produces a single self-contained `api/dist/bundle.cjs` (via `esbuild --bundle`) with all dependencies (`express`, `ws`, `@filen/sdk`, etc.) inlined — no `node_modules` needed at runtime, just Node itself:

```
cd api && npm install && npm run build
node dist/bundle.cjs            # or: npm start
```

Notes:
- `--format=cjs` is required — bundling as ESM breaks because some transitive deps (e.g. `depd`, pulled in by `express`) use a dynamic `require()` that esbuild can't resolve statically in ESM output, and throws at runtime. CJS handles it natively.
- Copy just `api/dist/bundle.cjs` (plus a `package.json` isn't even needed) to wherever you're running it; `certs/` and `data/streams.json` are created relative to the process's working directory on first run, so launch it from a consistent directory you want that state to live in.
- This is **not** wired up as an OS service (no systemd unit / NSSM / launchd config) — it's just a plain Node process you start manually or via whatever process manager you prefer. Say if you want one of those set up.

## Known limitation: self-signed cert

The API generates a self-signed dev certificate on first run (SAN covers `localhost`, `127.0.0.1`, and detected LAN IPv4 addresses). Tauri's webview is a real browser engine (WebView2 on Windows) and will reject it (`ERR_INVALID_CERT_AUTHORITY` in devtools, "Failed to fetch" in the app) unless it's trusted. For LAN use, either:

- Trust `api/certs/dev-cert.pem` on each client machine, then **fully restart the Tauri app** (WebView2 needs a fresh process to pick up the updated trust store):
  - Windows, current user only (no admin needed): `certutil -user -addstore Root api\certs\dev-cert.pem`
  - Windows, machine-wide (run as admin, needed so other LAN devices' browsers/webviews trust it too — copy the `.pem` to each device first): `certutil -addstore Root <path-to-dev-cert.pem>`
- Or replace it with a certificate from a real CA (e.g. via a local CA or a domain + Let's Encrypt) for anything beyond local testing.

If you ever delete `api/certs/` and let the server regenerate it, the new cert won't be trusted until you re-import it.

### Android needs an extra app-side opt-in

Installing the cert as trusted on the device's OS settings is **not enough on Android** — apps targeting API 24+ ignore user-installed CA certificates for their own network connections by default. `mobile/src-tauri/gen/android/app/src/main/res/xml/network_security_config.xml` opts this app into trusting them (referenced from `AndroidManifest.xml` via `android:networkSecurityConfig`). Without this, the app would still throw `ERR_INVALID_CERT_AUTHORITY` even after installing the cert in Settings.

To get the cert onto the phone in the first place (there's no filesystem path to browse to from a phone): email/AirDrop/Nearby-Share/USB-copy the `.pem`, or upload it to Filen and download it on the phone, then:
- **Android**: open the `.pem` → "Install certificate" → Settings → Security → Encryption & credentials → Install a CA certificate.
- **iOS**: opening it installs a configuration profile (Settings → General → VPN & Device Management), but you then *also* need Settings → General → About → Certificate Trust Settings to manually enable full trust for it. No app-side config change needed on iOS (unlike Android).

`gen/android` is a real, checked-in part of the project (only `gen/android/app/build`, `.gradle`, etc. are gitignored) — it's generated once via `tauri android init`, then edited directly going forward, the same way you'd treat a Capacitor/Cordova native project.

## System/speaker-loopback capture (desktop only)

`getDisplayMedia({ audio: true })` turned out to be a dead end (see git history for the original analysis: WebView2 never exposes a "share audio" option at all, and macOS browsers can't capture system audio via that API either). It's been replaced with **native loopback capture in Rust via [`cpal`](https://docs.rs/cpal)**:

- `desktop/src-tauri/src/loopback.rs` opens the *default output* device as an input stream. cpal detects this and does the OS-specific thing automatically: WASAPI loopback on Windows, a CoreAudio aggregate device + tap on macOS, no special-casing needed in our code.
- Captured audio is downmixed to mono, linearly resampled to 48kHz, quantized to 16-bit PCM, and chunked into the same 960-sample frames the mixer expects — emitted to the frontend over a Tauri `Channel` and sent straight onto the existing host WebSocket.
- **Platform support**:
  - **Windows**: works out of the box.
  - **macOS**: requires macOS **14.6+** (cpal's CoreAudio loopback support); the OS will likely prompt for an audio-recording-style permission the first time.
  - **Linux**: cpal's ALSA backend has no automatic loopback — this will probably fail to find a usable input on the default output device. A working setup needs the user's PipeWire/PulseAudio "Monitor of ..." source selected explicitly, which isn't wired up yet.
- **Mobile** (`mobile/`) intentionally does not get this feature — Android/iOS don't expose general system-audio loopback to apps, and `cpal` isn't a good fit there. Microphone-only on mobile.
- Dependency note: `cpal` declares a wide `windows`-crate version range that can otherwise resolve to a *different* copy than the one Tauri/wry already use, breaking the build (`IMMNotificationClient` trait errors). Pinned to `cpal = "0.17"` in `desktop/src-tauri/Cargo.toml`, which only depends on `windows` (no extra `windows-core` edge) and unifies cleanly with Tauri's version.

## WebSocket reconnect/backoff

Both the host and listener WebSocket connections (`desktop/`, `mobile/`) auto-reconnect on drop via `lib/reconnectingSocket.ts`: exponential backoff starting at 1s, capped at 30s, resetting after any successful reconnect. The UI shows "Connecting…" / "Reconnecting… (attempt N)" / "Disconnected" next to the stream while this is happening.

- **Hosting**: capture (microphone or native loopback) and the WebSocket connection are decoupled — capture keeps running across a drop, and frames are simply dropped (not buffered) while disconnected; once reconnected, sending resumes immediately. The host doesn't need to re-pick an audio source or restart capture.
- **Listening**: audio just stops (silence) while disconnected and resumes once reconnected; `AudioPlayback`'s scheduling handles the gap without glitching on resume.
- **Known gap**: the API keeps sessions in memory, so if the *API process itself* restarts while a client is mid-stream, the client's bearer token becomes invalid. Reconnect attempts will keep retrying indefinitely but always get rejected (401) by the server until the user manually stops and logs in again — there's no automatic re-authentication. In practice this only bites during API restarts (e.g. local dev), not on ordinary network blips.
