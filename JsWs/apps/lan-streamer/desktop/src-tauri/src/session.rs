use keyring::v1::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct StoredSession {
    pub api_base_url: String,
    pub token: String,
    pub account_user_id: i64,
    pub account_email: String,
}

const SERVICE: &str = "io.ayran.lanstreamer.desktop";
const USERNAME: &str = "session";

// Stored in the OS-native credential store (Windows Credential Manager via
// DPAPI, macOS Keychain, Linux Secret Service) rather than a plain file, so
// the session token isn't sitting in plaintext on disk.
fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, USERNAME).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_session(session: StoredSession) -> Result<(), String> {
    let json = serde_json::to_string(&session).map_err(|e| e.to_string())?;
    entry()?.set_password(&json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_session() -> Result<Option<StoredSession>, String> {
    match entry()?.get_password() {
        Ok(json) => serde_json::from_str(&json).map_err(|e| e.to_string()).map(Some),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn clear_session() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_windows_credential_manager() {
        let session = StoredSession {
            api_base_url: "https://example.test:9443".into(),
            token: "test-token-abc".into(),
            account_user_id: 42,
            account_email: "a@b.com".into(),
        };

        save_session(session.clone()).expect("save_session failed");

        let loaded = load_session().expect("load_session failed").expect("expected Some(session)");
        assert_eq!(loaded.token, session.token);
        assert_eq!(loaded.account_user_id, session.account_user_id);

        clear_session().expect("clear_session failed");
        let after_clear = load_session().expect("load_session failed");
        assert!(after_clear.is_none(), "expected None after clear_session");
    }
}
