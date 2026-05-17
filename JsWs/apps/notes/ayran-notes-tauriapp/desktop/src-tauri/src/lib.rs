pub mod cache;
pub mod filen;
pub mod gdrive;
pub mod storage;

use rusqlite::{params, OptionalExtension};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use tauri_plugin_fs::FsExt;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::collections::HashMap;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const GOOGLE_CLIENT_ID: &str = env!("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET: &str = env!("GOOGLE_CLIENT_SECRET");
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const DRIVE_API: &str = "https://www.googleapis.com/drive/v3";

// ── Custom data-dirs state ─────────────────────────────────────────────────────

/// Holds the user-chosen base directory for c/, t/, s/ (overrides app_base_dir when set).
pub struct CustomBasePath(pub std::sync::Mutex<Option<std::path::PathBuf>>);

/// Non-None when the app was closed while a data-dir move was in progress.
pub struct MoveInterruptedInfo(pub std::sync::Mutex<Option<(std::path::PathBuf, std::path::PathBuf)>>);

static MOVE_CANCELLED: AtomicBool = AtomicBool::new(false);
static MOVE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

// ── Shared account type (mirrors TypeScript's StoredAccount) ──────────────────

fn is_false(b: &bool) -> bool { !b }

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
    /// When true, all write operations for this account are buffered locally.
    #[serde(default, skip_serializing_if = "is_false")]
    pub shelveset_active: bool,
}

// ── Shelveset types ────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShelvesetChange {
    pub id: i64,
    pub account_id: String,
    pub operation: String, // "delete" | "rename" | "move"
    pub item_id: String,
    pub item_name: String,
    pub parent_id: String,
    pub new_name: Option<String>,
    pub new_parent_id: Option<String>,
    pub is_dir: bool,
    pub created_at: i64,
    pub display_path: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShelvesetContentItem {
    pub id: i64,
    pub account_id: String,
    pub item_id: String,
    pub item_name: String,
    pub parent_id: String,
    pub is_dir: bool,
    pub is_new: bool,
    pub created_at: i64,
    pub display_path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShelvesetAllChanges {
    pub structural: Vec<ShelvesetChange>,
    pub content: Vec<ShelvesetContentItem>,
}

// ── App environment (DEV / PROD) ──────────────────────────────────────────────

static APP_ENV: OnceLock<String> = OnceLock::new();

#[derive(Deserialize)]
struct AppConfigEnv {
    #[serde(default = "default_env")]
    env: String,
}
fn default_env() -> String { "PROD".to_string() }

fn read_config_env(app: &tauri::AppHandle) -> String {
    let path = match app.path().resource_dir() {
        Ok(d) => d.join("config.json"),
        Err(_) => return "PROD".to_string(),
    };
    let Ok(content) = std::fs::read_to_string(&path) else { return "PROD".to_string() };
    let Ok(cfg) = serde_json::from_str::<AppConfigEnv>(&content) else { return "PROD".to_string() };
    cfg.env
}

/// Returns the base data directory for all app files.
/// When env != "PROD", data is isolated under {app_data}/env/{ENV}/.
pub(crate) fn app_base_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let env = APP_ENV.get().map(|s| s.as_str()).unwrap_or("PROD");
    if env == "PROD" {
        Ok(base)
    } else {
        Ok(base.join("env").join(env))
    }
}

/// Returns the base directory for c/, t/, s/ — uses the user-chosen custom path if set.
pub(crate) fn data_dirs_base(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if let Some(state) = app.try_state::<CustomBasePath>() {
        if let Ok(guard) = state.0.lock() {
            if let Some(ref p) = *guard {
                return Ok(p.clone());
            }
        }
    }
    app_base_dir(app)
}

/// Path of the sentinel file that persists the user-chosen base dir.
fn custom_base_path_file(app: &tauri::AppHandle) -> std::path::PathBuf {
    // Must live in app_base_dir so it uses the same encryption key (.key file)
    // as accounts.dat. Using app_data_dir() here would initialise the OnceLock
    // with a different key on first read, corrupting all subsequent decryptions.
    app_base_dir(app)
        .unwrap_or_else(|_| app.path().app_data_dir().expect("app data dir unavailable"))
        .join("custom_base.dat")
}

fn read_custom_base_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    // Try the current encrypted location first.
    if let Ok(Some(s)) = storage::read::<String>(&custom_base_path_file(app)) {
        let trimmed = s.trim();
        if !trimmed.is_empty() { return Some(std::path::PathBuf::from(trimmed)); }
    }
    // Migrate from the old plaintext custom_base.txt (written by versions before encryption).
    let legacy = app.path().app_data_dir().ok()?.join("custom_base.txt");
    let s = std::fs::read_to_string(&legacy).ok()?;
    let trimmed = s.trim();
    if trimmed.is_empty() { return None; }
    let path = std::path::PathBuf::from(trimmed);
    // Persist in the new encrypted format and remove the legacy file.
    write_custom_base_path(app, Some(&path));
    let _ = std::fs::remove_file(&legacy);
    Some(path)
}

fn write_custom_base_path(app: &tauri::AppHandle, path: Option<&std::path::Path>) {
    let file = custom_base_path_file(app);
    match path {
        Some(p) => { let _ = storage::write(&file, &p.to_string_lossy().as_ref()); }
        None    => { let _ = std::fs::remove_file(&file); }
    }
}

/// Path of the sentinel file written before a move operation begins.
fn move_in_progress_file(app: &tauri::AppHandle) -> std::path::PathBuf {
    // Same reasoning as custom_base_path_file: must share the encryption key with accounts.dat.
    app_base_dir(app)
        .unwrap_or_else(|_| app.path().app_data_dir().expect("app data dir unavailable"))
        .join("move_in_progress.dat")
}

fn write_move_sentinel(app: &tauri::AppHandle, old: &std::path::Path, new: &std::path::Path) {
    let pair = (old.to_string_lossy().into_owned(), new.to_string_lossy().into_owned());
    let _ = storage::write(&move_in_progress_file(app), &pair);
}

fn clear_move_sentinel(app: &tauri::AppHandle) {
    let _ = std::fs::remove_file(move_in_progress_file(app));
}

fn read_move_sentinel(app: &tauri::AppHandle) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    let (old_s, new_s): (String, String) = storage::read(&move_in_progress_file(app)).ok().flatten()?;
    Some((std::path::PathBuf::from(old_s), std::path::PathBuf::from(new_s)))
}

pub(crate) fn accounts_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app_base_dir(app)?.join("accounts.dat"))
}

