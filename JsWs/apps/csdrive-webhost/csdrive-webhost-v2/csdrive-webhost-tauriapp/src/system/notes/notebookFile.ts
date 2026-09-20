/** The notebook file of the Notes strategy (`docs/strategies/notes-strategy.md`, "The root folder of a notebook"): what
 * it is called, what is in it, and how a note's title becomes part of a file name. Nothing here touches a disk or the
 * backend, so it is plain functions — see `notebooks.ts` for where they are used. */

/** A file is a notebook's when its name is this or ends with it (case doesn't matter: Windows and Filen don't care). */
export const NOTEBOOK_FILE_SUFFIX = '[note-book].json'

/** What the notebook file holds. The keys are PascalCase, as in the strategy. */
export interface NotebookFile {
  Title: string
  /** ISO 8601, UTC, seven fractional digits: `2026-09-19T07:34:04.0283216Z`. */
  CreatedAt: string
  NoteBookGuid: string
}

export function isNotebookFileName(name: string): boolean {
  return name.toLowerCase().endsWith(NOTEBOOK_FILE_SUFFIX)
}

const GUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i

/** A GUID written any usual way (upper case, braces, no dashes) as one canonical string — what notebooks are compared by. */
export function normalizeGuid(guid: string): string | null {
  const bare = guid.trim().replace(/^\{(.*)\}$/, '$1')
  if (!GUID.test(bare)) return null
  const hex = bare.replace(/-/g, '').toLowerCase()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export type ParsedNotebookFile =
  | {
      ok: true
      notebook: NotebookFile
      /** The guid in its canonical form. */
      guid: string
      /** Everything in the file, so that keys this app doesn't know survive an edit of the title. */
      raw: Record<string, unknown>
    }
  | { ok: false; reason: string }

/** Reads a notebook file's text: it must be a JSON object with a non-empty `Title`, a `CreatedAt` that is a date and a
 * `NoteBookGuid` that is a GUID. `reason` says, for a person, what is wrong when it isn't one. */
export function parseNotebookFile(text: string): ParsedNotebookFile {
  let value: unknown
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return { ok: false, reason: "It isn't valid JSON." }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: "It isn't a JSON object." }
  const raw = value as Record<string, unknown>
  const { Title, CreatedAt, NoteBookGuid } = raw
  if (typeof Title !== 'string' || Title.trim() === '') return { ok: false, reason: 'It has no "Title".' }
  if (typeof CreatedAt !== 'string' || Number.isNaN(Date.parse(CreatedAt))) return { ok: false, reason: 'Its "CreatedAt" isn\'t a date.' }
  const guid = typeof NoteBookGuid === 'string' ? normalizeGuid(NoteBookGuid) : null
  if (!guid) return { ok: false, reason: 'Its "NoteBookGuid" isn\'t a GUID.' }
  return { ok: true, notebook: { Title, CreatedAt, NoteBookGuid: guid }, guid, raw }
}

/** `2026-09-19T07:34:04.0283216Z`: the way the strategy writes moments (seven fractional digits, as .NET does). JavaScript
 * only knows milliseconds, so the last four digits are zeros. */
export function dotNetTimestamp(date: Date): string {
  return date.toISOString().replace(/\.(\d{3})Z$/, '.$10000Z')
}

/** The content of a new notebook's file. */
export function newNotebookFile(title: string, now: Date = new Date(), guid: string = crypto.randomUUID()): NotebookFile {
  return { Title: title.trim(), CreatedAt: dotNetTimestamp(now), NoteBookGuid: guid }
}

/** The text to write: indented as in the strategy, ending with a line break. */
export function serializeNotebookFile(content: Record<string, unknown>): string {
  return `${JSON.stringify(content, null, 2)}\n`
}

/** `raw` (a parsed notebook file) with another title — every other key as it was. */
export function withTitle(raw: Record<string, unknown>, title: string): Record<string, unknown> {
  return { ...raw, Title: title.trim() }
}

/** The longest file/folder name part made from a title, in characters. */
export const MAX_NAME_PART_CHARS = 100

/** How a title becomes (part of) a file or folder name — the rule of the Notes strategy: characters a file name can't have
 * are discarded, `/` becomes `%` and `%` becomes `%%` (so the name can be read back), and the result is at most 100
 * characters, a `%%` pair never cut in half (if the 100th character would be the first `%` of one, it is discarded too).
 * Trailing dots and spaces, which Windows drops, are removed as well. */
export function namePartFromTitle(title: string): string {
  const pieces: string[] = []
  for (const character of title) {
    if (character === '%') pieces.push('%%')
    else if (character === '/') pieces.push('%')
    else if (character.charCodeAt(0) >= 32 && !'<>:"\\|?*'.includes(character)) pieces.push(character)
  }
  let part = ''
  let length = 0
  for (const piece of pieces) {
    const size = Array.from(piece).length
    if (length + size > MAX_NAME_PART_CHARS) break
    part += piece
    length += size
  }
  return part.replace(/[. ]+$/, '')
}

/** The name for a new notebook's file in a folder that holds `existingNames`: `[note-book].json`, and — when that is taken
 * (a folder that already has a notebook) — the title first, so as never to overwrite: `My notes [note-book].json`. */
export function notebookFileNameFor(title: string, existingNames: Iterable<string>): string {
  const taken = new Set(Array.from(existingNames, (name) => name.toLowerCase()))
  if (!taken.has(NOTEBOOK_FILE_SUFFIX)) return NOTEBOOK_FILE_SUFFIX
  const part = namePartFromTitle(title) || 'notebook'
  const first = `${part} ${NOTEBOOK_FILE_SUFFIX}`
  if (!taken.has(first.toLowerCase())) return first
  for (let n = 2; ; n++) {
    const candidate = `${part} (${n}) ${NOTEBOOK_FILE_SUFFIX}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}
