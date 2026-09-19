//! What "a window" means, per platform — the only module that needs to know.
//!
//! - **Desktop:** every web app entry (see `secondary_windows`) is a real OS window,
//!   labelled with the entry's guid; the admin-app owns the window labelled `main`.
//! - **Android / iOS:** there is exactly one webview (`main`), so it *navigates*
//!   between the admin-app and web apps. Opening an entry navigates it to that app;
//!   leaving (system Back, or the admin-app being loaded again) suspends the entry
//!   (its tabs and tags are kept); closing an entry explicitly deletes it. Because
//!   the webview's label no longer says who is calling, callers are told apart by
//!   the page they're running: the admin-app's origin, or a web app's — and which web
//!   app entry that is, is tracked here (`HostState::active`).
//!
//! Everything else (`secondary_windows`, `app_state`, `sqlite_db`, the admin-only
//! commands) asks this module instead of touching windows or labels directly.

use std::sync::Mutex;

use tauri::{AppHandle, Manager, Url, WebviewWindow};

use crate::{ADMIN_PROTOCOL, USER_PROTOCOL};

/// The admin-app's window on every platform.
pub const MAIN_WINDOW_LABEL: &str = "main";

#[derive(Default)]
pub struct HostState {
    /// Mobile only: the web app entry the single webview is currently showing.
    #[allow(dead_code)]
    active: Mutex<Option<String>>,
}

// ── URLs ──────────────────────────────────────────────────────────────────────

/// `csuser://localhost/<relative_path>` — where a web app is served.
pub fn user_page_url(relative_path: &str) -> Result<Url, String> {
    let base = Url::parse(&format!("{USER_PROTOCOL}://localhost/")).map_err(|e| e.to_string())?;
    base.join(relative_path).map_err(|e| e.to_string())
}

/// The URL a webview must be *navigated* to for a custom-protocol `url`. (`WebviewUrl::CustomProtocol`
/// converts it for you when a window is built; `navigate` does not.) On Windows and
/// Android a custom scheme `x` is served as `http://x.localhost/...`.
pub fn navigation_url(url: &Url) -> Url {
    #[cfg(any(windows, target_os = "android"))]
    {
        let mut rewritten = format!("http://{}.localhost{}", url.scheme(), url.path());
        if let Some(query) = url.query() {
            rewritten.push('?');
            rewritten.push_str(query);
        }
        if let Some(fragment) = url.fragment() {
            rewritten.push('#');
            rewritten.push_str(fragment);
        }
        if let Ok(parsed) = Url::parse(&rewritten) {
            return parsed;
        }
    }
    url.clone()
}

/// `csadmin://localhost/<bundle file name>` — where the admin-app is served.
#[cfg_attr(desktop, allow(dead_code))] // used by the mobile window host
pub fn admin_page_url() -> Result<Url, String> {
    Url::parse(&format!("{ADMIN_PROTOCOL}://localhost/{}", crate::layout::admin_bundle_url_path()))
        .map_err(|e| e.to_string())
}

/// Whether `url` is on `scheme`'s origin — on Windows and Android a custom scheme `x`
/// is served as `http://x.localhost`.
#[cfg_attr(desktop, allow(dead_code))] // used by the mobile window host
fn url_is_on(url: &Url, scheme: &str) -> bool {
    url.scheme() == scheme
        || (matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some_and(|host| host.strip_suffix(".localhost") == Some(scheme)))
}

#[cfg_attr(desktop, allow(dead_code))] // used by the mobile window host
pub fn is_admin_url(url: &Url) -> bool {
    url_is_on(url, ADMIN_PROTOCOL)
}

// ── Who is calling ────────────────────────────────────────────────────────────

/// Whether the calling page is the admin-app.
pub fn is_admin_page(window: &WebviewWindow) -> bool {
    platform::is_admin_page(window)
}

/// The web app entry (secondary window guid) the caller is, or `None` if the caller is
/// the admin-app.
pub fn caller_guid(window: &WebviewWindow) -> Option<String> {
    platform::caller_guid(window)
}

/// Stable per-caller key (the guid, or `main` for the admin-app) — e.g. to scope open
/// SQLite databases to whoever opened them.
pub fn caller_key(window: &WebviewWindow) -> String {
    caller_guid(window).unwrap_or_else(|| MAIN_WINDOW_LABEL.to_string())
}

