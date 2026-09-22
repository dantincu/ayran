//! Android only: the windows of web apps and system apps, **one activity each** (`WindowActivity.kt`), with a bridge of our own
//! between their plain WebViews and this backend. The strategy — why, how identity works, the lifecycle — is written down in
//! `docs/strategies/android-windows-strategy.md`; this is the Rust half of it.
//!
//! - Kotlin calls in over JNI (the `Java_…_WindowBridge_native…` functions below) and Rust calls out to `WindowBridge`'s static
//!   methods through [`call_strings`], which attaches whatever thread it is on.
//! - **Which window is calling is what the activity said** (`nativeInvoke`'s `guid`), carried to the command as a header only
//!   this process can write ([`CALLER_HEADER`], with a secret made at startup) and read back by `window_host::CallerWindow`.
//!   Nothing a page sends decides it.
//! - A window may call the commands the capability file grants to windows (`user-apps.json`) — the same
//!   rule Tauri applies to a desktop window by its label — and nothing under `plugin:` (its events and dialogs are the bridge's
//!   own, in `scripts/window-bridge.js` / `WindowActivity.kt`).

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use jni::objects::{GlobalRef, JClass, JString, JValue};
use jni::sys::{jboolean, jbyteArray, jint, jstring, JNI_FALSE, JNI_TRUE};
use jni::{JNIEnv, JavaVM};
use tauri::http::header::{CONTENT_TYPE, HeaderMap, HeaderValue};
use tauri::http::{Response, StatusCode};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponse, InvokeResponseBody};
use tauri::webview::InvokeRequest;
use tauri::{AppHandle, Manager, Url};

use crate::window_host::{self, Allowed, Kind, Page};
use crate::window_scripts;

/// The name of the header that carries a call's window (`<secret>:<guid>`) from `dispatch` to `CallerWindow`.
const CALLER_HEADER: &str = "x-csdrive-caller";

/// The host a window fetches the raw bytes of an answer from (`scripts/window-bridge.js`; allowed by the CSP's `connect-src`).
const RAW_HOST: &str = "ipc.localhost";

// ── State ─────────────────────────────────────────────────────────────────────

struct Window {
    page: Page,
    /// Whether Rust asked for it to be closed (`request_close`) — as opposed to the person leaving it (Back, Recents).
    close_asked: bool,
}

#[derive(Default)]
struct State {
    windows: HashMap<String, Window>,
    /// Answers that are raw bytes, waiting to be fetched by the window they are for: key → (guid, bytes).
    raw: HashMap<u64, (String, Vec<u8>)>,
    next_raw: u64,
    /// Questions shown to the person in a window, waiting for the answer: id → (guid, where the answer goes).
    asks: HashMap<u64, (String, tokio::sync::oneshot::Sender<Option<usize>>)>,
    next_ask: u64,
}

fn state() -> MutexGuard<'static, State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(Mutex::default).lock().unwrap()
}

/// Made at startup, known to this process only: it is what makes [`CALLER_HEADER`] impossible to forge from a page.
fn secret() -> &'static str {
    static SECRET: OnceLock<String> = OnceLock::new();
    SECRET.get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
}

// ── Rust → Kotlin ─────────────────────────────────────────────────────────────

struct Kotlin {
    vm: JavaVM,
    /// `WindowBridge`, whose static methods are what Rust calls.
    class: GlobalRef,
}

static KOTLIN: OnceLock<Kotlin> = OnceLock::new();

/// Calls a static method of `WindowBridge` taking only strings and returning nothing, from whatever thread this is.
fn call_strings(method: &str, args: &[&str]) -> Result<(), String> {
    let kotlin = KOTLIN.get().ok_or("The window bridge isn't ready.")?;
    let mut env = kotlin.vm.attach_current_thread().map_err(|e| e.to_string())?;
    let result = (|| -> jni::errors::Result<()> {
        let strings = args.iter().map(|a| env.new_string(a)).collect::<jni::errors::Result<Vec<_>>>()?;
        let values: Vec<JValue> = strings.iter().map(|s| JValue::Object(s)).collect();
        let signature = format!("({})V", "Ljava/lang/String;".repeat(args.len()));
        // SAFETY: the reference is a global one to the class object.
        let class = unsafe { JClass::from_raw(kotlin.class.as_obj().as_raw()) };
        env.call_static_method(&class, method, &signature, &values)?;
        Ok(())
    })();
    result.map_err(|e| {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
        format!("Android: {e}")
    })
}

