//! Folders the user picks on the device — Android's counterpart of "pick a folder with
//! the native dialog, then use the fs plugin on it", which doesn't exist there: the
//! official dialog plugin has no folder picker on mobile, and Android hands out
//! `content://` URIs (the Storage Access Framework) that path-based fs can't use.
//!
//! So a picked folder is a *root* addressed like a Filen account: an opaque `rootId`
//! plus a path relative to that root, through the `device_*` commands below, which wrap
//! `tauri-plugin-android-fs` (Rust API only — none of the plugin's own JS commands are
//! enabled, so a webview can't reach the raw plugin).
//!
//! - The picker (`pick_device_root`) asks Android for read-write access to a folder tree
//!   and keeps that permission across restarts; the root is remembered in `data.db`
//!   (`device_roots`) so it's still there next launch. `remove_device_root` forgets it
//!   and gives the permission back.
//! - Like every other file capability, these are available to all windows (see
//!   CLAUDE.md, "capabilities"): a web app can ask the user to pick a folder, then use it.
//! - Only Android has device roots. Elsewhere `pick_device_root` errors and
//!   `list_device_roots` is empty — desktop picks folders with the dialog + fs plugins.
//!
//! Paths are always root-relative with `/` separators; `..` and `.` are rejected.

use serde::Serialize;
use sqlx::SqlitePool;
use tauri::ipc::{Request, Response};
use tauri::AppHandle;

use crate::app_state::AppDbState;

/// A remembered folder: what the frontend needs to show it and address it.
#[derive(Debug, Clone, Serialize, PartialEq, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRoot {
    pub id: String,
    pub label: String,
}

/// One entry of a folder listing — the same shape as `filen_readdir`'s.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EntryInfo {
    pub name: String,
    pub is_directory: bool,
    pub size: Option<u64>,
    pub mtime_ms: Option<u64>,
}

// ── Remembered roots (data.db) ────────────────────────────────────────────────

