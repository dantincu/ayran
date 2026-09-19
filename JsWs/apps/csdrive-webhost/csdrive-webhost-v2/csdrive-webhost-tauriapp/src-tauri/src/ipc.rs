//! Reading the pieces of a command that takes a file's bytes as its request body — used
//! by every upload-style command (`filen_write_file`,
//! `save_to_device`). The frontend side is `invokeWithBytes` (`src/lib/ipcBytes.ts`).
//!
//! A request can arrive in three shapes:
//! - **desktop**: the bytes are the raw body and the other arguments are percent-encoded
//!   headers;
//! - **Android**: the webview can't hand a POST body to a custom protocol, so Tauri falls
//!   back to postMessage, where the bytes would become a JSON array of numbers — a
//!   20 MB file is then tens of millions of JSON values in memory. So the frontend sends
//!   a JSON object instead: `{ ...arguments, data: "<base64>" }`;
//! - a plain JSON array of byte numbers is still understood (what a caller that doesn't
//!   know better ends up sending).

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use tauri::ipc::{InvokeBody, Request};

/// The request's file bytes, whichever way they came.
pub fn body_bytes(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(data) => Ok(data.clone()),
        InvokeBody::Json(Value::Array(values)) => values
            .iter()
            .map(|v| v.as_u64().and_then(|n| u8::try_from(n).ok()).ok_or_else(|| "The file's bytes are malformed.".to_string()))
            .collect(),
        InvokeBody::Json(Value::Object(fields)) => {
            let encoded = fields.get("data").and_then(Value::as_str).ok_or("Missing the file's bytes (\"data\").")?;
            STANDARD.decode(encoded).map_err(|_| "The file's bytes aren't valid base64.".to_string())
        }
        InvokeBody::Json(_) => Err("Expected the file's bytes as the request body.".to_string()),
    }
}

/// A text argument of the request: from its percent-encoded header (the raw-body form),
/// else from the JSON body (the base64 form). Text that isn't plain ASCII — names,
/// paths — is percent-encoded in the header form.
pub fn field(request: &Request<'_>, name: &str) -> Result<String, String> {
    if let Some(raw) = request.headers().get(name).and_then(|v| v.to_str().ok()) {
        return percent_encoding::percent_decode_str(raw)
            .decode_utf8()
            .map(|s| s.to_string())
            .map_err(|_| format!("\"{name}\" must be percent-encoded UTF-8."));
    }
    if let InvokeBody::Json(Value::Object(fields)) = request.body() {
        if let Some(value) = fields.get(name) {
            return match value {
                Value::String(s) => Ok(s.clone()),
                Value::Number(n) => Ok(n.to_string()),
                _ => Err(format!("\"{name}\" must be text.")),
            };
        }
    }
    Err(format!("Missing \"{name}\"."))
}