/// For commands only the admin-app may use. Capabilities already keep web apps out on
/// desktop (by window label), but on mobile the admin-app and web apps share one
/// webview, so this is what actually tells them apart.
pub fn require_admin(window: &WebviewWindow) -> Result<(), String> {
    if is_admin_page(window) {
        Ok(())
    } else {
        Err("Only the admin-app can do that.".to_string())
    }
}

// ── Opening, closing, focusing ────────────────────────────────────────────────

pub fn is_open(app: &AppHandle, guid: &str) -> bool {
    platform::is_open(app, guid)
}

/// Shows the web app for entry `guid`.
pub fn open(app: &AppHandle, guid: &str, relative_path: &str) -> Result<(), String> {
    platform::open(app, guid, relative_path)
}

/// If entry `guid` is showing, reloads it at its base URL (discarding whatever in-app
/// view it drifted to) and returns `true`; otherwise does nothing and returns `false`.
pub fn reload_if_open(app: &AppHandle, guid: &str, relative_path: &str) -> Result<bool, String> {
    platform::reload_if_open(app, guid, relative_path)
}

/// Asks entry `guid`'s window to close. Once it has, `secondary_windows` deletes the
/// entry (or, if it was marked as suspending, keeps it). Returns whether it was open.
pub fn request_close(app: &AppHandle, guid: &str) -> bool {
    platform::request_close(app, guid)
}

/// Waits (briefly) until none of `guids` are open any more.
pub async fn wait_until_closed(app: &AppHandle, guids: &[String]) {
    platform::wait_until_closed(app, guids).await
}

pub fn focus(app: &AppHandle, guid: &str) -> Result<(), String> {
    platform::focus(app, guid)
}

// ── Desktop: real OS windows ──────────────────────────────────────────────────

#[cfg(desktop)]
mod platform {
    use super::*;
    use tauri::{WebviewUrl, WebviewWindowBuilder, WindowEvent};

    pub fn is_admin_page(window: &WebviewWindow) -> bool {
        window.label() == MAIN_WINDOW_LABEL
    }

    pub fn caller_guid(window: &WebviewWindow) -> Option<String> {
        (window.label() != MAIN_WINDOW_LABEL).then(|| window.label().to_string())
    }

    pub fn is_open(app: &AppHandle, guid: &str) -> bool {
        app.get_webview_window(guid).is_some()
    }

