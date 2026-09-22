use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// `init_window_tab` call from that window binds to, consumed the moment that call arrives. The
    /// admin-app decides which tab a window will show *before* its page exists, and records it here:
    ///  - a window opened or reopened (`tab_for_opening`) — `force_stored_resource_id: false` only for a
    ///    placeholder that was just created (it is filled in with the real URL-derived resource id, like
    ///    any first tab would be); `true` for a tab that already existed, so the response echoes that
    ///    tab's *own* stored resource id and the app can restore what it showed.
    ///  - a tab activated in a window that is not open (`activate_tab`) — `true`, the same way.
    /// A page's init request never creates a tab (see `tab_for_init`): with nothing pending it is a
    /// reload, and binds to the window's current tab.
    pending_tab_activation: Mutex<HashMap<String, (String, bool)>>,
    /// The tab each window is showing — or showed when it was suspended: window guid → tab guid. Set
    /// when the page binds to a tab (`init_window_tab`, `add_window_tab`) or is sent one
    /// (`activate_tab`); kept when the window is suspended, so reopening it shows the same tab, and
    /// gone when the entry is. It is also what tells `close_tab` that closing a tab must suspend the
    /// window that is showing it (when it is open).
    current_tabs: Mutex<HashMap<String, String>>,
    /// The app is closing (its main window was asked to close): from now on a secondary window that goes
    /// away — closed by us, by the person or by the OS — is **suspended**, never removed from the list. Not
    /// persisted: it only matters until the app is gone, and the next start begins without it.
    shutting_down: AtomicBool,
}

impl SecondaryWindowsState {
    /// The database (for the modules that keep their own tables in it, like `external_sites`).
    pub(crate) fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// The tab a window is showing (or showed when it was suspended).
    pub(crate) fn current_tab_of(&self, window_guid: &str) -> Option<String> {
        self.current_tabs.lock().unwrap().get(window_guid).cloned()
    }

    pub fn new(pool: SqlitePool) -> Self {
        Self {
            pool,
            pending_suspend: Mutex::new(HashSet::new()),
            pending_tab_activation: Mutex::new(HashMap::new()),
            current_tabs: Mutex::new(HashMap::new()),
            shutting_down: AtomicBool::new(false),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecondaryWindowRecord {
    pub guid: String,
    /// `user` (a web app from the user folder) or `system` (one of our own apps).
    pub kind: String,
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
    /// Written in a monospaced font, like code.
    #[serde(default)]
    pub mono: bool,
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
    /// The title the page gave for its window, if it gave one (see `window_title`).
    pub app_title: Option<String>,
    pub created_at: i64,
    pub tags: Vec<TagRecord>,
    /// The external web sites opened from this tab's page, oldest first (see `external_sites`).
    pub external_pages: Vec<crate::external_sites::ExternalPageRecord>,
    /// The web apps opened from this tab (a Notes tab) — pages of files in a folder or a Filen account — as
    /// windows of their own that are listed here rather than among the apps (see `notes_pages`).
    pub opened_apps: Vec<crate::notes_pages::OpenedAppRecord>,
    /// Whether an open window is showing this tab right now — the only case in which it can be reloaded. (Filled in by
    /// `list_secondary_windows`; false everywhere else.)
    pub showing: bool,
}

/// The Filen account (and branch) a page was opened from — see `Origin`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilenOrigin {
    pub account_id: i64,
    pub email: String,
    /// The name of the branch the page was opened in, when it was opened in one.
    pub branch: Option<String>,
    /// The branch's index, when there is one (what the Filen commands call it).
    pub branch_index: Option<i64>,
}

/// How a window's page came to be opened, kept on its entry (`secondary_windows.origin`, JSON): what a
/// page is told about itself in `init_window_tab`. Anything not recorded is the ordinary case — a web app
/// of the user folder opened from the admin-app.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    /// `AdminApp` (opened from the admin-app itself) or `NotesApp` (from Notes' file manager).
    pub opened_by: Option<String>,
    /// Where the file is: `UserFolder`, `DeviceFolder` (a folder the person picked), `FilenCloud`, or
    /// `Bundled` (a system app).
    pub storage: Option<String>,
    /// The file's path in that storage (for Filen: its path in the drive). Absent: the entry's own path.
    pub path: Option<String>,
    /// `DeviceFolder`: the picked folder's root id.
    pub root: Option<String>,
    pub filen: Option<FilenOrigin>,
    /// What the window is for, when it is for something the app itself launches: `UserAction` (see `user_action.rs`).
    pub role: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TabInitResponse {
    pub tab_guid: String,
    pub resource_id: String,
    /// The page's own path — from the user folder for a web app, `system:<id>` for a system app, the
    /// path in the drive for a file opened from Filen. (Filled in by the command, not the database logic.)
    pub relative_path: String,
    /// `AdminApp` or `NotesApp`: who opened the page (the value is an enum member's name).
    pub opened_by: String,
    /// What the window is for, when the app launched it for something (`UserAction`); empty for an ordinary page.
    pub role: String,
    /// `UserFolder`, `DeviceFolder`, `FilenCloud` or `Bundled`.
    pub storage: String,
    /// When `storage` is `FilenCloud`: the account, and the branch if there is one.
    pub filen: Option<FilenOrigin>,
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

    // Which set the entry belongs to: web apps from the user folder, or our own system apps.
    let has_kind_column: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('secondary_windows') WHERE name = 'kind'")
        .fetch_one(&pool)
        .await
        .unwrap_or(0);
    if has_kind_column == 0 {
        sqlx::query("ALTER TABLE secondary_windows ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'").execute(&pool).await?;
    }

    // How the window's page came to be opened (see `Origin`), as JSON; NULL is the ordinary case.
    let has_origin_column: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('secondary_windows') WHERE name = 'origin'")
        .fetch_one(&pool)
        .await
        .unwrap_or(0);
    if has_origin_column == 0 {
        sqlx::query("ALTER TABLE secondary_windows ADD COLUMN origin TEXT").execute(&pool).await?;
    }

    // A window opened from a Notes tab belongs to that tab (see `notes_pages`): the tab's guid; NULL for every other.
    let has_parent_column: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('secondary_windows') WHERE name = 'parent_tab'")
        .fetch_one(&pool)
        .await
        .unwrap_or(0);
    if has_parent_column == 0 {
        sqlx::query("ALTER TABLE secondary_windows ADD COLUMN parent_tab TEXT").execute(&pool).await?;
    }

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
            app_title TEXT,
            created_at INTEGER NOT NULL
        )",
    )
    .execute(&pool)
    .await?;

    // `app_title` (the title of the tab's window — see `window_title`) was added later: a plain nullable column.
    let has_app_title_column: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('tabs') WHERE name = 'app_title'")
        .fetch_one(&pool)
        .await
        .unwrap_or(0);
    if has_app_title_column == 0 {
        sqlx::query("ALTER TABLE tabs ADD COLUMN app_title TEXT").execute(&pool).await?;
    }

    // `link_page`: the page a tab shows when the person opened a link in it (`link_navigation`) — its path (as a URL has it) and
    // query — instead of the page its window was opened at. NULL for every other tab: an app that keeps several tabs in one
    // page decides for itself what each shows (a tab switch is an event, not a navigation).
    let has_link_page_column: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('tabs') WHERE name = 'link_page'")
        .fetch_one(&pool)
        .await
        .unwrap_or(0);
    if has_link_page_column == 0 {
        sqlx::query("ALTER TABLE tabs ADD COLUMN link_page TEXT").execute(&pool).await?;
    }

    // `syncs`: the file (its served path) whose editor this tab follows — the tab reloads when the file is saved. Only the tab a note
    // was first opened in has one; NULL for every other tab.
    let has_syncs_column: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('tabs') WHERE name = 'syncs'")
        .fetch_one(&pool)
        .await
        .unwrap_or(0);
    if has_syncs_column == 0 {
        sqlx::query("ALTER TABLE tabs ADD COLUMN syncs TEXT").execute(&pool).await?;
    }

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

    // External web sites opened from a tab's page (see `external_sites`): children of that tab, not tabs.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS external_pages (
            guid TEXT PRIMARY KEY,
            tab_guid TEXT NOT NULL,
            window_guid TEXT NOT NULL,
            initial_url TEXT NOT NULL,
            url TEXT NOT NULL,
            title TEXT,
            created_at INTEGER NOT NULL
        )",
    )
    .execute(&pool)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS external_pages_tab ON external_pages (tab_guid)").execute(&pool).await?;

    Ok(pool)
}

use crate::window_host::{Kind, Page};

/// Checks that `page` names something that can be shown: an html file in the user folder, or a system app.
fn validate_page(app: &AppHandle, page: &Page) -> Result<(), String> {
    match page.kind {
        Kind::User => validate_relative_html_path(app, &page.relative_path),
        Kind::System => crate::system_apps::app_of_relative_path(&page.relative_path)
            .map(|_| ())
            .ok_or_else(|| "That system app doesn't exist.".to_string()),
    }
}

/// The page a window entry shows, from its row.
pub(crate) async fn page_of(pool: &SqlitePool, guid: &str) -> Result<Page, String> {
    let row = sqlx::query("SELECT kind, relative_path FROM secondary_windows WHERE guid = ?1")
        .bind(guid)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Window not found.".to_string())?;
    let kind: String = row.get("kind");
    Ok(Page::new(Kind::parse(Some(&kind))?, row.get::<String, _>("relative_path")))
}

/// The page a window shows when it shows `tab_guid`: the one its entry was made for — or, for a tab the person opened a link in
/// (`link_page`), the page that link led to.
pub(crate) async fn page_to_show(pool: &SqlitePool, tab_guid: &str, window_page: &Page) -> Result<Page, String> {
    let link: Option<String> = sqlx::query_scalar("SELECT link_page FROM tabs WHERE guid = ?1").bind(tab_guid).fetch_optional(pool).await.map_err(|e| e.to_string())?.flatten();
    // A web page is a web page whatever kind of window it is shown in: in a tab of a system app's window (Notes shows a note's
    // markdown that way) it has a web page's rights — who is calling follows the page the window shows.
    Ok(match link.filter(|l| !l.is_empty()) {
        Some(link) => Page::new(Kind::User, link),
        None => window_page.clone(),
    })
}

/// The tab the window shows: the one its page bound to — or, for a page that never registers a tab (a plain html file needs no
/// library), the one made ready for it when it was opened.
async fn tab_showing(state: &SecondaryWindowsState, window_guid: &str, window_page: &Page) -> Result<String, String> {
    let pending = state.pending_tab_activation.lock().unwrap().get(window_guid).map(|(tab, _)| tab.clone());
    match state.current_tab_of(window_guid).or(pending) {
        Some(tab) => Ok(tab),
        None => Ok(tab_for_opening(&state.pool, window_guid, &window_page.relative_path, None).await?.0),
    }
}

