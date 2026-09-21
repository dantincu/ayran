//! The app's **own clipboard**: one piece of text (a string), held here in memory and shared by every window of the app — the
//! admin-app, the system apps (Notes…) and the user's own web apps. It exists next to the
//! operating system's clipboard so that something can be carried between windows, and between the two, without either being
//! disturbed: what is copied to it never reaches other programs, and what is on the OS clipboard is left alone.
//!
//! Every window may read and write it — a web app included (that was decided on purpose: what one window copies, another
//! can paste, whatever kind of window it is). It isn't saved anywhere — it is gone when the app closes.

use std::sync::Mutex;

use tauri::State;

use crate::window_host::CallerWindow;

/// More than this isn't kept: a clipboard is for text a person copies, not for a file's contents.
const MAX_BYTES: usize = 16 * 1024 * 1024;

#[derive(Default)]
pub struct InternalClipboard(Mutex<String>);

impl InternalClipboard {
    fn get(&self) -> String {
        self.0.lock().unwrap().clone()
    }

    pub(crate) fn set(&self, text: String) -> Result<(), String> {
        if text.len() > MAX_BYTES {
            return Err(format!("That is too much text for the app's clipboard (the limit is {} MB).", MAX_BYTES / 1024 / 1024));
        }
        *self.0.lock().unwrap() = text;
        Ok(())
    }
}

/// The text on the app's own clipboard (empty when nothing was copied to it).
#[tauri::command]
pub fn internal_clipboard_get(_window: CallerWindow, clipboard: State<'_, InternalClipboard>) -> Result<String, String> {
    Ok(clipboard.get())
}

/// Empties the app's own clipboard.
#[tauri::command]
pub fn internal_clipboard_clear(_window: CallerWindow, clipboard: State<'_, InternalClipboard>) -> Result<(), String> {
    clipboard.set(String::new())
}

/// Replaces the text on the app's own clipboard.
#[tauri::command]
pub fn internal_clipboard_set(_window: CallerWindow, clipboard: State<'_, InternalClipboard>, text: String) -> Result<(), String> {
    clipboard.set(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_holds_one_text_and_the_last_copy_wins() {
        let clipboard = InternalClipboard::default();
        assert_eq!(clipboard.get(), "", "empty at first");
        clipboard.set("first".to_string()).unwrap();
        clipboard.set("ținută 日本語\nsecond line".to_string()).unwrap();
        assert_eq!(clipboard.get(), "ținută 日本語\nsecond line");
        clipboard.set(String::new()).unwrap();
        assert_eq!(clipboard.get(), "", "it can be emptied");
    }

    #[test]
    fn too_much_text_is_refused_and_what_was_there_stays() {
        let clipboard = InternalClipboard::default();
        clipboard.set("kept".to_string()).unwrap();
        assert!(clipboard.set("x".repeat(MAX_BYTES + 1)).is_err());
        assert_eq!(clipboard.get(), "kept");
        assert!(clipboard.set("x".repeat(MAX_BYTES)).is_ok(), "exactly the limit is fine");
    }
}
