#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_state;
mod data_location;
mod deployable_apps;
mod filen;
mod layout;
mod secondary_windows;
mod sqlite_db;

use std::path::{Path, PathBuf};

use tauri::http::{header::CONTENT_TYPE, Request, Response, StatusCode};
use tauri::webview::NewWindowResponse;
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

const USER_PROTOCOL: &str = "csuser";
const ADMIN_PROTOCOL: &str = "csadmin";

/// The admin-app's own single-file bundle, embedded into this binary at compile
/// time (and thus into every installer built from it) so it's always available
/// as the admin bundle file (`layout::ADMIN_BUNDLE_PATH`) — no separate resource file or internet
/// access needed. Built via `cd csdrive-webhost-admin-reactapp && npm run
/// build`; see `build.rs`, which fails the build early with a clear message if
/// this hasn't been done.
const ADMIN_APP_INDEX_HTML: &str = include_str!("../../../csdrive-webhost-admin-reactapp/dist/index.html");

/// Sent with every page we serve, to the admin-app's window and to user-provided web
/// apps alike, so no script running in any window can talk to the network: the only
/// things `connect-src` allows are this window's own origin (its own files), the
/// IPC channel to this backend (`ipc:` / `http://ipc.localhost`, depending on the OS),
/// and in-memory `data:`/`blob:` URLs. Everything else is locked to the same
/// origin or in-memory sources too, so images/fonts/scripts/frames can't be used to
/// reach out either (nor can forms). Inline scripts and styles stay allowed, since
/// the admin-app is one self-contained file and user apps commonly are too.
const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; \
     script-src 'self' 'unsafe-inline'; \
     style-src 'self' 'unsafe-inline'; \
     img-src 'self' data: blob:; \
     font-src 'self' data:; \
     media-src 'self' data: blob:; \
     connect-src 'self' data: blob: ipc: http://ipc.localhost; \
     frame-src 'self'; \
     worker-src 'self' blob:; \
     object-src 'none'; \
     base-uri 'self'; \
     form-action 'none'";

/// CSP doesn't cover navigating the window itself (`location.href = "https://…"`
/// would ship data out in the URL, and leave our CSP behind), so windows may only
/// ever be at one of our own two origins. On Windows a custom scheme `x` is served
/// as `http://x.localhost`.
fn is_internal_url(url: &Url) -> bool {
    let ours = |scheme: &str| scheme == USER_PROTOCOL || scheme == ADMIN_PROTOCOL;
    if ours(url.scheme()) {
        return true;
    }
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|host| {
            host.strip_suffix(".localhost").is_some_and(ours)
        })
}

/// Makes the admin bundle file (`layout::ADMIN_BUNDLE_PATH`) exactly the admin-app
/// bundle embedded in this binary, on every start. That installs it on a fresh install
/// or after "Delete app data", updates it when the app itself is upgraded, and —
/// because the admin-app is the one window with privileged commands — undoes any
/// tampering with the file between runs. (So during development, rebuild the Tauri app
/// after building the admin-app rather than copying the bundle by hand; a hand-copied
/// one is replaced at startup.)
fn install_admin_bundle(data_dir: &Path, bundle: &str) -> std::io::Result<()> {
    let bundle_file = layout::admin_bundle_file(data_dir);
    let bundle_root = layout::admin_bundle_root(data_dir);
    std::fs::create_dir_all(&bundle_root)?;

    let up_to_date = std::fs::read(&bundle_file).is_ok_and(|current| current == bundle.as_bytes());
    if !up_to_date {
        std::fs::write(&bundle_file, bundle)?;
    }

    // The folder is ours alone and the bundle is a single file, so anything else in it
    // shouldn't be there (e.g. something written into it by way of a link planted in
    // the `user` folder).
    if let Ok(entries) = std::fs::read_dir(&bundle_root) {
        for entry in entries.flatten() {
            if entry.path() != bundle_file {
                let path = entry.path();
                let _ = std::fs::remove_file(&path).or_else(|_| std::fs::remove_dir_all(&path));
            }
        }
    }

    Ok(())
}

/// Applies the network lockdown to a window under construction.
pub(crate) fn lock_down_navigation<R: tauri::Runtime>(
    builder: WebviewWindowBuilder<'_, R, impl Manager<R>>,
) -> WebviewWindowBuilder<'_, R, impl Manager<R>> {
    builder
        .on_navigation(is_internal_url)
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
}

fn respond(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, content_type)
        .header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        .body(body)
        .unwrap()
}

fn respond_text(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    respond(status, "text/plain; charset=utf-8", message.as_bytes().to_vec())
}

