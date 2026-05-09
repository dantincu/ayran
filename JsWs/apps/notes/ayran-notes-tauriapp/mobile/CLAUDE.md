# Ayran Notes — Mobile (Tauri)

Cross-platform mobile app (Android + iOS) built with Tauri 2.x + React 19 + Vite + TypeScript + Tailwind v4.

This is the mobile counterpart of the `ayran-csdrive-webhost-webapp` Next.js web app and the `../desktop` Tauri desktop app. The feature set is the same; the UI is touch-optimised and the architecture differs because there is no server.

## Features to implement

- Connect to **Google Drive** (one or multiple accounts)
- Connect to **Filen.io** (email + password, E2E encrypted)
- Access the **local file system** (native, via Tauri)
- Browse, upload, download, delete files and folders for all providers
- Dark / light theme toggle (default light; persisted in localStorage)

## Architecture — same as desktop with mobile-specific notes

See `../desktop/CLAUDE.md` for the full architecture overview. Key mobile differences:

### OAuth on mobile

On Android and iOS, the system browser OAuth redirect must use a custom URI scheme registered with the OS:
- iOS: add the scheme to `Info.plist` (Tauri handles via `tauri.conf.json`)
- Android: add an intent filter to `AndroidManifest.xml` (Tauri handles via `tauri.conf.json`)
- Scheme: `io.ayran.notes.mobile://auth/google/callback`
- Use `@tauri-apps/plugin-deep-link` for interception

For Google Cloud Console, create a separate **"Android"** or **"iOS"** OAuth client (or an additional authorized redirect URI on the Desktop client).

### File system on mobile

- On Android/iOS, apps have sandboxed file system access
- Use `@tauri-apps/plugin-dialog` for the document picker (system file picker)
- Use `@tauri-apps/plugin-fs` scoped to accessible paths
- On mobile there is no concept of "open a folder" the same way as desktop — the dialog opens a document picker scoped to allowed directories

### Touch UI

- Bottom navigation bar instead of sidebar
- Larger touch targets (min 44px)
- Swipe gestures for navigation where appropriate
- No hover states — use active/pressed states instead
- Full-screen explorers (no split-panel layout)

## Stack

Same as desktop (see `../desktop/CLAUDE.md`). Dev port is **1421** (desktop uses 1420).

## Dark mode

Identical to desktop — see `../desktop/CLAUDE.md`.

## UI components

Same porting strategy as desktop. Touch-specific adaptations:
- No `group-hover:opacity-100` for action buttons — show them always (or on long-press)
- Use bottom sheets / drawers instead of dropdowns for actions
- `AccountManager` becomes a bottom sheet or a dedicated screen rather than a sidebar

## Tauri plugins needed in Cargo.toml

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-store = "2"
tauri-plugin-fs = "2"
tauri-plugin-dialog = "2"
tauri-plugin-deep-link = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

## To initialise mobile targets

```bash
# Android (requires Android Studio + NDK)
npm run tauri android init
npm run tauri android dev

# iOS (requires macOS + Xcode)
npm run tauri ios init
npm run tauri ios dev
```