pub(crate) fn load_accounts(app: &tauri::AppHandle) -> Result<HashMap<String, StoredAccount>, String> {
    let path = accounts_path(app)?;
    match storage::read::<HashMap<String, StoredAccount>>(&path) {
        Ok(opt) => Ok(opt.unwrap_or_default()),
        Err(_) => {
            // File exists but can't be decrypted (wrong key or written by an older
            // code version). Wipe it so the app isn't permanently stuck.
            let _ = std::fs::remove_file(&path);
            Ok(HashMap::new())
        }
    }
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
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
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

pub(crate) fn now_ms() -> u64 {
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

// ── Folder cache state ────────────────────────────────────────────────────────

pub struct CacheState(pub cache::CacheDb);

/// How long a cached folder listing is considered fresh before a re-fetch is needed.
const CACHE_TTL_CLOUD_MS: i64 = 60_000;   // Google Drive and Filen
const CACHE_TTL_LOCAL_MS: i64 = 10_000;   // local file system

/// Rows older than this are purged on startup regardless of whether they are
/// reachable from a live folder (safety net for long-running orphans).
const CACHE_MAX_AGE_MS: i64 = 2 * 60 * 60 * 1_000; // 2 hours

/// Returns the parent_id that serves as the tree root for an account.
/// Root items (e.g. top-level GDrive files) are stored with this as their
/// `parent_id` but no corresponding `item_id` row ever exists in the cache,
/// so `cleanup_orphans` must know to exclude it.
fn account_root_parent_id(account: &StoredAccount) -> String {
    match account.provider.as_str() {
        "google-drive" => "root".to_string(),
        "filen" => account
            .provider_data
            .as_ref()
            .and_then(|d| d.get("baseFolderUuid"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        // Local-FS now uses relative paths; root parent is "" (empty = top-level).
        "local-fs" => String::new(),
        _ => String::new(),
    }
}

/// Resolve a validated relative local-fs path to an absolute PathBuf.
///
/// The relative path MUST use '/' as the only separator (backslash is rejected).
/// Every segment is validated before the path is built:
///   1. No whitespace characters other than the space character (U+0020).
///   2. No empty or all-space segments (rules out leading/trailing/double '/').
///   3. If a segment contains two or more '.' characters it must also contain at
///      least one character that is neither '.' nor ' ' — this blocks "..", "...",
///      ". ." and similar traversal entries while allowing "file..ext".
/// An empty `rel` (root folder) is always accepted.
fn local_fs_abs(account: &StoredAccount, rel: &str) -> Result<std::path::PathBuf, String> {
    let root = account.path.as_deref().ok_or("LocalFS account has no root path")?;
    if rel.is_empty() {
        return Ok(std::path::PathBuf::from(root));
    }
    // Backslash must never appear in the relative path sent from the frontend.
    if rel.contains('\\') {
        return Err("Invalid path: '\\' is not allowed; use '/' as the path separator".into());
    }
    let segments: Vec<&str> = rel.split('/').collect();
    for seg in &segments {
        // Rule 1: no whitespace other than the plain space character.
        if seg.chars().any(|c| c.is_whitespace() && c != ' ') {
            return Err(format!("Invalid path segment {:?}: contains non-space whitespace", seg));
        }
        // Rule 2: segment must not be empty or consist only of spaces.
        if seg.trim_matches(' ').is_empty() {
            return Err(format!("Invalid path {:?}: empty or blank segment", rel));
        }
        // Rule 3: 2+ dots → must have at least one non-dot non-space character.
        let dot_count = seg.chars().filter(|&c| c == '.').count();
        if dot_count >= 2 && !seg.chars().any(|c| c != '.' && c != ' ') {
            return Err(format!(
                "Invalid path segment {:?}: parent-directory traversal is not allowed",
                seg
            ));
        }
    }
    // Build the absolute path by pushing each validated segment individually so
    // that no separator ambiguity can arise across platforms.
    let mut path = std::path::PathBuf::from(root);
    for seg in &segments {
        path.push(seg);
    }
    Ok(path)
}

// ── Folder listing commands ───────────────────────────────────────────────────

/// List a folder, writing every item into the SQLite cache.
/// When `force` is false the cache is returned as-is if it is still within the
/// TTL for the account's provider; pass `force: true` after any write operation
/// to guarantee the view is always up to date.
#[tauri::command]
async fn list_folder(
    app: tauri::AppHandle,
    cache_state: tauri::State<'_, CacheState>,
    filen_sessions: tauri::State<'_, filen::FilenSessions>,
    account_id: String,
    parent_id: String,
    force: bool,
) -> Result<u64, String> {
    let accounts = load_accounts(&app)?;
    let account = accounts
        .get(&account_id)
        .ok_or_else(|| format!("Account '{}' not found", account_id))?
        .clone();

    let ttl_ms = match account.provider.as_str() {
        "local-fs" => CACHE_TTL_LOCAL_MS,
        _ => CACHE_TTL_CLOUD_MS,
    };

    let db = std::sync::Arc::clone(&cache_state.0);

    // When shelveset is active the local cache is the source of truth — never refresh from the network.
    if account.shelveset_active {
        let conn = db.lock().map_err(|e| e.to_string())?;
        if cache::get_folder_cached_at(&conn, &account_id, &parent_id)?.is_some() {
            return Ok(0);
        }
    }

    if !force {
        let conn = db.lock().map_err(|e| e.to_string())?;
        if let Some(cached_at) =
            cache::get_folder_cached_at(&conn, &account_id, &parent_id)?
        {
            let age_ms = now_ms() as i64 - cached_at;
            if age_ms < ttl_ms {
                return Ok(0); // cache is still fresh
            }
        }
    }

    // Clear stale rows and re-fetch from the provider.
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        cache::clear_folder(&conn, &account_id, &parent_id)?;
    }

    let total = match account.provider.as_str() {
        "google-drive" => {
            gdrive::list_to_cache(&app, &account_id, &parent_id, std::sync::Arc::clone(&db))
                .await?
        }
        "filen" => {
            let session = filen_sessions
                .0
                .lock()
                .map_err(|e| e.to_string())?
                .get(&account_id)
                .cloned()
                .ok_or_else(|| {
                    format!("No active Filen session for '{}'. Please log in again.", account_id)
                })?;
            filen::list_to_cache(
                session,
                &account_id,
                &parent_id,
                &account.email,
                std::sync::Arc::clone(&db),
            )
            .await?
        }
        "local-fs" => local_fs_list_to_cache(&account, &parent_id, std::sync::Arc::clone(&db)).await?,
        p => return Err(format!("Unknown provider '{}'", p)),
    };

    let root = account_root_parent_id(&account);

    // Populate path_index for the items we just listed.
    {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let folder_path = if parent_id == root {
            String::new()
        } else {
            cache::get_path_for_item(&conn, &account_id, &parent_id).unwrap_or_else(|| {
                let parts =
                    cache::item_path_from_root(&conn, &account_id, &parent_id, &root);
                // item_path_from_root falls back to [item_id] when not cached;
                // treat that as "unknown" so we don't store a garbage path.
                if parts.len() == 1 && parts[0] == parent_id {
                    String::new()
                } else {
                    parts.join("/")
                }
            })
        };
        // Collect (item_id, name, is_dir) for all items in this folder.
        let child_rows: Vec<(String, String, bool)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT item_id, name, is_dir FROM folder_items \
                     WHERE account_id = ?1 AND parent_id = ?2",
                )
                .map_err(|e| e.to_string())?;
            let rows: Vec<_> = stmt.query_map(params![&account_id, &parent_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i32>(2)? != 0,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
            rows
        };
        drop(conn);

        if !child_rows.is_empty() {
            let entries: Vec<(String, String, bool)> = child_rows
                .into_iter()
                .map(|(item_id, name, is_dir)| {
                    let path = if folder_path.is_empty() {
                        name
                    } else {
                        format!("{}/{}", folder_path, name)
                    };
                    (path, item_id, is_dir)
                })
                .collect();
            let mut conn = db.lock().map_err(|e| e.to_string())?;
            let _ = cache::upsert_path_index_batch(&mut conn, &account_id, &entries);
        }
    }

    // Fire-and-forget: remove cached rows whose parent_id is a folder that no
    // longer exists in the cache (grandchildren of externally-deleted folders).
    // The user should not wait for this housekeeping work.
    tauri::async_runtime::spawn(async move {
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(conn) = db.lock() {
                let _ = cache::cleanup_orphans(&conn, &account_id, &root);
            }
        })
        .await;
    });

    Ok(total)
}

/// Discard the cached listing for one folder so the next visit always goes to
/// the network, without triggering a re-fetch right now.
#[tauri::command]
fn invalidate_folder_cache(
    cache_state: tauri::State<'_, CacheState>,
    account_id: String,
    parent_id: String,
) -> Result<(), String> {
    let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
    cache::clear_folder(&conn, &account_id, &parent_id)
}

// ── Content-cache folder naming ───────────────────────────────────────────────
//
// Under {app_data}/c/ each account gets a *pair* of directories:
//   {idx}                           ← actual cache files live here (short path)
//   {idx}-{provider}-{email}-{id}   ← empty descriptor, human-readable
// where {idx} is a zero-padded 3-digit integer (000, 001, …) assigned once and
// never changed.  Finding the next free index = max(existing leading digits) + 1.

fn sanitize_path_component(s: &str) -> String {
    if s.is_empty() { return "_".to_string(); }
    s.chars()
        .map(|c| if matches!(c, '/'|'\\'|':'|'*'|'?'|'"'|'<'|'>'|'|'|'\0') { '_' } else { c })
        .collect()
}

/// Build the path for a shelved content file inside `acct_dir` by mirroring
/// the `display_path` directory structure (e.g. "docs/report.md" →
/// `acct_dir/docs/report.md`). Each component is individually sanitized.
fn shelved_content_path(acct_dir: &std::path::Path, display_path: &str) -> std::path::PathBuf {
    let mut path = acct_dir.to_path_buf();
    for component in display_path.split(['/', '\\']) {
        let trimmed = component.trim();
        if !trimmed.is_empty() {
            path.push(sanitize_path_component(trimmed));
        }
    }
    if path == acct_dir {
        // display_path was empty — fall back to a placeholder name
        path.push("_unnamed");
    }
    path
}

// Serialize all cache-dir creation so concurrent open_file / get_thumbnail calls for
// the same account never race to create duplicate pair-folders.
static CACHE_DIR_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();

/// Finds the numeric content-cache directory for `account` under `c_dir`,
/// creating it (and its descriptor sibling) if it does not exist yet.
fn account_content_cache_dir(
    c_dir: &std::path::Path,
    account: &StoredAccount,
) -> Result<std::path::PathBuf, String> {
    let _guard = CACHE_DIR_LOCK
        .get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .map_err(|e| e.to_string())?;
    // Strip the provider prefix to get a compact short ID.
    // Falls back to stripping up to the first '-' to handle cases where the
    // account ID prefix doesn't match the provider string (e.g. Google Drive
    // has provider "google-drive" but IDs start with "google-{permission_id}").
    let short_id = account.id
        .strip_prefix(&format!("{}-", account.provider))
        .or_else(|| account.id.find('-').map(|i| &account.id[i + 1..]))
        .unwrap_or(&account.id);
    // Use @@ as separator: it can never appear inside any segment (email has
    // exactly one @, provider keys and ids are alphanumeric/hyphens only).
    let descriptor_suffix = format!("@@{}@@{}@@{}", account.provider, account.email, short_id);

    // Check if an existing descriptor folder already belongs to this account.
    if c_dir.exists() {
        if let Ok(rd) = std::fs::read_dir(c_dir) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(&descriptor_suffix) && entry.path().is_dir() {
                    let digits: String = name.chars().take_while(|c| c.is_ascii_digit()).collect();
                    if !digits.is_empty() && name[digits.len()..].starts_with("@@") {
                        return Ok(c_dir.join(&digits));
                    }
                }
            }
        }
    }

    // No existing folder — pick the next free index.
    std::fs::create_dir_all(c_dir).map_err(|e| e.to_string())?;
    let next_idx: u32 = {
        let mut max: Option<u32> = None;
        if let Ok(rd) = std::fs::read_dir(c_dir) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let digits: String = name.chars().take_while(|c| c.is_ascii_digit()).collect();
                if !digits.is_empty() {
                    if let Ok(n) = digits.parse::<u32>() {
                        max = Some(max.map_or(n, |m| m.max(n)));
                    }
                }
            }
        }
        max.map_or(1, |m| m + 1)
    };

    let idx = format!("{:03}", next_idx);
    let content_dir = c_dir.join(&idx);
    let descriptor_dir = c_dir.join(format!("{}{}", idx, descriptor_suffix));
    std::fs::create_dir_all(&content_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&descriptor_dir).map_err(|e| e.to_string())?;
    Ok(content_dir)
}

