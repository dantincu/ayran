use rusqlite::{params, Connection};
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

    Ok(Arc::new(Mutex::new(conn)))
}

pub fn clear_folder(conn: &Connection, account_id: &str, parent_id: &str) -> Result<(), String> {
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

/// Remove a single item from the cache without touching the rest of the folder.
/// Used after a client-side delete so the cache stays consistent.
pub fn delete_item(conn: &Connection, account_id: &str, item_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM folder_items WHERE account_id = ?1 AND item_id = ?2",
        params![account_id, item_id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
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
    .map_err(|e| e.to_string())
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

pub fn query_items(
    conn: &Connection,
    account_id: &str,
    parent_id: &str,
    search: Option<&str>,
    sort_by: &str,
    ascending: bool,
) -> Result<Vec<CachedItem>, String> {
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
    let sql = format!(
        "SELECT account_id, account_email, storage_type, item_id, parent_id,
                name, is_dir, size, modified_ms, mime_type
         FROM folder_items
         WHERE account_id = ?1 AND parent_id = ?2 AND (?3 IS NULL OR name LIKE ?3)
         ORDER BY {}",
        order
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![account_id, parent_id, pattern], |row| {
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
        })
        .map_err(|e| e.to_string())?;
    rows.map(|r| r.map_err(|e| e.to_string())).collect()
}
