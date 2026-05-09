# Ayran CsDrive — Desktop (Tauri)

Cross-platform desktop app (Windows / macOS / Linux) built with Tauri 2.x + React 19 + Vite + TypeScript + Tailwind v4.

This is the desktop counterpart of the `ayran-csdrive-webhost-webapp` Next.js web app. The feature set is the same; the architecture is fundamentally different because there is no server — everything runs locally on the user's machine.

## Features to implement

- Connect to **Google Drive** (one or multiple accounts)
- Connect to **Filen.io** (email + password, E2E encrypted)
- Access the **local file system** (native, via Tauri)
- Browse, upload, download, delete files and folders for all providers
- Dark / light theme toggle (default light; persisted in localStorage)

## Architecture

### No proxy — direct API calls

The web app hid client secrets behind a Next.js server and proxied all cloud API requests. Here there is no server: the frontend (React) calls cloud APIs directly via `fetch`. For Google Drive this means the OAuth client secret is embedded in the app bundle — this is acceptable for a "Desktop application" OAuth client type in Google Cloud Console (the secret is not truly confidential for native apps).

### Storage providers

| Provider | Auth | Implementation |
|---|---|---|
| Google Drive | OAuth 2.0 PKCE via deep link | Direct Google Drive REST API via `fetch` + Bearer token |
| Filen.io | Email + password | `@filen/sdk` running in the webview (Chromium) |
| Local FS | None | `@tauri-apps/plugin-fs` + `@tauri-apps/plugin-dialog` |

### Token / account persistence

Use `@tauri-apps/plugin-store` (encrypted JSON store backed by the OS) instead of the web app's `.tokens/accounts.json` file. One store entry per connected account.

### Google OAuth deep link flow

1. Build the Google OAuth URL (PKCE, scope: `https://www.googleapis.com/auth/drive`)
2. Open it in the system browser via `@tauri-apps/plugin-shell` (`open()`)
3. Register a custom URI scheme `io.ayran.csdrive://` via `@tauri-apps/plugin-deep-link`
4. Google redirects to `io.ayran.csdrive://auth/google/callback?code=...`
5. Tauri deep-link listener fires; exchange code for tokens; store via plugin-store

In Google Cloud Console create an **"Desktop application"** OAuth 2.0 client. Add `io.ayran.csdrive://auth/google/callback` as an authorized redirect URI.

### Filen

`@filen/sdk` works in the Chromium webview. After `sdk.login()` store `sdk.config` (including master keys) in the encrypted plugin-store. Reconstruct the SDK from stored config on subsequent launches without re-authenticating.

### Local file system

Replace the browser File System Access API (`showDirectoryPicker`, `FileSystemDirectoryHandle`) with:
- `@tauri-apps/plugin-dialog` — `open({ directory: true })` to pick a folder
- `@tauri-apps/plugin-fs` — `readDir`, `readFile`, `writeFile`, `remove`, `createDir`

No need for IndexedDB handle persistence; store the chosen directory path as a string in plugin-store.

## Stack

- **Tauri 2.x** — native shell, plugin system
- **React 19 + TypeScript** — frontend
- **Vite 7** — bundler
- **Tailwind v4** — styling (`@tailwindcss/vite` plugin, no postcss config)
- **`@tailwindcss/vite`** — Tailwind plugin
- `@tauri-apps/api` — core Tauri JS API
- `@tauri-apps/plugin-opener` — open URLs in system browser
- `@tauri-apps/plugin-store` — persistent encrypted key-value store
- `@tauri-apps/plugin-fs` — file system read/write
- `@tauri-apps/plugin-dialog` — native file/folder picker dialogs
- `@tauri-apps/plugin-deep-link` — custom URI scheme handler for OAuth callbacks
- `@filen/sdk` — Filen cloud storage SDK

## Dark mode

- Default: light
- Toggled by setting `.dark` or `.light` class on `<html>`
- Persisted in `localStorage` under key `theme`
- Inline `<script>` in `index.html` reads localStorage before first paint — no flash
- Tailwind configured with `@custom-variant dark (&:where(.dark, .dark *))` in `src/styles.css`
- `ThemeToggle` component (sun/moon SVG icons, no emoji)

## UI components to port from webapp

All components from `ayran-csdrive-webhost-webapp/src/components/` are portable with minimal changes:

| Webapp component | Desktop equivalent | Changes needed |
|---|---|---|
| `AccountManager.tsx` | Port as-is | Update button callbacks (no `/api/storage/...` routes) |
| `DriveExplorer.tsx` | Port as-is | Change `fetch('/api/drive/...')` to direct Google Drive REST calls |
| `FilenExplorer.tsx` | Port as-is | Call SDK methods directly instead of via `/api/filen/...` |
| `FileSystemExplorer.tsx` | Rewrite | Use `@tauri-apps/plugin-fs` instead of browser File System Access API |
| `ThemeToggle.tsx` | Port as-is | No changes needed |
| `FilenLoginModal.tsx` | Port as-is | Call Filen SDK directly instead of POST `/api/storage/filen/login` |

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

And register them in `src-tauri/src/lib.rs`.

## Security note

The Google OAuth `client_secret` will be in the app bundle. This is standard practice for native desktop OAuth apps ("Desktop application" client type in Google). The secret is not truly confidential but Google accepts this. For Filen, user credentials are entered at runtime and stored in the OS encrypted store — they are never hardcoded.