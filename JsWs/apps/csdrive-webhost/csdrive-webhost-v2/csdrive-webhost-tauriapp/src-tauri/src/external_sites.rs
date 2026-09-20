//! **External web sites**: pages of the web (http/https) that a user or system app asks to open. See
//! `CLAUDE.md`, "External web sites".
//!
//! - An app calls `open_external_site(url)`. Nothing is opened until the person has said yes in an **OS
//!   native confirmation box** that shows the address; only one such box can be showing at a time, and a
//!   request that arrives while one is up is refused at once (there is no queue). The command answers
//!   with a request id straight away; the answer to the box comes later, as the `external-site-response`
//!   event, to the window that asked.
//! - A confirmed site opens in a window of this app (desktop: an OS window; Android: a full-screen page of
//!   its own), which has **no access to the backend at all** — it isn't one of our pages, so no command
//!   is granted to it — and may only go to other http/https addresses (never to one of our own origins).
//! - It is **not a tab**: it is listed as a child of the tab whose page asked for it (`external_pages`),
//!   one level below the tabs in the window manager. It has no `init`/`update` requests of its own, so
//!   what the manager shows is what is known from outside: the page's title (when it has one, and as it
//!   changes) and its address (as it changes; the first one is kept too, as `initial_url`).
//! - The asking app hears about it through events sent to its own window only: `external-site-response`
//!   (confirmed or not), `external-site-changed` (address or title), `external-site-closed`.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Emitter, Manager, State, Url};

use crate::secondary_windows::{fetch_tags, page_of, SecondaryWindowsState, TagRecord, EVENT_CHANGED};

/// The answer to the confirmation box (and so to `open_external_site`).
pub const EVENT_RESPONSE: &str = "external-site-response";
/// An external site's address or title changed.
pub const EVENT_SITE_CHANGED: &str = "external-site-changed";
/// An external site's window was closed (its entry stays in the window manager).
pub const EVENT_CLOSED: &str = "external-site-closed";

const MAX_URL_LEN: usize = 2048;

/// Only one confirmation box may be showing at a time.
#[derive(Default)]
pub struct ExternalSites {
    confirming: AtomicBool,
}

// ── Which addresses ───────────────────────────────────────────────────────────

/// The address an app asked for, if it is one that may be opened: absolute http or https, with a host,
/// no user name or password in it (a way of dressing one site up as another), of a sensible length, and
/// not one of this app's own origins.
pub fn check_url(input: &str) -> Result<Url, String> {
    let input = input.trim();
    if input.is_empty() || input.len() > MAX_URL_LEN {
        return Err("That isn't a usable web address.".to_string());
    }
    let url = Url::parse(input).map_err(|_| "That isn't a usable web address.".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only http and https addresses can be opened.".to_string());
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("That web address has no host.".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Addresses with a user name or password in them can't be opened.".to_string());
    }
    if crate::window_host::is_own_origin(&url) {
        return Err("That address is one of this app's own.".to_string());
    }
    Ok(url)
}

/// Whether an external site's window may go to `url`: what `check_url` accepts, or a blank page. (It is
/// checked for every navigation, so a site can't send its window to one of our own pages — those have
/// access to the backend, external pages have none.)
pub fn may_navigate_to(url: &Url) -> bool {
    url.as_str() == "about:blank" || check_url(url.as_str()).is_ok()
}

// ── What the window manager shows ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPageRecord {
    pub guid: String,
    /// The tab whose page asked for it — the tab it is listed under, for good.
    pub tab_guid: String,
    /// The window that tab belongs to: who hears about it.
    pub window_guid: String,
    /// The address it was opened at, and where it is now (it may have redirected, or been navigated).
    pub initial_url: String,
    pub url: String,
    /// The page's title, when it has one.
    pub title: Option<String>,
    pub created_at: i64,
    /// Filled in by the caller (it takes the window host).
    pub is_open: bool,
    pub tags: Vec<TagRecord>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// The external pages of `tab_guids`, oldest first, each with its tags.
pub async fn fetch_for_tabs(pool: &SqlitePool, tab_guids: &[String]) -> Result<Vec<ExternalPageRecord>, sqlx::Error> {
    if tab_guids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = (1..=tab_guids.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
    let query = format!(
        "SELECT guid, tab_guid, window_guid, initial_url, url, title, created_at FROM external_pages
         WHERE tab_guid IN ({placeholders}) ORDER BY created_at ASC, rowid ASC"
    );
    let mut q = sqlx::query(&query);
    for guid in tab_guids {
        q = q.bind(guid);
    }
    let rows = q.fetch_all(pool).await?;
    let guids: Vec<String> = rows.iter().map(|r| r.get::<String, _>("guid")).collect();
    let tags = fetch_tags(pool, &guids).await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let guid: String = row.get("guid");
            ExternalPageRecord {
                tags: tags.iter().filter(|t| t.guid == guid).cloned().collect(),
                guid,
                tab_guid: row.get("tab_guid"),
                window_guid: row.get("window_guid"),
                initial_url: row.get("initial_url"),
                url: row.get("url"),
                title: row.get("title"),
                created_at: row.get("created_at"),
                is_open: false,
            }
        })
        .collect())
}

