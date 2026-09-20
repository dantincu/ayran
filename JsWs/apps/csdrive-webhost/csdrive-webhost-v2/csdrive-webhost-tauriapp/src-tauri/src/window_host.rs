//! What "a window" means, per platform — the only module that needs to know.
//!
//! - **Desktop:** every web app entry (see `secondary_windows`) is a real OS window,
//!   labelled with the entry's guid; the admin-app owns the window labelled `main`.
//! - **Android:** every entry is an activity of its own (`android_windows.rs`, strategy in
//!   `docs/strategies/android-windows-strategy.md`) holding a plain WebView with a bridge of our own;
//!   the admin-app stays in Tauri's one webview, `main`. Nothing on a page says who is calling: which
//!   window a call comes from is decided by the activity that sent it.
//! - **iOS:** not implemented.
//!
//! Everything else (`secondary_windows`, `app_state`, `sqlite_db`, the admin-only
//! commands) asks this module instead of touching windows or labels directly.

use std::collections::HashSet;
use std::ops::Deref;
use std::sync::OnceLock;

use tauri::ipc::{CommandArg, CommandItem, InvokeError};
use tauri::{AppHandle, Runtime, Url, WebviewWindow};

use crate::USER_PROTOCOL;

/// The admin-app's window on every platform.
pub const MAIN_WINDOW_LABEL: &str = "main";

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
pub(crate) fn is_app_origin(url: &Url) -> bool {
    url_is_on(url, "tauri")
        || ADMIN_URL.get().is_some_and(|admin| {
            url.scheme() == admin.scheme() && url.host_str() == admin.host_str() && url.port_or_known_default() == admin.port_or_known_default()
        })
}

/// Whether `url` is one of this app's own origins — its frontend, the web apps' custom protocol, or any
/// `*.localhost` name (`ipc.localhost`, `asset.localhost`…, which is how the platform serves them). Pages
/// there have access to the backend, so an external web site must never be sent to one.
pub fn is_own_origin(url: &Url) -> bool {
    is_app_origin(url) || is_user_url(url) || url.host_str().is_some_and(|host| host.ends_with(".localhost"))
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

/// The commands a window (of a web app or a system app) may call: what `capabilities/user-apps.json` and `system-apps.json`
/// grant every window (`allow-some-command` → `some_command`). Tauri applies those files to a desktop window by its label;
/// the Android bridge (`android_windows.rs`) applies the same list itself, so there is one.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn window_commands() -> &'static HashSet<String> {
    static COMMANDS: OnceLock<HashSet<String>> = OnceLock::new();
    COMMANDS.get_or_init(|| {
        let mut commands = HashSet::new();
        for file in [include_str!("../capabilities/user-apps.json"), include_str!("../capabilities/system-apps.json")] {
            commands.extend(granted_commands(file));
        }
        commands
    })
}

/// The commands a capability file grants (its `allow-some-command` permissions).
fn granted_commands(capability_file: &str) -> Vec<String> {
    let parsed: serde_json::Value = serde_json::from_str(capability_file).expect("a capability file is valid json");
    parsed["permissions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|permission| permission.as_str()?.strip_prefix("allow-"))
        .map(|command| command.replace('-', "_"))
        .collect()
}

/// The window a command was called from — the admin-app, or the web app / system app entry (secondary window) with
/// a given guid. A command that needs to know who is calling takes this instead of a `WebviewWindow` (which it
/// derefs to: for a call made through Tauri's own webview — desktop windows, the admin-app — it *is* that window).
///
/// Who it is is worked out **when the command is extracted, from something the page cannot influence**: on desktop the
/// window's label (Tauri's capability files also keep the windows apart by label); on Android the activity the call came
/// from (`android_windows::caller_in`) — the page's address is not consulted, so nothing a page does can pass it off
/// as another window.
pub struct CallerWindow<R: Runtime = tauri::Wry> {
    window: WebviewWindow<R>,
    /// The entry's guid, or `None` for the admin-app.
    guid: Option<String>,
    /// Whether the window is one of the app's own system apps (Notes...).
    system: bool,
}

impl<R: Runtime> Deref for CallerWindow<R> {
    type Target = WebviewWindow<R>;

    fn deref(&self) -> &WebviewWindow<R> {
        &self.window
    }
}

impl<R: Runtime> CallerWindow<R> {
    /// Whether the caller is the admin-app.
    pub fn is_admin(&self) -> bool {
        self.guid.is_none()
    }
}

impl<'de, R: Runtime> CommandArg<'de, R> for CallerWindow<R> {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        let headers = command.message.headers().clone();
        let window = WebviewWindow::<R>::from_command(command)?;
        let (guid, system) = platform::identify(&headers, &window).map_err(InvokeError::from)?;
        Ok(Self { window, guid, system })
    }
}

/// Whether the calling window is the admin-app.
pub fn is_admin_page<R: Runtime>(window: &CallerWindow<R>) -> bool {
    window.is_admin()
}

/// The web app entry (secondary window guid) the caller is, or `None` if the caller is
/// the admin-app.
pub fn caller_guid<R: Runtime>(window: &CallerWindow<R>) -> Option<String> {
    window.guid.clone()
}

/// Stable per-caller key (the guid, or `main` for the admin-app) — e.g. to scope open
/// SQLite databases to whoever opened them.
pub fn caller_key<R: Runtime>(window: &CallerWindow<R>) -> String {
    caller_guid(window).unwrap_or_else(|| MAIN_WINDOW_LABEL.to_string())
}

