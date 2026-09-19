//! Handing a file to the device's own storage, outside the folders the app may use — the
//! admin-app's "Export".
//!
//! The person decides where it goes, so this is the one place a file is written outside the app's
//! scope (`fs_scope.rs`), and only ever to what they chose:
//! - **Desktop:** a native "save as" dialog. `choose_save_location` shows it and remembers the
//!   chosen path under a one-time token; `save_to_device` then writes the bytes there. (Two steps so
//!   the admin-app only fetches a big file — say from Filen — once the person has picked a place.)
//! - **Android:** there is no dialog step: a Kotlin helper (`DeviceFiles.kt`) stores the file in the
//!   public Downloads folder through MediaStore, which needs no storage permission.
//!
//! Admin-app only: leaving the app's sandbox is not something a web app gets to do.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::ipc::Request;

/// Desktop: locations the person chose in the dialog, waiting for their bytes (token → path).
#[derive(Default)]
pub struct ExportState {
    chosen: Mutex<HashMap<String, PathBuf>>,
}

impl ExportState {
    /// Desktop: the location the person chose for this token, used up.
    fn take_chosen(&self, token: Option<&str>) -> Result<Option<PathBuf>, String> {
        let token = token.ok_or("Choose where to save it first.")?;
        Ok(Some(self.chosen.lock().unwrap().remove(token).ok_or("That save location has expired — choose it again.")?))
    }
}

/// Desktop: asks where to save `name`. Resolves to a one-time token for `save_to_device`, or `None`
/// if the person cancelled.
#[tauri::command]
pub async fn choose_save_location(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, ExportState>,
    name: String,
) -> Result<Option<String>, String> {
    crate::window_host::require_trusted(&window)?;
    let name = safe_file_name(&name)?;
    let Some(path) = platform::choose(&app, &name).await? else { return Ok(None) };

    let token = uuid::Uuid::new_v4().to_string();
    state.chosen.lock().unwrap().insert(token.clone(), path);
    Ok(Some(token))
}

/// Exports the file at source (a real file on disk, which the caller has judged it may hand over) as
/// name: on desktop to the location chosen with choose_save_location (token), on Android into the
/// Downloads folder. The file is copied, never held in memory. Resolves to the name it was saved as.
pub async fn export_file(state: &ExportState, name: String, token: Option<String>, source: PathBuf) -> Result<String, String> {
    let name = safe_file_name(&name)?;
    let target = if cfg!(desktop) { state.take_chosen(token.as_deref())? } else { None };
    // Off the async threads: it copies a file.
    tauri::async_runtime::spawn_blocking(move || platform::save_file(name, &source, target)).await.map_err(|e| e.to_string())?
}

/// Exports a file from a folder the app may use (root and path, as the file commands take them),
/// copying it to where the person chose. Never goes through the window.
#[tauri::command]
pub async fn export_local_file(
    window: tauri::WebviewWindow,
    scope: tauri::State<'_, crate::fs_scope::FsScope>,
    state: tauri::State<'_, ExportState>,
    root: String,
    path: String,
    name: String,
    token: Option<String>,
) -> Result<String, String> {
    crate::window_host::require_trusted(&window)?;
    let source = scope.check_in(&root, &path, true)?;
    if !source.is_file() {
        return Err("That isn't a file.".to_string());
    }
    export_file(state.inner(), name, token, source).await
}

/// Saves the request's body as a file named by `name`: on desktop to the location chosen with
/// `choose_save_location` (its `token`), on Android into the Downloads folder. Resolves to where it
/// ended up (for display).
#[tauri::command]
pub async fn save_to_device(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ExportState>,
    request: Request<'_>,
) -> Result<String, String> {
    crate::window_host::require_trusted(&window)?;

    let name = safe_file_name(&crate::ipc::field(&request, "name")?)?;
    let data = crate::ipc::body_bytes(&request)?;
    let target = if cfg!(desktop) {
        let token = crate::ipc::field(&request, "token")?;
        let path = state.chosen.lock().unwrap().remove(&token).ok_or("That save location has expired — choose it again.")?;
        Some(path)
    } else {
        None
    };
    platform::save(name, data, target)
}

/// The last path component of `name`, so a hostile name can't aim outside Downloads.
fn safe_file_name(name: &str) -> Result<String, String> {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("").trim();
    if last.is_empty() || last == "." || last == ".." {
        return Err("That isn't a usable file name.".to_string());
    }
    Ok(last.to_string())
}

#[cfg(target_os = "android")]
mod platform {
    use std::path::PathBuf;

    use jni::objects::{JString, JValue};

    const HELPER_CLASS: &str = "com.ayran.csdrive_webhost_tauriapp.DeviceFiles";

    pub async fn choose(_app: &tauri::AppHandle, _name: &str) -> Result<Option<PathBuf>, String> {
        Err("There is no save dialog on Android: exports go to the Downloads folder.".to_string())
    }

