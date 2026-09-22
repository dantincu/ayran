//! **The User Action window** (`docs/strategies/note-custom-actions.md`): a web page of the person's own — an `.html` or markdown file of
//! the user folder, a picked folder or a Filen account — that a Notes window launches **in a window of its own**, from a button in the
//! header of every page of Notes and from every text box. The window is *reused*: one per Notes window, opened the first time and then
//! only told what happened, never closed for going out of scope; the person closes it (a button next to the one that launches it).
//!
//! It is an ordinary web app window (`notes_pages::open_child_window`: listed under the Notes tab that launched it, the rights every
//! window has, its own app state and its own identity — nothing of Notes' state or bridge is shared with it), so the app's rules for
//! windows apply to it: **at most ten windows are open at once**, and the person can suspend it, close it or find it in the window
//! manager like any other. What is special is only that this module finds it again — by the entry's `origin.role = UserAction` under the
//! tabs of the Notes window — and talks to it through events, which the page may listen to or ignore:
//!
//! - [`EVENT_LAUNCHED`] `{ resourceId, context, launchedAt }` — the person launched it: `resourceId` names what opened it (the Notes tab's
//!   resource identifier) and `context` says where from: a page's button, or a text box — **which one** (a stable id, distinct for every text box
//!   of Notes, its `data-ua-field` — e.g. `"notes.search.name"`) and of what kind, **never what is in it**: not its label, its selection nor its
//!   length. The bridge for actual text is the app's own clipboard, which the person controls. If the
//!   window was closed, it is opened and **the event waits for the page's `init_window_tab`**; the window comes to the front if it was
//!   open. (A page that missed the event can ask for it: `user_action_context`.)
//! - [`EVENT_SCOPE_LEFT`] `{ resourceId, now }` — the person went elsewhere in Notes: what opened it is out of scope. The window stays
//!   open; the page decides what to do (go to its default state, say).
//!
//! The Notes window is told, with [`EVENT_STATE`] `{ open }`, whether the window is open, so its buttons can show it.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Manager, State};

use crate::notes_pages::FileRef;
use crate::secondary_windows::{Origin, SecondaryWindowsState};

/// The window was launched (to the User Action window).
pub const EVENT_LAUNCHED: &str = "user-action-launched";
/// What opened the window is out of scope (to the User Action window).
pub const EVENT_SCOPE_LEFT: &str = "user-action-scope-left";
/// Whether the window is open (to the Notes window that owns it).
pub const EVENT_STATE: &str = "user-action-state";

/// The `origin.role` that marks a window as a User Action window.
pub const ROLE: &str = "UserAction";

/// What a launch tells the page (at most this many bytes of JSON in `context`).
const MAX_CONTEXT_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    /// The resource identifier of the Notes tab that launched it.
    pub resource_id: String,
    /// Where from: `{ "kind": "button" }` or `{ "kind": "input", "label": …, "selection": …, … }`.
    pub context: serde_json::Value,
    pub launched_at: i64,
}

/// What is being waited for, and what was told last.
#[derive(Default)]
pub struct UserActions {
    /// A launch that waits for the page of a window that was opened for it to ask for its tab (keyed by the Notes window).
    waiting: Mutex<HashMap<String, Launch>>,
    /// The last launch each User Action window was told of (keyed by its own guid).
    last: Mutex<HashMap<String, Launch>>,
}