// ── What window_host uses ─────────────────────────────────────────────────────

pub fn is_open(guid: &str) -> bool {
    state().windows.contains_key(guid)
}

/// The windows that are showing.
pub fn guids() -> Vec<String> {
    state().windows.keys().cloned().collect()
}

/// How many windows are showing.
pub fn open_count() -> usize {
    state().windows.len()
}

/// Starts the window's activity (or, if it is showing already, brings it to the front); it asks for its page when it is up
/// (`nativeAttach`).
pub fn open(_app: &AppHandle, guid: &str, page: &Page) -> Result<(), String> {
    let title = page.title();
    state().windows.insert(guid.to_string(), Window { page: page.clone(), close_asked: false });
    call_strings("open", &[guid, &title]).inspect_err(|_| {
        state().windows.remove(guid);
    })
}

/// The page an open window is at now.
pub fn page_of(guid: &str) -> Option<Page> {
    state().windows.get(guid).map(|w| w.page.clone())
}

/// Reloads the page the window shows.
pub fn reload(guid: &str) {
    if is_open(guid) {
        let _ = call_strings("eval", &[guid, "location.reload()"]);
    }
}

/// Takes the window to `page`: its navigation rule is told first (the load below is one it must let through).
pub fn navigate(guid: &str, page: &Page) -> Result<(), String> {
    let url = window_host::navigation_url(&page.url()?);
    match state().windows.get_mut(guid) {
        Some(window) => window.page = page.clone(),
        None => return Err("That window isn't open.".to_string()),
    }
    let target = serde_json::to_string(url.as_str()).map_err(|e| e.to_string())?;
    call_strings("eval", &[guid, &format!("location.replace({target})")])
}

/// The card of the window in the Recents screen shows `title`.
pub fn set_title(guid: &str, title: &str) {
    if is_open(guid) {
        let _ = call_strings("title", &[guid, title]);
    }
}

/// Delivers `event` to the window's page (which hands it to the listeners it registered), if the window is showing.
pub fn emit_if_open<S: serde::Serialize>(guid: &str, event: &str, payload: &S) -> bool {
    if !is_open(guid) {
        return false;
    }
    let (Ok(event), Ok(payload)) = (serde_json::to_string(event), serde_json::to_string(payload)) else {
        return false;
    };
    call_strings("eval", &[guid, &format!("window.__csdriveEmit && window.__csdriveEmit({event}, {payload})")]).is_ok()
}

/// Asks the window's activity to finish (and leave the Recents screen). Once it has, [`nativeDetached`] runs the bookkeeping.
pub fn request_close(guid: &str) -> bool {
    match state().windows.get_mut(guid) {
        Some(window) => window.close_asked = true,
        None => return false,
    }
    let _ = call_strings("close", &[guid]);
    true
}

/// Waits (briefly) until none of `guids` is showing any more.
pub async fn wait_until_closed(guids: &[String]) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while guids.iter().any(|g| is_open(g)) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Brings the window to the front.
pub fn focus(_app: &AppHandle, guid: &str) -> Result<(), String> {
    let Some(title) = state().windows.get(guid).map(|w| w.page.title()) else {
        return Ok(());
    };
    call_strings("open", &[guid, &title])
}