/// Finds the numeric content-cache directory for an account *without* creating
/// one — used by cleanup paths where we don't want a side-effect creation.
fn find_account_cache_dir(c_dir: &std::path::Path, account: &StoredAccount) -> Option<std::path::PathBuf> {
    let short_id = account.id
        .strip_prefix(&format!("{}-", account.provider))
        .or_else(|| account.id.find('-').map(|i| &account.id[i + 1..]))
        .unwrap_or(&account.id);
    let descriptor_suffix = format!("@@{}@@{}@@{}", account.provider, account.email, short_id);
    if !c_dir.exists() { return None; }
    for entry in std::fs::read_dir(c_dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(&descriptor_suffix) && entry.path().is_dir() {
            let digits: String = name.chars().take_while(|c| c.is_ascii_digit()).collect();
            if !digits.is_empty() && name[digits.len()..].starts_with("@@") {
                return Some(c_dir.join(&digits));
            }
        }
    }
    None
}

/// Shared inner logic for resolving a file to a local path, used by both
/// `open_file` and `get_thumbnail`.
async fn open_file_inner(
    app: &tauri::AppHandle,
    filen_sessions: &filen::FilenSessions,
    cache_db: &cache::CacheDb,
    account: &StoredAccount,
    item_id: &str,
    force: bool,
) -> Result<String, String> {
    if account.provider == "local-fs" {
        // item_id is a relative path; resolve to absolute for the caller.
        return Ok(local_fs_abs(account, item_id)?.to_string_lossy().into_owned());
    }

    let c_dir = data_dirs_base(app)?.join("c");
    let acct_dir = account_content_cache_dir(&c_dir, account)?;

    let known_rel = {
        let conn = cache_db.lock().map_err(|e| e.to_string())?;
        cache::get_content_cache_path(&conn, &account.id, item_id)
    };
    if let Some(ref rel) = known_rel {
        let existing = acct_dir.join(rel);
        if !force && existing.exists() {
            return Ok(existing.to_string_lossy().into_owned());
        }
    }

    let root_parent = account_root_parent_id(account);
    let path_parts = {
        let conn = cache_db.lock().map_err(|e| e.to_string())?;
        cache::item_path_from_root(&conn, &account.id, item_id, &root_parent)
    };

    let rel: std::path::PathBuf = path_parts.iter().map(|p| sanitize_path_component(p)).collect();
    let cache_path = acct_dir.join(&rel);

    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let dest = cache_path.to_string_lossy().into_owned();

    match account.provider.as_str() {
        "google-drive" => gdrive::download_to_path(app, &account.id, item_id, &dest).await?,
        "filen" => {
            let session = filen_sessions
                .0.lock().map_err(|e| e.to_string())?
                .get(&account.id).cloned()
                .ok_or_else(|| format!("No active Filen session for '{}'", account.id))?;
            filen::download_to_path(session, item_id, &dest, app).await?;
        }
        p => return Err(format!("Unsupported provider '{}'", p)),
    }

    let rel_str = rel.to_string_lossy();
    {
        let conn = cache_db.lock().map_err(|e| e.to_string())?;
        let _ = cache::set_content_cache_path(&conn, &account.id, item_id, &rel_str);
    }

    Ok(dest)
}

/// Open a file for viewing: returns the local filesystem path to the file content.
/// For cloud providers the file is downloaded into a persistent content cache.
/// For local-fs the original path is returned directly.
/// Pass `force = true` to force a fresh download even when the cache file already exists.
#[tauri::command]
async fn open_file(
    app: tauri::AppHandle,
    filen_sessions: tauri::State<'_, filen::FilenSessions>,
    cache_state: tauri::State<'_, CacheState>,
    account_id: String,
    item_id: String,
    force: bool,
) -> Result<String, String> {
    let accounts = load_accounts(&app)?;
    let account = accounts
        .get(&account_id)
        .ok_or_else(|| format!("Account '{}' not found", account_id))?
        .clone();
    open_file_inner(&app, &filen_sessions, &cache_state.0, &account, &item_id, force).await
}

/// Resolve the thumbnail cache path for an item, mirroring its relative path
/// within the account's drive (same pair-folder scheme as the `c/` content cache).
fn thumbnail_path_for_item(
    t_dir: &std::path::Path,
    account: &StoredAccount,
    item_id: &str,
    cache_db: &cache::CacheDb,
) -> Result<std::path::PathBuf, String> {
    let acct_dir = account_content_cache_dir(t_dir, account)?;

    let rel: std::path::PathBuf = if account.provider == "local-fs" {
        // item_id is already a relative path; just split and sanitize each segment.
        item_id
            .split(['/', '\\'])
            .filter(|s| !s.is_empty())
            .map(sanitize_path_component)
            .collect()
    } else {
        let root_parent = account_root_parent_id(account);
        let parts = {
            let conn = cache_db.lock().map_err(|e| e.to_string())?;
            cache::item_path_from_root(&conn, &account.id, item_id, &root_parent)
        };
        parts.iter().map(|p| sanitize_path_component(p)).collect()
    };

    let full_path = acct_dir.join(&rel);
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(full_path)
}

fn create_thumbnail_file(src_path: &str, dest_path: &std::path::Path) -> Result<(), String> {
    let img = image::open(src_path).map_err(|e| format!("Cannot read image: {}", e))?;
    img.thumbnail(256, 256)
        .save_with_format(dest_path, image::ImageFormat::Jpeg)
        .map_err(|e| format!("Cannot save thumbnail: {}", e))
}

/// Return the local path of a 256×256 JPEG thumbnail for the given item.
/// Creates and caches the thumbnail on first call; subsequent calls return the
/// cached path immediately without re-downloading or re-encoding.
#[tauri::command]
async fn get_thumbnail(
    app: tauri::AppHandle,
    filen_sessions: tauri::State<'_, filen::FilenSessions>,
    cache_state: tauri::State<'_, CacheState>,
    account_id: String,
    item_id: String,
) -> Result<String, String> {
    let accounts = load_accounts(&app)?;
    let account = accounts
        .get(&account_id)
        .ok_or_else(|| format!("Account '{}' not found", account_id))?
        .clone();

    let t_dir = data_dirs_base(&app)?.join("t");
    let thumb_path = thumbnail_path_for_item(&t_dir, &account, &item_id, &cache_state.0)?;

    if thumb_path.exists() {
        return Ok(thumb_path.to_string_lossy().into_owned());
    }

    let file_path = open_file_inner(&app, &filen_sessions, &cache_state.0, &account, &item_id, false).await?;
    create_thumbnail_file(&file_path, &thumb_path)?;
    Ok(thumb_path.to_string_lossy().into_owned())
}

