import { useEffect } from 'react'
import { Maximize2, Minimize2, X } from 'lucide-react'
import IconButton from './IconButton'
import { chordLabel } from '../lib/chords'
import { useMaximizable } from '../lib/modalStack'

interface ModalProps {
  title: string
  /** A wider panel, for a dialog with a list or several fields (it is still at most the window). */
  wide?: boolean
  /** More buttons in the header, before the maximize and close buttons (they are the popup's, outside whatever it shows). */
  actions?: React.ReactNode
  /** An extra class of the panel, for a popup that is laid out in its own way. */
  panelClass?: string
  onClose: () => void
  children: React.ReactNode
}

/** Open modals, oldest first — Escape closes only the top one, so a dialog opened
 * from inside another (e.g. editing a tag from the window-details dialog) doesn't
 * take its parent down with it. */
const openModals: symbol[] = []

export default function Modal({ title, onClose, children, wide, actions, panelClass }: ModalProps) {
  const { maximized, toggle } = useMaximizable()
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
    <div className={`modal-overlay ${maximized ? 'maximized' : ''}`} onClick={onClose}>
      <div className={`modal-panel ${wide ? 'wide' : ''} ${maximized ? 'maximized' : ''} ${panelClass ?? ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>{title}</strong>
          <div className="modal-header-actions">
            {actions}
            <IconButton
              icon={maximized ? Minimize2 : Maximize2}
              label={`${maximized ? 'Restore the size' : 'Maximize'} (${chordLabel('m')})`}
              onClick={toggle}
            />
            <IconButton icon={X} label="Close" onClick={onClose} />
          </div>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}
