fn main() {
    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "keychain_set_secret",
            "keychain_get_secret",
            "keychain_delete_secret",
        ]),
    );
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
