//! Encrypted-at-rest storage for the app's small secrets (Filen.io sessions) and for
//! the pointer file that records a relocated data folder.
//!
//! The design: **one random 32-byte key**, generated the first time it's needed and
//! kept in the platform's secure key store, encrypts everything; the secrets
//! themselves live in ordinary AES-256-GCM encrypted files inside the data folder
//! (`nonce (12 bytes) || ciphertext+tag`). So the platform-specific part is exactly
//! `platform::resolve_key` below — a few lines — and everything else (the file
//! format, what gets stored, how it's read back) is ours and identical everywhere.
//! It also means the key store only ever holds 32 bytes, so entry-size limits (the
//! Windows Credential Manager's ~2.5 KB) don't matter however many accounts there are.
//!
//! - Windows / macOS / Linux: the OS keychain (Credential Manager / Keychain / Secret
//!   Service) via the `keyring` crate.
//! - Android: the Android Keystore, through a small Kotlin helper (`SecureKey.kt`)
//!   that Rust calls over JNI (`android_jni.rs`).
//! - iOS: **not implemented yet** — implement `resolve_key` with the iOS Keychain; the
//!   rest of this module needs no change. Until then it fails with a clear error
//!   rather than storing the key unprotected.
//!
//! Uses only `std`, `aes-gcm`, `hex`, `serde(_json)` and (off mobile) `keyring`, and
//! reaches its keychain entry name through `crate::layout`, so the `seed_demo_data`
//! example `#[path]`-includes this very file.

use std::path::Path;
use std::sync::OnceLock;

use aes_gcm::aead::{Aead, Generate, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use serde::de::DeserializeOwned;
use serde::Serialize;

const NONCE_LEN: usize = 12;

/// Cached for the life of the process, so the keychain is asked once.
static APP_KEY: OnceLock<[u8; 32]> = OnceLock::new();

/// The app's encryption key: read from the platform key store, or generated and saved
/// there on first use.
pub fn app_key() -> Result<[u8; 32], String> {
    if let Some(key) = APP_KEY.get() {
        return Ok(*key);
    }
    let key = platform::resolve_key()?;
    let _ = APP_KEY.set(key);
    Ok(key)
}

// ── Platform-specific: where the key is kept ──────────────────────────────────

#[cfg(desktop)]
mod platform {
    use super::*;

    const KEY_ENTRY_NAME: &str = "app-encryption-key";

    pub fn resolve_key() -> Result<[u8; 32], String> {
        let entry = keyring::Entry::new(crate::layout::keychain_service(), KEY_ENTRY_NAME)
            .map_err(|e| format!("keychain: {e}"))?;

        match entry.get_password() {
            Ok(stored) => {
                let bytes = hex::decode(stored.trim()).map_err(|e| format!("keychain key isn't hex: {e}"))?;
                <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| "keychain key has the wrong length".to_string())
            }
            Err(keyring::Error::NoEntry) => {
                let key: [u8; 32] = Key::<Aes256Gcm>::generate().into();
                entry.set_password(&hex::encode(key)).map_err(|e| format!("keychain: {e}"))?;
                Ok(key)
            }
            Err(e) => Err(format!("keychain: {e}")),
        }
    }
}

/// Android: the key is generated and protected by the Android Keystore (see
/// `SecureKey.kt`): a random 32-byte key, stored encrypted by a Keystore-held AES key
/// that never leaves the secure hardware/OS. Rust reaches it through JNI.
#[cfg(target_os = "android")]
mod platform {
    use jni::objects::{JByteArray, JValue};

    const HELPER_CLASS: &str = "com.ayran.csdrive_webhost_tauriapp.SecureKey";

    pub fn resolve_key() -> Result<[u8; 32], String> {
        // Not from the main thread (it waits for the UI thread); commands run elsewhere.
        let bytes = crate::android_jni::on_activity(|env, activity| {
            let class = crate::android_jni::helper_class(env, activity, HELPER_CLASS)?;
            let bytes = env
                .call_static_method(&class, "getOrCreateAppKey", "(Landroid/content/Context;)[B", &[JValue::Object(activity)])?
                .l()?;
            env.convert_byte_array(&JByteArray::from(bytes))
        })?;
        <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| "the Keystore key has the wrong length".to_string())
    }
}

