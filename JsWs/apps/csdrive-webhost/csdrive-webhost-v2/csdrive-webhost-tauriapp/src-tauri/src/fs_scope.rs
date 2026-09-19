//! The one place that decides which files and folders the file commands (`fs_commands.rs`) and
//! SQLite (`sqlite_db.rs`) may touch — the app's own scope, replacing the fs plugin's.
//!
//! Why our own: the fs plugin's runtime scope can only grow (paths can be allowed or forbidden,
//! never taken back), so "forget this folder" couldn't actually revoke access until the app
//! restarted. Here a picked folder can be revoked at once, and re-picked afterwards.
//!
//! What is allowed:
//! - the **user folder**, always (`allow_fixed`);
//! - **picked folders** (`allow_picked`), which can be revoked (`revoke_picked`) — only they can:
//!   the user folder can't be, whatever a caller asks for;
//! and, whatever the above says, never anything inside a **denied** path (`deny`): the app's own
//! database and secrets (`admin/`, the data-location pointer), so picking a folder that happens to
//! contain them (say the whole app-data folder) doesn't expose them.
//!
//! Every path is resolved before it's judged, so links and `..` can't be used to step outside:
//! - `..` is refused outright and paths must be absolute;
//! - symlinks are followed to the real location, which is what's compared — including for a file
//!   that doesn't exist yet, whose nearest existing folder is resolved instead;
//! - a dangling link (whose target would be created by writing to it) is refused;
//! - for removing or renaming an entry itself, the entry's last component is *not* followed, so a
//!   link that points outside can still be removed from inside — the link goes, its target doesn't.
//!
//! (This also closes the old "links planted in `user/`" gap, where the plugin's check only resolved
//! paths that already existed.)

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Inner {
    /// Always allowed (the user folder).
    fixed: Vec<PathBuf>,
    /// Allowed until revoked.
    picked: Vec<PathBuf>,
    /// Never allowed, even inside an allowed folder.
    denied: Vec<PathBuf>,
}

/// Cheap to clone; every clone sees the same scope.
#[derive(Clone, Default)]
pub struct FsScope {
    inner: Arc<Mutex<Inner>>,
}

impl FsScope {
    pub fn new() -> Self {
        Self::default()
    }

    /// Allows `dir` for good (the user folder).
    pub fn allow_fixed(&self, dir: &Path) {
        let dir = resolve_best_effort(dir);
        let mut inner = self.inner.lock().unwrap();
        if !inner.fixed.contains(&dir) {
            inner.fixed.push(dir);
        }
    }

    /// Never allows `path` (a file or folder), even inside an allowed folder.
    pub fn deny(&self, path: &Path) {
        let path = resolve_best_effort(path);
        let mut inner = self.inner.lock().unwrap();
        if !inner.denied.contains(&path) {
            inner.denied.push(path);
        }
    }

    /// Allows a folder the user picked, until it is revoked. It must exist.
    pub fn allow_picked(&self, dir: &Path) -> Result<PathBuf, String> {
        let resolved = resolve(dir, true)?;
        if !resolved.is_dir() {
            return Err(format!("\"{}\" isn't a folder.", dir.display()));
        }
        let mut inner = self.inner.lock().unwrap();
        if !inner.picked.contains(&resolved) {
            inner.picked.push(resolved.clone());
        }
        Ok(resolved)
    }

    /// Takes a picked folder back out of the scope, effective immediately. Returns whether it was
    /// one. (Anything else — the user folder, a path that was never picked — is left alone.)
    pub fn revoke_picked(&self, dir: &Path) -> bool {
        let resolved = resolve_best_effort(dir);
        let mut inner = self.inner.lock().unwrap();
        let before = inner.picked.len();
        inner.picked.retain(|p| *p != resolved && p != dir);
        inner.picked.len() != before
    }