/// Save edited text-file content back to the provider and update the local cache.
/// Takes the content as a UTF-8 string so no file path crosses the IPC boundary.
/// Returns the effective item ID after upload: unchanged for GDrive/LocalFS, but a
/// *new* UUID for Filen because Filen creates a new file on every overwrite.
#[tauri::command]
async fn save_text_file(
    app: tauri::AppHandle,
    filen_sessions: tauri::State<'_, filen::FilenSessions>,
    cache_state: tauri::State<'_, CacheState>,
    account_id: String,
    item_id: String,
    parent_id: String,
    content: String,
) -> Result<String, String> {
    let bytes = content.into_bytes();
    let accounts = load_accounts(&app)?;
    let account = accounts
        .get(&account_id)
        .ok_or_else(|| format!("Account '{}' not found", account_id))?
        .clone();

    // LocalFS: resolve relative item_id to absolute and write directly.
    if account.provider == "local-fs" {
        let abs_path = local_fs_abs(&account, &item_id)?;
        tokio::fs::write(&abs_path, &bytes).await.map_err(|e| e.to_string())?;
        return Ok(item_id); // return relative path unchanged
    }

    // Cloud: write to cache then upload.
    let c_dir = data_dirs_base(&app)?.join("c");
    let acct_dir = account_content_cache_dir(&c_dir, &account)?;
    // Use the persistent content-cache index first so path is stable across restarts.
    let rel_str: String = {
        let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
        if let Some(r) = cache::get_content_cache_path(&conn, &account_id, &item_id) {
            r
        } else {
            let root_parent = account_root_parent_id(&account);
            let parts = cache::item_path_from_root(&conn, &account_id, &item_id, &root_parent);
            let p: std::path::PathBuf = parts.iter().map(|s| sanitize_path_component(s)).collect();
            p.to_string_lossy().into_owned()
        }
    };
    let cache_path = acct_dir.join(&rel_str);
    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    tokio::fs::write(&cache_path, &bytes).await.map_err(|e| e.to_string())?;

    let name = std::path::Path::new(&rel_str)
        .file_name().and_then(|n| n.to_str()).unwrap_or(&rel_str);

    let new_item_id = match account.provider.as_str() {
        "google-drive" => {
            gdrive::edit_bytes(&app, &account_id, &item_id, &bytes, name).await?;
            {
                let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
                let _ = cache::set_content_cache_path(&conn, &account_id, &item_id, &rel_str);
            }
            item_id
        }
        "filen" => {
            let session = filen_sessions
                .0.lock().map_err(|e| e.to_string())?
                .get(&account_id).cloned()
                .ok_or_else(|| format!("No Filen session for '{}'", account_id))?;
            let new_uuid = filen::overwrite_bytes(session, &item_id, &parent_id, &bytes, &app).await?;
            // Old UUID is now trashed; re-key the content-cache entry to the new UUID
            // so future open_file calls hit the correct file.
            {
                let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
                let _ = cache::delete_content_cache_entry(&conn, &account_id, &item_id);
                let _ = cache::set_content_cache_path(&conn, &account_id, &new_uuid, &rel_str);
            }
            new_uuid
        }
        p => return Err(format!("Unsupported provider '{}'", p)),
    };

    Ok(new_item_id)
}

/// Create a new text file in the given parent folder. Returns the new file's item ID.
#[tauri::command]
async fn create_text_file(
    app: tauri::AppHandle,
    filen_sessions: tauri::State<'_, filen::FilenSessions>,
    account_id: String,
    parent_id: String,
    filename: String,
    content: String,
) -> Result<String, String> {
    let bytes = content.into_bytes();
    let accounts = load_accounts(&app)?;
    let account = accounts
        .get(&account_id)
        .ok_or_else(|| format!("Account '{}' not found", account_id))?
        .clone();

    match account.provider.as_str() {
        "local-fs" => {
            let abs_parent = local_fs_abs(&account, &parent_id)?;
            let abs_path = abs_parent.join(&filename);
            tokio::fs::write(&abs_path, &bytes).await.map_err(|e| e.to_string())?;
            // Return relative path (parent/filename), using '/' as separator.
            let rel = if parent_id.is_empty() {
                filename
            } else {
                format!("{}/{}", parent_id, filename)
            };
            Ok(rel)
        }
        "filen" => {
            let session = filen_sessions
                .0.lock().map_err(|e| e.to_string())?
                .get(&account_id).cloned()
                .ok_or_else(|| format!("No Filen session for '{}'", account_id))?;
            filen::upload_file_bytes(session, &parent_id, &filename, &bytes).await
        }
        "google-drive" => {
            gdrive::upload_bytes(&app, &account_id, &parent_id, &filename, &bytes).await
        }
        p => Err(format!("Unsupported provider '{}'", p)),
    }
}

/// Delete the cached file content for one item and remove it from the index.
#[tauri::command]
fn delete_cached_file(
    app: tauri::AppHandle,
    cache_state: tauri::State<'_, CacheState>,
    account_id: String,
    item_id: String,
) -> Result<(), String> {
    let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
    if let Some(rel) = cache::get_content_cache_path(&conn, &account_id, &item_id) {
        if let (Ok(c_dir), Ok(accounts)) = (
            data_dirs_base(&app).map(|d| d.join("c")),
            load_accounts(&app),
        ) {
            if let Some(account) = accounts.get(&account_id) {
                if let Ok(acct_dir) = account_content_cache_dir(&c_dir, account) {
                    let _ = std::fs::remove_file(acct_dir.join(&rel));
                }
            }
        }
        let _ = cache::delete_content_cache_entry(&conn, &account_id, &item_id);
    }
    Ok(())
}

/// Remove an item and all its cached descendants after a client-side delete.
#[tauri::command]
fn uncache_item(
    app: tauri::AppHandle,
    cache_state: tauri::State<'_, CacheState>,
    account_id: String,
    item_id: String,
) -> Result<(), String> {
    let conn = cache_state.0.lock().map_err(|e| e.to_string())?;

    // Best-effort: delete the content-cache file before wiping the SQLite row
    // (path reconstruction needs the row to still exist).
    if let Ok(accounts) = load_accounts(&app) {
        if let Some(account) = accounts.get(&account_id) {
            if account.provider != "local-fs" {
                if let Ok(c_dir) = data_dirs_base(&app).map(|d| d.join("c")) {
                    if let Some(acct_dir) = find_account_cache_dir(&c_dir, account) {
                        let root = account_root_parent_id(account);
                        let parts = cache::item_path_from_root(&conn, &account_id, &item_id, &root);
                        if !parts.is_empty() {
                            let rel: std::path::PathBuf =
                                parts.iter().map(|p| sanitize_path_component(p)).collect();
                            let _ = std::fs::remove_file(acct_dir.join(rel));
                        }
                    }
                }
            }
        }
    }

    let _ = cache::delete_content_cache_entry(&conn, &account_id, &item_id);
    cache::cascade_delete_item(&conn, &account_id, &item_id)
}

/// Update the name of a single cached item after a client-side rename.
/// Keeps the rest of the folder's cached rows intact.
#[tauri::command]
fn rename_cached_item(
    cache_state: tauri::State<'_, CacheState>,
    account_id: String,
    item_id: String,
    new_name: String,
) -> Result<(), String> {
    let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
    cache::rename_item(&conn, &account_id, &item_id, &new_name)
}

