import { useState } from 'react'
import { Check, X } from 'lucide-react'
import IconButton from './IconButton'
import Modal from './Modal'

/** The "Edit link" / "Insert a link" popup of a text editor's clipboard menu (`TextFieldMenu.tsx`): two boxes —
 * the link's text and its address — for a markdown link, `[text](address)`. Used both to edit the link the caret
 * was in (both boxes start filled) and to insert a new one (both start empty, or the text pre-filled from
 * whatever was selected when the menu was opened). Enter in either box, or the button, submits; an address of
 * nothing but spaces can't be — a link needs somewhere to go — but the text may be empty (`[](address)` is a
 * married but valid, if odd, markdown link, and forcing one would lose whatever the person meant to clear). */
export default function MarkdownLinkModal({
  heading,
  initialText,
  initialAddress,
  onSubmit,
  onCancel,
}: {
  heading: string
  initialText: string
  initialAddress: string
  onSubmit: (text: string, address: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initialText)
  const [address, setAddress] = useState(initialAddress)
  const valid = address.trim() !== ''

  function submit() {
    if (!valid) return
    onSubmit(text, address.trim())
  }

  return (
    <Modal title={heading} onClose={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="modal-field-label">Link text — what it reads as</div>
        <input data-ua-field="textMenu.link.text" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="(optional)" />
        <div className="modal-field-label" style={{ marginTop: 10 }}>
          Link address — a web address, or a path
        </div>
        <input data-ua-field="textMenu.link.address" className={!valid && address !== '' ? 'invalid' : ''} value={address} onChange={(e) => setAddress(e.target.value)} />
        <div className="toolbar-actions" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <IconButton icon={Check} label="Save" disabled={!valid} onClick={submit} />
          <IconButton icon={X} label="Cancel" onClick={onCancel} />
        </div>
      </form>
    </Modal>
  )
}
