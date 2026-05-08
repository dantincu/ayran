use aes_gcm::{aead::Aead, Aes256Gcm, Key, KeyInit, Nonce};
use rand::RngCore;
use serde::{de::DeserializeOwned, Serialize};
use std::path::Path;
use std::sync::OnceLock;

// Cached per-process so webview page refreshes (same Rust process) always
// use the same key without hitting the secure store on every call.
static APP_KEY: OnceLock<[u8; 32]> = OnceLock::new();

// ── Platform-specific key protection ─────────────────────────────────────────

/// Windows: wrap the raw AES key with DPAPI so the `.key` file on disk is an
/// opaque blob — only the same Windows user account can unwrap it.
#[cfg(target_os = "windows")]
mod platform {
    use rand::RngCore;
    use std::path::Path;
    use std::ptr;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            pdata_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut (),
            p_prompt_struct: *const (),
            dw_flags: u32,
            pdata_out: *mut DataBlob,
        ) -> i32;

        fn CryptUnprotectData(
            pdata_in: *const DataBlob,
            ppszdata_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut (),
            p_prompt_struct: *const (),
            dw_flags: u32,
            pdata_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(hmem: *mut ()) -> *mut ();
    }

    fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, String> {
        let input = DataBlob { cb_data: data.len() as u32, pb_data: data.as_ptr() as *mut u8 };
        let mut output = DataBlob { cb_data: 0, pb_data: ptr::null_mut() };
        unsafe {
            if CryptProtectData(&input, ptr::null(), ptr::null(), ptr::null_mut(), ptr::null(), 0, &mut output) == 0 {
                return Err("DPAPI CryptProtectData failed".into());
            }
            let blob = std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec();
            LocalFree(output.pb_data as *mut ());
            Ok(blob)
        }
    }

    fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        let input = DataBlob { cb_data: data.len() as u32, pb_data: data.as_ptr() as *mut u8 };
        let mut output = DataBlob { cb_data: 0, pb_data: ptr::null_mut() };
        let mut desc: *mut u16 = ptr::null_mut();
        unsafe {
            if CryptUnprotectData(&input, &mut desc, ptr::null(), ptr::null_mut(), ptr::null(), 0, &mut output) == 0 {
                return Err("DPAPI CryptUnprotectData failed".into());
            }
            if !desc.is_null() { LocalFree(desc as *mut ()); }
            let plain = std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec();
            LocalFree(output.pb_data as *mut ());
            Ok(plain)
        }
    }

    /// Load the AES key from a DPAPI-protected blob file, or generate and
    /// protect a new one. The file is binary ciphertext — no plain text on disk.
    pub fn resolve_key(data_dir: &Path) -> Result<[u8; 32], String> {
        let key_path = data_dir.join(".key");

        if key_path.exists() {
            let blob = std::fs::read(&key_path).map_err(|e| e.to_string())?;
            let raw = dpapi_unprotect(&blob)?;
            if raw.len() != 32 {
                return Err("stored key has wrong length".into());
            }
            let mut key = [0u8; 32];
            key.copy_from_slice(&raw);
            return Ok(key);
        }

        // First run: generate → protect → persist.
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        let blob = dpapi_protect(&key)?;
        std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
        std::fs::write(&key_path, blob).map_err(|e| e.to_string())?;
        Ok(key)
    }
}

/// macOS / Linux: store the hex-encoded key in the platform keychain
/// (Keychain on macOS, Secret Service on Linux).
#[cfg(not(target_os = "windows"))]
mod platform {
    use rand::RngCore;
    use std::path::Path;

    const SERVICE: &str = "io.ayran.csdrive";
    const ACCOUNT: &str = "app-encryption-key";

    pub fn resolve_key(_data_dir: &Path) -> Result<[u8; 32], String> {
        let entry = keyring::Entry::new(SERVICE, ACCOUNT)
            .map_err(|e| format!("keychain open: {e}"))?;

        match entry.get_password() {
            Ok(stored) => {
                let bytes = hex::decode(stored.trim()).map_err(|e| e.to_string())?;
                if bytes.len() != 32 {
                    return Err("keychain key has wrong length".into());
                }
                let mut key = [0u8; 32];
                key.copy_from_slice(&bytes);
                Ok(key)
            }
            Err(keyring::Error::NoEntry) => {
                let mut key = [0u8; 32];
                rand::thread_rng().fill_bytes(&mut key);
                entry.set_password(&hex::encode(key)).map_err(|e| format!("keychain write: {e}"))?;
                Ok(key)
            }
            Err(e) => Err(format!("keychain read: {e}")),
        }
    }
}

// ── Internal key accessor ─────────────────────────────────────────────────────

fn get_or_create_key(data_dir: &Path) -> Result<[u8; 32], String> {
    if let Some(&cached) = APP_KEY.get() {
        return Ok(cached);
    }
    let key = platform::resolve_key(data_dir)?;
    let _ = APP_KEY.set(key);
    Ok(key)
}

// ── AES-256-GCM file I/O ──────────────────────────────────────────────────────

/// Serialise `value` to JSON, encrypt with the app key, write as binary file.
pub fn write<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let data_dir = path.parent().ok_or("path has no parent directory")?;
    let json = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let key_bytes = get_or_create_key(data_dir)?;

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), json.as_ref())
        .map_err(|e| e.to_string())?;

    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
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
    let data_dir = path.parent().ok_or("path has no parent directory")?;
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    if data.len() < 12 {
        return Err("encrypted file too short".into());
    }
    let key_bytes = get_or_create_key(data_dir)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let json = cipher
        .decrypt(Nonce::from_slice(&data[..12]), &data[12..])
        .map_err(|_| "decryption failed (wrong key or corrupted file)".to_string())?;
    serde_json::from_slice(&json).map(Some).map_err(|e| e.to_string())
}