async fn insert_page(pool: &SqlitePool, window_guid: &str, tab_guid: &str, url: &str) -> Result<String, sqlx::Error> {
    let guid = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO external_pages (guid, tab_guid, window_guid, initial_url, url, title, created_at) VALUES (?1, ?2, ?3, ?4, ?4, NULL, ?5)")
        .bind(&guid)
        .bind(tab_guid)
        .bind(window_guid)
        .bind(url)
        .bind(now_ms())
        .execute(pool)
        .await?;
    Ok(guid)
}

/// Deletes the external pages (and their tags) matching `column = value`, resolving to their guids.
async fn delete_where(pool: &SqlitePool, column: &str, values: &[String]) -> Vec<String> {
    let mut deleted = Vec::new();
    for value in values {
        let guids: Vec<String> = sqlx::query_scalar(&format!("SELECT guid FROM external_pages WHERE {column} = ?1"))
            .bind(value)
            .fetch_all(pool)
            .await
            .unwrap_or_default();
        for guid in &guids {
            let _ = sqlx::query("DELETE FROM window_tags WHERE guid = ?1").bind(guid).execute(pool).await;
        }
        let _ = sqlx::query(&format!("DELETE FROM external_pages WHERE {column} = ?1")).bind(value).execute(pool).await;
        deleted.extend(guids);
    }
    deleted
}

/// Deletes the external pages of these tabs (the tabs are going). Resolves to their guids, so that the
/// caller can close their windows.
pub async fn delete_for_tabs(pool: &SqlitePool, tab_guids: &[String]) -> Vec<String> {
    delete_where(pool, "tab_guid", tab_guids).await
}

/// Deletes the external pages of a window entry (the entry is going), likewise.
pub async fn delete_for_window(pool: &SqlitePool, window_guid: &str) -> Vec<String> {
    delete_where(pool, "window_guid", &[window_guid.to_string()]).await
}

/// A tab moved to a group of another window: whoever hears about its external pages changes too.
pub async fn follow_tab(pool: &SqlitePool, tab_guid: &str, window_guid: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE external_pages SET window_guid = ?2 WHERE tab_guid = ?1").bind(tab_guid).bind(window_guid).execute(pool).await?;
    Ok(())
}

fn pool_of(app: &AppHandle) -> SqlitePool {
    app.state::<SecondaryWindowsState>().pool().clone()
}

/// Whether the site's window is showing.
pub fn is_open(app: &AppHandle, guid: &str) -> bool {
    host::is_open(app, guid)
}

/// Asks the windows of these pages to close (their entries were already deleted).
pub fn close_windows(app: &AppHandle, guids: &[String]) {
    for guid in guids {
        host::close(app, guid);
    }
}

