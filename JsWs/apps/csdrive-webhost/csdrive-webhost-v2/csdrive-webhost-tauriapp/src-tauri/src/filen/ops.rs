//! Path-based file operations on one Filen account.
//!
//! Filen addresses everything by UUID and stores every name encrypted, so a path is
//! resolved by walking down from the account's base folder, decrypting each level's
//! child names. All the encryption, hashing and upload/download protocol details
//! live here and in `crypto`/`api`; callers only ever deal in plain paths and bytes.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};

use super::{api, crypto, Session};

/// Files are encrypted and transferred in chunks of this size.
const CHUNK_SIZE: usize = 1_048_576;

// ── What callers see ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub is_directory: bool,
    pub size: Option<u64>,
    pub mtime_ms: Option<u64>,
}

// ── Filen response shapes ─────────────────────────────────────────────────────

#[derive(Deserialize)]
struct DirContentResponse {
    uploads: Vec<DirUpload>,
    folders: Vec<DirFolder>,
}

#[derive(Deserialize)]
struct DirUpload {
    uuid: String,
    metadata: String,
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
    #[serde(default)]
    hash: Option<String>,
}

#[derive(Deserialize)]
struct FileInfoResponse {
    region: String,
    bucket: String,
    metadata: String,
    chunks: u32,
    version: u8,
}

#[derive(Deserialize)]
struct CreateDirResponse {
    uuid: String,
}

// ── Children of a folder ──────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Child {
    uuid: String,
    name: String,
    kind: Kind,
}

#[derive(Debug, Clone)]
enum Kind {
    Dir { modified_ms: u64 },
    File { size: u64, modified_ms: u64 },
}

impl Child {
    fn is_dir(&self) -> bool {
        matches!(self.kind, Kind::Dir { .. })
    }

    fn entry(&self) -> Entry {
        match self.kind {
            Kind::Dir { modified_ms } => Entry { name: self.name.clone(), is_directory: true, size: None, mtime_ms: Some(modified_ms) },
            Kind::File { size, modified_ms } => {
                Entry { name: self.name.clone(), is_directory: false, size: Some(size), mtime_ms: Some(modified_ms) }
            }
        }
    }
}

fn decrypt_folder_name(encrypted: &str, master_keys: &[String]) -> Result<String, String> {
    let plain = crypto::decrypt_metadata(encrypted, master_keys)?;
    // Stored as `{"name":"…"}`, though older data may be the bare name.
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&plain) {
        if let Some(name) = value.get("name").and_then(|n| n.as_str()) {
            return Ok(name.to_string());
        }
    }
    Ok(plain)
}

async fn list_children(s: &Session, dir_uuid: &str) -> Result<Vec<Child>, String> {
    let content: DirContentResponse =
        api::post(&s.client, "/v3/dir/content", &serde_json::json!({ "uuid": dir_uuid }), Some(&s.api_key)).await?;

    let mut children = Vec::with_capacity(content.folders.len() + content.uploads.len());
    // Anything whose name can't be decrypted (e.g. shared with a key we don't hold)
    // is left out rather than failing the whole listing.
    for folder in content.folders {
        if let Ok(name) = decrypt_folder_name(&folder.name, &s.master_keys) {
            children.push(Child { uuid: folder.uuid, name, kind: Kind::Dir { modified_ms: folder.timestamp * 1000 } });
        }
    }
    for upload in content.uploads {
        let meta = crypto::decrypt_metadata(&upload.metadata, &s.master_keys)
            .and_then(|plain| serde_json::from_str::<FileMetadata>(&plain).map_err(|e| e.to_string()));
        if let Ok(meta) = meta {
            children.push(Child {
                uuid: upload.uuid,
                name: meta.name,
                kind: Kind::File { size: meta.size, modified_ms: meta.last_modified.unwrap_or(upload.timestamp * 1000) },
            });
        }
    }
    Ok(children)
}

// ── Paths ─────────────────────────────────────────────────────────────────────

/// Splits an absolute Filen path (`/`, `/Folder/file.txt`) into its names.
fn split_path(path: &str) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" => {}
            "." | ".." => return Err(format!("\"{path}\": \".\" and \"..\" aren't allowed in paths.")),
            name => names.push(name.to_string()),
        }
    }
    Ok(names)
}

fn display(names: &[String]) -> String {
    format!("/{}", names.join("/"))
}

