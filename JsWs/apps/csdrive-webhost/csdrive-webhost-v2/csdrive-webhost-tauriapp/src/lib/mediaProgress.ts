/** Remembers how far into a video or sound the person got, per file, so reopening it in the media viewer
 * resumes there instead of starting over — backed by Notes' own app state (`data.db`), not browser storage
 * (see `appState.ts`'s own doc comment for why). Pictures have no progress to remember. */

import { getAppState, setAppState } from './appState'
import type { FileRef } from './secondaryWindows'

const KEY = 'notes.mediaProgress'

/** At most this many files' positions are kept — the oldest (by `at`) are dropped first once a new one
 * would push the map past this, so watching a lot of different files over the app's whole lifetime never
 * grows this without bound. */
const MAX_ENTRIES = 300

/** A saved position within this many seconds of the file's own duration is treated as "already finished" —
 * resuming there would just make the person seek back to actually watch it again. */
const NEAR_END_SECONDS = 5

interface Entry {
  time: number
  at: number
}

/** A stable identity for a file across the three kinds of storage `FileRef` can name — never a real path,
 * only what the ref itself already carries (see CLAUDE.md's "No real paths for web apps"). */
function fileRefKey(file: FileRef): string {
  if (file.storage === 'FilenCloud') return `filen:${file.userId ?? ''}:${file.branch ?? ''}:${file.path}`
  if (file.storage === 'DeviceFolder') return `device:${file.root ?? ''}:${file.path}`
  return `user:${file.path}`
}

async function readAll(): Promise<Record<string, Entry>> {
  return (await getAppState<Record<string, Entry>>(KEY).catch(() => undefined)) ?? {}
}

/** The saved position for this file, or `null` when there is none, or it's close enough to the file's own
 * `duration` that resuming there wouldn't actually help (see [`NEAR_END_SECONDS`]) — `duration` of `0` (not
 * known yet) skips that check rather than treating every saved position as "near the end". */
export async function mediaProgress(file: FileRef, duration: number): Promise<number | null> {
  const entry = (await readAll())[fileRefKey(file)]
  if (!entry || entry.time <= 1) return null
  if (duration > 0 && entry.time >= duration - NEAR_END_SECONDS) return null
  return entry.time
}

/** Remembers how far into this file the person got (bounded — see [`MAX_ENTRIES`]). */
export async function saveMediaProgress(file: FileRef, time: number): Promise<void> {
  const all = await readAll()
  const key = fileRefKey(file)
  const others = Object.keys(all).filter((k) => k !== key)
  if (others.length >= MAX_ENTRIES) {
    others.sort((a, b) => all[a].at - all[b].at)
    for (const k of others.slice(0, others.length - MAX_ENTRIES + 1)) delete all[k]
  }
  all[key] = { time, at: Date.now() }
  await setAppState(KEY, all).catch(() => {})
}

/** Forgets a file's saved position — once it has actually played to the end, there's nothing left to resume. */
export async function clearMediaProgress(file: FileRef): Promise<void> {
  const all = await readAll()
  delete all[fileRefKey(file)]
  await setAppState(KEY, all).catch(() => {})
}