// ── What the app is told ──────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Response<'a> {
    request_id: &'a str,
    url: &'a str,
    confirmed: bool,
    /// The page that was opened (only when confirmed).
    page_guid: Option<&'a str>,
    /// Why it wasn't opened, when it was confirmed but couldn't be.
    error: Option<&'a str>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Change<'a> {
    page_guid: &'a str,
    url: &'a str,
    initial_url: &'a str,
    title: Option<&'a str>,
}

/// Sends `event` to the window whose tab the page belongs to (that window only) and tells the window
/// manager to refresh.
async fn tell_asker<S: Serialize + Clone>(app: &AppHandle, window_guid: &str, event: &str, payload: S) {
    crate::window_host::emit_if_open(app, window_guid, event, payload);
    let _ = app.emit(EVENT_CHANGED, ());
}

/// The page's address changed (or was learnt): it is remembered and the asker is told.
pub(crate) async fn note_url(app: &AppHandle, guid: &str, url: &str) {
    let pool = pool_of(app);
    let changed = sqlx::query("UPDATE external_pages SET url = ?2 WHERE guid = ?1 AND url <> ?2").bind(guid).bind(url).execute(&pool).await;
    if changed.is_ok_and(|r| r.rows_affected() > 0) {
        announce(app, &pool, guid).await;
    }
}

/// The page's title changed (or was learnt).
pub(crate) async fn note_title(app: &AppHandle, guid: &str, title: &str) {
    let pool = pool_of(app);
    let title = title.trim();
    if title.is_empty() {
        return;
    }
    let changed = sqlx::query("UPDATE external_pages SET title = ?2 WHERE guid = ?1 AND (title IS NULL OR title <> ?2)")
        .bind(guid)
        .bind(title)
        .execute(&pool)
        .await;
    if changed.is_ok_and(|r| r.rows_affected() > 0) {
        announce(app, &pool, guid).await;
    }
}

async fn announce(app: &AppHandle, pool: &SqlitePool, guid: &str) {
    let Ok(Some(row)) = sqlx::query("SELECT window_guid, url, initial_url, title FROM external_pages WHERE guid = ?1").bind(guid).fetch_optional(pool).await else {
        return;
    };
    let (window_guid, url, initial_url, title): (String, String, String, Option<String>) =
        (row.get("window_guid"), row.get("url"), row.get("initial_url"), row.get("title"));
    let change = Change { page_guid: guid, url: &url, initial_url: &initial_url, title: title.as_deref() };
    tell_asker(app, &window_guid, EVENT_SITE_CHANGED, change).await;
}

/// The page's window has gone (the entry stays, as closed).
pub(crate) async fn note_closed(app: &AppHandle, guid: &str) {
    let pool = pool_of(app);
    let window_guid: Option<String> = sqlx::query_scalar("SELECT window_guid FROM external_pages WHERE guid = ?1").bind(guid).fetch_optional(&pool).await.ok().flatten();
    match window_guid {
        Some(window_guid) => tell_asker(app, &window_guid, EVENT_CLOSED, serde_json::json!({ "pageGuid": guid })).await,
        None => {
            let _ = app.emit(EVENT_CHANGED, ()); // the entry was removed: the manager refreshes
        }
    }
}

// ── The commands ──────────────────────────────────────────────────────────────

