//! Filen.io's client-side cryptography: metadata ("002"/"003") and file-chunk
//! encryption, and the password/master-key derivation used at login.
//!
//! Verified against vectors produced by Filen's own JS SDK (see the tests), and
//! ported from the same code used in the Ayran Notes app.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key};
type Nonce = aes_gcm::aead::Nonce<Aes256Gcm>;
use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};

fn cipher(key: &[u8]) -> Result<Aes256Gcm, String> {
    let key = Key::<Aes256Gcm>::try_from(key).map_err(|_| format!("key must be 32 bytes, got {}", key.len()))?;
    Ok(Aes256Gcm::new(&key))
}

fn nonce(iv: &[u8]) -> Result<Nonce, String> {
    Nonce::try_from(iv).map_err(|_| "IV must be 12 bytes".to_string())
}

// ── Metadata decrypt ──────────────────────────────────────────────────────────

/// Tries every master key (newest first) until one decrypts successfully.
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
    let iv = &bytes[3..15]; // 12 ASCII characters, used as raw bytes
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
    aes_gcm_decrypt(&key_bytes, &iv, &body)
}

fn aes_gcm_decrypt(key: &[u8], iv: &[u8], body_with_tag: &[u8]) -> Result<String, String> {
    let plain = cipher(key)?
        .decrypt(&nonce(iv)?, body_with_tag)
        .map_err(|_| "AES-GCM authentication failed".to_string())?;
    String::from_utf8(plain).map_err(|e| e.to_string())
}

// ── Metadata encrypt ──────────────────────────────────────────────────────────

