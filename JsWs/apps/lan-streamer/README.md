# Ayran LAN Streamer

See [CLAUDE.md](./CLAUDE.md) for the product spec. This is a v1 end-to-end skeleton:

- `api/` — Node.js + TypeScript API (Express + `ws`). HTTPS-only; serves whatever cert/key is at `certs/dev-cert.pem`/`dev-key.pem` (auto-generates a self-signed one there if missing, but the deployed instance uses a real Let's Encrypt cert — see below). Filen.io login via `@filen/sdk` issues an opaque session token; streams are persisted to `api/data/streams.json`, scoped per Filen account. Multi-host audio is mixed by summing 20ms 48kHz mono PCM frames and rebroadcast to listeners over WebSocket.
- `api-rs/` — Rust reimplementation of `api/` (axum + tokio), full feature parity, byte-compatible session encryption format — see "Deploying the API (Rust)" below. This is the actual live deployment now.
- `desktop/` — Tauri 2 + React 19 desktop client (`io.ayran.lanstreamer.desktop`, dev port 1420). Can host (microphone, or system/speaker-loopback capture via a native `cpal` Rust backend — see below) and listen at the same time - `HostPanel`/`ListenerPanel` are both always mounted in `App.tsx`, the Host/Listen tabs just toggle which is visible, not which is active.
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

## Deploying the API (Rust)

`api-rs/` is a from-scratch Rust reimplementation of `api/` (axum + tokio, full feature parity — Filen auth, sessions, streams CRUD, account settings, and all three mixer modes), built to compare against possible Node-side causes for the audio timing issues elsewhere in this doc (it wasn't the cause - the same issues reproduce identically under both, see "Pitch artifact root causes" below). It's now the actual live deployment.

```
cd api-rs && cargo build --release
```

Produces a single self-contained binary at `api-rs/target/release/lan-streamer-api.exe` — no `node_modules`-equivalent runtime dependency, just the one file. Copy it (plus `certs/dev-cert.pem`/`dev-key.pem` and an empty `data/` dir alongside it) to wherever you're running it from - same working-directory-relative convention as the Node version, just with its own separate `certs/`/`data/` (not shared with the Node deployment's). Deployed at `C:\Users\danti\AppData\Local\Ayran\Apps\Bin\lan-streamer\api-rs\bins\lan-streamer-api.exe`, run from the `api-rs/` parent directory so `./certs` and `./data` resolve correctly.

**Session encryption is byte-compatible with the Node version's `data/sessions.enc` format** (AES-256-GCM, `iv(12) + authTag(16) + ciphertext` - RustCrypto's AEAD convention appends the tag at the end instead, so `store.rs` explicitly reorders bytes on the way in and out to match Node's layout) - verified via a cross-language round trip (encrypt in Node, decrypt in Rust). The DPAPI-protected session key file is identical either way (same PowerShell-shelling approach). This means either deployment can read the other's `data/sessions.enc` if pointed at the same directory, though the current deployment deliberately uses separate `data/` dirs.

**It does not generate its own TLS certificate** (unlike the Node version's self-signed fallback) - `tls.rs` just loads whatever real cert is already at `certs/dev-cert.pem`/`dev-key.pem` and errors clearly if missing, since a self-signed cert was never going to be used here anyway (see "TLS certificate" below).

Deploy/manage scripts, mirroring the Node ones, live in `f:\T\turmerik\Scripts\Deploy\For-Cmder\ayran-lan-streamer\api-rs\`:
- `run-ayran-lan-streamer.bat` — runs `bins\lan-streamer-api.exe` at High OS priority (same reasoning as the Node version's run script).
- `stop-ayran-lan-streamer.bat` — kills whatever's listening on port 9443 (works for either deployment, since only one ever runs at a time).
- `renew-ayran-lan-streamer-cert.sh`/`.bat` — installs the renewed cert to `api-rs/certs/` specifically and restarts `lan-streamer-api.exe` (not `node`). The "Ayran LAN Streamer - Cert Renewal" scheduled task points here now, since `api-rs` is the live deployment.

## Deploying to Android

Debug build (Gradle auto-signs with a generated debug key — fine for testing, not for distributing):

```
cd mobile
npm install
npm run tauri android build -- --target aarch64 --debug
```

```
mobile\src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
```

Release build (drop `--debug`) — requires the signing config below to already exist, otherwise Gradle produces an unsigned APK that Android refuses to install:

```
cd mobile
npm run tauri android build -- --target aarch64
```

```
mobile\src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk
```

`--target aarch64` matches the vast majority of real phones; drop it to build all ABIs if you need to support x86 emulators too (slower build).

Install over USB with the device's "USB debugging" developer option enabled:

```
adb devices                              # confirm the device shows as "device", not "unauthorized"
adb install -r --user 0 <path-to-apk>
```

**Always pass `--user 0` explicitly.** Without it, a plain `adb install` can end up installing into *every* Android user profile on the device — including a Samsung "Dual Apps"/Dual Messenger profile if one exists (`adb shell pm list users` will show something like `UserInfo{95:DUAL_APP:...}` if so), which shows up as a confusing second "ghost" icon with a small badge in the app drawer. If that's already happened, removing it doesn't require reinstalling: `adb shell pm uninstall --user <id> io.ayran.lanstreamer.mobile` removes it from just that one profile.

Toolchain note specific to this dev machine: if `tauri android build`/`dev` fails trying to invoke a broken Java install, the system's default Android Studio JBR can be missing core JRE files. Point `JAVA_HOME` at a working JDK for the command instead, e.g.:

```
JAVA_HOME="C:\Program Files\Android\Android Studio1\jbr" npm run tauri android build -- --target aarch64 --debug
```

(Note the `Android Studio1` vs `Android Studio` — there were two installs on this machine, only one with a complete JBR.)

### Release signing

Release builds need a real signing config — unlike debug builds, Gradle won't auto-sign them, and an unsigned APK can't be installed at all. The keystore itself lives **outside the repo** (same reasoning as the API's TLS cert/key — see below): `C:\Users\victo\AppData\Roaming\Ayran\Keystores\ayran-lan-streamer-mobile.jks`, generated once via:

```
keytool -genkeypair -v -keystore <path>.jks -keyalg RSA -keysize 2048 -validity 10000 -alias ayran-lan-streamer-mobile
```

`mobile/src-tauri/gen/android/keystore.properties` (gitignored — see `gen/android/.gitignore`) points `build.gradle.kts`'s `release` signing config at it:

```properties
storeFile=C:/Users/victo/AppData/Roaming/Ayran/Keystores/ayran-lan-streamer-mobile.jks
storePassword=...
keyAlias=ayran-lan-streamer-mobile
keyPassword=...
```

If that file is missing, `build.gradle.kts` just skips applying a signing config to the `release` build type (checked via `keystoreProperties.containsKey("storeFile")`), so a release build still runs but produces an unsigned, uninstallable APK rather than failing outright. Verify a built APK is actually signed correctly with `apksigner` (in `<Android SDK>/build-tools/<version>/`):

```
apksigner verify --print-certs <path-to-apk>
```

## TLS certificate: real cert via DuckDNS + Let's Encrypt (DNS-01)

The API serves whatever's at `certs/dev-cert.pem`/`certs/dev-key.pem` (relative to wherever the process runs from) — by default it auto-generates a **self-signed** cert there on first run. That works for desktop (just trust it once via `certutil`), but **Android increasingly restricts manually installing user CA certificates through the Settings UI** — on at least some Samsung/One UI versions, every install path (Settings → Encryption & credentials, tapping the file directly, even the WPA2-Enterprise CA-cert picker) demands a private key as if it were a client identity cert, with no working manual fix short of MDM enrollment or root.

So for the actual deployed instance, the self-signed cert was replaced with a **real Let's Encrypt certificate**, via a DNS-01 challenge — this only proves DNS control, so it needs no port-forwarding or public exposure at all:

1. A free [DuckDNS](https://www.duckdns.org) subdomain (`ayran-lan-streamer.duckdns.org`) has its **A record pointed at the LAN IP** of the machine running the API (`192.168.1.14`, not a public address). DNS happily resolves a hostname to a private IP; clients on the same LAN resolve the name and connect directly, no traffic ever leaves the network.
2. [`acme.sh`](https://github.com/acmesh-official/acme.sh) (installed to `~/.acme.sh`) requests a cert from Let's Encrypt using the `dns_duckdns` plugin, which adds/removes the `_acme-challenge` TXT record via DuckDNS's API — no webserver exposure needed for validation either.
3. The resulting cert is installed to **both** `api/certs/` (repo, for dev) and the deployed `…\Apps\Bin\lan-streamer\certs\` via `acme.sh --install-cert`.
4. Both apps' `DEFAULT_API_BASE_URL` (`desktop/src/lib/config.ts`, `mobile/src/lib/config.ts`) now point at `https://ayran-lan-streamer.duckdns.org:9443` instead of `localhost` — this hostname works from any device on the LAN, including phones, with a cert every OS already trusts. No manual cert install needed on any client, ever, going forward.

**Renewal**: Let's Encrypt certs expire after 90 days. `f:\T\turmerik\Scripts\Deploy\For-Cmder\renew-ayran-lan-streamer-cert.{sh,bat}` re-runs the DNS-01 renewal (a no-op if not yet due), reinstalls to both cert locations, and restarts the deployed API. A Windows Scheduled Task ("Ayran LAN Streamer - Cert Renewal") runs it daily at 4am. The DuckDNS token is hardcoded in the `.sh` script — acceptable for a personal home-lab setup with a low-value token, but don't reuse that pattern for anything more sensitive.

**Caveat**: this only fixed the default for *new* logins. Existing installs already have the old URL saved in `localStorage` (it persists on every edit, not just successful logins — see `LoginScreen.tsx`), which always wins over the constant. Each existing device needs the API server URL field edited once (or `localStorage.removeItem("lan-streamer:apiBaseUrl")` via devtools) to pick up the new default.

The self-signed-cert path (`certutil -addstore`, Android's `network_security_config.xml` opt-in, etc.) still exists as a fallback for fully offline/no-internet LAN setups where DuckDNS isn't reachable — see git history for those exact steps if needed. `mobile/src-tauri/gen/android/app/src/main/res/xml/network_security_config.xml` (trusting user-installed CAs, referenced from `AndroidManifest.xml`) is left in place either way; it's harmless now that a publicly-trusted cert is in use, and still relevant if you ever fall back to self-signed.

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
- **Sessions survive API restarts**: tokens are persisted encrypted at rest (`data/sessions.enc`, AES-256-GCM). A restart no longer forces every client to log back in.
  - The AES key itself is protected via an OS-native secure store (`api/src/secureStore.ts` dispatches by `process.platform`) before being written to `data/session-key.bin` — on Windows that's DPAPI (`secureStore.windows.ts`, shelling out to PowerShell's `[System.Security.Cryptography.ProtectedData]` rather than a native Node addon, so the API stays a single dependency-free `bundle.cjs`). This ties decryption to *this Windows user account on this machine* — copying both `data/` files to another machine or user doesn't let you decrypt them, unlike a plain key sitting unencrypted next to its ciphertext.
  - macOS/Linux aren't implemented yet — `secureStore.ts` throws a clear error naming the missing platform if you run the API there. Add `secureStore.darwin.ts` (Keychain, e.g. via the `security` CLI) or `secureStore.linux.ts` (libsecret, e.g. via `secret-tool`) following the same `protect`/`unprotect` shape as `secureStore.windows.ts`, then wire the case into `loadSecureStore()`.

## Hosting and listening at the same time

The original spec said a device could be a host *or* a listener, never both. That constraint was relaxed: `App.tsx` (`desktop/`, `mobile/`) keeps both `HostPanel` and `ListenerPanel` mounted at all times once logged in - the "Host"/"Listen" tabs in the header only toggle which one is *visible* (a plain CSS `hidden` class), not which one is running. A device can host one stream and listen to a different one simultaneously; switching tabs back and forth doesn't interrupt either.

On mobile, this meant the background-survival foreground service (see below) could no longer be a simple start/stop - `foregroundService.ts` reference-counts by caller (`"host"` vs `"listen"`), so stopping one doesn't tear down the other's background survival, and the service's notification reflects whichever role most needs it (mic-using foreground-service-type takes priority while active, since that's the one with an extra permission requirement).

## Stream modes: merged vs simple vs raw

Each stream is created as one of three modes (`StreamRecord.mode`, chosen at creation time in the "New stream" form, immutable after that):

- **Merged** (the original/default behavior): any number of hosts can stream into it at once; `api/src/audio/mixer.ts` sums their frames on a 20ms tick.
- **Simple**: exactly one host streams at a time, forwarded directly with no mixing tick at all (`forwardSimpleFrame` in `mixer.ts` runs synchronously off each incoming frame, not a `setInterval`) — lower latency and immune to the mixer-tick-timing class of issues merged streams can hit under host CPU contention. Still goes through the same per-device volume cap (`forwardSimpleFrame` calls `getAccountSettings` exactly like the merged path).
- **Raw**: same single-active-host/superseding behavior as Simple, but completely unprocessed end to end - `forwardRawFrame` skips the limiter and volume cap server-side, **and** `HostPanel.tsx` (`desktop/`, `mobile/`) locks the live capture gain at 1 instead of applying "This device's volume" (that slider is disabled with an explanatory tooltip while hosting a raw stream). Added because a "slightly lowered pitch" was still noticeable even on Simple streams; turned out that artifact was unrelated to either volume control - see "Pitch artifact root causes" below for what it actually was. Still a useful mode in its own right for anyone who wants bit-exact passthrough with zero processing on either end.

### Pitch artifact root causes (resolved)

The "slightly lowered pitch" reported even on Simple/Raw streams, and even when hosting and listening on the *same* PC (ruling out network/WiFi entirely), turned out to be two separate, real bugs - found by trusting the diagnostics over assumptions: network/buffer diagnostics showed a perfectly healthy 0%-loss, stable ~200ms buffer the whole time, and the raw `test-tone.wav` file played back cleanly outside the app, which together ruled out everything network- and content-related and pointed at the capture and playback code itself.

1. **Test-tone capture had its own clock-drift bug**: `captureTestToneStream()` (`audioCapture.ts`, `desktop/`+`mobile/`) used to decode/loop the tone in its own `AudioContext`, then bridge it into `AudioCapture`'s separate context via a real `MediaStreamDestination`/`MediaStreamSource`. Two independent contexts each have their own real-time clock, and bridging them through an actual `MediaStream` let those clocks drift against each other, corrupting the captured samples before they ever reached the network - explaining why audio sounded wrong despite every network-side diagnostic being clean. Fixed by decoding and looping the tone directly inside `AudioCapture`'s own single context (`connectTestTone()`) - one clock end to end, no bridge. This only affected the `test-tone` source; microphone/system capture were never affected by this specific bug.
2. **The listener-side adaptive rate correction had no deadband** (`playback-worklet.js`, `desktop/`+`mobile/`): the buffer level naturally oscillates a few percent around its target under perfectly healthy conditions (confirmed ~190-210ms around a 200ms target, with 0% measured loss) - without a deadband, the correction reacted to *every* one of those normal wobbles, applying a small but never-zero, continuously-varying playback rate change. That's audible as a constant pitch wobble, especially on a sustained tone, even with nothing actually wrong. Fixed by adding `ERROR_DEADBAND` (15%): deviations within the band get no correction at all (rate stays exactly 1.0); only larger, sustained deviations beyond it still engage the (still small, ±3%) `MAX_RATE_ADJUST`.

Simple and Raw share the same **single active host with superseding** behavior: a second host starting up immediately supersedes whichever one was streaming before it - the server sends the superseded host a `{"type":"superseded"}` text control message over its still-open host WebSocket and then closes it; that host's `HostPanel.tsx` listens for this and stops itself with an explanatory error rather than silently going quiet. `attachExclusiveHost` in `ws-handlers.ts` implements this once, shared by both modes (they only differ in which `forward` function gets called per frame).

Deleting a stream (any mode) works the same way for all three — any device authenticated to the owning Filen account can delete it, not just whoever created it (same account-scoped check as everything else).

## Volume safety: per-device limiter + per-device gain

Two distinct, deliberately separate mechanisms:

- **Account-wide safety cap, enforced by the API** (`api/src/audio/mixer.ts`): before summing device streams together for a given account stream, each device stream's peak amplitude is limited to `maxDeviceAmplitude` (default `0.85`, i.e. 85% of full-scale 16-bit PCM — see `api/src/config.ts`) via a one-pole envelope limiter, not a hard clip. Fast attack (5ms) catches a sudden loud transient almost immediately; slower release (150ms) eases the gain back up smoothly afterward, avoiding the audible "pop" a hard `min(value, ceiling)` clamp would cause. Verified directly: feeding 5 full-scale frames through the mixer shows the output gain easing from ~32700 down to a settled ~16384 (the configured 50%-amplitude ceiling in that test) over ~2-3 frames, never snapping.
  - This is an **account setting**, not a per-stream one — `GET`/`PUT /api/account/settings` (`{ maxDeviceAmplitude }`, range `0.1`-`1`), persisted to `data/account-settings.json`. Editable from either the host or listener screen (`MaxAmplitudeControl.tsx` in both `desktop/` and `mobile/`), since it protects whoever ends up listening regardless of which screen someone happens to be on.
- **Per-device gain, applied entirely client-side, never sent to the API**: each host's "This device's volume" slider (0-100%, default 100%) multiplies its own captured audio *before* it's sent over the WebSocket. For microphone/in-browser capture this is a Web Audio `GainNode` inserted before the `ScriptProcessorNode` (`audioCapture.ts`); for native loopback capture on desktop, it's an `Arc<AtomicU32>`-backed f32 gain read inside the `cpal` audio callback (`loopback.rs`, exposed via a new `set_loopback_gain` Tauri command so the slider updates it live, mid-stream, without restarting capture). This only ever lowers a device's own contribution — it cannot raise it above the 100% default, and it's independent of the account-wide cap above.
  - Persisted to `localStorage` (`lan-streamer:deviceGain`) on the device itself, not the server — deliberately, since this is a per-device hardware/placement preference (e.g. "this laptop's mic is hot, this one's is quiet"), not something tied to the account that should follow a user to a different device.

Both settings survive a restart: the account-wide cap is confirmed surviving a real API restart (set, then reloaded via a fresh `loadAccountSettings()` call in a separate process — same persistence pattern as `streams.json`/sessions); the per-device gain is read from `localStorage` on mount in both `desktop/` and `mobile/`'s `HostPanel.tsx`.

## Audio quality: stereo + cubic resampling

Two upgrades from the original mono/linear-interpolation pipeline:

- **Stereo throughout the pipeline** — wire format is now interleaved 16-bit PCM `[L0,R0,L1,R1,...]`, 960 sample-pairs (20ms) per frame, `BYTES_PER_FRAME = 960 * 2 channels * 2 bytes = 3840` (`api/src/audio/mixer.ts`). Mono sources (most microphones) are duplicated to both channels automatically — `audioCapture.ts` fixes `ScriptProcessorNode`'s `numberOfInputChannels` at 2, which makes the Web Audio graph up-mix a mono source for free, so the JS code never needs to branch on the source's actual channel count. `loopback.rs` does the same explicitly (`stereo_from_frame`).
  - **The limiter is "linked" in stereo**: both channels of a sample pair share one gain value, derived from whichever channel is louder (`Math.max(|L|, |R|)`), rather than limiting each channel independently. Independent per-channel limiting would shrink whichever channel happens to be louder at any instant, smearing the stereo image left/right as the signal moves. Verified directly: a frame with full-scale left / 10%-amplitude right stays at *exactly* a 0.1 L/R ratio throughout the entire easing transition.
  - Multi-host mixing sums L and R independently per index — verified with two synthetic stereo hosts summing to the expected per-channel totals.
- **Cubic (Catmull-Rom) resampling** replaces linear interpolation in `loopback.rs`'s native system-audio capture path (the only place this project does its own resampling — the browser's Web Audio API already resamples mic/test-tone input internally at high quality). Same O(1)-per-sample cost and no added latency (no look-ahead beyond the 1-sample-back/2-sample-forward neighbors already needed structurally), but meaningfully less aliasing/distortion than linear, especially for content with energy above a few kHz (i.e. music, not just voice). Verified with Rust unit tests (`cargo test --lib loopback`): the interpolation is exact at `t=0` and reproduces the original signal exactly (to float precision) when input and target sample rates match, which wouldn't be true if the math were wrong.

