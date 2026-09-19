import { useEffect } from 'react'
import { X } from 'lucide-react'
import IconButton from './IconButton'

interface ModalProps {
  title: string
  onClose: () => void
  children: React.ReactNode
}

/** Open modals, oldest first — Escape closes only the top one, so a dialog opened
 * from inside another (e.g. editing a tag from the window-details dialog) doesn't
 * take its parent down with it. */
const openModals: symbol[] = []

export default function Modal({ title, onClose, children }: ModalProps) {
  useEffect(() => {
    const token = Symbol('modal')
    openModals.push(token)
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && openModals[openModals.length - 1] === token) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      openModals.splice(openModals.indexOf(token), 1)
    }
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>{title}</strong>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}
