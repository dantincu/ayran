use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Emitter, Manager, Url};

/// Emitted whenever a secondary window (or one of its tab groups/tabs) is opened,
/// closed, suspended, reopened, or edited, so the "Apps" tab in the main window
/// can refresh its list live.
pub const EVENT_CHANGED: &str = "secondary-windows-changed";

pub struct SecondaryWindowsState {
    pool: SqlitePool,
    /// Guids whose *next* Destroyed event should NOT delete the DB row (a suspend in progress).
    pending_suspend: Mutex<HashSet<String>>,
    /// window_guid -> (tab_guid, force_stored_resource_id): the tab the *next*
    /// `init_window_tab` call from that window should bind to instead of creating a
    /// brand new one, consumed the moment that call arrives. Set in two different
    /// situations that must behave differently once bound:
    ///  - a window (re)opened with no tabs yet (`ensure_default_tab_group`) —
    ///    `force_stored_resource_id: false`, so the placeholder just gets filled in
    ///    with the real URL-derived resource id, like any other first tab would.
    ///  - a specific tab activated by the user (`activate_tab`) — `true`, so the
    ///    response echoes that tab's *own* stored resource id (empty, for one
    ///    that's never been used) instead of one derived from the reloaded page's
    ///    URL, letting the app decide what a reactivated/new tab should show.
    pending_tab_activation: Mutex<HashMap<String, (String, bool)>>,
}

impl SecondaryWindowsState {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            pool,
            pending_suspend: Mutex::new(HashSet::new()),
            pending_tab_activation: Mutex::new(HashMap::new()),
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
    pub name: Option<String>,
    pub tags: Vec<TagRecord>,
    pub tabs: Vec<TabRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabTextSpan {
    pub text: String,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabText {
    pub first_row: Vec<TabTextSpan>,
    pub second_row: Vec<TabTextSpan>,
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
    pub resource_type: Option<String>,
    /// The SVG registered for `resource_type` under this app, if any — resolved
    /// server-side so the window manager doesn't need to look it up itself.
    pub icon: Option<String>,
    pub tab_text: Option<TabText>,
    pub created_at: i64,
    pub tags: Vec<TagRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabInitResponse {
    pub tab_guid: String,
    pub resource_id: String,
    /// Snippets of css/html/javascript every web app should apply (see `code_snippets`).
    /// Filled in by the `init_window_tab` command, not by the database logic.
    pub code_snippets: Vec<crate::code_snippets::CodeSnippet>,
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

/// Opens (creating if needed) the app's own `data.db` inside `admin_dir` — the
/// `admin` folder, a sibling of the user-editable `user` folder that holds only
/// this app's own files (its database and its own frontend bundle) — and
/// ensures its schema exists.
pub async fn init_db(admin_dir: &std::path::Path) -> Result<SqlitePool, sqlx::Error> {
    std::fs::create_dir_all(admin_dir)?;
    let db_path = admin_dir.join("data.db");
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
            bg_color TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
        )",
    )
    .execute(&pool)
    .await?;

    // `sort_order` (user-arrangeable order among the tags on one guid) was added
    // after `window_tags` first shipped; existing rows all get 0 and so keep their
    // insertion (id) order until first rearranged.
    let has_tag_sort_order_column: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('window_tags') WHERE name = 'sort_order'",
    )
    .fetch_one(&pool)
    .await
    .unwrap_or(0);
    if has_tag_sort_order_column == 0 {
        sqlx::query("ALTER TABLE window_tags ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
            .execute(&pool)
            .await?;
    }

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS tab_groups (
            guid TEXT PRIMARY KEY,
            window_guid TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
    )
    .execute(&pool)
    .await?;

    // `name` (user-editable, defaults to a suggestive "Tab Group N" for
    // auto-created groups) was added after `tab_groups` first shipped.
    let has_group_name_column: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('tab_groups') WHERE name = 'name'",
    )
    .fetch_one(&pool)
    .await
    .unwrap_or(0);
    if has_group_name_column == 0 {
        sqlx::query("ALTER TABLE tab_groups ADD COLUMN name TEXT").execute(&pool).await?;
    }

    // The `tabs` schema changed shape early in its life (title/resource_type
    // columns dropped in favor of tab_text) before any real tab data existed —
    // drop and recreate rather than migrate if an old-shaped table is found.
    let has_old_tabs_schema: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('tabs') WHERE name = 'title'",
    )
    .fetch_one(&pool)
    .await
    .unwrap_or(0);
    if has_old_tabs_schema > 0 {
        sqlx::query("DROP TABLE tabs").execute(&pool).await?;
    }

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS tabs (
            guid TEXT PRIMARY KEY,
            group_guid TEXT NOT NULL,
            window_guid TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            app_version INTEGER NOT NULL,
            resource_id TEXT NOT NULL,
            resource_type TEXT,
            tab_text TEXT,
            created_at INTEGER NOT NULL
        )",
    )
    .execute(&pool)
    .await?;

    // `resource_type` was added after `tabs` first shipped — add it to any table
    // that predates it (a plain nullable column, so existing rows are unaffected).
    let has_resource_type_column: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('tabs') WHERE name = 'resource_type'",
    )
    .fetch_one(&pool)
    .await
    .unwrap_or(0);
    if has_resource_type_column == 0 {
        sqlx::query("ALTER TABLE tabs ADD COLUMN resource_type TEXT").execute(&pool).await?;
    }

    // Tracks the highest app_version seen for each html file, so init_window_tab can
    // tell when a page has shipped a newer build and its icon set may have changed.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_versions (
            relative_path TEXT PRIMARY KEY,
            version INTEGER NOT NULL
        )",
    )
    .execute(&pool)
    .await?;

    // One SVG per (app, resource type), supplied by the app itself in response to a
    // request-resource-icons event — see `submit_resource_icons`.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS resource_icons (
            relative_path TEXT NOT NULL,
            resource_type TEXT NOT NULL,
            svg TEXT NOT NULL,
            PRIMARY KEY (relative_path, resource_type)
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
    let user_dir = crate::layout::user_dir(&crate::data_location::effective_data_dir(app)?);
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

