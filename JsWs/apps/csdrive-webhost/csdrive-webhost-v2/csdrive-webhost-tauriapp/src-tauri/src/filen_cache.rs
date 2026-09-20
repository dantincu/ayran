//! The commands over the Filen cache (`files_cache.rs`) — what the Notes app's file manager calls.
//! They mirror the `filen_*` commands (same shapes, same "any window" access, no credentials ever
//! shown), with a cache in between and an optional **branch** to work in instead of the account
//! itself. A branch is named by its index (`1` for the folder `001`) and is always one of the
//! account's; leave it out to work on the account itself.
//!
//! The account's own `files/` folder is not reachable through the file commands (it is a protected
//! path in the file scope), so this is the only way in.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use tauri::ipc::{Request, Response};
use tauri::{AppHandle, State};

use crate::device_files::ExportState;
use crate::files_cache::{AccountCacheInfo, BranchChange, BranchInfo, Cache, CommitReport, FileVersion, FilenRemote, Listing, UploadJob, VersionCheck};
use crate::fs_scope::FsScope;

/// An upload that a window feeds piece by piece (`filen_cache_upload_begin` … `_finish`).
type Job = UploadJob<crate::filen::ops::UploadSession>;

struct Upload {
    /// Who began it: only that window may push to it.
    owner: String,
    user_id: u64,
    started: Instant,
    job: Arc<tokio::sync::Mutex<Job>>,
}

/// The uploads in progress, by a random id. One that is never finished is dropped (and its temporary
/// file with it) an hour after it began, the next time another begins.
#[derive(Default)]
pub struct UploadSessions {
    open: StdMutex<HashMap<String, Upload>>,
}

impl UploadSessions {
    fn get(&self, id: &str, owner: &str) -> Result<(u64, Arc<tokio::sync::Mutex<Job>>), String> {
        let open = self.open.lock().unwrap();
        let upload = open.get(id).filter(|u| u.owner == owner).ok_or("That upload isn't open.")?;
        Ok((upload.user_id, upload.job.clone()))
    }

    fn remove(&self, id: &str, owner: &str) -> Option<Upload> {
        let mut open = self.open.lock().unwrap();
        if open.get(id).is_some_and(|u| u.owner == owner) {
            open.remove(id)
        } else {
            None
        }
    }
}

/// The account's Filen session as a `Remote`, after making sure the account has its cache folders.
pub(crate) async fn prepare(app: &AppHandle, cache: &Cache, user_id: u64) -> Result<FilenRemote, String> {
    let email = crate::filen::email_of(app, user_id).await?;
    cache.ensure_account(user_id as i64, &email).await?;
    Ok(FilenRemote(crate::filen::session_for(app, user_id).await?))
}

/// The account's cache settings (setting it up first if it's new): the cache interval and folder.
#[tauri::command]
pub async fn filen_cache_account(app: AppHandle, cache: State<'_, Cache>, user_id: u64) -> Result<AccountCacheInfo, String> {
    let email = crate::filen::email_of(&app, user_id).await?;
    cache.ensure_account(user_id as i64, &email).await
}

/// How long the account's cached listings, metadata and contents stay valid, in seconds; `null`
/// means never expire (they stay available offline).
#[tauri::command]
pub async fn filen_cache_set_interval(cache: State<'_, Cache>, user_id: u64, ttl_secs: Option<i64>) -> Result<(), String> {
    cache.set_ttl(user_id as i64, ttl_secs).await
}

/// Throws away everything cached for the account (branches stay).
#[tauri::command]
pub async fn filen_cache_clear(cache: State<'_, Cache>, user_id: u64) -> Result<(), String> {
    cache.clear(user_id as i64).await
}

#[tauri::command]
pub async fn filen_cache_list(
    app: AppHandle,
    cache: State<'_, Cache>,
    user_id: u64,
    branch: Option<i64>,
    path: String,
    force: Option<bool>,
) -> Result<Listing, String> {
    let remote = prepare(&app, &cache, user_id).await?;
    cache.list(&remote, user_id as i64, branch, &path, force.unwrap_or(false)).await
}