/// The tab of `window_guid` that follows the editor of `syncs` (a file's served path), if there is one.
pub(crate) async fn syncing_tab(pool: &SqlitePool, window_guid: &str, syncs: &str) -> Result<Option<String>, String> {
    sqlx::query_scalar("SELECT guid FROM tabs WHERE window_guid = ?1 AND syncs = ?2 ORDER BY created_at ASC LIMIT 1")
        .bind(window_guid)
        .bind(syncs)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())
}

/// The tab of `window_guid` that shows the app itself (no linked page) — where a window goes back to when a tab that showed a
/// web page is suspended or closed. The newest, if there are several.
pub(crate) async fn home_tab(pool: &SqlitePool, window_guid: &str) -> Result<Option<String>, String> {
    sqlx::query_scalar("SELECT guid FROM tabs WHERE window_guid = ?1 AND (link_page IS NULL OR link_page = '') ORDER BY created_at DESC LIMIT 1")
        .bind(window_guid)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())
}

/// Whether `window_guid` shows `tab_guid` now.
pub(crate) fn window_shows(state: &SecondaryWindowsState, window_guid: &str, tab_guid: &str) -> bool {
    state.current_tab_of(window_guid).as_deref() == Some(tab_guid)
}

/// The open windows that show a tab that follows the editor of `syncs` — only those reload when the file is saved.
pub(crate) async fn syncing_windows(app: &AppHandle, syncs: &str) -> Result<Vec<String>, String> {
    let state = app.state::<SecondaryWindowsState>();
    let rows = sqlx::query("SELECT guid, window_guid FROM tabs WHERE syncs = ?1").bind(syncs).fetch_all(&state.pool).await.map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let (tab, window): (String, String) = (row.get("guid"), row.get("window_guid"));
            (window_shows(&state, &window, &tab) && crate::window_host::is_open(app, &window)).then_some(window)
        })
        .collect())
}

/// Adds a tab that shows the web page `link_page` (a path as a URL has it, with its query) to the group of the tab `window_guid`
/// shows, without showing it. `syncs`: the file whose editor it follows. Resolves to the new tab's guid.
pub(crate) async fn add_page_tab(app: &AppHandle, window_guid: &str, link_page: &str, syncs: Option<&str>) -> Result<String, String> {
    let state = app.state::<SecondaryWindowsState>();
    let window_page = page_of(&state.pool, window_guid).await?;
    let current = tab_showing(&state, window_guid, &window_page).await?;
    let row = sqlx::query("SELECT group_guid, app_version FROM tabs WHERE guid = ?1 AND window_guid = ?2")
        .bind(&current)
        .bind(window_guid)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("The window's tab is gone.")?;
    let (group, app_version): (String, i64) = (row.get("group_guid"), row.get("app_version"));
    let tab_guid = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO tabs (guid, group_guid, window_guid, relative_path, app_version, resource_id, resource_type, tab_text, link_page, syncs, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?6, ?7, ?8)",
    )
    .bind(&tab_guid)
    .bind(&group)
    .bind(window_guid)
    .bind(&window_page.relative_path)
    .bind(app_version)
    .bind(link_page)
    .bind(syncs)
    .bind(current_millis())
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(tab_guid)
}

/// Opens a window of the Notes app whose only tab shows the web page `link_page` (see `add_page_tab`; `syncs` likewise) — a note
/// followed by its editor from a window of its own. Resolves to the new window's guid.
pub(crate) async fn open_notes_window_with_page(app: &AppHandle, link_page: &str, syncs: Option<&str>) -> Result<String, String> {
    let state = app.state::<SecondaryWindowsState>();
    let page = Page::new(Kind::System, crate::system_apps::relative_path_of("notes"));
    validate_page(app, &page)?;
    let (guid, _) = insert_entry(&state.pool, &page).await?;
    let (tab_guid, _) = tab_for_opening(&state.pool, &guid, &page.relative_path, None).await?;
    sqlx::query("UPDATE tabs SET resource_id = ?1, link_page = ?1, syncs = ?2 WHERE guid = ?3")
        .bind(link_page)
        .bind(syncs)
        .bind(&tab_guid)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    state.pending_tab_activation.lock().unwrap().insert(guid.clone(), (tab_guid.clone(), true));
    let shown = page_to_show(&state.pool, &tab_guid, &page).await?;
    crate::window_host::open(app, &guid, &shown)?;
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(guid)
}

/// Shows the page `url` (a page of the same web app space as the window's — see `link_navigation`) in the open window
/// `window_guid`, **in its current tab** (the tab now shows that page) or **in a new tab of the same tab group** (which
/// becomes the window's current tab); the window is taken there. The tab remembers the page (`link_page`), so reopening the
/// window or coming back to the tab shows it again.
pub(crate) async fn open_link_in_window(app: &AppHandle, window_guid: &str, url: &Url, new_tab: bool) -> Result<(), String> {
    let state = app.state::<SecondaryWindowsState>();
    let window_page = page_of(&state.pool, window_guid).await?;
    if !crate::window_host::is_open(app, window_guid) {
        return Err("That window isn't open.".to_string());
    }
    let current = tab_showing(&state, window_guid, &window_page).await?;
    // The tab stays a tab *of the window's app* (its `relative_path` is the app's, which is what lets it move to another window
    // of the same app); what it shows is `link_page`.
    let (_, resource_id) = split_url_into_path_and_resource_id(url.as_str())?;
    let link_page = resource_id.clone();

    let tab_guid = if new_tab {
        let row = sqlx::query("SELECT group_guid, app_version FROM tabs WHERE guid = ?1 AND window_guid = ?2")
            .bind(&current)
            .bind(window_guid)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("The window's tab is gone.")?;
        let (group, app_version): (String, i64) = (row.get("group_guid"), row.get("app_version"));
        let tab_guid = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO tabs (guid, group_guid, window_guid, relative_path, app_version, resource_id, resource_type, tab_text, link_page, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7, ?8)",
        )
        .bind(&tab_guid)
        .bind(&group)
        .bind(window_guid)
        .bind(&window_page.relative_path)
        .bind(app_version)
        .bind(&resource_id)
        .bind(&link_page)
        .bind(current_millis())
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
        tab_guid
    } else {
        sqlx::query(
            "UPDATE tabs SET resource_id = ?1, resource_type = NULL, tab_text = NULL, app_title = NULL, link_page = ?2 WHERE guid = ?3",
        )
        .bind(&resource_id)
        .bind(&link_page)
        .bind(&current)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
        current
    };

    state.pending_tab_activation.lock().unwrap().remove(window_guid);
    state.current_tabs.lock().unwrap().insert(window_guid.to_string(), tab_guid);
    crate::window_host::navigate(app, window_guid, &Page::new(Kind::User, link_page))?;
    refresh_window_title(app, window_guid).await;
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
}

/// The page a caller means: a web app is named by its html file, a system app by `system:<id>` — or
/// just its id.
fn page_from_request(kind: Kind, relative_path: &str) -> Page {
    match kind {
        Kind::User => Page::new(kind, relative_path),
        Kind::System if relative_path.starts_with("system:") => Page::new(kind, relative_path),
        Kind::System => Page::new(kind, crate::system_apps::relative_path_of(relative_path)),
    }
}

/// Adds the row for a new window entry.
async fn insert_entry(pool: &SqlitePool, page: &Page) -> Result<(String, i64), String> {
    insert_entry_full(pool, page, None, None).await
}

/// The same, with how the page came to be opened (`Origin`, as JSON) and the tab it is a child of.
async fn insert_entry_full(pool: &SqlitePool, page: &Page, origin: Option<&str>, parent_tab: Option<&str>) -> Result<(String, i64), String> {
    let guid = uuid::Uuid::new_v4().to_string();
    let created_at = current_millis();
    sqlx::query("INSERT INTO secondary_windows (guid, relative_path, kind, created_at, origin, parent_tab) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
        .bind(&guid)
        .bind(&page.relative_path)
        .bind(page.kind.as_str())
        .bind(created_at)
        .bind(origin)
        .bind(parent_tab)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok((guid, created_at))
}

/// A window entry's own path, how its page was opened, and the tab it is a child of (if any).
pub(crate) async fn origin_row(pool: &SqlitePool, window_guid: &str) -> Result<(String, Origin, Option<String>), String> {
    let row = sqlx::query("SELECT relative_path, origin, parent_tab FROM secondary_windows WHERE guid = ?1")
        .bind(window_guid)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Window not found.".to_string())?;
    let origin: Origin = row.get::<Option<String>, _>("origin").and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default();
    Ok((row.get("relative_path"), origin, row.get("parent_tab")))
}

/// Opens a web app that belongs to `parent_tab` (a Notes tab): its own window entry, listed under that tab.
/// Resolves to the entry's guid.
/// Opens the user-folder page `relative_path` in a window of its own, listed among the apps like one opened from the admin-app —
/// what a web page does when it opens another one (`open_related_web_app`). Resolves to the new window's guid.
pub(crate) async fn open_page_window(app: &AppHandle, relative_path: String) -> Result<String, String> {
    let state = app.state::<SecondaryWindowsState>();
    let page = Page::new(Kind::User, relative_path);
    validate_page(app, &page)?;
    let (guid, _) = insert_entry(&state.pool, &page).await?;
    let (tab_guid, created) = tab_for_opening(&state.pool, &guid, &page.relative_path, None).await?;
    state.pending_tab_activation.lock().unwrap().insert(guid.clone(), (tab_guid, !created));
    crate::window_host::open(app, &guid, &page)?;
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(guid)
}

pub(crate) async fn open_child_window(app: &AppHandle, relative_path: String, origin: Origin, parent_tab: String) -> Result<String, String> {
    let state = app.state::<SecondaryWindowsState>();
    let page = Page::new(Kind::User, relative_path);
    validate_page(app, &page)?;
    let origin_json = serde_json::to_string(&origin).map_err(|e| e.to_string())?;
    let (guid, _) = insert_entry_full(&state.pool, &page, Some(&origin_json), Some(&parent_tab)).await?;
    let (tab_guid, created) = tab_for_opening(&state.pool, &guid, &page.relative_path, None).await?;
    state.pending_tab_activation.lock().unwrap().insert(guid.clone(), (tab_guid, !created));
    crate::window_host::open(app, &guid, &page)?;
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(guid)
}

fn current_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Rejects paths that escape the user folder or don't point at an existing .html/.htm file.
pub(crate) fn validate_relative_html_path(app: &AppHandle, relative_path: &str) -> Result<(), String> {
    // A file of a picked folder or a Filen account (see `notes_pages`): not on disk under the user folder; it is
    // judged, by the scope or the cache, whenever it is served.
    if relative_path.starts_with("@device/") || relative_path.starts_with("@filen/") {
        return if crate::notes_pages::is_page_file(relative_path) { Ok(()) } else { Err("Only .html, .htm and markdown (.md) files can be opened as web apps.".to_string()) };
    }
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
    if !matches!(ext.as_str(), "html" | "htm" | "md" | "markdown") {
        return Err("Only .html, .htm and markdown (.md) files can be opened as web apps.".to_string());
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

    Ok(Some(insert_placeholder_tab(pool, &group_guid, window_guid, relative_path).await?))
}

/// Adds a blank tab (empty resource id, no text) to a group and returns its guid.
async fn insert_placeholder_tab(pool: &SqlitePool, group_guid: &str, window_guid: &str, relative_path: &str) -> Result<String, String> {
    let tab_guid = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO tabs (guid, group_guid, window_guid, relative_path, app_version, resource_id, resource_type, tab_text, created_at)
         VALUES (?1, ?2, ?3, ?4, 0, '', NULL, NULL, ?5)",
    )
    .bind(&tab_guid)
    .bind(group_guid)
    .bind(window_guid)
    .bind(relative_path)
    .bind(current_millis())
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(tab_guid)
}

/// Whether `tab_guid` is a tab of window `window_guid`.
async fn tab_in_window(pool: &SqlitePool, tab_guid: &str, window_guid: &str) -> Result<bool, String> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tabs WHERE guid = ?1 AND window_guid = ?2")
        .bind(tab_guid)
        .bind(window_guid)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(count > 0)
}

