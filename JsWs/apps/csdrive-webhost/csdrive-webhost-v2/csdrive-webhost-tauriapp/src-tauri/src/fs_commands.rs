//! The file commands available to every window — the admin-app's file manager and web apps alike
//! — replacing the fs plugin's. Each takes an absolute path and runs it past the app's own scope
//! (`fs_scope.rs`) before touching anything, and then operates on the *resolved* path the scope
//! judged, not on what the caller typed. A web app finds the user folder with `get_user_folder`
//! and the picked folders with `list_picked_roots`.
//!
//! Small on purpose: what the Files tab and web apps need, no more. Text and byte reads/writes
//! share one pair of commands (`fs_read_file`, `fs_write_file`); the JS side decodes.
//! Uploading bytes goes through `ipc::body_bytes`/`field` like the other upload commands (see
//! `invokeWithBytes` in the admin-app).

use std::path::Path;

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
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

// ── The operations (plain functions, so they can be tested without an app) ────

fn read_dir(scope: &FsScope, path: &Path) -> Result<Vec<DirEntryInfo>, String> {
    let real = scope.check(path, true)?;
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

fn stat(scope: &FsScope, path: &Path) -> Result<FileInfo, String> {
    let real = scope.check(path, true)?;
    let meta = std::fs::metadata(&real).map_err(io)?;
    let is_symlink = scope
        .check(path, false)
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

fn exists(scope: &FsScope, path: &Path) -> Result<bool, String> {
    Ok(scope.check(path, true)?.exists())
}

fn read_file(scope: &FsScope, path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(scope.check(path, true)?).map_err(io)
}

/// Creates or replaces the file; its folder must exist already (`mkdir` makes it).
fn write_file(scope: &FsScope, path: &Path, data: &[u8]) -> Result<(), String> {
    std::fs::write(scope.check(path, true)?, data).map_err(io)
}

fn mkdir(scope: &FsScope, path: &Path, recursive: bool) -> Result<(), String> {
    let real = scope.check(path, true)?;
    let made = if recursive { std::fs::create_dir_all(real) } else { std::fs::create_dir(real) };
    made.map_err(io)
}

/// Deletes a file, a link (itself, never what it points to), or a folder — with its contents only if `recursive`.
fn remove(scope: &FsScope, path: &Path, recursive: bool) -> Result<(), String> {
    let entry = scope.check(path, false)?; // the entry itself, not what a link at the end leads to
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

/// Renames or moves an entry (a link is moved itself). An existing target is replaced, as with `std::fs::rename`.
fn rename(scope: &FsScope, from: &Path, to: &Path) -> Result<(), String> {
    std::fs::rename(scope.check(from, false)?, scope.check(to, false)?).map_err(io)
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn fs_read_dir(scope: State<'_, FsScope>, path: String) -> Result<Vec<DirEntryInfo>, String> {
    let scope = scope.inner().clone();
    blocking(move || read_dir(&scope, Path::new(&path))).await
}

#[tauri::command]
pub async fn fs_stat(scope: State<'_, FsScope>, path: String) -> Result<FileInfo, String> {
    let scope = scope.inner().clone();
    blocking(move || stat(&scope, Path::new(&path))).await
}

#[tauri::command]
pub async fn fs_exists(scope: State<'_, FsScope>, path: String) -> Result<bool, String> {
    let scope = scope.inner().clone();
    blocking(move || exists(&scope, Path::new(&path))).await
}

/// The file's bytes as a raw binary response (an `ArrayBuffer` in JS).
#[tauri::command]
pub async fn fs_read_file(scope: State<'_, FsScope>, path: String) -> Result<Response, String> {
    let scope = scope.inner().clone();
    blocking(move || read_file(&scope, Path::new(&path))).await.map(Response::new)
}

/// Creates or replaces a file: its bytes are the request body and `path` an argument (see
/// `ipc::body_bytes`/`field`; from JS, `invokeWithBytes('fs_write_file', bytes, { path })`).
#[tauri::command]
pub async fn fs_write_file(scope: State<'_, FsScope>, request: Request<'_>) -> Result<(), String> {
    let path = crate::ipc::field(&request, "path")?;
    let data = crate::ipc::body_bytes(&request)?;
    let scope = scope.inner().clone();
    blocking(move || write_file(&scope, Path::new(&path), &data)).await
}

#[tauri::command]
pub async fn fs_mkdir(scope: State<'_, FsScope>, path: String, recursive: Option<bool>) -> Result<(), String> {
    let scope = scope.inner().clone();
    blocking(move || mkdir(&scope, Path::new(&path), recursive.unwrap_or(false))).await
}

#[tauri::command]
pub async fn fs_remove(scope: State<'_, FsScope>, path: String, recursive: Option<bool>) -> Result<(), String> {
    let scope = scope.inner().clone();
    blocking(move || remove(&scope, Path::new(&path), recursive.unwrap_or(false))).await
}

#[tauri::command]
pub async fn fs_rename(scope: State<'_, FsScope>, from: String, to: String) -> Result<(), String> {
    let scope = scope.inner().clone();
    blocking(move || rename(&scope, Path::new(&from), Path::new(&to))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scoped(name: &str) -> (FsScope, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("csdrive-fs-commands-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (root, outside) = (base.join("root"), base.join("outside"));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let (root, outside) = (root.canonicalize().unwrap(), outside.canonicalize().unwrap());
        let scope = FsScope::new();
        scope.allow_fixed(&root);
        (scope, root, outside)
    }

    #[test]
    fn files_and_folders_can_be_created_read_listed_renamed_and_removed() {
        let (scope, root, _) = scoped("crud");

        write_file(&scope, &root.join("a.txt"), b"hello").unwrap();
        assert_eq!(read_file(&scope, &root.join("a.txt")).unwrap(), b"hello");
        write_file(&scope, &root.join("a.txt"), b"hi").unwrap();
        assert_eq!(read_file(&scope, &root.join("a.txt")).unwrap(), b"hi", "replaced, not appended");
        assert!(write_file(&scope, &root.join("no-such-folder/b.txt"), b"x").is_err(), "the folder must exist");

        mkdir(&scope, &root.join("x/y/z"), true).unwrap();
        assert!(mkdir(&scope, &root.join("p/q"), false).is_err(), "non-recursive needs the parent");
        assert!(exists(&scope, &root.join("x/y")).unwrap());
        assert!(!exists(&scope, &root.join("nope")).unwrap());

        let mut listed = read_dir(&scope, &root).unwrap();
        listed.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(
            listed,
            [
                DirEntryInfo { name: "a.txt".into(), is_directory: false, is_file: true, is_symlink: false },
                DirEntryInfo { name: "x".into(), is_directory: true, is_file: false, is_symlink: false },
            ]
        );
        let info = stat(&scope, &root.join("a.txt")).unwrap();
        assert!(info.is_file && !info.is_directory && !info.is_symlink);
        assert_eq!(info.size, 2);
        assert!(info.mtime_ms.is_some());

        rename(&scope, &root.join("a.txt"), &root.join("x/moved.txt")).unwrap();
        assert!(!exists(&scope, &root.join("a.txt")).unwrap());
        assert_eq!(read_file(&scope, &root.join("x/moved.txt")).unwrap(), b"hi");

        assert!(remove(&scope, &root.join("x"), false).is_err(), "a folder with things in it needs recursive");
        remove(&scope, &root.join("x"), true).unwrap();
        assert!(!exists(&scope, &root.join("x")).unwrap());
        assert!(remove(&scope, &root.join("x"), true).is_err(), "already gone");
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn nothing_outside_the_scope_is_touched_by_any_command() {
        let (scope, root, outside) = scoped("outside");
        std::fs::write(outside.join("secret.txt"), "s").unwrap();
        let (secret, fresh) = (outside.join("secret.txt"), outside.join("new.txt"));

        assert!(read_dir(&scope, &outside).is_err());
        assert!(stat(&scope, &secret).is_err());
        assert!(exists(&scope, &secret).is_err(), "even whether it exists isn't revealed");
        assert!(read_file(&scope, &secret).is_err());
        assert!(write_file(&scope, &fresh, b"x").is_err());
        assert!(!fresh.exists());
        assert!(mkdir(&scope, &outside.join("d"), true).is_err());
        assert!(remove(&scope, &secret, false).is_err());
        assert!(secret.exists());
        std::fs::write(root.join("mine.txt"), "m").unwrap();
        assert!(rename(&scope, &root.join("mine.txt"), &fresh).is_err(), "moving out");
        assert!(rename(&scope, &secret, &root.join("stolen.txt")).is_err(), "moving in");
        assert!(root.join("mine.txt").exists() && secret.exists());
        assert!(read_file(&scope, &root.join("../outside/secret.txt")).is_err(), "`..`");
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

        assert!(read_dir(&scope, &link).is_err(), "can't look through it");
        assert!(write_file(&scope, &link.join("x.txt"), b"x").is_err(), "or write through it");
        let listed = read_dir(&scope, &root).unwrap();
        assert!(listed.iter().any(|e| e.name == "link" && e.is_symlink));

        remove(&scope, &link, true).unwrap();
        assert!(!link.exists() && std::fs::symlink_metadata(&link).is_err(), "the link is gone");
        assert!(outside.join("keep.txt").exists(), "what it pointed to is untouched");
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }
}
