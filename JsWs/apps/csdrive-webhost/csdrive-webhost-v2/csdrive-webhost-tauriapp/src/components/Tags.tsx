import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Check, Tag, X } from 'lucide-react'
import IconButton from './IconButton'
import Modal from './Modal'
import {
  addWindowTag,
  removeWindowTag,
  reorderWindowTags,
  updateWindowTag,
  type TagRecord,
} from '../lib/secondaryWindows'

const PRESET_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
  '#3b82f6', '#8b5cf6', '#ec4899', '#ffffff', '#000000', '#6b7280',
]

const DRAG_MIME = 'application/x-csdrive-tag'

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="color-field">
      <span className="muted">{label}</span>
      <div className="color-swatches">
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`color-swatch ${value.toLowerCase() === c ? 'selected' : ''}`}
            style={{ background: c }}
            onClick={() => onChange(c)}
            title={c}
          />
        ))}
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="color-custom"
          title="Custom color"
        />
      </div>
    </div>
  )
}

interface TagModalProps {
  title: string
  submitLabel: string
  initial?: { text: string; fgColor: string; bgColor: string }
  onSubmit: (text: string, fgColor: string, bgColor: string) => void
  onClose: () => void
  /** Only when editing an existing tag: nudge its position among its siblings. */
  reorder?: { canMoveEarlier: boolean; canMoveLater: boolean; onMove: (delta: -1 | 1) => void }
}

function TagModal({ title, submitLabel, initial, onSubmit, onClose, reorder }: TagModalProps) {
  const [text, setText] = useState(initial?.text ?? '')
  const [fgColor, setFgColor] = useState(initial?.fgColor ?? '#ffffff')
  const [bgColor, setBgColor] = useState(initial?.bgColor ?? '#3b82f6')

  function submit() {
    if (text.trim()) onSubmit(text.trim(), fgColor, bgColor)
  }

  return (
    <Modal title={title} onClose={onClose}>
      <input
        autoFocus
        placeholder="tag text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      <ColorField label="Text color" value={fgColor} onChange={setFgColor} />
      <ColorField label="Background color" value={bgColor} onChange={setBgColor} />
      <div>
        <div className="modal-field-label">Preview</div>
        <span className="tag-badge tag-preview" style={{ color: fgColor, background: bgColor }}>
          {text.trim() || 'preview'}
        </span>
      </div>
      <div className="tag-modal-footer">
        {reorder ? (
          <div className="toolbar-actions">
            <IconButton
              icon={ChevronLeft}
              label="Move earlier"
              disabled={!reorder.canMoveEarlier}
              onClick={() => reorder.onMove(-1)}
            />
            <IconButton
              icon={ChevronRight}
              label="Move later"
              disabled={!reorder.canMoveLater}
              onClick={() => reorder.onMove(1)}
            />
          </div>
        ) : (
          <span />
        )}
        <div className="toolbar-actions">
          <IconButton icon={Check} label={submitLabel} disabled={!text.trim()} onClick={submit} />
          <IconButton icon={X} label="Cancel" onClick={onClose} />
        </div>
      </div>
    </Modal>
  )
}

interface TagListProps {
  /** What the tags are attached to — a window/group/tab guid, or any other stable id. */
  guid: string
  tags: TagRecord[]
  /** Class for the wrapping flex container, so each place tags appear can lay it out. */
  className?: string
  /** Called after any change is saved, for places whose data isn't refreshed by the
   * backend's `secondary-windows-changed` event. */
  onChanged?: () => void
  onError: (message: string) => void
  /** Show the list — with its "add tag" button — even when there are no tags. Only the record's details popup does: a
   * listing shows a row of tags for a record that has some, and nothing for one that has none (so no empty row). */
  showWhenEmpty?: boolean
}

/** A tag's badges plus an "add tag" button: click a badge's text to edit it, drag
 * badges to reorder them (or use the arrows in the edit dialog), × to remove.
 * With no tags it shows nothing (unless `showWhenEmpty`): the first tag is added from the details of the record. */
