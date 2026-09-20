//! Putting a file that a window holds (a `File` from the device's file chooser, which has a name
//! and bytes but no path) into a folder the app may use — **piece by piece**, so a big file is never
//! held whole: the window sends it in pieces (`fs_upload_chunk`), each appended to a temporary file,
//! and `fs_upload_finish` moves that into place. It is the local counterpart of the Filen upload
//! sessions (`filen_cache_upload_*`) and works the same way: an upload belongs to the window that
//! began it, and nothing exists at the destination until it is finished.
//!
//! The temporary file lives in the app's own `files/` folder (never in the user's folders, where a
//! crash would leave clutter), and everything left there by an earlier run is cleared at startup.
//! The destination is judged by the file scope (`fs_scope.rs`) when the upload begins *and* again when
//! it finishes, so a folder that is forgotten in between can't be written to.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::ipc::Request;
use tauri::State;

use crate::fs_scope::FsScope;

struct Upload {
    /// Who began it: only that window may push to it.
    owner: String,
    root: String,
    path: String,
    tmp: PathBuf,
    file: Option<std::fs::File>,
    started: Instant,
}

impl Drop for Upload {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = std::fs::remove_file(&self.tmp);
    }
}

/// The uploads in progress, by a random id. Cheap to clone; every clone sees the same uploads.
#[derive(Clone)]
pub struct LocalUploads {
    dir: PathBuf,
    open: Arc<Mutex<HashMap<String, Upload>>>,
}