/// Queries the SQLite cache for one page of a folder's contents.
/// `sort_by` accepts `"name"`, `"size"`, or `"modified"`.
/// `page` is 0-indexed; `page_size` is the number of rows per page.
/// Returns `{ items, total }` where `total` is the full match count across all pages.
#[tauri::command]
async fn query_folder_items(
    cache_state: tauri::State<'_, CacheState>,
    account_id: String,
    parent_id: String,
    search: Option<String>,
    sort_by: String,
    ascending: bool,
    page: u32,
    page_size: u32,
) -> Result<cache::FolderPage, String> {
    let db = std::sync::Arc::clone(&cache_state.0);
    tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| e.to_string())?;
        cache::query_items_paged(
            &conn,
            &account_id,
            &parent_id,
            search.as_deref(),
            &sort_by,
            ascending,
            page,
            page_size,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Shelveset commands ────────────────────────────────────────────────────────

fn generate_local_id() -> String {
    let mut bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("shv-{}", URL_SAFE_NO_PAD.encode(bytes))
}

/// Activate the shelveset for an account (freezes network refreshes, buffers writes).
#[tauri::command]
fn shelveset_activate(app: tauri::AppHandle, account_id: String) -> Result<(), String> {
    let mut accounts = load_accounts(&app)?;
    let account = accounts.get_mut(&account_id)
        .ok_or_else(|| format!("Account '{}' not found", account_id))?;
    account.shelveset_active = true;
    storage::write(&accounts_path(&app)?, &accounts)
}

/// Record a structural change (delete / rename / move) on an existing item.
#[tauri::command]
fn shelveset_record_change(
    cache_state: tauri::State<'_, CacheState>,
    account_id: String,
    operation: String,
    item_id: String,
    item_name: String,
    parent_id: String,
    new_name: Option<String>,
    new_parent_id: Option<String>,
    is_dir: bool,
    display_path: String,
) -> Result<i64, String> {
    let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO shelveset_changes
         (account_id, operation, item_id, item_name, parent_id, new_name, new_parent_id, is_dir, created_at, display_path)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        rusqlite::params![account_id, operation, item_id, item_name, parent_id,
            new_name, new_parent_id, is_dir as i32, now_ms() as i64, display_path],
    ).map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

/// Save file content to the s/ folder and register in shelveset_contents.
#[tauri::command]
async fn shelveset_save_content(
    app: tauri::AppHandle,
    cache_state: tauri::State<'_, CacheState>,
    account_id: String,
    item_id: String,
    item_name: String,
    parent_id: String,
    is_dir: bool,
    is_new: bool,
    display_path: String,
    content: Option<String>,
) -> Result<(), String> {
    if let Some(text) = content {
        let accounts = load_accounts(&app)?;
        let account = accounts.get(&account_id)
            .ok_or_else(|| format!("Account '{}' not found", account_id))?
            .clone();
        let s_dir = data_dirs_base(&app)?.join("s");
        let acct_dir = account_content_cache_dir(&s_dir, &account)?;
        let file_path = shelved_content_path(&acct_dir, &display_path);
        if let Some(parent) = file_path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
        tokio::fs::write(&file_path, text.as_bytes()).await.map_err(|e| e.to_string())?;
    }
    let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO shelveset_contents
         (account_id, item_id, item_name, parent_id, is_dir, is_new, created_at, display_path)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        rusqlite::params![account_id, item_id, item_name, parent_id,
            is_dir as i32, is_new as i32, now_ms() as i64, display_path],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Copy an arbitrary file from `local_path` into the s/ folder for this account,
/// then register it in shelveset_contents. Used for binary / non-text files.
#[tauri::command]
async fn shelveset_save_file_path(
    app: tauri::AppHandle,
    cache_state: tauri::State<'_, CacheState>,
    account_id: String,
    item_id: String,
    item_name: String,
    parent_id: String,
    is_new: bool,
    display_path: String,
    local_path: String,
) -> Result<(), String> {
    let accounts = load_accounts(&app)?;
    let account = accounts.get(&account_id)
        .ok_or_else(|| format!("Account '{}' not found", account_id))?
        .clone();
    let s_dir = data_dirs_base(&app)?.join("s");
    let acct_dir = account_content_cache_dir(&s_dir, &account)?;
    let dest = shelved_content_path(&acct_dir, &display_path);
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    tokio::fs::copy(&local_path, &dest).await.map_err(|e| e.to_string())?;
    let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO shelveset_contents
         (account_id, item_id, item_name, parent_id, is_dir, is_new, created_at, display_path)
         VALUES (?1,?2,?3,?4,0,?5,?6,?7)",
        rusqlite::params![account_id, item_id, item_name, parent_id,
            is_new as i32, now_ms() as i64, display_path],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Create a brand-new item locally (no provider API call). Returns a local "shv-…" ID.
#[tauri::command]
async fn shelveset_create_item(
    app: tauri::AppHandle,
    cache_state: tauri::State<'_, CacheState>,
    account_id: String,
    parent_id: String,
    item_name: String,
    is_dir: bool,
    display_path: String,
    content: Option<String>,
) -> Result<String, String> {
    let local_id = generate_local_id();
    // Write file body to s/
    if let Some(text) = content {
        let accounts = load_accounts(&app)?;
        let account = accounts.get(&account_id)
            .ok_or_else(|| format!("Account '{}' not found", account_id))?
            .clone();
        let s_dir = data_dirs_base(&app)?.join("s");
        let acct_dir = account_content_cache_dir(&s_dir, &account)?;
        let file_path = shelved_content_path(&acct_dir, &display_path);
        if let Some(parent) = file_path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
        tokio::fs::write(&file_path, text.as_bytes()).await.map_err(|e| e.to_string())?;
    }
    // Register in shelveset_contents
    {
        let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO shelveset_contents
             (account_id, item_id, item_name, parent_id, is_dir, is_new, created_at, display_path)
             VALUES (?1,?2,?3,?4,?5,1,?6,?7)",
            rusqlite::params![account_id, local_id, item_name, parent_id,
                is_dir as i32, now_ms() as i64, display_path],
        ).map_err(|e| e.to_string())?;
    }
    // Inject a fake row into folder_items so the explorer shows the new item immediately.
    let accounts = load_accounts(&app)?;
    let account = accounts.get(&account_id)
        .ok_or_else(|| format!("Account '{}' not found", account_id))?
        .clone();
    let storage_type = match account.provider.as_str() {
        "google-drive" => cache::STORAGE_GOOGLE_DRIVE,
        "filen"        => cache::STORAGE_FILEN,
        _              => cache::STORAGE_LOCAL_FS,
    };
    let new_item = cache::CachedItem {
        account_id: account_id.clone(),
        account_email: account.email.clone(),
        storage_type,
        item_id: local_id.clone(),
        parent_id,
        name: item_name,
        is_dir,
        size: if is_dir { None } else { Some(0) },
        modified_ms: Some(now_ms() as i64),
        mime_type: if is_dir { None } else { Some("text/plain".to_string()) },
    };
    {
        let mut conn = cache_state.0.lock().map_err(|e| e.to_string())?;
        let _ = cache::insert_batch(&mut *conn, &[new_item]);
    }
    Ok(local_id)
}

/// Return the path to the shelved copy of a file (in s/), or None if not shelved.
#[tauri::command]
fn shelveset_get_content_path(
    app: tauri::AppHandle,
    cache_state: tauri::State<'_, CacheState>,
    account_id: String,
    item_id: String,
) -> Result<Option<String>, String> {
    let accounts = load_accounts(&app)?;
    let account = match accounts.get(&account_id) {
        Some(a) if a.shelveset_active => a.clone(),
        _ => return Ok(None),
    };
    let s_dir = data_dirs_base(&app)?.join("s");
    let acct_dir = match find_account_cache_dir(&s_dir, &account) {
        Some(d) => d,
        None => return Ok(None),
    };
    let display_path: String = {
        let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
        match conn.query_row(
            "SELECT display_path FROM shelveset_contents WHERE account_id=?1 AND item_id=?2",
            rusqlite::params![account_id, item_id],
            |r| r.get::<_, String>(0),
        ).optional().map_err(|e| e.to_string())? {
            Some(dp) => dp,
            None => return Ok(None),
        }
    };
    let p = shelved_content_path(&acct_dir, &display_path);
    Ok(if p.exists() { Some(p.to_string_lossy().into_owned()) } else { None })
}

/// Return all pending shelveset changes (structural + content) for an account.
#[tauri::command]
fn shelveset_get_all_changes(
    cache_state: tauri::State<'_, CacheState>,
    account_id: String,
) -> Result<ShelvesetAllChanges, String> {
    let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
    let mut s = conn.prepare(
        "SELECT id,account_id,operation,item_id,item_name,parent_id,new_name,new_parent_id,is_dir,created_at,display_path
         FROM shelveset_changes WHERE account_id=?1 ORDER BY display_path ASC",
    ).map_err(|e| e.to_string())?;
    let structural: Vec<ShelvesetChange> = s.query_map(rusqlite::params![account_id], |r| Ok(ShelvesetChange {
        id: r.get(0)?, account_id: r.get(1)?, operation: r.get(2)?,
        item_id: r.get(3)?, item_name: r.get(4)?, parent_id: r.get(5)?,
        new_name: r.get(6)?, new_parent_id: r.get(7)?,
        is_dir: r.get::<_,i32>(8)? != 0, created_at: r.get(9)?, display_path: r.get(10)?,
    })).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    let mut c = conn.prepare(
        "SELECT id,account_id,item_id,item_name,parent_id,is_dir,is_new,created_at,display_path
         FROM shelveset_contents WHERE account_id=?1 ORDER BY display_path ASC",
    ).map_err(|e| e.to_string())?;
    let content: Vec<ShelvesetContentItem> = c.query_map(rusqlite::params![account_id], |r| Ok(ShelvesetContentItem {
        id: r.get(0)?, account_id: r.get(1)?, item_id: r.get(2)?,
        item_name: r.get(3)?, parent_id: r.get(4)?,
        is_dir: r.get::<_,i32>(5)? != 0, is_new: r.get::<_,i32>(6)? != 0,
        created_at: r.get(7)?, display_path: r.get(8)?,
    })).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
    Ok(ShelvesetAllChanges { structural, content })
}

/// Remove a single structural change (undo a pending delete/rename/move).
#[tauri::command]
fn shelveset_undo_structural(cache_state: tauri::State<'_, CacheState>, id: i64) -> Result<(), String> {
    let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM shelveset_changes WHERE id=?1", rusqlite::params![id])
        .map(|_| ()).map_err(|e| e.to_string())
}

/// Remove a content change and delete its s/ file (undo a pending file edit or creation).
#[tauri::command]
async fn shelveset_undo_content(
    app: tauri::AppHandle,
    cache_state: tauri::State<'_, CacheState>,
    id: i64,
    account_id: String,
    item_id: String,
    is_new: bool,
) -> Result<(), String> {
    // Read display_path before deleting the DB row so we can locate the file.
    let display_path: Option<String> = {
        let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT display_path FROM shelveset_contents WHERE id=?1",
            rusqlite::params![id],
            |r| r.get(0),
        ).optional().map_err(|e| e.to_string())?
    };
    let accounts = load_accounts(&app)?;
    if let (Some(account), Some(dp)) = (accounts.get(&account_id), display_path) {
        let s_dir = data_dirs_base(&app)?.join("s");
        if let Some(d) = find_account_cache_dir(&s_dir, account) {
            let _ = tokio::fs::remove_file(shelved_content_path(&d, &dp)).await;
        }
    }
    let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM shelveset_contents WHERE id=?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    // If the item was new, remove it from the folder_items cache too
    if is_new {
        let _ = conn.execute(
            "DELETE FROM folder_items WHERE account_id=?1 AND item_id=?2",
            rusqlite::params![account_id, item_id],
        );
    }
    Ok(())
}

/// Discard the entire shelveset: clear all pending changes, delete s/ files, deactivate.
#[tauri::command]
async fn shelveset_discard(
    app: tauri::AppHandle,
    cache_state: tauri::State<'_, CacheState>,
    account_id: String,
) -> Result<(), String> {
    // Collect new item_ids before clearing so we can remove them from the folder cache
    let new_ids: Vec<String> = {
        let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
        let mut st = conn.prepare(
            "SELECT item_id FROM shelveset_contents WHERE account_id=?1 AND is_new=1"
        ).map_err(|e| e.to_string())?;
        let ids: Vec<String> = st.query_map(rusqlite::params![account_id], |r| r.get(0))
            .map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
        ids
    };
    // Clear DB rows
    {
        let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM shelveset_changes WHERE account_id=?1", rusqlite::params![account_id]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM shelveset_contents WHERE account_id=?1", rusqlite::params![account_id]).map_err(|e| e.to_string())?;
        // Remove new ghost items from folder cache
        for id in &new_ids {
            let _ = conn.execute("DELETE FROM folder_items WHERE account_id=?1 AND item_id=?2", rusqlite::params![account_id, id]);
        }
    }
    // Remove s/ files for account
    let accounts = load_accounts(&app)?;
    if let Some(account) = accounts.get(&account_id) {
        let s_dir = data_dirs_base(&app)?.join("s");
        if let Some(acct_dir) = find_account_cache_dir(&s_dir, account) {
            let _ = std::fs::remove_dir_all(&acct_dir);
        }
    }
    // Deactivate
    let mut accounts = load_accounts(&app)?;
    if let Some(a) = accounts.get_mut(&account_id) { a.shelveset_active = false; }
    storage::write(&accounts_path(&app)?, &accounts)
}

