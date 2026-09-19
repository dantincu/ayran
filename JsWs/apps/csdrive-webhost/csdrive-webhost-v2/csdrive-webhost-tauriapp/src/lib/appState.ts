/** Small key/value store for persisting UI state (active tab, last-browsed folder,
 * collapsed groups, ...) across app restarts — backed by the app's own `data.db`
 * (via the generic `app_state` table), *not* browser storage.
 *
 * Why not IndexedDB/localStorage: this app supports relocating its whole data
 * folder (see the Settings tab) as a way to switch between profiles for testing —
 * but browser storage lives in the fixed WebView2 profile, not the data folder, so
 * switching folders never actually gave you a fresh UI-state profile. Storing state
 * in `data.db` instead means it moves (or doesn't) exactly when the rest of the
 * app's data does.
 *
 * Rows are namespaced per app — by the calling window's own html file relative path
 * (e.g. `index.html`), which the *backend* works out from the window itself, so an
 * app can only ever reach its own state — so the same app keeps separate state when
 * deployed at more than one location, and multiple apps sharing this one database
 * never collide. See csdrive-webhost-v2/CLAUDE.md for the full rule. */

import { invoke } from '@tauri-apps/api/core'

export async function getAppState<T>(key: string): Promise<T | undefined> {
  const raw = await invoke<string | null>('get_app_state', { key })
  if (raw == null) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

export async function setAppState<T>(key: string, value: T): Promise<void> {
  await invoke('set_app_state', { key, value: JSON.stringify(value) })
}
