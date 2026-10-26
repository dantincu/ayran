import { decodeText } from './textFiles'

/** **The merged hierarchy "Insert custom text at the caret" browses** — one or more real root locations
 * (folders, per notebook, chosen through `system/notes/customTextLocations.ts`), each read **eagerly and in
 * full** into one in-memory tree: every real folder is walked recursively, every real file's own text is
 * read (binary/too-large ones are simply left out — they can't be a text template anyway), and every `.json`
 * file found in a folder is parsed and its own structure merged *into that same folder's listing* rather
 * than shown as a file of its own (item 2 of the todo's own spec, in full below). **Deliberately not lazy**:
 * search is asked to match a file's own *text*, not just its name, which would mean re-reading every file on
 * every keystroke of a search box if this stayed lazy — reading everything once, up front, is the simplest
 * design for what's expected to be a modest, hand-authored set of snippets, not a large file tree; pagination
 * over the result (the UI's own concern) is purely a display optimization on top of an already-fully-loaded
 * array, the same shape `FileExplorerModal.tsx`'s own paginated listing already is over its one folder's
 * entries.
 *
 * **The json-merge rules, read literally from the spec:**
 * - A `.json` file is never itself shown as a "file" row — its top-level object's own properties are merged
 *   into the *same folder* it was found in.
 * - A property whose value is a plain string/number/boolean/null ("a non-hash-object literal") becomes a
 *   *file*: the property's own **name** is the file's name, its **stringified value** (`String(value)`) is
 *   the file's content (its "piece of text").
 * - A property whose value is a hash object (a plain `{}`, not an array) becomes a *folder* of that same
 *   name, whose own contents are found by applying these same rules to that object's own properties.
 * - A property whose value is an *array* also becomes a folder of that name, but its contents come from the
 *   array's own elements instead of from object properties: a string element becomes a file whose name *and*
 *   content are both that string ("files whose contents are their own names"); a non-hash-object literal
 *   element is stringified and treated the same way; a hash-object element has its own properties merged
 *   directly into this folder's contents (not nested one level deeper under the array index) — "hash objects
 *   are being merged into the current set of files and folders".
 * - **Identical names are allowed** — a real file can share a name with a json-derived file or folder (or two
 *   json-derived entries can share one), so every level is a plain array, never a name-keyed map, all the way
 *   through.
 * - **Every level sorts alphabetically by name, after everything above has been merged in** — files and
 *   folders are each sorted on their own (never interleaved into one combined list), matching how every other
 *   listing in this app already separates the two. */

export interface HierarchyFile {
  kind: 'file'
  name: string
  content: string
}

export interface HierarchyFolder {
  kind: 'folder'
  name: string
  files: HierarchyFile[]
  folders: HierarchyFolder[]
}

export interface HierarchyLevel {
  files: HierarchyFile[]
  folders: HierarchyFolder[]
}

/** What this module needs from a `FileSource` — kept narrow and structural (not importing `sources.ts`'
 * own, much larger `FileSource` interface) so this stays a plain, DOM/backend-light module whose *shape* of
 * dependency is easy to see at a glance; `system/notes/sources.ts`'s real `FileSource` already satisfies it
 * structurally, with no adapter needed. */
export interface HierarchySource {
  list(path: string): Promise<{ entries: { name: string; isDirectory: boolean }[] }>
  read(path: string): Promise<Uint8Array>
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const stringify = (value: unknown): string => (typeof value === 'string' ? value : String(value))

function mergeJsonValue(name: string, value: unknown, files: HierarchyFile[], folders: HierarchyFolder[]): void {
  if (isPlainObject(value)) {
    const sub: HierarchyLevel = { files: [], folders: [] }
    mergeJsonObject(value, sub)
    sub.files.sort(byName)
    sub.folders.sort(byName)
    folders.push({ kind: 'folder', name, files: sub.files, folders: sub.folders })
  } else if (Array.isArray(value)) {
    const sub: HierarchyLevel = { files: [], folders: [] }
    for (const item of value) {
      if (isPlainObject(item)) mergeJsonObject(item, sub)
      else if (item !== undefined) {
        const text = stringify(item)
        sub.files.push({ kind: 'file', name: text, content: text })
      }
    }
    sub.files.sort(byName)
    sub.folders.sort(byName)
    folders.push({ kind: 'folder', name, files: sub.files, folders: sub.folders })
  } else {
    files.push({ kind: 'file', name, content: stringify(value) })
  }
}

function mergeJsonObject(obj: Record<string, unknown>, into: HierarchyLevel): void {
  for (const [key, value] of Object.entries(obj)) mergeJsonValue(key, value, into.files, into.folders)
}

async function readTextOrNull(source: HierarchySource, path: string): Promise<string | null> {
  try {
    return decodeText(await source.read(path))
  } catch {
    return null
  }
}

/** Reads one real folder, recursively, merging in every `.json` file found directly inside it (not inside
 * its subfolders — each subfolder merges its *own* `.json` files when *it* is read, the same recursive call). */
async function readRealFolder(source: HierarchySource, path: string): Promise<HierarchyLevel> {
  const level: HierarchyLevel = { files: [], folders: [] }
  const entries = await source.list(path).then((l) => l.entries, () => [])
  const jsonNames: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory) {
      level.folders.push({ kind: 'folder', name: entry.name, ...(await readRealFolder(source, joinPath(path, entry.name))) })
    } else if (entry.name.toLowerCase().endsWith('.json')) {
      jsonNames.push(entry.name)
    } else {
      const text = await readTextOrNull(source, joinPath(path, entry.name))
      if (text !== null) level.files.push({ kind: 'file', name: entry.name, content: text })
    }
  }
  for (const jsonName of jsonNames) {
    const text = await readTextOrNull(source, joinPath(path, jsonName))
    if (text === null) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      continue // a malformed json file is simply not merged — not a reason to fail the whole folder.
    }
    if (isPlainObject(parsed)) mergeJsonObject(parsed, level)
  }
  level.files.sort(byName)
  level.folders.sort(byName)
  return level
}

/** Reads every one of `locationPaths` and merges their top-level contents into one combined root — "the
 * hierarchy should be merged from all the root locations." Below the root, each real folder is exactly what
 * `readRealFolder` already built for it (no further cross-location merging is possible past the root, since
 * two different locations' own subfolders are necessarily distinct real folders on disk). */
export async function buildCustomTextHierarchy(source: HierarchySource, locationPaths: string[]): Promise<HierarchyLevel> {
  const root: HierarchyLevel = { files: [], folders: [] }
  for (const path of locationPaths) {
    const level = await readRealFolder(source, path).catch(() => ({ files: [], folders: [] }))
    root.files.push(...level.files)
    root.folders.push(...level.folders)
  }
  root.files.sort(byName)
  root.folders.sort(byName)
  return root
}

/** The level filtered to what a search string matches — a file by its own name *or* content, a folder by
 * its name only (it has no "text" of its own); case-insensitive substring, exactly "matches if it includes
 * the search string, ignoring the case." An empty query returns the level unchanged. */
export function filterHierarchyLevel(level: HierarchyLevel, query: string): HierarchyLevel {
  const q = query.trim().toLowerCase()
  if (!q) return level
  return {
    files: level.files.filter((f) => f.name.toLowerCase().includes(q) || f.content.toLowerCase().includes(q)),
    folders: level.folders.filter((f) => f.name.toLowerCase().includes(q)),
  }
}