/// Asks the person something in a dialog on the window's own activity (a dialog of the app's other activity would be invisible
/// while a window is showing): `labels` are up to three buttons, and the answer is the index of the one pressed — `None` if the
/// dialog was dismissed, or the window isn't showing (or goes away while it is).
pub async fn ask(guid: &str, title: &str, message: &str, labels: &[&str]) -> Option<usize> {
    if !is_open(guid) {
        return None;
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let id = {
        let mut state = state();
        state.next_ask += 1;
        let id = state.next_ask;
        state.asks.insert(id, (guid.to_string(), sender));
        id
    };
    let labels = serde_json::to_string(labels).ok()?;
    if call_strings("ask", &[guid, &id.to_string(), title, message, &labels]).is_err() {
        state().asks.remove(&id);
        return None;
    }
    receiver.await.ok().flatten()
}

/// Who a call comes from, if it was made through the bridge: the window's guid and whether it is a system app. `None` for a
/// call made through Tauri's own webview (the admin-app). A call that *claims* to be a window's but isn't (a wrong secret,
/// a window that is gone) is an error, never the admin-app.
pub fn caller_in(headers: &HeaderMap) -> Result<Option<(String, bool)>, String> {
    let Some(value) = headers.get(CALLER_HEADER) else {
        return Ok(None);
    };
    let claimed = value.to_str().ok().and_then(|v| v.split_once(':')).filter(|(given, _)| *given == secret());
    let Some((_, guid)) = claimed else {
        return Err("That call doesn't come from a window.".to_string());
    };
    let state = state();
    let window = state.windows.get(guid).ok_or("That window is closed.")?;
    Ok(Some((guid.to_string(), window.page.kind == Kind::System)))
}

// ── Kotlin → Rust (JNI) ───────────────────────────────────────────────────────

fn string_of(env: &mut JNIEnv, value: &JString) -> String {
    env.get_string(value).map(String::from).unwrap_or_default()
}

fn java_string(env: &mut JNIEnv, value: &str) -> jstring {
    env.new_string(value).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

/// `WindowBridge.init`: the class and the VM are kept so that Rust can call `WindowBridge`'s static methods from any thread.
#[no_mangle]
pub extern "system" fn Java_com_ayran_csdrive_1webhost_1tauriapp_WindowBridge_nativeInit(env: JNIEnv, class: JClass) {
    if KOTLIN.get().is_some() {
        return;
    }
    if let (Ok(vm), Ok(class)) = (env.get_java_vm(), env.new_global_ref(&class)) {
        let _ = KOTLIN.set(Kotlin { vm, class });
    }
}

/// A window's activity is up and asks what to show: `{url, title}`, or an empty string if the window is not one we opened (or
/// the app isn't running — the activity then starts the app and finishes).
#[no_mangle]
pub extern "system" fn Java_com_ayran_csdrive_1webhost_1tauriapp_WindowBridge_nativeAttach(mut env: JNIEnv, _class: JClass, guid: JString) -> jstring {
    let guid = string_of(&mut env, &guid);
    let answer = (|| {
        crate::android_jni::app()?;
        let state = state();
        let window = state.windows.get(&guid)?;
        let url = window_host::navigation_url(&window.page.url().ok()?);
        Some(serde_json::json!({ "url": url.as_str(), "title": window.page.title() }).to_string())
    })();
    java_string(&mut env, &answer.unwrap_or_default())
}

/// A window's page called `cmd`: run it as that window and answer through `WindowBridge.respond`.
#[no_mangle]
pub extern "system" fn Java_com_ayran_csdrive_1webhost_1tauriapp_WindowBridge_nativeInvoke(
    mut env: JNIEnv,
    _class: JClass,
    guid: JString,
    cmd: JString,
    args: JString,
    callback: jint,
    error: jint,
) {
    let (guid, cmd, args) = (string_of(&mut env, &guid), string_of(&mut env, &cmd), string_of(&mut env, &args));
    let Some(app) = crate::android_jni::app() else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move { dispatch(app, guid, cmd, args, callback as u32, error as u32).await });
}

/// The WebView of window `guid` asks for `url`: the answer as `status(4) | header json length(4) | header json | body`.
/// `range` and `origin` are the request's `Range` and `Origin` headers ("" when it has none): a media file is answered a
/// piece at a time (see `file_serving`), so no file is ever held whole.
#[no_mangle]
pub extern "system" fn Java_com_ayran_csdrive_1webhost_1tauriapp_WindowBridge_nativeServe(
    mut env: JNIEnv,
    _class: JClass,
    guid: JString,
    url: JString,
    range: JString,
    origin: JString,
) -> jbyteArray {
    let (guid, url) = (string_of(&mut env, &guid), string_of(&mut env, &url));
    let (range, origin) = (string_of(&mut env, &range), string_of(&mut env, &origin));
    let meta = crate::file_serving::RequestMeta { range: Some(range).filter(|r| !r.is_empty()), origin: Some(origin).filter(|o| !o.is_empty()) };
    let response = match (crate::android_jni::app(), Url::parse(&url)) {
        (Some(app), Ok(url)) => tauri::async_runtime::block_on(serve(app, &guid, &url, &meta)),
        _ => plain(StatusCode::NOT_FOUND, "Not found"),
    };
    let mut headers = serde_json::Map::new();
    for (name, value) in response.headers() {
        if let Ok(value) = value.to_str() {
            headers.insert(name.as_str().to_string(), serde_json::Value::String(value.to_string()));
        }
    }
    let headers = serde_json::Value::Object(headers).to_string().into_bytes();
    let mut frame = Vec::with_capacity(8 + headers.len() + response.body().len());
    frame.extend_from_slice(&(response.status().as_u16() as u32).to_be_bytes());
    frame.extend_from_slice(&(headers.len() as u32).to_be_bytes());
    frame.extend_from_slice(&headers);
    frame.extend_from_slice(response.body());
    env.byte_array_from_slice(&frame).map(|a| a.into_raw()).unwrap_or(std::ptr::null_mut())
}

/// The WebView of window `guid` is about to navigate to `url`: whether it may (`navigation_verdict` — the rule desktop
/// windows have too: its own page only; a link to the web goes to the OS browser; everything else is blocked).
#[no_mangle]
pub extern "system" fn Java_com_ayran_csdrive_1webhost_1tauriapp_WindowBridge_nativeNavigation(mut env: JNIEnv, _class: JClass, guid: JString, url: JString) -> jboolean {
    let (guid, url) = (string_of(&mut env, &guid), string_of(&mut env, &url));
    let page = state().windows.get(&guid).map(|w| w.page.clone());
    let (Some(page), Ok(url)) = (page, Url::parse(&url)) else { return JNI_FALSE };
    let Ok(own) = page.url() else { return JNI_FALSE };
    match crate::navigation_verdict(&url, Allowed::for_kind(page.kind), Some(&own)) {
        crate::Nav::Allow => JNI_TRUE,
        crate::Nav::Browser => {
            crate::external_sites::open_in_browser(&url);
            JNI_FALSE
        }
        crate::Nav::Request => {
            if let Some(app) = crate::android_jni::app() {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { crate::link_navigation::request(&app, &guid, url).await });
            }
            JNI_FALSE
        }
        crate::Nav::Block => JNI_FALSE,
    }
}