/// Update the parent_id of a cached item (used after a shelved move).
#[tauri::command]
fn move_cached_item(
    cache_state: tauri::State<'_, CacheState>,
    account_id: String,
    item_id: String,
    new_parent_id: String,
) -> Result<(), String> {
    let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE folder_items SET parent_id=?1 WHERE account_id=?2 AND item_id=?3",
        rusqlite::params![new_parent_id, account_id, item_id],
    ).map(|_| ()).map_err(|e| e.to_string())
}

/// Delete all cached content (folder listings + content cache files) for an account.
#[tauri::command]
async fn delete_account_cache(
    app: tauri::AppHandle,
    cache_state: tauri::State<'_, CacheState>,
    account_id: String,
) -> Result<(), String> {
    {
        let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM folder_items WHERE account_id=?1", rusqlite::params![account_id]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM content_cache WHERE account_id=?1", rusqlite::params![account_id]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM path_index WHERE account_id=?1", rusqlite::params![account_id]).map_err(|e| e.to_string())?;
    }
    let accounts = load_accounts(&app)?;
    if let Some(account) = accounts.get(&account_id) {
        let c_dir = data_dirs_base(&app)?.join("c");
        if let Some(d) = find_account_cache_dir(&c_dir, account) {
            let _ = std::fs::remove_dir_all(&d);
        }
        let t_dir = data_dirs_base(&app)?.join("t");
        if let Some(d) = find_account_cache_dir(&t_dir, account) {
            let _ = std::fs::remove_dir_all(&d);
        }
    }
    Ok(())
}

/// Delete all app-specific data for an account (cache + shelveset), keeping it connected.
#[tauri::command]
async fn delete_account_app_data(
    app: tauri::AppHandle,
    cache_state: tauri::State<'_, CacheState>,
    account_id: String,
) -> Result<(), String> {
    delete_account_cache(app.clone(), cache_state.clone(), account_id.clone()).await?;
    shelveset_discard(app, cache_state, account_id).await
}

// ── Per-item conflict metadata ────────────────────────────────────────────────

/// Returns the `modified_ms` timestamp we have cached for an item, or `null` if unknown.
#[tauri::command]
fn get_item_cached_mtime(
    cache_state: tauri::State<'_, CacheState>,
    account_id: String,
    item_id: String,
) -> Result<Option<i64>, String> {
    let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
    let ms: Option<i64> = conn.query_row(
        "SELECT modified_ms FROM folder_items WHERE account_id=?1 AND item_id=?2",
        rusqlite::params![account_id, item_id],
        |r| r.get(0),
    ).ok().flatten();
    Ok(ms)
}

// ── Data-dirs move commands ───────────────────────────────────────────────────

#[tauri::command]
fn get_data_dirs_info(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let current = data_dirs_base(&app)?;
    let default = app_base_dir(&app)?;
    Ok(serde_json::json!({
        "current": current.to_string_lossy(),
        "default": default.to_string_lossy(),
        "isCustom": current != default,
    }))
}

#[tauri::command]
fn validate_new_data_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let new_path = std::path::PathBuf::from(&path);
    if !new_path.exists()  { return Err(format!("Path does not exist: {}", path)); }
    if !new_path.is_dir()  { return Err(format!("Not a directory: {}", path)); }

    // Must not be inside $appData.
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if new_path.starts_with(&app_data) {
        return Err("Cannot use a folder inside the app data directory.".into());
    }

    // Must not be a known system directory (Windows).
    #[cfg(target_os = "windows")]
    {
        let sys_roots = [
            "C:\\Windows",
            "C:\\Program Files",
            "C:\\Program Files (x86)",
            "C:\\ProgramData",
        ];
        for root in sys_roots {
            let rp = std::path::PathBuf::from(root);
            if new_path == rp || new_path.starts_with(&rp) {
                return Err(format!("Cannot use a system folder: {}", root));
            }
        }
    }

    // Must not already be the current data dir.
    if new_path == data_dirs_base(&app)? {
        return Err("This is already the current data folder.".into());
    }
    Ok(())
}

#[tauri::command]
fn is_move_in_progress() -> bool {
    MOVE_IN_PROGRESS.load(Ordering::SeqCst)
}

#[tauri::command]
fn cancel_move_data_dirs() {
    MOVE_CANCELLED.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn get_interrupted_move_info(app: tauri::AppHandle) -> Option<serde_json::Value> {
    let state = app.try_state::<MoveInterruptedInfo>()?;
    let guard = state.0.lock().ok()?;
    let (ref old, ref new) = *guard.as_ref()?;
    Some(serde_json::json!({"old": old.to_string_lossy(), "new": new.to_string_lossy()}))
}

#[tauri::command]
fn cleanup_interrupted_move(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<MoveInterruptedInfo>() {
        if let Ok(guard) = state.0.lock() {
            if let Some((ref old, _)) = *guard {
                for dir in ["c", "t", "s"] {
                    let _ = std::fs::remove_dir_all(old.join(dir));
                }
            }
        }
    }
    clear_move_sentinel(&app);
    Ok(())
}

fn count_files_recursive(dir: &std::path::Path) -> u64 {
    if !dir.exists() { return 0; }
    let mut n = 0u64;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            if entry.path().is_dir() { n += count_files_recursive(&entry.path()); }
            else { n += 1; }
        }
    }
    n
}

fn copy_dir_sync(
    src: &std::path::Path,
    dst: &std::path::Path,
    app: &tauri::AppHandle,
    copied: &std::sync::Arc<std::sync::atomic::AtomicU64>,
    total: u64,
) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let rd = std::fs::read_dir(src).map_err(|e| e.to_string())?;
    for entry in rd.flatten() {
        if MOVE_CANCELLED.load(Ordering::SeqCst) { return Ok(()); }
        let sp = entry.path();
        let dp = dst.join(entry.file_name());
        if sp.is_dir() {
            copy_dir_sync(&sp, &dp, app, copied, total)?;
        } else {
            std::fs::copy(&sp, &dp).map_err(|e| e.to_string())?;
            let n = copied.fetch_add(1, Ordering::Relaxed) + 1;
            let _ = app.emit("data-dirs-move-progress",
                serde_json::json!({ "copied": n, "total": total }));
        }
    }
    Ok(())
}

