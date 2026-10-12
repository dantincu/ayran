import { getAppState, setAppState } from '../../lib/appState'
import { joinRelative } from '../../lib/localFs'
import type { FileRoot } from '../../lib/fileRoots'
import {
  FILEN_PREFIX,
  LOCAL_PREFIX,
  filenSource,
  localSource,
  type Entry,
  type FileSource,
  type FilenAccountInfo,
} from './sources'
import {
  isNotebookFileName,
  newNotebookFile,
  notebookFileNameFor,
  parseNotebookFile,
  serializeNotebookFile,
  withTitle,
  type ParsedNotebookFile,
} from './notebookFile'

/** The Notes app's notebooks (see `docs/strategies/notes-strategy.md`). A notebook *is* its `[note-book].json` file — its
 * folder is the notebook's root — and the app keeps only **a list of the ones it knows about**, with where each is: the
 * list is this app's (in its own state, `data.db`), the notebook is wherever its file is. A notebook is **listed** when it
 * is in that list, and merely **found** when its file exists on this device or in a Filen account and the app hasn't
 * been told about it — the two are told apart by the notebook's GUID (`NoteBookGuid`, kept in the file). */

/** One notebook in the list — a traditional, **file-based** one (a `[note-book].json`, `guid`/`title`/`fileName` all
 * present) or a **folder-as-notebook** (below): a folder the person chose to treat as a notebook's root directly,
 * with no file written into it and no internal folder pair (`03`) created just to list it — asked for directly
 * ("without the notebook json file or the internal notebook folder pair"), for a folder already used for notes some
 * other way, or one the person doesn't want to leave a marker file in. **Which kind an entry is isn't a separate
 * flag — it's exactly whether `fileName` is present** (`isFolderNotebook`, below): a folder-as-notebook has no file
 * at all, so there is nothing for `guid`/`title`/`fileName` to hold, and the entry is identified purely by its
 * `sourceId`/`folder` (the person's own words: "identified by the root and the relative path"), the one thing it
 * actually has. Its displayed name is its own relative path, shown fresh every time (`notebookTitle`), never a
 * separately stored title — there's no file to keep one in step with, and the path *is* the identity, so showing
 * it directly can't drift from what the entry actually names. */
export interface NotebookEntry {
  /** The notebook's GUID, canonical (see `normalizeGuid`) — what makes it the same notebook wherever it is found.
   * Absent for a folder-as-notebook: there's no file to keep one in. */
  guid?: string
  /** The title as last seen in the file (the file is the truth; this is for showing the list without reading them).
   * Absent for a folder-as-notebook — see `notebookTitle` for what is shown instead. */
  title?: string
  /** `local:user`, `local:<picked folder's root id>` or `filen:<userId>` — never a branch: a notebook lives in the account. */
  sourceId: string
  /** The notebook's root folder, relative to the source's root; `''` is the root itself. */
  folder: string
  /** The notebook file's name in that folder (it is or ends with `[note-book].json`). **Its absence is what makes
   * this entry a folder-as-notebook** — not a separate flag, since whether a file exists is exactly what decides it. */
  fileName?: string
  addedAt: number
}

/** A folder the person chose to treat as a notebook directly, with no `[note-book].json` file and no `guid` —
 * told apart from a file-based entry by `fileName`'s own absence, which is the one thing that actually differs
 * between the two shapes (see `NotebookEntry`'s own doc comment). */
export function isFolderNotebook(entry: NotebookEntry): boolean {
  return entry.fileName === undefined
}

/** What to show as a notebook's name: the file's own title for a file-based entry, or the entry's relative path
 * for a folder-as-notebook (asked for directly, in preference to a separately stored title or just the folder's
 * last name part — the full path is what actually identifies it, and never drifts from what the entry names). */
export function notebookTitle(entry: NotebookEntry): string {
  if (!isFolderNotebook(entry)) return entry.title!
  return entry.folder === '' ? '(the whole folder)' : `/${entry.folder}`
}

