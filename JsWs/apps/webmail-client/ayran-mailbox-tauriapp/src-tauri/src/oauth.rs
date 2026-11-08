//! Signing in to Gmail and Outlook: OAuth 2.0 authorization code + PKCE, the way native apps do it
//! (RFC 8252). The app listens on a random port of the loopback interface, opens the provider's
//! sign-in page in the system browser, and the provider redirects the browser back to
//! `http://127.0.0.1:<port>/` (Google) or `http://localhost:<port>/` (Microsoft) with the code. The code
//! is exchanged here; the tokens never leave the Rust side.

use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Notify;

use crate::accounts::OAuthTokens;
use crate::mail::types::Provider;

/// How long the browser sign-in may take before the app stops waiting.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

struct ProviderConfig {
    auth_url: String,
    token_url: String,
    scope: &'static str,
    client_id: Option<&'static str>,
    client_secret: Option<&'static str>,
    /// The host the redirect URI names (each provider documents a different one for loopback).
    redirect_host: &'static str,
    env_prefix: &'static str,
}

/// Which Microsoft accounts the app registration accepts: `consumers` (personal accounts only — the
/// default, as the registration in `.env.example` describes), `common` (personal and work/school) or
/// `organizations`, or a tenant id.
fn outlook_tenant() -> &'static str {
    option_env!("OUTLOOK_TENANT").filter(|t| !t.is_empty()).unwrap_or("consumers")
}

fn config(provider: Provider) -> Result<ProviderConfig, String> {
    match provider {
        Provider::Gmail => Ok(ProviderConfig {
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token_url: "https://oauth2.googleapis.com/token".into(),
            scope: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
            client_id: option_env!("GMAIL_CLIENT_ID"),
            client_secret: option_env!("GMAIL_CLIENT_SECRET"),
            redirect_host: "127.0.0.1",
            env_prefix: "GMAIL",
        }),
        Provider::Outlook => Ok(ProviderConfig {
            auth_url: format!("https://login.microsoftonline.com/{}/oauth2/v2.0/authorize", outlook_tenant()),
            token_url: format!("https://login.microsoftonline.com/{}/oauth2/v2.0/token", outlook_tenant()),
            scope: "offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read",
            client_id: option_env!("OUTLOOK_CLIENT_ID"),
            client_secret: option_env!("OUTLOOK_CLIENT_SECRET"),
            redirect_host: "localhost",
            env_prefix: "OUTLOOK",
        }),
        Provider::Yahoo => Err("Yahoo connects with an app password, not OAuth.".into()),
    }
}

impl ProviderConfig {
    fn client_id(&self) -> Result<&'static str, String> {
        self.client_id.filter(|id| !id.is_empty()).ok_or_else(|| {
            format!(
                "This build has no {p} OAuth client. Set {p}_CLIENT_ID (see .env.example) and rebuild the app.",
                p = self.env_prefix
            )
        })
    }

    fn secret(&self) -> Option<&'static str> {
        self.client_secret.filter(|s| !s.is_empty())
    }
}

fn random_b64(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

pub fn code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    scope: Option<String>,
}

#[derive(Deserialize)]
struct TokenError {
    error: String,
    error_description: Option<String>,
}

async fn token_request(http: &reqwest::Client, cfg: &ProviderConfig, mut form: Vec<(&str, String)>) -> Result<TokenResponse, String> {
    form.push(("client_id", cfg.client_id()?.to_string()));
    if let Some(secret) = cfg.secret() {
        form.push(("client_secret", secret.to_string()));
    }
    let res = http.post(&cfg.token_url).form(&form).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(match serde_json::from_str::<TokenError>(&text) {
            Ok(e) => format!("{}{}", e.error, e.error_description.map(|d| format!(": {d}")).unwrap_or_default()),
            Err(_) => format!("token endpoint answered {status}"),
        });
    }
    serde_json::from_str(&text).map_err(|e| format!("unexpected token response: {e}"))
}

