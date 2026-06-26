package io.crates.keyring

import android.content.Context

// Package/class name and the `external fun` signature are fixed by
// android-native-keyring-store's JNI export
// (Java_io_crates_keyring_Keyring_00024Companion_initializeNdkContext, compiled
// into our own liblan_streamer_mobile_lib.so since that crate is a Rust
// dependency, not a separate native library) - this just calls into it.
// Tauri's MainActivity already loads liblan_streamer_mobile_lib.so before
// onCreate runs, so no separate System.loadLibrary call is needed here.
class Keyring {
    companion object {
        external fun initializeNdkContext(context: Context)
    }
}
