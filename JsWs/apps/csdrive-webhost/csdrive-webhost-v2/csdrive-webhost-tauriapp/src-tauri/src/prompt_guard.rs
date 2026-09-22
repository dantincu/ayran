//! The rules every prompt of the app follows (`docs/app-security.md`): a web app must not be able to abuse the prompts the app shows,
//! and the person must always be able to make them stop without restarting anything but this app.
//!
//! - **One prompt at a time, in a queue this app keeps.** The OS queues nothing — it shows whatever it is told to, at once, on top
//!   of each other — so the app holds the queue itself: a prompt is handed to the OS only when the one before it has been answered.
//!   The queue is short ([`MAX_WAITING`]; a request beyond it is refused) and nobody waits for ever ([`QUEUE_WAIT`]), and a box that
//!   can't be seen (its window is in the background) gives up after [`PROMPT_TIMEOUT`] so it can't hold the others back for ever.
//! - **"Prevent this app from showing prompts."** An in-memory flag, `false` when the app starts, that the person sets from a prompt and
//!   that **only a full restart of the app clears**. While it is set no prompt is shown — the ones waiting in the queue included — and
//!   what needed one is refused. Two ways to reach it, so that **every prompt kind can**: a box with two choices carries it as a third
//!   button (between the choice and *Cancel*, so that closing the box — which answers as its last button — is still *Cancel*); and the
//!   queue *counts* — when [`BURST_PROMPTS`] prompts of any kind (a box of one button, a three-button link box, an OS file dialog…) come
//!   within [`BURST_WINDOW`], the mark of a page that keeps asking, **the next one is preceded by a box that asks only that**: go on, or
//!   prevent prompts. (A native box has at most three buttons; that box uses them all.)
//! - Nothing here decides *what* a prompt says: that is the caller's, and it must never be misleading — it names who asks from what the
//!   backend knows, never from anything a page wrote.
//!
//! Every prompt goes through [`ask`] (`window_host::choose` is that), [`notice`] or [`os_dialog`], and a page's own JavaScript dialogs
//! through [`begin_dialog`]/[`end_dialog`] (Android) or `page_dialogs` (desktop); nothing else may show one to a window's request.

use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

/// The button that sets the flag.
pub const BLOCK_LABEL: &str = "Prevent this app from showing prompts";

/// What a caller answers when the flag is set.
pub const BLOCKED_MESSAGE: &str = "Prompts are prevented until the app is restarted.";

/// What a caller answers when there are too many prompts waiting, or its turn never came.
pub const BUSY_MESSAGE: &str = "Too many questions are waiting for the person's answer — try again after they have been answered.";

/// A prompt nobody answers (its window can't be seen) is given up after this long, so it doesn't hold the others back for ever.
pub const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

/// How many prompts may wait for their turn; one more is refused.
pub const MAX_WAITING: usize = 8;

/// How long a prompt waits for its turn before it is dropped.
pub const QUEUE_WAIT: Duration = Duration::from_secs(60);

/// This many prompts within [`BURST_WINDOW`] make the next one suspicious.
pub const BURST_PROMPTS: usize = 5;
pub const BURST_WINDOW: Duration = Duration::from_secs(30);

/// The state, apart from the one the app has ([`blocked`], [`ask`]…) so that it can be tested.
pub struct Guard {
    blocked: AtomicBool,
    /// The turn to show a prompt: whoever holds it is the one prompt showing.
    turn: Arc<AsyncMutex<()>>,
    waiting: AtomicUsize,
    shown: Mutex<Vec<Instant>>,
    /// The turn, held between [`Guard::begin_manual`] and [`Guard::end_manual`] by a prompt that is not shown from Rust.
    manual: Mutex<Option<OwnedMutexGuard<()>>>,
}

impl Guard {
    pub fn new() -> Self {
        Self { blocked: AtomicBool::new(false), turn: Arc::new(AsyncMutex::new(())), waiting: AtomicUsize::new(0), shown: Mutex::new(Vec::new()), manual: Mutex::new(None) }
    }

