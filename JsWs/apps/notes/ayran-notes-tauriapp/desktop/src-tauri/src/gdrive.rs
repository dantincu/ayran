use crate::storage;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tauri::Emitter;
use tokio::io::AsyncWriteExt;

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
#[serde(rename_all = "camelCase")]
struct ListResponse {
    #[serde(default)]
    files: Vec<DriveFileRaw>,
    next_page_token: Option<String>,
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

/// Pages through an entire folder's contents, inserting every row into the
/// SQLite cache as each page arrives.  Returns the total number of items inserted.
pub async fn list_to_cache(
    app: &tauri::AppHandle,
    account_id: &str,
    folder_id: &str,
    db: crate::cache::CacheDb,
) -> Result<u64, String> {
    let token = get_valid_token(app, account_id).await?;
    let email = crate::load_accounts(app)?
        .get(account_id)
        .map(|a| a.email.clone())
        .unwrap_or_default();

    let q = format!("'{}' in parents and trashed = false", folder_id);
    let mut page_token: Option<String> = None;
    let mut total: u64 = 0;

    loop {
        let mut req = client()
            .get(format!("{}/files", DRIVE_API))
            .bearer_auth(&token)
            .query(&[
                ("q", q.as_str()),
                ("fields", "nextPageToken,files(id,name,mimeType,size,modifiedTime)"),
                ("orderBy", "folder,name"),
                ("pageSize", "1000"),
            ]);
        if let Some(ref pt) = page_token {
            req = req.query(&[("pageToken", pt.as_str())]);
        }

        let res = req.send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(api_err(res).await);
        }
        let data: ListResponse = res.json().await.map_err(|e| e.to_string())?;

        let items: Vec<crate::cache::CachedItem> = data
            .files
            .into_iter()
            .map(|f| {
                let is_dir = f.mime_type == "application/vnd.google-apps.folder";
                let size = f.size.as_deref().and_then(|s| s.parse::<i64>().ok());
                let modified_ms = f.modified_time.as_deref().and_then(parse_rfc3339_ms);
                crate::cache::CachedItem {
                    account_id: account_id.to_string(),
                    account_email: email.clone(),
                    storage_type: crate::cache::STORAGE_GOOGLE_DRIVE,
                    item_id: f.id,
                    parent_id: folder_id.to_string(),
                    name: f.name,
                    is_dir,
                    size,
                    modified_ms,
                    mime_type: Some(f.mime_type),
                }
            })
            .collect();

        let count = items.len() as u64;
        let db_clone = std::sync::Arc::clone(&db);
        tokio::task::spawn_blocking(move || {
            let mut conn = db_clone.lock().map_err(|e| e.to_string())?;
            crate::cache::insert_batch(&mut *conn, &items)
        })
        .await
        .map_err(|e| e.to_string())??;

        total += count;
        page_token = data.next_page_token;
        if page_token.is_none() {
            break;
        }
    }
    Ok(total)
}

/// Parse an RFC 3339 timestamp (e.g. "2023-05-15T10:30:00.123Z") to Unix milliseconds.
fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    let s = s.trim_end_matches('Z');
    let (date_part, time_part) = s.split_once('T')?;
    let mut dp = date_part.split('-');
    let year: i64 = dp.next()?.parse().ok()?;
    let month: i64 = dp.next()?.parse().ok()?;
    let day: i64 = dp.next()?.parse().ok()?;
    let (hms, frac) = time_part.split_once('.').unwrap_or((time_part, ""));
    let mut tp = hms.split(':');
    let h: i64 = tp.next()?.parse().ok()?;
    let m: i64 = tp.next()?.parse().ok()?;
    let sec: i64 = tp.next()?.parse().ok()?;
    let ms: i64 = if frac.is_empty() {
        0
    } else {
        format!("{:0<3}", &frac[..frac.len().min(3)]).parse().unwrap_or(0)
    };
    let days = gregorian_days_since_epoch(year, month, day)?;
    Some((days * 86_400 + h * 3_600 + m * 60 + sec) * 1_000 + ms)
}

/// Days since 1970-01-01 using the proleptic Gregorian calendar (Julian Day Number method).
fn gregorian_days_since_epoch(year: i64, month: i64, day: i64) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let a = (14 - month) / 12;
    let y = year + 4800 - a;
    let mo = month + 12 * a - 3;
    let jdn = day + (153 * mo + 2) / 5 + 365 * y + y / 4 - y / 100 + y / 400 - 32045;
    Some(jdn - 2_440_588)
}

