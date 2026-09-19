//! A tiny generic key/value store, backed by the same `data.db` as everything else,
//! for apps' own UI-state persistence (active tab, last-browsed folder, ...).
//!
//! It exists so that switching the app's data folder (see `data_location`) also
//! switches an app's *own* settings — something browser storage (IndexedDB /
//! localStorage) can't do, since it lives in the fixed WebView2 profile rather than
//! wherever the data folder currently points. Rows are namespaced by `app_id` — the
//! html file's own relative path (e.g. `index.html`), matching the browser-storage
//! prefix convention it replaces — so multiple apps sharing this one database never
//! collide.

use sqlx::SqlitePool;

pub struct AppDbState {
    pub pool: SqlitePool,
}

pub async fn ensure_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_state (
            app_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (app_id, key)
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE TABLE IF NOT EXISTS global_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        .execute(pool)
        .await?;

    Ok(())
}

async fn caller_app_id(pool: &SqlitePool, caller_guid: Option<&str>) -> Result<String, String> {
    let Some(guid) = caller_guid else {
        return Ok(crate::layout::ADMIN_APP_ID.to_string());
    };
    sqlx::query_scalar("SELECT relative_path FROM secondary_windows WHERE guid = ?1")
        .bind(guid)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "This window isn't a registered app window.".to_string())
}

/// A setting that belongs to no one app but to the whole app — e.g. the page size every list uses, in
/// the admin-app and the system apps alike — so unlike `get_app_state` it isn't kept apart per caller.
/// For preferences only: every window, web apps included, can read and write these.
#[tauri::command]
pub async fn get_global_setting(state: tauri::State<'_, AppDbState>, key: String) -> Result<Option<String>, String> {
    sqlx::query_scalar("SELECT value FROM global_settings WHERE key = ?1")
        .bind(key)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_global_setting(state: tauri::State<'_, AppDbState>, key: String, value: String) -> Result<(), String> {
    sqlx::query("INSERT INTO global_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key)
        .bind(value)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_app_state(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppDbState>,
    key: String,
) -> Result<Option<String>, String> {
    let app_id = caller_app_id(&state.pool, crate::window_host::caller_guid(&window).as_deref()).await?;
    sqlx::query_scalar("SELECT value FROM app_state WHERE app_id = ?1 AND key = ?2")
        .bind(&app_id)
        .bind(&key)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_app_state(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppDbState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let app_id = caller_app_id(&state.pool, crate::window_host::caller_guid(&window).as_deref()).await?;
    sqlx::query(
        "INSERT INTO app_state (app_id, key, value) VALUES (?1, ?2, ?3)
         ON CONFLICT(app_id, key) DO UPDATE SET value = excluded.value",
    )
    .bind(&app_id)
    .bind(&key)
    .bind(&value)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// For other modules' tests: the app id state is kept under for a window.
#[cfg(test)]
pub(crate) async fn caller_app_id_for_test(pool: &SqlitePool, guid: &str) -> String {
    caller_app_id(pool, Some(guid)).await.unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqliteConnectOptions;

    async fn test_pool(name: &str) -> SqlitePool {
        let dir = std::env::temp_dir().join(format!("csdrive-app-state-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let options = SqliteConnectOptions::new()
            .filename(dir.join("data.db"))
            .create_if_missing(true);
        let pool = SqlitePool::connect_with(options).await.unwrap();
        ensure_schema(&pool).await.unwrap();
        pool
    }

    #[test]
    fn values_are_scoped_per_app_id() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("scoping").await;

            sqlx::query("INSERT INTO app_state (app_id, key, value) VALUES ('index.html', 'activeTab', '\"windows\"')")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO app_state (app_id, key, value) VALUES ('other.html', 'activeTab', '\"files\"')")
                .execute(&pool)
                .await
                .unwrap();

            let a: Option<String> = sqlx::query_scalar("SELECT value FROM app_state WHERE app_id = 'index.html' AND key = 'activeTab'")
                .fetch_optional(&pool)
                .await
                .unwrap();
            let b: Option<String> = sqlx::query_scalar("SELECT value FROM app_state WHERE app_id = 'other.html' AND key = 'activeTab'")
                .fetch_optional(&pool)
                .await
                .unwrap();

            assert_eq!(a.as_deref(), Some("\"windows\""));
            assert_eq!(b.as_deref(), Some("\"files\""));
        });
    }

    #[test]
    fn a_windows_app_id_comes_from_its_own_identity() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("caller").await;
            sqlx::query("CREATE TABLE secondary_windows (guid TEXT PRIMARY KEY, relative_path TEXT NOT NULL, created_at INTEGER NOT NULL)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO secondary_windows (guid, relative_path, created_at) VALUES ('win-1', 'qwer/index1.html', 0)")
                .execute(&pool)
                .await
                .unwrap();

            assert_eq!(caller_app_id(&pool, None).await.unwrap(), crate::layout::ADMIN_APP_ID);
            assert_eq!(caller_app_id(&pool, Some("win-1")).await.unwrap(), "qwer/index1.html");
            assert!(caller_app_id(&pool, Some("unknown")).await.is_err());
        });
    }

    #[test]
    fn set_app_state_upserts() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool("upsert").await;

            sqlx::query("INSERT INTO app_state (app_id, key, value) VALUES ('index.html', 'k', 'old')")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO app_state (app_id, key, value) VALUES (?1, ?2, ?3)
                 ON CONFLICT(app_id, key) DO UPDATE SET value = excluded.value",
            )
            .bind("index.html")
            .bind("k")
            .bind("new")
            .execute(&pool)
            .await
            .unwrap();

            let value: Option<String> = sqlx::query_scalar("SELECT value FROM app_state WHERE app_id = 'index.html' AND key = 'k'")
                .fetch_optional(&pool)
                .await
                .unwrap();
            assert_eq!(value.as_deref(), Some("new"));
        });
    }
}