/// A file's bytes (a raw binary response), fetched from Filen only if they aren't cached.
#[tauri::command]
pub async fn filen_cache_read(
    app: AppHandle,
    cache: State<'_, Cache>,
    user_id: u64,
    branch: Option<i64>,
    path: String,
) -> Result<Response, String> {
    let remote = prepare(&app, &cache, user_id).await?;
    cache.read(&remote, user_id as i64, branch, &path).await.map(Response::new)
}

/// Creates or replaces a file: its bytes are the request body; `userId`, `path` and (optionally)
/// `branch` are arguments (see `ipc::body_bytes`/`field`, and `invokeWithBytes` on the JS side).
#[tauri::command]
pub async fn filen_cache_write(app: AppHandle, cache: State<'_, Cache>, request: Request<'_>) -> Result<(), String> {
    let user_id: u64 = crate::ipc::field(&request, "userId")?.parse().map_err(|_| "\"userId\" must be a number.".to_string())?;
    let branch = crate::ipc::field(&request, "branch").ok().filter(|b| !b.is_empty()).map(|b| b.parse::<i64>()).transpose().map_err(|_| "\"branch\" must be a number.".to_string())?;
    let path = crate::ipc::field(&request, "path")?;
    let bytes = crate::ipc::body_bytes(&request)?;
    let remote = prepare(&app, &cache, user_id).await?;
    cache.write(&remote, user_id as i64, branch, &path, &bytes).await
}

#[tauri::command]
pub async fn filen_cache_mkdir(app: AppHandle, cache: State<'_, Cache>, user_id: u64, branch: Option<i64>, path: String) -> Result<(), String> {
    let remote = prepare(&app, &cache, user_id).await?;
    cache.mkdir(&remote, user_id as i64, branch, &path).await
}

#[tauri::command]
pub async fn filen_cache_rm(app: AppHandle, cache: State<'_, Cache>, user_id: u64, branch: Option<i64>, path: String) -> Result<(), String> {
    let remote = prepare(&app, &cache, user_id).await?;
    cache.remove(&remote, user_id as i64, branch, &path).await
}

#[tauri::command]
pub async fn filen_cache_rename(
    app: AppHandle,
    cache: State<'_, Cache>,
    user_id: u64,
    branch: Option<i64>,
    from: String,
    to: String,
) -> Result<(), String> {
    let remote = prepare(&app, &cache, user_id).await?;
    cache.rename(&remote, user_id as i64, branch, &from, &to).await
}

#[tauri::command]
pub async fn filen_cache_branches(app: AppHandle, cache: State<'_, Cache>, user_id: u64) -> Result<Vec<BranchInfo>, String> {
    prepare(&app, &cache, user_id).await?;
    cache.branches(user_id as i64).await
}

/// Creates a branch of the account; `name` must be a valid file name of at most 100 characters.
#[tauri::command]
pub async fn filen_cache_create_branch(app: AppHandle, cache: State<'_, Cache>, user_id: u64, name: String) -> Result<BranchInfo, String> {
    prepare(&app, &cache, user_id).await?;
    cache.create_branch(user_id as i64, &name).await
}

/// What the branch changes, for showing before a commit.
#[tauri::command]
pub async fn filen_cache_branch_changes(cache: State<'_, Cache>, user_id: u64, branch: i64) -> Result<Vec<BranchChange>, String> {
    cache.branch_changes(user_id as i64, branch).await
}

/// Applies the branch to Filen and deletes it. If Filen changed since the branch touched something,
/// nothing is applied and `committed` is false with the `conflicts`, unless `force` is set.
#[tauri::command]
pub async fn filen_cache_commit_branch(
    app: AppHandle,
    cache: State<'_, Cache>,
    user_id: u64,
    branch: i64,
    force: Option<bool>,
) -> Result<CommitReport, String> {
    let remote = prepare(&app, &cache, user_id).await?;
    cache.commit_branch(&remote, user_id as i64, branch, force.unwrap_or(false)).await
}

/// Deletes the branch without applying anything.
#[tauri::command]
pub async fn filen_cache_discard_branch(cache: State<'_, Cache>, user_id: u64, branch: i64) -> Result<(), String> {
    cache.discard_branch(user_id as i64, branch).await
}

