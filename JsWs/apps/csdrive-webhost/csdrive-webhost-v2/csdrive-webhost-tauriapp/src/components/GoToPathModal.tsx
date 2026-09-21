import { useState } from 'react'
import { ClipboardPaste, ClipboardType, CornerDownRight, X } from 'lucide-react'
import IconButton from './IconButton'
import Modal from './Modal'
import { internalClipboard, readOsClipboard } from '../lib/clipboard'
import { parsePathInput } from '../lib/pathInput'

interface Props {
  title?: string
  /** The path the listing is at now, to start from (edited, or replaced by a paste). */
  current: string
  /** What the box takes, in a line (which paths, from where they start). */
  hint: string
  /** Goes to the folder named by `segments`; answers why it can't (shown in the box, which stays open), or `null` when it did. */
  onGo: (segments: string[], query: string | null) => Promise<string | null>
  onClose: () => void
}

/** "Go to a path": a box to type a path into — or paste one that was copied from another listing's details — and go there.
 * The two paste buttons replace the box's text with what is on the OS clipboard or on the app's own. */
export default function GoToPathModal({ title = 'Go to a path', current, hint, onGo, onClose }: Props) {
  const [text, setText] = useState(current)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function go() {
    const parsed = parsePathInput(text)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const problem = await onGo(parsed.segments, parsed.query)
      if (problem === null) onClose()
      else setError(problem)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function paste(from: 'os' | 'app') {
    try {
      const pasted = from === 'os' ? await readOsClipboard() : await internalClipboard.get()
      if (pasted === '') setError(from === 'os' ? 'The clipboard is empty.' : "The app's clipboard is empty.")
      else {
        setText(pasted.trim())
        setError(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-field-label">{hint}</div>
      <input
        autoFocus
        className={error ? 'invalid' : ''}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value)
          setError(null)
        }}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') go()
        }}
      />
      {error && <div className="error-banner">{error}</div>}
      <div className="toolbar-actions" style={{ justifyContent: 'flex-end' }}>
        <IconButton icon={ClipboardPaste} label="Paste the path from the clipboard" onClick={() => paste('os')} />
        <IconButton icon={ClipboardType} label="Paste the path from the app's clipboard" onClick={() => paste('app')} />
        <IconButton icon={CornerDownRight} label="Go" disabled={busy} onClick={go} />
        <IconButton icon={X} label="Cancel" onClick={onClose} />
      </div>
    </Modal>
  )
}
