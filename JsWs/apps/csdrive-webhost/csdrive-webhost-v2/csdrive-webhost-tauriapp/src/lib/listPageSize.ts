import { invoke } from '@tauri-apps/api/core'
import { getAppState, setAppState } from './appState'

/** One page-size setting shared by every paginated list in the app — the admin-app's Files and
 * Filen.io tabs and the Notes file manager — so changing it in any one changes it for all the
 * others. Stored in the app-owned `data.db`'s *global* settings (`get_global_setting`), which,
 * unlike `app_state`, every app sees, not just the one that wrote it.
 *
 * **Kept exactly as it was, for the one-off "pick a file" dialogs that haven't moved to the
 * resource-type split below** — `components/FileExplorerModal.tsx`, `system/notes/InsertPathModal.tsx`
 * (its generic "Files" mode, and its own "Notes" mode's notebooks/notes picking lists) and
 * `system/notes/LocationPicker.tsx`. Those are transient pickers a person opens, uses once and closes,
 * not a page they sit and browse repeatedly the way the File Manager or a notebook's own notes list
 * are — splitting *their* page size by resource type or by notebook wasn't judged worth the extra
 * dimension for something shown for a few seconds at a time. `getResourceTypePageSize('files')` below
 * falls back to this same value, so an existing preference carries over rather than resetting. */
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

/** The two kinds of thing a paginated list in this app ever shows (asked for directly: "do we have other
 * resource types?") — a plain file/folder listing (the admin-app's Files and Filen.io tabs, Notes' own File
 * Manager and Note Files Explorer) or a notebook's own notes (its children list's search results — the
 * plain, un-searched list has no pagination of its own at all yet, see `NotePage.tsx`). **Not a third type
 * for "the list of notebooks themselves"**: `InsertPathModal.tsx`'s own notebook-picking sub-mode is one of
 * the untouched one-off pickers above, and `NotebooksPage.tsx` ("Manage notebooks") has no pagination to
 * begin with — so there is nowhere a notebooks-list page size would currently apply to. */
export type ListResourceType = 'files' | 'notes'

/** A resource type's own page size, shared by every app that lists that kind of thing — but kept apart from
 * the *other* type's, so a person who wants a notebook's notes shown 10 at a time doesn't also get 10 files
 * per page in the File Manager, and vice versa. **"files" is kept in `global_settings`**, the same as the
 * plain shared value above — every app that lists files (Files, Filen.io, Notes' own File Manager) sees it.
 * **"notes" is kept in Notes' own `app_state` instead** — no other app ever lists notes, so putting it in
 * `global_settings` would mean nothing to anyone but Notes, the same "a Notes-only concept doesn't belong in
 * what every app sees" rule the per-notebook override below already follows. **Both fall back to the plain
 * shared value above**, not straight to the hardcoded default, so an existing preference (set before this
 * split existed, when "files" and "notes" shared the one value) carries over the first time either is read,
 * rather than silently resetting to 25. */
const FILES_PAGE_SIZE_KEY = 'listPageSize.files'
const NOTES_PAGE_SIZE_KEY = 'notes.pageSize.notes'

export async function getResourceTypePageSize(type: ListResourceType): Promise<number> {
  if (type === 'files') {
    const saved = Number(await invoke<string | null>('get_global_setting', { key: FILES_PAGE_SIZE_KEY }))
    return PAGE_SIZE_OPTIONS.includes(saved) ? saved : getGlobalPageSize()
  }
  const saved = await getAppState<number>(NOTES_PAGE_SIZE_KEY).catch(() => undefined)
  return saved !== undefined && PAGE_SIZE_OPTIONS.includes(saved) ? saved : getGlobalPageSize()
}

export async function setResourceTypePageSize(type: ListResourceType, size: number): Promise<void> {
  if (type === 'files') await invoke('set_global_setting', { key: FILES_PAGE_SIZE_KEY, value: String(size) })
  else await setAppState(NOTES_PAGE_SIZE_KEY, size)
}

/** A notebook's own page size, kept apart from the shared one above and now further split by resource type
 * (a notebook's own files and its own notes are shown through two completely different pages — the File
 * Manager browsing its raw folder tree, `NotePage.tsx` listing its notes — so a notebook kept a certain way
 * can want a different page size for each): while browsing or searching *inside* a listed notebook, the page
 * size is this notebook's own choice for *that* resource type instead of the one every other listing of that
 * same type shares — changing it here never touches what Files/Filen.io/every other notebook, or this same
 * notebook's *other* resource type, use. Stored in Notes' own `app_state` (never `global_settings`, which
 * every app sees — a notebook is a Notes-only concept) as one map, keyed by the notebook's own `entryKey`
 * (its location, not its GUID — see `notebooks.ts`'s own reasoning for why location is the identity and two
 * entries can share a GUID) **and** the resource type, so the two kinds of listing a notebook can show never
 * share one slot. **Falls back to that resource type's own shared page size**, not the hardcoded default,
 * until the notebook has had one of its own actually set for that type — the person's usual preference for
 * that kind of listing is the more useful first guess than an arbitrary 25. */
const NOTEBOOK_PAGE_SIZE_KEY = 'notes.pageSizeByNotebook'

function notebookPageSizeMapKey(notebookKey: string, type: ListResourceType): string {
  return `${notebookKey}:${type}`
}

export async function getNotebookPageSize(notebookKey: string, type: ListResourceType): Promise<number> {
  const map = (await getAppState<Record<string, number>>(NOTEBOOK_PAGE_SIZE_KEY).catch(() => undefined)) ?? {}
  const saved = map[notebookPageSizeMapKey(notebookKey, type)]
  return PAGE_SIZE_OPTIONS.includes(saved) ? saved : getResourceTypePageSize(type)
}

export async function setNotebookPageSize(notebookKey: string, type: ListResourceType, size: number): Promise<void> {
  const map = (await getAppState<Record<string, number>>(NOTEBOOK_PAGE_SIZE_KEY).catch(() => undefined)) ?? {}
  map[notebookPageSizeMapKey(notebookKey, type)] = size
  await setAppState(NOTEBOOK_PAGE_SIZE_KEY, map)
}
