//! Ayran Mailbox — the Rust side: accounts and their encrypted credentials, OAuth sign-in, and the
//! mail providers (Gmail and Outlook over their REST APIs, Yahoo over IMAP/SMTP). The webview only
//! ever names an account by id; credentials stay in this process.

mod accounts;
#[cfg(target_os = "android")]
mod android_jni;
mod folder_pairs;
mod mail;
mod oauth;
mod secure_store;

use lettre::message::Mailbox;
use serde::de::DeserializeOwned;
use tauri::{Manager, State};
use tokio::sync::{Mutex, Notify};

use accounts::{AccountInfo, AccountStore, Credentials, StoredAccount};
use mail::types::*;
use mail::Service;

pub const MAIN_WINDOW_LABEL: &str = "main";

/// Refresh the access token when it has less than this left.
const REFRESH_MARGIN_MS: i64 = 2 * 60 * 1000;

struct AppState {
    http: reqwest::Client,
    accounts: AccountStore,
    /// Wakes a browser sign-in that is waiting, to cancel it.
    sign_in_cancel: Notify,
    /// One refresh at a time, so two commands don't both spend the same refresh token.
    refresh_lock: Mutex<()>,
}

// ── HTTP helpers shared by the providers ─────────────────────────────────────

/// The readable part of a Google / Microsoft API error body.
fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body).ok().and_then(|v| {
        v.pointer("/error/message")
            .or_else(|| v.pointer("/error_description"))
            .or_else(|| v.pointer("/error"))
            .and_then(|m| m.as_str().map(str::to_string))
    });
    match (status.as_u16(), message) {
        (401, _) => "The provider no longer accepts this account's sign-in. Remove the account and add it again.".into(),
        (_, Some(m)) => format!("{m} ({status})"),
        (_, None) => format!("The provider answered {status}"),
    }
}

pub(crate) async fn http_json<T: DeserializeOwned>(res: reqwest::Response) -> Result<T, String> {
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(api_error(status, &body));
    }
    serde_json::from_str(&body).map_err(|e| format!("Unexpected answer from the provider: {e}"))
}

pub(crate) async fn http_ok(res: reqwest::Response) -> Result<(), String> {
    let status = res.status();
    if status.is_success() {
        return Ok(());
    }
    Err(api_error(status, &res.text().await.unwrap_or_default()))
}

// ── Accounts → services ──────────────────────────────────────────────────────

/// A valid access token for an OAuth account, refreshing (and saving) it if it's about to expire.
async fn access_token(state: &AppState, account_id: &str) -> Result<String, String> {
    let fresh = |a: &StoredAccount| match &a.credentials {
        Credentials::OAuth { tokens } if tokens.expires_at - REFRESH_MARGIN_MS > chrono::Utc::now().timestamp_millis() => {
            Some(tokens.access_token.clone())
        }
        _ => None,
    };
    if let Some(token) = fresh(&state.accounts.get(account_id).await?) {
        return Ok(token);
    }

    let _guard = state.refresh_lock.lock().await;
    let mut account = state.accounts.get(account_id).await?; // another command may have refreshed meanwhile
    if let Some(token) = fresh(&account) {
        return Ok(token);
    }
    let Credentials::OAuth { tokens } = &account.credentials else {
        return Err("This account doesn't sign in with OAuth.".into());
    };
    let refresh_token = tokens.refresh_token.clone().ok_or_else(|| expired(&account.email))?;
    let tokens = oauth::refresh(&state.http, account.provider, &refresh_token).await.map_err(|e| {
        log::warn!("Token refresh for {} failed: {e}", account.id);
        if e.starts_with("invalid_grant") { expired(&account.email) } else { format!("Couldn't renew the sign-in: {e}") }
    })?;
    let token = tokens.access_token.clone();
    account.credentials = Credentials::OAuth { tokens };
    state.accounts.save(account).await?;
    Ok(token)
}

fn expired(email: &str) -> String {
    format!("The sign-in to {email} has expired or was revoked. Remove the account and add it again.")
}

async fn service(state: &AppState, account_id: &str) -> Result<(Service, StoredAccount), String> {
    let account = state.accounts.get(account_id).await?;
    let id = account.id.clone();
    let svc = match (&account.provider, &account.credentials) {
        (Provider::Gmail, Credentials::OAuth { .. }) => {
            Service::Gmail(mail::gmail::Gmail::new(state.http.clone(), access_token(state, &id).await?, id))
        }
        (Provider::Outlook, Credentials::OAuth { .. }) => {
            Service::Outlook(mail::outlook::Outlook::new(state.http.clone(), access_token(state, &id).await?, id))
        }
        (Provider::Yahoo, Credentials::AppPassword { app_password }) => {
            Service::Yahoo(mail::yahoo::Yahoo::new(account.email.clone(), app_password.clone(), id))
        }
        _ => return Err("This account's stored credentials don't match its provider.".into()),
    };
    Ok((svc, account))
}

fn sender(account: &StoredAccount) -> Result<Mailbox, String> {
    let address = account.email.parse().map_err(|e| format!("The account's address isn't valid: {e}"))?;
    let name = (!account.display_name.is_empty() && account.display_name != account.email).then(|| account.display_name.clone());
    Ok(Mailbox::new(name, address))
}

// ── Commands: accounts ───────────────────────────────────────────────────────

