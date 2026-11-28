import { invoke } from '@tauri-apps/api/core'

/** The name of the one shared JavaScript namespace object (`window.<name>`, default `"ayran"`) that lives
 * under `ayranGlobal.name` in `global_settings` — configurable only by the admin-app (`ayran_global.rs`'s own
 * `set_ayran_global_name`), but readable by any window through the generic `get_global_setting` (which has
 * no reserved-prefix check on the *read* side, only on `set_global_setting`'s own write side) — the same
 * "a dedicated wrapper, the bootstrap/page reads the identical key directly" shape `noteWebAppScroll.ts`
 * already uses for a different global setting. Not `get_ayran_global_name` itself: that command is
 * admin-only at the *capability* level (`admin.json`, `windows: ["main"]`), refused outright for any other
 * window — this reads the exact same stored value through the one path every other window actually has. */

const KEY = 'ayranGlobal.name'
const DEFAULT_NAME = 'ayran'

export async function getAyranGlobalName(): Promise<string> {
  const value = await invoke<string | null>('get_global_setting', { key: KEY })
  return value ?? DEFAULT_NAME
}
