import { useCallback, useEffect, useState } from 'react'

/** The popups that can be **maximized** — a dialog (`components/Modal.tsx`) or an editor (`components/EditorPanel.tsx`) — in the
 * order they opened, so the chord that maximizes (`Ctrl+K, M`, see `lib/chords.ts`) acts on the top one. A maximized popup takes
 * the whole window less a margin (thin on a phone, up to 40px on a Full HD screen) so it still reads as a popup. */

interface Entry {
  toggle: () => void
}

const stack: Entry[] = []

/** `maximized` and its toggle, for a popup that is on screen while the calling component is mounted. */
export function useMaximizable(): { maximized: boolean; toggle: () => void } {
  const [maximized, setMaximized] = useState(false)
  const toggle = useCallback(() => setMaximized((m) => !m), [])
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