/// Filen names are unique case-insensitively, so look up that way — but prefer an
/// exact-case match if there somehow is one.
fn find<'a>(children: &'a [Child], name: &str) -> Option<&'a Child> {
    children
        .iter()
        .find(|c| c.name == name)
        .or_else(|| children.iter().find(|c| c.name.to_lowercase() == name.to_lowercase()))
}

async fn resolve_dir(s: &Session, names: &[String]) -> Result<String, String> {
    let mut uuid = s.base_folder_uuid.clone();
    for (depth, name) in names.iter().enumerate() {
        let children = list_children(s, &uuid).await?;
        match find(&children, name) {
            Some(child) if child.is_dir() => uuid = child.uuid.clone(),
            Some(_) => return Err(format!("{} isn't a folder.", display(&names[..=depth]))),
            None => return Err(format!("{}: no such folder.", display(&names[..=depth]))),
        }
    }
    Ok(uuid)
}

struct Located {
    parent_uuid: String,
    child: Child,
}

/// Finds the file or folder at a non-root path.
async fn locate(s: &Session, names: &[String]) -> Result<Located, String> {
    let (name, parent_names) = names.split_last().ok_or_else(|| "The root folder can't be used here.".to_string())?;
    let parent_uuid = resolve_dir(s, parent_names).await?;
    let children = list_children(s, &parent_uuid).await?;
    let child = find(&children, name).cloned().ok_or_else(|| format!("{}: no such file or folder.", display(names)))?;
    Ok(Located { parent_uuid, child })
}

// ── Reading ───────────────────────────────────────────────────────────────────

