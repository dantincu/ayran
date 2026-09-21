//! Files opened from the Notes app as web apps — html and markdown pages that live in a folder the person
//! picked, in the user folder, or in a Filen account. See `CLAUDE.md`, "Web apps opened from Notes".
//!
//! - **Serving.** The web apps' protocol (`csuser://`) serves the user folder as it always did; two more
//!   address spaces sit beside it, so that a page's *relative* references (a stylesheet, an image, a link to
//!   another page) resolve against its own address and are answered from the same place:
//!   `/@device/<root id>/<path>` (a picked folder, through the file scope — the path is judged like any
//!   other) and `/@filen/<user id>/<branch index or ->/<path in the drive>` (through the Filen cache: fetched
//!   if it isn't there or has expired, then served from the cache). Nothing in them is a real path.
//! - **Opening.** `open_file_as_web_app` (Notes and the admin-app only) makes the file a window entry of its
//!   own, remembers where it came from (`Origin`, told to the page in its init response), and lists it as a
//!   **child of the Notes tab that opened it**; `open_related_web_app` lets such a page open another file next
//!   to itself (a path relative to its own), and that one is listed under the same Notes tab — a sibling.
//! - **Children.** A window opened this way belongs to that tab: it is not listed among the apps, suspends
//!   when the Notes window does, and goes when the tab, its group or the window does.


use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use tauri::http::{Response, StatusCode};
use tauri::{AppHandle, Manager, State};

use crate::files_cache::{norm_path, Cache};
use crate::fs_scope::FsScope;
use crate::secondary_windows::{fetch_tags, FilenOrigin, Origin, SecondaryWindowsState, TabText, TagRecord};

/// Whether a file can be opened as a web app: a page, or a markdown document.
pub fn is_page_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".html", ".htm", ".md", ".markdown"].iter().any(|ext| lower.ends_with(ext))
}

// ── Serving ───────────────────────────────────────────────────────────────────

/// Where a request for a page or one of its resources is answered from.
#[derive(Debug, PartialEq)]
pub enum Special {
    /// A picked folder: its root id and a path inside it.
    Device { root: String, path: String },
    /// A Filen account, in a branch (its index) or the account itself, and a path in the drive.
    Filen { user_id: u64, branch: Option<i64>, path: String },
}

/// Reads a (percent-decoded) request path. `None`: an ordinary path of the user folder. `Some(Err)`: an
/// address in the reserved `/@…` space that names nothing valid.
pub fn parse_special(path: &str) -> Option<Result<Special, ()>> {
    let rest = path.strip_prefix('/')?.strip_prefix('@')?;
    let mut parts = rest.splitn(2, '/');
    let (kind, tail) = (parts.next()?, parts.next().unwrap_or(""));
    Some(match kind {
        "device" => match tail.split_once('/') {
            Some((root, path)) if !root.is_empty() && !path.is_empty() => Ok(Special::Device { root: root.to_string(), path: path.to_string() }),
            _ => Err(()),
        },
        "filen" => {
            let mut fields = tail.splitn(3, '/');
            match (fields.next(), fields.next(), fields.next()) {
                (Some(user), Some(branch), Some(path)) if !path.is_empty() => {
                    let user_id = user.parse::<u64>().map_err(|_| ());
                    let branch = if branch == "-" { Ok(None) } else { branch.parse::<i64>().map(Some).map_err(|_| ()) };
                    match (user_id, branch) {
                        (Ok(user_id), Ok(branch)) => Ok(Special::Filen { user_id, branch, path: format!("/{path}") }),
                        _ => Err(()),
                    }
                }
                _ => Err(()),
            }
        }
        _ => Err(()),
    })
}

