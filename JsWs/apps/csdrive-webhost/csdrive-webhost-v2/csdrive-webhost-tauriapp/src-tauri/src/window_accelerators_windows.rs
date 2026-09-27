//! A bare Alt press is a Win32 "system key": if nothing consumes it, the window's own default handling
//! (`DefWindowProc`) treats it as the classic "toggle menu mode" — keyboard focus jumps to the window's
//! system-menu icon (top-left corner, invisible on a window with no title-bar menu of its own), and the
//! arrow keys, which the person meant for the page, open that menu instead (reported live: "after I press
//! the ALT key the focus remains on the top left corner of the window and then pressing up or down arrows
//! opens the accessibility menu, but I want the focus to stay where it was"). WebView2 exposes exactly the
//! hook meant for this — `AcceleratorKeyPressed`, fired for every key WebView2 would otherwise hand up to
//! the browser's own accelerator handling *before* the outer window ever sees it — so marking the Alt key
//! `Handled` here stops it from reaching that default behavior at all. None of this app's own shortcuts use
//! a bare Alt (they're all Ctrl-based — see CLAUDE.md's "Keyboard"), so there's no real mnemonic to lose;
//! Alt+Tab and Alt+F4 are unaffected (the shell, and `DefWindowProc`'s own `WM_SYSCOMMAND`, see those
//! independently of this event, which only concerns the *bare* key finishing a menu-activation sequence).

use tauri::WebviewWindow;
use webview2_com::AcceleratorKeyPressedEventHandler;

/// `VK_MENU` — the Alt key's virtual-key code, either side (`VK_LMENU`/`VK_RMENU` are reported as this).
const VK_MENU: u32 = 0x12;

/// Installs the hook on `window`'s webview. Called for every window — the main one and every secondary
/// window (an app's, an external web site's, a prompt's) — since any of them can otherwise lose focus to
/// its own system menu the same way.
pub fn install(window: &WebviewWindow) {
    let _ = window.with_webview(move |webview| {
        // SAFETY: called on the thread of the webview, with its own COM objects — the same pattern `page_dialogs_windows.rs` uses.
        unsafe {
            let controller = webview.controller();
            let handler = AcceleratorKeyPressedEventHandler::create(Box::new(|_sender, args| {
                let Some(args) = args else { return Ok(()) };
                let mut virtual_key = 0u32;
                args.VirtualKey(&mut virtual_key)?;
                if virtual_key == VK_MENU {
                    args.SetHandled(true)?;
                }
                Ok(())
            }));
            let mut token = 0;
            let _ = controller.add_AcceleratorKeyPressed(&handler, &mut token);
        }
    });
}
