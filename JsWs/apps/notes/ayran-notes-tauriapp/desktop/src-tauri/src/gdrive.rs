use crate::storage;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

const GOOGLE_CLIENT_ID: &str = env!("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET: &str = env!("GOOGLE_CLIENT_SECRET");
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const DRIVE_API: &str = "https://www.googleapis.com/drive/v3";

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(reqwest::Client::new)
}

// ── Shared response shapes ────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveFileRaw {
    id: String,
    name: String,
    mime_type: String,
    size: Option<String>,
    modified_time: Option<String>,
}

#[derive(Deserialize)]
struct ListResponse {
    files: Vec<DriveFileRaw>,
}

// ── Public return type ────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: Option<String>,
    pub modified_time: Option<String>,
}

// ── Internal token management ─────────────────────────────────────────────────

/// Returns a valid access token for `account_id`, refreshing it if needed.
/// Persists the new token to the encrypted accounts file.
async fn get_valid_token(app: &tauri::AppHandle, account_id: &str) -> Result<String, String> {
    let mut accounts = crate::load_accounts(app)?;
    let account = accounts
        .get(account_id)
        .ok_or_else(|| format!("Account '{}' not found", account_id))?
        .clone();

    let access_token = account.access_token.clone().ok_or("account has no access token")?;
    let expires_at = account.expires_at.unwrap_or(0);

    if expires_at > crate::now_ms() + 300_000 {
        return Ok(access_token);
    }

    let refresh_token = account
        .refresh_token
        .clone()
        .ok_or("account has no refresh token")?;

    let res = client()
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
    let new_token = data.access_token.clone();

    if let Some(acc) = accounts.get_mut(account_id) {
        acc.access_token = Some(new_token.clone());
        acc.expires_at = Some(crate::now_ms() + data.expires_in * 1_000);
    }
    storage::write(&crate::accounts_path(app)?, &accounts)?;

    Ok(new_token)
}

// ── Error helper ──────────────────────────────────────────────────────────────

async fn api_err(res: reqwest::Response) -> String {
    let status = res.status();
    let body: serde_json::Value = res.json().await.unwrap_or_default();
    body.pointer("/error/message")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("HTTP {}", status))
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
        _ => "application/octet-stream",
    }
}

fn rand_hex(n: usize) -> String {
    let mut buf = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn gdrive_list_files(
    app: tauri::AppHandle,
    account_id: String,
    folder_id: String,
    query: Option<String>,
) -> Result<Vec<DriveFile>, String> {
    let token = get_valid_token(&app, &account_id).await?;

    let q = if let Some(ref q_str) = query {
        format!("name contains '{}' and trashed = false", q_str)
    } else {
        format!("'{}' in parents and trashed = false", folder_id)
    };

    let res = client()
        .get(format!("{}/files", DRIVE_API))
        .bearer_auth(&token)
        .query(&[
            ("q", q.as_str()),
            ("fields", "files(id,name,mimeType,size,modifiedTime)"),
            ("orderBy", "folder,name"),
            ("pageSize", "200"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(api_err(res).await);
    }

    let data: ListResponse = res.json().await.map_err(|e| e.to_string())?;
    Ok(data.files.into_iter().map(|f| DriveFile {
        id: f.id, name: f.name, mime_type: f.mime_type,
        size: f.size, modified_time: f.modified_time,
    }).collect())
}

#[tauri::command]
pub async fn gdrive_download_file(
    app: tauri::AppHandle,
    account_id: String,
    file_id: String,
    dest_path: String,
) -> Result<(), String> {
    let token = get_valid_token(&app, &account_id).await?;

    let res = client()
        .get(format!("{}/files/{}?alt=media", DRIVE_API, file_id))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(api_err(res).await);
    }

    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    tokio::fs::write(&dest_path, &bytes)
        .await
        .map_err(|e| format!("write '{}': {}", dest_path, e))
}

#[tauri::command]
pub async fn gdrive_upload_file(
    app: tauri::AppHandle,
    account_id: String,
    folder_id: String,
    file_path: String,
) -> Result<(), String> {
    let token = get_valid_token(&app, &account_id).await?;

    let path = std::path::Path::new(&file_path);
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("invalid file path")?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let mime = mime_from_ext(&ext);

    let file_bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("read '{}': {}", file_path, e))?;

    let boundary = format!("csdrive_{}", rand_hex(8));
    let metadata = serde_json::json!({ "name": name, "parents": [folder_id] }).to_string();
    let pre = format!(
        "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n\
         --{boundary}\r\nContent-Type: {mime}\r\n\r\n"
    );
    let post = format!("\r\n--{boundary}--");

    let mut body = Vec::with_capacity(pre.len() + file_bytes.len() + post.len());
    body.extend_from_slice(pre.as_bytes());
    body.extend_from_slice(&file_bytes);
    body.extend_from_slice(post.as_bytes());

    let res = client()
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart")
        .bearer_auth(&token)
        .header("Content-Type", format!("multipart/related; boundary={}", boundary))
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(api_err(res).await);
    }
    Ok(())
}

