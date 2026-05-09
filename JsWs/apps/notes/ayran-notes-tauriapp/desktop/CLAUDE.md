# Ayran Notes — Desktop (Tauri)

Cross-platform desktop app (Windows / macOS / Linux) built with **Tauri 2.x + React 19 + Vite 7 + TypeScript + Tailwind v4**.

This project was forked from the completed **Ayran CsDrive** Tauri desktop app on 2026-05-09. All CsDrive features are fully implemented and working. Future development adds notes-specific functionality on top of this foundation.

---

## What is already implemented

### Storage providers (fully working)
| Provider | Operations |
|---|---|
| Google Drive | List, download, upload, edit, rename, copy, move, delete, create folder |
| Filen.io | List, download, upload, edit, rename, copy, move, trash, create folder |
| Local file system | List, download, upload, edit, rename, copy, move, delete, create folder |

### Auth & security
- **Google OAuth:** Full PKCE flow implemented in Rust (`lib.rs` → `start_google_oauth`). Rust opens a loopback listener, receives the OAuth callback, exchanges the code with the client secret — credentials never reach JavaScript.
- **Filen.io:** AuthV2 (PBKDF2-SHA512) and AuthV3 (Argon2id) login in Rust. API key and master keys live only in Rust memory and are persisted encrypted.
- **Encrypted storage:** All accounts stored in `accounts.dat`; Filen sessions in `filen_sessions.dat`. Both use AES-256-GCM with a key protected by DPAPI (Windows) or OS keychain (macOS/Linux). Key is cached in a `OnceLock` per process so it survives page refreshes.
- **CSP:** `connect-src` blocks all external HTTPS from JavaScript. Only Tauri IPC and localhost (dev HMR) are allowed. All Google Drive and Filen network requests are made by the Rust backend.

### UI features
- Breadcrumb navigation (persisted per account in `localStorage`)
- Search within a folder
- Dark / light theme toggle (persisted in `localStorage`, no FOUC)
- Folder picker modal (shared between Google Drive and Filen copy/move)
- Per-item loading states on all action buttons
- Selected account persisted in `localStorage`

---

## Architecture

### Rust crate (`src-tauri/src/`)
```
lib.rs          — App entry, account CRUD commands, Google OAuth commands,
                  StoredAccount struct, pub(crate) helpers: accounts_path / load_accounts / now_ms
storage.rs      — AES-256-GCM read/write; DPAPI (Win) / keyring (mac/Linux) key protection
gdrive.rs       — All Google Drive REST calls: list, download, upload, delete,
                  create_folder, rename, copy, move, edit; internal get_valid_token refreshes
                  the token automatically and persists the new value
filen/
  mod.rs        — Filen session state (FilenSessions Mutex<HashMap>), login, restore,
                  list_directory, download_file, upload_file, create_directory, trash_file,
                  trash_directory, rename_file, rename_directory, move_file, move_directory,
                  copy_file, overwrite_file; sessions persisted to filen_sessions.dat
  crypto.rs     — "002"/"003" metadata decrypt/encrypt; AES-GCM chunk crypto;
                  PBKDF2 / Argon2id key derivation
  api.rs        — HTTP helpers for Filen gateway (Checksum: SHA-512 header) and ingest;
                  upload checksum is SHA-512(JSON.stringify({...})) with ALL values as strings
```

### TypeScript (`src/`)
```
lib/
  account-store.ts   — invoke wrappers: list_accounts, get_account, upsert_account, delete_account
  filen-client.ts    — invoke wrappers for every Filen command + FilenItem type
  google-auth.ts     — connectGoogleDrive (OAuth connect flow only; token management is Rust-side)
components/
  AppShell.tsx            — Top-level layout; persists selected account in localStorage
  AccountManager.tsx      — Sidebar account list + connect buttons
  GoogleDriveExplorer.tsx — Google Drive file browser; all ops via invoke(), no fetch()
  FilenExplorer.tsx       — Filen file browser; same pattern
  FileSystemExplorer.tsx  — Local FS browser using @tauri-apps/plugin-fs
  FolderPickerModal.tsx   — Generic folder picker modal for copy/move (provider-agnostic)
  FilenLoginModal.tsx     — Filen email/password login
  ThemeToggle.tsx         — Dark/light toggle
```

### Key Tauri capabilities (`src-tauri/capabilities/default.json`)
`fs:allow-read-dir`, `fs:allow-read-file`, `fs:allow-write-file`, `fs:allow-mkdir`, `fs:allow-remove`, `fs:allow-rename`, `fs:allow-copy-file`, `dialog:allow-open`, `dialog:allow-save`

### Environment variables
`desktop/.env` (NOT committed) must contain:
```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```
These are read by `build.rs` and injected as `cargo:rustc-env` — they are never exposed to JavaScript.

---

## Development

```powershell
cd desktop
npm run tauri dev   # starts Vite dev server + Tauri window
```

```powershell
cd desktop/src-tauri
cargo check          # fast Rust type check without linking
```

---

## Filen protocol notes (non-obvious)
- Upload ingest checksum: SHA-512 of `JSON.stringify({uuid:"…", index:"0", parent:"…", uploadKey:"…", hash:"…"})` — the `index` value MUST be the string `"0"`, not the number `0`, because URLSearchParams coercion is replicated in the JSON
- Metadata versions: "003" uses hex-decoded 32-byte key; "002" uses PBKDF2-SHA512(key, key, 1, 32) as key
- Rename re-encrypts name + full metadata JSON; move calls `/v3/file/move` or `/v3/dir/move` with `to` field
- Sessions restored from `filen_sessions.dat` on app startup via `load_persisted()` called in the Tauri `setup` hook

## Google Drive notes (non-obvious)
- Token refresh is fully internal to `gdrive::get_valid_token` — it checks `expires_at` with a 5-minute buffer and writes the new token back to `accounts.dat`
- `gdrive_move_file` requires both `from_folder_id` and `to_folder_id` for the `addParents`/`removeParents` query params
- Edit (overwrite content) uses `PATCH /upload/drive/v3/files/{id}?uploadType=media` — preserves name and parents