/// Asks the person to allow opening an external web site. Answers at once with a request id (an app with
/// a confirmation box already showing gets an error instead — nothing is queued); what the person
/// decides arrives as the `external-site-response` event, and — if they said yes — the site's window
/// opens, listed under the tab that asked. The caller must be a web app or system app with a tab.
#[tauri::command]
pub async fn open_external_site(
    window: tauri::WebviewWindow,
    app: AppHandle,
    sites: State<'_, ExternalSites>,
    windows: State<'_, SecondaryWindowsState>,
    url: String,
) -> Result<String, String> {
    let url = check_url(&url)?;
    let window_guid = crate::window_host::caller_guid(&window).ok_or("Only web apps can open external web sites.")?;
    let tab_guid = windows.current_tab_of(&window_guid).ok_or("This window hasn't registered a tab yet.")?;
    let app_name = page_of(windows.pool(), &window_guid).await?.title();

    if sites.confirming.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("Another web site is waiting for the person's answer — try again after it has been answered.".to_string());
    }

    let request_id = uuid::Uuid::new_v4().to_string();
    let request = request_id.clone();
    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        let confirmed = confirm(&app_for_task, &app_name, &url).await;
        app_for_task.state::<ExternalSites>().confirming.store(false, Ordering::SeqCst);

        let pool = pool_of(&app_for_task);
        let mut page_guid = None;
        let mut error = None;
        if confirmed {
            match open_confirmed(&app_for_task, &pool, &window_guid, &tab_guid, &url).await {
                Ok(guid) => page_guid = Some(guid),
                Err(e) => error = Some(e),
            }
        }
        let response = Response {
            request_id: &request,
            url: url.as_str(),
            confirmed: confirmed && error.is_none(),
            page_guid: page_guid.as_deref(),
            error: error.as_deref(),
        };
        tell_asker(&app_for_task, &window_guid, EVENT_RESPONSE, response).await;
    });
    Ok(request_id)
}

/// The OS native box: who asks, and the address to be opened.
async fn confirm(app: &AppHandle, app_name: &str, url: &Url) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!("\"{app_name}\" wants to open this web site in a window of CsDrive WebHost:\n\n{url}\n\nOpen it?"))
        .title("Open an external web site?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Open".to_string(), "Cancel".to_string()))
        .show(move |answer| {
            let _ = sender.send(answer);
        });
    receiver.await.unwrap_or(false)
}

/// The person said yes: the page is listed under its tab, and its window opens.
async fn open_confirmed(app: &AppHandle, pool: &SqlitePool, window_guid: &str, tab_guid: &str, url: &Url) -> Result<String, String> {
    let guid = insert_page(pool, window_guid, tab_guid, url.as_str()).await.map_err(|e| e.to_string())?;
    if let Err(e) = host::open(app, &guid, url) {
        delete_where(pool, "guid", &[guid]).await;
        let _ = app.emit(EVENT_CHANGED, ());
        return Err(e);
    }
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(guid)
}

async fn url_of(pool: &SqlitePool, guid: &str) -> Result<Url, String> {
    let url: Option<String> = sqlx::query_scalar("SELECT url FROM external_pages WHERE guid = ?1").bind(guid).fetch_optional(pool).await.map_err(|e| e.to_string())?;
    let url = Url::parse(&url.ok_or("That external web site isn't listed.")?).map_err(|e| e.to_string())?;
    if !may_navigate_to(&url) {
        return Err("That address can't be opened.".to_string());
    }
    Ok(url)
}

