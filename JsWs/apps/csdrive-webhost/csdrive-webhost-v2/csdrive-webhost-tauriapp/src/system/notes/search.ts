/** **Searching and sorting the Notes file managers and the notes** — plain functions and generators, nothing here draws anything.
 *
 * **What can be asked** (`SearchCriteria`): by **name** (a file's or folder's name, a note's title), by **contents** (a file's text, a
 * note's markdown), by **last modified** and **created** time and by **size** (each an *interval* whose either edge may be left out —
 * that edge is then infinity), by **extension**, and by **type** (files / folders). Every text term can be read as a **regular
 * expression**; a regular expression on the contents is applied **line by line** or to **the whole contents** (then the newlines are the
 * expression's business). The **depth** is how many levels are searched — 1, the folder itself, by default; no limit if asked.
 *
 * **Nothing is ever collected.** A search is an *async generator* that walks the tree folder by folder and yields one hit at a time; a
 * `ResultPager` pulls from it only as far as the page on screen needs (and keeps just a handful of pages), so a search that finds a
 * million things holds a page or two of them — and a folder's listing at a time, the way the File Manager already lists. What that costs
 * is the order: results are **grouped by folder** — the folder's own hits (sorted as asked) first, then each subfolder's — and every hit
 * says which folder it is in (its *ancestors*: a path for files and folders, the titles of the parent notes for a note). A *global*
 * sort of a deep search would need every hit in memory at once, so it is not offered; within a folder (and, at depth 1, everywhere) the
 * sort is exact.
 *
 * **Sorting** (`SortSpec`): by name, extension, time stamps or size, ascending or descending, folders first or not — applied to a
 * listing and, per folder, to the hits of a search. */

import { joinRelative } from '../../lib/localFs'
import { findMarkdown, readChildren, type NoteRef } from './noteModel'
import type { Entry, FileSource } from './sources'

// ── What is asked ─────────────────────────────────────────────────────────────

export interface TextTerm {
  text: string
  /** The text is a regular expression. */
  regex: boolean
  matchCase: boolean
}

export interface ContentTerm extends TextTerm {
  /** A regular expression on the contents: applied to each line, or to the whole contents. */
  mode: 'lines' | 'whole'
}

/** An interval; an edge that is `null` is left out — infinity. */
export interface Range {
  from: number | null
  to: number | null
}

export interface SearchCriteria {
  kind: 'any' | 'files' | 'folders'
  name: TextTerm
  extension: TextTerm
  content: ContentTerm
  /** Last modified (ms since 1970). */
  modified: Range
  created: Range
  /** Bytes; files only. */
  size: Range
  /** How many levels are searched: 1 is the folder itself; `null`, no limit. */
  depth: number | null
}

const emptyTerm = (): TextTerm => ({ text: '', regex: false, matchCase: false })
const emptyRange = (): Range => ({ from: null, to: null })

export function emptyCriteria(): SearchCriteria {
  return {
    kind: 'any',
    name: emptyTerm(),
    extension: emptyTerm(),
    content: { ...emptyTerm(), mode: 'lines' },
    modified: emptyRange(),
    created: emptyRange(),
    size: emptyRange(),
    depth: 1,
  }
}

const hasRange = (r: Range) => r.from !== null || r.to !== null

// ── Sorting ───────────────────────────────────────────────────────────────────

export type SortKey = 'default' | 'name' | 'extension' | 'modified' | 'created' | 'size'

export interface SortSpec {
  /** `default`: as the listing is (a file manager: folders first, by name; a list of notes: by index). */
  key: SortKey
  descending: boolean
  /** Files and folders: folders before files, whatever the key. */
  foldersFirst: boolean
}

export const DEFAULT_SORT: SortSpec = { key: 'default', descending: false, foldersFirst: true }

/** Whether sorting changes the order a listing is in (a list of notes then no longer is in the order of its indexes). */
export const isSorted = (sort: SortSpec) => sort.key !== 'default' || sort.descending

/** What a sort looks at, for a file, a folder or a note. */
export interface SortItem {
  name: string
  isDirectory: boolean
  size: number | null
  modifiedMs: number | null
  createdMs: number | null
  /** A note's index, for the default order of a list of notes. */
  index?: number
}

