//! A page's own JavaScript dialogs (`alert`, `confirm`, `prompt`) under the rules every prompt follows (`prompt_guard.rs`).
//!
//! **Windows (WebView2)** is implemented in `page_dialogs_windows.rs`: the webview's own dialogs are turned off and answered from there.
//! **Android** does it in Kotlin (`WindowActivity`, through `prompt_guard::begin_dialog`/`end_dialog`). **macOS and Linux** webviews are not
//! covered: their own dialogs stay (this is what these two functions being empty means).

#[cfg(windows)]
#[path = "page_dialogs_windows.rs"]
pub(crate) mod windows_impl;

#[cfg(windows)]
pub use windows_impl::{install, is_prompt_window};

/// Turns off the webview's own script dialogs in `window` and answers them from the app (Windows only).
#[cfg(not(windows))]
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn install(_window: &tauri::WebviewWindow) {}

/// Whether a window (by label) is one that shows a page's dialog (Windows only).
#[cfg(not(windows))]
pub fn is_prompt_window(_label: &str) -> bool {
    false
}