/// Opens a listed site's window again, at the address it was at. The person asks for this in the window
/// manager itself, so there is no box to confirm.
#[tauri::command]
pub async fn reopen_external_site(app: AppHandle, windows: State<'_, SecondaryWindowsState>, guid: String) -> Result<(), String> {
    let url = url_of(windows.pool(), &guid).await?;
    if !host::is_open(&app, &guid) {
        host::open(&app, &guid, &url)?;
    }
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn focus_external_site(app: AppHandle, guid: String) -> Result<(), String> {
    host::focus(&app, &guid)
}

/// **Suspends** the site: only its window is closed; the entry stays in the list, as suspended, and
/// `reopen_external_site` brings the window back.
#[tauri::command]
pub fn suspend_external_site(app: AppHandle, guid: String) -> Result<(), String> {
    host::close(&app, &guid);
    Ok(())
}

/// **Closes** the site: its window is closed and its entry is removed from the list (with its tags).
#[tauri::command]
pub async fn close_external_site(app: AppHandle, windows: State<'_, SecondaryWindowsState>, guid: String) -> Result<(), String> {
    delete_where(windows.pool(), "guid", &[guid.clone()]).await;
    host::close(&app, &guid);
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(())
}

/// The sites opened from the tabs of a window entry — to suspend them when the window is.
pub async fn guids_of_window(pool: &SqlitePool, window_guid: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT guid FROM external_pages WHERE window_guid = ?1").bind(window_guid).fetch_all(pool).await.unwrap_or_default()
}

// ── Windows, per platform ─────────────────────────────────────────────────────

#[cfg(desktop)]
mod host {
    use std::time::Duration;

    use tauri::webview::{NewWindowResponse, PageLoadEvent};
    use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

    pub fn is_open(app: &AppHandle, guid: &str) -> bool {
        app.get_webview_window(guid).is_some()
    }

    /// An OS window showing `url`, labelled with the page's guid. **No capability names it** and its page
    /// isn't one of ours, so it can call nothing in the backend; it may only navigate to addresses
    /// `may_navigate_to` accepts and cannot open windows of its own.
    pub fn open(app: &AppHandle, guid: &str, url: &Url) -> Result<(), String> {
        let (for_load, for_title, for_close) = (app.clone(), app.clone(), app.clone());
        let (guid_load, guid_title, guid_close) = (guid.to_string(), guid.to_string(), guid.to_string());
        let window = WebviewWindowBuilder::new(app, guid, WebviewUrl::External(url.clone()))
            .title(url.as_str())
            .inner_size(1100.0, 800.0)
            .disable_drag_drop_handler()
            .on_navigation(|url| super::may_navigate_to(url))
            .on_new_window(|_url, _features| NewWindowResponse::Deny)
            .on_page_load(move |window, payload| {
                if matches!(payload.event(), PageLoadEvent::Finished) {
                    let (app, guid, url) = (for_load.clone(), guid_load.clone(), window.url().map(|u| u.to_string()).unwrap_or_else(|_| payload.url().to_string()));
                    tauri::async_runtime::spawn(async move { super::note_url(&app, &guid, &url).await });
                }
            })
            .on_document_title_changed(move |window, title| {
                let _ = window.set_title(&title);
                let (app, guid) = (for_title.clone(), guid_title.clone());
                tauri::async_runtime::spawn(async move { super::note_title(&app, &guid, &title).await });
            })
            .build()
            .map_err(|e| e.to_string())?;

        window.on_window_event(move |event| {
            if let WindowEvent::Destroyed = event {
                let (app, guid) = (for_close.clone(), guid_close.clone());
                tauri::async_runtime::spawn(async move { super::note_closed(&app, &guid).await });
            }
        });

        // A page that changes its address without loading (a single-page site) raises no load event: look.
        let (app, guid) = (app.clone(), guid.to_string());
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(1500)).await;
                let Some(window) = app.get_webview_window(&guid) else { break };
                if let Ok(url) = window.url() {
                    super::note_url(&app, &guid, url.as_str()).await;
                }
            }
        });
        Ok(())
    }

    pub fn close(app: &AppHandle, guid: &str) {
        if let Some(window) = app.get_webview_window(guid) {
            let _ = window.close();
        }
    }

    pub fn focus(app: &AppHandle, guid: &str) -> Result<(), String> {
        if let Some(window) = app.get_webview_window(guid) {
            let _ = window.unminimize();
            window.set_focus().map_err(|e| e.to_string())?;
            window.show().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

/// Android: a site is a page of its own (`ExternalSites.kt`), not a window; Rust starts it over JNI and polls
/// what it reports (its address, its title, being closed) — no native callback needed, as with the folder picker.
#[cfg(target_os = "android")]
mod host {
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;

    use jni::objects::{JString, JValue};
    use tauri::{AppHandle, Url};

    const CLASS: &str = "com.ayran.csdrive_webhost_tauriapp.ExternalSites";

    /// The sites showing now, by page guid.
    static OPEN: Mutex<Option<HashSet<String>>> = Mutex::new(None);
    static POLLING: AtomicBool = AtomicBool::new(false);

    fn with_open<T>(job: impl FnOnce(&mut HashSet<String>) -> T) -> T {
        job(OPEN.lock().unwrap().get_or_insert_with(HashSet::new))
    }

    pub fn is_open(_app: &AppHandle, guid: &str) -> bool {
        with_open(|open| open.contains(guid))
    }

    pub fn open(app: &AppHandle, guid: &str, url: &Url) -> Result<(), String> {
        let (id, address) = (guid.to_string(), url.to_string());
        crate::android_jni::on_activity(move |env, activity| {
            let class = crate::android_jni::helper_class(env, activity, CLASS)?;
            let id = env.new_string(&id)?;
            let address = env.new_string(&address)?;
            env.call_static_method(
                &class,
                "open",
                "(Landroid/app/Activity;Ljava/lang/String;Ljava/lang/String;)V",
                &[JValue::Object(activity), JValue::Object(&id), JValue::Object(&address)],
            )?;
            Ok(())
        })?;
        with_open(|open| open.insert(guid.to_string()));
        start_polling(app);
        Ok(())
    }

    pub fn close(_app: &AppHandle, guid: &str) {
        let id = guid.to_string();
        let _ = crate::android_jni::on_activity(move |env, activity| {
            let class = crate::android_jni::helper_class(env, activity, CLASS)?;
            let id = env.new_string(&id)?;
            env.call_static_method(&class, "close", "(Ljava/lang/String;)V", &[JValue::Object(&id)])?;
            Ok(())
        });
    }

    /// The site is on top of the app already; there is no other window to bring forward.
    pub fn focus(_app: &AppHandle, _guid: &str) -> Result<(), String> {
        Ok(())
    }

    /// While any site is showing, asks Kotlin now and then what happened to them.
    fn start_polling(app: &AppHandle) {
        if POLLING.swap(true, Ordering::SeqCst) {
            return;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(300)).await;
                let drained = crate::android_jni::on_activity(|env, activity| {
                    let class = crate::android_jni::helper_class(env, activity, CLASS)?;
                    let text = env.call_static_method(&class, "drain", "()Ljava/lang/String;", &[])?.l()?;
                    Ok(String::from(env.get_string(&JString::from(text))?))
                })
                .unwrap_or_default();
                for line in drained.lines() {
                    let mut parts = line.splitn(3, '\t');
                    let (Some(kind), Some(id), Some(value)) = (parts.next(), parts.next(), parts.next()) else { continue };
                    match kind {
                        "url" => super::note_url(&app, id, value).await,
                        "title" => super::note_title(&app, id, value).await,
                        "closed" => {
                            with_open(|open| open.remove(id));
                            super::note_closed(&app, id).await;
                        }
                        _ => {}
                    }
                }
                if with_open(|open| open.is_empty()) {
                    POLLING.store(false, Ordering::SeqCst);
                    // A site opened just as the loop was ending would find it stopped: carry on for it.
                    if with_open(|open| open.is_empty()) || POLLING.swap(true, Ordering::SeqCst) {
                        break;
                    }
                }
            }
        });
    }
}