    pub fn save(name: String, data: Vec<u8>, _target: Option<PathBuf>) -> Result<String, String> {
        let reply = crate::android_jni::on_activity(move |env, activity| {
            let class = crate::android_jni::helper_class(env, activity, HELPER_CLASS)?;
            let name = env.new_string(&name)?;
            let data = env.byte_array_from_slice(&data)?;
            let result = env
                .call_static_method(
                    &class,
                    "saveToDownloads",
                    "(Landroid/content/Context;Ljava/lang/String;[B)Ljava/lang/String;",
                    &[JValue::Object(activity), JValue::Object(&name), JValue::Object(&data)],
                )?
                .l()?;
            Ok(String::from(env.get_string(&JString::from(result))?))
        })?;

        // The helper reports its own failures as "!<message>".
        match reply.strip_prefix('!') {
            Some(message) => Err(message.to_string()),
            None => Ok(reply),
        }
    }

    /// Copies the file at source into Downloads, as a stream.
    pub fn save_file(name: String, source: &std::path::Path, _target: Option<PathBuf>) -> Result<String, String> {
        let path = source.to_string_lossy().to_string();
        let reply = crate::android_jni::on_activity(move |env, activity| {
            let class = crate::android_jni::helper_class(env, activity, HELPER_CLASS)?;
            let name = env.new_string(&name)?;
            let path = env.new_string(&path)?;
            let result = env
                .call_static_method(
                    &class,
                    "saveFileToDownloads",
                    "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                    &[JValue::Object(activity), JValue::Object(&name), JValue::Object(&path)],
                )?
                .l()?;
            Ok(String::from(env.get_string(&JString::from(result))?))
        })?;
        match reply.strip_prefix('!') {
            Some(message) => Err(message.to_string()),
            None => Ok(reply),
        }
    }
}

#[cfg(desktop)]
mod platform {
    use std::path::PathBuf;

    use tauri_plugin_dialog::DialogExt;

    pub async fn choose(app: &tauri::AppHandle, name: &str) -> Result<Option<PathBuf>, String> {
        let (app, name) = (app.clone(), name.to_string());
        let chosen = tauri::async_runtime::spawn_blocking(move || {
            app.dialog().file().set_file_name(name).blocking_save_file()
        })
        .await
        .map_err(|e| e.to_string())?;
        chosen.map(|p| p.into_path().map_err(|e| e.to_string())).transpose()
    }

    pub fn save(name: String, data: Vec<u8>, target: Option<PathBuf>) -> Result<String, String> {
        let path = target.ok_or("No save location was chosen.")?;
        std::fs::write(&path, data).map_err(|e| e.to_string())?;
        // Only the file's name — where it went is the person's business, and a window doesn't see real paths.
        Ok(path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(name))
    }

    /// Copies the file at source to the chosen location.
    pub fn save_file(name: String, source: &std::path::Path, target: Option<PathBuf>) -> Result<String, String> {
        let path = target.ok_or("No save location was chosen.")?;
        std::fs::copy(source, &path).map_err(|e| e.to_string())?;
        Ok(path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(name))
    }
}

#[cfg(target_os = "ios")]
mod platform {
    use std::path::PathBuf;

    pub fn save_file(_name: String, _source: &std::path::Path, _target: Option<PathBuf>) -> Result<String, String> {
        Err("Exporting isn't implemented on iOS yet.".to_string())
    }

    pub async fn choose(_app: &tauri::AppHandle, _name: &str) -> Result<Option<PathBuf>, String> {
        Err("Exporting isn't implemented on iOS yet.".to_string())
    }

    pub fn save(_name: String, _data: Vec<u8>, _target: Option<PathBuf>) -> Result<String, String> {
        Err("Exporting isn't implemented on iOS yet.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{export_file, safe_file_name, ExportState};

    #[cfg(desktop)]
    #[test]
    fn a_file_is_exported_by_copying_it_to_the_chosen_location_once() {
        tauri::async_runtime::block_on(async {
            let base = std::env::temp_dir().join(format!("csdrive-export-test-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(&base).unwrap();
            let (source, chosen) = (base.join("cached.bin"), base.join("saved-as.bin"));
            std::fs::write(&source, b"exported bytes").unwrap();

            let state = ExportState::default();
            state.chosen.lock().unwrap().insert("token-1".into(), chosen.clone());

            assert!(export_file(&state, "x.bin".into(), None, source.clone()).await.is_err(), "no token: choose a location first");
            let saved = export_file(&state, "x.bin".into(), Some("token-1".into()), source.clone()).await.unwrap();
            assert_eq!(saved, "saved-as.bin", "what it says is the file's name, not where it went");
            assert_eq!(std::fs::read(&chosen).unwrap(), b"exported bytes");
            assert_eq!(std::fs::read(&source).unwrap(), b"exported bytes", "the cached copy is untouched");
            assert!(export_file(&state, "x.bin".into(), Some("token-1".into()), source).await.is_err(), "a token is used up");
            let _ = std::fs::remove_dir_all(&base);
        });
    }

    #[test]
    fn only_the_last_path_component_is_kept() {
        assert_eq!(safe_file_name("report.pdf").unwrap(), "report.pdf");
        assert_eq!(safe_file_name("../../etc/passwd").unwrap(), "passwd");
        assert_eq!(safe_file_name("a\\b\\c.txt").unwrap(), "c.txt");
        assert!(safe_file_name("").is_err());
        assert!(safe_file_name("dir/").is_err());
        assert!(safe_file_name("..").is_err());
    }
}
