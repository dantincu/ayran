/** **The indexes of notes** — plain functions, nothing here touches a disk (see `noteModel.ts` for the operations on the disk).
 *
 * A note's index is the three-digit name of its short folder (`999`). The indexes are not one long run: the config file
 * (`config/folder-pairs-and-notes.json`, `notes.numberings`) gives each *kind* its own **interval** — note items `999`→`401` going down,
 * and the note sections `199`→`111`, `299`→`201`, `399`→`301` — so several kinds can share one parent folder without ever taking each
 * other's numbers (`docs/strategies/folder-pairs-strategy.md`). A note whose index is in none of them (the notes of the first
 * versions of the app were numbered `001`, `002`…) is **outside the intervals**: it is listed and works as ever, and can be *converted*
 * into an interval.
 *
 * What is here: the intervals, the next index of one (**after the largest**: one step past the furthest in use, in the interval's
 * direction), and the three ways a set of notes gets new indexes *at once* — **normalize** (close the gaps of every interval, keeping
 * the order), **convert** (move the notes of one interval into another) and **reorder** (a note takes another place in the list: the
 * *same* indexes are handed out again in the new order). Each takes the current assignment and answers the new one; the caller shows it,
 * lets the person adjust it, and only then writes it to the disk in one go. */

import { config, type NumberingDef } from '../../lib/appConfig'

export interface NoteInterval extends NumberingDef {
  key: string
}

export const NOTE_INTERVALS: NoteInterval[] = Object.entries(config.notes.numberings).map(([key, def]) => ({ ...def, key }))
/** The interval of the note items — what a new note is numbered from. */
export const NOTE_ITEMS: NoteInterval = NOTE_INTERVALS.find((interval) => interval.key === 'noteItems')!

/** How many digits an index has, and the largest one. */
export const INDEX_DIGITS = NOTE_ITEMS.digits
export const MAX_INDEX = 10 ** INDEX_DIGITS - 1

export const low = (interval: NumberingDef) => Math.min(interval.from, interval.to)
export const high = (interval: NumberingDef) => Math.max(interval.from, interval.to)
export const descends = (interval: NumberingDef) => interval.from > interval.to
export const inInterval = (interval: NumberingDef, index: number) => index >= low(interval) && index <= high(interval)

/** The interval an index is in, or `null` when it is in none. */
export function intervalOf(index: number): NoteInterval | null {
  return NOTE_INTERVALS.find((interval) => inInterval(interval, index)) ?? null
}

/** The words for where an index sits. */
export const intervalLabel = (index: number) => intervalOf(index)?.label ?? 'Outside the intervals'

/** `5` → `005`. */
export const indexText = (index: number) => String(index).padStart(INDEX_DIGITS, '0')

/** What a person typed as an index (`5`, `005`): the number, or `null` when it isn't one from 1 to the largest. */
export function parseIndex(text: string): number | null {
  const trimmed = text.trim()
  if (!new RegExp(`^\\d{1,${INDEX_DIGITS}}$`).test(trimmed)) return null
  const index = Number(trimmed)
  return index >= 1 && index <= MAX_INDEX ? index : null
}

/** The index a new note of `interval` gets when `used` are the indexes already there (by short folders or markers): **one step past
 * the furthest in use**, in the interval's direction — the interval's start when none is used — or, for a `fillGaps` interval, the
 * first free one. `null` when the interval has no room (for *after the largest*: nothing lies beyond the furthest index, even if there
 * are gaps behind it: normalizing makes room). */
export function nextIndexIn(interval: NumberingDef, used: Iterable<number>): number | null {
  const inside = [...used].filter((index) => inInterval(interval, index))
  const step = descends(interval) ? -1 : 1
  if (interval.indexing === 'afterLargest') {
    if (inside.length === 0) return interval.from
    const furthest = descends(interval) ? Math.min(...inside) : Math.max(...inside)
    const next = furthest + step
    return inInterval(interval, next) ? next : null
  }
  const taken = new Set(inside)
  for (let index = interval.from; inInterval(interval, index); index += step) if (!taken.has(index)) return index
  return null
}

/** The next indexes for `count` new notes of `interval` (each one after the one before), or `null` if there isn't room for them all. */
export function nextIndexesIn(interval: NumberingDef, used: Iterable<number>, count: number): number[] | null {
  const taken = new Set(used)
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const next = nextIndexIn(interval, taken)
    if (next === null) return null
    out.push(next)
    taken.add(next)
  }
  return out
}

/** The first free indexes of `interval` (gaps first), for `count` notes — what pasting into a parent can do "to fill its gaps". */
export function gapIndexesIn(interval: NumberingDef, used: Iterable<number>, count: number): number[] | null {
  const taken = new Set(used)
  const step = descends(interval) ? -1 : 1
  const out: number[] = []
  for (let index = interval.from; inInterval(interval, index) && out.length < count; index += step) if (!taken.has(index)) out.push(index)
  return out.length === count ? out : null
}

