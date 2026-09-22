//! **Branches of a folder of this device** — the File Manager's counterpart of the Filen branches (`files_cache.rs`).
//!
//! A branch is a set of changes (files written, folders made, things deleted, files checked out) that stay in a folder of the
//! app's own until they are *committed* (applied to the real folder) or *discarded*. Reading through a branch shows the real
//! folder with the branch's changes on top. Unlike a Filen account there is **no cache**: the real folder is the base and is
//! always read as it is; the only things kept are the changed files themselves — `files/a/NNN/b/MMM/…`, inside the root's own
//! folder in `a` (the same top-level folder the Filen accounts' content lives in; `NNN-local-fs@@<root guid>` beside `NNN` says
//! whose it is, `MMM-<branch name>` beside `MMM` which branch it is) — and, in `files/data.db`, which paths the branch changed,
//! and the version of each that the change was based on (so a commit can tell that the folder changed underneath it). The
//! thumbnails of a root's files live beside these, inside the same `NNN` (`files/a/NNN/t/…`, and `files/a/NNN/tb/MMM/…` for a
//! branch's changed files).
//!
//! A root is named by its **guid** (`picked_roots::root_guid_of`): the branches, changes and folders belong to the root through it.
//! The base is reached through the file scope (`FsScope::check_in`) like any other access, so a link that leads outside the root,
//! or into the app's own data, is refused here too. Paths are `/`-separated, with a leading slash (`/`, `/docs/a.md`) as the
//! Filen ones are.

use std::path::{Path, PathBuf};

use sqlx::Row;

use super::*;
use crate::fs_scope::FsScope;

/// The full-folder-name part of a root's folders: `local-fs@@<guid>`.
pub fn root_part(guid: &str) -> String {
    format!("local-fs@@{guid}")
}

/// The folder as the branches see it underneath: the real one, judged by the file scope.
pub struct Base<'a> {
    pub scope: &'a FsScope,
    pub root: &'a str,
}

/// What the real folder says about one entry.
#[derive(Debug, Clone, PartialEq)]
pub struct BaseEntry {
    pub name: String,
    pub is_directory: bool,
    pub size: Option<u64>,
    pub mtime_ms: Option<u64>,
    pub created_ms: Option<u64>,
}

fn millis(t: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    t.ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64)
}

impl Base<'_> {
    fn rel(path: &str) -> &str {
        path.trim_start_matches('/')
    }

    /// The real place `path` names, judged by the scope (`follow_last`: see `FsScope::check_in`).
    pub fn real(&self, path: &str, follow_last: bool) -> Result<PathBuf, String> {
        self.scope.check_in(self.root, Self::rel(path), follow_last)
    }

    fn entry_of(name: String, meta: &std::fs::Metadata) -> BaseEntry {
        BaseEntry {
            name,
            is_directory: meta.is_dir(),
            size: meta.is_file().then(|| meta.len()),
            mtime_ms: millis(meta.modified()),
            created_ms: millis(meta.created()),
        }
    }

    /// The entries of a folder, with size and dates.
    pub fn list(&self, path: &str) -> Result<Vec<BaseEntry>, String> {
        let real = self.real(path, true)?;
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(&real).map_err(io)? {
            let entry = entry.map_err(io)?;
            let listed = entry.metadata().map_err(io)?;
            let shown = if listed.file_type().is_symlink() { std::fs::metadata(entry.path()).unwrap_or(listed) } else { listed };
            entries.push(Self::entry_of(entry.file_name().to_string_lossy().into_owned(), &shown));
        }
        Ok(entries)
    }

    /// One entry, or `None` when there is nothing there.
    pub fn stat(&self, path: &str) -> Result<Option<BaseEntry>, String> {
        let real = self.real(path, true)?;
        Ok(std::fs::metadata(&real).ok().map(|m| Self::entry_of(name_of(path).to_string(), &m)))
    }
}

impl FileVersion {
    fn of_base(entry: Option<&BaseEntry>) -> Self {
        match entry {
            Some(e) if !e.is_directory => Self { exists: true, size: e.size, mtime_ms: e.mtime_ms },
            _ => Self::missing(),
        }
    }
}

#[derive(sqlx::FromRow, Clone, Debug)]
struct LocalChange {
    path: String,
    kind: String,
    base_exists: i64,
    base_size: Option<i64>,
    base_mtime_ms: Option<i64>,
    changed_at: i64,
}

const CHANGE_COLUMNS: &str = "path, kind, base_exists, base_size, base_mtime_ms, changed_at";

/// A local file name for a component of a path in the branch's folder (see `mirror_name`).
fn mirrored(path: &str) -> PathBuf {
    path.split('/').filter(|p| !p.is_empty()).map(mirror_name).collect()
}

impl Cache {
    // ── Where things are ─────────────────────────────────────────────────────

    /// `files/a/NNN` — the folder of the root (the same `a` as the Filen accounts'): its branches (`b`), its thumbnails (`t`) and its
    /// branches' thumbnails (`tb`). `None` when it has none yet and `make` is off.
    fn root_dir(&self, guid: &str, make: bool) -> Result<Option<PathBuf>, String> {
        let a = self.a_dir();
        let part = root_part(guid);
        Ok(if make { Some(NUMBERING.ensure(&a, &part).map_err(io)?.short_dir) } else { NUMBERING.find(&a, &part).map_err(io)?.map(|p| p.short_dir) })
    }

    /// The root's folder goes when nothing is kept in it any more (no branches, no thumbnails).
    fn drop_root_dir_if_empty(&self, guid: &str) {
        if let Ok(Some(dir)) = self.root_dir(guid, false) {
            if std::fs::read_dir(&dir).map(|mut d| d.next().is_none()).unwrap_or(false) {
                let _ = NUMBERING.delete(&self.a_dir(), &root_part(guid));
            }
        }
    }

    /// `files/a/NNN/b/MMM` — the branch's short folder.
    fn local_branch_dir(&self, guid: &str, branch: i64) -> Result<PathBuf, String> {
        let root = self.root_dir(guid, false)?.ok_or("That branch doesn't exist.")?;
        Ok(root.join(crate::layout::FILES_BRANCHES_FOLDER).join(NUMBERING.short_name(branch as u32)))
    }

    /// Where the content of what the branch changed at `path` is kept.
    fn local_branch_file(&self, guid: &str, branch: i64, path: &str) -> Result<PathBuf, String> {
        Ok(self.local_branch_dir(guid, branch)?.join(mirrored(path)))
    }

