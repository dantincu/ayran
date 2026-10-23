/** A single occurrence found by `findMatches` — character offsets into the text that was searched, the same
 * basis `textarea.setSelectionRange` already takes everywhere else in this app's own editor. */
export interface FindMatch {
  start: number
  end: number
}

export interface FindResult {
  matches: FindMatch[]
  /** Set only when `useRegex` and `query` isn't a valid regular expression — the engine's own message, shown
   * to the person rather than thrown back at them. `matches` is always `[]` alongside it. */
  error: string | null
}

/** Caps how many matches a single search ever collects — a pattern that matches very often (or, in regex
 * mode, a pattern that matches the empty string, `a*`) on a large file shouldn't grow this without bound.
 * The same kind of size-based safety net this app already has elsewhere for a cost that scales with file
 * size (e.g. `CodeEditor.tsx`'s own `MAX_LINES_FOR_WRAP_MEASUREMENT`) — matches past this point are simply
 * not found, not an error. */
export const MAX_FIND_MATCHES = 20_000

/** Finds every occurrence of `query` in `text`: a plain, case-insensitive substring search (the same default
 * every other search in this app already uses — see `lib/search.ts`'s own "a plain term is a case-insensitive
 * substring unless Match case"), or, with `useRegex`, `query` read as a JavaScript regular expression —
 * case-sensitive exactly as typed, since there's no separate case-sensitivity control here for the person to
 * reach for a flag with; a regex that can match a zero-length string (`a*`, `x?`) is advanced by one character
 * after such a match so the scan can't loop forever on the same position. */
export function findMatches(text: string, query: string, useRegex: boolean): FindResult {
  if (query === '') return { matches: [], error: null }
  if (useRegex) {
    let re: RegExp
    try {
      re = new RegExp(query, 'g')
    } catch (err) {
      return { matches: [], error: err instanceof Error ? err.message : 'That isn’t a valid regular expression.' }
    }
    const matches: FindMatch[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length })
      if (m[0].length === 0) re.lastIndex++
      if (matches.length >= MAX_FIND_MATCHES) break
    }
    return { matches, error: null }
  }
  const matches: FindMatch[] = []
  const hay = text.toLowerCase()
  const needle = query.toLowerCase()
  let from = 0
  for (;;) {
    const idx = hay.indexOf(needle, from)
    if (idx === -1) break
    matches.push({ start: idx, end: idx + needle.length })
    from = idx + needle.length // non-overlapping, the ordinary meaning of "how many times does X occur"
    if (matches.length >= MAX_FIND_MATCHES) break
  }
  return { matches, error: null }
}

/** The index, into `matches`, of the match to land on when the search itself just changed (a fresh query, or
 * the regex checkbox was toggled) — the first match at or after `anchor` (forward) or at or before it
 * (backward), wrapping to the far end when none qualifies; `null` for an empty list. Previous/Next themselves
 * don't call this — they just step `currentIndex` by one, wrapping — this is only for "where do we land the
 * very first time," the same "Find starts from where you were" convention every editor's own Ctrl+F already
 * follows. */
export function matchIndexNear(matches: FindMatch[], anchor: number, direction: 'forward' | 'backward'): number | null {
  if (matches.length === 0) return null
  if (direction === 'forward') {
    const i = matches.findIndex((m) => m.start >= anchor)
    return i === -1 ? 0 : i
  }
  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i].start <= anchor) return i
  }
  return matches.length - 1
}
