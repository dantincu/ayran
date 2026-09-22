//! The Notes app's cache of Filen accounts, and their **branches** — see `CLAUDE.md`, "Notes and the
//! Filen cache", and `docs/strategies/folder-pairs-strategy.md`.
//!
//! Everything lives in the `files` folder (a sibling of `admin` and `user`; `layout::FILES_FOLDER`):
//!
//! ```text
//! files/data.db                    directory listings, file/folder metadata, settings, branch changes
//! files/a/NNN/c/…                  cached *contents* of account NNN, at the same paths as in Filen
//! files/a/NNN-filen@@email@@id/    (empty: says whose NNN is)
//! files/b/NNN/MMM/…                what branch MMM of account NNN has changed
//! files/b/NNN/MMM-<branch name>/   (empty: says which branch MMM is)
//! ```
//!
//! **It is a cache, not a sync.** Nothing is fetched until it is asked for: listing a folder fetches
//! (and remembers) that folder's listing; opening or exporting a file fetches (and remembers) its
//! content. Everything remembered expires after the account's **cache interval** (`ttl_secs`) —
//! listings, metadata and contents alike — and is then fetched again. With no interval (`NULL`) it
//! *never* expires, which is how a person makes things available offline. When Filen can't be
//! reached, an expired listing or file is still served, marked stale, rather than failing.
//!
//! **Writes to the account itself go straight to Filen** (and update the cache). A **branch** is
//! the alternative, like a git branch: a set of local changes — files written, folders made, things
//! deleted — kept in the branch's own folder and `branch_changes` until it is *committed* (the changes
//! are applied to Filen and the branch is deleted) or *discarded* (the branch is just deleted).
//! Reading through a branch shows Filen's state (cached) with the branch's changes on top. A commit
//! first checks that Filen still looks as it did when each change was made, and reports conflicts
//! instead of overwriting unless told to.
//!
//! Two more things sit on top. A file can be **locked against caching**: its cached copy (and what the
//! cache knows about it) is then never refreshed, dropped or expired — not by the interval, not by a
//! newer listing, not by clearing the cache — until it is unlocked; the lock belongs to the account's
//! file, so a branch that reads it through sees the same frozen copy. And a branch can **check out** a
//! file without changing it: the file's current content is copied into the branch and recorded, as a
//! change of kind `checkout`, based on the version that was checked out — so it shows in the branch's
//! pending changes and its version is verified at commit time like every other change's.
//!
//! Whoever works on a file remembers its **version** (`FileVersion`: exists, size, modification time —
//! what Filen's listing offers) and, before saving over it, asks Filen itself (`check_version`, which
//! never goes through the cache) whether it is still the same.
//!
//! Filen is reached through the `Remote` trait, so all of this is tested without a network.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use tokio::sync::Mutex;

use crate::folder_pairs;

/// The default cache interval: one hour.
pub const DEFAULT_TTL_SECS: i64 = 3600;
fn provider() -> &'static str {
    &crate::config::get().folder_pairs.account_provider
}
/// Inside an account's short folder, beside the cached contents: where uploads are assembled and
/// downloads' partial files never go (those sit next to their target, with a .part ending).
const UPLOADS_FOLDER: &str = "tmp";
/// The size of the pieces a file is read from disk in when it is uploaded.
const READ_PIECE: usize = 1_048_576;
/// Accounts' and branches' folder pairs take the lowest free index, so deleting one (disconnecting an
/// account, committing or discarding a branch) leaves no permanent gap in the numbering.
static NUMBERING: &std::sync::LazyLock<folder_pairs::Numbering> = &crate::config::DEFAULT_NUMBERING;
/// Local file names are cut to this many characters (the pair strategy keeps the folders above short).
const MAX_LOCAL_NAME: usize = 120;

// ── The remote ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct RemoteEntry {
    /// The storage's own id for it, when it has one (Filen's uuid).
    pub id: Option<String>,
    pub name: String,
    pub is_directory: bool,
    pub size: Option<u64>,
    pub mtime_ms: Option<u64>,
}

/// What the cache needs from the storage it caches.
pub trait Remote: Send + Sync {
    fn readdir(&self, path: &str) -> impl Future<Output = Result<Vec<RemoteEntry>, String>> + Send;
    /// A file being uploaded a piece at a time (see begin_upload).
    type Upload: Send;
    /// Streams the file's content to sink, a chunk at a time — the whole file is never held.
    fn download(&self, path: &str, sink: &mut (dyn FnMut(&[u8]) -> Result<(), String> + Send)) -> impl Future<Output = Result<(), String>> + Send;
    /// Starts uploading to path (creating the file, or replacing it): nothing exists until finish_upload.
    fn begin_upload(&self, path: &str) -> impl Future<Output = Result<Self::Upload, String>> + Send;
    fn upload_bytes(&self, upload: &mut Self::Upload, bytes: &[u8]) -> impl Future<Output = Result<(), String>> + Send;
    fn finish_upload(&self, upload: Self::Upload) -> impl Future<Output = Result<(), String>> + Send;
    fn mkdir(&self, path: &str) -> impl Future<Output = Result<(), String>> + Send;
    fn remove(&self, path: &str) -> impl Future<Output = Result<(), String>> + Send;
    fn rename(&self, from: &str, to: &str) -> impl Future<Output = Result<(), String>> + Send;
}

/// A Filen account, as a `Remote`.
pub struct FilenRemote(pub crate::filen::Session);

impl Remote for FilenRemote {
    type Upload = crate::filen::ops::UploadSession;

    async fn readdir(&self, path: &str) -> Result<Vec<RemoteEntry>, String> {
        Ok(crate::filen::ops::readdir(&self.0, path)
            .await?
            .into_iter()
            .map(|e| RemoteEntry { id: Some(e.id), name: e.name, is_directory: e.is_directory, size: e.size, mtime_ms: e.mtime_ms })
            .collect())
    }
    async fn download(&self, path: &str, sink: &mut (dyn FnMut(&[u8]) -> Result<(), String> + Send)) -> Result<(), String> {
        crate::filen::ops::read_file_chunks(&self.0, path, sink).await
    }
    async fn begin_upload(&self, path: &str) -> Result<Self::Upload, String> {
        crate::filen::ops::begin_upload(&self.0, path).await
    }
    async fn upload_bytes(&self, upload: &mut Self::Upload, bytes: &[u8]) -> Result<(), String> {
        crate::filen::ops::upload_bytes(&self.0, upload, bytes).await
    }
    async fn finish_upload(&self, upload: Self::Upload) -> Result<(), String> {
        crate::filen::ops::finish_upload(&self.0, upload).await
    }
    async fn mkdir(&self, path: &str) -> Result<(), String> {
        crate::filen::ops::mkdir(&self.0, path).await
    }
    async fn remove(&self, path: &str) -> Result<(), String> {
        crate::filen::ops::remove(&self.0, path).await
    }
    async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        crate::filen::ops::rename(&self.0, from, to).await
    }
}

// ── What the frontend sees ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CacheEntry {
    /// Filen's id for it (its uuid) — none for something that only exists in a branch so far.
    pub id: Option<String>,
    pub name: String,
    pub is_directory: bool,
    pub size: Option<u64>,
    pub mtime_ms: Option<u64>,
    /// The file's content is in the cache (so opening it needs no network).
    pub cached: bool,
    /// The file is locked against caching: its cached copy is never refreshed or dropped.
    pub locked: bool,
    /// In a branch: `"put"` (written in the branch), `"mkdir"` (made in the branch) or `"checkout"`
    /// (checked out, not changed).
    pub changed: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub entries: Vec<CacheEntry>,
    /// When the listing was fetched from Filen (ms since 1970).
    pub fetched_at: i64,
    /// It has expired but Filen couldn't be reached, so it's shown as it was.
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountCacheInfo {
    pub user_id: i64,
    pub email: String,
    /// `None`: never expires (available offline).
    pub ttl_secs: Option<i64>,
    /// The account's short folder in `files/a` (`001`).
    pub folder: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// The branch's short folder index (`1` for `001`) — how commands name it.
    pub index: i64,
    pub name: String,
    pub created_at: i64,
    pub changes: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchChange {
    pub path: String,
    /// `put`, `mkdir`, `delete` or `checkout` (a file taken into the branch without being changed).
    pub kind: String,
    pub is_new: bool,
}

/// Which version of a file someone has been working on: whether it existed, and its size and
/// modification time — all Filen's listing says, and enough to tell that it has changed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileVersion {
    pub exists: bool,
    pub size: Option<u64>,
    pub mtime_ms: Option<u64>,
}

impl FileVersion {
    fn missing() -> Self {
        Self { exists: false, size: None, mtime_ms: None }
    }

    fn of(entry: Option<&RemoteEntry>) -> Self {
        match entry {
            Some(e) if !e.is_directory => Self { exists: true, size: e.size, mtime_ms: e.mtime_ms },
            _ => Self::missing(),
        }
    }

    /// The same version (a file that doesn't exist is the same as another that doesn't).
    fn same_as(&self, other: &FileVersion) -> bool {
        self.exists == other.exists && (!self.exists || (self.size == other.size && self.mtime_ms == other.mtime_ms))
    }
}

/// What asking Filen about a file found.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VersionCheck {
    /// Filen has the very version that was being worked on.
    pub up_to_date: bool,
    /// When it isn't: what happened to it, in words.
    pub problem: Option<String>,
    /// How Filen has the file now.
    pub current: FileVersion,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitReport {
    pub committed: bool,
    pub applied: usize,
    /// Why nothing was applied: Filen has changed since the branch touched these.
    pub conflicts: Vec<String>,
}

// ── Paths and names ───────────────────────────────────────────────────────────

/// A Filen path in its one canonical form: `/` for the root, otherwise a leading slash, single
/// slashes, no trailing one, and no `.`/`..`.
pub fn norm_path(path: &str) -> Result<String, String> {
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" => {}
            "." | ".." => return Err("Paths can't contain \".\" or \"..\".".to_string()),
            p if p.contains('\0') => return Err("That isn't a usable path.".to_string()),
            p => parts.push(p),
        }
    }
    Ok(if parts.is_empty() { "/".to_string() } else { format!("/{}", parts.join("/")) })
}

fn parent_of(path: &str) -> Option<String> {
    if path == "/" {
        return None;
    }
    let cut = path.rfind('/')?;
    Some(if cut == 0 { "/".to_string() } else { path[..cut].to_string() })
}

fn name_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or("")
}

fn join_path(parent: &str, name: &str) -> String {
    if parent == "/" { format!("/{name}") } else { format!("{parent}/{name}") }
}

/// `/a/b/c` → `["/a", "/a/b", "/a/b/c"]`.
fn prefixes(path: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for part in path.split('/').filter(|p| !p.is_empty()) {
        current = format!("{current}/{part}");
        out.push(current.clone());
    }
    out
}

/// Whether `path` is `ancestor` or something inside it.
fn is_within(path: &str, ancestor: &str) -> bool {
    ancestor == "/" || path == ancestor || path.starts_with(&format!("{ancestor}/"))
}

/// A name safe to use on every file system (see `folder_pairs::sanitize_part`), for the mirror.
fn mirror_name(name: &str) -> String {
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4",
        "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let mut cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { c })
        .take(MAX_LOCAL_NAME)
        .collect();
    cleaned = cleaned.trim_end_matches(['.', ' ']).to_string();
    if cleaned.is_empty() {
        cleaned = "_".to_string();
    }
    if RESERVED.contains(&cleaned.split('.').next().unwrap_or("").to_ascii_uppercase().as_str()) {
        cleaned.insert(0, '_');
    }
    cleaned
}

/// FNV-1a: a small stable hash, to tell apart names that collide once made safe.
fn hash_of(text: &str) -> u32 {
    text.bytes().fold(0x811c_9dc5, |h, b| (h ^ b as u32).wrapping_mul(0x0100_0193))
}

/// The local name for `name` among siblings whose local names (lower-cased, since Windows and macOS
/// ignore case) are `taken`: its safe form — or, if that's taken, with a short hash of the real name.
fn allocate_local_name(name: &str, taken: &HashSet<String>) -> String {
    let base = mirror_name(name);
    if !taken.contains(&base.to_lowercase()) {
        return base;
    }
    let suffix = format!("~{:06x}", hash_of(name) & 0xff_ffff);
    let stem: String = base.chars().take(MAX_LOCAL_NAME - suffix.len() - 4).collect();
    let mut candidate = format!("{stem}{suffix}");
    let mut n = 2;
    while taken.contains(&candidate.to_lowercase()) {
        candidate = format!("{stem}{suffix}-{n}");
        n += 1;
    }
    candidate
}

/// The start of the name of the thumbnail file of `path` (what every version of it shares): its name made safe, and a dot.
fn thumb_prefix(path: &str) -> String {
    format!("{}.", mirror_name(name_of(path)))
}

/// The thumbnail file of the version (`mtime_ms`, `size`) of `path` under `root`: laid out like the files themselves, named
/// `<name>.<modified>-<size>.jpg`, so a changed file simply has no thumbnail until one is made for its new version.
fn thumb_file(root: &Path, path: &str, mtime_ms: u64, size: u64) -> PathBuf {
    let mut file = root.to_path_buf();
    let names: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    for folder in names.iter().take(names.len().saturating_sub(1)) {
        file.push(mirror_name(folder));
    }
    file.push(format!("{}{mtime_ms}-{size}.jpg", thumb_prefix(path)));
    file
}

/// Whether `name` is a thumbnail of the file whose thumbnails start with `prefix` (`<name>.`): what follows is exactly
/// `<digits>-<digits>.jpg`, so a file called `a.b` doesn't lose its thumbnails to one called `a`.
fn is_thumb_of(name: &str, prefix: &str) -> bool {
    let Some(rest) = name.strip_prefix(prefix).and_then(|r| r.strip_suffix(".jpg")) else { return false };
    matches!(rest.split_once('-'), Some((m, s)) if !m.is_empty() && !s.is_empty() && m.bytes().all(|b| b.is_ascii_digit()) && s.bytes().all(|b| b.is_ascii_digit()))
}

