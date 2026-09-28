import Modal from './Modal'

/** The second (and last) step of "Insert a path…": the explorer (`FileExplorerModal`, or Notes' own
 * `InsertPathModal`) already named the file — this just asks whether to insert it relative to the file being
 * edited or as an absolute path (from the notebook root, in a note editor, or the storage root otherwise — the
 * caller has already worked out both strings, this only shows them). */
export default function PathStyleModal({
  relative,
  absolute,
  onPick,
  onClose,
}: {
  relative: string
  absolute: string
  onPick: (text: string) => void
  onClose: () => void
}) {
  return (
    <Modal title="Insert this path" onClose={onClose}>
      <div className="dialog-actions" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
        <button type="button" onClick={() => onPick(relative)}>
          Relative — <code>{relative}</code>
        </button>
        <button type="button" onClick={() => onPick(absolute)}>
          Absolute — <code>{absolute}</code>
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}
