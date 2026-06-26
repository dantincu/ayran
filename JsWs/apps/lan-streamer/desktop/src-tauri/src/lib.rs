mod loopback;
mod session;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(loopback::LoopbackState::default())
        .invoke_handler(tauri::generate_handler![
            session::save_session,
            session::load_session,
            session::clear_session,
            loopback::start_loopback_capture,
            loopback::stop_loopback_capture,
            loopback::set_loopback_gain
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
