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

use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Manager, Url, WebviewWindow};

use crate::USER_PROTOCOL;

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

/// Which of the two sets of windows an entry belongs to: web apps from the user folder, or the
/// system apps that ship inside this one (see `system_apps.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    User,
    System,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::User => "user",
            Kind::System => "system",
        }
    }

    /// `None` means the user apps (what every caller had before there were two kinds).
    pub fn parse(text: Option<&str>) -> Result<Self, String> {
        match text {
            None | Some("user") => Ok(Kind::User),
            Some("system") => Ok(Kind::System),
            Some(other) => Err(format!("Unknown kind of window: \"{other}\".")),
        }
    }
}

/// What a window shows: a web app in the user folder (`relative_path` is its html file) or a system
/// app (`relative_path` is `system:<id>`).
#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub kind: Kind,
    pub relative_path: String,
}

impl Page {
    pub fn new(kind: Kind, relative_path: impl Into<String>) -> Self {
        Self { kind, relative_path: relative_path.into() }
    }

    /// The page's URL, in the form `navigation_url` expects.
    pub fn url(&self) -> Result<Url, String> {
        match self.kind {
            Kind::User => user_page_url(&self.relative_path),
            Kind::System => crate::system_apps::page_url(
                crate::system_apps::app_of_relative_path(&self.relative_path).ok_or("That system app doesn't exist.")?,
            ),
        }
    }

    /// The window's title.
    #[cfg_attr(mobile, allow(dead_code))]
    pub fn title(&self) -> String {
        match self.kind {
            Kind::User => self.relative_path.clone(),
            Kind::System => crate::system_apps::app_of_relative_path(&self.relative_path).map_or_else(|| self.relative_path.clone(), |app| app.name.to_string()),
        }
    }
}

/// Which pages a window may be at (see `lock_down_navigation`).
#[derive(Debug, Clone, Copy, Default)]
pub struct Allowed {
    pub user: bool,
    pub system: bool,
    pub admin: bool,
}

impl Allowed {
    /// The pages of one kind of secondary window.
    pub fn for_kind(kind: Kind) -> Self {
        Self { user: kind == Kind::User, system: kind == Kind::System, admin: false }
    }
}

/// The URL a webview must be *navigated* to for a custom-protocol `url`. (`WebviewUrl::CustomProtocol`
/// converts it for you when a window is built; `navigate` does not.) On Windows and
/// Android a custom scheme `x` is served as `http://x.localhost/...`.
#[cfg_attr(desktop, allow(dead_code))] // used by the mobile window host, which navigates one webview
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

/// Where the admin-app is served from: the app's own compiled-in frontend (`frontendDist`
/// in `tauri.conf.json`), which Tauri serves at `tauri://localhost` — or, on Windows and
/// Android, `http://tauri.localhost` (see `navigation_url`) — and, while running under
/// `tauri dev`, from the dev server (`devUrl`).
static ADMIN_URL: OnceLock<Url> = OnceLock::new();

/// Records where the admin-app is served from. Called once, at startup.
pub fn init(app: &AppHandle) {
    let dev_url = if tauri::is_dev() { app.config().build.dev_url.clone() } else { None };
    let _ = ADMIN_URL.set(dev_url.unwrap_or_else(default_admin_url));
}

fn default_admin_url() -> Url {
    Url::parse("tauri://localhost/index.html").expect("a valid URL")
}

/// The admin-app's page (in the form to pass to `navigation_url`).
#[cfg_attr(desktop, allow(dead_code))] // used by the mobile window host
pub fn admin_page_url() -> Url {
    ADMIN_URL.get().cloned().unwrap_or_else(default_admin_url)
}

/// Whether `url` is on `scheme`'s origin — on Windows and Android a custom scheme `x`
/// is served as `http://x.localhost`.
fn url_is_on(url: &Url, scheme: &str) -> bool {
    (url.scheme() == scheme && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some_and(|host| host.strip_suffix(".localhost") == Some(scheme)))
}

