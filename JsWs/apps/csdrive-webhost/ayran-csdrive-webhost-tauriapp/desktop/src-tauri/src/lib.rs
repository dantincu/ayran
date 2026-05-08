pub mod filen;
pub mod storage;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};
use std::collections::HashMap;
use tauri::Manager;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const GOOGLE_CLIENT_ID: &str = env!("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET: &str = env!("GOOGLE_CLIENT_SECRET");
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const DRIVE_API: &str = "https://www.googleapis.com/drive/v3";

// ── Shared account type (mirrors TypeScript's StoredAccount) ──────────────────

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoredAccount {
    pub id: String,
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

fn accounts_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("accounts.dat"))
}

fn load_accounts(app: &tauri::AppHandle) -> Result<HashMap<String, StoredAccount>, String> {
    Ok(storage::read(&accounts_path(app)?)?.unwrap_or_default())
}

// ── Account CRUD commands ─────────────────────────────────────────────────────

#[tauri::command]
fn list_accounts(app: tauri::AppHandle) -> Result<Vec<StoredAccount>, String> {
    Ok(load_accounts(&app)?.into_values().collect())
}

#[tauri::command]
fn get_account(app: tauri::AppHandle, id: String) -> Result<Option<StoredAccount>, String> {
    Ok(load_accounts(&app)?.remove(&id))
}

#[tauri::command]
fn upsert_account(app: tauri::AppHandle, account: StoredAccount) -> Result<(), String> {
    let mut accounts = load_accounts(&app)?;
    accounts.insert(account.id.clone(), account);
    storage::write(&accounts_path(&app)?, &accounts)
}

#[tauri::command]
fn delete_account(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut accounts = load_accounts(&app)?;
    accounts.remove(&id);
    storage::write(&accounts_path(&app)?, &accounts)
}

// ── Google OAuth types ────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GoogleAccount {
    id: String,
    email: String,
    display_name: String,
    provider: String,
    access_token: String,
    refresh_token: Option<String>,
    expires_at: u64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
}

#[derive(Deserialize)]
struct DriveAbout {
    user: DriveUser,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveUser {
    display_name: String,
    email_address: String,
    permission_id: String,
}

// ── PKCE / helpers ────────────────────────────────────────────────────────────

fn random_base64url(byte_count: usize) -> String {
    let mut bytes = vec![0u8; byte_count];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(&bytes)
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha512::digest(verifier.as_bytes()))
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => {
                out.push('%');
                out.push(char::from_digit((byte >> 4) as u32, 16).unwrap().to_ascii_uppercase());
                out.push(char::from_digit((byte & 0xf) as u32, 16).unwrap().to_ascii_uppercase());
            }
        }
    }
    out
}

