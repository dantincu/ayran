import { useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react'
import { Redo2, Undo2 } from 'lucide-react'
import IconButton from './IconButton'
import { UndoHistory } from '../lib/undoHistory'
import { highlight, languageOf, type Language } from '../lib/highlight'
import { editorLinkHandlers, type LinkHandler } from '../lib/textLinks'

interface Props {
  value: string
  onChange: (value: string) => void
  /** The file's name: what it is highlighted as (Markdown, HTML — anything else is plain). */
  fileName: string
  /** What to do with a link the caret is in when the person asks to open it (the clipboard menu offers it when this is set). */
  onOpenLink?: LinkHandler
  readOnly?: boolean
  /** Which language to use, when it isn't the file name's. */
  language?: Language
}

/** The one text editor of the app's file views: a `textarea` — so everything a text box does (selection, the clipboard
 * menu, the on-screen keyboard, drafts) stays as it is — with **syntax highlighting** drawn behind it (`lib/highlight.ts`).
 *
 * The highlighted copy of the text sits under the box, which has the same font, padding and wrapping and a transparent
 * text; the box is as tall as its text and the frame around both scrolls, so nothing has to be kept in step but the
 * height. (The layer is a picture: it can't be selected or focused, and screen readers skip it.)
 *
 * **Undo and redo** — two buttons above the text (and Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z) — go through the editor's own history
 * (`lib/undoHistory.ts`), which covers everything that changes the text through `onChange`, the clipboard menu's paste
 * included. A text replaced from outside (a file read again) starts a new history. */
export default function CodeEditor({ value, onChange, fileName, onOpenLink, readOnly, language }: Props) {
  const frameRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const history = useRef<UndoHistory | null>(null)
  if (history.current === null) history.current = new UndoHistory(value)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const restoreCaret = useRef<{ start: number; end: number } | null>(null)
  const html = useMemo(() => highlight(value, language ?? languageOf(fileName)) + (value.endsWith('\n') ? ' ' : ''), [value, language, fileName])

  // The box is as tall as its text (or the frame, when the text is shorter, so a press anywhere in the frame is in the box).
  const fit = () => {
    const input = inputRef.current
    const frame = frameRef.current
    if (!input || !frame) return
    input.style.height = '0px'
    input.style.height = `${Math.max(input.scrollHeight, frame.clientHeight)}px`
  }
  useLayoutEffect(fit, [value])
  // A text that isn't the one the history stands at came from outside: it starts a new history. And after an undo or redo the
  // caret goes where the text it brought back had it.
  useLayoutEffect(() => {
    const h = history.current!
    if (h.current.value !== value) {
      h.reset(value)
      redraw()
    }
    const caret = restoreCaret.current
    if (caret && inputRef.current && inputRef.current.value === value) {
      inputRef.current.setSelectionRange(caret.start, caret.end)
      restoreCaret.current = null
    }
  }, [value])
  const step = (direction: 'undo' | 'redo') => {
    const h = history.current!
    const snapshot = direction === 'undo' ? h.undo() : h.redo()
    if (!snapshot) return
    restoreCaret.current = { start: snapshot.start, end: snapshot.end }
    inputRef.current?.focus()
    onChange(snapshot.value)
    redraw()
  }
  useEffect(() => {
    const frame = frameRef.current
    if (!frame || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])

  // The clipboard menu offers "Open link" for a box that has a handler.
  useEffect(() => {
    const input = inputRef.current
    if (!input || !onOpenLink) return
    editorLinkHandlers.set(input, onOpenLink)
    return () => {
      editorLinkHandlers.delete(input)
    }
  }, [onOpenLink])

  const h = history.current!
  return (
    <div className="code-editor-wrap">
      {!readOnly && (
        <div className="code-editor-toolbar">
          <IconButton icon={Undo2} label="Undo (Ctrl+Z)" onClick={() => step('undo')} disabled={!h.canUndo} onMouseDown={(e) => e.preventDefault()} />
          <IconButton icon={Redo2} label="Redo (Ctrl+Y)" onClick={() => step('redo')} disabled={!h.canRedo} onMouseDown={(e) => e.preventDefault()} />
        </div>
      )}
      {/* The clipboard menu's button sits at the corner of the frame, not of the (tall) box. */}
      <div className="code-editor" ref={frameRef} data-text-menu-anchor>
        <pre className="code-editor-highlight" aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />
        <textarea
          ref={inputRef}
          className="code-editor-input"
          value={value}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => {
            history.current!.record(e.target.value, e.target.selectionStart, e.target.selectionEnd, Date.now())
            onChange(e.target.value)
            redraw()
          }}
          onKeyDown={(e) => {
            if (readOnly || !(e.ctrlKey || e.metaKey) || e.altKey) return
            const key = e.key.toLowerCase()
            if (key === 'z' && !e.shiftKey) step('undo')
            else if (key === 'y' || (key === 'z' && e.shiftKey)) step('redo')
            else return
            e.preventDefault()
          }}
        />
      </div>
    </div>
  )
}