/// The answer for a request in the `/@…` space.
pub async fn serve(app: &AppHandle, special: Special, meta: &crate::file_serving::RequestMeta, csp: &str) -> Response<Vec<u8>> {
    let forbidden = || crate::respond_text(StatusCode::FORBIDDEN, "Forbidden", csp);
    match special {
        Special::Device { root, path } => {
            let scope = app.state::<FsScope>();
            match scope.check_in(&root, &path, true) {
                Ok(real) if real.is_file() => crate::file_serving::respond_file(&real, meta, csp),
                Ok(_) => crate::respond_text(StatusCode::NOT_FOUND, "File not found", csp),
                Err(_) => forbidden(),
            }
        }
        Special::Filen { user_id, branch, path } => {
            let cache = app.state::<Cache>();
            let fetched = async {
                let remote = crate::filen_cache::prepare(app, &cache, user_id).await?;
                cache.cached_file(&remote, user_id as i64, branch, &path).await
            }
            .await;
            match fetched {
                // In the cache on disk by now (a big file is fetched there piece by piece): served from there, in pieces if asked.
                Ok(local) => crate::file_serving::respond_file(&local, meta, csp),
                Err(_) => crate::respond_text(StatusCode::NOT_FOUND, "File not found", csp),
            }
        }
    }
}

// ── Opening ───────────────────────────────────────────────────────────────────

/// A file, named the way Notes names it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    /// `UserFolder`, `DeviceFolder` or `FilenCloud`.
    pub storage: String,
    /// `DeviceFolder`: the picked folder's root id.
    pub root: Option<String>,
    /// `FilenCloud`: the account, and the branch (its index) if the file is opened in one.
    pub user_id: Option<u64>,
    pub branch: Option<i64>,
    /// Relative to the root (user folder, picked folder) or a path in the drive (Filen).
    pub path: String,
}

/// `base`'s folder joined with `relative` (a path a page wrote — it may have `.`, `..`, a query or a fragment),
/// as a path without a leading slash; an error if it climbs out of the root.
pub fn join_relative(base: &str, relative: &str) -> Result<String, String> {
    let relative = relative.split(['?', '#']).next().unwrap_or("");
    let mut parts: Vec<&str> = base.split('/').filter(|p| !p.is_empty()).collect();
    parts.pop(); // the file's own name: what is joined is relative to its folder
    for segment in relative.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop().ok_or("That path leaves the folder the page was opened from.")?;
            }
            s => parts.push(s),
        }
    }
    if relative.trim_matches('/').is_empty() || parts.is_empty() {
        return Err("That path names no file.".to_string());
    }
    Ok(parts.join("/"))
}

/// The window entry's path, and how it was opened, for `file`.
async fn resolve(app: &AppHandle, file: &FileRef) -> Result<(String, Origin), String> {
    if !is_page_file(&file.path) {
        return Err("Only .html, .htm and markdown (.md) files can be opened as web apps.".to_string());
    }
    let notes = Some("NotesApp".to_string());
    match file.storage.as_str() {
        "UserFolder" => {
            let path = file.path.trim_start_matches('/').to_string();
            crate::secondary_windows::validate_relative_html_path(app, &path)?;
            Ok((path, Origin { opened_by: notes, storage: Some("UserFolder".into()), ..Default::default() }))
        }
        "DeviceFolder" => {
            let root = file.root.clone().ok_or("A folder on the device needs its root.")?;
            let path = file.path.trim_start_matches('/').to_string();
            if !app.state::<FsScope>().check_in(&root, &path, true)?.is_file() {
                return Err(format!("\"{path}\" isn't a file."));
            }
            Ok((
                format!("@device/{root}/{path}"),
                Origin { opened_by: notes, storage: Some("DeviceFolder".into()), path: Some(path), root: Some(root), filen: None },
            ))
        }
        "FilenCloud" => {
            let user_id = file.user_id.ok_or("A Filen file needs its account.")?;
            let path = norm_path(&file.path)?;
            let email = crate::filen::email_of(app, user_id).await?;
            let cache = app.state::<Cache>();
            let branch_name = match file.branch {
                Some(index) => Some(
                    cache.branches(user_id as i64).await?.into_iter().find(|b| b.index == index).ok_or("That branch doesn't exist.")?.name,
                ),
                None => None,
            };
            let branch_part = file.branch.map_or_else(|| "-".to_string(), |b| b.to_string());
            Ok((
                format!("@filen/{user_id}/{branch_part}/{}", path.trim_start_matches('/')),
                Origin {
                    opened_by: notes,
                    storage: Some("FilenCloud".into()),
                    path: Some(path),
                    root: None,
                    filen: Some(FilenOrigin { account_id: user_id as i64, email, branch: branch_name, branch_index: file.branch }),
                },
            ))
        }
        other => Err(format!("Unknown storage: \"{other}\".")),
    }
}

