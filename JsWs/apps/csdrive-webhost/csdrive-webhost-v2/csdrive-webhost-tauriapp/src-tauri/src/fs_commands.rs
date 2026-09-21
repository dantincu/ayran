//! The file commands available to every window — the admin-app's file manager and web apps alike
//! — replacing the fs plugin's. Each names a **root** (`user`, or the id of a folder the person
//! picked) and a **path relative to it**, and runs that past the app's own scope (`fs_scope.rs`)
//! before touching anything; it then operates on the *resolved* location the scope judged, not on
//! what the caller typed. A window never sees a real path: it finds the picked folders with
//! `list_picked_roots` (ids and labels) and everything it is told about a refusal names the relative
//! path.
//!
//! Small on purpose: what the Files tab and web apps need, no more. Text and byte reads/writes
//! share one pair of commands (`fs_read_file`, `fs_write_file`); the JS side decodes.
//! Uploading bytes goes through `ipc::body_bytes`/`field` like the other upload commands (see
//! `invokeWithBytes` in the admin-app).

use serde::Serialize;
use tauri::ipc::{Request, Response};
use tauri::State;

use crate::fs_scope::FsScope;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    pub is_directory: bool,
    pub is_file: bool,
    pub is_symlink: bool,
}

/// An entry of a listing with what a search and a sort need — size and dates — in **one** call for the whole folder (asking for each
/// entry would be a call per entry). `created_ms` is `None` where the platform doesn't keep a creation time.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryDetailed {
    pub name: String,
    pub is_directory: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub size: Option<u64>,
    pub mtime_ms: Option<u64>,
    pub created_ms: Option<u64>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub is_file: bool,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mtime_ms: Option<u64>,
}

fn io(e: std::io::Error) -> String {
    e.to_string()
}

/// Runs blocking file work off the async runtime's threads (a big read or delete mustn't hold one).
pub(crate) async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

// ── The operations (plain functions, so they can be tested without an app) ────

fn read_dir(scope: &FsScope, root: &str, rel: &str) -> Result<Vec<DirEntryInfo>, String> {
    let real = scope.check_in(root, rel, true)?;
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&real).map_err(io)? {
        let entry = entry.map_err(io)?;
        let listed = entry.metadata().map_err(io)?; // does not follow links
        let is_symlink = listed.file_type().is_symlink();
        // A link is described by what it leads to (so a linked folder can be opened), if that can be seen.
        let shown = if is_symlink { std::fs::metadata(entry.path()).ok() } else { Some(listed) };
        entries.push(DirEntryInfo {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_directory: shown.as_ref().is_some_and(|m| m.is_dir()),
            is_file: shown.as_ref().is_some_and(|m| m.is_file()),
            is_symlink,
        });
    }
    Ok(entries)
}

fn millis(time: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    time.ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64)
}

fn read_dir_detailed(scope: &FsScope, root: &str, rel: &str) -> Result<Vec<DirEntryDetailed>, String> {
    let real = scope.check_in(root, rel, true)?;
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&real).map_err(io)? {
        let entry = entry.map_err(io)?;
        let listed = entry.metadata().map_err(io)?; // does not follow links
        let is_symlink = listed.file_type().is_symlink();
        let shown = if is_symlink { std::fs::metadata(entry.path()).ok() } else { Some(listed) };
        let is_file = shown.as_ref().is_some_and(|m| m.is_file());
        entries.push(DirEntryDetailed {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_directory: shown.as_ref().is_some_and(|m| m.is_dir()),
            is_file,
            is_symlink,
            size: shown.as_ref().filter(|m| m.is_file()).map(|m| m.len()),
            mtime_ms: shown.as_ref().and_then(|m| millis(m.modified())),
            created_ms: shown.as_ref().and_then(|m| millis(m.created())),
        });
    }
    Ok(entries)
}

fn stat(scope: &FsScope, root: &str, rel: &str) -> Result<FileInfo, String> {
    let real = scope.check_in(root, rel, true)?;
    let meta = std::fs::metadata(&real).map_err(io)?;
    let is_symlink = scope
        .check_in(root, rel, false)
        .ok()
        .and_then(|own| std::fs::symlink_metadata(own).ok())
        .is_some_and(|m| m.file_type().is_symlink());
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    Ok(FileInfo { is_file: meta.is_file(), is_directory: meta.is_dir(), is_symlink, size: meta.len(), mtime_ms })
}

fn exists(scope: &FsScope, root: &str, rel: &str) -> Result<bool, String> {
    Ok(scope.check_in(root, rel, true)?.exists())
}

fn read_file(scope: &FsScope, root: &str, rel: &str) -> Result<Vec<u8>, String> {
    std::fs::read(scope.check_in(root, rel, true)?).map_err(io)
}