// ── Giving many notes new indexes at once ─────────────────────────────────────

/** Which note holds which index: `key` names the note (its current index, as text), `index` is what it holds — now or after. */
export interface Assignment {
  key: string
  index: number
}

const inDirection = (interval: NumberingDef | null) => (a: number, b: number) => (interval !== null && descends(interval) ? b - a : a - b)

/** **Normalizes**: in each interval the notes are given consecutive indexes from the interval's start, in the order they are in (`999`,
 * `997`, `995` become `999`, `998`, `997`), and the notes outside the intervals close their gaps upward from the lowest of them. Every
 * note stays in its own interval — that is what "respecting the intervals where they sit" means — and the order never changes. */
export function normalize(rows: Assignment[]): Assignment[] {
  const groups = new Map<NoteInterval | null, Assignment[]>()
  for (const row of rows) {
    const interval = intervalOf(row.index)
    groups.set(interval, [...(groups.get(interval) ?? []), row])
  }
  const result = new Map<string, number>()
  for (const [interval, members] of groups) {
    const ordered = [...members].sort((a, b) => inDirection(interval)(a.index, b.index))
    const start = interval !== null ? interval.from : Math.min(...members.map((m) => m.index))
    const step = interval !== null && descends(interval) ? -1 : 1
    const next = ordered.map((_, i) => start + i * step)
    // Outside the intervals, the compacted run must not run into one (it can't leave the span it was in, but the span may have spanned one).
    const safe = interval !== null || next.every((index) => intervalOf(index) === null)
    ordered.forEach((row, i) => result.set(row.key, safe ? next[i] : row.index))
  }
  return rows.map((row) => ({ key: row.key, index: result.get(row.key) ?? row.index }))
}

/** The keys of the notes whose index is in `interval` (`null`: outside every interval) — what "select the whole interval" selects. */
export function keysInInterval(rows: Assignment[], interval: NumberingDef | null): string[] {
  return rows.filter((row) => (interval === null ? intervalOf(row.index) === null : inInterval(interval, row.index))).map((row) => row.key)
}

/** **Converts** the **selected** notes (`selected`: their keys) to indexes in `to`: they keep their order — the notes outside the intervals
 * first, then each interval in the order of the config, each in its own direction — and take the first free indexes of `to` from its
 * start, skipping the ones other notes hold. A selected note that is in `to` already stays where it is. Throws when `to` has no room. */
export function convert(rows: Assignment[], selected: Iterable<string>, to: NumberingDef): Assignment[] {
  const chosen = new Set(selected)
  const moving = rows.filter((row) => chosen.has(row.key) && !inInterval(to, row.index))
  if (moving.length === 0) return rows
  const stay = new Set(rows.filter((row) => !moving.includes(row)).map((row) => row.index))
  const free = gapIndexesIn(to, stay, moving.length)
  if (free === null) throw new Error(`"${to.label}" has room for fewer than ${moving.length} more note${moving.length === 1 ? '' : 's'}.`)
  // Outside the intervals first, then the intervals in the config's order; inside each, the interval's own direction.
  const rank = (row: Assignment) => {
    const interval = intervalOf(row.index)
    return interval === null ? -1 : NOTE_INTERVALS.indexOf(interval)
  }
  const ordered = [...moving].sort((a, b) => rank(a) - rank(b) || inDirection(intervalOf(a.index))(a.index, b.index))
  const result = new Map(ordered.map((row, i) => [row.key, free[i]]))
  return rows.map((row) => ({ key: row.key, index: result.get(row.key) ?? row.index }))
}

/** **Reorders**: `rows` are in the order they are shown; the one at `from` is moved to `to`, and the indexes the rows held are handed
 * out again **in the new order** (smallest first, top to bottom) — so a note takes another one's place and nothing else changes: the
 * same set of indexes, gaps and intervals included. */
export function reorder(rows: Assignment[], from: number, to: number): Assignment[] {
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return rows
  const slots = rows.map((row) => row.index).sort((a, b) => a - b)
  const moved = [...rows]
  const [row] = moved.splice(from, 1)
  moved.splice(to, 0, row)
  return moved.map((r, i) => ({ key: r.key, index: slots[i] }))
}

/** What is wrong with an assignment: the indexes held by more than one note, and the ones that aren't an index. */
export function problems(rows: Array<{ key: string; index: number | null }>): { duplicates: Set<number>; invalid: Set<string> } {
  const seen = new Set<number>()
  const duplicates = new Set<number>()
  const invalid = new Set<string>()
  for (const row of rows) {
    if (row.index === null) invalid.add(row.key)
    else if (seen.has(row.index)) duplicates.add(row.index)
    else seen.add(row.index)
  }
  return { duplicates, invalid }
}
