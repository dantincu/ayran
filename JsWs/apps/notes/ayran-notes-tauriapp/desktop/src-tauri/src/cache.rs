use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Arc, Mutex};

pub const STORAGE_LOCAL_FS: i32 = 0;
pub const STORAGE_GOOGLE_DRIVE: i32 = 1;
pub const STORAGE_FILEN: i32 = 2;

// Bump this whenever the schema changes — the cache is always regeneratable so
// we just drop and recreate the table on a version mismatch.
const SCHEMA_VERSION: i32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedItem {
    pub account_id: String,
    pub account_email: String,
    pub storage_type: i32,
    pub item_id: String,
    pub parent_id: String,
    pub name: String,
    pub is_dir: bool,
    pub size: Option<i64>,
    pub modified_ms: Option<i64>,
    pub mime_type: Option<String>,
}

pub type CacheDb = Arc<Mutex<Connection>>;

pub fn open(data_dir: &Path) -> Result<CacheDb, String> {
    let path = data_dir.join("folder_cache.db");
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;

    // Drop the old table when the schema is outdated — the data is always
    // regeneratable from the cloud / local FS.
    let version: i32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    if version < SCHEMA_VERSION {
        conn.execute_batch(
            "DROP TABLE IF EXISTS folder_items;
             DROP INDEX IF EXISTS idx_folder;
             DROP INDEX IF EXISTS idx_parent;",
        )
        .map_err(|e| e.to_string())?;
    }

    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         CREATE TABLE IF NOT EXISTS folder_items (
             id           INTEGER PRIMARY KEY AUTOINCREMENT,
             account_id   TEXT    NOT NULL,
             account_email TEXT   NOT NULL,
             storage_type INTEGER NOT NULL,
             item_id      TEXT    NOT NULL,
             parent_id    TEXT    NOT NULL,
             name         TEXT    NOT NULL,
             is_dir       INTEGER NOT NULL DEFAULT 0,
             size         INTEGER,
             modified_ms  INTEGER,
             mime_type    TEXT,
             cached_at    INTEGER NOT NULL DEFAULT 0,
             UNIQUE(account_id, item_id)
         );
         CREATE INDEX IF NOT EXISTS idx_parent
             ON folder_items(account_id, parent_id);",
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        &format!("PRAGMA user_version = {}", SCHEMA_VERSION),
        [],
    )
    .map_err(|e| e.to_string())?;

    // Content-cache path index — never auto-expired; persists across restarts.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS content_cache (
             account_id    TEXT NOT NULL,
             item_id       TEXT NOT NULL,
             relative_path TEXT NOT NULL,
             PRIMARY KEY (account_id, item_id)
         );",
    )
    .map_err(|e| e.to_string())?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS path_index (
             account_id TEXT    NOT NULL,
             path       TEXT    NOT NULL,
             path_hash  INTEGER NOT NULL,
             item_id    TEXT    NOT NULL,
             is_dir     INTEGER NOT NULL DEFAULT 0,
             PRIMARY KEY (account_id, path)
         );
         CREATE INDEX IF NOT EXISTS idx_path_index_hash
             ON path_index(account_id, path_hash);
         CREATE INDEX IF NOT EXISTS idx_path_index_item
             ON path_index(account_id, item_id);",
    )
    .map_err(|e| e.to_string())?;

    // Shelveset tables — structural changes (delete/rename/move on existing items)
    // and content changes (new or modified file bodies stored in the s/ folder).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS shelveset_changes (
             id            INTEGER PRIMARY KEY AUTOINCREMENT,
             account_id    TEXT    NOT NULL,
             operation     TEXT    NOT NULL,
             item_id       TEXT    NOT NULL,
             item_name     TEXT    NOT NULL,
             parent_id     TEXT    NOT NULL,
             new_name      TEXT,
             new_parent_id TEXT,
             is_dir        INTEGER NOT NULL DEFAULT 0,
             created_at    INTEGER NOT NULL,
             display_path  TEXT    NOT NULL DEFAULT ''
         );
         CREATE TABLE IF NOT EXISTS shelveset_contents (
             id            INTEGER PRIMARY KEY AUTOINCREMENT,
             account_id    TEXT    NOT NULL,
             item_id       TEXT    NOT NULL,
             item_name     TEXT    NOT NULL,
             parent_id     TEXT    NOT NULL,
             is_dir        INTEGER NOT NULL DEFAULT 0,
             is_new        INTEGER NOT NULL DEFAULT 0,
             created_at    INTEGER NOT NULL,
             display_path  TEXT    NOT NULL DEFAULT '',
             UNIQUE(account_id, item_id)
         );",
    )
    .map_err(|e| e.to_string())?;

    Ok(Arc::new(Mutex::new(conn)))
}