    /// Judges `path`, returning the real, resolved location to operate on. With `follow_last` false
    /// the last component is kept as it is instead of being followed (for removing or renaming an
    /// entry itself).
    pub fn check(&self, path: &Path, follow_last: bool) -> Result<PathBuf, String> {
        let resolved = resolve(path, follow_last)?;
        let inner = self.inner.lock().unwrap();
        if inner.denied.iter().any(|d| resolved.starts_with(d)) {
            return Err(format!("\"{}\" is protected — it holds the app's own data.", path.display()));
        }
        if inner.fixed.iter().chain(inner.picked.iter()).any(|root| resolved.starts_with(root)) {
            Ok(resolved)
        } else {
            Err(format!("\"{}\" is outside the folders this app may use.", path.display()))
        }
    }

    /// Whether `path` (followed to its real location) is allowed — for SQLite's checks.
    pub fn is_allowed(&self, path: &Path) -> bool {
        self.check(path, true).is_ok()
    }
}

/// Resolves `path` to the real location it names: absolute, no `..`, symlinks followed — even when
/// it (or its last components) don't exist yet, by resolving the nearest folder that does.
pub fn resolve(path: &Path, follow_last: bool) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("\"{}\" isn't an absolute path.", path.display()));
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => return Err(format!("\"{}\" contains \"..\".", path.display())),
            Component::CurDir => {}
            other => clean.push(other),
        }
    }

    if follow_last {
        return resolve_following(&clean);
    }
    let name = clean.file_name().ok_or_else(|| format!("\"{}\" has no name of its own.", path.display()))?.to_owned();
    let parent = clean.parent().ok_or_else(|| format!("\"{}\" has no parent folder.", path.display()))?;
    Ok(resolve_following(parent)?.join(name))
}

fn resolve_following(path: &Path) -> Result<PathBuf, String> {
    let mut existing = path.to_path_buf();
    let mut tail: Vec<OsString> = Vec::new();
    loop {
        match std::fs::canonicalize(&existing) {
            Ok(mut real) => {
                for part in tail.iter().rev() {
                    real.push(part);
                }
                return Ok(real);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // Nothing there — unless it is a link with nothing at its end. Writing to one would
                // create the file wherever the link points, so it can't be judged and is refused.
                if std::fs::symlink_metadata(&existing).is_ok() {
                    return Err(format!("\"{}\" is a link that leads nowhere.", existing.display()));
                }
                let Some(name) = existing.file_name().map(|n| n.to_owned()) else {
                    return Err(format!("\"{}\" doesn't exist.", path.display()));
                };
                tail.push(name);
                if !existing.pop() {
                    return Err(format!("\"{}\" doesn't exist.", path.display()));
                }
            }
            Err(e) => return Err(format!("\"{}\": {e}", path.display())),
        }
    }
}