/// Opens `file` as a web app, listed under the Notes tab that asked. Only Notes (or the admin-app) may.
/// Resolves to the new window's guid.
#[tauri::command]
pub async fn open_file_as_web_app(
    window: crate::window_host::CallerWindow,
    app: AppHandle,
    windows: State<'_, SecondaryWindowsState>,
    file: FileRef,
) -> Result<String, String> {
    if !crate::window_host::is_system_page(&window) {
        return Err("Only the Notes app can open its files as web apps.".to_string());
    }
    let window_guid = crate::window_host::caller_guid(&window).ok_or("The admin-app has no tab to list the page under.")?;
    let parent = windows.current_tab_of(&window_guid).ok_or("This window hasn't registered a tab yet.")?;
    let (relative_path, origin) = resolve(&app, &file).await?;
    crate::secondary_windows::open_child_window(&app, relative_path, origin, parent).await
}

/// Lets a web page open another page next to itself, **in a window of its own**: `path` is relative to the page's own (in
/// the same folder, picked folder or drive; a leading `/` makes it relative to the root of that storage).
/// - A page that was opened from Notes: the new page is listed under the same Notes tab — as a sibling of the page that asked.
/// - Any other web page (of the user folder): the new page is a window of the apps list, like one opened from the admin-app.
///
/// The page it asks *from* is the one its window is showing now (a link may have taken it to another file than the one the
/// window was made for). Resolves to the new window's guid.
#[tauri::command]
pub async fn open_related_web_app(
    window: crate::window_host::CallerWindow,
    app: AppHandle,
    windows: State<'_, SecondaryWindowsState>,
    path: String,
) -> Result<String, String> {
    let window_guid = crate::window_host::caller_guid(&window).ok_or("Only web apps can do that.")?;
    let (own_path, origin, parent) = crate::secondary_windows::origin_row(windows.pool(), &window_guid).await?;
    // The file the window shows now, relative to its storage's root — else the one it was made for.
    let now = crate::window_host::current_page_url(&app, &window_guid).and_then(|url| file_of(&url));
    if origin.opened_by.as_deref() != Some("NotesApp") {
        // An ordinary web page of the user folder.
        let own = now.unwrap_or(own_path);
        let target = if path.starts_with('/') { join_relative("/", &path)? } else { join_relative(&own, &path)? };
        return crate::secondary_windows::open_page_window(&app, target).await;
    }
    let parent = parent.ok_or("This page isn't listed under a Notes tab.")?;
    let own = now.or(origin.path.clone()).unwrap_or(own_path);
    let target = if path.starts_with('/') { join_relative("/", &path)? } else { join_relative(&own, &path)? };
    let file = match origin.storage.as_deref() {
        Some("DeviceFolder") => FileRef { storage: "DeviceFolder".into(), root: origin.root.clone(), user_id: None, branch: None, path: target },
        Some("FilenCloud") => {
            let filen = origin.filen.as_ref().ok_or("The page's account isn't known.")?;
            FileRef { storage: "FilenCloud".into(), root: None, user_id: Some(filen.account_id as u64), branch: filen.branch_index, path: target }
        }
        _ => FileRef { storage: "UserFolder".into(), root: None, user_id: None, branch: None, path: target },
    };
    let (relative_path, new_origin) = resolve(&app, &file).await?;
    crate::secondary_windows::open_child_window(&app, relative_path, new_origin, parent).await
}