fn rand_hex(n: usize) -> String {
    let mut buf = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Searches a folder for children whose name exactly matches `name`.
/// Returns all matching file IDs (GDrive allows multiple siblings with the same name).
/// Used for recursive path resolution — only IDs are returned to minimize data transfer.
#[tauri::command]
pub async fn gdrive_find_children_by_name(
    app: tauri::AppHandle,
    account_id: String,
    parent_id: String,
    name: String,
) -> Result<Vec<String>, String> {
    let token = get_valid_token(&app, &account_id).await?;
    // Escape single-quotes in name for the GDrive query syntax
    let safe_name = name.replace('\\', "\\\\").replace('\'', "\\'");
    let q = format!(
        "'{}' in parents and name='{}' and trashed=false",
        parent_id, safe_name
    );
    let res = client()
        .get(format!("{}/files", DRIVE_API))
        .bearer_auth(&token)
        .query(&[
            ("q", q.as_str()),
            ("fields", "files(id)"),
            ("pageSize", "10"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(api_err(res).await);
    }
    #[derive(Deserialize)]
    struct Resp { files: Vec<IdOnly> }
    #[derive(Deserialize)]
    struct IdOnly { id: String }
    let data: Resp = res.json().await.map_err(|e| e.to_string())?;
    Ok(data.files.into_iter().map(|f| f.id).collect())
}

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

pub(crate) async fn download_to_path(
    app: &tauri::AppHandle,
    account_id: &str,
    file_id: &str,
    dest_path: &str,
) -> Result<(), String> {
    let token = get_valid_token(app, account_id).await?;
    let mut res = client()
        .get(format!("{}/files/{}?alt=media", DRIVE_API, file_id))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(api_err(res).await);
    }
    let total = res.content_length();
    let mut file = tokio::fs::File::create(dest_path)
        .await
        .map_err(|e| format!("create '{}': {}", dest_path, e))?;
    let mut loaded: u64 = 0;
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        loaded += chunk.len() as u64;
        let _ = app.emit("file-download-progress", serde_json::json!({ "loaded": loaded, "total": total }));
    }
    file.flush().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn gdrive_download_file(
    app: tauri::AppHandle,
    account_id: String,
    file_id: String,
    dest_path: String,
) -> Result<(), String> {
    download_to_path(&app, &account_id, &file_id, &dest_path).await
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

    let boundary = format!("notes_{}", rand_hex(8));
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

/// Upload bytes as a new file. Returns the new Drive file ID.
pub async fn upload_bytes(
    app: &tauri::AppHandle,
    account_id: &str,
    folder_id: &str,
    filename: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let token = get_valid_token(app, account_id).await?;
    let ext = filename.rsplit('.').next().unwrap_or("").to_lowercase();
    let mime = mime_from_ext(&ext);
    let boundary = format!("notes_{}", rand_hex(8));
    let metadata = serde_json::json!({ "name": filename, "parents": [folder_id] }).to_string();
    let pre = format!(
        "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n\
         --{boundary}\r\nContent-Type: {mime}\r\n\r\n"
    );
    let post = format!("\r\n--{boundary}--");
    let mut body = Vec::with_capacity(pre.len() + bytes.len() + post.len());
    body.extend_from_slice(pre.as_bytes());
    body.extend_from_slice(bytes);
    body.extend_from_slice(post.as_bytes());

    #[derive(serde::Deserialize)]
    struct UploadResp { id: String }

    let res = client()
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart")
        .bearer_auth(&token)
        .header("Content-Type", format!("multipart/related; boundary={}", boundary))
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() { return Err(api_err(res).await); }
    let json: UploadResp = res.json().await.map_err(|e| e.to_string())?;
    Ok(json.id)
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

pub(crate) async fn edit_bytes(
    app: &tauri::AppHandle,
    account_id: &str,
    file_id: &str,
    bytes: &[u8],
    name: &str,
) -> Result<(), String> {
    let token = get_valid_token(app, account_id).await?;
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    let mime = mime_from_ext(&ext);
    let res = client()
        .patch(format!("https://www.googleapis.com/upload/drive/v3/files/{}?uploadType=media", file_id))
        .bearer_auth(&token)
        .header("Content-Type", mime)
        .body(bytes.to_vec())
        .send().await.map_err(|e| e.to_string())?;
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
