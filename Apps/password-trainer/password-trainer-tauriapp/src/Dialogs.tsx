import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { errorText, type Entry } from './api'
import { PasswordInput } from './PasswordInput'

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}

/**
 * Adds a password (`entry` undefined) or edits one: its label, and — only when typed — a new password.
 * `onSave` hashes on the backend; the plain text lives only in this dialog's state until it closes.
 */
export function EditDialog({ entry, onSave, onClose }: {
  entry?: Entry
  onSave: (label: string, password: string | null) => Promise<void>
  onClose: () => void
}) {
  const adding = !entry
  const [label, setLabel] = useState(entry?.label ?? '')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const labelRef = useRef<HTMLInputElement>(null)
  useEffect(() => labelRef.current?.focus(), [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!label.trim()) return setError('Please give it a label.')
    if (adding && !password) return setError('Please type the password.')
    if (password !== confirm) return setError("The two passwords don't match.")
    setBusy(true)
    setError(null)
    try {
      await onSave(label.trim(), password ? password : null)
      onClose()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <Modal title={adding ? 'Add a password' : 'Edit password'} onClose={busy ? () => {} : onClose}>
      <form onSubmit={submit} className="form">
        <label>
          Label
          <input ref={labelRef} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200}
            autoComplete="off" />
        </label>
        <label>
          {adding ? 'Password' : 'New password (leave empty to keep the current one)'}
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label>
          Repeat the password
          <PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)}
            disabled={!adding && !password && !confirm} />
        </label>
        <p className="hint">Only a salted hash of the password is stored, never the password itself.</p>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}

export function ConfirmDialog({ title, message, confirmText, onConfirm, onClose }: {
  title: string
  message: string
  confirmText: string
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const go = async () => {
    setBusy(true)
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }
  return (
    <Modal title={title} onClose={busy ? () => {} : onClose}>
      <p>{message}</p>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="danger" onClick={go} disabled={busy}>{confirmText}</button>
      </div>
    </Modal>
  )
}
