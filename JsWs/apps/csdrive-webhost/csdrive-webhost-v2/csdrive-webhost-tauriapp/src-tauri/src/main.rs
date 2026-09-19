#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_state;
mod data_location;
mod deployable_apps;
mod secondary_windows;

use std::path::{Path, PathBuf};

use tauri::http::{header::CONTENT_TYPE, Request, Response, StatusCode};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const USER_PROTOCOL: &str = "csuser";
const ADMIN_PROTOCOL: &str = "csadmin";
const KEYCHAIN_SERVICE: &str = "com.ayran.csdrive-webhost-tauriapp";

/// The admin-app's own single-file bundle, embedded into this binary at compile
/// time (and thus into every installer built from it) so it's always available
/// as the default `admin/index.html` — no separate resource file or internet
/// access needed. Built via `cd csdrive-webhost-admin-reactapp && npm run
/// build`; see `build.rs`, which fails the build early with a clear message if
/// this hasn't been done.
const ADMIN_APP_INDEX_HTML: &str = include_str!("../../../csdrive-webhost-admin-reactapp/dist/index.html");

#[tauri::command]
fn keychain_set_secret(key: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn keychain_get_secret(key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn keychain_delete_secret(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
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
/// `csuser://`, the `admin` folder for `csadmin://`), rejecting attempts to
/// escape it (e.g. via `..`) since — at least for `user` — the served content
/// is arbitrary user-authored HTML/JS.
fn resolve_file_in(base_dir: &Path, request_path: &str) -> Option<PathBuf> {
    let relative = request_path.trim_start_matches('/');
    let relative = if relative.is_empty() {
        "index.html"
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
        .plugin(tauri_plugin_sql::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            keychain_set_secret,
            keychain_get_secret,
            keychain_delete_secret,
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
            data_location::get_data_folder_info,
            data_location::pick_and_set_custom_data_folder,
            data_location::reset_data_folder_to_default,
            data_location::clear_custom_data_folder_contents,
            data_location::delete_app_data,
            deployable_apps::list_deployable_apps,
            deployable_apps::get_deployable_app_html,
        ])
        .register_uri_scheme_protocol(USER_PROTOCOL, |ctx, request: Request<Vec<u8>>| {
            let user_dir = data_location::effective_data_dir(ctx.app_handle())
                .expect("failed to resolve app data dir")
                .join("user");

            match resolve_file_in(&user_dir, request.uri().path()) {
                Some(file_path) => match std::fs::read(&file_path) {
                    Ok(data) => Response::builder()
                        .header(CONTENT_TYPE, content_type_for(&file_path))
                        .body(data)
                        .unwrap(),
                    Err(_) => Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
                        .body(b"File not found".to_vec())
                        .unwrap(),
                },
                None => Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .header(CONTENT_TYPE, "text/plain; charset=utf-8")
                    .body(b"Forbidden".to_vec())
                    .unwrap(),
            }
        })
        .register_uri_scheme_protocol(ADMIN_PROTOCOL, |ctx, request: Request<Vec<u8>>| {
            let admin_dir = data_location::effective_data_dir(ctx.app_handle())
                .expect("failed to resolve app data dir")
                .join("admin");

            match resolve_file_in(&admin_dir, request.uri().path()) {
                Some(file_path) => match std::fs::read(&file_path) {
                    Ok(data) => Response::builder()
                        .header(CONTENT_TYPE, content_type_for(&file_path))
                        .body(data)
                        .unwrap(),
                    Err(_) => Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
                        .body(b"File not found".to_vec())
                        .unwrap(),
                },
                None => Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .header(CONTENT_TYPE, "text/plain; charset=utf-8")
                    .body(b"Forbidden".to_vec())
                    .unwrap(),
            }
        })
        .setup(|app| {
            let app_data_dir = data_location::effective_data_dir(app.handle())?;
            let admin_dir = app_data_dir.join("admin");
            let user_dir = app_data_dir.join("user");
            // Always ensure both exist, regardless of which (if either) files
            // inside them are missing.
            std::fs::create_dir_all(&admin_dir)?;
            std::fs::create_dir_all(&user_dir)?;

            let pool = tauri::async_runtime::block_on(secondary_windows::init_db(&admin_dir))?;
            tauri::async_runtime::block_on(app_state::ensure_schema(&pool))?;
            app.manage(app_state::AppDbState { pool: pool.clone() });
            app.manage(secondary_windows::SecondaryWindowsState::new(pool));

            let index_path = admin_dir.join("index.html");

            // No admin frontend yet (fresh install, or a "Delete app data" reset) —
            // install the one embedded into this binary at compile time.
            if !index_path.exists() {
                std::fs::write(&index_path, ADMIN_APP_INDEX_HTML)?;
            }

            // The custom data folder (if any) lives outside the default app-data dir
            // that fs:allow-appdata-* scopes cover, so extend the runtime scope to it.
            let _ = tauri_plugin_fs::FsExt::fs_scope(app).allow_directory(&user_dir, true);

            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::CustomProtocol(
                    format!("{ADMIN_PROTOCOL}://localhost/index.html").parse()?,
                ),
            )
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