    pub fn blocked(&self) -> bool {
        self.blocked.load(Ordering::SeqCst)
    }

    /// Sets the flag. Nothing clears it but the process ending.
    pub fn block(&self) {
        self.blocked.store(true, Ordering::SeqCst);
    }

    /// How many prompts are waiting for their turn.
    #[cfg(test)]
    pub fn waiting(&self) -> usize {
        self.waiting.load(Ordering::SeqCst)
    }

    /// Waits for the turn to show a prompt. `Err` says why there is none: the person prevented prompts (also while this one waited), too
    /// many are waiting already, or the turn didn't come in [`QUEUE_WAIT`]. Dropping the result gives the turn to the next.
    pub async fn take_turn(&self) -> Result<OwnedMutexGuard<()>, &'static str> {
        if self.blocked() {
            return Err(BLOCKED_MESSAGE);
        }
        if self.waiting.fetch_add(1, Ordering::SeqCst) >= MAX_WAITING {
            self.waiting.fetch_sub(1, Ordering::SeqCst);
            return Err(BUSY_MESSAGE);
        }
        let got = tokio::time::timeout(QUEUE_WAIT, self.turn.clone().lock_owned()).await;
        self.waiting.fetch_sub(1, Ordering::SeqCst);
        let turn = got.map_err(|_| BUSY_MESSAGE)?;
        if self.blocked() {
            return Err(BLOCKED_MESSAGE); // prevented while this one waited
        }
        Ok(turn)
    }

    /// A prompt that is shown from Kotlin (a page's own `alert`, on Android) can't wait — the page's thread is the one that would wait —
    /// so it takes the turn if it is free right now, and gives it back with [`Guard::end_manual`].
    pub fn begin_manual(&self) -> Result<(), &'static str> {
        if self.blocked() {
            return Err(BLOCKED_MESSAGE);
        }
        let turn = self.turn.clone().try_lock_owned().map_err(|_| BUSY_MESSAGE)?;
        *self.manual.lock().unwrap() = Some(turn);
        Ok(())
    }

    pub fn end_manual(&self) {
        self.manual.lock().unwrap().take();
    }

    /// Records a prompt about to be shown; true when it is the [`BURST_PROMPTS`]th within [`BURST_WINDOW`].
    pub fn note_shown(&self, now: Instant) -> bool {
        let mut shown = self.shown.lock().unwrap();
        shown.retain(|at| now.duration_since(*at) < BURST_WINDOW);
        shown.push(now);
        shown.len() >= BURST_PROMPTS
    }

    /// The person chose to go on: the count starts again.
    pub fn forget_burst(&self) {
        self.shown.lock().unwrap().clear();
    }
}

impl Default for Guard {
    fn default() -> Self {
        Self::new()
    }
}

static GUARD: LazyLock<Guard> = LazyLock::new(Guard::new);

/// Whether the person prevented prompts (until the app restarts).
pub fn blocked() -> bool {
    GUARD.blocked()
}

/// Sets the flag (the person chose *Prevent this app from showing prompts*).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn block() {
    GUARD.block();
}

/// Android's Kotlin asks before it shows a page's own dialog (`alert`, `confirm`, `prompt`): 0 — go ahead (give the turn back with
/// [`end_dialog`]), 1 — the person prevented prompts, 2 — another is showing.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn begin_dialog() -> i32 {
    match GUARD.begin_manual() {
        Ok(()) => 0,
        Err(reason) if reason == BLOCKED_MESSAGE => 1,
        Err(_) => 2,
    }
}

/// The page's own dialog is over; `prevent`: the person chose *Prevent this app from showing prompts* in it.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn end_dialog(prevent: bool) {
    if prevent {
        GUARD.block();
    }
    GUARD.end_manual();
}

/// `Err` with the reason when prompts are prevented — for a command to say so before it starts something that needs one.
pub fn refuse_if_blocked() -> Result<(), String> {
    if GUARD.blocked() {
        Err(BLOCKED_MESSAGE.to_string())
    } else {
        Ok(())
    }
}