const NAME_ORDER: Intl.CollatorOptions = { numeric: true, sensitivity: 'base' }

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function compareItems(a: SortItem, b: SortItem, sort: SortSpec): number {
  if (sort.foldersFirst && a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
  const byName = () => a.name.localeCompare(b.name, undefined, NAME_ORDER)
  const sign = sort.descending ? -1 : 1
  // A missing value (a size, a date nobody knows) goes last, in either direction.
  const number = (x: number | null, y: number | null) => (x === null && y === null ? 0 : x === null ? 1 : y === null ? -1 : sign * (x - y))
  switch (sort.key) {
    case 'name':
      return sign * byName()
    case 'extension':
      return sign * extensionOf(a.name).localeCompare(extensionOf(b.name)) || sign * byName()
    case 'modified':
      return number(a.modifiedMs, b.modifiedMs) || byName()
    case 'created':
      return number(a.createdMs, b.createdMs) || byName()
    case 'size':
      return number(a.size, b.size) || byName()
    default:
      // The listing's own order: by index for notes; for files, by name (folders first, as a file manager lists).
      return a.index !== undefined && b.index !== undefined ? sign * (a.index - b.index) : sign * byName()
  }
}

const itemOfEntry = (e: Entry): SortItem => ({ name: e.name, isDirectory: e.isDirectory, size: e.size, modifiedMs: e.mtimeMs, createdMs: e.createdMs ?? null })

/** The entries of a listing sorted (a copy). */
export function sortEntries(entries: Entry[], sort: SortSpec): Entry[] {
  return [...entries].sort((a, b) => compareItems(itemOfEntry(a), itemOfEntry(b), sort))
}

const timeOf = (stamp: string | undefined): number | null => {
  const t = stamp ? Date.parse(stamp) : NaN
  return Number.isNaN(t) ? null : t
}
const itemOfNote = (n: NoteRef): SortItem => ({ name: n.title, isDirectory: false, size: null, modifiedMs: timeOf(n.updatedAt ?? n.createdAt), createdMs: timeOf(n.createdAt), index: Number(n.index) })

/** The notes of a list sorted (a copy): by title, time stamps, or — the default — by index. */
export function sortNotes(notes: NoteRef[], sort: SortSpec): NoteRef[] {
  return [...notes].sort((a, b) => compareItems(itemOfNote(a), itemOfNote(b), { ...sort, foldersFirst: false }))
}

// ── Matching ──────────────────────────────────────────────────────────────────

type Matcher = (text: string) => boolean

/** The text term as a test, `null` when the term is empty, or an error message (a regular expression that isn't one). */
export function compileTerm(term: TextTerm): Matcher | string | null {
  if (term.text === '') return null
  if (term.regex) {
    try {
      const re = new RegExp(term.text, term.matchCase ? '' : 'i')
      return (text) => re.test(text)
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }
  if (term.matchCase) return (text) => text.includes(term.text)
  const wanted = term.text.toLowerCase()
  return (text) => text.toLowerCase().includes(wanted)
}

/** The extension term as a test on a file's extension: plain, it is a list (`jpg, png .gif`) and any of them matches; a regular
 * expression is tested on the extension. */
export function compileExtension(term: TextTerm): Matcher | string | null {
  if (term.text.trim() === '') return null
  if (term.regex) return compileTerm(term)
  const wanted = term.text
    .split(/[\s,;]+/)
    .map((t) => t.replace(/^\./, ''))
    .filter(Boolean)
    .map((t) => (term.matchCase ? t : t.toLowerCase()))
  return (ext) => wanted.includes(term.matchCase ? ext : ext.toLowerCase())
}

/** Where a term was found in a text: its line (from 1) and a piece of that line to show. */
export interface ContentMatch {
  line: number
  snippet: string
}

const SNIPPET = 160

function snippetAround(text: string, index: number, length: number): string {
  const start = text.lastIndexOf('\n', index - 1) + 1
  const end = text.indexOf('\n', index + length)
  const line = text.slice(start, end < 0 ? text.length : end).replace(/\r$/, '')
  if (line.length <= SNIPPET) return line.trim()
  const at = index - start
  const from = Math.max(0, at - SNIPPET / 2)
  return `${from > 0 ? '…' : ''}${line.slice(from, from + SNIPPET).trim()}${from + SNIPPET < line.length ? '…' : ''}`
}

const lineOf = (text: string, index: number) => {
  let line = 1
  for (let i = text.indexOf('\n'); i >= 0 && i < index; i = text.indexOf('\n', i + 1)) line++
  return line
}

/** The contents term as a search of a text: the first place it is found, or `null`; an error message for a bad regular expression;
 * `null` itself when the term is empty. */
export function contentMatcher(term: ContentTerm): ((text: string) => ContentMatch | null) | string | null {
  if (term.text === '') return null
  if (!term.regex) {
    const wanted = term.matchCase ? term.text : term.text.toLowerCase()
    return (text) => {
      const at = (term.matchCase ? text : text.toLowerCase()).indexOf(wanted)
      return at < 0 ? null : { line: lineOf(text, at), snippet: snippetAround(text, at, wanted.length) }
    }
  }
  let re: RegExp
  try {
    re = new RegExp(term.text, term.matchCase ? '' : 'i')
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  if (term.mode === 'whole') {
    return (text) => {
      const m = re.exec(text)
      return m ? { line: lineOf(text, m.index), snippet: snippetAround(text, m.index, m[0].length) } : null
    }
  }
  return (text) => {
    let line = 1
    for (const piece of text.split('\n')) {
      const s = piece.endsWith('\r') ? piece.slice(0, -1) : piece
      if (re.test(s)) return { line, snippet: s.length > SNIPPET ? `${s.slice(0, SNIPPET).trim()}…` : s.trim() }
      line++
    }
    return null
  }
}

const inRange = (value: number | null, r: Range) => (!hasRange(r) ? true : value === null ? false : (r.from === null || value >= r.from) && (r.to === null || value <= r.to))

/** The problems with a set of criteria (a regular expression that doesn't compile, an interval that ends before it starts, a depth that
 * isn't a number of levels), one message each; empty when they can be searched. */
export function problemsWith(c: SearchCriteria): string[] {
  const out: string[] = []
  for (const [what, compiled] of [['The name', compileTerm(c.name)], ['The extension', compileExtension(c.extension)], ['The contents', contentMatcher(c.content)]] as const) {
    if (typeof compiled === 'string') out.push(`${what}: ${compiled}`)
  }
  for (const [what, r] of [['modified', c.modified], ['created', c.created], ['size', c.size]] as const) {
    if (r.from !== null && r.to !== null && r.from > r.to) out.push(`The ${what} interval ends before it starts.`)
  }
  if (c.depth !== null && (!Number.isInteger(c.depth) || c.depth < 1)) out.push('The depth is a number of levels, 1 or more.')
  return out
}

// ── Walking the tree ──────────────────────────────────────────────────────────

/** A search running: whether it was cancelled, and what it has looked at so far (the page shows it). */
export interface SearchContext {
  aborted: boolean
  stats: { folders: number; examined: number; skipped: number; failed: number }
}

export const newContext = (): SearchContext => ({ aborted: false, stats: { folders: 0, examined: 0, skipped: 0, failed: 0 } })

/** A file over this is not read to search its contents (it is counted as skipped) — nothing big is pulled into the page for a search. */
export const MAX_CONTENT_BYTES = 10 * 1024 * 1024
/** A tree is never walked deeper than this, even when "no limit" is asked (links can make a tree endless). */
export const HARD_DEPTH = 100

/** The text of bytes, or `null` when they look binary (a NUL in the first 8 000 characters). */
export function textOf(bytes: Uint8Array): string | null {
  const text = new TextDecoder('utf-8').decode(bytes)
  return text.slice(0, 8000).includes('\u0000') ? null : text
}

export interface FileHit {
  entry: Entry
  /** The folder it is in, relative to the source's root. */
  folder: string
  path: string
  /** Where the contents term was found. */
  match?: ContentMatch
}

/** Walks `start` (a folder of `source`) for the entries that satisfy `c`, yielding them **one at a time**, folder by folder: a folder's
 * hits — sorted as asked — and then its subfolders', down to the depth asked. */
export async function* searchFiles(source: FileSource, start: string, c: SearchCriteria, sort: SortSpec, ctx: SearchContext): AsyncGenerator<FileHit> {
  const compiledName = compileTerm(c.name)
  const compiledExtension = compileExtension(c.extension)
  const compiledContent = contentMatcher(c.content)
  if (typeof compiledName === 'string' || typeof compiledExtension === 'string' || typeof compiledContent === 'string') return
  const name: Matcher | null = compiledName
  const extension: Matcher | null = compiledExtension
  const content: ((text: string) => ContentMatch | null) | null = compiledContent
  const needsDetails = hasRange(c.modified) || hasRange(c.created) || hasRange(c.size) || content !== null || ['modified', 'created', 'size'].includes(sort.key)

  const passes = (e: Entry): boolean => {
    if (c.kind === 'files' && e.isDirectory) return false
    if (c.kind === 'folders' && !e.isDirectory) return false
    if (name && !name(e.name)) return false
    // What only a file has: an extension, a size, contents.
    if ((extension || hasRange(c.size) || content) && e.isDirectory) return false
    if (extension && !extension(extensionOf(e.name))) return false
    if (!inRange(e.size, c.size)) return false
    return inRange(e.mtimeMs, c.modified) && inRange(e.createdMs ?? null, c.created)
  }

  async function* walk(folder: string, levels: number): AsyncGenerator<FileHit> {
    if (ctx.aborted) return
    let entries: Entry[]
    try {
      const listing = await (needsDetails && source.listDetailed ? source.listDetailed(folder) : source.list(folder))
      entries = sortEntries(listing.entries, sort)
    } catch {
      ctx.stats.failed++
      return
    }
    ctx.stats.folders++
    for (const entry of entries) {
      if (ctx.aborted) return
      ctx.stats.examined++
      if (!passes(entry)) continue
      const path = joinRelative(folder, entry.name)
      if (!content) {
        yield { entry, folder, path }
        continue
      }
      if (entry.size !== null && entry.size > MAX_CONTENT_BYTES) {
        ctx.stats.skipped++
        continue
      }
      try {
        const text = textOf(await source.read(path))
        if (text === null) {
          ctx.stats.skipped++
          continue
        }
        const match = content(text)
        if (match) yield { entry, folder, path, match }
      } catch {
        ctx.stats.failed++
      }
    }
    if (levels > 1) for (const entry of entries) if (entry.isDirectory) yield* walk(joinRelative(folder, entry.name), levels - 1)
  }

  yield* walk(start, Math.min(c.depth ?? HARD_DEPTH, HARD_DEPTH))
}

export interface NoteHit {
  note: NoteRef
  /** The titles of the notes above it, from the folder searched down — where it is. */
  trail: string[]
  match?: ContentMatch
}

/** The same for **notes**: walks the children of `folder` (a notebook's root or a note's folder), then theirs, to the depth asked. A
 * note's name is its title, its times are the ones in its `[note].json`, its contents are its markdown. */
export async function* searchNotes(source: FileSource, folder: string, c: SearchCriteria, sort: SortSpec, ctx: SearchContext): AsyncGenerator<NoteHit> {
  const compiledName = compileTerm(c.name)
  const compiledContent = contentMatcher(c.content)
  if (typeof compiledName === 'string' || typeof compiledContent === 'string') return
  const name: Matcher | null = compiledName
  const content: ((text: string) => ContentMatch | null) | null = compiledContent

  async function* walk(at: string, levels: number, trail: string[]): AsyncGenerator<NoteHit> {
    if (ctx.aborted) return
    let notes: NoteRef[]
    try {
      notes = sortNotes((await readChildren(source, at)).notes, sort)
    } catch {
      ctx.stats.failed++
      return
    }
    ctx.stats.folders++
    for (const note of notes) {
      if (ctx.aborted) return
      ctx.stats.examined++
      if (name && !name(note.title)) continue
      if (!inRange(timeOf(note.updatedAt ?? note.createdAt), c.modified) || !inRange(timeOf(note.createdAt), c.created)) continue
      if (!content) {
        yield { note, trail }
        continue
      }
      try {
        const markdown = await findMarkdown(source, note.folder)
        if (!markdown) continue
        const text = textOf(await source.read(markdown))
        if (text === null || text.length > MAX_CONTENT_BYTES) {
          ctx.stats.skipped++
          continue
        }
        const match = content(text)
        if (match) yield { note, trail, match }
      } catch {
        ctx.stats.failed++
      }
    }
    if (levels > 1) for (const note of notes) yield* walk(note.folder, levels - 1, [...trail, note.title])
  }

  yield* walk(folder, Math.min(c.depth ?? HARD_DEPTH, HARD_DEPTH), [])
}

// ── Paging without collecting ─────────────────────────────────────────────────

/** Pulls the results of a search **a page at a time** and keeps only the last few pages. Going to a page that was dropped starts the
 * search again and reads on to it — slower for the rare person who goes far back, never more memory. `known` is how many results have
 * been pulled so far (the total once `done`). */
export class ResultPager<T> {
  private gen: AsyncGenerator<T> | null = null
  private consumed = 0
  private finished = false
  private pages = new Map<number, T[]>()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly factory: () => AsyncGenerator<T>
  readonly pageSize: number
  private readonly keep: number

  constructor(factory: () => AsyncGenerator<T>, pageSize: number, keep = 6) {
    this.factory = factory
    this.pageSize = pageSize
    this.keep = keep
  }

  get done() {
    return this.finished
  }

  get known() {
    return this.consumed
  }

  /** Page `page` (from 0). Loads are taken one after another, so a quick double press can't pull twice. */
  load(page: number): Promise<T[]> {
    const next = this.queue.then(() => this.pull(page))
    this.queue = next.catch(() => undefined)
    return next
  }

  /** Stops the search (it may be in the middle of a folder). */
  async dispose(): Promise<void> {
    this.pages.clear()
    await this.gen?.return(undefined)
    this.gen = null
  }

  private async pull(page: number): Promise<T[]> {
    const cached = this.pages.get(page)
    if (cached) {
      this.pages.delete(page)
      this.pages.set(page, cached) // most recently used last
      return cached
    }
    if (this.gen === null || page * this.pageSize < this.consumed) {
      await this.gen?.return(undefined)
      this.gen = this.factory()
      this.consumed = 0
      this.finished = false
    }
    while (!this.finished && Math.floor(this.consumed / this.pageSize) <= page) {
      const items: T[] = []
      while (items.length < this.pageSize) {
        const next = await this.gen.next()
        if (next.done) {
          this.finished = true
          break
        }
        items.push(next.value)
      }
      if (items.length > 0) {
        this.pages.set(Math.floor(this.consumed / this.pageSize), items)
        this.consumed += items.length
        while (this.pages.size > this.keep) this.pages.delete(this.pages.keys().next().value as number)
      }
    }
    return this.pages.get(page) ?? []
  }
}

// ── The form ──────────────────────────────────────────────────────────────────

/** What the search panel holds while a person types — text, before it is turned into `SearchCriteria`. */
export interface SearchForm {
  nameText: string
  nameRegex: boolean
  nameCase: boolean
  extText: string
  extRegex: boolean
  contentText: string
  contentRegex: boolean
  contentCase: boolean
  contentMode: 'lines' | 'whole'
  kind: SearchCriteria['kind']
  /** `datetime-local` values (`2026-09-21T08:30`); empty is an edge left out. */
  modFrom: string
  modTo: string
  creFrom: string
  creTo: string
  sizeFrom: string
  sizeTo: string
  sizeUnit: 'B' | 'KB' | 'MB' | 'GB'
  depthText: string
  unlimited: boolean
}

export const emptyForm = (): SearchForm => ({
  nameText: '', nameRegex: false, nameCase: false,
  extText: '', extRegex: false,
  contentText: '', contentRegex: false, contentCase: false, contentMode: 'lines',
  kind: 'any',
  modFrom: '', modTo: '', creFrom: '', creTo: '',
  sizeFrom: '', sizeTo: '', sizeUnit: 'KB',
  depthText: '1', unlimited: false,
})

const UNIT: Record<SearchForm['sizeUnit'], number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }

/** A `datetime-local` value as ms since 1970 (local time); the *end* of an interval is the end of the minute typed. */
function stamp(text: string, end: boolean): number | null | 'bad' {
  if (text.trim() === '') return null
  const t = new Date(text).getTime()
  return Number.isNaN(t) ? 'bad' : end ? t + 59_999 : t
}

function amount(text: string, unit: number, what: string): number | null | string {
  if (text.trim() === '') return null
  const n = Number(text.replace(',', '.'))
  return Number.isFinite(n) && n >= 0 ? Math.round(n * unit) : `The ${what} isn't a number.`
}

/** The form as criteria, or the problems with it. */
export function criteriaOf(f: SearchForm): { criteria: SearchCriteria; problems: string[] } {
  const problems: string[] = []
  const times = (from: string, to: string, what: string): Range => {
    const a = stamp(from, false)
    const b = stamp(to, true)
    if (a === 'bad' || b === 'bad') {
      problems.push(`The ${what} interval has a date that isn't one.`)
      return { from: null, to: null }
    }
    return { from: a, to: b }
  }
  const sizes = (): Range => {
    const a = amount(f.sizeFrom, UNIT[f.sizeUnit], 'smallest size')
    const b = amount(f.sizeTo, UNIT[f.sizeUnit], 'largest size')
    for (const x of [a, b]) if (typeof x === 'string') problems.push(x)
    return { from: typeof a === 'number' ? a : null, to: typeof b === 'number' ? b : null }
  }
  let depth: number | null = 1
  if (f.unlimited) depth = null
  else {
    const n = Number(f.depthText)
    if (!Number.isInteger(n) || n < 1) problems.push('The depth is a number of levels, 1 or more.')
    else depth = n
  }
  const criteria: SearchCriteria = {
    kind: f.kind,
    name: { text: f.nameText, regex: f.nameRegex, matchCase: f.nameCase },
    extension: { text: f.extText, regex: f.extRegex, matchCase: false },
    content: { text: f.contentText, regex: f.contentRegex, matchCase: f.contentCase, mode: f.contentMode },
    modified: times(f.modFrom, f.modTo, 'modified'),
    created: times(f.creFrom, f.creTo, 'created'),
    size: sizes(),
    depth,
  }
  return { criteria, problems: [...problems, ...problemsWith(criteria)] }
}