#[cfg(target_os = "ios")]
mod host {
    use tauri::{AppHandle, Url};

    pub fn is_open(_app: &AppHandle, _guid: &str) -> bool {
        false
    }

    pub fn open(_app: &AppHandle, _guid: &str, _url: &Url) -> Result<(), String> {
        Err("External web sites can't be opened on iOS yet.".to_string())
    }

    pub fn close(_app: &AppHandle, _guid: &str) {}

    pub fn focus(_app: &AppHandle, _guid: &str) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_web_addresses_can_be_opened() {
        for good in ["https://example.com/", "http://example.com:8080/a?b=c#d", "  https://Example.com/x  ", "http://localhost:3000/", "https://sub.domain.example.org/path"] {
            assert!(check_url(good).is_ok(), "{good}");
        }
        assert_eq!(check_url("  https://Example.com/x  ").unwrap().as_str(), "https://example.com/x", "normalised, and what the person is shown");
        for bad in [
            "",
            "example.com",
            "javascript:alert(1)",
            "file:///C:/Windows/win.ini",
            "data:text/html,<b>x</b>",
            "ftp://example.com/",
            "tauri://localhost/index.html",
            "csuser://localhost/x.html",
            "http://tauri.localhost/index.html",
            "http://csuser.localhost/x.html",
            "http://ipc.localhost/get_app_state",
            "https://x.localhost/",
            "https://user:secret@example.com/",
            "https://google.com@evil.example/",
            "https://",
        ] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
        assert!(check_url(&format!("https://example.com/{}", "a".repeat(3000))).is_err(), "too long");
    }

