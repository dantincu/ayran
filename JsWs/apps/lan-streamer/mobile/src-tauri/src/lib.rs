mod foreground_service;
mod session;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            session::save_session,
            session::load_session,
            session::clear_session,
            foreground_service::start_foreground_service,
            foreground_service::stop_foreground_service
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
