# Android: one real window per secondary window

**Status: built and verified on the emulator** (API 34). The user-facing description is in `CLAUDE.md`, "Windows on Android"; this file is the
reasoning behind it and the decisions that were made along the way.

**Goal.** On Android a secondary window (a user web app, a system app such as Notes) is a window of its own, like on desktop: it has its own
entry in the Recents screen, the person switches between windows with the system's task switcher, and opening app B never disturbs app A.
The admin-app stays in `MainActivity` (Tauri's own webview); every secondary window is one `WindowActivity` holding one plain
`android.webkit.WebView`. (External web sites already work this way: `ExternalSiteActivity`, no bridge.)

This replaces the old model in which one webview *navigated* between the admin-app and the apps (`window_host` mobile module,
`HostState.active`, `note_navigation`, "Back = suspend"), and it is where the "a web app's window never changes its own address" rule
(see `CLAUDE.md`, "Keyboard" → frozen address) is applied on Android.

## Why a bridge of our own

Tauri creates exactly one webview on Android (the one in `MainActivity`), and its IPC, events and capabilities exist only for it. A
`WebView` we create ourselves has none of that, so `WindowActivity` brings its own, and everything security-relevant is decided in Rust:

```
page JS ──▶ window.__TAURI_INTERNALS__.invoke ──▶ CsdriveBridge.invoke(...)      (@JavascriptInterface, per activity)
        ──▶ WindowBridge.nativeInvoke(guid, cmd, args, cb, err)  (JNI, in-process: only our own Kotlin can call it)
        ──▶ Rust: Webview::on_message(InvokeRequest{… secret header naming the window …})   (Tauri's own dispatcher, on `main`)
        ──▶ command runs, extracting `CallerWindow` ──▶ identity = the window named in the header
        ◀── response ──▶ Kotlin `evaluateJavascript(runCallback(id, value))`  (or, for raw bytes, a fetch of `http://ipc.localhost/raw/<key>`)
```

- **Identity comes from the activity, never from the page.** The `@JavascriptInterface` object is created by `WindowActivity` for one guid; the
  page can call its methods but cannot change which guid they act for. Rust learns the guid from the JNI call, wraps it in a header
  (`x-csdrive-caller: <per-process random secret>:<guid>`) and dispatches through `Webview::on_message` of the `main` webview, so all the ~100
  commands are reached through the one door Tauri gives them. The secret makes the header unforgeable by any script (the admin-app's
  own JavaScript included): a claim without it is refused, never treated as the admin-app.
- **`CallerWindow`** (`window_host.rs`) is a command argument (`impl CommandArg`) that replaces `WebviewWindow` in the commands that need to know
  who is calling. On desktop it says what the window's label says (`main` = the admin-app, else the guid); on Android it says what the header
  says. `caller_guid`, `require_admin`, `require_trusted`, `is_system_page`, `is_admin_page` take it. A page's *address* is no longer used
  to tell callers apart on Android (a window can't be at another window's address anyway — see the frozen address).
- **Tauri's ACL** (capability files) is resolved against the `main` webview for these calls, i.e. everything is granted; on Android it always
  was (one webview), which is why `require_admin`/`require_trusted` exist. They are now checked against the *real* caller, so nothing is weaker.
  `plugin:event|*` and `plugin:dialog|*` are **not** forwarded to Tauri's plugins (their targets would be `main`): the bridge handles them
  itself (events: below; dialogs: a native `AlertDialog` on the window's own activity).
- **Events** (`tab-navigate`, `external-site-*`, `request-resource-icons`): `plugin:event|listen`/`unlisten` never leave the page — its bridge keeps the
  listeners — and `window_host::emit_if_open(guid, …)` evaluates `__csdriveEmit(event, payload)` in that window's WebView only, which hands it to them.
  Same contract as `emit_to` on desktop (the two `window.emit` calls that used to broadcast now go to the one window they were meant for).
- **Serving pages.** The WebView loads `http://csuser.localhost/…` (web apps) or `http://tauri.localhost/system/<id>/index.html` (system apps),
  exactly the addresses wry uses. `shouldInterceptRequest` sends every request to Rust (`WindowBridge.nativeServe`), which answers with the
  same code as the `csuser` protocol (user folder, `@device`, `@filen`, markdown) or, for system apps, Tauri's `asset_resolver`. **Any other
  host gets an error response** (a second wall behind the CSP). HTML documents get `<script src="/@csdrive/window.js">` (the bridge, Tauri's `window.__TAURI__` and the frozen-address guard) first in their `<head>`
  — injected by Rust while serving, so it works on every WebView version and before any page script (and the CSP's `script-src 'self'` covers it).
- **Frozen address.** `shouldOverrideUrlLoading` asks Rust (`navigation_verdict`, the same function desktop uses): the window's own page (reload,
  fragment) goes ahead, a link to the web goes to the OS browser, a request for another page of a web app's own storage is put to the
  person (`link_navigation`: native boxes on the window's activity, see CLAUDE.md, "Links between pages of web apps") and everything else is
  blocked. The init script turns `pushState` and `replaceState` into such a request and removes `navigation`.

## Lifecycle

| What happens | Effect on the entry |
| --- | --- |
| Rust `open(guid)` (Open / Reopen in the admin-app, `open_related_web_app`, …) | `WindowActivity` started as its own task, `documentLaunchMode="intoExisting"` keyed by `csdrive-window://<guid>`: opening an entry that is already showing just brings its task to the front |
| `focus` | the same start again |
| Back in a window, or the person leaves it and the system finishes it | the window is **suspended** (entry, tabs, tags kept) and its task removed from Recents |
| Swipe away in Recents | also **suspended** — an accidental swipe must not delete tab groups (deleting stays an explicit *Close* in the admin-app) |
| *Suspend* / *Close* in the admin-app | Rust asks Kotlin to `finishAndRemoveTask()`; *Close* also deletes the entry (`secondary_windows`, unchanged) |
| The process is killed while windows are open | entries are suspended at the next start (as on desktop); a restored task whose activity finds the app not running starts `MainActivity` and finishes itself |

The old cascade rules now apply on Android unchanged: suspending a window suspends the external sites and the web apps opened from its tabs.

## Decisions made while building it

- **Deny by default, from the capability files.** A window may call the commands `user-apps.json` + `system-apps.json` grant to every window
  (`window_host::window_commands`) — read from those files, not copied — and nothing under `plugin:`. Dispatching through `main`'s ACL alone would
  have granted a page everything the admin-app has (`core:default` and the like), which on desktop a window's label keeps away from it.
- **A claim that fails is an error, not the admin-app.** Both the unknown-secret and the window-is-gone cases refuse the call; only a call with *no*
  claim (made by Tauri's own webview) is the admin-app.
- **Suspend, never delete, when the person leaves.** Back and swiping a window away in Recents suspend it. (On desktop closing a window's X deletes its
  entry; on a phone a swipe is too easy an accident for that.)
- **Rust-side questions are asked in the window** (`android_windows::ask`): the dialog plugin shows dialogs on the app's main activity, invisible while
  a window is in front. Used by the external-site confirmation.
- **External sites are tasks too** (`csdrive-site://<id>`, `intoExisting`) — started from the main activity's context they would otherwise have joined the admin-app's task.
- **No safe-area CSS variables in windows**: the activity pads its root (bars, cutout, keyboard), so the variables the admin-app's webview publishes are not needed.
- **An activity the system destroys while it is not finishing keeps its window** (the backend's record stays; `onCreate` asks for the page again). Only `isFinishing` reports the window gone.
- **Tauri's own `window.__TAURI__` bundle** is copied by `build.rs` from the path Tauri hands its dependents (`DEP_TAURI_GLOBAL_API_SCRIPT_PATH`), so it is always the version's own.

## What was removed

`HostState.active`, `note_navigation` and the `on_page_load` hook, the mobile `platform::open/retire` navigation model, `lock_down_navigation(…, None)`
special-casing for "the main window moves between pages" (the main webview is locked to the admin-app; `Allowed.user/system` go away for it).

## Verified on the emulator

A user web app and Notes each as a task of their own; identity (`label` = the guid, app state per window); refusals of `filen_login`, `get_data_folder_info` and
`plugin:app|version`; a raw `ArrayBuffer` response; `tab-navigate` delivered to the page; Back / *Suspend* / *Reopen* / *Close* / a second open bringing the task
forward; `location.href` blocked, `pushState` throwing, `#fragment` allowed, `fetch` of a web address failing; plugin-dialog OK / Cancel / dismissed; the system file
chooser over a window; an external site as its own task with the confirmation on the asking window, Back closing it, its entry surviving; the suspend cascade
(Notes → its external site, Notes → the web app it opened); a web app opened from Notes reporting `openedBy: NotesApp`; a process kill with a window open.

The card's title follows the tab the window shows (`appTitle`, else the first row of the tab's label — see `CLAUDE.md`, "Tab labels and window titles"). Not done: Android 10-and-older; a real device.
