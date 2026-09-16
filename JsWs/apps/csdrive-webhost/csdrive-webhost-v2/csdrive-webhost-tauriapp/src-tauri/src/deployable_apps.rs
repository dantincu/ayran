//! Small standalone apps that can be *deployed* — copied as a new folder of
//! content into a folder the admin-app's Files tab can browse — via the "Deploy
//! apps" action there. Each one's source lives under `csdrive-webhost-userapps/`
//! (a sibling of this crate and of `csdrive-webhost-admin-reactapp`), and its
//! `index.html` is embedded into this binary at compile time (same as the
//! admin-app's own bundle — see `ADMIN_APP_INDEX_HTML` in `main.rs`), so
//! deploying one never needs network access or an external file.
//!
//! Adding a new deployable app: create its source folder under
//! `csdrive-webhost-userapps/`, add an `include_str!` for it below, and add one
//! entry to `registry()`.

use serde::Serialize;

const NOTES_APP_INDEX_HTML: &str = include_str!("../../../csdrive-webhost-userapps/notes/index.html");
const FILES_APP_INDEX_HTML: &str = include_str!("../../../csdrive-webhost-userapps/files/index.html");

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployableAppInfo {
    pub id: String,
    pub name: String,
    /// The folder name this app's own source sits under in
    /// `csdrive-webhost-userapps/` — offered as the default target folder name
    /// when deploying.
    pub default_folder_name: String,
}

fn registry() -> [(&'static str, &'static str, &'static str, &'static str); 2] {
    // (id, display name, default folder name, embedded index.html)
    [
        ("notes", "Notes", "notes", NOTES_APP_INDEX_HTML),
        ("files", "Files", "files", FILES_APP_INDEX_HTML),
    ]
}

#[tauri::command]
pub fn list_deployable_apps() -> Vec<DeployableAppInfo> {
    registry()
        .into_iter()
        .map(|(id, name, default_folder_name, _)| DeployableAppInfo {
            id: id.to_string(),
            name: name.to_string(),
            default_folder_name: default_folder_name.to_string(),
        })
        .collect()
}

/// The embedded `index.html` content for a deployable app, so the frontend can
/// write it out via the same generic file APIs it already uses for the folder
/// it's deploying into (whichever root/path that is — this command doesn't need
/// to know).
#[tauri::command]
pub fn get_deployable_app_html(app_id: String) -> Result<String, String> {
    registry()
        .into_iter()
        .find(|(id, ..)| *id == app_id)
        .map(|(_, _, _, html)| html.to_string())
        .ok_or_else(|| format!("Unknown deployable app \"{app_id}\"."))
}
