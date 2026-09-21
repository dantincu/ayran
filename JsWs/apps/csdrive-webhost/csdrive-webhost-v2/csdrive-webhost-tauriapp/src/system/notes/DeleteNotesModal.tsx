import { useState } from 'react'
import { Check, X } from 'lucide-react'
import IconButton from '../../components/IconButton'
import Modal from '../../components/Modal'
import type { NoteRef } from './noteModel'

/** Asks before notes are deleted — and whether the indexes of the notes that stay should be **normalized** afterwards (the gaps the
 * deleted ones leave closed, each interval from its start, the order kept). */
export default function DeleteNotesModal({
  notes,
  canNormalize = true,
  onConfirm,
  onClose,
}: {
  notes: NoteRef[]
  /** Renumbering the notes that remain is not offered while the list is searched or sorted (their indexes are not in view). */
  canNormalize?: boolean
  onConfirm: (normalize: boolean) => void
  onClose: () => void
}) {
  const [normalize, setNormalize] = useState(false)
  return (
    <Modal title="Delete notes" onClose={onClose} wide>
      <div className="pair-modal">
        <div>
          Delete {notes.length === 1 ? <strong>"{notes[0].title}"</strong> : <strong>{notes.length} notes</strong>}, with their child notes and files? This cannot be undone.
        </div>
        {notes.length > 1 && (
          <ul className="delete-list">
            {notes.slice(0, 8).map((n) => (
              <li key={n.index}>
                <code>{n.index}</code> {n.title}
              </li>
            ))}
            {notes.length > 8 && <li className="muted">…and {notes.length - 8} more</li>}
          </ul>
        )}
        {canNormalize && (
          <label className="pair-check">
            <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} /> Normalize the indexes of the notes that remain
          </label>
        )}
        <div className="toolbar-actions" style={{ justifyContent: 'flex-end' }}>
          <IconButton icon={Check} label="Delete" variant="danger" onClick={() => onConfirm(canNormalize && normalize)} />
          <IconButton icon={X} label="Cancel" onClick={onClose} />
        </div>
      </div>
    </Modal>
  )
}
