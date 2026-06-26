// Keeps hosting/listening alive with the screen off or the app backgrounded
// by starting/stopping a native Android foreground service - see
// gen/android/app/src/main/java/io/ayran/lanstreamer/mobile/StreamingForegroundService.kt
// for what it actually does (notification + wake lock). This file is just
// the JNI bridge calling its two static entry points from Rust.

#[cfg(target_os = "android")]
fn call_service_method(method: &str, sig: &str, role: Option<&str>) -> Result<(), String> {
    use jni::objects::{JObject, JValue};
    use jni::JavaVM;

    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };

    let role_jstring = role.map(|r| env.new_string(r)).transpose().map_err(|e| e.to_string())?;
    let mut args: Vec<JValue> = vec![JValue::Object(&context)];
    if let Some(role_jstring) = &role_jstring {
        args.push(JValue::Object(role_jstring));
    }

    env.call_static_method(
        "io/ayran/lanstreamer/mobile/StreamingForegroundService",
        method,
        sig,
        &args,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn start_foreground_service(role: String) -> Result<(), String> {
    call_service_method("start", "(Landroid/content/Context;Ljava/lang/String;)V", Some(&role))
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn stop_foreground_service() -> Result<(), String> {
    call_service_method("stop", "(Landroid/content/Context;)V", None)
}

// Only Android suspends background apps aggressively enough to need this -
// other mobile targets (iOS) and any non-mobile build just no-op.
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn start_foreground_service(_role: String) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn stop_foreground_service() -> Result<(), String> {
    Ok(())
}
