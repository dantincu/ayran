import { getAppState, setAppState } from '../../lib/appState'
import { USER_ACTION_JSON } from '../../lib/appConfig'
import { ensureNotebookInternals, join, NOTEBOOK_INTERNALS_INDEX } from './noteModel'
import type { NotebookEntry } from './notebooks'
import type { FileSource } from './sources'
import { invoke } from '@tauri-apps/api/core'
import { getUserRoot, loadSavedRoots } from '../../lib/fileRoots'
import { listFilenAccounts } from '../../lib/filen'
import { loadNotebooks, resolveSource } from './notebooks'
import { decodePlace } from './tabs'
import { currentResource, launchedNow } from './userActionScope'

/** **User Action** (`docs/strategies/note-custom-actions.md`): a button in every Notes page — and one at every text box — launches a web page the
 * person chose, an html file of any source (the user folder, a folder of this device, a Filen account), **in a window of its own** (`user_action.rs`:
 * one per Notes window, reused, told what opened it and when that goes out of scope). Which page is a setting with two homes:
 * - **in a notebook** (a page whose place is inside a listed notebook): a json file in the notebook's own internals folder, `03`
 *   (`03/[user-action].json`, in the notebook's own source — so it travels with the notebook);
 * - **anywhere else** (the home page, the notebooks page, a folder outside every notebook): one global setting in the Notes app's own
 *   state (`notes.userAction`, `data.db`).
 * This file is the setting and its two homes, and the launch; `UserActionButton.tsx` is the control (launch, close), `UserActionModal.tsx`
 * the dialog that chooses the page, and `userActionScope.ts` what tells the window that what opened it is out of scope. */

/** Where the page is: a file of a source (`local:user`, `local:<root id>`, `filen:<user id>`). */
export interface UserActionPage {
  sourceId: string
  /** The html file, relative to the source's root. */
  path: string
}

/** What a User Action was launched for: one notebook, or the app as a whole. */
export type UserActionScope = { kind: 'notebook'; notebook: NotebookEntry } | { kind: 'global' }

const GLOBAL_KEY = 'notes.userAction'

/** Only an html page can be the page of a User Action (the popup shows it as a web app). */
export const isPageFileName = (name: string) => /\.html?$/i.test(name)

function validPage(value: unknown): UserActionPage | null {
  if (typeof value !== 'object' || value === null) return null
  const page = value as Record<string, unknown>
  const sourceId = page.SourceId ?? page.sourceId
  const path = page.Path ?? page.path
  if (typeof sourceId !== 'string' || typeof path !== 'string' || !sourceId || !path.replace(/^\/+/, '')) return null
  return { sourceId, path: path.replace(/^\/+/, '') }
}

/** The file that holds a notebook's setting, as text: `{ "Page": { "SourceId": …, "Path": … } }` (the keys are capitalized like the
 * notebook file's). */
export function serializeUserActionFile(page: UserActionPage): string {
  return `${JSON.stringify({ Page: { SourceId: page.sourceId, Path: page.path } }, null, 2)}\n`
}

/** What a notebook's setting file says. `null`: it names no page (an empty object, an absent `Page`). Throws, with a reason a person
 * can read, when it isn't json or its `Page` isn't a page. */
