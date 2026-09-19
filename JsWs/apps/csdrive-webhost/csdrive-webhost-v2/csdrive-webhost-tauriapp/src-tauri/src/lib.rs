#[cfg(target_os = "android")]
mod android_jni;
mod app_state;
mod code_snippets;
mod data_location;
mod deployable_apps;
mod device_files;
mod device_roots;
mod filen;
mod ipc;
mod layout;
mod secure_store;
mod secondary_windows;
mod sqlite_db;
mod window_host;

use std::path::{Path, PathBuf};

use tauri::http::{header::CONTENT_TYPE, Request, Response, StatusCode};
use tauri::webview::NewWindowResponse;
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

pub(crate) const USER_PROTOCOL: &str = "csuser";

/// The Content-Security-Policy for every page. It's written once, in `tauri.conf.json`
/// (`app.security.csp`): Tauri applies it to the admin-app's own pages, and `respond`
/// sends the very same string with every page we serve to the web apps. Under it no
/// script in any window can talk to the network: the only things `connect-src` allows are
/// the window's own origin (its own files), the IPC channel to this backend (`ipc:` /
/// `http://ipc.localhost`, depending on the OS), and in-memory `data:`/`blob:` URLs.
/// Everything else is locked to the same origin or in-memory sources too, so
/// images/fonts/scripts/frames can't be used to reach out either (nor can forms). Inline
/// scripts and styles stay allowed, since web apps commonly are one self-contained file.
fn content_security_policy<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> String {
    app.config()
        .app
        .security
        .csp
        .as_ref()
        .map(|csp| csp.to_string())
        // Never serve a page without one, even if the config were ever edited to drop it.
        .unwrap_or_else(|| "default-src 'none'".to_string())
}

/// CSP doesn't cover navigating the window itself (`location.href = "https://…"`
/// would ship data out in the URL, and leave our CSP behind), so windows may only
/// ever be at our own origins: the web apps' (`csuser`) and — for the main window only —
/// the admin-app's. (Web app windows never need the admin-app's page.)
fn is_internal_url(url: &Url, allow_admin: bool) -> bool {
    window_host::is_user_url(url) || (allow_admin && window_host::is_admin_url(url))
}

/// Applies the network lockdown to a window under construction.
///
/// `allow_admin`: whether the window may also show the admin-app (the main window; on
/// Android it's the only window and moves between the admin-app and web apps).
pub(crate) fn lock_down_navigation<R: tauri::Runtime>(
    builder: WebviewWindowBuilder<'_, R, impl Manager<R>>,
    allow_admin: bool,
) -> WebviewWindowBuilder<'_, R, impl Manager<R>> {
    let builder = builder
        .on_navigation(move |url| is_internal_url(url, allow_admin))
        .on_new_window(|_url, _features| NewWindowResponse::Deny);
    // Publishes the Android system-bar insets to the page as CSS variables (see `code_snippets`).
    #[cfg(mobile)]
    let builder = builder.initialization_script(code_snippets::SAFE_AREA_INIT_SCRIPT);
    builder
}

fn respond(status: StatusCode, content_type: &str, body: Vec<u8>, csp: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, content_type)
        .header("Content-Security-Policy", csp)
        .body(body)
        .unwrap()
}

fn respond_text(status: StatusCode, message: &str, csp: &str) -> Response<Vec<u8>> {
    respond(status, "text/plain; charset=utf-8", message.as_bytes().to_vec(), csp)
}

/// Serves `request_path` from inside `base_dir`.
fn serve_file(base_dir: &Path, request_path: &str, default_document: &str, csp: &str) -> Response<Vec<u8>> {
    match resolve_file_in(base_dir, request_path, default_document) {
        Some(file_path) => match std::fs::read(&file_path) {
            Ok(data) => respond(StatusCode::OK, content_type_for(&file_path), data, csp),
            Err(_) => respond_text(StatusCode::NOT_FOUND, "File not found", csp),
        },
        None => respond_text(StatusCode::FORBIDDEN, "Forbidden", csp),
    }
}

fn content_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Resolves a request path against `base_dir` (the `user` folder, for `csuser://`),
/// rejecting attempts to escape it (e.g. via `..`) since the served content is
/// arbitrary user-authored HTML/JS.
fn resolve_file_in(base_dir: &Path, request_path: &str, default_document: &str) -> Option<PathBuf> {
    let relative = request_path.trim_start_matches('/');
    let relative = if relative.is_empty() {
        default_document
    } else {
        relative
    };

    let candidate = base_dir.join(relative);
    let canonical_base_dir = base_dir.canonicalize().ok()?;
    let canonical_candidate = candidate.canonicalize().ok()?;

    if canonical_candidate.starts_with(&canonical_base_dir) {
        Some(canonical_candidate)
    } else {
        None
    }
}

