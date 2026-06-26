import { invoke } from "@tauri-apps/api/core";

/**
 * Starts/stops the native Android foreground service that keeps
 * hosting/listening alive with the screen off or the app backgrounded (see
 * src-tauri/src/foreground_service.rs and the Kotlin service it calls into).
 * No-ops on non-Android targets.
 */
export function startForegroundService(role: "hosting" | "listening"): Promise<void> {
  return invoke("start_foreground_service", { role });
}

export function stopForegroundService(): Promise<void> {
  return invoke("stop_foreground_service");
}
