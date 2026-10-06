import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ClipboardCopy, ClipboardList, ClipboardPaste, ClipboardType, Copy, Ellipsis, ExternalLink, Link, Link2, TextCursorInput } from 'lucide-react'
import { copyToOsClipboard, internalClipboard, readOsClipboard } from '../lib/clipboard'
import { selectParagraphs } from '../lib/paragraphs'
import { editorLinkHandlers, linkAt, markdownLinkAt } from '../lib/textLinks'
import { useChord } from '../lib/chords'
import ClipboardManagerModal from './ClipboardManagerModal'
import MarkdownLinkModal from './MarkdownLinkModal'

type Field = HTMLInputElement | HTMLTextAreaElement

/** `.text-menu-trigger`'s own size in `App.css`, kept in step by hand — the placement math below needs the
 * exact figure to reserve room for it (and, for `UserActionFieldButtons`, its own siblings) correctly. As big
 * as an ordinary `.icon-button` now (34px), asked for directly: these used to read as noticeably smaller. */
const TRIGGER_SIZE = 34

/** The kinds of single-line box that hold text a person selects, copies and pastes (the others — numbers, e-mail addresses,
 * passwords, colours… — don't have a text selection to work with, or shouldn't be copied from). */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel'])

/** A box the menu is for: a text editor (a `textarea`) or a single-line text box — unless it, or something around it, says
 * `data-no-text-menu` (the tiny boxes of the popups that close when something outside them is pressed). */
function isTextField(target: EventTarget | null): target is Field {
  if (target instanceof HTMLTextAreaElement) return !target.closest('[data-no-text-menu]')
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type) && !target.closest('[data-no-text-menu]')
  return false
}

const isMultiLine = (field: Field) => field instanceof HTMLTextAreaElement

/** The current selection of `field`, ordered. */
function selection(field: Field): { start: number; end: number } {
  const a = field.selectionStart ?? 0
  const b = field.selectionEnd ?? 0
  return { start: Math.min(a, b), end: Math.max(a, b) }
}