/// The whole app. `main.rs` (desktop) and the generated Android/iOS glue both call this.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init());
    // Android's folder picker and the files inside a picked folder (see `device_roots.rs`).
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_android_fs::init());
    let builder = builder
        .invoke_handler(tauri::generate_handler![
            secondary_windows::list_secondary_windows,
            secondary_windows::open_new_secondary_window,
            secondary_windows::add_secondary_window_entry,
            secondary_windows::reopen_secondary_window,
            secondary_windows::close_secondary_window,
            secondary_windows::suspend_secondary_window,
            secondary_windows::close_all_secondary_windows,
            secondary_windows::suspend_all_secondary_windows,
            secondary_windows::focus_secondary_window,
            secondary_windows::list_tags,
            secondary_windows::add_window_tag,
            secondary_windows::update_window_tag,
            secondary_windows::reorder_window_tags,
            secondary_windows::remove_window_tag,
            secondary_windows::init_window_tab,
            secondary_windows::update_tab_resource,
            secondary_windows::submit_resource_icons,
            secondary_windows::create_tab_group,
            secondary_windows::rename_tab_group,
            secondary_windows::add_blank_tab,
            secondary_windows::clone_tab,
            secondary_windows::activate_tab,
            secondary_windows::move_tab_to_group,
            app_state::get_app_state,
            app_state::set_app_state,
            code_snippets::get_code_snippets,
            data_location::get_user_folder,
            device_files::save_to_device,
            device_roots::pick_device_root,
            device_roots::list_device_roots,
            device_roots::remove_device_root,
            device_roots::device_readdir,
            device_roots::device_stat,
            device_roots::device_exists,
            device_roots::device_read_file,
            device_roots::device_write_file,
            device_roots::device_mkdir,
            device_roots::device_rm,
            device_roots::device_rename,
            data_location::get_data_folder_info,
            data_location::pick_and_set_custom_data_folder,
            data_location::reset_data_folder_to_default,
            data_location::clear_custom_data_folder_contents,
            data_location::delete_app_data,
            deployable_apps::list_deployable_apps,
            deployable_apps::get_deployable_app_html,
            sqlite_db::sqlite_load,
            sqlite_db::sqlite_close,
            sqlite_db::sqlite_execute,
            sqlite_db::sqlite_select,
            filen::filen_list_accounts,
            filen::filen_login,
            filen::filen_logout,
            filen::filen_readdir,
            filen::filen_stat,
            filen::filen_read_file,
            filen::filen_write_file,
            filen::filen_mkdir,
            filen::filen_rm,
            filen::filen_rename,
        ])
        .register_uri_scheme_protocol(USER_PROTOCOL, |ctx, request: Request<Vec<u8>>| {
            let data_dir = data_location::effective_data_dir(ctx.app_handle()).expect("failed to resolve app data dir");
            serve_file(&layout::user_dir(&data_dir), request.uri().path(), "index.html", &content_security_policy(ctx.app_handle()))
        })
        .setup(|app| {
            let app_data_dir = data_location::effective_data_dir(app.handle())?;
            let admin_dir = layout::admin_dir(&app_data_dir);
            let user_dir = layout::user_dir(&app_data_dir);
            // Always ensure both exist, regardless of which (if either) files
            // inside them are missing.
            std::fs::create_dir_all(&admin_dir)?;
            std::fs::create_dir_all(&user_dir)?;

            let pool = tauri::async_runtime::block_on(secondary_windows::init_db(&admin_dir))?;
            tauri::async_runtime::block_on(app_state::ensure_schema(&pool))?;
            tauri::async_runtime::block_on(filen::ensure_schema(&pool))?;
            tauri::async_runtime::block_on(device_roots::ensure_schema(&pool))?;
            app.manage(app_state::AppDbState { pool: pool.clone() });
            app.manage(secondary_windows::SecondaryWindowsState::new(pool));
            app.manage(sqlite_db::SqliteState::default());
            app.manage(filen::FilenState::default());
            app.manage(window_host::HostState::default());
            #[cfg(target_os = "android")]
            android_jni::init(app.handle().clone());

            window_host::init(app.handle());

            // The custom data folder (if any) lives outside the default app-data dir
            // that fs:allow-appdata-* scopes cover, so extend the runtime scope to it.
            let _ = tauri_plugin_fs::FsExt::fs_scope(app).allow_directory(&user_dir, true);

            // The admin-app is the Tauri app's own frontend (`frontendDist`), compiled into the binary.
            let main_window = lock_down_navigation(
                WebviewWindowBuilder::new(app, window_host::MAIN_WINDOW_LABEL, WebviewUrl::App("index.html".into())),
                true,
            );
            #[cfg(desktop)]
            let main_window = main_window
            .title("CsDrive WebHost")
            .inner_size(1024.0, 768.0)
            // wry registers its own IDropTarget on the WebView2 child window (for OS
            // file drops) unless this is off, which prevents WebView2/Chromium's own
            // internal HTML5 drag-and-drop from ever receiving drag events on
            // Windows — permanently showing a "not allowed" cursor and the drop
            // never landing. `drag_and_drop(false)` (window-level, OS file drops
            // onto the window) alone is NOT enough; `disable_drag_drop_handler()`
            // (webview-level) is the one that actually stops wry's own handler —
            // both are documented as "required to use HTML5 drag and drop on
            // Windows," but only the webview one is.
            .drag_and_drop(false)
            .disable_drag_drop_handler();
            main_window.build()?;

            Ok(())
        })
