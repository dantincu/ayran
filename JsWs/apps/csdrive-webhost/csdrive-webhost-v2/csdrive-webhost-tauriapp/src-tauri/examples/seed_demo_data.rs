//! Manually run tool (`cargo run --example seed_demo_data`) that populates the real
//! `data.db` with demo windows/tab groups/tabs for the 9 sample apps in `user/qwer/`:
//! one entry per app, except `qwer/index1.html` which gets 10 window entries, whose
//! first window gets 10 tab groups, whose first group gets 100 tabs.
//!
//! Runs outside the Tauri app entirely, so it duplicates the tiny bit of
//! `data_location`'s pointer-file logic needed to find the *effective* data
//! folder (respecting a relocated custom folder, not just the default one).
//!
//! Safe to re-run: every row it creates is tagged with SEED_TAG, and a run starts
//! by deleting only rows carrying that tag (cascading to their groups/tabs/tags) —
//! it never touches any other window, tab, or tag already in the database.

use std::path::PathBuf;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};
use base64::Engine;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::SqlitePool;

const IDENTIFIER: &str = "com.ayran.csdrive-webhost-tauriapp";
const KEYCHAIN_SERVICE: &str = IDENTIFIER;
const KEYCHAIN_KEY_NAME: &str = "data-location-encryption-key";
const CONFIG_FILE_NAME: &str = "data-location.enc";
const NONCE_LEN: usize = 12;

const SEED_TAG: &str = "seeded:qwer-demo-data";

fn base64_engine() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn default_app_data_dir() -> PathBuf {
    let appdata = std::env::var("APPDATA").expect("%APPDATA% is not set");
    PathBuf::from(appdata).join(IDENTIFIER)
}

/// Reads (never creates) the encryption key from the OS keychain — if it isn't
/// there, no custom data folder was ever set, so falling back to the default is
/// the correct behavior anyway.
fn get_key() -> Option<Vec<u8>> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_KEY_NAME).ok()?;
    let encoded = entry.get_password().ok()?;
    base64_engine().decode(encoded).ok()
}

fn decrypt(key_bytes: &[u8], data: &[u8]) -> Option<Vec<u8>> {
    if data.len() < NONCE_LEN {
        return None;
    }
    let (nonce_bytes, ciphertext) = data.split_at(NONCE_LEN);
    let key = Key::<Aes256Gcm>::try_from(key_bytes).ok()?;
    let cipher = Aes256Gcm::new(&key);
    let nonce = Nonce::try_from(nonce_bytes).ok()?;
    cipher.decrypt(&nonce, ciphertext).ok()
}

/// Mirrors `data_location::effective_data_dir`, duplicated here since this script
/// runs standalone: the custom data folder if the encrypted pointer file resolves
/// to one that still exists, otherwise the default app-data folder.
fn effective_data_dir() -> PathBuf {
    let default_dir = default_app_data_dir();
    let config_path = default_dir.join(CONFIG_FILE_NAME);

    let custom = std::fs::read(&config_path)
        .ok()
        .and_then(|bytes| get_key().and_then(|key| decrypt(&key, &bytes)))
        .and_then(|plain| String::from_utf8(plain).ok())
        .map(|s| PathBuf::from(s.trim().to_string()))
        .filter(|p| p.is_dir());

    custom.unwrap_or(default_dir)
}

fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Deletes every window (and its groups/tabs/tags) carrying SEED_TAG — i.e. only
/// rows this script itself created on a previous run.
async fn delete_previously_seeded_data(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let window_guids: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT guid FROM window_tags WHERE text = ?1")
            .bind(SEED_TAG)
            .fetch_all(pool)
            .await?;

    for guid in &window_guids {
        let tab_guids: Vec<String> = sqlx::query_scalar("SELECT guid FROM tabs WHERE window_guid = ?1")
            .bind(guid)
            .fetch_all(pool)
            .await?;
        let group_guids: Vec<String> = sqlx::query_scalar("SELECT guid FROM tab_groups WHERE window_guid = ?1")
            .bind(guid)
            .fetch_all(pool)
            .await?;

        sqlx::query("DELETE FROM tabs WHERE window_guid = ?1").bind(guid).execute(pool).await?;
        sqlx::query("DELETE FROM tab_groups WHERE window_guid = ?1").bind(guid).execute(pool).await?;
        for g in tab_guids.iter().chain(group_guids.iter()) {
            sqlx::query("DELETE FROM window_tags WHERE guid = ?1").bind(g).execute(pool).await?;
        }
        sqlx::query("DELETE FROM secondary_windows WHERE guid = ?1").bind(guid).execute(pool).await?;
        sqlx::query("DELETE FROM window_tags WHERE guid = ?1").bind(guid).execute(pool).await?;
    }

    Ok(())
}