/// The turn to show a prompt of a kind `ask` doesn't cover (a page's own dialog on desktop, in `page_dialogs`), counted like the rest:
/// `Ok(true)` — show it; `Ok(false)` — the person, asked because many came in a row, doesn't want to see it; `Err` — none may be shown.
#[cfg_attr(not(windows), allow(dead_code))]
pub async fn take_turn_counted(app: &AppHandle, guid: &str) -> Result<(OwnedMutexGuard<()>, bool), String> {
    let turn = GUARD.take_turn().await.map_err(str::to_string)?;
    let go = !GUARD.note_shown(Instant::now()) || go_on_after_burst(app, guid).await;
    Ok((turn, go))
}

/// The box that asks only whether to go on seeing prompts, shown before one that comes on the heels of many others.
async fn burst_box(app: &AppHandle, guid: &str) -> Option<usize> {
    crate::window_host::choose_unguarded(
        app,
        guid,
        "Many prompts",
        "This app has shown you many questions in a short time. Do you want to go on seeing them?",
        &["Keep showing prompts", BLOCK_LABEL, "Cancel"],
    )
    .await
}

/// What the person answered to the box that comes before the [`BURST_PROMPTS`]th prompt in a short time: `true` to show it.
async fn go_on_after_burst(app: &AppHandle, guid: &str) -> bool {
    match burst_box(app, guid).await {
        Some(0) => {
            GUARD.forget_burst();
            true
        }
        Some(1) => {
            GUARD.block();
            false
        }
        _ => false,
    }
}

/// Shows a prompt in the window `guid` — `labels` are up to three buttons, the answer the index of the one pressed, `None` when it was
/// dismissed, refused, or the person prevented prompts. It waits for its turn (see the top of this file). Every box of the app is shown
/// through this.
pub async fn ask(app: &AppHandle, guid: &str, title: &str, message: &str, labels: &[&str]) -> Option<usize> {
    let turn = GUARD.take_turn().await.ok()?;
    if GUARD.note_shown(Instant::now()) && !go_on_after_burst(app, guid).await {
        return None;
    }
    let shown = async {
        match labels {
            // Room for the option: between the choice and Cancel (a box that is closed answers as its last button).
            [first, last] => match crate::window_host::choose_unguarded(app, guid, title, message, &[first, BLOCK_LABEL, last]).await {
                Some(0) => Some(0),
                Some(1) => {
                    GUARD.block();
                    None
                }
                Some(2) => Some(1),
                _ => None,
            },
            _ => crate::window_host::choose_unguarded(app, guid, title, message, labels).await,
        }
    };
    let answer = tokio::time::timeout(PROMPT_TIMEOUT, shown).await.ok().flatten();
    drop(turn);
    answer
}

/// Tells the person something, with one button — in the window `guid`, or (`None`) in the admin-app's, the one that asked. Nothing is
/// shown when prompts are prevented.
pub async fn notice(app: &AppHandle, guid: Option<&str>, title: &str, message: &str) {
    let Ok(turn) = GUARD.take_turn().await else { return };
    if let Some(guid) = guid {
        if GUARD.note_shown(Instant::now()) && !go_on_after_burst(app, guid).await {
            return;
        }
    } else {
        GUARD.note_shown(Instant::now());
    }
    let shown = async {
        match guid {
            Some(guid) => {
                crate::window_host::choose_unguarded(app, guid, title, message, &["OK"]).await;
            }
            None => {
                use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
                let (sender, receiver) = tokio::sync::oneshot::channel();
                app.dialog().message(message).title(title).kind(MessageDialogKind::Warning).buttons(MessageDialogButtons::OkCustom("OK".to_string())).show(move |_| {
                    let _ = sender.send(());
                });
                let _ = receiver.await;
            }
        }
    };
    let _ = tokio::time::timeout(PROMPT_TIMEOUT, shown).await;
    drop(turn);
}

