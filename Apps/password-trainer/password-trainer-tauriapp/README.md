# Ayran Password Trainer

A Tauri 2 app (React + TypeScript frontend, Rust backend) for practising important passwords from memory. The spec is in `CLAUDE.md`.

## How it works

- **Storage**: `passwords.json` in the app data folder. It holds a label and an Argon2id hash for each password, each hash with its own random salt (`src-tauri/src/store.rs`). Passwords are never stored, and the hashes never reach the UI: it gets ids and labels and asks the backend to check an attempt (`check_password`). Saves are atomic (a temporary file, then a rename). A damaged file is reported, never overwritten.
- **List view** (`src/ListView.tsx`):
  - **Editing**: add, edit (the label, and optionally a new password), delete the selection.
  - **Selection**: Shift-click, right-click or long-press a checkbox to set every row between it and the checkbox toggled before to the new state.
  - **Reordering**: drag the ⠿ handle (pointer events, so touch works too; dragging a selected row moves the whole selection), or use the up and down arrows on the selection.
- **Training view** (`src/TrainView.tsx`): a password field you can't copy, cut, drag from or open a context menu on (`src/noCopy.ts`), and a ✓ button (or Enter) to check it against the hash.
- **Android**:
  - Autofill is excluded from the window, so password managers never offer to save what you type (`MainActivity.kt`).
  - `allowBackup="false"` keeps the hash file out of cloud backups.

## Commands

```sh
npm install
npm test                      # frontend list logic
cd src-tauri && cargo test    # store and hashing
cargo tauri dev               # desktop
```

### Icon

The sources are in `icon-src/`. `app-icon.svg` is the desktop icon. The `android-*.svg` files are the adaptive launcher icon's background, foreground (kept inside the safe zone) and monochrome layers. Regenerate every platform's icons, including the Android project's mipmaps, with:

```sh
cargo tauri icon icon-src/icon-manifest.json
```

### Android release

Needs `ANDROID_HOME` (`%LOCALAPPDATA%\Android\Sdk`) and `NDK_HOME` (an NDK under it).

```sh
cargo tauri android build --apk --target aarch64
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

Release signing reads `private/android-release-signing.properties`, which points at `private/release.keystore`. That folder is gitignored and must never be committed. **Keep a backup of it.** Without the same key, an update can't be installed over the existing app; you'd have to uninstall it, which deletes the stored hashes. Set `PASSWORD_TRAINER_ANDROID_KEYSTORE_PROPERTIES` to use a properties file somewhere else.
