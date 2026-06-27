use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::account_for_token;
use crate::mixer::{ExclusiveHost, BYTES_PER_FRAME};
use crate::types::{HostAudioSource, StreamMode};
use crate::AppState;

#[derive(Deserialize)]
pub struct HostQuery {
    token: Option<String>,
    source: Option<String>,
}

#[derive(Deserialize)]
pub struct ListenQuery {
    token: Option<String>,
}

pub async fn ws_host(
    Path(stream_id): Path<String>,
    Query(query): Query<HostQuery>,
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(account) = query.token.as_deref().and_then(|t| account_for_token(&state.store, t)) else {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    };
    let Some(stream) = state.store.get_stream(&stream_id) else {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    };
    if stream.owner_account_id != account.user_id {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }

    // An account can host any number of distinct streams at once (each from
    // a different device/window "device stream"); only a single connection
    // is ever tied to one streamId, since that's inherent to one WebSocket.
    let audio_source = match query.source.as_deref() {
        Some("system") => HostAudioSource::System,
        Some("test-tone") => HostAudioSource::TestTone,
        _ => HostAudioSource::Microphone,
    };

    ws.on_upgrade(move |socket| async move {
        match stream.mode {
            StreamMode::Simple => attach_simple_host(socket, stream_id, account.user_id, audio_source, state).await,
            StreamMode::Raw => attach_raw_host(socket, stream_id, account.user_id, audio_source, state).await,
            StreamMode::Merged => attach_host(socket, stream_id, account.user_id, audio_source, state).await,
        }
    })
}

pub async fn ws_listen(Path(stream_id): Path<String>, Query(query): Query<ListenQuery>, State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    let Some(_account) = query.token.as_deref().and_then(|t| account_for_token(&state.store, t)) else {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    };
    let Some(stream) = state.store.get_stream(&stream_id) else {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    };

    ws.on_upgrade(move |socket| async move {
        match stream.mode {
            StreamMode::Simple => attach_simple_listener(socket, stream_id, state).await,
            StreamMode::Raw => attach_raw_listener(socket, stream_id, state).await,
            StreamMode::Merged => attach_listener(socket, stream_id, state).await,
        }
    })
}

async fn attach_host(mut socket: WebSocket, stream_id: String, account_id: i64, audio_source: HostAudioSource, state: AppState) {
    let connection_id = Uuid::new_v4().to_string();
    state.mixer.register_host(&stream_id, &connection_id, account_id);
    state.store.add_active_host(&stream_id, connection_id.clone(), account_id, audio_source).await;

    while let Some(Ok(msg)) = socket.recv().await {
        if let Message::Binary(data) = msg {
            if data.len() == BYTES_PER_FRAME {
                state.mixer.push_host_frame(&stream_id, &connection_id, data);
            }
        }
    }

    state.mixer.unregister_host(&stream_id, &connection_id);
    state.store.remove_active_host(&stream_id, &connection_id, account_id).await;
}

async fn attach_listener(mut socket: WebSocket, stream_id: String, state: AppState) {
    let connection_id = Uuid::new_v4().to_string();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    state.mixer.register_listener(&stream_id, connection_id.clone(), tx);

    loop {
        tokio::select! {
            frame = rx.recv() => {
                match frame {
                    Some(bytes) => { if socket.send(Message::Binary(bytes.to_vec())).await.is_err() { break; } }
                    None => break,
                }
            }
            msg = socket.recv() => {
                if !matches!(msg, Some(Ok(_))) { break; }
            }
        }
    }

    state.mixer.unregister_listener(&stream_id, &connection_id);
}

async fn attach_simple_listener(mut socket: WebSocket, stream_id: String, state: AppState) {
    let connection_id = Uuid::new_v4().to_string();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    state.mixer.register_simple_listener(&stream_id, connection_id.clone(), tx);

    loop {
        tokio::select! {
            frame = rx.recv() => {
                match frame {
                    Some(bytes) => { if socket.send(Message::Binary(bytes.to_vec())).await.is_err() { break; } }
                    None => break,
                }
            }
            msg = socket.recv() => {
                if !matches!(msg, Some(Ok(_))) { break; }
            }
        }
    }

    state.mixer.unregister_simple_listener(&stream_id, &connection_id);
}

