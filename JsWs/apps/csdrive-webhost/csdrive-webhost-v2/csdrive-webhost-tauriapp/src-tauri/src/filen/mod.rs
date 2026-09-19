//! Filen.io support, entirely on the Rust side: login, session storage, and
//! path-based file operations. Nothing here ever hands a credential to a webview —
//! windows (the admin-app and user-provided web apps alike) get file/folder metadata
//! and contents, plus each account's Filen user id and email, and nothing more.
//!
//! - `crypto` / `api`: Filen's encryption and HTTP protocol.
//! - `ops`: path-based operations (list, read, write, mkdir, remove, rename).
//!
//! Where things live: the list of connected accounts (user id + email) is a table in
//! `data.db`; every account's session secrets (API key, master keys, ...) are in one
//! AES-256-GCM encrypted file in the data folder (`layout::FILEN_SESSIONS_FILE`),
//! encrypted with the app key that `secure_store` keeps in the platform key store.

mod api;
mod crypto;
mod ops;

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::{AppHandle, Manager};

use crate::app_state::AppDbState;

// ── Sessions ──────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct Session {
    api_key: String,
    /// Oldest first, newest last; decrypting tries newest first, encrypting uses the newest.
    master_keys: Vec<String>,
    base_folder_uuid: String,
    auth_version: u8,
    /// Salts name hashes on auth-version-3 accounts (see `crypto::derive_hmac_key`).
    hmac_key: Option<Vec<u8>>,
    client: reqwest::Client,
}

impl Session {
    /// The hash Filen uses server-side to detect duplicate names in a folder.
    fn hash_name(&self, name: &str) -> Result<String, String> {
        match (&self.hmac_key, self.auth_version) {
            (Some(key), 3) => crypto::hash_filename_hmac(name, key),
            (None, 3) => Err("This account has to be reconnected before files can be changed.".to_string()),
            _ => Ok(crypto::hash_filename(name)),
        }
    }
}

/// What's persisted (in the keychain) for a session.
#[derive(Serialize, Deserialize, Clone)]
struct StoredSession {
    api_key: String,
    master_keys: Vec<String>,
    base_folder_uuid: String,
    user_id: u64,
    email: String,
    #[serde(default = "default_auth_version")]
    auth_version: u8,
    #[serde(default)]
    hmac_key_hex: Option<String>,
}

fn default_auth_version() -> u8 {
    2
}

impl StoredSession {
    fn into_session(self) -> Result<Session, String> {
        let hmac_key = self.hmac_key_hex.as_deref().map(hex::decode).transpose().map_err(|e| e.to_string())?;
        Ok(Session {
            api_key: self.api_key,
            master_keys: self.master_keys,
            base_folder_uuid: self.base_folder_uuid,
            auth_version: self.auth_version,
            hmac_key,
            client: reqwest::Client::new(),
        })
    }
}

// ── Session storage: one encrypted file in the data folder ────────────────────

fn read_sessions(path: &std::path::Path) -> Result<Vec<StoredSession>, String> {
    Ok(crate::secure_store::read_json(path)?.unwrap_or_default())
}

fn write_sessions(path: &std::path::Path, sessions: &[StoredSession]) -> Result<(), String> {
    crate::secure_store::write_json(path, &sessions)
}

fn save_session_at(path: &std::path::Path, stored: &StoredSession) -> Result<(), String> {
    let mut sessions = read_sessions(path)?;
    sessions.retain(|s| s.user_id != stored.user_id);
    sessions.push(stored.clone());
    write_sessions(path, &sessions)
}

fn load_session_at(path: &std::path::Path, user_id: u64) -> Result<Option<StoredSession>, String> {
    Ok(read_sessions(path)?.into_iter().find(|s| s.user_id == user_id))
}

fn delete_session_at(path: &std::path::Path, user_id: u64) -> Result<(), String> {
    let mut sessions = read_sessions(path)?;
    let before = sessions.len();
    sessions.retain(|s| s.user_id != user_id);
    if sessions.len() != before {
        write_sessions(path, &sessions)?;
    }
    Ok(())
}

/// Serializes read-modify-write of the sessions file.
static SESSIONS_FILE_LOCK: Mutex<()> = Mutex::new(());

fn sessions_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(crate::layout::filen_sessions_file(&crate::data_location::effective_data_dir(app)?))
}