async fn insert_window(pool: &SqlitePool, relative_path: &str) -> Result<String, sqlx::Error> {
    let guid = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO secondary_windows (guid, relative_path, created_at) VALUES (?1, ?2, ?3)")
        .bind(&guid)
        .bind(relative_path)
        .bind(now_millis())
        .execute(pool)
        .await?;
    sqlx::query("INSERT INTO window_tags (guid, text, fg_color, bg_color) VALUES (?1, ?2, '#ffffff', '#7c3aed')")
        .bind(&guid)
        .bind(SEED_TAG)
        .execute(pool)
        .await?;
    Ok(guid)
}

async fn insert_tab_group(pool: &SqlitePool, window_guid: &str) -> Result<String, sqlx::Error> {
    let guid = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO tab_groups (guid, window_guid, created_at) VALUES (?1, ?2, ?3)")
        .bind(&guid)
        .bind(window_guid)
        .bind(now_millis())
        .execute(pool)
        .await?;
    Ok(guid)
}

async fn insert_tab(
    pool: &SqlitePool,
    group_guid: &str,
    window_guid: &str,
    relative_path: &str,
    index: usize,
) -> Result<(), sqlx::Error> {
    let guid = uuid::Uuid::new_v4().to_string();
    let resource_id = format!("{relative_path}?seed={index}");
    let tab_text = serde_json::json!({
        "firstRow": [{ "text": format!("Seed tab {index}"), "bold": true }],
        "secondRow": [{ "text": resource_id, "italic": true }],
    });

    sqlx::query(
        "INSERT INTO tabs (guid, group_guid, window_guid, relative_path, app_version, resource_id, resource_type, tab_text, created_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, NULL, ?6, ?7)",
    )
    .bind(&guid)
    .bind(group_guid)
    .bind(window_guid)
    .bind(relative_path)
    .bind(&resource_id)
    .bind(tab_text.to_string())
    .bind(now_millis())
    .execute(pool)
    .await?;

    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = effective_data_dir();
    let db_path = data_dir.join("data.db");
    println!("Using data folder: {}", data_dir.display());

    if !db_path.exists() {
        return Err(format!(
            "No data.db found at {} — run the app at least once first so it can create the database.",
            db_path.display()
        )
        .into());
    }

    let qwer_dir = data_dir.join("user").join("qwer");
    for n in 1..=9 {
        let file = qwer_dir.join(format!("index{n}.html"));
        if !file.exists() {
            return Err(format!(
                "Missing sample app file: {} — deploy the sample-apps/qwer/ files into user/qwer/ first.",
                file.display()
            )
            .into());
        }
    }

    let options = SqliteConnectOptions::new().filename(&db_path).create_if_missing(false);
    let pool = SqlitePool::connect_with(options).await?;

    println!("Removing any rows from a previous run of this script (tagged \"{SEED_TAG}\")...");
    delete_previously_seeded_data(&pool).await?;

    let mut index1_window_guids = Vec::new();
    let mut total_windows = 0;

    for n in 1..=9 {
        let relative_path = format!("qwer/index{n}.html");
        let window_count = if n == 1 { 10 } else { 1 };
        for _ in 0..window_count {
            let guid = insert_window(&pool, &relative_path).await?;
            if n == 1 {
                index1_window_guids.push(guid);
            }
            total_windows += 1;
        }
    }
    println!("Created {total_windows} secondary_windows rows across the 9 qwer/ apps (index1.html x10, the rest x1).");

    let first_window_guid = index1_window_guids[0].clone();
    let mut first_window_group_guids = Vec::new();
    for _ in 0..10 {
        first_window_group_guids.push(insert_tab_group(&pool, &first_window_guid).await?);
    }
    println!("Created 10 tab_groups under the first qwer/index1.html window.");

    let first_group_guid = first_window_group_guids[0].clone();
    for i in 1..=100 {
        insert_tab(&pool, &first_group_guid, &first_window_guid, "qwer/index1.html", i).await?;
    }
    println!("Created 100 tabs under the first tab group of that window.");

    pool.close().await;
    println!("Done.");
    Ok(())
}
