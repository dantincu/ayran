import type { ReactNode } from 'react'
import { Maximize2, Minimize2, X } from 'lucide-react'
import IconButton from './IconButton'
import { chordLabel } from '../lib/chords'
import { useMaximizable } from '../lib/modalStack'

/** The popup a file is edited in: a title, the buttons the editor has (`actions`, drawn before the maximize and close buttons),
 * and the editor. It can be maximized like every popup (`Ctrl+K, M`). */
export default function EditorPanel({ title, actions, onClose, children }: { title: ReactNode; actions: ReactNode; onClose: () => void; children: ReactNode }) {
  const { maximized, toggle } = useMaximizable()
  return (
    <div className={`editor-overlay ${maximized ? 'maximized' : ''}`}>
      <div className={`editor-panel ${maximized ? 'maximized' : ''}`}>
        <div className="editor-header">
          <strong>{title}</strong>
          <div>
            {actions}
            <IconButton
              icon={maximized ? Minimize2 : Maximize2}
              label={`${maximized ? 'Restore the size' : 'Maximize'} (${chordLabel('m')})`}
              onClick={toggle}
            />
            <IconButton icon={X} label="Close" onClick={onClose} />
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}