/// Creates or replaces the file; its folder must exist already (`mkdir` makes it).
fn write_file(scope: &FsScope, root: &str, rel: &str, data: &[u8]) -> Result<(), String> {
    std::fs::write(scope.check_in(root, rel, true)?, data).map_err(io)
}

fn mkdir(scope: &FsScope, root: &str, rel: &str, recursive: bool) -> Result<(), String> {
    let real = scope.check_in(root, rel, true)?;
    let made = if recursive { std::fs::create_dir_all(real) } else { std::fs::create_dir(real) };
    made.map_err(io)
}

/// Deletes a file, a link (itself, never what it points to), or a folder — with its contents only if `recursive`.
fn remove(scope: &FsScope, root: &str, rel: &str, recursive: bool) -> Result<(), String> {
    let entry = scope.check_in(root, rel, false)?; // the entry itself, not what a link at the end leads to
    let meta = std::fs::symlink_metadata(&entry).map_err(io)?;
    if meta.file_type().is_symlink() {
        // A link to a folder is removed like a folder on Windows and like a file elsewhere.
        return std::fs::remove_file(&entry).or_else(|_| std::fs::remove_dir(&entry)).map_err(io);
    }
    if meta.is_dir() {
        let removed = if recursive { std::fs::remove_dir_all(&entry) } else { std::fs::remove_dir(&entry) };
        removed.map_err(io)
    } else {
        std::fs::remove_file(&entry).map_err(io)
    }
}

/// Renames or moves an entry within a root (a link is moved itself). An existing target is
/// replaced, as with `std::fs::rename`.
fn rename(scope: &FsScope, root: &str, from: &str, to: &str) -> Result<(), String> {
    std::fs::rename(scope.check_in(root, from, false)?, scope.check_in(root, to, false)?).map_err(io)
}