pub async fn readdir(s: &Session, path: &str) -> Result<Vec<Entry>, String> {
    let uuid = resolve_dir(s, &split_path(path)?).await?;
    let mut entries: Vec<Entry> = list_children(s, &uuid).await?.iter().map(Child::entry).collect();
    entries.sort_by(|a, b| b.is_directory.cmp(&a.is_directory).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

pub async fn stat(s: &Session, path: &str) -> Result<Entry, String> {
    let names = split_path(path)?;
    if names.is_empty() {
        return Ok(Entry { name: String::new(), is_directory: true, size: None, mtime_ms: None });
    }
    Ok(locate(s, &names).await?.child.entry())
}

async fn file_info(s: &Session, uuid: &str) -> Result<FileInfoResponse, String> {
    api::post(&s.client, "/v3/file", &serde_json::json!({ "uuid": uuid }), Some(&s.api_key)).await
}

fn file_metadata(s: &Session, info: &FileInfoResponse) -> Result<FileMetadata, String> {
    let plain = crypto::decrypt_metadata(&info.metadata, &s.master_keys)?;
    serde_json::from_str(&plain).map_err(|e| e.to_string())
}

pub async fn read_file(s: &Session, path: &str) -> Result<Vec<u8>, String> {
    let names = split_path(path)?;
    let located = locate(s, &names).await?;
    if located.child.is_dir() {
        return Err(format!("{} is a folder, not a file.", display(&names)));
    }

    let info = file_info(s, &located.child.uuid).await?;
    let meta = file_metadata(s, &info)?;
    let mut content = Vec::with_capacity(meta.size as usize);
    for index in 0..info.chunks {
        let encrypted = api::download_chunk(&s.client, &info.region, &info.bucket, &located.child.uuid, index).await?;
        content.extend_from_slice(&crypto::decrypt_chunk(&encrypted, &meta.key, info.version)?);
    }
    Ok(content)
}

// ── Writing ───────────────────────────────────────────────────────────────────

/// Creates or replaces the file at `path` (its folder must already exist). Replacing
/// uploads the new content as a fresh file and then trashes the old one, since Filen
/// files are immutable.
pub async fn write_file(s: &Session, path: &str, content: &[u8]) -> Result<(), String> {
    let names = split_path(path)?;
    let (name, parent_names) = names.split_last().ok_or_else(|| "The root folder can't be written to.".to_string())?;
    let parent_uuid = resolve_dir(s, parent_names).await?;
    let children = list_children(s, &parent_uuid).await?;

    match find(&children, name) {
        Some(existing) if existing.is_dir() => Err(format!("{} is a folder.", display(&names))),
        Some(existing) => {
            let new_uuid = upload_new(s, &parent_uuid, &existing.name, content).await?;
            // Only discard the old version once the new one is confirmed readable.
            if file_info(s, &new_uuid).await.is_ok() {
                let _ = api::post_ok(&s.client, "/v3/file/trash", &serde_json::json!({ "uuid": existing.uuid }), &s.api_key).await;
            }
            Ok(())
        }
        None => upload_new(s, &parent_uuid, name, content).await.map(|_| ()),
    }
}

async fn upload_new(s: &Session, parent_uuid: &str, name: &str, content: &[u8]) -> Result<String, String> {
    let master_key = s.master_keys.last().ok_or("The account has no master key.")?;
    let file_uuid = uuid::Uuid::new_v4().to_string();
    let file_key = crypto::generate_file_key_v2();
    let upload_key = crypto::generate_random_string(32);
    let mime = mime_from_name(name);
    let last_modified = now_ms();
    let total_size = content.len() as u64;

    let mut content_hasher = Sha512::new();
    let mut chunks: u32 = 0;
    for chunk in content.chunks(CHUNK_SIZE) {
        content_hasher.update(chunk);
        let encrypted = crypto::encrypt_chunk_v2(chunk, &file_key)?;
        let chunk_hash = hex::encode(Sha512::digest(&encrypted));
        api::upload_chunk(&s.client, &file_uuid, chunks, parent_uuid, &upload_key, &chunk_hash, &encrypted, &s.api_key).await?;
        chunks += 1;
    }

    let name_enc = crypto::encrypt_metadata(name, &file_key)?;
    let name_hashed = s.hash_name(name)?;
    let size_enc = crypto::encrypt_metadata(&total_size.to_string(), &file_key)?;
    let mime_enc = crypto::encrypt_metadata(mime, &file_key)?;
    let rm = crypto::generate_random_string(32);

    let mut metadata = serde_json::json!({
        "name": name, "size": total_size, "mime": mime, "key": file_key, "lastModified": last_modified
    });
    if chunks > 0 {
        metadata["hash"] = serde_json::Value::String(hex::encode(content_hasher.finalize()));
    }
    let metadata_enc = crypto::encrypt_metadata(&metadata.to_string(), master_key)?;

    if chunks == 0 {
        api::post_ok(
            &s.client,
            "/v3/upload/empty",
            &serde_json::json!({
                "uuid": file_uuid, "name": name_enc, "nameHashed": name_hashed, "size": size_enc,
                "mime": mime_enc, "metadata": metadata_enc, "version": 2, "parent": parent_uuid
            }),
            &s.api_key,
        )
        .await?;
    } else {
        api::post_ok(
            &s.client,
            "/v3/upload/done",
            &serde_json::json!({
                "uuid": file_uuid, "name": name_enc, "nameHashed": name_hashed, "size": size_enc,
                "chunks": chunks, "mime": mime_enc, "rm": rm, "metadata": metadata_enc,
                "version": 2, "uploadKey": upload_key
            }),
            &s.api_key,
        )
        .await?;
    }
    Ok(file_uuid)
}

async fn create_dir(s: &Session, parent_uuid: &str, name: &str) -> Result<String, String> {
    let master_key = s.master_keys.last().ok_or("The account has no master key.")?;
    let name_enc = crypto::encrypt_metadata(&serde_json::json!({ "name": name }).to_string(), master_key)?;
    let created: CreateDirResponse = api::post(
        &s.client,
        "/v3/dir/create",
        &serde_json::json!({
            "uuid": uuid::Uuid::new_v4().to_string(), "name": name_enc,
            "nameHashed": s.hash_name(name)?, "parent": parent_uuid
        }),
        Some(&s.api_key),
    )
    .await?;
    Ok(created.uuid)
}

/// Creates the folder at `path`, and any missing folders above it.
pub async fn mkdir(s: &Session, path: &str) -> Result<(), String> {
    let mut uuid = s.base_folder_uuid.clone();
    let names = split_path(path)?;
    for (depth, name) in names.iter().enumerate() {
        let children = list_children(s, &uuid).await?;
        uuid = match find(&children, name) {
            Some(child) if child.is_dir() => child.uuid.clone(),
            Some(_) => return Err(format!("{} already exists and isn't a folder.", display(&names[..=depth]))),
            None => create_dir(s, &uuid, name).await?,
        };
    }
    Ok(())
}

/// Moves a file or folder to Filen's trash.
pub async fn remove(s: &Session, path: &str) -> Result<(), String> {
    let located = locate(s, &split_path(path)?).await?;
    let endpoint = if located.child.is_dir() { "/v3/dir/trash" } else { "/v3/file/trash" };
    api::post_ok(&s.client, endpoint, &serde_json::json!({ "uuid": located.child.uuid }), &s.api_key).await
}

/// Renames and/or moves a file or folder. The destination's folder must exist and
/// the destination itself must not.
pub async fn rename(s: &Session, from: &str, to: &str) -> Result<(), String> {
    let from_names = split_path(from)?;
    let to_names = split_path(to)?;
    let located = locate(s, &from_names).await?;
    let (new_name, to_parent_names) = to_names.split_last().ok_or_else(|| "The root folder can't be a destination.".to_string())?;

    let to_parent_uuid = resolve_dir(s, to_parent_names).await?;
    let siblings = list_children(s, &to_parent_uuid).await?;
    if let Some(existing) = find(&siblings, new_name) {
        if existing.uuid != located.child.uuid {
            return Err(format!("{} already exists.", display(&to_names)));
        }
    }

    let is_dir = located.child.is_dir();
    let uuid = &located.child.uuid;

    if to_parent_uuid != located.parent_uuid {
        let endpoint = if is_dir { "/v3/dir/move" } else { "/v3/file/move" };
        api::post_ok(&s.client, endpoint, &serde_json::json!({ "uuid": uuid, "to": to_parent_uuid }), &s.api_key).await?;
    }
    if new_name != &located.child.name {
        rename_in_place(s, uuid, is_dir, new_name).await?;
    }
    Ok(())
}

async fn rename_in_place(s: &Session, uuid: &str, is_dir: bool, new_name: &str) -> Result<(), String> {
    let master_key = s.master_keys.last().ok_or("The account has no master key.")?;
    let name_hashed = s.hash_name(new_name)?;

    if is_dir {
        let name_enc = crypto::encrypt_metadata(&serde_json::json!({ "name": new_name }).to_string(), master_key)?;
        return api::post_ok(
            &s.client,
            "/v3/dir/rename",
            &serde_json::json!({ "uuid": uuid, "name": name_enc, "nameHashed": name_hashed }),
            &s.api_key,
        )
        .await;
    }

    // A file's name is encrypted with the file's own key, and repeated inside its
    // metadata (encrypted with the master key) — both must change.
    let meta = file_metadata(s, &file_info(s, uuid).await?)?;
    let name_enc = crypto::encrypt_metadata(new_name, &meta.key)?;
    let mut new_meta = serde_json::json!({
        "name": new_name, "size": meta.size, "mime": meta.mime,
        "key": meta.key, "lastModified": meta.last_modified.unwrap_or(0)
    });
    if let Some(hash) = &meta.hash {
        new_meta["hash"] = serde_json::Value::String(hash.clone());
    }
    let metadata_enc = crypto::encrypt_metadata(&new_meta.to_string(), master_key)?;
    api::post_ok(
        &s.client,
        "/v3/file/rename",
        &serde_json::json!({ "uuid": uuid, "name": name_enc, "nameHashed": name_hashed, "metadata": metadata_enc }),
        &s.api_key,
    )
    .await
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn mime_from_name(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default();
    match ext.as_str() {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_split_into_names() {
        assert_eq!(split_path("/").unwrap(), Vec::<String>::new());
        assert_eq!(split_path("").unwrap(), Vec::<String>::new());
        assert_eq!(split_path("/a//b/c.txt/").unwrap(), ["a", "b", "c.txt"]);
        assert!(split_path("/a/../b").is_err());
        assert!(split_path("/./a").is_err());
    }

    #[test]
    fn lookups_are_case_insensitive_but_prefer_an_exact_match() {
        let child = |name: &str| Child { uuid: name.to_string(), name: name.to_string(), kind: Kind::Dir { modified_ms: 0 } };
        let children = [child("Docs"), child("docs")];
        assert_eq!(find(&children, "docs").unwrap().uuid, "docs");
        assert_eq!(find(&children, "DOCS").unwrap().uuid, "Docs");
        assert!(find(&children, "other").is_none());
    }

    #[test]
    fn mime_types_come_from_the_extension() {
        assert_eq!(mime_from_name("photo.JPG"), "image/jpeg");
        assert_eq!(mime_from_name("notes.md"), "text/markdown");
        assert_eq!(mime_from_name("noextension"), "application/octet-stream");
    }

    #[test]
    fn children_become_entries() {
        let dir = Child { uuid: "u".into(), name: "d".into(), kind: Kind::Dir { modified_ms: 5 } };
        assert_eq!(dir.entry(), Entry { name: "d".into(), is_directory: true, size: None, mtime_ms: Some(5) });
        let file = Child { uuid: "u".into(), name: "f".into(), kind: Kind::File { size: 9, modified_ms: 7 } };
        assert_eq!(file.entry(), Entry { name: "f".into(), is_directory: false, size: Some(9), mtime_ms: Some(7) });
    }
}