/// Runs one of the OS's own dialogs (a folder to pick, a place to save to) that a window asked for, under the same rules: it waits for
/// its turn, refused when prompts are prevented, and counted as a prompt (the box offering to stop them comes first when many follow
/// each other, for a window's request — `guid` is `None` for the admin-app's own buttons, which are the person's, not a page's).
/// `Ok(None)`: the person declined that box.
pub async fn os_dialog<T>(app: &AppHandle, guid: Option<&str>, run: impl Future<Output = T>) -> Result<Option<T>, String> {
    let turn = GUARD.take_turn().await.map_err(str::to_string)?;
    if let Some(guid) = guid {
        if GUARD.note_shown(Instant::now()) && !go_on_after_burst(app, guid).await {
            return if blocked() { Err(BLOCKED_MESSAGE.to_string()) } else { Ok(None) };
        }
    }
    let answer = tokio::time::timeout(PROMPT_TIMEOUT, run).await.ok();
    drop(turn);
    Ok(answer)
}

// ── For the person: the state, and a question a window may ask ─────────────────────────────────────────────

/// What Settings shows: whether prompts are prevented, and how many windows are open of how many the app allows.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub prompts_prevented: bool,
    pub open_windows: usize,
    pub max_windows: usize,
}

/// The admin-app's Settings: the prompt flag and the window count. Admin-app only.
#[tauri::command]
pub fn prompt_guard_status(window: crate::window_host::CallerWindow, app: AppHandle) -> Result<Status, String> {
    crate::window_host::require_admin(&window)?;
    Ok(Status {
        prompts_prevented: blocked(),
        open_windows: crate::window_host::open_windows(&app),
        max_windows: crate::window_host::MAX_OPEN_WINDOWS,
    })
}

/// The longest question a window may put in a box.
const MAX_QUESTION_CHARS: usize = 1500;

/// A yes/no question in a native box on the asking window (Notes' "Delete …?", "Close without saving?"): `true` when the person pressed
/// **OK**. A page can ask too, under the rules above — which is why this and not the dialog plugin is what windows use (the plugin's own
/// commands are the admin-app's). `false` when declined, prevented or refused.
///
/// **A page can't make it misleading**: the *question* is the caller's, but the box's title says who asks — the window's page, as the app
/// knows it, never anything the caller wrote (Notes, whose page may be relaying a page of the person's own, says so) — and the buttons
/// are always *OK* and *Cancel*, in that order; the caller chooses neither.
#[tauri::command]
pub async fn confirm_dialog(
    window: crate::window_host::CallerWindow,
    app: AppHandle,
    windows: tauri::State<'_, crate::secondary_windows::SecondaryWindowsState>,
    message: String,
) -> Result<bool, String> {
    // The admin-app has the dialog plugin for its own questions; this is for windows.
    let guid = crate::window_host::caller_guid(&window).ok_or("The admin-app asks its own questions.")?;
    refuse_if_blocked()?;
    let page = crate::secondary_windows::page_of(windows.pool(), &guid).await?;
    let who = asker_label(&page);
    let message: String = message.chars().take(MAX_QUESTION_CHARS).collect();
    Ok(ask(&app, &guid, &format!("{who} asks"), &message, &["OK", "Cancel"]).await == Some(0))
}

/// A message for the person in a native box on the asking window (what a page's `alert` becomes): one button, *OK*. The message is the
/// caller's, the title — who says it — is the app's (see [`confirm_dialog`]). Nothing is shown when prompts are prevented.
#[tauri::command]
pub async fn alert_dialog(
    window: crate::window_host::CallerWindow,
    app: AppHandle,
    windows: tauri::State<'_, crate::secondary_windows::SecondaryWindowsState>,
    message: String,
) -> Result<(), String> {
    let guid = crate::window_host::caller_guid(&window).ok_or("The admin-app has its own messages.")?;
    refuse_if_blocked()?;
    let page = crate::secondary_windows::page_of(windows.pool(), &guid).await?;
    let who = asker_label(&page);
    let message: String = message.chars().take(MAX_QUESTION_CHARS).collect();
    ask(&app, &guid, &format!("{who} says"), &message, &["OK"]).await;
    Ok(())
}

