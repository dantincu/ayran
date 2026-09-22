//! The commands over the branches of the folders of this device (`files_cache/local_branches.rs`) — what the Notes app's file
//! manager calls when it works in a branch of the user folder or of a picked folder. They mirror the `filen_cache_*` commands
//! (same shapes, same "any window" access): a folder is named by its **root id** as everywhere, the branch by its index; no path
//! of the device is ever shown. Working on the folder itself (no branch) needs none of this — that is the ordinary `fs_*`
//! commands.
//!
//! What a window may do here is what it may do with the folder anyway: a branch only *holds* changes until they are committed,
//! and committing writes them through the same file scope (`FsScope::check_in`) as any other write.

use tauri::ipc::{Request, Response};
use tauri::State;

use crate::app_state::AppDbState;
use crate::device_files::ExportState;
use crate::files_cache::local_branches::Base;
use crate::files_cache::{BranchChange, BranchInfo, Cache, CommitReport, FileVersion, Listing, VersionCheck};
use crate::fs_scope::FsScope;

async fn guid_of(db: &AppDbState, root: &str) -> Result<String, String> {
    crate::picked_roots::root_guid_of(&db.pool, root).await
}

fn branch_field(request: &Request<'_>) -> Result<i64, String> {
    crate::ipc::field(request, "branch")?.parse().map_err(|_| "\"branch\" must be a number.".to_string())
}

/// A branch of a folder of this device: its `guid`, and the folder underneath.
macro_rules! ctx {
    ($db:expr, $scope:expr, $root:expr) => {{
        let guid = guid_of(&$db, &$root).await?;
        (guid, $scope.inner().clone())
    }};
}

#[tauri::command]
pub async fn local_branches(db: State<'_, AppDbState>, cache: State<'_, Cache>, root: String) -> Result<Vec<BranchInfo>, String> {
    cache.local_branches(&guid_of(&db, &root).await?).await
}

#[tauri::command]
pub async fn local_branch_create(db: State<'_, AppDbState>, cache: State<'_, Cache>, root: String, name: String) -> Result<BranchInfo, String> {
    cache.local_create_branch(&guid_of(&db, &root).await?, &name).await
}

#[tauri::command]
pub async fn local_branch_discard(db: State<'_, AppDbState>, cache: State<'_, Cache>, root: String, branch: i64) -> Result<(), String> {
    cache.local_discard_branch(&guid_of(&db, &root).await?, branch).await
}

#[tauri::command]
pub async fn local_branch_changes(db: State<'_, AppDbState>, cache: State<'_, Cache>, root: String, branch: i64) -> Result<Vec<BranchChange>, String> {
    cache.local_branch_changes(&guid_of(&db, &root).await?, branch).await
}

#[tauri::command]
pub async fn local_branch_commit(
    db: State<'_, AppDbState>,
    cache: State<'_, Cache>,
    scope: State<'_, FsScope>,
    root: String,
    branch: i64,
    force: Option<bool>,
) -> Result<CommitReport, String> {
    let (guid, scope) = ctx!(db, scope, root);
    cache.local_commit(&Base { scope: &scope, root: &root }, &guid, branch, force.unwrap_or(false)).await
}

#[tauri::command]
pub async fn local_branch_list(db: State<'_, AppDbState>, cache: State<'_, Cache>, scope: State<'_, FsScope>, root: String, branch: i64, path: String) -> Result<Listing, String> {
    let (guid, scope) = ctx!(db, scope, root);
    cache.local_list(&Base { scope: &scope, root: &root }, &guid, branch, &path).await
}

/// A file's bytes as the branch sees them (a raw binary response).
#[tauri::command]
pub async fn local_branch_read(db: State<'_, AppDbState>, cache: State<'_, Cache>, scope: State<'_, FsScope>, root: String, branch: i64, path: String) -> Result<Response, String> {
    let (guid, scope) = ctx!(db, scope, root);
    cache.local_read(&Base { scope: &scope, root: &root }, &guid, branch, &path).await.map(Response::new)
}

/// Creates or replaces a file in the branch: its bytes are the request body; `root`, `branch` and `path` are arguments (see
/// `ipc::body_bytes`/`field`, and `invokeWithBytes` on the JS side).
#[tauri::command]
pub async fn local_branch_write(db: State<'_, AppDbState>, cache: State<'_, Cache>, scope: State<'_, FsScope>, request: Request<'_>) -> Result<(), String> {
    let root = crate::ipc::field(&request, "root")?;
    let (branch, path) = (branch_field(&request)?, crate::ipc::field(&request, "path")?);
    let bytes = crate::ipc::body_bytes(&request)?;
    let (guid, scope) = ctx!(db, scope, root);
    cache.local_write(&Base { scope: &scope, root: &root }, &guid, branch, &path, &bytes).await
}

