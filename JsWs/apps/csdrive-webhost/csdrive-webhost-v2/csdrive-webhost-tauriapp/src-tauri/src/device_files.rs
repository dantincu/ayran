//! Handing a file to the device's own storage, outside the app's sandbox.
//!
//! On desktop the admin-app does this with a native "save as" dialog plus the fs
//! plugin. Android has neither: its save dialog returns a content URI, which the fs
//! plugin can't write to within our scope. So the admin-app sends the bytes here, and a
//! Kotlin helper (`DeviceFiles.kt`) stores them in the public Downloads folder through
//! MediaStore — which needs no storage permission.
//!
//! Admin-app only: leaving the app's sandbox is not something a web app gets to do.

use tauri::ipc::Request;

/// Saves the request's body as a file named by the percent-encoded `name` header into
/// the device's Downloads folder; resolves to where it ended up (for display).
#[tauri::command]
pub async fn save_to_device(window: tauri::WebviewWindow, request: Request<'_>) -> Result<String, String> {
    crate::window_host::require_admin(&window)?;

    let name = safe_file_name(&crate::ipc::field(&request, "name")?)?;
    platform::save(name, crate::ipc::body_bytes(&request)?)
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
    use jni::objects::{JString, JValue};

    const HELPER_CLASS: &str = "com.ayran.csdrive_webhost_tauriapp.DeviceFiles";

    pub fn save(name: String, data: Vec<u8>) -> Result<String, String> {
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
}

#[cfg(not(target_os = "android"))]
mod platform {
    pub fn save(_name: String, _data: Vec<u8>) -> Result<String, String> {
        Err("Saving to the Downloads folder is only available on Android; use a save dialog here.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::safe_file_name;

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
