//! The commands over the Filen cache (`files_cache.rs`) — what the Notes app's file manager calls.
//! They mirror the `filen_*` commands (same shapes, same "any window" access, no credentials ever
//! shown), with a cache in between and an optional **branch** to work in instead of the account
//! itself. A branch is named by its index (`1` for the folder `001`) and is always one of the
//! account's; leave it out to work on the account itself.
//!
//! The account's own `files/` folder is not reachable through the file commands (it is a protected
//! path in the file scope), so this is the only way in.

use tauri::ipc::{Request, Response};
use tauri::{AppHandle, State};

use crate::files_cache::{AccountCacheInfo, BranchChange, BranchInfo, Cache, CommitReport, FilenRemote, Listing};

/// The account's Filen session as a `Remote`, after making sure the account has its cache folders.
async fn prepare(app: &AppHandle, cache: &Cache, user_id: u64) -> Result<FilenRemote, String> {
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
