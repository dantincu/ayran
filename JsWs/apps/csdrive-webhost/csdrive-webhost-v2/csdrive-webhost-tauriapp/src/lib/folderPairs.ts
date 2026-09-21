import { config, KEEP_CONTENT, KEEP_FILE, MAX_NAME_PART_CHARS } from './appConfig'

/** **Folder pairs** as the frontend makes them (the mechanism is `src-tauri/src/folder_pairs.rs`; the idea is
 * `docs/strategies/folder-pairs-strategy.md`): a short folder `NNN` and, beside it, a full folder `NNN-<readable part>` that holds only
 * a `.keep` — the constants (the keep file and its content, the longest part, the default numbering) come from the config file. */

/** The characters a file name can't have on every platform, as the hint of a box shows them. */
export const INVALID_NAME_CHARACTERS = '< > : " \\ | ? *'

/** What the default numbering is called for: no prefix, upward from `001`, three digits, first free (`config.folderPairs.defaultNumbering`). */
const numbering = config.folderPairs.defaultNumbering

const pad = (index: number) => String(index).padStart(numbering.digits, '0')

/** The index a new pair gets in a folder that holds `names`: the first that no folder uses, from the numbering's start — a short
 * folder `NNN` and a full folder `NNN-…` both count as using it. */
export function nextPairIndex(names: Iterable<string>): string {
  const used = new Set<number>()
  for (const name of names) {
    const m = /^(\d+)(?:-|$)/.exec(name)
    if (m) used.add(Number(m[1]))
  }
  let index = numbering.from
  while (used.has(index)) index++
  return pad(index)
}

/** A short folder's name from what a person typed: anything a folder can be called — the characters no platform allows are dropped, so
 * are the dots and spaces Windows drops at the end. */
export function shortNameFrom(text: string): string {
  return Array.from(text)
    .filter((c) => c.charCodeAt(0) >= 32 && !'<>:"/\\|?*'.includes(c))
    .join('')
    .trim()
    .replace(/[. ]+$/, '')
}

/** The names of a pair: the short folder and the full one (`<short>-<part>`). */
export const pairNames = (short: string, part: string) => ({ short, full: `${short}-${part}` })

/** What goes into the full folder: its `.keep`, with the content the config says. */
export const keepFile = () => ({ name: KEEP_FILE, content: new TextEncoder().encode(KEEP_CONTENT) })

/** The longest part a title may make (see `namePartFromTitle`). */
export const MAX_PART = MAX_NAME_PART_CHARS
