//! Android only: how Rust calls into this app's own Kotlin helpers (`SecureKey.kt`,
//! `DeviceFiles.kt`) over JNI.
//!
//! Everything goes through the main webview's `jni_handle`, which runs a closure on
//! Android's UI thread with the JNI environment and the activity — the only place our
//! own classes and a `Context` can be reached from. Commands aren't on that thread, so
//! [`on_activity`] just waits for the closure's result.

use std::sync::{mpsc, OnceLock};
use std::time::Duration;

use jni::objects::{JClass, JObject, JValue};
use jni::JNIEnv;
use tauri::{AppHandle, Manager};

static APP: OnceLock<AppHandle> = OnceLock::new();

/// How long a helper may take (saving a large file is the slow case).
const HELPER_TIMEOUT: Duration = Duration::from_secs(120);

/// A defensive wait for the main window to be registered, for a caller early in startup. `lib.rs`'s `.setup()`
/// builds the main window *before* calling anything that can reach here (`secure_store`'s Android path, used to
/// decrypt the data-location pointer file) for exactly this reason — a call from earlier than that, before the
/// window existed, used to fail outright with "The main window isn't available", every time: `read_custom_dir`
/// treats every failure as "no custom folder set", so a configured custom folder was silently ignored at real
/// startup and `admin`/`user`/`files` were created under the *default* location regardless, live-reproduced and
/// confirmed by a debug build (waiting here, even for many seconds, never helped on its own — the window build
/// call itself hadn't run yet at the old call site). This wait stays as a safety net for any future caller this
/// early, not the fix itself; it costs nothing once the window is already there, which it now always is by the
/// time `.setup()` can reach this. `.setup()` runs off Android's UI thread (the window it waits for is attached
/// ON that thread, by `exec` below), so sleeping here doesn't hold that thread back.
const WINDOW_WAIT_TIMEOUT: Duration = Duration::from_secs(10);
const WINDOW_WAIT_STEP: Duration = Duration::from_millis(50);

pub fn init(app: AppHandle) {
    let _ = APP.set(app);
}

/// The app, once it is running (the windows' natives are called from Kotlin, which has no handle of its own).
pub fn app() -> Option<&'static AppHandle> {
    APP.get()
}

/// Runs `job` on Android's UI thread with the JNI environment and the activity, and
/// returns what it returned. A Java exception raised inside it is logged, cleared and
/// turned into an `Err`.
pub fn on_activity<T, F>(job: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut JNIEnv, &JObject) -> jni::errors::Result<T> + Send + 'static,
{
    let app = APP.get().ok_or("The Android bridge wasn't initialised.")?;
    let window = {
        let mut waited = Duration::ZERO;
        loop {
            if let Some(w) = app.get_webview_window(crate::window_host::MAIN_WINDOW_LABEL) {
                break w;
            }
            if waited >= WINDOW_WAIT_TIMEOUT {
                return Err("The main window isn't available.".to_string());
            }
            std::thread::sleep(WINDOW_WAIT_STEP);
            waited += WINDOW_WAIT_STEP;
        }
    };

    let (sender, receiver) = mpsc::channel();
    window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _webview| {
                let result = job(env, activity).map_err(|e| {
                    let _ = env.exception_describe();
                    let _ = env.exception_clear();
                    format!("Android: {e}")
                });
                let _ = sender.send(result);
            });
        })
        .map_err(|e| e.to_string())?;

    receiver.recv_timeout(HELPER_TIMEOUT).map_err(|_| "Android didn't answer in time.".to_string())?
}

/// Finds one of our own Kotlin classes. It has to go through the activity's class
/// loader: a plain `find_class` from a native thread only sees the system classes.
pub fn helper_class<'l>(env: &mut JNIEnv<'l>, activity: &JObject, class_name: &str) -> jni::errors::Result<JClass<'l>> {
    let loader = env.call_method(activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?.l()?;
    let name = env.new_string(class_name)?;
    Ok(env
        .call_method(&loader, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", &[JValue::Object(&name)])?
        .l()?
        .into())
}