/// For commands only the admin-app may use. (Capabilities keep web apps out of them on desktop, by window label; this
/// is what does it on Android, where every call reaches Tauri through the one webview, and on desktop too.)
pub fn require_admin<R: Runtime>(window: &CallerWindow<R>) -> Result<(), String> {
    if is_admin_page(window) {
        Ok(())
    } else {
        Err("Only the admin-app can do that.".to_string())
    }
}

/// Whether the calling window is one of the app's own system apps (Notes...).
pub fn is_system_page<R: Runtime>(window: &CallerWindow<R>) -> bool {
    window.system
}

/// For the few commands that reach beyond what a web app may do and that the app's own code —
/// the admin-app and the system apps — needs (today: exporting a file to the device, see
/// `device_files`). A user web app is refused.
pub fn require_trusted<R: Runtime>(window: &CallerWindow<R>) -> Result<(), String> {
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
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

    /// Who a call comes from: the window's label (the admin-app is `main`; every other window's label is its guid), and
    /// whether the page it shows is a system app's.
    pub fn identify<R: Runtime>(_headers: &tauri::http::HeaderMap, window: &WebviewWindow<R>) -> Result<(Option<String>, bool), String> {
        Ok(((window.label() != MAIN_WINDOW_LABEL).then(|| window.label().to_string()), window.url().is_ok_and(|url| is_system_url(&url))))
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

        // A web app's or system app's window stays at its own page (see `lock_down_navigation`).
        let window = crate::lock_down_navigation(WebviewWindowBuilder::new(app, guid, url), Allowed::for_kind(page.kind), Some(page.url()?))
            .title(page.title())
            .inner_size(1024.0, 768.0)
            // Without this, wry hands the page the *real paths* of files dropped on it (Tauri's
            // drag-drop event) — and web apps never see a real path. Turning it off also lets the page
            // use HTML5 drag and drop, whose `File` objects carry no path.
            .disable_drag_drop_handler()
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

// ── Android: one activity per window ─────────────────────────────────────────

#[cfg(target_os = "android")]
mod platform {
    use super::*;
    use crate::android_windows as host;

    /// Who a call comes from: the activity that sent it (see `android_windows::caller_in`), or — a call made through
    /// Tauri's own webview, which shows nothing but the admin-app — the admin-app.
    pub fn identify<R: Runtime>(headers: &tauri::http::HeaderMap, _window: &WebviewWindow<R>) -> Result<(Option<String>, bool), String> {
        Ok(host::caller_in(headers)?.map_or((None, false), |(guid, system)| (Some(guid), system)))
    }

    pub fn is_open(_app: &AppHandle, guid: &str) -> bool {
        host::is_open(guid)
    }

    pub fn open(app: &AppHandle, guid: &str, page: &Page) -> Result<(), String> {
        host::open(app, guid, page)
    }

    pub fn emit_if_open<S: serde::Serialize + Clone>(_app: &AppHandle, guid: &str, event: &str, payload: S) -> bool {
        host::emit_if_open(guid, event, &payload)
    }

    pub fn request_close(_app: &AppHandle, guid: &str) -> bool {
        host::request_close(guid)
    }

    pub async fn wait_until_closed(_app: &AppHandle, guids: &[String]) {
        host::wait_until_closed(guids).await
    }

    pub fn focus(app: &AppHandle, guid: &str) -> Result<(), String> {
        host::focus(app, guid)
    }
}

// ── iOS: not implemented ─────────────────────────────────────────────────────

#[cfg(target_os = "ios")]
mod platform {
    use super::*;

    const NOT_IMPLEMENTED: &str = "Windows aren't implemented on iOS yet.";

    pub fn identify<R: Runtime>(_headers: &tauri::http::HeaderMap, _window: &WebviewWindow<R>) -> Result<(Option<String>, bool), String> {
        Ok((None, false))
    }

    pub fn is_open(_app: &AppHandle, _guid: &str) -> bool {
        false
    }

    pub fn open(_app: &AppHandle, _guid: &str, _page: &Page) -> Result<(), String> {
        Err(NOT_IMPLEMENTED.to_string())
    }

    pub fn emit_if_open<S: serde::Serialize + Clone>(_app: &AppHandle, _guid: &str, _event: &str, _payload: S) -> bool {
        false
    }

    pub fn request_close(_app: &AppHandle, _guid: &str) -> bool {
        false
    }

    pub async fn wait_until_closed(_app: &AppHandle, _guids: &[String]) {}

    pub fn focus(_app: &AppHandle, _guid: &str) -> Result<(), String> {
        Err(NOT_IMPLEMENTED.to_string())
    }
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
    fn what_a_window_may_call_is_what_the_capability_files_grant_to_every_window_and_nothing_of_the_admin_apps() {
        let windows = window_commands();
        for command in ["list_secondary_windows", "init_window_tab", "fs_read_file", "sqlite_select", "open_external_site", "filen_cache_list", "save_to_device"] {
            assert!(windows.contains(command), "{command}");
        }
        // What only the admin-app may do (admin.json) is never on the list — nor is anything of Tauri's own plugins.
        for command in granted_commands(include_str!("../capabilities/admin.json")) {
            assert!(!windows.contains(&command), "{command} is the admin-app's");
        }
        for command in ["filen_login", "filen_logout", "delete_app_data", "get_data_folder_info", "fs_root_path", "list_deployable_apps"] {
            assert!(!windows.contains(command), "{command}");
        }
        assert!(windows.iter().all(|c| !c.contains(':') && !c.starts_with("plugin")));
        // Every one of them is a command the app defines (build.rs lists them all: granting one that isn't there is a typo).
        let build = include_str!("../build.rs");
        for command in windows {
            assert!(build.contains(&format!("\"{command}\"")), "{command} is granted to windows but isn't a command of the app");
        }
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
