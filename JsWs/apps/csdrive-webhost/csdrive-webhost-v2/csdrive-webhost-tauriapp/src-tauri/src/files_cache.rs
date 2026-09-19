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
//! Filen is reached through the `Remote` trait, so all of this is tested without a network.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use serde::Serialize;
use sqlx::{Row, SqlitePool};
use tokio::sync::Mutex;

use crate::folder_pairs;

/// The default cache interval: one hour.
pub const DEFAULT_TTL_SECS: i64 = 3600;
const PROVIDER: &str = "filen";
/// Accounts' and branches' folder pairs take the lowest free index, so deleting one (disconnecting an
/// account, committing or discarding a branch) leaves no permanent gap in the numbering.
const INDEXING: folder_pairs::Indexing = folder_pairs::Indexing::FillGaps;
/// Local file names are cut to this many characters (the pair strategy keeps the folders above short).
const MAX_LOCAL_NAME: usize = 120;

// ── The remote ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct RemoteEntry {
    pub name: String,
    pub is_directory: bool,
    pub size: Option<u64>,
    pub mtime_ms: Option<u64>,
}

/// What the cache needs from the storage it caches.
pub trait Remote: Send + Sync {
    fn readdir(&self, path: &str) -> impl Future<Output = Result<Vec<RemoteEntry>, String>> + Send;
    fn read_file(&self, path: &str) -> impl Future<Output = Result<Vec<u8>, String>> + Send;
    fn write_file(&self, path: &str, content: &[u8]) -> impl Future<Output = Result<(), String>> + Send;
    fn mkdir(&self, path: &str) -> impl Future<Output = Result<(), String>> + Send;
    fn remove(&self, path: &str) -> impl Future<Output = Result<(), String>> + Send;
    fn rename(&self, from: &str, to: &str) -> impl Future<Output = Result<(), String>> + Send;
}

/// A Filen account, as a `Remote`.
pub struct FilenRemote(pub crate::filen::Session);

impl Remote for FilenRemote {
    async fn readdir(&self, path: &str) -> Result<Vec<RemoteEntry>, String> {
        Ok(crate::filen::ops::readdir(&self.0, path)
            .await?
            .into_iter()
            .map(|e| RemoteEntry { name: e.name, is_directory: e.is_directory, size: e.size, mtime_ms: e.mtime_ms })
            .collect())
    }
    async fn read_file(&self, path: &str) -> Result<Vec<u8>, String> {
        crate::filen::ops::read_file(&self.0, path).await
    }
    async fn write_file(&self, path: &str, content: &[u8]) -> Result<(), String> {
        crate::filen::ops::write_file(&self.0, path, content).await
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
    pub name: String,
    pub is_directory: bool,
    pub size: Option<u64>,
    pub mtime_ms: Option<u64>,
    /// The file's content is in the cache (so opening it needs no network).
    pub cached: bool,
    /// In a branch: `"put"` (written in the branch) or `"mkdir"` (made in the branch).
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
    /// `put`, `mkdir` or `delete`.
    pub kind: String,
    pub is_new: bool,
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

/// `filen@@<email>@@<account id>` — the account's full-folder-name part (see the pairs strategy).
pub fn account_part(email: &str, user_id: i64) -> String {
    let tail = format!("@@{user_id}");
    let room = folder_pairs::MAX_NAME_PART_CHARS.saturating_sub(PROVIDER.len() + 2 + tail.len());
    let email: String = folder_pairs::sanitize_part(email).chars().take(room).collect();
    format!("{PROVIDER}@@{}{tail}", email.trim_end_matches(['.', ' ']))
}

fn is_account_part_for(part: &str, user_id: i64) -> bool {
    part.starts_with(&format!("{PROVIDER}@@")) && part.ends_with(&format!("@@{user_id}"))
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
    path: String,
    name: String,
    is_dir: i64,
    size: Option<i64>,
    mtime_ms: Option<i64>,
    local_name: String,
    content_at: Option<i64>,
}

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
        Self::with_pool(pool, files_dir.to_path_buf(), Arc::new(now_real)).await
    }

