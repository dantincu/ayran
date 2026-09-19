//! Folders the user picks to browse and use, remembered across restarts.
//!
//! Picking is a native dialog either way — the OS's own on desktop, `FolderPicker.kt` on Android
//! (the system one there hands back `content://` URIs, which the file commands, SQLite and web apps
//! can't use, so the app ships its own that browses the real filesystem; it needs Android's "All
//! files access", asked for the first time). The chosen folder is a plain absolute path, added to
//! the app's file scope (`fs_scope.rs`) — which is all it takes for the Files tab, SQLite databases
//! in it and web apps to use it, through the ordinary file commands.
//!
//! What this module adds is memory: the scope is empty at every start, so the picked folders are
//! kept in `data.db` and allowed again then (`allow_saved`). And forgetting one really revokes it:
//! `remove_picked_root` takes it out of the scope at once, and it can be picked again afterwards.
//!
//! Like any file access, picking is available to every window: it needs the person to choose in a
//! native dialog.

use std::path::Path;

use serde::Serialize;
use sqlx::SqlitePool;
use tauri::AppHandle;

use crate::app_state::AppDbState;
use crate::fs_scope::FsScope;

/// A remembered folder.
#[derive(Debug, Clone, Serialize, PartialEq, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PickedRoot {
    pub path: String,
    pub label: String,
}

// ── Remembered folders (data.db) ──────────────────────────────────────────────