#[tauri::command]
pub async fn local_branch_mkdir(db: State<'_, AppDbState>, cache: State<'_, Cache>, scope: State<'_, FsScope>, root: String, branch: i64, path: String) -> Result<(), String> {
    let (guid, scope) = ctx!(db, scope, root);
    cache.local_mkdir(&Base { scope: &scope, root: &root }, &guid, branch, &path).await
}

#[tauri::command]
pub async fn local_branch_rm(db: State<'_, AppDbState>, cache: State<'_, Cache>, scope: State<'_, FsScope>, root: String, branch: i64, path: String) -> Result<(), String> {
    let (guid, scope) = ctx!(db, scope, root);
    cache.local_remove(&Base { scope: &scope, root: &root }, &guid, branch, &path).await
}

#[tauri::command]
pub async fn local_branch_rename(db: State<'_, AppDbState>, cache: State<'_, Cache>, scope: State<'_, FsScope>, root: String, branch: i64, from: String, to: String) -> Result<(), String> {
    let (guid, scope) = ctx!(db, scope, root);
    cache.local_rename(&Base { scope: &scope, root: &root }, &guid, branch, &from, &to).await
}

/// The version of a file in the folder or, with a branch, in that branch's view (what a change in it was based on).
#[tauri::command]
pub async fn local_branch_version(db: State<'_, AppDbState>, cache: State<'_, Cache>, scope: State<'_, FsScope>, root: String, branch: Option<i64>, path: String) -> Result<FileVersion, String> {
    let (guid, scope) = ctx!(db, scope, root);
    cache.local_version(&Base { scope: &scope, root: &root }, &guid, branch, &path).await
}

/// Asks the folder itself whether the file is still the version `base`.
#[tauri::command]
pub async fn local_branch_check_version(db: State<'_, AppDbState>, cache: State<'_, Cache>, scope: State<'_, FsScope>, root: String, path: String, base: FileVersion) -> Result<VersionCheck, String> {
    let (_guid, scope) = ctx!(db, scope, root);
    cache.local_check_version(&Base { scope: &scope, root: &root }, &path, &base)
}

#[tauri::command]
pub async fn local_branch_rebase(db: State<'_, AppDbState>, cache: State<'_, Cache>, scope: State<'_, FsScope>, root: String, branch: i64, path: String) -> Result<(), String> {
    let (guid, scope) = ctx!(db, scope, root);
    cache.local_rebase(&Base { scope: &scope, root: &root }, &guid, branch, &path).await
}

#[tauri::command]
pub async fn local_branch_checkout(db: State<'_, AppDbState>, cache: State<'_, Cache>, scope: State<'_, FsScope>, root: String, branch: i64, path: String) -> Result<(), String> {
    let (guid, scope) = ctx!(db, scope, root);
    cache.local_checkout(&Base { scope: &scope, root: &root }, &guid, branch, &path).await
}

#[tauri::command]
pub async fn local_branch_release(db: State<'_, AppDbState>, cache: State<'_, Cache>, root: String, branch: i64, path: String) -> Result<(), String> {
    cache.local_release(&guid_of(&db, &root).await?, branch, &path).await
}

/// Puts a file that is in a folder the app may use (`from_root`, `source`) into the branch, copied on this side.
#[tauri::command]
pub async fn local_branch_put_from_path(
    db: State<'_, AppDbState>,
    cache: State<'_, Cache>,
    scope: State<'_, FsScope>,
    root: String,
    branch: i64,
    path: String,
    from_root: String,
    source: String,
) -> Result<(), String> {
    let (guid, scope) = ctx!(db, scope, root);
    let from = scope.check_in(&from_root, &source, true)?;
    if !from.is_file() {
        return Err(format!("\"{source}\" isn't a file."));
    }
    cache.local_put_from_file(&Base { scope: &scope, root: &root }, &guid, branch, &path, &from).await
}

/// Copies a file, as the branch sees it, into a folder the app may use (`to_root`, `dest`).
#[tauri::command]
pub async fn local_branch_copy_to(
    db: State<'_, AppDbState>,
    cache: State<'_, Cache>,
    scope: State<'_, FsScope>,
    root: String,
    branch: i64,
    path: String,
    to_root: String,
    dest: String,
) -> Result<(), String> {
    let (guid, scope) = ctx!(db, scope, root);
    let from = cache.local_file(&Base { scope: &scope, root: &root }, &guid, branch, &path).await?;
    let target = scope.check_in(&to_root, &dest, true)?;
    if from == target {
        return Err("That is the same file.".to_string());
    }
    std::fs::copy(from, target).map(|_| ()).map_err(|e| e.to_string())
}

