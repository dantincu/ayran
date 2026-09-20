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

/** One notebook in the list. */
export interface NotebookEntry {
  /** The notebook's GUID, canonical (see `normalizeGuid`) — what makes it the same notebook wherever it is found. */
  guid: string
  /** The title as last seen in the file (the file is the truth; this is for showing the list without reading them). */
  title: string
  /** `local:user`, `local:<picked folder's root id>` or `filen:<userId>` — never a branch: a notebook lives in the account. */
  sourceId: string
  /** The notebook's root folder, relative to the source's root; `''` is the root itself. */
  folder: string
  /** The notebook file's name in that folder (it is or ends with `[note-book].json`). */
  fileName: string
  addedAt: number
}

const NOTEBOOKS_KEY = 'notes.notebooks'

function isEntry(value: unknown): value is NotebookEntry {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    typeof e.guid === 'string' &&
    typeof e.title === 'string' &&
    typeof e.sourceId === 'string' &&
    typeof e.folder === 'string' &&
    typeof e.fileName === 'string' &&
    typeof e.addedAt === 'number'
  )
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

/** Where a notebook is, for showing a person: `user · /notes/work · [note-book].json`. */
export function describeLocation(entry: NotebookEntry, roots: FileRoot[], accounts: FilenAccountInfo[]): string {
  const source = resolveSource(entry.sourceId, roots, accounts)
  const where = source ? source.label : entry.sourceId.startsWith(FILEN_PREFIX) ? 'a Filen account that isn\'t connected' : 'a folder that isn\'t on the list of folders'
  return `${where} · /${entry.folder} · ${entry.fileName}`
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
  | { status: 'added'; entry: NotebookEntry }
  /** It was in the list already (found by its GUID, or by where it is); `entry` is the listed one, brought up to date. */
  | { status: 'already-listed'; entry: NotebookEntry }
  | { status: 'not-a-notebook'; reason: string }

/** Adds a notebook that exists but isn't listed: reads its file, and lists it — unless it is listed already. */
export async function addExistingNotebook(source: FileSource, folder: string, fileName: string): Promise<AddResult> {
  const read = await readNotebookFile(source, folder, fileName)
  if (!read.ok) return { status: 'not-a-notebook', reason: read.reason }
  const fresh: NotebookEntry = { guid: read.guid, title: read.notebook.Title, sourceId: source.id, folder, fileName, addedAt: Date.now() }
  let result: AddResult = { status: 'added', entry: fresh }
  await updateNotebooks((list) => {
    const same = list.find((n) => n.guid === fresh.guid || (n.sourceId === fresh.sourceId && n.folder === fresh.folder && n.fileName === fresh.fileName))
    if (!same) return [...list, fresh]
    const updated: NotebookEntry = { ...same, title: fresh.title }
    result = { status: 'already-listed', entry: updated }
    return list.map((n) => (n === same ? updated : n))
  })
  return result
}

/** Gives a listed notebook a new title: in its file first (every other key of the file kept), then in the list. Throws —
 * with the list unchanged — when the file can't be read, isn't a notebook's or can't be written. */
export async function retitleNotebook(entry: NotebookEntry, source: FileSource, title: string): Promise<NotebookEntry> {
  const read = await readNotebookFile(source, entry.folder, entry.fileName)
  if (!read.ok) throw new Error(`"${entry.fileName}" isn't a notebook file any more: ${read.reason}`)
  await source.write(joinRelative(entry.folder, entry.fileName), new TextEncoder().encode(serializeNotebookFile(withTitle(read.raw, title))))
  const updated = { ...entry, title: title.trim() }
  await updateNotebooks((list) => list.map((n) => (n.guid === entry.guid ? updated : n)))
  return updated
}

/** Takes a notebook out of the list. Its files are left exactly where they are. */
export async function unlistNotebook(guid: string): Promise<NotebookEntry[]> {
  return updateNotebooks((list) => list.filter((n) => n.guid !== guid))
}

/** What is known of a listed notebook's file right now. */
export type NotebookCheck =
  | { state: 'checking' }
  | { state: 'ok'; title: string }
  | { state: 'problem'; reason: string }

/** Looks at a listed notebook's file: is the place reachable, and is it still a notebook (with which title)? */
export async function checkNotebook(entry: NotebookEntry, roots: FileRoot[], accounts: FilenAccountInfo[]): Promise<NotebookCheck> {
  const source = resolveSource(entry.sourceId, roots, accounts)
  if (!source) {
    return { state: 'problem', reason: entry.sourceId.startsWith(FILEN_PREFIX) ? "That Filen account isn't connected." : "That folder isn't on the list of folders any more." }
  }
  try {
    const read = await readNotebookFile(source, entry.folder, entry.fileName)
    return read.ok ? { state: 'ok', title: read.notebook.Title } : { state: 'problem', reason: read.reason }
  } catch (e) {
    return { state: 'problem', reason: String(e) }
  }
}
