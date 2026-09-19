//! System apps: the apps that ship inside this app, as separate modules of its own frontend (Notes
//! is the first). They are the counterpart of the user apps — html files the person keeps in the
//! `user` folder — and are managed the same way: each is opened in its own windows, its windows have
//! tab groups and tabs and tags, and the admin-app lists them in its System Apps tab, kept apart
//! from the user apps' windows (`secondary_windows.kind`).
//!
//! Differences: a system app isn't a file in the data folder but a page of the compiled-in frontend
//! (`entry`, under `system/` — see `vite.config.ts`, which builds each as its own html entry); the set
//! is fixed, so there's no way to add one; and it is recognised by its page's path, not the admin-app's
//! (see `window_host::is_system_url`). It gets exactly what a user app gets — no admin privileges.

use serde::Serialize;
use tauri::Url;

pub struct SystemApp {
    /// A short, stable id (`notes`).
    pub id: &'static str,
    pub name: &'static str,
    /// The page's path in the frontend build, e.g. `system/notes/index.html`.
    pub entry: &'static str,
}

pub const APPS: &[SystemApp] = &[SystemApp { id: "notes", name: "Notes", entry: "system/notes/index.html" }];

/// System windows and tabs store `system:<id>` where user ones store an html file's relative path,
/// so the two can never be mistaken for each other in the keys shared by both (app versions, icons,
/// saved app state).
const RELATIVE_PATH_PREFIX: &str = "system:";

pub fn find(id: &str) -> Option<&'static SystemApp> {
    APPS.iter().find(|app| app.id == id)
}

pub fn relative_path_of(id: &str) -> String {
    format!("{RELATIVE_PATH_PREFIX}{id}")
}

/// The app a stored `system:<id>` relative path names.
pub fn app_of_relative_path(relative_path: &str) -> Option<&'static SystemApp> {
    find(relative_path.strip_prefix(RELATIVE_PATH_PREFIX)?)
}

/// The app whose page is at `path` (with or without the leading slash), if any.
pub fn app_of_entry_path(path: &str) -> Option<&'static SystemApp> {
    let path = path.trim_start_matches('/');
    APPS.iter().find(|app| app.entry == path)
}

/// Where the app's page is served — in the form `window_host::navigation_url` expects.
pub fn page_url(app: &SystemApp) -> Result<Url, String> {
    Url::parse(&format!("tauri://localhost/{}", app.entry)).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAppInfo {
    pub id: &'static str,
    pub name: &'static str,
    /// What its windows store as their relative path (`system:notes`).
    pub relative_path: String,
}

#[tauri::command]
pub fn list_system_apps() -> Vec<SystemAppInfo> {
    APPS.iter().map(|app| SystemAppInfo { id: app.id, name: app.name, relative_path: relative_path_of(app.id) }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apps_are_found_by_id_stored_path_and_page() {
        let notes = find("notes").unwrap();
        assert_eq!(notes.name, "Notes");
        assert!(find("nope").is_none());
        assert_eq!(relative_path_of("notes"), "system:notes");
        assert_eq!(app_of_relative_path("system:notes").unwrap().id, "notes");
        assert!(app_of_relative_path("system:nope").is_none());
        assert!(app_of_relative_path("notes/index.html").is_none(), "a user app's path isn't a system app");
        assert_eq!(app_of_entry_path("/system/notes/index.html").unwrap().id, "notes");
        assert_eq!(app_of_entry_path("system/notes/index.html").unwrap().id, "notes");
        assert!(app_of_entry_path("/index.html").is_none());
        assert_eq!(page_url(notes).unwrap().as_str(), "tauri://localhost/system/notes/index.html");
    }

    #[test]
    fn every_entry_lives_under_system_and_ids_are_unique() {
        for app in APPS {
            assert!(app.entry.starts_with("system/") && app.entry.ends_with(".html"), "{}", app.entry);
            assert_eq!(APPS.iter().filter(|other| other.id == app.id).count(), 1);
        }
    }
}