/// Decides which tab a window that is being opened (or reopened) will show — before its page exists,
/// so the entry is in the list first and the page's init request only *binds* to it. In order:
/// `preferred` (the tab it showed before), else the window's first tab, else a new blank placeholder
/// (in its first group, or a new default group if it has none). Resolves to the tab's guid and
/// whether it was just created.
async fn tab_for_opening(
    pool: &SqlitePool,
    window_guid: &str,
    relative_path: &str,
    preferred: Option<&str>,
) -> Result<(String, bool), String> {
    if let Some(tab) = preferred {
        if tab_in_window(pool, tab, window_guid).await? {
            return Ok((tab.to_string(), false));
        }
    }
    let first: Option<String> = sqlx::query_scalar(
        "SELECT t.guid FROM tabs t JOIN tab_groups g ON g.guid = t.group_guid
         WHERE t.window_guid = ?1 ORDER BY g.created_at ASC, g.rowid ASC, t.created_at ASC, t.rowid ASC LIMIT 1",
    )
    .bind(window_guid)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    if let Some(tab) = first {
        return Ok((tab, false));
    }
    if let Some(tab) = ensure_default_tab_group(pool, window_guid, relative_path).await? {
        return Ok((tab, true));
    }
    // Groups, but not a single tab in them.
    let group: String = sqlx::query_scalar("SELECT guid FROM tab_groups WHERE window_guid = ?1 ORDER BY created_at ASC, rowid ASC LIMIT 1")
        .bind(window_guid)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok((insert_placeholder_tab(pool, &group, window_guid, relative_path).await?, true))
}

/// Which tab an `init_window_tab` call from window `window_guid` binds to — it never creates one
/// (a page adds tabs with `add_window_tab`). The tab that was made ready for the page (`pending`),
/// else the tab the window is showing (`current`: this is a reload), else whatever
/// `tab_for_opening` picks. Resolves to the tab and whether to echo its own stored resource id
/// rather than the URL's (see `SecondaryWindowsState::pending_tab_activation`).
async fn tab_for_init(
    pool: &SqlitePool,
    window_guid: &str,
    relative_path: &str,
    pending: Option<(String, bool)>,
    current: Option<String>,
) -> Result<(String, bool), String> {
    if let Some((tab, force_stored)) = pending {
        if tab_in_window(pool, &tab, window_guid).await? {
            return Ok((tab, force_stored));
        }
    }
    if let Some(tab) = current {
        if tab_in_window(pool, &tab, window_guid).await? {
            return Ok((tab, true));
        }
    }
    let (tab, created) = tab_for_opening(pool, window_guid, relative_path, None).await?;
    Ok((tab, !created))
}

/// Deletes a secondary window's row along with its tab groups, tabs, and every tag
/// attached to any of them.
/// Deletes a window entry with everything under it — and the windows opened from its tabs, and theirs. Resolves to
/// what the caller must close: those windows, and the external web sites' windows.
async fn delete_window_and_tags(pool: &SqlitePool, guid: &str) -> crate::notes_pages::Closing {
    let mut closing = crate::notes_pages::Closing::default();
    let mut queue = crate::notes_pages::children_of_window(pool, guid).await;
    let mut descendants = Vec::new();
    while let Some(window) = queue.pop() {
        queue.extend(crate::notes_pages::children_of_window(pool, &window).await);
        descendants.push(window);
    }
    for window in descendants {
        closing.external.extend(delete_window_rows(pool, &window).await);
        closing.windows.push(window);
    }
    closing.external.extend(delete_window_rows(pool, guid).await);
    closing
}

/// Deletes the windows opened from these tabs (the tabs are going), each with what is under it.
async fn delete_children_of_tabs(pool: &SqlitePool, tab_guids: &[String]) -> crate::notes_pages::Closing {
    let mut closing = crate::notes_pages::Closing::default();
    for child in crate::notes_pages::children_of_tabs(pool, tab_guids).await {
        let below = delete_window_and_tags(pool, &child).await;
        closing.merge(below);
        closing.windows.push(child);
    }
    closing
}

/// One window entry's own rows: its tabs, groups, tags and external web sites (resolving to their guids).
async fn delete_window_rows(pool: &SqlitePool, guid: &str) -> Vec<String> {
    let external = crate::external_sites::delete_for_window(pool, guid).await;
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
    let _ = sqlx::query("DELETE FROM window_state WHERE window_guid = ?1").bind(guid).execute(pool).await;
    external
}

/// Marks an entry's window as being *suspended*, so that when it goes away its entry is kept.
#[cfg_attr(desktop, allow(dead_code))] // used by the mobile window host
pub(crate) fn mark_suspending(app: &AppHandle, guid: &str) {
    app.state::<SecondaryWindowsState>().pending_suspend.lock().unwrap().insert(guid.to_string());
}

/// The main window is being closed (desktop). **The first thing** is to raise the flag that keeps window entries
/// from being removed as their windows go; then the close is held back while every secondary window is
/// suspended — their real windows closed, the entries kept — and only then is the main window closed for
/// real. A second request (the one that closing it for real raises, or a person pressing the button again) is
/// let through. Even if the OS ends the app before the suspending is done, no entry has been removed.
#[cfg(desktop)]
pub(crate) fn main_window_close_requested(app: &AppHandle, api: &tauri::CloseRequestApi) {
    let state = app.state::<SecondaryWindowsState>();
    if state.shutting_down.swap(true, Ordering::SeqCst) {
        return;
    }
    api.prevent_close();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        suspend_everything(&app).await;
        if let Some(main) = app.get_webview_window(crate::window_host::MAIN_WINDOW_LABEL) {
            let _ = main.close();
        }
    });
}

/// Suspends every secondary window (of both kinds, including the ones opened from tabs) and closes every
/// external web site's window, waiting for them to be gone.
#[cfg(desktop)]
async fn suspend_everything(app: &AppHandle) {
    let state = app.state::<SecondaryWindowsState>();
    let rows = fetch_rows_with(&state.pool, None, None, true).await.unwrap_or_default();
    let mut closing = Vec::new();
    for (guid, _, _) in rows {
        if crate::window_host::is_open(app, &guid) {
            state.pending_suspend.lock().unwrap().insert(guid.clone());
            crate::window_host::request_close(app, &guid);
            closing.push(guid);
        }
    }
    let external = crate::external_sites::all_guids(&state.pool).await;
    crate::external_sites::close_windows(app, &external);
    closing.extend(external);
    crate::window_host::wait_until_closed(app, &closing).await;
}

pub(crate) async fn handle_window_destroyed(app: &AppHandle, guid: &str) {
    // A User Action window's Notes window learns that it is gone (before its entry — which says whose it is — goes).
    crate::user_action::window_gone(app, guid).await;
    // Release any SQLite databases the window still had open.
    app.state::<crate::sqlite_db::SqliteState>().close(guid, None).await;

    let state = app.state::<SecondaryWindowsState>();
    let was_suspended = {
        let mut pending = state.pending_suspend.lock().unwrap();
        // (Always taken out, so a suspend that was asked for isn't left behind.)
        let asked = pending.remove(guid);
        asked || state.shutting_down.load(Ordering::SeqCst)
    };

    if !was_suspended {
        state.current_tabs.lock().unwrap().remove(guid);
        delete_window_and_tags(&state.pool, guid).await.close(app);
    } else {
        // Suspending a window suspends the external web sites opened from its tabs and the web apps opened
        // from them (which do the same to theirs): their windows close, their entries stay.
        let open = crate::external_sites::guids_of_window(&state.pool, guid).await;
        crate::external_sites::close_windows(app, &open);
        for child in crate::notes_pages::children_of_window(&state.pool, guid).await {
            if crate::window_host::is_open(app, &child) {
                state.pending_suspend.lock().unwrap().insert(child.clone());
                crate::window_host::request_close(app, &child);
            }
        }
    }

    let _ = app.emit(EVENT_CHANGED, ());
}

pub(crate) async fn fetch_tags(pool: &SqlitePool, guids: &[String]) -> Result<Vec<TagRecord>, sqlx::Error> {
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
        "SELECT guid, group_guid, window_guid, relative_path, app_version, resource_id, resource_type, tab_text, app_title, created_at
         FROM tabs WHERE group_guid IN ({placeholders}) ORDER BY created_at ASC"
    );

    let mut q = sqlx::query(&query);
    for guid in group_guids {
        q = q.bind(guid);
    }
    let rows = q.fetch_all(pool).await?;

    let tab_guids: Vec<String> = rows.iter().map(|row| row.get::<String, _>("guid")).collect();
    let all_tags = fetch_tags(pool, &tab_guids).await?;
    let all_external = crate::external_sites::fetch_for_tabs(pool, &tab_guids).await?;
    let all_opened = crate::notes_pages::fetch_for_tabs(pool, &tab_guids).await?;

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
            let external_pages = all_external.iter().filter(|p| p.tab_guid == guid).cloned().collect();
            let opened_apps = all_opened.iter().filter(|(tab, _)| *tab == guid).map(|(_, app)| app.clone()).collect();
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
                app_title: row.get("app_title"),
                created_at: row.get("created_at"),
                tags,
                external_pages,
                opened_apps,
                showing: false,
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

/// The window entries — of one kind (or, with `None`, both) and, optionally, of one app.
async fn fetch_rows(
    pool: &SqlitePool,
    kind: Option<&str>,
    relative_path: Option<&str>,
) -> Result<Vec<(String, String, i64)>, sqlx::Error> {
    fetch_rows_with(pool, kind, relative_path, false).await
}

