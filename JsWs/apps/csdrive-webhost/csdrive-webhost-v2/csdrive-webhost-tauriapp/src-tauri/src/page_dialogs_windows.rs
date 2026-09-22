//! A page's own JavaScript dialogs — `alert`, `confirm`, `prompt` (and the "leave this page?" of `beforeunload`) — on **desktop
//! (Windows, WebView2)**, under the rules every prompt of the app follows (`prompt_guard.rs`, `docs/app-security.md`).
//!
//! WebView2 shows these itself, at once and on top of each other — a page in a loop of `alert()`s could keep the person from using
//! their computer. So every secondary window (the apps' and the external web sites') has its webview's own dialogs **turned off** and
//! this module answers the `ScriptDialogOpening` event instead: the dialog waits its turn in the app's queue, is counted (the box that
//! offers to stop prompts comes before the fifth in a row), never shows once the person has prevented prompts, and is shown in **a
//! window of our own** (`system/prompt/index.html`) that says who is talking — never anything the page wrote as the title — and has the
//! option *Prevent this app from showing prompts*. That window also gives `prompt()` its text box, which no native message box has.
//!
//! - `alert`: the message and *OK*. `confirm`: *OK* / *Cancel*. `prompt`: the message, a text box (with the page's default) and *OK* /
//!   *Cancel*. Dismissed, refused or prevented: what the page gets for a cancelled dialog (`undefined`, `false`, `null`).
//! - `beforeunload` is accepted without asking: a page that wants to keep a window from closing is not something to show a box for.
//! - macOS and Linux webviews are not covered (their own dialogs stay); the app is built and tested for Windows and Android.


use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_SCRIPT_DIALOG_KIND, COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT, COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD, COREWEBVIEW2_SCRIPT_DIALOG_KIND_CONFIRM,
    COREWEBVIEW2_SCRIPT_DIALOG_KIND_PROMPT,
};
use webview2_com::{take_pwstr, ScriptDialogOpeningEventHandler};
use windows::core::{HSTRING, PWSTR};

/// The page of the window that shows a page's dialog (a page of our own frontend, built by Vite: `system/prompt/index.html`).
const PROMPT_PAGE: &str = "system/prompt/index.html";

/// The longest message a page may put in the window.
const MAX_MESSAGE_CHARS: usize = 1500;

/// What the prompt window shows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogRequest {
    /// `alert`, `confirm` or `prompt`.
    pub kind: &'static str,
    pub message: String,
    pub default_text: String,
    /// Who is talking, by what the app knows.
    pub who: String,
}

/// What the person answered.
#[derive(Debug, PartialEq)]
enum Answer {
    /// *OK* — with the text, for a `prompt`.
    Ok(Option<String>),
    Cancel,
    /// *Prevent this app from showing prompts*.
    Prevent,
}

struct Pending {
    request: DialogRequest,
    sender: Option<tokio::sync::oneshot::Sender<Answer>>,
}

/// The dialogs being shown, by the label of the window that shows them.
static PENDING: LazyLock<Mutex<HashMap<String, Pending>>> = LazyLock::new(Default::default);

/// Whether a window (by label) is one of these: not one of the apps' windows, and not counted among them.
pub fn is_prompt_window(label: &str) -> bool {
    label.starts_with("prompt-")
}

/// Turns off the webview's own script dialogs in `window` and answers them from here. Called for every secondary window.
pub fn install(window: &WebviewWindow) {
    let (app, guid, watched) = (window.app_handle().clone(), window.label().to_string(), window.clone());
    let _ = window.with_webview(move |webview| {
        // SAFETY: called on the thread of the webview, with the webview's own COM objects.
        unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else { return };
            if let Ok(settings) = core.Settings() {
                let _ = settings.SetAreDefaultScriptDialogsEnabled(false);
            }
            let handler = ScriptDialogOpeningEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_SCRIPT_DIALOG_KIND(0);
                args.Kind(&mut kind)?;
                let (mut message, mut default, mut uri) = (PWSTR::null(), PWSTR::null(), PWSTR::null());
                args.Message(&mut message)?;
                args.DefaultText(&mut default)?;
                args.Uri(&mut uri)?;
                let (message, default_text, uri) = (take_pwstr(message), take_pwstr(default), take_pwstr(uri));
                if kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD {
                    args.Accept()?; // leaving is the person's decision, not a page's to question
                    return Ok(());
                }
                let kind_name = match kind {
                    COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT => "alert",
                    COREWEBVIEW2_SCRIPT_DIALOG_KIND_CONFIRM => "confirm",
                    COREWEBVIEW2_SCRIPT_DIALOG_KIND_PROMPT => "prompt",
                    _ => return Ok(()), // an unknown kind is dismissed
                };
                // The dialog stays open (the page's script waits) until the deferral completes, on this thread, after the person answered.
                let deferral = args.GetDeferral()?;
                let (args, deferral) = (OnTheWebviewThread(args), OnTheWebviewThread(deferral));
                let (app, guid, window) = (app.clone(), guid.clone(), watched.clone());
                tauri::async_runtime::spawn(async move {
                    let outcome = decide(&app, &guid, &window, kind_name, &uri, message, default_text).await;
                    let _ = window.clone().run_on_main_thread(move || {
                        let (args, deferral) = (args.into_inner(), deferral.into_inner());
                        // On the webview's thread again, with the objects the event gave.
                        if let Some(text) = outcome {
                            if let Some(text) = text {
                                let _ = args.SetResultText(&HSTRING::from(text));
                            }
                            let _ = args.Accept();
                        }
                        let _ = deferral.Complete();
                    });
                });
                Ok(())
            }));
            let mut token = 0;
            let _ = core.add_ScriptDialogOpening(&handler, &mut token);
        }
    });
}