    #[test]
    fn a_site_may_only_go_to_other_web_addresses() {
        let go = |u: &str| may_navigate_to(&Url::parse(u).unwrap());
        assert!(go("https://example.com/next"));
        assert!(go("about:blank"));
        assert!(!go("tauri://localhost/index.html"));
        assert!(!go("http://tauri.localhost/system/notes/index.html"));
        assert!(!go("csuser://localhost/app.html"));
        assert!(!go("javascript:alert(1)"));
        assert!(!go("file:///etc/passwd"));
    }

    /// A fresh `data.db` under an isolated OS temp dir — never the real app-data folder.
    async fn test_pool(name: &str) -> SqlitePool {
        let dir = std::env::temp_dir().join(format!("csdrive-external-sites-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        crate::secondary_windows::init_db(&dir).await.unwrap()
    }

    #[test]
    fn a_site_is_listed_under_its_tab_and_goes_with_it() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("listed").await;
            let a = insert_page(&pool, "w1", "tabA", "https://a.example/").await.unwrap();
            let b = insert_page(&pool, "w1", "tabA", "https://b.example/").await.unwrap();
            let c = insert_page(&pool, "w1", "tabB", "https://c.example/").await.unwrap();
            sqlx::query("INSERT INTO window_tags (guid, text, fg_color, bg_color, sort_order) VALUES (?1, 'read later', '#fff', '#000', 0)").bind(&a).execute(&pool).await.unwrap();

            let of_a = fetch_for_tabs(&pool, &["tabA".to_string()]).await.unwrap();
            assert_eq!(of_a.iter().map(|p| p.guid.clone()).collect::<Vec<_>>(), [a.clone(), b.clone()], "in the order they were opened");
            assert_eq!((of_a[0].initial_url.as_str(), of_a[0].url.as_str(), of_a[0].title.as_deref()), ("https://a.example/", "https://a.example/", None));
            assert_eq!(of_a[0].tags.len(), 1, "with its tags");
            assert!(fetch_for_tabs(&pool, &[]).await.unwrap().is_empty());

            // Moved with its tab to a group of another window: whoever is told follows.
            follow_tab(&pool, "tabA", "w2").await.unwrap();
            assert!(fetch_for_tabs(&pool, &["tabA".to_string()]).await.unwrap().iter().all(|p| p.window_guid == "w2"));

            // The tab goes: its sites and their tags go, and nobody else's.
            let gone = delete_for_tabs(&pool, &["tabA".to_string()]).await;
            assert_eq!(gone.len(), 2);
            assert!(fetch_for_tabs(&pool, &["tabA".to_string()]).await.unwrap().is_empty());
            assert_eq!(fetch_for_tabs(&pool, &["tabB".to_string()]).await.unwrap()[0].guid, c);
            let tags: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM window_tags WHERE guid = ?1").bind(&a).fetch_one(&pool).await.unwrap();
            assert_eq!(tags, 0);

            // The window goes: what is left of it goes.
            assert_eq!(delete_for_window(&pool, "w1").await, [c]);
            assert!(delete_for_window(&pool, "w1").await.is_empty());
        });
    }
}
