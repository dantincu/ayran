import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ClipboardCopy, ClipboardPaste, ClipboardType, Copy, Ellipsis, ExternalLink, TextCursorInput } from 'lucide-react'
import { copyToOsClipboard, internalClipboard, readOsClipboard } from '../lib/clipboard'
import { selectParagraphs } from '../lib/paragraphs'
import { editorLinkHandlers, linkAt } from '../lib/textLinks'
import { useChord } from '../lib/chords'

type Field = HTMLInputElement | HTMLTextAreaElement

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

/** The clipboard menu of every text editor and single-line text box of this page: while one has the focus, a small button
 * sits at its top-right corner, and opens a menu of:
 *
 * - **Select paragraphs** (a single-line box: **Select all**) — the paragraph(s) the selection touches (or the caret is in),
 *   whole, without the whitespace around them;
 * - **Copy to** / **Paste from the app's clipboard** — the app's own clipboard: one text, shared by every window of the
 *   admin-app and of the system apps (`lib/clipboard.ts`);
 * - **Copy to** / **Paste from the clipboard** — the operating system's.
 *
 * Copying takes the selected text; pasting replaces it (or is put at the caret). The box keeps the focus and its selection
 * the whole time: pressing the button or a menu item doesn't take the focus (a box that is renamed or committed when it
 * loses the focus is not disturbed). Mounted once per page. */
export default function TextFieldMenu() {
  const [field, setField] = useState<Field | null>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
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
      // A box that says where its frame is (an editor whose box is as tall as its text) gets the button at the frame's corner.
      const box = (field.closest('[data-text-menu-anchor]') ?? field).getBoundingClientRect()
      const visible = box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < window.innerHeight
      if (!visible) {
        setPlacement((current) => (current === null ? current : null))
      } else {
        // An editor: inside it, at its top-right corner (left of the scrollbar) — above it there is usually a dialog's
        // header with buttons of its own. A single-line box: just above it, at its right end, or inside it at the top when
        // it is at the top of the screen.
        const inside = field instanceof HTMLTextAreaElement
        const top = inside ? Math.max(4, box.top + 4) : box.top >= 30 ? box.top - 26 : box.top + 2
        const left = Math.max(4, Math.min(box.right - (inside ? 46 : 28), window.innerWidth - 32))
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
      else await internalClipboard.set(text)
      return where === 'os' ? 'Copied to the clipboard.' : "Copied to the app's clipboard."
    })

  const pasteFrom = (where: 'os' | 'app') =>
    run(async () => {
      if (!field) return
      if (field.readOnly || field.disabled) return "This box can't be changed."
      const text = where === 'os' ? await readOsClipboard() : await internalClipboard.get()
      if (!text) return where === 'os' ? 'The clipboard is empty.' : "The app's clipboard is empty."
      replaceSelection(field, text)
    })

  // Ctrl+K, C / Ctrl+K, V: copy the selection to / paste over it from the app's clipboard, in the box that has the focus.
  useChord('c', "Copy the selection to the app's clipboard", () => copyTo('app'), () => field !== null && selected() !== '')
  useChord('v', "Paste from the app's clipboard", () => pasteFrom('app'), () => field !== null && !field.readOnly && !field.disabled)

  // A press on the button or an item must not take the focus from the box.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault()

  if (!field || !placement) return null
  const multi = isMultiLine(field)
  const hasSelection = selected() !== ''
  // An editor that can open links offers to open the one the caret (or the selection) is in.
  const openLink = field instanceof HTMLTextAreaElement ? editorLinkHandlers.get(field) : undefined
  const caret = selection(field)
  const link = openLink ? linkAt(field.value, caret.start, caret.end) : null

  return createPortal(
    <div ref={rootRef} className="text-menu" style={{ top: placement.top, left: placement.left }}>
      <button
        type="button"
        className="text-menu-trigger"
        aria-label="Clipboard and selection"
        aria-expanded={open}
        title="Select, copy and paste"
        onMouseDown={keepFocus}
        onClick={() => setOpen((o) => !o)}
      >
        <Ellipsis size={14} strokeWidth={2} aria-hidden="true" />
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
          <button type="button" role="menuitem" onMouseDown={keepFocus} onClick={selectAction}>
            <TextCursorInput size={14} aria-hidden="true" /> {multi ? 'Select paragraphs' : 'Select all'}
          </button>
          <button type="button" role="menuitem" disabled={!hasSelection} onMouseDown={keepFocus} onClick={() => copyTo('app')}>
            <ClipboardCopy size={14} aria-hidden="true" /> Copy to the app's clipboard
          </button>
          <button type="button" role="menuitem" disabled={field.readOnly} onMouseDown={keepFocus} onClick={() => pasteFrom('app')}>
            <ClipboardType size={14} aria-hidden="true" /> Paste from the app's clipboard
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
    </div>,
    document.body,
  )
}
