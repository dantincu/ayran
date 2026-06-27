// OS-native secure storage for small secrets (the session-encryption key),
// tying decryption to the OS user account this process runs as, rather than
// to mere possession of a file. Windows-only for now, matching the Node
// version's secureStore.ts/.windows.ts split - add a macOS (Keychain via the
// `security` CLI) or Linux (libsecret via `secret-tool`) implementation by
// following the same protect/unprotect shape when those platforms are needed.

use base64::{engine::general_purpose::STANDARD, Engine};
use tokio::process::Command;

#[cfg(target_os = "windows")]
async fn run_powershell(script: &str) -> Result<String, String> {
    // Windows DPAPI ties the protected blob to the current Windows user
    // account on this machine: CryptUnprotectData derives its key from
    // secrets only the OS holds for that user, so the blob can't be
    // decrypted by copying it (plus any other file) to a different machine
    // or user account.
    let encoded = {
        use std::io::Write;
        let utf16le: Vec<u8> = script.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
        let mut buf = Vec::new();
        buf.write_all(&utf16le).map_err(|e| e.to_string())?;
        STANDARD.encode(&buf)
    };

    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(format!("powershell exited with {}: {}", output.status, String::from_utf8_lossy(&output.stderr)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(target_os = "windows")]
pub async fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    let script = format!(
        r#"
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String('{}')
$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($protected)
"#,
        STANDARD.encode(data)
    );
    let out = run_powershell(&script).await?;
    STANDARD.decode(out).map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
pub async fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    let script = format!(
        r#"
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String('{}')
$unprotected = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($unprotected)
"#,
        STANDARD.encode(data)
    );
    let out = run_powershell(&script).await?;
    STANDARD.decode(out).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "windows"))]
pub async fn protect(_data: &[u8]) -> Result<Vec<u8>, String> {
    Err(format!(
        "No OS-native secure store implemented for this platform yet. See secure_store.rs for the pattern to follow (Windows DPAPI)."
    ))
}

#[cfg(not(target_os = "windows"))]
pub async fn unprotect(_data: &[u8]) -> Result<Vec<u8>, String> {
    Err(format!(
        "No OS-native secure store implemented for this platform yet. See secure_store.rs for the pattern to follow (Windows DPAPI)."
    ))
}
