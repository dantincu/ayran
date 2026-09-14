fn main() {
    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "keychain_set_secret",
            "keychain_get_secret",
            "keychain_delete_secret",
            "list_secondary_windows",
            "open_new_secondary_window",
            "reopen_secondary_window",
            "close_secondary_window",
            "suspend_secondary_window",
            "close_all_secondary_windows",
            "suspend_all_secondary_windows",
            "focus_secondary_window",
            "add_window_tag",
            "remove_window_tag",
        ]),
    );
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
