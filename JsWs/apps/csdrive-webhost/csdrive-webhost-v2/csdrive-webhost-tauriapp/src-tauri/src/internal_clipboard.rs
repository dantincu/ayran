//! The app's **own clipboard**: a *stack* of text entries, held here in memory and shared by every window of the
//! app — the admin-app, the system apps (Notes…) and the user's own web apps. It exists next to the operating
//! system's clipboard so that something can be carried between windows, and between the two, without either being
//! disturbed: what is copied to it never reaches other programs, and what is on the OS clipboard is left alone.
//!
//! Every window may read and write it — a web app included (that was decided on purpose: what one window copies,
//! another can paste, whatever kind of window it is). It isn't saved anywhere — it is gone when the app closes.
//!
//! **A stack, not one slot** (asked for directly, with the OS clipboard's own history in mind): copying ("Copy to
//! the app's clipboard", everywhere this app offers it) [`push`]es a new entry on top rather than replacing
//! whatever was there; pasting [`peek`]s the top one, non-destructively — so pasting twice pastes the same thing
//! twice, the way a plain clipboard always has — and [`pop`] is there for a caller that means to *consume* the top
//! entry rather than just read it. The full stack ([`list`]) and a bulk replace of it ([`set_all`]) back the
//! "manage the app's clipboard" popup (`ClipboardManagerModal.tsx`): adding at the top, inserting anywhere,
//! editing, removing some or all, and reordering are all, from here, just "here is the whole stack now" — the
//! ordering and editing logic lives entirely in the frontend, this module only ever stores whatever list it's
//! given.

use std::sync::Mutex;

use tauri::State;

use crate::window_host::CallerWindow;

/// More than this isn't kept, in total across every entry: a clipboard is for text a person copies, not for a
/// file's contents.
const MAX_TOTAL_BYTES: usize = 16 * 1024 * 1024;

/// At most this many entries — a person's own copies, not an unbounded log.
const MAX_ENTRIES: usize = 200;

#[derive(Default)]
pub struct InternalClipboard(Mutex<Vec<String>>);

fn total_len(entries: &[String]) -> usize {
    entries.iter().map(String::len).sum()
}

impl InternalClipboard {
    fn list(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }

    fn peek(&self) -> Option<String> {
        self.0.lock().unwrap().first().cloned()
    }

    pub(crate) fn push(&self, text: String) -> Result<(), String> {
        let mut entries = self.0.lock().unwrap();
        if entries.len() >= MAX_ENTRIES {
            return Err(format!("The app's clipboard already holds {MAX_ENTRIES} entries — remove one first."));
        }
        if total_len(&entries) + text.len() > MAX_TOTAL_BYTES {
            return Err(format!("That is too much text for the app's clipboard (the limit is {} MB in total).", MAX_TOTAL_BYTES / 1024 / 1024));
        }
        entries.insert(0, text);
        Ok(())
    }

    fn pop(&self) -> Option<String> {
        // One lock, held for both the check and the removal — a second nested `self.0.lock()` while the first
        // guard is still alive (even as a temporary within the same statement) would self-deadlock: this
        // `Mutex` isn't reentrant, and a thread blocking on a lock it already holds just hangs forever rather
        // than panicking. Found exactly that way, live, by this file's own test suite hanging indefinitely.
        let mut entries = self.0.lock().unwrap();
        if entries.is_empty() { None } else { Some(entries.remove(0)) }
    }

    pub(crate) fn set_all(&self, entries: Vec<String>) -> Result<(), String> {
        if entries.len() > MAX_ENTRIES {
            return Err(format!("The app's clipboard can hold at most {MAX_ENTRIES} entries."));
        }
        if total_len(&entries) > MAX_TOTAL_BYTES {
            return Err(format!("That is too much text for the app's clipboard (the limit is {} MB in total).", MAX_TOTAL_BYTES / 1024 / 1024));
        }
        *self.0.lock().unwrap() = entries;
        Ok(())
    }

    fn clear(&self) {
        self.0.lock().unwrap().clear();
    }
}