const NOTEBOOKS_KEY = 'notes.notebooks'

/** The identity of a *listed* entry: where it is. Two listed entries can share a GUID — the same notebook file
 * copied (by the person, outside the app) to another location and added again — but never this: the list can
 * hold at most one entry at a given `sourceId`/`folder`/`fileName` (`addExistingNotebook` treats a second add at
 * the same location as "already listed", not a duplicate). Use this wherever `guid` alone used to key a single
 * listed entry (a `Record`'s key, a React list `key`) and no longer can, now that it isn't list-wide unique. */
export function entryKey(entry: NotebookEntry): string {
  return `${entry.sourceId}|${entry.folder}|${entry.fileName ?? ''}`
}

function sameLocation(a: NotebookEntry, b: NotebookEntry): boolean {
  return a.sourceId === b.sourceId && a.folder === b.folder && (a.fileName ?? '') === (b.fileName ?? '')
}

function isEntry(value: unknown): value is NotebookEntry {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  if (typeof e.sourceId !== 'string' || typeof e.folder !== 'string' || typeof e.addedAt !== 'number') return false
  // A folder-as-notebook has none of these three; a file-based one has all three — never some but not others.
  if (e.fileName === undefined) return e.guid === undefined && e.title === undefined
  return typeof e.guid === 'string' && typeof e.title === 'string' && typeof e.fileName === 'string'
}

/** The listed notebooks, in the order they were added. What was saved is checked before it is used. */
export async function loadNotebooks(): Promise<NotebookEntry[]> {
  const saved = await getAppState<unknown>(NOTEBOOKS_KEY).catch(() => undefined)
  return Array.isArray(saved) ? saved.filter(isEntry) : []
}

async function saveNotebooks(list: NotebookEntry[]): Promise<void> {
  await setAppState(NOTEBOOKS_KEY, list)
}

/** Changes the list as `change` says and saves it — reading it fresh first, so another Notes window's changes aren't lost. */
export async function updateNotebooks(change: (list: NotebookEntry[]) => NotebookEntry[]): Promise<NotebookEntry[]> {
  const next = change(await loadNotebooks())
  await saveNotebooks(next)
  return next
}

/** The source (a folder on this device, or a Filen account) a notebook entry names, if it is still there. */
export function resolveSource(sourceId: string, roots: FileRoot[], accounts: FilenAccountInfo[]): FileSource | null {
  if (sourceId.startsWith(FILEN_PREFIX)) {
    const account = accounts.find((a) => `${FILEN_PREFIX}${a.userId}` === sourceId)
    return account ? filenSource(account, null) : null
  }
  const root = roots.find((r) => `${LOCAL_PREFIX}${r.id}` === sourceId)
  return root ? localSource(root) : null
}

/** Where a notebook is, for showing a person: `user · /notes/work · [note-book].json` for a file-based notebook,
 * or `user · /notes/work` for a folder-as-notebook — it has no file of its own to name. */
export function describeLocation(entry: NotebookEntry, roots: FileRoot[], accounts: FilenAccountInfo[]): string {
  const source = resolveSource(entry.sourceId, roots, accounts)
  const where = source ? source.label : entry.sourceId.startsWith(FILEN_PREFIX) ? 'a Filen account that isn\'t connected' : 'a folder that isn\'t on the list of folders'
  const place = `${where} · /${entry.folder}`
  return entry.fileName !== undefined ? `${place} · ${entry.fileName}` : place
}

const decoder = new TextDecoder('utf-8')

/** Reads and checks a notebook file. Throws when it can't be read (the message says why). */
export async function readNotebookFile(source: FileSource, folder: string, fileName: string): Promise<ParsedNotebookFile> {
  const bytes = await source.read(joinRelative(folder, fileName))
  return parseNotebookFile(decoder.decode(bytes))
}

/** The names of the notebook files (a name that is or ends with `[note-book].json`) among a folder's entries. */
export function notebookFilesIn(entries: Entry[]): string[] {
  return entries.filter((e) => !e.isDirectory && isNotebookFileName(e.name)).map((e) => e.name)
}

