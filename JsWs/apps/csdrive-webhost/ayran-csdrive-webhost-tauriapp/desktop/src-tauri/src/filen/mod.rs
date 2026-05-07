pub mod api;
pub mod crypto;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri_plugin_store::StoreExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const STORE_FILE: &str = "filen_sessions.json";
const STORE_KEY: &str = "sessions";

// ── Session state ─────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct FilenSession {
    pub api_key: String,
    /// Master keys, oldest first, newest last. Decrypt tries newest first.
    pub master_keys: Vec<String>,
    pub base_folder_uuid: String,
    pub user_id: u64,
    pub email: String,
    pub client: reqwest::Client,
}

pub struct FilenSessions(pub Mutex<HashMap<String, FilenSession>>);

// ── Persistence helpers ───────────────────────────────────────────────────────

/// Serialisable subset of a session stored on disk.
#[derive(Serialize, Deserialize, Clone)]
pub struct StoredSession {
    pub api_key: String,
    pub master_keys: Vec<String>,
    pub base_folder_uuid: String,
    pub user_id: u64,
    pub email: String,
}

impl From<&FilenSession> for StoredSession {
    fn from(s: &FilenSession) -> Self {
        Self {
            api_key: s.api_key.clone(),
            master_keys: s.master_keys.clone(),
            base_folder_uuid: s.base_folder_uuid.clone(),
            user_id: s.user_id,
            email: s.email.clone(),
        }
    }
}

fn persist(app: &tauri::AppHandle, sessions: &HashMap<String, FilenSession>) {
    let stored: HashMap<String, StoredSession> =
        sessions.iter().map(|(k, v)| (k.clone(), v.into())).collect();
    if let Ok(store) = app.store(STORE_FILE) {
        if let Ok(val) = serde_json::to_value(&stored) {
            store.set(STORE_KEY, val);
            let _ = store.save();
        }
    }
}

/// Called once on app startup to hydrate in-memory sessions from disk.
pub fn load_persisted(app: &tauri::AppHandle, sessions: &mut HashMap<String, FilenSession>) {
    let Ok(store) = app.store(STORE_FILE) else { return };
    let Some(val) = store.get(STORE_KEY) else { return };
    let Ok(map) = serde_json::from_value::<HashMap<String, StoredSession>>(val) else { return };
    for (id, stored) in map {
        sessions.entry(id).or_insert_with(|| FilenSession {
            api_key: stored.api_key,
            master_keys: stored.master_keys,
            base_folder_uuid: stored.base_folder_uuid,
            user_id: stored.user_id,
            email: stored.email,
            client: reqwest::Client::new(),
        });
    }
}

fn get_session(
    state: &tauri::State<'_, FilenSessions>,
    account_id: &str,
) -> Result<FilenSession, String> {
    state
        .0
        .lock()
        .unwrap()
        .get(account_id)
        .cloned()
        .ok_or_else(|| format!("No active Filen session for '{}'. Please log in again.", account_id))
}

