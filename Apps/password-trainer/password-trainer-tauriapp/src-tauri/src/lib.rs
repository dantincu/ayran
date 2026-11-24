mod store;

use std::sync::Mutex;

use store::{EntryView, Store};
use tauri::{Manager, State};

/// The store, or why it couldn't be opened (a damaged file is reported, never overwritten).
struct AppState(Mutex<Result<Store, String>>);

fn with_store<T>(state: &State<AppState>, f: impl FnOnce(&mut Store) -> Result<T, String>) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(|_| "The app's state is unusable; please restart it.".to_string())?;
    match guard.as_mut() {
        Ok(store) => f(store),
        Err(e) => Err(e.clone()),
    }
}

/// Runs Argon2 off the main thread, so the UI stays responsive while it works.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn list_passwords(state: State<AppState>) -> Result<Vec<EntryView>, String> {
    with_store(&state, |s| Ok(s.list()))
}

#[tauri::command]
async fn add_password(state: State<'_, AppState>, label: String, password: String) -> Result<Vec<EntryView>, String> {
    let hash = blocking(move || store::hash_password(&password)).await?;
    with_store(&state, |s| s.add(&label, hash))
}

/// `password` is `None` to keep the current one.
#[tauri::command]
async fn update_password(
    state: State<'_, AppState>,
    id: String,
    label: String,
    password: Option<String>,
) -> Result<Vec<EntryView>, String> {
    let hash = match password {
        Some(p) => Some(blocking(move || store::hash_password(&p)).await?),
        None => None,
    };
    with_store(&state, |s| s.update(&id, &label, hash))
}

#[tauri::command]
fn delete_passwords(state: State<AppState>, ids: Vec<String>) -> Result<Vec<EntryView>, String> {
    with_store(&state, |s| s.delete(&ids))
}

#[tauri::command]
fn reorder_passwords(state: State<AppState>, ids: Vec<String>) -> Result<Vec<EntryView>, String> {
    with_store(&state, |s| s.reorder(&ids))
}

#[tauri::command]
async fn check_password(state: State<'_, AppState>, id: String, attempt: String) -> Result<bool, String> {
    let hash = with_store(&state, |s| s.hash_of(&id))?;
    blocking(move || store::verify_hash(&hash, &attempt)).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let opened = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("Couldn't find the app data folder: {e}"))
                .and_then(|dir| Store::open(&dir));
            app.manage(AppState(Mutex::new(opened)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_passwords,
            add_password,
            update_password,
            delete_passwords,
            reorder_passwords,
            check_password
        ])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