/// A COM object that is only ever touched on the thread of the webview it came from (the handler runs there and so does the closure
/// that answers), carried through the async task in between.
struct OnTheWebviewThread<T>(T);
// SAFETY: see above — it is moved, never used, off the webview's thread.
unsafe impl<T> Send for OnTheWebviewThread<T> {}
impl<T> OnTheWebviewThread<T> {
    fn into_inner(self) -> T {
        self.0
    }
}

/// What to answer a page's dialog: `None` — dismiss it (the page gets a cancelled dialog's result); `Some(None)` — accept it;
/// `Some(Some(text))` — accept it with the text of a `prompt`.
async fn decide(app: &AppHandle, guid: &str, window: &WebviewWindow, kind: &'static str, uri: &str, message: String, default_text: String) -> Option<Option<String>> {
    if crate::prompt_guard::blocked() {
        return None;
    }
    // The dialog waits its turn, and the box that offers to stop prompts comes first when many are in a row.
    let (turn, go) = crate::prompt_guard::take_turn_counted(app, guid).await.ok()?;
    if !go {
        return None;
    }
    let request = DialogRequest {
        kind,
        message: message.chars().take(MAX_MESSAGE_CHARS).collect(),
        default_text: default_text.chars().take(MAX_MESSAGE_CHARS).collect(),
        who: who_is_talking(app, guid, window, uri).await,
    };
    let answer = tokio::time::timeout(crate::prompt_guard::PROMPT_TIMEOUT, show(app, guid, request)).await.unwrap_or(Answer::Cancel);
    drop(turn);
    match answer {
        Answer::Ok(text) => Some(if kind == "prompt" { Some(text.unwrap_or_default()) } else { None }),
        Answer::Prevent => {
            crate::prompt_guard::block();
            None
        }
        Answer::Cancel => None,
    }
}

/// Who says it, as the app knows it (the page's own words are only the message): the window's page, or — when the dialog comes from a
/// frame of another origin (Notes' User Action popup) — a page shown in it; an external web site by its host.
async fn who_is_talking(app: &AppHandle, guid: &str, window: &WebviewWindow, uri: &str) -> String {
    let pool = app.state::<crate::secondary_windows::SecondaryWindowsState>().pool().clone();
    match crate::secondary_windows::page_of(&pool, guid).await {
        Ok(page) => {
            let title = page.title();
            let own = window.url().ok().is_some_and(|top| crate::window_host::same_origin_as(uri, &top));
            if own {
                format!("\"{title}\" says")
            } else {
                format!("A page shown in \"{title}\" says")
            }
        }
        Err(_) => {
            let host = tauri::Url::parse(uri).ok().and_then(|url| url.host_str().map(str::to_string)).unwrap_or_else(|| "A web site".to_string());
            format!("The web site \"{host}\" says")
        }
    }
}

/// Shows the dialog in a window of its own — over the window it belongs to — and waits for the answer. Closing that window is *Cancel*.
async fn show(app: &AppHandle, parent_guid: &str, request: DialogRequest) -> Answer {
    let label = format!("prompt-{}", uuid::Uuid::new_v4().simple());
    let (sender, receiver) = tokio::sync::oneshot::channel();
    PENDING.lock().unwrap().insert(label.clone(), Pending { request, sender: Some(sender) });
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(PROMPT_PAGE.into()))
        .title("A web page says")
        .inner_size(480.0, 280.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .always_on_top(true)
        .center()
        .disable_drag_drop_handler();
    // The window may only be at its own page (a page of our frontend).
    let builder = crate::lock_down_navigation(builder, crate::window_host::Allowed { user: false, system: true, admin: false }, None);
    let builder = match app.get_webview_window(parent_guid) {
        Some(parent) => builder.parent(&parent),
        None => Ok(builder),
    };
    let Ok(window) = builder.and_then(|builder| builder.build()) else {
        PENDING.lock().unwrap().remove(&label);
        return Answer::Cancel;
    };
    let closed = label.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            PENDING.lock().unwrap().remove(&closed); // the sender goes with it: nobody answered
        }
    });
    let answer = receiver.await.unwrap_or(Answer::Cancel);
    let _ = window.close();
    tokio::time::sleep(Duration::from_millis(10)).await;
    PENDING.lock().unwrap().remove(&label);
    answer
}

/// What the prompt window shows — asked by the window itself (`system/prompt/index.html`).
#[tauri::command]
pub fn prompt_dialog_info(window: WebviewWindow) -> Result<DialogRequest, String> {
    PENDING.lock().unwrap().get(window.label()).map(|pending| pending.request.clone()).ok_or_else(|| "No question is waiting here.".to_string())
}

/// The person's answer (`ok`, `cancel` or `prevent`; `text` for a `prompt`), given by the prompt window itself. A window can only answer
/// for its own dialog.
#[tauri::command]
pub fn prompt_dialog_answer(window: WebviewWindow, action: String, text: Option<String>) -> Result<(), String> {
    if !is_prompt_window(window.label()) {
        return Err("That isn't a prompt window.".to_string());
    }
    let sender = PENDING.lock().unwrap().get_mut(window.label()).and_then(|pending| pending.sender.take()).ok_or("No question is waiting here.")?;
    let answer = match action.as_str() {
        "ok" => Answer::Ok(text),
        "prevent" => Answer::Prevent,
        _ => Answer::Cancel,
    };
    let _ = sender.send(answer);
    Ok(())
}
