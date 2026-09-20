//! WHERE THINGS LIVE â€” the one place to change it.
//!
//! Every path the app uses for its own data is built from the constants below (there
//! are no other hardcoded copies), so editing one line here relocates that part of the
//! app everywhere: the backend, the keychain entries, the `seed_demo_data` example.
//! Uses only `std` so the example can `#[path]`-include this very file.
//!
//! To run the app completely isolated from your real data â€” e.g. for tests â€” point
//! `DEFAULT_DATA_FOLDER` at a scratch folder. It's a *default*: the user can still
//! relocate the data folder from the Settings tab (recorded in a pointer file inside
//! this default folder), and that choice wins over the default.

use std::path::{Path, PathBuf};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// >>>  EDIT HERE  <<<
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// The default data folder: everything the app stores lives inside it (the `user`
/// and `admin` folders below, plus the small pointer file that records a relocation).
///
/// A relative name is placed inside the OS per-user app-data folder (`%APPDATA%` on
/// Windows), so the default is `%APPDATA%\com.ayran.csdrive-webhost-tauriapp`. An
/// absolute path is used as is (e.g. `r"C:\Temp\csdrive-isolated-test"`).
///
/// The last path component doubles as the name of this app's OS-keychain entries
/// (Filen sessions, the pointer file's encryption key) â€” so pointing this somewhere
/// else also gives a run its own, separate keychain entries.
pub const DEFAULT_DATA_FOLDER: &str = "com.ayran.csdrive-webhost-tauriapp";

/// The app's own files inside the data folder (`data.db`, the Filen sessions). Nothing
/// in here is ever served to a window: the admin-app itself is not a file in the data
/// folder but the Tauri app's own compiled-in frontend (`frontendDist` in `tauri.conf.json`).
pub const ADMIN_FOLDER: &str = "admin";

/// The admin-app's `app_id` for its saved UI state (see `app_state`). A web app's is the
/// relative path of its html file, so this is deliberately not a valid one and can never
/// collide with theirs.
pub const ADMIN_APP_ID: &str = "::admin";

/// The encrypted file holding every connected Filen.io account's session (API key,
/// master keys, ...), relative to the data folder. Encrypted with the app key kept in
/// the platform key store (see `secure_store`). It lives in the data folder on purpose:
/// it travels with `data.db` (which lists the accounts) when the folder is relocated.
pub const FILEN_SESSIONS_FILE: &str = "admin/filen-sessions.enc";

/// User-authored content inside the data folder: web apps, and whatever else the
/// Files tab manages.
pub const USER_FOLDER: &str = "user";

/// The Notes app's cache of Filen accounts and their branches (see `files_cache.rs` and
/// `docs/strategies/folder-pairs-strategy.md`), a sibling of `admin` and `user`. Nothing in it is
/// reachable through the file commands; it is only ever used through the cache's own commands.
pub const FILES_FOLDER: &str = "files";

/// Inside `files`: one folder pair per cached account (its short folder holds `c`, the cached contents).
pub const FILES_ACCOUNTS_FOLDER: &str = "a";

/// Inside `files`: one folder pair per account with branches (its short folder holds one pair per branch).
pub const FILES_BRANCHES_FOLDER: &str = "b";

/// Inside an account's short folder in `a`: the mirror of the account's files (only what was opened or exported).
/// Inside `files`: where uploads from a window into a local folder are assembled (`fs_upload.rs`);
/// emptied at every start.
pub const FILES_LOCAL_UPLOADS_FOLDER: &str = "local-uploads";
pub const FILES_CONTENT_FOLDER: &str = "c";

/// The cache's own database: listings, metadata, settings and branch changes, inside `files`.
pub const FILES_DB: &str = "data.db";

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// `os_data_dir` is the OS per-user app-data folder (`%APPDATA%` on Windows).
pub fn default_data_dir(os_data_dir: &Path) -> PathBuf {
    os_data_dir.join(DEFAULT_DATA_FOLDER)
}

/// Name for this app's OS-keychain entries: the last component of `DEFAULT_DATA_FOLDER`.
#[cfg_attr(mobile, allow(dead_code))] // only the desktop keychain uses it
pub fn keychain_service() -> &'static str {
    let trimmed = DEFAULT_DATA_FOLDER.trim_end_matches(['/', '\\']);
    trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed)
}

pub fn admin_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(ADMIN_FOLDER)
}

pub fn user_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(USER_FOLDER)
}

pub fn files_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(FILES_FOLDER)
}

pub fn filen_sessions_file(data_dir: &Path) -> PathBuf {
    data_dir.join(FILEN_SESSIONS_FILE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_constants_fit_together() {
        assert!(!keychain_service().is_empty() && !keychain_service().contains(['/', '\\']));
        assert!(!ADMIN_APP_ID.is_empty() && ADMIN_APP_ID.contains(':'), "must not look like a relative html path");
        assert_ne!(admin_dir(Path::new("data")), user_dir(Path::new("data")));
    }

    #[test]
    fn a_relative_default_goes_under_the_os_folder_and_an_absolute_one_is_used_as_is() {
        let os = Path::new("os-app-data");
        // whichever value the constant has today, joining behaves as documented:
        assert_eq!(default_data_dir(os), os.join(DEFAULT_DATA_FOLDER));
        let absolute = std::env::temp_dir().join("csdrive-isolated");
        assert_eq!(os.join(&absolute), absolute, "an absolute path replaces the base");
    }
}
