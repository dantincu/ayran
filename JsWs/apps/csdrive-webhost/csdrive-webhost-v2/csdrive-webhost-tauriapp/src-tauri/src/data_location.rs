//! Lets the user relocate the app's data folder (the `user` and `admin` folders,
//! the latter holding `data.db` and the admin app's own frontend bundle) away
//! from the default machine app-data location, via a native folder picker.
//!
//! Where the custom location is recorded: a single small file, always at a fixed
//! path inside the *default* app-data folder, encrypted with a key held in the OS
//! keychain (the same way Filen.io session tokens are protected). This file is the
//! only thing that always stays put, regardless of where the rest of the app's data
//! currently lives. Changing the location never moves any files — it only rewrites
//! this one pointer file; the change takes effect on the next launch.

use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, Generate, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager};

const CONFIG_FILE_NAME: &str = "data-location.enc";
const KEYCHAIN_KEY_NAME: &str = "data-location-encryption-key";
const NONCE_LEN: usize = 12;

fn base64_engine() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// The default data folder (see `layout::DEFAULT_DATA_FOLDER`).
fn default_app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let os_data_dir = app.path().data_dir().map_err(|e| e.to_string())?;
    Ok(crate::layout::default_data_dir(&os_data_dir))
}

fn config_file_path(default_dir: &Path) -> PathBuf {
    default_dir.join(CONFIG_FILE_NAME)
}

fn get_or_create_key() -> Result<Vec<u8>, String> {
    let entry =
        keyring::Entry::new(crate::layout::keychain_service(), KEYCHAIN_KEY_NAME).map_err(|e| e.to_string())?;

    match entry.get_password() {
        Ok(existing) => base64_engine()
            .decode(existing)
            .map_err(|e| e.to_string()),
        Err(keyring::Error::NoEntry) => {
            let key = Key::<Aes256Gcm>::generate();
            let encoded = base64_engine().encode(key.as_slice());
            entry.set_password(&encoded).map_err(|e| e.to_string())?;
            Ok(key.to_vec())
        }
        Err(e) => Err(e.to_string()),
    }
}

fn encrypt(key_bytes: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let key = Key::<Aes256Gcm>::try_from(key_bytes).map_err(|e| e.to_string())?;
    let cipher = Aes256Gcm::new(&key);
    let nonce = Nonce::generate();
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| e.to_string())?;

    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn decrypt(key_bytes: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < NONCE_LEN {
        return Err("data-location config file is corrupt".to_string());
    }
    let (nonce_bytes, ciphertext) = data.split_at(NONCE_LEN);
    let key = Key::<Aes256Gcm>::try_from(key_bytes).map_err(|e| e.to_string())?;
    let cipher = Aes256Gcm::new(&key);
    let nonce = Nonce::try_from(nonce_bytes).map_err(|e| e.to_string())?;
    cipher.decrypt(&nonce, ciphertext).map_err(|e| e.to_string())
}

/// Reads the custom data folder from the encrypted pointer file, if one is set.
/// Returns `None` on any failure (missing file, corrupt/undecryptable content, or
/// a path that no longer exists on disk) so the app can fall back to the default
/// location rather than fail to start.
fn read_custom_dir(default_dir: &Path) -> Option<PathBuf> {
    let path = config_file_path(default_dir);
    let bytes = std::fs::read(&path).ok()?;
    let key = get_or_create_key().ok()?;
    let plaintext = decrypt(&key, &bytes).ok()?;
    let text = String::from_utf8(plaintext).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let custom = PathBuf::from(trimmed);
    if custom.is_dir() {
        Some(custom)
    } else {
        None
    }
}

fn write_custom_dir(default_dir: &Path, path: Option<&Path>) -> Result<(), String> {
    let config_path = config_file_path(default_dir);
    match path {
        None => {
            match std::fs::remove_file(&config_path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.to_string()),
            }
        }
        Some(p) => {
            std::fs::create_dir_all(default_dir).map_err(|e| e.to_string())?;
            let key = get_or_create_key()?;
            let plaintext = p.to_string_lossy().into_owned();
            let encrypted = encrypt(&key, plaintext.as_bytes())?;
            std::fs::write(&config_path, encrypted).map_err(|e| e.to_string())
        }
    }
}

/// The folder that `user/` and `admin/` should actually live under right now:
/// the custom location if one is set and still exists, otherwise the default.
pub fn effective_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let default_dir = default_app_data_dir(app)?;
    Ok(read_custom_dir(&default_dir).unwrap_or(default_dir))
}

