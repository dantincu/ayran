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

    Ok(())
}

#[tauri::command]
pub async fn get_app_state(
    state: tauri::State<'_, AppDbState>,
    app_id: String,
    key: String,
) -> Result<Option<String>, String> {
    sqlx::query_scalar("SELECT value FROM app_state WHERE app_id = ?1 AND key = ?2")
        .bind(&app_id)
        .bind(&key)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_app_state(
    state: tauri::State<'_, AppDbState>,
    app_id: String,
    key: String,
    value: String,
) -> Result<(), String> {
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