pub async fn ensure_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS picked_roots (
            path TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Remembers a folder (picking one that's already remembered changes nothing) and returns it.
async fn remember(pool: &SqlitePool, path: &str) -> Result<PickedRoot, sqlx::Error> {
    let label = label_for(path);
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    sqlx::query("INSERT OR IGNORE INTO picked_roots (path, label, created_at) VALUES (?1, ?2, ?3)")
        .bind(path)
        .bind(&label)
        .bind(created_at)
        .execute(pool)
        .await?;
    sqlx::query_as::<_, PickedRoot>("SELECT path, label FROM picked_roots WHERE path = ?1").bind(path).fetch_one(pool).await
}

async fn all(pool: &SqlitePool) -> Result<Vec<PickedRoot>, sqlx::Error> {
    sqlx::query_as::<_, PickedRoot>("SELECT path, label FROM picked_roots ORDER BY created_at, path").fetch_all(pool).await
}

/// The folder's own name (or the whole path, for a drive root).
fn label_for(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed.rsplit(['/', '\\']).next().filter(|s| !s.is_empty()).unwrap_or(trimmed).to_string()
}

/// Allows every remembered folder in `scope` again (called once at startup, before any window
/// exists). A folder that has disappeared is skipped, but stays remembered.
pub fn allow_saved(pool: &SqlitePool, scope: &FsScope) {
    for root in tauri::async_runtime::block_on(all(pool)).unwrap_or_default() {
        let _ = scope.allow_picked(Path::new(&root.path));
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Opens the folder picker. A picked folder is allowed in the file scope, remembered, and returned;
/// `None` if the person cancelled.
#[tauri::command]
pub async fn pick_folder(
    app: AppHandle,
    scope: tauri::State<'_, FsScope>,
    state: tauri::State<'_, AppDbState>,
) -> Result<Option<PickedRoot>, String> {
    let Some(path) = platform::pick(&app).await? else { return Ok(None) };
    scope.allow_picked(Path::new(&path))?;
    remember(&state.pool, &path).await.map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_picked_roots(state: tauri::State<'_, AppDbState>) -> Result<Vec<PickedRoot>, String> {
    all(&state.pool).await.map_err(|e| e.to_string())
}

/// Forgets a folder and takes it out of the file scope, effective at once. Nothing inside it is
/// touched. (Only picked folders can be revoked: the user folder never can.)
#[tauri::command]
pub async fn remove_picked_root(
    scope: tauri::State<'_, FsScope>,
    state: tauri::State<'_, AppDbState>,
    path: String,
) -> Result<(), String> {
    scope.revoke_picked(Path::new(&path));
    sqlx::query("DELETE FROM picked_roots WHERE path = ?1").bind(&path).execute(&state.pool).await.map_err(|e| e.to_string())?;
    Ok(())
}

// ── Platform ──────────────────────────────────────────────────────────────────

#[cfg(target_os = "android")]
mod platform {
    use std::time::{Duration, Instant};

    use jni::objects::{JString, JValue};
    use tauri::AppHandle;

    const HELPER_CLASS: &str = "com.ayran.csdrive_webhost_tauriapp.FolderPicker";

    /// Shows `FolderPicker.kt`'s dialog and waits for the person to choose. The dialog reports
    /// through a static string that is polled — "pending", then "picked:<path>", "cancelled" or
    /// "error:<message>" — which needs no native callback and lets the dialog take as long as it likes.
    pub async fn pick(_app: &AppHandle) -> Result<Option<String>, String> {
        crate::android_jni::on_activity(|env, activity| {
            let class = crate::android_jni::helper_class(env, activity, HELPER_CLASS)?;
            env.call_static_method(&class, "start", "(Landroid/app/Activity;)V", &[JValue::Object(activity)])?;
            Ok(())
        })?;

        let give_up = Instant::now() + Duration::from_secs(30 * 60);
        loop {
            tokio::time::sleep(Duration::from_millis(150)).await;
            let state = crate::android_jni::on_activity(|env, activity| {
                let class = crate::android_jni::helper_class(env, activity, HELPER_CLASS)?;
                let text = env.call_static_method(&class, "poll", "()Ljava/lang/String;", &[])?.l()?;
                Ok(String::from(env.get_string(&JString::from(text))?))
            })?;

            match state.as_str() {
                "pending" if Instant::now() < give_up => {}
                "pending" => return Err("The folder picker was left open too long.".to_string()),
                "cancelled" => return Ok(None),
                other => {
                    if let Some(path) = other.strip_prefix("picked:") {
                        return Ok(Some(path.to_string()));
                    }
                    return Err(other.strip_prefix("error:").unwrap_or(other).to_string());
                }
            }
        }
    }
}

#[cfg(desktop)]
mod platform {
    use tauri::AppHandle;
    use tauri_plugin_dialog::DialogExt;

    pub async fn pick(app: &AppHandle) -> Result<Option<String>, String> {
        let app = app.clone();
        let picked = tauri::async_runtime::spawn_blocking(move || {
            app.dialog().file().set_title("Choose a folder to browse").blocking_pick_folder()
        })
        .await
        .map_err(|e| e.to_string())?;
        picked.map(|p| p.into_path().map(|p| p.display().to_string()).map_err(|e| e.to_string())).transpose()
    }
}

#[cfg(target_os = "ios")]
mod platform {
    use tauri::AppHandle;

    pub async fn pick(_app: &AppHandle) -> Result<Option<String>, String> {
        Err("Picking folders isn't implemented on iOS yet.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_label_is_the_folders_own_name() {
        assert_eq!(label_for("/storage/emulated/0/Documents/Photos"), "Photos");
        assert_eq!(label_for("/storage/emulated/0/Documents/Photos/"), "Photos");
        assert_eq!(label_for("C:\\Users\\me\\Photos"), "Photos");
        assert_eq!(label_for("/"), "");
    }

    #[tokio::test]
    async fn folders_are_remembered_once_and_forgotten() {
        // One connection: every new connection to `:memory:` would be its own empty database.
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        ensure_schema(&pool).await.unwrap();

        let first = remember(&pool, "/storage/emulated/0/Photos").await.unwrap();
        assert_eq!(first, PickedRoot { path: "/storage/emulated/0/Photos".into(), label: "Photos".into() });
        assert_eq!(remember(&pool, "/storage/emulated/0/Photos").await.unwrap(), first, "no duplicate");
        remember(&pool, "/storage/emulated/0/Docs").await.unwrap();

        let listed = all(&pool).await.unwrap();
        assert_eq!(listed.iter().map(|r| r.label.as_str()).collect::<Vec<_>>(), ["Photos", "Docs"], "in the order they were added");

        sqlx::query("DELETE FROM picked_roots WHERE path = ?1").bind(&first.path).execute(&pool).await.unwrap();
        assert_eq!(all(&pool).await.unwrap().len(), 1);
    }

    #[test]
    fn remembered_folders_are_allowed_again_at_startup_and_missing_ones_are_skipped() {
        let base = std::env::temp_dir().join(format!("csdrive-picked-roots-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (here, gone) = (base.join("here"), base.join("gone"));
        std::fs::create_dir_all(&here).unwrap();

        // Everything on Tauri's own runtime, as in the app (which is also what `allow_saved` blocks on).
        let pool = tauri::async_runtime::block_on(async {
            let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
            ensure_schema(&pool).await.unwrap();
            remember(&pool, &here.to_string_lossy()).await.unwrap();
            remember(&pool, &gone.to_string_lossy()).await.unwrap();
            pool
        });

        let scope = FsScope::new();
        allow_saved(&pool, &scope);

        assert!(scope.is_allowed(&here.join("f.txt")));
        assert!(!scope.is_allowed(&gone.join("f.txt")));
        assert_eq!(tauri::async_runtime::block_on(all(&pool)).unwrap().len(), 2, "the missing folder stays remembered");
        let _ = std::fs::remove_dir_all(&base);
    }
}