export function parseUserActionFile(text: string): UserActionPage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${USER_ACTION_JSON} isn't valid json.`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${USER_ACTION_JSON} isn't a json object.`)
  const page = (parsed as Record<string, unknown>).Page
  if (page === undefined || page === null) return null
  const valid = validPage(page)
  if (!valid) throw new Error(`The "Page" in ${USER_ACTION_JSON} needs a "SourceId" and a "Path".`)
  return valid
}

/** The listed notebook a place belongs to — the notebook whose folder is the place or above it, the innermost when notebooks are
 * nested — or `null` (a place outside every notebook: the User Action there is the global one). */
export function notebookContaining(list: NotebookEntry[], sourceId: string | undefined, folder: string | undefined): NotebookEntry | null {
  if (sourceId === undefined) return null
  const place = (folder ?? '').replace(/^\/+|\/+$/g, '')
  let best: NotebookEntry | null = null
  for (const notebook of list) {
    if (notebook.sourceId !== sourceId) continue
    const root = notebook.folder.replace(/^\/+|\/+$/g, '')
    const inside = root === '' || place === root || place.startsWith(`${root}/`)
    if (inside && (best === null || root.length > best.folder.replace(/^\/+|\/+$/g, '').length)) best = notebook
  }
  return best
}

const settingPath = (notebook: NotebookEntry) => join(notebook.folder, NOTEBOOK_INTERNALS_INDEX, USER_ACTION_JSON)

// ── A notebook's setting: `03/[user-action].json` in the notebook's own source ─────────────────────────────

/** The page a notebook's User Action shows, or `null` when none was chosen. */
export async function readNotebookPage(source: FileSource, notebook: NotebookEntry): Promise<UserActionPage | null> {
  const internals = join(notebook.folder, NOTEBOOK_INTERNALS_INDEX)
  const inside = await source.list(internals, true).then(
    (listing) => listing.entries,
    () => null, // no internals folder yet: nothing was ever chosen
  )
  if (!inside || !inside.some((e) => !e.isDirectory && e.name === USER_ACTION_JSON)) return null
  return parseUserActionFile(new TextDecoder('utf-8').decode(await source.read(settingPath(notebook))))
}

/** Chooses the page of a notebook's User Action (makes the notebook's `03` pair if it has none). */
export async function saveNotebookPage(source: FileSource, notebook: NotebookEntry, page: UserActionPage): Promise<void> {
  await ensureNotebookInternals(source, notebook.folder)
  await source.write(settingPath(notebook), new TextEncoder().encode(serializeUserActionFile(page)))
}

/** Forgets the chosen page of a notebook: the setting file goes (the `03` pair stays). */
export async function resetNotebookPage(source: FileSource, notebook: NotebookEntry): Promise<void> {
  const internals = join(notebook.folder, NOTEBOOK_INTERNALS_INDEX)
  const inside = await source.list(internals, true).then(
    (listing) => listing.entries,
    () => [],
  )
  if (inside.some((e) => !e.isDirectory && e.name === USER_ACTION_JSON)) await source.remove(settingPath(notebook), false)
}

// ── The global setting: the Notes app's own state ───────────────────────────────────────────────────────────

/** The page the global User Action shows, or `null`. What was saved is checked before it is used. */
export async function readGlobalPage(): Promise<UserActionPage | null> {
  return validPage(await getAppState<unknown>(GLOBAL_KEY).catch(() => undefined))
}

export async function saveGlobalPage(page: UserActionPage | null): Promise<void> {
  await setAppState(GLOBAL_KEY, page)
}

// ── Launching ───────────────────────────────────────────────────────────────────────────────────────────────

/** The source and folder the resource being shown is at (what decides which setting a launch reads): none for the home page and the
 * pages that are not at a folder of a source. */
export function placeOfResource(resourceId: string): { sourceId?: string; folder?: string } {
  const place = decodePlace(resourceId)
  if (!place) return {}
  switch (place.view) {
    case 'files':
      return place.location ? { sourceId: place.location.sourceId, folder: place.location.path } : {}
    case 'notes':
    case 'noteEdit':
    case 'noteFiles':
      return { sourceId: place.sourceId, folder: place.folder }
    default:
      return {}
  }
}

/** The page the launch would show at the resource being shown, and whose setting it is. */
export async function pageHere(): Promise<{ page: UserActionPage | null; scope: UserActionScope }> {
  const { sourceId, folder } = placeOfResource(currentResource())
  const notebook = notebookContaining(await loadNotebooks(), sourceId, folder)
  if (!notebook) return { page: await readGlobalPage(), scope: { kind: 'global' } }
  const [user, saved, accounts] = await Promise.all([getUserRoot(), loadSavedRoots().catch(() => []), listFilenAccounts().catch(() => [])])
  const source = resolveSource(notebook.sourceId, [user, ...saved], accounts)
  if (!source) throw new Error("This notebook's place isn't available (a folder that isn't on the list of folders, or a Filen account that isn't connected).")
  return { page: await readNotebookPage(source, notebook), scope: { kind: 'notebook', notebook } }
}

/** Launches the User Action window (opening it, or bringing the one that is open to the front) and tells it what opened it: the
 * resource being shown, and `context` — where from (`{ kind: 'button' }`, or a text box: see `UserActionButton.tsx`). Resolves to `false`
 * when no page was chosen yet (the caller then offers to choose one). */
export async function launchUserAction(context: Record<string, unknown>): Promise<boolean> {
  const { page } = await pageHere()
  if (!page) return false
  const [user, saved, accounts] = await Promise.all([getUserRoot(), loadSavedRoots().catch(() => []), listFilenAccounts().catch(() => [])])
  const source = resolveSource(page.sourceId, [user, ...saved], accounts)
  if (!source?.fileRef) throw new Error("The page's place isn't available (a folder that isn't on the list of folders, or a Filen account that isn't connected).")
  await invoke('user_action_launch', { file: source.fileRef(page.path), resourceId: currentResource(), context })
  launchedNow()
  return true
}

/** Closes the User Action window of this Notes window (if it is open). */
export async function closeUserAction(): Promise<void> {
  await invoke('user_action_close')
}
