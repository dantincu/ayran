import { getAppState, setAppState } from './appState'

/** One page-size setting shared by every paginated list in the app (Files,
 * Filen.io, ...) — changing it in any one list changes it for all the others,
 * persisted in the same app-owned `data.db` as the rest of this app's own
 * state (see `appState.ts`), not per-list. */

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]
export const DEFAULT_PAGE_SIZE = 25

const GLOBAL_PAGE_SIZE_KEY = 'global.listPageSize'

export async function getGlobalPageSize(): Promise<number> {
  const saved = await getAppState<number>(GLOBAL_PAGE_SIZE_KEY)
  return saved && PAGE_SIZE_OPTIONS.includes(saved) ? saved : DEFAULT_PAGE_SIZE
}

export async function setGlobalPageSize(size: number): Promise<void> {
  await setAppState(GLOBAL_PAGE_SIZE_KEY, size)
}