    /// Builds the `csuser://localhost/<relative_path>` window and wires up the close
    /// handler that deletes (or, if suspending, preserves) its `data.db` row. The
    /// window's own label is its guid — that's how `init_window_tab` knows which
    /// window called it, without needing to pass the guid through the URL.
    pub fn open(app: &AppHandle, guid: &str, relative_path: &str) -> Result<(), String> {
        let url = user_page_url(relative_path)?;

        let window = crate::lock_down_navigation(WebviewWindowBuilder::new(app, guid, WebviewUrl::CustomProtocol(url)))
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
                    crate::secondary_windows::handle_window_destroyed(&app_handle, &guid).await;
                });
            }
        });
        Ok(())
    }

    pub fn reload_if_open(app: &AppHandle, guid: &str, relative_path: &str) -> Result<bool, String> {
        match app.get_webview_window(guid) {
            Some(window) => {
                window.navigate(navigation_url(&user_page_url(relative_path)?)).map_err(|e| e.to_string())?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    pub fn request_close(app: &AppHandle, guid: &str) -> bool {
        match app.get_webview_window(guid) {
            Some(window) => window.close().is_ok(),
            None => false,
        }
    }

    /// `.close()` only *requests* a close — the window isn't actually gone until its
    /// `Destroyed` event fires on a later event-loop tick — so callers that need to
    /// know a window's file handles have truly been released (e.g. before deleting the
    /// data folder) must wait for this rather than assuming `.close()` was enough.
    pub async fn wait_until_closed(app: &AppHandle, guids: &[String]) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while guids.iter().any(|g| app.get_webview_window(g).is_some()) {
            if std::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
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

// ── Mobile: one webview that navigates ────────────────────────────────────────

#[cfg(mobile)]
mod platform {
    use super::*;

    pub fn is_admin_page(window: &WebviewWindow) -> bool {
        window.url().is_ok_and(|url| is_admin_url(&url))
    }

    pub fn caller_guid(window: &WebviewWindow) -> Option<String> {
        if is_admin_page(window) {
            None
        } else {
            window.app_handle().state::<HostState>().active.lock().unwrap().clone()
        }
    }

    pub fn is_open(app: &AppHandle, guid: &str) -> bool {
        app.state::<HostState>().active.lock().unwrap().as_deref() == Some(guid)
    }

    fn navigate(app: &AppHandle, url: Url) -> Result<(), String> {
        let window = app.get_webview_window(MAIN_WINDOW_LABEL).ok_or("The main window isn't available.")?;
        window.navigate(navigation_url(&url)).map_err(|e| e.to_string())
    }

    /// Runs the "window was destroyed" bookkeeping for an entry that is no longer showing.
    fn retire(app: &AppHandle, guid: String, keep_entry: bool) {
        if keep_entry {
            crate::secondary_windows::mark_suspending(app, &guid);
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            crate::secondary_windows::handle_window_destroyed(&app, &guid).await;
        });
    }

    pub fn open(app: &AppHandle, guid: &str, relative_path: &str) -> Result<(), String> {
        let previous = app.state::<HostState>().active.lock().unwrap().replace(guid.to_string());
        if let Some(previous) = previous.filter(|p| p != guid) {
            retire(app, previous, true); // only one app can be showing; the old one is kept, suspended
        }
        navigate(app, user_page_url(relative_path)?)
    }

    pub fn reload_if_open(app: &AppHandle, guid: &str, relative_path: &str) -> Result<bool, String> {
        if !is_open(app, guid) {
            return Ok(false);
        }
        navigate(app, user_page_url(relative_path)?)?;
        Ok(true)
    }

    pub fn request_close(app: &AppHandle, guid: &str) -> bool {
        if !is_open(app, guid) {
            return false;
        }
        *app.state::<HostState>().active.lock().unwrap() = None;
        // Not "keep": the caller decides that (by marking the entry as suspending
        // first); otherwise closing deletes it, as on desktop.
        retire(app, guid.to_string(), false);
        if let Ok(url) = admin_page_url() {
            let _ = navigate(app, url);
        }
        true
    }

    pub async fn wait_until_closed(_app: &AppHandle, _guids: &[String]) {}

    pub fn focus(_app: &AppHandle, _guid: &str) -> Result<(), String> {
        Ok(())
    }

    /// Called on every page load. Leaving a web app by any route other than closing it
    /// (system Back, a link, the admin-app being loaded again) lands on the admin-app
    /// with an entry still marked active: that's a suspend, not a close.
    pub fn note_navigation(app: &AppHandle, url: &Url) {
        if !is_admin_url(url) {
            return;
        }
        let left = app.state::<HostState>().active.lock().unwrap().take();
        if let Some(guid) = left {
            retire(app, guid, true);
        }
    }
}

/// Mobile only: tell the host a page is loading (see `platform::note_navigation`).
#[cfg(mobile)]
pub fn note_navigation(app: &AppHandle, url: &Url) {
    platform::note_navigation(app, url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_are_recognised_by_origin_on_every_platform() {
        let admin = |u: &str| is_admin_url(&Url::parse(u).unwrap());
        assert!(admin("csadmin://localhost/index.html"));
        assert!(admin("http://csadmin.localhost/index.html"));
        assert!(!admin("csuser://localhost/x.html"));
        assert!(!admin("http://csuser.localhost/x.html"));
        assert!(!admin("http://csadmin.localhost.evil.com/index.html"));
        assert!(!admin("https://example.com/csadmin"));
    }

    #[test]
    fn navigation_urls_use_the_form_the_webview_actually_serves() {
        let url = user_page_url("qwer/index1.html?doc=1#top").unwrap();
        let nav = navigation_url(&url);
        if cfg!(any(windows, target_os = "android")) {
            assert_eq!(nav.as_str(), "http://csuser.localhost/qwer/index1.html?doc=1#top");
        } else {
            assert_eq!(nav, url);
        }
    }

    #[test]
    fn page_urls_are_built_from_the_relative_path_and_the_bundle_name() {
        assert_eq!(user_page_url("qwer/index1.html").unwrap().as_str(), "csuser://localhost/qwer/index1.html");
        assert_eq!(
            admin_page_url().unwrap().as_str(),
            format!("csadmin://localhost/{}", crate::layout::admin_bundle_url_path())
        );
    }
}
