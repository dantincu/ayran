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

/** `fallback`, when given, replaces the plain resource-type value as what a notebook that has no size of its
 * own for this type falls through to — used by a page that also has its own per-page level (below) sitting
 * between the notebook and the resource type, so a notebook without its own override still prefers that
 * page's own default over the generic cross-app one. Omitted, this is exactly today's behaviour. */
export async function getNotebookPageSize(notebookKey: string, type: ListResourceType, fallback?: () => Promise<number>): Promise<number> {
  const map = (await getAppState<Record<string, number>>(NOTEBOOK_PAGE_SIZE_KEY).catch(() => undefined)) ?? {}
  const saved = map[notebookPageSizeMapKey(notebookKey, type)]
  return PAGE_SIZE_OPTIONS.includes(saved) ? saved : fallback ? fallback() : getResourceTypePageSize(type)
}

export async function setNotebookPageSize(notebookKey: string, type: ListResourceType, size: number): Promise<void> {
  const map = (await getAppState<Record<string, number>>(NOTEBOOK_PAGE_SIZE_KEY).catch(() => undefined)) ?? {}
  map[notebookPageSizeMapKey(notebookKey, type)] = size
  await setAppState(NOTEBOOK_PAGE_SIZE_KEY, map)
}

/** Which distinct *page or modal* is showing the listing — asked for directly: "preserve the page size on
 * per location... not just resource type," then clarified once the first attempt (above, keyed by the exact
 * folder/account/branch being browsed) turned out to be the wrong axis: "by location I meant pages/modals in
 * our app, not differences in resource identifier of the same resource type." So this is **not** about
 * *where* a listing is pointed (that's the resource-type/notebook levels above, untouched); it's about
 * *which UI surface* is showing it — the Files tab, the Filen.io tab, Notes' File Manager, the Note Files
 * Explorer, "Insert a path…", "Add a notebook…"'s own folder picker, "Create image from the clipboard…",
 * "Insert custom text at the caret…" — each remembers its own choice, independent of every other one, even
 * though more than one of them lists the very same kind of thing. A page id is a short, arbitrary string
 * private to the one component that picks it (`PAGE_IDS` below is where every one in use is listed, so a new
 * page/modal with its own pagination picks an unused id from the same place). **One flat map, in
 * `global_settings`** — not split by resource type or by app, unlike the two levels above: nothing outside
 * the one component that owns a given id ever reads or writes it, so there is no cross-app-confusion risk of
 * the kind that split "files" from "notes" in the first place; keeping it to one map is simpler, and matches
 * this module's own established shape for "yet one more fallback tier" (compare the notebook level's own map,
 * keyed by notebook+type, in one place rather than per notebook).
 *
 * **Falls back to whatever the caller already used before this level existed** — the one thing that matters
 * for continuity: a page that already had its own resource-type-level value (the Files/Filen.io tabs, Notes'
 * File Manager outside a notebook) keeps showing it until its own page-level override is actually set; a
 * one-off picker that was deliberately left on the plain global value (`FileExplorerModal`,
 * `InsertPathModal`'s own "notes" mode, `LocationPicker`, "Create image from the clipboard…", "Insert custom
 * text at the caret…") keeps falling to *that*, not suddenly inheriting whatever the resource-type split
 * settled on — each caller passes its own `fallback` for exactly this reason, rather than this module
 * guessing which broader level, if any, used to apply. */
export const PAGE_IDS = {
  filesTab: 'files-tab',
  filenTab: 'filen-tab',
  notesFileManager: 'notes-file-manager',
  noteFilesExplorer: 'note-files-explorer',
  filesTabInsertPath: 'files-tab-insert-path',
  notesInsertPathFiles: 'notes-insert-path-files',
  notesInsertPathNotes: 'notes-insert-path-notes',
  notesLocationPicker: 'notes-location-picker',
  notesCreateImageFromClipboard: 'notes-create-image-from-clipboard',
  notesInsertCustomText: 'notes-insert-custom-text',
} as const

const PAGE_PAGE_SIZE_KEY = 'listPageSize.byPage'

async function readPageMap(): Promise<Record<string, number>> {
  const raw = await invoke<string | null>('get_global_setting', { key: PAGE_PAGE_SIZE_KEY })
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, number>
  } catch {
    return {}
  }
}

export async function getPagePageSize(pageId: string, fallback: () => Promise<number>): Promise<number> {
  const map = await readPageMap()
  const saved = map[pageId]
  return PAGE_SIZE_OPTIONS.includes(saved) ? saved : fallback()
}

export async function setPagePageSize(pageId: string, size: number): Promise<void> {
  const map = await readPageMap()
  map[pageId] = size
  await invoke('set_global_setting', { key: PAGE_PAGE_SIZE_KEY, value: JSON.stringify(map) })
}