// ── Content-cache path index ──────────────────────────────────────────────────

pub fn get_content_cache_path(conn: &Connection, account_id: &str, item_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT relative_path FROM content_cache WHERE account_id=?1 AND item_id=?2",
        params![account_id, item_id],
        |r| r.get(0),
    )
    .optional()
    .unwrap_or(None)
}

pub fn set_content_cache_path(conn: &Connection, account_id: &str, item_id: &str, relative_path: &str) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO content_cache (account_id, item_id, relative_path) VALUES (?1,?2,?3)",
        params![account_id, item_id, relative_path],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn delete_content_cache_entry(conn: &Connection, account_id: &str, item_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM content_cache WHERE account_id=?1 AND item_id=?2",
        params![account_id, item_id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

// ── Path index ────────────────────────────────────────────────────────────────

/// FNV-1a 64-bit hash, stored as SQLite INTEGER for fast prefix filtering.
fn path_hash(s: &str) -> i64 {
    let mut h: u64 = 14695981039346656037;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    h as i64
}

/// Escape special LIKE characters (`\`, `%`, `_`) using backslash as the escape char.
fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Look up the indexed path for an item (used when computing children's paths).
pub fn get_path_for_item(conn: &Connection, account_id: &str, item_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT path FROM path_index WHERE account_id = ?1 AND item_id = ?2",
        params![account_id, item_id],
        |r| r.get(0),
    )
    .optional()
    .unwrap_or(None)
}

/// Resolve a human-readable path to an item_id.
pub fn get_item_id_by_path(conn: &Connection, account_id: &str, path: &str) -> Option<String> {
    let h = path_hash(path);
    conn.query_row(
        "SELECT item_id FROM path_index \
         WHERE account_id = ?1 AND path_hash = ?2 AND path = ?3",
        params![account_id, h, path],
        |r| r.get(0),
    )
    .optional()
    .unwrap_or(None)
}

/// Insert or update path entries for a batch of items (called after every listing).
/// `entries` = (path, item_id, is_dir).
pub fn upsert_path_index_batch(
    conn: &mut Connection,
    account_id: &str,
    entries: &[(String, String, bool)],
) -> Result<(), String> {
    if entries.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT OR REPLACE INTO path_index \
                 (account_id, path, path_hash, item_id, is_dir) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(|e| e.to_string())?;
        for (path, item_id, is_dir) in entries {
            stmt.execute(params![
                account_id,
                path,
                path_hash(path),
                item_id,
                *is_dir as i32,
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Delete a path_index entry and all of its descendants (subtree under `path/`).
/// Also falls back to an item_id delete in case the item was never indexed by path.
fn delete_path_subtree(conn: &Connection, account_id: &str, path: &str, item_id: &str) {
    let prefix = format!("{}/", escape_like(path));
    let _ = conn.execute(
        "DELETE FROM path_index \
         WHERE account_id = ?1 AND (path = ?2 OR path LIKE ?3 || '%' ESCAPE ?4)",
        params![account_id, path, prefix, "\\"],
    );
    // Belt-and-suspenders: remove by item_id too (handles un-indexed items).
    let _ = conn.execute(
        "DELETE FROM path_index WHERE account_id = ?1 AND item_id = ?2",
        params![account_id, item_id],
    );
}

/// Remove path_index rows whose item_id no longer exists in folder_items.
/// Called once at startup after the TTL-based row cleanup.
pub fn cleanup_path_index_orphans(conn: &Connection) -> Result<u64, String> {
    conn.execute(
        "DELETE FROM path_index \
         WHERE NOT EXISTS ( \
             SELECT 1 FROM folder_items f \
             WHERE f.account_id = path_index.account_id \
               AND f.item_id    = path_index.item_id \
         )",
        [],
    )
    .map(|n| n as u64)
    .map_err(|e| e.to_string())
}

pub fn clear_folder(conn: &Connection, account_id: &str, parent_id: &str) -> Result<(), String> {
    // Delete path_index entries for direct children before their folder_items rows
    // are gone (the subquery still finds them at this point).
    let _ = conn.execute(
        "DELETE FROM path_index \
         WHERE account_id = ?1 AND item_id IN ( \
             SELECT item_id FROM folder_items \
             WHERE account_id = ?1 AND parent_id = ?2 \
         )",
        params![account_id, parent_id],
    );
    conn.execute(
        "DELETE FROM folder_items WHERE account_id = ?1 AND parent_id = ?2",
        params![account_id, parent_id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Returns the Unix-ms timestamp at which the folder's cache was last populated,
/// or `None` if the folder has never been cached.
pub fn get_folder_cached_at(
    conn: &Connection,
    account_id: &str,
    parent_id: &str,
) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT MAX(cached_at) FROM folder_items \
         WHERE account_id = ?1 AND parent_id = ?2",
        params![account_id, parent_id],
        |row| row.get::<_, Option<i64>>(0),
    )
    .map_err(|e| e.to_string())
}

/// Delete an item and every descendant that has been cached beneath it.
/// Uses a recursive CTE so the whole subtree is removed in one statement.
/// Used after a client-side folder (or file) delete.
pub fn cascade_delete_item(
    conn: &Connection,
    account_id: &str,
    item_id: &str,
) -> Result<(), String> {
    // Capture the indexed path before the rows are gone.
    let item_path: Option<String> = conn
        .query_row(
            "SELECT path FROM path_index WHERE account_id = ?1 AND item_id = ?2",
            params![account_id, item_id],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None);

    conn.execute(
        "WITH RECURSIVE sub(id) AS (
             SELECT ?2
             UNION ALL
             SELECT f.item_id FROM folder_items f
             INNER JOIN sub ON f.parent_id = sub.id AND f.account_id = ?1
         )
         DELETE FROM folder_items
         WHERE account_id = ?1 AND item_id IN (SELECT id FROM sub)",
        params![account_id, item_id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())?;

    if let Some(ref p) = item_path {
        delete_path_subtree(conn, account_id, p, item_id);
    } else {
        let _ = conn.execute(
            "DELETE FROM path_index WHERE account_id = ?1 AND item_id = ?2",
            params![account_id, item_id],
        );
    }
    Ok(())
}

/// Update the name of a single cached item without re-fetching the whole folder.
/// Used after a client-side rename so the cache stays consistent.
pub fn rename_item(
    conn: &Connection,
    account_id: &str,
    item_id: &str,
    new_name: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE folder_items SET name = ?3 \
         WHERE account_id = ?1 AND item_id = ?2",
        params![account_id, item_id, new_name],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())?;

    // Stale paths (old name and every descendant) are removed so the next
    // listing rebuilds them with the correct new name.
    let old_path: Option<String> = conn
        .query_row(
            "SELECT path FROM path_index WHERE account_id = ?1 AND item_id = ?2",
            params![account_id, item_id],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None);
    if let Some(ref op) = old_path {
        delete_path_subtree(conn, account_id, op, item_id);
    } else {
        let _ = conn.execute(
            "DELETE FROM path_index WHERE account_id = ?1 AND item_id = ?2",
            params![account_id, item_id],
        );
    }
    Ok(())
}

/// Delete rows whose `parent_id` no longer exists as an `item_id` in the cache
/// for this account — i.e. rows that are children of externally-deleted folders.
/// `root_parent_id` is the account's top-level folder ID (never appears as an
/// `item_id` row), which must be excluded from the orphan check.
pub fn cleanup_orphans(
    conn: &Connection,
    account_id: &str,
    root_parent_id: &str,
) -> Result<u64, String> {
    conn.execute(
        "DELETE FROM folder_items
         WHERE account_id = ?1
           AND parent_id != ?2
           AND parent_id NOT IN (
               SELECT item_id FROM folder_items WHERE account_id = ?1
           )",
        params![account_id, root_parent_id],
    )
    .map(|n| n as u64)
    .map_err(|e| e.to_string())
}

/// Delete all rows older than `max_age_ms` milliseconds across every account.
/// Called once on app startup as a safety net for any orphans that slipped through.
pub fn cleanup_old_rows(conn: &Connection, max_age_ms: i64) -> Result<u64, String> {
    let cutoff_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
        - max_age_ms;
    conn.execute(
        "DELETE FROM folder_items WHERE cached_at < ?1",
        params![cutoff_ms],
    )
    .map(|n| n as u64)
    .map_err(|e| e.to_string())
}

/// Reconstructs the path components from the drive root down to `item_id`,
/// using the human-readable names stored in the metadata cache.
/// Returns `["FolderA", "FolderB", "filename.txt"]` (root→item order).
/// Falls back to `[item_id]` when the item is not in the cache.
pub fn item_path_from_root(
    conn: &Connection,
    account_id: &str,
    item_id: &str,
    root_parent_id: &str,
) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = item_id.to_string();
    for _ in 0..100 {
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT name, parent_id FROM folder_items WHERE account_id=?1 AND item_id=?2",
                params![account_id, &current],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .unwrap_or(None);
        match row {
            Some((name, parent_id)) => {
                parts.push(name);
                if parent_id == root_parent_id { break; }
                current = parent_id;
            }
            None => {
                if parts.is_empty() { parts.push(current); }
                break;
            }
        }
    }
    parts.reverse();
    parts
}

/// Returns all item_ids for an account — used by content-cache orphan cleanup.
pub fn all_item_ids_for_account(conn: &Connection, account_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT item_id FROM folder_items WHERE account_id = ?1")
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([account_id], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(ids)
}

pub fn insert_batch(conn: &mut Connection, items: &[CachedItem]) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT OR REPLACE INTO folder_items
                 (account_id, account_email, storage_type, item_id, parent_id,
                  name, is_dir, size, modified_ms, mime_type, cached_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            )
            .map_err(|e| e.to_string())?;
        for item in items {
            stmt.execute(params![
                item.account_id,
                item.account_email,
                item.storage_type,
                item.item_id,
                item.parent_id,
                item.name,
                item.is_dir as i32,
                item.size,
                item.modified_ms,
                item.mime_type,
                now_ms,
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Returned by [`query_items_paged`] — one page of items plus the unfiltered total
/// (needed by the frontend to compute the page count).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPage {
    pub items: Vec<CachedItem>,
    pub total: u64,
}

pub fn query_items_paged(
    conn: &Connection,
    account_id: &str,
    parent_id: &str,
    search: Option<&str>,
    sort_by: &str,
    ascending: bool,
    page: u32,
    page_size: u32,
) -> Result<FolderPage, String> {
    let sort_col = match sort_by {
        "size" => "size",
        "modified" => "modified_ms",
        _ => "name",
    };
    let dir = if ascending { "ASC" } else { "DESC" };
    // Folders always first; within each group apply the chosen column, then name
    // as a tiebreaker so the order is fully deterministic.
    let order = format!("is_dir DESC, {} {}, name ASC", sort_col, dir);
    let pattern = search.map(|q| format!("%{}%", q));

    let total: u64 = conn
        .query_row(
            "SELECT COUNT(*) FROM folder_items \
             WHERE account_id = ?1 AND parent_id = ?2 AND (?3 IS NULL OR name LIKE ?3)",
            params![account_id, parent_id, pattern.as_deref()],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let offset = (page as i64) * (page_size as i64);
    let limit = page_size as i64;
    let sql = format!(
        "SELECT account_id, account_email, storage_type, item_id, parent_id,
                name, is_dir, size, modified_ms, mime_type
         FROM folder_items
         WHERE account_id = ?1 AND parent_id = ?2 AND (?3 IS NULL OR name LIKE ?3)
         ORDER BY {}
         LIMIT ?4 OFFSET ?5",
        order
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![account_id, parent_id, pattern.as_deref(), limit, offset],
            |row| {
                Ok(CachedItem {
                    account_id: row.get(0)?,
                    account_email: row.get(1)?,
                    storage_type: row.get(2)?,
                    item_id: row.get(3)?,
                    parent_id: row.get(4)?,
                    name: row.get(5)?,
                    is_dir: row.get::<_, i32>(6)? != 0,
                    size: row.get(7)?,
                    modified_ms: row.get(8)?,
                    mime_type: row.get(9)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    let items = rows
        .map(|r| r.map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(FolderPage { items, total })
}