/// Copies a file, from one place the app may use to another (the same root or not), without it
/// passing through the caller. An existing target is replaced.
fn copy_file(scope: &FsScope, from_root: &str, from: &str, to_root: &str, to: &str) -> Result<(), String> {
    let source = scope.check_in(from_root, from, true)?;
    let target = scope.check_in(to_root, to, true)?;
    if !source.is_file() {
        return Err(format!("\"{from}\" isn't a file."));
    }
    if source == target {
        return Err("That is the same file.".to_string()); // copying a file onto itself would empty it
    }
    std::fs::copy(source, target).map(|_| ()).map_err(io)
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn fs_read_dir(scope: State<'_, FsScope>, root: String, path: String) -> Result<Vec<DirEntryInfo>, String> {
    let scope = scope.inner().clone();
    blocking(move || read_dir(&scope, &root, &path)).await
}

/// A folder's entries with their sizes and dates (see `DirEntryDetailed`): what searching and sorting a listing need.
#[tauri::command]
pub async fn fs_read_dir_detailed(scope: State<'_, FsScope>, root: String, path: String) -> Result<Vec<DirEntryDetailed>, String> {
    let scope = scope.inner().clone();
    blocking(move || read_dir_detailed(&scope, &root, &path)).await
}

#[tauri::command]
pub async fn fs_stat(scope: State<'_, FsScope>, root: String, path: String) -> Result<FileInfo, String> {
    let scope = scope.inner().clone();
    blocking(move || stat(&scope, &root, &path)).await
}

#[tauri::command]
pub async fn fs_exists(scope: State<'_, FsScope>, root: String, path: String) -> Result<bool, String> {
    let scope = scope.inner().clone();
    blocking(move || exists(&scope, &root, &path)).await
}

/// The file's bytes as a raw binary response (an `ArrayBuffer` in JS).
#[tauri::command]
pub async fn fs_read_file(scope: State<'_, FsScope>, root: String, path: String) -> Result<Response, String> {
    let scope = scope.inner().clone();
    blocking(move || read_file(&scope, &root, &path)).await.map(Response::new)
}

/// Creates or replaces a file: its bytes are the request body; `root` and `path` are arguments (see
/// `ipc::body_bytes`/`field`; from JS, `invokeWithBytes('fs_write_file', bytes, { root, path })`).
#[tauri::command]
pub async fn fs_write_file(scope: State<'_, FsScope>, request: Request<'_>) -> Result<(), String> {
    let root = crate::ipc::field(&request, "root")?;
    let path = crate::ipc::field(&request, "path")?;
    let data = crate::ipc::body_bytes(&request)?;
    let scope = scope.inner().clone();
    blocking(move || write_file(&scope, &root, &path, &data)).await
}

#[tauri::command]
pub async fn fs_mkdir(scope: State<'_, FsScope>, root: String, path: String, recursive: Option<bool>) -> Result<(), String> {
    let scope = scope.inner().clone();
    blocking(move || mkdir(&scope, &root, &path, recursive.unwrap_or(false))).await
}

#[tauri::command]
pub async fn fs_remove(scope: State<'_, FsScope>, root: String, path: String, recursive: Option<bool>) -> Result<(), String> {
    let scope = scope.inner().clone();
    blocking(move || remove(&scope, &root, &path, recursive.unwrap_or(false))).await
}

#[tauri::command]
pub async fn fs_rename(scope: State<'_, FsScope>, root: String, from: String, to: String) -> Result<(), String> {
    let scope = scope.inner().clone();
    blocking(move || rename(&scope, &root, &from, &to)).await
}

/// Copies a file, in Rust: from `from` inside `from_root` to `to` inside `to_root` (the destination's
/// folder must exist). A big file is never read into a window.
#[tauri::command]
pub async fn fs_copy(scope: State<'_, FsScope>, from_root: String, from: String, to_root: String, to: String) -> Result<(), String> {
    let scope = scope.inner().clone();
    blocking(move || copy_file(&scope, &from_root, &from, &to_root, &to)).await
}

/// Where a root really is — **the admin-app only**, for showing the person which folder a root is.
/// (A window learns nothing of the kind: see `fs_scope.rs`.)
#[tauri::command]
pub fn fs_root_path(window: crate::window_host::CallerWindow, scope: State<'_, FsScope>, root: String) -> Result<String, String> {
    crate::window_host::require_admin(&window)?;
    let real = scope.root_real(&root).ok_or_else(|| "That folder isn't available.".to_string())?;
    let shown = real.display().to_string();
    // Windows' canonical form carries a `\\?\` prefix that means nothing to a person.
    Ok(shown.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(shown))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A scope whose `user` root is a scratch folder, with a sibling folder outside it.
    fn scoped(name: &str) -> (FsScope, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("csdrive-fs-commands-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (root, outside) = (base.join("root"), base.join("outside"));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let (root, outside) = (root.canonicalize().unwrap(), outside.canonicalize().unwrap());
        let scope = FsScope::new();
        scope.allow_fixed_as("user", &root);
        (scope, root, outside)
    }

    const U: &str = "user";

    #[test]
    fn a_detailed_listing_carries_sizes_and_dates_for_the_whole_folder_in_one_call() {
        let (scope, _, _) = scoped("detailed");
        write_file(&scope, U, "a.txt", b"hello").unwrap();
        mkdir(&scope, U, "sub", false).unwrap();
        let mut entries = read_dir_detailed(&scope, U, "").unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(entries.len(), 2);
        assert_eq!((entries[0].name.as_str(), entries[0].is_file, entries[0].size), ("a.txt", true, Some(5)));
        assert!(entries[0].mtime_ms.is_some_and(|ms| ms > 1_000_000_000_000), "a modification time in milliseconds");
        assert_eq!((entries[1].name.as_str(), entries[1].is_directory, entries[1].size), ("sub", true, None), "a folder has no size");
        assert!(read_dir_detailed(&scope, U, "../outside").is_err(), "the scope is judged as for any listing");
    }

    #[test]
    fn files_and_folders_can_be_created_read_listed_renamed_and_removed() {
        let (scope, root, _) = scoped("crud");

        write_file(&scope, U, "a.txt", b"hello").unwrap();
        assert_eq!(read_file(&scope, U, "a.txt").unwrap(), b"hello");
        assert!(root.join("a.txt").exists(), "in the root's real folder");
        write_file(&scope, U, "a.txt", b"hi").unwrap();
        assert_eq!(read_file(&scope, U, "a.txt").unwrap(), b"hi", "replaced, not appended");
        assert!(write_file(&scope, U, "no-such-folder/b.txt", b"x").is_err(), "the folder must exist");

        mkdir(&scope, U, "x/y/z", true).unwrap();
        assert!(mkdir(&scope, U, "p/q", false).is_err(), "non-recursive needs the parent");
        assert!(exists(&scope, U, "x/y").unwrap());
        assert!(!exists(&scope, U, "nope").unwrap());

        let mut listed = read_dir(&scope, U, "").unwrap();
        listed.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(
            listed,
            [
                DirEntryInfo { name: "a.txt".into(), is_directory: false, is_file: true, is_symlink: false },
                DirEntryInfo { name: "x".into(), is_directory: true, is_file: false, is_symlink: false },
            ]
        );
        let info = stat(&scope, U, "a.txt").unwrap();
        assert!(info.is_file && !info.is_directory && !info.is_symlink);
        assert_eq!(info.size, 2);
        assert!(info.mtime_ms.is_some());

        rename(&scope, U, "a.txt", "x/moved.txt").unwrap();
        assert!(!exists(&scope, U, "a.txt").unwrap());
        assert_eq!(read_file(&scope, U, "x/moved.txt").unwrap(), b"hi");

        assert!(remove(&scope, U, "x", false).is_err(), "a folder with things in it needs recursive");
        remove(&scope, U, "x", true).unwrap();
        assert!(!exists(&scope, U, "x").unwrap());
        assert!(remove(&scope, U, "x", true).is_err(), "already gone");
        assert!(remove(&scope, U, "", true).is_err(), "the root itself is never removed");
        assert!(root.is_dir());
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn a_file_is_copied_in_rust_between_roots_and_never_onto_itself() {
        let (scope, root, _) = scoped("copy");
        let other = root.parent().unwrap().join("other");
        std::fs::create_dir_all(&other).unwrap();
        scope.allow_picked_as("k3y9", &other).unwrap();
        write_file(&scope, U, "a.txt", b"content").unwrap();

        copy_file(&scope, U, "a.txt", U, "b.txt").unwrap();
        assert_eq!(read_file(&scope, U, "b.txt").unwrap(), b"content");
        copy_file(&scope, U, "a.txt", "k3y9", "c.txt").unwrap();
        assert_eq!(std::fs::read(other.join("c.txt")).unwrap(), b"content", "into another root");
        write_file(&scope, U, "a.txt", b"newer").unwrap();
        copy_file(&scope, U, "a.txt", "k3y9", "c.txt").unwrap();
        assert_eq!(std::fs::read(other.join("c.txt")).unwrap(), b"newer", "replaced");

        assert!(copy_file(&scope, U, "a.txt", U, "a.txt").is_err(), "onto itself");
        assert_eq!(read_file(&scope, U, "a.txt").unwrap(), b"newer", "and it is intact");
        mkdir(&scope, U, "d", false).unwrap();
        assert!(copy_file(&scope, U, "d", U, "e").is_err(), "a folder isn't copied this way");
        assert!(copy_file(&scope, U, "a.txt", U, "no/such/f.txt").is_err(), "the destination's folder must exist");
        assert!(copy_file(&scope, U, "a.txt", "nope", "x.txt").is_err());
        assert!(copy_file(&scope, U, "../outside/x", U, "y.txt").is_err());
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn nothing_outside_the_scope_is_touched_by_any_command_and_no_real_path_is_ever_said() {
        let (scope, root, outside) = scoped("outside");
        std::fs::write(outside.join("secret.txt"), "s").unwrap();
        let (secret, fresh) = (outside.join("secret.txt"), outside.join("new.txt"));
        std::fs::write(root.join("mine.txt"), "m").unwrap();

        // The only way to say "outside" is `..`, which can't be said; and an unknown root has no folder.
        let real = root.parent().unwrap().to_string_lossy().to_string();
        let refusals = [
            read_dir(&scope, U, "../outside").unwrap_err(),
            stat(&scope, U, "../outside/secret.txt").unwrap_err(),
            exists(&scope, U, "../outside/secret.txt").unwrap_err(),
            read_file(&scope, U, "../outside/secret.txt").unwrap_err(),
            write_file(&scope, U, "../outside/new.txt", b"x").unwrap_err(),
            mkdir(&scope, U, "../outside/d", true).unwrap_err(),
            remove(&scope, U, "../outside/secret.txt", false).unwrap_err(),
            rename(&scope, U, "mine.txt", "../outside/new.txt").unwrap_err(),
            rename(&scope, U, "../outside/secret.txt", "stolen.txt").unwrap_err(),
            read_file(&scope, "not-a-root", "mine.txt").unwrap_err(),
        ];
        for message in refusals {
            assert!(!message.contains(&real), "a real path leaked: {message}");
        }
        assert!(!fresh.exists() && secret.exists() && root.join("mine.txt").exists());
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn a_link_pointing_outside_is_removed_itself_never_its_target() {
        let (scope, root, outside) = scoped("link");
        std::fs::write(outside.join("keep.txt"), "keep").unwrap();
        let link = root.join("link");
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&outside, &link).is_ok();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(&outside, &link).is_ok();
        if !made {
            eprintln!("(skipped: this OS user can't create symlinks)");
            let _ = std::fs::remove_dir_all(root.parent().unwrap());
            return;
        }

        assert!(read_dir(&scope, U, "link").is_err(), "can't look through it");
        assert!(write_file(&scope, U, "link/x.txt", b"x").is_err(), "or write through it");
        let listed = read_dir(&scope, U, "").unwrap();
        assert!(listed.iter().any(|e| e.name == "link" && e.is_symlink));

        remove(&scope, U, "link", true).unwrap();
        assert!(!link.exists() && std::fs::symlink_metadata(&link).is_err(), "the link is gone");
        assert!(outside.join("keep.txt").exists(), "what it pointed to is untouched");
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }
}
