//! Bakes the OAuth client registrations into the binary.
//!
//! A desktop/mobile app is a *public* OAuth client: whatever it ships with can be read out of it, and
//! the providers know that (Google calls the "client secret" of a Desktop client non-confidential;
//! Microsoft's public clients have none at all — PKCE is what protects the flow). So the ids come from
//! the build environment, or from a `.env` file next to this crate or at the project root, and are
//! compiled in with `option_env!` (see `oauth.rs`). Nothing here is a user secret.

const KEYS: &[&str] = &["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "OUTLOOK_CLIENT_ID", "OUTLOOK_CLIENT_SECRET", "OUTLOOK_TENANT"];

fn main() {
    for file in ["../.env", ".env"] {
        println!("cargo:rerun-if-changed={file}");
        let Ok(text) = std::fs::read_to_string(file) else { continue };
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('#') {
                continue;
            }
            let Some((key, value)) = line.split_once('=') else { continue };
            let (key, value) = (key.trim(), value.trim().trim_matches('"'));
            // A variable set in the real environment wins over the file.
            if KEYS.contains(&key) && std::env::var(key).is_err() && !value.is_empty() {
                println!("cargo:rustc-env={key}={value}");
            }
        }
    }
    for key in KEYS {
        println!("cargo:rerun-if-env-changed={key}");
    }
    tauri_build::build()
}
