//! Folders the user picks to browse and use, remembered across restarts.
//!
//! Picking is a native dialog either way — the OS's own on desktop, `FolderPicker.kt` on Android
//! (the system one there hands back `content://` URIs, which the file commands, SQLite and web apps
//! can't use, so the app ships its own that browses the real filesystem; it needs Android's "All
//! files access", asked for the first time). The chosen folder is added to the app's file scope
//! (`fs_scope.rs`) under a **root id** — a random string made here — which is all a window ever sees
//! of it (with the folder's own name as a label): the Files tab, SQLite databases in it and web apps
//! use it through the ordinary file commands by naming that id and a path relative to it. **The real
//! path never reaches a window.**
//!
//! What this module adds is memory: the scope is empty at every start, so the picked folders (their
//! real paths and ids) are kept in `data.db` and allowed again then (`allow_saved`). And forgetting
//! one really revokes it: `remove_picked_root` takes it out of the scope at once, and it can be
//! picked again afterwards (it keeps its id).
//!
//! Like any file access, picking is available to every window: it needs the person to choose in a
//! native dialog.

use std::path::Path;

use serde::Serialize;
use sqlx::SqlitePool;
use tauri::AppHandle;

use crate::app_state::AppDbState;
use crate::fs_scope::FsScope;

/// What a window is told about a picked folder: its root id and its own name. Never its path.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PickedRoot {
    pub id: String,
    pub label: String,
}

/// A remembered folder as this module keeps it: with the real path, which stays in the backend.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
struct Remembered {
    id: String,
    path: String,
    label: String,
}

impl From<Remembered> for PickedRoot {
    fn from(row: Remembered) -> Self {
        PickedRoot { id: row.id, label: row.label }
    }
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

    // Folders remembered before roots had ids get one now.
    let has_id: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info('picked_roots') WHERE name = 'id'").fetch_one(pool).await?;
    if has_id == 0 {
        sqlx::query("ALTER TABLE picked_roots ADD COLUMN id TEXT").execute(pool).await?;
    }
    let without_id: Vec<String> = sqlx::query_scalar("SELECT path FROM picked_roots WHERE id IS NULL").fetch_all(pool).await?;
    for path in without_id {
        sqlx::query("UPDATE picked_roots SET id = ?1 WHERE path = ?2").bind(new_id()).bind(path).execute(pool).await?;
    }
    sqlx::query("CREATE UNIQUE INDEX IF NOT EXISTS picked_roots_id ON picked_roots (id)").execute(pool).await?;

    migrate_path_based_ids(pool).await;
    Ok(())
}

/// A picked folder used to be named by its path (`ext:<path>`), which ended up inside other data: the
/// tags of the folder, and — for Notes — its tabs' resource ids and its remembered place. Those would
/// show a real path to whoever reads them, so they are moved to the folder's id (tags) or reset
/// (Notes' own places, which fall back to the user folder). Best effort, and harmless once done.
async fn migrate_path_based_ids(pool: &SqlitePool) {
    let rows: Vec<Remembered> = sqlx::query_as("SELECT id, path, label FROM picked_roots").fetch_all(pool).await.unwrap_or_default();
    for row in rows {
        let _ = sqlx::query("UPDATE window_tags SET guid = 'root:' || ?1 WHERE guid = 'root:ext:' || ?2")
            .bind(&row.id)
            .bind(&row.path)
            .execute(pool)
            .await;
    }
    let _ = sqlx::query("UPDATE tabs SET resource_id = relative_path WHERE relative_path = 'system:notes' AND instr(resource_id, 'local%3Aext%3A') > 0")
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM app_state WHERE app_id = 'system:notes' AND instr(value, 'local:ext:') > 0").execute(pool).await;
}

/// A short random id for a root: hex, so it can never be `user`.
fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

/// Remembers a folder (picking one that's already remembered changes nothing, and keeps its id) and
/// returns it.
async fn remember(pool: &SqlitePool, path: &str) -> Result<Remembered, sqlx::Error> {
    let label = label_for(path);
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    sqlx::query("INSERT OR IGNORE INTO picked_roots (path, label, created_at, id) VALUES (?1, ?2, ?3, ?4)")
        .bind(path)
        .bind(&label)
        .bind(created_at)
        .bind(new_id())
        .execute(pool)
        .await?;
    sqlx::query_as::<_, Remembered>("SELECT id, path, label FROM picked_roots WHERE path = ?1").bind(path).fetch_one(pool).await
}

