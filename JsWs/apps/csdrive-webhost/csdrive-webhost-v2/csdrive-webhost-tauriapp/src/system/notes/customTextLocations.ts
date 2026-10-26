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

/** Which kind of typing a location's own files/folders are offered for — a follow-up ask, once the feature
 * already existed for the editor alone: "let's also make that option available for when typing the item name
 * ... for each location the user will specify ... if the location is for item names or for the text editor or
 * for both." `'both'` is the default (and what every location migrated from the old, mode-less format gets),
 * so nothing already configured silently stops applying somewhere it used to. */
export type CustomTextLocationMode = 'editor' | 'itemName' | 'both'

/** A notebook's own set of **custom-text locations** — folders, *inside the notebook's own source*, whose
 * files and folders make up the hierarchy the "Insert custom text" menus browse (see `lib/customTextTemplate.ts`
 * for the template language itself, `customTextHierarchy.ts` for how several locations and their files merge
 * into one tree). Kept the exact same way User Action's/the viewer script's own per-notebook settings are
 * (`userAction.ts`/`noteViewerScript.ts`): a small json file in the notebook's own internals folder (`03`).
 *
 * **`id` is the one thing that has to survive every edit untouched** — it's what a location's own colored tags
 * (`customTextLocationTagGuid`) are attached to, so losing or regenerating it on every read would silently
 * disconnect a location from tags already put on it. A location read from the *old*, plain-string-array format
 * (or missing its own `Id` for any other reason) gets a freshly made one the first time it's read — and that
 * read immediately writes the migrated form back (see `readCustomTextLocations`), so the same id comes back
 * every time after, not a new one per read. */
export interface CustomTextLocation {
  id: string
  path: string
  appliesTo: CustomTextLocationMode
}

export function customTextLocationTagGuid(id: string): string {
  return `customtext-location:${id}`
}

/** A fresh, opaque location id — exported too, for `CustomTextLocationsModal.tsx`'s own "Add a location…" to
 * make one for a brand-new entry, the same way every id this module itself generates (migrating an old entry
 * with none) is made. */
export function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function validMode(value: unknown): CustomTextLocationMode {
  return value === 'editor' || value === 'itemName' || value === 'both' ? value : 'both'
}

/** `migrated` is true the moment any entry needed anything fixed up — a bare string (the old format
 * entirely) or an object missing a usable `Id` — which is the caller's cue to persist the result right away,
 * so the same ids (and so the same tags) come back on every later read, not a fresh batch each time. */
function parseLocations(value: unknown): { locations: CustomTextLocation[]; migrated: boolean } {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).Locations : undefined
  if (!Array.isArray(raw)) return { locations: [], migrated: false }
  const locations: CustomTextLocation[] = []
  let migrated = false
  for (const item of raw) {
    if (typeof item === 'string') {
      const path = item.replace(/^\/+|\/+$/g, '').trim()
      if (path === '') continue
      locations.push({ id: randomId(), path, appliesTo: 'both' })
      migrated = true
      continue
    }
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    const path = typeof rec.Path === 'string' ? rec.Path.replace(/^\/+|\/+$/g, '').trim() : ''
    if (path === '') continue
    const hasId = typeof rec.Id === 'string' && rec.Id.trim() !== ''
    if (!hasId) migrated = true
    locations.push({ id: hasId ? (rec.Id as string) : randomId(), path, appliesTo: validMode(rec.AppliesTo) })
  }
  return { locations, migrated }
}

export function serializeCustomTextLocationsFile(locations: CustomTextLocation[]): string {
  return `${JSON.stringify({ Locations: locations.map((l) => ({ Id: l.id, Path: l.path, AppliesTo: l.appliesTo })) }, null, 2)}\n`
}

export function parseCustomTextLocationsFile(text: string): CustomTextLocation[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${CUSTOM_TEXT_LOCATIONS_JSON} isn't valid json.`)
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Record<string, unknown>).Locations)) {
    throw new Error(`${CUSTOM_TEXT_LOCATIONS_JSON} needs a "Locations" array.`)
  }
  return parseLocations(parsed).locations
}

const settingPath = (notebook: NotebookEntry) => join(notebook.folder, NOTEBOOK_INTERNALS_INDEX, CUSTOM_TEXT_LOCATIONS_JSON)

/** `[]` (not `null`) when the notebook has no custom-text locations chosen yet — unlike User Action's own
 * per-notebook page, "no locations configured" isn't a state the person is ever asked to tell apart from
 * "configured, but to an empty list": both simply mean the hierarchy is empty, so this never needs its own
 * three-way "unset vs. set-to-nothing" distinction. */
export async function readCustomTextLocations(source: FileSource, notebook: NotebookEntry): Promise<CustomTextLocation[]> {
  const internals = join(notebook.folder, NOTEBOOK_INTERNALS_INDEX)
  const inside = await source.list(internals, true).then(
    (listing) => listing.entries,
    () => null,
  )
  if (!inside || !inside.some((e) => !e.isDirectory && e.name === CUSTOM_TEXT_LOCATIONS_JSON)) return []
  const text = new TextDecoder('utf-8').decode(await source.read(settingPath(notebook)))
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${CUSTOM_TEXT_LOCATIONS_JSON} isn't valid json.`)
  }
  const { locations, migrated } = parseLocations(parsed)
  if (migrated) await saveCustomTextLocations(source, notebook, locations).catch(() => {})
  return locations
}

export async function saveCustomTextLocations(source: FileSource, notebook: NotebookEntry, locations: CustomTextLocation[]): Promise<void> {
  await ensureNotebookInternals(source, notebook.folder)
  await source.write(settingPath(notebook), new TextEncoder().encode(serializeCustomTextLocationsFile(locations)))
}

/** The plain paths `buildCustomTextHierarchy` needs — every location whose own `appliesTo` includes `mode`
 * (its own exact mode, or `'both'`). What both "Insert custom text at the caret" (the editor) and the new
 * item-name button call before building their own hierarchy, so the same stored locations serve either
 * context without the hierarchy module itself needing to know this distinction exists. */
export function pathsForMode(locations: CustomTextLocation[], mode: 'editor' | 'itemName'): string[] {
  return locations.filter((l) => l.appliesTo === mode || l.appliesTo === 'both').map((l) => l.path)
}