/// `with_children`: also the windows that are children of a tab (see `notes_pages`) — the listing of the apps
/// leaves them out (they are listed under their tab), closing and suspending everything does not.
async fn fetch_rows_with(
    pool: &SqlitePool,
    kind: Option<&str>,
    relative_path: Option<&str>,
    with_children: bool,
) -> Result<Vec<(String, String, i64)>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT guid, relative_path, created_at FROM secondary_windows
         WHERE (?1 IS NULL OR kind = ?1) AND (?2 IS NULL OR relative_path = ?2) AND (?3 OR parent_tab IS NULL)
         ORDER BY relative_path ASC, created_at DESC",
    )
    .bind(kind)
    .bind(relative_path)
    .bind(with_children)
    .fetch_all(pool)
    .await?;

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
    kind: Option<String>,
) -> Result<Vec<SecondaryWindowRecord>, String> {
    let kind = Kind::parse(kind.as_deref())?;
    let rows = fetch_rows(&state.pool, Some(kind.as_str()), None).await.map_err(|e| e.to_string())?;
    let guids: Vec<String> = rows.iter().map(|(guid, _, _)| guid.clone()).collect();
    let all_tags = fetch_tags(&state.pool, &guids).await.map_err(|e| e.to_string())?;
    let all_groups = fetch_tab_groups(&state.pool, &guids).await.map_err(|e| e.to_string())?;

    let mut records: Vec<SecondaryWindowRecord> = rows
        .into_iter()
        .map(|(guid, relative_path, created_at)| {
            let is_open = crate::window_host::is_open(&app, &guid);
            let tags = all_tags.iter().filter(|t| t.guid == guid).cloned().collect();
            let tab_groups = all_groups.iter().filter(|g| g.window_guid == guid).cloned().collect();
            SecondaryWindowRecord {
                guid,
                kind: kind.as_str().to_string(),
                relative_path,
                created_at,
                is_open,
                tags,
                tab_groups,
            }
        })
        .collect();
    for tab in records.iter_mut().flat_map(|w| w.tab_groups.iter_mut()).flat_map(|g| g.tabs.iter_mut()) {
        tab.showing = crate::window_host::is_open(&app, &tab.window_guid) && window_shows(&state, &tab.window_guid, &tab.guid);
        for external in tab.external_pages.iter_mut() {
            external.is_open = crate::external_sites::is_open(&app, &external.guid);
        }
        for opened in tab.opened_apps.iter_mut() {
            opened.is_open = crate::window_host::is_open(&app, &opened.guid);
        }
    }
    Ok(records)
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
    kind: Option<String>,
) -> Result<SecondaryWindowRecord, String> {
    let page = page_from_request(Kind::parse(kind.as_deref())?, &relative_path);
    validate_page(&app, &page)?;
    let (guid, created_at) = insert_entry(&state.pool, &page).await?;

    let (tab_guid, created) = tab_for_opening(&state.pool, &guid, &page.relative_path, None).await?;
    state.pending_tab_activation.lock().unwrap().insert(guid.clone(), (tab_guid, !created));

    crate::window_host::open(&app, &guid, &page)?;
    let _ = app.emit(EVENT_CHANGED, ());

    let tab_groups = fetch_tab_groups(&state.pool, &[guid.clone()]).await.map_err(|e| e.to_string())?;
    Ok(SecondaryWindowRecord {
        guid,
        kind: page.kind.as_str().to_string(),
        relative_path: page.relative_path,
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
    kind: Option<String>,
) -> Result<SecondaryWindowRecord, String> {
    let page = page_from_request(Kind::parse(kind.as_deref())?, &relative_path);
    validate_page(&app, &page)?;
    let (guid, created_at) = insert_entry(&state.pool, &page).await?;

    let (tab_guid, created) = tab_for_opening(&state.pool, &guid, &page.relative_path, None).await?;
    state.pending_tab_activation.lock().unwrap().insert(guid.clone(), (tab_guid, !created));

    let _ = app.emit(EVENT_CHANGED, ());

    let tab_groups = fetch_tab_groups(&state.pool, &[guid.clone()]).await.map_err(|e| e.to_string())?;
    Ok(SecondaryWindowRecord {
        guid,
        kind: page.kind.as_str().to_string(),
        relative_path: page.relative_path,
        created_at,
        is_open: false,
        tags: Vec::new(),
        tab_groups,
    })
}

/// Opens an entry's window again (it was suspended). What it shows comes from its own row.
#[tauri::command]
pub async fn reopen_secondary_window(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    guid: String,
) -> Result<(), String> {
    let page = page_of(&state.pool, &guid).await?;
    validate_page(&app, &page)?;

    if crate::window_host::is_open(&app, &guid) {
        return Ok(());
    }

    // The window shows the tab it showed when it was suspended (else its first one, else a new
    // placeholder), and its page's init request binds to that tab — no new tab appears. A tab the person opened a link
    // in shows that link's page.
    let showed = state.current_tabs.lock().unwrap().get(&guid).cloned();
    let (tab_guid, created) = tab_for_opening(&state.pool, &guid, &page.relative_path, showed.as_deref()).await?;
    let page = page_to_show(&state.pool, &tab_guid, &page).await?;
    validate_page(&app, &page)?;
    state.pending_tab_activation.lock().unwrap().insert(guid.clone(), (tab_guid, !created));

    crate::window_host::open(&app, &guid, &page)?;
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
}

/// Closes a window entry. An open one is asked to close (and its entry goes when it has); one that is
/// suspended has nothing to close, so its entry — with its tab groups, tabs and tags — is removed.
#[tauri::command]
pub async fn close_secondary_window(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    guid: String,
) -> Result<(), String> {
    if !crate::window_host::request_close(&app, &guid) {
        state.pending_tab_activation.lock().unwrap().remove(&guid);
        state.current_tabs.lock().unwrap().remove(&guid);
        delete_window_and_tags(&state.pool, &guid).await.close(&app);
        let _ = app.emit(EVENT_CHANGED, ());
    }
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

/// Closes every open secondary window matching `relative_path` and `kind` (or all of them, if
/// `None`) and waits for them to actually finish closing before returning. Also
/// called directly (not just as a command) by the data-folder deletion flow in
/// `data_location`, which must not proceed while a window might still be reading
/// from — or writing tab data into — the folder about to be deleted.
#[tauri::command]
pub async fn close_all_secondary_windows(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    relative_path: Option<String>,
    kind: Option<String>,
) -> Result<(), String> {
    let kind = kind.as_deref().map(|k| Kind::parse(Some(k))).transpose()?;
    let rows = fetch_rows_with(&state.pool, kind.map(Kind::as_str), relative_path.as_deref(), true)
        .await
        .map_err(|e| e.to_string())?;

    let mut closing = Vec::new();
    for (guid, _, _) in &rows {
        if crate::window_host::request_close(&app, guid) {
            // The window-destroyed handler deletes the row (and its tags) once the window actually closes.
            closing.push(guid.clone());
        } else {
            delete_window_and_tags(&state.pool, guid).await.close(&app);
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
    kind: Option<String>,
) -> Result<(), String> {
    let kind = kind.as_deref().map(|k| Kind::parse(Some(k))).transpose()?;
    let rows = fetch_rows_with(&state.pool, kind.map(Kind::as_str), relative_path.as_deref(), true)
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

/// Reloads the page an **open** window shows — the same as `location.reload()` in it, whichever tab that is.
#[tauri::command]
pub fn reload_secondary_window(app: AppHandle, guid: String) -> Result<(), String> {
    if !crate::window_host::is_open(&app, &guid) {
        return Err("That window isn't open.".into());
    }
    crate::window_host::reload(&app, &guid);
    Ok(())
}

/// Reloads a tab — when it is **the one an open window is showing** (a tab that isn't shown has no page to reload).
#[tauri::command]
pub async fn reload_tab(app: AppHandle, state: tauri::State<'_, SecondaryWindowsState>, tab_guid: String) -> Result<(), String> {
    let window_guid: Option<String> =
        sqlx::query_scalar("SELECT window_guid FROM tabs WHERE guid = ?1").bind(&tab_guid).fetch_optional(&state.pool).await.map_err(|e| e.to_string())?;
    let window_guid = window_guid.ok_or("That tab doesn't exist.")?;
    if !crate::window_host::is_open(&app, &window_guid) || !window_shows(&state, &window_guid, &tab_guid) {
        return Err("That tab isn't shown in an open window, so there is nothing to reload.".into());
    }
    crate::window_host::reload(&app, &window_guid);
    Ok(())
}

/// Splits a page's full `location.href` into the window's own html-file relative
/// path (no query — used to group tabs under the right app/window) and the tab's
/// resource identifier (relative path *with* its query string, if any — the piece
/// that actually distinguishes one open resource from another within that app).
fn split_url_into_path_and_resource_id(url: &str) -> Result<(String, String), String> {
    let parsed = Url::parse(url).map_err(|e| e.to_string())?;
    // A system app's page is a page of our own frontend; its windows and tabs are known as `system:<id>`.
    let system_app = crate::window_host::is_system_url(&parsed).then(|| crate::system_apps::app_of_entry_path(parsed.path())).flatten();
    let relative_path = match system_app {
        Some(app) => crate::system_apps::relative_path_of(app.id),
        None => parsed.path().trim_start_matches('/').to_string(),
    };
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

/// The core of both `init_window_tab` (which passes the tab to bind to as `reuse`) and
/// `add_window_tab` (which passes none). The calling window's own label is its guid (see
/// `build_window`), so the window never needs to know or send its own guid — Tauri hands it to us
/// via the `window` parameter.
///
/// If `reuse` is set, this call binds to that exact tab instead of creating a new one, in one of
/// two ways depending on why it was chosen (see `SecondaryWindowsState::pending_tab_activation`):
///  - `force_stored_resource_id: false` (a placeholder just created for a new window) — it is
///    filled in with the real URL-derived resource id, the same as a fresh tab would get.
///  - `true` (a tab that already existed — activated, reopened or reloaded) — the response echoes
///    back *that tab's own* stored resource id (unchanged) instead of one derived from the page's
///    URL, letting the app decide what to show for a reactivated (possibly still-blank) tab itself.
///
/// Without `reuse`: finds-or-creates the window's default tab group and creates a fresh tab in it,
/// deriving the resource id from the URL. The tab starts with no display text — the app fills that in
/// with a follow-up `update_tab_resource` call once it has something to show. Returns whether this
/// app_version is new/newer for this html file, alongside the usual response.
/// Tells a page how it was opened (see `Origin`): its own path, who opened it and where it is stored. The
/// window it runs in is found from its tab.
async fn fill_origin(pool: &SqlitePool, app: Option<&AppHandle>, response: &mut TabInitResponse) -> Result<(), String> {
    let row = sqlx::query(
        "SELECT w.kind AS kind, w.relative_path AS relative_path, w.origin AS origin, t.link_page AS link_page
         FROM tabs t JOIN secondary_windows w ON w.guid = t.window_guid WHERE t.guid = ?1",
    )
    .bind(&response.tab_guid)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let Some(row) = row else { return Ok(()) };
    let kind: String = row.get("kind");
    let origin: Origin = row.get::<Option<String>, _>("origin").and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default();
    response.relative_path = origin.path.unwrap_or_else(|| row.get("relative_path"));
    // A tab the person opened a link in shows another file of the same storage than the one the window was opened for.
    if let Some(link) = row.get::<Option<String>, _>("link_page") {
        let path = percent_encoding::percent_decode_str(link.split('?').next().unwrap_or("")).decode_utf8_lossy().to_string();
        // Where the page is, from its address: what it is told about itself follows the page (in a tab of a system app's window
        // the window's own origin — bundled — is not the page's).
        response.relative_path = match crate::notes_pages::parse_special(&format!("/{path}")) {
            Some(Ok(crate::notes_pages::Special::Filen { user_id, branch, path })) => {
                response.storage = "FilenCloud".to_string();
                let email = match app {
                    Some(app) => crate::filen::email_of(app, user_id).await.unwrap_or_default(),
                    None => String::new(),
                };
                response.filen = Some(FilenOrigin { account_id: user_id as i64, email, branch: None, branch_index: branch });
                path
            }
            Some(Ok(crate::notes_pages::Special::Device { path, .. })) => {
                response.storage = "DeviceFolder".to_string();
                response.filen = None;
                path
            }
            _ => {
                response.storage = "UserFolder".to_string();
                response.filen = None;
                path
            }
        };
        if kind == "system" {
            response.opened_by = "NotesApp".to_string();
        }
    }
    response.opened_by = origin.opened_by.unwrap_or_else(|| "AdminApp".to_string());
    response.role = origin.role.unwrap_or_default();
    response.storage = origin.storage.unwrap_or_else(|| if kind == "system" { "Bundled" } else { "UserFolder" }.to_string());
    response.filen = origin.filen;
    Ok(())
}

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
                    ..Default::default()
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
            ..Default::default()
        },
        is_new_or_newer_version,
    ))
}

/// Sent to a window (only) when a tab is activated in it while it is open — the tab's
/// `TabInitResponse`, the very same data `init_window_tab` answers with — so the page can switch to
/// that tab in place. Every app, system or user, gets it and is expected to handle it (a page is never
/// reloaded for it). A page should start listening *before* it calls `init_window_tab`, so it can't
/// miss one. (A window that is not open is simply opened, and the init response carries the tab.)
pub const EVENT_TAB_NAVIGATE: &str = "tab-navigate";

/// Emitted to a specific window asking the app running in it to report its icons —
/// see `submit_resource_icons`. Sent whenever `init_window_tab` sees an app_version
/// it hasn't seen before (including the very first time that html file is opened).
pub const EVENT_REQUEST_RESOURCE_ICONS: &str = "request-resource-icons";

#[tauri::command]
pub async fn init_window_tab(
    window: crate::window_host::CallerWindow,
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    app_version: i64,
    url: String,
    resource_type: Option<String>,
) -> Result<TabInitResponse, String> {
    let window_guid = crate::window_host::caller_guid(&window).ok_or("Only web apps can register tabs.")?;
    let (relative_path, resource_id) = split_url_into_path_and_resource_id(&url)?;
    let pending = state.pending_tab_activation.lock().unwrap().remove(&window_guid);
    let current = state.current_tabs.lock().unwrap().get(&window_guid).cloned();
    let (tab_guid, force_stored) = tab_for_init(&state.pool, &window_guid, &relative_path, pending, current).await?;
    let (mut result, needs_icons) = init_window_tab_impl(
        &state.pool,
        &window_guid,
        &relative_path,
        &resource_id,
        resource_type.as_deref(),
        app_version,
        Some((&tab_guid, force_stored)),
    )
    .await?;

    state.current_tabs.lock().unwrap().insert(window_guid.clone(), result.tab_guid.clone());
    refresh_window_title(&app, &window_guid).await;

    if needs_icons {
        // To the window that registered — not to every window.
        crate::window_host::emit_if_open(&app, &window_guid, EVENT_REQUEST_RESOURCE_ICONS, ());
    }

    let _ = app.emit(EVENT_CHANGED, ());
    result.code_snippets = crate::code_snippets::code_snippets();
    fill_origin(&state.pool, Some(&app), &mut result).await?;
    // A User Action window that was opened for a launch is told of it now that it has registered.
    crate::user_action::page_ready(&app, &window_guid).await;
    Ok(result)
}

/// Creates a tab (`init_window_tab_impl` without `reuse`) and puts it in the group of `current_tab` —
/// the tab the window is showing — if it has one, rather than just the window's first group.
async fn add_tab_impl(
    pool: &SqlitePool,
    window_guid: &str,
    relative_path: &str,
    resource_id: &str,
    resource_type: Option<&str>,
    app_version: i64,
    current_tab: Option<&str>,
) -> Result<(TabInitResponse, bool), String> {
    let (response, needs_icons) =
        init_window_tab_impl(pool, window_guid, relative_path, resource_id, resource_type, app_version, None).await?;
    if let Some(current) = current_tab {
        let group: Option<String> = sqlx::query_scalar("SELECT group_guid FROM tabs WHERE guid = ?1 AND window_guid = ?2")
            .bind(current)
            .bind(window_guid)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
        if let Some(group) = group {
            sqlx::query("UPDATE tabs SET group_guid = ?1 WHERE guid = ?2")
                .bind(group)
                .bind(&response.tab_guid)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok((response, needs_icons))
}

/// Called by an app running inside a secondary window to **add another tab** — a second document, a
/// new view — to the list. This is the only request with which a page creates a tab: `init_window_tab`
/// only ever binds the page to a tab the admin-app already made for it. Takes what `init_window_tab`
/// takes (the page's own `location.href`, from which the resource id is derived, and an optional
/// resource type) and answers with the same data. The new tab lands in the group of the tab the
/// window is showing and **becomes that window's current tab** — the app is showing it now, so a later
/// reload of the page binds to it.
#[tauri::command]
pub async fn add_window_tab(
    window: crate::window_host::CallerWindow,
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    app_version: i64,
    url: String,
    resource_type: Option<String>,
) -> Result<TabInitResponse, String> {
    let window_guid = crate::window_host::caller_guid(&window).ok_or("Only web apps can add tabs.")?;
    let (relative_path, resource_id) = split_url_into_path_and_resource_id(&url)?;
    let current = state.current_tabs.lock().unwrap().get(&window_guid).cloned();
    let (mut result, needs_icons) = add_tab_impl(
        &state.pool,
        &window_guid,
        &relative_path,
        &resource_id,
        resource_type.as_deref(),
        app_version,
        current.as_deref(),
    )
    .await?;

    state.pending_tab_activation.lock().unwrap().remove(&window_guid);
    state.current_tabs.lock().unwrap().insert(window_guid.clone(), result.tab_guid.clone());
    refresh_window_title(&app, &window_guid).await;

    if needs_icons {
        crate::window_host::emit_if_open(&app, &window_guid, EVENT_REQUEST_RESOURCE_ICONS, ());
    }
    let _ = app.emit(EVENT_CHANGED, ());
    result.code_snippets = crate::code_snippets::code_snippets();
    fill_origin(&state.pool, Some(&app), &mut result).await?;
    Ok(result)
}

/// Updates a tab's label, its window title and/or resource type/id. `resource_type`/`resource_id`
/// are only changed when the app actually sends one — COALESCE keeps whatever
/// was already stored otherwise. The label and the title are replaced as they are sent (no title is
/// "none": the window's title is then made from the label — see `window_title`).
async fn update_tab_resource_impl(
    pool: &SqlitePool,
    tab_guid: &str,
    tab_text: &TabText,
    app_title: Option<&str>,
    resource_type: Option<&str>,
    resource_id: Option<&str>,
) -> Result<(), String> {
    let json = serde_json::to_string(tab_text).map_err(|e| e.to_string())?;
    let app_title = app_title.map(str::trim).filter(|t| !t.is_empty());
    sqlx::query(
        "UPDATE tabs SET tab_text = ?1, app_title = ?2, resource_type = COALESCE(?3, resource_type), resource_id = COALESCE(?4, resource_id) WHERE guid = ?5",
    )
    .bind(&json)
    .bind(app_title)
    .bind(resource_type)
    .bind(resource_id)
    .bind(tab_guid)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    if resource_id.is_some() {
        // A tab that shows a page a link led to keeps showing what its page says it is at now.
        sqlx::query("UPDATE tabs SET link_page = resource_id WHERE guid = ?1 AND link_page IS NOT NULL").bind(tab_guid).execute(pool).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// What a window's title says about the tab it shows: the title the page gave (`appTitle`), or — when it gave none, or an
/// empty one — the pieces of the first row of the tab's label joined with a bullet (the window manager draws the pieces
/// of a row with bullets between them too). `None` when there is nothing to say (the window then keeps the title of its
/// page). The title is one plain line: no styles, and line breaks become spaces.
pub(crate) fn window_title(app_title: Option<&str>, tab_text: Option<&TabText>) -> Option<String> {
    let one_line = |text: &str| text.split(['\r', '\n', '\t']).map(str::trim).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
    if let Some(title) = app_title.map(one_line).filter(|t| !t.is_empty()) {
        return Some(title);
    }
    let pieces: Vec<String> = tab_text?.first_row.iter().map(|span| one_line(&span.text)).filter(|t| !t.is_empty()).collect();
    (!pieces.is_empty()).then(|| pieces.join(" • "))
}

/// Puts the title of the tab a window is showing on the window (the OS window's title on desktop, the card in the Recents
/// screen on Android). Called whenever what the window shows, or what its tab says about it, may have changed.
pub(crate) async fn refresh_window_title(app: &AppHandle, window_guid: &str) {
    let state = app.state::<SecondaryWindowsState>();
    let Some(tab) = state.current_tabs.lock().unwrap().get(window_guid).cloned() else {
        return;
    };
    let row = sqlx::query("SELECT app_title, tab_text FROM tabs WHERE guid = ?1 AND window_guid = ?2")
        .bind(&tab)
        .bind(window_guid)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten();
    let title = row.and_then(|row| {
        let app_title: Option<String> = row.get("app_title");
        let tab_text = row.get::<Option<String>, _>("tab_text").and_then(|json| serde_json::from_str::<TabText>(&json).ok());
        window_title(app_title.as_deref(), tab_text.as_ref())
    });
    let title = match title {
        Some(title) => title,
        None => match page_of(&state.pool, window_guid).await {
            Ok(page) => page.title(),
            Err(_) => return,
        },
    };
    crate::window_host::set_title(app, window_guid, &title);
}

/// Called by an app to set (or replace) the two-line, richly-styled label its tab
/// shows in the window manager, and optionally its resource type (the key into that
/// app's icon set — see `submit_resource_icons`) and/or its resource id (e.g. the
/// app navigated to a different view within the same tab, without opening a new
/// one). Rejects updating a tab that doesn't belong to the calling window, so one
/// app's page can't relabel another window's tab.
#[tauri::command]
pub async fn update_tab_resource(
    window: crate::window_host::CallerWindow,
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    tab_guid: String,
    tab_text: TabText,
    app_title: Option<String>,
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

    update_tab_resource_impl(&state.pool, &tab_guid, &tab_text, app_title.as_deref(), resource_type.as_deref(), resource_id.as_deref()).await?;

    refresh_window_title(&app, &owner_window_guid).await;
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
}

/// Called by an app in response to a `request-resource-icons` event to report its
/// icon set: a map of resource-type key to SVG markup. The calling window's own
/// relative path (looked up the same way `init_window_tab` identifies it) is what
/// the icons get filed under.
#[tauri::command]
pub async fn submit_resource_icons(
    window: crate::window_host::CallerWindow,
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    icons: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let relative_path: Option<String> = sqlx::query_scalar("SELECT relative_path FROM secondary_windows WHERE guid = ?1")
        .bind(crate::window_host::caller_guid(&window))
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    let mut relative_path = relative_path.ok_or_else(|| "Window not found.".to_string())?;
    // A web page shown in a tab of a system app's window submits icons for itself, never over the system app's.
    if relative_path.starts_with("system:") {
        if let Some(page) = crate::app_state::hosted_page_id(&app, &window) {
            relative_path = page;
        }
    }

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
        app_title: None,
        created_at,
        tags: Vec::new(),
        external_pages: Vec::new(),
        opened_apps: Vec::new(),
        showing: false,
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
        "INSERT INTO tabs (guid, group_guid, window_guid, relative_path, app_version, resource_id, resource_type, tab_text, link_page, created_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, NULL, NULL, (SELECT link_page FROM tabs WHERE guid = ?7), ?6)",
    )
    .bind(&new_guid)
    .bind(&group_guid)
    .bind(&window_guid)
    .bind(&relative_path)
    .bind(&resource_id)
    .bind(created_at)
    .bind(&tab_guid)
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
        app_title: None,
        created_at,
        tags: Vec::new(),
        external_pages: Vec::new(),
        opened_apps: Vec::new(),
        showing: false,
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
    let page = page_to_show(&state.pool, &tab_guid, &page_of(&state.pool, &window_guid).await?).await?;
    let payload = navigation_payload(&state.pool, &tab_guid).await?;

    // A tab of a web app's window that shows another *page* than the window is at (a link was opened in it) is shown by
    // taking the window there; every other tab switch is the event, and the page shows the tab in place.
    let elsewhere = crate::window_host::current_page_url(&app, &window_guid).zip(page.url().ok()).is_some_and(|(now, wanted)| !crate::same_page(&wanted, &now));
    if elsewhere {
        state.pending_tab_activation.lock().unwrap().remove(&window_guid);
        state.current_tabs.lock().unwrap().insert(window_guid.clone(), tab_guid);
        crate::window_host::navigate(&app, &window_guid, &page)?;
        refresh_window_title(&app, &window_guid).await;
    } else if crate::window_host::emit_if_open(&app, &window_guid, EVENT_TAB_NAVIGATE, payload) {
        // The window shows it now; if its page loads again (it reloads itself in response, or the
        // person presses reload), its init request binds to the window's current tab.
        state.pending_tab_activation.lock().unwrap().remove(&window_guid);
        state.current_tabs.lock().unwrap().insert(window_guid.clone(), tab_guid);
        refresh_window_title(&app, &window_guid).await;
    } else {
        state.pending_tab_activation.lock().unwrap().insert(window_guid.clone(), (tab_guid, true));
        crate::window_host::open(&app, &window_guid, &page)?;
    }

    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
}

/// Deletes a tab group, its tabs and the tags on all of them. Resolves to the guid of the window the
/// group belonged to and the guids of the tabs that went with it.
async fn delete_tab_group_impl(pool: &SqlitePool, group_guid: &str) -> Result<(String, Vec<String>), String> {
    let window_guid: Option<String> = sqlx::query_scalar("SELECT window_guid FROM tab_groups WHERE guid = ?1")
        .bind(group_guid)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    let window_guid = window_guid.ok_or_else(|| "Tab group not found.".to_string())?;

    let tab_guids: Vec<String> = sqlx::query_scalar("SELECT guid FROM tabs WHERE group_guid = ?1")
        .bind(group_guid)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    for guid in tab_guids.iter().map(String::as_str).chain(std::iter::once(group_guid)) {
        sqlx::query("DELETE FROM window_tags WHERE guid = ?1").bind(guid).execute(pool).await.map_err(|e| e.to_string())?;
    }
    sqlx::query("DELETE FROM tabs WHERE group_guid = ?1").bind(group_guid).execute(pool).await.map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM tab_groups WHERE guid = ?1").bind(group_guid).execute(pool).await.map_err(|e| e.to_string())?;
    Ok((window_guid, tab_guids))
}

/// Deletes a tab group with its tabs and their tags. As with `close_tab`, if one of them is the tab an
/// open window is showing right now, that window is **suspended**; otherwise windows are left alone.
#[tauri::command]
pub async fn delete_tab_group(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    group_guid: String,
) -> Result<(), String> {
    let (window_guid, tab_guids) = delete_tab_group_impl(&state.pool, &group_guid).await?;
    let mut closing = delete_children_of_tabs(&state.pool, &tab_guids).await;
    closing.external.extend(crate::external_sites::delete_for_tabs(&state.pool, &tab_guids).await);
    closing.close(&app);

    state.pending_tab_activation.lock().unwrap().retain(|_, (pending_tab, _)| !tab_guids.contains(pending_tab));

    let showing_one = state.current_tabs.lock().unwrap().get(&window_guid).is_some_and(|current| tab_guids.contains(current));
    if showing_one && crate::window_host::is_open(&app, &window_guid) {
        state.pending_suspend.lock().unwrap().insert(window_guid.clone());
        crate::window_host::request_close(&app, &window_guid);
    }

    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
}

/// Deletes a tab and the tags on it. Resolves to the guid of the window it belonged to.
async fn close_tab_impl(pool: &SqlitePool, tab_guid: &str) -> Result<String, String> {
    let window_guid: Option<String> = sqlx::query_scalar("SELECT window_guid FROM tabs WHERE guid = ?1")
        .bind(tab_guid)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    let window_guid = window_guid.ok_or_else(|| "Tab not found.".to_string())?;

    sqlx::query("DELETE FROM window_tags WHERE guid = ?1").bind(tab_guid).execute(pool).await.map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM tabs WHERE guid = ?1").bind(tab_guid).execute(pool).await.map_err(|e| e.to_string())?;
    Ok(window_guid)
}

/// Closes a tab: it is deleted, with its tags. If it is the tab an open window is showing right now,
/// that window is **suspended** (its entry and its other tabs are kept, as with any suspend) — the
/// page it was showing has nothing left to belong to. Closing any other tab leaves windows alone.
#[tauri::command]
pub async fn close_tab(
    app: AppHandle,
    state: tauri::State<'_, SecondaryWindowsState>,
    tab_guid: String,
) -> Result<(), String> {
    let window_guid = close_tab_impl(&state.pool, &tab_guid).await?;
    let mut closing = delete_children_of_tabs(&state.pool, std::slice::from_ref(&tab_guid)).await;
    closing.external.extend(crate::external_sites::delete_for_tabs(&state.pool, std::slice::from_ref(&tab_guid)).await);
    closing.close(&app);

    // An activation still waiting for this tab's page would find it gone; nothing is left to wait for.
    state.pending_tab_activation.lock().unwrap().retain(|_, (pending_tab, _)| *pending_tab != tab_guid);

    let showing_it = state.current_tabs.lock().unwrap().get(&window_guid).is_some_and(|current| *current == tab_guid);
    if showing_it && crate::window_host::is_open(&app, &window_guid) {
        state.pending_suspend.lock().unwrap().insert(window_guid.clone());
        crate::window_host::request_close(&app, &window_guid);
    }

    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
}

/// What a page is told when a tab is activated in it: what `init_window_tab` would answer for that
/// tab — its own stored resource id (empty for a tab that has never been used).
async fn navigation_payload(pool: &SqlitePool, tab_guid: &str) -> Result<TabInitResponse, String> {
    let resource_id: Option<String> = sqlx::query_scalar("SELECT resource_id FROM tabs WHERE guid = ?1")
        .bind(tab_guid)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    let mut response = TabInitResponse {
        tab_guid: tab_guid.to_string(),
        resource_id: resource_id.ok_or_else(|| "Tab not found.".to_string())?,
        code_snippets: crate::code_snippets::code_snippets(),
        ..Default::default()
    };
    fill_origin(pool, None, &mut response).await?;
    Ok(response)
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
    crate::external_sites::follow_tab(pool, tab_guid, &target_window_guid).await.map_err(|e| e.to_string())?;

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
            update_tab_resource_impl(&pool, &tab.tab_guid, &blank_text, None, None, Some("res-b"))
                .await
                .unwrap();
            let resource_id: String = sqlx::query_scalar("SELECT resource_id FROM tabs WHERE guid = ?1")
                .bind(&tab.tab_guid)
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(resource_id, "res-b");

            // Without one, the previous value is left untouched.
            update_tab_resource_impl(&pool, &tab.tab_guid, &blank_text, None, None, None).await.unwrap();
            let resource_id: String = sqlx::query_scalar("SELECT resource_id FROM tabs WHERE guid = ?1")
                .bind(&tab.tab_guid)
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(resource_id, "res-b", "omitting resource id must not clear/reset it");
        });
    }

    #[test]
    fn a_tab_a_link_was_opened_in_shows_that_page_and_follows_the_resource_id_the_page_reports() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("link-page").await;
            insert_window(&pool, "win1", "docs/a.md").await;
            let tab = init_tab(&pool, "win1", "docs/a.md", "docs/a.md", 1).await;
            let window_page = Page::new(Kind::User, "docs/a.md");

            // An ordinary tab shows the page its window was opened for.
            assert_eq!(page_to_show(&pool, &tab.tab_guid, &window_page).await.unwrap(), window_page);

            // A link opened in it: it shows that page from then on.
            sqlx::query("UPDATE tabs SET link_page = 'docs/b.md?x=1', resource_id = 'docs/b.md?x=1' WHERE guid = ?1").bind(&tab.tab_guid).execute(&pool).await.unwrap();
            assert_eq!(page_to_show(&pool, &tab.tab_guid, &window_page).await.unwrap(), Page::new(Kind::User, "docs/b.md?x=1"));

            // The page says it is at another address of its own: the tab follows it.
            let blank = TabText { first_row: vec![], second_row: vec![] };
            update_tab_resource_impl(&pool, &tab.tab_guid, &blank, None, None, Some("docs/b.md?x=2")).await.unwrap();
            assert_eq!(page_to_show(&pool, &tab.tab_guid, &window_page).await.unwrap(), Page::new(Kind::User, "docs/b.md?x=2"));

            // A tab of a system app's window can show a page too — a web page, in a window that is the system app's.
            let system = Page::new(Kind::System, "system:notes");
            assert_eq!(page_to_show(&pool, &tab.tab_guid, &system).await.unwrap(), Page::new(Kind::User, "docs/b.md?x=2"));

            // A tab that no link touched is not made to follow anything.
            let other = init_tab(&pool, "win1", "docs/a.md", "docs/a.md?k=1", 1).await;
            update_tab_resource_impl(&pool, &other.tab_guid, &blank, None, None, Some("docs/a.md?k=2")).await.unwrap();
            assert_eq!(page_to_show(&pool, &other.tab_guid, &window_page).await.unwrap(), window_page);
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
                    TabTextSpan { text: "asdfasdf".to_string(), bold: true, italic: false, mono: false },
                    TabTextSpan { text: "qwerqwer".to_string(), bold: false, italic: false, mono: true },
                ],
                second_row: vec![TabTextSpan { text: "zxczxcv".to_string(), bold: false, italic: true, mono: false }],
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
            assert!(!stored.first_row[0].mono && stored.first_row[1].mono, "the mono flag is kept");
            // A label stored before there was a `mono` flag has none: it reads as false.
            let old: TabText = serde_json::from_str(r#"{"firstRow":[{"text":"a","bold":true}],"secondRow":[]}"#).unwrap();
            assert!(!old.first_row[0].mono);
        });
    }

    fn span(text: &str) -> TabTextSpan {
        TabTextSpan { text: text.to_string(), bold: false, italic: false, mono: false }
    }

    #[test]
    fn a_windows_title_is_the_title_the_page_gave_or_the_first_row_of_the_label_joined_with_bullets() {
        let label = TabText { first_row: vec![span("Report"), span("Q3"), span("  "), span("draft")], second_row: vec![span("/reports/q3.md")] };
        assert_eq!(window_title(Some("My Reports"), Some(&label)).as_deref(), Some("My Reports"), "the title wins");
        assert_eq!(window_title(Some("  Padded  "), None).as_deref(), Some("Padded"), "trimmed");
        for none in [None, Some(""), Some("   ")] {
            assert_eq!(window_title(none, Some(&label)).as_deref(), Some("Report • Q3 • draft"), "no title: the first row, empty pieces left out, second row not used");
        }
        assert_eq!(window_title(None, Some(&TabText { first_row: vec![], second_row: vec![span("only a second row")] })), None, "nothing to say");
        assert_eq!(window_title(None, None), None);
        // One plain line.
        assert_eq!(window_title(Some("two\nlines\there"), None).as_deref(), Some("two lines here"));
        assert_eq!(window_title(None, Some(&TabText { first_row: vec![span("a\r\nb")], second_row: vec![] })).as_deref(), Some("a b"));
    }

    #[test]
    fn a_tabs_title_is_stored_replaced_and_cleared_with_its_label() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("app-title").await;
            insert_window(&pool, "win1", "asdf/index.html").await;
            let tab = init_tab(&pool, "win1", "asdf/index.html", "res-a", 1).await;
            let title_of = |pool: SqlitePool| async move {
                fetch_tab_groups(&pool, &["win1".to_string()]).await.unwrap()[0].tabs[0].app_title.clone()
            };
            let label = TabText { first_row: vec![span("x")], second_row: vec![] };

            assert_eq!(title_of(pool.clone()).await, None, "none until the page sends one");
            update_tab_resource_impl(&pool, &tab.tab_guid, &label, Some("  Notes of the day "), None, None).await.unwrap();
            assert_eq!(title_of(pool.clone()).await.as_deref(), Some("Notes of the day"));
            update_tab_resource_impl(&pool, &tab.tab_guid, &label, Some("   "), None, None).await.unwrap();
            assert_eq!(title_of(pool.clone()).await, None, "an empty title is no title");
            update_tab_resource_impl(&pool, &tab.tab_guid, &label, Some("again"), None, None).await.unwrap();
            update_tab_resource_impl(&pool, &tab.tab_guid, &label, None, None, None).await.unwrap();
            assert_eq!(title_of(pool.clone()).await, None, "sending none takes it back: the title is made from the label again");
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
    fn a_web_page_in_a_tab_of_a_system_window_is_a_web_page_and_only_one_tab_follows_the_editor() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("syncs").await;
            insert_window(&pool, "win1", "system:notes").await;
            let home = init_tab(&pool, "win1", "system:notes", "system:notes?v=home", 1).await;
            let notes_page = Page::new(Kind::System, "system:notes");
            // A tab of the Notes window that shows a note's markdown: its page is a web page's, whatever the window is.
            let note_tab = uuid::Uuid::new_v4().to_string();
            let group: String = sqlx::query_scalar("SELECT group_guid FROM tabs WHERE guid = ?1").bind(&home.tab_guid).fetch_one(&pool).await.unwrap();
            sqlx::query("INSERT INTO tabs (guid, group_guid, window_guid, relative_path, app_version, resource_id, resource_type, tab_text, link_page, syncs, created_at) VALUES (?1, ?2, 'win1', 'system:notes', 1, 'Book/001/n.md', NULL, NULL, 'Book/001/n.md', '/Book/001/n.md', 5)")
                .bind(&note_tab)
                .bind(&group)
                .execute(&pool)
                .await
                .unwrap();
            assert_eq!(page_to_show(&pool, &note_tab, &notes_page).await.unwrap(), Page::new(Kind::User, "Book/001/n.md"));
            assert_eq!(page_to_show(&pool, &home.tab_guid, &notes_page).await.unwrap(), notes_page, "the app's own tab shows the app");

            // The tab that follows the editor of a file: found by the file, per window.
            assert_eq!(syncing_tab(&pool, "win1", "/Book/001/n.md").await.unwrap(), Some(note_tab.clone()));
            assert_eq!(syncing_tab(&pool, "win1", "/Book/001/other.md").await.unwrap(), None);
            assert_eq!(syncing_tab(&pool, "win2", "/Book/001/n.md").await.unwrap(), None, "another window has none");
            // A tab that shows the same page but does not follow the editor is not it.
            let plain = uuid::Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO tabs (guid, group_guid, window_guid, relative_path, app_version, resource_id, resource_type, tab_text, link_page, created_at) VALUES (?1, ?2, 'win1', 'system:notes', 1, 'Book/001/n.md', NULL, NULL, 'Book/001/n.md', 6)")
                .bind(&plain)
                .bind(&group)
                .execute(&pool)
                .await
                .unwrap();
            assert_eq!(syncing_tab(&pool, "win1", "/Book/001/n.md").await.unwrap(), Some(note_tab.clone()), "still only the syncing one");
            // Where a window goes back to when the page's tab is left: the tab of the app itself.
            assert_eq!(home_tab(&pool, "win1").await.unwrap(), Some(home.tab_guid));
        });
    }

    #[test]
    fn a_tab_that_shows_a_linked_page_still_moves_to_another_window_of_its_app_and_keeps_showing_it() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("move-linked").await;
            insert_window(&pool, "win1", "docs/a.md").await;
            insert_window(&pool, "win2", "docs/a.md").await;
            let tab = init_tab(&pool, "win1", "docs/a.md", "docs/a.md", 1).await;
            let target_tab = init_tab(&pool, "win2", "docs/a.md", "docs/a.md", 1).await;
            // What opening a link in the tab does: the tab stays the app's, and remembers the page.
            sqlx::query("UPDATE tabs SET resource_id = 'docs/b.md', link_page = 'docs/b.md' WHERE guid = ?1").bind(&tab.tab_guid).execute(&pool).await.unwrap();
            let target_group = group_guid_of_tab(&pool, &target_tab.tab_guid).await;

            move_tab_to_group_impl(&pool, &tab.tab_guid, &target_group).await.unwrap();

            let window_page = Page::new(Kind::User, "docs/a.md");
            assert_eq!(page_to_show(&pool, &tab.tab_guid, &window_page).await.unwrap(), Page::new(Kind::User, "docs/b.md"));
            let in_win2: String = sqlx::query_scalar("SELECT window_guid FROM tabs WHERE guid = ?1").bind(&tab.tab_guid).fetch_one(&pool).await.unwrap();
            assert_eq!(in_win2, "win2");
        });
    }

    #[test]
    fn navigation_carries_what_init_would_answer_for_the_tab() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("navigation").await;
            insert_window(&pool, "win1", "asdf/index.html").await;
            let tab = init_tab(&pool, "win1", "asdf/index.html", "asdf/index.html?doc=7", 1).await;

            let payload = navigation_payload(&pool, &tab.tab_guid).await.unwrap();
            assert_eq!(payload.tab_guid, tab.tab_guid);
            assert_eq!(payload.resource_id, "asdf/index.html?doc=7", "the tab's own stored resource id");
            assert_eq!(payload.code_snippets.len(), crate::code_snippets::code_snippets().len());

            assert!(navigation_payload(&pool, "nope").await.unwrap_err().contains("not found"));
        });
    }

    #[test]
    fn a_window_opens_on_the_tab_it_showed_else_its_first_else_a_new_one() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("opening").await;
            insert_window(&pool, "win1", "asdf/index.html").await;

            // Nothing yet: a placeholder is created, in a new default group.
            let (first, created) = tab_for_opening(&pool, "win1", "asdf/index.html", None).await.unwrap();
            assert!(created);
            // From then on there is a tab to show.
            assert_eq!(tab_for_opening(&pool, "win1", "asdf/index.html", None).await.unwrap(), (first.clone(), false));

            let second = init_tab(&pool, "win1", "asdf/index.html", "res-b", 1).await;
            assert_eq!(
                tab_for_opening(&pool, "win1", "asdf/index.html", Some(&second.tab_guid)).await.unwrap(),
                (second.tab_guid.clone(), false),
                "the tab it showed before"
            );
            assert_eq!(
                tab_for_opening(&pool, "win1", "asdf/index.html", Some("nope")).await.unwrap(),
                (first.clone(), false),
                "a tab that isn't there any more is ignored: the first one"
            );

            // A window whose groups hold no tabs gets a placeholder in its first group — not a new group.
            sqlx::query("DELETE FROM tabs WHERE window_guid = 'win1'").execute(&pool).await.unwrap();
            let (again, created) = tab_for_opening(&pool, "win1", "asdf/index.html", None).await.unwrap();
            assert!(created);
            assert_eq!(fetch_tab_groups(&pool, &["win1".to_string()]).await.unwrap().len(), 1);
            assert_eq!(group_guid_of_tab(&pool, &again).await, fetch_tab_groups(&pool, &["win1".to_string()]).await.unwrap()[0].guid);
        });
    }

    #[test]
    fn an_init_request_binds_to_a_tab_and_never_creates_one() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("init-binds").await;
            insert_window(&pool, "win1", "asdf/index.html").await;
            insert_window(&pool, "win2", "asdf/index.html").await;
            let a = init_tab(&pool, "win1", "asdf/index.html", "res-a", 1).await.tab_guid;
            let b = init_tab(&pool, "win1", "asdf/index.html", "res-b", 1).await.tab_guid;
            let c = init_tab(&pool, "win2", "asdf/index.html", "res-c", 1).await.tab_guid;
            let count = || async { sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM tabs").fetch_one(&pool).await.unwrap() };
            assert_eq!(count().await, 3);

            let init = |pending: Option<(&str, bool)>, current: Option<&str>| {
                let pool = pool.clone();
                let (pending, current) = (pending.map(|(t, f)| (t.to_string(), f)), current.map(str::to_string));
                async move { tab_for_init(&pool, "win1", "asdf/index.html", pending, current).await.unwrap() }
            };
            assert_eq!(init(Some((&a, false)), Some(&b)).await, (a.clone(), false), "what was made ready for the page wins");
            assert_eq!(init(Some((&c, false)), Some(&b)).await, (b.clone(), true), "another window's tab is ignored: this is a reload of b");
            assert_eq!(init(None, Some(&b)).await, (b.clone(), true), "a reload rebinds to the current tab, echoing its stored resource id");
            assert_eq!(init(None, None).await, (a.clone(), true), "no idea which: the window's first tab");
            assert_eq!(count().await, 3, "none of that created a tab");

            // A window with no tabs at all gets a placeholder to fill in.
            sqlx::query("DELETE FROM tabs WHERE window_guid = 'win1'").execute(&pool).await.unwrap();
            let (fresh, force_stored) = init(None, Some(&b)).await;
            assert!(!force_stored && fresh != a && fresh != b);
            assert_eq!(count().await, 2);
        });
    }

    #[test]
    fn a_page_adds_a_tab_in_the_group_of_the_tab_it_shows() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("add-tab").await;
            insert_window(&pool, "win1", "asdf/index.html").await;
            let a = init_tab(&pool, "win1", "asdf/index.html", "res-a", 1).await.tab_guid;
            let shown = init_tab(&pool, "win1", "asdf/index.html", "res-b", 1).await.tab_guid;
            sqlx::query("INSERT INTO tab_groups (guid, window_guid, created_at, name) VALUES ('g2', 'win1', ?1, 'Second')")
                .bind(current_millis() + 1000)
                .execute(&pool)
                .await
                .unwrap();
            move_tab_to_group_impl(&pool, &shown, "g2").await.unwrap();

            let (added, _) =
                add_tab_impl(&pool, "win1", "asdf/index.html", "asdf/index.html?doc=9", Some("document"), 1, Some(&shown)).await.unwrap();
            assert_eq!(added.resource_id, "asdf/index.html?doc=9");
            assert_ne!(added.tab_guid, a);
            assert_eq!(group_guid_of_tab(&pool, &added.tab_guid).await, "g2", "next to the tab the window is showing");

            let (elsewhere, _) = add_tab_impl(&pool, "win1", "asdf/index.html", "res-e", None, 1, None).await.unwrap();
            assert_eq!(fetch_tab_groups(&pool, &["win1".to_string()]).await.unwrap().iter().flat_map(|g| g.tabs.iter()).count(), 4);
            assert!(tab_in_window(&pool, &elsewhere.tab_guid, "win1").await.unwrap());
        });
    }

    #[test]
    fn deleting_a_tab_group_takes_its_tabs_and_all_their_tags_but_nothing_else() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("delete-group").await;
            insert_window(&pool, "win1", "asdf/index.html").await;

            let staying = init_tab(&pool, "win1", "asdf/index.html", "res-a", 1).await;
            let going = init_tab(&pool, "win1", "asdf/index.html", "res-b", 1).await;
            let other = init_tab(&pool, "win1", "asdf/index.html", "res-c", 1).await;
            sqlx::query("INSERT INTO tab_groups (guid, window_guid, created_at, name) VALUES ('g2', 'win1', ?1, 'Second')")
                .bind(current_millis())
                .execute(&pool)
                .await
                .unwrap();
            move_tab_to_group_impl(&pool, &going.tab_guid, "g2").await.unwrap();
            move_tab_to_group_impl(&pool, &other.tab_guid, "g2").await.unwrap();
            for guid in [staying.tab_guid.as_str(), going.tab_guid.as_str(), other.tab_guid.as_str(), "g2"] {
                add_tag_impl(&pool, guid, "t", "#fff", "#000").await.unwrap();
            }

            let (window, tabs) = delete_tab_group_impl(&pool, "g2").await.unwrap();
            assert_eq!(window, "win1");
            assert_eq!(tabs.len(), 2);

            let groups = fetch_tab_groups(&pool, &["win1".to_string()]).await.unwrap();
            assert_eq!(groups.len(), 1, "only the other group is left");
            assert_eq!(groups[0].tabs.len(), 1);
            assert_eq!(groups[0].tabs[0].guid, staying.tab_guid);
            assert_eq!(groups[0].tabs[0].tags.len(), 1, "the tab that stayed keeps its tag");
            let gone = ["g2".to_string(), going.tab_guid.clone(), other.tab_guid.clone()];
            assert!(fetch_tags(&pool, &gone).await.unwrap().is_empty(), "the tags of the group and its tabs went too");

            assert!(delete_tab_group_impl(&pool, "g2").await.unwrap_err().contains("not found"));
        });
    }

    #[test]
    fn closing_a_tab_deletes_it_and_its_tags_but_not_its_siblings() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("close-tab").await;
            insert_window(&pool, "win1", "asdf/index.html").await;

            let first = init_tab(&pool, "win1", "asdf/index.html", "res-a", 1).await;
            let second = init_tab(&pool, "win1", "asdf/index.html", "res-b", 1).await;
            add_tag_impl(&pool, &first.tab_guid, "mine", "#fff", "#000").await.unwrap();
            add_tag_impl(&pool, &second.tab_guid, "theirs", "#fff", "#000").await.unwrap();

            let window = close_tab_impl(&pool, &first.tab_guid).await.unwrap();
            assert_eq!(window, "win1");

            let groups = fetch_tab_groups(&pool, &["win1".to_string()]).await.unwrap();
            let tabs: Vec<&TabRecord> = groups.iter().flat_map(|g| g.tabs.iter()).collect();
            assert_eq!(tabs.len(), 1);
            assert_eq!(tabs[0].guid, second.tab_guid);
            assert_eq!(tabs[0].tags.len(), 1, "the sibling keeps its tag");
            assert!(fetch_tags(&pool, &[first.tab_guid.clone()]).await.unwrap().is_empty(), "the closed tab's tags go with it");

            let err = close_tab_impl(&pool, &first.tab_guid).await.unwrap_err();
            assert!(err.contains("not found"));
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

    #[test]
    fn user_apps_and_system_apps_keep_separate_sets_of_windows() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("kinds").await;
            let user = Page::new(Kind::User, "asdf/index.html");
            let notes = Page::new(Kind::System, "system:notes");
            let (user_guid, _) = insert_entry(&pool, &user).await.unwrap();
            let (notes_guid, _) = insert_entry(&pool, &notes).await.unwrap();
            let (notes_guid2, _) = insert_entry(&pool, &notes).await.unwrap();

            let guids = |rows: Vec<(String, String, i64)>| rows.into_iter().map(|(g, _, _)| g).collect::<std::collections::HashSet<_>>();
            assert_eq!(guids(fetch_rows(&pool, Some("user"), None).await.unwrap()), [user_guid.clone()].into());
            assert_eq!(guids(fetch_rows(&pool, Some("system"), None).await.unwrap()), [notes_guid.clone(), notes_guid2.clone()].into());
            assert_eq!(fetch_rows(&pool, None, None).await.unwrap().len(), 3, "no kind: both");
            assert_eq!(fetch_rows(&pool, Some("system"), Some("system:notes")).await.unwrap().len(), 2);
            assert!(fetch_rows(&pool, Some("user"), Some("system:notes")).await.unwrap().is_empty(), "the same path under the other kind is nothing");

            assert_eq!(page_of(&pool, &user_guid).await.unwrap(), user);
            assert_eq!(page_of(&pool, &notes_guid).await.unwrap(), notes);
            assert!(page_of(&pool, "nope").await.is_err());

            // Tabs, tags and saved state key off the relative path, which differs for the two.
            ensure_default_tab_group(&pool, &notes_guid, "system:notes").await.unwrap();
            let tab = init_tab(&pool, &notes_guid, "system:notes", "system:notes?root=1", 1).await;
            assert_eq!(tab.resource_id, "system:notes?root=1");
            assert_eq!(crate::app_state::caller_app_id_for_test(&pool, &notes_guid).await, "system:notes");
        });
    }

    #[test]
    fn a_database_from_before_system_apps_gets_the_kind_column_and_keeps_its_windows() {
        tauri::async_runtime::block_on(async {
            let dir = std::env::temp_dir().join(format!("csdrive-secondary-windows-test-migrate-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let old = SqlitePool::connect_with(SqliteConnectOptions::new().filename(dir.join("data.db")).create_if_missing(true)).await.unwrap();
            sqlx::query("CREATE TABLE secondary_windows (guid TEXT PRIMARY KEY, relative_path TEXT NOT NULL, created_at INTEGER NOT NULL)").execute(&old).await.unwrap();
            sqlx::query("INSERT INTO secondary_windows VALUES ('old-window', 'qwer/index1.html', 1)").execute(&old).await.unwrap();
            old.close().await;

            let pool = init_db(&dir).await.unwrap();
            assert_eq!(page_of(&pool, "old-window").await.unwrap(), Page::new(Kind::User, "qwer/index1.html"), "an old window is a user app");
            init_db(&dir).await.unwrap(); // running it again changes nothing
        });
    }

    #[test]
    fn system_app_pages_are_recognised_from_the_url_a_tab_registers_with() {
        // A system app's page is a page of the app's own frontend; it is known as `system:notes`.
        for base in ["tauri://localhost", "http://tauri.localhost"] {
            let (path, resource_id) = split_url_into_path_and_resource_id(&format!("{base}/system/notes/index.html?root=user&path=docs")).unwrap();
            assert_eq!(path, "system:notes");
            assert_eq!(resource_id, "system:notes?root=user&path=docs");
            let (_, plain) = split_url_into_path_and_resource_id(&format!("{base}/system/notes/index.html")).unwrap();
            assert_eq!(plain, "system:notes");
        }
        // A user app's file at the same path is still a user app.
        let (path, _) = split_url_into_path_and_resource_id("csuser://localhost/system/notes/index.html").unwrap();
        assert_eq!(path, "system/notes/index.html");
        let (path, _) = split_url_into_path_and_resource_id("http://csuser.localhost/system/notes/index.html").unwrap();
        assert_eq!(path, "system/notes/index.html");
    }
}
