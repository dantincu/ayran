/** The notes themselves (`docs/strategies/notes-strategy.md`): how a note item is kept on disk, and the operations on it —
 * create, list the children, rename, delete, find its markdown and its files — over a `FileSource` (a folder of this device or a
 * Filen account, in a branch too), so a notebook works the same anywhere.
 *
 * A **note item** is a pair of folders (`folder-pairs-strategy.md`) in its parent's folder: the short one, `NNN` (three digits),
 * where everything lives, and `NNN-<title as a name part>`, an empty marker (only a `.keep`) that says what `NNN` is. In `NNN`:
 * - the note's markdown, `0-<name part>[note].md`, which starts with the title as a heading;
 * - `[note].json` — `{ Title, CreatedAt, UpdatedAt }`;
 * - `[note-children].json` — `{ ChildNotes: { "001": { Title, CreatedAt, UpdatedAt } } }`, the list read to show the children
 *   without opening each of them;
 * - the child notes (more pairs of three digits), and pairs of **two** digits for internals: `01` (with `01-Note files`) holds
 *   the note's files — what the person uploads to it.
 * A **notebook**'s root folder is the same, without the markdown and `[note].json`: it holds `[note-book].json` and its top level
 * notes (listed in its own `[note-children].json`).
 *
 * The address of a note is the path of its short folder with the query key `note`: `/Projects/001/002?note`. */

import { dotNetTimestamp, namePartFromTitle } from './notebookFile'
import type { Entry, FileSource } from './sources'

export const NOTE_JSON = '[note].json'
export const CHILDREN_JSON = '[note-children].json'
export const NOTE_MARKDOWN_SUFFIX = '[note].md'
/** The internals pair that holds a note's files. */
export const NOTE_FILES_INDEX = '01'
export const NOTE_FILES_NAME = 'Note files'
const KEEP = '.keep'

/** A note as its parent lists it. */
export interface NoteRef {
  /** Three digits: the name of its short folder. */
  index: string
  /** The path of its short folder, relative to the source's root. */
  folder: string
  title: string
  createdAt: string
  updatedAt?: string
}

/** What `[note-children].json` holds, as JSON. */
interface ChildEntry {
  Title: string
  CreatedAt: string
  UpdatedAt?: string
}

const join = (...parts: string[]) => parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')
const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

// ── Names ─────────────────────────────────────────────────────────────────────

const NOTE_INDEX = /^\d{3}$/
const NOTE_MARKER = /^(\d{3})-(.*)$/s

/** The name part a title makes (see `namePartFromTitle`), never empty. */
export const partOf = (title: string) => namePartFromTitle(title) || 'Untitled'

export const markerName = (index: string, title: string) => `${index}-${partOf(title)}`
export const markdownName = (title: string) => `0-${partOf(title)}${NOTE_MARKDOWN_SUFFIX}`
export const isNoteMarkdown = (name: string) => name.toLowerCase().endsWith(NOTE_MARKDOWN_SUFFIX.toLowerCase())

/** The index for the next note in a folder that holds `names`: one more than the highest used — by a short folder or a marker —
 * ("after the largest", gaps stay). `null` when all 999 are taken. */
export function nextNoteIndex(names: Iterable<string>): string | null {
  let highest = 0
  for (const name of names) {
    const m = NOTE_INDEX.test(name) ? name : NOTE_MARKER.exec(name)?.[1]
    if (m) highest = Math.max(highest, Number(m))
  }
  return highest >= 999 ? null : String(highest + 1).padStart(3, '0')
}

/** The address of the note whose short folder is `folder`. */
export const noteAddress = (folder: string) => `/${folder.replace(/^\/+/, '')}?note`

// ── The title in the markdown ─────────────────────────────────────────────────

/** A title as a markdown heading: html-encoded (`& < >`) and with the characters markdown reads as marks escaped. */
export function markdownTitle(title: string): string {
  const encoded = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `# ${encoded.replace(/([\\`*_[\]#])/g, '\\$1')}`
}

