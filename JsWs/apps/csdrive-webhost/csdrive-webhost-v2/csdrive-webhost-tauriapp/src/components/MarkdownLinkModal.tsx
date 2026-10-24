import { useState } from 'react'
import { ArrowUp, Check, ExternalLink, X } from 'lucide-react'
import IconButton from './IconButton'
import Modal from './Modal'

/** A plain `http(s)://…` address — the only kind "Open in external browser" (below) makes sense for; a bare
 * relative or account-absolute path (the other thing this popup's address box accepts) has nothing to open in
 * a browser at all. */
const WEB_ADDRESS = /^https?:\/\//i

/** The "Edit link" / "Insert a link" popup of a text editor's clipboard menu (`TextFieldMenu.tsx`): two boxes —
 * the link's text and its address — for a markdown link, `[text](address)`. Used both to edit the link the caret
 * was in (both boxes start filled) and to insert a new one (both start empty, or the text pre-filled from
 * whatever was selected when the menu was opened). Enter in either box, or the button, submits. **Both boxes are
 * optional, the same way** — asked for directly ("an empty link should also be allowed, just like the title is
 * optional, so should the url"): `[]()` is an odd but syntactically valid markdown link, and this popup used to
 * refuse to write it (an address of nothing but spaces couldn't be saved) for no reason stronger than "a link
 * usually goes somewhere" — not a real constraint worth enforcing against someone who means to clear it, which is
 * exactly the same reasoning the text box was already given. There is nothing left to validate here: both fields
 * commit whatever they hold, trimmed, with no disabled Save and no "invalid" styling on an empty/whitespace-only
 * address.
 *
 * **Open in external browser** (asked for directly), offered only while the address is a plain web one, calls
 * back to whichever host actually knows how to open it — `onOpenExternal`, wired by `TextFieldMenu.tsx` to the
 * exact same `editorLinkHandlers` dispatch its own "Open link" menu item already uses, so this popup doesn't
 * need its own copy of the admin-app-vs-Notes distinction ("Open link" in CLAUDE.md: `open_web_address` for the
 * admin-app, which has no tab to list a site under, `open_external_site` for Notes and a user web app).
 *
 * **Copying the title/address, pasting into either box, and the app's own clipboard (push/pop/peek, and the
 * "manage" popup) are not a separate feature here** — both boxes are ordinary recognized text fields, so
 * `TextFieldMenu`'s own floating clipboard menu already covers all of it the moment either one has the focus,
 * the same as any other text box in the app; see CLAUDE.md for why a second, redundant copy of that menu
 * wasn't added to this popup specifically.
 *
 * **"Use the address as the link text" (asked for directly: "a button for repeating the url, without the
 * https scheme if present, in the title textbox")** — the `ArrowUp` button beside the Link text box replaces
 * it with the address, `https://`/`http://` stripped if the address starts with one (`addressWithoutScheme`;
 * a plain case-insensitive prefix strip, not a URL parse — this box also accepts a bare relative/account-
 * absolute path, which has no scheme to strip at all, so the regex simply doesn't match and the path is used
 * as it is). Disabled while the address is empty, since there is nothing to repeat yet. */
export default function MarkdownLinkModal({
  heading,
  initialText,
  initialAddress,
  onSubmit,
  onCancel,
  onOpenExternal,
}: {
  heading: string
  initialText: string
  initialAddress: string
  onSubmit: (text: string, address: string) => void
  onCancel: () => void
  onOpenExternal?: (address: string) => void
}) {
  const [text, setText] = useState(initialText)
  const [address, setAddress] = useState(initialAddress)
  const trimmedAddress = address.trim()
  const isWebAddress = WEB_ADDRESS.test(trimmedAddress)
  const addressWithoutScheme = trimmedAddress.replace(/^https?:\/\//i, '')

  function submit() {
    onSubmit(text, trimmedAddress)
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
        <div className="toolbar-actions">
          <input
            data-ua-field="textMenu.link.text"
            autoFocus
            style={{ flex: 1 }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="(optional)"
          />
          <IconButton
            icon={ArrowUp}
            label="Use the address (without its scheme) as the link text"
            disabled={trimmedAddress === ''}
            onClick={() => setText(addressWithoutScheme)}
          />
        </div>
        <div className="modal-field-label" style={{ marginTop: 10 }}>
          Link address — a web address, or a path
        </div>
        <div className="toolbar-actions">
          <input
            data-ua-field="textMenu.link.address"
            style={{ flex: 1 }}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          {onOpenExternal && isWebAddress && (
            <IconButton icon={ExternalLink} label="Open in external browser" onClick={() => onOpenExternal(trimmedAddress)} />
          )}
        </div>
        <div className="toolbar-actions" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <IconButton icon={Check} label="Save" onClick={submit} />
          <IconButton icon={X} label="Cancel" onClick={onCancel} />
        </div>
      </form>
    </Modal>
  )
}