    pub async fn with_pool(pool: SqlitePool, root: PathBuf, clock: Clock) -> Result<Self, String> {
        for statement in [
            "CREATE TABLE IF NOT EXISTS accounts (user_id INTEGER PRIMARY KEY, email TEXT NOT NULL, pair_index INTEGER NOT NULL, ttl_secs INTEGER, created_at INTEGER NOT NULL)",
            "CREATE TABLE IF NOT EXISTS entries (user_id INTEGER NOT NULL, path TEXT NOT NULL, parent TEXT NOT NULL, name TEXT NOT NULL, is_dir INTEGER NOT NULL, size INTEGER, mtime_ms INTEGER, local_name TEXT NOT NULL, fetched_at INTEGER NOT NULL, content_at INTEGER, PRIMARY KEY (user_id, path))",
            "CREATE INDEX IF NOT EXISTS entries_parent ON entries (user_id, parent)",
            "CREATE TABLE IF NOT EXISTS listings (user_id INTEGER NOT NULL, path TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (user_id, path))",
            "CREATE TABLE IF NOT EXISTS branches (user_id INTEGER NOT NULL, pair_index INTEGER NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, pair_index))",
            "CREATE TABLE IF NOT EXISTS branch_changes (user_id INTEGER NOT NULL, branch INTEGER NOT NULL, path TEXT NOT NULL, parent TEXT NOT NULL, kind TEXT NOT NULL, base_exists INTEGER NOT NULL, base_size INTEGER, base_mtime_ms INTEGER, local_name TEXT NOT NULL, changed_at INTEGER NOT NULL, PRIMARY KEY (user_id, branch, path))",
            "CREATE INDEX IF NOT EXISTS branch_changes_parent ON branch_changes (user_id, branch, parent)",
        ] {
            sqlx::query(statement).execute(&pool).await.map_err(sql)?;
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

    fn b_dir(&self) -> PathBuf {
        self.root.join(crate::layout::FILES_BRANCHES_FOLDER)
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
        let existing = folder_pairs::list(&a).map_err(io)?.into_iter().find(|(_, p)| is_account_part_for(p, user_id));
        let pair = match existing {
            Some((pair, existing_part)) => {
                if existing_part != part {
                    let renamed = a.join(folder_pairs::full_name(pair.index, &part));
                    std::fs::rename(&pair.full_dir, &renamed).map_err(io)?;
                }
                std::fs::create_dir_all(&pair.short_dir).map_err(io)?;
                folder_pairs::find(&a, &part).map_err(io)?.ok_or("The account's folder disappeared.")?
            }
            None => folder_pairs::create(&a, &part, INDEXING).map_err(io)?,
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
            folder: folder_pairs::short_name(row.get::<i64, _>("pair_index") as u32),
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
        for parent in [self.a_dir(), self.b_dir()] {
            for (pair, part) in folder_pairs::list(&parent).map_err(io)? {
                if is_account_part_for(&part, user_id) {
                    folder_pairs::delete(&parent, &part).map_err(io)?;
                    let _ = pair;
                }
            }
        }
        for table in ["branch_changes", "branches", "listings", "entries", "accounts"] {
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
        Ok(self.a_dir().join(folder_pairs::short_name(pair_index as u32)).join(crate::layout::FILES_CONTENT_FOLDER))
    }

    /// Throws away everything cached for the account (listings, metadata, contents); branches stay.
    pub async fn clear(&self, user_id: i64) -> Result<(), String> {
        let _guard = self.lock(user_id).await;
        let content = self.content_root(user_id).await?;
        match std::fs::remove_dir_all(&content) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io(e)),
        }
        for table in ["listings", "entries"] {
            sqlx::query(&format!("DELETE FROM {table} WHERE user_id = ?1")).bind(user_id).execute(&self.pool).await.map_err(sql)?;
        }
        Ok(())
    }

    // ── The cached tree of the account itself ────────────────────────────────

    async fn entry(&self, user_id: i64, path: &str) -> Result<Option<EntryRow>, String> {
        sqlx::query_as::<_, EntryRow>(
            "SELECT path, name, is_dir, size, mtime_ms, local_name, content_at FROM entries WHERE user_id = ?1 AND path = ?2",
        )
        .bind(user_id)
        .bind(path)
        .fetch_optional(&self.pool)
        .await
        .map_err(sql)
    }

    async fn children(&self, user_id: i64, parent: &str) -> Result<Vec<EntryRow>, String> {
        sqlx::query_as::<_, EntryRow>(
            "SELECT path, name, is_dir, size, mtime_ms, local_name, content_at FROM entries WHERE user_id = ?1 AND parent = ?2",
        )
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
    /// under them.
    async fn sync_listing(&self, user_id: i64, path: &str, remote: Vec<RemoteEntry>) -> Result<(), String> {
        let now = self.now();
        let existing: HashMap<String, EntryRow> = self.children(user_id, path).await?.into_iter().map(|r| (r.name.clone(), r)).collect();
        let listed: HashSet<&str> = remote.iter().map(|e| e.name.as_str()).collect();

        for (name, row) in &existing {
            if !listed.contains(name.as_str()) {
                self.drop_subtree(user_id, &row.path).await?;
            }
        }

        let mut taken: HashSet<String> =
            existing.iter().filter(|(n, _)| listed.contains(n.as_str())).map(|(_, r)| r.local_name.to_lowercase()).collect();
        for entry in remote {
            let entry_path = join_path(path, &entry.name);
            match existing.get(&entry.name) {
                Some(row) if (row.is_dir != 0) == entry.is_directory => {
                    let changed = row.size != entry.size.map(|s| s as i64) || row.mtime_ms != entry.mtime_ms.map(|m| m as i64);
                    if changed && row.content_at.is_some() {
                        let local = self.mirror_path(user_id, &entry_path).await?;
                        let _ = std::fs::remove_file(local);
                    }
                    sqlx::query(
                        "UPDATE entries SET size = ?3, mtime_ms = ?4, fetched_at = ?5, content_at = CASE WHEN ?6 THEN NULL ELSE content_at END
                         WHERE user_id = ?1 AND path = ?2",
                    )
                    .bind(user_id)
                    .bind(&entry_path)
                    .bind(entry.size.map(|s| s as i64))
                    .bind(entry.mtime_ms.map(|m| m as i64))
                    .bind(now)
                    .bind(changed)
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
                        "INSERT INTO entries (user_id, path, parent, name, is_dir, size, mtime_ms, local_name, fetched_at, content_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)",
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
        Ok(())
    }

    fn to_entry(row: &EntryRow) -> CacheEntry {
        CacheEntry {
            name: row.name.clone(),
            is_directory: row.is_dir != 0,
            size: row.size.map(|s| s as u64),
            mtime_ms: row.mtime_ms.map(|m| m as u64),
            cached: row.content_at.is_some(),
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
                    self.sync_listing(user_id, path, entries).await?;
                    (self.now(), false)
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
    async fn read_account(&self, remote: &impl Remote, user_id: i64, path: &str) -> Result<Vec<u8>, String> {
        let parent = parent_of(path).ok_or("That's the root folder, not a file.")?;
        self.list_account(remote, user_id, &parent, false).await?; // validates the listing (and so the entry)
        let entry = self.entry(user_id, path).await?.ok_or_else(|| format!("\"{path}\" doesn't exist."))?;
        if entry.is_dir != 0 {
            return Err(format!("\"{path}\" is a folder."));
        }
        let local = self.mirror_path(user_id, path).await?;
        if entry.content_at.is_some() {
            if let Ok(bytes) = std::fs::read(&local) {
                return Ok(bytes);
            }
        }
        let bytes = remote.read_file(path).await?;
        self.store_content(user_id, path, &local, &bytes).await?;
        Ok(bytes)
    }

    async fn store_content(&self, user_id: i64, path: &str, local: &Path, bytes: &[u8]) -> Result<(), String> {
        if let Some(dir) = local.parent() {
            std::fs::create_dir_all(dir).map_err(io)?;
        }
        std::fs::write(local, bytes).map_err(io)?;
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
                self.list_account(remote, user_id, &parent, false).await?;
                remote.write_file(&path, bytes).await?;
                self.list_account(remote, user_id, &parent, true).await?; // Filen's own idea of the new file
                let local = self.mirror_path(user_id, &path).await?;
                self.store_content(user_id, &path, &local, bytes).await
            }
        }
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
                self.drop_subtree(user_id, &from).await?;
                let mut affected: Vec<String> = parent_of(&from).into_iter().collect();
                affected.extend(prefixes(&to).iter().filter_map(|p| parent_of(p)));
                self.invalidate_listings(user_id, &affected).await
            }
        }
    }

    // ── Branches ─────────────────────────────────────────────────────────────

    async fn account_branch_part(&self, user_id: i64) -> Result<String, String> {
        let info = self.account_info(user_id).await?;
        Ok(account_part(&info.email, user_id))
    }

    /// `files/b/NNN/MMM` — the branch's short folder.
    async fn branch_dir(&self, user_id: i64, branch: i64) -> Result<PathBuf, String> {
        let part = self.account_branch_part(user_id).await?;
        let account = folder_pairs::find(&self.b_dir(), &part).map_err(io)?.ok_or("That branch doesn't exist.")?;
        Ok(account.short_dir.join(folder_pairs::short_name(branch as u32)))
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
        let info = self.account_info(user_id).await?;
        if self.branches(user_id).await?.iter().any(|b| b.name.to_lowercase() == name.to_lowercase()) {
            return Err(format!("There is a branch called \"{name}\" already."));
        }
        let account = folder_pairs::ensure(&self.b_dir(), &account_part(&info.email, user_id), INDEXING).map_err(io)?;
        let pair = folder_pairs::create(&account.short_dir, name, INDEXING).map_err(io)?;
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
        if let Ok(part) = self.account_branch_part(user_id).await {
            if let Some(account) = folder_pairs::find(&self.b_dir(), &part).map_err(io)? {
                folder_pairs::delete(&account.short_dir, name).map_err(io)?;
                // With no branches left, the account's own pair in `b` goes too.
                if folder_pairs::list(&account.short_dir).map_err(io)?.is_empty() {
                    folder_pairs::delete(&self.b_dir(), &part).map_err(io)?;
                }
            }
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
            entries.retain(|e| e.name != name);
            match change.kind.as_str() {
                "delete" => {}
                "mkdir" => entries.push(CacheEntry { name, is_directory: true, size: None, mtime_ms: Some(change.changed_at as u64), cached: false, changed: Some("mkdir".into()) }),
                _ => {
                    let local = self.branch_local_path(user_id, branch, &change.path).await?;
                    let size = std::fs::metadata(&local).map(|m| m.len()).ok();
                    entries.push(CacheEntry { name, is_directory: false, size, mtime_ms: Some(change.changed_at as u64), cached: true, changed: Some("put".into()) });
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
        self.branch_exists(user_id, branch).await?;
        if self.deleted_in_branch(user_id, branch, path).await? {
            return Err(format!("\"{path}\" was deleted in this branch."));
        }
        if self.change(user_id, branch, path).await?.is_some_and(|c| c.kind == "put") {
            return std::fs::read(self.branch_local_path(user_id, branch, path).await?).map_err(io);
        }
        self.read_account(remote, user_id, path).await
    }

    async fn write_branch(&self, remote: &impl Remote, user_id: i64, branch: i64, path: &str, parent: &str, bytes: &[u8]) -> Result<(), String> {
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
        std::fs::write(local, bytes).map_err(io)
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

        // Filen as it is now, one fresh listing per folder involved.
        let mut current: HashMap<String, Option<Vec<CacheEntry>>> = HashMap::new();
        let mut conflicts = Vec::new();
        for change in &changes {
            let parent = parent_of(&change.path).unwrap_or_else(|| "/".to_string());
            if !current.contains_key(&parent) {
                let listing = self.list_account(remote, user_id, &parent, true).await.ok().map(|l| l.entries);
                current.insert(parent.clone(), listing);
            }
            let now_entry = current[&parent].as_ref().and_then(|entries| entries.iter().find(|e| e.name == name_of(&change.path)));
            let same_as_base = |e: &CacheEntry| e.size.map(|s| s as i64) == change.base_size && e.mtime_ms.map(|m| m as i64) == change.base_mtime_ms;
            let problem = match (change.kind.as_str(), change.base_exists != 0, now_entry) {
                ("mkdir", _, Some(e)) if !e.is_directory => Some("a file with that name exists in Filen now"),
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

        // Folders first (top down), then files, then deletions (bottom up).
        changes.sort_by_key(|c| (match c.kind.as_str() { "mkdir" => 0, "put" => 1, _ => 2 }, if c.kind == "delete" { -(depth(c) as i64) } else { depth(c) as i64 }));
        let mut applied = 0;
        let mut touched: Vec<String> = Vec::new();
        for change in &changes {
            match change.kind.as_str() {
                "mkdir" => remote.mkdir(&change.path).await?,
                "put" => {
                    let bytes = std::fs::read(self.branch_local_path(user_id, branch, &change.path).await?).map_err(io)?;
                    remote.write_file(&change.path, &bytes).await?;
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

        // Filen changed, so what's cached about it is out of date.
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
                        out.push(RemoteEntry { name: rest.to_string(), is_directory: false, size: Some(bytes.len() as u64), mtime_ms: Some(bytes.iter().map(|b| *b as u64).sum::<u64>() + 1000) });
                    }
                }
            }
            for folder in self.folders.lock().unwrap().iter() {
                if let Some(rest) = folder.strip_prefix(&prefix) {
                    if !rest.is_empty() && !rest.contains('/') {
                        out.push(RemoteEntry { name: rest.to_string(), is_directory: true, size: None, mtime_ms: None });
                    }
                }
            }
            Ok(out)
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>, String> {
            self.check_online()?;
            self.reads.fetch_add(1, Ordering::SeqCst);
            self.files.lock().unwrap().get(path).cloned().ok_or_else(|| format!("{path} not found"))
        }
        async fn write_file(&self, path: &str, content: &[u8]) -> Result<(), String> {
            self.check_online()?;
            self.put(path, &String::from_utf8_lossy(content));
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
            assert!(f.base.join("b").join("001-filen@@new@example.com@@7").is_dir());
            f.cache.forget_account(7).await.unwrap();
            assert!(!a.join("001").exists() && !a.join("001-filen@@new@example.com@@7").exists());
            assert!(std::fs::read_dir(f.base.join("b")).unwrap().next().is_none(), "the branches' pair goes too");
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
            let account_b = f.base.join("b/001-filen@@me@example.com@@7");
            assert!(account_b.is_dir() && f.base.join("b/001/001").is_dir() && f.base.join("b/001/001-my draft").is_dir(), "the branch's pair");
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

    #[test]
    fn several_branches_get_their_own_pairs() {
        run(async {
            let f = Fixture::new("several").await;
            let one = f.cache.create_branch(7, "first").await.unwrap();
            let two = f.cache.create_branch(7, "second").await.unwrap();
            assert_eq!((one.index, two.index), (1, 2));
            f.cache.discard_branch(7, one.index).await.unwrap();
            assert!(f.base.join("b/001/002-second").is_dir() && !f.base.join("b/001/001-first").exists());
            assert_eq!(f.cache.create_branch(7, "third").await.unwrap().index, 1, "the gap the discarded branch left is filled");
            assert!(f.base.join("b/001/001-third").is_dir());
            assert_eq!(f.cache.create_branch(7, "fourth").await.unwrap().index, 3, "and with no gap left: the largest plus one");
        });
    }
}