/// Absolute path of the folder holding user-authored content (`layout::USER_FOLDER`
/// inside the data folder in use right now). Available to every window: it's how a
/// web app finds where to point the fs commands.
#[tauri::command]
pub fn get_user_folder(app: AppHandle) -> Result<String, String> {
    Ok(crate::layout::user_dir(&effective_data_dir(&app)?).display().to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataFolderInfo {
    pub default_path: String,
    pub custom_path: Option<String>,
    pub effective_path: String,
}

#[tauri::command]
pub fn get_data_folder_info(app: AppHandle) -> Result<DataFolderInfo, String> {
    let default_dir = default_app_data_dir(&app)?;
    let custom_dir = read_custom_dir(&default_dir);
    let effective_dir = custom_dir.clone().unwrap_or_else(|| default_dir.clone());

    Ok(DataFolderInfo {
        default_path: default_dir.display().to_string(),
        custom_path: custom_dir.map(|p| p.display().to_string()),
        effective_path: effective_dir.display().to_string(),
    })
}

/// Opens a native folder picker (from the Rust side) and, if the user picks a
/// folder, records it as the new custom data location. Does not move or touch any
/// existing files — the change only takes effect after the app is restarted.
#[tauri::command]
pub fn pick_and_set_custom_data_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let default_dir = default_app_data_dir(&app)?;

    let picked = app
        .dialog()
        .file()
        .set_title("Choose a folder to store CsDrive WebHost's data in")
        .blocking_pick_folder();

    let Some(picked) = picked else {
        return Ok(None);
    };
    let picked_path = picked.into_path().map_err(|e| e.to_string())?;

    write_custom_dir(&default_dir, Some(&picked_path))?;
    Ok(Some(picked_path.display().to_string()))
}

#[tauri::command]
pub fn reset_data_folder_to_default(app: AppHandle) -> Result<(), String> {
    let default_dir = default_app_data_dir(&app)?;
    write_custom_dir(&default_dir, None)
}

/// Retries `op` a few times with a short, increasing delay before giving up.
/// Even after every connection pool and window this app itself controls is
/// confirmed closed, Windows can still hold a just-released file open for a brief
/// moment longer (antivirus/indexer scans, deferred handle cleanup) — a single
/// immediate `remove_file`/`remove_dir_all` attempt right after that can lose that
/// race and fail with "used by another process" even though nothing is genuinely
/// still using the file.
fn remove_with_retry<F: Fn() -> std::io::Result<()>>(op: F) -> std::io::Result<()> {
    let mut last_err = None;
    for attempt in 0..5u32 {
        match op() {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(100 * (attempt as u64 + 1)));
            }
        }
    }
    Err(last_err.unwrap())
}

