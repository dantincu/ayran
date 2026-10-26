import { useState, type ReactNode, type RefObject } from 'react'
import { ExternalLink, Link2, TextCursorInput } from 'lucide-react'
import MarkdownLinkModal from '../components/MarkdownLinkModal'
import type { MenuItem } from '../components/ContextMenu'
import { selectParagraphs } from './paragraphs'
import { linkAt, markdownLinkAt, type LinkHandler } from './textLinks'

/** The "Select paragraphs"/"Open link at the caret"/"Edit the link at the caret, or insert a new one" menu
 * items for a plain-`<textarea>`-based editor (`CodeEditor.tsx`'s `HighlightedEditor`/`PlainTextEditor`) —
 * the built-in editor's own counterpart of what `MonacoCodeEditor.tsx` already wires as toolbar actions (and
 * registers as real Monaco actions), and what `TextFieldMenu.tsx`'s own floating clipboard menu already offers
 * at *any* focused text field, this editor's own textarea included. The notebook-scoped three-dots menu
 * (`CodeEditor.tsx`'s own `notebookMenu` prop — see its doc comment) moves these three *out* of that generic
 * floating menu and into this one instead, so a notebook-scoped editor needs its own, explicit trigger for
 * them rather than leaning on `TextFieldMenu` to keep offering them at the same time. Reuses the exact same
 * pure, DOM-light helpers `TextFieldMenu.tsx`/`MonacoCodeEditor.tsx` already do (`selectParagraphs`, `linkAt`,
 * `markdownLinkAt`) — not a second implementation of any of the three that could drift from the others. */
export function useNotebookEditorMenuItems(
  inputRef: RefObject<HTMLTextAreaElement | null>,
  value: string,
  applyEdit: (edit: { value: string; start: number; end: number }) => void,
  onOpenLink: LinkHandler | undefined,
): { items: MenuItem[]; modal: ReactNode } {
  const [linkEdit, setLinkEdit] = useState<{ heading: string; range: { start: number; end: number }; image: boolean; text: string; address: string } | null>(null)

  function selection(): { start: number; end: number } {
    const input = inputRef.current
    return { start: input?.selectionStart ?? 0, end: input?.selectionEnd ?? 0 }
  }

  function doSelectParagraphs() {
    const input = inputRef.current
    if (!input) return
    const { start, end } = selection()
    const range = selectParagraphs(value, start, end)
    input.focus()
    input.setSelectionRange(range.start, range.end)
  }

  function doOpenLink() {
    if (!onOpenLink) return
    const { start, end } = selection()
    const hit = linkAt(value, start, end)
    if (hit) void onOpenLink(hit)
  }

  function doEditOrInsertLink() {
    const { start, end } = selection()
    const hit = markdownLinkAt(value, start, end)
    if (hit) setLinkEdit({ heading: 'Edit link', range: { start: hit.start, end: hit.end }, image: hit.image, text: hit.text, address: hit.address })
    else setLinkEdit({ heading: 'Insert a link', range: { start, end }, image: false, text: value.slice(start, end), address: '' })
  }

  function submitLink(text: string, address: string) {
    const edit = linkEdit
    setLinkEdit(null)
    if (!edit) return
    const newText = `${edit.image ? '!' : ''}[${text}](${address})`
    const next = value.slice(0, edit.range.start) + newText + value.slice(edit.range.end)
    applyEdit({ value: next, start: edit.range.start + newText.length, end: edit.range.start + newText.length })
    inputRef.current?.focus()
  }

  const items: MenuItem[] = [
    { label: 'Select paragraphs', icon: TextCursorInput, onSelect: doSelectParagraphs },
    ...(onOpenLink ? [{ label: 'Open link at the caret', icon: ExternalLink, onSelect: doOpenLink }] : []),
    ...(onOpenLink ? [{ label: 'Edit the link at the caret, or insert a new one', icon: Link2, onSelect: doEditOrInsertLink }] : []),
  ]

  const modal = linkEdit && (
    <MarkdownLinkModal
      heading={linkEdit.heading}
      initialText={linkEdit.text}
      initialAddress={linkEdit.address}
      onSubmit={submitLink}
      onCancel={() => setLinkEdit(null)}
      onOpenExternal={onOpenLink ? (address) => void onOpenLink({ kind: 'web', target: address, start: 0, end: 0 }) : undefined}
    />
  )

  return { items, modal }
}