// ── Versions, locks and checkouts ──────────────────────────────────────────────

/// The version of a file as the cache knows it — what a window that has just opened it is working
/// on (in a branch that changed or checked out the file: the version that change is based on).
#[tauri::command]
pub async fn filen_cache_version(cache: State<'_, Cache>, user_id: u64, branch: Option<i64>, path: String) -> Result<FileVersion, String> {
    cache.version(user_id as i64, branch, &path).await
}

/// Asks Filen itself whether the file is still at `base`, the version that was being worked on.
#[tauri::command]
pub async fn filen_cache_check_version(
    app: AppHandle,
    cache: State<'_, Cache>,
    user_id: u64,
    branch: Option<i64>,
    path: String,
    base: FileVersion,
) -> Result<VersionCheck, String> {
    let remote = prepare(&app, &cache, user_id).await?;
    cache.check_version(&remote, user_id as i64, branch, &path, &base).await
}

/// Bases the branch's change to a file on what Filen has now (the person chose to overwrite it).
#[tauri::command]
pub async fn filen_cache_rebase(app: AppHandle, cache: State<'_, Cache>, user_id: u64, branch: i64, path: String) -> Result<(), String> {
    let remote = prepare(&app, &cache, user_id).await?;
    cache.rebase(&remote, user_id as i64, branch, &path).await
}

/// Locks a file of the account against caching (its cached copy is never refreshed or dropped), or
/// unlocks it. It is about the account's file, so it holds in every branch too.
#[tauri::command]
pub async fn filen_cache_set_locked(app: AppHandle, cache: State<'_, Cache>, user_id: u64, path: String, locked: bool) -> Result<(), String> {
    let remote = prepare(&app, &cache, user_id).await?;
    cache.set_locked(&remote, user_id as i64, &path, locked).await
}

/// Takes a file into the branch without changing it, so it is among the branch's pending changes.
#[tauri::command]
pub async fn filen_cache_checkout(app: AppHandle, cache: State<'_, Cache>, user_id: u64, branch: i64, path: String) -> Result<(), String> {
    let remote = prepare(&app, &cache, user_id).await?;
    cache.checkout(&remote, user_id as i64, branch, &path).await
}

/// Lets go of a file that was checked out and never changed.
#[tauri::command]
pub async fn filen_cache_release(cache: State<'_, Cache>, user_id: u64, branch: i64, path: String) -> Result<(), String> {
    cache.release(user_id as i64, branch, &path).await
}

// ── Big files: nothing here holds a whole file ─────────────────────────────────

/// Starts uploading a file to `path` (in the account, or in `branch`); returns the upload's id. The
/// window then sends the file in pieces with `filen_cache_upload_chunk` and ends with
/// `filen_cache_upload_finish` (or gives up with `filen_cache_upload_abort`).
#[tauri::command]
pub async fn filen_cache_upload_begin(
    window: crate::window_host::CallerWindow,
    app: AppHandle,
    cache: State<'_, Cache>,
    sessions: State<'_, UploadSessions>,
    user_id: u64,
    branch: Option<i64>,
    path: String,
) -> Result<String, String> {
    let remote = prepare(&app, &cache, user_id).await?;
    let job = cache.upload_begin(&remote, user_id as i64, branch, &path).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut open = sessions.open.lock().unwrap();
    open.retain(|_, u| u.started.elapsed() < Duration::from_secs(3600));
    open.insert(
        id.clone(),
        Upload { owner: crate::window_host::caller_key(&window), user_id, started: Instant::now(), job: Arc::new(tokio::sync::Mutex::new(job)) },
    );
    Ok(id)
}