    async fn local_branch_exists(&self, guid: &str, branch: i64) -> Result<(), String> {
        let found: Option<i64> = sqlx::query_scalar("SELECT pair_index FROM local_branches WHERE root_guid = ?1 AND pair_index = ?2")
            .bind(guid)
            .bind(branch)
            .fetch_optional(&self.pool)
            .await
            .map_err(sql)?;
        found.map(|_| ()).ok_or_else(|| "That branch doesn't exist.".to_string())
    }

    async fn local_branch_name(&self, guid: &str, branch: i64) -> Result<String, String> {
        sqlx::query_scalar("SELECT name FROM local_branches WHERE root_guid = ?1 AND pair_index = ?2")
            .bind(guid)
            .bind(branch)
            .fetch_optional(&self.pool)
            .await
            .map_err(sql)?
            .ok_or_else(|| "That branch doesn't exist.".to_string())
    }

    /// One operation at a time per root (the lock is keyed by a number, so a root is one by its guid's hash).
    async fn local_lock(&self, guid: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let key = -(hash_of(guid) as i64) - 1; // never an account's id
        let mutex = self.locks.lock().unwrap().entry(key).or_default().clone();
        mutex.lock_owned().await
    }

    // ── Branches ─────────────────────────────────────────────────────────────

    pub async fn local_branches(&self, guid: &str) -> Result<Vec<BranchInfo>, String> {
        let rows = sqlx::query(
            "SELECT b.pair_index, b.name, b.created_at,
                    (SELECT COUNT(*) FROM local_branch_changes c WHERE c.root_guid = b.root_guid AND c.branch = b.pair_index) AS changes
             FROM local_branches b WHERE b.root_guid = ?1 ORDER BY b.pair_index",
        )
        .bind(guid)
        .fetch_all(&self.pool)
        .await
        .map_err(sql)?;
        Ok(rows
            .iter()
            .map(|r| BranchInfo { index: r.get("pair_index"), name: r.get("name"), created_at: r.get("created_at"), changes: r.get("changes") })
            .collect())
    }

    pub async fn local_create_branch(&self, guid: &str, name: &str) -> Result<BranchInfo, String> {
        folder_pairs::validate_part(name)?;
        let _guard = self.local_lock(guid).await;
        if self.local_branches(guid).await?.iter().any(|b| b.name.to_lowercase() == name.to_lowercase()) {
            return Err(format!("There is a branch called \"{name}\" already."));
        }
        let branches = self.root_dir(guid, true)?.ok_or("The folder of the root couldn't be made.")?.join(crate::layout::FILES_BRANCHES_FOLDER);
        std::fs::create_dir_all(&branches).map_err(io)?;
        let pair = NUMBERING.create(&branches, name).map_err(io)?;
        sqlx::query("INSERT INTO local_branches (root_guid, pair_index, name, created_at) VALUES (?1, ?2, ?3, ?4)")
            .bind(guid)
            .bind(pair.index as i64)
            .bind(name)
            .bind(self.now())
            .execute(&self.pool)
            .await
            .map_err(sql)?;
        Ok(BranchInfo { index: pair.index as i64, name: name.to_string(), created_at: self.now(), changes: 0 })
    }

    async fn delete_local_branch(&self, guid: &str, branch: i64, name: &str) -> Result<(), String> {
        if let Some(root) = self.root_dir(guid, false)? {
            // With no branches left, `b` goes too.
            let b = root.join(crate::layout::FILES_BRANCHES_FOLDER);
            NUMBERING.delete(&b, name).map_err(io)?;
            let _ = std::fs::remove_dir(&b);
            // The branch's thumbnails go with it.
            let tb = root.join(crate::layout::FILES_BRANCH_THUMBNAILS_FOLDER);
            let _ = NUMBERING.delete(&tb, name);
            let _ = std::fs::remove_dir(&tb);
        }
        // And the root's own folder, when nothing is kept in it.
        self.drop_root_dir_if_empty(guid);
        sqlx::query("DELETE FROM local_branch_changes WHERE root_guid = ?1 AND branch = ?2").bind(guid).bind(branch).execute(&self.pool).await.map_err(sql)?;
        sqlx::query("DELETE FROM local_branches WHERE root_guid = ?1 AND pair_index = ?2").bind(guid).bind(branch).execute(&self.pool).await.map_err(sql)?;
        Ok(())
    }

    /// Throws the branch away: its folders and everything it changed. The real folder isn't touched.
    pub async fn local_discard_branch(&self, guid: &str, branch: i64) -> Result<(), String> {
        let _guard = self.local_lock(guid).await;
        self.local_branch_exists(guid, branch).await?;
        let name = self.local_branch_name(guid, branch).await?;
        self.delete_local_branch(guid, branch, &name).await
    }

    /// A root that is forgotten loses its thumbnails (they are made again if it is picked again); its branches stay, with their
    /// pending changes, for the same reason.
    pub fn local_drop_thumbnails(&self, guid: &str) {
        if let Ok(Some(root)) = self.root_dir(guid, false) {
            let _ = std::fs::remove_dir_all(root.join(crate::layout::FILES_THUMBNAILS_FOLDER));
        }
        self.drop_root_dir_if_empty(guid);
    }

    pub async fn local_branch_changes(&self, guid: &str, branch: i64) -> Result<Vec<BranchChange>, String> {
        self.local_branch_exists(guid, branch).await?;
        Ok(self
            .local_changes(guid, branch)
            .await?
            .into_iter()
            .map(|c| BranchChange { path: c.path, kind: c.kind, is_new: c.base_exists == 0 })
            .collect())
    }

    async fn local_changes(&self, guid: &str, branch: i64) -> Result<Vec<LocalChange>, String> {
        sqlx::query_as::<_, LocalChange>(&format!("SELECT {CHANGE_COLUMNS} FROM local_branch_changes WHERE root_guid = ?1 AND branch = ?2 ORDER BY path"))
            .bind(guid)
            .bind(branch)
            .fetch_all(&self.pool)
            .await
            .map_err(sql)
    }

    async fn local_change(&self, guid: &str, branch: i64, path: &str) -> Result<Option<LocalChange>, String> {
        sqlx::query_as::<_, LocalChange>(&format!("SELECT {CHANGE_COLUMNS} FROM local_branch_changes WHERE root_guid = ?1 AND branch = ?2 AND path = ?3"))
            .bind(guid)
            .bind(branch)
            .bind(path)
            .fetch_optional(&self.pool)
            .await
            .map_err(sql)
    }

