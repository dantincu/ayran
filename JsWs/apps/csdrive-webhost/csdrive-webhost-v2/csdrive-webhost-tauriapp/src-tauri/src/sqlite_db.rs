//! SQLite access for the admin-app's SQLite studio and for user-provided web apps —
//! in place of `tauri-plugin-sql`, which will open *any* path on disk. Every
//! database is named by a root (`user`, or a picked folder's id) and a path inside it and opened
//! through `authorize`, so only files inside the user folder or inside a folder the user has picked
//! (both of which are in `fs_scope` — the same scope the file commands obey) can be reached. The
//! handle a window gets back is that same virtual name, never the file's real location.
//!
//! SQLite has its own ways to name files — `ATTACH DATABASE`, `VACUUM INTO`,
//! `PRAGMA temp_store_directory` — which would sidestep that check, so every connection
//! also runs under an authorizer (see `install_authorizer`) that refuses them (`ATTACH` of anything
//! but an in-memory or temporary database, since SQL can't name a root), and `VACUUM INTO` (which
//! SQLite doesn't route through the authorizer) is refused by `reject_forbidden_statements`.
//!
//! Values cross the boundary as JSON: `null`, booleans, numbers, strings (binds), and
//! rows come back as `{column: value}` objects with BLOBs as arrays of byte values
//! (the same shape `tauri-plugin-sql` used, so callers didn't have to change).

use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_void, CStr};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Map, Value};
use libsqlite3_sys as ffi;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions, SqliteRow};
use sqlx::SqliteConnection;
use sqlx::{Column, Row, SqlitePool, TypeInfo, ValueRef};
use tauri::{AppHandle, Manager};

use crate::fs_scope::FsScope;

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

/// Resolves `path` inside `root` to the real file it names and checks it's somewhere the user has
/// made available. Also returns the *handle* by which windows name the database: the root and the
/// tidied relative path — never the real location.
fn authorize(app: &AppHandle, root: &str, path: &str) -> Result<(PathBuf, String), String> {
    let real = app.state::<FsScope>().check_in(root, path, true)?;
    let tidy: Vec<&str> = path.split('/').filter(|s| !s.is_empty() && *s != ".").collect();
    Ok((real, format!("{root}/{}", tidy.join("/"))))
}

/// Whether SQLite may `ATTACH` the database named `name`: only an in-memory or temporary one. A file
/// can't be named safely from SQL — a window doesn't know real paths, and a root can't be spoken
/// there — so none is allowed.
fn attach_target_allowed(name: &str) -> bool {
    name.is_empty() || name == ":memory:"
}

unsafe extern "C" fn authorizer(
    _context: *mut c_void,
    action: c_int,
    arg1: *const c_char,
    arg2: *const c_char,
    _database: *const c_char,
    _trigger: *const c_char,
) -> c_int {
    let text = |p: *const c_char| if p.is_null() { None } else { CStr::from_ptr(p).to_str().ok() };

    let allowed = match action {
        ffi::SQLITE_ATTACH => text(arg1).is_some_and(attach_target_allowed),
        ffi::SQLITE_PRAGMA => !text(arg1)
            .is_some_and(|name| ["temp_store_directory", "data_store_directory"].iter().any(|p| name.eq_ignore_ascii_case(p))),
        ffi::SQLITE_FUNCTION => !text(arg2).is_some_and(|name| name.eq_ignore_ascii_case("load_extension")),
        _ => true,
    };
    if allowed { ffi::SQLITE_OK } else { ffi::SQLITE_DENY }
}

/// Makes SQLite consult `authorizer` for everything the connection prepares.
async fn install_authorizer(connection: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    let mut handle = connection.lock_handle().await?;
    unsafe {
        ffi::sqlite3_set_authorizer(handle.as_raw_handle().as_ptr(), Some(authorizer), std::ptr::null_mut());
    }
    Ok(())
}

fn guarded_pool_options() -> SqlitePoolOptions {
    SqlitePoolOptions::new().after_connect(|connection, _meta| Box::pin(async move { install_authorizer(connection).await }))
}

/// Statements SQLite doesn't put through the authorizer but that write to a path the
/// caller names. Token-based so that the words inside string literals, comments or
/// quoted names don't trip it.
fn reject_forbidden_statements(sql: &str) -> Result<(), String> {
    let mut tokens: Vec<String> = Vec::new();
    let chars: Vec<char> = sql.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
        } else if c == '-' && chars.get(i + 1) == Some(&'-') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
        } else if c == '\'' || c == '"' || c == '`' || c == '[' {
            let close = if c == '[' { ']' } else { c };
            i += 1;
            while i < chars.len() && chars[i] != close {
                i += 1;
            }
            i += 1;
            tokens.push("<quoted>".to_string());
        } else if c.is_alphanumeric() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            tokens.push(chars[start..i].iter().collect::<String>().to_lowercase());
        } else {
            tokens.push(c.to_string());
            i += 1;
        }
    }

    // VACUUM [schema-name] INTO <file>
    let vacuum_into = tokens.iter().enumerate().any(|(n, t)| {
        t == "vacuum" && (tokens.get(n + 1).is_some_and(|x| x == "into") || tokens.get(n + 2).is_some_and(|x| x == "into"))
    });
    if vacuum_into {
        return Err("VACUUM INTO isn't supported.".to_string());
    }
    Ok(())
}

