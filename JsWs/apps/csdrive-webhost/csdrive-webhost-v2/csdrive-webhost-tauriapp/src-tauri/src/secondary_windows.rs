use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// Emitted whenever a secondary window (or one of its tab groups/tabs) is opened,
/// closed, suspended, reopened, or edited, so the "Windows" tab in the main window
/// can refresh its list live.
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
    pub tab_groups: Vec<TabGroupRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabGroupRecord {
    pub guid: String,
    pub window_guid: String,
    pub created_at: i64,
    pub tags: Vec<TagRecord>,
    pub tabs: Vec<TabRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabRecord {
    pub guid: String,
    pub group_guid: String,
    pub window_guid: String,
    pub relative_path: String,
    pub app_version: i64,
    pub resource_id: String,
    pub title: String,
    pub resource_type: String,
    pub created_at: i64,
    pub tags: Vec<TagRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabInitResponse {
    pub tab_guid: String,
    pub group_guid: String,
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

    // Tags are generic: `guid` names whatever they're attached to — a window, a tab
    // group, or a tab — with no foreign key tying it to one specific table.
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

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS tab_groups (
            guid TEXT PRIMARY KEY,
            window_guid TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS tabs (
            guid TEXT PRIMARY KEY,
            group_guid TEXT NOT NULL,
            window_guid TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            app_version INTEGER NOT NULL,
            resource_id TEXT NOT NULL,
            title TEXT NOT NULL,
            resource_type TEXT NOT NULL,
            created_at INTEGER NOT NULL
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
    let user_dir = crate::data_location::effective_data_dir(app)?.join("user");
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

/// Builds the `csuser://localhost/<relative_path>` window and wires up the close
/// handler that deletes (or, if suspending, preserves) its `data.db` row. The window's
/// own label is its guid — that's how `init_window_tab` knows which window called it,
/// without needing to pass the guid through the URL.
fn build_window(app: &AppHandle, guid: &str, relative_path: &str) -> Result<(), String> {
    let base = Url::parse(&format!("{}://localhost/", crate::USER_PROTOCOL)).map_err(|e| e.to_string())?;
    let url = base.join(relative_path).map_err(|e| e.to_string())?;

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

/// Deletes a secondary window's row along with its tab groups, tabs, and every tag
/// attached to any of them.
async fn delete_window_and_tags(pool: &SqlitePool, guid: &str) {
    let tab_guids: Vec<String> = sqlx::query_scalar("SELECT guid FROM tabs WHERE window_guid = ?1")
        .bind(guid)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
    let group_guids: Vec<String> = sqlx::query_scalar("SELECT guid FROM tab_groups WHERE window_guid = ?1")
        .bind(guid)
        .fetch_all(pool)
        .await
        .unwrap_or_default();

    let _ = sqlx::query("DELETE FROM tabs WHERE window_guid = ?1").bind(guid).execute(pool).await;
    let _ = sqlx::query("DELETE FROM tab_groups WHERE window_guid = ?1").bind(guid).execute(pool).await;
    for g in tab_guids.iter().chain(group_guids.iter()) {
        let _ = sqlx::query("DELETE FROM window_tags WHERE guid = ?1").bind(g).execute(pool).await;
    }

    let _ = sqlx::query("DELETE FROM secondary_windows WHERE guid = ?1").bind(guid).execute(pool).await;
    let _ = sqlx::query("DELETE FROM window_tags WHERE guid = ?1").bind(guid).execute(pool).await;
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

/// Fetches every tab belonging to any of `group_guids`, each with its own tags.
async fn fetch_tabs(pool: &SqlitePool, group_guids: &[String]) -> Result<Vec<TabRecord>, sqlx::Error> {
    if group_guids.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders = (1..=group_guids.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
    let query = format!(
        "SELECT guid, group_guid, window_guid, relative_path, app_version, resource_id, title, resource_type, created_at
         FROM tabs WHERE group_guid IN ({placeholders}) ORDER BY created_at ASC"
    );

    let mut q = sqlx::query(&query);
    for guid in group_guids {
        q = q.bind(guid);
    }
    let rows = q.fetch_all(pool).await?;

    let tab_guids: Vec<String> = rows.iter().map(|row| row.get::<String, _>("guid")).collect();
    let all_tags = fetch_tags(pool, &tab_guids).await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let guid: String = row.get("guid");
            let tags = all_tags.iter().filter(|t| t.guid == guid).cloned().collect();
            TabRecord {
                guid,
                group_guid: row.get("group_guid"),
                window_guid: row.get("window_guid"),
                relative_path: row.get("relative_path"),
                app_version: row.get("app_version"),
                resource_id: row.get("resource_id"),
                title: row.get("title"),
                resource_type: row.get("resource_type"),
                created_at: row.get("created_at"),
                tags,
            }
        })
        .collect())
}

/// Fetches every tab group belonging to any of `window_guids`, each with its own tags
/// and nested tabs.
async fn fetch_tab_groups(pool: &SqlitePool, window_guids: &[String]) -> Result<Vec<TabGroupRecord>, sqlx::Error> {
    if window_guids.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders = (1..=window_guids.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
    let query = format!(
        "SELECT guid, window_guid, created_at FROM tab_groups WHERE window_guid IN ({placeholders}) ORDER BY created_at ASC"
    );

    let mut q = sqlx::query(&query);
    for guid in window_guids {
        q = q.bind(guid);
    }
    let rows = q.fetch_all(pool).await?;

    let group_guids: Vec<String> = rows.iter().map(|row| row.get::<String, _>("guid")).collect();
    let all_tags = fetch_tags(pool, &group_guids).await?;
    let all_tabs = fetch_tabs(pool, &group_guids).await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let guid: String = row.get("guid");
            let tags = all_tags.iter().filter(|t| t.guid == guid).cloned().collect();
            let tabs = all_tabs.iter().filter(|t| t.group_guid == guid).cloned().collect();
            TabGroupRecord {
                guid,
                window_guid: row.get("window_guid"),
                created_at: row.get("created_at"),
                tags,
                tabs,
            }
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
    let all_groups = fetch_tab_groups(&state.pool, &guids).await.map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|(guid, relative_path, created_at)| {
            let is_open = app.get_webview_window(&guid).is_some();
            let tags = all_tags.iter().filter(|t| t.guid == guid).cloned().collect();
            let tab_groups = all_groups.iter().filter(|g| g.window_guid == guid).cloned().collect();
            SecondaryWindowRecord {
                guid,
                relative_path,
                created_at,
                is_open,
                tags,
                tab_groups,
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
        tab_groups: Vec::new(),
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
        tab_groups: Vec::new(),
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

/// Called by an app running *inside* a secondary window to register one of its
/// resources (a document, a view, ...) as a tab. The calling window's own label is
/// its guid (see `build_window`), so the window never needs to know or send its own
/// guid — Tauri hands it to us via the `window` parameter. The window's first ever
/// call creates its default tab group; every call creates a new tab in it (or in
/// whichever group the tab has since been moved to, on a version bump / reconnect —
/// out of scope for this first cut, so today every call makes a fresh tab).
async fn init_window_tab_impl(
    pool: &SqlitePool,
    window_guid: &str,
    relative_path: &str,
    app_version: i64,
    resource_id: &str,
    title: &str,
    resource_type: &str,
) -> Result<TabInitResponse, String> {
    let existing_group: Option<String> = sqlx::query_scalar(
        "SELECT guid FROM tab_groups WHERE window_guid = ?1 ORDER BY created_at ASC LIMIT 1",
    )
    .bind(window_guid)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    let group_guid = match existing_group {
        Some(g) => g,
        None => {
            let g = uuid::Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO tab_groups (guid, window_guid, created_at) VALUES (?1, ?2, ?3)")
                .bind(&g)
                .bind(window_guid)
                .bind(current_millis())
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            g
        }
    };

    let tab_guid = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO tabs (guid, group_guid, window_guid, relative_path, app_version, resource_id, title, resource_type, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )
    .bind(&tab_guid)
    .bind(&group_guid)
    .bind(window_guid)
    .bind(relative_path)
    .bind(app_version)
    .bind(resource_id)
    .bind(title)
    .bind(resource_type)
    .bind(current_millis())
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(TabInitResponse { tab_guid, group_guid })
}

/// Called by an app running *inside* a secondary window to register one of its
/// resources (a document, a view, ...) as a tab. The calling window's own label is
/// its guid (see `build_window`), so the window never needs to know or send its own
/// guid — Tauri hands it to us via the `window` parameter. The window's first ever
/// call creates its default tab group; every call creates a new tab in it (or in
/// whichever group the tab has since been moved to, on a version bump / reconnect —
/// out of scope for this first cut, so today every call makes a fresh tab).
#[tauri::command]
pub async fn init_window_tab(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    relative_path: String,
    app_version: i64,
    resource_id: String,
    title: String,
    resource_type: String,
) -> Result<TabInitResponse, String> {
    let result = init_window_tab_impl(
        &state.pool,
        window.label(),
        &relative_path,
        app_version,
        &resource_id,
        &title,
        &resource_type,
    )
    .await?;

    let _ = app.emit(EVENT_CHANGED, ());
    Ok(result)
}

/// Creates an empty tab group under a window, so tabs have somewhere to be moved to
/// besides a window's single default group.
#[tauri::command]
pub async fn create_tab_group(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    window_guid: String,
) -> Result<TabGroupRecord, String> {
    let guid = uuid::Uuid::new_v4().to_string();
    let created_at = current_millis();
    sqlx::query("INSERT INTO tab_groups (guid, window_guid, created_at) VALUES (?1, ?2, ?3)")
        .bind(&guid)
        .bind(&window_guid)
        .bind(created_at)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;

    let _ = app.emit(EVENT_CHANGED, ());

    Ok(TabGroupRecord {
        guid,
        window_guid,
        created_at,
        tags: Vec::new(),
        tabs: Vec::new(),
    })
}

async fn move_tab_to_group_impl(pool: &SqlitePool, tab_guid: &str, target_group_guid: &str) -> Result<(), String> {
    let tab_relative_path: Option<String> = sqlx::query_scalar("SELECT relative_path FROM tabs WHERE guid = ?1")
        .bind(tab_guid)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    let tab_relative_path = tab_relative_path.ok_or_else(|| "Tab not found.".to_string())?;

    let target_window_guid: Option<String> =
        sqlx::query_scalar("SELECT window_guid FROM tab_groups WHERE guid = ?1")
            .bind(target_group_guid)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let target_window_guid = target_window_guid.ok_or_else(|| "Target group not found.".to_string())?;

    let target_relative_path: Option<String> =
        sqlx::query_scalar("SELECT relative_path FROM secondary_windows WHERE guid = ?1")
            .bind(&target_window_guid)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let target_relative_path = target_relative_path.ok_or_else(|| "Target window not found.".to_string())?;

    if tab_relative_path != target_relative_path {
        return Err("Tabs can only move within windows of the same app.".to_string());
    }

    sqlx::query("UPDATE tabs SET group_guid = ?1, window_guid = ?2 WHERE guid = ?3")
        .bind(target_group_guid)
        .bind(&target_window_guid)
        .bind(tab_guid)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Moves a tab into a different group — possibly a group belonging to a different
/// window, as long as that window hosts the same html file (same app).
#[tauri::command]
pub async fn move_tab_to_group(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    tab_guid: String,
    target_group_guid: String,
) -> Result<(), String> {
    move_tab_to_group_impl(&state.pool, &tab_guid, &target_group_guid).await?;
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh `data.db` under an isolated OS temp dir — never the real app-data folder.
    async fn test_pool(name: &str) -> SqlitePool {
        let dir = std::env::temp_dir().join(format!("csdrive-secondary-windows-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        init_db(&dir).await.unwrap()
    }

    async fn insert_window(pool: &SqlitePool, guid: &str, relative_path: &str) {
        sqlx::query("INSERT INTO secondary_windows (guid, relative_path, created_at) VALUES (?1, ?2, ?3)")
            .bind(guid)
            .bind(relative_path)
            .bind(current_millis())
            .execute(pool)
            .await
            .unwrap();
    }

    #[test]
    fn init_window_tab_creates_one_group_then_reuses_it() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("init-reuse").await;
            insert_window(&pool, "win1", "asdf/index.html").await;

            let first = init_window_tab_impl(&pool, "win1", "asdf/index.html", 1, "res-a", "Title A", "document")
                .await
                .unwrap();
            let second = init_window_tab_impl(&pool, "win1", "asdf/index.html", 1, "res-b", "Title B", "document")
                .await
                .unwrap();

            assert_eq!(first.group_guid, second.group_guid, "both tabs should land in the window's one default group");
            assert_ne!(first.tab_guid, second.tab_guid);

            let groups = fetch_tab_groups(&pool, &["win1".to_string()]).await.unwrap();
            assert_eq!(groups.len(), 1);
            assert_eq!(groups[0].tabs.len(), 2);
        });
    }

    #[test]
    fn move_tab_to_group_rejects_windows_of_a_different_app() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("move-reject").await;
            insert_window(&pool, "win1", "asdf/index1.html").await;
            insert_window(&pool, "win2", "asdf/index2.html").await;

            let tab = init_window_tab_impl(&pool, "win1", "asdf/index1.html", 1, "res-a", "Title A", "document")
                .await
                .unwrap();
            let other_group = init_window_tab_impl(&pool, "win2", "asdf/index2.html", 1, "res-b", "Title B", "document")
                .await
                .unwrap();

            let err = move_tab_to_group_impl(&pool, &tab.tab_guid, &other_group.group_guid)
                .await
                .unwrap_err();
            assert!(err.contains("same app"));
        });
    }

    #[test]
    fn move_tab_to_group_allows_a_different_window_of_the_same_app() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("move-allow").await;
            insert_window(&pool, "win1", "asdf/index.html").await;
            insert_window(&pool, "win2", "asdf/index.html").await;

            let tab = init_window_tab_impl(&pool, "win1", "asdf/index.html", 1, "res-a", "Title A", "document")
                .await
                .unwrap();
            let target_group = init_window_tab_impl(&pool, "win2", "asdf/index.html", 1, "res-b", "Title B", "document")
                .await
                .unwrap();

            move_tab_to_group_impl(&pool, &tab.tab_guid, &target_group.group_guid)
                .await
                .unwrap();

            let groups = fetch_tab_groups(&pool, &["win2".to_string()]).await.unwrap();
            assert_eq!(groups[0].tabs.len(), 2, "the moved tab should now be alongside win2's own tab");
        });
    }

    #[test]
    fn deleting_a_window_cascades_to_its_groups_tabs_and_tags() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("cascade").await;
            insert_window(&pool, "win1", "asdf/index.html").await;

            let tab = init_window_tab_impl(&pool, "win1", "asdf/index.html", 1, "res-a", "Title A", "document")
                .await
                .unwrap();

            sqlx::query("INSERT INTO window_tags (guid, text, fg_color, bg_color) VALUES (?1, 'x', '#fff', '#000')")
                .bind(&tab.tab_guid)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO window_tags (guid, text, fg_color, bg_color) VALUES (?1, 'x', '#fff', '#000')")
                .bind(&tab.group_guid)
                .execute(&pool)
                .await
                .unwrap();

            delete_window_and_tags(&pool, "win1").await;

            let groups = fetch_tab_groups(&pool, &["win1".to_string()]).await.unwrap();
            assert!(groups.is_empty());

            let remaining_tags = fetch_tags(&pool, &[tab.tab_guid, tab.group_guid]).await.unwrap();
            assert!(remaining_tags.is_empty(), "tags on the deleted tab/group must be gone too");
        });
    }
}
