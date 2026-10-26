import { ensureNotebookInternals, join, NOTEBOOK_INTERNALS_INDEX } from './noteModel'
import type { NotebookEntry } from './notebooks'
import type { FileSource } from './sources'

/** The notebook-own json file naming the "insert custom text" locations (item 2 of the todo) — a plain local
 * constant, not a `lib/appConfig.ts` entry like `USER_ACTION_JSON`/`NOTE_VIEWER_SCRIPT_JSON`: this feature is
 * pure frontend state (nothing server-side ever reads this file's name, unlike the viewer script, which the
 * backend's own `note_viewer_script.rs` resolves to inject into a rendered page), so there is nothing for the
 * two languages to need to agree on bit-for-bit — the same reasoning `notes.notebooks`/`notes.userAction`'s own
 * plain string keys already rest on, elsewhere in this app. */
const CUSTOM_TEXT_LOCATIONS_JSON = '[custom-text-locations].json'

/** A notebook's own set of **custom-text locations** — folders, *inside the notebook's own source*, whose
 * files and folders make up the hierarchy the "Insert custom text at the caret" menu item browses (see
 * `lib/customTextTemplate.ts` for the template language itself, `customTextHierarchy.ts` for how several
 * locations and their files merge into one tree). Kept the exact same way User Action's/the viewer script's
 * own per-notebook settings are (`userAction.ts`/`noteViewerScript.ts`): a small json file in the notebook's
 * own internals folder (`03`) — `{ "Locations": ["path1", "path2", ...] }`, each path relative to the
 * notebook's *own source's root* (not necessarily the notebook's own folder — "inside the current root",
 * item 2's own wording, read here as the notebook's whole source, the same root `addFolderNotebook`/
 * `LocationPicker`'s own `mode="folder"` already address paths relative to elsewhere in this app). */
export interface CustomTextLocations {
  paths: string[]
}

function validLocations(value: unknown): CustomTextLocations | null {
  if (typeof value !== 'object' || value === null) return null
  const locations = (value as Record<string, unknown>).Locations
  if (!Array.isArray(locations)) return null
  const paths = locations.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.replace(/^\/+|\/+$/g, ''))
  return { paths }
}

export function serializeCustomTextLocationsFile(locations: CustomTextLocations): string {
  return `${JSON.stringify({ Locations: locations.paths }, null, 2)}\n`
}

export function parseCustomTextLocationsFile(text: string): CustomTextLocations {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${CUSTOM_TEXT_LOCATIONS_JSON} isn't valid json.`)
  }
  const valid = validLocations(parsed)
  if (!valid) throw new Error(`${CUSTOM_TEXT_LOCATIONS_JSON} needs a "Locations" array of paths.`)
  return valid
}

const settingPath = (notebook: NotebookEntry) => join(notebook.folder, NOTEBOOK_INTERNALS_INDEX, CUSTOM_TEXT_LOCATIONS_JSON)

/** `[]` (not `null`) when the notebook has no custom-text locations chosen yet — unlike User Action's own
 * per-notebook page, "no locations configured" isn't a state the person is ever asked to tell apart from
 * "configured, but to an empty list": both simply mean the hierarchy is empty, so this never needs its own
 * three-way "unset vs. set-to-nothing" distinction. */
export async function readCustomTextLocations(source: FileSource, notebook: NotebookEntry): Promise<string[]> {
  const internals = join(notebook.folder, NOTEBOOK_INTERNALS_INDEX)
  const inside = await source.list(internals, true).then(
    (listing) => listing.entries,
    () => null,
  )
  if (!inside || !inside.some((e) => !e.isDirectory && e.name === CUSTOM_TEXT_LOCATIONS_JSON)) return []
  return parseCustomTextLocationsFile(new TextDecoder('utf-8').decode(await source.read(settingPath(notebook)))).paths
}

export async function saveCustomTextLocations(source: FileSource, notebook: NotebookEntry, paths: string[]): Promise<void> {
  await ensureNotebookInternals(source, notebook.folder)
  await source.write(settingPath(notebook), new TextEncoder().encode(serializeCustomTextLocationsFile({ paths })))
}
