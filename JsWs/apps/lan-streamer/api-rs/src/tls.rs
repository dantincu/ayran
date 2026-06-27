use std::path::{Path, PathBuf};

/// The deployed instance uses a real Let's Encrypt certificate (DuckDNS
/// DNS-01, see README) at `certs/dev-cert.pem`/`dev-key.pem` - despite the
/// "dev" naming (a holdover from when this was self-signed), that's the real
/// cert the Node API already serves. The Rust API just loads the same
/// files rather than generating its own self-signed one.
pub fn load_certificate(cert_dir: &Path) -> Result<(PathBuf, PathBuf), String> {
    let key_path = cert_dir.join("dev-key.pem");
    let cert_path = cert_dir.join("dev-cert.pem");

    if !key_path.exists() || !cert_path.exists() {
        return Err(format!(
            "Expected an existing certificate at {} and {} - this API doesn't generate its own (the real Let's Encrypt cert from the Node deployment should already be there, see README's \"TLS certificate\" section).",
            cert_path.display(),
            key_path.display(),
        ));
    }

    Ok((key_path, cert_path))
}
