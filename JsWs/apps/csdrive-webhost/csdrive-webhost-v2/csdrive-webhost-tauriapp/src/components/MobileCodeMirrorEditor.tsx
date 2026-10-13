import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Clipboard, ClipboardPaste, ExternalLink, Redo2, Undo2 } from 'lucide-react'
import { basicSetup, EditorView } from 'codemirror'
import { Compartment, EditorState } from '@codemirror/state'
import { highlightWhitespace, keymap } from '@codemirror/view'
import { indentUnit } from '@codemirror/language'
import { history, historyKeymap, indentWithTab, redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import IconButton from './IconButton'
import { languageOf, type Language } from '../lib/highlight'
import { linkAt, type LinkHandler } from '../lib/textLinks'
import { internalClipboard } from '../lib/clipboard'
import { subscribeEditorSettings, type EditorSettings } from '../lib/editorSettings'
import type { CodeEditorHandle } from './CodeEditor'

function tabExtensions(tabInsertsSpaces: boolean, tabSpaceCount: number) {
  return [EditorState.tabSize.of(tabSpaceCount), indentUnit.of(tabInsertsSpaces ? ' '.repeat(tabSpaceCount) : '\t')]
}

function languageExtension(language: Language) {
  switch (language) {
    case 'javascript':
      return javascript()
    case 'css':
      return css()
    case 'html':
      return html()
    case 'json':
      return json()
    case 'markdown':
      return markdown()
    case 'text':
      return []
  }
}

interface Props {
  value: string
  onChange: (value: string) => void
  fileName: string
  onOpenLink?: LinkHandler
  readOnly?: boolean
  language?: Language
  onVisibleLineChange?: (line: number) => void
  onScrollNudge?: (direction: 'up' | 'down' | 'pageUp' | 'pageDown') => void
}

/** The mobile default editor while `editor.useBuiltInEditor` is off (`lib/editorSettings.ts`) — asked for
 * directly: "Monaco for desktop... you choose an appropriate one for mobile." **CodeMirror 6, not Monaco, on
 * Android**: Monaco assumes a desktop-shaped input surface (hover tooltips, a dense context menu, a
 * multi-megabyte bundle) and has no particular mobile/touch design behind it, where CodeMirror 6 is built
 * mobile-first — real touch selection handles, no assumption of a mouse or a keyboard shortcut for every
 * action, and a much smaller bundle for a WebView that's already carrying this whole app. It's also already
 * virtualized internally (only the visible viewport's lines are real DOM), the same property this app's own
 * editor spent a great deal of this session's work earning for itself.
 *
 * **Line numbers are always shown here, regardless of the separate `lineNumbers` setting's own stored
 * value** — a deliberate simplification: `codemirror`'s own `basicSetup` bundle (used here as-is rather than
 * hand-assembling its dozen-plus extensions just to make one of them optional) always includes its line-
 * number gutter, and there's no virtualization-cost reason to fight that the way there was for this app's
 * own plain-textarea mode — CodeMirror's gutter is exactly as cheap as the rest of its already-virtualized
 * rendering. The setting still works for `HighlightedEditor`/`PlainTextEditor` (`editor.useBuiltInEditor` on)
 * and for `MonacoCodeEditor`, which has no such bundled-preset constraint.
 *
 * **Same `TextFieldMenu` gap as `MonacoCodeEditor`'s own doc comment describes** — CodeMirror 6's real
 * editing surface is a `contenteditable` div, never a plain `HTMLTextAreaElement`, so `TextFieldMenu`'s
 * floating clipboard menu doesn't attach here either; the same toolbar buttons (app clipboard copy/paste,
 * "Open link") stand in for the two actually-used pieces. */
const MobileCodeMirrorEditor = forwardRef<CodeEditorHandle, Props>(function MobileCodeMirrorEditor(
  { value, onChange, fileName, onOpenLink, readOnly, language, onVisibleLineChange, onScrollNudge },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const [settings, setSettings] = useState<EditorSettings | null>(null)
  useEffect(() => subscribeEditorSettings(setSettings), [])
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const lastVisibleLine = useRef<number | null>(null)
  const effectiveLanguage = language ?? languageOf(fileName)

  const languageCompartment = useRef(new Compartment()).current
  const readOnlyCompartment = useRef(new Compartment()).current
  const wrapCompartment = useRef(new Compartment()).current
  const whitespaceCompartment = useRef(new Compartment()).current
  const tabCompartment = useRef(new Compartment()).current

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      doc: value,
      parent: host,
      extensions: [
        basicSetup,
        keymap.of([indentWithTab, ...historyKeymap]),
        history(),
        languageCompartment.of(effectiveLanguage === 'text' || (settings?.highlightDisabled ?? false) ? [] : languageExtension(effectiveLanguage)),
        readOnlyCompartment.of(EditorState.readOnly.of(readOnly ?? false)),
        wrapCompartment.of(settings?.wrapLines === false ? [] : EditorView.lineWrapping),
        whitespaceCompartment.of(settings?.showWhitespace ? highlightWhitespace() : []),
        tabCompartment.of(tabExtensions(settings?.tabInsertsSpaces ?? false, settings?.tabSpaceCount ?? 4)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const text = update.state.doc.toString()
            onChangeRef.current(text)
          }
          if (update.docChanged || update.selectionSet) {
            setCanUndo(undoDepth(update.state) > 0)
            setCanRedo(redoDepth(update.state) > 0)
          }
          if (update.geometryChanged || update.docChanged) {
            if (!onVisibleLineChange) return
            const line = update.view.state.doc.lineAt(update.view.lineBlockAtHeight(update.view.scrollDOM.scrollTop).from).number
            if (line !== lastVisibleLine.current) {
              lastVisibleLine.current = line
              onVisibleLineChange(line)
            }
          }
        }),
        onScrollNudge
          ? keymap.of([
              {
                key: 'Ctrl-Alt-ArrowUp',
                run: () => {
                  onScrollNudge('up')
                  return true
                },
              },
              {
                key: 'Ctrl-Alt-ArrowDown',
                run: () => {
                  onScrollNudge('down')
                  return true
                },
              },
              {
                key: 'Ctrl-Alt-PageUp',
                run: () => {
                  onScrollNudge('pageUp')
                  return true
                },
              },
              {
                key: 'Ctrl-Alt-PageDown',
                run: () => {
                  onScrollNudge('pageDown')
                  return true
                },
              },
            ])
          : [],
      ],
    })
    viewRef.current = view
    // The scroll handler above only reacts to a document/geometry change, not a plain scroll with neither —
    // mirror-scroll also needs a real `scroll` listener on the box itself.
    const onScroll = () => {
      if (!onVisibleLineChange) return
      const line = view.state.doc.lineAt(view.lineBlockAtHeight(view.scrollDOM.scrollTop).from).number
      if (line !== lastVisibleLine.current) {
        lastVisibleLine.current = line
        onVisibleLineChange(line)
      }
    }
    view.scrollDOM.addEventListener('scroll', onScroll)
    return () => {
      view.scrollDOM.removeEventListener('scroll', onScroll)
      view.destroy()
      viewRef.current = null
    }
    // Mount-only — later prop/setting changes are applied through the compartments below, not by rebuilding
    // the whole view (which would lose the undo history and the scroll position for no reason).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === value) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const disabled = settings?.highlightDisabled ?? false
    view.dispatch({
      effects: languageCompartment.reconfigure(effectiveLanguage === 'text' || disabled ? [] : languageExtension(effectiveLanguage)),
    })
  }, [effectiveLanguage, settings?.highlightDisabled, languageCompartment])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly ?? false)) })
  }, [readOnly, readOnlyCompartment])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: wrapCompartment.reconfigure(settings?.wrapLines === false ? [] : EditorView.lineWrapping),
    })
  }, [settings?.wrapLines, wrapCompartment])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: whitespaceCompartment.reconfigure(settings?.showWhitespace ? highlightWhitespace() : []),
    })
  }, [settings?.showWhitespace, whitespaceCompartment])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: tabCompartment.reconfigure(tabExtensions(settings?.tabInsertsSpaces ?? false, settings?.tabSpaceCount ?? 4)),
    })
  }, [settings?.tabInsertsSpaces, settings?.tabSpaceCount, tabCompartment])

  useImperativeHandle(ref, () => ({
    insertAtCursor(text) {
      const view = viewRef.current
      if (!view) return
      const sel = view.state.selection.main
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length } })
      view.focus()
    },
  }))

  function openLinkAtCursor() {
    const view = viewRef.current
    if (!view || !onOpenLink) return
    const sel = view.state.selection.main
    const text = view.state.doc.toString()
    const hit = linkAt(text, sel.from, sel.to)
    if (hit) void onOpenLink(hit)
  }

  async function copySelectionToAppClipboard() {
    const view = viewRef.current
    if (!view) return
    const sel = view.state.selection.main
    const text = view.state.sliceDoc(sel.from, sel.to)
    if (text) await internalClipboard.push(text)
  }

  async function pasteFromAppClipboard() {
    const view = viewRef.current
    if (!view) return
    const text = await internalClipboard.peek()
    if (text === null) return
    const sel = view.state.selection.main
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text } })
  }

  return (
    <div className="code-editor-wrap">
      {!readOnly && (
        <div className="code-editor-toolbar">
          <IconButton icon={Undo2} label="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => viewRef.current && undo(viewRef.current)} />
          <IconButton icon={Redo2} label="Redo (Ctrl+Y)" disabled={!canRedo} onClick={() => viewRef.current && redo(viewRef.current)} />
          <IconButton icon={Clipboard} label="Copy the selection to the app’s clipboard" onClick={copySelectionToAppClipboard} />
          <IconButton icon={ClipboardPaste} label="Paste from the app’s clipboard" onClick={pasteFromAppClipboard} />
          {onOpenLink && <IconButton icon={ExternalLink} label="Open link at the caret" onClick={openLinkAtCursor} />}
          <span className="code-editor-menu-slot" data-text-menu-target />
        </div>
      )}
      <div className="code-editor" data-text-menu-anchor>
        <div ref={hostRef} className="codemirror-editor-host" />
      </div>
    </div>
  )
})

export default MobileCodeMirrorEditor
