import { useSyncExternalStore } from 'react'
import type { NoteRef } from './noteModel'
import type { FileSource } from './sources'

/** **The notes that were cut or copied**, waiting to be pasted under another parent (`PasteNotesModal`). It is kept in the page — the
 * notes are only named here, nothing is read until they are pasted — so it lasts while this window shows Notes, whichever notes page is
 * on screen, and is gone with the window. (It is not the app's own clipboard, which holds text.) */
export interface NoteClipboard {
  /** Where the notes are. */
  source: FileSource
  notes: NoteRef[]
  mode: 'copy' | 'cut'
}

let current: NoteClipboard | null = null
const listeners = new Set<() => void>()

export function setNoteClipboard(next: NoteClipboard | null): void {
  current = next
  listeners.forEach((listener) => listener())
}

export const getNoteClipboard = () => current

/** The notes clipboard, and a re-render whenever it changes. */
export function useNoteClipboard(): NoteClipboard | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => current,
  )
}