/// Serves `request_path` from inside `base_dir`.
fn serve_file(base_dir: &Path, request_path: &str, default_document: &str) -> Response<Vec<u8>> {
    match resolve_file_in(base_dir, request_path, default_document) {
        Some(file_path) => match std::fs::read(&file_path) {
            Ok(data) => respond(StatusCode::OK, content_type_for(&file_path), data),
            Err(_) => respond_text(StatusCode::NOT_FOUND, "File not found"),
        },
        None => respond_text(StatusCode::FORBIDDEN, "Forbidden"),
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

/// Resolves a request path against `base_dir` (the `user` folder for
/// `csuser://`, the admin bundle's folder for `csadmin://`), rejecting attempts to
/// escape it (e.g. via `..`) since — at least for `user` — the served content
/// is arbitrary user-authored HTML/JS.
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
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
            data_location::get_user_folder,
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
            serve_file(&layout::user_dir(&data_dir), request.uri().path(), "index.html")
        })
        .register_uri_scheme_protocol(ADMIN_PROTOCOL, |ctx, request: Request<Vec<u8>>| {
            // Only the admin-app's own window may load this; user-provided web apps
            // run in other windows.
            if ctx.webview_label() != "main" {
                return respond_text(StatusCode::FORBIDDEN, "Forbidden");
            }
            let data_dir = data_location::effective_data_dir(ctx.app_handle()).expect("failed to resolve app data dir");
            serve_file(&layout::admin_bundle_root(&data_dir), request.uri().path(), layout::admin_bundle_url_path())
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
            app.manage(app_state::AppDbState { pool: pool.clone() });
            app.manage(secondary_windows::SecondaryWindowsState::new(pool));
            app.manage(sqlite_db::SqliteState::default());
            app.manage(filen::FilenState::default());

            install_admin_bundle(&app_data_dir, ADMIN_APP_INDEX_HTML)?;

            // The custom data folder (if any) lives outside the default app-data dir
            // that fs:allow-appdata-* scopes cover, so extend the runtime scope to it.
            let _ = tauri_plugin_fs::FsExt::fs_scope(app).allow_directory(&user_dir, true);

            lock_down_navigation(WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::CustomProtocol(
                    format!("{ADMIN_PROTOCOL}://localhost/{}", layout::admin_bundle_url_path()).parse()?,
                ),
            ))
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
            .disable_drag_drop_handler()
            .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn internal(url: &str) -> bool {
        is_internal_url(&Url::parse(url).unwrap())
    }

    #[test]
    fn windows_may_only_navigate_within_our_own_origins() {
        assert!(internal("csuser://localhost/qwer/index1.html"));
        assert!(internal("csadmin://localhost/index.html"));
        assert!(internal("http://csuser.localhost/qwer/index1.html"));
        assert!(internal("http://csadmin.localhost/index.html"));

        assert!(!internal("https://example.com/"));
        assert!(!internal("http://example.com/"));
        assert!(!internal("http://csuser.localhost.evil.com/"));
        assert!(!internal("http://evilcsuser.localhost/"));
        assert!(!internal("http://localhost/"));
        assert!(!internal("data:text/html,<script>alert(1)</script>"));
        assert!(!internal("blob:http://csuser.localhost/1234"));
        assert!(!internal("file:///C:/Windows/win.ini"));
        assert!(!internal("about:blank"));
    }

    #[test]
    fn the_csp_never_names_an_external_host_or_scheme() {
        for directive in CONTENT_SECURITY_POLICY.split(';').map(str::trim) {
            for source in directive.split_whitespace().skip(1) {
                let allowed = matches!(
                    source,
                    "'none'" | "'self'" | "'unsafe-inline'" | "data:" | "blob:" | "ipc:" | "http://ipc.localhost"
                );
                assert!(allowed, "unexpected source \"{source}\" in \"{directive}\"");
            }
        }
        assert!(CONTENT_SECURITY_POLICY.contains("default-src 'none'"));
        assert!(CONTENT_SECURITY_POLICY.contains("connect-src 'self' data: blob: ipc: http://ipc.localhost"));
    }

    #[test]
    fn the_admin_bundle_is_installed_updated_and_restored_at_every_start() {
        let data_dir = std::env::temp_dir().join(format!("csdrive-admin-bundle-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data_dir);
        std::fs::create_dir_all(&data_dir).unwrap();
        let bundle_file = layout::admin_bundle_file(&data_dir);
        let bundle_root = layout::admin_bundle_root(&data_dir);

        install_admin_bundle(&data_dir, "<h1>v1</h1>").unwrap();
        assert_eq!(std::fs::read_to_string(&bundle_file).unwrap(), "<h1>v1</h1>", "fresh install");

        std::fs::write(&bundle_file, "<script>evil()</script>").unwrap();
        install_admin_bundle(&data_dir, "<h1>v1</h1>").unwrap();
        assert_eq!(std::fs::read_to_string(&bundle_file).unwrap(), "<h1>v1</h1>", "tampering is undone");

        install_admin_bundle(&data_dir, "<h1>v2</h1>").unwrap();
        assert_eq!(std::fs::read_to_string(&bundle_file).unwrap(), "<h1>v2</h1>", "an upgrade replaces it");

        std::fs::write(bundle_root.join("_planted.txt"), "planted").unwrap();
        std::fs::create_dir_all(bundle_root.join("planted-dir")).unwrap();
        install_admin_bundle(&data_dir, "<h1>v2</h1>").unwrap();
        assert_eq!(std::fs::read_dir(&bundle_root).unwrap().count(), 1, "only the bundle is left in its folder");

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn every_response_carries_the_csp() {
        let dir = std::env::temp_dir().join(format!("csdrive-serve-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "<h1>hi</h1>").unwrap();

        for (path, status) in [("/index.html", StatusCode::OK), ("/", StatusCode::OK), ("/missing.html", StatusCode::FORBIDDEN), ("/../x", StatusCode::FORBIDDEN)] {
            let response = serve_file(&dir, path, "index.html");
            assert_eq!(response.status(), status, "{path}");
            assert_eq!(
                response.headers().get("Content-Security-Policy").and_then(|v| v.to_str().ok()),
                Some(CONTENT_SECURITY_POLICY),
                "{path}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
