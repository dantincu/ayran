fn main() {
    // Inject Google OAuth credentials from ../.env as compile-time constants so they
    // end up in the Rust binary instead of the JS bundle.
    println!("cargo:rerun-if-changed=../.env");
    if let Ok(content) = std::fs::read_to_string("../.env") {
        for line in content.lines() {
            let line = line.trim();
            if line.starts_with('#') || line.is_empty() {
                continue;
            }
            if let Some((key, val)) = line.split_once('=') {
                let key = key.trim();
                let val = val.trim().trim_matches('"').trim_matches('\'');
                if matches!(key, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET") {
                    println!("cargo:rustc-env={}={}", key, val);
                }
            }
        }
    }
    tauri_build::build()
}
