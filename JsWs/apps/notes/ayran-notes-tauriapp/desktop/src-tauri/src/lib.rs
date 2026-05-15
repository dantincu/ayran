pub mod cache;
pub mod filen;
pub mod gdrive;
pub mod storage;

use rusqlite::params;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use std::collections::HashMap;
use tauri::{Emitter, Manager};
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
        "local-fs" => account.path.clone().unwrap_or_default(),
        _ => String::new(),
    }
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
        return Ok(item_id.to_string());
    }

    let c_dir = app_base_dir(app)?.join("c");
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
        // item_id is an absolute path; strip the account root to get a relative path.
        let root = account.path.as_deref().unwrap_or("");
        let stripped = if item_id.len() > root.len() && item_id.starts_with(root) {
            &item_id[root.len()..]
        } else {
            item_id
        };
        stripped
            .trim_start_matches(['/', '\\'])
            .split(['/', '\\'])
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

    let t_dir = app_base_dir(&app)?.join("t");
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

    // LocalFS: write directly to the original file path.
    if account.provider == "local-fs" {
        tokio::fs::write(&item_id, &bytes).await.map_err(|e| e.to_string())?;
        return Ok(item_id);
    }

    // Cloud: write to cache then upload.
    let c_dir = app_base_dir(&app)?.join("c");
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
            let path = std::path::Path::new(&parent_id).join(&filename);
            tokio::fs::write(&path, &bytes).await.map_err(|e| e.to_string())?;
            Ok(path.to_string_lossy().into_owned())
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
            app_base_dir(&app).map(|d| d.join("c")),
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
                if let Ok(c_dir) = app_base_dir(&app).map(|d| d.join("c")) {
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

// ── Local FS listing ──────────────────────────────────────────────────────────

async fn local_fs_list_to_cache(
    account: &StoredAccount,
    path: &str,
    db: cache::CacheDb,
) -> Result<u64, String> {
    let mut read_dir = tokio::fs::read_dir(path)
        .await
        .map_err(|e| format!("read_dir '{}': {}", path, e))?;

    let mut items: Vec<cache::CachedItem> = Vec::new();

    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| e.to_string())?
    {
        let name = entry.file_name().to_string_lossy().to_string();
        let item_path = entry.path().to_string_lossy().to_string();
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
            item_id: item_path,
            parent_id: path.to_string(),
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
                let c_dir = data_dir.join("c");
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
            create_text_file,
            get_thumbnail,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
