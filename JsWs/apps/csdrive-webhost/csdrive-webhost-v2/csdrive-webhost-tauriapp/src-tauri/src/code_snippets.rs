//! Snippets of css/html/javascript that the backend hands to every web app, in the
//! `codeSnippets` part of the `init_window_tab` response, for the app to apply to
//! itself (`_tab-lib.js` in the sample apps does it automatically). It's the one
//! channel for "every web app needs this" — platform fixes, shared styling — so those
//! don't have to be copied into each app and kept in step by hand.
//!
//! The admin-app asks for the same list with `get_code_snippets` and applies it too,
//! so the two can never disagree.

use serde::Serialize;

// All three kinds are part of the contract with web apps, even though only css is used so far.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SnippetType {
    Css,
    Html,
    Javascript,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CodeSnippet {
    pub code: String,
    #[serde(rename = "type")]
    pub kind: SnippetType,
}

/// Keeps a page out from under the system bars on Android (status bar, gesture or
/// navigation bar, camera cutout) — the app draws edge to edge, so without this the
/// top of the page sits under the clock and the bottom under the gesture pill.
///
/// The `--csdrive-safe-area-inset-*` values are set on `<html>` by the app itself
/// (the Kotlin `MainActivity` measures the real insets and a small script injected
/// into every page publishes them), in CSS pixels. They are used instead of
/// `env(safe-area-inset-*)` because Android's WebView reports 0 for the bottom
/// inset there. When the system bars are hidden (full-screen mode) the values become
/// 0 and the page takes the whole screen; on desktop they're never set, so this is a
/// no-op there.
const SAFE_AREA_CSS: &str = "html {
  box-sizing: border-box;
  height: 100%;
  padding: var(--csdrive-safe-area-inset-top, 0px) var(--csdrive-safe-area-inset-right, 0px)
    var(--csdrive-safe-area-inset-bottom, 0px) var(--csdrive-safe-area-inset-left, 0px);
}
";

/// Everything web apps should apply, in order.
pub fn code_snippets() -> Vec<CodeSnippet> {
    vec![CodeSnippet { code: SAFE_AREA_CSS.to_string(), kind: SnippetType::Css }]
}

/// Injected into every page at document start (on mobile): publishes the insets the
/// Android activity measures as the CSS variables `SAFE_AREA_CSS` uses. The activity
/// exposes `CsdriveSafeArea.get()` ("top,right,bottom,left" in CSS px) and calls
/// `window.__csdriveApplySafeArea` whenever the insets change.
#[cfg_attr(desktop, allow(dead_code))] // only injected on mobile
pub const SAFE_AREA_INIT_SCRIPT: &str = r#"(function () {
  var sides = ['top', 'right', 'bottom', 'left'];
  function apply(top, right, bottom, left) {
    var root = document.documentElement;
    if (!root) return false;
    var values = [top, right, bottom, left];
    for (var i = 0; i < 4; i++) {
      root.style.setProperty('--csdrive-safe-area-inset-' + sides[i], values[i] + 'px');
    }
    return true;
  }
  window.__csdriveApplySafeArea = apply;
  function pull() {
    if (!window.CsdriveSafeArea) return;
    var v = String(window.CsdriveSafeArea.get()).split(',');
    if (!apply(v[0], v[1], v[2], v[3])) setTimeout(pull, 0);
  }
  pull();
})();"#;

/// Available to every window (the admin-app applies these itself, like web apps do).
#[tauri::command]
pub fn get_code_snippets() -> Vec<CodeSnippet> {
    code_snippets()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_snippet_serializes_as_code_plus_type() {
        let json = serde_json::to_value(code_snippets()).unwrap();
        let first = &json[0];
        assert_eq!(first["type"], "css");
        assert!(first["code"].as_str().unwrap().contains("--csdrive-safe-area-inset-bottom"));
        assert_eq!(first.as_object().unwrap().len(), 2, "only `code` and `type`");

        assert_eq!(serde_json::to_value(SnippetType::Html).unwrap(), "html");
        assert_eq!(serde_json::to_value(SnippetType::Javascript).unwrap(), "javascript");
    }

    #[test]
    fn the_safe_area_css_and_the_script_agree_on_the_variable_names() {
        for side in ["top", "right", "bottom", "left"] {
            assert!(SAFE_AREA_CSS.contains(&format!("--csdrive-safe-area-inset-{side}")));
        }
        assert!(SAFE_AREA_INIT_SCRIPT.contains("'--csdrive-safe-area-inset-'"));
        assert!(SAFE_AREA_INIT_SCRIPT.contains("['top', 'right', 'bottom', 'left']"));
    }
}
