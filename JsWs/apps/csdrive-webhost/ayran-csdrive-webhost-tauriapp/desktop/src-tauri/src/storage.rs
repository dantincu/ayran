use aes_gcm::{aead::Aead, Aes256Gcm, Key, KeyInit, Nonce};
use rand::RngCore;
use serde::{de::DeserializeOwned, Serialize};
use std::path::Path;

const KEYRING_SERVICE: &str = "io.ayran.csdrive";
const KEYRING_ACCOUNT: &str = "app-encryption-key";

// ── Keychain-backed encryption key ────────────────────────────────────────────

fn get_or_create_key() -> Result<[u8; 32], String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("keyring open: {e}"))?;

    match entry.get_password() {
        Ok(stored) => {
            let bytes = hex::decode(&stored).map_err(|e| format!("keyring decode: {e}"))?;
            if bytes.len() != 32 {
                return Err("keyring: stored key has wrong length".into());
            }
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            Ok(key)
        }
        Err(keyring::Error::NoEntry) | Err(keyring::Error::NoStorageAccess(_)) => {
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            entry
                .set_password(&hex::encode(key))
                .map_err(|e| format!("keyring write: {e}"))?;
            Ok(key)
        }
        Err(e) => Err(format!("keyring read: {e}")),
    }
}

// ── AES-256-GCM file I/O ──────────────────────────────────────────────────────

/// Serialise `value` to JSON, encrypt with the app key, write as binary file.
pub fn write<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let key_bytes = get_or_create_key()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), json.as_ref())
        .map_err(|e| e.to_string())?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    std::fs::write(path, out).map_err(|e| e.to_string())
}

/// Read an encrypted binary file and deserialise its JSON content.
/// Returns `Ok(None)` if the file does not exist.
pub fn read<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    if data.len() < 12 {
        return Err("encrypted file too short".into());
    }
    let key_bytes = get_or_create_key()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let json = cipher
        .decrypt(Nonce::from_slice(&data[..12]), &data[12..])
        .map_err(|_| "decryption failed (wrong key or corrupted file)".to_string())?;
    serde_json::from_slice(&json).map(Some).map_err(|e| e.to_string())
}
