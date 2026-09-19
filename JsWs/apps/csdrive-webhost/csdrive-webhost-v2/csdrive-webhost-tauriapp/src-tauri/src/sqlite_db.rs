//! SQLite access for the admin-app's SQLite studio and for user-provided web apps —
//! in place of `tauri-plugin-sql`, which will open *any* path on disk. Every
//! database is opened through `authorize`, so only files inside the user folder or
//! inside a folder the user has picked with a native dialog (both of which are in the
//! plugin-fs runtime scope — the same scope the file APIs obey) can be reached.
//!
//! Values cross the boundary as JSON: `null`, booleans, numbers, strings (binds), and
//! rows come back as `{column: value}` objects with BLOBs as arrays of byte values
//! (the same shape `tauri-plugin-sql` used, so callers didn't have to change).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Map, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqliteRow};
use sqlx::{Column, Row, SqlitePool, TypeInfo, ValueRef};
use tauri::AppHandle;
use tauri_plugin_fs::FsExt;

use crate::data_location;

/// Open databases, per window: a handle is only usable by the window that loaded it.
#[derive(Default)]
pub struct SqliteState {
    pools: Mutex<HashMap<(String, String), SqlitePool>>,
}

impl SqliteState {
    fn get(&self, window_label: &str, db: &str) -> Result<SqlitePool, String> {
        self.pools
            .lock()
            .unwrap()
            .get(&(window_label.to_string(), db.to_string()))
            .cloned()
            .ok_or_else(|| "That database isn't open — load it first.".to_string())
    }

    /// Closes (and forgets) `db` for a window, or every database the window has open.
    pub async fn close(&self, window_label: &str, db: Option<&str>) {
        let removed: Vec<SqlitePool> = {
            let mut pools = self.pools.lock().unwrap();
            let keys: Vec<(String, String)> = pools
                .keys()
                .filter(|(label, path)| label == window_label && db.is_none_or(|d| d == path))
                .cloned()
                .collect();
            keys.into_iter().filter_map(|k| pools.remove(&k)).collect()
        };
        for pool in removed {
            pool.close().await;
        }
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResult {
    pub rows_affected: u64,
    pub last_insert_id: i64,
}

/// Resolves `path` (absolute, or relative to the user folder) to the real file it
/// names and checks it's somewhere the user has made available.
fn authorize(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let requested = PathBuf::from(path);
    let requested = if requested.is_absolute() {
        requested
    } else {
        data_location::effective_data_dir(app)?.join("user").join(requested)
    };

    // Resolve symlinks and `..` before checking, so neither can escape the scope. A
    // database that doesn't exist yet is resolved via its parent folder.
    let resolved = match requested.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            let parent = requested
                .parent()
                .ok_or_else(|| format!("\"{path}\" isn't a valid path."))?
                .canonicalize()
                .map_err(|_| format!("\"{path}\" isn't in a folder that exists."))?;
            let name = requested.file_name().ok_or_else(|| format!("\"{path}\" isn't a valid path."))?;
            parent.join(name)
        }
    };

    if app.fs_scope().is_allowed(&resolved) {
        Ok(resolved)
    } else {
        Err(format!(
            "\"{path}\" is outside the user folder and the folders you've chosen, so it can't be opened."
        ))
    }
}

async fn connect(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::new().filename(path).create_if_missing(true);
    SqlitePool::connect_with(options).await
}

#[tauri::command]
pub async fn sqlite_load(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SqliteState>,
    path: String,
) -> Result<String, String> {
    let resolved = authorize(&app, &path)?;
    let handle = resolved.to_string_lossy().to_string();
    let key = (window.label().to_string(), handle.clone());

    if !state.pools.lock().unwrap().contains_key(&key) {
        let pool = connect(&resolved).await.map_err(|e| e.to_string())?;
        state.pools.lock().unwrap().insert(key, pool);
    }
    Ok(handle)
}

#[tauri::command]
pub async fn sqlite_close(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SqliteState>,
    db: Option<String>,
) -> Result<(), String> {
    state.close(window.label(), db.as_deref()).await;
    Ok(())
}

#[tauri::command]
pub async fn sqlite_execute(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SqliteState>,
    db: String,
    query: String,
    values: Option<Vec<Value>>,
) -> Result<ExecuteResult, String> {
    let pool = state.get(window.label(), &db)?;
    run_execute(&pool, &query, &values.unwrap_or_default()).await
}

#[tauri::command]
pub async fn sqlite_select(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SqliteState>,
    db: String,
    query: String,
    values: Option<Vec<Value>>,
) -> Result<Vec<Map<String, Value>>, String> {
    let pool = state.get(window.label(), &db)?;
    run_select(&pool, &query, &values.unwrap_or_default()).await
}

