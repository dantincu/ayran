//! Android only: how Rust calls into this app's own Kotlin helper (`SecureKey.kt`) over JNI.
//! Adapted from Ayran CsDrive WebHost's `android_jni.rs`.
//!
//! Everything goes through the main webview's `jni_handle`, which runs a closure on Android's UI
//! thread with the JNI environment and the activity — the only place our own classes and a
//! `Context` can be reached from. Commands aren't on that thread, so [`on_activity`] waits for the
//! closure's result. (It must therefore never be called *from* the UI thread.)

use std::sync::{mpsc, OnceLock};
use std::time::Duration;

use jni::objects::{JClass, JObject, JValue};
use jni::JNIEnv;
use tauri::{AppHandle, Manager};

static APP: OnceLock<AppHandle> = OnceLock::new();

const HELPER_TIMEOUT: Duration = Duration::from_secs(30);
/// A caller early in startup may come before the main window is registered.
const WINDOW_WAIT_TIMEOUT: Duration = Duration::from_secs(10);
const WINDOW_WAIT_STEP: Duration = Duration::from_millis(50);

pub fn init(app: AppHandle) {
    let _ = APP.set(app);
}

/// Runs `job` on Android's UI thread with the JNI environment and the activity, and returns what it
/// returned. A Java exception raised inside it is logged, cleared and turned into an `Err`.
pub fn on_activity<T, F>(job: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut JNIEnv, &JObject) -> jni::errors::Result<T> + Send + 'static,
{
    let app = APP.get().ok_or("The Android bridge wasn't initialised.")?;
    let window = {
        let mut waited = Duration::ZERO;
        loop {
            if let Some(w) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) {
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

/// Finds one of our own Kotlin classes. It has to go through the activity's class loader: a plain
/// `find_class` from a native thread only sees the system classes.
pub fn helper_class<'l>(env: &mut JNIEnv<'l>, activity: &JObject, class_name: &str) -> jni::errors::Result<JClass<'l>> {
    let loader = env.call_method(activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?.l()?;
    let name = env.new_string(class_name)?;
    Ok(env
        .call_method(&loader, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", &[JValue::Object(&name)])?
        .l()?
        .into())
}