`test-tone.wav` was regenerated as genuinely stereo (left: the original quiet/loud/quiet 440/523Hz pattern that drives the limiter test; right: the same envelope at half amplitude on different pitches, 330/392Hz) so it can also be used to audibly confirm L/R aren't collapsing to mono anywhere in the pipeline, not just to test the volume cap.

**Test-tone capture used to introduce its own pitch distortion**, independent of the network/buffer issues elsewhere in this doc - confirmed by the network-side diagnostics showing a perfectly healthy buffer (0% loss, stable ~200ms level) while the audio was still audibly wrong, and by the raw `.wav` file playing back cleanly outside the app. The cause: `captureTestToneStream()` used to decode/loop the file in its *own* `AudioContext`, bridged into `AudioCapture`'s separate context via a real `MediaStreamDestination`/`MediaStreamSource` - two independent contexts each have their own real-time clock, and bridging them through an actual `MediaStream` let those clocks drift against each other, corrupting the captured samples before they ever reached the network. Fixed by decoding and looping the tone directly inside `AudioCapture`'s own single context (`connectTestTone()` in `audioCapture.ts`) - one clock end to end, no bridge.

## Background survival on Android (mobile)

Android suspends or kills ordinary background app processes fairly aggressively (Doze, App Standby, per-app background execution limits) - hosting or listening would otherwise stop within seconds of turning the screen off or switching apps. `mobile/src-tauri/gen/android/app/src/main/java/io/ayran/lanstreamer/mobile/StreamingForegroundService.kt` is a native foreground service (the same mechanism music/calling apps use) that's started when hosting/listening begins and stopped when it ends:

