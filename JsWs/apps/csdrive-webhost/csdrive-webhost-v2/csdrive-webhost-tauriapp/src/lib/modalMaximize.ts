/** Whether a popup (`components/Modal.tsx`) was last left maximized — one of the app's own app-state entries
 * (`appState.ts`, not `global_settings`: a modal's own identity, its `title`, only makes sense within the app
 * that shows it, so this is naturally per-app like everything else there), so a dialog that was maximized
 * last time starts maximized again — asked for directly. Keyed by the dialog's own `title` (the one thing
 * every `Modal` already has and is usually distinct per *kind* of dialog — "New note…", "Go to a path…" — not
 * a separate id nothing else needed). */

import { getAppState, setAppState } from './appState'

const KEY = 'modalMaximized'

let cache: Record<string, boolean> = {}
// Kicked off at module load — well before a click could possibly open a modal — so `modalWasMaximized`
// almost never actually has to wait on it in practice; awaited anyway for the one cold case it might.
const ready: Promise<void> = getAppState<Record<string, boolean>>(KEY).then(
  (v) => {
    cache = v ?? {}
  },
  () => {},
)

export async function modalWasMaximized(title: string): Promise<boolean> {
  await ready
  return cache[title] === true
}

export function setModalMaximized(title: string, maximized: boolean): void {
  cache = { ...cache, [title]: maximized }
  void setAppState(KEY, cache).catch(() => {})
}
