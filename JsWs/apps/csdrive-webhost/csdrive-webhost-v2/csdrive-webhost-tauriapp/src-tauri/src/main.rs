#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::http::{header::CONTENT_TYPE, Request, Response, StatusCode};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const USER_PROTOCOL: &str = "csuser";
const ACTION_SCHEME: &str = "csuser-action";

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

/// Resolves a request path against the user folder, rejecting attempts to
/// escape it (e.g. via `..`) since the served content is arbitrary
/// user-authored HTML/JS.
fn resolve_user_file(user_dir: &Path, request_path: &str) -> Option<PathBuf> {
    let relative = request_path.trim_start_matches('/');
    let relative = if relative.is_empty() {
        "index.html"
    } else {
        relative
    };

    let candidate = user_dir.join(relative);
    let canonical_user_dir = user_dir.canonicalize().ok()?;
    let canonical_candidate = candidate.canonicalize().ok()?;

    if canonical_candidate.starts_with(&canonical_user_dir) {
        Some(canonical_candidate)
    } else {
        None
    }
}

fn sample_index_html(user_dir: &Path) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>CsDrive WebHost</title>
<style>
  body {{ font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; line-height: 1.5; padding: 0 1rem; }}
  code {{ background: #eee; padding: 0.15em 0.4em; border-radius: 4px; }}
  .path {{ word-break: break-all; }}
  a.action {{ display: inline-block; margin: 0.5rem 1rem 0.5rem 0; }}
</style>
</head>
<body>
<h1>CsDrive WebHost</h1>
<p>This is a sample page. CsDrive WebHost renders whatever <code>index.html</code>
you place in your user folder instead of a built-in UI.</p>
<p>Your user folder is:</p>
<p class="path"><code>{user_dir}</code></p>
<p>Edit or replace <code>index.html</code> in that folder (and add any CSS/JS/images
alongside it) and reopen the app to see your own page.</p>
<p>
  <a class="action" href="csuser-action://open-folder">Open user folder</a>
  <a class="action" href="csuser-action://open-editor">Open this file in a text editor</a>
</p>
</body>
</html>
"#,
        user_dir = user_dir.display()
    )
}

fn open_in_file_manager(path: &Path) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer").arg(path).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(path).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(path).spawn();
    }
}

fn open_in_text_editor(path: &Path) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("notepad").arg(path).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("-e")
            .arg(path)
            .spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let editor = std::env::var("EDITOR").unwrap_or_else(|_| "xdg-open".to_string());
        let _ = std::process::Command::new(editor).arg(path).spawn();
    }
}

fn main() {
    tauri::Builder::default()
        .register_uri_scheme_protocol(USER_PROTOCOL, |ctx, request: Request<Vec<u8>>| {
            let user_dir = ctx
                .app_handle()
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir")
                .join("user");

            match resolve_user_file(&user_dir, request.uri().path()) {
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
            let user_dir = app.path().app_data_dir()?.join("user");
            let index_path = user_dir.join("index.html");

            if !index_path.exists() {
                std::fs::create_dir_all(&user_dir)?;
                std::fs::write(&index_path, sample_index_html(&user_dir))?;
            }

            let index_path_for_editor = index_path.clone();
            let user_dir_for_folder = user_dir.clone();
            // WebView2 can fire the navigation-intercept callback more than once
            // for a single link click/redirect; debounce so actions don't double-fire.
            let last_action: Mutex<Option<(String, Instant)>> = Mutex::new(None);

            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::CustomProtocol(
                    format!("{USER_PROTOCOL}://localhost/index.html").parse()?,
                ),
            )
            .title("CsDrive WebHost")
            .inner_size(1024.0, 768.0)
            .on_navigation(move |url| {
                if url.scheme() == ACTION_SCHEME {
                    let action = url.host_str().unwrap_or("").to_string();
                    let mut last = last_action.lock().unwrap();
                    let is_duplicate = matches!(
                        &*last,
                        Some((prev_action, at)) if *prev_action == action && at.elapsed() < Duration::from_millis(500)
                    );
                    *last = Some((action.clone(), Instant::now()));

                    if !is_duplicate {
                        match action.as_str() {
                            "open-folder" => open_in_file_manager(&user_dir_for_folder),
                            "open-editor" => open_in_text_editor(&index_path_for_editor),
                            _ => {}
                        }
                    }
                    false
                } else {
                    true
                }
            })
            .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