/// The file a page's address names, relative to its storage's root (the user folder, a picked folder, a Filen drive), without
/// a leading slash.
fn file_of(url: &tauri::Url) -> Option<String> {
    let path = percent_encoding::percent_decode_str(url.path()).decode_utf8_lossy().to_string();
    match parse_special(&path) {
        None => Some(path.trim_start_matches('/').to_string()),
        Some(Ok(Special::Device { path, .. })) | Some(Ok(Special::Filen { path, .. })) => Some(path.trim_start_matches('/').to_string()),
        Some(Err(())) => None,
    }
}

/// The path (with a leading slash) at which the page `file` is served — what a window showing it has as its address.
fn served_path_of(file: &FileRef) -> Result<String, String> {
    let path = file.path.trim_start_matches('/');
    match file.storage.as_str() {
        "UserFolder" => Ok(format!("/{path}")),
        "DeviceFolder" => Ok(format!("/@device/{}/{path}", file.root.as_deref().ok_or("A folder on the device needs its root.")?)),
        "FilenCloud" => {
            let user_id = file.user_id.ok_or("A Filen file needs its account.")?;
            Ok(format!("/@filen/{user_id}/{}/{path}", file.branch.map_or_else(|| "-".to_string(), |b| b.to_string())))
        }
        other => Err(format!("Unknown storage: \"{other}\".")),
    }
}

/// The address at which a system app's page can load `file` as a picture or as media (`<img>`, `<video>`, `<audio>`): on the
/// web apps' origin, where the file is served — a piece at a time when a player asks (see `file_serving`). Nothing in it is a
/// real path.
#[tauri::command]
pub fn media_url(window: crate::window_host::CallerWindow, file: FileRef) -> Result<String, String> {
    crate::window_host::require_trusted(&window)?;
    let served = served_path_of(&file)?;
    let mut url = tauri::Url::parse(&format!("{}://localhost/", crate::USER_PROTOCOL)).map_err(|e| e.to_string())?;
    // Segment by segment, so a `#` or a `?` in a file's name is part of the name.
    url.path_segments_mut().map_err(|_| "That file can't be addressed.".to_string())?.pop_if_empty().extend(served.split('/').filter(|s| !s.is_empty()));
    Ok(crate::window_host::navigation_url(&url).to_string())
}

// ── A note (or any page file) as a tab of the Notes window ───────────────────────

/// What a page's tab is called in the database and the window manager: the page's path as a URL has it (percent-encoded, no
/// leading slash), like every resource id.
fn link_page_of(relative_path: &str) -> Result<String, String> {
    let url = crate::window_host::user_page_url(relative_path)?;
    Ok(url.path().trim_start_matches('/').to_string())
}

/// The key that says which file a syncing tab follows: the path it is served at.
fn sync_key_of(relative_path: &str) -> String {
    format!("/{}", relative_path.trim_start_matches('/'))
}

/// What Notes knows of the tab that follows a file's editor.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncingTab {
    pub tab_guid: String,
    /// The window shows it now.
    pub showing: bool,
}

/// Opens `file` (a page — html or markdown, a note's markdown) as a web page **in a tab of the calling Notes window** and shows it:
/// - `sync`: the tab that **follows the editor** — it reloads when the file is saved. There is one per file and window: the
///   first call makes it, a later call brings it back. (Only a window that shows it and isn't the editor's own window can be
///   reloaded behind the editor's back — the person moves the tab to another window of the app, or asks for `new_window`.)
/// - not `sync`: a tab of its own that never reloads by itself; every call makes another.
/// - `new_window`: a window of the Notes app of its own whose only tab is the page (syncing, if `sync`) — what the editor uses,
///   so that the editor stays where it is.
/// Resolves to the tab's guid (the window's, for `new_window`). Notes only.
#[tauri::command]
pub async fn open_note_tab(
    window: crate::window_host::CallerWindow,
    app: AppHandle,
    windows: State<'_, SecondaryWindowsState>,
    file: FileRef,
    sync: bool,
    new_window: bool,
) -> Result<String, String> {
    crate::window_host::require_trusted(&window)?;
    let window_guid = crate::window_host::caller_guid(&window).ok_or("Only the Notes app can open a note in a tab.")?;
    let (relative_path, _) = resolve(&app, &file).await?;
    let link = link_page_of(&relative_path)?;
    let key = sync_key_of(&relative_path);
    let syncs = sync.then_some(key.as_str());

    if new_window {
        return crate::secondary_windows::open_notes_window_with_page(&app, &link, syncs).await;
    }
    let tab = match (sync, crate::secondary_windows::syncing_tab(windows.pool(), &window_guid, &key).await?) {
        (true, Some(existing)) => existing,
        _ => crate::secondary_windows::add_page_tab(&app, &window_guid, &link, syncs).await?,
    };
    crate::secondary_windows::activate_tab(app.clone(), app.state::<SecondaryWindowsState>(), tab.clone()).await?;
    Ok(tab)
}