fn save_session(app: &AppHandle, stored: &StoredSession) -> Result<(), String> {
    let _guard = SESSIONS_FILE_LOCK.lock().unwrap();
    save_session_at(&sessions_file(app)?, stored)
}

fn load_session(app: &AppHandle, user_id: u64) -> Result<Option<StoredSession>, String> {
    let _guard = SESSIONS_FILE_LOCK.lock().unwrap();
    load_session_at(&sessions_file(app)?, user_id)
}

fn delete_session(app: &AppHandle, user_id: u64) -> Result<(), String> {
    let _guard = SESSIONS_FILE_LOCK.lock().unwrap();
    delete_session_at(&sessions_file(app)?, user_id)
}

/// Sessions already loaded from the encrypted file this run.
#[derive(Default)]
pub struct FilenState {
    sessions: Mutex<HashMap<u64, Session>>,
}

// ── Connected accounts (data.db) ──────────────────────────────────────────────

/// The only things a web app is ever told about an account.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilenAccount {
    pub user_id: u64,
    pub email: String,
}

pub async fn ensure_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query("CREATE TABLE IF NOT EXISTS filen_accounts (user_id INTEGER PRIMARY KEY, email TEXT NOT NULL)")
        .execute(pool)
        .await?;
    Ok(())
}

async fn upsert_account(pool: &SqlitePool, user_id: u64, email: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO filen_accounts (user_id, email) VALUES (?1, ?2)
         ON CONFLICT(user_id) DO UPDATE SET email = excluded.email",
    )
    .bind(user_id as i64)
    .bind(email)
    .execute(pool)
    .await?;
    Ok(())
}

async fn list_accounts(pool: &SqlitePool) -> Result<Vec<FilenAccount>, sqlx::Error> {
    let rows: Vec<(i64, String)> = sqlx::query_as("SELECT user_id, email FROM filen_accounts ORDER BY email")
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|(user_id, email)| FilenAccount { user_id: user_id as u64, email }).collect())
}

fn pool(app: &AppHandle) -> SqlitePool {
    app.state::<AppDbState>().pool.clone()
}

/// The session for a connected account, loading it from the encrypted file the first time.
async fn session_for(app: &AppHandle, user_id: u64) -> Result<Session, String> {
    if let Some(session) = app.state::<FilenState>().sessions.lock().unwrap().get(&user_id).cloned() {
        return Ok(session);
    }

    let connected = list_accounts(&pool(app)).await.map_err(|e| e.to_string())?.iter().any(|a| a.user_id == user_id);
    if !connected {
        return Err("No connected Filen account has that user id.".to_string());
    }
    let stored = load_session(app, user_id)?
        .ok_or_else(|| "The saved Filen session is missing — reconnect this account.".to_string())?;
    let session = stored.into_session()?;
    app.state::<FilenState>().sessions.lock().unwrap().insert(user_id, session.clone());
    Ok(session)
}

// ── Login / logout (admin window only) ────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthInfoResponse {
    auth_version: u8,
    salt: String,
    id: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginResponse {
    api_key: String,
    master_keys: Option<String>,
}