pub async fn ensure_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS device_roots (
            id TEXT PRIMARY KEY,
            uri TEXT NOT NULL UNIQUE,
            label TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Remembers a picked folder (its URI is stored in the plugin's own JSON form). Picking
/// a folder that's already remembered returns the existing entry.
async fn remember_root(pool: &SqlitePool, uri: &str, label: &str) -> Result<DeviceRoot, sqlx::Error> {
    if let Some(existing) = sqlx::query_as::<_, DeviceRoot>("SELECT id, label FROM device_roots WHERE uri = ?1")
        .bind(uri)
        .fetch_optional(pool)
        .await?
    {
        return Ok(existing);
    }
    let root = DeviceRoot { id: uuid::Uuid::new_v4().to_string(), label: label.to_string() };
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    sqlx::query("INSERT INTO device_roots (id, uri, label, created_at) VALUES (?1, ?2, ?3, ?4)")
        .bind(&root.id)
        .bind(uri)
        .bind(label)
        .bind(created_at)
        .execute(pool)
        .await?;
    Ok(root)
}

async fn all_roots(pool: &SqlitePool) -> Result<Vec<DeviceRoot>, sqlx::Error> {
    sqlx::query_as::<_, DeviceRoot>("SELECT id, label FROM device_roots ORDER BY created_at, id")
        .fetch_all(pool)
        .await
}

/// The stored URI of a root, or an error the user can read.
async fn root_uri(pool: &SqlitePool, id: &str) -> Result<String, String> {
    sqlx::query_scalar::<_, String>("SELECT uri FROM device_roots WHERE id = ?1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That folder isn't in the list any more — add it again.".to_string())
}

/// Forgets a root; returns its URI if there was one.
async fn forget_root(pool: &SqlitePool, id: &str) -> Result<Option<String>, sqlx::Error> {
    let uri = sqlx::query_scalar::<_, String>("SELECT uri FROM device_roots WHERE id = ?1").bind(id).fetch_optional(pool).await?;
    sqlx::query("DELETE FROM device_roots WHERE id = ?1").bind(id).execute(pool).await?;
    Ok(uri)
}

// ── Paths ─────────────────────────────────────────────────────────────────────

/// Normalises a root-relative path: `""` is the root itself; slashes at the ends and
/// doubled slashes are dropped; `.`/`..`/NUL are refused so a path can never leave the root.
fn clean_relative_path(path: &str) -> Result<String, String> {
    let mut parts = Vec::new();
    for part in path.split(['/', '\\']) {
        match part {
            "" => {}
            "." | ".." => return Err("Paths can't contain \".\" or \"..\".".to_string()),
            p if p.contains('\0') => return Err("That isn't a usable path.".to_string()),
            p => parts.push(p),
        }
    }
    Ok(parts.join("/"))
}

/// Splits a cleaned, non-empty path into its parent path (`""` for the root) and name.
#[cfg_attr(not(target_os = "android"), allow(dead_code))] // only the Android platform code (and tests) split paths
fn split_parent(path: &str) -> (&str, &str) {
    match path.rsplit_once('/') {
        Some((parent, name)) => (parent, name),
        None => ("", path),
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Opens Android's folder picker; on a pick, remembers the folder (with read-write
/// access kept across restarts) and returns it. `None` if the user cancelled.
#[tauri::command]
pub async fn pick_device_root(app: AppHandle, state: tauri::State<'_, AppDbState>) -> Result<Option<DeviceRoot>, String> {
    let Some((uri, label)) = platform::pick(&app).await? else { return Ok(None) };
    remember_root(&state.pool, &uri, &label).await.map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_device_roots(state: tauri::State<'_, AppDbState>) -> Result<Vec<DeviceRoot>, String> {
    all_roots(&state.pool).await.map_err(|e| e.to_string())
}

/// Forgets a folder and gives Android its access permission back. Nothing inside it is touched.
#[tauri::command]
pub async fn remove_device_root(app: AppHandle, state: tauri::State<'_, AppDbState>, root_id: String) -> Result<(), String> {
    if let Some(uri) = forget_root(&state.pool, &root_id).await.map_err(|e| e.to_string())? {
        platform::release(&app, &uri).await;
    }
    Ok(())
}

/// Gives back the access permission of every remembered folder (used when the app's
/// data is wiped, which deletes the list itself).
pub async fn release_all(app: &AppHandle, pool: &SqlitePool) {
    let uris: Vec<String> = sqlx::query_scalar("SELECT uri FROM device_roots").fetch_all(pool).await.unwrap_or_default();
    for uri in uris {
        platform::release(app, &uri).await;
    }
}

#[tauri::command]
pub async fn device_readdir(
    app: AppHandle,
    state: tauri::State<'_, AppDbState>,
    root_id: String,
    path: String,
) -> Result<Vec<EntryInfo>, String> {
    let path = clean_relative_path(&path)?;
    platform::readdir(&app, &root_uri(&state.pool, &root_id).await?, &path).await
}

#[tauri::command]
pub async fn device_stat(
    app: AppHandle,
    state: tauri::State<'_, AppDbState>,
    root_id: String,
    path: String,
) -> Result<EntryInfo, String> {
    let path = clean_relative_path(&path)?;
    platform::stat(&app, &root_uri(&state.pool, &root_id).await?, &path).await
}

#[tauri::command]
pub async fn device_exists(
    app: AppHandle,
    state: tauri::State<'_, AppDbState>,
    root_id: String,
    path: String,
) -> Result<bool, String> {
    let path = clean_relative_path(&path)?;
    Ok(platform::stat(&app, &root_uri(&state.pool, &root_id).await?, &path).await.is_ok())
}

/// Returns the file's bytes as a raw binary response (an `ArrayBuffer` in JS).
#[tauri::command]
pub async fn device_read_file(
    app: AppHandle,
    state: tauri::State<'_, AppDbState>,
    root_id: String,
    path: String,
) -> Result<Response, String> {
    let path = clean_relative_path(&path)?;
    platform::read_file(&app, &root_uri(&state.pool, &root_id).await?, &path).await.map(Response::new)
}

/// Creates or replaces a file (creating missing parent folders). The bytes are the
/// request body, the root and path the other arguments (see `ipc.rs` and `invokeWithBytes`).
#[tauri::command]
pub async fn device_write_file(app: AppHandle, state: tauri::State<'_, AppDbState>, request: Request<'_>) -> Result<(), String> {
    let root_id = crate::ipc::field(&request, "rootId")?;
    let path = clean_relative_path(&crate::ipc::field(&request, "path")?)?;
    if path.is_empty() {
        return Err("The root folder can't be written to.".to_string());
    }
    let data = crate::ipc::body_bytes(&request)?;
    platform::write_file(&app, &root_uri(&state.pool, &root_id).await?, &path, data).await
}

/// Creates a folder and any missing parents; fine if it already exists.
#[tauri::command]
pub async fn device_mkdir(app: AppHandle, state: tauri::State<'_, AppDbState>, root_id: String, path: String) -> Result<(), String> {
    let path = clean_relative_path(&path)?;
    if path.is_empty() {
        return Ok(());
    }
    platform::mkdir(&app, &root_uri(&state.pool, &root_id).await?, &path).await
}

/// Deletes a file, or a folder with everything in it. **Permanently** — Android's
/// document providers have no trash.
#[tauri::command]
pub async fn device_rm(app: AppHandle, state: tauri::State<'_, AppDbState>, root_id: String, path: String) -> Result<(), String> {
    let path = clean_relative_path(&path)?;
    if path.is_empty() {
        return Err("The root folder itself can't be deleted here — remove it from the list instead.".to_string());
    }
    platform::remove(&app, &root_uri(&state.pool, &root_id).await?, &path).await
}

/// Renames or moves within the root. Never overwrites: an existing target is an error.
#[tauri::command]
pub async fn device_rename(
    app: AppHandle,
    state: tauri::State<'_, AppDbState>,
    root_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let (from, to) = (clean_relative_path(&from)?, clean_relative_path(&to)?);
    if from.is_empty() || to.is_empty() {
        return Err("The root folder can't be renamed or moved.".to_string());
    }
    if from == to {
        return Ok(());
    }
    if to.starts_with(&format!("{from}/")) {
        return Err("A folder can't be moved into itself.".to_string());
    }
    platform::rename(&app, &root_uri(&state.pool, &root_id).await?, &from, &to).await
}

// ── Platform ──────────────────────────────────────────────────────────────────

#[cfg(target_os = "android")]
mod platform {
    use std::time::{SystemTime, UNIX_EPOCH};

    use tauri_plugin_android_fs::{AndroidFsExt, Entry, FsUri};

    use super::*;

    fn err(e: impl std::fmt::Display) -> String {
        e.to_string()
    }

    fn parse(root: &str) -> Result<FsUri, String> {
        FsUri::from_json_str(root).map_err(err)
    }

    fn millis(time: &SystemTime) -> Option<u64> {
        time.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
    }

    fn info(entry: &Entry) -> EntryInfo {
        match entry {
            Entry::File { name, last_modified, len, .. } => {
                EntryInfo { name: name.clone(), is_directory: false, size: Some(*len), mtime_ms: millis(last_modified) }
            }
            Entry::Dir { name, last_modified, .. } => {
                EntryInfo { name: name.clone(), is_directory: true, size: None, mtime_ms: millis(last_modified) }
            }
        }
    }

    /// The folder at `rel` inside the root (the root itself for `""`).
    async fn dir_at(app: &AppHandle, root: &FsUri, rel: &str) -> Result<FsUri, String> {
        if rel.is_empty() {
            return Ok(root.clone());
        }
        app.android_fs_async().resolve_dir_uri(root, rel).await.map_err(|_| format!("\"{rel}\" isn't a folder here."))
    }

    /// The file or folder at `rel` (not the root itself — callers handle `""`).
    async fn entry_at(app: &AppHandle, root: &FsUri, rel: &str) -> Result<Entry, String> {
        let api = app.android_fs_async();
        if let Ok(uri) = api.resolve_file_uri(root, rel).await {
            if let Ok(entry) = api.get_info(&uri).await {
                return Ok(entry);
            }
        }
        if let Ok(uri) = api.resolve_dir_uri(root, rel).await {
            if let Ok(entry) = api.get_info(&uri).await {
                return Ok(entry);
            }
        }
        Err(format!("\"{rel}\" doesn't exist."))
    }

    fn uri_of(entry: &Entry) -> FsUri {
        match entry {
            Entry::File { uri, .. } | Entry::Dir { uri, .. } => uri.clone(),
        }
    }

    pub async fn pick(app: &AppHandle) -> Result<Option<(String, String)>, String> {
        let api = app.android_fs_async();
        let Some(uri) = api.picker().pick_dir(None, false).await.map_err(err)? else { return Ok(None) };
        // Without this the permission ends with the app process.
        api.picker().persist_uri_permission(&uri).await.map_err(err)?;
        let label = api.get_name_or_last_path_segment(&uri).await;
        Ok(Some((uri.to_json_string().map_err(err)?, label)))
    }

    pub async fn release(app: &AppHandle, uri: &str) {
        if let Ok(uri) = FsUri::from_json_str(uri) {
            let _ = app.android_fs_async().picker().release_persisted_uri_permission(&uri).await;
        }
    }

    pub async fn readdir(app: &AppHandle, root: &str, rel: &str) -> Result<Vec<EntryInfo>, String> {
        let root = parse(root)?;
        let dir = dir_at(app, &root, rel).await?;
        let entries = app.android_fs_async().read_dir(&dir).await.map_err(err)?;
        Ok(entries.iter().map(info).collect())
    }

    pub async fn stat(app: &AppHandle, root: &str, rel: &str) -> Result<EntryInfo, String> {
        if rel.is_empty() {
            return Ok(EntryInfo { name: String::new(), is_directory: true, size: None, mtime_ms: None });
        }
        Ok(info(&entry_at(app, &parse(root)?, rel).await?))
    }

    pub async fn read_file(app: &AppHandle, root: &str, rel: &str) -> Result<Vec<u8>, String> {
        let api = app.android_fs_async();
        let uri = api.resolve_file_uri(&parse(root)?, rel).await.map_err(|_| format!("\"{rel}\" isn't a file here."))?;
        api.read(&uri).await.map_err(err)
    }

    pub async fn write_file(app: &AppHandle, root: &str, rel: &str, data: Vec<u8>) -> Result<(), String> {
        let api = app.android_fs_async();
        let root = parse(root)?;
        let uri = match api.resolve_file_uri(&root, rel).await {
            Ok(existing) => existing,
            // Creating also creates any missing parent folders.
            Err(_) => api.create_new_file(&root, rel, None).await.map_err(err)?,
        };
        api.write(&uri, data).await.map_err(err)
    }

    pub async fn mkdir(app: &AppHandle, root: &str, rel: &str) -> Result<(), String> {
        app.android_fs_async().create_dir_all(&parse(root)?, rel).await.map(|_| ()).map_err(err)
    }

    pub async fn remove(app: &AppHandle, root: &str, rel: &str) -> Result<(), String> {
        let api = app.android_fs_async();
        let entry = entry_at(app, &parse(root)?, rel).await?;
        match &entry {
            Entry::File { uri, .. } => api.remove_file(uri).await.map_err(err),
            Entry::Dir { uri, .. } => api.remove_dir_all(uri).await.map_err(err),
        }
    }

    pub async fn rename(app: &AppHandle, root: &str, from: &str, to: &str) -> Result<(), String> {
        let api = app.android_fs_async();
        let root = parse(root)?;
        let source = entry_at(app, &root, from).await?;
        if entry_at(app, &root, to).await.is_ok() {
            return Err(format!("\"{to}\" already exists."));
        }

        let (from_parent, _) = split_parent(from);
        let (to_parent, to_name) = split_parent(to);
        if from_parent == to_parent {
            // Same folder: a plain rename.
            return api.rename(&uri_of(&source), to_name).await.map(|_| ()).map_err(err);
        }

        // Android can only rename in place, so a move is copy-then-delete: the source is
        // only removed once everything has been copied.
        let mut pending = vec![(source.clone(), to.to_string())];
        while let Some((entry, dest)) = pending.pop() {
            match &entry {
                Entry::File { uri, .. } => {
                    let created = api.create_new_file(&root, &dest, None).await.map_err(err)?;
                    api.copy(uri, &created).await.map_err(err)?;
                }
                Entry::Dir { uri, .. } => {
                    api.create_dir_all(&root, &dest).await.map_err(err)?;
                    for child in api.read_dir(uri).await.map_err(err)? {
                        let name = match &child {
                            Entry::File { name, .. } | Entry::Dir { name, .. } => name.clone(),
                        };
                        pending.push((child, format!("{dest}/{name}")));
                    }
                }
            }
        }
        match &source {
            Entry::File { uri, .. } => api.remove_file(uri).await.map_err(err),
            Entry::Dir { uri, .. } => api.remove_dir_all(uri).await.map_err(err),
        }
    }
}

#[cfg(not(target_os = "android"))]
mod platform {
    use super::*;

    const NOT_HERE: &str = "Device folders are an Android feature; pick folders with the file dialog on this platform.";

    pub async fn pick(_: &AppHandle) -> Result<Option<(String, String)>, String> {
        Err(NOT_HERE.to_string())
    }
    pub async fn release(_: &AppHandle, _: &str) {}
    pub async fn readdir(_: &AppHandle, _: &str, _: &str) -> Result<Vec<EntryInfo>, String> {
        Err(NOT_HERE.to_string())
    }
    pub async fn stat(_: &AppHandle, _: &str, _: &str) -> Result<EntryInfo, String> {
        Err(NOT_HERE.to_string())
    }
    pub async fn read_file(_: &AppHandle, _: &str, _: &str) -> Result<Vec<u8>, String> {
        Err(NOT_HERE.to_string())
    }
    pub async fn write_file(_: &AppHandle, _: &str, _: &str, _: Vec<u8>) -> Result<(), String> {
        Err(NOT_HERE.to_string())
    }
    pub async fn mkdir(_: &AppHandle, _: &str, _: &str) -> Result<(), String> {
        Err(NOT_HERE.to_string())
    }
    pub async fn remove(_: &AppHandle, _: &str, _: &str) -> Result<(), String> {
        Err(NOT_HERE.to_string())
    }
    pub async fn rename(_: &AppHandle, _: &str, _: &str, _: &str) -> Result<(), String> {
        Err(NOT_HERE.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_are_normalised_and_cannot_leave_the_root() {
        assert_eq!(clean_relative_path("").unwrap(), "");
        assert_eq!(clean_relative_path("/").unwrap(), "");
        assert_eq!(clean_relative_path("a//b/").unwrap(), "a/b");
        assert_eq!(clean_relative_path("/a/b").unwrap(), "a/b");
        assert_eq!(clean_relative_path("a\\b").unwrap(), "a/b");
        assert!(clean_relative_path("../x").is_err());
        assert!(clean_relative_path("a/../x").is_err());
        assert!(clean_relative_path("a/./x").is_err());
        assert!(clean_relative_path("a\0b").is_err());
    }

    #[test]
    fn a_path_splits_into_parent_and_name() {
        assert_eq!(split_parent("name"), ("", "name"));
        assert_eq!(split_parent("a/name"), ("a", "name"));
        assert_eq!(split_parent("a/b/name"), ("a/b", "name"));
    }

    #[tokio::test]
    async fn roots_are_remembered_once_and_forgotten() {
        // One connection: every new connection to `:memory:` would be its own empty database.
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        ensure_schema(&pool).await.unwrap();

        let first = remember_root(&pool, "{\"uri\":\"content://tree/a\"}", "Photos").await.unwrap();
        let again = remember_root(&pool, "{\"uri\":\"content://tree/a\"}", "Renamed").await.unwrap();
        assert_eq!(first, again, "the same folder isn't added twice");
        let other = remember_root(&pool, "{\"uri\":\"content://tree/b\"}", "Docs").await.unwrap();
        assert_ne!(first.id, other.id);

        assert_eq!(all_roots(&pool).await.unwrap().len(), 2);
        assert_eq!(root_uri(&pool, &other.id).await.unwrap(), "{\"uri\":\"content://tree/b\"}");
        assert!(root_uri(&pool, "nope").await.is_err());

        assert_eq!(forget_root(&pool, &first.id).await.unwrap().as_deref(), Some("{\"uri\":\"content://tree/a\"}"));
        assert_eq!(forget_root(&pool, &first.id).await.unwrap(), None);
        assert_eq!(all_roots(&pool).await.unwrap(), vec![other]);
    }
}