async fn connect(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::new().filename(path).create_if_missing(true);
    guarded_pool_options().connect_with(options).await
}

/// Opens (creating it if need be) the SQLite database at `path` inside `root` (`user`, or a picked
/// folder's id) and returns its handle — `<root>/<path>`, which is only valid in this window.
#[tauri::command]
pub async fn sqlite_load(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SqliteState>,
    root: String,
    path: String,
) -> Result<String, String> {
    let (real, handle) = authorize(&app, &root, &path)?;
    let key = (crate::window_host::caller_key(&window), handle.clone());

    if !state.pools.lock().unwrap().contains_key(&key) {
        let pool = connect(&real).await.map_err(|e| e.to_string())?;
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
    state.close(&crate::window_host::caller_key(&window), db.as_deref()).await;
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
    reject_forbidden_statements(&query)?;
    let pool = state.get(&crate::window_host::caller_key(&window), &db)?;
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
    reject_forbidden_statements(&query)?;
    let pool = state.get(&crate::window_host::caller_key(&window), &db)?;
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
    fn sqlite_cannot_be_used_to_reach_files_outside_the_allowed_folders() {
        tauri::async_runtime::block_on(async {
            let root = std::env::temp_dir().join(format!("csdrive-sqlite-guard-test-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            let (allowed, outside) = (root.join("allowed"), root.join("outside"));
            std::fs::create_dir_all(&allowed).unwrap();
            std::fs::create_dir_all(&outside).unwrap();
            let allowed = allowed.canonicalize().unwrap();
            let outside = outside.canonicalize().unwrap();

            // A database with a secret in it, outside the allowed folder.
            let secret = outside.join("secret.db");
            let plain = connect(&secret).await.unwrap();
            run_execute(&plain, "CREATE TABLE t (x)", &[]).await.unwrap();
            run_execute(&plain, "INSERT INTO t VALUES ('top secret')", &[]).await.unwrap();
            plain.close().await;

            let db = connect(&allowed.join("mine.db")).await.unwrap();

            let attach = |p: &Path| format!("ATTACH DATABASE '{}' AS x", p.display());
            assert!(run_execute(&db, &attach(&secret), &[]).await.is_err(), "attaching an outside database must fail");
            assert!(run_select(&db, "SELECT * FROM x.t", &[]).await.is_err(), "and nothing is readable through it");
            assert!(run_execute(&db, &attach(&outside.join("new.db")), &[]).await.is_err(), "nor may it create one there");
            assert!(!outside.join("new.db").exists());

            // No file can be attached at all — a window can't name one safely, inside or out.
            assert!(run_execute(&db, &attach(&allowed.join("other.db")), &[]).await.is_err(), "not even inside the allowed folder");
            assert!(!allowed.join("other.db").exists());
            assert!(run_execute(&db, "ATTACH DATABASE 'relative.db' AS r", &[]).await.is_err(), "relative names are refused");
            assert!(run_execute(&db, "ATTACH DATABASE 'file:x.db?mode=rwc' AS u", &[]).await.is_err(), "URI names are refused");
            assert!(run_execute(&db, "ATTACH DATABASE ':memory:' AS m", &[]).await.is_ok(), "in-memory is fine");
            assert!(
                run_execute(&db, &format!("PRAGMA temp_store_directory = '{}'", outside.display()), &[]).await.is_err(),
                "temp_store_directory is refused"
            );

            run_execute(&db, "CREATE TABLE ok (v TEXT)", &[]).await.unwrap();
            run_execute(&db, "INSERT INTO ok VALUES ('attach vacuum into pragma')", &[]).await.unwrap();
            assert_eq!(run_select(&db, "SELECT v FROM ok", &[]).await.unwrap().len(), 1, "ordinary SQL is unaffected");

            db.close().await;
            let _ = std::fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn vacuum_into_is_refused_but_lookalikes_are_not() {
        for bad in [
            "VACUUM INTO 'C:\\x.db'",
            "vacuum into \"x\"",
            "VACUUM main INTO 'x'",
            "  /* hi */ Vacuum\n  temp\n INTO ?1",
            "PRAGMA foreign_keys=ON; VACUUM INTO 'x'",
        ] {
            assert!(reject_forbidden_statements(bad).is_err(), "{bad}");
        }
        for fine in [
            "VACUUM",
            "VACUUM main",
            "SELECT 'vacuum into'",
            "-- vacuum into\nSELECT 1",
            "INSERT INTO vacuum VALUES (1)",
            "SELECT \"vacuum\" FROM t WHERE x IN (SELECT into_col FROM u)",
            "/* VACUUM INTO 'x' */ SELECT 1",
        ] {
            assert!(reject_forbidden_statements(fine).is_ok(), "{fine}");
        }
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