/// A window's page is about to show its own `alert`/`confirm`/`prompt`: 0 — it may (the right to show a prompt is taken, and given
/// back by `nativeDialogEnd`), 1 — the person prevented prompts, 2 — another prompt is showing. See `prompt_guard`.
#[no_mangle]
pub extern "system" fn Java_com_ayran_csdrive_1webhost_1tauriapp_WindowBridge_nativeDialogBegin(_env: JNIEnv, _class: JClass) -> jint {
    crate::prompt_guard::begin_dialog()
}

/// The page's own dialog is over (`prevent`: the person chose to prevent prompts in it).
#[no_mangle]
pub extern "system" fn Java_com_ayran_csdrive_1webhost_1tauriapp_WindowBridge_nativeDialogEnd(_env: JNIEnv, _class: JClass, prevent: jboolean) {
    crate::prompt_guard::end_dialog(prevent != JNI_FALSE);
}

/// The person answered a question asked with [`ask`] (`index` is -1 when the dialog was dismissed).
#[no_mangle]
pub extern "system" fn Java_com_ayran_csdrive_1webhost_1tauriapp_WindowBridge_nativeAnswer(_env: JNIEnv, _class: JClass, id: jint, index: jint) {
    if let Some((_, sender)) = state().asks.remove(&(id as u64)) {
        let _ = sender.send(usize::try_from(index).ok());
    }
}

