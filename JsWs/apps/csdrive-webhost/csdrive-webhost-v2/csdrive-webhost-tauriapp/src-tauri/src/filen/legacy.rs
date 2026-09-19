//! One-time import of Filen accounts connected by the old UI, which ran the Filen JS
//! SDK inside the admin window: its account list was a JSON file under
//! `user/.csdrive-config/` and each account's SDK config (session keys) was a keychain
//! entry named by the account's email. Both are converted to the current storage and
//! the old ones removed — but only once an account has been safely moved.

use std::path::Path;

use serde::Deserialize;
use sqlx::SqlitePool;

use super::{crypto, save_session, upsert_account, StoredSession};

#[derive(Deserialize)]
struct LegacyIndex {
    #[serde(default)]
    accounts: Vec<LegacyAccount>,
}

#[derive(Deserialize)]
struct LegacyAccount {
    id: String,
}

/// The parts of a JS SDK `config` object that matter here. (Its `password` is stored
/// as "redacted", so there's no credential beyond the session keys.)
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySdkConfig {
    email: Option<String>,
    master_keys: Option<Vec<String>>,
    api_key: Option<String>,
    private_key: Option<String>,
    auth_version: Option<u8>,
    #[serde(rename = "baseFolderUUID")]
    base_folder_uuid: Option<String>,
    user_id: Option<u64>,
}

pub(super) fn parse_legacy_config(json: &str, fallback_email: &str) -> Result<StoredSession, String> {
    let config: LegacySdkConfig = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let missing = |what: &str| format!("the saved session has no {what}");

    let auth_version = config.auth_version.unwrap_or(2);
    let hmac_key_hex = match config.private_key.as_deref().filter(|k| !k.is_empty() && *k != "anonymous") {
        Some(private_key) => Some(hex::encode(crypto::derive_hmac_key(private_key)?)),
        None if auth_version == 3 => return Err(missing("private key")),
        None => None,
    };

    Ok(StoredSession {
        api_key: config.api_key.filter(|k| !k.is_empty()).ok_or_else(|| missing("API key"))?,
        master_keys: config.master_keys.filter(|k| !k.is_empty()).ok_or_else(|| missing("master keys"))?,
        base_folder_uuid: config.base_folder_uuid.ok_or_else(|| missing("base folder"))?,
        user_id: config.user_id.ok_or_else(|| missing("user id"))?,
        email: config.email.unwrap_or_else(|| fallback_email.to_string()),
        auth_version,
        hmac_key_hex,
    })
}

pub(super) async fn migrate(pool: &SqlitePool, user_dir: &Path) {
    let config_dir = user_dir.join(".csdrive-config");
    let index_path = config_dir.join("filen-accounts.json");
    let Ok(text) = std::fs::read_to_string(&index_path) else { return };
    let Ok(index) = serde_json::from_str::<LegacyIndex>(&text) else { return };

    let mut all_moved = true;
    for account in &index.accounts {
        if let Err(e) = migrate_account(pool, &account.id).await {
            all_moved = false;
            eprintln!("Couldn't import Filen account \"{}\" (reconnect it instead): {e}", account.id);
        }
    }

    if all_moved {
        let _ = std::fs::remove_file(&index_path);
        let _ = std::fs::remove_dir(&config_dir); // only succeeds if now empty
    }
}

async fn migrate_account(pool: &SqlitePool, legacy_id: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(crate::KEYCHAIN_SERVICE, legacy_id).map_err(|e| e.to_string())?;
    let secret = match entry.get_password() {
        Ok(secret) => secret,
        Err(keyring::Error::NoEntry) => return Ok(()), // nothing left to import
        Err(e) => return Err(e.to_string()),
    };

    let stored = parse_legacy_config(&secret, legacy_id)?;
    save_session(&stored)?;
    upsert_account(pool, stored.user_id, &stored.email).await.map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_a_js_sdk_config() {
        let json = r#"{
            "email": "me@example.com", "password": "redacted", "twoFactorCode": "redacted",
            "masterKeys": ["k1", "k2"], "apiKey": "api", "publicKey": "pub", "privateKey": "AQIDBAUGBwgJCg==",
            "authVersion": 3, "baseFolderUUID": "base-uuid", "userId": 12345, "metadataCache": true
        }"#;
        let stored = parse_legacy_config(json, "fallback").unwrap();
        assert_eq!(stored.email, "me@example.com");
        assert_eq!(stored.user_id, 12345);
        assert_eq!(stored.master_keys, ["k1", "k2"]);
        assert_eq!(stored.base_folder_uuid, "base-uuid");
        assert_eq!(stored.auth_version, 3);
        assert_eq!(
            stored.hmac_key_hex.as_deref(),
            Some("8decdc479faae1bd6ac363ed99f7f6f6e6f8d3330b0b33a6a6681ad16be2ac49")
        );
    }

    #[test]
    fn refuses_configs_that_are_missing_what_a_session_needs() {
        assert!(parse_legacy_config(r#"{"apiKey":"a","masterKeys":["k"],"baseFolderUUID":"b"}"#, "e").is_err(), "no user id");
        assert!(
            parse_legacy_config(r#"{"apiKey":"a","masterKeys":["k"],"baseFolderUUID":"b","userId":1,"authVersion":3}"#, "e").is_err(),
            "a v3 account can't hash names without its private key"
        );
        assert!(parse_legacy_config("not json", "e").is_err());
        assert!(parse_legacy_config(r#"{"apiKey":"a","masterKeys":["k"],"baseFolderUUID":"b","userId":1}"#, "e").is_ok());
    }
}
