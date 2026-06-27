mod auth;
mod config;
mod filen;
mod mixer;
mod routes;
mod secure_store;
mod store;
mod tls;
mod types;
mod ws_handlers;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::routing::get;
use axum::Router;
use axum_server::tls_rustls::RustlsConfig;
use tower_http::cors::CorsLayer;

use mixer::Mixer;
use store::Store;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub mixer: Arc<Mixer>,
}

#[tokio::main]
async fn main() {
    // rustls needs an explicit crypto provider selected when more than one
    // is reachable in the dependency graph (axum-server/reqwest can each
    // pull in aws-lc-rs transitively) - without this it panics at the first
    // TLS operation instead of picking one automatically.
    rustls::crypto::ring::default_provider().install_default().expect("failed to install rustls crypto provider");

    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8443);
    let data_dir = std::env::current_dir().expect("cwd").join("data");
    let cert_dir = std::env::current_dir().expect("cwd").join("certs");

    let store = Arc::new(Store::new(data_dir));
    store.load_streams().await.expect("failed to load streams");
    store.load_sessions().await.expect("failed to load sessions");
    store.load_account_settings().await.expect("failed to load account settings");

    let mixer = Arc::new(Mixer::new(store.clone()));
    let state = AppState { store, mixer };

    let (key_path, cert_path) = tls::load_certificate(&cert_dir).expect("certificate not found");

    let app = Router::new()
        .nest("/api", routes::router())
        .route("/ws/host/:stream_id", get(ws_handlers::ws_host))
        .route("/ws/listen/:stream_id", get(ws_handlers::ws_listen))
        // Clients are Tauri desktop/mobile apps (arbitrary dev-server or
        // app:// origins), not browser pages we need to restrict; auth is
        // enforced via Filen login + bearer token, not by origin, so
        // reflecting the request origin is fine here.
        .layer(CorsLayer::permissive())
        .with_state(state);

    let tls_config = RustlsConfig::from_pem_file(&cert_path, &key_path).await.expect("failed to load TLS cert/key");

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("LAN Streamer API (Rust) listening on https://0.0.0.0:{port}");
    axum_server::bind_rustls(addr, tls_config).serve(app.into_make_service()).await.expect("server error");
}