#[derive(Serialize, Clone, Copy)]
struct OpenState {
    open: bool,
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// The User Action window of the Notes window `owner`: its guid and the path of the page it shows.
async fn existing(pool: &SqlitePool, owner: &str) -> Option<(String, String)> {
    let rows = sqlx::query(
        "SELECT w.guid AS guid, w.relative_path AS path, w.origin AS origin
         FROM secondary_windows w JOIN tabs t ON t.guid = w.parent_tab WHERE t.window_guid = ?1",
    )
    .bind(owner)
    .fetch_all(pool)
    .await
    .ok()?;
    rows.into_iter().find_map(|row| {
        let origin: Origin = row.get::<Option<String>, _>("origin").and_then(|json| serde_json::from_str(&json).ok())?;
        (origin.role.as_deref() == Some(ROLE)).then(|| (row.get("guid"), row.get("path")))
    })
}

/// The Notes window a User Action window belongs to (through the tab it is listed under), if `guid` is one.
async fn owner_of(pool: &SqlitePool, guid: &str) -> Option<String> {
    let row = sqlx::query(
        "SELECT t.window_guid AS owner, w.origin AS origin FROM secondary_windows w JOIN tabs t ON t.guid = w.parent_tab WHERE w.guid = ?1",
    )
    .bind(guid)
    .fetch_optional(pool)
    .await
    .ok()??;
    let origin: Origin = row.get::<Option<String>, _>("origin").and_then(|json| serde_json::from_str(&json).ok())?;
    (origin.role.as_deref() == Some(ROLE)).then(|| row.get("owner"))
}

fn tell_owner(app: &AppHandle, owner: &str, open: bool) {
    crate::window_host::emit_if_open(app, owner, EVENT_STATE, OpenState { open });
}

/// Launches the User Action window of the calling Notes window showing `file`, and tells it what opened it. The window that is showing
/// is brought to the front; one that is closed is opened (and the event waits for its page); one that shows another page than `file`
/// (the person chose another) is replaced.
#[tauri::command]
pub async fn user_action_launch(
    window: crate::window_host::CallerWindow,
    app: AppHandle,
    windows: State<'_, SecondaryWindowsState>,
    actions: State<'_, UserActions>,
    file: FileRef,
    resource_id: String,
    context: serde_json::Value,
) -> Result<(), String> {
    let owner = crate::window_host::caller_guid(&window).ok_or("Only a window of an app can launch the User Action.")?;
    let parent_tab = windows.current_tab_of(&owner).ok_or("This window hasn't registered a tab yet.")?;
    if serde_json::to_string(&context).map(|s| s.len()).unwrap_or(usize::MAX) > MAX_CONTEXT_BYTES {
        return Err("That context is too big to hand to the page.".to_string());
    }
    let (path, mut origin) = crate::notes_pages::resolve_file(&app, &file).await?;
    origin.role = Some(ROLE.to_string());
    let launch = Launch { resource_id, context, launched_at: now() };

    let pool = windows.pool().clone();
    if let Some((child, shown)) = existing(&pool, &owner).await {
        if shown == path {
            // Listed under the tab that launched it now (it is the one that opened it).
            let _ = sqlx::query("UPDATE secondary_windows SET parent_tab = ?1 WHERE guid = ?2").bind(&parent_tab).bind(&child).execute(&pool).await;
            if crate::window_host::is_open(&app, &child) {
                crate::window_host::focus(&app, &child)?;
                actions.last.lock().unwrap().insert(child.clone(), launch.clone());
                crate::window_host::emit_if_open(&app, &child, EVENT_LAUNCHED, launch);
            } else {
                // Suspended: opened again, and told when its page asks for its tab.
                actions.waiting.lock().unwrap().insert(owner.clone(), launch);
                if let Err(e) = crate::secondary_windows::reopen_secondary_window(app.clone(), windows.clone(), child.clone()).await {
                    actions.waiting.lock().unwrap().remove(&owner);
                    return Err(e);
                }
            }
            tell_owner(&app, &owner, true);
            return Ok(());
        }
        // The person chose another page: the old window goes.
        crate::secondary_windows::close_secondary_window(app.clone(), windows.clone(), child).await?;
    }
    actions.waiting.lock().unwrap().insert(owner.clone(), launch);
    if let Err(e) = crate::secondary_windows::open_child_window(&app, path, origin, parent_tab).await {
        actions.waiting.lock().unwrap().remove(&owner);
        return Err(e);
    }
    tell_owner(&app, &owner, true);
    Ok(())
}

/// Closes the User Action window of the calling Notes window (its entry goes with it). Nothing to close is fine.
#[tauri::command]
pub async fn user_action_close(window: crate::window_host::CallerWindow, app: AppHandle, windows: State<'_, SecondaryWindowsState>) -> Result<(), String> {
    let owner = crate::window_host::caller_guid(&window).ok_or("Only a window of an app can close the User Action.")?;
    if let Some((child, _)) = existing(windows.pool(), &owner).await {
        crate::secondary_windows::close_secondary_window(app.clone(), windows.clone(), child).await?;
    }
    tell_owner(&app, &owner, false);
    Ok(())
}

/// Whether the calling Notes window's User Action window is open now.
#[tauri::command]
pub async fn user_action_status(window: crate::window_host::CallerWindow, app: AppHandle, windows: State<'_, SecondaryWindowsState>) -> Result<bool, String> {
    let Some(owner) = crate::window_host::caller_guid(&window) else { return Ok(false) };
    Ok(match existing(windows.pool(), &owner).await {
        Some((child, _)) => crate::window_host::is_open(&app, &child),
        None => false,
    })
}

/// The Notes window went elsewhere: what opened its User Action window (`resource_id`) is out of scope. Tells the window if it is open.
#[tauri::command]
pub async fn user_action_scope_left(
    window: crate::window_host::CallerWindow,
    app: AppHandle,
    windows: State<'_, SecondaryWindowsState>,
    resource_id: String,
    now: String,
) -> Result<(), String> {
    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct Left {
        resource_id: String,
        now: String,
    }
    let Some(owner) = crate::window_host::caller_guid(&window) else { return Ok(()) };
    if let Some((child, _)) = existing(windows.pool(), &owner).await {
        crate::window_host::emit_if_open(&app, &child, EVENT_SCOPE_LEFT, Left { resource_id, now });
    }
    Ok(())
}

/// For the User Action page itself: the last launch it was told of — for a page that missed the event (it wasn't listening yet).
/// Any other window gets `null`.
#[tauri::command]
pub async fn user_action_context(window: crate::window_host::CallerWindow, actions: State<'_, UserActions>) -> Result<Option<Launch>, String> {
    let Some(guid) = crate::window_host::caller_guid(&window) else { return Ok(None) };
    Ok(actions.last.lock().unwrap().get(&guid).cloned())
}

/// A window asked for its tab (`init_window_tab`): if it is a User Action window that was opened for a launch, tell it, now that it can hear.
pub async fn page_ready(app: &AppHandle, guid: &str) {
    let windows = app.state::<SecondaryWindowsState>();
    let Some(owner) = owner_of(windows.pool(), guid).await else { return };
    let actions = app.state::<UserActions>();
    let launch = actions.waiting.lock().unwrap().remove(&owner);
    if let Some(launch) = launch {
        actions.last.lock().unwrap().insert(guid.to_string(), launch.clone());
        // A moment for the page to attach its listeners after it has registered.
        let (app, guid) = (app.clone(), guid.to_string());
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            crate::window_host::emit_if_open(&app, &guid, EVENT_LAUNCHED, launch);
        });
    }
    tell_owner(app, &owner, true);
}

/// A window is going away: if it was a User Action window, its Notes window is told (before its entry is deleted).
pub async fn window_gone(app: &AppHandle, guid: &str) {
    let windows = app.state::<SecondaryWindowsState>();
    let Some(owner) = owner_of(windows.pool(), guid).await else { return };
    app.state::<UserActions>().last.lock().unwrap().remove(guid);
    tell_owner(app, &owner, false);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_events_have_names_pages_can_listen_to() {
        for name in [EVENT_LAUNCHED, EVENT_SCOPE_LEFT, EVENT_STATE] {
            assert!(name.starts_with("user-action-") && name.chars().all(|c| c.is_ascii_lowercase() || c == '-'));
        }
    }

    #[test]
    fn a_launch_names_what_opened_it_and_where_from() {
        let launch = Launch { resource_id: "system:notes?v=home".into(), context: serde_json::json!({ "kind": "button" }), launched_at: 5 };
        let json = serde_json::to_value(&launch).unwrap();
        assert_eq!(json["resourceId"], "system:notes?v=home");
        assert_eq!(json["context"]["kind"], "button");
        assert_eq!(json["launchedAt"], 5);
    }
}
