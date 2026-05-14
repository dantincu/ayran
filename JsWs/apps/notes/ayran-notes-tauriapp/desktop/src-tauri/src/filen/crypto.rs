use aes_gcm::{aead::Aead, Aes256Gcm, Key, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use sha1::Sha1;
use sha2::{Digest, Sha512};

// ── Metadata decrypt ──────────────────────────────────────────────────────────

/// Try every master key (newest first) until one decrypts successfully.
pub fn decrypt_metadata(ciphertext: &str, master_keys: &[String]) -> Result<String, String> {
    for key in master_keys.iter().rev() {
        if let Ok(plain) = decrypt_with_key(ciphertext, key) {
            return Ok(plain);
        }
    }
    Err("decrypt_metadata: all master keys failed".into())
}

pub fn decrypt_with_key(ciphertext: &str, key: &str) -> Result<String, String> {
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
    let iv = &bytes[3..15]; // 12 UTF-8 bytes
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
    let plain = cipher
        .decrypt(nonce, body_with_tag)
        .map_err(|_| "AES-GCM authentication failed".to_string())?;
    String::from_utf8(plain).map_err(|e| e.to_string())
}

// ── Metadata encrypt ──────────────────────────────────────────────────────────

/// Always encrypt with "002" for maximum compatibility with all Filen SDK versions.
/// The Filen desktop app has a known issue decrypting "003"-format metadata produced
/// by third-party clients, while the web app handles both formats. "002" uses
/// AES-256-GCM with a PBKDF2-derived key and is supported by every SDK release.
pub fn encrypt_metadata(plaintext: &str, key: &str) -> Result<String, String> {
    encrypt_002(plaintext, key)
}

fn encrypt_002(plaintext: &str, key: &str) -> Result<String, String> {
    let mut key_bytes = [0u8; 32];
    pbkdf2_hmac::<Sha512>(key.as_bytes(), key.as_bytes(), 1, &mut key_bytes);
    let iv_str = random_ascii(12);
    let iv = iv_str.as_bytes();
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let nonce = Nonce::from_slice(iv);
    let ct = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(format!("002{}{}", iv_str, STANDARD.encode(&ct)))
}

fn encrypt_003(plaintext: &str, key: &str) -> Result<String, String> {
    let key_bytes = hex::decode(key).map_err(|e| e.to_string())?;
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let nonce = Nonce::from_slice(&iv);
    let ct = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(format!("003{}{}", hex::encode(iv), STANDARD.encode(&ct)))
}

// ── File chunk decrypt ────────────────────────────────────────────────────────

pub fn decrypt_chunk(data: &[u8], key: &str, version: u8) -> Result<Vec<u8>, String> {
    if data.len() < 28 {
        return Err("chunk too short".into());
    }
    let iv = &data[..12];
    let body = &data[12..];
    let key_bytes: Vec<u8> = if version >= 3 {
        hex::decode(key).map_err(|e| e.to_string())?
    } else {
        // version 2: key is 32 ASCII chars used as raw bytes
        key.as_bytes().to_vec()
    };
    if key_bytes.len() != 32 {
        return Err(format!("chunk key must be 32 bytes, got {}", key_bytes.len()));
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let nonce = Nonce::from_slice(iv);
    cipher
        .decrypt(nonce, body)
        .map_err(|_| "chunk AES-GCM authentication failed".to_string())
}

// ── File chunk encrypt (always v3) ────────────────────────────────────────────

pub fn encrypt_chunk(data: &[u8], key: &str) -> Result<Vec<u8>, String> {
    let key_bytes = hex::decode(key).map_err(|e| e.to_string())?;
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let nonce = Nonce::from_slice(&iv);
    let ct = cipher
        .encrypt(nonce, data)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(&iv);
    out.extend_from_slice(&ct);
    Ok(out)
}

// ── Key derivation ────────────────────────────────────────────────────────────

/// AuthVersion 2: PBKDF2-HMAC-SHA512(pw, salt, 200k, 64 bytes).
/// Returns (derived_password_for_api, initial_master_key).
pub fn derive_keys_v2(password: &str, salt: &str) -> (String, String) {
    let mut derived = [0u8; 64];
    pbkdf2_hmac::<Sha512>(password.as_bytes(), salt.as_bytes(), 200_000, &mut derived);
    let hex = hex::encode(derived);
    let master_key = hex[..64].to_string();
    let password_half = hex[64..].to_string();
    let derived_password = hex::encode(Sha512::digest(password_half.as_bytes()));
    (derived_password, master_key)
}

/// AuthVersion 3: Argon2id.
/// Returns (derived_password_for_api, initial_master_key).
pub fn derive_keys_v3(password: &str, salt_hex: &str) -> Result<(String, String), String> {
    let salt = hex::decode(salt_hex).map_err(|e| e.to_string())?;
    let params =
        argon2::Params::new(65536, 3, 4, Some(64)).map_err(|e| e.to_string())?;
    let argon = argon2::Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        params,
    );
    let mut derived = [0u8; 64];
    argon
        .hash_password_into(password.as_bytes(), &salt, &mut derived)
        .map_err(|e| e.to_string())?;
    let hex = hex::encode(derived);
    let master_key = hex[..64].to_string();
    let derived_password = hex[64..].to_string();
    Ok((derived_password, master_key))
}

// ── Filename hashing (v1/v2 auth) ─────────────────────────────────────────────

pub fn hash_filename(name: &str) -> String {
    let sha512 = hex::encode(Sha512::digest(name.to_lowercase().as_bytes()));
    hex::encode(Sha1::digest(sha512.as_bytes()))
}

// ── Random helpers ────────────────────────────────────────────────────────────

/// 64-char lowercase hex string = 32 random bytes (v3 file key).
pub fn generate_file_key() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// 32-char ASCII random string — v2 file key (used as raw bytes, not hex-decoded).
pub fn generate_file_key_v2() -> String {
    random_ascii(32)
}

/// V2 chunk encryption: key is interpreted as raw ASCII bytes (32 chars → 32 bytes).
pub fn encrypt_chunk_v2(data: &[u8], key: &str) -> Result<Vec<u8>, String> {
    let key_bytes = key.as_bytes();
    if key_bytes.len() != 32 {
        return Err(format!("v2 chunk key must be 32 bytes, got {}", key_bytes.len()));
    }
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key_bytes));
    let nonce = Nonce::from_slice(&iv);
    let ct = cipher.encrypt(nonce, data).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(&iv);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// 32-char alphanumeric string (upload key / rm).
pub fn generate_random_string(len: usize) -> String {
    random_ascii(len)
}

fn random_ascii(len: usize) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| CHARS[(rng.next_u32() as usize) % CHARS.len()] as char)
        .collect()
}