#[cfg(target_os = "ios")]
mod platform {
    pub fn resolve_key() -> Result<[u8; 32], String> {
        Err("Secure key storage isn't implemented on iOS yet (see secure_store.rs).".to_string())
    }
}

// ── Encryption ────────────────────────────────────────────────────────────────

fn encrypt_with(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key));
    let nonce = Nonce::generate();
    let ciphertext = cipher.encrypt(&nonce, plaintext).map_err(|e| e.to_string())?;

    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn decrypt_with(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < NONCE_LEN {
        return Err("encrypted file is too short to be valid".to_string());
    }
    let (nonce_bytes, ciphertext) = data.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key));
    let nonce = Nonce::try_from(nonce_bytes).map_err(|e| e.to_string())?;
    cipher
        .decrypt(&nonce, ciphertext)
        .map_err(|_| "decryption failed (wrong key or corrupted file)".to_string())
}

// ── Encrypted files ───────────────────────────────────────────────────────────

/// Writes `plaintext` to `path` encrypted (creating parent folders). Written to a
/// temporary file and renamed into place, so a crash can't leave a half-written file.
pub fn write_bytes(path: &Path, plaintext: &[u8]) -> Result<(), String> {
    write_bytes_with(&app_key()?, path, plaintext)
}

/// Reads and decrypts `path`; `Ok(None)` if the file doesn't exist (in which case the
/// key store isn't touched at all).
pub fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let Some(data) = read_file(path)? else { return Ok(None) };
    decrypt_with(&app_key()?, &data).map(Some)
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    write_bytes(path, &serde_json::to_vec(value).map_err(|e| e.to_string())?)
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    match read_bytes(path)? {
        Some(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

fn write_bytes_with(key: &[u8; 32], path: &Path, plaintext: &[u8]) -> Result<(), String> {
    let encrypted = encrypt_with(key, plaintext)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut temp_name = path.file_name().ok_or("path has no file name")?.to_os_string();
    temp_name.push(".tmp");
    let temp = path.with_file_name(temp_name);
    std::fs::write(&temp, encrypted).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })
}

fn read_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(path) {
        Ok(data) => Ok(Some(data)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key(byte: u8) -> [u8; 32] {
        [byte; 32]
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("csdrive-secure-store-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn what_is_written_is_ciphertext_and_reads_back_only_with_the_same_key() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("nested").join("secret.enc");
        let secret = br#"{"api_key":"very-secret-value"}"#;

        write_bytes_with(&test_key(1), &path, secret).unwrap();

        let on_disk = std::fs::read(&path).unwrap();
        assert!(!on_disk.windows(10).any(|w| w == b"very-secre"), "the secret must not appear in the file");
        assert_eq!(on_disk.len(), NONCE_LEN + secret.len() + 16, "nonce + ciphertext + 16-byte tag");
        assert_eq!(decrypt_with(&test_key(1), &on_disk).unwrap(), secret);
        assert!(decrypt_with(&test_key(2), &on_disk).is_err(), "a different key must fail");

        let mut tampered = on_disk.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(decrypt_with(&test_key(1), &tampered).is_err(), "tampering must be detected");
        assert!(decrypt_with(&test_key(1), &on_disk[..5]).is_err(), "a truncated file must fail");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn writing_replaces_atomically_and_never_reuses_a_nonce() {
        let dir = temp_dir("atomic");
        let path = dir.join("s.enc");

        write_bytes_with(&test_key(1), &path, b"first").unwrap();
        let first = std::fs::read(&path).unwrap();
        write_bytes_with(&test_key(1), &path, b"first").unwrap();
        let second = std::fs::read(&path).unwrap();
        assert_ne!(first[..NONCE_LEN], second[..NONCE_LEN], "each write uses a fresh nonce");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "no temporary file is left behind");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_file_reads_as_none_without_needing_a_key() {
        assert_eq!(read_file(&std::env::temp_dir().join("csdrive-definitely-not-here.enc")).unwrap(), None);
    }

    /// Uses the real OS keychain (creating this app's key entry, as the app itself would).
    #[test]
    fn the_key_is_created_once_and_then_read_back_unchanged() {
        let first = app_key().unwrap();
        assert_ne!(first, [0u8; 32]);
        assert_eq!(platform::resolve_key().unwrap(), first, "the keychain hands back the same key");
    }
}
