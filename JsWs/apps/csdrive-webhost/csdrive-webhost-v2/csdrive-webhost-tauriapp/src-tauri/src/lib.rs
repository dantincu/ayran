#[cfg(target_os = "android")]
mod android_jni;
mod app_state;
mod code_snippets;
mod data_location;
mod deployable_apps;
mod device_files;
mod external_sites;
mod files_cache;
mod filen;
mod filen_cache;
mod folder_pairs;
mod fs_commands;
mod fs_scope;
mod fs_upload;
mod ipc;
mod layout;
mod markdown;
mod picked_roots;
mod secure_store;
mod secondary_windows;
mod sqlite_db;
mod system_apps;
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
/// ever be at our own pages, and only those their kind needs: a web app's window at web apps' pages
/// (`csuser`), a system app's at system apps' pages, and the main window — which on Android is the
/// only window and moves between all of them — at any.
fn is_internal_url(url: &Url, allowed: window_host::Allowed) -> bool {
    (allowed.user && window_host::is_user_url(url))
        || (allowed.system && window_host::is_system_url(url))
        || (allowed.admin && window_host::is_admin_url(url))
}

/// Applies the network lockdown to a window under construction.
///
/// `allowed`: which pages the window may be at (see `is_internal_url`).
pub(crate) fn lock_down_navigation<R: tauri::Runtime>(
    builder: WebviewWindowBuilder<'_, R, impl Manager<R>>,
    allowed: window_host::Allowed,
) -> WebviewWindowBuilder<'_, R, impl Manager<R>> {
    let builder = builder
        .on_navigation(move |url| is_internal_url(url, allowed))
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
            // A markdown file is not served as it is: it becomes a page (see markdown.rs).
            Ok(data) if markdown::is_markdown(&file_path) => {
                let name = file_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let page = markdown::render_page(&String::from_utf8_lossy(&data), &name);
                respond(StatusCode::OK, "text/html; charset=utf-8", page.into_bytes(), csp)
            }
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
            secondary_windows::add_window_tab,
            secondary_windows::close_tab,
            secondary_windows::delete_tab_group,
            secondary_windows::move_tab_to_group,
            external_sites::open_external_site,
            external_sites::reopen_external_site,
            external_sites::focus_external_site,
            external_sites::suspend_external_site,
            external_sites::close_external_site,
            app_state::get_global_setting,
            app_state::set_global_setting,
            system_apps::list_system_apps,
            app_state::get_app_state,
            app_state::set_app_state,
            code_snippets::get_code_snippets,
            device_files::save_to_device,
            fs_commands::fs_read_dir,
            fs_commands::fs_stat,
            fs_commands::fs_exists,
            fs_commands::fs_read_file,
            fs_commands::fs_write_file,
            fs_commands::fs_mkdir,
            fs_commands::fs_remove,
            fs_commands::fs_rename,
            fs_commands::fs_root_path,
            fs_commands::fs_copy,
            fs_upload::fs_upload_begin,
            fs_upload::fs_upload_chunk,
            fs_upload::fs_upload_finish,
            fs_upload::fs_upload_abort,
            device_files::choose_save_location,
            filen_cache::filen_cache_account,
            filen_cache::filen_cache_set_interval,
            filen_cache::filen_cache_clear,
            filen_cache::filen_cache_list,
            filen_cache::filen_cache_read,
            filen_cache::filen_cache_write,
            filen_cache::filen_cache_mkdir,
            filen_cache::filen_cache_rm,
            filen_cache::filen_cache_rename,
            filen_cache::filen_cache_branches,
            filen_cache::filen_cache_create_branch,
            filen_cache::filen_cache_branch_changes,
            filen_cache::filen_cache_commit_branch,
            filen_cache::filen_cache_discard_branch,
            filen_cache::filen_cache_version,
            filen_cache::filen_cache_check_version,
            filen_cache::filen_cache_rebase,
            filen_cache::filen_cache_set_locked,
            filen_cache::filen_cache_checkout,
            filen_cache::filen_cache_release,
            filen_cache::filen_cache_upload_begin,
            filen_cache::filen_cache_upload_chunk,
            filen_cache::filen_cache_upload_finish,
            filen_cache::filen_cache_upload_abort,
            filen_cache::filen_cache_upload_from_path,
            filen_cache::filen_cache_download_to,
            filen_cache::filen_cache_export,
            device_files::export_local_file,
            picked_roots::pick_folder,
            picked_roots::list_picked_roots,
            picked_roots::remove_picked_root,
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
            tauri::async_runtime::block_on(picked_roots::ensure_schema(&pool))?;
            app.manage(app_state::AppDbState { pool: pool.clone() });
            app.manage(secondary_windows::SecondaryWindowsState::new(pool));
            app.manage(sqlite_db::SqliteState::default());
            app.manage(filen::FilenState::default());
            app.manage(window_host::HostState::default());
            app.manage(external_sites::ExternalSites::default());
            app.manage(device_files::ExportState::default());
            app.manage(filen_cache::UploadSessions::default());
            app.manage(fs_upload::LocalUploads::new(layout::files_dir(&app_data_dir).join(layout::FILES_LOCAL_UPLOADS_FOLDER)));
            // The Notes app's cache of Filen accounts and branches: the `files` folder and its database.
            app.manage(tauri::async_runtime::block_on(files_cache::Cache::open(&layout::files_dir(&app_data_dir)))?);
            #[cfg(target_os = "android")]
            android_jni::init(app.handle().clone());

            window_host::init(app.handle());

            // What the file commands and SQLite may touch (see `fs_scope.rs`): the user folder, always;
            // never the app's own database and secrets; and the folders picked in earlier sessions.
            let fs_scope = fs_scope::FsScope::new();
            fs_scope.allow_fixed_as("user", &user_dir);
            for protected in data_location::protected_paths(app.handle())? {
                fs_scope.deny(&protected);
            }
            picked_roots::allow_saved(&app.state::<app_state::AppDbState>().pool, &fs_scope);
            app.manage(fs_scope);

            // The admin-app is the Tauri app's own frontend (`frontendDist`), compiled into the binary.
            let main_window = lock_down_navigation(
                WebviewWindowBuilder::new(app, window_host::MAIN_WINDOW_LABEL, WebviewUrl::App("index.html".into())),
                window_host::Allowed { user: true, system: true, admin: true },
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

    fn internal(url: &str, allowed: window_host::Allowed) -> bool {
        is_internal_url(&Url::parse(url).unwrap(), allowed)
    }

    #[test]
    fn windows_may_only_navigate_within_our_own_pages_of_their_kind() {
        use window_host::{Allowed, Kind};
        let user = Allowed::for_kind(Kind::User);
        let system = Allowed::for_kind(Kind::System);
        let main = Allowed { user: true, system: true, admin: true };

        for allowed in [user, system, main] {
            assert!(!internal("https://example.com/", allowed));
            assert!(!internal("http://example.com/", allowed));
            assert!(!internal("http://csuser.localhost.evil.com/", allowed));
            assert!(!internal("http://evilcsuser.localhost/", allowed));
            assert!(!internal("http://localhost/", allowed));
            assert!(!internal("data:text/html,<script>alert(1)</script>", allowed));
            assert!(!internal("blob:http://csuser.localhost/1234", allowed));
            assert!(!internal("file:///C:/Windows/win.ini", allowed));
            assert!(!internal("about:blank", allowed));
        }
        let (web_app, system_app, admin_app) =
            ("http://csuser.localhost/qwer/index1.html", "http://tauri.localhost/system/notes/index.html", "http://tauri.localhost/index.html");

        // A web app's window stays with web apps; a system app's with system apps.
        assert!(internal(web_app, user) && !internal(system_app, user) && !internal(admin_app, user));
        assert!(internal(system_app, system) && !internal(web_app, system) && !internal(admin_app, system));
        // The main window (all there is on Android) may be at any of them.
        assert!(internal(web_app, main) && internal(system_app, main) && internal(admin_app, main));
        assert!(internal("csuser://localhost/qwer/index1.html", user));
        assert!(internal("tauri://localhost/system/notes/index.html", system));
        assert!(!internal("tauri://localhost/index.html", user));
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