async fn attach_raw_listener(mut socket: WebSocket, stream_id: String, state: AppState) {
    let connection_id = Uuid::new_v4().to_string();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    state.mixer.register_raw_listener(&stream_id, connection_id.clone(), tx);

    loop {
        tokio::select! {
            frame = rx.recv() => {
                match frame {
                    Some(bytes) => { if socket.send(Message::Binary(bytes.to_vec())).await.is_err() { break; } }
                    None => break,
                }
            }
            msg = socket.recv() => {
                if !matches!(msg, Some(Ok(_))) { break; }
            }
        }
    }

    state.mixer.unregister_raw_listener(&stream_id, &connection_id);
}

// "simple" and "raw" hosting share the same single-active-host/superseding
// behavior - a second host starting up on the same stream supersedes
// whoever was streaming on it. They're written as two near-identical
// functions (rather than one generic one) since the two modes use separate
// active-host maps and forward functions, and the coordination logic here
// is already fiddly enough without adding generics on top.

async fn attach_simple_host(mut socket: WebSocket, stream_id: String, account_id: i64, audio_source: HostAudioSource, state: AppState) {
    let connection_id = Uuid::new_v4().to_string();
    let (close_tx, mut close_rx) = tokio::sync::mpsc::unbounded_channel::<()>();

    {
        let mut hosts = state.mixer.active_simple_hosts.lock().unwrap();
        if let Some(previous) = hosts.get(&stream_id) {
            let _ = previous.close.send(());
        }
        hosts.insert(stream_id.clone(), ExclusiveHost { connection_id: connection_id.clone(), close: close_tx });
    }
    state.store.add_active_host(&stream_id, connection_id.clone(), account_id, audio_source).await;

    loop {
        tokio::select! {
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Binary(data))) => {
                        let still_active = state.mixer.active_simple_hosts.lock().unwrap().get(&stream_id).map(|h| h.connection_id == connection_id).unwrap_or(false);
                        if still_active && data.len() == BYTES_PER_FRAME {
                            state.mixer.forward_simple_frame(&stream_id, account_id, &data);
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => break,
                }
            }
            _ = close_rx.recv() => {
                let _ = socket.send(Message::Text(r#"{"type":"superseded"}"#.into())).await;
                break;
            }
        }
    }

    {
        let mut hosts = state.mixer.active_simple_hosts.lock().unwrap();
        if hosts.get(&stream_id).map(|h| h.connection_id == connection_id).unwrap_or(false) {
            hosts.remove(&stream_id);
        }
    }
    state.store.remove_active_host(&stream_id, &connection_id, account_id).await;
}

async fn attach_raw_host(mut socket: WebSocket, stream_id: String, account_id: i64, audio_source: HostAudioSource, state: AppState) {
    let connection_id = Uuid::new_v4().to_string();
    let (close_tx, mut close_rx) = tokio::sync::mpsc::unbounded_channel::<()>();

    {
        let mut hosts = state.mixer.active_raw_hosts.lock().unwrap();
        if let Some(previous) = hosts.get(&stream_id) {
            let _ = previous.close.send(());
        }
        hosts.insert(stream_id.clone(), ExclusiveHost { connection_id: connection_id.clone(), close: close_tx });
    }
    state.store.add_active_host(&stream_id, connection_id.clone(), account_id, audio_source).await;

    loop {
        tokio::select! {
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Binary(data))) => {
                        let still_active = state.mixer.active_raw_hosts.lock().unwrap().get(&stream_id).map(|h| h.connection_id == connection_id).unwrap_or(false);
                        if still_active && data.len() == BYTES_PER_FRAME {
                            state.mixer.forward_raw_frame(&stream_id, &data);
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => break,
                }
            }
            _ = close_rx.recv() => {
                let _ = socket.send(Message::Text(r#"{"type":"superseded"}"#.into())).await;
                break;
            }
        }
    }

    {
        let mut hosts = state.mixer.active_raw_hosts.lock().unwrap();
        if hosts.get(&stream_id).map(|h| h.connection_id == connection_id).unwrap_or(false) {
            hosts.remove(&stream_id);
        }
    }
    state.store.remove_active_host(&stream_id, &connection_id, account_id).await;
}
