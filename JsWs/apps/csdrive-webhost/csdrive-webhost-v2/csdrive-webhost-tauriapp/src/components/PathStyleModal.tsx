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
      {/* `data-primary-actions` (`lib/buttonRowKeyboard.ts`) is what makes these three buttons a recognized
       * "row of buttons" — Left/Right/Home/End/Page Up/Page Down and the Alt+N/P/./,/]/['/; fast-nav moves
       * already apply to *any* row matching that marker, with no keyboard handling of its own needed here
       * (item 2 of the todo). Without the marker, an unmounted modal's buttons were only ever reached by
       * Alt+Shift+J's own "first enabled button" fallback — which focuses one, but `currentRow()` then finds
       * no row to navigate *within*, since a plain, unmarked `.dialog-actions` matches none of `ROW_SELECTOR`.
       * `autoFocus` on the first button means the row is already usable the instant the modal opens, not only
       * once Alt+Shift+J is pressed by hand. */}
      <div className="dialog-actions" data-primary-actions style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
        <button type="button" autoFocus onClick={() => onPick(relative)}>
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