- Shows an ongoing notification ("Hosting an audio stream" / "Listening to an audio stream") - this is an Android platform requirement for any foreground service, not something this app can opt out of. Tapping it reopens the app.
- Declares `foregroundServiceType="mediaPlayback|microphone"` in `AndroidManifest.xml` (required on Android 14+, matched to whichever role is actually active) and holds a partial wake lock for as long as it's running, so the CPU doesn't fully sleep and stall the WebView's audio/WebSocket work.
- `mobile/src-tauri/src/foreground_service.rs` is the Rust↔Kotlin bridge: two Tauri commands (`start_foreground_service`/`stop_foreground_service`) call the service's static `start`/`stop` methods directly via JNI (using the `jni`/`ndk-context` crate versions already pinned by Tauri's own Android support - see the comment in `Cargo.toml`), rather than a full Tauri plugin for what's otherwise two one-line calls. Wired into `HostPanel.tsx`/`ListenerPanel.tsx` via `mobile/src/lib/foregroundService.ts`.
- `POST_NOTIFICATIONS` (required at runtime on Android 13+) is requested once from `MainActivity.onCreate` - a best-effort ask; if denied, the foreground service still keeps running and exempts the app from background limits, Android just can't show the notification.
- **The foreground service alone wasn't enough to keep mic hosting working in the background** - confirmed by testing: it kept the process alive, but audio capture still silently stopped. The actual cause is a second, independent mechanism: the generated `WryActivity.onPause()` (`gen/android/.../generated/WryActivity.kt`, marked do-not-modify) unconditionally calls `WebView.onPause()`, which suspends JS timers/processing - that's what was actually breaking `ScriptProcessorNode`-based capture, regardless of the process's foreground-service status. Since `WryActivity`'s WebView field is private, `MainActivity.onPause()` (safe to edit, not generated) instead finds the WebView itself via the public view hierarchy and immediately calls `.onResume()` on it again right after, but only while `StreamingForegroundService.isActive` is true (set by the service's own `start`/`stop`) - so JS keeps running normally while actively streaming, but the WebView still pauses normally (saving battery) the rest of the time.
- Desktop-only feature: `desktop/`'s equivalent files don't exist - desktop apps aren't subject to the same OS-level background suspension Android applies.
- The foreground service is only started **after** `captureStream()` already succeeds, not before - requesting the `microphone` foreground-service-type before `RECORD_AUDIO` is actually granted throws a `SecurityException` and crashes the app (confirmed via `adb logcat`'s `FATAL EXCEPTION` trace), since `captureStream()` succeeding is what proves the permission was granted. Hosting via `test-tone` (no real mic) requests the `mediaPlayback` type instead, so it never needs `RECORD_AUDIO` at all.
- **`MODIFY_AUDIO_SETTINGS` is required in `AndroidManifest.xml` alongside `RECORD_AUDIO`** for WebView's `getUserMedia(audio)` to work at all - missing it produces a `NotAllowedError: Permission denied` from `getUserMedia` even with `RECORD_AUDIO` itself fully granted (confirmed via `adb logcat`'s `cr_media: Requires MODIFY_AUDIO_SETTINGS and RECORD_AUDIO` warning, and `adb shell dumpsys package` showing `RECORD_AUDIO: granted=true` but `MODIFY_AUDIO_SETTINGS` entirely absent from the held-permissions list). Unlike `RECORD_AUDIO`, it's a "normal" permission - declaring it in the manifest is enough, Android grants it automatically at install with no runtime prompt.

## Client-side session storage (desktop/mobile)

The session token persisted by the Tauri apps (`desktop/src-tauri/src/session.rs`, `mobile/src-tauri/src/session.rs`) is stored in the OS-native credential store via the [`keyring`](https://docs.rs/keyring) crate (`keyring::v1::Entry`) rather than a plain JSON file — on Windows that's Credential Manager (DPAPI-backed), giving the same "tied to this OS user account" property as the API's session-key protection above.

**Android** needed real extra plumbing beyond just adding the crate, worth knowing about if this ever needs touching again:
- `keyring`'s Android backend (`android-native-keyring-store`) depends on the `ndk-context` crate's global Android context, which Tauri 2/`wry` does **not** populate automatically despite that crate's docs claiming otherwise (verified: `wry`/`tauri-runtime-wry` don't even depend on `ndk-context`). Calling into it before it's set panics.
- Fixed with a small Kotlin shim — `mobile/src-tauri/gen/android/app/src/main/java/io/crates/keyring/Keyring.kt` declares the `external fun initializeNdkContext` that `android-native-keyring-store` exports as a JNI symbol (compiled into our own `liblan_streamer_mobile_lib.so`, not a separate native lib), and `MainActivity.kt`'s `onCreate` calls it once with `applicationContext` before any session command can run.
- Separately, `keyring`'s Android backend doesn't auto-register itself as the default credential store the way the Windows one does — `session.rs` lazily calls `android_native_keyring_store::Store::new()` + `keyring_core::set_default_store()` once, guarded by a `OnceLock`, on first actual use (not eagerly at `run()` time, since the Kotlin-side `initializeNdkContext` call and Tauri's own startup sequencing means the context isn't ready that early either).
- Verified for real on a physical device (not just compiled): a temporary debug command exercised save → load → verify → clear → verify-gone through the actual Android Keystore and confirmed via `adb logcat`, then removed once confirmed working.
- iOS isn't wired up (`keyring` supports it via `apple-native-keyring-store`, untested here) — expect a similar context-plumbing gap to Android, though Apple platforms may not need the Kotlin-equivalent shim since Keychain access doesn't depend on `ndk-context`.