/// Saves a file, as the branch sees it, to the device (see `device_files`): the person is asked, as for any export.
#[tauri::command]
pub async fn local_branch_export(
    window: crate::window_host::CallerWindow,
    app: tauri::AppHandle,
    db: State<'_, AppDbState>,
    cache: State<'_, Cache>,
    scope: State<'_, FsScope>,
    exports: State<'_, ExportState>,
    root: String,
    branch: i64,
    path: String,
    name: String,
    token: Option<String>,
) -> Result<String, String> {
    crate::device_files::confirm_export(&app, &window, &name).await?;
    let (guid, scope) = ctx!(db, scope, root);
    let file = cache.local_file(&Base { scope: &scope, root: &root }, &guid, branch, &path).await?;
    crate::device_files::export_file(exports.inner(), name, token, file).await
}

/// The thumbnail (a JPEG) kept for this version of a file, or an empty answer (raw binary response).
#[tauri::command]
pub async fn local_thumb_get(db: State<'_, AppDbState>, cache: State<'_, Cache>, root: String, branch: Option<i64>, path: String, mtime_ms: u64, size: u64) -> Result<Response, String> {
    Ok(Response::new(cache.local_thumb_get(&guid_of(&db, &root).await?, branch, &path, mtime_ms, size).await?.unwrap_or_default()))
}

/// Keeps a thumbnail (its bytes are the request body; `root`, `path`, `mtimeMs`, `size` and, optionally, `branch` are arguments).
#[tauri::command]
pub async fn local_thumb_put(db: State<'_, AppDbState>, cache: State<'_, Cache>, request: Request<'_>) -> Result<(), String> {
    let number = |name: &str| -> Result<u64, String> { crate::ipc::field(&request, name)?.parse().map_err(|_| format!("\"{name}\" must be a number.")) };
    let root = crate::ipc::field(&request, "root")?;
    let branch = crate::ipc::field(&request, "branch").ok().filter(|b| !b.is_empty()).map(|b| b.parse::<i64>()).transpose().map_err(|_| "\"branch\" must be a number.".to_string())?;
    let path = crate::ipc::field(&request, "path")?;
    let bytes = crate::ipc::body_bytes(&request)?;
    if bytes.len() > 512 * 1024 {
        return Err("A thumbnail is at most 512 KiB.".to_string());
    }
    cache.local_thumb_put(&guid_of(&db, &root).await?, branch, &path, number("mtimeMs")?, number("size")?, &bytes).await
}

// ── A file from the device's chooser, into a branch ───────────────────────────

/// Starts putting a file into the branch, a piece at a time (`fs_upload_chunk` sends the pieces, exactly as for a folder; then
/// `local_branch_upload_finish`) — the counterpart of `fs_upload_begin`.
#[tauri::command]
pub async fn local_branch_upload_begin(
    window: crate::window_host::CallerWindow,
    db: State<'_, AppDbState>,
    cache: State<'_, Cache>,
    scope: State<'_, FsScope>,
    uploads: State<'_, crate::fs_upload::LocalUploads>,
    root: String,
    branch: i64,
    path: String,
) -> Result<String, String> {
    let (guid, scope) = ctx!(db, scope, root);
    // The folder has to exist in the branch's view, and the name not be a folder.
    let parent = path.rsplit_once('/').map(|(p, _)| p.to_string()).unwrap_or_default();
    let listing = cache.local_list(&Base { scope: &scope, root: &root }, &guid, branch, &format!("/{parent}")).await.map_err(|_| format!("The folder of \"{path}\" doesn't exist."))?;
    let name = path.rsplit('/').next().unwrap_or(&path);
    if listing.entries.iter().any(|e| e.name == name && e.is_directory) {
        return Err(format!("\"{path}\" is a folder."));
    }
    let owner = crate::window_host::caller_key(&window);
    uploads.begin_branch(&owner, &root, branch, &path)
}

#[tauri::command]
pub async fn local_branch_upload_finish(
    window: crate::window_host::CallerWindow,
    db: State<'_, AppDbState>,
    cache: State<'_, Cache>,
    scope: State<'_, FsScope>,
    uploads: State<'_, crate::fs_upload::LocalUploads>,
    id: String,
) -> Result<(), String> {
    let owner = crate::window_host::caller_key(&window);
    let finished = uploads.finish_branch(&owner, &id)?;
    let root = finished.root.clone();
    let (guid, scope) = ctx!(db, scope, root);
    let branch = finished.branch.ok_or("That upload isn't for a branch.")?;
    cache.local_put_from_file(&Base { scope: &scope, root: &finished.root }, &guid, branch, &finished.path, &finished.tmp).await
}
