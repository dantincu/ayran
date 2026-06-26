use keyring::v1::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct StoredSession {
    pub api_base_url: String,
    pub token: String,
    pub account_user_id: i64,
    pub account_email: String,
}

const SERVICE: &str = "io.ayran.lanstreamer.mobile";
const USERNAME: &str = "session";

// keyring's Android backend doesn't auto-register itself as the default
// credential store (unlike the Windows one) - it must be created and handed
// to keyring_core explicitly. This has to happen lazily, on first actual use,
// rather than eagerly during `run()`: Tauri hasn't initialized the ndk-context
// this backend depends on that early yet, and calling into it before that
// panics.
#[cfg(target_os = "android")]
fn ensure_secure_store_initialized() {
    use std::sync::OnceLock;
    static INIT: OnceLock<()> = OnceLock::new();
    INIT.get_or_init(|| {
        let store = android_native_keyring_store::Store::new().expect("failed to initialize Android keystore-backed credential store");
        keyring_core::set_default_store(store);
    });
}

// Stored in the OS-native credential store (Windows Credential Manager via
// DPAPI, macOS Keychain, Linux Secret Service) rather than a plain file, so
// the session token isn't sitting in plaintext on disk.
fn entry() -> Result<Entry, String> {
    #[cfg(target_os = "android")]
    ensure_secure_store_initialized();

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

// Only the android-native-keyring-store backend is enabled for this crate
// (see Cargo.toml) - this test needs to actually run on an Android device/
// emulator, not the host machine, which has no backend enabled at all.
#[cfg(all(test, target_os = "android"))]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_android_keystore() {
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
