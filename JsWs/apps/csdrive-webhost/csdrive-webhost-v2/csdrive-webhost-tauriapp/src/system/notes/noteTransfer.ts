/** **Moving and copying notes under another parent** — over any two `FileSource`s (a folder of this device, a Filen account, in a
 * branch too). Kept apart from `noteModel.ts` because it copies whole trees (`copyTree`), which reaches the backend. */

import { KEEP_CONTENT, KEEP_FILE } from '../../lib/appConfig'
import { gapIndexesIn, indexText, MAX_INDEX, nextIndexesIn, NOTE_ITEMS } from './noteIndexes'
import { deleteNote, join, markerOf, NOTE_MARKER, normalizeChildren, parentOf, partOf, setChild, usedIndexes, type NoteRef } from './noteModel'
import { copyTree, type FileSource } from './sources'

/** How a paste picks the indexes in the new parent: the **next** ones (after the largest of the note items' interval, as a new note
 * gets), the first free ones (**gaps**), or the person's **custom** ones. */
export type PasteIndexes = 'next' | 'gaps' | 'custom'

/** The indexes `count` notes pasted into `parent` of `source` get by default (`next`) or when filling the gaps (`gaps`); `null` when
 * the interval has no room for them all. */
export async function indexesForPaste(source: FileSource, parent: string, count: number, how: Exclude<PasteIndexes, 'custom'>): Promise<number[] | null> {
  const used = usedIndexes((await source.list(parent, true)).entries.map((e) => e.name))
  return how === 'next' ? nextIndexesIn(NOTE_ITEMS, used, count) : gapIndexesIn(NOTE_ITEMS, used, count)
}

/** Puts `notes` (children of one parent of `from`) under `parent` of `to` with the given `indexes` (one each, in order): a **copy**
 * makes new pairs with everything inside them (children, files); a **cut** moves them — renamed within one source, copied and then
 * deleted across two. A note can't go into itself or under one of its own children, and a cut can't put a note where it already is.
 * With `normalizeOld`, the notes that stay behind in the old parent get their indexes normalized afterwards. Returns the notes as they
 * are now. */
export async function placeNotes(
  from: FileSource,
  notes: NoteRef[],
  to: FileSource,
  parent: string,
  indexes: number[],
  mode: 'copy' | 'cut',
  normalizeOld = false,
): Promise<NoteRef[]> {
  if (indexes.length !== notes.length) throw new Error('Every note needs an index.')
  if (indexes.some((index) => !Number.isInteger(index) || index < 1 || index > MAX_INDEX) || new Set(indexes).size !== indexes.length) {
    throw new Error(`The indexes are numbers from 1 to ${MAX_INDEX}, each used once.`)
  }
  const sameSource = from.viewKey === to.viewKey
  for (const note of notes) {
    if (sameSource && (parent === note.folder || parent.startsWith(`${note.folder}/`))) throw new Error(`"${note.title}" can't go into itself.`)
    if (sameSource && mode === 'cut' && parentOf(note.folder) === parent) throw new Error(`"${note.title}" is in this folder already.`)
  }
  const used = new Set(usedIndexes((await to.list(parent, true)).entries.map((e) => e.name)))
  for (const index of indexes) {
    if (used.has(index)) throw new Error(`The index ${indexText(index)} is already used in the folder the notes are going to.`)
  }

  const keep = new TextEncoder().encode(KEEP_CONTENT)
  const placed: NoteRef[] = []
  const oldParents = new Set<string>()
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]
    const text = indexText(indexes[i])
    const oldParent = parentOf(note.folder)
    const oldEntries = (await from.list(oldParent, true)).entries
    const oldMarker = markerOf(oldEntries, note.index)
    const part = NOTE_MARKER.exec(oldMarker?.name ?? '')?.[2] ?? partOf(note.title)
    const folder = join(parent, text)
    const marker = join(parent, `${text}-${part}`)
    if (sameSource && mode === 'cut') {
      await from.rename(note.folder, folder)
      if (oldMarker) await from.rename(join(oldParent, oldMarker.name), marker)
      else {
        await to.mkdir(marker)
        await to.write(join(marker, KEEP_FILE), keep)
      }
    } else {
      await copyTree(from, note.folder, true, to, folder)
      await to.mkdir(marker)
      await to.write(join(marker, KEEP_FILE), keep)
      if (mode === 'cut') await deleteNote(from, note)
    }
    const ref: NoteRef = { ...note, index: text, folder }
    await setChild(to, parent, ref, text)
    if (mode === 'cut') {
      if (sameSource) await setChild(from, oldParent, null, note.index)
      oldParents.add(oldParent)
    }
    placed.push(ref)
  }
  if (mode === 'cut' && normalizeOld) for (const oldParent of oldParents) await normalizeChildren(from, oldParent)
  return placed
}
