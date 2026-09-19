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

/// The admin-app's single-file bundle, relative to the data folder. The backend
/// keeps this file identical to the bundle embedded in the binary (see
/// `install_admin_bundle` in `lib.rs`), serves its containing folder to the main
/// window only, and treats everything else in that folder as disposable. Its file
/// name is also the admin-app's `app_id` for saved UI state, so renaming the file
/// starts the admin-app's saved state afresh.
pub const ADMIN_BUNDLE_PATH: &str = "admin/dist/index.html";

/// The app's own files inside the data folder (`data.db` lives here).
pub const ADMIN_FOLDER: &str = "admin";

/// The encrypted file holding every connected Filen.io account's session (API key,
/// master keys, ...), relative to the data folder. Encrypted with the app key kept in
/// the platform key store (see `secure_store`). It lives in the data folder on purpose:
/// it travels with `data.db` (which lists the accounts) when the folder is relocated.
pub const FILEN_SESSIONS_FILE: &str = "admin/filen-sessions.enc";

/// User-authored content inside the data folder: web apps, and whatever else the
/// Files tab manages.
pub const USER_FOLDER: &str = "user";

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

pub fn filen_sessions_file(data_dir: &Path) -> PathBuf {
    data_dir.join(FILEN_SESSIONS_FILE)
}

pub fn admin_bundle_file(data_dir: &Path) -> PathBuf {
    data_dir.join(ADMIN_BUNDLE_PATH)
}

/// The folder containing the bundle â€” what the `csadmin://` protocol serves.
pub fn admin_bundle_root(data_dir: &Path) -> PathBuf {
    let file = admin_bundle_file(data_dir);
    file.parent().map(Path::to_path_buf).unwrap_or(file)
}

/// The bundle's file name: its path within `admin_bundle_root`, so its URL is
/// `csadmin://localhost/<this>`, and the admin-app's `app_id`.
pub fn admin_bundle_url_path() -> &'static str {
    ADMIN_BUNDLE_PATH.rsplit('/').next().unwrap_or(ADMIN_BUNDLE_PATH)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_constants_fit_together() {
        assert!(!keychain_service().is_empty() && !keychain_service().contains(['/', '\\']));
        assert!(ADMIN_BUNDLE_PATH.contains('/'), "the bundle must sit inside a folder of its own to be served safely");
        assert!(!ADMIN_BUNDLE_PATH.starts_with('/') && !ADMIN_BUNDLE_PATH.contains(".."));
        assert!(!admin_bundle_url_path().is_empty() && !admin_bundle_url_path().contains('/'));

        let data = Path::new("data");
        assert!(admin_bundle_file(data).starts_with(admin_bundle_root(data)));
        assert_ne!(admin_bundle_root(data), data, "serving the whole data folder would expose data.db");
        assert!(!admin_bundle_root(data).starts_with(user_dir(data)), "the bundle must live outside user/");
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
