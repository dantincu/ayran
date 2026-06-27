use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{end_session, issue_session, AuthedAccount};
use crate::config::{MAX_MAX_DEVICE_AMPLITUDE, MIN_MAX_DEVICE_AMPLITUDE};
use crate::filen::login_with_filen;
use crate::types::{AccountSettings, StreamMode};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/streams", get(list_streams).post(create_stream))
        .route("/streams/:id", delete(delete_stream))
        .route("/streams/:id/pause", post(pause_stream))
        .route("/streams/:id/resume", post(resume_stream))
        .route("/account/settings", get(get_account_settings).put(put_account_settings))
}

#[derive(Deserialize)]
struct LoginBody {
    email: Option<String>,
    password: Option<String>,
    #[serde(rename = "twoFactorCode")]
    two_factor_code: Option<String>,
}

async fn login(State(state): State<AppState>, Json(body): Json<LoginBody>) -> (StatusCode, Json<Value>) {
    let (Some(email), Some(password)) = (body.email, body.password) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "email and password are required" })));
    };

    match login_with_filen(&email, &password, body.two_factor_code).await {
        Ok(account) => {
            let token = issue_session(&state.store, account.clone()).await;
            (StatusCode::OK, Json(json!({ "token": token, "account": account })))
        }
        Err(err) => (StatusCode::UNAUTHORIZED, Json(json!({ "error": err }))),
    }
}

async fn logout(State(state): State<AppState>, headers: axum::http::HeaderMap) -> StatusCode {
    if let Some(token) = headers.get(axum::http::header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")) {
        end_session(&state.store, token).await;
    }
    StatusCode::NO_CONTENT
}

async fn list_streams(State(state): State<AppState>, AuthedAccount(account): AuthedAccount) -> Json<Value> {
    Json(json!(state.store.list_streams_for_account(account.user_id)))
}

#[derive(Deserialize)]
struct CreateStreamBody {
    name: Option<String>,
    mode: Option<StreamMode>,
}

async fn create_stream(State(state): State<AppState>, AuthedAccount(account): AuthedAccount, Json(body): Json<CreateStreamBody>) -> (StatusCode, Json<Value>) {
    let Some(name) = body.name.filter(|n| !n.trim().is_empty()) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "name is required" })));
    };
    let Some(mode) = body.mode else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "mode must be 'merged', 'simple', or 'raw'" })));
    };
    let record = state.store.create_stream(name.trim().to_string(), account.user_id, mode).await;
    (StatusCode::CREATED, Json(json!(record)))
}

async fn delete_stream(State(state): State<AppState>, AuthedAccount(account): AuthedAccount, Path(id): Path<String>) -> (StatusCode, Json<Value>) {
    if state.store.delete_stream(&id, account.user_id).await {
        (StatusCode::NO_CONTENT, Json(Value::Null))
    } else {
        (StatusCode::NOT_FOUND, Json(json!({ "error": "Stream not found" })))
    }
}

async fn pause_stream(State(state): State<AppState>, AuthedAccount(account): AuthedAccount, Path(id): Path<String>) -> (StatusCode, Json<Value>) {
    set_paused(state, account, id, true).await
}

async fn resume_stream(State(state): State<AppState>, AuthedAccount(account): AuthedAccount, Path(id): Path<String>) -> (StatusCode, Json<Value>) {
    set_paused(state, account, id, false).await
}

async fn set_paused(state: AppState, account: crate::types::FilenAccount, id: String, paused: bool) -> (StatusCode, Json<Value>) {
    match state.store.get_stream(&id) {
        Some(stream) if stream.owner_account_id == account.user_id => {
            state.store.set_host_paused(&id, account.user_id, paused).await;
            (StatusCode::NO_CONTENT, Json(Value::Null))
        }
        _ => (StatusCode::NOT_FOUND, Json(json!({ "error": "Stream not found" }))),
    }
}

async fn get_account_settings(State(state): State<AppState>, AuthedAccount(account): AuthedAccount) -> Json<Value> {
    Json(json!(state.store.get_account_settings(account.user_id)))
}

#[derive(Deserialize)]
struct UpdateAccountSettingsBody {
    #[serde(rename = "maxDeviceAmplitude")]
    max_device_amplitude: Option<f64>,
}

async fn put_account_settings(State(state): State<AppState>, AuthedAccount(account): AuthedAccount, Json(body): Json<UpdateAccountSettingsBody>) -> (StatusCode, Json<Value>) {
    let Some(max_device_amplitude) = body.max_device_amplitude.filter(|v| v.is_finite() && *v >= MIN_MAX_DEVICE_AMPLITUDE && *v <= MAX_MAX_DEVICE_AMPLITUDE) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("maxDeviceAmplitude must be a number between {MIN_MAX_DEVICE_AMPLITUDE} and {MAX_MAX_DEVICE_AMPLITUDE}") })),
        );
    };
    state.store.set_account_settings(account.user_id, AccountSettings { max_device_amplitude }).await;
    (StatusCode::OK, Json(json!(state.store.get_account_settings(account.user_id))))
}
