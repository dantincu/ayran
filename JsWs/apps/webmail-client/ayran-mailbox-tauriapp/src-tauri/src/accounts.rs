//! The connected accounts and their credentials.
//!
//! On disk, each account is a folder pair (`folder_pairs.rs`, the folder pairs strategy) in
//! `<app data>/accounts/`:
//!
//! ```text
//! accounts/
//!   001/account.enc              <- the account and its credentials, encrypted (secure_store.rs)
//!   001-gmail@@me@gmail.com/     <- only says what 001 is
//!     .keep
//! ```
//!
//! `account.enc` holds the OAuth tokens (Gmail, Outlook) or the app password (Yahoo). They are only
//! ever decrypted here, in the Rust process: the webview gets [`AccountInfo`] — who the account is,
//! never how to get in.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::folder_pairs::{sanitize_part, Numbering};
use crate::mail::types::Provider;
use crate::secure_store;

const NUMBERING: Numbering = Numbering::DEFAULT;
const ACCOUNT_FILE: &str = "account.enc";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Unix time, milliseconds.
    pub expires_at: i64,
    #[serde(default)]
    pub scope: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Credentials {
    #[serde(rename_all = "camelCase")]
    OAuth { tokens: OAuthTokens },
    #[serde(rename_all = "camelCase")]
    AppPassword { app_password: String },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAccount {
    pub id: String,
    pub provider: Provider,
    pub email: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub credentials: Credentials,
}

/// What the frontend may know about an account (`src/types/auth.ts`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub id: String,
    pub provider: Provider,
    pub email: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

impl StoredAccount {
    pub fn account_id(provider: Provider, email: &str) -> String {
        format!("{}-{}", provider.as_str(), email.to_lowercase())
    }

    pub fn info(&self) -> AccountInfo {
        AccountInfo {
            id: self.id.clone(),
            provider: self.provider,
            email: self.email.clone(),
            display_name: self.display_name.clone(),
            avatar_url: self.avatar_url.clone(),
        }
    }

    /// The full name part of the account's folder pair: `<provider>@@<email>`.
    fn pair_part(&self) -> String {
        sanitize_part(&format!("{}@@{}", self.provider.as_str(), self.email.to_lowercase()))
    }
}

pub struct AccountStore {
    dir: PathBuf,
    /// Loaded on first use (reading needs the OS key store, which may prompt).
    accounts: Mutex<Option<BTreeMap<String, StoredAccount>>>,
}

impl AccountStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, accounts: Mutex::new(None) }
    }

    fn load(&self) -> Result<BTreeMap<String, StoredAccount>, String> {
        let mut map = BTreeMap::new();
        // Every full folder keeps its `.keep` (the strategy's rule holds even for pairs copied in from elsewhere).
        if let Err(e) = NUMBERING.repair(&self.dir) {
            log::warn!("Couldn't repair the account folders' markers: {e}");
        }
        for (pair, _) in NUMBERING.list(&self.dir).map_err(|e| format!("Can't read the accounts folder: {e}"))? {
            match secure_store::read_json::<StoredAccount>(&pair.short_dir.join(ACCOUNT_FILE)) {
                Ok(Some(account)) => {
                    map.insert(account.id.clone(), account);
                }
                Ok(None) => {} // a pair whose file was never written (interrupted connect)
                Err(e) => log::warn!("Skipping account {}: {e}", pair.full_name),
            }
        }
        Ok(map)
    }

    /// Runs `f` on the loaded accounts, holding the lock.
    async fn with<T>(&self, f: impl FnOnce(&mut BTreeMap<String, StoredAccount>) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.accounts.lock().await;
        if guard.is_none() {
            *guard = Some(self.load()?);
        }
        f(guard.as_mut().expect("loaded above"))
    }

    pub async fn list(&self) -> Result<Vec<AccountInfo>, String> {
        self.with(|m| Ok(m.values().map(StoredAccount::info).collect())).await
    }

    pub async fn get(&self, id: &str) -> Result<StoredAccount, String> {
        self.with(|m| m.get(id).cloned().ok_or_else(|| "This account isn't connected any more.".to_string())).await
    }

    /// Adds or replaces an account, writing its encrypted file first.
    pub async fn save(&self, account: StoredAccount) -> Result<(), String> {
        let dir = self.dir.clone();
        self.with(move |m| {
            let pair = NUMBERING.ensure(&dir, &account.pair_part()).map_err(|e| format!("Can't create the account's folder: {e}"))?;
            secure_store::write_json(&pair.short_dir.join(ACCOUNT_FILE), &account)?;
            m.insert(account.id.clone(), account);
            Ok(())
        })
        .await
    }

    pub async fn remove(&self, id: &str) -> Result<(), String> {
        let dir = self.dir.clone();
        self.with(move |m| {
            if let Some(account) = m.get(id) {
                NUMBERING.delete(&dir, &account.pair_part()).map_err(|e| format!("Can't delete the account's folder: {e}"))?;
                m.remove(id);
            }
            Ok(())
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_round_trip_through_json_and_info_has_no_secrets() {
        let account = StoredAccount {
            id: StoredAccount::account_id(Provider::Yahoo, "Me@Yahoo.com"),
            provider: Provider::Yahoo,
            email: "Me@Yahoo.com".into(),
            display_name: "Me".into(),
            avatar_url: None,
            credentials: Credentials::AppPassword { app_password: "abcd efgh".into() },
        };
        assert_eq!(account.id, "yahoo-me@yahoo.com");
        assert_eq!(account.pair_part(), "yahoo@@me@yahoo.com");
        let json = serde_json::to_string(&account).unwrap();
        let back: StoredAccount = serde_json::from_str(&json).unwrap();
        assert!(matches!(back.credentials, Credentials::AppPassword { app_password } if app_password == "abcd efgh"));
        let info = serde_json::to_string(&account.info()).unwrap();
        assert!(!info.contains("abcd"), "the frontend's view never carries credentials: {info}");
    }

    /// Uses this app's real key-store entry (as the app does) but a temporary accounts folder.
    #[tokio::test]
    async fn accounts_are_stored_encrypted_in_folder_pairs_and_survive_a_reload() {
        let dir = std::env::temp_dir().join(format!("ayran-mailbox-accounts-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let account = StoredAccount {
            id: StoredAccount::account_id(Provider::Gmail, "me@gmail.com"),
            provider: Provider::Gmail,
            email: "me@gmail.com".into(),
            display_name: "Me".into(),
            avatar_url: None,
            credentials: Credentials::OAuth {
                tokens: OAuthTokens { access_token: "ya29.SECRET".into(), refresh_token: Some("1//REFRESH".into()), expires_at: 1, scope: String::new() },
            },
        };

        let store = AccountStore::new(dir.clone());
        store.save(account.clone()).await.unwrap();
        let file = dir.join("001").join(ACCOUNT_FILE);
        let raw = std::fs::read(&file).unwrap();
        assert!(!raw.windows(6).any(|w| w == b"SECRET" || w == b"REFRES"), "tokens must be encrypted on disk");
        assert_eq!(std::fs::read_to_string(dir.join("001-gmail@@me@gmail.com").join(".keep")).unwrap(), "-");

        let reloaded = AccountStore::new(dir.clone());
        assert_eq!(reloaded.list().await.unwrap().len(), 1);
        let back = reloaded.get(&account.id).await.unwrap();
        assert!(matches!(back.credentials, Credentials::OAuth { tokens } if tokens.access_token == "ya29.SECRET"));

        reloaded.remove(&account.id).await.unwrap();
        assert!(reloaded.list().await.unwrap().is_empty());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "both folders of the pair are gone");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
