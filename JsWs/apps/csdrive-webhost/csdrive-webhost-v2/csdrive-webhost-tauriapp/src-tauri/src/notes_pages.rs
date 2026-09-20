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

use std::path::Path;

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
pub async fn serve(app: &AppHandle, special: Special, csp: &str) -> Response<Vec<u8>> {
    let forbidden = || crate::respond_text(StatusCode::FORBIDDEN, "Forbidden", csp);
    match special {
        Special::Device { root, path } => {
            let scope = app.state::<FsScope>();
            match scope.check_in(&root, &path, true) {
                Ok(real) if real.is_file() => match std::fs::read(&real) {
                    Ok(data) => crate::respond_bytes(Path::new(&path), data, csp),
                    Err(_) => crate::respond_text(StatusCode::NOT_FOUND, "File not found", csp),
                },
                Ok(_) => crate::respond_text(StatusCode::NOT_FOUND, "File not found", csp),
                Err(_) => forbidden(),
            }
        }
        Special::Filen { user_id, branch, path } => {
            let cache = app.state::<Cache>();
            let fetched = async {
                let remote = crate::filen_cache::prepare(app, &cache, user_id).await?;
                let local = cache.cached_file(&remote, user_id as i64, branch, &path).await?;
                std::fs::read(local).map_err(|e| e.to_string())
            }
            .await;
            match fetched {
                Ok(data) => crate::respond_bytes(Path::new(&path), data, csp),
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
    window: tauri::WebviewWindow,
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

/// Lets a page that was opened from Notes open another file next to itself: `path` is relative to the page's
/// own (in the same folder, picked folder or drive), and the new page is listed under the same Notes tab —
/// as a sibling of the page that asked. Resolves to the new window's guid.
#[tauri::command]
pub async fn open_related_web_app(
    window: tauri::WebviewWindow,
    app: AppHandle,
    windows: State<'_, SecondaryWindowsState>,
    path: String,
) -> Result<String, String> {
    let window_guid = crate::window_host::caller_guid(&window).ok_or("Only web apps can do that.")?;
    let (own_path, origin, parent) = crate::secondary_windows::origin_row(windows.pool(), &window_guid).await?;
    if origin.opened_by.as_deref() != Some("NotesApp") {
        return Err("Only a page that was opened from Notes can open others next to it.".to_string());
    }
    let parent = parent.ok_or("This page isn't listed under a Notes tab.")?;
    let own = origin.path.clone().unwrap_or(own_path);
    let target = join_relative(&own, &path)?;
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