// ── Serialisable types sent to the frontend ───────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FilenAccountInfo {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub provider: String,
    pub provider_data: FilenProviderData,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FilenProviderData {
    pub base_folder_uuid: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum FilenItem {
    #[serde(rename = "file")]
    File {
        uuid: String,
        name: String,
        mime: String,
        size: u64,
        last_modified: u64,
    },
    #[serde(rename = "directory")]
    Directory {
        uuid: String,
        name: String,
        last_modified: u64,
    },
}

// ── API response shapes ───────────────────────────────────────────────────────

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
#[serde(rename_all = "camelCase")]
struct BaseFolderResponse {
    uuid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirContentResponse {
    uploads: Vec<DirUpload>,
    folders: Vec<DirFolder>,
}

#[derive(Deserialize)]
struct DirUpload {
    uuid: String,
    metadata: String,
    chunks: u32,
    size: u64,
    bucket: String,
    region: String,
    version: u8,
    timestamp: u64,
}

#[derive(Deserialize)]
struct DirFolder {
    uuid: String,
    name: String,
    timestamp: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileMetadata {
    name: String,
    size: u64,
    mime: String,
    key: String,
    last_modified: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileInfoResponse {
    region: String,
    bucket: String,
    metadata: String,
    chunks: u32,
    version: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDirResponse {
    uuid: String,
}

// ── Login ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn filen_login(
    app: tauri::AppHandle,
    state: tauri::State<'_, FilenSessions>,
    email: String,
    password: String,
    two_factor_code: Option<String>,
) -> Result<FilenAccountInfo, String> {
    let client = reqwest::Client::new();

    // Step 1: auth info
    let auth_info: AuthInfoResponse = api::post(
        &client,
        "/v3/auth/info",
        &serde_json::json!({ "email": email }),
        None,
    )
    .await?;

    // Step 2: derive keys
    let (derived_password, initial_master_key) = match auth_info.auth_version {
        2 => crypto::derive_keys_v2(&password, &auth_info.salt),
        3 => crypto::derive_keys_v3(&password, &auth_info.salt)?,
        v => return Err(format!("Unsupported auth version: {}", v)),
    };

    // Step 3: login
    let login: LoginResponse = api::post(
        &client,
        "/v3/login",
        &serde_json::json!({
            "email": email,
            "password": derived_password,
            "twoFactorCode": two_factor_code.unwrap_or_else(|| "XXXXXX".into()),
            "authVersion": auth_info.auth_version
        }),
        None,
    )
    .await?;

    // Step 4: decrypt master keys
    let master_keys = match login.master_keys {
        Some(ref enc) if !enc.is_empty() => {
            let plain = crypto::decrypt_with_key(enc, &initial_master_key)?;
            plain
                .split('|')
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        }
        _ => vec![initial_master_key.clone()],
    };

    // Step 5: get base folder UUID
    let base: BaseFolderResponse =
        api::get(&client, "/v3/user/baseFolder", &login.api_key).await?;

    let account_id = format!("filen-{}", auth_info.id);

    let session = FilenSession {
        api_key: login.api_key,
        master_keys,
        base_folder_uuid: base.uuid.clone(),
        user_id: auth_info.id,
        email: email.clone(),
        client,
    };

    let mut sessions = state.0.lock().unwrap();
    sessions.insert(account_id.clone(), session);
    persist(&app, &sessions);
    drop(sessions);

    Ok(FilenAccountInfo {
        id: account_id,
        display_name: email.split('@').next().unwrap_or("").to_string(),
        email,
        provider: "filen".into(),
        provider_data: FilenProviderData {
            base_folder_uuid: base.uuid,
        },
    })
}

/// Restore a session from persisted provider data (called on app startup).
#[tauri::command]
pub async fn filen_restore_session(
    state: tauri::State<'_, FilenSessions>,
    account_id: String,
    api_key: String,
    master_keys: Vec<String>,
    base_folder_uuid: String,
    user_id: u64,
    email: String,
) -> Result<(), String> {
    let session = FilenSession {
        api_key,
        master_keys,
        base_folder_uuid,
        user_id,
        email,
        client: reqwest::Client::new(),
    };
    state.0.lock().unwrap().insert(account_id, session);
    Ok(())
}

#[tauri::command]
pub fn filen_has_session(
    state: tauri::State<'_, FilenSessions>,
    account_id: String,
) -> bool {
    state.0.lock().unwrap().contains_key(&account_id)
}

#[tauri::command]
pub fn filen_logout(
    app: tauri::AppHandle,
    state: tauri::State<'_, FilenSessions>,
    account_id: String,
) {
    let mut sessions = state.0.lock().unwrap();
    sessions.remove(&account_id);
    persist(&app, &sessions);
}

// ── Directory listing ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn filen_list_directory(
    state: tauri::State<'_, FilenSessions>,
    account_id: String,
    uuid: String,
) -> Result<Vec<FilenItem>, String> {
    let s = get_session(&state, &account_id)?;

    let content: DirContentResponse = api::post(
        &s.client,
        "/v3/dir/content",
        &serde_json::json!({ "uuid": uuid }),
        Some(&s.api_key),
    )
    .await?;

    let mut items: Vec<FilenItem> = Vec::new();

    for folder in content.folders {
        let name = decrypt_folder_name(&folder.name, &s.master_keys)?;
        items.push(FilenItem::Directory {
            uuid: folder.uuid,
            name,
            last_modified: folder.timestamp * 1000,
        });
    }

    for upload in content.uploads {
        if let Ok(meta) = crypto::decrypt_metadata(&upload.metadata, &s.master_keys)
            .and_then(|plain| serde_json::from_str::<FileMetadata>(&plain).map_err(|e| e.to_string()))
        {
            let last_modified = meta.last_modified.unwrap_or(upload.timestamp * 1000);
            items.push(FilenItem::File {
                uuid: upload.uuid,
                name: meta.name,
                mime: meta.mime,
                size: meta.size,
                last_modified,
            });
        }
    }

    // Directories first, then files, both sorted by name
    items.sort_by(|a, b| {
        let type_order = |i: &FilenItem| matches!(i, FilenItem::File { .. }) as u8;
        type_order(a)
            .cmp(&type_order(b))
            .then_with(|| item_name(a).cmp(item_name(b)))
    });

    Ok(items)
}

fn decrypt_folder_name(enc: &str, master_keys: &[String]) -> Result<String, String> {
    let plain = crypto::decrypt_metadata(enc, master_keys)?;
    // Folder name is stored as JSON: {"name":"..."} or bare string
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&plain) {
        if let Some(n) = v.get("name").and_then(|n| n.as_str()) {
            return Ok(n.to_string());
        }
    }
    Ok(plain)
}

fn item_name(i: &FilenItem) -> &str {
    match i {
        FilenItem::File { name, .. } | FilenItem::Directory { name, .. } => name,
    }
}

// ── File download ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn filen_download_file(
    state: tauri::State<'_, FilenSessions>,
    account_id: String,
    uuid: String,
    dest_path: String,
) -> Result<(), String> {
    let s = get_session(&state, &account_id)?;

    // Fetch file info
    let info: FileInfoResponse = api::post(
        &s.client,
        "/v3/file",
        &serde_json::json!({ "uuid": uuid }),
        Some(&s.api_key),
    )
    .await?;

    let plain_meta = crypto::decrypt_metadata(&info.metadata, &s.master_keys)?;
    let meta: FileMetadata =
        serde_json::from_str(&plain_meta).map_err(|e| e.to_string())?;

    let mut file = tokio::fs::File::create(&dest_path)
        .await
        .map_err(|e| format!("create '{}': {}", dest_path, e))?;

    for index in 0..info.chunks {
        let enc_chunk =
            api::download_chunk(&s.client, &info.region, &info.bucket, &uuid, index).await?;
        let plain_chunk = crypto::decrypt_chunk(&enc_chunk, &meta.key, info.version)?;
        file.write_all(&plain_chunk)
            .await
            .map_err(|e| e.to_string())?;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

// ── File upload ───────────────────────────────────────────────────────────────

const CHUNK_SIZE: usize = 1_048_576; // 1 MiB

#[tauri::command]
pub async fn filen_upload_file(
    state: tauri::State<'_, FilenSessions>,
    account_id: String,
    parent_uuid: String,
    file_path: String,
) -> Result<(), String> {
    let s = get_session(&state, &account_id)?;
    let master_key = s.master_keys.last().ok_or("no master key")?;

    let file_uuid = uuid::Uuid::new_v4().to_string();
    let file_key = crypto::generate_file_key();
    let upload_key = crypto::generate_random_string(32);

    // Derive name, mime, last_modified from the path
    let path = std::path::Path::new(&file_path);
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("invalid file path")?
        .to_string();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = mime_from_ext(&ext);
    let last_modified = std::fs::metadata(&file_path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let mut file = tokio::fs::File::open(&file_path)
        .await
        .map_err(|e| format!("open '{}': {}", file_path, e))?;

    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut chunk_index: u32 = 0;
    let mut total_size: u64 = 0;
    let mut content_hasher = Sha512::new();
    let mut last_upload: Option<api::UploadChunkResponse> = None;

    loop {
        let n = file.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        let chunk = &buf[..n];
        total_size += n as u64;
        content_hasher.update(chunk);

        let enc_chunk = crypto::encrypt_chunk(chunk, &file_key)?;
        let chunk_hash = hex::encode(Sha512::digest(&enc_chunk));

        let resp = api::upload_chunk(
            &s.client,
            &file_uuid,
            chunk_index,
            &parent_uuid,
            &upload_key,
            &chunk_hash,
            &enc_chunk,
            &s.api_key,
        )
        .await?;

        last_upload = Some(resp);
        chunk_index += 1;
    }

    // Empty file: use /v3/upload/empty
    if chunk_index == 0 {
        let name_enc = crypto::encrypt_metadata(&name, &file_key)?;
        let name_hashed = crypto::hash_filename(&name);
        let size_enc = crypto::encrypt_metadata("0", &file_key)?;
        let mime_enc = crypto::encrypt_metadata(mime, &file_key)?;
        let rm = crypto::generate_random_string(32);
        let metadata_plain = serde_json::json!({
            "name": name, "size": 0u64, "mime": mime,
            "key": file_key, "lastModified": last_modified
        })
        .to_string();
        let metadata_enc = crypto::encrypt_metadata(&metadata_plain, master_key)?;

        api::post_ok(
            &s.client,
            "/v3/upload/empty",
            &serde_json::json!({
                "uuid": file_uuid, "name": name_enc, "nameHashed": name_hashed,
                "size": size_enc, "mime": mime_enc, "rm": rm,
                "metadata": metadata_enc, "version": 3, "parent": parent_uuid
            }),
            &s.api_key,
        )
        .await?;
        return Ok(());
    }

    let content_hash = hex::encode(content_hasher.finalize());
    let (bucket, region) = last_upload
        .map(|r| (r.bucket, r.region))
        .unwrap_or_default();

    // Encrypt individual fields with file_key, metadata blob with master_key
    let name_enc = crypto::encrypt_metadata(&name, &file_key)?;
    let name_hashed = crypto::hash_filename(&name);
    let size_enc = crypto::encrypt_metadata(&total_size.to_string(), &file_key)?;
    let mime_enc = crypto::encrypt_metadata(mime, &file_key)?;
    let rm = crypto::generate_random_string(32);

    let metadata_plain = serde_json::json!({
        "name": name, "size": total_size, "mime": mime,
        "key": file_key, "lastModified": last_modified, "hash": content_hash
    })
    .to_string();
    let metadata_enc = crypto::encrypt_metadata(&metadata_plain, master_key)?;

    api::post_ok(
        &s.client,
        "/v3/upload/done",
        &serde_json::json!({
            "uuid": file_uuid, "name": name_enc, "nameHashed": name_hashed,
            "size": size_enc, "chunks": chunk_index, "mime": mime_enc,
            "rm": rm, "metadata": metadata_enc, "version": 3,
            "uploadKey": upload_key, "bucket": bucket, "region": region
        }),
        &s.api_key,
    )
    .await?;

    Ok(())
}

// ── Create directory ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn filen_create_directory(
    state: tauri::State<'_, FilenSessions>,
    account_id: String,
    parent_uuid: String,
    name: String,
) -> Result<String, String> {
    let s = get_session(&state, &account_id)?;
    let master_key = s.master_keys.last().ok_or("no master key")?;

    let name_json = serde_json::json!({ "name": name }).to_string();
    let name_enc = crypto::encrypt_metadata(&name_json, master_key)?;
    let name_hashed = crypto::hash_filename(&name);
    let new_uuid = uuid::Uuid::new_v4().to_string();

    let resp: CreateDirResponse = api::post(
        &s.client,
        "/v3/dir/create",
        &serde_json::json!({
            "uuid": new_uuid, "name": name_enc,
            "nameHashed": name_hashed, "parent": parent_uuid
        }),
        Some(&s.api_key),
    )
    .await?;

    Ok(resp.uuid)
}

// ── Trash ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn filen_trash_file(
    state: tauri::State<'_, FilenSessions>,
    account_id: String,
    uuid: String,
) -> Result<(), String> {
    let s = get_session(&state, &account_id)?;
    api::post_ok(
        &s.client,
        "/v3/file/trash",
        &serde_json::json!({ "uuid": uuid }),
        &s.api_key,
    )
    .await
}

#[tauri::command]
pub async fn filen_trash_directory(
    state: tauri::State<'_, FilenSessions>,
    account_id: String,
    uuid: String,
) -> Result<(), String> {
    let s = get_session(&state, &account_id)?;
    api::post_ok(
        &s.client,
        "/v3/dir/trash",
        &serde_json::json!({ "uuid": uuid }),
        &s.api_key,
    )
    .await
}

// ── MIME helper ───────────────────────────────────────────────────────────────

fn mime_from_ext(ext: &str) -> &'static str {
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
        "zip" => "application/zip",
        "tar" => "application/x-tar",
        "gz" => "application/gzip",
        "json" => "application/json",
        "xml" => "application/xml",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "ts" => "text/typescript",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "xls" | "xlsx" => "application/vnd.ms-excel",
        "doc" | "docx" => "application/msword",
        "ppt" | "pptx" => "application/vnd.ms-powerpoint",
        "rs" | "py" | "go" | "java" | "c" | "cpp" | "h" => "text/plain",
        _ => "application/octet-stream",
    }
}