#[tauri::command]
pub async fn gdrive_delete_file(
    app: tauri::AppHandle,
    account_id: String,
    file_id: String,
) -> Result<(), String> {
    let token = get_valid_token(&app, &account_id).await?;

    let res = client()
        .delete(format!("{}/files/{}", DRIVE_API, file_id))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() && res.status().as_u16() != 204 {
        return Err(api_err(res).await);
    }
    Ok(())
}

#[tauri::command]
pub async fn gdrive_create_folder(
    app: tauri::AppHandle,
    account_id: String,
    parent_id: String,
    name: String,
) -> Result<(), String> {
    let token = get_valid_token(&app, &account_id).await?;

    let res = client()
        .post(format!("{}/files", DRIVE_API))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "name": name,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id]
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(api_err(res).await);
    }
    Ok(())
}

#[tauri::command]
pub async fn gdrive_rename(
    app: tauri::AppHandle,
    account_id: String,
    file_id: String,
    new_name: String,
) -> Result<(), String> {
    let token = get_valid_token(&app, &account_id).await?;

    let res = client()
        .patch(format!("{}/files/{}", DRIVE_API, file_id))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "name": new_name }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(api_err(res).await);
    }
    Ok(())
}

#[tauri::command]
pub async fn gdrive_copy_file(
    app: tauri::AppHandle,
    account_id: String,
    file_id: String,
    dest_folder_id: String,
    name: String,
) -> Result<(), String> {
    let token = get_valid_token(&app, &account_id).await?;

    let res = client()
        .post(format!("{}/files/{}/copy", DRIVE_API, file_id))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "name": name, "parents": [dest_folder_id] }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(api_err(res).await);
    }
    Ok(())
}

#[tauri::command]
pub async fn gdrive_move_file(
    app: tauri::AppHandle,
    account_id: String,
    file_id: String,
    from_folder_id: String,
    to_folder_id: String,
) -> Result<(), String> {
    let token = get_valid_token(&app, &account_id).await?;

    let url = format!(
        "{}/files/{}?addParents={}&removeParents={}",
        DRIVE_API, file_id, to_folder_id, from_folder_id
    );

    let res = client()
        .patch(&url)
        .bearer_auth(&token)
        .header("Content-Length", "0")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(api_err(res).await);
    }
    Ok(())
}

#[tauri::command]
pub async fn gdrive_edit_file(
    app: tauri::AppHandle,
    account_id: String,
    file_id: String,
    file_path: String,
) -> Result<(), String> {
    let token = get_valid_token(&app, &account_id).await?;

    let path = std::path::Path::new(&file_path);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let mime = mime_from_ext(&ext);

    let bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("read '{}': {}", file_path, e))?;

    let res = client()
        .patch(format!(
            "https://www.googleapis.com/upload/drive/v3/files/{}?uploadType=media",
            file_id
        ))
        .bearer_auth(&token)
        .header("Content-Type", mime)
        .body(bytes)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(api_err(res).await);
    }
    Ok(())
}