/// Whether `url` is one of the web apps' pages (`csuser://…`).
pub fn is_user_url(url: &Url) -> bool {
    url_is_on(url, USER_PROTOCOL)
}

/// Whether `url` is on the app's own frontend origin (`tauri://localhost`, `http://tauri.localhost`,
/// or the dev server's under `tauri dev`).
fn is_app_origin(url: &Url) -> bool {
    url_is_on(url, "tauri")
        || ADMIN_URL.get().is_some_and(|admin| {
            url.scheme() == admin.scheme() && url.host_str() == admin.host_str() && url.port_or_known_default() == admin.port_or_known_default()
        })
}

/// Whether `url` is the admin-app's page. The frontend has more than one page — each system app is
/// its own — so the origin isn't enough: only the root page is the admin-app, and only it has
/// admin privileges.
pub fn is_admin_url(url: &Url) -> bool {
    is_app_origin(url) && matches!(url.path(), "" | "/" | "/index.html")
}

/// Whether `url` is a system app's page (under `/system/`). These are ordinary pages of the same
/// frontend and get the privileges of a user app, nothing more.
pub fn is_system_url(url: &Url) -> bool {
    is_app_origin(url) && url.path().starts_with("/system/")
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

/// Whether the calling page is one of the app's own system apps (Notes...). Read from the page's
/// address, which a window can't change to a system page's unless it is one (navigation is confined
/// per kind of window — see `lock_down_navigation`).
pub fn is_system_page(window: &WebviewWindow) -> bool {
    window.url().is_ok_and(|url| is_system_url(&url))
}

/// For the few commands that reach beyond what a web app may do and that the app's own code —
/// the admin-app and the system apps — needs (today: exporting a file to the device, see
/// `device_files`). A user web app is refused.
pub fn require_trusted(window: &WebviewWindow) -> Result<(), String> {
    if is_admin_page(window) || is_system_page(window) {
        Ok(())
    } else {
        Err("Only the admin-app and the system apps can do that.".to_string())
    }
}

// ── Opening, closing, focusing ────────────────────────────────────────────────

pub fn is_open(app: &AppHandle, guid: &str) -> bool {
    platform::is_open(app, guid)
}

/// Shows the page for entry `guid`.
pub fn open(app: &AppHandle, guid: &str, page: &Page) -> Result<(), String> {
    platform::open(app, guid, page)
}

/// Sends `event` to entry `guid`'s window — to that window only, not to every window — if it is
/// showing, and returns whether it was.
pub fn emit_if_open<S: serde::Serialize + Clone>(app: &AppHandle, guid: &str, event: &str, payload: S) -> bool {
    platform::emit_if_open(app, guid, event, payload)
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
    pub fn open(app: &AppHandle, guid: &str, page: &Page) -> Result<(), String> {
        // A web app is served by our own protocol; a system app is a page of the frontend Tauri embeds.
        let url = match page.kind {
            Kind::User => WebviewUrl::CustomProtocol(page.url()?),
            Kind::System => WebviewUrl::App(
                crate::system_apps::app_of_relative_path(&page.relative_path).ok_or("That system app doesn't exist.")?.entry.into(),
            ),
        };

        let window = crate::lock_down_navigation(WebviewWindowBuilder::new(app, guid, url), Allowed::for_kind(page.kind))
            .title(page.title())
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

    pub fn emit_if_open<S: serde::Serialize + Clone>(app: &AppHandle, guid: &str, event: &str, payload: S) -> bool {
        use tauri::Emitter;
        // A window's label is its guid.
        app.get_webview_window(guid).is_some() && app.emit_to(guid, event, payload).is_ok()
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

    pub fn open(app: &AppHandle, guid: &str, page: &Page) -> Result<(), String> {
        let previous = app.state::<HostState>().active.lock().unwrap().replace(guid.to_string());
        if let Some(previous) = previous.filter(|p| p != guid) {
            retire(app, previous, true); // only one app can be showing; the old one is kept, suspended
        }
        navigate(app, page.url()?)
    }

    pub fn emit_if_open<S: serde::Serialize + Clone>(app: &AppHandle, guid: &str, event: &str, payload: S) -> bool {
        use tauri::Emitter;
        // There is one webview, `main`, showing whichever page is active.
        is_open(app, guid) && app.emit_to(MAIN_WINDOW_LABEL, event, payload).is_ok()
    }

    pub fn request_close(app: &AppHandle, guid: &str) -> bool {
        if !is_open(app, guid) {
            return false;
        }
        *app.state::<HostState>().active.lock().unwrap() = None;
        // Not "keep": the caller decides that (by marking the entry as suspending
        // first); otherwise closing deletes it, as on desktop.
        retire(app, guid.to_string(), false);
        let _ = navigate(app, admin_page_url());
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
    fn urls_are_recognised_by_origin_and_path_on_every_platform() {
        let admin = |u: &str| is_admin_url(&Url::parse(u).unwrap());
        let system = |u: &str| is_system_url(&Url::parse(u).unwrap());
        let user = |u: &str| is_user_url(&Url::parse(u).unwrap());
        assert!(admin("tauri://localhost/index.html"));
        assert!(admin("http://tauri.localhost/index.html"));
        assert!(admin("https://tauri.localhost/"));
        assert!(admin("http://tauri.localhost/index.html?x=1#top"));
        assert!(!admin("csuser://localhost/x.html"));
        assert!(!admin("http://csuser.localhost/x.html"));
        assert!(!admin("http://tauri.localhost.evil.com/index.html"));
        assert!(!admin("tauri://evil/index.html"));
        assert!(!admin("https://example.com/tauri"));
        // Only the development server's own origin is added while developing.
        assert!(!admin("http://localhost:1420/"));

        // A system app is a page of the same frontend, but it is not the admin-app.
        assert!(system("tauri://localhost/system/notes/index.html"));
        assert!(system("http://tauri.localhost/system/notes/index.html?root=1"));
        assert!(!admin("tauri://localhost/system/notes/index.html"), "a system app never has admin privileges");
        assert!(!admin("http://tauri.localhost/system/notes/index.html"));
        assert!(!system("tauri://localhost/index.html"));
        assert!(!system("tauri://localhost/systemx/notes.html"));
        assert!(!system("http://csuser.localhost/system/notes/index.html"), "a user app's file at that path isn't a system app");
        assert!(!system("http://tauri.localhost.evil.com/system/notes/index.html"));

        assert!(user("csuser://localhost/x.html"));
        assert!(user("http://csuser.localhost/x.html"));
        assert!(!user("tauri://localhost/index.html"));
        assert!(!user("http://csuser.localhost.evil.com/"));
        assert!(!user("csuser://evil/x.html"));
    }

    #[test]
    fn a_page_knows_its_url_and_title() {
        let user = Page::new(Kind::User, "qwer/index1.html");
        assert_eq!(user.url().unwrap().as_str(), "csuser://localhost/qwer/index1.html");
        assert_eq!(user.title(), "qwer/index1.html");
        let system = Page::new(Kind::System, "system:notes");
        assert_eq!(system.url().unwrap().as_str(), "tauri://localhost/system/notes/index.html");
        assert_eq!(system.title(), "Notes");
        assert!(Page::new(Kind::System, "system:nope").url().is_err());
        assert_eq!(Kind::parse(None).unwrap(), Kind::User);
        assert_eq!(Kind::parse(Some("system")).unwrap(), Kind::System);
        assert!(Kind::parse(Some("other")).is_err());
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
    fn page_urls_are_built_from_the_relative_path() {
        assert_eq!(user_page_url("qwer/index1.html").unwrap().as_str(), "csuser://localhost/qwer/index1.html");
        assert_eq!(admin_page_url().as_str(), "tauri://localhost/index.html");
    }
}
