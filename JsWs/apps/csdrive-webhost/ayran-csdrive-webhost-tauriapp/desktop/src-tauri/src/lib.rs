use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Binds a one-shot local HTTP server on a random port, waits for the OAuth
/// callback in a background task, and emits the auth code via the "oauth-code"
/// Tauri event. Returns the bound port so the frontend can build the redirect URI.
#[tauri::command]
async fn start_oauth_listener(app: tauri::AppHandle) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;

    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    tauri::async_runtime::spawn(async move {
        if let Ok((mut stream, _)) = listener.accept().await {
            let mut buf = vec![0u8; 8192];
            if let Ok(n) = stream.read(&mut buf).await {
                let request = String::from_utf8_lossy(&buf[..n]).to_string();

                let html_ok = b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n\
                    <html><body style='font-family:sans-serif;text-align:center;padding:60px'>\
                    <h2>Authorization successful!</h2>\
                    <p>You can close this window and return to the app.</p>\
                    </body></html>";

                let html_err = b"HTTP/1.1 400 Bad Request\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n\
                    <html><body style='font-family:sans-serif;text-align:center;padding:60px'>\
                    <h2>Authorization failed</h2><p>Please try again.</p>\
                    </body></html>";

                if let Some(code) = extract_oauth_code(&request) {
                    let _ = stream.write_all(html_ok).await;
                    let _ = stream.flush().await;
                    let _ = app.emit("oauth-code", code);
                } else if let Some(err) = extract_oauth_error(&request) {
                    let _ = stream.write_all(html_err).await;
                    let _ = stream.flush().await;
                    let _ = app.emit("oauth-error", err);
                } else {
                    let _ = stream.write_all(html_err).await;
                    let _ = stream.flush().await;
                }
            }
        }
    });

    Ok(port)
}

fn parse_query(request: &str) -> Vec<(String, String)> {
    let first_line = match request.lines().next() {
        Some(l) => l,
        None => return vec![],
    };
    let path = match first_line.split_whitespace().nth(1) {
        Some(p) => p,
        None => return vec![],
    };
    let query = match path.find('?') {
        Some(i) => &path[i + 1..],
        None => return vec![],
    };
    query
        .split('&')
        .filter_map(|pair| {
            let mut it = pair.splitn(2, '=');
            let k = it.next()?.to_string();
            let v = it.next().unwrap_or("").to_string();
            Some((k, v))
        })
        .collect()
}

fn extract_oauth_code(request: &str) -> Option<String> {
    parse_query(request)
        .into_iter()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v)
}

fn extract_oauth_error(request: &str) -> Option<String> {
    parse_query(request)
        .into_iter()
        .find(|(k, _)| k == "error")
        .map(|(_, v)| v)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![start_oauth_listener])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}