/// `resolve`, or the path as given when it can't be resolved (for paths that are only ever compared).
fn resolve_best_effort(path: &Path) -> PathBuf {
    resolve(path, true).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh, empty scratch folder (canonical, so comparisons match what `resolve` returns).
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("csdrive-fs-scope-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    /// Makes a directory symlink where the OS allows it (Windows needs a privilege for it).
    fn try_dir_symlink(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(target, link).is_ok();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(target, link).is_ok();
        made
    }

    #[test]
    fn only_the_allowed_folders_are_reachable_and_paths_cannot_climb_out() {
        let base = scratch("basic");
        let (user, other) = (base.join("user"), base.join("other"));
        std::fs::create_dir_all(user.join("sub")).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(user.join("a.txt"), "a").unwrap();

        let scope = FsScope::new();
        scope.allow_fixed(&user);

        assert!(scope.check(&user, true).is_ok(), "the folder itself");
        assert!(scope.check(&user.join("a.txt"), true).is_ok());
        assert!(scope.check(&user.join("sub/new/deeper.txt"), true).is_ok(), "a file that doesn't exist yet");
        assert!(scope.check(&other, true).is_err());
        assert!(scope.check(&other.join("x.txt"), true).is_err(), "a new file outside");
        assert!(scope.check(&user.join("sub/../../other/x.txt"), true).is_err(), "`..` is refused, not resolved");
        assert!(scope.check(Path::new("relative/path.txt"), true).is_err());
        // A sibling that merely shares a name prefix isn't inside.
        let lookalike = base.join("user-evil");
        std::fs::create_dir_all(&lookalike).unwrap();
        assert!(scope.check(&lookalike, true).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_picked_folder_can_be_revoked_at_once_and_picked_again_but_the_user_folder_cannot_be_revoked() {
        let base = scratch("revoke");
        let (user, picked) = (base.join("user"), base.join("picked"));
        std::fs::create_dir_all(&user).unwrap();
        std::fs::create_dir_all(&picked).unwrap();

        let scope = FsScope::new();
        scope.allow_fixed(&user);
        assert!(scope.check(&picked.join("f.txt"), true).is_err(), "not yet");

        scope.allow_picked(&picked).unwrap();
        assert!(scope.check(&picked.join("f.txt"), true).is_ok());

        assert!(scope.revoke_picked(&picked), "it was picked");
        assert!(scope.check(&picked.join("f.txt"), true).is_err(), "revoked immediately");
        assert!(!scope.revoke_picked(&picked), "nothing left to revoke");

        scope.allow_picked(&picked).unwrap();
        assert!(scope.check(&picked.join("f.txt"), true).is_ok(), "and it can be picked again in the same session");

        assert!(!scope.revoke_picked(&user), "the user folder isn't a picked folder");
        assert!(scope.check(&user.join("f.txt"), true).is_ok(), "so it stays");
        assert!(scope.allow_picked(&base.join("missing")).is_err(), "only real folders can be picked");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn protected_paths_stay_out_of_reach_even_inside_an_allowed_folder() {
        let base = scratch("deny");
        let data = base.join("data");
        std::fs::create_dir_all(data.join("admin")).unwrap();
        std::fs::create_dir_all(data.join("user")).unwrap();
        std::fs::write(data.join("admin/data.db"), "secret").unwrap();

        let scope = FsScope::new();
        scope.deny(&data.join("admin"));
        scope.deny(&data.join("data-location.enc")); // doesn't exist yet
        scope.allow_picked(&data).unwrap(); // someone picked the whole data folder

        assert!(scope.check(&data.join("user/a.txt"), true).is_ok());
        assert!(scope.check(&data.join("admin/data.db"), true).is_err());
        assert!(scope.check(&data.join("admin/new.txt"), true).is_err());
        assert!(scope.check(&data.join("admin"), true).is_err());
        assert!(scope.check(&data.join("data-location.enc"), true).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn links_cannot_lead_outside_and_a_link_can_still_be_removed() {
        let base = scratch("links");
        let (user, outside) = (base.join("user"), base.join("outside"));
        std::fs::create_dir_all(&user).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "s").unwrap();

        let link = user.join("link");
        if !try_dir_symlink(&outside, &link) {
            eprintln!("(skipped: this OS user can't create symlinks)");
            let _ = std::fs::remove_dir_all(&base);
            return;
        }
        let scope = FsScope::new();
        scope.allow_fixed(&user);

        assert!(scope.check(&link, true).is_err(), "a link to outside is followed, so it's outside");
        assert!(scope.check(&link.join("secret.txt"), true).is_err(), "reading through it");
        assert!(scope.check(&link.join("new.txt"), true).is_err(), "and creating through it — the old plugin gap");
        assert_eq!(scope.check(&link, false).unwrap(), link, "the link itself can be removed or renamed");

        // A link that leads nowhere can't be judged: writing to it would create its target.
        let dangling = user.join("dangling");
        assert!(try_dir_symlink(&outside.join("not-there"), &dangling));
        assert!(scope.check(&dangling, true).is_err());
        assert!(scope.check(&dangling.join("x.txt"), true).is_err());
        assert!(scope.check(&dangling, false).is_ok(), "though the link itself can still be removed");
        let _ = std::fs::remove_dir_all(&base);
    }
}
