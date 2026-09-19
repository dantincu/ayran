fn main() {
    // main.rs embeds this file directly (`include_str!`) as the default
    // `admin/index.html` — give a clear error instead of a cryptic include_str!
    // failure if it's missing, since it lives in a sibling package this crate
    // doesn't otherwise build.
    let admin_app_index = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../csdrive-webhost-admin-reactapp/dist/index.html");
    if !admin_app_index.exists() {
        panic!(
            "\n\nMissing {}\n\nBuild the admin-app first:\n  cd csdrive-webhost-admin-reactapp && npm run build\n\n",
            admin_app_index.display()
        );
    }
    println!("cargo:rerun-if-changed={}", admin_app_index.display());

    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "list_secondary_windows",
            "open_new_secondary_window",
            "add_secondary_window_entry",
            "reopen_secondary_window",
            "close_secondary_window",
            "suspend_secondary_window",
            "close_all_secondary_windows",
            "suspend_all_secondary_windows",
            "focus_secondary_window",
            "list_tags",
            "add_window_tag",
            "update_window_tag",
            "reorder_window_tags",
            "remove_window_tag",
            "init_window_tab",
            "update_tab_resource",
            "submit_resource_icons",
            "create_tab_group",
            "rename_tab_group",
            "add_blank_tab",
            "clone_tab",
            "activate_tab",
            "move_tab_to_group",
            "get_app_state",
            "set_app_state",
            "get_data_folder_info",
            "pick_and_set_custom_data_folder",
            "reset_data_folder_to_default",
            "clear_custom_data_folder_contents",
            "delete_app_data",
            "sqlite_load",
            "sqlite_close",
            "sqlite_execute",
            "sqlite_select",
            "filen_list_accounts",
            "filen_login",
            "filen_logout",
            "filen_readdir",
            "filen_stat",
            "filen_read_file",
            "filen_write_file",
            "filen_mkdir",
            "filen_rm",
            "filen_rename",
            "list_deployable_apps",
            "get_deployable_app_html",
        ]),
    );
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