/// Always encrypts with "002", which every Filen client version can read (some
/// clients mishandle "003" metadata written by third parties).
pub fn encrypt_metadata(plaintext: &str, key: &str) -> Result<String, String> {
    let mut key_bytes = [0u8; 32];
    pbkdf2_hmac::<Sha512>(key.as_bytes(), key.as_bytes(), 1, &mut key_bytes);
    let iv_str = random_ascii(12);
    let ct = cipher(&key_bytes)?
        .encrypt(&nonce(iv_str.as_bytes())?, plaintext.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(format!("002{}{}", iv_str, STANDARD.encode(&ct)))
}

// ── File chunk encrypt/decrypt ────────────────────────────────────────────────

/// Layout: 12-byte IV, then ciphertext + tag. Version >= 3 keys are 64 hex chars;
/// version 2 keys are 32 ASCII characters used as raw bytes.
pub fn decrypt_chunk(data: &[u8], key: &str, version: u8) -> Result<Vec<u8>, String> {
    if data.len() < 28 {
        return Err("chunk too short".into());
    }
    let key_bytes: Vec<u8> = if version >= 3 {
        hex::decode(key).map_err(|e| e.to_string())?
    } else {
        key.as_bytes().to_vec()
    };
    cipher(&key_bytes)?
        .decrypt(&nonce(&data[..12])?, &data[12..])
        .map_err(|_| "chunk AES-GCM authentication failed".to_string())
}

/// Version-2 chunk encryption (what this app writes): the key is 32 ASCII characters.
pub fn encrypt_chunk_v2(data: &[u8], key: &str) -> Result<Vec<u8>, String> {
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    let ct = cipher(key.as_bytes())?.encrypt(&nonce(&iv)?, data).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(&iv);
    out.extend_from_slice(&ct);
    Ok(out)
}

// ── Key derivation ────────────────────────────────────────────────────────────

/// AuthVersion 2: PBKDF2-HMAC-SHA512(password, salt, 200k rounds, 64 bytes).
/// Returns (derived password for the API, initial master key).
pub fn derive_keys_v2(password: &str, salt: &str) -> (String, String) {
    let mut derived = [0u8; 64];
    pbkdf2_hmac::<Sha512>(password.as_bytes(), salt.as_bytes(), 200_000, &mut derived);
    let hex = hex::encode(derived);
    let master_key = hex[..64].to_string();
    let derived_password = hex::encode(Sha512::digest(hex[64..].as_bytes()));
    (derived_password, master_key)
}

/// AuthVersion 3: Argon2id. Returns (derived password for the API, initial master key).
pub fn derive_keys_v3(password: &str, salt_hex: &str) -> Result<(String, String), String> {
    let salt = hex::decode(salt_hex).map_err(|e| e.to_string())?;
    let params = argon2::Params::new(65536, 3, 4, Some(64)).map_err(|e| e.to_string())?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut derived = [0u8; 64];
    argon.hash_password_into(password.as_bytes(), &salt, &mut derived).map_err(|e| e.to_string())?;
    let hex = hex::encode(derived);
    Ok((hex[64..].to_string(), hex[..64].to_string()))
}

// ── Names and random values ───────────────────────────────────────────────────

/// Server-side name-uniqueness hash for auth versions 1 and 2:
/// sha1(sha512(lowercased name)) as hex.
pub fn hash_filename(name: &str) -> String {
    let sha512 = hex::encode(Sha512::digest(name.to_lowercase().as_bytes()));
    hex::encode(Sha1::digest(sha512.as_bytes()))
}

/// The key auth-version-3 accounts salt their name hashes with: HKDF-SHA256 (empty
/// salt, info "hmac-sha256-key") of the account's RSA private key (base64 DER).
pub fn derive_hmac_key(private_key_base64: &str) -> Result<[u8; 32], String> {
    let ikm = STANDARD.decode(private_key_base64).map_err(|e| e.to_string())?;
    let mut extract = <Hmac<Sha256> as Mac>::new_from_slice(&[0u8; 32]).map_err(|e| e.to_string())?;
    extract.update(&ikm);
    let prk = extract.finalize().into_bytes();
    let mut expand = <Hmac<Sha256> as Mac>::new_from_slice(&prk).map_err(|e| e.to_string())?;
    expand.update(b"hmac-sha256-key");
    expand.update(&[1u8]);
    Ok(expand.finalize().into_bytes().into())
}

/// Name hash for auth-version-3 accounts: HMAC-SHA256(hmac key, lowercased name) as hex.
pub fn hash_filename_hmac(name: &str, hmac_key: &[u8]) -> Result<String, String> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(hmac_key).map_err(|e| e.to_string())?;
    mac.update(name.to_lowercase().as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

/// 32-character ASCII key for a new version-2 file.
pub fn generate_file_key_v2() -> String {
    random_ascii(32)
}

pub fn generate_random_string(len: usize) -> String {
    random_ascii(len)
}

fn random_ascii(len: usize) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..len).map(|_| CHARS[(rng.next_u32() as usize) % CHARS.len()] as char).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vectors produced by Filen's own JS SDK (@filen/sdk), so these check that we
    // interoperate with real Filen data, not just with ourselves.
    const HEX_KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const ASCII_KEY: &str = "abcdefghijklmnopqrstuvwxyz012345";
    const PLAIN: &[u8] = b"chunk plaintext bytes \x00\x01\x02 end";

    #[test]
    fn decrypts_metadata_written_by_the_official_sdk() {
        let meta = "002U52D_T52f1Dhd3WZN8FgXwiXxDichsN9crtXZjRwPxq+JJHSykr6D1DogfaNPDYVlbPpT3v9/A==";
        assert_eq!(decrypt_with_key(meta, ASCII_KEY).unwrap(), r#"{"name":"héllo.txt","size":5}"#);

        let folder = "002Zg5eImb_qfFEicAUJyF090s0yCfutW1BDK4xB5HsRUXH3jfkl9JeCMTV";
        assert_eq!(decrypt_metadata(folder, &["wrong".to_string(), HEX_KEY.to_string()]).unwrap(), r#"{"name":"Folder"}"#);
        assert!(decrypt_with_key(folder, "not-the-key").is_err());
    }

    #[test]
    fn metadata_we_write_round_trips() {
        let enc = encrypt_metadata("héllo wörld", ASCII_KEY).unwrap();
        assert!(enc.starts_with("002"));
        assert_eq!(decrypt_with_key(&enc, ASCII_KEY).unwrap(), "héllo wörld");
    }

    #[test]
    fn decrypts_chunks_written_by_the_official_sdk() {
        let v2 = STANDARD.decode("VWVQRC1WNnFrS3VYg6JewVnmNzP6lYLR0u/uw5Dz7Hsu2d4bkSzLY/t6D2iC27ddG0githOnMneM").unwrap();
        assert_eq!(decrypt_chunk(&v2, ASCII_KEY, 2).unwrap(), PLAIN);
        let v3 = STANDARD.decode("aj4weFFYNOj/binSybDQoF+CKcfYNqxGavhiD1H8HfVWxJNqw9PdZFFce5lm5THSKoAPwAluMDH+").unwrap();
        assert_eq!(decrypt_chunk(&v3, HEX_KEY, 3).unwrap(), PLAIN);
    }

    #[test]
    fn chunks_we_write_round_trip() {
        let key = generate_file_key_v2();
        assert_eq!(key.len(), 32);
        let enc = encrypt_chunk_v2(PLAIN, &key).unwrap();
        assert_eq!(decrypt_chunk(&enc, &key, 2).unwrap(), PLAIN);
        assert!(decrypt_chunk(&enc, &generate_file_key_v2(), 2).is_err());
    }

    #[test]
    fn key_derivation_matches_the_official_sdk() {
        let (password, master) = derive_keys_v2("correct horse", "somesalt");
        assert_eq!(master, "1f910f2f9da895ab46e2298bf745ae6cbdce003bb4a051ded329b96b16e2facd");
        assert_eq!(password, "65361778200af1ef77db68ee1b1d74b87b343ac7117ea54a00940b4bf88e052c62906a88956b7843d8dcdc672eba43052b97ada90adec0729eb9334ce0e0c080");

        let (password, master) = derive_keys_v3("correct horse", HEX_KEY).unwrap();
        assert_eq!(master, "d57c7934a4a04aadb70f7935a9509e2d40fa2fba9988f88d718c79e98761744a");
        assert_eq!(password, "88ef216d3ef119d024d5c9d98f0537f12f91ea0be9baa29d7b22cd4ab1cc6d74");
    }

    #[test]
    fn name_hashes_match_the_official_sdk_and_ignore_case() {
        // The SDK's hashFn does not lowercase itself; its callers pass the lowercased name.
        assert_eq!(hash_filename("Héllo.TXT"), "c11f0cb35b0920dc1c054cdab2f1c636596c4641");
        assert_eq!(hash_filename("héllo.txt"), hash_filename("HÉLLO.TXT"));

        let key = derive_hmac_key("AQIDBAUGBwgJCg==").unwrap();
        assert_eq!(hex::encode(key), "8decdc479faae1bd6ac363ed99f7f6f6e6f8d3330b0b33a6a6681ad16be2ac49");
        assert_eq!(
            hash_filename_hmac("Héllo.TXT", &key).unwrap(),
            "63bcac41f867827f8dac83800928f13df3f7fff191209b04a96865d8a8ba9d30"
        );
        assert_eq!(hash_filename_hmac("héllo.txt", &key).unwrap(), hash_filename_hmac("HÉLLO.TXT", &key).unwrap());
    }
}