;

    // One webview on mobile: notice when it lands back on the admin-app (see `window_host`).
    #[cfg(mobile)]
    let builder = builder.on_page_load(|webview, payload| {
        if let tauri::webview::PageLoadEvent::Started = payload.event() {
            window_host::note_navigation(webview.app_handle(), payload.url());
        }
    });

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn internal(url: &str, allow_admin: bool) -> bool {
        is_internal_url(&Url::parse(url).unwrap(), allow_admin)
    }

    #[test]
    fn windows_may_only_navigate_within_our_own_origins() {
        for allow_admin in [false, true] {
            assert!(internal("csuser://localhost/qwer/index1.html", allow_admin));
            assert!(internal("http://csuser.localhost/qwer/index1.html", allow_admin));

            assert!(!internal("https://example.com/", allow_admin));
            assert!(!internal("http://example.com/", allow_admin));
            assert!(!internal("http://csuser.localhost.evil.com/", allow_admin));
            assert!(!internal("http://evilcsuser.localhost/", allow_admin));
            assert!(!internal("http://localhost/", allow_admin));
            assert!(!internal("data:text/html,<script>alert(1)</script>", allow_admin));
            assert!(!internal("blob:http://csuser.localhost/1234", allow_admin));
            assert!(!internal("file:///C:/Windows/win.ini", allow_admin));
            assert!(!internal("about:blank", allow_admin));
        }
        // The admin-app's pages are for the main window only.
        assert!(internal("tauri://localhost/index.html", true));
        assert!(internal("http://tauri.localhost/index.html", true));
        assert!(!internal("tauri://localhost/index.html", false));
        assert!(!internal("http://tauri.localhost/index.html", false));
    }

    /// The policy lives in `tauri.conf.json`, so that is what's checked.
    #[test]
    fn the_csp_never_names_an_external_host_or_scheme() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let security = &conf["app"]["security"];
        for (key, extra_allowed) in [("csp", None), ("devCsp", Some("ws://localhost:1420"))] {
            let policy = security[key].as_str().unwrap_or_else(|| panic!("app.security.{key} must be set"));
            for directive in policy.split(';').map(str::trim) {
                for source in directive.split_whitespace().skip(1) {
                    let allowed = matches!(
                        source,
                        "'none'" | "'self'" | "'unsafe-inline'" | "data:" | "blob:" | "ipc:" | "http://ipc.localhost"
                    ) || Some(source) == extra_allowed;
                    assert!(allowed, "unexpected source \"{source}\" in {key}: \"{directive}\"");
                }
            }
            assert!(policy.contains("default-src 'none'"), "{key}");
            assert!(policy.contains("connect-src 'self' data: blob: ipc: http://ipc.localhost"), "{key}");
            assert!(policy.contains("form-action 'none'"), "{key}");
        }
        assert!(!security["csp"].as_str().unwrap().contains("ws:"), "only the dev policy may allow the dev server's websocket");
    }

    #[test]
    fn every_response_carries_the_csp() {
        let dir = std::env::temp_dir().join(format!("csdrive-serve-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "<h1>hi</h1>").unwrap();

        for (path, status) in [("/index.html", StatusCode::OK), ("/", StatusCode::OK), ("/missing.html", StatusCode::FORBIDDEN), ("/../x", StatusCode::FORBIDDEN)] {
            let response = serve_file(&dir, path, "index.html", "default-src 'none'");
            assert_eq!(response.status(), status, "{path}");
            assert_eq!(
                response.headers().get("Content-Security-Policy").and_then(|v| v.to_str().ok()),
                Some("default-src 'none'"),
                "{path}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
