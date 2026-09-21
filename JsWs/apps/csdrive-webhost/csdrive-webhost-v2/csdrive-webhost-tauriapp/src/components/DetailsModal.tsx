import { useState, type ReactNode } from 'react'
import { Check, ClipboardCopy, Copy, Eye, EyeOff } from 'lucide-react'
import IconButton from './IconButton'
import Modal from './Modal'
import { TagList } from './Tags'
import { copyToOsClipboard, internalClipboard } from '../lib/clipboard'
import type { TagRecord } from '../lib/secondaryWindows'

/** One line of a record's details. */
export interface DetailField {
  label: string
  value: string
  /** Shown in a monospaced font and allowed to break anywhere (paths, ids). */
  mono?: boolean
  /** Kept out of sight until the person asks (an id): the value shows as dots behind an eye button. */
  hidden?: boolean
  /** Whether the value can be copied to the OS clipboard and to the app's own clipboard (default: yes). */
  copy?: boolean
}

interface Props {
  title: string
  fields: DetailField[]
  /** The record's tags. **Adding the first one is done here**: a listing shows a tag row only for a record that has tags. */
  tags?: { guid: string; tags: TagRecord[]; onChanged?: () => void }
  /** More to show under the fields (buttons, a list…). */
  children?: ReactNode
  onClose: () => void
  onError: (message: string) => void
}

/** The popup every listing opens for one of its records — what the record is, each value copyable to the OS clipboard or to
 * the app's own (`lib/clipboard.ts`), an id kept hidden until asked for — and where its tags are edited, the first one
 * included. */
export default function DetailsModal({ title, fields, tags, children, onClose, onError }: Props) {
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState<string | null>(null)

  function said(text: string) {
    setCopied(text)
    setTimeout(() => setCopied((current) => (current === text ? null : current)), 1600)
  }

  async function copy(field: DetailField, to: 'os' | 'app') {
    try {
      if (to === 'os') await copyToOsClipboard(field.value)
      else await internalClipboard.set(field.value)
      said(`${field.label}: copied to ${to === 'os' ? 'the clipboard' : "the app's clipboard"}`)
    } catch (e) {
      onError(String(e))
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      {fields.map((field) => {
        const hidden = field.hidden && !revealed.has(field.label)
        return (
          <div key={field.label}>
            <div className="modal-field-label">{field.label}</div>
            <div className="modal-guid-row">
              <span className={`details-value ${field.mono ? 'window-item-guid' : ''}`}>{hidden ? '••••••••••••••••' : field.value || '—'}</span>
              {field.hidden && (
                <IconButton
                  icon={hidden ? Eye : EyeOff}
                  label={hidden ? `Show the ${field.label.toLowerCase()}` : `Hide the ${field.label.toLowerCase()}`}
                  onClick={() =>
                    setRevealed((current) => {
                      const next = new Set(current)
                      if (next.has(field.label)) next.delete(field.label)
                      else next.add(field.label)
                      return next
                    })
                  }
                />
              )}
              {field.copy !== false && field.value && (
                <>
                  <IconButton icon={Copy} label={`Copy the ${field.label.toLowerCase()} to the clipboard`} onClick={() => copy(field, 'os')} />
                  <IconButton icon={ClipboardCopy} label={`Copy the ${field.label.toLowerCase()} to the app's own clipboard`} onClick={() => copy(field, 'app')} />
                </>
              )}
            </div>
          </div>
        )
      })}

      {tags && (
        <div>
          <div className="modal-field-label">Tags</div>
          <TagList guid={tags.guid} tags={tags.tags} className="window-item-tags tag-list-flush" showWhenEmpty onChanged={tags.onChanged} onError={onError} />
        </div>
      )}

      {children}

      <div className="details-status" aria-live="polite">
        {copied ? (
          <span className="muted">
            <Check size={12} aria-hidden="true" /> {copied}
          </span>
        ) : (
          ''
        )}
      </div>
    </Modal>
  )
}
