fn main() {
    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "keychain_set_secret",
            "keychain_get_secret",
            "keychain_delete_secret",
            "list_secondary_windows",
            "open_new_secondary_window",
            "add_secondary_window_entry",
            "reopen_secondary_window",
            "close_secondary_window",
            "suspend_secondary_window",
            "close_all_secondary_windows",
            "suspend_all_secondary_windows",
            "focus_secondary_window",
            "add_window_tag",
            "remove_window_tag",
            "get_data_folder_info",
            "pick_and_set_custom_data_folder",
            "reset_data_folder_to_default",
            "clear_custom_data_folder_contents",
            "delete_app_data",
        ]),
    );
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
