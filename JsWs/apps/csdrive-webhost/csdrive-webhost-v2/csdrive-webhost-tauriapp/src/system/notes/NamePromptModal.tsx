import { useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import IconButton from '../../components/IconButton'
import Modal from '../../components/Modal'
import InsertCustomTextButton from './InsertCustomTextButton'
import type { FileSource } from './sources'

/** A plain "type a name" dialog — **New folder…** and **New file…** in the File Manager and the Note Files
 * Explorer, replacing their own `window.prompt()` so the name field can carry the same "Insert custom text"
 * button the item 1 follow-up asks for ("when creating... a file or note"): a native prompt can't host a
 * button of its own. `validate` returns an error message, or `null` when `name` (already trimmed) is fine;
 * it's checked again right before `onSubmit` in case the folder's own contents changed meanwhile. */
export default function NamePromptModal({
  title,
  label,
  initialValue = '',
  validate,
  source,
  sourceId,
  folder,
  onSubmit,
  onClose,
}: {
  title: string
  label: string
  initialValue?: string
  validate: (name: string) => string | null
  source: FileSource
  sourceId: string
  folder: string
  onSubmit: (name: string) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(initialValue)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function submit() {
    if (busy) return
    const trimmed = name.trim()
    const problem = validate(trimmed)
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit(trimmed)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="pair-modal">
        <label className="notes-field notes-field-leading">
          <span>{label}</span>
          <input ref={inputRef} autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          <InsertCustomTextButton source={source} sourceId={sourceId} folder={folder} inputRef={inputRef} value={name} onChange={setName} />
        </label>
        {error && <div className="error-banner">{error}</div>}
        <div className="toolbar-actions" style={{ justifyContent: 'flex-end' }}>
          <IconButton icon={Check} label="OK" onClick={submit} disabled={busy} />
          <IconButton icon={X} label="Cancel" onClick={onClose} />
        </div>
      </div>
    </Modal>
  )
}