/// Who a prompt says is asking: the window's page, by the name the app gives it. A system app's window may be showing a page of the
/// person's own (Notes' User Action popup, whose calls it relays), so it is named as that.
pub fn asker_label(page: &crate::window_host::Page) -> String {
    if page.kind == crate::window_host::Kind::System {
        format!("\"{}\" (or a page it shows)", page.title())
    } else {
        format!("\"{}\"", page.title())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run<T>(future: impl Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn the_flag_starts_false_and_only_a_new_guard_clears_it() {
        let guard = Guard::new();
        assert!(!guard.blocked());
        guard.block();
        assert!(guard.blocked());
        assert_eq!(run(guard.take_turn()).err(), Some(BLOCKED_MESSAGE), "no prompt while prevented");
        assert!(guard.begin_manual().is_err());
        assert!(run(Guard::new().take_turn()).is_ok(), "a restart (a fresh guard) starts over");
    }

    #[test]
    fn prompts_wait_for_their_turn_one_at_a_time() {
        run(async {
            let guard = Arc::new(Guard::new());
            let first = guard.take_turn().await.expect("the first one may show");
            let second = tokio::spawn({
                let guard = guard.clone();
                async move { guard.take_turn().await.map(|_| "shown") }
            });
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert_eq!(guard.waiting(), 1, "the second waits — it is queued here, not handed to the OS");
            assert!(!second.is_finished());
            drop(first);
            assert_eq!(second.await.unwrap(), Ok("shown"), "after the answer the next one is shown");
            assert_eq!(guard.waiting(), 0);
        });
    }

    #[test]
    fn the_queue_is_short_and_what_waits_is_dropped_when_prompts_get_prevented() {
        run(async {
            let guard = Arc::new(Guard::new());
            let held = guard.take_turn().await.unwrap();
            let mut waiters = Vec::new();
            for _ in 0..MAX_WAITING {
                let guard = guard.clone();
                waiters.push(tokio::spawn(async move { guard.take_turn().await.map(|_| ()) }));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert_eq!(guard.waiting(), MAX_WAITING);
            assert_eq!(guard.take_turn().await.err(), Some(BUSY_MESSAGE), "one more than the queue holds is refused");
            guard.block(); // the person prevented prompts while they waited
            drop(held);
            for waiter in waiters {
                assert_eq!(waiter.await.unwrap(), Err(BLOCKED_MESSAGE), "none of them is shown");
            }
        });
    }

    #[test]
    fn a_page_dialog_shown_from_kotlin_takes_the_turn_if_it_is_free_and_gives_it_back() {
        run(async {
            let guard = Guard::new();
            assert!(guard.begin_manual().is_ok());
            assert_eq!(guard.begin_manual().err(), Some(BUSY_MESSAGE), "a second one can't wait: it is cancelled");
            let waiting = guard.take_turn();
            tokio::pin!(waiting);
            assert!(tokio::time::timeout(Duration::from_millis(50), &mut waiting).await.is_err(), "a prompt of the app waits while the page's dialog shows");
            guard.end_manual();
            assert!(waiting.await.is_ok(), "and gets its turn when it is over");
        });
    }

    #[test]
    fn many_prompts_in_a_short_time_are_a_burst_and_slow_ones_are_not() {
        let guard = Guard::new();
        let start = Instant::now();
        for i in 0..BURST_PROMPTS - 1 {
            assert!(!guard.note_shown(start + Duration::from_secs(i as u64)), "prompt {i}");
        }
        assert!(guard.note_shown(start + Duration::from_secs(BURST_PROMPTS as u64)), "the fifth within the window");
        guard.forget_burst();
        assert!(!guard.note_shown(start + Duration::from_secs(10)), "the count starts again when the person goes on");

        let slow = Guard::new();
        for i in 0..20 {
            assert!(!slow.note_shown(start + BURST_WINDOW * 2 * i), "prompts far apart are never a burst");
        }
    }
}