fn extract_query_param(request: &str, key: &str) -> Option<String> {
    let path = request.lines().next()?.split_whitespace().nth(1)?;
    let query = &path[path.find('?')? + 1..];
    query.split('&').find_map(|pair| {
        let mut it = pair.splitn(2, '=');
        let k = it.next()?;
        if k == key {
            Some(it.next().unwrap_or("").to_string())
        } else {
            None
        }
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

// ── Google OAuth commands ─────────────────────────────────────────────────────

#[tauri::command]
async fn start_google_oauth(app: tauri::AppHandle) -> Result<String, String> {
    let verifier = random_base64url(64);
    let challenge = pkce_challenge(&verifier);
    let state = random_base64url(16);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{}/callback", port);

    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/auth\
        ?client_id={}&redirect_uri={}&response_type=code\
        &scope={}&access_type=offline&prompt={}\
        &code_challenge={}&code_challenge_method=S256&state={}",
        percent_encode(GOOGLE_CLIENT_ID),
        percent_encode(&redirect_uri),
        percent_encode("https://www.googleapis.com/auth/drive"),
        percent_encode("consent select_account"),
        percent_encode(&challenge),
        percent_encode(&state),
    );

    tauri::async_runtime::spawn(async move {
        handle_oauth_callback(listener, verifier, redirect_uri, app).await;
    });

    Ok(auth_url)
}

#[tauri::command]
async fn refresh_google_token(refresh_token: String) -> Result<(String, u64), String> {
    let client = reqwest::Client::new();
    let res = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", GOOGLE_CLIENT_ID),
            ("client_secret", GOOGLE_CLIENT_SECRET),
            ("refresh_token", refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Token refresh failed: {}", res.text().await.unwrap_or_default()));
    }
    let data: TokenResponse = res.json().await.map_err(|e| e.to_string())?;
    Ok((data.access_token, now_ms() + data.expires_in * 1_000))
}

// ── OAuth callback handler ────────────────────────────────────────────────────

async fn handle_oauth_callback(
    listener: TcpListener,
    verifier: String,
    redirect_uri: String,
    app: tauri::AppHandle,
) {
    let Ok((mut stream, _)) = listener.accept().await else {
        return;
    };
    let mut buf = vec![0u8; 8192];
    let Ok(n) = stream.read(&mut buf).await else {
        return;
    };
    let request = String::from_utf8_lossy(&buf[..n]).to_string();

    let html_ok = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n\
        <html><body style='font-family:sans-serif;text-align:center;padding:60px'>\
        <h2>Authorization successful!</h2>\
        <p>You can close this window and return to the app.</p>\
        </body></html>";
    let html_err = "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n\
        <html><body style='font-family:sans-serif;text-align:center;padding:60px'>\
        <h2>Authorization failed</h2><p>Please try again.</p>\
        </body></html>";

    if let Some(code) = extract_query_param(&request, "code") {
        let _ = stream.write_all(html_ok.as_bytes()).await;
        let _ = stream.flush().await;
        match exchange_code_for_account(&code, &redirect_uri, &verifier).await {
            Ok(account) => {
                let _ = app.emit("oauth-account", account);
            }
            Err(e) => {
                let _ = app.emit("oauth-error", e);
            }
        }
    } else {
        let err = extract_query_param(&request, "error").unwrap_or_else(|| "unknown error".into());
        let _ = stream.write_all(html_err.as_bytes()).await;
        let _ = stream.flush().await;
        let _ = app.emit("oauth-error", err);
    }
}

async fn exchange_code_for_account(
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<GoogleAccount, String> {
    let client = reqwest::Client::new();

    let token_res = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", GOOGLE_CLIENT_ID),
            ("client_secret", GOOGLE_CLIENT_SECRET),
            ("code", code),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !token_res.status().is_success() {
        return Err(format!(
            "Token exchange failed: {}",
            token_res.text().await.unwrap_or_default()
        ));
    }
    let tokens: TokenResponse = token_res.json().await.map_err(|e| e.to_string())?;

    let about: DriveAbout = client
        .get(format!("{}/about?fields=user", DRIVE_API))
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    Ok(GoogleAccount {
        id: format!("google-{}", about.user.permission_id),
        email: about.user.email_address,
        display_name: about.user.display_name,
        provider: "google-drive".to_string(),
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: now_ms() + tokens.expires_in * 1_000,
    })
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(filen::FilenSessions(std::sync::Mutex::new(
            std::collections::HashMap::new(),
        )))
        .setup(|app| {
            let state = app.state::<filen::FilenSessions>();
            let mut sessions = state.0.lock().unwrap();
            filen::load_persisted(&app.handle(), &mut sessions);
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            // Accounts
            list_accounts,
            get_account,
            upsert_account,
            delete_account,
            // Google
            start_google_oauth,
            refresh_google_token,
            // Filen
            filen::filen_login,
            filen::filen_restore_session,
            filen::filen_has_session,
            filen::filen_logout,
            filen::filen_list_directory,
            filen::filen_download_file,
            filen::filen_upload_file,
            filen::filen_create_directory,
            filen::filen_trash_file,
            filen::filen_trash_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
