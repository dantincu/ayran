import { NOTE_VIEWER_SCRIPT_JSON } from '../../lib/appConfig'
import { ensureNotebookInternals, join, NOTEBOOK_INTERNALS_INDEX } from './noteModel'
import type { NotebookEntry } from './notebooks'
import type { FileSource } from './sources'

/** A notebook's own **viewer script**: a plain JavaScript file, chosen per notebook, inserted into the DOM
 * of every Note Viewer and markdown/html File Viewer page shown for a file inside that notebook's own
 * folder (its subfolders included) — see CLAUDE.md, "A notebook's own viewer script". Kept the same way
 * User Action's own per-notebook page is (`userAction.ts`): a small json file in the notebook's own
 * internals folder (`03`), `{Script: {SourceId, Path}}` — the script itself can be anywhere the person
 * points to, not necessarily the notebook's own source. The backend re-reads it fresh on every page that
 * loads inside this notebook's scope — editing the script and reopening or reloading that page picks up
 * the change; there is no separate "apply" step here. */
export interface NoteViewerScript {
  sourceId: string
  path: string
}

function validScript(value: unknown): NoteViewerScript | null {
  if (typeof value !== 'object' || value === null) return null
  const script = value as Record<string, unknown>
  const sourceId = script.SourceId ?? script.sourceId
  const path = script.Path ?? script.path
  if (typeof sourceId !== 'string' || typeof path !== 'string' || !sourceId || !path.replace(/^\/+/, '')) return null
  return { sourceId, path: path.replace(/^\/+/, '') }
}

export function serializeNoteViewerScriptFile(script: NoteViewerScript): string {
  return `${JSON.stringify({ Script: { SourceId: script.sourceId, Path: script.path } }, null, 2)}\n`
}

export function parseNoteViewerScriptFile(text: string): NoteViewerScript | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${NOTE_VIEWER_SCRIPT_JSON} isn't valid json.`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${NOTE_VIEWER_SCRIPT_JSON} isn't a json object.`)
  const script = (parsed as Record<string, unknown>).Script
  if (script === undefined || script === null) return null
  const valid = validScript(script)
  if (!valid) throw new Error(`The "Script" in ${NOTE_VIEWER_SCRIPT_JSON} needs a "SourceId" and a "Path".`)
  return valid
}

const settingPath = (notebook: NotebookEntry) => join(notebook.folder, NOTEBOOK_INTERNALS_INDEX, NOTE_VIEWER_SCRIPT_JSON)

export async function readNotebookScript(source: FileSource, notebook: NotebookEntry): Promise<NoteViewerScript | null> {
  const internals = join(notebook.folder, NOTEBOOK_INTERNALS_INDEX)
  const inside = await source.list(internals, true).then(
    (listing) => listing.entries,
    () => null,
  )
  if (!inside || !inside.some((e) => !e.isDirectory && e.name === NOTE_VIEWER_SCRIPT_JSON)) return null
  return parseNoteViewerScriptFile(new TextDecoder('utf-8').decode(await source.read(settingPath(notebook))))
}

export async function saveNotebookScript(source: FileSource, notebook: NotebookEntry, script: NoteViewerScript): Promise<void> {
  await ensureNotebookInternals(source, notebook.folder)
  await source.write(settingPath(notebook), new TextEncoder().encode(serializeNoteViewerScriptFile(script)))
}

export async function resetNotebookScript(source: FileSource, notebook: NotebookEntry): Promise<void> {
  const internals = join(notebook.folder, NOTEBOOK_INTERNALS_INDEX)
  const inside = await source.list(internals, true).then(
    (listing) => listing.entries,
    () => [],
  )
  if (inside.some((e) => !e.isDirectory && e.name === NOTE_VIEWER_SCRIPT_JSON)) await source.remove(settingPath(notebook), false)
}
