//! HTTP helpers for Filen's gateway (JSON API), egest (chunk download) and ingest
//! (chunk upload) hosts. Every gateway request carries a `Checksum` header: the
//! SHA-512 of the exact request body.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha512};

const GATEWAY: &str = "https://gateway.filen.io";
const EGEST: &str = "https://egest.filen.io";
const INGEST: &str = "https://ingest.filen.io";

#[derive(Deserialize)]
struct ApiResponse<T> {
    status: bool,
    message: Option<String>,
    data: Option<T>,
}

fn check<T>(r: ApiResponse<T>) -> Result<T, String> {
    if !r.status {
        return Err(r.message.unwrap_or_else(|| "Filen API error".into()));
    }
    r.data.ok_or_else(|| "Filen API returned no data".into())
}

async fn send_json<B: Serialize>(
    client: &reqwest::Client,
    endpoint: &str,
    body: &B,
    api_key: Option<&str>,
) -> Result<reqwest::Response, String> {
    let body_str = serde_json::to_string(body).map_err(|e| e.to_string())?;
    let checksum = hex::encode(Sha512::digest(body_str.as_bytes()));
    let auth = api_key.map(|k| format!("Bearer {k}")).unwrap_or_else(|| "Bearer anonymous".into());

    client
        .post(format!("{GATEWAY}{endpoint}"))
        .header("Authorization", auth)
        .header("Content-Type", "application/json")
        .header("Checksum", checksum)
        .body(body_str)
        .send()
        .await
        .map_err(|e| e.to_string())
}

/// POST that returns the response's `data`.
pub async fn post<B: Serialize, R: DeserializeOwned>(
    client: &reqwest::Client,
    endpoint: &str,
    body: &B,
    api_key: Option<&str>,
) -> Result<R, String> {
    let resp = send_json(client, endpoint, body, api_key).await?;
    check(resp.json::<ApiResponse<R>>().await.map_err(|e| e.to_string())?)
}

/// POST that only checks `status`.
pub async fn post_ok<B: Serialize>(client: &reqwest::Client, endpoint: &str, body: &B, api_key: &str) -> Result<(), String> {
    let resp = send_json(client, endpoint, body, Some(api_key)).await?;
    let parsed: ApiResponse<serde_json::Value> = resp.json().await.map_err(|e| e.to_string())?;
    if !parsed.status {
        return Err(parsed.message.unwrap_or_else(|| "Filen API error".into()));
    }
    Ok(())
}

pub async fn get<R: DeserializeOwned>(client: &reqwest::Client, endpoint: &str, api_key: &str) -> Result<R, String> {
    let resp = client
        .get(format!("{GATEWAY}{endpoint}"))
        .header("Authorization", format!("Bearer {api_key}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    check(resp.json::<ApiResponse<R>>().await.map_err(|e| e.to_string())?)
}

pub async fn download_chunk(
    client: &reqwest::Client,
    region: &str,
    bucket: &str,
    uuid: &str,
    index: u32,
) -> Result<Vec<u8>, String> {
    let resp = client
        .get(format!("{EGEST}/{region}/{bucket}/{uuid}/{index}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("chunk download failed with HTTP {}", resp.status()));
    }
    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
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
    // The checksum is SHA-512(JSON.stringify(parseURLParams(url))): URLSearchParams
    // makes every value a string (so `index` is "0", not 0), in query-string order.
    let checksum_input = format!(
        r#"{{"uuid":"{file_uuid}","index":"{index}","parent":"{parent}","uploadKey":"{upload_key}","hash":"{hash}"}}"#
    );
    let checksum = hex::encode(Sha512::digest(checksum_input.as_bytes()));

    let resp = client
        .post(format!("{INGEST}/v3/upload?uuid={file_uuid}&index={index}&parent={parent}&uploadKey={upload_key}&hash={hash}"))
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Checksum", checksum)
        .body(data.to_vec())
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let parsed: ApiResponse<serde_json::Value> = resp.json().await.map_err(|e| e.to_string())?;
    if !parsed.status {
        return Err(parsed.message.unwrap_or_else(|| "chunk upload failed".into()));
    }
    Ok(())
}