/// The whole stack, top (most recently pushed) first.
#[tauri::command]
pub fn internal_clipboard_list(_window: CallerWindow, clipboard: State<'_, InternalClipboard>) -> Result<Vec<String>, String> {
    Ok(clipboard.list())
}

/// The top entry, or `null` when the stack is empty — read-only, same as pasting from a plain clipboard: it
/// doesn't remove the entry, so pasting again pastes the same thing.
#[tauri::command]
pub fn internal_clipboard_peek(_window: CallerWindow, clipboard: State<'_, InternalClipboard>) -> Result<Option<String>, String> {
    Ok(clipboard.peek())
}

/// Adds a new entry on top of the stack — an ordinary "copy".
#[tauri::command]
pub fn internal_clipboard_push(_window: CallerWindow, clipboard: State<'_, InternalClipboard>, text: String) -> Result<(), String> {
    clipboard.push(text)
}

/// Removes and returns the top entry, or `null` when the stack is empty.
#[tauri::command]
pub fn internal_clipboard_pop(_window: CallerWindow, clipboard: State<'_, InternalClipboard>) -> Result<Option<String>, String> {
    Ok(clipboard.pop())
}

/// Replaces the whole stack — the "manage the app's clipboard" popup's one write command: adding, inserting,
/// editing, removing and reordering are all done in the frontend and saved back as the new, complete list.
#[tauri::command]
pub fn internal_clipboard_set_all(_window: CallerWindow, clipboard: State<'_, InternalClipboard>, entries: Vec<String>) -> Result<(), String> {
    clipboard.set_all(entries)
}

/// Empties the app's own clipboard entirely.
#[tauri::command]
pub fn internal_clipboard_clear(_window: CallerWindow, clipboard: State<'_, InternalClipboard>) -> Result<(), String> {
    clipboard.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pushing_adds_to_the_top_and_peek_reads_it_without_removing_it() {
        let clipboard = InternalClipboard::default();
        assert_eq!(clipboard.peek(), None, "empty at first");
        clipboard.push("first".to_string()).unwrap();
        clipboard.push("second".to_string()).unwrap();
        assert_eq!(clipboard.peek(), Some("second".to_string()));
        assert_eq!(clipboard.peek(), Some("second".to_string()), "peeking twice reads the same thing");
        assert_eq!(clipboard.list(), vec!["second".to_string(), "first".to_string()]);
    }

    #[test]
    fn popping_removes_and_returns_the_top_entry() {
        let clipboard = InternalClipboard::default();
        clipboard.push("a".to_string()).unwrap();
        clipboard.push("b".to_string()).unwrap();
        assert_eq!(clipboard.pop(), Some("b".to_string()));
        assert_eq!(clipboard.list(), vec!["a".to_string()]);
        assert_eq!(clipboard.pop(), Some("a".to_string()));
        assert_eq!(clipboard.pop(), None, "nothing left");
    }

    #[test]
    fn set_all_replaces_the_whole_stack_in_the_given_order() {
        let clipboard = InternalClipboard::default();
        clipboard.push("stale".to_string()).unwrap();
        clipboard.set_all(vec!["x".to_string(), "y".to_string(), "z".to_string()]).unwrap();
        assert_eq!(clipboard.list(), vec!["x".to_string(), "y".to_string(), "z".to_string()]);
    }

    #[test]
    fn too_many_entries_or_too_much_text_is_refused_and_nothing_already_there_changes() {
        let clipboard = InternalClipboard::default();
        clipboard.push("kept".to_string()).unwrap();
        assert!(clipboard.set_all(vec!["x".repeat(MAX_TOTAL_BYTES + 1)]).is_err());
        assert_eq!(clipboard.list(), vec!["kept".to_string()]);
        assert!(clipboard.set_all((0..MAX_ENTRIES + 1).map(|i| i.to_string()).collect()).is_err());
        assert_eq!(clipboard.list(), vec!["kept".to_string()]);
    }

    #[test]
    fn clear_empties_it() {
        let clipboard = InternalClipboard::default();
        clipboard.push("a".to_string()).unwrap();
        clipboard.push("b".to_string()).unwrap();
        clipboard.clear();
        assert_eq!(clipboard.list(), Vec::<String>::new());
    }
}
