//! Keeps a bare press of the Alt key from stealing keyboard focus to the window's own system menu.
//!
//! **Windows (WebView2)** is implemented in `window_accelerators_windows.rs`. **Android and every other platform** don't have
//! this problem (there's no title bar or system menu to steal focus to) — the function is empty there, as `page_dialogs.rs`'s
//! platform split does for the same reason.

#[cfg(windows)]
#[path = "window_accelerators_windows.rs"]
pub(crate) mod windows_impl;

#[cfg(windows)]
pub use windows_impl::install;

/// No-op outside Windows.
#[cfg(not(windows))]
pub fn install(_window: &tauri::WebviewWindow) {}