/** What a folder's notebook files hold — for warning a person that the folder already has a notebook. A file that can't
 * be read or isn't a notebook is still reported (by name), with no title. */
export async function describeNotebookFilesIn(source: FileSource, folder: string, names: string[]): Promise<{ name: string; title: string | null }[]> {
  return Promise.all(
    names.map(async (name) => {
      try {
        const read = await readNotebookFile(source, folder, name)
        return { name, title: read.ok ? read.notebook.Title : null }
      } catch {
        return { name, title: null }
      }
    }),
  )
}

/** Creates a notebook: writes its file into `folder` (which must exist) under a name that overwrites nothing, and lists
 * it. Nothing else is written. */
export async function createNotebook(source: FileSource, folder: string, title: string): Promise<NotebookEntry> {
  const { entries } = await source.list(folder)
  const fileName = notebookFileNameFor(title, entries.map((e) => e.name))
  const file = newNotebookFile(title)
  await source.write(joinRelative(folder, fileName), new TextEncoder().encode(serializeNotebookFile({ ...file })))
  const entry: NotebookEntry = { guid: file.NoteBookGuid, title: file.Title, sourceId: source.id, folder, fileName, addedAt: Date.now() }
  await updateNotebooks((list) => [...list.filter((n) => n.guid !== entry.guid), entry])
  return entry
}

export type AddResult =
  | { status: 'added'; entry: NotebookEntry; /** Other listed entries that share this one's GUID — a copy of
      the same notebook file, added from another location. Informational only: adding it is never refused for
      this. */ sameGuidAs: NotebookEntry[] }
  /** The exact location (source, folder and file name) was in the list already; `entry` is the listed one,
   * brought up to date. A *different* location whose file happens to share a GUID with a listed entry is not
   * this — it is `added`, with that entry named in `sameGuidAs` (see "Notebooks" in CLAUDE.md). */
  | { status: 'already-listed'; entry: NotebookEntry }
  | { status: 'not-a-notebook'; reason: string }

/** Adds a notebook that exists but isn't listed at this exact location: reads its file, and lists it — unless
 * this exact `source`/`folder`/`fileName` is listed already. A notebook file copied to more than one place (the
 * same GUID at a different location) is allowed and listed as its own, separate entry — only the same location
 * twice is "already listed". */
export async function addExistingNotebook(source: FileSource, folder: string, fileName: string): Promise<AddResult> {
  const read = await readNotebookFile(source, folder, fileName)
  if (!read.ok) return { status: 'not-a-notebook', reason: read.reason }
  const fresh: NotebookEntry = { guid: read.guid, title: read.notebook.Title, sourceId: source.id, folder, fileName, addedAt: Date.now() }
  let result: AddResult = { status: 'added', entry: fresh, sameGuidAs: [] }
  await updateNotebooks((list) => {
    const here = list.find((n) => sameLocation(n, fresh))
    if (here) {
      const updated: NotebookEntry = { ...here, title: fresh.title }
      result = { status: 'already-listed', entry: updated }
      return list.map((n) => (n === here ? updated : n))
    }
    result = { status: 'added', entry: fresh, sameGuidAs: list.filter((n) => n.guid === fresh.guid) }
    return [...list, fresh]
  })
  return result
}

/** Lists a folder directly as a notebook: no file is written, no `guid` exists, nothing is created in the folder
 * at all — asked for directly ("without the notebook json file or the internal notebook folder pair"). Refused
 * (as `already-listed`) only for the exact same `sourceId`/`folder` already listed this same, file-less way; a
 * *file-based* notebook already at this folder is a different entry (a different `fileName`, so a different
 * `entryKey`) and doesn't conflict — both can be listed, same as a notebook file copied elsewhere already can. */