/// The tab of the calling window that follows `file`'s editor, if there is one.
#[tauri::command]
pub async fn note_tab_state(
    window: crate::window_host::CallerWindow,
    app: AppHandle,
    windows: State<'_, SecondaryWindowsState>,
    file: FileRef,
) -> Result<Option<SyncingTab>, String> {
    crate::window_host::require_trusted(&window)?;
    let window_guid = crate::window_host::caller_guid(&window).ok_or("Only the Notes app can ask.")?;
    let key = sync_key_of(&served_path_of(&file)?);
    let _ = &app;
    Ok(crate::secondary_windows::syncing_tab(windows.pool(), &window_guid, &key)
        .await?
        .map(|tab| SyncingTab { showing: crate::secondary_windows::window_shows(&windows, &window_guid, &tab), tab_guid: tab }))
}

/// What to do with the tab that follows `file`'s editor (`show`, `suspend`, `close`): *show* brings it to the front; *suspend* leaves
/// it — the window goes back to a tab of the app itself, the syncing tab stays listed and is shown again by *show* or by
/// opening the note; *close* removes it (leaving it first when the window shows it). Notes only.
#[tauri::command]
pub async fn note_tab_action(
    window: crate::window_host::CallerWindow,
    app: AppHandle,
    windows: State<'_, SecondaryWindowsState>,
    file: FileRef,
    action: String,
) -> Result<(), String> {
    crate::window_host::require_trusted(&window)?;
    let window_guid = crate::window_host::caller_guid(&window).ok_or("Only the Notes app can do that.")?;
    let key = sync_key_of(&served_path_of(&file)?);
    let tab = crate::secondary_windows::syncing_tab(windows.pool(), &window_guid, &key).await?.ok_or("This note has no tab that follows its editor.")?;
    let showing = crate::secondary_windows::window_shows(&windows, &window_guid, &tab);
    match action.as_str() {
        "show" => crate::secondary_windows::activate_tab(app.clone(), app.state::<SecondaryWindowsState>(), tab).await,
        "suspend" | "close" => {
            if showing {
                let home = crate::secondary_windows::home_tab(windows.pool(), &window_guid).await?.ok_or("There is no tab of the app to go back to.")?;
                crate::secondary_windows::activate_tab(app.clone(), app.state::<SecondaryWindowsState>(), home).await?;
            }
            if action == "close" {
                crate::secondary_windows::close_tab(app.clone(), app.state::<SecondaryWindowsState>(), tab).await?;
            }
            Ok(())
        }
        other => Err(format!("Unknown action: \"{other}\".")),
    }
}

/// A file that web apps may be showing was **saved** (by the admin-app's or Notes' editor): the tab that **follows its editor**
/// (`open_note_tab` with `sync`) reloads — only that one; any other window or tab that shows the same page is left as it is —
/// when a window shows it. Resolves to how many windows were reloaded. Admin-app and system apps only.
#[tauri::command]
pub async fn notify_file_saved(
    window: crate::window_host::CallerWindow,
    app: AppHandle,
    windows: State<'_, SecondaryWindowsState>,
    file: FileRef,
) -> Result<usize, String> {
    crate::window_host::require_trusted(&window)?;
    let _ = &windows;
    let guids = crate::secondary_windows::syncing_windows(&app, &sync_key_of(&served_path_of(&file)?)).await?;
    for guid in &guids {
        crate::window_host::reload(&app, guid);
    }
    Ok(guids.len())
}