/// A window's activity is gone. If Rust didn't ask for that, the person left it (Back, swiped it away in Recents): that
/// *suspends* the window — its entry is kept — and only the admin-app's *Close* deletes one.
#[no_mangle]
pub extern "system" fn Java_com_ayran_csdrive_1webhost_1tauriapp_WindowBridge_nativeDetached(mut env: JNIEnv, _class: JClass, guid: JString) {
    let guid = string_of(&mut env, &guid);
    let Some(app) = crate::android_jni::app() else { return };
    let asked = {
        let mut state = state();
        state.raw.retain(|_, (owner, _)| *owner != guid);
        state.asks.retain(|_, (owner, _)| *owner != guid); // (dropping the sender answers "nobody")
        state.windows.remove(&guid).map(|w| w.close_asked)
    };
    let Some(asked) = asked else { return };
    if !asked {
        crate::secondary_windows::mark_suspending(app, &guid);
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { crate::secondary_windows::handle_window_destroyed(&app, &guid).await });
}

// ── Commands ──────────────────────────────────────────────────────────────────

fn respond(guid: &str, id: u32, kind: &str, payload: &str) {
    let _ = call_strings("respond", &[guid, &id.to_string(), kind, payload]);
}

/// Runs command `cmd` with the JSON arguments `args` for window `guid`, through Tauri's own dispatcher (so the command is
/// handled exactly as if its page had called it) — with the header that tells `CallerWindow` who is calling.
async fn dispatch(app: AppHandle, guid: String, cmd: String, args: String, callback: u32, error: u32) {
    let fail = |message: &str| respond(&guid, error, "json", &serde_json::Value::String(message.to_string()).to_string());
    if !is_open(&guid) {
        return;
    }
    if cmd.starts_with("plugin:") || !window_host::window_commands().contains(&cmd) {
        return fail(&format!("Command {cmd} not allowed for this window."));
    }
    let body = match serde_json::from_str::<serde_json::Value>(&args) {
        Ok(body) => body,
        Err(e) => return fail(&format!("The arguments aren't json: {e}")),
    };
    let Some(main) = app.get_webview_window(window_host::MAIN_WINDOW_LABEL) else {
        return fail("The app isn't ready.");
    };
    let main: tauri::Webview = main.as_ref().clone();
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    match HeaderValue::from_str(&format!("{}:{guid}", secret())) {
        Ok(value) => headers.insert(CALLER_HEADER, value),
        Err(_) => return fail("That window has no valid name."),
    };
    let request = InvokeRequest {
        cmd,
        callback: CallbackFn(callback),
        error: CallbackFn(error),
        // Tauri treats a call as local (not from a remote page) when it comes from its own origin.
        url: window_host::navigation_url(&window_host::admin_page_url()),
        body: InvokeBody::Json(body),
        headers,
        invoke_key: app.invoke_key().to_string(),
    };
    let owner = guid.clone();
    main.on_message(
        request,
        Box::new(move |_webview, _cmd, response, callback, error| match response {
            InvokeResponse::Ok(InvokeResponseBody::Json(json)) => respond(&owner, callback.0, "json", &json),
            InvokeResponse::Ok(InvokeResponseBody::Raw(bytes)) => {
                let key = {
                    let mut state = state();
                    state.next_raw += 1;
                    let key = state.next_raw;
                    state.raw.insert(key, (owner.clone(), bytes));
                    key
                };
                // The page fetches the bytes itself (see `serve`); it needs the error callback in case that fails.
                respond(&owner, callback.0, "raw", &format!("{}:{key}", error.0));
            }
            InvokeResponse::Err(e) => respond(&owner, error.0, "json", &e.0.to_string()),
        }),
    );
}

// ── Serving ───────────────────────────────────────────────────────────────────

fn plain(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder().status(status).header(CONTENT_TYPE, "text/plain; charset=utf-8").body(message.as_bytes().to_vec()).unwrap()
}

