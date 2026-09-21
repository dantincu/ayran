/** Finding a link in a text editor: where the caret (or the selection) is inside an address, so the editor can offer to open it.
 *
 * What counts as one, in Markdown and in HTML alike: a web address (`https://…`, bare or in `<…>`), the target of a
 * Markdown link or image (`[text](target)`), of a reference (`[ref]: target`), and the value of an `href` or `src` attribute.
 * An address is a **web** address (`http`/`https`) or a **path** — relative to the file being edited, or absolute (from the
 * root of the folder or account the file is in), with an optional `?query` (a note's address has the query key `note`);
 * `#fragment` alone, `mailto:` and the like aren't followed. */

import { URL_PATTERN } from './highlight'

export interface LinkHit {
  /** The address as written. */
  target: string
  /** Where it is in the text (the address itself — not the brackets or quotes round it). */
  start: number
  end: number
  kind: 'web' | 'path'
}

/** What an editor does with a link it was asked to open. */
export type LinkHandler = (link: LinkHit) => void | Promise<void>

/** The editors that can open links, by their `textarea` — `components/CodeEditor.tsx` puts itself here, and the clipboard menu
 * (`components/TextFieldMenu.tsx`) offers "Open link" for a box that is in it. */
export const editorLinkHandlers = new WeakMap<HTMLTextAreaElement, LinkHandler>()

const WEB = new RegExp(URL_PATTERN, 'g')
const MARKDOWN_TARGET = /\]\(\s*<?([^)\s>]+)/g
const REFERENCE_TARGET = /^\s{0,3}\[[^\]\n]+\]:\s*<?([^\s>]+)/
const ATTRIBUTE_TARGET = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi

function kindOf(target: string): LinkHit['kind'] | null {
  if (/^https?:\/\//i.test(target)) return 'web'
  if (target === '' || target.startsWith('#') || target.startsWith('//')) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null // mailto:, tel:, data:, javascript:…
  return 'path'
}

/** Every address in `line` (which begins at `offset` in the whole text). */
function linksOf(line: string, offset: number): LinkHit[] {
  const found: LinkHit[] = []
  const add = (target: string, at: number) => {
    const kind = kindOf(target)
    if (kind) found.push({ target, start: offset + at, end: offset + at + target.length, kind })
  }
  for (const m of line.matchAll(MARKDOWN_TARGET)) add(m[1], m.index + m[0].indexOf(m[1]))
  const reference = REFERENCE_TARGET.exec(line)
  if (reference) add(reference[1], reference[0].indexOf(reference[1]))
  for (const m of line.matchAll(ATTRIBUTE_TARGET)) {
    const value = m[1] ?? m[2] ?? m[3] ?? ''
    add(value, m.index + m[0].lastIndexOf(value))
  }
  for (const m of line.matchAll(WEB)) {
    // A bare address that is a target already found (inside its brackets or quotes) is that one.
    if (!found.some((f) => f.start <= offset + m.index && offset + m.index < f.end)) add(m[0], m.index)
  }
  return found
}

/** Where a path link points, in the storage of the file that holds it. */
export interface LinkedPath {
  /** Relative to the root of the folder or account, without a leading slash; `''` is the root itself. */
  path: string
  /** The query, without its `?` — or `null` when there is none. */
  query: string | null
}

/** The path `target` (as written in the file `fromFile`, itself a path relative to its root) names: a relative path is
 * relative to the folder of the file, an absolute one (`/a/b`) to the root; `.` and `..` are followed, a query and a
 * fragment set aside. `null` when the path climbs out of the root. */
export function resolveLinkedPath(fromFile: string, target: string): LinkedPath | null {
  const cut = target.search(/[?#]/)
  const rawPath = cut < 0 ? target : target.slice(0, cut)
  const query = cut >= 0 && target[cut] === '?' ? target.slice(cut + 1).split('#')[0] : null
  let decoded = rawPath
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    // not percent-encoded after all
  }
  const parts = decoded.startsWith('/') ? [] : fromFile.split('/').filter(Boolean).slice(0, -1)
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(segment)
    }
  }
  return { path: parts.join('/'), query }
}

/** Whether a query names a note (has the key `note`): the address is then a note's, not a folder's or a file's. */
export function isNoteQuery(query: string | null): boolean {
  return query !== null && new URLSearchParams(query).has('note')
}

/** The link the selection touches — the caret in it, or the selected text overlapping it (the first, when it touches several) —
 * or `null` when there is none. Links don't span lines. */
export function linkAt(text: string, selectionStart: number, selectionEnd: number): LinkHit | null {
  const start = Math.min(selectionStart, selectionEnd)
  const end = Math.max(selectionStart, selectionEnd)
  const lineStart = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1
  const lineEndAt = text.indexOf('\n', end)
  const lineEnd = lineEndAt < 0 ? text.length : lineEndAt
  // A selection over several lines: the links of every line it covers.
  const block = text.slice(lineStart, lineEnd)
  const hits: LinkHit[] = []
  let offset = lineStart
  for (const line of block.split('\n')) {
    hits.push(...linksOf(line.endsWith('\r') ? line.slice(0, -1) : line, offset))
    offset += line.length + 1
  }
  const touching = hits.filter((h) => (start === end ? h.start <= start && start <= h.end : h.start < end && start < h.end))
  return touching.sort((a, b) => a.start - b.start)[0] ?? null
}
