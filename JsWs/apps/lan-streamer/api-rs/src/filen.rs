// Filen.io login, ported from the Rust implementation in
// ayran-notes-tauriapp (desktop/src-tauri/src/filen/{api,crypto}.rs) - there
// is no official Filen Rust SDK, so that project reimplemented the gateway
// HTTP calls and client-side crypto from scratch. Only the login portion is
// needed here (no file/folder operations), and base_folder_uuid is dropped
// entirely since LAN Streamer has no use for it.

use aes_gcm::{aead::Aead, Aes256Gcm, Key, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};
use pbkdf2::pbkdf2_hmac;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha512};

use crate::types::FilenAccount;

const GATEWAY: &str = "https://gateway.filen.io";

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

async fn post<B: Serialize, R: DeserializeOwned>(client: &reqwest::Client, endpoint: &str, body: &B) -> Result<R, String> {
    let body_str = serde_json::to_string(body).map_err(|e| e.to_string())?;
    let checksum = hex::encode(Sha512::digest(body_str.as_bytes()));

    let resp = client
        .post(format!("{GATEWAY}{endpoint}"))
        .header("Authorization", "Bearer anonymous")
        .header("Content-Type", "application/json")
        .header("Checksum", checksum)
        .body(body_str)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let api_resp: ApiResponse<R> = resp.json().await.map_err(|e| e.to_string())?;
    check(api_resp)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthInfoResponse {
    auth_version: u8,
    salt: String,
    id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginResponse {
    api_key: String,
    master_keys: Option<String>,
}

/// AuthVersion 2: PBKDF2-HMAC-SHA512(pw, salt, 200k, 64 bytes).
/// Returns (derived_password_for_api, initial_master_key).
fn derive_keys_v2(password: &str, salt: &str) -> (String, String) {
    let mut derived = [0u8; 64];
    pbkdf2_hmac::<Sha512>(password.as_bytes(), salt.as_bytes(), 200_000, &mut derived);
    let hex = hex::encode(derived);
    let master_key = hex[..64].to_string();
    let password_half = hex[64..].to_string();
    let derived_password = hex::encode(Sha512::digest(password_half.as_bytes()));
    (derived_password, master_key)
}

/// AuthVersion 3: Argon2id. Returns (derived_password_for_api, initial_master_key).
fn derive_keys_v3(password: &str, salt_hex: &str) -> Result<(String, String), String> {
    let salt = hex::decode(salt_hex).map_err(|e| e.to_string())?;
    let params = argon2::Params::new(65536, 3, 4, Some(64)).map_err(|e| e.to_string())?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut derived = [0u8; 64];
    argon
        .hash_password_into(password.as_bytes(), &salt, &mut derived)
        .map_err(|e| e.to_string())?;
    let hex = hex::encode(derived);
    let master_key = hex[..64].to_string();
    let derived_password = hex[64..].to_string();
    Ok((derived_password, master_key))
}

fn decrypt_with_key(ciphertext: &str, key: &str) -> Result<String, String> {
    if ciphertext.starts_with("003") {
        decrypt_003(ciphertext, key)
    } else if ciphertext.starts_with("002") {
        decrypt_002(ciphertext, key)
    } else {
        Err("unsupported metadata encryption version".into())
    }
}

fn decrypt_002(ct: &str, key: &str) -> Result<String, String> {
    let bytes = ct.as_bytes();
    if bytes.len() < 15 {
        return Err("002: ciphertext too short".into());
    }
    let iv = &bytes[3..15];
    let body = STANDARD.decode(&ct[15..]).map_err(|e| e.to_string())?;
    if body.len() < 16 {
        return Err("002: body too short".into());
    }
    let mut key_bytes = [0u8; 32];
    pbkdf2_hmac::<Sha512>(key.as_bytes(), key.as_bytes(), 1, &mut key_bytes);
    aes_gcm_decrypt(&key_bytes, iv, &body)
}

fn decrypt_003(ct: &str, key: &str) -> Result<String, String> {
    if ct.len() < 27 {
        return Err("003: ciphertext too short".into());
    }
    let iv = hex::decode(&ct[3..27]).map_err(|e| e.to_string())?;
    let body = STANDARD.decode(&ct[27..]).map_err(|e| e.to_string())?;
    if body.len() < 16 {
        return Err("003: body too short".into());
    }
    let key_bytes = hex::decode(key).map_err(|e| e.to_string())?;
    if key_bytes.len() != 32 {
        return Err("003: key must be 64 hex chars (32 bytes)".into());
    }
    aes_gcm_decrypt(&key_bytes, &iv, &body)
}

fn aes_gcm_decrypt(key: &[u8], iv: &[u8], body_with_tag: &[u8]) -> Result<String, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(iv);
    let plain = cipher.decrypt(nonce, body_with_tag).map_err(|_| "AES-GCM authentication failed".to_string())?;
    String::from_utf8(plain).map_err(|e| e.to_string())
}

pub async fn login_with_filen(email: &str, password: &str, two_factor_code: Option<String>) -> Result<FilenAccount, String> {
    let client = reqwest::Client::new();

    let auth_info: AuthInfoResponse = post(&client, "/v3/auth/info", &serde_json::json!({ "email": email })).await?;

    let (derived_password, initial_master_key) = match auth_info.auth_version {
        2 => derive_keys_v2(password, &auth_info.salt),
        3 => derive_keys_v3(password, &auth_info.salt)?,
        v => return Err(format!("Unsupported auth version: {v}")),
    };

    let login: LoginResponse = post(
        &client,
        "/v3/login",
        &serde_json::json!({
            "email": email,
            "password": derived_password,
            "twoFactorCode": two_factor_code.unwrap_or_else(|| "XXXXXX".into()),
            "authVersion": auth_info.auth_version,
        }),
    )
    .await?;

    // Master keys aren't actually used by LAN Streamer (no file/folder
    // access needed), but decrypting them anyway mirrors the real login
    // flow exactly and surfaces a decrypt failure as a login failure rather
    // than silently accepting a bad password derivation.
    if let Some(enc) = login.master_keys.filter(|s| !s.is_empty()) {
        decrypt_with_key(&enc, &initial_master_key)?;
    }
    let _ = login.api_key;

    Ok(FilenAccount {
        user_id: auth_info.id,
        email: email.to_string(),
    })
}