fn tokens_from(res: TokenResponse, previous_refresh: Option<String>, cfg: &ProviderConfig) -> OAuthTokens {
    OAuthTokens {
        access_token: res.access_token,
        // Google doesn't send a new refresh token on refresh; keep the one we have.
        refresh_token: res.refresh_token.or(previous_refresh),
        expires_at: chrono::Utc::now().timestamp_millis() + res.expires_in.unwrap_or(3600) * 1000,
        scope: res.scope.unwrap_or_else(|| cfg.scope.to_string()),
    }
}

pub async fn refresh(http: &reqwest::Client, provider: Provider, refresh_token: &str) -> Result<OAuthTokens, String> {
    let cfg = config(provider)?;
    let res = token_request(
        http,
        &cfg,
        vec![("grant_type", "refresh_token".into()), ("refresh_token", refresh_token.into()), ("scope", cfg.scope.into())],
    )
    .await?;
    Ok(tokens_from(res, Some(refresh_token.to_string()), &cfg))
}

pub struct Profile {
    pub email: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

pub async fn profile(http: &reqwest::Client, provider: Provider, access_token: &str) -> Result<Profile, String> {
    match provider {
        Provider::Gmail => {
            #[derive(Deserialize)]
            struct Google {
                email: String,
                name: Option<String>,
                picture: Option<String>,
            }
            let res = http.get("https://www.googleapis.com/oauth2/v2/userinfo").bearer_auth(access_token).send().await.map_err(|e| e.to_string())?;
            let p: Google = crate::http_json(res).await?;
            Ok(Profile { display_name: p.name.unwrap_or_else(|| p.email.clone()), email: p.email, avatar_url: p.picture })
        }
        Provider::Outlook => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Graph {
                display_name: Option<String>,
                mail: Option<String>,
                user_principal_name: String,
            }
            let res = http
                .get("https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName")
                .bearer_auth(access_token)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let p: Graph = crate::http_json(res).await?;
            let email = p.mail.unwrap_or(p.user_principal_name);
            Ok(Profile { display_name: p.display_name.unwrap_or_else(|| email.clone()), email, avatar_url: None })
        }
        Provider::Yahoo => Err("Yahoo has no OAuth profile here.".into()),
    }
}

/// The parts of the request line's query we care about.
#[derive(Debug, Default, PartialEq)]
struct Redirect {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// `GET /?code=…&state=… HTTP/1.1` → its parameters; `None` for any other path (a favicon request…).
fn parse_redirect(request: &str) -> Option<Redirect> {
    let target = request.lines().next()?.strip_prefix("GET ")?.split(' ').next()?;
    let url = reqwest::Url::parse(&format!("http://loopback{target}")).ok()?;
    if url.path() != "/" {
        return None;
    }
    let mut r = Redirect::default();
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => r.code = Some(v.into_owned()),
            "state" => r.state = Some(v.into_owned()),
            "error_description" => r.error = Some(v.into_owned()),
            "error" if r.error.is_none() => r.error = Some(v.into_owned()),
            _ => {}
        }
    }
    Some(r)
}

const PAGE: &str = "<!doctype html><meta charset=utf-8><title>Ayran Mailbox</title>\
<body style=\"font-family:system-ui,sans-serif;display:grid;place-items:center;height:90vh;color:#374151\">\
<div style=\"text-align:center\"><h2>{TITLE}</h2><p>{TEXT}</p></div>";

async fn respond(stream: &mut tokio::net::TcpStream, status: &str, title: &str, text: &str) {
    let body = PAGE.replace("{TITLE}", title).replace("{TEXT}", text);
    let res = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(res.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Waits for the browser to come back with the code for `state`.
async fn wait_for_code(listener: TcpListener, state: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 8192];
        let mut len = 0;
        // Read the request head (the request line is all we need).
        while len < buf.len() {
            match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf[len..])).await {
                Ok(Ok(0)) | Err(_) => break,
                Ok(Ok(n)) => len += n,
                Ok(Err(_)) => break,
            }
            if buf[..len].windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        let request = String::from_utf8_lossy(&buf[..len]);
        let Some(redirect) = parse_redirect(&request) else {
            respond(&mut stream, "404 Not Found", "Not found", "").await;
            continue;
        };
        if redirect.state.as_deref() != Some(state) {
            // Not our sign-in (a stale tab, or something else knocking): ignore, keep waiting.
            respond(&mut stream, "400 Bad Request", "This sign-in link has expired", "Start again from Ayran Mailbox.").await;
            continue;
        }
        if let Some(err) = redirect.error {
            respond(&mut stream, "200 OK", "Sign-in was not completed", "You can close this tab and return to Ayran Mailbox.").await;
            return Err(err);
        }
        let Some(code) = redirect.code else {
            respond(&mut stream, "400 Bad Request", "Sign-in failed", "The provider sent no authorization code.").await;
            return Err("The provider sent no authorization code.".into());
        };
        respond(&mut stream, "200 OK", "You're signed in", "You can close this tab and return to Ayran Mailbox.").await;
        return Ok(code);
    }
}