impl LocalUploads {
    /// `dir` is where the temporary files go. Whatever an earlier run left in it is deleted.
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::remove_dir_all(&dir);
        Self { dir, open: Arc::default() }
    }

    /// Starts uploading to `path` inside `root` — the file is created or replaced when it finishes; its
    /// folder must exist. Resolves to the upload's id. An upload that is never finished is dropped, with
    /// its temporary file, an hour after it began (the next time one begins).
    pub fn begin(&self, scope: &FsScope, owner: &str, root: &str, path: &str) -> Result<String, String> {
        let destination = scope.check_in(root, path, true)?;
        if destination.is_dir() {
            return Err(format!("\"{path}\" is a folder."));
        }
        if !destination.parent().is_some_and(Path::is_dir) {
            return Err(format!("The folder of \"{path}\" doesn't exist."));
        }
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let id = uuid::Uuid::new_v4().to_string();
        let tmp = self.dir.join(format!("{}.part", id.replace('-', "")));
        let file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let upload = Upload { owner: owner.into(), root: root.into(), path: path.into(), tmp, file: Some(file), started: Instant::now() };
        let mut open = self.open.lock().unwrap();
        open.retain(|_, u| u.started.elapsed() < Duration::from_secs(3600));
        open.insert(id.clone(), upload);
        Ok(id)
    }

    /// Appends the next piece. A piece that can't be written ends the upload.
    pub fn push(&self, owner: &str, id: &str, bytes: &[u8]) -> Result<(), String> {
        let mut open = self.open.lock().unwrap();
        let upload = open.get_mut(id).filter(|u| u.owner == owner).ok_or("That upload isn't open.")?;
        let written = upload.file.as_mut().ok_or("That upload isn't open.")?.write_all(bytes).map_err(|e| e.to_string());
        if written.is_err() {
            open.remove(id);
        }
        written
    }

    /// Ends the upload: the file now exists at its destination (replacing what was there).
    pub fn finish(&self, scope: &FsScope, owner: &str, id: &str) -> Result<(), String> {
        let mut upload = {
            let mut open = self.open.lock().unwrap();
            if !open.get(id).is_some_and(|u| u.owner == owner) {
                return Err("That upload isn't open.".to_string());
            }
            open.remove(id).expect("checked above")
        };
        drop(upload.file.take());
        // Judged again: the folder may have been forgotten since it began.
        let destination = scope.check_in(&upload.root, &upload.path, true)?;
        if std::fs::rename(&upload.tmp, &destination).is_err() {
            // Another drive, say: copy it across instead.
            std::fs::copy(&upload.tmp, &destination).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Gives up an upload (only its owner can): nothing is left of it.
    pub fn abort(&self, owner: &str, id: &str) {
        let mut open = self.open.lock().unwrap();
        if open.get(id).is_some_and(|u| u.owner == owner) {
            open.remove(id);
        }
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Starts uploading a file to `path` inside `root`; returns the upload's id. The window then sends
/// the file in pieces with `fs_upload_chunk` and ends with `fs_upload_finish` (or `fs_upload_abort`).
#[tauri::command]
pub async fn fs_upload_begin(
    window: tauri::WebviewWindow,
    scope: State<'_, FsScope>,
    uploads: State<'_, LocalUploads>,
    root: String,
    path: String,
) -> Result<String, String> {
    let (scope, uploads) = (scope.inner().clone(), uploads.inner().clone());
    let owner = crate::window_host::caller_key(&window);
    crate::fs_commands::blocking(move || uploads.begin(&scope, &owner, &root, &path)).await
}

/// The next piece of an upload: its bytes are the request body and `id` an argument (see
/// `ipc::body_bytes`/`field`; from JS, `invokeWithBytes('fs_upload_chunk', bytes, { id })`).
#[tauri::command]
pub async fn fs_upload_chunk(window: tauri::WebviewWindow, uploads: State<'_, LocalUploads>, request: Request<'_>) -> Result<(), String> {
    let id = crate::ipc::field(&request, "id")?;
    let bytes = crate::ipc::body_bytes(&request)?;
    let uploads = uploads.inner().clone();
    let owner = crate::window_host::caller_key(&window);
    crate::fs_commands::blocking(move || uploads.push(&owner, &id, &bytes)).await
}

#[tauri::command]
pub async fn fs_upload_finish(
    window: tauri::WebviewWindow,
    scope: State<'_, FsScope>,
    uploads: State<'_, LocalUploads>,
    id: String,
) -> Result<(), String> {
    let (scope, uploads) = (scope.inner().clone(), uploads.inner().clone());
    let owner = crate::window_host::caller_key(&window);
    crate::fs_commands::blocking(move || uploads.finish(&scope, &owner, &id)).await
}

#[tauri::command]
pub fn fs_upload_abort(window: tauri::WebviewWindow, uploads: State<'_, LocalUploads>, id: String) -> Result<(), String> {
    uploads.abort(&crate::window_host::caller_key(&window), &id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup(name: &str) -> (LocalUploads, FsScope, PathBuf) {
        let base = std::env::temp_dir().join(format!("csdrive-fs-upload-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (root, tmp) = (base.join("root"), base.join("tmp"));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let scope = FsScope::new();
        scope.allow_fixed_as("user", &root);
        (LocalUploads::new(tmp), scope, base)
    }

    fn parts(dir: &Path) -> usize {
        std::fs::read_dir(dir).map(|d| d.flatten().count()).unwrap_or(0)
    }

    #[test]
    fn a_file_arrives_in_pieces_and_exists_only_when_finished() {
        let (uploads, scope, base) = setup("pieces");
        std::fs::write(base.join("root/new.txt"), "old").unwrap();
        let id = uploads.begin(&scope, "w1", "user", "new.txt").unwrap();
        for piece in ["hel", "lo ", "pie", "ces"] {
            uploads.push("w1", &id, piece.as_bytes()).unwrap();
        }
        assert_eq!(std::fs::read_to_string(base.join("root/new.txt")).unwrap(), "old", "nothing changes until it is finished");
        assert_eq!(parts(&base.join("tmp")), 1);
        uploads.finish(&scope, "w1", &id).unwrap();
        assert_eq!(std::fs::read_to_string(base.join("root/new.txt")).unwrap(), "hello pieces", "replaced");
        assert_eq!(parts(&base.join("tmp")), 0, "the temporary file became the file");
        assert!(uploads.finish(&scope, "w1", &id).is_err(), "an id is used up");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_empty_file_and_a_new_name_work_and_a_bad_destination_is_refused_at_the_start() {
        let (uploads, scope, base) = setup("dest");
        let id = uploads.begin(&scope, "w1", "user", "empty.bin").unwrap();
        uploads.finish(&scope, "w1", &id).unwrap();
        assert_eq!(std::fs::read(base.join("root/empty.bin")).unwrap(), b"");

        std::fs::create_dir(base.join("root/dir")).unwrap();
        assert!(uploads.begin(&scope, "w1", "user", "dir").is_err(), "a folder isn't a file");
        assert!(uploads.begin(&scope, "w1", "user", "no/such/folder/f.txt").is_err(), "its folder must exist");
        assert!(uploads.begin(&scope, "w1", "user", "../escape.txt").is_err());
        assert!(uploads.begin(&scope, "w1", "nope", "f.txt").is_err(), "an unknown root");
        assert_eq!(parts(&base.join("tmp")), 0, "a refused start leaves nothing");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_upload_belongs_to_the_window_that_began_it() {
        let (uploads, scope, base) = setup("owner");
        let id = uploads.begin(&scope, "w1", "user", "mine.txt").unwrap();
        assert!(uploads.push("w2", &id, b"x").is_err(), "another window can't add to it");
        assert!(uploads.finish(&scope, "w2", &id).is_err(), "or finish it");
        uploads.abort("w2", &id); // and can't abort it either
        uploads.push("w1", &id, b"mine").unwrap();
        uploads.finish(&scope, "w1", &id).unwrap();
        assert_eq!(std::fs::read_to_string(base.join("root/mine.txt")).unwrap(), "mine");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_aborted_or_forgotten_upload_leaves_nothing_and_a_folder_forgotten_meanwhile_cannot_be_written() {
        let (uploads, scope, base) = setup("abort");
        let picked = base.join("picked");
        std::fs::create_dir_all(&picked).unwrap();
        scope.allow_picked_as("k3y9", &picked).unwrap();

        let id = uploads.begin(&scope, "w1", "user", "gone.txt").unwrap();
        uploads.push("w1", &id, b"partial").unwrap();
        uploads.abort("w1", &id);
        assert_eq!(parts(&base.join("tmp")), 0);
        assert!(!base.join("root/gone.txt").exists());
        assert!(uploads.push("w1", &id, b"more").is_err());

        // The folder is forgotten while the upload is under way: finishing is refused, and nothing is left.
        let id = uploads.begin(&scope, "w1", "k3y9", "late.txt").unwrap();
        uploads.push("w1", &id, b"data").unwrap();
        assert!(scope.revoke_picked_id("k3y9"));
        assert!(uploads.finish(&scope, "w1", &id).is_err());
        assert!(!picked.join("late.txt").exists());
        assert_eq!(parts(&base.join("tmp")), 0);

        // What an earlier run left behind is cleared when the app starts.
        std::fs::create_dir_all(base.join("tmp")).unwrap();
        std::fs::write(base.join("tmp/stale.part"), "x").unwrap();
        let _fresh = LocalUploads::new(base.join("tmp"));
        assert_eq!(parts(&base.join("tmp")), 0);
        let _ = std::fs::remove_dir_all(&base);
    }
}
