import { useCallback, useEffect, useState } from 'react'
import { modalWasMaximized, setModalMaximized } from './modalMaximize'

/** The popups that can be **maximized** — a dialog (`components/Modal.tsx`) — in the order they opened, so the chord that
 * maximizes (`Ctrl+K, M`, see `lib/chords.ts`) acts on the top one. A maximized popup takes the whole window less a margin
 * (thin on a phone, up to 40px on a Full HD screen) so it still reads as a popup. (The file editors used to be a maximizable
 * popup of their own, `components/EditorPanel.tsx` — they are dedicated pages now, not popups, so there is nothing left to
 * maximize there; this stack is `Modal`-only today.)
 *
 * **Remembers whether this kind of dialog was last left maximized** (`lib/modalMaximize.ts`, keyed by `title`) —
 * asked for directly — and starts that way again next time: a mount effect checks the remembered value and, only
 * if it says "maximized", flips to it (so a dialog that was never remembered, or was remembered as *not*
 * maximized, behaves exactly as it always did — starting plain). Every `toggle()`, the one and only way
 * `maximized` ever changes, persists the new value — there is no separate "save" step to forget. */

interface Entry {
  toggle: () => void
}

const stack: Entry[] = []

/** `maximized` and its toggle, for a popup that is on screen while the calling component is mounted. `title` is
 * the dialog's own (`Modal`'s `title` prop) — the key its remembered maximized state is kept under. */
export function useMaximizable(title: string): { maximized: boolean; toggle: () => void } {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    let alive = true
    modalWasMaximized(title).then((was) => {
      if (alive && was) setMaximized(true)
    })
    return () => {
      alive = false
    }
  }, [title])
  const toggle = useCallback(() => {
    setMaximized((m) => {
      const next = !m
      setModalMaximized(title, next)
      return next
    })
  }, [title])
  useEffect(() => {
    const entry: Entry = { toggle }
    stack.push(entry)
    return () => {
      stack.splice(stack.indexOf(entry), 1)
    }
  }, [toggle])
  return { maximized, toggle }
}

export const anyMaximizable = () => stack.length > 0

/** Maximizes (or restores) the popup on top. */
export function toggleTopMaximizable(): void {
  stack[stack.length - 1]?.toggle()
}