#[tauri::command]
async fn start_move_data_dirs(app: tauri::AppHandle, new_path: String) -> Result<(), String> {
    validate_new_data_dir(app.clone(), new_path.clone())?;

    let old_base = data_dirs_base(&app)?;
    let new_base = std::path::PathBuf::from(&new_path);

    MOVE_CANCELLED.store(false, Ordering::SeqCst);
    MOVE_IN_PROGRESS.store(true, Ordering::SeqCst);
    write_move_sentinel(&app, &old_base, &new_base);
    let _ = app.emit("data-dirs-move-started", ());

    let total: u64 = ["c","t","s"].iter()
        .map(|d| count_files_recursive(&old_base.join(d)))
        .sum();

    let copied = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));

    // Copy all three dirs inside a single spawn_blocking call.
    let result = {
        let old = old_base.clone();
        let new = new_base.clone();
        let app2 = app.clone();
        let ctr = std::sync::Arc::clone(&copied);
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            for dir in ["c","t","s"] {
                let src = old.join(dir);
                if !src.exists() { continue; }
                copy_dir_sync(&src, &new.join(dir), &app2, &ctr, total)?;
                if MOVE_CANCELLED.load(Ordering::SeqCst) { return Ok(()); }
            }
            Ok(())
        }).await.map_err(|e| e.to_string())?
    };

    if MOVE_CANCELLED.load(Ordering::SeqCst) || result.is_err() {
        for d in ["c","t","s"] { let _ = std::fs::remove_dir_all(new_base.join(d)); }
        MOVE_IN_PROGRESS.store(false, Ordering::SeqCst);
        clear_move_sentinel(&app);
        let _ = app.emit("data-dirs-move-cancelled", ());
        return result;
    }

    // Remove originals.
    for dir in ["c","t","s"] {
        let _ = std::fs::remove_dir_all(old_base.join(dir));
    }

    // Persist and update in-memory state; grant fs scope for the new location.
    write_custom_base_path(&app, Some(&new_base));
    let _ = app.fs_scope().allow_directory(&new_base, true);
    if let Some(state) = app.try_state::<CustomBasePath>() {
        if let Ok(mut g) = state.0.lock() { *g = Some(new_base); }
    }
    if let Some(state) = app.try_state::<MoveInterruptedInfo>() {
        if let Ok(mut g) = state.0.lock() { *g = None; }
    }

    MOVE_IN_PROGRESS.store(false, Ordering::SeqCst);
    clear_move_sentinel(&app);
    let _ = app.emit("data-dirs-move-done", ());
    Ok(())
}

/// Move c/, t/, s/ back to the default app_base_dir and clear the custom path.
/// Bypasses the validation that rejects the app_data_dir location.
#[tauri::command]
async fn reset_data_dirs_to_default(app: tauri::AppHandle) -> Result<(), String> {
    let old_base = data_dirs_base(&app)?;
    let new_base = app_base_dir(&app)?;

    if old_base == new_base {
        return Ok(()); // already at default, nothing to do
    }

    MOVE_CANCELLED.store(false, Ordering::SeqCst);
    MOVE_IN_PROGRESS.store(true, Ordering::SeqCst);
    write_move_sentinel(&app, &old_base, &new_base);
    let _ = app.emit("data-dirs-move-started", ());

    let total: u64 = ["c","t","s"].iter()
        .map(|d| count_files_recursive(&old_base.join(d)))
        .sum();
    let copied = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));

    let result = {
        let old = old_base.clone();
        let new = new_base.clone();
        let app2 = app.clone();
        let ctr = std::sync::Arc::clone(&copied);
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            for dir in ["c","t","s"] {
                let src = old.join(dir);
                if !src.exists() { continue; }
                copy_dir_sync(&src, &new.join(dir), &app2, &ctr, total)?;
                if MOVE_CANCELLED.load(Ordering::SeqCst) { return Ok(()); }
            }
            Ok(())
        }).await.map_err(|e| e.to_string())?
    };

    if MOVE_CANCELLED.load(Ordering::SeqCst) || result.is_err() {
        for d in ["c","t","s"] { let _ = std::fs::remove_dir_all(new_base.join(d)); }
        MOVE_IN_PROGRESS.store(false, Ordering::SeqCst);
        clear_move_sentinel(&app);
        let _ = app.emit("data-dirs-move-cancelled", ());
        return result;
    }

    for dir in ["c","t","s"] {
        let _ = std::fs::remove_dir_all(old_base.join(dir));
    }

    // Clear the custom path (back to default = no override).
    write_custom_base_path(&app, None);
    if let Some(state) = app.try_state::<CustomBasePath>() {
        if let Ok(mut g) = state.0.lock() { *g = None; }
    }
    if let Some(state) = app.try_state::<MoveInterruptedInfo>() {
        if let Ok(mut g) = state.0.lock() { *g = None; }
    }

    MOVE_IN_PROGRESS.store(false, Ordering::SeqCst);
    clear_move_sentinel(&app);
    let _ = app.emit("data-dirs-move-done", ());
    Ok(())
}

// ── Local FS listing ──────────────────────────────────────────────────────────

/// `rel_path` is a relative path (using '/' separator) within the account root.
/// The empty string means the account's root folder itself.
async fn local_fs_list_to_cache(
    account: &StoredAccount,
    rel_path: &str,
    db: cache::CacheDb,
) -> Result<u64, String> {
    let abs_path = local_fs_abs(account, rel_path)?;
    let mut read_dir = tokio::fs::read_dir(&abs_path)
        .await
        .map_err(|e| format!("read_dir '{}': {}", abs_path.display(), e))?;

    let mut items: Vec<cache::CachedItem> = Vec::new();

    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| e.to_string())?
    {
        let name = entry.file_name().to_string_lossy().to_string();
        // Build the child's relative path using '/' as separator.
        let item_rel_path = if rel_path.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel_path, name)
        };
        let meta = entry.metadata().await.ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = meta
            .as_ref()
            .filter(|m| m.is_file())
            .map(|m| m.len() as i64);
        let modified_ms = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        let mime_type = if is_dir {
            None
        } else {
            let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
            Some(local_mime_from_ext(&ext).to_string())
        };
        items.push(cache::CachedItem {
            account_id: account.id.clone(),
            account_email: account.email.clone(),
            storage_type: cache::STORAGE_LOCAL_FS,
            item_id: item_rel_path,
            parent_id: rel_path.to_string(),
            name,
            is_dir,
            size,
            modified_ms,
            mime_type,
        });
    }

    let total = items.len() as u64;
    tokio::task::spawn_blocking(move || {
        let mut conn = db.lock().map_err(|e| e.to_string())?;
        cache::insert_batch(&mut *conn, &items)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(total)
}

fn local_mime_from_ext(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "mp4" => "video/mp4",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "pdf" => "application/pdf",
        "doc" | "docx" => "application/msword",
        "xls" | "xlsx" => "application/vnd.ms-excel",
        "ppt" | "pptx" => "application/vnd.ms-powerpoint",
        "json" => "application/json",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "ts" => "text/javascript",
        "csv" => "text/csv",
        _ => "application/octet-stream",
    }
}

/// Resolve a list of human-readable folder paths to their item IDs.
/// Returns one entry per input path: `Some(item_id)` if found, `None` otherwise.
#[tauri::command]
fn resolve_folder_paths(
    cache_state: tauri::State<'_, CacheState>,
    account_id: String,
    paths: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
    paths
        .iter()
        .map(|p| Ok(cache::get_item_id_by_path(&conn, &account_id, p)))
        .collect()
}

// ── DevTools: SQLite explorer ─────────────────────────────────────────────────

