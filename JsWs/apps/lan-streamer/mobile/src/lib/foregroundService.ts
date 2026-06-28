import { invoke } from "@tauri-apps/api/core";

type Role = "hosting-microphone" | "hosting-test-tone" | "listening";

/**
 * Starts/stops the native Android foreground service that keeps
 * hosting/listening alive with the screen off or the app backgrounded (see
 * src-tauri/src/foreground_service.rs and the Kotlin service it calls into).
 * No-ops on non-Android targets.
 *
 * Reference-counted by caller key ("host"/"listen") rather than a plain
 * start/stop, since hosting and listening can now both be active at once
 * (HostPanel/ListenerPanel are both mounted simultaneously) - without this,
 * stopping just one of the two would tear down the single underlying
 * service and silently kill the other's background survival too.
 */
const activeRoles = new Map<string, Role>();

function representativeRole(): Role {
  const roles = [...activeRoles.values()];
  // The "microphone" foreground-service-type is the only one with an extra
  // permission requirement, so once granted, prefer reporting it while
  // it's still in play - dropping to "listening"/"hosting-test-tone" and
  // back doesn't change anything functionally, just notification wording.
  if (roles.includes("hosting-microphone")) return "hosting-microphone";
  if (roles.includes("hosting-test-tone")) return "hosting-test-tone";
  return "listening";
}

// "hosting-microphone" requests the Android foreground-service-type
// "microphone", which the OS only allows once RECORD_AUDIO has actually been
// granted - callers must only call this *after* mic capture has already
// succeeded (proving the permission is granted), not before requesting it.
export function startForegroundService(key: "host" | "listen", role: Role): Promise<void> {
  activeRoles.set(key, role);
  return invoke("start_foreground_service", { role: representativeRole() });
}

export function stopForegroundService(key: "host" | "listen"): Promise<void> {
  activeRoles.delete(key);
  if (activeRoles.size === 0) {
    return invoke("stop_foreground_service");
  }
  return invoke("start_foreground_service", { role: representativeRole() });
}
