use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// Emitted whenever a secondary window is opened, closed, suspended, or reopened,
/// so the "Windows" tab in the main window can refresh its list live.
pub const EVENT_CHANGED: &str = "secondary-windows-changed";

pub struct SecondaryWindowsState {
    pool: SqlitePool,
    /// Guids whose *next* Destroyed event should NOT delete the DB row (a suspend in progress).
    pending_suspend: Mutex<HashSet<String>>,
}

impl SecondaryWindowsState {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            pool,
            pending_suspend: Mutex::new(HashSet::new()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecondaryWindowRecord {
    pub guid: String,
    pub relative_path: String,
    pub created_at: i64,
    pub is_open: bool,
    pub tags: Vec<TagRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRecord {
    pub id: i64,
    pub guid: String,
    pub text: String,
    pub fg_color: String,
    pub bg_color: String,
}

/// Opens (creating if needed) the app's own `data.db`, living directly under the app data
/// directory — outside the user-editable `user` folder — and ensures its schema exists.
pub async fn init_db(app_data_dir: &std::path::Path) -> Result<SqlitePool, sqlx::Error> {
    std::fs::create_dir_all(app_data_dir)?;
    let db_path = app_data_dir.join("data.db");
    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true);
    let pool = SqlitePool::connect_with(options).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS secondary_windows (
            guid TEXT PRIMARY KEY,
            relative_path TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS window_tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guid TEXT NOT NULL,
            text TEXT NOT NULL,
            fg_color TEXT NOT NULL,
            bg_color TEXT NOT NULL
        )",
    )
    .execute(&pool)
    .await?;

    Ok(pool)
}

fn current_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Rejects paths that escape the user folder or don't point at an existing .html/.htm file.
fn validate_relative_html_path(app: &AppHandle, relative_path: &str) -> Result<(), String> {
    let user_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("user");
    let candidate = user_dir.join(relative_path);

    let canonical_user_dir = user_dir.canonicalize().map_err(|e| e.to_string())?;
    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|_| format!("\"{relative_path}\" does not exist."))?;

    if !canonical_candidate.starts_with(&canonical_user_dir) {
        return Err("Path escapes the user folder.".to_string());
    }

    let ext = canonical_candidate
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "html" && ext != "htm" {
        return Err("Only .html/.htm files can be opened as web apps.".to_string());
    }

    Ok(())
}

/// Builds the `csuser://localhost/<relative_path>?uuid=<guid>` window and wires up the
/// close handler that deletes (or, if suspending, preserves) its `data.db` row.
fn build_window(app: &AppHandle, guid: &str, relative_path: &str) -> Result<(), String> {
    let base = Url::parse(&format!("{}://localhost/", crate::USER_PROTOCOL)).map_err(|e| e.to_string())?;
    let mut url = base.join(relative_path).map_err(|e| e.to_string())?;
    url.set_query(Some(&format!("uuid={guid}")));

    let window = WebviewWindowBuilder::new(app, guid, WebviewUrl::CustomProtocol(url))
        .title(relative_path)
        .inner_size(1024.0, 768.0)
        .build()
        .map_err(|e| e.to_string())?;

    let app_for_event = app.clone();
    let guid_for_event = guid.to_string();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            let app_handle = app_for_event.clone();
            let guid = guid_for_event.clone();
            tauri::async_runtime::spawn(async move {
                handle_window_destroyed(&app_handle, &guid).await;
            });
        }
    });

    Ok(())
}

/// Deletes a secondary window's row and all of its tags.
async fn delete_window_and_tags(pool: &SqlitePool, guid: &str) {
    let _ = sqlx::query("DELETE FROM secondary_windows WHERE guid = ?1")
        .bind(guid)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM window_tags WHERE guid = ?1")
        .bind(guid)
        .execute(pool)
        .await;
}

async fn handle_window_destroyed(app: &AppHandle, guid: &str) {
    let state = app.state::<SecondaryWindowsState>();

    let was_suspended = {
        let mut pending = state.pending_suspend.lock().unwrap();
        pending.remove(guid)
    };

    if !was_suspended {
        delete_window_and_tags(&state.pool, guid).await;
    }

    let _ = app.emit(EVENT_CHANGED, ());
}

async fn fetch_tags(pool: &SqlitePool, guids: &[String]) -> Result<Vec<TagRecord>, sqlx::Error> {
    if guids.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders = (1..=guids.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
    let query = format!(
        "SELECT id, guid, text, fg_color, bg_color FROM window_tags WHERE guid IN ({placeholders}) ORDER BY id ASC"
    );

    let mut q = sqlx::query(&query);
    for guid in guids {
        q = q.bind(guid);
    }

    let rows = q.fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|row| TagRecord {
            id: row.get("id"),
            guid: row.get("guid"),
            text: row.get("text"),
            fg_color: row.get("fg_color"),
            bg_color: row.get("bg_color"),
        })
        .collect())
}

