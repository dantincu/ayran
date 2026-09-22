# Ayran CsDrive WebHost

A Tauri app (desktop and Android) with a React admin-app, system apps (Notes) and user web apps. How it is built and how it
behaves is in [CLAUDE.md](CLAUDE.md); how recurring problems are solved is in [docs/strategies](docs/strategies/README.md).

## Careful: development runs can reach production data

If the machine you develop on also runs the app for real, and the real one uses **Settings → Change data folder** (a custom data
folder), read this before running anything.

**Where the pointer lives.** The choice of a custom data folder is recorded in one small encrypted file, `data-location.enc`, in the
*default* data folder (`%APPDATA%\com.ayran.csdrive-webhost-tauriapp`, from `DEFAULT_DATA_FOLDER` in
`csdrive-webhost-tauriapp/src-tauri/src/layout.rs`). It has to live there so the app can find the rest of its data, which means
**any build with the same `DEFAULT_DATA_FOLDER` reads the same pointer and opens the same custom folder** — `cargo tauri dev`, a
plain debug run, an installer you built to try something. It is not a separate "development" profile.

**What that means for a dev or test run that is not isolated:**

- It opens the production `admin/data.db`, the `user` folder, the Filen sessions and the Notes cache in `files/` — reads *and* writes.
  A test that creates notes, tags, windows or files creates them in the real data.
- It shares the encryption key with the real app (the keychain entries are named after the last component of `DEFAULT_DATA_FOLDER`),
  so it can decrypt the real Filen sessions and would act on the connected Filen accounts.
- **Settings → Change data folder**, "clear the custom data folder" and **Delete app data** act on the pointer and on the folders it
  names: using them in a dev run rewrites or removes the *production* pointer, or wipes the production data.
- The `seed_demo_data` example (`cargo run --example seed_demo_data`) finds the real data folder the same way the app does,
  a relocated one included, and writes to its `data.db`. Its `seeded:` tag protects other rows, not the fact that it is the real database.

**What to do.**

1. **While developing, debugging or testing, keep the custom data folder unchecked** (Settings → clear the custom data folder) — or
   better, don't share the machine's default at all:
2. **Isolate the run.** Set `DEFAULT_DATA_FOLDER` in `layout.rs` to a scratch absolute path (e.g. `r"C:\Temp\csdrive-isolated-test"`) and
   rebuild. The run then has its own pointer file, data folder, database and keychain entries and cannot reach the real ones. Set it
   back before building anything you will install or use for real (an installer built with the scratch value would start empty).
   Delete the scratch folder afterwards.
3. Never point a test at the production data folder, and never run the demo seeder against it. If something must be checked against
   real data, copy the data folder somewhere else first and work on the copy.
4. Android is not affected: it has no custom data folder, and the emulator's app data is its own.

The isolation switch and its caveats are also described under "Folder layout" in [CLAUDE.md](CLAUDE.md).
