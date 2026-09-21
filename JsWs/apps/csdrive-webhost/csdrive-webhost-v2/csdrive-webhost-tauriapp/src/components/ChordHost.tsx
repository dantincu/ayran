import { useEffect, useRef, useState } from 'react'
import { anyMaximizable, toggleTopMaximizable } from '../lib/modalStack'
import { chordActions, CHORD_PREFIX, chordLabel, onChordsChanged, useChord, type ChordAction } from '../lib/chords'
import { internalClipboard } from '../lib/clipboard'
import { isShortcut } from '../lib/keyboard'

/** How long a chord waits for its second key. */
const CHORD_WAIT_MS = 3000

/** How long the hint stays, lit, on the shortcut that was just pressed. */
const HIT_MS = 600

/** The two-key shortcuts of this page (`lib/chords.ts`): **Ctrl+K**, then a letter. Mounted once per page, next to the clipboard
 * menu. It owns the chords that belong to no one screen — maximize the popup on top, clear the app's clipboard — and shows the
 * hint of what the letters do while a chord waits. */
export default function ChordHost() {
  const [waiting, setWaiting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  /** The shortcut that matched the second key: its entry in the hint glows for a moment, whatever it goes on to do. */
  const [hit, setHit] = useState<{ letter: string; label: string } | null>(null)
  const hitTimer = useRef<number | undefined>(undefined)
  const [, redraw] = useState(0)
  const waitingRef = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const messageTimer = useRef<number | undefined>(undefined)

  useChord('m', 'Maximize or restore the dialog', toggleTopMaximizable, anyMaximizable)
  useChord('x', "Clear the app's clipboard", async () => {
    await internalClipboard.clear()
    tell("The app's clipboard is empty now.")
  })

  function tell(text: string) {
    setMessage(text)
    window.clearTimeout(messageTimer.current)
    messageTimer.current = window.setTimeout(() => setMessage(null), 2200)
  }

  function stopWaiting() {
    waitingRef.current = false
    setWaiting(false)
    window.clearTimeout(timer.current)
  }

  useEffect(() => onChordsChanged(() => redraw((n) => n + 1)), [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (waitingRef.current) {
        if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return // the modifiers being let go
        e.preventDefault()
        e.stopPropagation()
        stopWaiting()
        if (e.key === 'Escape') return
        const action: ChordAction | undefined = chordActions().find((a) => a.letter === e.key.toLowerCase())
        if (!action) {
          tell(`${chordLabel(e.key.length === 1 ? e.key : '?')} is not a shortcut.`)
          return
        }
        setHit({ letter: action.letter, label: action.label })
        window.clearTimeout(hitTimer.current)
        hitTimer.current = window.setTimeout(() => setHit(null), HIT_MS)
        Promise.resolve(action.run()).catch((err) => tell(err instanceof Error ? err.message : String(err)))
        return
      }
      if (isShortcut(e, CHORD_PREFIX)) {
        e.preventDefault()
        e.stopPropagation()
        waitingRef.current = true
        setWaiting(true)
        timer.current = window.setTimeout(stopWaiting, CHORD_WAIT_MS)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  if (!waiting && !message && !hit) return null
  return (
    <div className={`chord-hint ${waiting ? 'waiting' : ''} ${hit ? 'matched' : ''}`} role="status">
      {waiting ? (
        <>
          <strong>{chordLabel('…')}</strong>
          {chordActions().map((a) => (
            <span key={a.letter}>
              <kbd>{a.letter.toUpperCase()}</kbd> {a.label}
            </span>
          ))}
        </>
      ) : hit ? (
        <span className="hit">
          <kbd>{hit.letter.toUpperCase()}</kbd> {hit.label}
        </span>
      ) : (
        message
      )}
    </div>
  )
}