/// If `window_guid` has no tab groups yet, creates one ("Tab Group 1") with a
/// single blank placeholder tab inside it (empty resource id, no text) and
/// returns that tab's guid — so the caller can mark it pending (see
/// `SecondaryWindowsState::pending_tab_activation`), guaranteeing a freshly
/// opened window always shows at least one tab immediately rather than waiting
/// on the web app's own (possibly delayed, possibly never-sent) init request.
async fn ensure_default_tab_group(
    pool: &SqlitePool,
    window_guid: &str,
    relative_path: &str,
) -> Result<Option<String>, String> {
    let existing_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tab_groups WHERE window_guid = ?1")
        .bind(window_guid)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    if existing_count > 0 {
        return Ok(None);
    }

    let group_guid = uuid::Uuid::new_v4().to_string();
    let created_at = current_millis();
    sqlx::query("INSERT INTO tab_groups (guid, window_guid, created_at, name) VALUES (?1, ?2, ?3, 'Tab Group 1')")
        .bind(&group_guid)
        .bind(window_guid)
        .bind(created_at)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    let tab_guid = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO tabs (guid, group_guid, window_guid, relative_path, app_version, resource_id, resource_type, tab_text, created_at)
         VALUES (?1, ?2, ?3, ?4, 0, '', NULL, NULL, ?5)",
    )
    .bind(&tab_guid)
    .bind(&group_guid)
    .bind(window_guid)
    .bind(relative_path)
    .bind(created_at)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(Some(tab_guid))
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

/// Marks an entry's window as being *suspended*, so that when it goes away its entry is kept.
#[cfg_attr(desktop, allow(dead_code))] // used by the mobile window host
pub(crate) fn mark_suspending(app: &AppHandle, guid: &str) {
    app.state::<SecondaryWindowsState>().pending_suspend.lock().unwrap().insert(guid.to_string());
}

pub(crate) async fn handle_window_destroyed(app: &AppHandle, guid: &str) {
    // Release any SQLite databases the window still had open.
    app.state::<crate::sqlite_db::SqliteState>().close(guid, None).await;

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
        "SELECT id, guid, text, fg_color, bg_color FROM window_tags WHERE guid IN ({placeholders}) ORDER BY sort_order ASC, id ASC"
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

/// Fetches the registered icon (if any) for every (relative_path, resource_type)
/// pair that could be relevant to `relative_paths`.
async fn fetch_icons(
    pool: &SqlitePool,
    relative_paths: &[String],
) -> Result<std::collections::HashMap<(String, String), String>, sqlx::Error> {
    if relative_paths.is_empty() {
        return Ok(std::collections::HashMap::new());
    }

    let placeholders = (1..=relative_paths.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
    let query = format!(
        "SELECT relative_path, resource_type, svg FROM resource_icons WHERE relative_path IN ({placeholders})"
    );

    let mut q = sqlx::query(&query);
    for rp in relative_paths {
        q = q.bind(rp);
    }
    let rows = q.fetch_all(pool).await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let relative_path: String = row.get("relative_path");
            let resource_type: String = row.get("resource_type");
            let svg: String = row.get("svg");
            ((relative_path, resource_type), svg)
        })
        .collect())
}

