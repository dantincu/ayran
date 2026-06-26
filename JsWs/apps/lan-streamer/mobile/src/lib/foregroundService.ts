import { invoke } from "@tauri-apps/api/core";

/**
 * Starts/stops the native Android foreground service that keeps
 * hosting/listening alive with the screen off or the app backgrounded (see
 * src-tauri/src/foreground_service.rs and the Kotlin service it calls into).
 * No-ops on non-Android targets.
 */
// "hosting-microphone" requests the Android foreground-service-type
// "microphone", which the OS only allows once RECORD_AUDIO has actually been
// granted - callers must only call this *after* mic capture has already
// succeeded (proving the permission is granted), not before requesting it.
export function startForegroundService(role: "hosting-microphone" | "hosting-test-tone" | "listening"): Promise<void> {
  return invoke("start_foreground_service", { role });
}

export function stopForegroundService(): Promise<void> {
  return invoke("stop_foreground_service");
}