/** The title in a markdown text's first heading (`# …`), decoded; `null` if it has none. */
export function titleFromMarkdown(markdown: string): string | null {
  const m = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(markdown.replace(/\r\n/g, '\n'))
  if (!m) return null
  const heading = m[1].replace(/\\([\\`*_[\]#])/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  return heading.trim() || null
}

/** `markdown` with its first heading replaced by `title`'s — or the heading added on top when there is none. */
export function withTitleHeading(markdown: string, title: string): string {
  const heading = markdownTitle(title)
  const pattern = /^#[ \t]+.*$/m
  if (pattern.test(markdown)) return markdown.replace(pattern, () => heading)
  return `${heading}\n\n${markdown}`
}

// ── Reading ───────────────────────────────────────────────────────────────────

async function readJson(source: FileSource, path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(await source.read(path)))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function writeJson(source: FileSource, path: string, content: Record<string, unknown>): Promise<void> {
  await source.write(path, new TextEncoder().encode(`${JSON.stringify(content, null, 2)}\n`))
}

const isChild = (value: unknown): value is ChildEntry =>
  value !== null && typeof value === 'object' && typeof (value as ChildEntry).Title === 'string' && typeof (value as ChildEntry).CreatedAt === 'string'

/** The notes in `folder` (a notebook's root or a note's short folder) as its `[note-children].json` lists them, oldest index
 * first. When the file is missing or unreadable the folder is scanned instead — each short folder's own `[note].json` — so a
 * notebook made by hand, or damaged, still shows its notes (`repaired` says so). */
export async function readChildren(source: FileSource, folder: string): Promise<{ notes: NoteRef[]; repaired: boolean }> {
  const file = await readJson(source, join(folder, CHILDREN_JSON))
  const children = file?.ChildNotes
  if (children !== null && typeof children === 'object' && !Array.isArray(children)) {
    const notes = Object.entries(children as Record<string, unknown>)
      .filter(([index, value]) => NOTE_INDEX.test(index) && isChild(value))
      .map(([index, value]) => {
        const c = value as ChildEntry
        return { index, folder: join(folder, index), title: c.Title, createdAt: c.CreatedAt, ...(c.UpdatedAt ? { updatedAt: c.UpdatedAt } : {}) }
      })
    return { notes: notes.sort((a, b) => a.index.localeCompare(b.index)), repaired: false }
  }
  const entries = (await source.list(folder, true)).entries
  const notes: NoteRef[] = []
  for (const entry of entries.filter((e) => e.isDirectory && NOTE_INDEX.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const note = await readJson(source, join(folder, entry.name, NOTE_JSON))
    if (typeof note?.Title === 'string') {
      notes.push({
        index: entry.name,
        folder: join(folder, entry.name),
        title: note.Title,
        createdAt: typeof note.CreatedAt === 'string' ? note.CreatedAt : '',
        ...(typeof note.UpdatedAt === 'string' ? { updatedAt: note.UpdatedAt } : {}),
      })
    }
  }
  return { notes, repaired: true }
}

/** The note whose short folder is `folder` (its `[note].json`), or `null` when the folder isn't a note. */
export async function readNote(source: FileSource, folder: string): Promise<NoteRef | null> {
  const note = await readJson(source, join(folder, NOTE_JSON))
  if (typeof note?.Title !== 'string') return null
  return {
    index: baseOf(folder),
    folder,
    title: note.Title,
    createdAt: typeof note.CreatedAt === 'string' ? note.CreatedAt : '',
    ...(typeof note.UpdatedAt === 'string' ? { updatedAt: note.UpdatedAt } : {}),
  }
}

/** The path of a note's markdown file, or `null` when the folder has none. */
export async function findMarkdown(source: FileSource, folder: string): Promise<string | null> {
  const entry = (await source.list(folder)).entries.find((e) => !e.isDirectory && isNoteMarkdown(e.name))
  return entry ? join(folder, entry.name) : null
}

/** The notes above `folder`, from the top (each with its title), up to but not including `notebookRoot` — for the breadcrumbs. */
export async function ancestorsOf(source: FileSource, folder: string, notebookRoot: string): Promise<NoteRef[]> {
  const chain: NoteRef[] = []
  let at = folder
  while (at !== '' && at !== notebookRoot && at.length > notebookRoot.length) {
    const note = await readNote(source, at)
    if (!note) break
    chain.unshift(note)
    at = parentOf(at)
  }
  return chain
}

// ── Writing ───────────────────────────────────────────────────────────────────

/** Puts (or replaces) the entry of a child in the parent's `[note-children].json`, creating the file when there is none. */
async function setChild(source: FileSource, parent: string, ref: NoteRef | null, index: string): Promise<void> {
  const path = join(parent, CHILDREN_JSON)
  const file = (await readJson(source, path)) ?? {}
  let children: Record<string, unknown>
  if (file.ChildNotes !== null && typeof file.ChildNotes === 'object' && !Array.isArray(file.ChildNotes)) {
    children = { ...(file.ChildNotes as Record<string, unknown>) }
  } else {
    // No list (or a damaged one): it is made from the folders, so what was there is not lost.
    children = {}
    for (const n of (await readChildren(source, parent)).notes) children[n.index] = { Title: n.title, CreatedAt: n.createdAt, ...(n.updatedAt ? { UpdatedAt: n.updatedAt } : {}) }
  }
  if (ref) children[index] = { Title: ref.title, CreatedAt: ref.createdAt, ...(ref.updatedAt ? { UpdatedAt: ref.updatedAt } : {}) }
  else delete children[index]
  await writeJson(source, path, { ...file, ChildNotes: children })
}

/** A new note titled `title` in `parent` (a notebook's root or a note's short folder). Everything the note needs is made — its
 * pair of folders, markdown, `[note].json` and `[note-children].json` — before it is listed in its parent's. */
export async function createNote(source: FileSource, parent: string, title: string, now: Date = new Date()): Promise<NoteRef> {
  const clean = title.trim()
  if (!clean) throw new Error('A note needs a title.')
  const names = (await source.list(parent, true)).entries.map((e) => e.name)
  const index = nextNoteIndex(names)
  if (index === null) throw new Error('This folder already has 999 notes.')
  const folder = join(parent, index)
  const marker = join(parent, markerName(index, clean))
  const stamp = dotNetTimestamp(now)

  await source.mkdir(folder)
  await source.mkdir(marker)
  await source.write(join(marker, KEEP), new TextEncoder().encode('-'))
  await writeJson(source, join(folder, NOTE_JSON), { Title: clean, CreatedAt: stamp, UpdatedAt: stamp })
  await source.write(join(folder, markdownName(clean)), new TextEncoder().encode(`${markdownTitle(clean)}\n`))
  await writeJson(source, join(folder, CHILDREN_JSON), { ChildNotes: {} })

  const ref: NoteRef = { index, folder, title: clean, createdAt: stamp, updatedAt: stamp }
  await setChild(source, parent, ref, index)
  return ref
}

/** Gives a note another index in its parent — its short folder and its marker are renamed and the parent's list follows. Refused when
 * the index is not three digits or is already used (by a short folder or a marker). The note's own contents, children and files
 * keep their names: they are inside the folder that moved. */
export async function changeNoteIndex(source: FileSource, note: NoteRef, newIndex: string): Promise<NoteRef> {
  if (!NOTE_INDEX.test(newIndex) || Number(newIndex) === 0) throw new Error('An index is a number from 1 to 999.')
  if (newIndex === note.index) return note
  const parent = parentOf(note.folder)
  const entries = (await source.list(parent, true)).entries
  if (entries.some((e) => e.isDirectory && (e.name === newIndex || NOTE_MARKER.exec(e.name)?.[1] === newIndex))) {
    throw new Error(`The index ${newIndex} is already used here.`)
  }
  const marker = entries.find((e) => e.isDirectory && NOTE_MARKER.exec(e.name)?.[1] === note.index)
  await source.rename(join(parent, note.index), join(parent, newIndex))
  if (marker) await source.rename(join(parent, marker.name), join(parent, `${newIndex}-${NOTE_MARKER.exec(marker.name)![2]}`))
  const moved: NoteRef = { ...note, index: newIndex, folder: join(parent, newIndex) }
  await setChild(source, parent, null, note.index)
  await setChild(source, parent, moved, newIndex)
  return moved
}

/** Gives a note another title: its marker folder and markdown file are renamed, its heading and both JSON files follow. */
export async function renameNote(source: FileSource, note: NoteRef, title: string, now: Date = new Date()): Promise<NoteRef> {
  const clean = title.trim()
  if (!clean) throw new Error('A note needs a title.')
  const parent = parentOf(note.folder)
  const stamp = dotNetTimestamp(now)

  const markdown = await findMarkdown(source, note.folder)
  if (markdown) {
    const text = withTitleHeading(new TextDecoder().decode(await source.read(markdown)), clean)
    await source.write(markdown, new TextEncoder().encode(text))
    const wanted = join(note.folder, markdownName(clean))
    if (wanted !== markdown) await source.rename(markdown, wanted)
  }
  const marker = (await source.list(parent)).entries.find((e) => e.isDirectory && NOTE_MARKER.exec(e.name)?.[1] === note.index)
  if (marker && marker.name !== markerName(note.index, clean)) await source.rename(join(parent, marker.name), join(parent, markerName(note.index, clean)))

  const json = (await readJson(source, join(note.folder, NOTE_JSON))) ?? {}
  await writeJson(source, join(note.folder, NOTE_JSON), { ...json, Title: clean, UpdatedAt: stamp })
  const renamed: NoteRef = { ...note, title: clean, updatedAt: stamp }
  await setChild(source, parent, renamed, note.index)
  return renamed
}

/** Marks a note as changed now (its `[note].json` and its parent's list), e.g. after its markdown was saved. */
export async function touchNote(source: FileSource, note: NoteRef, now: Date = new Date()): Promise<void> {
  const stamp = dotNetTimestamp(now)
  const json = (await readJson(source, join(note.folder, NOTE_JSON))) ?? { Title: note.title, CreatedAt: note.createdAt }
  await writeJson(source, join(note.folder, NOTE_JSON), { ...json, UpdatedAt: stamp })
  await setChild(source, parentOf(note.folder), { ...note, updatedAt: stamp }, note.index)
}

/** Deletes a note — with its children and files — and takes it out of its parent's list. */
export async function deleteNote(source: FileSource, note: NoteRef): Promise<void> {
  const parent = parentOf(note.folder)
  const marker = (await source.list(parent)).entries.find((e) => e.isDirectory && NOTE_MARKER.exec(e.name)?.[1] === note.index)
  await setChild(source, parent, null, note.index)
  await source.remove(note.folder, true)
  if (marker) await source.remove(join(parent, marker.name), true)
}

/** The folder that holds a note's files, made (with its marker) when the note has none yet. */
export async function ensureNoteFiles(source: FileSource, folder: string): Promise<string> {
  const files = join(folder, NOTE_FILES_INDEX)
  const entries: Entry[] = (await source.list(folder, true)).entries
  if (!entries.some((e) => e.isDirectory && e.name === NOTE_FILES_INDEX)) await source.mkdir(files)
  const markerName = `${NOTE_FILES_INDEX}-${NOTE_FILES_NAME}`
  if (!entries.some((e) => e.isDirectory && e.name === markerName)) {
    await source.mkdir(join(folder, markerName))
    await source.write(join(folder, markerName, KEEP), new TextEncoder().encode('-'))
  }
  return files
}