fn bind_all<'q>(
    mut query: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    values: &'q [Value],
) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    for value in values {
        query = match value {
            Value::Null => query.bind(None::<i64>),
            Value::Bool(b) => query.bind(*b),
            Value::Number(n) => match n.as_i64() {
                Some(i) => query.bind(i),
                None => query.bind(n.as_f64()),
            },
            Value::String(s) => query.bind(s.as_str()),
            other => query.bind(other.to_string()),
        };
    }
    query
}

async fn run_execute(pool: &SqlitePool, query: &str, values: &[Value]) -> Result<ExecuteResult, String> {
    let result = bind_all(sqlx::query(query), values).execute(pool).await.map_err(|e| e.to_string())?;
    Ok(ExecuteResult { rows_affected: result.rows_affected(), last_insert_id: result.last_insert_rowid() })
}

async fn run_select(pool: &SqlitePool, query: &str, values: &[Value]) -> Result<Vec<Map<String, Value>>, String> {
    let rows = bind_all(sqlx::query(query), values).fetch_all(pool).await.map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_json).collect())
}

fn row_to_json(row: &SqliteRow) -> Map<String, Value> {
    let mut map = Map::new();
    for (index, column) in row.columns().iter().enumerate() {
        map.insert(column.name().to_string(), cell_to_json(row, index));
    }
    map
}

fn cell_to_json(row: &SqliteRow, index: usize) -> Value {
    let Ok(raw) = row.try_get_raw(index) else { return Value::Null };
    if raw.is_null() {
        return Value::Null;
    }
    let declared = raw.type_info().name().to_ascii_uppercase();

    let as_int = || row.try_get::<i64, _>(index).ok().map(Value::from);
    let as_float = || row.try_get::<f64, _>(index).ok().and_then(|f| serde_json::Number::from_f64(f)).map(Value::Number);
    let as_text = || row.try_get::<String, _>(index).ok().map(Value::from);
    let as_blob = || {
        row.try_get::<Vec<u8>, _>(index)
            .ok()
            .map(|bytes| Value::Array(bytes.into_iter().map(Value::from).collect()))
    };
    let as_bool = || row.try_get::<bool, _>(index).ok().map(Value::from);

    let preferred = match declared.as_str() {
        "INTEGER" => as_int(),
        "REAL" => as_float(),
        "BOOLEAN" => as_bool(),
        "BLOB" => as_blob(),
        "TEXT" | "DATE" | "TIME" | "DATETIME" => as_text(),
        _ => None,
    };
    preferred.or_else(as_int).or_else(as_float).or_else(as_text).or_else(as_blob).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn memory_pool() -> SqlitePool {
        SqlitePool::connect_with(SqliteConnectOptions::new().filename(":memory:")).await.unwrap()
    }

    #[test]
    fn values_round_trip_through_execute_and_select() {
        tauri::async_runtime::block_on(async {
            let pool = sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(SqliteConnectOptions::new().filename(":memory:"))
                .await
                .unwrap();

            run_execute(&pool, "CREATE TABLE t (i INTEGER, r REAL, s TEXT, b BLOB, n TEXT)", &[]).await.unwrap();
            let inserted = run_execute(
                &pool,
                "INSERT INTO t (i, r, s, b, n) VALUES (?1, ?2, ?3, ?4, ?5)",
                &[json!(42), json!(1.5), json!("hi"), json!("bytes"), Value::Null],
            )
            .await
            .unwrap();
            assert_eq!(inserted, ExecuteResult { rows_affected: 1, last_insert_id: 1 });

            let rows = run_select(&pool, "SELECT i, r, s, b, n FROM t WHERE i = ?1", &[json!(42)]).await.unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0]["i"], json!(42));
            assert_eq!(rows[0]["r"], json!(1.5));
            assert_eq!(rows[0]["s"], json!("hi"));
            assert_eq!(rows[0]["n"], Value::Null);

            let computed = run_select(&pool, "SELECT count(*) AS c, 'x' AS t, 2.5 AS f FROM t", &[]).await.unwrap();
            assert_eq!(computed[0]["c"], json!(1));
            assert_eq!(computed[0]["t"], json!("x"));
            assert_eq!(computed[0]["f"], json!(2.5));

            assert!(run_select(&pool, "SELECT * FROM missing_table", &[]).await.is_err());
        });
    }

    #[test]
    fn closing_a_window_closes_only_its_own_databases() {
        tauri::async_runtime::block_on(async {
            let state = SqliteState::default();
            state.pools.lock().unwrap().insert(("a".into(), "/x.db".into()), memory_pool().await);
            state.pools.lock().unwrap().insert(("a".into(), "/y.db".into()), memory_pool().await);
            state.pools.lock().unwrap().insert(("b".into(), "/x.db".into()), memory_pool().await);

            assert!(state.get("b", "/x.db").is_ok());
            state.close("a", Some("/x.db")).await;
            assert!(state.get("a", "/x.db").is_err());
            assert!(state.get("a", "/y.db").is_ok());

            state.close("a", None).await;
            assert!(state.get("a", "/y.db").is_err());
            assert!(state.get("b", "/x.db").is_ok(), "another window's handle must survive");
        });
    }
}
