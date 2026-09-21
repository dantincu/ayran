import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
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
 * height. (The layer is a picture: it can't be selected or focused, and screen readers skip it.) */
export default function CodeEditor({ value, onChange, fileName, onOpenLink, readOnly, language }: Props) {
  const frameRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
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

  return (
    // The clipboard menu's button sits at the corner of the frame, not of the (tall) box.
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
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}
