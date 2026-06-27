use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::Json;
use rand::RngCore;
use serde_json::json;

use crate::store::Store;
use crate::types::{FilenAccount, Session};
use crate::AppState;

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

pub async fn issue_session(store: &Store, account: FilenAccount) -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = hex::encode(bytes);
    store.create_session(Session { token: token.clone(), account, created_at: now_ms() }).await;
    token
}

pub async fn end_session(store: &Store, token: &str) {
    store.delete_session(token).await;
}

pub fn account_for_token(store: &Store, token: &str) -> Option<FilenAccount> {
    store.get_session(token).map(|s| s.account)
}

/// Extractor mirroring the Node `requireAuth` middleware - rejects with 401
/// before the handler body runs if the bearer token is missing/invalid.
pub struct AuthedAccount(pub FilenAccount);

#[async_trait::async_trait]
impl FromRequestParts<AppState> for AuthedAccount {
    type Rejection = (StatusCode, Json<serde_json::Value>);

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let unauthorized = || (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Not authenticated" })));

        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "));

        let Some(token) = token else { return Err(unauthorized()) };
        account_for_token(&state.store, token).map(AuthedAccount).ok_or_else(unauthorized)
    }
}