export function TagList({ guid, tags, className, onChanged, onError, showWhenEmpty = false }: TagListProps) {
  // `undefined` = dialog closed, `null` = adding a new tag, a number = editing that tag.
  const [dialog, setDialog] = useState<number | null | undefined>(undefined)
  const [dropTargetId, setDropTargetId] = useState<number | null>(null)
  const draggingId = useRef<number | null>(null)

  async function run(action: () => Promise<unknown>) {
    try {
      await action()
      onChanged?.()
    } catch (e) {
      onError(String(e))
    }
  }

  function moveTag(id: number, toIndex: number) {
    const ids = tags.map((t) => t.id)
    const from = ids.indexOf(id)
    if (from === -1 || toIndex < 0 || toIndex >= ids.length || from === toIndex) return
    ids.splice(from, 1)
    ids.splice(toIndex, 0, id)
    void run(() => reorderWindowTags(guid, ids))
  }

  const editing = typeof dialog === 'number' ? tags.find((t) => t.id === dialog) : undefined
  const editingIndex = editing ? tags.indexOf(editing) : -1

  if (tags.length === 0 && !showWhenEmpty) return null

  return (
    <div className={className}>
      {tags.map((tag, index) => (
        <span
          key={tag.id}
          className={`tag-badge tag-badge-sortable ${dropTargetId === tag.id ? 'tag-badge-drop-target' : ''}`}
          style={{ color: tag.fgColor, background: tag.bgColor }}
          draggable
          // Tags often sit inside other drag-reorderable rows (see ReorderList); stop
          // these events so dragging a tag never also drags/drops its row.
          onDragStart={(e) => {
            e.stopPropagation()
            draggingId.current = tag.id
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData(DRAG_MIME, String(tag.id))
          }}
          onDragEnd={() => {
            draggingId.current = null
            setDropTargetId(null)
          }}
          onDragOver={(e) => {
            if (draggingId.current === null) return
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            setDropTargetId(tag.id)
          }}
          onDragLeave={() => setDropTargetId((current) => (current === tag.id ? null : current))}
          onDrop={(e) => {
            const dragged = draggingId.current
            if (dragged === null) return
            e.preventDefault()
            e.stopPropagation()
            draggingId.current = null
            setDropTargetId(null)
            moveTag(dragged, index)
          }}
        >
          <button className="tag-text" onClick={() => setDialog(tag.id)} title="Edit tag" aria-label={`Edit tag ${tag.text}`}>
            {tag.text}
          </button>
          <button
            className="tag-remove"
            onClick={() => void run(() => removeWindowTag(tag.id))}
            title="Remove tag"
            aria-label="Remove tag"
          >
            <X size={11} strokeWidth={2.5} aria-hidden="true" />
          </button>
        </span>
      ))}
      <button className="add-tag-button" onClick={() => setDialog(null)} title="Add tag" aria-label="Add tag">
        <Tag size={12} strokeWidth={2} aria-hidden="true" />
      </button>

      {dialog === null &&
        createPortal(
        <TagModal
          title="Add tag"
          submitLabel="Add tag"
          onSubmit={(text, fg, bg) => {
            setDialog(undefined)
            void run(() => addWindowTag(guid, text, fg, bg))
          }}
          onClose={() => setDialog(undefined)}
        />,
          document.body,
        )}

      {editing &&
        createPortal(
        <TagModal
          title="Edit tag"
          submitLabel="Save"
          initial={{ text: editing.text, fgColor: editing.fgColor, bgColor: editing.bgColor }}
          onSubmit={(text, fg, bg) => {
            setDialog(undefined)
            void run(() => updateWindowTag(editing.id, text, fg, bg))
          }}
          onClose={() => setDialog(undefined)}
          reorder={{
            canMoveEarlier: editingIndex > 0,
            canMoveLater: editingIndex < tags.length - 1,
            onMove: (delta) => moveTag(editing.id, editingIndex + delta),
          }}
        />,
          document.body,
        )}
    </div>
  )
}