/// Deletes every entry directly inside `dir` (files and subfolders alike), leaving
/// `dir` itself in place. `exclude`, if given, names one entry (matched after
/// canonicalization) to leave untouched. Best-effort: keeps going after a failed
/// entry and reports every failure joined together, rather than stopping at the
/// first one.
fn clear_directory_contents(dir: &Path, exclude: Option<&Path>) -> Result<(), String> {
    let canonical_exclude = exclude.and_then(|p| p.canonicalize().ok());

    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    let mut errors = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                errors.push(e.to_string());
                continue;
            }
        };
        let path = entry.path();

        if let Some(exclude) = &canonical_exclude {
            if path.canonicalize().ok().as_deref() == Some(exclude.as_path()) {
                continue;
            }
        }

        let result = remove_with_retry(|| {
            if path.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            }
        });
        if let Err(e) = result {
            errors.push(format!("{}: {e}", path.display()));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

/// Deletes everything inside the custom data folder (if one is set), without
/// touching the folder entry itself or the default app-data folder.
///
/// Before touching anything, this closes every handle this app itself could be
/// holding into that folder — on Windows, deleting a file that's still open fails
/// with "used by another process" (os error 32) — in the order the caller can't
/// get wrong even if it tried: every open secondary window first (closing one can
/// itself trigger tab/database activity, so windows must be gone before anything
/// downstream is touched), then the shared `data.db` connection pool. The frontend
/// is responsible for closing any `tauri-plugin-sql` connections onto files under
/// `user/` and wiping browser storage before calling this — Rust code can't reach
/// into another plugin's private connection registry, only invoke() from JS can.
/// Restarts the app afterward so it comes back with a fresh pool over the (now
/// empty) folder instead of continuing to run with a closed one.
#[tauri::command]
pub async fn clear_custom_data_folder_contents(
    app: AppHandle,
    windows_state: tauri::State<'_, crate::secondary_windows::SecondaryWindowsState>,
    db_state: tauri::State<'_, crate::app_state::AppDbState>,
) -> Result<(), String> {
    let default_dir = default_app_data_dir(&app)?;
    let custom_dir =
        read_custom_dir(&default_dir).ok_or_else(|| "No custom data folder is set.".to_string())?;

    crate::secondary_windows::close_all_secondary_windows(app.clone(), windows_state, None).await?;
    // The account list lives in the folder being wiped, so drop the keychain secrets too.
    crate::filen::forget_all_accounts(&app).await;
    db_state.pool.close().await;

    clear_directory_contents(&custom_dir, None)?;
    app.restart();
}

/// Deletes everything inside the default app-data folder — the `user` folder,
/// `data.db`, and the encrypted data-location pointer file itself — the same way
/// "clear app data" works from the OS settings. Never touches the custom data
/// folder, even if one is currently set. Closes secondary windows then the shared
/// `data.db` connection pool first (see `clear_custom_data_folder_contents`) and
/// restarts the app afterward.
#[tauri::command]
pub async fn delete_app_data(
    app: AppHandle,
    windows_state: tauri::State<'_, crate::secondary_windows::SecondaryWindowsState>,
    db_state: tauri::State<'_, crate::app_state::AppDbState>,
) -> Result<(), String> {
    let default_dir = default_app_data_dir(&app)?;
    let custom_dir = read_custom_dir(&default_dir);

    crate::secondary_windows::close_all_secondary_windows(app.clone(), windows_state, None).await?;
    if custom_dir.is_none() {
        // `data.db` (and so the account list) is inside the folder being wiped.
        crate::filen::forget_all_accounts(&app).await;
    }
    db_state.pool.close().await;

    clear_directory_contents(&default_dir, custom_dir.as_deref())?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_custom_dir_through_encrypted_pointer_file() {
        let default_dir = std::env::temp_dir().join(format!(
            "csdrive-data-location-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&default_dir).unwrap();

        let custom_dir = std::env::temp_dir().join("csdrive-data-location-test-custom-target");
        std::fs::create_dir_all(&custom_dir).unwrap();

        assert_eq!(read_custom_dir(&default_dir), None);

        write_custom_dir(&default_dir, Some(&custom_dir)).unwrap();
        assert!(config_file_path(&default_dir).exists());
        assert_eq!(read_custom_dir(&default_dir), Some(custom_dir.clone()));

        write_custom_dir(&default_dir, None).unwrap();
        assert!(!config_file_path(&default_dir).exists());
        assert_eq!(read_custom_dir(&default_dir), None);

        let _ = std::fs::remove_dir_all(&default_dir);
        let _ = std::fs::remove_dir_all(&custom_dir);
    }

    #[test]
    fn falls_back_to_default_when_pointed_dir_no_longer_exists() {
        let default_dir = std::env::temp_dir().join(format!(
            "csdrive-data-location-test-missing-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&default_dir).unwrap();

        let vanished_dir =
            std::env::temp_dir().join("csdrive-data-location-test-vanished-target");
        std::fs::create_dir_all(&vanished_dir).unwrap();
        write_custom_dir(&default_dir, Some(&vanished_dir)).unwrap();
        std::fs::remove_dir_all(&vanished_dir).unwrap();

        assert_eq!(read_custom_dir(&default_dir), None);

        let _ = std::fs::remove_dir_all(&default_dir);
    }

    #[test]
    fn clears_directory_contents_but_keeps_the_directory_and_excluded_entry() {
        let dir = std::env::temp_dir().join(format!("csdrive-clear-dir-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("subfolder")).unwrap();
        std::fs::write(dir.join("subfolder").join("nested.txt"), b"x").unwrap();
        std::fs::write(dir.join("file.txt"), b"x").unwrap();
        let keep = dir.join("keep-me");
        std::fs::create_dir_all(&keep).unwrap();
        std::fs::write(keep.join("still-here.txt"), b"x").unwrap();

        clear_directory_contents(&dir, Some(&keep)).unwrap();

        assert!(dir.exists());
        assert!(!dir.join("subfolder").exists());
        assert!(!dir.join("file.txt").exists());
        assert!(keep.join("still-here.txt").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_app_data_removes_everything_including_the_pointer_file() {
        let default_dir = std::env::temp_dir().join(format!(
            "csdrive-delete-app-data-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&default_dir);
        use crate::layout;
        std::fs::create_dir_all(layout::user_dir(&default_dir)).unwrap();
        std::fs::write(layout::user_dir(&default_dir).join("some-app.html"), b"<html></html>").unwrap();
        std::fs::create_dir_all(layout::admin_bundle_root(&default_dir)).unwrap();
        std::fs::write(layout::admin_bundle_file(&default_dir), b"<html></html>").unwrap();
        std::fs::write(layout::admin_dir(&default_dir).join("data.db"), b"fake-sqlite").unwrap();

        let custom_dir = std::env::temp_dir().join(format!(
            "csdrive-delete-app-data-test-custom-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&custom_dir);
        std::fs::create_dir_all(&custom_dir).unwrap();
        std::fs::write(custom_dir.join("untouched.txt"), b"keep").unwrap();
        write_custom_dir(&default_dir, Some(&custom_dir)).unwrap();
        assert!(config_file_path(&default_dir).exists());

        let custom_before = read_custom_dir(&default_dir);
        clear_directory_contents(&default_dir, custom_before.as_deref()).unwrap();

        assert!(default_dir.exists());
        assert!(!crate::layout::user_dir(&default_dir).exists());
        assert!(!crate::layout::admin_dir(&default_dir).exists());
        assert!(!config_file_path(&default_dir).exists());
        // The custom folder and its contents must survive a default-folder wipe.
        assert!(custom_dir.join("untouched.txt").exists());

        let _ = std::fs::remove_dir_all(&default_dir);
        let _ = std::fs::remove_dir_all(&custom_dir);
    }
}
