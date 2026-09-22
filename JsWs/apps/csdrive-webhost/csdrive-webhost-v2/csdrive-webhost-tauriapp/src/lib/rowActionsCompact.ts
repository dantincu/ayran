import { invoke } from '@tauri-apps/api/core'

/** Whether every list's per-row icon buttons collapse into one "more actions" (⋯) button instead of
 * showing inline — one setting for the whole app (`RowActions.tsx` is what reads it), like the list page
 * size (`listPageSize.ts`). Off by default: buttons show inline exactly as they always have. Stored in the
 * app-owned `data.db`'s *global* settings (`get_global_setting`), which every app sees, not just the one
 * that wrote it — so switching it on in Settings collapses it everywhere, Notes included. */

const KEY = 'rowActionsCompact'
let cached: boolean | null = null
const listeners = new Set<(value: boolean) => void>()

export async function getRowActionsCompact(): Promise<boolean> {
  if (cached === null) cached = (await invoke<string | null>('get_global_setting', { key: KEY })) === '1'
  return cached
}

export async function setRowActionsCompact(value: boolean): Promise<void> {
  cached = value
  await invoke('set_global_setting', { key: KEY, value: value ? '1' : '0' })
  for (const listener of listeners) listener(value)
}

/** Calls `listener` once the current value has loaded, and again whenever it changes in this window
 * (`setRowActionsCompact`, e.g. from Settings). Returns a function that stops listening. */
export function subscribeRowActionsCompact(listener: (value: boolean) => void): () => void {
  listeners.add(listener)
  void getRowActionsCompact().then(listener)
  return () => {
    listeners.delete(listener)
  }
}
