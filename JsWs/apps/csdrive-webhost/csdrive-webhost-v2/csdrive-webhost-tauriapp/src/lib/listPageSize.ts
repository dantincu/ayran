import { invoke } from '@tauri-apps/api/core'

/** One page-size setting shared by every paginated list in the app — the admin-app's Files and
 * Filen.io tabs and the Notes file manager — so changing it in any one changes it for all the
 * others. Stored in the app-owned `data.db`'s *global* settings (`get_global_setting`), which,
 * unlike `app_state`, every app sees, not just the one that wrote it. */

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]
export const DEFAULT_PAGE_SIZE = 25

const GLOBAL_PAGE_SIZE_KEY = 'listPageSize'

export async function getGlobalPageSize(): Promise<number> {
  const saved = Number(await invoke<string | null>('get_global_setting', { key: GLOBAL_PAGE_SIZE_KEY }))
  return PAGE_SIZE_OPTIONS.includes(saved) ? saved : DEFAULT_PAGE_SIZE
}

export async function setGlobalPageSize(size: number): Promise<void> {
  await invoke('set_global_setting', { key: GLOBAL_PAGE_SIZE_KEY, value: String(size) })
}