#[derive(Deserialize)]
struct BaseFolderResponse {
    uuid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyPairResponse {
    private_key: Option<String>,
}

#[tauri::command]
pub async fn filen_login(
    window: tauri::WebviewWindow,
    app: AppHandle,
    email: String,
    password: String,
    two_factor_code: Option<String>,
) -> Result<FilenAccount, String> {
    crate::window_host::require_admin(&window)?;
    let client = reqwest::Client::new();

    let info: AuthInfoResponse =
        api::post(&client, "/v3/auth/info", &serde_json::json!({ "email": email }), None).await?;

    let (derived_password, initial_master_key) = match info.auth_version {
        2 => crypto::derive_keys_v2(&password, &info.salt),
        3 => crypto::derive_keys_v3(&password, &info.salt)?,
        v => return Err(format!("Unsupported Filen auth version: {v}")),
    };

    let login: LoginResponse = api::post(
        &client,
        "/v3/login",
        &serde_json::json!({
            "email": email,
            "password": derived_password,
            "twoFactorCode": two_factor_code.filter(|c| !c.trim().is_empty()).unwrap_or_else(|| "XXXXXX".into()),
            "authVersion": info.auth_version
        }),
        None,
    )
    .await?;

    let master_keys = match login.master_keys.as_deref() {
        Some(encrypted) if !encrypted.is_empty() => crypto::decrypt_with_key(encrypted, &initial_master_key)?
            .split('|')
            .filter(|k| !k.is_empty())
            .map(str::to_string)
            .collect(),
        _ => vec![initial_master_key],
    };

    let base: BaseFolderResponse = api::get(&client, "/v3/user/baseFolder", &login.api_key).await?;

    // Version-3 accounts salt their name hashes with a key derived from the account's
    // RSA private key, which is stored server-side encrypted with the master key.
    let key_pair: KeyPairResponse = api::get(&client, "/v3/user/keyPair/info", &login.api_key).await?;
    let hmac_key = match key_pair.private_key.as_deref().filter(|k| !k.is_empty()) {
        Some(encrypted) => Some(crypto::derive_hmac_key(&crypto::decrypt_metadata(encrypted, &master_keys)?)?),
        None if info.auth_version == 3 => return Err("Filen didn't return this account's key pair.".to_string()),
        None => None,
    };

    let stored = StoredSession {
        api_key: login.api_key,
        master_keys,
        base_folder_uuid: base.uuid,
        user_id: info.id,
        email: email.clone(),
        auth_version: info.auth_version,
        hmac_key_hex: hmac_key.map(hex::encode),
    };
    save_session(&app, &stored)?;
    upsert_account(&pool(&app), info.id, &email).await.map_err(|e| e.to_string())?;

    let session = stored.into_session()?;
    app.state::<FilenState>().sessions.lock().unwrap().insert(info.id, session);
    Ok(FilenAccount { user_id: info.id, email })
}

#[tauri::command]
pub async fn filen_logout(window: tauri::WebviewWindow, app: AppHandle, user_id: u64) -> Result<(), String> {
    crate::window_host::require_admin(&window)?;
    delete_session(&app, user_id)?;
    app.state::<FilenState>().sessions.lock().unwrap().remove(&user_id);
    sqlx::query("DELETE FROM filen_accounts WHERE user_id = ?1")
        .bind(user_id as i64)
        .execute(&pool(&app))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── File operations (any window) ──────────────────────────────────────────────

#[tauri::command]
pub async fn filen_list_accounts(app: AppHandle) -> Result<Vec<FilenAccount>, String> {
    list_accounts(&pool(&app)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn filen_readdir(app: AppHandle, user_id: u64, path: String) -> Result<Vec<ops::Entry>, String> {
    ops::readdir(&session_for(&app, user_id).await?, &path).await
}

#[tauri::command]
pub async fn filen_stat(app: AppHandle, user_id: u64, path: String) -> Result<ops::Entry, String> {
    ops::stat(&session_for(&app, user_id).await?, &path).await
}

/// Returns the file's bytes as a raw binary response (an `ArrayBuffer` in JS).
#[tauri::command]
pub async fn filen_read_file(app: AppHandle, user_id: u64, path: String) -> Result<tauri::ipc::Response, String> {
    let content = ops::read_file(&session_for(&app, user_id).await?, &path).await?;
    Ok(tauri::ipc::Response::new(content))
}

/// Takes the file's bytes as the request body (see `ipc::body_bytes`), with `userId` and a
/// percent-encoded `path` as request headers:
/// `invoke('filen_write_file', bytes, { headers: { userId, path: encodeURIComponent(path) } })`.
#[tauri::command]
pub async fn filen_write_file(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let content = crate::ipc::body_bytes(&request)?;
    let user_id: u64 = crate::ipc::field(&request, "userId")?.parse().map_err(|_| "\"userId\" must be a number.".to_string())?;
    let path = crate::ipc::field(&request, "path")?;

    ops::write_file(&session_for(&app, user_id).await?, &path, &content).await
}

#[tauri::command]
pub async fn filen_mkdir(app: AppHandle, user_id: u64, path: String) -> Result<(), String> {
    ops::mkdir(&session_for(&app, user_id).await?, &path).await
}

#[tauri::command]
pub async fn filen_rm(app: AppHandle, user_id: u64, path: String) -> Result<(), String> {
    ops::remove(&session_for(&app, user_id).await?, &path).await
}

#[tauri::command]
pub async fn filen_rename(app: AppHandle, user_id: u64, from: String, to: String) -> Result<(), String> {
    ops::rename(&session_for(&app, user_id).await?, &from, &to).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(auth_version: u8, hmac_key: Option<Vec<u8>>) -> Session {
        Session {
            api_key: "k".into(),
            master_keys: vec!["m".into()],
            base_folder_uuid: "b".into(),
            auth_version,
            hmac_key,
            client: reqwest::Client::new(),
        }
    }

    #[test]
    fn name_hash_depends_on_the_accounts_auth_version() {
        assert_eq!(session(2, None).hash_name("A.txt").unwrap(), crypto::hash_filename("a.txt"));
        let key = vec![7u8; 32];
        assert_eq!(
            session(3, Some(key.clone())).hash_name("A.txt").unwrap(),
            crypto::hash_filename_hmac("a.txt", &key).unwrap()
        );
        assert!(session(3, None).hash_name("a.txt").is_err());
    }

    #[test]
    fn stored_sessions_round_trip_and_older_ones_default_to_auth_v2() {
        let stored = StoredSession {
            api_key: "key".into(),
            master_keys: vec!["m1".into(), "m2".into()],
            base_folder_uuid: "base".into(),
            user_id: 42,
            email: "me@example.com".into(),
            auth_version: 3,
            hmac_key_hex: Some("00".repeat(32)),
        };
        let json = serde_json::to_string(&stored).unwrap();
        let session = serde_json::from_str::<StoredSession>(&json).unwrap().into_session().unwrap();
        assert_eq!((session.auth_version, session.hmac_key.map(|k| k.len())), (3, Some(32)));

        let old = r#"{"api_key":"k","master_keys":["m"],"base_folder_uuid":"b","user_id":1,"email":"e"}"#;
        assert_eq!(serde_json::from_str::<StoredSession>(old).unwrap().auth_version, 2);
    }

    fn stored(user_id: u64, marker: &str) -> StoredSession {
        StoredSession {
            api_key: format!("api-key-{marker}"),
            master_keys: (0..12).map(|i| format!("{i:0>64}")).collect(),
            base_folder_uuid: uuid::Uuid::new_v4().to_string(),
            user_id,
            email: format!("{marker}@example.com"),
            auth_version: 3,
            hmac_key_hex: Some("ab".repeat(32)),
        }
    }

    /// Uses the real key from the OS keychain (as the app does) on a file in a temp folder.
    #[test]
    fn sessions_are_kept_encrypted_in_one_file_and_can_be_added_replaced_and_removed() {
        let dir = std::env::temp_dir().join(format!("csdrive-filen-sessions-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("admin").join("filen-sessions.enc");

        assert!(load_session_at(&path, 1).unwrap().is_none(), "no file yet");
        save_session_at(&path, &stored(1, "alice")).unwrap();
        save_session_at(&path, &stored(2, "bob")).unwrap();
        assert_eq!(load_session_at(&path, 1).unwrap().unwrap().email, "alice@example.com");
        assert_eq!(load_session_at(&path, 2).unwrap().unwrap().master_keys.len(), 12);

        let on_disk = std::fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&on_disk).contains("api-key-alice"), "secrets must not be readable in the file");

        save_session_at(&path, &stored(1, "alice-again")).unwrap();
        assert_eq!(read_sessions(&path).unwrap().len(), 2, "saving an existing account replaces it");
        assert_eq!(load_session_at(&path, 1).unwrap().unwrap().api_key, "api-key-alice-again");

        delete_session_at(&path, 1).unwrap();
        assert!(load_session_at(&path, 1).unwrap().is_none());
        assert!(load_session_at(&path, 2).unwrap().is_some(), "other accounts are untouched");
        delete_session_at(&path, 1).unwrap(); // removing what's already gone is fine

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn accounts_are_stored_and_listed_by_email() {
        tauri::async_runtime::block_on(async {
            let dir = std::env::temp_dir().join(format!("csdrive-filen-test-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let pool = SqlitePool::connect_with(
                sqlx::sqlite::SqliteConnectOptions::new().filename(dir.join("t.db")).create_if_missing(true),
            )
            .await
            .unwrap();
            ensure_schema(&pool).await.unwrap();

            upsert_account(&pool, 2, "b@x.com").await.unwrap();
            upsert_account(&pool, 1, "a@x.com").await.unwrap();
            upsert_account(&pool, 2, "b2@x.com").await.unwrap();
            assert_eq!(
                list_accounts(&pool).await.unwrap(),
                [
                    FilenAccount { user_id: 1, email: "a@x.com".into() },
                    FilenAccount { user_id: 2, email: "b2@x.com".into() }
                ]
            );
        });
    }
}