    async fn local_change_children(&self, guid: &str, branch: i64, parent: &str) -> Result<Vec<LocalChange>, String> {
        sqlx::query_as::<_, LocalChange>(&format!("SELECT {CHANGE_COLUMNS} FROM local_branch_changes WHERE root_guid = ?1 AND branch = ?2 AND parent = ?3"))
            .bind(guid)
            .bind(branch)
            .bind(parent)
            .fetch_all(&self.pool)
            .await
            .map_err(sql)
    }

    async fn local_deleted_in_branch(&self, guid: &str, branch: i64, path: &str) -> Result<bool, String> {
        for prefix in prefixes(path) {
            if self.local_change(guid, branch, &prefix).await?.is_some_and(|c| c.kind == "delete") {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Whether `path` lies inside a folder that only exists in the branch (the real folder has nothing there).
    async fn local_inside_new_folder(&self, guid: &str, branch: i64, path: &str) -> Result<bool, String> {
        for prefix in prefixes(path) {
            if self.local_change(guid, branch, &prefix).await?.is_some_and(|c| c.kind == "mkdir" && c.base_exists == 0) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Whether the branch has its own copy of the file at `path` (written there, or checked out).
    pub async fn local_changed_in_branch(&self, guid: &str, branch: i64, path: &str) -> Result<bool, String> {
        Ok(self.local_change(guid, branch, path).await?.is_some_and(|c| c.kind == "put"))
    }

    // ── Reading through a branch ─────────────────────────────────────────────

    /// A folder as the branch sees it: the real one with the branch's changes on top.
    pub async fn local_list(&self, base: &Base<'_>, guid: &str, branch: i64, path: &str) -> Result<Listing, String> {
        let path = norm_path(path)?;
        self.local_branch_exists(guid, branch).await?;
        if self.local_deleted_in_branch(guid, branch, &path).await? {
            return Err(format!("\"{path}\" was deleted in this branch."));
        }
        let made_here = self.local_change(guid, branch, &path).await?.is_some_and(|c| c.kind == "mkdir" && c.base_exists == 0);
        let mut entries: Vec<CacheEntry> = if made_here || self.local_inside_new_folder(guid, branch, &path).await? {
            Vec::new()
        } else {
            base.list(&path)?
                .into_iter()
                .map(|e| CacheEntry { id: None, name: e.name, is_directory: e.is_directory, size: e.size, mtime_ms: e.mtime_ms, cached: false, locked: false, changed: None })
                .collect()
        };
        for change in self.local_change_children(guid, branch, &path).await? {
            let name = name_of(&change.path).to_string();
            entries.retain(|e| e.name != name);
            match change.kind.as_str() {
                "delete" => {}
                "mkdir" => entries.push(CacheEntry { id: None, name, is_directory: true, size: None, mtime_ms: Some(change.changed_at as u64), cached: false, locked: false, changed: Some("mkdir".into()) }),
                kind => {
                    let local = self.local_branch_file(guid, branch, &change.path)?;
                    let meta = std::fs::metadata(&local).ok();
                    let size = meta.as_ref().map(|m| m.len());
                    let mtime_ms = meta.as_ref().and_then(|m| millis(m.modified())).or(Some(change.changed_at as u64));
                    entries.push(CacheEntry { id: None, name, is_directory: false, size, mtime_ms, cached: false, locked: false, changed: Some(kind.into()) });
                }
            }
        }
        sort_entries(&mut entries);
        Ok(Listing { entries, fetched_at: self.now(), stale: false })
    }

    /// Where the file, as the branch sees it, is on disk: the branch's own copy if it changed the file, otherwise the real one.
    /// (Never shown to a window.)
    pub async fn local_file(&self, base: &Base<'_>, guid: &str, branch: i64, path: &str) -> Result<PathBuf, String> {
        let path = norm_path(path)?;
        self.local_branch_exists(guid, branch).await?;
        if self.local_deleted_in_branch(guid, branch, &path).await? {
            return Err(format!("\"{path}\" was deleted in this branch."));
        }
        if self.local_change(guid, branch, &path).await?.is_some_and(|c| c.kind == "put" || c.kind == "checkout") {
            return self.local_branch_file(guid, branch, &path);
        }
        if self.local_inside_new_folder(guid, branch, &path).await? {
            return Err(format!("\"{path}\" doesn't exist here."));
        }
        let real = base.real(&path, true)?;
        if real.is_file() { Ok(real) } else { Err(format!("\"{path}\" isn't a file.")) }
    }

    pub async fn local_read(&self, base: &Base<'_>, guid: &str, branch: i64, path: &str) -> Result<Vec<u8>, String> {
        let _guard = self.local_lock(guid).await;
        std::fs::read(self.local_file(base, guid, branch, path).await?).map_err(io)
    }

    // ── Changing through a branch ────────────────────────────────────────────

    /// The folder must exist in the branch's view.
    async fn local_require_folder(&self, base: &Base<'_>, guid: &str, branch: i64, path: &str) -> Result<(), String> {
        self.local_list(base, guid, branch, path).await.map(|_| ()).map_err(|_| format!("The folder \"{path}\" doesn't exist here."))
    }

    /// What the real folder has at `path` now, as (exists, size, mtime) — what a change is based on.
    async fn local_base_of(&self, base: &Base<'_>, guid: &str, branch: i64, path: &str) -> Result<(bool, Option<i64>, Option<i64>), String> {
        if self.local_inside_new_folder(guid, branch, path).await? {
            return Ok((false, None, None));
        }
        Ok(match base.stat(path)? {
            Some(e) => (true, e.size.map(|s| s as i64), e.mtime_ms.map(|m| m as i64)),
            None => (false, None, None),
        })
    }

    /// Records that the branch puts a file at `path` (`kind` `put` or `checkout`) and returns where its content goes.
    async fn local_begin_put(&self, base: &Base<'_>, guid: &str, branch: i64, path: &str, parent: &str, kind: &str) -> Result<PathBuf, String> {
        self.local_branch_exists(guid, branch).await?;
        self.local_require_folder(base, guid, branch, parent).await?;
        if self.local_list(base, guid, branch, parent).await?.entries.iter().any(|e| e.name == name_of(path) && e.is_directory) {
            return Err(format!("\"{path}\" is a folder."));
        }
        let (base_exists, base_size, base_mtime) = match self.local_change(guid, branch, path).await? {
            // Touched before: keep what it was originally based on.
            Some(c) => (c.base_exists, c.base_size, c.base_mtime_ms),
            None => {
                let (exists, size, mtime) = self.local_base_of(base, guid, branch, path).await?;
                (exists as i64, size, mtime)
            }
        };
        sqlx::query(
            "INSERT INTO local_branch_changes (root_guid, branch, path, parent, kind, base_exists, base_size, base_mtime_ms, changed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(root_guid, branch, path) DO UPDATE SET kind = excluded.kind, changed_at = excluded.changed_at",
        )
        .bind(guid)
        .bind(branch)
        .bind(path)
        .bind(parent)
        .bind(kind)
        .bind(base_exists)
        .bind(base_size)
        .bind(base_mtime)
        .bind(self.now())
        .execute(&self.pool)
        .await
        .map_err(sql)?;
        let local = self.local_branch_file(guid, branch, path)?;
        if let Some(dir) = local.parent() {
            std::fs::create_dir_all(dir).map_err(io)?;
        }
        Ok(local)
    }

    pub async fn local_write(&self, base: &Base<'_>, guid: &str, branch: i64, path: &str, bytes: &[u8]) -> Result<(), String> {
        let path = norm_path(path)?;
        let parent = parent_of(&path).ok_or("The root folder can't be written to.")?;
        let _guard = self.local_lock(guid).await;
        let local = self.local_begin_put(base, guid, branch, &path, &parent, "put").await?;
        std::fs::write(local, bytes).map_err(io)
    }

    /// Puts a file that is on this device (a folder the app may use: `from_root`, `source`) into the branch, copied on this side.
    pub async fn local_put_from_file(&self, base: &Base<'_>, guid: &str, branch: i64, path: &str, source: &Path) -> Result<(), String> {
        let path = norm_path(path)?;
        let parent = parent_of(&path).ok_or("The root folder can't be written to.")?;
        let _guard = self.local_lock(guid).await;
        let local = self.local_begin_put(base, guid, branch, &path, &parent, "put").await?;
        std::fs::copy(source, local).map(|_| ()).map_err(io)
    }

    pub async fn local_mkdir(&self, base: &Base<'_>, guid: &str, branch: i64, path: &str) -> Result<(), String> {
        let path = norm_path(path)?;
        if path == "/" {
            return Ok(());
        }
        let _guard = self.local_lock(guid).await;
        self.local_branch_exists(guid, branch).await?;
        // Make each missing level, from the top.
        for prefix in prefixes(&path) {
            let parent = parent_of(&prefix).unwrap_or_else(|| "/".to_string());
            if self.local_change(guid, branch, &prefix).await?.is_some_and(|c| c.kind != "delete") {
                continue;
            }
            let existing = if self.local_change(guid, branch, &prefix).await?.is_some() || self.local_inside_new_folder(guid, branch, &parent).await? {
                None // deleted in the branch (or inside a folder the real one doesn't have): make it anew
            } else {
                base.stat(&prefix)?
            };
            if let Some(e) = &existing {
                if !e.is_directory {
                    return Err(format!("\"{prefix}\" is a file."));
                }
                continue;
            }
            sqlx::query(
                "INSERT INTO local_branch_changes (root_guid, branch, path, parent, kind, base_exists, base_size, base_mtime_ms, changed_at)
                 VALUES (?1, ?2, ?3, ?4, 'mkdir', 0, NULL, NULL, ?5)
                 ON CONFLICT(root_guid, branch, path) DO UPDATE SET kind = 'mkdir', changed_at = excluded.changed_at",
            )
            .bind(guid)
            .bind(branch)
            .bind(&prefix)
            .bind(&parent)
            .bind(self.now())
            .execute(&self.pool)
            .await
            .map_err(sql)?;
            std::fs::create_dir_all(self.local_branch_file(guid, branch, &prefix)?).map_err(io)?;
        }
        Ok(())
    }

    pub async fn local_remove(&self, base: &Base<'_>, guid: &str, branch: i64, path: &str) -> Result<(), String> {
        let path = norm_path(path)?;
        if path == "/" {
            return Err("The root folder can't be deleted.".to_string());
        }
        let _guard = self.local_lock(guid).await;
        self.local_remove_locked(base, guid, branch, &path).await
    }

    async fn local_remove_locked(&self, base: &Base<'_>, guid: &str, branch: i64, path: &str) -> Result<(), String> {
        self.local_branch_exists(guid, branch).await?;
        let parent = parent_of(path).unwrap_or_else(|| "/".to_string());
        let view = self.local_list(base, guid, branch, &parent).await?;
        let shown = view.entries.iter().find(|e| e.name == name_of(path)).ok_or_else(|| format!("\"{path}\" doesn't exist here."))?.clone();

        let own = self.local_change(guid, branch, path).await?;
        let local = self.local_branch_file(guid, branch, path)?;
        let existed_in_base = own.as_ref().map(|c| c.base_exists != 0).unwrap_or(true);

        // Forget the branch's changes at and below `path`, and the files it kept for them.
        let below = format!("{path}/");
        sqlx::query("DELETE FROM local_branch_changes WHERE root_guid = ?1 AND branch = ?2 AND (path = ?3 OR substr(path, 1, ?4) = ?5)")
            .bind(guid)
            .bind(branch)
            .bind(path)
            .bind(below.chars().count() as i64)
            .bind(&below)
            .execute(&self.pool)
            .await
            .map_err(sql)?;
        let _ = std::fs::remove_dir_all(&local).or_else(|_| std::fs::remove_file(&local));

        if existed_in_base {
            let (size, mtime) = match &own {
                Some(c) => (c.base_size, c.base_mtime_ms),
                // (Asked of the file itself: a listing can show a file's time as it was before it was last closed.)
                None => match base.stat(path)? {
                    Some(e) => (e.size.map(|s| s as i64), e.mtime_ms.map(|m| m as i64)),
                    None => (shown.size.map(|s| s as i64), shown.mtime_ms.map(|m| m as i64)),
                },
            };
            sqlx::query(
                "INSERT INTO local_branch_changes (root_guid, branch, path, parent, kind, base_exists, base_size, base_mtime_ms, changed_at)
                 VALUES (?1, ?2, ?3, ?4, 'delete', 1, ?5, ?6, ?7)",
            )
            .bind(guid)
            .bind(branch)
            .bind(path)
            .bind(&parent)
            .bind(size)
            .bind(mtime)
            .bind(self.now())
            .execute(&self.pool)
            .await
            .map_err(sql)?;
        }
        Ok(())
    }

    /// Renames or moves a file inside the branch (folders can't be renamed in a branch — only on the real folder).
    pub async fn local_rename(&self, base: &Base<'_>, guid: &str, branch: i64, from: &str, to: &str) -> Result<(), String> {
        let (from, to) = (norm_path(from)?, norm_path(to)?);
        if from == "/" || to == "/" {
            return Err("The root folder can't be renamed or moved.".to_string());
        }
        if from == to {
            return Ok(());
        }
        if is_within(&to, &from) {
            return Err("A folder can't be moved into itself.".to_string());
        }
        let _guard = self.local_lock(guid).await;
        let from_parent = parent_of(&from).unwrap_or_else(|| "/".to_string());
        let shown = self
            .local_list(base, guid, branch, &from_parent)
            .await?
            .entries
            .into_iter()
            .find(|e| e.name == name_of(&from))
            .ok_or_else(|| format!("\"{from}\" doesn't exist here."))?;
        if shown.is_directory {
            return Err("Folders can't be renamed inside a branch — rename them on the main view instead.".to_string());
        }
        let to_parent = parent_of(&to).unwrap_or_else(|| "/".to_string());
        if self.local_list(base, guid, branch, &to_parent).await?.entries.iter().any(|e| e.name == name_of(&to)) {
            return Err(format!("\"{to}\" already exists."));
        }
        let source = self.local_file(base, guid, branch, &from).await?;
        let local = self.local_begin_put(base, guid, branch, &to, &to_parent, "put").await?;
        std::fs::copy(&source, &local).map_err(io)?;
        self.local_remove_locked(base, guid, branch, &from).await
    }

    // ── Versions: checkouts, and what a change is based on ───────────────────

    /// The version of the file as this branch's view knows it: in a branch that changed or checked it out, the version *that* was
    /// based on; otherwise what the real folder has now.
    pub async fn local_version(&self, base: &Base<'_>, guid: &str, branch: Option<i64>, path: &str) -> Result<FileVersion, String> {
        let path = norm_path(path)?;
        if let Some(branch) = branch {
            self.local_branch_exists(guid, branch).await?;
            if let Some(c) = self.local_change(guid, branch, &path).await?.filter(|c| c.kind != "delete") {
                return Ok(FileVersion { exists: c.base_exists != 0, size: c.base_size.map(|s| s as u64), mtime_ms: c.base_mtime_ms.map(|m| m as u64) });
            }
        }
        Ok(FileVersion::of_base(base.stat(&path)?.as_ref()))
    }

    /// Asks the real folder whether the file is still at `known`.
    pub fn local_check_version(&self, base: &Base<'_>, path: &str, known: &FileVersion) -> Result<VersionCheck, String> {
        let path = norm_path(path)?;
        let current = FileVersion::of_base(base.stat(&path)?.as_ref());
        let problem = match (known.exists, current.exists) {
            (true, false) => Some("it was deleted after you started"),
            (false, true) => Some("it was created after you started"),
            (true, true) if !known.same_as(&current) => Some("it is newer on the device"),
            _ => None,
        };
        Ok(VersionCheck { up_to_date: problem.is_none(), problem: problem.map(str::to_string), current })
    }

    /// Bases the branch's change to the file on what the real folder has now (the person chose to overwrite it).
    pub async fn local_rebase(&self, base: &Base<'_>, guid: &str, branch: i64, path: &str) -> Result<(), String> {
        let path = norm_path(path)?;
        let _guard = self.local_lock(guid).await;
        self.local_branch_exists(guid, branch).await?;
        self.local_change(guid, branch, &path).await?.filter(|c| c.kind != "delete").ok_or("The branch has no change to that file.")?;
        let now = FileVersion::of_base(base.stat(&path)?.as_ref());
        sqlx::query("UPDATE local_branch_changes SET base_exists = ?4, base_size = ?5, base_mtime_ms = ?6 WHERE root_guid = ?1 AND branch = ?2 AND path = ?3")
            .bind(guid)
            .bind(branch)
            .bind(&path)
            .bind(now.exists as i64)
            .bind(now.size.map(|s| s as i64))
            .bind(now.mtime_ms.map(|m| m as i64))
            .execute(&self.pool)
            .await
            .map_err(sql)?;
        Ok(())
    }

    /// Takes the file into the branch without changing it: copied in and recorded as a `checkout` based on the version that was
    /// copied, so it is among the pending changes and its version is verified when the branch is committed.
    pub async fn local_checkout(&self, base: &Base<'_>, guid: &str, branch: i64, path: &str) -> Result<(), String> {
        let path = norm_path(path)?;
        let parent = parent_of(&path).ok_or("The root folder can't be checked out.")?;
        let _guard = self.local_lock(guid).await;
        self.local_branch_exists(guid, branch).await?;
        if self.local_deleted_in_branch(guid, branch, &path).await? {
            return Err(format!("\"{path}\" was deleted in this branch."));
        }
        match self.local_change(guid, branch, &path).await? {
            Some(c) if c.kind == "put" || c.kind == "checkout" => return Ok(()),
            Some(_) => return Err(format!("\"{path}\" isn't a file.")),
            None => {}
        }
        let source = self.local_file(base, guid, branch, &path).await?;
        let local = self.local_begin_put(base, guid, branch, &path, &parent, "checkout").await?;
        if let Err(e) = std::fs::copy(&source, &local) {
            sqlx::query("DELETE FROM local_branch_changes WHERE root_guid = ?1 AND branch = ?2 AND path = ?3").bind(guid).bind(branch).bind(&path).execute(&self.pool).await.map_err(sql)?;
            return Err(io(e));
        }
        Ok(())
    }

    /// Lets go of a checkout that was never changed.
    pub async fn local_release(&self, guid: &str, branch: i64, path: &str) -> Result<(), String> {
        let path = norm_path(path)?;
        let _guard = self.local_lock(guid).await;
        self.local_branch_exists(guid, branch).await?;
        let change = self.local_change(guid, branch, &path).await?.ok_or("That file isn't checked out in this branch.")?;
        if change.kind != "checkout" {
            return Err("That file has changes in this branch; it can't be let go without losing them.".to_string());
        }
        let local = self.local_branch_file(guid, branch, &path)?;
        sqlx::query("DELETE FROM local_branch_changes WHERE root_guid = ?1 AND branch = ?2 AND path = ?3").bind(guid).bind(branch).bind(&path).execute(&self.pool).await.map_err(sql)?;
        let _ = std::fs::remove_file(local);
        Ok(())
    }

    // ── Commit ───────────────────────────────────────────────────────────────

    /// Applies the branch's changes to the real folder and deletes the branch. If the folder changed since the branch touched
    /// something, nothing is applied and the conflicts are reported — unless `force`.
    pub async fn local_commit(&self, base: &Base<'_>, guid: &str, branch: i64, force: bool) -> Result<CommitReport, String> {
        let _guard = self.local_lock(guid).await;
        self.local_branch_exists(guid, branch).await?;
        let name = self.local_branch_name(guid, branch).await?;
        let mut changes = self.local_changes(guid, branch).await?;
        let depth = |c: &LocalChange| c.path.matches('/').count();

        let mut conflicts = Vec::new();
        for change in &changes {
            let now_entry = base.stat(&change.path).unwrap_or(None);
            let same_as_base = |e: &BaseEntry| e.size.map(|s| s as i64) == change.base_size && e.mtime_ms.map(|m| m as i64) == change.base_mtime_ms;
            let problem = match (change.kind.as_str(), change.base_exists != 0, now_entry.as_ref()) {
                ("mkdir", _, Some(e)) if !e.is_directory => Some("a file with that name exists on the device now"),
                ("checkout", _, None) => Some("it was deleted on the device after it was checked out"),
                ("checkout", _, Some(e)) if !same_as_base(e) => Some("it changed on the device after it was checked out"),
                ("put", false, Some(_)) => Some("it was created on the device after the branch was"),
                ("put", true, None) => Some("it was deleted on the device after the branch changed it"),
                ("put", true, Some(e)) if !same_as_base(e) => Some("it changed on the device after the branch did"),
                // (A folder's own time moves with what is inside it, and a listing and a look at it can disagree: only files are compared.)
                ("delete", true, Some(e)) if !e.is_directory && !same_as_base(e) => Some("it changed on the device after the branch deleted it"),
                _ => None,
            };
            if let Some(problem) = problem {
                conflicts.push(format!("{}: {problem}", change.path));
            }
        }
        if !conflicts.is_empty() && !force {
            return Ok(CommitReport { committed: false, applied: 0, conflicts });
        }

        // A checkout changes nothing. Folders first (top down), then files, then deletions (bottom up).
        changes.retain(|c| c.kind != "checkout");
        changes.sort_by_key(|c| (match c.kind.as_str() { "mkdir" => 0, "put" => 1, _ => 2 }, if c.kind == "delete" { -(depth(c) as i64) } else { depth(c) as i64 }));
        let mut applied = 0;
        for change in &changes {
            match change.kind.as_str() {
                "mkdir" => std::fs::create_dir_all(base.real(&change.path, true)?).map_err(io)?,
                "put" => {
                    let target = base.real(&change.path, true)?;
                    if let Some(dir) = target.parent() {
                        std::fs::create_dir_all(dir).map_err(io)?;
                    }
                    let local = self.local_branch_file(guid, branch, &change.path)?;
                    std::fs::copy(&local, &target).map_err(io)?;
                }
                _ => {
                    let target = base.real(&change.path, false)?;
                    match std::fs::symlink_metadata(&target) {
                        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(&target).map_err(io)?,
                        Ok(_) => std::fs::remove_file(&target).map_err(io)?,
                        Err(_) => {} // already gone
                    }
                }
            }
            applied += 1;
        }
        self.delete_local_branch(guid, branch, &name).await?;
        Ok(CommitReport { committed: true, applied, conflicts })
    }

    // ── Thumbnails ───────────────────────────────────────────────────────────

    /// The folder that holds the thumbnails of the root's own files, or of one of its branches' changed files (`files/t/NNN` and
    /// `files/tb/NNN/MMM`).
    async fn local_thumb_root(&self, guid: &str, branch: Option<i64>, make: bool) -> Result<Option<PathBuf>, String> {
        let Some(root) = self.root_dir(guid, make)? else { return Ok(None) };
        let parent = root.join(if branch.is_some() { crate::layout::FILES_BRANCH_THUMBNAILS_FOLDER } else { crate::layout::FILES_THUMBNAILS_FOLDER });
        if make {
            std::fs::create_dir_all(&parent).map_err(io)?;
        } else if !parent.is_dir() {
            return Ok(None);
        }
        let Some(branch) = branch else { return Ok(Some(parent)) };
        self.local_branch_exists(guid, branch).await?;
        let short = parent.join(NUMBERING.short_name(branch as u32));
        if make {
            let name = self.local_branch_name(guid, branch).await?;
            let marker = parent.join(NUMBERING.full_name(branch as u32, &name));
            std::fs::create_dir_all(&short).map_err(io)?;
            std::fs::create_dir_all(&marker).map_err(io)?;
            let keep = marker.join(folder_pairs::keep_file());
            if !keep.exists() {
                std::fs::write(keep, folder_pairs::keep_content()).map_err(io)?;
            }
        }
        Ok(short.is_dir().then_some(short))
    }

    /// The thumbnail (a JPEG) made for this version of `path` — none when there isn't one. In a branch, a file the branch has not
    /// changed is looked for among the root's own.
    pub async fn local_thumb_get(&self, guid: &str, branch: Option<i64>, path: &str, mtime_ms: u64, size: u64) -> Result<Option<Vec<u8>>, String> {
        let path = norm_path(path)?;
        let place = match branch {
            Some(b) if self.local_changed_in_branch(guid, b, &path).await? => Some(b),
            _ => None,
        };
        if let Some(root) = self.local_thumb_root(guid, place, false).await? {
            if let Ok(bytes) = std::fs::read(thumb_file(&root, &path, mtime_ms, size)) {
                return Ok(Some(bytes));
            }
        }
        Ok(None)
    }

    pub async fn local_thumb_put(&self, guid: &str, branch: Option<i64>, path: &str, mtime_ms: u64, size: u64, bytes: &[u8]) -> Result<(), String> {
        let path = norm_path(path)?;
        let place = match branch {
            Some(b) if self.local_changed_in_branch(guid, b, &path).await? => Some(b),
            _ => None,
        };
        let Some(root) = self.local_thumb_root(guid, place, true).await? else { return Ok(()) };
        let target = thumb_file(&root, &path, mtime_ms, size);
        if let Some(folder) = target.parent() {
            std::fs::create_dir_all(folder).map_err(io)?;
            remove_older_thumbs(folder, &thumb_prefix(&path), target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
        }
        std::fs::write(target, bytes).map_err(io)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::sync::Arc;

    struct Setup {
        dir: PathBuf,
        cache: Cache,
        scope: FsScope,
        real: PathBuf,
    }

    impl Drop for Setup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn run<F: Future<Output = ()>>(future: F) {
        tauri::async_runtime::block_on(future)
    }

    async fn setup(name: &str) -> Setup {
        let dir = std::env::temp_dir().join(format!("csdrive-local-branches-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let files = dir.join("files");
        let real = dir.join("real");
        std::fs::create_dir_all(real.join("docs")).unwrap();
        std::fs::write(real.join("a.txt"), "alpha").unwrap();
        std::fs::write(real.join("docs/b.md"), "beta").unwrap();
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        let cache = Cache::with_pool(pool, files, Arc::new(|| 1_000)).await.unwrap();
        let scope = FsScope::new();
        scope.allow_fixed_as("r", &real);
        let real = crate::fs_scope::resolve(&real, true).unwrap();
        Setup { dir, cache, scope, real }
    }

    const G: &str = "11111111-2222-3333-4444-555555555555";

    fn base(s: &Setup) -> Base<'_> {
        Base { scope: &s.scope, root: "r" }
    }

    fn names(listing: &Listing) -> Vec<String> {
        listing.entries.iter().map(|e| e.name.clone()).collect()
    }

    #[test]
    fn a_branch_shows_the_folder_with_its_changes_on_top() {
        run(async {
        let s = setup("a_branch_shows_the_f").await;
        let b = s.cache.local_create_branch(G, "work").await.unwrap().index;
        assert_eq!(names(&s.cache.local_list(&base(&s), G, b, "/").await.unwrap()), ["docs", "a.txt"]);
        s.cache.local_write(&base(&s), G, b, "/a.txt", b"changed").await.unwrap();
        s.cache.local_write(&base(&s), G, b, "/new.txt", b"new").await.unwrap();
        s.cache.local_mkdir(&base(&s), G, b, "/made/deeper").await.unwrap();
        s.cache.local_remove(&base(&s), G, b, "/docs").await.unwrap();
        let root = s.cache.local_list(&base(&s), G, b, "/").await.unwrap();
        assert_eq!(names(&root), ["made", "a.txt", "new.txt"]);
        assert_eq!(root.entries.iter().find(|e| e.name == "a.txt").unwrap().changed.as_deref(), Some("put"));
        assert_eq!(s.cache.local_read(&base(&s), G, b, "/a.txt").await.unwrap(), b"changed");
        // The real folder is untouched.
        assert_eq!(std::fs::read_to_string(s.real.join("a.txt")).unwrap(), "alpha");
        assert!(s.real.join("docs/b.md").exists() && !s.real.join("new.txt").exists());
        assert!(s.cache.local_read(&base(&s), G, b, "/docs/b.md").await.is_err(), "deleted in the branch");
        assert_eq!(names(&s.cache.local_list(&base(&s), G, b, "/made").await.unwrap()), ["deeper"]);
        });
    }

    #[test]
    fn the_changed_files_are_kept_in_the_branchs_own_folder() {
        run(async {
        let s = setup("the_changed_files_ar").await;
        let b = s.cache.local_create_branch(G, "work").await.unwrap().index;
        s.cache.local_write(&base(&s), G, b, "/docs/c.md", b"gamma").await.unwrap();
        let root = NUMBERING.find(&s.cache.a_dir(), &root_part(G)).unwrap().unwrap();
        assert!(root.short_dir.join("b").join("001").join("docs").join("c.md").is_file(), "{:?}", root.short_dir);
        assert!(s.cache.a_dir().read_dir().unwrap().any(|e| e.unwrap().file_name().to_string_lossy() == format!("001-{}", root_part(G))), "the root's pair is in a, beside the accounts'");
        assert!(root.short_dir.join("b").join("001-work").is_dir(), "and the branch's pair inside it");
        });
    }

    #[test]
    fn commit_applies_the_changes_and_removes_the_branch() {
        run(async {
        let s = setup("commit_applies_the_c").await;
        let b = s.cache.local_create_branch(G, "work").await.unwrap().index;
        s.cache.local_write(&base(&s), G, b, "/a.txt", b"changed").await.unwrap();
        s.cache.local_mkdir(&base(&s), G, b, "/made").await.unwrap();
        s.cache.local_write(&base(&s), G, b, "/made/n.txt", b"n").await.unwrap();
        s.cache.local_remove(&base(&s), G, b, "/docs").await.unwrap();
        let report = s.cache.local_commit(&base(&s), G, b, false).await.unwrap();
        assert!(report.committed && report.conflicts.is_empty(), "{report:?}");
        assert_eq!(std::fs::read_to_string(s.real.join("a.txt")).unwrap(), "changed");
        assert_eq!(std::fs::read_to_string(s.real.join("made/n.txt")).unwrap(), "n");
        assert!(!s.real.join("docs").exists());
        assert!(s.cache.local_branches(G).await.unwrap().is_empty());
        assert!(NUMBERING.find(&s.cache.a_dir(), &root_part(G)).unwrap().is_none(), "the root's pair goes with its last branch, when nothing else is kept in it");
        });
    }

    #[test]
    fn a_commit_notices_that_the_folder_changed_underneath() {
        run(async {
        let s = setup("a_commit_notices_tha").await;
        let b = s.cache.local_create_branch(G, "work").await.unwrap().index;
        s.cache.local_write(&base(&s), G, b, "/a.txt", b"mine").await.unwrap();
        std::fs::write(s.real.join("a.txt"), "someone else's, and longer").unwrap();
        let report = s.cache.local_commit(&base(&s), G, b, false).await.unwrap();
        assert!(!report.committed && report.conflicts.len() == 1 && report.conflicts[0].starts_with("/a.txt"), "{report:?}");
        assert_eq!(std::fs::read_to_string(s.real.join("a.txt")).unwrap(), "someone else's, and longer");
        assert!(s.cache.local_commit(&base(&s), G, b, true).await.unwrap().committed);
        assert_eq!(std::fs::read_to_string(s.real.join("a.txt")).unwrap(), "mine");
        });
    }

    #[test]
    fn checkouts_are_verified_and_released() {
        run(async {
        let s = setup("checkouts_are_verifi").await;
        let b = s.cache.local_create_branch(G, "work").await.unwrap().index;
        s.cache.local_checkout(&base(&s), G, b, "/a.txt").await.unwrap();
        assert_eq!(s.cache.local_branch_changes(G, b).await.unwrap()[0].kind, "checkout");
        assert_eq!(s.cache.local_read(&base(&s), G, b, "/a.txt").await.unwrap(), b"alpha");
        s.cache.local_release(G, b, "/a.txt").await.unwrap();
        assert!(s.cache.local_branch_changes(G, b).await.unwrap().is_empty());
        s.cache.local_checkout(&base(&s), G, b, "/a.txt").await.unwrap();
        std::fs::write(s.real.join("a.txt"), "changed elsewhere").unwrap();
        assert!(!s.cache.local_commit(&base(&s), G, b, false).await.unwrap().committed);
        });
    }

    #[test]
    fn versions_follow_what_the_branch_was_based_on() {
        run(async {
        let s = setup("versions_follow_what").await;
        let b = s.cache.local_create_branch(G, "work").await.unwrap().index;
        let before = s.cache.local_version(&base(&s), G, Some(b), "/a.txt").await.unwrap();
        assert!(before.exists && before.size == Some(5));
        s.cache.local_write(&base(&s), G, b, "/a.txt", b"longer text").await.unwrap();
        assert_eq!(s.cache.local_version(&base(&s), G, Some(b), "/a.txt").await.unwrap(), before, "the change's base, not its own content");
        assert!(s.cache.local_check_version(&base(&s), "/a.txt", &before).unwrap().up_to_date);
        std::fs::write(s.real.join("a.txt"), "twelve chars").unwrap();
        let check = s.cache.local_check_version(&base(&s), "/a.txt", &before).unwrap();
        assert!(!check.up_to_date && check.problem.is_some());
        s.cache.local_rebase(&base(&s), G, b, "/a.txt").await.unwrap();
        assert!(s.cache.local_commit(&base(&s), G, b, false).await.unwrap().committed, "rebased: no conflict any more");
        });
    }

    #[test]
    fn renames_move_files_only() {
        run(async {
        let s = setup("renames_move_files_o").await;
        let b = s.cache.local_create_branch(G, "work").await.unwrap().index;
        s.cache.local_rename(&base(&s), G, b, "/a.txt", "/z.txt").await.unwrap();
        assert_eq!(names(&s.cache.local_list(&base(&s), G, b, "/").await.unwrap()), ["docs", "z.txt"]);
        assert!(s.cache.local_rename(&base(&s), G, b, "/docs", "/other").await.is_err());
        assert!(s.cache.local_commit(&base(&s), G, b, false).await.unwrap().committed);
        assert!(!s.real.join("a.txt").exists());
        assert_eq!(std::fs::read_to_string(s.real.join("z.txt")).unwrap(), "alpha");
        });
    }

    #[test]
    fn discarding_leaves_the_folder_alone_and_frees_the_folders() {
        run(async {
        let s = setup("discarding_leaves_th").await;
        let b = s.cache.local_create_branch(G, "work").await.unwrap().index;
        s.cache.local_write(&base(&s), G, b, "/a.txt", b"x").await.unwrap();
        s.cache.local_discard_branch(G, b).await.unwrap();
        assert_eq!(std::fs::read_to_string(s.real.join("a.txt")).unwrap(), "alpha");
        assert!(s.cache.local_branches(G).await.unwrap().is_empty());
        assert!(s.cache.local_list(&base(&s), G, b, "/").await.is_err());
        assert!(s.cache.local_create_branch(G, "again").await.is_ok(), "the index is free again");
        });
    }

    #[test]
    fn names_and_paths_are_checked() {
        run(async {
        let s = setup("names_and_paths_are_").await;
        s.cache.local_create_branch(G, "work").await.unwrap();
        assert!(s.cache.local_create_branch(G, "WORK").await.is_err(), "a branch name is used once");
        assert!(s.cache.local_create_branch(G, "a/b").await.is_err());
        let b = 1;
        assert!(s.cache.local_write(&base(&s), G, b, "/../escape.txt", b"x").await.is_err());
        assert!(s.cache.local_write(&base(&s), G, b, "/nowhere/x.txt", b"x").await.is_err(), "the folder has to exist");
        assert!(s.cache.local_write(&base(&s), G, b, "/docs", b"x").await.is_err(), "a folder can't be written as a file");
        });
    }

    #[test]
    fn thumbnails_of_a_branch_are_kept_apart_and_go_with_it() {
        run(async {
        let s = setup("thumbnails_of_a_bran").await;
        let b = s.cache.local_create_branch(G, "work").await.unwrap().index;
        s.cache.local_thumb_put(G, None, "/a.txt", 5, 5, b"root-thumb").await.unwrap();
        assert_eq!(s.cache.local_thumb_get(G, Some(b), "/a.txt", 5, 5).await.unwrap().as_deref(), Some(&b"root-thumb"[..]), "unchanged: the root's own");
        s.cache.local_write(&base(&s), G, b, "/a.txt", b"changed").await.unwrap();
        assert!(s.cache.local_thumb_get(G, Some(b), "/a.txt", 5, 5).await.unwrap().is_none(), "changed: none until made");
        s.cache.local_thumb_put(G, Some(b), "/a.txt", 9, 7, b"branch-thumb").await.unwrap();
        assert_eq!(s.cache.local_thumb_get(G, Some(b), "/a.txt", 9, 7).await.unwrap().as_deref(), Some(&b"branch-thumb"[..]));
        let root = NUMBERING.find(&s.cache.a_dir(), &root_part(G)).unwrap().unwrap().short_dir;
        assert!(root.join("tb").join("001").is_dir() && root.join("t").is_dir());
        s.cache.local_discard_branch(G, b).await.unwrap();
        assert!(!root.join("tb").exists(), "the branch's thumbnails go with it");
        assert!(s.cache.local_thumb_get(G, None, "/a.txt", 5, 5).await.unwrap().is_some(), "the root's stay");
        s.cache.local_drop_thumbnails(G);
        assert!(s.cache.local_thumb_get(G, None, "/a.txt", 5, 5).await.unwrap().is_none());
        });
    }
}
