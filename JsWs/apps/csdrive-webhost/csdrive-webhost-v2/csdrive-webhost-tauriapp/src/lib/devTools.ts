import { useEffect, useState } from 'react'
import { getAppState, setAppState } from './appState'

/** Whether the admin-app shows its Dev Tools tab (Settings → "Advanced") — a pure UI-visibility toggle of the
 * admin-app's own, so it's kept in the admin-app's own app state (`appState.ts`, the same place `activeTab`
 * and every tab page's own navigation already live), not `global_settings`, which is for preferences every
 * *app* shares (Notes included) — this one only ever needs to be seen by the admin-app itself. Off by
 * default: the tab, and everything behind it (the Logs page), stays out of the way until asked for.
 *
 * **A module-level cache and listener set, the same shape as `rowActionsCompact.ts`/`listPageSize.ts`** —
 * not a plain per-component `useState` reading `appState` once on mount: `SettingsTab` (the checkbox) and
 * `App.tsx` (the tab bar itself) are two different components each needing their *own* up-to-date read of
 * this value, and a plain `useState` in each would only update the one that made the change — found live,
 * checking the checkbox in Settings never made the tab appear, because `App.tsx`'s own separate `useState`
 * had no way to learn the value had changed. `setDevToolsEnabled` notifies every subscriber in this window
 * synchronously, the same fix `subscribeRowActionsCompact` already models. */
const KEY = 'settings.devToolsEnabled'
let cached: boolean | null = null
const listeners = new Set<(value: boolean) => void>()

export async function getDevToolsEnabled(): Promise<boolean> {
  if (cached === null) cached = (await getAppState<boolean>(KEY)) === true
  return cached
}

export async function setDevToolsEnabled(value: boolean): Promise<void> {
  cached = value
  await setAppState(KEY, value)
  for (const listener of listeners) listener(value)
}

/** Calls `listener` once the current value has loaded, and again whenever it changes in this window. Returns
 * a function that stops listening. */
export function subscribeDevToolsEnabled(listener: (value: boolean) => void): () => void {
  listeners.add(listener)
  void getDevToolsEnabled().then(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useDevToolsEnabled(): { enabled: boolean; setEnabled: (value: boolean) => void } {
  const [enabled, setEnabledState] = useState(false)
  useEffect(() => subscribeDevToolsEnabled(setEnabledState), [])
  return { enabled, setEnabled: (value) => setDevToolsEnabled(value).catch(() => {}) }
}