/// The keys of the frontend's embedded files (the admin-app and the system apps' pages, and their shared assets).
fn app_asset_keys(app: &AppHandle) -> &'static HashSet<String> {
    static KEYS: OnceLock<HashSet<String>> = OnceLock::new();
    KEYS.get_or_init(|| app.asset_resolver().iter().map(|(key, _)| key.trim_start_matches('/').to_string()).collect())
}

/// A system app's file: what is under `system/` (its pages) or `assets/` (what the pages share). **Never** the admin-app's
/// own page — Tauri's asset resolver answers an address it doesn't know with `index.html`, so the key is checked first.
fn serve_app_asset(app: &AppHandle, path: &str, csp: &str) -> Response<Vec<u8>> {
    let requested = path.trim_start_matches('/');
    let keys = app_asset_keys(app);
    let key = [requested.to_string(), format!("{}/index.html", requested.trim_end_matches('/'))]
        .into_iter()
        .find(|key| (key.starts_with("system/") || key.starts_with("assets/")) && keys.contains(key));
    match key.and_then(|key| app.asset_resolver().get(format!("/{key}"))) {
        Some(asset) => crate::respond(StatusCode::OK, &asset.mime_type, asset.bytes, csp),
        None => crate::respond_text(StatusCode::NOT_FOUND, "Not found", csp),
    }
}

/// The answer to a request the WebView of window `guid` makes. Only the window's own kind of origin is served (web apps: the
/// user origin; system apps: the frontend's) — anything else is refused, a second wall behind the CSP.
async fn serve(app: &AppHandle, guid: &str, url: &Url, meta: &crate::file_serving::RequestMeta) -> Response<Vec<u8>> {
    let path = percent_encoding::percent_decode_str(url.path()).decode_utf8_lossy().into_owned();
    let csp = crate::content_security_policy(app);

    // The bytes of an answer that is not json: fetched once, by the window it is for.
    if url.host_str() == Some(RAW_HOST) {
        let key = path.strip_prefix("/raw/").and_then(|k| k.parse::<u64>().ok());
        let taken = key.and_then(|key| {
            let mut state = state();
            match state.raw.get(&key) {
                Some((owner, _)) if owner == guid => state.raw.remove(&key).map(|(_, bytes)| bytes),
                _ => None,
            }
        });
        return match taken {
            Some(bytes) => Response::builder()
                .header(CONTENT_TYPE, "application/octet-stream")
                .header("Access-Control-Allow-Origin", "*")
                .body(bytes)
                .unwrap(),
            None => plain(StatusCode::NOT_FOUND, "Gone"),
        };
    }

    let Some(kind) = state().windows.get(guid).map(|w| w.page.kind) else {
        return crate::respond_text(StatusCode::NOT_FOUND, "That window is closed.", &csp);
    };
    // Our own script, on whichever origin the page is at.
    if path == window_scripts::SCRIPT_PATH && (window_host::is_user_url(url) || window_host::is_app_origin(url)) {
        return Response::builder()
            .header(CONTENT_TYPE, "text/javascript; charset=utf-8")
            .header("Content-Security-Policy", csp)
            .header("Cache-Control", "no-cache")
            .body(window_scripts::script().into_bytes())
            .unwrap();
    }
    let response = match kind {
        Kind::User if window_host::is_user_url(url) => crate::serve_user_path(app, &path, meta).await,
        Kind::System if window_host::is_app_origin(url) => serve_app_asset(app, &path, &csp),
        // A system app shows files of the user origin — a picture, a video, and a web page in a frame (Notes' User Action popup) —
        // but only as such: its CSP lets it load them as images, media and frames, never as a script of its own.
        Kind::System if window_host::is_user_url(url) => crate::serve_user_path(app, &path, meta).await,
        _ => crate::respond_text(StatusCode::FORBIDDEN, "Forbidden", &csp),
    };
    // Every page gets the bridge first in its head.
    let is_html = response.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|t| t.starts_with("text/html"));
    if is_html {
        let (parts, body) = response.into_parts();
        let html = window_scripts::with_script_in_head(&String::from_utf8_lossy(&body));
        return Response::from_parts(parts, html.into_bytes());
    }
    response
}