fn remove_older_thumbs(folder: &Path, prefix: &str, keep: String) {
    if let Ok(entries) = std::fs::read_dir(folder) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name != keep && is_thumb_of(&name, prefix) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// `filen@@<email>@@<account id>` — the account's full-folder-name part (see the pairs strategy).
pub fn account_part(email: &str, user_id: i64) -> String {
    let tail = format!("@@{user_id}");
    let room = folder_pairs::max_name_part_chars().saturating_sub(provider().len() + 2 + tail.len());
    let email: String = folder_pairs::sanitize_part(email).chars().take(room).collect();
    format!("{}@@{}{tail}", provider(), email.trim_end_matches(['.', ' ']))
}

fn is_account_part_for(part: &str, user_id: i64) -> bool {
    part.starts_with(&format!("{}@@", provider())) && part.ends_with(&format!("@@{user_id}"))
}

// ── The cache ─────────────────────────────────────────────────────────────────

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub struct Cache {
    pool: SqlitePool,
    /// The `files` folder.
    root: PathBuf,
    clock: Clock,
    /// One operation at a time per account (they read, fetch and then update the same rows and files).
    locks: StdMutex<HashMap<i64, Arc<Mutex<()>>>>,
}

#[derive(sqlx::FromRow, Clone, Debug)]
struct EntryRow {
    remote_id: Option<String>,
    path: String,
    name: String,
    is_dir: i64,
    size: Option<i64>,
    mtime_ms: Option<i64>,
    local_name: String,
    content_at: Option<i64>,
    locked: i64,
}

/// The columns of an entries row, as EntryRow reads them (with whether the file is locked).
const ENTRY_COLUMNS: &str = "remote_id, path, name, is_dir, size, mtime_ms, local_name, content_at,
    EXISTS(SELECT 1 FROM file_locks l WHERE l.user_id = entries.user_id AND l.path = entries.path) AS locked";

#[derive(sqlx::FromRow, Clone, Debug)]
struct ChangeRow {
    path: String,
    kind: String,
    base_exists: i64,
    base_size: Option<i64>,
    base_mtime_ms: Option<i64>,
    local_name: String,
    changed_at: i64,
}

fn now_real() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn fresh(fetched_at: i64, ttl_secs: Option<i64>, now: i64) -> bool {
    match ttl_secs {
        None => true,
        Some(secs) => now - fetched_at < secs.saturating_mul(1000),
    }
}

fn sql(e: sqlx::Error) -> String {
    e.to_string()
}

fn io(e: std::io::Error) -> String {
    e.to_string()
}

impl Cache {
    pub async fn open(files_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(files_dir).map_err(io)?;
        let options = sqlx::sqlite::SqliteConnectOptions::new().filename(files_dir.join(crate::layout::FILES_DB)).create_if_missing(true);
        let pool = SqlitePool::connect_with(options).await.map_err(sql)?;
        let cache = Self::with_pool(pool, files_dir.to_path_buf(), Arc::new(now_real)).await?;
        cache.migrate_old_layout().await;
        cache.remove_leftover_uploads();
        cache.keep_pairs_marked();
        Ok(cache)
    }

    /// Every full folder holds its `.keep` (see `folder_pairs::keep_file()`) — including the ones made before that rule
    /// existed, which get theirs at the next start. Best effort: a folder that can't be written to is left for next time.
    fn keep_pairs_marked(&self) {
        let a = self.a_dir();
        let _ = NUMBERING.repair(&a);
        for (source, _) in NUMBERING.list(&a).unwrap_or_default() {
            // The branches of the account or folder, and its branches' thumbnails, are pairs too.
            let _ = NUMBERING.repair(&source.short_dir.join(crate::layout::FILES_BRANCHES_FOLDER));
            let _ = NUMBERING.repair(&source.short_dir.join(crate::layout::FILES_BRANCH_THUMBNAILS_FOLDER));
        }
    }

    /// **The old layout kept the branches and thumbnails beside `a`** (`files/b/NNN-<source>/MMM`, `files/t/NNN-<source>`,
    /// `files/tb/NNN-<source>/MMM`, each with a numbering of its own); they now live **inside the folder of the account or of the folder of
    /// this device they belong to** — `files/a/NNN/b`, `t` and `tb`. Whatever is found in the old places is moved (the folder is renamed, so a
    /// big branch is not copied), the old marker pair goes, and the old folders are removed when empty. Safe to run again, and it leaves alone
    /// anything it can't move (a target that exists already).
    async fn migrate_old_layout(&self) {
        let a = self.a_dir();
        for (old_name, new_name) in [
            (crate::layout::FILES_BRANCHES_FOLDER, crate::layout::FILES_BRANCHES_FOLDER),
            (crate::layout::FILES_THUMBNAILS_FOLDER, crate::layout::FILES_THUMBNAILS_FOLDER),
            (crate::layout::FILES_BRANCH_THUMBNAILS_FOLDER, crate::layout::FILES_BRANCH_THUMBNAILS_FOLDER),
        ] {
            let old = self.root.join(old_name);
            let Ok(pairs) = NUMBERING.list(&old) else { continue };
            for (pair, part) in pairs {
                // Whose it was: a Filen account (found by its user id — its email may have changed) or a folder of this device.
                let owner: Option<PathBuf> = match part.strip_prefix(&format!("{}@@", provider())).and_then(|rest| rest.rsplit("@@").next()).and_then(|id| id.parse::<i64>().ok()) {
                    Some(user_id) => match sqlx::query_scalar::<_, i64>("SELECT pair_index FROM accounts WHERE user_id = ?1").bind(user_id).fetch_optional(&self.pool).await {
                        Ok(Some(index)) => Some(a.join(NUMBERING.short_name(index as u32))),
                        _ => NUMBERING.ensure(&a, &part).ok().map(|p| p.short_dir),
                    },
                    None => NUMBERING.ensure(&a, &part).ok().map(|p| p.short_dir),
                };
                let Some(owner) = owner else { continue };
                let target = owner.join(new_name);
                if target.exists() {
                    continue;
                }
                if std::fs::create_dir_all(&owner).is_ok() && std::fs::rename(&pair.short_dir, &target).is_ok() {
                    let _ = std::fs::remove_dir_all(&pair.full_dir);
                }
            }
            let _ = std::fs::remove_dir(&old);
        }
    }

    /// An upload in flight when the app stopped left its temporary file behind: they all go.
    fn remove_leftover_uploads(&self) {
        if let Ok(accounts) = std::fs::read_dir(self.a_dir()) {
            for account in accounts.flatten() {
                let _ = std::fs::remove_dir_all(account.path().join(UPLOADS_FOLDER));
            }
        }
    }

    pub async fn with_pool(pool: SqlitePool, root: PathBuf, clock: Clock) -> Result<Self, String> {
        for statement in [
            "CREATE TABLE IF NOT EXISTS accounts (user_id INTEGER PRIMARY KEY, email TEXT NOT NULL, pair_index INTEGER NOT NULL, ttl_secs INTEGER, created_at INTEGER NOT NULL)",
            "CREATE TABLE IF NOT EXISTS entries (user_id INTEGER NOT NULL, path TEXT NOT NULL, parent TEXT NOT NULL, name TEXT NOT NULL, is_dir INTEGER NOT NULL, size INTEGER, mtime_ms INTEGER, local_name TEXT NOT NULL, fetched_at INTEGER NOT NULL, content_at INTEGER, remote_id TEXT, PRIMARY KEY (user_id, path))",
            "CREATE INDEX IF NOT EXISTS entries_parent ON entries (user_id, parent)",
            "CREATE TABLE IF NOT EXISTS listings (user_id INTEGER NOT NULL, path TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (user_id, path))",
            "CREATE TABLE IF NOT EXISTS branches (user_id INTEGER NOT NULL, pair_index INTEGER NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, pair_index))",
            "CREATE TABLE IF NOT EXISTS branch_changes (user_id INTEGER NOT NULL, branch INTEGER NOT NULL, path TEXT NOT NULL, parent TEXT NOT NULL, kind TEXT NOT NULL, base_exists INTEGER NOT NULL, base_size INTEGER, base_mtime_ms INTEGER, local_name TEXT NOT NULL, changed_at INTEGER NOT NULL, PRIMARY KEY (user_id, branch, path))",
            "CREATE INDEX IF NOT EXISTS branch_changes_parent ON branch_changes (user_id, branch, parent)",
            // Files locked against caching. Kept apart from `entries` so that a lock survives its row being
            // dropped and made again (a commit, or a listing that briefly lacks the file).
            "CREATE TABLE IF NOT EXISTS file_locks (user_id INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY (user_id, path))",
            // The branches of the folders of this device (`local_branches.rs`): a root is named by its guid.
            "CREATE TABLE IF NOT EXISTS local_branches (root_guid TEXT NOT NULL, pair_index INTEGER NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (root_guid, pair_index))",
            "CREATE TABLE IF NOT EXISTS local_branch_changes (root_guid TEXT NOT NULL, branch INTEGER NOT NULL, path TEXT NOT NULL, parent TEXT NOT NULL, kind TEXT NOT NULL, base_exists INTEGER NOT NULL, base_size INTEGER, base_mtime_ms INTEGER, changed_at INTEGER NOT NULL, PRIMARY KEY (root_guid, branch, path))",
            "CREATE INDEX IF NOT EXISTS local_branch_changes_parent ON local_branch_changes (root_guid, branch, parent)",
        ] {
            sqlx::query(statement).execute(&pool).await.map_err(sql)?;
        }
        // `remote_id` (Filen's id for the entry) was added later: a plain nullable column, filled in as listings are fetched again.
        let has_remote_id: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('entries') WHERE name = 'remote_id'").fetch_one(&pool).await.map_err(sql)?;
        if has_remote_id == 0 {
            sqlx::query("ALTER TABLE entries ADD COLUMN remote_id TEXT").execute(&pool).await.map_err(sql)?;
        }
        Ok(Self { pool, root, clock, locks: StdMutex::new(HashMap::new()) })
    }

    /// Closes the database, releasing `files/data.db` — on Windows a file that is still open can't be
    /// deleted, so the commands that wipe the data folder call this first (see `data_location`). The
    /// cache can't be used afterwards; those commands restart the app.
    pub async fn close(&self) {
        self.pool.close().await;
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    async fn lock(&self, user_id: i64) -> tokio::sync::OwnedMutexGuard<()> {
        let mutex = self.locks.lock().unwrap().entry(user_id).or_default().clone();
        mutex.lock_owned().await
    }

    fn a_dir(&self) -> PathBuf {
        self.root.join(crate::layout::FILES_ACCOUNTS_FOLDER)
    }

    /// `files/a/NNN` — the folder of an account: its cached content (`c`), its branches (`b`), its thumbnails (`t`) and its branches'
    /// thumbnails (`tb`) — each holding the account's own files' folder hierarchy.
    async fn account_dir(&self, user_id: i64) -> Result<PathBuf, String> {
        Ok(self.content_root(user_id).await?.parent().ok_or("The account's folder is missing.")?.to_path_buf())
    }

    // ── Thumbnails ───────────────────────────────────────────────────────────

    /// The folder that holds the thumbnails of the account's own files, or of one of its branches' files (`files/t/NNN` and
    /// `files/tb/NNN/MMM`, each with its readable half beside it, like the folders of the contents and of the branches). `None`
    /// when it doesn't exist and `make` is off.
    async fn thumb_root(&self, user_id: i64, branch: Option<i64>, make: bool) -> Result<Option<PathBuf>, String> {
        let parent = self.account_dir(user_id).await?.join(if branch.is_some() { crate::layout::FILES_BRANCH_THUMBNAILS_FOLDER } else { crate::layout::FILES_THUMBNAILS_FOLDER });
        if make {
            std::fs::create_dir_all(&parent).map_err(io)?;
        } else if !parent.is_dir() {
            return Ok(None);
        }
        let Some(branch) = branch else { return Ok(Some(parent)) };
        self.branch_exists(user_id, branch).await?;
        let short = parent.join(NUMBERING.short_name(branch as u32));
        if make {
            let name = self.branch_name(user_id, branch).await?;
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

    /// The thumbnail of `path` (a JPEG) as it was made for the version of the file with this modification time and size — none
    /// when there isn't one. In a branch, a file the branch has not changed is looked for among the account's own.
    pub async fn thumb_get(&self, user_id: i64, branch: Option<i64>, path: &str, mtime_ms: u64, size: u64) -> Result<Option<Vec<u8>>, String> {
        let path = norm_path(path)?;
        let mut places = vec![branch];
        if branch.is_some() && !self.changed_in_branch(user_id, branch.unwrap(), &path).await? {
            places = vec![None];
        }
        for place in places {
            if let Some(root) = self.thumb_root(user_id, place, false).await? {
                if let Ok(bytes) = std::fs::read(thumb_file(&root, &path, mtime_ms, size)) {
                    return Ok(Some(bytes));
                }
            }
        }
        Ok(None)
    }

    /// Keeps `bytes` (a JPEG) as the thumbnail of this version of `path`; older versions' thumbnails of it are removed. A file the
    /// branch has changed keeps its thumbnail with the branch, any other with the account.
    pub async fn thumb_put(&self, user_id: i64, branch: Option<i64>, path: &str, mtime_ms: u64, size: u64, bytes: &[u8]) -> Result<(), String> {
        let path = norm_path(path)?;
        let place = match branch {
            Some(b) if self.changed_in_branch(user_id, b, &path).await? => Some(b),
            _ => None,
        };
        let Some(root) = self.thumb_root(user_id, place, true).await? else { return Ok(()) };
        let target = thumb_file(&root, &path, mtime_ms, size);
        if let Some(folder) = target.parent() {
            std::fs::create_dir_all(folder).map_err(io)?;
            remove_older_thumbs(folder, &thumb_prefix(&path), target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
        }
        std::fs::write(target, bytes).map_err(io)
    }

    /// Whether the branch has a change (a write, a new folder) at `path` — the file it shows is then not the account's.
    async fn changed_in_branch(&self, user_id: i64, branch: i64, path: &str) -> Result<bool, String> {
        let changed: Option<i64> = sqlx::query_scalar("SELECT 1 FROM branch_changes WHERE user_id = ?1 AND branch = ?2 AND path = ?3 AND kind = 'put'")
            .bind(user_id)
            .bind(branch)
            .bind(path)
            .fetch_optional(&self.pool)
            .await
            .map_err(sql)?;
        Ok(changed.is_some())
    }

    /// Throws away the account's thumbnails (its own, not its branches').
    async fn drop_thumbs_of_account(&self, user_id: i64) {
        if let Ok(dir) = self.account_dir(user_id).await {
            let _ = std::fs::remove_dir_all(dir.join(crate::layout::FILES_THUMBNAILS_FOLDER));
        }
    }

    // ── Accounts ─────────────────────────────────────────────────────────────

    /// Makes sure the account has its folder pair in `files/a` and a row here (called when it's
    /// connected, and again whenever it's used, so accounts that pre-date the cache get theirs).
    /// If the email has changed, the readable folder is renamed to match.
    pub async fn ensure_account(&self, user_id: i64, email: &str) -> Result<AccountCacheInfo, String> {
        let _guard = self.lock(user_id).await;
        self.ensure_account_locked(user_id, email).await
    }

    async fn ensure_account_locked(&self, user_id: i64, email: &str) -> Result<AccountCacheInfo, String> {
        let part = account_part(email, user_id);
        let a = self.a_dir();
        let existing = NUMBERING.list(&a).map_err(io)?.into_iter().find(|(_, p)| is_account_part_for(p, user_id));
        let pair = match existing {
            Some((pair, existing_part)) => {
                if existing_part != part {
                    let renamed = a.join(NUMBERING.full_name(pair.index, &part));
                    std::fs::rename(&pair.full_dir, &renamed).map_err(io)?;
                }
                std::fs::create_dir_all(&pair.short_dir).map_err(io)?;
                NUMBERING.find(&a, &part).map_err(io)?.ok_or("The account's folder disappeared.")?
            }
            None => NUMBERING.create(&a, &part).map_err(io)?,
        };

        sqlx::query(
            "INSERT INTO accounts (user_id, email, pair_index, ttl_secs, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, pair_index = excluded.pair_index",
        )
        .bind(user_id)
        .bind(email)
        .bind(pair.index as i64)
        .bind(DEFAULT_TTL_SECS)
        .bind(self.now())
        .execute(&self.pool)
        .await
        .map_err(sql)?;
        self.account_info(user_id).await
    }

    pub async fn account_info(&self, user_id: i64) -> Result<AccountCacheInfo, String> {
        let row = sqlx::query("SELECT email, pair_index, ttl_secs FROM accounts WHERE user_id = ?1")
            .bind(user_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(sql)?
            .ok_or("This account isn't set up for caching yet.")?;
        Ok(AccountCacheInfo {
            user_id,
            email: row.get("email"),
            ttl_secs: row.get("ttl_secs"),
            folder: NUMBERING.short_name(row.get::<i64, _>("pair_index") as u32),
        })
    }

    /// Sets how long the account's listings, metadata and contents stay valid; `None`: forever.
    pub async fn set_ttl(&self, user_id: i64, ttl_secs: Option<i64>) -> Result<(), String> {
        if ttl_secs.is_some_and(|s| s < 0) {
            return Err("The cache interval can't be negative.".to_string());
        }
        sqlx::query("UPDATE accounts SET ttl_secs = ?2 WHERE user_id = ?1").bind(user_id).bind(ttl_secs).execute(&self.pool).await.map_err(sql)?;
        Ok(())
    }

    /// Removes everything to do with the account: both folder pairs (and so the cached files and every
    /// branch) and every row. Called when it is disconnected.
    pub async fn forget_account(&self, user_id: i64) -> Result<(), String> {
        let _guard = self.lock(user_id).await;
        // The account's folder holds everything of it — content, branches, thumbnails.
        let a = self.a_dir();
        for (_, part) in NUMBERING.list(&a).map_err(io)? {
            if is_account_part_for(&part, user_id) {
                NUMBERING.delete(&a, &part).map_err(io)?;
            }
        }
        for table in ["branch_changes", "branches", "listings", "entries", "file_locks", "accounts"] {
            sqlx::query(&format!("DELETE FROM {table} WHERE user_id = ?1")).bind(user_id).execute(&self.pool).await.map_err(sql)?;
        }
        Ok(())
    }

    async fn ttl(&self, user_id: i64) -> Result<Option<i64>, String> {
        Ok(self.account_info(user_id).await?.ttl_secs)
    }

    /// `files/a/NNN/c`, where the account's cached contents live.
    async fn content_root(&self, user_id: i64) -> Result<PathBuf, String> {
        let pair_index: i64 = sqlx::query_scalar("SELECT pair_index FROM accounts WHERE user_id = ?1")
            .bind(user_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(sql)?
            .ok_or("This account isn't set up for caching yet.")?;
        Ok(self.a_dir().join(NUMBERING.short_name(pair_index as u32)).join(crate::layout::FILES_CONTENT_FOLDER))
    }

    /// Throws away everything cached for the account (listings, metadata, contents); branches stay,
    /// and so do the files locked against caching (with the folders above them, whose rows name them).
    pub async fn clear(&self, user_id: i64) -> Result<(), String> {
        let _guard = self.lock(user_id).await;
        let locked: Vec<String> = sqlx::query_scalar("SELECT e.path FROM entries e JOIN file_locks l ON l.user_id = e.user_id AND l.path = e.path WHERE e.user_id = ?1 AND e.is_dir = 0")
            .bind(user_id)
            .fetch_all(&self.pool)
            .await
            .map_err(sql)?;
        if !locked.is_empty() {
            return self.clear_except(user_id, &locked).await;
        }
        let content = self.content_root(user_id).await?;
        match std::fs::remove_dir_all(&content) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io(e)),
        }
        self.drop_thumbs_of_account(user_id).await;
        for table in ["listings", "entries"] {
            sqlx::query(&format!("DELETE FROM {table} WHERE user_id = ?1")).bind(user_id).execute(&self.pool).await.map_err(sql)?;
        }
        Ok(())
    }

    /// clear() when files are locked: everything goes but them and the folders above them.
    async fn clear_except(&self, user_id: i64, locked: &[String]) -> Result<(), String> {
        let keep: HashSet<String> = locked.iter().flat_map(|p| prefixes(p)).collect();
        let rows: Vec<(String, i64)> = sqlx::query_as("SELECT path, is_dir FROM entries WHERE user_id = ?1").bind(user_id).fetch_all(&self.pool).await.map_err(sql)?;
        for (path, is_dir) in rows.iter().filter(|(p, _)| !keep.contains(p)) {
            let local = self.mirror_path(user_id, path).await?;
            let _ = if *is_dir != 0 { std::fs::remove_dir_all(&local) } else { std::fs::remove_file(&local) };
        }
        for (path, _) in rows.iter().filter(|(p, _)| !keep.contains(p)) {
            sqlx::query("DELETE FROM entries WHERE user_id = ?1 AND path = ?2").bind(user_id).bind(path).execute(&self.pool).await.map_err(sql)?;
        }
        sqlx::query("DELETE FROM listings WHERE user_id = ?1").bind(user_id).execute(&self.pool).await.map_err(sql)?;
        Ok(())
    }

    // ── One item of the cache ────────────────────────────────────────────────

    /// **Hard refresh** of one item: what the cache holds of it is fetched from Filen again, whatever the interval says. A file's
    /// listing entry (its version) and its content are fetched anew; a folder's listing is, and everything below it is looked at
    /// again the next time it is opened. A file locked against caching is frozen and refuses — unlock it first.
    pub async fn hard_refresh(&self, remote: &impl Remote, user_id: i64, path: &str) -> Result<(), String> {
        let path = norm_path(path)?;
        let _guard = self.lock(user_id).await;
        let Some(parent) = parent_of(&path) else {
            self.forget_listings_below(user_id, "/").await?;
            self.list_account(remote, user_id, "/", true).await?;
            return Ok(());
        };
        if self.entry(user_id, &path).await?.is_some_and(|e| e.locked != 0 && e.is_dir == 0) {
            return Err(format!("\"{path}\" is locked against caching: unlock it to refresh it."));
        }
        self.list_account(remote, user_id, &parent, true).await?; // Filen's own idea of it — and of its version
        let entry = self.entry(user_id, &path).await?.ok_or_else(|| format!("\"{path}\" doesn't exist in Filen (any more)."))?;
        if entry.is_dir != 0 {
            self.forget_listings_below(user_id, &path).await?;
            self.list_account(remote, user_id, &path, true).await?;
        } else {
            self.drop_content(user_id, &path).await?;
            self.cached_file_account(remote, user_id, &path).await?;
        }
        Ok(())
    }

    /// **Clear the cache** of one item: the cached content of a file — of every file below a folder, its listing and theirs — and its
    /// thumbnails are thrown away; it is fetched again when it is next needed. Files locked against caching stay as they are.
    pub async fn clear_item(&self, user_id: i64, path: &str) -> Result<(), String> {
        let path = norm_path(path)?;
        let _guard = self.lock(user_id).await;
        let below = format!("{}/", path.trim_end_matches('/'));
        let rows: Vec<(String, i64, i64)> = sqlx::query_as(
            "SELECT e.path, e.is_dir, EXISTS(SELECT 1 FROM file_locks l WHERE l.user_id = e.user_id AND l.path = e.path)
             FROM entries e WHERE e.user_id = ?1 AND (e.path = ?2 OR substr(e.path, 1, ?3) = ?4 OR ?2 = '/')",
        )
        .bind(user_id)
        .bind(&path)
        .bind(below.chars().count() as i64)
        .bind(&below)
        .fetch_all(&self.pool)
        .await
        .map_err(sql)?;
        for (file, is_dir, locked) in &rows {
            if *is_dir == 0 && *locked == 0 {
                self.drop_content(user_id, file).await?;
            }
        }
        // The listings of the item and below (a locked file's folders keep their rows: they name it).
        self.forget_listings_below(user_id, &path).await?;
        self.invalidate_listings(user_id, &[path.clone()]).await?;
        // The thumbnails of the item: a file's, or the folder's whole subtree.
        if let Some(root) = self.thumb_root(user_id, None, false).await? {
            let target = path.split('/').filter(|p| !p.is_empty()).fold(root.clone(), |dir, part| dir.join(mirror_name(part)));
            if rows.iter().any(|(p, d, _)| p == &path && *d == 0) {
                let file = thumb_file(&root, &path, 0, 0);
                if let Some(folder) = file.parent() {
                    remove_older_thumbs(folder, &thumb_prefix(&path), String::new());
                }
            } else {
                let _ = std::fs::remove_dir_all(target);
            }
        }
        Ok(())
    }

    /// The cached content of one file goes (its listing entry stays, so the file is still shown).
    async fn drop_content(&self, user_id: i64, path: &str) -> Result<(), String> {
        let local = self.mirror_path(user_id, path).await?;
        let _ = std::fs::remove_file(&local);
        sqlx::query("UPDATE entries SET content_at = NULL WHERE user_id = ?1 AND path = ?2").bind(user_id).bind(path).execute(&self.pool).await.map_err(sql)?;
        Ok(())
    }

    /// Forgets that the folders *below* `path` were listed (the folder's own listing is not touched).
    async fn forget_listings_below(&self, user_id: i64, path: &str) -> Result<(), String> {
        let below = format!("{}/", path.trim_end_matches('/'));
        sqlx::query("DELETE FROM listings WHERE user_id = ?1 AND substr(path, 1, ?2) = ?3").bind(user_id).bind(below.chars().count() as i64).bind(&below).execute(&self.pool).await.map_err(sql)?;
        Ok(())
    }

    // ── Files locked against caching ─────────────────────────────────────────

    async fn is_locked(&self, user_id: i64, path: &str) -> Result<bool, String> {
        let found: Option<i64> = sqlx::query_scalar("SELECT 1 FROM file_locks WHERE user_id = ?1 AND path = ?2")
            .bind(user_id)
            .bind(path)
            .fetch_optional(&self.pool)
            .await
            .map_err(sql)?;
        Ok(found.is_some())
    }

    async fn set_lock_row(&self, user_id: i64, path: &str, locked: bool) -> Result<(), String> {
        let statement = if locked { "INSERT OR IGNORE INTO file_locks (user_id, path) VALUES (?1, ?2)" } else { "DELETE FROM file_locks WHERE user_id = ?1 AND path = ?2" };
        sqlx::query(statement).bind(user_id).bind(path).execute(&self.pool).await.map_err(sql)?;
        Ok(())
    }

    /// Forgets the locks of `path` and everything below it (it was deleted or moved).
    async fn drop_locks_below(&self, user_id: i64, path: &str) -> Result<(), String> {
        let below = format!("{path}/");
        sqlx::query("DELETE FROM file_locks WHERE user_id = ?1 AND (path = ?2 OR substr(path, 1, ?3) = ?4)")
            .bind(user_id)
            .bind(path)
            .bind(below.chars().count() as i64)
            .bind(&below)
            .execute(&self.pool)
            .await
            .map_err(sql)?;
        Ok(())
    }

    /// Locks a file of the account against caching, or unlocks it. A locked file's cached copy is
    /// **frozen**: it is served as it is — with no check that it is still current, so it opens offline
    /// too — and neither the interval, nor a newer listing, nor a deletion in Filen, nor "clear the
    /// cache" touches it. Locking fetches the file first if it isn't cached (there has to be a copy to
    /// keep). It is about the account's file, so it holds in every branch that reads it through.
    pub async fn set_locked(&self, remote: &impl Remote, user_id: i64, path: &str, locked: bool) -> Result<(), String> {
        let path = norm_path(path)?;
        let _guard = self.lock(user_id).await;
        if locked {
            self.cached_file_account(remote, user_id, &path).await?;
        }
        self.set_lock_row(user_id, &path, locked).await
    }

    // ── The cached tree of the account itself ────────────────────────────────

    async fn entry(&self, user_id: i64, path: &str) -> Result<Option<EntryRow>, String> {
        sqlx::query_as::<_, EntryRow>(&format!("SELECT {ENTRY_COLUMNS} FROM entries WHERE user_id = ?1 AND path = ?2"))
        .bind(user_id)
        .bind(path)
        .fetch_optional(&self.pool)
        .await
        .map_err(sql)
    }

    async fn children(&self, user_id: i64, parent: &str) -> Result<Vec<EntryRow>, String> {
        sqlx::query_as::<_, EntryRow>(&format!("SELECT {ENTRY_COLUMNS} FROM entries WHERE user_id = ?1 AND parent = ?2"))
        .bind(user_id)
        .bind(parent)
        .fetch_all(&self.pool)
        .await
        .map_err(sql)
    }

    /// The local path of `path`'s content in the mirror: each component's own local name.
    async fn mirror_path(&self, user_id: i64, path: &str) -> Result<PathBuf, String> {
        let mut local = self.content_root(user_id).await?;
        for prefix in prefixes(path) {
            let name = match self.entry(user_id, &prefix).await? {
                Some(row) => row.local_name,
                None => mirror_name(name_of(&prefix)),
            };
            local.push(name);
        }
        Ok(local)
    }

    /// Deletes the cached rows for `path` and everything below it, and its cached files.
    async fn drop_subtree(&self, user_id: i64, path: &str) -> Result<(), String> {
        if path == "/" {
            return self.clear_tree_of_root(user_id).await;
        }
        let local = self.mirror_path(user_id, path).await?;
        for target in [&local] {
            let _ = std::fs::remove_dir_all(target).or_else(|_| std::fs::remove_file(target));
        }
        let below = format!("{path}/");
        let len = below.chars().count() as i64;
        for table in ["entries", "listings"] {
            sqlx::query(&format!("DELETE FROM {table} WHERE user_id = ?1 AND (path = ?2 OR substr(path, 1, ?3) = ?4)"))
                .bind(user_id)
                .bind(path)
                .bind(len)
                .bind(&below)
                .execute(&self.pool)
                .await
                .map_err(sql)?;
        }
        Ok(())
    }

    async fn clear_tree_of_root(&self, user_id: i64) -> Result<(), String> {
        let content = self.content_root(user_id).await?;
        let _ = std::fs::remove_dir_all(&content);
        for table in ["entries", "listings"] {
            sqlx::query(&format!("DELETE FROM {table} WHERE user_id = ?1")).bind(user_id).execute(&self.pool).await.map_err(sql)?;
        }
        Ok(())
    }

    /// Forgets that these folders' listings are known, so the next look fetches them again.
    async fn invalidate_listings(&self, user_id: i64, paths: &[String]) -> Result<(), String> {
        for path in paths {
            sqlx::query("DELETE FROM listings WHERE user_id = ?1 AND path = ?2").bind(user_id).bind(path).execute(&self.pool).await.map_err(sql)?;
        }
        Ok(())
    }

    /// Records a fresh listing of `path` from Filen: new things are added (with a safe local name),
    /// changed files lose their cached content, things that are gone are dropped with everything
    /// under them. Resolves to the time the listing was recorded with — what a caller must report as
    /// its `fetched_at`, so the value it shows is the stored one.
    async fn sync_listing(&self, user_id: i64, path: &str, remote: Vec<RemoteEntry>) -> Result<i64, String> {
        let now = self.now();
        let existing: HashMap<String, EntryRow> = self.children(user_id, path).await?.into_iter().map(|r| (r.name.clone(), r)).collect();
        let listed: HashSet<&str> = remote.iter().map(|e| e.name.as_str()).collect();
        // A locked file is frozen: what the cache holds of it stays, whatever Filen now says (even that it is gone).
        let frozen = |row: &EntryRow| row.locked != 0 && row.is_dir == 0;

        for (name, row) in &existing {
            if !listed.contains(name.as_str()) && !frozen(row) {
                self.drop_subtree(user_id, &row.path).await?;
            }
        }

        let mut taken: HashSet<String> =
            existing.iter().filter(|(n, r)| listed.contains(n.as_str()) || frozen(r)).map(|(_, r)| r.local_name.to_lowercase()).collect();
        for entry in remote {
            let entry_path = join_path(path, &entry.name);
            if !entry.is_directory && existing.get(&entry.name).is_some_and(|row| frozen(row) && row.is_dir == 0) {
                continue;
            }
            match existing.get(&entry.name) {
                Some(row) if (row.is_dir != 0) == entry.is_directory => {
                    let changed = row.size != entry.size.map(|s| s as i64) || row.mtime_ms != entry.mtime_ms.map(|m| m as i64);
                    if changed && row.content_at.is_some() {
                        let local = self.mirror_path(user_id, &entry_path).await?;
                        let _ = std::fs::remove_file(local);
                    }
                    sqlx::query(
                        "UPDATE entries SET size = ?3, mtime_ms = ?4, fetched_at = ?5, content_at = CASE WHEN ?6 THEN NULL ELSE content_at END, remote_id = ?7
                         WHERE user_id = ?1 AND path = ?2",
                    )
                    .bind(user_id)
                    .bind(&entry_path)
                    .bind(entry.size.map(|s| s as i64))
                    .bind(entry.mtime_ms.map(|m| m as i64))
                    .bind(now)
                    .bind(changed)
                    .bind(&entry.id)
                    .execute(&self.pool)
                    .await
                    .map_err(sql)?;
                }
                previous => {
                    if previous.is_some() {
                        self.drop_subtree(user_id, &entry_path).await?; // it was a file and is now a folder, or the other way round
                    }
                    let local_name = allocate_local_name(&entry.name, &taken);
                    taken.insert(local_name.to_lowercase());
                    sqlx::query(
                        "INSERT INTO entries (user_id, path, parent, name, is_dir, size, mtime_ms, local_name, fetched_at, content_at, remote_id)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10)",
                    )
                    .bind(user_id)
                    .bind(&entry_path)
                    .bind(path)
                    .bind(&entry.name)
                    .bind(entry.is_directory as i64)
                    .bind(entry.size.map(|s| s as i64))
                    .bind(entry.mtime_ms.map(|m| m as i64))
                    .bind(&local_name)
                    .bind(now)
                    .bind(&entry.id)
                    .execute(&self.pool)
                    .await
                    .map_err(sql)?;
                }
            }
        }
        sqlx::query("INSERT INTO listings (user_id, path, fetched_at) VALUES (?1, ?2, ?3) ON CONFLICT(user_id, path) DO UPDATE SET fetched_at = excluded.fetched_at")
            .bind(user_id)
            .bind(path)
            .bind(now)
            .execute(&self.pool)
            .await
            .map_err(sql)?;
        Ok(now)
    }

    fn to_entry(row: &EntryRow) -> CacheEntry {
        CacheEntry {
            id: row.remote_id.clone(),
            name: row.name.clone(),
            is_directory: row.is_dir != 0,
            size: row.size.map(|s| s as u64),
            mtime_ms: row.mtime_ms.map(|m| m as u64),
            cached: row.content_at.is_some(),
            locked: row.locked != 0,
            changed: None,
        }
    }

    /// The listing of `path` in the account itself: from the cache if it is still valid, otherwise
    /// from Filen (or, if Filen can't be reached, the expired one, marked stale).
    async fn list_account(&self, remote: &impl Remote, user_id: i64, path: &str, force: bool) -> Result<Listing, String> {
        let ttl = self.ttl(user_id).await?;
        let known: Option<i64> = sqlx::query_scalar("SELECT fetched_at FROM listings WHERE user_id = ?1 AND path = ?2")
            .bind(user_id)
            .bind(path)
            .fetch_optional(&self.pool)
            .await
            .map_err(sql)?;

        let (fetched_at, stale) = match known {
            Some(at) if !force && fresh(at, ttl, self.now()) => (at, false),
            _ => match remote.readdir(path).await {
                Ok(entries) => {
                    (self.sync_listing(user_id, path, entries).await?, false)
                }
                Err(e) => match known {
                    Some(at) => (at, true),
                    None => return Err(e),
                },
            },
        };
        let mut entries: Vec<CacheEntry> = self.children(user_id, path).await?.iter().map(Self::to_entry).collect();
        sort_entries(&mut entries);
        Ok(Listing { entries, fetched_at, stale })
    }

    /// The content of a file of the account itself: from the cache, or fetched (and cached).
    /// The file's bytes — for small files (the caller holds them all); see cached_file for the rest.
    async fn read_account(&self, remote: &impl Remote, user_id: i64, path: &str) -> Result<Vec<u8>, String> {
        let local = self.cached_file_account(remote, user_id, path).await?;
        std::fs::read(local).map_err(io)
    }

    /// Where the account's file is cached, having fetched it from Filen if it wasn't (or the cached
    /// copy is gone). The download goes to a .part file beside its target as it arrives — the whole
    /// file is never in memory — and is renamed into place only when it is complete, so an interrupted
    /// download leaves nothing that looks cached.
    async fn cached_file_account(&self, remote: &impl Remote, user_id: i64, path: &str) -> Result<PathBuf, String> {
        let parent = parent_of(path).ok_or("That's the root folder, not a file.")?;
        // A locked file that is cached is served as it is: nothing about it is validated (or fetched).
        if let Some(entry) = self.entry(user_id, path).await? {
            if entry.locked != 0 && entry.is_dir == 0 && entry.content_at.is_some() {
                let local = self.mirror_path(user_id, path).await?;
                if local.is_file() {
                    return Ok(local);
                }
            }
        }
        self.list_account(remote, user_id, &parent, false).await?; // validates the listing (and so the entry)
        let entry = self.entry(user_id, path).await?.ok_or_else(|| format!("\"{path}\" doesn't exist."))?;
        if entry.is_dir != 0 {
            return Err(format!("\"{path}\" is a folder."));
        }
        let local = self.mirror_path(user_id, path).await?;
        if entry.content_at.is_some() && local.is_file() {
            return Ok(local);
        }
        if let Some(dir) = local.parent() {
            std::fs::create_dir_all(dir).map_err(io)?;
        }
        let mut part = local.as_os_str().to_owned();
        part.push(".part");
        let part = PathBuf::from(part);
        let mut file = std::fs::File::create(&part).map_err(io)?;
        let downloaded = {
            use std::io::Write;
            remote.download(path, &mut |chunk: &[u8]| file.write_all(chunk).map_err(io)).await
        };
        drop(file);
        match downloaded {
            Ok(()) => {
                std::fs::rename(&part, &local).map_err(io)?;
                self.mark_cached(user_id, path).await?;
                Ok(local)
            }
            Err(e) => {
                let _ = std::fs::remove_file(&part);
                Err(e)
            }
        }
    }

    async fn store_content(&self, user_id: i64, path: &str, local: &Path, bytes: &[u8]) -> Result<(), String> {
        if let Some(dir) = local.parent() {
            std::fs::create_dir_all(dir).map_err(io)?;
        }
        std::fs::write(local, bytes).map_err(io)?;
        self.mark_cached(user_id, path).await
    }

    /// Records that the file's content is in the cache now.
    async fn mark_cached(&self, user_id: i64, path: &str) -> Result<(), String> {
        sqlx::query("UPDATE entries SET content_at = ?3 WHERE user_id = ?1 AND path = ?2")
            .bind(user_id)
            .bind(path)
            .bind(self.now())
            .execute(&self.pool)
            .await
            .map_err(sql)?;
        Ok(())
    }

    // ── Public operations (an optional branch selects the branch's view) ─────

    /// The folder's entries. `force` skips the cache's validity check and fetches again.
    pub async fn list(&self, remote: &impl Remote, user_id: i64, branch: Option<i64>, path: &str, force: bool) -> Result<Listing, String> {
        let path = norm_path(path)?;
        let _guard = self.lock(user_id).await;
        match branch {
            None => self.list_account(remote, user_id, &path, force).await,
            Some(branch) => self.list_branch(remote, user_id, branch, &path, force).await,
        }
    }

    /// A file's bytes (opening or exporting it) — fetched only if it isn't cached.
    pub async fn read(&self, remote: &impl Remote, user_id: i64, branch: Option<i64>, path: &str) -> Result<Vec<u8>, String> {
        let path = norm_path(path)?;
        let _guard = self.lock(user_id).await;
        match branch {
            None => self.read_account(remote, user_id, &path).await,
            Some(branch) => self.read_branch(remote, user_id, branch, &path).await,
        }
    }

    /// Creates or replaces a file. In the account itself it goes to Filen at once; in a branch it
    /// stays local until the branch is committed.
    pub async fn write(&self, remote: &impl Remote, user_id: i64, branch: Option<i64>, path: &str, bytes: &[u8]) -> Result<(), String> {
        let path = norm_path(path)?;
        let parent = parent_of(&path).ok_or("The root folder can't be written to.")?;
        let _guard = self.lock(user_id).await;
        match branch {
            Some(branch) => self.write_branch(remote, user_id, branch, &path, &parent, bytes).await,
            None => {
                // A locked file stays locked, on what is written now: the lock is lifted while the cache
                // learns of the new version (a frozen row would ignore it) and put back after.
                let was_locked = self.is_locked(user_id, &path).await?;
                if was_locked {
                    self.set_lock_row(user_id, &path, false).await?;
                }
                let done = self.write_account(remote, user_id, &path, &parent, bytes).await;
                if was_locked {
                    self.set_lock_row(user_id, &path, true).await?;
                }
                done
            }
        }
    }

    async fn write_account(&self, remote: &impl Remote, user_id: i64, path: &str, parent: &str, bytes: &[u8]) -> Result<(), String> {
        self.list_account(remote, user_id, parent, false).await?;
        write_remote(remote, path, bytes).await?;
        self.list_account(remote, user_id, parent, true).await?; // Filen's own idea of the new file
        let local = self.mirror_path(user_id, path).await?;
        self.store_content(user_id, path, &local, bytes).await
    }

    /// Creates a folder (and any missing folders above it).
    pub async fn mkdir(&self, remote: &impl Remote, user_id: i64, branch: Option<i64>, path: &str) -> Result<(), String> {
        let path = norm_path(path)?;
        if path == "/" {
            return Ok(());
        }
        let _guard = self.lock(user_id).await;
        match branch {
            Some(branch) => self.mkdir_branch(remote, user_id, branch, &path).await,
            None => {
                remote.mkdir(&path).await?;
                let mut affected: Vec<String> = prefixes(&path).iter().filter_map(|p| parent_of(p)).collect();
                affected.dedup();
                self.invalidate_listings(user_id, &affected).await
            }
        }
    }

    /// Deletes a file or folder (a folder with everything in it).
    pub async fn remove(&self, remote: &impl Remote, user_id: i64, branch: Option<i64>, path: &str) -> Result<(), String> {
        let path = norm_path(path)?;
        if path == "/" {
            return Err("The root folder can't be deleted.".to_string());
        }
        let _guard = self.lock(user_id).await;
        match branch {
            Some(branch) => self.remove_branch(remote, user_id, branch, &path).await,
            None => {
                remote.remove(&path).await?;
                self.drop_locks_below(user_id, &path).await?;
                self.drop_subtree(user_id, &path).await
            }
        }
    }

    /// Renames or moves a file or folder. (Inside a branch only files can be renamed.)
    pub async fn rename(&self, remote: &impl Remote, user_id: i64, branch: Option<i64>, from: &str, to: &str) -> Result<(), String> {
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
        let _guard = self.lock(user_id).await;
        match branch {
            Some(branch) => self.rename_branch(remote, user_id, branch, &from, &to).await,
            None => {
                remote.rename(&from, &to).await?;
                self.drop_locks_below(user_id, &from).await?;
                self.drop_subtree(user_id, &from).await?;
                let mut affected: Vec<String> = parent_of(&from).into_iter().collect();
                affected.extend(prefixes(&to).iter().filter_map(|p| parent_of(p)));
                self.invalidate_listings(user_id, &affected).await
            }
        }
    }

    // ── Versions ─────────────────────────────────────────────────────────────

    /// The version of the file as the cache knows it — what someone opening it is working on. No
    /// network. In a branch that already holds the file (changed or checked out) it is the version
    /// *that* was based on: the one that has to still be Filen's for the file to be saved or committed
    /// without a warning.
    pub async fn version(&self, user_id: i64, branch: Option<i64>, path: &str) -> Result<FileVersion, String> {
        let path = norm_path(path)?;
        let _guard = self.lock(user_id).await;
        if let Some(branch) = branch {
            self.branch_exists(user_id, branch).await?;
            if let Some(change) = self.change(user_id, branch, &path).await?.filter(|c| c.kind != "delete") {
                return Ok(FileVersion { exists: change.base_exists != 0, size: change.base_size.map(|s| s as u64), mtime_ms: change.base_mtime_ms.map(|m| m as u64) });
            }
        }
        Ok(match self.entry(user_id, &path).await? {
            Some(e) if e.is_dir == 0 => FileVersion { exists: true, size: e.size.map(|s| s as u64), mtime_ms: e.mtime_ms.map(|m| m as u64) },
            _ => FileVersion::missing(),
        })
    }

    /// Asks Filen itself — not the cache, which a locked file would keep frozen — how the file is now,
    /// and compares it with `base`, the version that was being worked on.
    pub async fn check_version(&self, remote: &impl Remote, user_id: i64, branch: Option<i64>, path: &str, base: &FileVersion) -> Result<VersionCheck, String> {
        let path = norm_path(path)?;
        let parent = parent_of(&path).ok_or("The root folder isn't a file.")?;
        let _guard = self.lock(user_id).await;
        if let Some(branch) = branch {
            if self.inside_new_folder(user_id, branch, &parent).await? {
                // Filen has nothing there at all, and nothing can have changed.
                return Ok(VersionCheck { up_to_date: !base.exists, problem: None, current: FileVersion::missing() });
            }
        }
        let listing = remote.readdir(&parent).await.map_err(|e| format!("Filen can't be asked about the file just now ({e})."))?;
        let current = FileVersion::of(listing.iter().find(|e| e.name == name_of(&path)));
        let problem = if current.same_as(base) {
            None
        } else if !base.exists {
            Some("it was created in Filen after you started".to_string())
        } else if !current.exists {
            Some("it was deleted in Filen after you started".to_string())
        } else if current.mtime_ms > base.mtime_ms {
            Some("Filen has a newer version of it".to_string())
        } else {
            Some("Filen has a different version of it".to_string())
        };
        Ok(VersionCheck { up_to_date: problem.is_none(), problem, current })
    }

    /// Bases the branch's change at `path` on what Filen has now — the person saw that Filen changed the
    /// file and chose to overwrite it — so the commit doesn't warn about it again.
    pub async fn rebase(&self, remote: &impl Remote, user_id: i64, branch: i64, path: &str) -> Result<(), String> {
        let path = norm_path(path)?;
        let parent = parent_of(&path).ok_or("The root folder isn't a file.")?;
        let _guard = self.lock(user_id).await;
        self.branch_exists(user_id, branch).await?;
        self.change(user_id, branch, &path).await?.filter(|c| c.kind != "delete").ok_or("The branch has no change to that file.")?;
        let listing = remote.readdir(&parent).await.map_err(|e| format!("Filen can't be asked about the file just now ({e})."))?;
        let now = FileVersion::of(listing.iter().find(|e| e.name == name_of(&path)));
        sqlx::query("UPDATE branch_changes SET base_exists = ?4, base_size = ?5, base_mtime_ms = ?6 WHERE user_id = ?1 AND branch = ?2 AND path = ?3")
            .bind(user_id)
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

    // ── Branches ─────────────────────────────────────────────────────────────

    /// `files/a/NNN/b/MMM` — the branch's short folder.
    async fn branch_dir(&self, user_id: i64, branch: i64) -> Result<PathBuf, String> {
        Ok(self.account_dir(user_id).await?.join(crate::layout::FILES_BRANCHES_FOLDER).join(NUMBERING.short_name(branch as u32)))
    }

    async fn branch_exists(&self, user_id: i64, branch: i64) -> Result<(), String> {
        let exists: Option<i64> = sqlx::query_scalar("SELECT pair_index FROM branches WHERE user_id = ?1 AND pair_index = ?2")
            .bind(user_id)
            .bind(branch)
            .fetch_optional(&self.pool)
            .await
            .map_err(sql)?;
        exists.map(|_| ()).ok_or_else(|| "That branch doesn't exist.".to_string())
    }

    pub async fn branches(&self, user_id: i64) -> Result<Vec<BranchInfo>, String> {
        let rows = sqlx::query(
            "SELECT b.pair_index, b.name, b.created_at,
                    (SELECT COUNT(*) FROM branch_changes c WHERE c.user_id = b.user_id AND c.branch = b.pair_index) AS changes
             FROM branches b WHERE b.user_id = ?1 ORDER BY b.pair_index",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .map_err(sql)?;
        Ok(rows
            .iter()
            .map(|r| BranchInfo { index: r.get("pair_index"), name: r.get("name"), created_at: r.get("created_at"), changes: r.get("changes") })
            .collect())
    }

    /// Creates a branch named `name` (see `folder_pairs::validate_part`) for the account.
    pub async fn create_branch(&self, user_id: i64, name: &str) -> Result<BranchInfo, String> {
        folder_pairs::validate_part(name)?;
        let _guard = self.lock(user_id).await;
        if self.branches(user_id).await?.iter().any(|b| b.name.to_lowercase() == name.to_lowercase()) {
            return Err(format!("There is a branch called \"{name}\" already."));
        }
        let branches = self.account_dir(user_id).await?.join(crate::layout::FILES_BRANCHES_FOLDER);
        std::fs::create_dir_all(&branches).map_err(io)?;
        let pair = NUMBERING.create(&branches, name).map_err(io)?;
        sqlx::query("INSERT INTO branches (user_id, pair_index, name, created_at) VALUES (?1, ?2, ?3, ?4)")
            .bind(user_id)
            .bind(pair.index as i64)
            .bind(name)
            .bind(self.now())
            .execute(&self.pool)
            .await
            .map_err(sql)?;
        Ok(BranchInfo { index: pair.index as i64, name: name.to_string(), created_at: self.now(), changes: 0 })
    }

    async fn delete_branch_files_and_rows(&self, user_id: i64, branch: i64, name: &str) -> Result<(), String> {
        if let Ok(account) = self.account_dir(user_id).await {
            // Its folder in `b`; with no branches left, `b` itself goes.
            let b = account.join(crate::layout::FILES_BRANCHES_FOLDER);
            NUMBERING.delete(&b, name).map_err(io)?;
            let _ = std::fs::remove_dir(&b);
            // The branch's thumbnails go with it — a second place, beside `b`: `tb/MMM` and its marker.
            let tb = account.join(crate::layout::FILES_BRANCH_THUMBNAILS_FOLDER);
            let _ = NUMBERING.delete(&tb, name);
            let _ = std::fs::remove_dir(&tb);
        }
        sqlx::query("DELETE FROM branch_changes WHERE user_id = ?1 AND branch = ?2").bind(user_id).bind(branch).execute(&self.pool).await.map_err(sql)?;
        sqlx::query("DELETE FROM branches WHERE user_id = ?1 AND pair_index = ?2").bind(user_id).bind(branch).execute(&self.pool).await.map_err(sql)?;
        Ok(())
    }

    /// Throws the branch away: its folders and everything it changed. Filen isn't touched.
    pub async fn discard_branch(&self, user_id: i64, branch: i64) -> Result<(), String> {
        let _guard = self.lock(user_id).await;
        self.branch_exists(user_id, branch).await?;
        let name = self.branch_name(user_id, branch).await?;
        self.delete_branch_files_and_rows(user_id, branch, &name).await
    }

    async fn branch_name(&self, user_id: i64, branch: i64) -> Result<String, String> {
        sqlx::query_scalar("SELECT name FROM branches WHERE user_id = ?1 AND pair_index = ?2")
            .bind(user_id)
            .bind(branch)
            .fetch_optional(&self.pool)
            .await
            .map_err(sql)?
            .ok_or_else(|| "That branch doesn't exist.".to_string())
    }

    pub async fn branch_changes(&self, user_id: i64, branch: i64) -> Result<Vec<BranchChange>, String> {
        self.branch_exists(user_id, branch).await?;
        Ok(self
            .changes(user_id, branch)
            .await?
            .into_iter()
            .map(|c| BranchChange { path: c.path, kind: c.kind, is_new: c.base_exists == 0 })
            .collect())
    }

    async fn changes(&self, user_id: i64, branch: i64) -> Result<Vec<ChangeRow>, String> {
        sqlx::query_as::<_, ChangeRow>(
            "SELECT path, kind, base_exists, base_size, base_mtime_ms, local_name, changed_at FROM branch_changes
             WHERE user_id = ?1 AND branch = ?2 ORDER BY path",
        )
        .bind(user_id)
        .bind(branch)
        .fetch_all(&self.pool)
        .await
        .map_err(sql)
    }

    async fn change(&self, user_id: i64, branch: i64, path: &str) -> Result<Option<ChangeRow>, String> {
        sqlx::query_as::<_, ChangeRow>(
            "SELECT path, kind, base_exists, base_size, base_mtime_ms, local_name, changed_at FROM branch_changes
             WHERE user_id = ?1 AND branch = ?2 AND path = ?3",
        )
        .bind(user_id)
        .bind(branch)
        .bind(path)
        .fetch_optional(&self.pool)
        .await
        .map_err(sql)
    }

    async fn change_children(&self, user_id: i64, branch: i64, parent: &str) -> Result<Vec<ChangeRow>, String> {
        sqlx::query_as::<_, ChangeRow>(
            "SELECT path, kind, base_exists, base_size, base_mtime_ms, local_name, changed_at FROM branch_changes
             WHERE user_id = ?1 AND branch = ?2 AND parent = ?3",
        )
        .bind(user_id)
        .bind(branch)
        .bind(parent)
        .fetch_all(&self.pool)
        .await
        .map_err(sql)
    }

    /// Whether `path` or anything above it was deleted in the branch.
    async fn deleted_in_branch(&self, user_id: i64, branch: i64, path: &str) -> Result<bool, String> {
        for prefix in prefixes(path) {
            if self.change(user_id, branch, &prefix).await?.is_some_and(|c| c.kind == "delete") {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// The local path (inside the branch's folder) where `path`'s content is kept.
    async fn branch_local_path(&self, user_id: i64, branch: i64, path: &str) -> Result<PathBuf, String> {
        let mut local = self.branch_dir(user_id, branch).await?;
        for prefix in prefixes(path) {
            let name = if let Some(change) = self.change(user_id, branch, &prefix).await? {
                change.local_name
            } else if let Some(entry) = self.entry(user_id, &prefix).await? {
                entry.local_name
            } else {
                mirror_name(name_of(&prefix))
            };
            local.push(name);
        }
        Ok(local)
    }

    /// The local name for a new change at `path`: unique among what its parent already holds, in
    /// Filen (as cached) and in the branch. A file Filen already has keeps its usual local name.
    async fn branch_local_name(&self, user_id: i64, branch: i64, path: &str) -> Result<String, String> {
        if let Some(entry) = self.entry(user_id, path).await? {
            return Ok(entry.local_name);
        }
        let parent = parent_of(path).unwrap_or_else(|| "/".to_string());
        let mut taken: HashSet<String> = self.children(user_id, &parent).await?.into_iter().map(|r| r.local_name.to_lowercase()).collect();
        taken.extend(self.change_children(user_id, branch, &parent).await?.into_iter().map(|c| c.local_name.to_lowercase()));
        Ok(allocate_local_name(name_of(path), &taken))
    }

    /// What Filen has at `path` as far as the cache knows (for recording what a change is based on).
    async fn base_of(&self, user_id: i64, path: &str) -> Result<(bool, Option<i64>, Option<i64>), String> {
        Ok(match self.entry(user_id, path).await? {
            Some(e) => (true, e.size, e.mtime_ms),
            None => (false, None, None),
        })
    }

    /// Makes sure `path` exists as a folder in the branch's view (so something can be put in it).
    /// (This also loads the folder's listing, so what a change is based on is known.)
    async fn require_folder(&self, remote: &impl Remote, user_id: i64, branch: i64, path: &str) -> Result<(), String> {
        self.list_branch(remote, user_id, branch, path, false).await.map(|_| ()).map_err(|_| format!("The folder \"{path}\" doesn't exist here."))
    }

    async fn list_branch(&self, remote: &impl Remote, user_id: i64, branch: i64, path: &str, force: bool) -> Result<Listing, String> {
        self.branch_exists(user_id, branch).await?;
        if self.deleted_in_branch(user_id, branch, path).await? {
            return Err(format!("\"{path}\" was deleted in this branch."));
        }
        let made_here = self.change(user_id, branch, path).await?.is_some_and(|c| c.kind == "mkdir" && c.base_exists == 0);
        let (mut entries, fetched_at, stale) = if made_here || self.inside_new_folder(user_id, branch, path).await? {
            (Vec::new(), self.now(), false)
        } else {
            let base = self.list_account(remote, user_id, path, force).await?;
            (base.entries, base.fetched_at, base.stale)
        };

        for change in self.change_children(user_id, branch, path).await? {
            let name = name_of(&change.path).to_string();
            let locked = entries.iter().any(|e| e.name == name && e.locked); // the account's file under it
            let id = entries.iter().find(|e| e.name == name).and_then(|e| e.id.clone()); // the account's, if there is one
            entries.retain(|e| e.name != name);
            match change.kind.as_str() {
                "delete" => {}
                "mkdir" => entries.push(CacheEntry { id: None, name, is_directory: true, size: None, mtime_ms: Some(change.changed_at as u64), cached: false, locked: false, changed: Some("mkdir".into()) }),
                kind => {
                    let local = self.branch_local_path(user_id, branch, &change.path).await?;
                    let size = std::fs::metadata(&local).map(|m| m.len()).ok();
                    entries.push(CacheEntry { id, name, is_directory: false, size, mtime_ms: Some(change.changed_at as u64), cached: true, locked, changed: Some(kind.into()) });
                }
            }
        }
        sort_entries(&mut entries);
        Ok(Listing { entries, fetched_at, stale })
    }

    /// Whether `path` lies inside a folder that only exists in the branch (Filen has nothing there).
    async fn inside_new_folder(&self, user_id: i64, branch: i64, path: &str) -> Result<bool, String> {
        for prefix in prefixes(path) {
            if self.change(user_id, branch, &prefix).await?.is_some_and(|c| c.kind == "mkdir" && c.base_exists == 0) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    async fn read_branch(&self, remote: &impl Remote, user_id: i64, branch: i64, path: &str) -> Result<Vec<u8>, String> {
        std::fs::read(self.cached_file_branch(remote, user_id, branch, path).await?).map_err(io)
    }

    /// Where the file, as the branch sees it, is on disk: the branch's own copy if it changed the
    /// file, otherwise the account's cached one (fetched first if need be).
    async fn cached_file_branch(&self, remote: &impl Remote, user_id: i64, branch: i64, path: &str) -> Result<PathBuf, String> {
        self.branch_exists(user_id, branch).await?;
        if self.deleted_in_branch(user_id, branch, path).await? {
            return Err(format!("\"{path}\" was deleted in this branch."));
        }
        if self.change(user_id, branch, path).await?.is_some_and(|c| c.kind == "put" || c.kind == "checkout") {
            return self.branch_local_path(user_id, branch, path).await;
        }
        self.cached_file_account(remote, user_id, path).await
    }

    /// Takes the file into the branch without changing it: its content (fetched if need be) is copied
    /// into the branch and recorded as a `checkout` based on the version that was copied, so it is
    /// among the branch's pending changes and its version is checked when the branch is committed. A
    /// file the branch already changed (or checked out) is left as it is.
    pub async fn checkout(&self, remote: &impl Remote, user_id: i64, branch: i64, path: &str) -> Result<(), String> {
        let path = norm_path(path)?;
        let parent = parent_of(&path).ok_or("The root folder can't be checked out.")?;
        let _guard = self.lock(user_id).await;
        self.branch_exists(user_id, branch).await?;
        if self.deleted_in_branch(user_id, branch, &path).await? {
            return Err(format!("\"{path}\" was deleted in this branch."));
        }
        match self.change(user_id, branch, &path).await? {
            Some(c) if c.kind == "put" || c.kind == "checkout" => return Ok(()),
            Some(_) => return Err(format!("\"{path}\" isn't a file.")),
            None => {}
        }
        let source = self.cached_file_account(remote, user_id, &path).await?;
        let local = self.begin_put(remote, user_id, branch, &path, &parent).await?;
        sqlx::query("UPDATE branch_changes SET kind = 'checkout' WHERE user_id = ?1 AND branch = ?2 AND path = ?3")
            .bind(user_id)
            .bind(branch)
            .bind(&path)
            .execute(&self.pool)
            .await
            .map_err(sql)?;
        if let Err(e) = std::fs::copy(&source, &local) {
            sqlx::query("DELETE FROM branch_changes WHERE user_id = ?1 AND branch = ?2 AND path = ?3").bind(user_id).bind(branch).bind(&path).execute(&self.pool).await.map_err(sql)?;
            return Err(io(e));
        }
        Ok(())
    }

    /// Lets go of a checkout that was never changed: the file leaves the branch's pending changes.
    pub async fn release(&self, user_id: i64, branch: i64, path: &str) -> Result<(), String> {
        let path = norm_path(path)?;
        let _guard = self.lock(user_id).await;
        self.branch_exists(user_id, branch).await?;
        let change = self.change(user_id, branch, &path).await?.ok_or("That file isn't checked out in this branch.")?;
        if change.kind != "checkout" {
            return Err("That file has changes in this branch; it can't be let go without losing them.".to_string());
        }
        let local = self.branch_local_path(user_id, branch, &path).await?;
        sqlx::query("DELETE FROM branch_changes WHERE user_id = ?1 AND branch = ?2 AND path = ?3").bind(user_id).bind(branch).bind(&path).execute(&self.pool).await.map_err(sql)?;
        let _ = std::fs::remove_file(local);
        Ok(())
    }

    /// Where the file is on disk, fetched (streamed) into the cache if it isn't there yet — for
    /// callers that copy it somewhere (exporting) rather than hold its bytes. Never shown to a window.
    pub async fn cached_file(&self, remote: &impl Remote, user_id: i64, branch: Option<i64>, path: &str) -> Result<PathBuf, String> {
        let path = norm_path(path)?;
        let _guard = self.lock(user_id).await;
        match branch {
            None => self.cached_file_account(remote, user_id, &path).await,
            Some(branch) => self.cached_file_branch(remote, user_id, branch, &path).await,
        }
    }

    async fn write_branch(&self, remote: &impl Remote, user_id: i64, branch: i64, path: &str, parent: &str, bytes: &[u8]) -> Result<(), String> {
        let local = self.begin_put(remote, user_id, branch, path, parent).await?;
        std::fs::write(local, bytes).map_err(io)
    }

    /// Records that the branch puts a file at path (based on what Filen has there now) and returns
    /// where its content goes, with the folder made.
    async fn begin_put(&self, remote: &impl Remote, user_id: i64, branch: i64, path: &str, parent: &str) -> Result<PathBuf, String> {
        self.branch_exists(user_id, branch).await?;
        self.require_folder(remote, user_id, branch, parent).await?;

        let (base_exists, base_size, base_mtime) = match self.change(user_id, branch, path).await? {
            // Touched before: keep what it was originally based on.
            Some(c) => (c.base_exists, c.base_size, c.base_mtime_ms),
            None => {
                let (exists, size, mtime) = self.base_of(user_id, path).await?;
                (exists as i64, size, mtime)
            }
        };
        let local_name = match self.change(user_id, branch, path).await? {
            Some(c) => c.local_name,
            None => self.branch_local_name(user_id, branch, path).await?,
        };
        sqlx::query(
            "INSERT INTO branch_changes (user_id, branch, path, parent, kind, base_exists, base_size, base_mtime_ms, local_name, changed_at)
             VALUES (?1, ?2, ?3, ?4, 'put', ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(user_id, branch, path) DO UPDATE SET kind = 'put', changed_at = excluded.changed_at",
        )
        .bind(user_id)
        .bind(branch)
        .bind(path)
        .bind(parent)
        .bind(base_exists)
        .bind(base_size)
        .bind(base_mtime)
        .bind(&local_name)
        .bind(self.now())
        .execute(&self.pool)
        .await
        .map_err(sql)?;

        let local = self.branch_local_path(user_id, branch, path).await?;
        if let Some(dir) = local.parent() {
            std::fs::create_dir_all(dir).map_err(io)?;
        }
        Ok(local)
    }

    async fn mkdir_branch(&self, remote: &impl Remote, user_id: i64, branch: i64, path: &str) -> Result<(), String> {
        self.branch_exists(user_id, branch).await?;
        // Make each missing level, from the top.
        for prefix in prefixes(path) {
            let parent = parent_of(&prefix).unwrap_or_else(|| "/".to_string());
            if self.change(user_id, branch, &prefix).await?.is_some_and(|c| c.kind != "delete") {
                continue;
            }
            let existing = if self.change(user_id, branch, &prefix).await?.is_some() || self.inside_new_folder(user_id, branch, &parent).await? {
                None // deleted in the branch (or inside a folder Filen doesn't have): make it anew
            } else {
                self.list_account(remote, user_id, &parent, false).await?.entries.into_iter().find(|e| e.name == name_of(&prefix))
            };
            if let Some(e) = &existing {
                if !e.is_directory {
                    return Err(format!("\"{prefix}\" is a file."));
                }
                continue;
            }
            let local_name = self.branch_local_name(user_id, branch, &prefix).await?;
            sqlx::query(
                "INSERT INTO branch_changes (user_id, branch, path, parent, kind, base_exists, base_size, base_mtime_ms, local_name, changed_at)
                 VALUES (?1, ?2, ?3, ?4, 'mkdir', 0, NULL, NULL, ?5, ?6)
                 ON CONFLICT(user_id, branch, path) DO UPDATE SET kind = 'mkdir', changed_at = excluded.changed_at",
            )
            .bind(user_id)
            .bind(branch)
            .bind(&prefix)
            .bind(&parent)
            .bind(&local_name)
            .bind(self.now())
            .execute(&self.pool)
            .await
            .map_err(sql)?;
            std::fs::create_dir_all(self.branch_local_path(user_id, branch, &prefix).await?).map_err(io)?;
        }
        Ok(())
    }

    async fn remove_branch(&self, remote: &impl Remote, user_id: i64, branch: i64, path: &str) -> Result<(), String> {
        self.branch_exists(user_id, branch).await?;
        let parent = parent_of(path).unwrap_or_else(|| "/".to_string());
        // What is there now, in the branch's view.
        let view = self.list_branch(remote, user_id, branch, &parent, false).await?;
        let shown = view.entries.iter().find(|e| e.name == name_of(path)).ok_or_else(|| format!("\"{path}\" doesn't exist here."))?.clone();

        let own = self.change(user_id, branch, path).await?;
        let local = self.branch_local_path(user_id, branch, path).await?;
        let existed_in_filen = own.as_ref().map(|c| c.base_exists != 0).unwrap_or(true);

        // Forget the branch's changes at and below `path`, and the files it kept for them.
        let below = format!("{path}/");
        sqlx::query("DELETE FROM branch_changes WHERE user_id = ?1 AND branch = ?2 AND (path = ?3 OR substr(path, 1, ?4) = ?5)")
            .bind(user_id)
            .bind(branch)
            .bind(path)
            .bind(below.chars().count() as i64)
            .bind(&below)
            .execute(&self.pool)
            .await
            .map_err(sql)?;
        let _ = std::fs::remove_dir_all(&local).or_else(|_| std::fs::remove_file(&local));

        if existed_in_filen {
            // Filen has it, so committing has to delete it there.
            let (_, size, mtime) = match &own {
                Some(c) => (c.base_exists, c.base_size, c.base_mtime_ms),
                None => (1, shown.size.map(|s| s as i64), shown.mtime_ms.map(|m| m as i64)),
            };
            let local_name = self.branch_local_name(user_id, branch, path).await?;
            sqlx::query(
                "INSERT INTO branch_changes (user_id, branch, path, parent, kind, base_exists, base_size, base_mtime_ms, local_name, changed_at)
                 VALUES (?1, ?2, ?3, ?4, 'delete', 1, ?5, ?6, ?7, ?8)",
            )
            .bind(user_id)
            .bind(branch)
            .bind(path)
            .bind(&parent)
            .bind(size)
            .bind(mtime)
            .bind(local_name)
            .bind(self.now())
            .execute(&self.pool)
            .await
            .map_err(sql)?;
        }
        Ok(())
    }

    async fn rename_branch(&self, remote: &impl Remote, user_id: i64, branch: i64, from: &str, to: &str) -> Result<(), String> {
        let from_parent = parent_of(from).unwrap_or_else(|| "/".to_string());
        let shown = self
            .list_branch(remote, user_id, branch, &from_parent, false)
            .await?
            .entries
            .into_iter()
            .find(|e| e.name == name_of(from))
            .ok_or_else(|| format!("\"{from}\" doesn't exist here."))?;
        if shown.is_directory {
            return Err("Folders can't be renamed inside a branch — rename them on the main view instead.".to_string());
        }
        let to_parent = parent_of(to).unwrap_or_else(|| "/".to_string());
        if self.list_branch(remote, user_id, branch, &to_parent, false).await?.entries.iter().any(|e| e.name == name_of(to)) {
            return Err(format!("\"{to}\" already exists."));
        }
        let bytes = self.read_branch(remote, user_id, branch, from).await?;
        self.write_branch(remote, user_id, branch, to, &to_parent, &bytes).await?;
        self.remove_branch(remote, user_id, branch, from).await
    }

    /// Applies the branch's changes to Filen and deletes the branch. If Filen has changed since the
    /// branch touched something, nothing is applied and the conflicts are reported — unless `force`.
    /// (A commit that fails halfway leaves the branch as it was; committing again is safe, since making
    /// a folder that exists, writing a file and deleting something already gone all just succeed.)
    pub async fn commit_branch(&self, remote: &impl Remote, user_id: i64, branch: i64, force: bool) -> Result<CommitReport, String> {
        let _guard = self.lock(user_id).await;
        self.branch_exists(user_id, branch).await?;
        let name = self.branch_name(user_id, branch).await?;
        let mut changes = self.changes(user_id, branch).await?;
        let depth = |c: &ChangeRow| c.path.matches('/').count();

        // Filen as it is now — asked directly, one listing per folder involved (the cache would show a
        // locked file as it was).
        let mut current: HashMap<String, Option<Vec<RemoteEntry>>> = HashMap::new();
        let mut conflicts = Vec::new();
        for change in &changes {
            let parent = parent_of(&change.path).unwrap_or_else(|| "/".to_string());
            if !current.contains_key(&parent) {
                current.insert(parent.clone(), remote.readdir(&parent).await.ok());
            }
            let now_entry = current[&parent].as_ref().and_then(|entries| entries.iter().find(|e| e.name == name_of(&change.path)));
            let same_as_base = |e: &RemoteEntry| e.size.map(|s| s as i64) == change.base_size && e.mtime_ms.map(|m| m as i64) == change.base_mtime_ms;
            let problem = match (change.kind.as_str(), change.base_exists != 0, now_entry) {
                ("mkdir", _, Some(e)) if !e.is_directory => Some("a file with that name exists in Filen now"),
                ("checkout", _, None) => Some("it was deleted in Filen after it was checked out"),
                ("checkout", _, Some(e)) if !same_as_base(e) => Some("it changed in Filen after it was checked out"),
                ("put", false, Some(_)) => Some("it was created in Filen after the branch was"),
                ("put", true, None) => Some("it was deleted in Filen after the branch changed it"),
                ("put", true, Some(e)) if !same_as_base(e) => Some("it changed in Filen after the branch did"),
                ("delete", true, Some(e)) if !same_as_base(e) => Some("it changed in Filen after the branch deleted it"),
                _ => None,
            };
            if let Some(problem) = problem {
                conflicts.push(format!("{}: {problem}", change.path));
            }
        }
        if !conflicts.is_empty() && !force {
            return Ok(CommitReport { committed: false, applied: 0, conflicts });
        }

        // A checkout changes nothing: it only had its version verified. Folders first (top down), then
        // files, then deletions (bottom up).
        changes.retain(|c| c.kind != "checkout");
        changes.sort_by_key(|c| (match c.kind.as_str() { "mkdir" => 0, "put" => 1, _ => 2 }, if c.kind == "delete" { -(depth(c) as i64) } else { depth(c) as i64 }));
        let mut applied = 0;
        let mut touched: Vec<String> = Vec::new();
        for change in &changes {
            match change.kind.as_str() {
                "mkdir" => remote.mkdir(&change.path).await?,
                "put" => {
                    let local = self.branch_local_path(user_id, branch, &change.path).await?;
                    upload_local_file(remote, &change.path, &local).await?;
                }
                _ => {
                    let parent = parent_of(&change.path).unwrap_or_else(|| "/".to_string());
                    let still_there = current[&parent].as_ref().is_none_or(|entries| entries.iter().any(|e| e.name == name_of(&change.path)));
                    if still_there {
                        remote.remove(&change.path).await?;
                    }
                }
            }
            applied += 1;
            touched.push(change.path.clone());
        }

        // Filen changed, so what's cached about it is out of date. (A file that was deleted has no lock
        // left to keep; one that was written keeps its lock, which then holds the version fetched next.)
        for change in changes.iter().filter(|c| c.kind == "delete") {
            self.drop_locks_below(user_id, &change.path).await?;
        }
        for path in &touched {
            self.drop_subtree(user_id, path).await?;
            let mut affected: Vec<String> = prefixes(path).iter().filter_map(|p| parent_of(p)).collect();
            affected.dedup();
            self.invalidate_listings(user_id, &affected).await?;
        }
        self.delete_branch_files_and_rows(user_id, branch, &name).await?;
        Ok(CommitReport { committed: true, applied, conflicts })
    }
}

/// A file being uploaded to the account (or into a branch) a piece at a time — from the webview's
/// pieces or from a file on disk. Each piece goes to Filen and, at the same moment, to a temporary
/// file that becomes the cached copy when the upload is finished; nothing is held in memory but the
/// piece. See Cache::upload_begin / upload_push / upload_finish. Dropping an unfinished job deletes
/// its temporary file.
pub struct UploadJob<U> {
    user_id: i64,
    branch: Option<i64>,
    path: String,
    parent: String,
    /// Filen's side of it — none for an upload into a branch, which stays local until it is committed.
    remote: Option<U>,
    tmp: PathBuf,
    file: Option<std::fs::File>,
    written: u64,
}

impl<U> UploadJob<U> {
    /// How many bytes have been pushed so far.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn written(&self) -> u64 {
        self.written
    }
}

impl<U> Drop for UploadJob<U> {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = std::fs::remove_file(&self.tmp);
    }
}

impl Cache {
    /// Where an account's uploads are assembled (see UPLOADS_FOLDER).
    async fn uploads_root(&self, user_id: i64) -> Result<PathBuf, String> {
        let content = self.content_root(user_id).await?;
        Ok(content.parent().ok_or("The account's folder is missing.")?.join(UPLOADS_FOLDER))
    }

    /// Starts uploading a file to path — in the account itself, or in a branch.
    pub async fn upload_begin<R: Remote>(&self, remote: &R, user_id: i64, branch: Option<i64>, path: &str) -> Result<UploadJob<R::Upload>, String> {
        let path = norm_path(path)?;
        let parent = parent_of(&path).ok_or("The root folder can't be written to.")?;
        let _guard = self.lock(user_id).await;
        let upstream = match branch {
            Some(branch) => {
                self.branch_exists(user_id, branch).await?;
                self.require_folder(remote, user_id, branch, &parent).await?;
                None
            }
            None => {
                self.list_account(remote, user_id, &parent, false).await?;
                Some(remote.begin_upload(&path).await?)
            }
        };
        let dir = self.uploads_root(user_id).await?;
        std::fs::create_dir_all(&dir).map_err(io)?;
        let tmp = dir.join(format!("{}.part", uuid::Uuid::new_v4().simple()));
        let file = std::fs::File::create(&tmp).map_err(io)?;
        Ok(UploadJob { user_id, branch, path, parent, remote: upstream, tmp, file: Some(file), written: 0 })
    }

    /// Adds the next piece of the file.
    pub async fn upload_push<R: Remote>(&self, remote: &R, job: &mut UploadJob<R::Upload>, bytes: &[u8]) -> Result<(), String> {
        use std::io::Write;
        if let Some(upload) = job.remote.as_mut() {
            remote.upload_bytes(upload, bytes).await?;
        }
        job.file.as_mut().ok_or("That upload is already finished.")?.write_all(bytes).map_err(io)?;
        job.written += bytes.len() as u64;
        Ok(())
    }

    /// Finishes the upload: the file now exists (in Filen, or in the branch), and what was assembled
    /// on disk is its cached copy.
    pub async fn upload_finish<R: Remote>(&self, remote: &R, job: UploadJob<R::Upload>) -> Result<(), String> {
        let _guard = self.lock(job.user_id).await;
        // As for a write: a locked file stays locked, on the version that was just uploaded.
        let (user_id, path) = (job.user_id, job.path.clone());
        let was_locked = job.branch.is_none() && self.is_locked(user_id, &path).await?;
        if was_locked {
            self.set_lock_row(user_id, &path, false).await?;
        }
        let done = self.finish_upload_job(remote, job).await;
        if was_locked {
            self.set_lock_row(user_id, &path, true).await?;
        }
        done
    }

    async fn finish_upload_job<R: Remote>(&self, remote: &R, mut job: UploadJob<R::Upload>) -> Result<(), String> {
        drop(job.file.take());
        let (user_id, path, parent) = (job.user_id, job.path.clone(), job.parent.clone());
        let local = match job.branch {
            Some(branch) => self.begin_put(remote, user_id, branch, &path, &parent).await?,
            None => {
                let upstream = job.remote.take().ok_or("That upload is already finished.")?;
                remote.finish_upload(upstream).await?;
                self.list_account(remote, user_id, &parent, true).await?; // Filen's own idea of the new file
                let local = self.mirror_path(user_id, &path).await?;
                if let Some(dir) = local.parent() {
                    std::fs::create_dir_all(dir).map_err(io)?;
                }
                local
            }
        };
        if std::fs::rename(&job.tmp, &local).is_err() {
            std::fs::copy(&job.tmp, &local).map_err(io)?;
        }
        if job.branch.is_none() {
            self.mark_cached(user_id, &path).await?;
        }
        Ok(())
    }

    /// Uploads the file at src (a real file on disk — the caller has judged it may be read) to path,
    /// piece by piece.
    pub async fn upload_from_file<R: Remote>(&self, remote: &R, user_id: i64, branch: Option<i64>, path: &str, src: &Path) -> Result<(), String> {
        use std::io::Read;
        let mut input = std::fs::File::open(src).map_err(io)?;
        let mut job = self.upload_begin(remote, user_id, branch, path).await?;
        let mut piece = vec![0u8; READ_PIECE];
        loop {
            let n = input.read(&mut piece).map_err(io)?;
            if n == 0 {
                break;
            }
            self.upload_push(remote, &mut job, &piece[..n]).await?;
        }
        self.upload_finish(remote, job).await
    }
}

/// Puts bytes (small ones — the caller has them all) at path in Filen.
async fn write_remote<R: Remote>(remote: &R, path: &str, bytes: &[u8]) -> Result<(), String> {
    let mut upload = remote.begin_upload(path).await?;
    remote.upload_bytes(&mut upload, bytes).await?;
    remote.finish_upload(upload).await
}

/// Uploads the file at src to path in Filen, piece by piece.
async fn upload_local_file<R: Remote>(remote: &R, path: &str, src: &Path) -> Result<(), String> {
    use std::io::Read;
    let mut input = std::fs::File::open(src).map_err(io)?;
    let mut upload = remote.begin_upload(path).await?;
    let mut piece = vec![0u8; READ_PIECE];
    loop {
        let n = input.read(&mut piece).map_err(io)?;
        if n == 0 {
            break;
        }
        remote.upload_bytes(&mut upload, &piece[..n]).await?;
    }
    remote.finish_upload(upload).await
}

pub mod local_branches;

/// Folders first, then by name (case-insensitively).
fn sort_entries(entries: &mut [CacheEntry]) {
    entries.sort_by(|a, b| b.is_directory.cmp(&a.is_directory).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};

    /// An in-memory "Filen": a map from path to file bytes (folders are paths ending in `/`).
    #[derive(Default)]
    struct MemoryRemote {
        files: StdMutex<HashMap<String, Vec<u8>>>,
        folders: StdMutex<HashSet<String>>,
        mtime: AtomicI64,
        offline: AtomicBool,
        reads: AtomicUsize,
        listings: AtomicUsize,
    }

    impl MemoryRemote {
        fn new() -> Self {
            let remote = Self::default();
            remote.folders.lock().unwrap().insert("/".to_string());
            remote
        }
        fn put(&self, path: &str, content: &str) {
            let mut folder = String::new();
            for part in path.split('/').filter(|p| !p.is_empty()).collect::<Vec<_>>().split_last().map(|(_, dirs)| dirs.to_vec()).unwrap_or_default() {
                folder = format!("{folder}/{part}");
                self.folders.lock().unwrap().insert(folder.clone());
            }
            self.files.lock().unwrap().insert(path.to_string(), content.as_bytes().to_vec());
            self.mtime.fetch_add(1, Ordering::SeqCst);
        }
        fn text(&self, path: &str) -> Option<String> {
            self.files.lock().unwrap().get(path).map(|b| String::from_utf8_lossy(b).into_owned())
        }
        fn has_folder(&self, path: &str) -> bool {
            self.folders.lock().unwrap().contains(path)
        }
        fn check_online(&self) -> Result<(), String> {
            if self.offline.load(Ordering::SeqCst) { Err("offline".into()) } else { Ok(()) }
        }
    }

    impl Remote for MemoryRemote {
        type Upload = (String, Vec<u8>);

        async fn readdir(&self, path: &str) -> Result<Vec<RemoteEntry>, String> {
            self.check_online()?;
            self.listings.fetch_add(1, Ordering::SeqCst);
            if !self.folders.lock().unwrap().contains(path) {
                return Err(format!("{path} not found"));
            }
            let prefix = if path == "/" { "/".to_string() } else { format!("{path}/") };
            let mut out = Vec::new();
            for (file, bytes) in self.files.lock().unwrap().iter() {
                if let Some(rest) = file.strip_prefix(&prefix) {
                    if !rest.contains('/') {
                        out.push(RemoteEntry { id: Some(format!("id:{file}")), name: rest.to_string(), is_directory: false, size: Some(bytes.len() as u64), mtime_ms: Some(bytes.iter().map(|b| *b as u64).sum::<u64>() + 1000) });
                    }
                }
            }
            for folder in self.folders.lock().unwrap().iter() {
                if let Some(rest) = folder.strip_prefix(&prefix) {
                    if !rest.is_empty() && !rest.contains('/') {
                        out.push(RemoteEntry { id: Some(format!("id:{folder}")), name: rest.to_string(), is_directory: true, size: None, mtime_ms: None });
                    }
                }
            }
            Ok(out)
        }
        async fn download(&self, path: &str, sink: &mut (dyn FnMut(&[u8]) -> Result<(), String> + Send)) -> Result<(), String> {
            self.check_online()?;
            self.reads.fetch_add(1, Ordering::SeqCst);
            let bytes = self.files.lock().unwrap().get(path).cloned().ok_or_else(|| format!("{path} not found"))?;
            for piece in bytes.chunks(3) {
                sink(piece)?; // small pieces, like Filen's chunks are small compared with a big file
            }
            Ok(())
        }
        async fn begin_upload(&self, path: &str) -> Result<Self::Upload, String> {
            self.check_online()?;
            Ok((path.to_string(), Vec::new()))
        }
        async fn upload_bytes(&self, upload: &mut Self::Upload, bytes: &[u8]) -> Result<(), String> {
            self.check_online()?;
            upload.1.extend_from_slice(bytes);
            Ok(())
        }
        async fn finish_upload(&self, upload: Self::Upload) -> Result<(), String> {
            self.check_online()?;
            self.put(&upload.0, &String::from_utf8_lossy(&upload.1));
            Ok(())
        }
        async fn mkdir(&self, path: &str) -> Result<(), String> {
            self.check_online()?;
            let mut folder = String::new();
            for part in path.split('/').filter(|p| !p.is_empty()) {
                folder = format!("{folder}/{part}");
                self.folders.lock().unwrap().insert(folder.clone());
            }
            Ok(())
        }
        async fn remove(&self, path: &str) -> Result<(), String> {
            self.check_online()?;
            let below = format!("{path}/");
            self.files.lock().unwrap().retain(|f, _| f != path && !f.starts_with(&below));
            self.folders.lock().unwrap().retain(|f| f != path && !f.starts_with(&below));
            Ok(())
        }
        async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
            self.check_online()?;
            let content = self.files.lock().unwrap().remove(from).ok_or("not a file in this fake")?;
            self.put(to, &String::from_utf8_lossy(&content));
            Ok(())
        }
    }

    struct Fixture {
        cache: Cache,
        remote: MemoryRemote,
        clock: Arc<AtomicI64>,
        base: PathBuf,
    }

    impl Fixture {
        async fn new(name: &str) -> Self {
            let base = std::env::temp_dir().join(format!("csdrive-files-cache-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(&base).unwrap();
            let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
            let clock = Arc::new(AtomicI64::new(1_000_000));
            let clock_for_cache = clock.clone();
            let cache = Cache::with_pool(pool, base.clone(), Arc::new(move || clock_for_cache.load(Ordering::SeqCst))).await.unwrap();
            cache.ensure_account(7, "me@example.com").await.unwrap();
            Self { cache, remote: MemoryRemote::new(), clock, base }
        }
        fn advance(&self, secs: i64) {
            self.clock.fetch_add(secs * 1000, Ordering::SeqCst);
        }
        fn names(listing: &Listing) -> Vec<String> {
            listing.entries.iter().map(|e| e.name.clone()).collect()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    fn run<F: Future<Output = ()>>(future: F) {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn a_listing_carries_filens_ids_and_they_follow_the_file_when_it_is_replaced() {
        run(async {
            let f = Fixture::new("ids").await;
            f.remote.put("/d/a.txt", "one");
            f.remote.mkdir("/d/sub").await.unwrap();
            let listed = f.cache.list(&f.remote, 7, None, "/d", false).await.unwrap().entries;
            let ids: Vec<(&str, Option<&str>)> = listed.iter().map(|e| (e.name.as_str(), e.id.as_deref())).collect();
            assert_eq!(ids, [("sub", Some("id:/d/sub")), ("a.txt", Some("id:/d/a.txt"))], "folders and files both");
            // The same listing, later, from the cache's own table — the ids were stored.
            let again = f.cache.list(&f.remote, 7, None, "/d", false).await.unwrap().entries;
            assert_eq!(listed, again);
            // In a branch: what the account has keeps its id even when the branch changed it; what the branch made has none.
            let branch = f.cache.create_branch(7, "b").await.unwrap();
            f.cache.write(&f.remote, 7, Some(branch.index), "/d/a.txt", b"changed").await.unwrap();
            f.cache.write(&f.remote, 7, Some(branch.index), "/d/new.txt", b"new").await.unwrap();
            let seen = f.cache.list(&f.remote, 7, Some(branch.index), "/d", false).await.unwrap().entries;
            let of = |name: &str| seen.iter().find(|e| e.name == name).unwrap().id.clone();
            assert_eq!(of("a.txt").as_deref(), Some("id:/d/a.txt"));
            assert_eq!(of("new.txt"), None);
        });
    }

    #[test]
    fn a_cache_made_before_ids_gets_the_column_and_fills_it_on_the_next_listing() {
        run(async {
            let base = std::env::temp_dir().join(format!("csdrive-files-cache-oldids-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(&base).unwrap();
            let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
            // The table as it was before `remote_id`, with a row in it.
            sqlx::query("CREATE TABLE entries (user_id INTEGER NOT NULL, path TEXT NOT NULL, parent TEXT NOT NULL, name TEXT NOT NULL, is_dir INTEGER NOT NULL, size INTEGER, mtime_ms INTEGER, local_name TEXT NOT NULL, fetched_at INTEGER NOT NULL, content_at INTEGER, PRIMARY KEY (user_id, path))")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO entries VALUES (7, '/d/a.txt', '/d', 'a.txt', 0, 3, 1003, 'a.txt', 5, NULL)").execute(&pool).await.unwrap();
            let clock = Arc::new(AtomicI64::new(1_000_000));
            let for_cache = clock.clone();
            let cache = Cache::with_pool(pool, base.clone(), Arc::new(move || for_cache.load(Ordering::SeqCst))).await.unwrap();
            cache.ensure_account(7, "me@example.com").await.unwrap();
            let remote = MemoryRemote::new();
            remote.put("/d/a.txt", "one");
            let listed = cache.list(&remote, 7, None, "/d", true).await.unwrap().entries;
            assert_eq!(listed[0].id.as_deref(), Some("id:/d/a.txt"), "the old row got its id when the folder was fetched again");
            let _ = std::fs::remove_dir_all(&base);
        });
    }

    #[test]
    fn a_locked_file_is_frozen_until_it_is_unlocked() {
        run(async {
            let f = Fixture::new("lock").await;
            f.remote.put("/d/a.txt", "one");
            f.remote.put("/d/b.txt", "bee");
            f.cache.set_locked(&f.remote, 7, "/d/a.txt", true).await.unwrap();
            assert_eq!(f.remote.reads.load(Ordering::SeqCst), 1, "locking fetches the file, so there is a copy to keep");
            let entries = f.cache.list(&f.remote, 7, None, "/d", false).await.unwrap().entries;
            assert!(entries[0].locked && entries[0].cached && !entries[1].locked, "{entries:?}");

            // Changed in Filen and past the interval: the unlocked file follows, the locked one doesn't.
            f.remote.put("/d/a.txt", "one, changed elsewhere");
            f.remote.put("/d/b.txt", "bee, changed elsewhere");
            f.advance(4000);
            assert_eq!(f.cache.read(&f.remote, 7, None, "/d/a.txt").await.unwrap(), b"one");
            assert_eq!(f.cache.read(&f.remote, 7, None, "/d/b.txt").await.unwrap(), b"bee, changed elsewhere");
            let listed = f.cache.list(&f.remote, 7, None, "/d", true).await.unwrap().entries;
            assert_eq!((listed[0].size, listed[0].locked), (Some(3), true), "its metadata is frozen too: {listed:?}");

            // Offline, long after: a locked file opens without asking anybody.
            f.remote.offline.store(true, Ordering::SeqCst);
            f.advance(999_999);
            assert_eq!(f.cache.read(&f.remote, 7, None, "/d/a.txt").await.unwrap(), b"one");
            f.remote.offline.store(false, Ordering::SeqCst);

            // Deleted in Filen: still here, frozen — and clearing the cache keeps it (and only it).
            f.remote.remove("/d/a.txt").await.unwrap();
            f.advance(4000);
            assert_eq!(Fixture::names(&f.cache.list(&f.remote, 7, None, "/d", true).await.unwrap()), ["a.txt", "b.txt"]);
            f.cache.clear(7).await.unwrap();
            assert!(f.base.join("a/001/c/d/a.txt").is_file() && !f.base.join("a/001/c/d/b.txt").exists());
            f.remote.offline.store(true, Ordering::SeqCst);
            assert_eq!(f.cache.read(&f.remote, 7, None, "/d/a.txt").await.unwrap(), b"one", "after the clear, offline");
            f.remote.offline.store(false, Ordering::SeqCst);

            // Unlocked, it is an ordinary cached file again, and Filen's deletion catches up with it.
            f.cache.set_locked(&f.remote, 7, "/d/a.txt", false).await.unwrap();
            assert_eq!(Fixture::names(&f.cache.list(&f.remote, 7, None, "/d", true).await.unwrap()), ["b.txt"]);
            assert!(f.cache.read(&f.remote, 7, None, "/d/a.txt").await.is_err());
            assert!(f.cache.set_locked(&f.remote, 7, "/d/nothing.txt", true).await.is_err(), "only a file Filen has can be locked");
        });
    }

    #[test]
    fn hard_refresh_fetches_one_item_again_whatever_the_interval_says() {
        run(async {
            let f = Fixture::new("hard").await;
            f.remote.put("/d/a.txt", "one");
            f.remote.put("/d/b.txt", "bee");
            f.remote.put("/d/sub/c.txt", "sea");
            assert_eq!(f.cache.read(&f.remote, 7, None, "/d/a.txt").await.unwrap(), b"one");
            assert_eq!(f.cache.read(&f.remote, 7, None, "/d/b.txt").await.unwrap(), b"bee");
            f.cache.list(&f.remote, 7, None, "/d/sub", false).await.unwrap();

            // Changed in Filen, inside the interval: the cache still shows what it has.
            f.remote.put("/d/a.txt", "one, changed elsewhere");
            f.remote.put("/d/b.txt", "bee, changed elsewhere");
            assert_eq!(f.cache.read(&f.remote, 7, None, "/d/a.txt").await.unwrap(), b"one");

            // A hard refresh of one file: that file is fetched again (with its folder's listing, which the other files learn from).
            f.cache.hard_refresh(&f.remote, 7, "/d/a.txt").await.unwrap();
            assert_eq!(f.cache.read(&f.remote, 7, None, "/d/a.txt").await.unwrap(), b"one, changed elsewhere");
            assert_eq!(f.cache.read(&f.remote, 7, None, "/d/b.txt").await.unwrap(), b"bee, changed elsewhere", "the folder's listing is one: its other files learn of their changes too");

            // A hard refresh of a folder: its listing is fetched again, and what is below it is looked at again when it is opened.
            f.remote.put("/d/new.txt", "new");
            f.remote.put("/d/sub/e.txt", "eee");
            let before = f.remote.listings.load(Ordering::SeqCst);
            f.cache.hard_refresh(&f.remote, 7, "/d").await.unwrap();
            assert!(f.remote.listings.load(Ordering::SeqCst) > before);
            assert_eq!(Fixture::names(&f.cache.list(&f.remote, 7, None, "/d", false).await.unwrap()), ["sub", "a.txt", "b.txt", "new.txt"]);
            assert_eq!(Fixture::names(&f.cache.list(&f.remote, 7, None, "/d/sub", false).await.unwrap()), ["c.txt", "e.txt"], "below it too");
            assert!(f.cache.hard_refresh(&f.remote, 7, "/d/none.txt").await.is_err(), "nothing to refresh");
        });
    }

    #[test]
    fn a_locked_file_refuses_a_hard_refresh_and_survives_clearing_an_item() {
        run(async {
            let f = Fixture::new("hard-lock").await;
            f.remote.put("/d/a.txt", "one");
            f.remote.put("/d/b.txt", "bee");
            f.cache.set_locked(&f.remote, 7, "/d/a.txt", true).await.unwrap();
            f.cache.read(&f.remote, 7, None, "/d/b.txt").await.unwrap();
            assert!(f.cache.hard_refresh(&f.remote, 7, "/d/a.txt").await.unwrap_err().contains("locked"));
            f.cache.clear_item(7, "/d").await.unwrap();
            assert!(f.base.join("a/001/c/d/a.txt").is_file(), "the locked file stays");
            assert!(!f.base.join("a/001/c/d/b.txt").exists(), "the rest of the folder's content goes");
            assert_eq!(f.cache.read(&f.remote, 7, None, "/d/b.txt").await.unwrap(), b"bee", "and is fetched again when needed");
        });
    }

    #[test]
    fn clearing_one_item_drops_its_content_and_thumbnails_and_nothing_else() {
        run(async {
            let f = Fixture::new("clear-item").await;
            f.remote.put("/d/a.txt", "one");
            f.remote.put("/d/b.txt", "bee");
            f.remote.put("/e/c.txt", "sea");
            for p in ["/d/a.txt", "/d/b.txt", "/e/c.txt"] {
                f.cache.read(&f.remote, 7, None, p).await.unwrap();
                f.cache.thumb_put(7, None, p, 5, 3, b"jpeg").await.unwrap();
            }
            f.cache.clear_item(7, "/d/a.txt").await.unwrap();
            assert!(!f.base.join("a/001/c/d/a.txt").exists() && f.base.join("a/001/c/d/b.txt").is_file());
            assert!(f.cache.thumb_get(7, None, "/d/a.txt", 5, 3).await.unwrap().is_none() && f.cache.thumb_get(7, None, "/d/b.txt", 5, 3).await.unwrap().is_some());
            let listed = f.cache.list(&f.remote, 7, None, "/d", false).await.unwrap().entries;
            assert!(!listed.iter().find(|e| e.name == "a.txt").unwrap().cached, "still listed, no longer cached");

            f.cache.clear_item(7, "/d").await.unwrap();
            assert!(!f.base.join("a/001/c/d/b.txt").exists() && f.base.join("a/001/c/e/c.txt").is_file(), "a folder clears itself and what is below it, not its neighbours");
            assert!(f.cache.thumb_get(7, None, "/d/b.txt", 5, 3).await.unwrap().is_none() && f.cache.thumb_get(7, None, "/e/c.txt", 5, 3).await.unwrap().is_some());
        });
    }

    #[test]
    fn a_locked_file_stays_locked_when_written_and_forgets_it_when_deleted() {
        run(async {
            let f = Fixture::new("lock-write").await;
            f.remote.put("/a.txt", "one");
            f.cache.set_locked(&f.remote, 7, "/a.txt", true).await.unwrap();

            f.cache.write(&f.remote, 7, None, "/a.txt", b"two").await.unwrap();
            assert_eq!(f.remote.text("/a.txt").as_deref(), Some("two"));
            let entry = f.cache.list(&f.remote, 7, None, "/", false).await.unwrap().entries.remove(0);
            assert_eq!((entry.locked, entry.size), (true, Some(3)), "still locked, on what was written: {entry:?}");

            f.remote.put("/a.txt", "changed elsewhere");
            f.advance(4000);
            assert_eq!(f.cache.read(&f.remote, 7, None, "/a.txt").await.unwrap(), b"two", "and frozen on it");

            f.cache.remove(&f.remote, 7, None, "/a.txt").await.unwrap();
            f.cache.write(&f.remote, 7, None, "/a.txt", b"again").await.unwrap();
            assert!(!f.cache.list(&f.remote, 7, None, "/", false).await.unwrap().entries[0].locked, "a deleted file's lock is gone");
        });
    }

    #[test]
    fn a_locked_file_is_the_same_frozen_copy_in_every_branch() {
        run(async {
            let f = Fixture::new("lock-branch").await;
            f.remote.put("/a.txt", "one");
            let branch = f.cache.create_branch(7, "b").await.unwrap();
            let b = Some(branch.index);
            f.cache.set_locked(&f.remote, 7, "/a.txt", true).await.unwrap();
            f.remote.put("/a.txt", "changed elsewhere");
            f.advance(4000);
            assert_eq!(f.cache.read(&f.remote, 7, b, "/a.txt").await.unwrap(), b"one");
            assert!(f.cache.list(&f.remote, 7, b, "/", true).await.unwrap().entries[0].locked);
            // A file the branch changed still says so, and its lock is the account file's.
            f.cache.write(&f.remote, 7, b, "/a.txt", b"mine").await.unwrap();
            let entry = f.cache.list(&f.remote, 7, b, "/", false).await.unwrap().entries.remove(0);
            assert_eq!((entry.locked, entry.changed.as_deref()), (true, Some("put")));
        });
    }

    #[test]
    fn a_version_is_checked_against_filen_itself_even_for_a_locked_file() {
        run(async {
            let f = Fixture::new("version").await;
            f.remote.put("/a.txt", "v1");
            f.cache.read(&f.remote, 7, None, "/a.txt").await.unwrap();
            let v1 = f.cache.version(7, None, "/a.txt").await.unwrap();
            assert!(v1.exists && v1.size == Some(2));
            assert!(f.cache.check_version(&f.remote, 7, None, "/a.txt", &v1).await.unwrap().up_to_date);
            assert!(!f.cache.version(7, None, "/nothing.txt").await.unwrap().exists);

            f.cache.set_locked(&f.remote, 7, "/a.txt", true).await.unwrap();
            f.remote.put("/a.txt", "v2, from somewhere else");
            let check = f.cache.check_version(&f.remote, 7, None, "/a.txt", &v1).await.unwrap();
            assert!(!check.up_to_date, "the lock freezes the cache, not the truth");
            assert!(check.problem.as_deref().unwrap().contains("newer"), "{check:?}");
            assert_eq!(check.current.size, Some(23));

            f.remote.remove("/a.txt").await.unwrap();
            let gone = f.cache.check_version(&f.remote, 7, None, "/a.txt", &v1).await.unwrap();
            assert!(!gone.up_to_date && !gone.current.exists && gone.problem.as_deref().unwrap().contains("deleted"), "{gone:?}");
            // A file that didn't exist when the work began and does now.
            f.remote.put("/new.txt", "someone's");
            assert!(!f.cache.check_version(&f.remote, 7, None, "/new.txt", &FileVersion { exists: false, size: None, mtime_ms: None }).await.unwrap().up_to_date);

            f.remote.offline.store(true, Ordering::SeqCst);
            assert!(f.cache.check_version(&f.remote, 7, None, "/new.txt", &v1).await.is_err(), "it can't be verified offline, and says so");
        });
    }

    #[test]
    fn a_checked_out_file_is_a_pending_change_that_is_verified_but_never_applied() {
        run(async {
            let f = Fixture::new("checkout").await;
            f.remote.put("/docs/a.txt", "one");
            f.remote.put("/docs/b.txt", "two");
            let branch = f.cache.create_branch(7, "work").await.unwrap();
            let b = Some(branch.index);

            f.cache.checkout(&f.remote, 7, branch.index, "/docs/a.txt").await.unwrap();
            f.cache.checkout(&f.remote, 7, branch.index, "/docs/a.txt").await.unwrap(); // already: nothing happens
            assert!(f.cache.checkout(&f.remote, 7, branch.index, "/docs/missing.txt").await.is_err());
            assert!(f.cache.checkout(&f.remote, 7, branch.index, "/docs").await.is_err(), "a folder isn't checked out");
            let changes = f.cache.branch_changes(7, branch.index).await.unwrap();
            assert_eq!(changes.len(), 1);
            assert_eq!((changes[0].path.as_str(), changes[0].kind.as_str(), changes[0].is_new), ("/docs/a.txt", "checkout", false));
            assert_eq!(f.cache.branches(7).await.unwrap()[0].changes, 1);
            let view = f.cache.list(&f.remote, 7, b, "/docs", false).await.unwrap();
            assert_eq!(view.entries.iter().find(|e| e.name == "a.txt").unwrap().changed.as_deref(), Some("checkout"));
            assert!(view.entries.iter().find(|e| e.name == "b.txt").unwrap().changed.is_none());
            assert_eq!(f.cache.read(&f.remote, 7, b, "/docs/a.txt").await.unwrap(), b"one", "read from the branch's own copy");
            let base = f.cache.version(7, b, "/docs/a.txt").await.unwrap();
            assert_eq!(base, f.cache.version(7, None, "/docs/a.txt").await.unwrap(), "based on the version that was checked out");

            // Committing an unchanged checkout applies nothing, and the branch goes.
            let report = f.cache.commit_branch(&f.remote, 7, branch.index, false).await.unwrap();
            assert!(report.committed && report.applied == 0 && report.conflicts.is_empty(), "{report:?}");
            assert_eq!(f.remote.text("/docs/a.txt").as_deref(), Some("one"));
            assert!(f.cache.branches(7).await.unwrap().is_empty());

            // Filen moved on after the checkout: the commit says so, and letting go of it clears the way.
            let second = f.cache.create_branch(7, "second").await.unwrap();
            f.cache.checkout(&f.remote, 7, second.index, "/docs/a.txt").await.unwrap();
            f.remote.put("/docs/a.txt", "one, changed elsewhere");
            let report = f.cache.commit_branch(&f.remote, 7, second.index, false).await.unwrap();
            assert!(!report.committed && report.conflicts.len() == 1 && report.conflicts[0].contains("checked out"), "{report:?}");
            f.cache.release(7, second.index, "/docs/a.txt").await.unwrap();
            assert!(f.cache.branch_changes(7, second.index).await.unwrap().is_empty());
            assert!(f.cache.release(7, second.index, "/docs/a.txt").await.is_err());
            assert!(f.cache.commit_branch(&f.remote, 7, second.index, false).await.unwrap().committed);

            // Deleted in Filen after the checkout is a conflict too.
            let third = f.cache.create_branch(7, "third").await.unwrap();
            f.cache.checkout(&f.remote, 7, third.index, "/docs/b.txt").await.unwrap();
            f.remote.remove("/docs/b.txt").await.unwrap();
            let report = f.cache.commit_branch(&f.remote, 7, third.index, false).await.unwrap();
            assert!(!report.committed && report.conflicts[0].contains("deleted"), "{report:?}");
        });
    }

    #[test]
    fn editing_a_checked_out_file_keeps_its_base_and_the_person_can_rebase_onto_filen() {
        run(async {
            let f = Fixture::new("checkout-edit").await;
            f.remote.put("/a.txt", "one");
            let branch = f.cache.create_branch(7, "edit").await.unwrap();
            let b = Some(branch.index);
            f.cache.checkout(&f.remote, 7, branch.index, "/a.txt").await.unwrap();
            let base = f.cache.version(7, b, "/a.txt").await.unwrap();

            f.cache.write(&f.remote, 7, b, "/a.txt", b"one, edited").await.unwrap();
            let changes = f.cache.branch_changes(7, branch.index).await.unwrap();
            assert_eq!((changes.len(), changes[0].kind.as_str()), (1, "put"), "editing turns the checkout into a change");
            assert_eq!(f.cache.version(7, b, "/a.txt").await.unwrap(), base, "but it is still based on what was checked out");
            assert!(f.cache.release(7, branch.index, "/a.txt").await.is_err());
            assert!(f.cache.check_version(&f.remote, 7, b, "/a.txt", &base).await.unwrap().up_to_date);

            f.remote.put("/a.txt", "one, and a colleague's words");
            let check = f.cache.check_version(&f.remote, 7, b, "/a.txt", &base).await.unwrap();
            assert!(!check.up_to_date);
            let report = f.cache.commit_branch(&f.remote, 7, branch.index, false).await.unwrap();
            assert!(!report.committed && report.conflicts[0].contains("changed in Filen after the branch did"), "{report:?}");

            // The person looked, and chose to overwrite: based on Filen's version now, the commit goes through.
            f.cache.rebase(&f.remote, 7, branch.index, "/a.txt").await.unwrap();
            assert!(f.cache.check_version(&f.remote, 7, b, "/a.txt", &f.cache.version(7, b, "/a.txt").await.unwrap()).await.unwrap().up_to_date);
            assert!(f.cache.commit_branch(&f.remote, 7, branch.index, false).await.unwrap().committed);
            assert_eq!(f.remote.text("/a.txt").as_deref(), Some("one, edited"));
            assert!(f.cache.rebase(&f.remote, 7, branch.index, "/a.txt").await.is_err(), "the branch is gone");
        });
    }

    #[test]
    fn paths_are_normalised_and_split() {
        assert_eq!(norm_path("").unwrap(), "/");
        assert_eq!(norm_path("//a//b/").unwrap(), "/a/b");
        assert!(norm_path("/a/../b").is_err());
        assert_eq!(parent_of("/a/b"), Some("/a".into()));
        assert_eq!(parent_of("/a"), Some("/".into()));
        assert_eq!(parent_of("/"), None);
        assert_eq!(prefixes("/a/b/c"), ["/a", "/a/b", "/a/b/c"]);
        assert!(is_within("/a/b", "/a") && is_within("/a", "/a") && is_within("/x", "/") && !is_within("/ab", "/a"));
    }

    #[test]
    fn local_names_are_safe_and_never_collide() {
        assert_eq!(mirror_name("a:b*c.txt"), "a_b_c.txt");
        assert_eq!(mirror_name("CON"), "_CON");
        assert_eq!(mirror_name("trailing. "), "trailing");
        assert_eq!(mirror_name("..."), "_");
        assert_eq!(mirror_name(&"x".repeat(500)).chars().count(), MAX_LOCAL_NAME);

        let mut taken = HashSet::new();
        let first = allocate_local_name("Notes.txt", &taken);
        taken.insert(first.to_lowercase());
        let second = allocate_local_name("notes.txt", &taken); // differs only by case
        assert_ne!(first.to_lowercase(), second.to_lowercase());
        taken.insert(second.to_lowercase());
        let third = allocate_local_name("a?b", &taken);
        taken.insert(third.to_lowercase());
        let fourth = allocate_local_name("a*b", &taken); // both become a_b
        assert_ne!(third, fourth);
        assert_eq!(allocate_local_name("Notes.txt", &taken).to_lowercase() != first.to_lowercase(), true);
    }

    #[test]
    fn thumbnails_belong_to_a_version_of_a_file_and_go_with_the_account_or_the_branch() {
        run(async {
            let f = Fixture::new("thumbs").await;
            f.remote.put("/pics/a.png", "one");
            f.remote.put("/pics/a.png.bak", "two");
            let t = f.base.join("a/001/t");

            // Nothing yet; then one for the version (modified 1000, 3 bytes) — laid out like the files, inside the account's own folder.
            assert_eq!(f.cache.thumb_get(7, None, "/pics/a.png", 1000, 3).await.unwrap(), None);
            f.cache.thumb_put(7, None, "/pics/a.png", 1000, 3, b"jpeg-1").await.unwrap();
            assert!(t.join("pics/a.png.1000-3.jpg").is_file());
            assert_eq!(f.cache.thumb_get(7, None, "/pics/a.png", 1000, 3).await.unwrap().as_deref(), Some(&b"jpeg-1"[..]));
            // A changed file has none until one is made for its new version, and that one replaces the old.
            assert_eq!(f.cache.thumb_get(7, None, "/pics/a.png", 2000, 5).await.unwrap(), None);
            f.cache.thumb_put(7, None, "/pics/a.png.bak", 1000, 3, b"bak").await.unwrap();
            f.cache.thumb_put(7, None, "/pics/a.png", 2000, 5, b"jpeg-2").await.unwrap();
            assert!(!t.join("pics/a.png.1000-3.jpg").exists(), "the older version's is removed");
            assert!(t.join("pics/a.png.bak.1000-3.jpg").is_file(), "…and another file's is not");

            // A branch: a file it hasn't changed shows the account's thumbnail; one it changed has its own, with the branch.
            let branch = f.cache.create_branch(7, "draft").await.unwrap();
            let b = Some(branch.index);
            assert_eq!(f.cache.thumb_get(7, b, "/pics/a.png", 2000, 5).await.unwrap().as_deref(), Some(&b"jpeg-2"[..]));
            f.cache.write(&f.remote, 7, b, "/pics/a.png", b"changed").await.unwrap();
            assert_eq!(f.cache.thumb_get(7, b, "/pics/a.png", 2000, 5).await.unwrap(), None, "changed in the branch: not the account's");
            f.cache.thumb_put(7, b, "/pics/a.png", 3000, 7, b"branch").await.unwrap();
            let tb = f.base.join("a/001/tb");
            assert!(tb.join("001/pics/a.png.3000-7.jpg").is_file() && tb.join("001-draft").is_dir(), "the branch's pair, inside the account's own folder");
            assert_eq!(f.cache.thumb_get(7, None, "/pics/a.png", 3000, 7).await.unwrap(), None, "the account never sees the branch's");

            // Discarding the branch deletes both of its places.
            f.cache.discard_branch(7, branch.index).await.unwrap();
            assert!(!f.base.join("a/001/b/001").exists());
            assert!(!tb.exists(), "the branch's thumbnails are gone with it");
            assert!(t.join("pics/a.png.2000-5.jpg").is_file(), "the account's stay");

            // Clearing the cache drops the account's thumbnails; disconnecting drops them too.
            f.cache.clear(7).await.unwrap();
            assert!(!t.exists());
            f.cache.thumb_put(7, None, "/pics/a.png", 2000, 5, b"again").await.unwrap();
            f.cache.forget_account(7).await.unwrap();
            assert!(!t.exists(), "the account's folder — thumbnails included — is gone with it");
        });
    }

    #[test]
    fn the_old_layout_of_b_t_and_tb_beside_a_is_moved_inside_the_owner_at_the_next_open() {
        run(async {
            let base = std::env::temp_dir().join(format!("csdrive-files-cache-migrate-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            // Build the old layout by hand: an account already in `a`, its branch in the old top-level `b`, a thumbnail in the old
            // top-level `t`, and its branch's thumbnail in the old top-level `tb` — each under the account's own `NNN-<part>` pair.
            let part = "filen@@me@example.com@@7";
            for (parent, extra) in [("a", Some("c")), ("b", None), ("t", None), ("tb", None)] {
                let full = base.join(parent).join(format!("001-{part}"));
                std::fs::create_dir_all(&full).unwrap();
                std::fs::write(full.join(".keep"), "-").unwrap();
                let short = base.join(parent).join("001");
                if let Some(sub) = extra {
                    std::fs::create_dir_all(short.join(sub)).unwrap();
                } else {
                    std::fs::create_dir_all(&short).unwrap();
                }
            }
            std::fs::write(base.join("b/001/x.txt"), "in the branch").unwrap();
            std::fs::write(base.join("t/001/pic.jpg"), "thumb").unwrap();
            std::fs::create_dir_all(base.join("tb/001/001")).unwrap();
            std::fs::write(base.join("tb/001/001/pic.jpg"), "branch thumb").unwrap();

            let cache = Cache::open(&base).await.unwrap();
            let a = base.join("a/001");
            assert_eq!(std::fs::read_to_string(a.join("b/x.txt")).unwrap(), "in the branch", "the branch moved inside the account's own folder");
            assert_eq!(std::fs::read_to_string(a.join("t/pic.jpg")).unwrap(), "thumb");
            assert_eq!(std::fs::read_to_string(a.join("tb/001/pic.jpg")).unwrap(), "branch thumb");
            assert!(!base.join("b").exists() && !base.join("t").exists() && !base.join("tb").exists(), "the old top-level folders are gone");
            // Idempotent — opening again changes nothing more (there is no accounts row here — the folders were made by hand — so
            // ensure_account never ran; the migration still found the pair through its part, not through the database).
            drop(cache);
            let cache2 = Cache::open(&base).await.unwrap();
            assert_eq!(std::fs::read_to_string(a.join("b/x.txt")).unwrap(), "in the branch", "running the migration again is harmless");
            let _ = cache2;
            let _ = std::fs::remove_dir_all(&base);
        });
    }

    #[test]
    fn only_a_thumbnail_of_that_very_file_is_taken_for_one() {
        assert!(is_thumb_of("a.png.1000-3.jpg", "a.png."));
        assert!(!is_thumb_of("a.png.bak.1000-3.jpg", "a.png."), "another file's");
        assert!(!is_thumb_of("a.png.1000-3.jpeg", "a.png."));
        assert!(!is_thumb_of("a.png.x-3.jpg", "a.png."));
        assert_eq!(thumb_file(Path::new("root"), "/x/y:z/a.png", 5, 6), Path::new("root").join("x").join("y_z").join("a.png.5-6.jpg"));
    }

    #[test]
    fn an_account_gets_its_folder_pair_and_loses_it_on_disconnect() {
        run(async {
            let f = Fixture::new("account").await;
            let a = f.base.join("a");
            let info = f.cache.account_info(7).await.unwrap();
            assert_eq!(info.folder, "001");
            assert_eq!(info.ttl_secs, Some(DEFAULT_TTL_SECS));
            assert!(a.join("001").is_dir() && a.join("001-filen@@me@example.com@@7").is_dir());

            f.cache.ensure_account(8, "b@example.com").await.unwrap();
            assert!(a.join("002-filen@@b@example.com@@8").is_dir(), "the next account is 002");
            f.cache.ensure_account(7, "me@example.com").await.unwrap();
            assert_eq!(std::fs::read_dir(&a).unwrap().count(), 4, "ensuring again adds nothing");

            f.cache.ensure_account(7, "new@example.com").await.unwrap(); // the email changed
            assert!(a.join("001-filen@@new@example.com@@7").is_dir() && !a.join("001-filen@@me@example.com@@7").exists());

            f.cache.create_branch(7, "draft").await.unwrap();
            assert!(a.join("001/b/001-draft").is_dir(), "the branch's pair lives inside the account's own folder now");
            f.cache.forget_account(7).await.unwrap();
            assert!(!a.join("001").exists() && !a.join("001-filen@@new@example.com@@7").exists(), "the branches inside it go too");
            assert!(f.cache.account_info(7).await.is_err());
            assert!(a.join("002").exists(), "other accounts are untouched");
        });
    }

    #[test]
    fn listings_are_fetched_once_and_expire_with_the_interval() {
        run(async {
            let f = Fixture::new("ttl").await;
            f.remote.put("/docs/a.txt", "aaa");
            f.remote.put("/docs/B.txt", "bb");

            let first = f.cache.list(&f.remote, 7, None, "/docs", false).await.unwrap();
            assert_eq!(Fixture::names(&first), ["a.txt", "B.txt"]);
            f.cache.list(&f.remote, 7, None, "/docs", false).await.unwrap();
            assert_eq!(f.remote.listings.load(Ordering::SeqCst), 1, "the second look came from the cache");

            f.advance(3599);
            f.cache.list(&f.remote, 7, None, "/docs", false).await.unwrap();
            assert_eq!(f.remote.listings.load(Ordering::SeqCst), 1, "still valid just before the interval is up");
            f.advance(2);
            f.remote.put("/docs/c.txt", "c");
            let refreshed = f.cache.list(&f.remote, 7, None, "/docs", false).await.unwrap();
            assert_eq!(f.remote.listings.load(Ordering::SeqCst), 2, "expired, so fetched again");
            assert_eq!(Fixture::names(&refreshed), ["a.txt", "B.txt", "c.txt"]);

            f.cache.list(&f.remote, 7, None, "/docs", true).await.unwrap();
            assert_eq!(f.remote.listings.load(Ordering::SeqCst), 3, "force fetches regardless");

            // A shorter interval applies at once; "never" means never.
            f.cache.set_ttl(7, Some(10)).await.unwrap();
            f.advance(11);
            f.cache.list(&f.remote, 7, None, "/docs", false).await.unwrap();
            assert_eq!(f.remote.listings.load(Ordering::SeqCst), 4);
            f.cache.set_ttl(7, None).await.unwrap();
            f.advance(10 * 365 * 24 * 3600);
            f.cache.list(&f.remote, 7, None, "/docs", false).await.unwrap();
            assert_eq!(f.remote.listings.load(Ordering::SeqCst), 4, "with no interval it never expires");
            assert!(f.cache.set_ttl(7, Some(-1)).await.is_err());
        });
    }

    #[test]
    fn an_expired_listing_is_still_served_when_filen_cannot_be_reached() {
        run(async {
            let f = Fixture::new("offline").await;
            f.remote.put("/a.txt", "x");
            f.cache.list(&f.remote, 7, None, "/", false).await.unwrap();
            f.remote.offline.store(true, Ordering::SeqCst);

            f.advance(7200);
            let listing = f.cache.list(&f.remote, 7, None, "/", false).await.unwrap();
            assert!(listing.stale, "marked stale");
            assert_eq!(Fixture::names(&listing), ["a.txt"]);
            assert!(f.cache.list(&f.remote, 7, None, "/never-seen", false).await.is_err(), "nothing cached, nothing to show");
        });
    }

    #[test]
    fn a_file_is_fetched_only_when_opened_and_kept_until_it_changes_or_expires() {
        run(async {
            let f = Fixture::new("content").await;
            f.remote.put("/notes/todo.txt", "buy milk");
            f.cache.list(&f.remote, 7, None, "/notes", false).await.unwrap();
            assert_eq!(f.remote.reads.load(Ordering::SeqCst), 0, "listing fetches no content");
            assert!(!f.cache.list(&f.remote, 7, None, "/notes", false).await.unwrap().entries[0].cached);

            assert_eq!(f.cache.read(&f.remote, 7, None, "/notes/todo.txt").await.unwrap(), b"buy milk");
            assert_eq!(f.remote.reads.load(Ordering::SeqCst), 1);
            assert!(f.base.join("a/001/c/notes/todo.txt").is_file(), "mirrored at the same path");
            assert!(f.cache.list(&f.remote, 7, None, "/notes", false).await.unwrap().entries[0].cached);

            f.cache.read(&f.remote, 7, None, "/notes/todo.txt").await.unwrap();
            assert_eq!(f.remote.reads.load(Ordering::SeqCst), 1, "the second open is local");

            // Expired, but unchanged in Filen: the listing is refetched, the content is kept.
            f.advance(4000);
            f.cache.read(&f.remote, 7, None, "/notes/todo.txt").await.unwrap();
            assert_eq!(f.remote.reads.load(Ordering::SeqCst), 1);
            assert_eq!(f.remote.listings.load(Ordering::SeqCst), 2, "the listing was fetched again, the content wasn't");

            // Changed in Filen: the next look after the interval fetches the new content.
            f.remote.put("/notes/todo.txt", "buy milk and eggs");
            f.advance(4000);
            assert_eq!(f.cache.read(&f.remote, 7, None, "/notes/todo.txt").await.unwrap(), b"buy milk and eggs");
            assert_eq!(f.remote.reads.load(Ordering::SeqCst), 2);

            // Offline with the file cached: it still opens, even past the interval.
            f.remote.offline.store(true, Ordering::SeqCst);
            f.advance(999_999);
            assert_eq!(f.cache.read(&f.remote, 7, None, "/notes/todo.txt").await.unwrap(), b"buy milk and eggs");
            assert!(f.cache.read(&f.remote, 7, None, "/notes/missing.txt").await.is_err());
        });
    }

    #[test]
    fn writes_go_to_filen_and_update_the_cache_and_clear_empties_it() {
        run(async {
            let f = Fixture::new("write").await;
            f.remote.put("/d/keep.txt", "k");
            f.cache.write(&f.remote, 7, None, "/d/new.txt", b"hello").await.unwrap();
            assert_eq!(f.remote.text("/d/new.txt").as_deref(), Some("hello"), "written to Filen at once");
            assert_eq!(f.cache.read(&f.remote, 7, None, "/d/new.txt").await.unwrap(), b"hello");
            assert_eq!(f.remote.reads.load(Ordering::SeqCst), 0, "and cached, so reading it needs no download");
            assert_eq!(Fixture::names(&f.cache.list(&f.remote, 7, None, "/d", false).await.unwrap()), ["keep.txt", "new.txt"]);

            f.cache.mkdir(&f.remote, 7, None, "/d/sub/deeper").await.unwrap();
            assert!(f.remote.has_folder("/d/sub/deeper"));
            assert_eq!(Fixture::names(&f.cache.list(&f.remote, 7, None, "/d", false).await.unwrap()), ["sub", "keep.txt", "new.txt"]);

            f.cache.rename(&f.remote, 7, None, "/d/new.txt", "/d/sub/moved.txt").await.unwrap();
            assert_eq!(f.remote.text("/d/sub/moved.txt").as_deref(), Some("hello"));
            assert_eq!(Fixture::names(&f.cache.list(&f.remote, 7, None, "/d", false).await.unwrap()), ["sub", "keep.txt"]);

            f.cache.remove(&f.remote, 7, None, "/d/sub").await.unwrap();
            assert!(!f.remote.has_folder("/d/sub"));
            assert_eq!(Fixture::names(&f.cache.list(&f.remote, 7, None, "/d", false).await.unwrap()), ["keep.txt"]);
            assert!(!f.base.join("a/001/c/d/sub").exists(), "and its cached files are gone");

            f.cache.read(&f.remote, 7, None, "/d/keep.txt").await.unwrap();
            f.cache.clear(7).await.unwrap();
            assert!(!f.base.join("a/001/c").exists());
            let reads = f.remote.reads.load(Ordering::SeqCst);
            f.cache.read(&f.remote, 7, None, "/d/keep.txt").await.unwrap();
            assert_eq!(f.remote.reads.load(Ordering::SeqCst), reads + 1, "after clearing it is fetched again");
            assert!(f.cache.remove(&f.remote, 7, None, "/").await.is_err());
            assert!(f.cache.rename(&f.remote, 7, None, "/d", "/d/inside").await.is_err());
        });
    }

    #[test]
    fn odd_filen_names_get_safe_unique_local_names() {
        run(async {
            let f = Fixture::new("names").await;
            for name in ["Notes.txt", "notes.txt", "a:b.txt", "a?b.txt", "CON"] {
                f.remote.put(&format!("/{name}"), name);
            }
            f.cache.list(&f.remote, 7, None, "/", false).await.unwrap();
            for name in ["Notes.txt", "notes.txt", "a:b.txt", "a?b.txt", "CON"] {
                assert_eq!(f.cache.read(&f.remote, 7, None, &format!("/{name}")).await.unwrap(), name.as_bytes(), "{name}");
            }
            let on_disk: HashSet<String> = std::fs::read_dir(f.base.join("a/001/c")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_lowercase()).collect();
            assert_eq!(on_disk.len(), 5, "five different files, whatever the file system thinks of case: {on_disk:?}");
        });
    }

    #[test]
    fn a_branch_keeps_changes_local_until_committed() {
        run(async {
            let f = Fixture::new("branch").await;
            f.remote.put("/docs/a.txt", "one");
            f.remote.put("/docs/b.txt", "two");
            let branch = f.cache.create_branch(7, "my draft").await.unwrap();
            assert_eq!(branch.index, 1);
            let account = f.base.join("a/001-filen@@me@example.com@@7");
            assert!(account.is_dir() && f.base.join("a/001/b/001").is_dir() && f.base.join("a/001/b/001-my draft").is_dir(), "the branch's pair, inside the account's own folder");
            assert!(f.cache.create_branch(7, "MY DRAFT").await.is_err(), "names are unique");
            assert!(f.cache.create_branch(7, "bad/name").await.is_err());

            let b = Some(branch.index);
            f.cache.write(&f.remote, 7, b, "/docs/a.txt", b"one, edited").await.unwrap();
            f.cache.write(&f.remote, 7, b, "/docs/c.txt", b"three").await.unwrap();
            f.cache.mkdir(&f.remote, 7, b, "/docs/new/inner").await.unwrap();
            f.cache.write(&f.remote, 7, b, "/docs/new/inner/d.txt", b"deep").await.unwrap();
            f.cache.remove(&f.remote, 7, b, "/docs/b.txt").await.unwrap();

            // Filen is untouched…
            assert_eq!(f.remote.text("/docs/a.txt").as_deref(), Some("one"));
            assert!(f.remote.text("/docs/b.txt").is_some() && f.remote.text("/docs/c.txt").is_none());
            // …and the account's own view is unchanged, while the branch's view has the changes.
            assert_eq!(Fixture::names(&f.cache.list(&f.remote, 7, None, "/docs", false).await.unwrap()), ["a.txt", "b.txt"]);
            let view = f.cache.list(&f.remote, 7, b, "/docs", false).await.unwrap();
            assert_eq!(Fixture::names(&view), ["new", "a.txt", "c.txt"]);
            assert_eq!(view.entries.iter().find(|e| e.name == "a.txt").unwrap().changed.as_deref(), Some("put"));
            assert_eq!(Fixture::names(&f.cache.list(&f.remote, 7, b, "/docs/new/inner", false).await.unwrap()), ["d.txt"]);
            assert_eq!(f.cache.read(&f.remote, 7, b, "/docs/a.txt").await.unwrap(), b"one, edited");
            assert!(f.cache.read(&f.remote, 7, b, "/docs/b.txt").await.is_err(), "deleted in the branch");
            assert!(f.cache.list(&f.remote, 7, b, "/docs/b.txt", false).await.is_err());
            assert_eq!(f.cache.branch_changes(7, branch.index).await.unwrap().len(), 6);
            assert_eq!(f.cache.branches(7).await.unwrap()[0].changes, 6);

            // A file the branch created and then deleted leaves nothing behind.
            f.cache.write(&f.remote, 7, b, "/docs/temp.txt", b"t").await.unwrap();
            f.cache.remove(&f.remote, 7, b, "/docs/temp.txt").await.unwrap();
            assert!(f.cache.branch_changes(7, branch.index).await.unwrap().iter().all(|c| c.path != "/docs/temp.txt"));

            f.cache.rename(&f.remote, 7, b, "/docs/c.txt", "/docs/c-renamed.txt").await.unwrap();
            assert_eq!(f.cache.read(&f.remote, 7, b, "/docs/c-renamed.txt").await.unwrap(), b"three");
            assert!(f.cache.rename(&f.remote, 7, b, "/docs/new", "/docs/newer").await.is_err(), "no folder renames in a branch");

            // Commit applies everything and deletes the branch.
            let report = f.cache.commit_branch(&f.remote, 7, branch.index, false).await.unwrap();
            assert!(report.committed && report.conflicts.is_empty());
            assert_eq!(f.remote.text("/docs/a.txt").as_deref(), Some("one, edited"));
            assert_eq!(f.remote.text("/docs/c-renamed.txt").as_deref(), Some("three"));
            assert_eq!(f.remote.text("/docs/new/inner/d.txt").as_deref(), Some("deep"));
            assert!(f.remote.text("/docs/b.txt").is_none() && f.remote.text("/docs/c.txt").is_none());
            assert!(f.cache.branches(7).await.unwrap().is_empty());
            assert!(!f.base.join("b/001").exists() && !f.base.join("b/001-filen@@me@example.com@@7").exists(), "the pairs are gone");
            assert_eq!(Fixture::names(&f.cache.list(&f.remote, 7, None, "/docs", false).await.unwrap()), ["new", "a.txt", "c-renamed.txt"], "and the account view is fresh");
            assert_eq!(f.cache.read(&f.remote, 7, None, "/docs/a.txt").await.unwrap(), b"one, edited");
        });
    }

    #[test]
    fn a_commit_reports_conflicts_instead_of_overwriting_and_a_branch_can_be_discarded() {
        run(async {
            let f = Fixture::new("conflict").await;
            f.remote.put("/a.txt", "original");
            f.remote.put("/gone.txt", "will be deleted remotely");
            let branch = f.cache.create_branch(7, "risky").await.unwrap();
            let b = Some(branch.index);
            f.cache.write(&f.remote, 7, b, "/a.txt", b"my edit").await.unwrap();
            f.cache.write(&f.remote, 7, b, "/gone.txt", b"my edit too").await.unwrap();
            f.cache.write(&f.remote, 7, b, "/fresh.txt", b"mine").await.unwrap();

            // Meanwhile, in Filen…
            f.remote.put("/a.txt", "changed elsewhere");
            f.remote.remove("/gone.txt").await.unwrap();
            f.remote.put("/fresh.txt", "someone else made this");

            let report = f.cache.commit_branch(&f.remote, 7, branch.index, false).await.unwrap();
            assert!(!report.committed && report.applied == 0);
            assert_eq!(report.conflicts.len(), 3, "{:?}", report.conflicts);
            assert_eq!(f.remote.text("/a.txt").as_deref(), Some("changed elsewhere"), "nothing was overwritten");
            assert_eq!(f.cache.branches(7).await.unwrap().len(), 1, "the branch is still there");

            let forced = f.cache.commit_branch(&f.remote, 7, branch.index, true).await.unwrap();
            assert!(forced.committed);
            assert_eq!(f.remote.text("/a.txt").as_deref(), Some("my edit"), "forced: the branch wins");

            // Discarding just deletes the branch.
            let second = f.cache.create_branch(7, "throwaway").await.unwrap();
            f.cache.write(&f.remote, 7, Some(second.index), "/never.txt", b"x").await.unwrap();
            f.cache.discard_branch(7, second.index).await.unwrap();
            assert!(f.remote.text("/never.txt").is_none());
            assert!(f.cache.branches(7).await.unwrap().is_empty());
            assert!(f.cache.discard_branch(7, second.index).await.is_err());
            assert!(!f.base.join("b").join("001").exists());
        });
    }

    /// Every file under dir whose name ends with suffix.
    fn files_ending(dir: &Path, suffix: &str) -> Vec<PathBuf> {
        let mut found = Vec::new();
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                found.extend(files_ending(&path, suffix));
            } else if path.to_string_lossy().ends_with(suffix) {
                found.push(path);
            }
        }
        found
    }

    #[test]
    fn a_file_is_streamed_into_the_cache_and_an_interrupted_download_leaves_nothing() {
        run(async {
            let f = Fixture::new("stream-down").await;
            f.remote.put("/a.txt", "hello streamed world");
            f.cache.list(&f.remote, 7, None, "/", false).await.unwrap();

            // Cut off: the download fails, and nothing looks cached afterwards.
            f.remote.offline.store(true, Ordering::SeqCst);
            assert!(f.cache.cached_file(&f.remote, 7, None, "/a.txt").await.is_err());
            assert!(files_ending(&f.base, ".part").is_empty(), "no partial file is left");
            assert!(!f.cache.list(&f.remote, 7, None, "/", false).await.unwrap().entries[0].cached);

            // Back online: it arrives, in place, and is served from the cache from then on.
            f.remote.offline.store(false, Ordering::SeqCst);
            let local = f.cache.cached_file(&f.remote, 7, None, "/a.txt").await.unwrap();
            assert_eq!(std::fs::read_to_string(&local).unwrap(), "hello streamed world");
            assert!(local.starts_with(&f.base) && !local.to_string_lossy().ends_with(".part"));
            assert_eq!(f.remote.reads.load(Ordering::SeqCst), 1);
            f.cache.cached_file(&f.remote, 7, None, "/a.txt").await.unwrap();
            assert_eq!(f.remote.reads.load(Ordering::SeqCst), 1, "the second time it is not downloaded again");
            assert!(f.cache.list(&f.remote, 7, None, "/", false).await.unwrap().entries[0].cached);
            assert_eq!(f.cache.read(&f.remote, 7, None, "/a.txt").await.unwrap(), b"hello streamed world", "and the bytes API agrees");
            assert!(files_ending(&f.base, ".part").is_empty());
        });
    }

    #[test]
    fn an_upload_in_pieces_goes_to_filen_and_the_cache_together() {
        run(async {
            let f = Fixture::new("upload-pieces").await;
            let mut job = f.cache.upload_begin(&f.remote, 7, None, "/up.txt").await.unwrap();
            for piece in ["hel", "lo ", "pie", "ces"] {
                f.cache.upload_push(&f.remote, &mut job, piece.as_bytes()).await.unwrap();
            }
            assert_eq!(job.written(), 12);
            assert!(f.remote.text("/up.txt").is_none(), "nothing exists in Filen until the upload is finished");
            f.cache.upload_finish(&f.remote, job).await.unwrap();

            assert_eq!(f.remote.text("/up.txt").as_deref(), Some("hello pieces"));
            let local = f.cache.cached_file(&f.remote, 7, None, "/up.txt").await.unwrap();
            assert_eq!(std::fs::read_to_string(local).unwrap(), "hello pieces");
            assert_eq!(f.remote.reads.load(Ordering::SeqCst), 0, "what was assembled is the cached copy: no download");
            assert!(files_ending(&f.base, ".part").is_empty(), "the temporary file became the cached one");
        });
    }

    #[test]
    fn a_file_on_disk_uploads_to_the_account_and_into_a_branch_and_a_commit_streams_it_too() {
        run(async {
            let f = Fixture::new("upload-file").await;
            let src = f.base.join("source.txt");
            let content = "from disk ".repeat(10);
            std::fs::write(&src, &content).unwrap();

            f.cache.upload_from_file(&f.remote, 7, None, "/disk.txt", &src).await.unwrap();
            assert_eq!(f.remote.text("/disk.txt").as_deref(), Some(content.as_str()));

            // Into a branch, Filen is untouched until the commit.
            let branch = f.cache.create_branch(7, "b").await.unwrap();
            f.cache.upload_from_file(&f.remote, 7, Some(branch.index), "/branchy.txt", &src).await.unwrap();
            assert!(f.remote.text("/branchy.txt").is_none());
            assert_eq!(f.cache.read(&f.remote, 7, Some(branch.index), "/branchy.txt").await.unwrap(), content.as_bytes());
            let report = f.cache.commit_branch(&f.remote, 7, branch.index, false).await.unwrap();
            assert!(report.committed);
            assert_eq!(f.remote.text("/branchy.txt").as_deref(), Some(content.as_str()));
            assert!(files_ending(&f.base, ".part").is_empty());

            // Replacing a file that is there already works the same way.
            std::fs::write(&src, "replaced").unwrap();
            f.cache.upload_from_file(&f.remote, 7, None, "/disk.txt", &src).await.unwrap();
            assert_eq!(f.remote.text("/disk.txt").as_deref(), Some("replaced"));
            assert_eq!(f.cache.read(&f.remote, 7, None, "/disk.txt").await.unwrap(), b"replaced");
        });
    }

    #[test]
    fn an_abandoned_upload_leaves_nothing_behind() {
        run(async {
            let f = Fixture::new("upload-abandon").await;
            let mut job = f.cache.upload_begin(&f.remote, 7, None, "/x.txt").await.unwrap();
            f.cache.upload_push(&f.remote, &mut job, b"partial").await.unwrap();
            assert_eq!(files_ending(&f.base, ".part").len(), 1);
            drop(job);
            assert!(files_ending(&f.base, ".part").is_empty(), "dropping an unfinished upload deletes its temporary file");
            assert!(f.remote.text("/x.txt").is_none());

            // And one cut off by the app stopping (nothing ran a destructor) is cleared at the next start.
            let mut cut_off = f.cache.upload_begin(&f.remote, 7, None, "/y.txt").await.unwrap();
            f.cache.upload_push(&f.remote, &mut cut_off, b"partial").await.unwrap();
            std::mem::forget(cut_off);
            assert_eq!(files_ending(&f.base, ".part").len(), 1);
            f.cache.remove_leftover_uploads();
            assert!(files_ending(&f.base, ".part").is_empty());
        });
    }

    #[test]
    fn a_fetched_listing_reports_the_time_it_was_stored_with() {
        run(async {
            let base = std::env::temp_dir().join(format!("csdrive-files-cache-ticking-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(&base).unwrap();
            let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
            // A clock that moves on every reading, like a real one does while a fetch is in flight.
            let ticks = Arc::new(AtomicI64::new(1_000_000));
            let clock = {
                let ticks = ticks.clone();
                Arc::new(move || ticks.fetch_add(1, Ordering::SeqCst))
            };
            let cache = Cache::with_pool(pool, base.clone(), clock).await.unwrap();
            cache.ensure_account(7, "me@example.com").await.unwrap();
            let remote = MemoryRemote::new();

            let forced = cache.list(&remote, 7, None, "/", true).await.unwrap();
            let again = cache.list(&remote, 7, None, "/", false).await.unwrap();
            assert_eq!(forced.fetched_at, again.fetched_at, "the refresh reports what it stored, so the next read agrees");
            let _ = std::fs::remove_dir_all(&base);
        });
    }

    #[test]
    fn several_branches_get_their_own_pairs() {
        run(async {
            let f = Fixture::new("several").await;
            let one = f.cache.create_branch(7, "first").await.unwrap();
            let two = f.cache.create_branch(7, "second").await.unwrap();
            assert_eq!((one.index, two.index), (1, 2));
            f.cache.discard_branch(7, one.index).await.unwrap();
            assert!(f.base.join("a/001/b/002-second").is_dir() && !f.base.join("a/001/b/001-first").exists());
            assert_eq!(f.cache.create_branch(7, "third").await.unwrap().index, 1, "the gap the discarded branch left is filled");
            assert!(f.base.join("a/001/b/001-third").is_dir());
            assert_eq!(f.cache.create_branch(7, "fourth").await.unwrap().index, 3, "and with no gap left: the largest plus one");
        });
    }
}