async fn all(pool: &SqlitePool) -> Result<Vec<Remembered>, sqlx::Error> {
    sqlx::query_as::<_, Remembered>("SELECT id, path, label FROM picked_roots ORDER BY created_at, rowid").fetch_all(pool).await
}

/// The folder's own name (or the whole path, for a drive root).
fn label_for(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed.rsplit(['/', '\\']).next().filter(|s| !s.is_empty()).unwrap_or(trimmed).to_string()
}

/// Allows every remembered folder in `scope` again, under its id (called once at startup, before any
/// window exists). A folder that has disappeared is skipped, but stays remembered.
pub fn allow_saved(pool: &SqlitePool, scope: &FsScope) {
    for root in tauri::async_runtime::block_on(all(pool)).unwrap_or_default() {
        let _ = scope.allow_picked_as(&root.id, Path::new(&root.path));
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Opens the folder picker. A picked folder is allowed in the file scope, remembered, and returned
/// (its id and label — not its path); `None` if the person cancelled.
#[tauri::command]
pub async fn pick_folder(
    app: AppHandle,
    scope: tauri::State<'_, FsScope>,
    state: tauri::State<'_, AppDbState>,
) -> Result<Option<PickedRoot>, String> {
    let Some(path) = platform::pick(&app).await? else { return Ok(None) };
    let real = crate::fs_scope::resolve(Path::new(&path), true).map_err(|_| "The chosen folder isn't available.".to_string())?;
    if !real.is_dir() {
        return Err("The chosen item isn't a folder.".to_string());
    }
    let remembered = remember(&state.pool, &path).await.map_err(|e| e.to_string())?;
    scope.allow_picked_as(&remembered.id, Path::new(&path))?;
    Ok(Some(remembered.into()))
}

#[tauri::command]
pub async fn list_picked_roots(state: tauri::State<'_, AppDbState>) -> Result<Vec<PickedRoot>, String> {
    all(&state.pool).await.map(|rows| rows.into_iter().map(PickedRoot::from).collect()).map_err(|e| e.to_string())
}

/// Forgets a folder (by its root id) and takes it out of the file scope, effective at once. Nothing
/// inside it is touched. (Only picked folders can be revoked: the user folder never can.)
#[tauri::command]
pub async fn remove_picked_root(
    scope: tauri::State<'_, FsScope>,
    state: tauri::State<'_, AppDbState>,
    id: String,
) -> Result<(), String> {
    scope.revoke_picked_id(&id);
    sqlx::query("DELETE FROM picked_roots WHERE id = ?1").bind(&id).execute(&state.pool).await.map_err(|e| e.to_string())?;
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

    #[test]
    fn ids_are_random_hex_and_never_the_user_root() {
        let (a, b) = (new_id(), new_id());
        assert_ne!(a, b);
        assert!(a.len() == 12 && a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, "user");
    }

    #[tokio::test]
    async fn folders_are_remembered_once_with_a_stable_id_and_forgotten() {
        // One connection: every new connection to `:memory:` would be its own empty database.
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        ensure_schema(&pool).await.unwrap();

        let first = remember(&pool, "/storage/emulated/0/Photos").await.unwrap();
        assert_eq!((first.path.as_str(), first.label.as_str()), ("/storage/emulated/0/Photos", "Photos"));
        assert_eq!(remember(&pool, "/storage/emulated/0/Photos").await.unwrap(), first, "no duplicate, and the same id");
        remember(&pool, "/storage/emulated/0/Docs").await.unwrap();

        let listed = all(&pool).await.unwrap();
        assert_eq!(listed.iter().map(|r| r.label.as_str()).collect::<Vec<_>>(), ["Photos", "Docs"], "in the order they were added");

        // What a window is told has no path in it.
        let told = serde_json::to_string(&PickedRoot::from(first.clone())).unwrap();
        assert!(!told.contains("storage") && !told.contains("path"), "{told}");

        sqlx::query("DELETE FROM picked_roots WHERE id = ?1").bind(&first.id).execute(&pool).await.unwrap();
        assert_eq!(all(&pool).await.unwrap().len(), 1);
    }

    #[test]
    fn remembered_folders_are_allowed_again_at_startup_under_their_ids_and_missing_ones_are_skipped() {
        let base = std::env::temp_dir().join(format!("csdrive-picked-roots-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (here, gone) = (base.join("here"), base.join("gone"));
        std::fs::create_dir_all(&here).unwrap();

        // Everything on Tauri's own runtime, as in the app (which is also what `allow_saved` blocks on).
        let (pool, here_id) = tauri::async_runtime::block_on(async {
            let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
            ensure_schema(&pool).await.unwrap();
            let here_id = remember(&pool, &here.to_string_lossy()).await.unwrap().id;
            remember(&pool, &gone.to_string_lossy()).await.unwrap();
            (pool, here_id)
        });

        let scope = FsScope::new();
        allow_saved(&pool, &scope);

        assert!(scope.check_in(&here_id, "f.txt", true).is_ok());
        assert!(scope.is_allowed(&here.join("f.txt")));
        assert!(!scope.is_allowed(&gone.join("f.txt")));
        assert_eq!(tauri::async_runtime::block_on(all(&pool)).unwrap().len(), 2, "the missing folder stays remembered");

        assert!(scope.revoke_picked_id(&here_id));
        assert!(scope.check_in(&here_id, "f.txt", true).is_err(), "forgetting is by id and immediate");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn data_that_named_a_folder_by_its_path_is_moved_to_its_id() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        // How an older version left things: a table without ids, tags keyed by the path, Notes state naming it.
        sqlx::query("CREATE TABLE picked_roots (path TEXT PRIMARY KEY, label TEXT NOT NULL, created_at INTEGER NOT NULL)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO picked_roots VALUES ('C:\\Users\\me\\Photos', 'Photos', 1)").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE window_tags (id INTEGER PRIMARY KEY, guid TEXT NOT NULL)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO window_tags (guid) VALUES ('root:ext:C:\\Users\\me\\Photos'), ('root:user')").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE tabs (guid TEXT, relative_path TEXT, resource_id TEXT)").execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO tabs VALUES ('t1', 'system:notes', 'system:notes?s=local%3Aext%3AC%3A%5CUsers%5Cme%5CPhotos&p='),
                                     ('t2', 'system:notes', 'system:notes?s=local%3Auser&p=sub')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("CREATE TABLE app_state (app_id TEXT, key TEXT, value TEXT)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO app_state VALUES ('system:notes', 'notes.lastLocation', '{\"sourceId\":\"local:ext:C:\\\\Users\\\\me\\\\Photos\"}'), ('system:notes', 'other', '1')")
            .execute(&pool)
            .await
            .unwrap();

        ensure_schema(&pool).await.unwrap();

        let id: String = sqlx::query_scalar("SELECT id FROM picked_roots").fetch_one(&pool).await.unwrap();
        assert!(!id.is_empty());
        let guids: Vec<String> = sqlx::query_scalar("SELECT guid FROM window_tags ORDER BY id").fetch_all(&pool).await.unwrap();
        assert_eq!(guids, [format!("root:{id}"), "root:user".to_string()], "the folder's tags follow it to its id");
        let resources: Vec<String> = sqlx::query_scalar("SELECT resource_id FROM tabs ORDER BY guid").fetch_all(&pool).await.unwrap();
        assert_eq!(resources, ["system:notes", "system:notes?s=local%3Auser&p=sub"], "only the tab that named the path is reset");
        let state: Vec<String> = sqlx::query_scalar("SELECT key FROM app_state").fetch_all(&pool).await.unwrap();
        assert_eq!(state, ["other"], "Notes' remembered place, which held the path, is gone");

        ensure_schema(&pool).await.unwrap(); // and running it again changes nothing
        assert_eq!(sqlx::query_scalar::<_, String>("SELECT id FROM picked_roots").fetch_one(&pool).await.unwrap(), id);
    }
}