/** Puts `text` where the selection is (replacing it) and lets whoever listens — a controlled box — know it changed. */
function replaceSelection(field: Field, text: string): void {
  const { start, end } = selection(field)
  field.setRangeText(text, start, end, 'end')
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

interface Placement {
  top: number
  left: number
}

/** The "Edit link"/"Insert a link" popup's own in-flight state. `target` is captured here, not read from the
 * component's own `field` state, because opening the popup moves the focus to its boxes — which, like every
 * other text box in the app, becomes the new tracked `field` itself (the clipboard menu follows focus
 * generically; this popup's boxes are not opted out of that with `data-no-text-menu`, since a plain field — able
 * to paste an address into the address box — is exactly the behavior every other dialog's own box already has).
 * So by the time *Save* is pressed, `field` may no longer be the editor the link is being written into — `target`
 * always still is. */
interface LinkEdit {
  heading: string
  target: HTMLTextAreaElement
  range: { start: number; end: number }
  image: boolean
  text: string
  address: string
}

/** The clipboard menu of every text editor and single-line text box of this page: while one has the focus, a small button
 * sits at its top-right corner, and opens a menu of:
 *
 * - **Select paragraphs** (a single-line box: **Select all**) — the paragraph(s) the selection touches (or the caret is in),
 *   whole, without the whitespace around them;
 * - **Open link**, **Edit link** and **Insert a link** — only for an editor that can open links (`onOpenLink`,
 *   `CodeEditor.tsx`): **Open link** follows the address the caret is in (any kind — web, a markdown/HTML link, an `href`);
 *   **Edit link**, only offered when the caret is in a *markdown* link specifically (`markdownLinkAt`, which — unlike
 *   `linkAt`'s plain address — also has the link's own text to edit), opens `MarkdownLinkModal` on it and replaces the whole
 *   construct with what comes back; **Insert a link** opens the same popup empty (the text pre-filled from the selection,
 *   if there is one) and writes a new `[text](address)` at the caret;
 * - **Copy to** / **Paste from the app's clipboard** — the app's own clipboard: one text, shared by every window of the
 *   admin-app and of the system apps (`lib/clipboard.ts`);
 * - **Copy to** / **Paste from the clipboard** — the operating system's.
 *
 * Copying takes the selected text; pasting replaces it (or is put at the caret). The box keeps the focus and its selection
 * the whole time: pressing the button or a menu item doesn't take the focus (a box that is renamed or committed when it
 * loses the focus is not disturbed) — except opening the link popup, which necessarily moves the focus to its own boxes;
 * see `LinkEdit`'s own doc for how the editor to write back into survives that. Mounted once per page. */
export default function TextFieldMenu({ extra }: { /** More buttons beside the trigger, for the box that has the focus (the Notes app's User Action launch and close). */ extra?: (field: Field) => ReactNode } = {}) {
  const [field, setField] = useState<Field | null>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [linkEdit, setLinkEdit] = useState<LinkEdit | null>(null)
  // The target to use/replace-in when the "manage the app's clipboard" popup is open — captured here, the same
  // reason `LinkEdit.target` is (see its own doc): opening the popup may leave `field` itself not meaningfully
  // changed, but relying on it directly here would couple this component's own focus-tracking to a popup that
  // can stay open for a while.
  const [managing, setManaging] = useState<{ field: Field; text: string } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const messageTimer = useRef<number | undefined>(undefined)

  // Which box is being edited: the one that has the focus, if it is one of these.
  useEffect(() => {
    function onFocusIn(e: FocusEvent) {
      if (isTextField(e.target)) {
        setField(e.target)
        setOpen(false)
        setMessage(null)
      } else if (!(e.target instanceof Node && rootRef.current?.contains(e.target))) {
        setField(null)
        setOpen(false)
      }
    }
    function onFocusOut(e: FocusEvent) {
      const next = e.relatedTarget
      if (next instanceof Node && rootRef.current?.contains(next)) return
      if (next === null) {
        // Focus went nowhere in particular (a press on plain page background, the window losing the focus): the box is left.
        window.setTimeout(() => {
          if (!isTextField(document.activeElement)) {
            setField(null)
            setOpen(false)
          }
        }, 0)
      }
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    if (isTextField(document.activeElement)) setField(document.activeElement)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [])

  // Keep the button on the box's corner, wherever the page scrolls or resizes it to.
  useEffect(() => {
    if (!field) {
      setPlacement(null)
      return
    }
    let frame = 0
    const update = () => {
      if (!field.isConnected) {
        setField(null)
        return
      }
      // A newer modal may have opened on top of the one (if any) that contains this field, without the
      // field itself ever losing focus — reported live: opening "New note…", then right-clicking its
      // floating User Action launch button to open a second dialog on top of it left this component's own
      // buttons (still anchored to the first dialog's title field) floating over the second dialog's own
      // header, since nothing had told this component a *different* modal had since taken over the screen.
      // Modals mount in the order they open, so the field's own menu is shown only while its nearest modal
      // (if it is in one at all) is still the *last* — topmost — one in the document; a field on the plain
      // page counts as covered the moment any modal opens at all, the same reasoning applying there too.
      const overlays = document.querySelectorAll('.modal-overlay')
      const topOverlay = overlays[overlays.length - 1] ?? null
      if (topOverlay && field.closest('.modal-overlay') !== topOverlay) {
        setPlacement((current) => (current === null ? current : null))
        frame = requestAnimationFrame(update)
        return
      }
      // A box that says where its frame is (an editor whose box is as tall as its text) gets the button at the frame's corner —
      // unless that frame *also* says where it would rather have the buttons sit (`data-text-menu-target`, a reserved slot in
      // its own toolbar, beside its Undo/Redo — `CodeEditor.tsx`): floating over the corner would otherwise cover whatever
      // text happens to be rendered there (reported live).
      const anchor = field.closest('[data-text-menu-anchor]')
      const target = anchor?.parentElement?.querySelector('[data-text-menu-target]') as HTMLElement | null
      const box = (target ?? anchor ?? field).getBoundingClientRect()
      const visible = box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < window.innerHeight
      const room = extra ? (TRIGGER_SIZE + 2) * 2 : 0 // the buttons of `extra` are left of the trigger
      if (!visible) {
        setPlacement((current) => (current === null ? current : null))
      } else if (target) {
        // A reserved slot: right-aligned within it (the same way the trigger sits at a plain box's own right end),
        // vertically centred — the slot's own height follows its toolbar row, taller than the trigger itself.
        const top = box.top + (box.height - TRIGGER_SIZE) / 2
        const left = box.right - (TRIGGER_SIZE + 4) - room
        setPlacement((current) => (current && current.top === top && current.left === left ? current : { top, left }))
      } else {
        // An editor: inside it, at its top-right corner (left of the scrollbar) — above it there is usually a dialog's
        // header with buttons of its own. A single-line box: just above it, at its right end, or inside it at the top when
        // it is at the top of the screen.
        const inside = field instanceof HTMLTextAreaElement
        const top = inside ? Math.max(4, box.top + 4) : box.top >= TRIGGER_SIZE + 4 ? box.top - (TRIGGER_SIZE + 4) : box.top + 2
        const left = Math.max(4, Math.min(box.right - (inside ? TRIGGER_SIZE + 22 : TRIGGER_SIZE + 4) - room, window.innerWidth - (TRIGGER_SIZE + 8) - room))
        setPlacement((current) => (current && current.top === top && current.left === left ? current : { top, left }))
      }
      frame = requestAnimationFrame(update)
    }
    frame = requestAnimationFrame(update)
    return () => cancelAnimationFrame(frame)
  }, [field])

  // Escape closes the menu (and only it: the dialog the box is in stays).
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open])

  const say = useCallback((text: string) => {
    setMessage(text)
    window.clearTimeout(messageTimer.current)
    messageTimer.current = window.setTimeout(() => setMessage(null), 2200)
  }, [])

  async function run(action: () => Promise<string | void> | string | void) {
    setOpen(false)
    if (!field) return
    try {
      const said = await action()
      if (said) say(said)
    } catch (e) {
      say(e instanceof Error ? e.message : String(e))
    }
    field.focus({ preventScroll: true })
  }

  const selected = () => {
    if (!field) return ''
    const { start, end } = selection(field)
    return field.value.slice(start, end)
  }

  const selectAction = () =>
    run(() => {
      if (!field) return
      if (isMultiLine(field)) {
        const now = selection(field)
        const range = selectParagraphs(field.value, now.start, now.end)
        field.setSelectionRange(range.start, range.end)
      } else {
        field.setSelectionRange(0, field.value.length)
      }
    })

  const copyTo = (where: 'os' | 'app') =>
    run(async () => {
      const text = selected()
      if (!text) return 'Select some text first.'
      if (where === 'os') await copyToOsClipboard(text)
      else await internalClipboard.push(text)
      return where === 'os' ? 'Copied to the clipboard.' : "Copied to the app's clipboard."
    })

  const pasteFrom = (where: 'os' | 'app') =>
    run(async () => {
      if (!field) return
      if (field.readOnly || field.disabled) return "This box can't be changed."
      const text = where === 'os' ? await readOsClipboard() : await internalClipboard.peek()
      if (!text) return where === 'os' ? 'The clipboard is empty.' : "The app's clipboard is empty."
      replaceSelection(field, text)
    })

  // Ctrl+K, C / Ctrl+K, V: copy the selection to / paste over it from the app's clipboard, in the box that has the focus.
  useChord('c', "Copy the selection to the app's clipboard", () => copyTo('app'), () => field !== null && selected() !== '')
  useChord('v', "Paste from the app's clipboard", () => pasteFrom('app'), () => field !== null && !field.readOnly && !field.disabled)

  // A press on the button or an item must not take the focus from the box.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault()

  /** Opens the popup on the markdown link the caret (or the selection) is in — only offered when there is one. */
  function openEditLink(target: HTMLTextAreaElement, hit: { image: boolean; text: string; address: string; start: number; end: number }) {
    setOpen(false)
    setLinkEdit({ heading: 'Edit link', target, range: { start: hit.start, end: hit.end }, image: hit.image, text: hit.text, address: hit.address })
  }

  /** Opens the popup to insert a brand new link at the caret — replacing the selection, if there is one, and
   * taking its text as the link's own (so selecting a word first and asking to turn it into a link needs no
   * retyping). */
  function openInsertLink(target: HTMLTextAreaElement) {
    setOpen(false)
    const { start, end } = selection(target)
    setLinkEdit({ heading: 'Insert a link', target, range: { start, end }, image: false, text: target.value.slice(start, end), address: '' })
  }

  function submitLink(text: string, address: string) {
    const edit = linkEdit
    setLinkEdit(null)
    if (!edit) return
    edit.target.focus({ preventScroll: true })
    edit.target.setSelectionRange(edit.range.start, edit.range.end)
    replaceSelection(edit.target, `${edit.image ? '!' : ''}[${text}](${address})`)
  }

  // A plain sibling of the floating menu's own portal — and, critically, **always rendered as the Fragment's
  // same second child below, whether `field` is set or not**. Clicking anything in the popup that isn't itself a
  // text field (its Save/Cancel buttons, its Maximize/Close) makes `field` go null for exactly the reason its own
  // doc explains — and if that changed *which branch of this component's own return statement* produced the
  // popup, React would see a structurally different tree and remount it mid-click, destroying the very node the
  // click was headed for before its `onClick` could fire. (Found exactly this way, live: *Save* never once took
  // effect — the popup silently stayed open with the unedited text — because that is precisely what happened.)
  // Keeping the returned shape identical either way is what fixes it, not any change to the popup itself.
  const linkEditModal = linkEdit && (
    <MarkdownLinkModal
      heading={linkEdit.heading}
      initialText={linkEdit.text}
      initialAddress={linkEdit.address}
      onSubmit={submitLink}
      onCancel={() => setLinkEdit(null)}
      onOpenExternal={
        editorLinkHandlers.has(linkEdit.target)
          ? (address) => void editorLinkHandlers.get(linkEdit.target)?.({ kind: 'web', target: address, start: 0, end: 0 })
          : undefined
      }
    />
  )

  let menu: ReactNode = null
  if (field && placement) {
    const multi = isMultiLine(field)
    const hasSelection = selected() !== ''
    // An editor that can open links offers to open the one the caret (or the selection) is in — and, in the same
    // place, to edit it (a markdown link specifically — see `markdownLinkAt`'s own doc for why it's not `linkAt`'s
    // plain address) or to insert a new one.
    const openLink = field instanceof HTMLTextAreaElement ? editorLinkHandlers.get(field) : undefined
    const caret = selection(field)
    const link = openLink ? linkAt(field.value, caret.start, caret.end) : null
    const markdownLink = openLink ? markdownLinkAt(field.value, caret.start, caret.end) : null

    menu = (
      <div ref={rootRef} className="text-menu" style={{ top: placement.top, left: placement.left }}>
        {extra?.(field)}
        <button
          type="button"
          className="text-menu-trigger"
          aria-label="Clipboard and selection"
          aria-expanded={open}
          title="Select, copy and paste"
          onMouseDown={keepFocus}
          onClick={() => setOpen((o) => !o)}
        >
          <Ellipsis size={16} strokeWidth={2} aria-hidden="true" />
        </button>
        {open && (
          <div className="text-menu-list" role="menu" style={placement.left < 210 ? { left: 0 } : { right: 0 }}>
            {openLink && link && (
              <button
                type="button"
                role="menuitem"
                title={link.target}
                onMouseDown={keepFocus}
                onClick={() => run(() => openLink(link))}
              >
                <ExternalLink size={14} aria-hidden="true" /> Open link
              </button>
            )}
            {openLink && markdownLink && (
              <button type="button" role="menuitem" onMouseDown={keepFocus} onClick={() => openEditLink(field as HTMLTextAreaElement, markdownLink)}>
                <Link2 size={14} aria-hidden="true" /> Edit link
              </button>
            )}
            {openLink && (
              <button type="button" role="menuitem" disabled={field.readOnly} onMouseDown={keepFocus} onClick={() => openInsertLink(field as HTMLTextAreaElement)}>
                <Link size={14} aria-hidden="true" /> Insert a link
              </button>
            )}
            <button type="button" role="menuitem" onMouseDown={keepFocus} onClick={selectAction}>
              <TextCursorInput size={14} aria-hidden="true" /> {multi ? 'Select paragraphs' : 'Select all'}
            </button>
            <button type="button" role="menuitem" disabled={!hasSelection} onMouseDown={keepFocus} onClick={() => copyTo('app')}>
              <ClipboardCopy size={14} aria-hidden="true" /> Copy to the app's clipboard
            </button>
            <button type="button" role="menuitem" disabled={field.readOnly} onMouseDown={keepFocus} onClick={() => pasteFrom('app')}>
              <ClipboardType size={14} aria-hidden="true" /> Paste from the app's clipboard
            </button>
            <button
              type="button"
              role="menuitem"
              onMouseDown={keepFocus}
              onClick={() => {
                setManaging({ field, text: selected() })
                setOpen(false)
              }}
            >
              <ClipboardList size={14} aria-hidden="true" /> Manage the app's clipboard…
            </button>
            <button type="button" role="menuitem" disabled={!hasSelection} onMouseDown={keepFocus} onClick={() => copyTo('os')}>
              <Copy size={14} aria-hidden="true" /> Copy to the clipboard
            </button>
            <button type="button" role="menuitem" disabled={field.readOnly} onMouseDown={keepFocus} onClick={() => pasteFrom('os')}>
              <ClipboardPaste size={14} aria-hidden="true" /> Paste from the clipboard
            </button>
          </div>
        )}
        {message && (
          <div className="text-menu-message" role="status">
            {message}
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      {menu && createPortal(menu, document.body)}
      {linkEditModal}
      {managing && (
        <ClipboardManagerModal
          onClose={() => setManaging(null)}
          currentSelection={managing.text}
          onPick={(text) => {
            replaceSelection(managing.field, text)
            setManaging(null)
          }}
        />
      )}
    </>
  )
}