/// Fetches every tab belonging to any of `group_guids`, each with its own tags and
/// its icon resolved (if it has a resource_type and that app has registered one).
async fn fetch_tabs(pool: &SqlitePool, group_guids: &[String]) -> Result<Vec<TabRecord>, sqlx::Error> {
    if group_guids.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders = (1..=group_guids.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
    let query = format!(
        "SELECT guid, group_guid, window_guid, relative_path, app_version, resource_id, resource_type, tab_text, created_at
         FROM tabs WHERE group_guid IN ({placeholders}) ORDER BY created_at ASC"
    );

    let mut q = sqlx::query(&query);
    for guid in group_guids {
        q = q.bind(guid);
    }
    let rows = q.fetch_all(pool).await?;

    let tab_guids: Vec<String> = rows.iter().map(|row| row.get::<String, _>("guid")).collect();
    let all_tags = fetch_tags(pool, &tab_guids).await?;

    let relative_paths: Vec<String> = rows
        .iter()
        .map(|row| row.get::<String, _>("relative_path"))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let icons = fetch_icons(pool, &relative_paths).await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let guid: String = row.get("guid");
            let relative_path: String = row.get("relative_path");
            let tags = all_tags.iter().filter(|t| t.guid == guid).cloned().collect();
            let tab_text_json: Option<String> = row.get("tab_text");
            let tab_text = tab_text_json.and_then(|json| serde_json::from_str::<TabText>(&json).ok());
            let resource_type: Option<String> = row.get("resource_type");
            let icon = resource_type
                .as_ref()
                .and_then(|rt| icons.get(&(relative_path.clone(), rt.clone())))
                .cloned();
            TabRecord {
                guid,
                group_guid: row.get("group_guid"),
                window_guid: row.get("window_guid"),
                relative_path,
                app_version: row.get("app_version"),
                resource_id: row.get("resource_id"),
                resource_type,
                icon,
                tab_text,
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
        "SELECT guid, window_guid, created_at, name FROM tab_groups WHERE window_guid IN ({placeholders}) ORDER BY created_at ASC"
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
                name: row.get("name"),
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
            let is_open = crate::window_host::is_open(&app, &guid);
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

/// Tags attached to arbitrary guids — e.g. a file-manager root, which isn't a
/// secondary window/group/tab and so isn't covered by `list_secondary_windows`.
#[tauri::command]
pub async fn list_tags(
    state: tauri::State<'_, SecondaryWindowsState>,
    guids: Vec<String>,
) -> Result<Vec<TagRecord>, String> {
    fetch_tags(&state.pool, &guids).await.map_err(|e| e.to_string())
}

async fn add_tag_impl(
    pool: &SqlitePool,
    guid: &str,
    text: &str,
    fg_color: &str,
    bg_color: &str,
) -> Result<TagRecord, sqlx::Error> {
    // New tags go after the guid's existing ones.
    let id = sqlx::query(
        "INSERT INTO window_tags (guid, text, fg_color, bg_color, sort_order)
         VALUES (?1, ?2, ?3, ?4, COALESCE((SELECT MAX(sort_order) FROM window_tags WHERE guid = ?1), -1) + 1)",
    )
    .bind(guid)
    .bind(text)
    .bind(fg_color)
    .bind(bg_color)
    .execute(pool)
    .await?
    .last_insert_rowid();

    Ok(TagRecord {
        id,
        guid: guid.to_string(),
        text: text.to_string(),
        fg_color: fg_color.to_string(),
        bg_color: bg_color.to_string(),
    })
}

async fn update_tag_impl(
    pool: &SqlitePool,
    id: i64,
    text: &str,
    fg_color: &str,
    bg_color: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE window_tags SET text = ?1, fg_color = ?2, bg_color = ?3 WHERE id = ?4")
        .bind(text)
        .bind(fg_color)
        .bind(bg_color)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Rewrites the order of the tags on `guid` to match `ids`. Ids that don't belong to
/// `guid` are ignored, and tags of `guid` missing from `ids` keep their relative order
/// after the listed ones.
async fn reorder_tags_impl(pool: &SqlitePool, guid: &str, ids: &[i64]) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    let current: Vec<i64> =
        sqlx::query_scalar("SELECT id FROM window_tags WHERE guid = ?1 ORDER BY sort_order ASC, id ASC")
            .bind(guid)
            .fetch_all(&mut *tx)
            .await?;

    let mut ordered: Vec<i64> = Vec::with_capacity(current.len());
    for id in ids {
        if current.contains(id) && !ordered.contains(id) {
            ordered.push(*id);
        }
    }
    for id in &current {
        if !ordered.contains(id) {
            ordered.push(*id);
        }
    }

    for (position, id) in ordered.iter().enumerate() {
        sqlx::query("UPDATE window_tags SET sort_order = ?1 WHERE id = ?2")
            .bind(position as i64)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await
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
    let tag = add_tag_impl(&state.pool, &guid, &text, &fg_color, &bg_color)
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(tag)
}

#[tauri::command]
pub async fn update_window_tag(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    id: i64,
    text: String,
    fg_color: String,
    bg_color: String,
) -> Result<(), String> {
    update_tag_impl(&state.pool, id, &text, &fg_color, &bg_color)
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub async fn reorder_window_tags(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    guid: String,
    ids: Vec<i64>,
) -> Result<(), String> {
    reorder_tags_impl(&state.pool, &guid, &ids).await.map_err(|e| e.to_string())?;
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
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

    if let Some(tab_guid) = ensure_default_tab_group(&state.pool, &guid, &relative_path).await? {
        state.pending_tab_activation.lock().unwrap().insert(guid.clone(), (tab_guid, false));
    }

    crate::window_host::open(&app, &guid, &relative_path)?;
    let _ = app.emit(EVENT_CHANGED, ());

    let tab_groups = fetch_tab_groups(&state.pool, &[guid.clone()]).await.map_err(|e| e.to_string())?;
    Ok(SecondaryWindowRecord {
        guid,
        relative_path,
        created_at,
        is_open: true,
        tags: Vec::new(),
        tab_groups,
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

    if let Some(tab_guid) = ensure_default_tab_group(&state.pool, &guid, &relative_path).await? {
        state.pending_tab_activation.lock().unwrap().insert(guid.clone(), (tab_guid, false));
    }

    let _ = app.emit(EVENT_CHANGED, ());

    let tab_groups = fetch_tab_groups(&state.pool, &[guid.clone()]).await.map_err(|e| e.to_string())?;
    Ok(SecondaryWindowRecord {
        guid,
        relative_path,
        created_at,
        is_open: false,
        tags: Vec::new(),
        tab_groups,
    })
}

#[tauri::command]
pub async fn reopen_secondary_window(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    guid: String,
    relative_path: String,
) -> Result<(), String> {
    validate_relative_html_path(&app, &relative_path)?;

    if crate::window_host::is_open(&app, &guid) {
        return Ok(());
    }

    // Defensive: a row from before this feature existed could have zero tab
    // groups; a normal reopen otherwise already has some from its original open.
    if let Some(tab_guid) = ensure_default_tab_group(&state.pool, &guid, &relative_path).await? {
        state.pending_tab_activation.lock().unwrap().insert(guid.clone(), (tab_guid, false));
    }

    crate::window_host::open(&app, &guid, &relative_path)?;
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn close_secondary_window(app: AppHandle, guid: String) -> Result<(), String> {
    crate::window_host::request_close(&app, &guid);
    Ok(())
}

#[tauri::command]
pub fn suspend_secondary_window(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    guid: String,
) -> Result<(), String> {
    if crate::window_host::is_open(&app, &guid) {
        state.pending_suspend.lock().unwrap().insert(guid.clone());
        crate::window_host::request_close(&app, &guid);
    }
    Ok(())
}

/// Closes every open secondary window matching `relative_path` (or all of them, if
/// `None`) and waits for them to actually finish closing before returning. Also
/// called directly (not just as a command) by the data-folder deletion flow in
/// `data_location`, which must not proceed while a window might still be reading
/// from — or writing tab data into — the folder about to be deleted.
#[tauri::command]
pub async fn close_all_secondary_windows(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    relative_path: Option<String>,
) -> Result<(), String> {
    let rows = fetch_rows(&state.pool, relative_path.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    let mut closing = Vec::new();
    for (guid, _, _) in &rows {
        if crate::window_host::request_close(&app, guid) {
            // The window-destroyed handler deletes the row (and its tags) once the window actually closes.
            closing.push(guid.clone());
        } else {
            delete_window_and_tags(&state.pool, guid).await;
        }
    }

    crate::window_host::wait_until_closed(&app, &closing).await;

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
        if crate::window_host::is_open(&app, &guid) {
            state.pending_suspend.lock().unwrap().insert(guid.clone());
            crate::window_host::request_close(&app, &guid);
        }
    }

    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn focus_secondary_window(app: AppHandle, guid: String) -> Result<(), String> {
    crate::window_host::focus(&app, &guid)
}

/// Splits a page's full `location.href` into the window's own html-file relative
/// path (no query — used to group tabs under the right app/window) and the tab's
/// resource identifier (relative path *with* its query string, if any — the piece
/// that actually distinguishes one open resource from another within that app).
fn split_url_into_path_and_resource_id(url: &str) -> Result<(String, String), String> {
    let parsed = Url::parse(url).map_err(|e| e.to_string())?;
    let relative_path = parsed.path().trim_start_matches('/').to_string();
    let resource_id = match parsed.query() {
        Some(q) if !q.is_empty() => format!("{relative_path}?{q}"),
        _ => relative_path.clone(),
    };
    Ok((relative_path, resource_id))
}

/// Records `app_version` as the highest seen for `relative_path`, if it's newer
/// than (or the first ever for) that app. Returns whether it was — the signal
/// `init_window_tab` uses to decide whether to ask the window for a fresh icon set.
async fn note_app_version(pool: &SqlitePool, relative_path: &str, app_version: i64) -> Result<bool, String> {
    let known_version: Option<i64> = sqlx::query_scalar("SELECT version FROM app_versions WHERE relative_path = ?1")
        .bind(relative_path)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;

    let is_new_or_newer = known_version.map_or(true, |v| app_version > v);
    if is_new_or_newer {
        sqlx::query(
            "INSERT INTO app_versions (relative_path, version) VALUES (?1, ?2)
             ON CONFLICT(relative_path) DO UPDATE SET version = excluded.version",
        )
        .bind(relative_path)
        .bind(app_version)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(is_new_or_newer)
}

/// A suggestive default name for the `n`th tab group created under a window
/// (1-indexed) — "Tab Group 1", "Tab Group 2", ... — used for both the
/// auto-created default group and manually-created ones; editable afterward via
/// `rename_tab_group`.
async fn next_group_name(pool: &SqlitePool, window_guid: &str) -> Result<String, String> {
    let existing_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tab_groups WHERE window_guid = ?1")
        .bind(window_guid)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(format!("Tab Group {}", existing_count + 1))
}

/// Called by an app running *inside* a secondary window to register one of its
/// resources (a document, a view, ...) as a tab. The calling window's own label is
/// its guid (see `build_window`), so the window never needs to know or send its own
/// guid — Tauri hands it to us via the `window` parameter.
///
/// If `reuse` is set, this call binds to that exact tab instead of creating a new
/// one, in one of two ways depending on why it was set (see
/// `SecondaryWindowsState::pending_tab_activation`):
///  - `force_stored_resource_id: false` (a window opened with no tabs yet) — the
///    placeholder is simply filled in with the real URL-derived resource id, the
///    same as a fresh tab would get.
///  - `true` (a specific tab was activated) — the response echoes back *that
///    tab's own* stored resource id (unchanged) instead of one derived from the
///    reloaded page's URL, letting the app decide what to show for a reactivated
///    (possibly still-blank) tab itself.
///
/// Otherwise, behaves as before: finds-or-creates the window's default tab group
/// and always creates a fresh tab in it, deriving the resource id from the URL.
/// The tab starts with no display text — the app fills that in with a follow-up
/// `update_tab_resource` call once it has something to show. Returns whether this
/// app_version is new/newer for this html file, alongside the usual response.
async fn init_window_tab_impl(
    pool: &SqlitePool,
    window_guid: &str,
    relative_path: &str,
    resource_id: &str,
    resource_type: Option<&str>,
    app_version: i64,
    reuse: Option<(&str, bool)>,
) -> Result<(TabInitResponse, bool), String> {
    let is_new_or_newer_version = note_app_version(pool, relative_path, app_version).await?;

    if let Some((tab_guid, force_stored_resource_id)) = reuse {
        let existing_resource_id: Option<String> = sqlx::query_scalar("SELECT resource_id FROM tabs WHERE guid = ?1")
            .bind(tab_guid)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
        if let Some(existing_resource_id) = existing_resource_id {
            let response_resource_id = if force_stored_resource_id {
                existing_resource_id
            } else {
                sqlx::query("UPDATE tabs SET resource_id = ?1, resource_type = ?2 WHERE guid = ?3")
                    .bind(resource_id)
                    .bind(resource_type)
                    .bind(tab_guid)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                resource_id.to_string()
            };
            return Ok((
                TabInitResponse {
                    tab_guid: tab_guid.to_string(),
                    resource_id: response_resource_id,
                    code_snippets: Vec::new(),
                },
                is_new_or_newer_version,
            ));
        }
        // The tab has since been deleted (e.g. its window closed) — fall through
        // and create a fresh one as if no reuse had been requested.
    }

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
            let name = next_group_name(pool, window_guid).await?;
            sqlx::query("INSERT INTO tab_groups (guid, window_guid, created_at, name) VALUES (?1, ?2, ?3, ?4)")
                .bind(&g)
                .bind(window_guid)
                .bind(current_millis())
                .bind(&name)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            g
        }
    };

    let tab_guid = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO tabs (guid, group_guid, window_guid, relative_path, app_version, resource_id, resource_type, tab_text, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8)",
    )
    .bind(&tab_guid)
    .bind(&group_guid)
    .bind(window_guid)
    .bind(relative_path)
    .bind(app_version)
    .bind(resource_id)
    .bind(resource_type)
    .bind(current_millis())
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok((
        TabInitResponse {
            tab_guid,
            resource_id: resource_id.to_string(),
            code_snippets: Vec::new(),
        },
        is_new_or_newer_version,
    ))
}

/// Emitted to a specific window asking the app running in it to report its icons —
/// see `submit_resource_icons`. Sent whenever `init_window_tab` sees an app_version
/// it hasn't seen before (including the very first time that html file is opened).
pub const EVENT_REQUEST_RESOURCE_ICONS: &str = "request-resource-icons";

#[tauri::command]
pub async fn init_window_tab(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    app_version: i64,
    url: String,
    resource_type: Option<String>,
) -> Result<TabInitResponse, String> {
    let window_guid = crate::window_host::caller_guid(&window).ok_or("Only web apps can register tabs.")?;
    let (relative_path, resource_id) = split_url_into_path_and_resource_id(&url)?;
    let reuse = state.pending_tab_activation.lock().unwrap().remove(&window_guid);
    let (mut result, needs_icons) = init_window_tab_impl(
        &state.pool,
        &window_guid,
        &relative_path,
        &resource_id,
        resource_type.as_deref(),
        app_version,
        reuse.as_ref().map(|(guid, force)| (guid.as_str(), *force)),
    )
    .await?;

    if needs_icons {
        let _ = window.emit(EVENT_REQUEST_RESOURCE_ICONS, ());
    }

    let _ = app.emit(EVENT_CHANGED, ());
    result.code_snippets = crate::code_snippets::code_snippets();
    Ok(result)
}

/// Updates a tab's label and/or resource type/id. `resource_type`/`resource_id`
/// are only changed when the app actually sends one — COALESCE keeps whatever
/// was already stored otherwise.
async fn update_tab_resource_impl(
    pool: &SqlitePool,
    tab_guid: &str,
    tab_text: &TabText,
    resource_type: Option<&str>,
    resource_id: Option<&str>,
) -> Result<(), String> {
    let json = serde_json::to_string(tab_text).map_err(|e| e.to_string())?;
    sqlx::query(
        "UPDATE tabs SET tab_text = ?1, resource_type = COALESCE(?2, resource_type), resource_id = COALESCE(?3, resource_id) WHERE guid = ?4",
    )
    .bind(&json)
    .bind(resource_type)
    .bind(resource_id)
    .bind(tab_guid)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Called by an app to set (or replace) the two-line, richly-styled label its tab
/// shows in the window manager, and optionally its resource type (the key into that
/// app's icon set — see `submit_resource_icons`) and/or its resource id (e.g. the
/// app navigated to a different view within the same tab, without opening a new
/// one). Rejects updating a tab that doesn't belong to the calling window, so one
/// app's page can't relabel another window's tab.
#[tauri::command]
pub async fn update_tab_resource(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    tab_guid: String,
    tab_text: TabText,
    resource_type: Option<String>,
    resource_id: Option<String>,
) -> Result<(), String> {
    let owner_window_guid: Option<String> = sqlx::query_scalar("SELECT window_guid FROM tabs WHERE guid = ?1")
        .bind(&tab_guid)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    let owner_window_guid = owner_window_guid.ok_or_else(|| "Tab not found.".to_string())?;
    if Some(owner_window_guid.as_str()) != crate::window_host::caller_guid(&window).as_deref() {
        return Err("Tab does not belong to this window.".to_string());
    }

    update_tab_resource_impl(&state.pool, &tab_guid, &tab_text, resource_type.as_deref(), resource_id.as_deref()).await?;

    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
}

/// Called by an app in response to a `request-resource-icons` event to report its
/// icon set: a map of resource-type key to SVG markup. The calling window's own
/// relative path (looked up the same way `init_window_tab` identifies it) is what
/// the icons get filed under.
#[tauri::command]
pub async fn submit_resource_icons(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    icons: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let relative_path: Option<String> = sqlx::query_scalar("SELECT relative_path FROM secondary_windows WHERE guid = ?1")
        .bind(crate::window_host::caller_guid(&window))
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    let relative_path = relative_path.ok_or_else(|| "Window not found.".to_string())?;

    for (resource_type, svg) in icons {
        sqlx::query(
            "INSERT INTO resource_icons (relative_path, resource_type, svg) VALUES (?1, ?2, ?3)
             ON CONFLICT(relative_path, resource_type) DO UPDATE SET svg = excluded.svg",
        )
        .bind(&relative_path)
        .bind(&resource_type)
        .bind(&svg)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    }

    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
}

/// Creates an empty tab group under a window, so tabs have somewhere to be moved to
/// besides a window's single default group. Gets a suggestive default name ("Tab
/// Group N") the user can change later via `rename_tab_group`.
#[tauri::command]
pub async fn create_tab_group(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    window_guid: String,
) -> Result<TabGroupRecord, String> {
    let guid = uuid::Uuid::new_v4().to_string();
    let created_at = current_millis();
    let name = next_group_name(&state.pool, &window_guid).await?;
    sqlx::query("INSERT INTO tab_groups (guid, window_guid, created_at, name) VALUES (?1, ?2, ?3, ?4)")
        .bind(&guid)
        .bind(&window_guid)
        .bind(created_at)
        .bind(&name)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;

    let _ = app.emit(EVENT_CHANGED, ());

    Ok(TabGroupRecord {
        guid,
        window_guid,
        created_at,
        name: Some(name),
        tags: Vec::new(),
        tabs: Vec::new(),
    })
}

/// Renames a tab group. An empty/blank `name` clears it back to unnamed.
#[tauri::command]
pub async fn rename_tab_group(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    guid: String,
    name: String,
) -> Result<(), String> {
    let trimmed = name.trim();
    let stored: Option<&str> = if trimmed.is_empty() { None } else { Some(trimmed) };
    sqlx::query("UPDATE tab_groups SET name = ?1 WHERE guid = ?2")
        .bind(stored)
        .bind(&guid)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;

    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
}

/// Adds a blank tab to a group — no immediate effect on the corresponding
/// secondary window. Its resource id starts empty and its label starts blank;
/// the user activates it later (see `activate_tab`) to have the window reopen
/// its web app and bind to it, at which point the web app decides what a "new
/// tab" should show.
#[tauri::command]
pub async fn add_blank_tab(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    group_guid: String,
) -> Result<TabRecord, String> {
    let window_guid: String = sqlx::query_scalar("SELECT window_guid FROM tab_groups WHERE guid = ?1")
        .bind(&group_guid)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Tab group not found.".to_string())?;
    let relative_path: String = sqlx::query_scalar("SELECT relative_path FROM secondary_windows WHERE guid = ?1")
        .bind(&window_guid)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Window not found.".to_string())?;

    let tab_guid = uuid::Uuid::new_v4().to_string();
    let created_at = current_millis();
    sqlx::query(
        "INSERT INTO tabs (guid, group_guid, window_guid, relative_path, app_version, resource_id, resource_type, tab_text, created_at)
         VALUES (?1, ?2, ?3, ?4, 0, '', NULL, NULL, ?5)",
    )
    .bind(&tab_guid)
    .bind(&group_guid)
    .bind(&window_guid)
    .bind(&relative_path)
    .bind(created_at)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;

    let _ = app.emit(EVENT_CHANGED, ());

    Ok(TabRecord {
        guid: tab_guid,
        group_guid,
        window_guid,
        relative_path,
        app_version: 0,
        resource_id: String::new(),
        resource_type: None,
        icon: None,
        tab_text: None,
        created_at,
        tags: Vec::new(),
    })
}

/// Adds a new tab to the same group as `tab_guid`, copying its resource id (but
/// not its label — the web app fills that in again once activated, the same as
/// any other tab).
#[tauri::command]
pub async fn clone_tab(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    tab_guid: String,
) -> Result<TabRecord, String> {
    let row = sqlx::query("SELECT group_guid, window_guid, relative_path, resource_id FROM tabs WHERE guid = ?1")
        .bind(&tab_guid)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Tab not found.".to_string())?;
    let group_guid: String = row.get("group_guid");
    let window_guid: String = row.get("window_guid");
    let relative_path: String = row.get("relative_path");
    let resource_id: String = row.get("resource_id");

    let new_guid = uuid::Uuid::new_v4().to_string();
    let created_at = current_millis();
    sqlx::query(
        "INSERT INTO tabs (guid, group_guid, window_guid, relative_path, app_version, resource_id, resource_type, tab_text, created_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, NULL, NULL, ?6)",
    )
    .bind(&new_guid)
    .bind(&group_guid)
    .bind(&window_guid)
    .bind(&relative_path)
    .bind(&resource_id)
    .bind(created_at)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;

    let _ = app.emit(EVENT_CHANGED, ());

    Ok(TabRecord {
        guid: new_guid,
        group_guid,
        window_guid,
        relative_path,
        app_version: 0,
        resource_id,
        resource_type: None,
        icon: None,
        tab_text: None,
        created_at,
        tags: Vec::new(),
    })
}

/// Makes a tab the one its window's *next* `init_window_tab` call binds to
/// (see `init_window_tab_impl`), then makes the corresponding secondary window
/// "reopen its web app": navigates it back to its plain base URL if it's already
/// open (discarding whatever in-app view it had drifted to via its own
/// `history.pushState` calls), or opens it fresh if it was suspended. The web
/// app's own subsequent init call is told this tab's resource id (its stored
/// value — empty for a tab that's never been used) so it can decide what to show.
#[tauri::command]
pub async fn activate_tab(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    tab_guid: String,
) -> Result<(), String> {
    let window_guid: String = sqlx::query_scalar("SELECT window_guid FROM tabs WHERE guid = ?1")
        .bind(&tab_guid)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Tab not found.".to_string())?;
    let relative_path: String = sqlx::query_scalar("SELECT relative_path FROM secondary_windows WHERE guid = ?1")
        .bind(&window_guid)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Window not found.".to_string())?;

    state.pending_tab_activation.lock().unwrap().insert(window_guid.clone(), (tab_guid, true));

    if !crate::window_host::reload_if_open(&app, &window_guid, &relative_path)? {
        crate::window_host::open(&app, &window_guid, &relative_path)?;
    }

    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
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

    async fn group_guid_of_tab(pool: &SqlitePool, tab_guid: &str) -> String {
        sqlx::query_scalar("SELECT group_guid FROM tabs WHERE guid = ?1")
            .bind(tab_guid)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// Thin wrapper matching the pre-icons test call shape: no resource_type, and
    /// discards the "is this a new/newer app_version" bool most tests don't care about.
    async fn init_tab(pool: &SqlitePool, window_guid: &str, relative_path: &str, resource_id: &str, app_version: i64) -> TabInitResponse {
        init_window_tab_impl(pool, window_guid, relative_path, resource_id, None, app_version, None)
            .await
            .unwrap()
            .0
    }

    #[test]
    fn split_url_separates_relative_path_from_resource_id() {
        let (path, resource_id) =
            split_url_into_path_and_resource_id("csuser://localhost/asdf/index1.html?doc=42").unwrap();
        assert_eq!(path, "asdf/index1.html");
        assert_eq!(resource_id, "asdf/index1.html?doc=42");

        let (path_no_query, resource_id_no_query) =
            split_url_into_path_and_resource_id("csuser://localhost/asdf/index1.html").unwrap();
        assert_eq!(path_no_query, "asdf/index1.html");
        assert_eq!(resource_id_no_query, "asdf/index1.html");
    }

    #[test]
    fn init_window_tab_creates_one_group_then_reuses_it() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("init-reuse").await;
            insert_window(&pool, "win1", "asdf/index.html").await;

            let first = init_tab(&pool, "win1", "asdf/index.html", "res-a", 1).await;
            let second = init_tab(&pool, "win1", "asdf/index.html", "res-b", 1).await;

            assert_eq!(first.resource_id, "res-a");
            assert_ne!(first.tab_guid, second.tab_guid);

            let first_group = group_guid_of_tab(&pool, &first.tab_guid).await;
            let second_group = group_guid_of_tab(&pool, &second.tab_guid).await;
            assert_eq!(first_group, second_group, "both tabs should land in the window's one default group");

            let groups = fetch_tab_groups(&pool, &["win1".to_string()]).await.unwrap();
            assert_eq!(groups.len(), 1);
            assert_eq!(groups[0].tabs.len(), 2);
            assert!(groups[0].tabs.iter().all(|t| t.tab_text.is_none()), "no tab_text until update_tab_resource is called");
        });
    }

    #[test]
    fn update_tab_resource_rejects_a_tab_from_another_window() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("update-reject").await;
            insert_window(&pool, "win1", "asdf/index.html").await;
            let tab = init_tab(&pool, "win1", "asdf/index.html", "res-a", 1).await;

            let owner: Option<String> = sqlx::query_scalar("SELECT window_guid FROM tabs WHERE guid = ?1")
                .bind(&tab.tab_guid)
                .fetch_optional(&pool)
                .await
                .unwrap();
            assert_eq!(owner.as_deref(), Some("win1"));
            // The actual ownership check lives in the #[tauri::command] wrapper (it
            // needs a real WebviewWindow for its label, which a unit test can't
            // construct) — this test just pins down the data it checks against.
        });
    }

    #[test]
    fn update_tab_resource_can_change_the_resource_id_but_only_when_given() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("update-resource-id").await;
            insert_window(&pool, "win1", "asdf/index.html").await;
            let tab = init_tab(&pool, "win1", "asdf/index.html", "res-a", 1).await;

            let blank_text = TabText { first_row: vec![], second_row: vec![] };

            // Given a new resource id, it replaces the old one.
            update_tab_resource_impl(&pool, &tab.tab_guid, &blank_text, None, Some("res-b"))
                .await
                .unwrap();
            let resource_id: String = sqlx::query_scalar("SELECT resource_id FROM tabs WHERE guid = ?1")
                .bind(&tab.tab_guid)
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(resource_id, "res-b");

            // Without one, the previous value is left untouched.
            update_tab_resource_impl(&pool, &tab.tab_guid, &blank_text, None, None).await.unwrap();
            let resource_id: String = sqlx::query_scalar("SELECT resource_id FROM tabs WHERE guid = ?1")
                .bind(&tab.tab_guid)
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(resource_id, "res-b", "omitting resource id must not clear/reset it");
        });
    }

    #[test]
    fn tab_text_round_trips_through_json_storage() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("tab-text").await;
            insert_window(&pool, "win1", "asdf/index.html").await;
            let tab = init_tab(&pool, "win1", "asdf/index.html", "res-a", 1).await;

            let tab_text = TabText {
                first_row: vec![
                    TabTextSpan { text: "asdfasdf".to_string(), bold: true, italic: false },
                    TabTextSpan { text: "qwerqwer".to_string(), bold: false, italic: false },
                ],
                second_row: vec![TabTextSpan { text: "zxczxcv".to_string(), bold: false, italic: true }],
            };
            let json = serde_json::to_string(&tab_text).unwrap();
            sqlx::query("UPDATE tabs SET tab_text = ?1 WHERE guid = ?2")
                .bind(&json)
                .bind(&tab.tab_guid)
                .execute(&pool)
                .await
                .unwrap();

            let groups = fetch_tab_groups(&pool, &["win1".to_string()]).await.unwrap();
            let stored = groups[0].tabs[0].tab_text.clone().expect("tab_text should be set");
            assert_eq!(stored.first_row.len(), 2);
            assert!(stored.first_row[0].bold);
            assert!(!stored.first_row[0].italic);
            assert!(stored.second_row[0].italic);
        });
    }

    #[test]
    fn move_tab_to_group_rejects_windows_of_a_different_app() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("move-reject").await;
            insert_window(&pool, "win1", "asdf/index1.html").await;
            insert_window(&pool, "win2", "asdf/index2.html").await;

            let tab = init_tab(&pool, "win1", "asdf/index1.html", "res-a", 1).await;
            let other_tab = init_tab(&pool, "win2", "asdf/index2.html", "res-b", 1).await;
            let other_group = group_guid_of_tab(&pool, &other_tab.tab_guid).await;

            let err = move_tab_to_group_impl(&pool, &tab.tab_guid, &other_group).await.unwrap_err();
            assert!(err.contains("same app"));
        });
    }

    #[test]
    fn move_tab_to_group_allows_a_different_window_of_the_same_app() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("move-allow").await;
            insert_window(&pool, "win1", "asdf/index.html").await;
            insert_window(&pool, "win2", "asdf/index.html").await;

            let tab = init_tab(&pool, "win1", "asdf/index.html", "res-a", 1).await;
            let target_tab = init_tab(&pool, "win2", "asdf/index.html", "res-b", 1).await;
            let target_group = group_guid_of_tab(&pool, &target_tab.tab_guid).await;

            move_tab_to_group_impl(&pool, &tab.tab_guid, &target_group).await.unwrap();

            let groups = fetch_tab_groups(&pool, &["win2".to_string()]).await.unwrap();
            assert_eq!(groups[0].tabs.len(), 2, "the moved tab should now be alongside win2's own tab");
        });
    }

    #[test]
    fn deleting_a_window_cascades_to_its_groups_tabs_and_tags() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("cascade").await;
            insert_window(&pool, "win1", "asdf/index.html").await;

            let tab = init_tab(&pool, "win1", "asdf/index.html", "res-a", 1).await;
            let group_guid = group_guid_of_tab(&pool, &tab.tab_guid).await;

            sqlx::query("INSERT INTO window_tags (guid, text, fg_color, bg_color) VALUES (?1, 'x', '#fff', '#000')")
                .bind(&tab.tab_guid)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO window_tags (guid, text, fg_color, bg_color) VALUES (?1, 'x', '#fff', '#000')")
                .bind(&group_guid)
                .execute(&pool)
                .await
                .unwrap();

            delete_window_and_tags(&pool, "win1").await;

            let groups = fetch_tab_groups(&pool, &["win1".to_string()]).await.unwrap();
            assert!(groups.is_empty());

            let remaining_tags = fetch_tags(&pool, &[tab.tab_guid, group_guid]).await.unwrap();
            assert!(remaining_tags.is_empty(), "tags on the deleted tab/group must be gone too");
        });
    }

    async fn tag_texts(pool: &SqlitePool, guid: &str) -> Vec<String> {
        fetch_tags(pool, &[guid.to_string()]).await.unwrap().into_iter().map(|t| t.text).collect()
    }

    #[test]
    fn tags_come_back_in_insertion_order_and_can_be_reordered_edited_and_scoped_per_guid() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("tag-order").await;
            let a = add_tag_impl(&pool, "g1", "a", "#fff", "#000").await.unwrap();
            let b = add_tag_impl(&pool, "g1", "b", "#fff", "#000").await.unwrap();
            let c = add_tag_impl(&pool, "g1", "c", "#fff", "#000").await.unwrap();
            let other = add_tag_impl(&pool, "g2", "other", "#fff", "#000").await.unwrap();
            assert_eq!(tag_texts(&pool, "g1").await, ["a", "b", "c"]);

            reorder_tags_impl(&pool, "g1", &[c.id, a.id, b.id]).await.unwrap();
            assert_eq!(tag_texts(&pool, "g1").await, ["c", "a", "b"]);

            let d = add_tag_impl(&pool, "g1", "d", "#fff", "#000").await.unwrap();
            assert_eq!(tag_texts(&pool, "g1").await, ["c", "a", "b", "d"], "a new tag goes last");

            // A partial list puts those first; the rest keep their relative order after them.
            // An id from a different guid is ignored, not moved.
            reorder_tags_impl(&pool, "g1", &[d.id, other.id]).await.unwrap();
            assert_eq!(tag_texts(&pool, "g1").await, ["d", "c", "a", "b"]);
            assert_eq!(tag_texts(&pool, "g2").await, ["other"]);

            update_tag_impl(&pool, b.id, "B!", "#111", "#222").await.unwrap();
            let edited = fetch_tags(&pool, &["g1".to_string()]).await.unwrap();
            let edited_b = edited.iter().find(|t| t.id == b.id).unwrap();
            assert_eq!((edited_b.text.as_str(), edited_b.fg_color.as_str(), edited_b.bg_color.as_str()), ("B!", "#111", "#222"));
            assert_eq!(edited.last().unwrap().id, b.id, "editing must not change position");
        });
    }

    #[test]
    fn init_window_tab_flags_only_new_or_newer_app_versions() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("version-flag").await;
            insert_window(&pool, "win1", "asdf/index.html").await;

            let (_, first_is_new) =
                init_window_tab_impl(&pool, "win1", "asdf/index.html", "res-a", None, 1, None).await.unwrap();
            assert!(first_is_new, "the very first call for an app should be flagged");

            let (_, same_version_is_new) =
                init_window_tab_impl(&pool, "win1", "asdf/index.html", "res-b", None, 1, None).await.unwrap();
            assert!(!same_version_is_new, "an unchanged version should not be re-flagged");

            let (_, older_version_is_new) =
                init_window_tab_impl(&pool, "win1", "asdf/index.html", "res-c", None, 0, None).await.unwrap();
            assert!(!older_version_is_new, "an older version should not be flagged either");

            let (_, newer_version_is_new) =
                init_window_tab_impl(&pool, "win1", "asdf/index.html", "res-d", None, 2, None).await.unwrap();
            assert!(newer_version_is_new, "a genuinely newer version should be flagged");
        });
    }

    #[test]
    fn tab_icon_resolves_from_resource_type_scoped_to_the_app() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("icons").await;
            insert_window(&pool, "win1", "asdf/index.html").await;
            insert_window(&pool, "win2", "asdf/other.html").await;

            let tab = init_window_tab_impl(&pool, "win1", "asdf/index.html", "res-a", Some("document"), 1, None)
                .await
                .unwrap()
                .0;
            let other_app_tab = init_window_tab_impl(&pool, "win2", "asdf/other.html", "res-b", Some("document"), 1, None)
                .await
                .unwrap()
                .0;

            sqlx::query("INSERT INTO resource_icons (relative_path, resource_type, svg) VALUES ('asdf/index.html', 'document', '<svg>a</svg>')")
                .execute(&pool)
                .await
                .unwrap();

            let groups = fetch_tab_groups(&pool, &["win1".to_string(), "win2".to_string()]).await.unwrap();
            let found_tab = groups.iter().flat_map(|g| &g.tabs).find(|t| t.guid == tab.tab_guid).unwrap();
            let found_other = groups.iter().flat_map(|g| &g.tabs).find(|t| t.guid == other_app_tab.tab_guid).unwrap();

            assert_eq!(found_tab.icon.as_deref(), Some("<svg>a</svg>"));
            assert_eq!(found_other.icon, None, "the same resource_type key in a different app must not share icons");
        });
    }

    #[test]
    fn ensure_default_tab_group_creates_a_placeholder_once() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("ensure-default").await;
            insert_window(&pool, "win1", "asdf/index.html").await;

            let placeholder = ensure_default_tab_group(&pool, "win1", "asdf/index.html").await.unwrap();
            assert!(placeholder.is_some(), "a fresh window should get a placeholder tab");

            let groups = fetch_tab_groups(&pool, &["win1".to_string()]).await.unwrap();
            assert_eq!(groups.len(), 1);
            assert_eq!(groups[0].name.as_deref(), Some("Tab Group 1"));
            assert_eq!(groups[0].tabs.len(), 1);
            assert_eq!(groups[0].tabs[0].resource_id, "");
            assert!(groups[0].tabs[0].tab_text.is_none());

            let second_call = ensure_default_tab_group(&pool, "win1", "asdf/index.html").await.unwrap();
            assert!(second_call.is_none(), "must not create a second placeholder once one exists");
            let groups = fetch_tab_groups(&pool, &["win1".to_string()]).await.unwrap();
            assert_eq!(groups[0].tabs.len(), 1, "still just the one placeholder tab");
        });
    }

    #[test]
    fn init_window_tab_fills_the_auto_created_placeholder_with_the_real_resource_id() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("reuse-placeholder").await;
            insert_window(&pool, "win1", "asdf/index.html").await;
            let placeholder_guid = ensure_default_tab_group(&pool, "win1", "asdf/index.html")
                .await
                .unwrap()
                .expect("fresh window should get a placeholder");

            // force_stored_resource_id: false — a plain window-open placeholder gets
            // filled in with the real URL-derived resource id, same as any other
            // first tab would, just reusing the existing row instead of a new one.
            let (response, _) = init_window_tab_impl(
                &pool,
                "win1",
                "asdf/index.html",
                "asdf/index.html?doc=real",
                None,
                1,
                Some((&placeholder_guid, false)),
            )
            .await
            .unwrap();

            assert_eq!(response.tab_guid, placeholder_guid, "must bind to the pending tab, not create a new one");
            assert_eq!(response.resource_id, "asdf/index.html?doc=real", "must use the real URL-derived resource id");

            let groups = fetch_tab_groups(&pool, &["win1".to_string()]).await.unwrap();
            assert_eq!(groups[0].tabs.len(), 1, "no extra tab should have been created");
            assert_eq!(groups[0].tabs[0].resource_id, "asdf/index.html?doc=real", "the row itself must be updated too");
        });
    }

    #[test]
    fn init_window_tab_activated_tab_keeps_its_own_stored_resource_id() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("reuse-activated").await;
            insert_window(&pool, "win1", "asdf/index.html").await;
            let placeholder_guid = ensure_default_tab_group(&pool, "win1", "asdf/index.html")
                .await
                .unwrap()
                .expect("fresh window should get a placeholder");

            // force_stored_resource_id: true — the tab the user explicitly
            // activated (a blank "new tab", here) keeps its own resource id (empty)
            // regardless of whatever URL the reloaded page happens to send.
            let (response, _) = init_window_tab_impl(
                &pool,
                "win1",
                "asdf/index.html",
                "asdf/index.html?doc=should-be-ignored",
                None,
                1,
                Some((&placeholder_guid, true)),
            )
            .await
            .unwrap();

            assert_eq!(response.tab_guid, placeholder_guid);
            assert_eq!(response.resource_id, "", "must echo the tab's own stored resource id, not the URL-derived one");

            let groups = fetch_tab_groups(&pool, &["win1".to_string()]).await.unwrap();
            assert_eq!(groups[0].tabs.len(), 1, "no extra tab should have been created");
            assert_eq!(groups[0].tabs[0].resource_id, "", "the row itself must be left unchanged");
        });
    }

    #[test]
    fn next_group_name_increments_per_window() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("group-naming").await;
            insert_window(&pool, "win1", "asdf/index.html").await;

            assert_eq!(next_group_name(&pool, "win1").await.unwrap(), "Tab Group 1");
            ensure_default_tab_group(&pool, "win1", "asdf/index.html").await.unwrap();
            assert_eq!(next_group_name(&pool, "win1").await.unwrap(), "Tab Group 2");
        });
    }
}
