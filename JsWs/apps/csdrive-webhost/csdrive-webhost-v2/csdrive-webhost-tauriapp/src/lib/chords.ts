import { useEffect, useRef } from 'react'

/** **Two-key shortcuts.** One key, held with Ctrl (⌘ on a Mac), takes a shortcut per letter, and there are only so many
 * letters — so the app's shortcuts are *chords*: press **Ctrl+K**, let go, then press a letter. While the chord is waiting a small
 * hint (`components/ChordHost.tsx`) lists what the letters do (and a wrong letter or Esc cancels it). A chord's actions
 * are registered by whatever owns them, while it is on screen (`useChord`), so the list is the one that applies *here*.
 * The list of every chord, for the people who use them, is `docs/keyboard-shortcuts.md`. */

export interface ChordAction {
  /** The letter, lower case. */
  letter: string
  /** What it does, as the hint says it. */
  label: string
  run: () => void | Promise<void>
  /** Whether it applies right now (a copy needs a text box in focus); hidden from the hint and ignored when it doesn't. */
  enabled?: () => boolean
}

/** Every registered action, oldest first; for a letter that two registered, the newest wins. */
const registered: ChordAction[] = []
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((l) => l())

/** Registers `action` until the returned function is called. */
export function registerChord(action: ChordAction): () => void {
  registered.push(action)
  changed()
  return () => {
    const at = registered.indexOf(action)
    if (at >= 0) registered.splice(at, 1)
    changed()
  }
}

/** The actions that apply now, one per letter, in letter order. */
export function chordActions(): ChordAction[] {
  const byLetter = new Map<string, ChordAction>()
  for (const action of registered) {
    if (action.enabled === undefined || action.enabled()) byLetter.set(action.letter, action)
  }
  return [...byLetter.values()].sort((a, b) => a.letter.localeCompare(b.letter))
}

export function onChordsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The letter that starts every chord (with Ctrl, or ⌘ on a Mac). */
export const CHORD_PREFIX = 'k'

/** How a chord is written in tooltips and documents: `Ctrl+K, T`. */
export function chordLabel(letter: string): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  return `${mac ? '⌘' : 'Ctrl+'}${CHORD_PREFIX.toUpperCase()}, ${letter.toUpperCase()}`
}

/** Registers a chord action while the calling component is mounted (the latest `run` is always the one called). */
export function useChord(letter: string, label: string, run: () => void | Promise<void>, enabled?: () => boolean): void {
  const latest = useRef({ run, enabled })
  latest.current = { run, enabled }
  useEffect(
    () =>
      registerChord({
        letter,
        label,
        run: () => latest.current.run(),
        enabled: () => latest.current.enabled?.() ?? true,
      }),
    [letter, label],
  )
}
