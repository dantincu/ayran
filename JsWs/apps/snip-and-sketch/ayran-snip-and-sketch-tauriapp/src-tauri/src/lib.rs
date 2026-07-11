#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::Manager;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn capture_screenshot(app: tauri::AppHandle) -> Result<String, String> {
    use base64::Engine;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    window.hide().map_err(|e| e.to_string())?;
    // Give the OS time to actually repaint the window behind us before we capture.
    std::thread::sleep(std::time::Duration::from_millis(400));

    let capture_result = (|| -> Result<String, String> {
        let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
        let monitor = monitors
            .into_iter()
            .find(|m| m.is_primary())
            .or_else(|| xcap::Monitor::all().ok().and_then(|mut m| m.pop()))
            .ok_or_else(|| "no monitor found".to_string())?;

        let image = monitor.capture_image().map_err(|e| e.to_string())?;
        let mut bytes: Vec<u8> = Vec::new();
        image
            .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;

        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })();

    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;

    capture_result
}

#[cfg(target_os = "ios")]
#[tauri::command]
fn capture_screenshot(_app: tauri::AppHandle) -> Result<String, String> {
    Err("Screenshot capture is not yet supported on iOS.".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_screen_capture::init());

    #[cfg(not(target_os = "android"))]
    let builder = builder.invoke_handler(tauri::generate_handler![capture_screenshot]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
