use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha512};

const GATEWAY: &str = "https://gateway.filen.io";
const EGEST: &str = "https://egest.filen.io";
const INGEST: &str = "https://ingest.filen.io";

// ── API response wrapper ──────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ApiResponse<T> {
    status: bool,
    message: Option<String>,
    data: Option<T>,
}

fn check<T>(r: ApiResponse<T>) -> Result<T, String> {
    if !r.status {
        return Err(r.message.unwrap_or_else(|| "API error".into()));
    }
    r.data.ok_or_else(|| "API returned no data".into())
}

// ── Gateway POST ──────────────────────────────────────────────────────────────

pub async fn post<B: Serialize, R: DeserializeOwned>(
    client: &reqwest::Client,
    endpoint: &str,
    body: &B,
    api_key: Option<&str>,
) -> Result<R, String> {
    let body_str = serde_json::to_string(body).map_err(|e| e.to_string())?;
    let checksum = hex::encode(Sha512::digest(body_str.as_bytes()));
    let auth = api_key
        .map(|k| format!("Bearer {}", k))
        .unwrap_or_else(|| "Bearer anonymous".into());

    let resp = client
        .post(format!("{}{}", GATEWAY, endpoint))
        .header("Authorization", auth)
        .header("Content-Type", "application/json")
        .header("Checksum", checksum)
        .body(body_str)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let api_resp: ApiResponse<R> = resp.json().await.map_err(|e| e.to_string())?;
    check(api_resp)
}

/// POST that only checks `status` (no data payload).
pub async fn post_ok<B: Serialize>(
    client: &reqwest::Client,
    endpoint: &str,
    body: &B,
    api_key: &str,
) -> Result<(), String> {
    let body_str = serde_json::to_string(body).map_err(|e| e.to_string())?;
    let checksum = hex::encode(Sha512::digest(body_str.as_bytes()));

    let resp = client
        .post(format!("{}{}", GATEWAY, endpoint))
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .header("Checksum", checksum)
        .body(body_str)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let api_resp: ApiResponse<serde_json::Value> =
        resp.json().await.map_err(|e| e.to_string())?;
    if !api_resp.status {
        return Err(api_resp.message.unwrap_or_else(|| "API error".into()));
    }
    Ok(())
}

// ── Gateway GET ───────────────────────────────────────────────────────────────

pub async fn get<R: DeserializeOwned>(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
) -> Result<R, String> {
    let resp = client
        .get(format!("{}{}", GATEWAY, endpoint))
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let api_resp: ApiResponse<R> = resp.json().await.map_err(|e| e.to_string())?;
    check(api_resp)
}

// ── Chunk download (egress, no auth) ─────────────────────────────────────────

pub async fn download_chunk(
    client: &reqwest::Client,
    region: &str,
    bucket: &str,
    uuid: &str,
    index: u32,
) -> Result<Vec<u8>, String> {
    let url = format!("{}/{}/{}/{}/{}", EGEST, region, bucket, uuid, index);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("chunk download HTTP {}", resp.status()));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| e.to_string())
}

// ── Chunk upload (ingress) ────────────────────────────────────────────────────

pub async fn upload_chunk(
    client: &reqwest::Client,
    file_uuid: &str,
    index: u32,
    parent: &str,
    upload_key: &str,
    hash: &str,
    data: &[u8],
    api_key: &str,
) -> Result<(), String> {
    // Checksum = SHA-512(JSON.stringify(parseURLParams(fullURL))).
    // URLSearchParams coerces all values to strings, so index is "0" not 0.
    // Key order matches query string order: uuid, index, parent, uploadKey, hash.
    let checksum_input = format!(
        r#"{{"uuid":"{}","index":"{}","parent":"{}","uploadKey":"{}","hash":"{}"}}"#,
        file_uuid, index, parent, upload_key, hash
    );
    let checksum = hex::encode(Sha512::digest(checksum_input.as_bytes()));

    let url = format!(
        "{}/v3/upload?uuid={}&index={}&parent={}&uploadKey={}&hash={}",
        INGEST, file_uuid, index, parent, upload_key, hash
    );

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Checksum", checksum)
        .body(data.to_vec())
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let api_resp: ApiResponse<serde_json::Value> =
        resp.json().await.map_err(|e| e.to_string())?;
    if !api_resp.status {
        return Err(api_resp.message.unwrap_or_else(|| "chunk upload failed".into()));
    }
    Ok(())
}