export async function addFolderNotebook(source: FileSource, folder: string): Promise<AddResult> {
  const fresh: NotebookEntry = { sourceId: source.id, folder, addedAt: Date.now() }
  let result: AddResult = { status: 'added', entry: fresh, sameGuidAs: [] }
  await updateNotebooks((list) => {
    const here = list.find((n) => sameLocation(n, fresh))
    if (here) {
      result = { status: 'already-listed', entry: here }
      return list
    }
    result = { status: 'added', entry: fresh, sameGuidAs: [] }
    return [...list, fresh]
  })
  return result
}

/** Gives a listed notebook a new title: in its file first (every other key of the file kept), then in the list. Throws —
 * with the list unchanged — when the file can't be read, isn't a notebook's or can't be written. A folder-as-notebook
 * has no file and no stored title to change (its name is always its own path, see `notebookTitle`) — never reachable
 * from the UI for one (its "change title" action isn't offered), but refused here too, defensively. */
export async function retitleNotebook(entry: NotebookEntry, source: FileSource, title: string): Promise<NotebookEntry> {
  if (isFolderNotebook(entry)) throw new Error("A folder used as a notebook has no title to change — it's always shown as its own path.")
  const read = await readNotebookFile(source, entry.folder, entry.fileName!)
  if (!read.ok) throw new Error(`"${entry.fileName}" isn't a notebook file any more: ${read.reason}`)
  await source.write(joinRelative(entry.folder, entry.fileName!), new TextEncoder().encode(serializeNotebookFile(withTitle(read.raw, title))))
  const updated = { ...entry, title: title.trim() }
  // By location, not by guid: two listed entries can now share a guid (see `entryKey`), and only the one at
  // `entry`'s own location should be retitled — not every notebook that happens to share it.
  await updateNotebooks((list) => list.map((n) => (sameLocation(n, entry) ? updated : n)))
  return updated
}

/** Takes a notebook out of the list, by its location (not its guid — see `entryKey`, since another listed entry
 * can share it). Its files are left exactly where they are. */
export async function unlistNotebook(entry: NotebookEntry): Promise<NotebookEntry[]> {
  return updateNotebooks((list) => list.filter((n) => !sameLocation(n, entry)))
}

/** What is known of a listed notebook right now. `title`, when present, is the file's own current title (a file-based
 * notebook only) — compared against the listed entry's own `title` to catch one changed outside the app; `undefined`
 * for a folder-as-notebook (there's nothing to re-read, so nothing to catch drifting — its name is always its own
 * path, computed fresh, see `notebookTitle`), which is also why it's `undefined` there rather than a freshly computed
 * path: comparing `undefined` against the listed entry's own (always-`undefined`) `title` correctly never looks like
 * a change, where comparing a *computed* path against it would — the entry's `folder` itself is still re-checked below. */
export type NotebookCheck =
  | { state: 'checking' }
  | { state: 'ok'; title?: string }
  | { state: 'problem'; reason: string }

/** Looks at a listed notebook: is the place reachable — and, for a file-based one, is it still a notebook (with
 * which title)? A folder-as-notebook has no file to read, so it is simply listed (any error there, such as the
 * folder itself being gone, is the problem). */
export async function checkNotebook(entry: NotebookEntry, roots: FileRoot[], accounts: FilenAccountInfo[]): Promise<NotebookCheck> {
  const source = resolveSource(entry.sourceId, roots, accounts)
  if (!source) {
    return { state: 'problem', reason: entry.sourceId.startsWith(FILEN_PREFIX) ? "That Filen account isn't connected." : "That folder isn't on the list of folders any more." }
  }
  if (isFolderNotebook(entry)) {
    try {
      await source.list(entry.folder)
      return { state: 'ok' }
    } catch (e) {
      return { state: 'problem', reason: String(e) }
    }
  }
  try {
    const read = await readNotebookFile(source, entry.folder, entry.fileName!)
    return read.ok ? { state: 'ok', title: read.notebook.Title } : { state: 'problem', reason: read.reason }
  } catch (e) {
    return { state: 'problem', reason: String(e) }
  }
}