fn row_to_json_vec(
    row: &rusqlite::Row<'_>,
    col_count: usize,
) -> rusqlite::Result<Vec<serde_json::Value>> {
    (0..col_count)
        .map(|i| {
            Ok(match row.get_ref(i)? {
                rusqlite::types::ValueRef::Null => serde_json::Value::Null,
                rusqlite::types::ValueRef::Integer(n) => {
                    serde_json::Value::Number(serde_json::Number::from(n))
                }
                rusqlite::types::ValueRef::Real(f) => serde_json::Number::from_f64(f)
                    .map(serde_json::Value::Number)
                    .unwrap_or(serde_json::Value::Null),
                rusqlite::types::ValueRef::Text(s) => {
                    serde_json::Value::String(String::from_utf8_lossy(s).into_owned())
                }
                rusqlite::types::ValueRef::Blob(b) => {
                    serde_json::Value::String(format!("<BLOB {} bytes>", b.len()))
                }
            })
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SqliteTableSummary {
    name: String,
    row_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SqliteColumnInfo {
    cid: i64,
    name: String,
    type_name: String,
    not_null: bool,
    primary_key: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SqliteQueryResult {
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
    total_rows: Option<i64>,
    affected_rows: Option<i64>,
    truncated: bool,
    error: Option<String>,
}

#[tauri::command]
fn sqlite_list_tables(
    cache_state: tauri::State<'_, CacheState>,
) -> Result<Vec<SqliteTableSummary>, String> {
    let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master \
             WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .map_err(|e| e.to_string())?;
    let names: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);
    names
        .into_iter()
        .map(|name| {
            let safe = name.replace('"', "\"\"");
            let row_count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM \"{safe}\""), [], |r| r.get(0))
                .unwrap_or(0);
            Ok(SqliteTableSummary { name, row_count })
        })
        .collect()
}

#[tauri::command]
fn sqlite_table_schema(
    cache_state: tauri::State<'_, CacheState>,
    table: String,
) -> Result<Vec<SqliteColumnInfo>, String> {
    let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
    let safe = table.replace('"', "\"\"");
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info(\"{safe}\")"))
        .map_err(|e| e.to_string())?;
    let cols = stmt
        .query_map([], |row| {
            Ok(SqliteColumnInfo {
                cid: row.get(0)?,
                name: row.get(1)?,
                type_name: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                not_null: row.get::<_, i32>(3)? != 0,
                primary_key: row.get::<_, i32>(5)? != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(cols)
}

#[tauri::command]
fn sqlite_query_table(
    cache_state: tauri::State<'_, CacheState>,
    table: String,
    page: i64,
    page_size: i64,
) -> Result<SqliteQueryResult, String> {
    let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
    let safe = table.replace('"', "\"\"");
    let total: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM \"{safe}\""), [], |r| r.get(0))
        .unwrap_or(0);
    let offset = page * page_size;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT * FROM \"{safe}\" LIMIT {page_size} OFFSET {offset}"
        ))
        .map_err(|e| e.to_string())?;
    let col_count = stmt.column_count();
    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let rows: Vec<Vec<serde_json::Value>> = stmt
        .query_map([], |row| row_to_json_vec(row, col_count))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(SqliteQueryResult {
        columns,
        rows,
        total_rows: Some(total),
        affected_rows: None,
        truncated: false,
        error: None,
    })
}

const QUERY_ROW_LIMIT: usize = 1_000;

#[tauri::command]
fn sqlite_run_query(
    cache_state: tauri::State<'_, CacheState>,
    sql: String,
) -> Result<SqliteQueryResult, String> {
    let conn = cache_state.0.lock().map_err(|e| e.to_string())?;
    let sql = sql.trim();
    if sql.is_empty() {
        return Ok(SqliteQueryResult {
            columns: vec![],
            rows: vec![],
            total_rows: None,
            affected_rows: None,
            truncated: false,
            error: Some("Empty query".into()),
        });
    }
    // First prepare to detect column count; the Statement is dropped at end of block.
    let col_count = match conn.prepare(sql) {
        Err(e) => {
            return Ok(SqliteQueryResult {
                columns: vec![],
                rows: vec![],
                total_rows: None,
                affected_rows: None,
                truncated: false,
                error: Some(e.to_string()),
            })
        }
        Ok(stmt) => stmt.column_count(),
    };
    if col_count == 0 {
        return match conn.execute(sql, []) {
            Ok(n) => Ok(SqliteQueryResult {
                columns: vec![],
                rows: vec![],
                total_rows: None,
                affected_rows: Some(n as i64),
                truncated: false,
                error: None,
            }),
            Err(e) => Ok(SqliteQueryResult {
                columns: vec![],
                rows: vec![],
                total_rows: None,
                affected_rows: None,
                truncated: false,
                error: Some(e.to_string()),
            }),
        };
    }
    let mut stmt = match conn.prepare(sql) {
        Err(e) => {
            return Ok(SqliteQueryResult {
                columns: vec![],
                rows: vec![],
                total_rows: None,
                affected_rows: None,
                truncated: false,
                error: Some(e.to_string()),
            })
        }
        Ok(s) => s,
    };
    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let result = match stmt.query_map([], |row| row_to_json_vec(row, col_count)) {
        Err(e) => Ok(SqliteQueryResult {
            columns,
            rows: vec![],
            total_rows: None,
            affected_rows: None,
            truncated: false,
            error: Some(e.to_string()),
        }),
        Ok(mapped) => {
            let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
            let mut truncated = false;
            for r in mapped {
                if rows.len() >= QUERY_ROW_LIMIT {
                    truncated = true;
                    break;
                }
                if let Ok(v) = r {
                    rows.push(v);
                }
            }
            Ok(SqliteQueryResult {
                columns,
                rows,
                total_rows: None,
                affected_rows: None,
                truncated,
                error: None,
            })
        }
    };
    result
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(filen::FilenSessions(std::sync::Mutex::new(
            std::collections::HashMap::new(),
        )))
        .setup(|app| {
            // Read env from bundled config.json (must run before any path is resolved).
            let env = read_config_env(&app.handle());
            APP_ENV.get_or_init(|| env);

            // Load custom data-dirs base path and interrupted-move info FIRST so
            // that data_dirs_base() works correctly throughout the rest of setup.
            let custom_base = read_custom_base_path(&app.handle());
            if let Some(ref base) = custom_base {
                let _ = app.handle().fs_scope().allow_directory(base, true);
            }
            let interrupted_move = read_move_sentinel(&app.handle());
            app.manage(CustomBasePath(std::sync::Mutex::new(custom_base)));
            app.manage(MoveInterruptedInfo(std::sync::Mutex::new(interrupted_move)));

            // Restore Filen sessions from disk.
            {
                let state = app.state::<filen::FilenSessions>();
                let mut sessions = state.0.lock().unwrap();
                filen::load_persisted(&app.handle(), &mut sessions);
            }
            // Open (or create) the SQLite folder-cache database.
            let data_dir = app_base_dir(&app.handle()).expect("app data dir unavailable");
            std::fs::create_dir_all(&data_dir).ok();
            let db = cache::open(&data_dir).expect("failed to open folder cache DB");
            // Purge rows that are too old to be useful — catches orphans that
            // slipped through the per-operation cleanup in previous sessions.
            if let Ok(conn) = db.lock() {
                let _ = cache::cleanup_old_rows(&conn, CACHE_MAX_AGE_MS);
                let _ = cache::cleanup_path_index_orphans(&conn);

                // Remove content-cache folder pairs whose account no longer exists.
                let c_dir = data_dirs_base(&app.handle()).unwrap_or_else(|_| data_dir.clone()).join("c");
                if c_dir.exists() {
                    if let Ok(accounts) = load_accounts(app.handle()) {
                        if let Ok(rd) = std::fs::read_dir(&c_dir) {
                            for entry in rd.flatten() {
                                let name = entry.file_name().to_string_lossy().to_string();
                                // Only look at descriptor folders: leading digits + '-' + ...
                                let digits: String =
                                    name.chars().take_while(|c| c.is_ascii_digit()).collect();
                                if digits.is_empty()
                                    || name.len() <= digits.len()
                                    || !name[digits.len()..].starts_with("@@")
                                {
                                    continue;
                                }
                                let known = accounts.values().any(|a| {
                                    let short = a.id
                                        .strip_prefix(&format!("{}-", a.provider))
                                        .or_else(|| a.id.find('-').map(|i| &a.id[i + 1..]))
                                        .unwrap_or(&a.id);
                                    name.ends_with(&format!("@@{}", short))
                                });
                                if !known {
                                    let _ = std::fs::remove_dir_all(entry.path()); // descriptor
                                    let _ = std::fs::remove_dir_all(c_dir.join(&digits)); // content
                                }
                            }
                        }
                    }
                }
            }
            app.manage(CacheState(db));
            Ok(())
        })
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            // Accounts
            list_accounts,
            get_account,
            upsert_account,
            delete_account,
            // Folder cache
            list_folder,
            query_folder_items,
            uncache_item,
            rename_cached_item,
            invalidate_folder_cache,
            resolve_folder_paths,
            // File content cache
            open_file,
            save_text_file,
            delete_cached_file,
            // Google
            start_google_oauth,
            refresh_google_token,
            gdrive::gdrive_list_files,
            gdrive::gdrive_download_file,
            gdrive::gdrive_upload_file,
            gdrive::gdrive_delete_file,
            gdrive::gdrive_create_folder,
            gdrive::gdrive_rename,
            gdrive::gdrive_copy_file,
            gdrive::gdrive_move_file,
            gdrive::gdrive_edit_file,
            gdrive::gdrive_get_file_mtime,
            // Path resolvers
            filen::filen_find_child_by_name,
            gdrive::gdrive_find_children_by_name,
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
            filen::filen_rename_file,
            filen::filen_rename_directory,
            filen::filen_move_file,
            filen::filen_move_directory,
            filen::filen_copy_file,
            filen::filen_overwrite_file,
            filen::filen_get_file_mtime,
            create_text_file,
            get_thumbnail,
            // Data-dirs move
            get_data_dirs_info,
            validate_new_data_dir,
            is_move_in_progress,
            cancel_move_data_dirs,
            start_move_data_dirs,
            reset_data_dirs_to_default,
            get_interrupted_move_info,
            cleanup_interrupted_move,
            // Conflict detection
            get_item_cached_mtime,
            // Shelveset
            shelveset_activate,
            shelveset_record_change,
            shelveset_save_content,
            shelveset_save_file_path,
            shelveset_create_item,
            shelveset_get_content_path,
            shelveset_get_all_changes,
            shelveset_undo_structural,
            shelveset_undo_content,
            shelveset_discard,
            move_cached_item,
            delete_account_cache,
            delete_account_app_data,
            // DevTools: SQLite explorer
            sqlite_list_tables,
            sqlite_table_schema,
            sqlite_query_table,
            sqlite_run_query,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