#[tauri::command]
async fn list_accounts(state: State<'_, AppState>) -> Result<Vec<AccountInfo>, String> {
    state.accounts.list().await
}

#[tauri::command]
async fn remove_account(state: State<'_, AppState>, account_id: String) -> Result<(), String> {
    state.accounts.remove(&account_id).await
}

#[tauri::command]
async fn oauth_sign_in(app: tauri::AppHandle, state: State<'_, AppState>, provider: Provider) -> Result<AccountInfo, String> {
    use tauri_plugin_opener::OpenerExt;
    let (tokens, profile) = oauth::sign_in(&state.http, provider, &state.sign_in_cancel, |url| {
        app.opener().open_url(url, None::<&str>).map_err(|e| format!("Couldn't open the browser: {e}"))
    })
    .await?;
    let account = StoredAccount {
        id: StoredAccount::account_id(provider, &profile.email),
        provider,
        email: profile.email,
        display_name: profile.display_name,
        avatar_url: profile.avatar_url,
        credentials: Credentials::OAuth { tokens },
    };
    let info = account.info();
    state.accounts.save(account).await?;
    Ok(info)
}

#[tauri::command]
fn oauth_cancel(state: State<'_, AppState>) {
    state.sign_in_cancel.notify_waiters();
}

#[tauri::command]
async fn yahoo_connect(state: State<'_, AppState>, email: String, app_password: String) -> Result<AccountInfo, String> {
    let email = email.trim().to_string();
    // Yahoo shows app passwords in groups of four; the spaces aren't part of it.
    let app_password: String = app_password.chars().filter(|c| !c.is_whitespace()).collect();
    if email.is_empty() || app_password.is_empty() {
        return Err("Email and app password are required.".into());
    }
    let id = StoredAccount::account_id(Provider::Yahoo, &email);
    mail::yahoo::Yahoo::new(email.clone(), app_password.clone(), id.clone())
        .verify()
        .await
        .map_err(|e| format!("Connection failed. Check your Yahoo email address and app password. ({e})"))?;
    let account = StoredAccount {
        id,
        provider: Provider::Yahoo,
        display_name: email.clone(),
        email,
        avatar_url: None,
        credentials: Credentials::AppPassword { app_password },
    };
    let info = account.info();
    state.accounts.save(account).await?;
    Ok(info)
}

// ── Commands: mail ───────────────────────────────────────────────────────────

#[tauri::command]
async fn get_folders(state: State<'_, AppState>, account_id: String) -> Result<Vec<Folder>, String> {
    service(&state, &account_id).await?.0.folders().await
}

#[tauri::command]
async fn get_emails(state: State<'_, AppState>, account_id: String, query: EmailQuery) -> Result<EmailPage, String> {
    service(&state, &account_id).await?.0.emails(&query).await
}

#[tauri::command]
async fn get_email_full(state: State<'_, AppState>, account_id: String, email_id: String) -> Result<EmailFull, String> {
    service(&state, &account_id).await?.0.email_full(&email_id).await
}

#[tauri::command]
async fn send_email(state: State<'_, AppState>, account_id: String, compose: Compose) -> Result<(), String> {
    let (svc, account) = service(&state, &account_id).await?;
    svc.send(&compose, &sender(&account)?).await
}

#[tauri::command]
async fn mark_as_read(state: State<'_, AppState>, account_id: String, email_id: String) -> Result<(), String> {
    service(&state, &account_id).await?.0.mark_read(&email_id).await
}

#[tauri::command]
async fn trash_emails(state: State<'_, AppState>, account_id: String, email_ids: Vec<String>) -> Result<(), String> {
    service(&state, &account_id).await?.0.trash(&email_ids).await
}

#[tauri::command]
async fn archive_emails(state: State<'_, AppState>, account_id: String, email_ids: Vec<String>) -> Result<(), String> {
    service(&state, &account_id).await?.0.archive(&email_ids).await
}

#[tauri::command]
async fn modify_labels(
    state: State<'_, AppState>,
    account_id: String,
    email_ids: Vec<String>,
    add_ids: Vec<String>,
    remove_ids: Vec<String>,
) -> Result<(), String> {
    service(&state, &account_id).await?.0.modify_labels(&email_ids, &add_ids, &remove_ids).await
}

#[tauri::command]
async fn move_emails(state: State<'_, AppState>, account_id: String, email_ids: Vec<String>, folder_id: String) -> Result<(), String> {
    service(&state, &account_id).await?.0.move_to(&email_ids, &folder_id).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(target_os = "android")]
            android_jni::init(app.handle().clone());

            let data_dir = app.path().app_data_dir()?;
            app.manage(AppState {
                http: reqwest::Client::builder()
                    .user_agent(concat!("AyranMailbox/", env!("CARGO_PKG_VERSION")))
                    .timeout(std::time::Duration::from_secs(60))
                    .build()?,
                accounts: AccountStore::new(data_dir.join("accounts")),
                sign_in_cancel: Notify::new(),
                refresh_lock: Mutex::new(()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_accounts,
            remove_account,
            oauth_sign_in,
            oauth_cancel,
            yahoo_connect,
            get_folders,
            get_emails,
            get_email_full,
            send_email,
            mark_as_read,
            trash_emails,
            archive_emails,
            modify_labels,
            move_emails,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ayran Mailbox");
}