/// The next piece of an upload: its bytes are the request body and `id` an argument (see
/// `ipc::body_bytes`/`field`). Any size will do — Filen's own 1 MiB chunks are cut from what arrives.
/// A piece that fails ends the upload.
#[tauri::command]
pub async fn filen_cache_upload_chunk(
    window: crate::window_host::CallerWindow,
    app: AppHandle,
    cache: State<'_, Cache>,
    sessions: State<'_, UploadSessions>,
    request: Request<'_>,
) -> Result<(), String> {
    let id = crate::ipc::field(&request, "id")?;
    let bytes = crate::ipc::body_bytes(&request)?;
    let owner = crate::window_host::caller_key(&window);
    let (user_id, job) = sessions.get(&id, &owner)?;
    let remote = prepare(&app, &cache, user_id).await?;
    let pushed = cache.upload_push(&remote, &mut *job.lock().await, &bytes).await;
    if pushed.is_err() {
        sessions.remove(&id, &owner);
    }
    pushed
}

/// Ends an upload: the file now exists, and what was sent is its cached copy.
#[tauri::command]
pub async fn filen_cache_upload_finish(
    window: crate::window_host::CallerWindow,
    app: AppHandle,
    cache: State<'_, Cache>,
    sessions: State<'_, UploadSessions>,
    id: String,
) -> Result<(), String> {
    let upload = sessions.remove(&id, &crate::window_host::caller_key(&window)).ok_or("That upload isn't open.")?;
    let remote = prepare(&app, &cache, upload.user_id).await?;
    let job = Arc::try_unwrap(upload.job).map_err(|_| "That upload is still busy.".to_string())?.into_inner();
    cache.upload_finish(&remote, job).await
}

/// Gives up an upload: nothing is left of it.
#[tauri::command]
pub fn filen_cache_upload_abort(window: crate::window_host::CallerWindow, sessions: State<'_, UploadSessions>, id: String) -> Result<(), String> {
    sessions.remove(&id, &crate::window_host::caller_key(&window));
    Ok(())
}

/// Uploads a file that is already on this device — the file at `source` inside `root` (a folder the
/// app may use, named as the file commands name it) — to `path` in the account or in `branch`. Rust
/// reads it piece by piece; the file never goes through the window.
#[tauri::command]
pub async fn filen_cache_upload_from_path(
    app: AppHandle,
    cache: State<'_, Cache>,
    scope: State<'_, FsScope>,
    user_id: u64,
    branch: Option<i64>,
    path: String,
    root: String,
    source: String,
) -> Result<(), String> {
    let real = scope.check_in(&root, &source, true)?;
    if !real.is_file() {
        return Err("That isn't a file.".to_string());
    }
    let remote = prepare(&app, &cache, user_id).await?;
    cache.upload_from_file(&remote, user_id as i64, branch, &path, &real).await
}

/// Copies a file from the account (or a branch) to `dest` inside `root` — a folder the app may use.
/// The file is fetched into the cache as a stream if it isn't there, then copied on this side.
#[tauri::command]
pub async fn filen_cache_download_to(
    app: AppHandle,
    cache: State<'_, Cache>,
    scope: State<'_, FsScope>,
    user_id: u64,
    branch: Option<i64>,
    path: String,
    root: String,
    dest: String,
) -> Result<(), String> {
    let target = scope.check_in(&root, &dest, true)?;
    let remote = prepare(&app, &cache, user_id).await?;
    let cached = cache.cached_file(&remote, user_id as i64, branch, &path).await?;
    tauri::async_runtime::spawn_blocking(move || std::fs::copy(cached, target).map(|_| ()).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Exports a file from the account (or a branch) to the person's device — see `device_files`; the
/// desktop's `token` comes from `choose_save_location`. Fetched into the cache as a stream if need be,
/// then copied: it never goes through the window. Trusted windows only, like every export.
#[tauri::command]
pub async fn filen_cache_export(
    window: crate::window_host::CallerWindow,
    app: AppHandle,
    cache: State<'_, Cache>,
    exports: State<'_, ExportState>,
    user_id: u64,
    branch: Option<i64>,
    path: String,
    name: String,
    token: Option<String>,
) -> Result<String, String> {
    crate::window_host::require_trusted(&window)?;
    let remote = prepare(&app, &cache, user_id).await?;
    let cached = cache.cached_file(&remote, user_id as i64, branch, &path).await?;
    crate::device_files::export_file(exports.inner(), name, token, cached).await
}