// ── What the window manager shows ─────────────────────────────────────────────

/// A page opened from a Notes tab, as listed under that tab.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedAppRecord {
    /// The window entry's guid.
    pub guid: String,
    pub kind: String,
    pub relative_path: String,
    /// The file's path in its storage, for showing.
    pub path: String,
    /// `UserFolder`, `DeviceFolder` or `FilenCloud`.
    pub storage: String,
    pub created_at: i64,
    pub is_open: bool,
    /// The page's own label (its first tab's), when it has given one.
    pub tab_text: Option<TabText>,
    pub tags: Vec<TagRecord>,
}

/// The pages opened from these tabs, oldest first.
pub async fn fetch_for_tabs(pool: &SqlitePool, tab_guids: &[String]) -> Result<Vec<(String, OpenedAppRecord)>, sqlx::Error> {
    if tab_guids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = (1..=tab_guids.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
    let query = format!(
        "SELECT guid, kind, relative_path, origin, created_at, parent_tab FROM secondary_windows
         WHERE parent_tab IN ({placeholders}) ORDER BY created_at ASC, rowid ASC"
    );
    let mut q = sqlx::query(&query);
    for guid in tab_guids {
        q = q.bind(guid);
    }
    let rows = q.fetch_all(pool).await?;
    let guids: Vec<String> = rows.iter().map(|r| r.get::<String, _>("guid")).collect();
    let tags = fetch_tags(pool, &guids).await?;
    let mut out = Vec::new();
    for row in rows {
        let guid: String = row.get("guid");
        let relative_path: String = row.get("relative_path");
        let origin: Origin = row.get::<Option<String>, _>("origin").and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default();
        let tab_text: Option<String> = sqlx::query_scalar("SELECT tab_text FROM tabs WHERE window_guid = ?1 ORDER BY created_at ASC, rowid ASC LIMIT 1")
            .bind(&guid)
            .fetch_optional(pool)
            .await?
            .flatten();
        out.push((
            row.get::<String, _>("parent_tab"),
            OpenedAppRecord {
                tags: tags.iter().filter(|t| t.guid == guid).cloned().collect(),
                guid,
                kind: row.get("kind"),
                path: origin.path.clone().unwrap_or_else(|| relative_path.clone()),
                relative_path,
                storage: origin.storage.unwrap_or_else(|| "UserFolder".to_string()),
                created_at: row.get("created_at"),
                is_open: false,
                tab_text: tab_text.and_then(|json| serde_json::from_str(&json).ok()),
            },
        ));
    }
    Ok(out)
}

// ── Children: a window opened from a tab goes with that tab ───────────────────

/// What has to be closed after rows were deleted: windows, and the external web sites' windows.
#[derive(Default)]
pub struct Closing {
    pub windows: Vec<String>,
    pub external: Vec<String>,
}

impl Closing {
    pub fn merge(&mut self, other: Closing) {
        self.windows.extend(other.windows);
        self.external.extend(other.external);
    }

    /// Asks the windows to close (their entries are already gone).
    pub fn close(&self, app: &AppHandle) {
        for guid in &self.windows {
            crate::window_host::request_close(app, guid);
        }
        crate::external_sites::close_windows(app, &self.external);
    }
}

/// The windows opened from these tabs (not their own children).
pub async fn children_of_tabs(pool: &SqlitePool, tab_guids: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for tab in tab_guids {
        let found: Vec<String> = sqlx::query_scalar("SELECT guid FROM secondary_windows WHERE parent_tab = ?1").bind(tab).fetch_all(pool).await.unwrap_or_default();
        out.extend(found);
    }
    out
}

/// The windows opened from the tabs of `window_guid`.
pub async fn children_of_window(pool: &SqlitePool, window_guid: &str) -> Vec<String> {
    let tabs: Vec<String> = sqlx::query_scalar("SELECT guid FROM tabs WHERE window_guid = ?1").bind(window_guid).fetch_all(pool).await.unwrap_or_default();
    children_of_tabs(pool, &tabs).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_a_page_shows_is_told_from_its_address_in_any_storage() {
        let url = |u: &str| tauri::Url::parse(u).unwrap();
        assert_eq!(file_of(&url("http://csuser.localhost/qwer/index%201.html?x=1")).as_deref(), Some("qwer/index 1.html"));
        assert_eq!(file_of(&url("http://csuser.localhost/@filen/123/-/docs/a.md")).as_deref(), Some("docs/a.md"));
        assert_eq!(file_of(&url("http://csuser.localhost/@device/ab12cd/x/y.md")).as_deref(), Some("x/y.md"));
        assert_eq!(file_of(&url("http://csuser.localhost/@nothing/x.md")), None);
    }

    #[test]
    fn a_path_a_page_gives_is_relative_to_its_folder_or_to_the_root_of_its_storage() {
        assert_eq!(join_relative("docs/a.md", "b.md").unwrap(), "docs/b.md");
        assert_eq!(join_relative("docs/a.md", "../c/d.html?x=1#h").unwrap(), "c/d.html");
        assert_eq!(join_relative("/", "/top/e.md").unwrap(), "top/e.md", "a leading slash: from the root");
        assert!(join_relative("a.md", "../out.md").is_err(), "not out of the root");
        assert!(join_relative("/", "/").is_err(), "nothing to open");
    }

    #[test]
    fn the_reserved_address_space_is_read_strictly() {
        assert_eq!(parse_special("/qwer/index1.html"), None, "an ordinary path is the user folder's");
        assert_eq!(parse_special("/"), None);
        assert_eq!(
            parse_special("/@device/ab12cd/docs/a b.md"),
            Some(Ok(Special::Device { root: "ab12cd".into(), path: "docs/a b.md".into() }))
        );
        assert_eq!(
            parse_special("/@filen/92627162/-/Notes/todo.md"),
            Some(Ok(Special::Filen { user_id: 92627162, branch: None, path: "/Notes/todo.md".into() }))
        );
        assert_eq!(
            parse_special("/@filen/7/3/a.html"),
            Some(Ok(Special::Filen { user_id: 7, branch: Some(3), path: "/a.html".into() }))
        );
        for bad in ["/@device/", "/@device/root", "/@device//x", "/@filen/x/-/a.md", "/@filen/7/y/a.md", "/@filen/7/-", "/@other/x", "/@"] {
            assert_eq!(parse_special(bad), Some(Err(())), "{bad}");
        }
    }

    #[test]
    fn a_relative_path_is_joined_to_the_pages_folder_and_never_climbs_out() {
        assert_eq!(join_relative("docs/a.md", "b.md").unwrap(), "docs/b.md");
        assert_eq!(join_relative("docs/a.md", "./sub/../c.md?x=1#top").unwrap(), "docs/c.md");
        assert_eq!(join_relative("docs/deep/a.md", "../b.md").unwrap(), "docs/b.md");
        assert_eq!(join_relative("a.md", "b.md").unwrap(), "b.md");
        assert_eq!(join_relative("/Notes/todo.md", "x/y.html").unwrap(), "Notes/x/y.html");
        assert!(join_relative("docs/a.md", "../../x.md").is_err());
        assert!(join_relative("a.md", "../x.md").is_err());
        assert!(join_relative("docs/a.md", "").is_err());
    }

    #[test]
    fn pages_are_html_and_markdown_files() {
        for yes in ["a.html", "A.HTM", "notes.md", "x.Markdown"] {
            assert!(is_page_file(yes), "{yes}");
        }
        for no in ["a.txt", "a.js", "md", "a.html.bak"] {
            assert!(!is_page_file(no), "{no}");
        }
    }
}