/// The whole browser sign-in. `open` shows the URL in the system browser; `cancel` aborts the wait.
pub async fn sign_in(
    http: &reqwest::Client,
    provider: Provider,
    cancel: &Notify,
    open: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(OAuthTokens, Profile), String> {
    let cfg = config(provider)?;
    let client_id = cfg.client_id()?;

    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| format!("Can't listen for the sign-in redirect: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://{}:{port}/", cfg.redirect_host);

    let verifier = random_b64(48);
    let state = random_b64(24);
    let mut url = reqwest::Url::parse(&cfg.auth_url).map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", cfg.scope)
        .append_pair("state", &state)
        .append_pair("code_challenge", &code_challenge(&verifier))
        .append_pair("code_challenge_method", "S256");
    match provider {
        // A refresh token every time, and the account chooser even when one Google account is signed in.
        Provider::Gmail => {
            url.query_pairs_mut().append_pair("access_type", "offline").append_pair("prompt", "consent select_account");
        }
        _ => {
            url.query_pairs_mut().append_pair("prompt", "select_account");
        }
    }

    open(url.as_str())?;

    let code = tokio::select! {
        r = wait_for_code(listener, &state) => r?,
        _ = cancel.notified() => return Err("Sign-in cancelled.".into()),
        _ = tokio::time::sleep(SIGN_IN_TIMEOUT) => return Err("Sign-in timed out.".into()),
    };

    let res = token_request(
        http,
        &cfg,
        vec![
            ("grant_type", "authorization_code".into()),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
        ],
    )
    .await?;
    let tokens = tokens_from(res, None, &cfg);
    let profile = profile(http, provider, &tokens.access_token).await?;
    Ok((tokens, profile))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pkce_challenge_is_unpadded_base64url_sha256() {
        // Expected value computed independently: base64.urlsafe_b64encode(hashlib.sha256(v).digest()).rstrip(b'=')
        assert_eq!(code_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r7wW1gFWFOEjXk"), "bwWFMyPfdG9qreDhH2lmftFx_dFeLDalzcT1gb_j68g");
        let verifier = random_b64(48);
        assert_eq!(verifier.len(), 64, "RFC 7636 wants 43-128 characters");
        assert!(verifier.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn the_redirect_request_line_is_parsed() {
        let r = parse_redirect("GET /?code=4%2F0Ab&state=xyz&scope=a+b HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
        assert_eq!(r, Redirect { code: Some("4/0Ab".into()), state: Some("xyz".into()), error: None });
        let e = parse_redirect("GET /?error=access_denied&error_description=User+said+no&state=s HTTP/1.1\r\n").unwrap();
        assert_eq!(e.error.as_deref(), Some("User said no"));
        assert!(parse_redirect("GET /favicon.ico HTTP/1.1\r\n").is_none());
        assert!(parse_redirect("POST / HTTP/1.1\r\n").is_none());
    }

    #[tokio::test]
    async fn the_loopback_listener_hands_back_the_code_for_its_own_state_only() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let waiter = tokio::spawn(async move { wait_for_code(listener, "good").await });

        let get = |path: &'static str| async move {
            let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).await.unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).await.unwrap();
            out
        };
        assert!(get("/favicon.ico").await.starts_with("HTTP/1.1 404"));
        assert!(get("/?code=c1&state=bad").await.starts_with("HTTP/1.1 400"));
        assert!(get("/?code=c2&state=good").await.starts_with("HTTP/1.1 200"));
        assert_eq!(waiter.await.unwrap().unwrap(), "c2");
    }
}
