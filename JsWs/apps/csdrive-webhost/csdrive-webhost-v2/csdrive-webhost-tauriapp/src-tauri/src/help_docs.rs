//! Reference documents shown in the admin-app's Help tab, rendered from the same markdown source that documents
//! them for a person reading the repo (`markdown::render_fragment`) — one file for both, so the Help tab's copy
//! can never drift from `docs/keyboard-shortcuts.md`'s. Embedded at compile time (`include_str!`), like
//! `deployable_apps.rs`'s sample app: no separate file ships, and no network access is needed to show it.

const KEYBOARD_SHORTCUTS_MD: &str = include_str!("../../../docs/keyboard-shortcuts.md");
const CODEC_HELP_MD: &str = include_str!("../../../docs/installing-audio-video-codecs.md");

/// The document's own leading `# Title` line dropped: the Help tab already gives this section its own heading
/// (the same "Keyboard shortcuts" toolbar row every other section has), so keeping the file's own `<h1>` too
/// would just repeat it.
fn without_leading_heading(source: &str) -> &str {
    source.strip_prefix("# ").and_then(|rest| rest.split_once('\n')).map_or(source, |(_, rest)| rest)
}

/// The keyboard shortcuts document, as an HTML fragment ready to drop into the page — admin-app only, like every
/// other Help-tab fetch (`deployable_apps::get_deployable_app_html`): nothing here is sensitive, but nothing but
/// the admin-app has a Help tab to show it in either.
#[tauri::command]
pub fn get_keyboard_shortcuts_html(window: crate::window_host::CallerWindow) -> Result<String, String> {
    crate::window_host::require_admin(&window, "get_keyboard_shortcuts_html")?;
    Ok(crate::markdown::render_fragment(without_leading_heading(KEYBOARD_SHORTCUTS_MD)))
}

/// The audio/video codec installation document — the other half of the "play any video, including .mkv"
/// ask (`video_transcode.rs` is the first half): same pattern as `get_keyboard_shortcuts_html` exactly, one
/// markdown file serving both a person reading the repo and this in-app reference.
#[tauri::command]
pub fn get_codec_help_html(window: crate::window_host::CallerWindow) -> Result<String, String> {
    crate::window_host::require_admin(&window, "get_codec_help_html")?;
    Ok(crate::markdown::render_fragment(without_leading_heading(CODEC_HELP_MD)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_leading_heading_is_dropped_but_nothing_else() {
        assert_eq!(without_leading_heading("# Title\n\nBody text.\n"), "\nBody text.\n");
        assert_eq!(without_leading_heading("No heading here.\n"), "No heading here.\n", "unchanged when there's no leading `# `");
    }

    #[test]
    fn the_real_document_starts_with_a_heading_and_survives_rendering() {
        assert!(KEYBOARD_SHORTCUTS_MD.starts_with("# "), "this test (and without_leading_heading's whole reason to exist) assumes the doc starts with a heading");
        let html = crate::markdown::render_fragment(without_leading_heading(KEYBOARD_SHORTCUTS_MD));
        assert!(!html.contains("<h1>"), "the leading heading should be gone: {}", &html[..html.len().min(200)]);
        assert!(html.contains("Ctrl+K"), "the real shortcuts should still be there");
    }

    #[test]
    fn the_codec_help_document_starts_with_a_heading_and_survives_rendering() {
        assert!(CODEC_HELP_MD.starts_with("# "), "this test assumes the doc starts with a heading");
        let html = crate::markdown::render_fragment(without_leading_heading(CODEC_HELP_MD));
        assert!(!html.contains("<h1>"), "the leading heading should be gone: {}", &html[..html.len().min(200)]);
        assert!(html.contains("Media Feature Pack"), "the real Windows guidance should still be there");
        assert!(html.contains("Android"), "the real Android guidance should still be there");
    }
}