async fn fetch_rows(
    pool: &SqlitePool,
    relative_path: Option<&str>,
) -> Result<Vec<(String, String, i64)>, sqlx::Error> {
    let rows = if let Some(rp) = relative_path {
        sqlx::query(
            "SELECT guid, relative_path, created_at FROM secondary_windows
             WHERE relative_path = ?1 ORDER BY created_at DESC",
        )
        .bind(rp)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query(
            "SELECT guid, relative_path, created_at FROM secondary_windows
             ORDER BY relative_path ASC, created_at DESC",
        )
        .fetch_all(pool)
        .await?
    };

    Ok(rows
        .into_iter()
        .map(|row| {
            let guid: String = row.get("guid");
            let relative_path: String = row.get("relative_path");
            let created_at: i64 = row.get("created_at");
            (guid, relative_path, created_at)
        })
        .collect())
}

#[tauri::command]
pub async fn list_secondary_windows(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
) -> Result<Vec<SecondaryWindowRecord>, String> {
    let rows = fetch_rows(&state.pool, None).await.map_err(|e| e.to_string())?;
    let guids: Vec<String> = rows.iter().map(|(guid, _, _)| guid.clone()).collect();
    let all_tags = fetch_tags(&state.pool, &guids).await.map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|(guid, relative_path, created_at)| {
            let is_open = app.get_webview_window(&guid).is_some();
            let tags = all_tags.iter().filter(|t| t.guid == guid).cloned().collect();
            SecondaryWindowRecord {
                guid,
                relative_path,
                created_at,
                is_open,
                tags,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn add_window_tag(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    guid: String,
    text: String,
    fg_color: String,
    bg_color: String,
) -> Result<TagRecord, String> {
    let id = sqlx::query("INSERT INTO window_tags (guid, text, fg_color, bg_color) VALUES (?1, ?2, ?3, ?4)")
        .bind(&guid)
        .bind(&text)
        .bind(&fg_color)
        .bind(&bg_color)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?
        .last_insert_rowid();

    let _ = app.emit(EVENT_CHANGED, ());

    Ok(TagRecord {
        id,
        guid,
        text,
        fg_color,
        bg_color,
    })
}

#[tauri::command]
pub async fn remove_window_tag(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    id: i64,
) -> Result<(), String> {
    sqlx::query("DELETE FROM window_tags WHERE id = ?1")
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub async fn open_new_secondary_window(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    relative_path: String,
) -> Result<SecondaryWindowRecord, String> {
    validate_relative_html_path(&app, &relative_path)?;

    let guid = uuid::Uuid::new_v4().to_string();
    let created_at = current_millis();

    sqlx::query("INSERT INTO secondary_windows (guid, relative_path, created_at) VALUES (?1, ?2, ?3)")
        .bind(&guid)
        .bind(&relative_path)
        .bind(created_at)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;

    build_window(&app, &guid, &relative_path)?;
    let _ = app.emit(EVENT_CHANGED, ());

    Ok(SecondaryWindowRecord {
        guid,
        relative_path,
        created_at,
        is_open: true,
        tags: Vec::new(),
    })
}

/// Registers a new entry in an existing (or new) group without opening a window for
/// it — the user can open it later via `reopen_secondary_window`.
#[tauri::command]
pub async fn add_secondary_window_entry(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    relative_path: String,
) -> Result<SecondaryWindowRecord, String> {
    validate_relative_html_path(&app, &relative_path)?;

    let guid = uuid::Uuid::new_v4().to_string();
    let created_at = current_millis();

    sqlx::query("INSERT INTO secondary_windows (guid, relative_path, created_at) VALUES (?1, ?2, ?3)")
        .bind(&guid)
        .bind(&relative_path)
        .bind(created_at)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;

    let _ = app.emit(EVENT_CHANGED, ());

    Ok(SecondaryWindowRecord {
        guid,
        relative_path,
        created_at,
        is_open: false,
        tags: Vec::new(),
    })
}

#[tauri::command]
pub async fn reopen_secondary_window(
    app: AppHandle,
    guid: String,
    relative_path: String,
) -> Result<(), String> {
    validate_relative_html_path(&app, &relative_path)?;

    if app.get_webview_window(&guid).is_some() {
        return Ok(());
    }

    build_window(&app, &guid, &relative_path)?;
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn close_secondary_window(app: AppHandle, guid: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&guid) {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn suspend_secondary_window(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    guid: String,
) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&guid) {
        state.pending_suspend.lock().unwrap().insert(guid);
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn close_all_secondary_windows(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    relative_path: Option<String>,
) -> Result<(), String> {
    let rows = fetch_rows(&state.pool, relative_path.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    for (guid, _, _) in rows {
        if let Some(w) = app.get_webview_window(&guid) {
            // Destroyed handler deletes the row (and its tags) once the window actually closes.
            let _ = w.close();
        } else {
            delete_window_and_tags(&state.pool, &guid).await;
        }
    }

    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub async fn suspend_all_secondary_windows(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    relative_path: Option<String>,
) -> Result<(), String> {
    let rows = fetch_rows(&state.pool, relative_path.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    for (guid, _, _) in rows {
        if let Some(w) = app.get_webview_window(&guid) {
            state.pending_suspend.lock().unwrap().insert(guid.clone());
            let _ = w.close();
        }
    }

    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn focus_secondary_window(app: AppHandle, guid: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&guid) {
        let _ = w.unminimize();
        w.set_focus().map_err(|e| e.to_string())?;
        w.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}
