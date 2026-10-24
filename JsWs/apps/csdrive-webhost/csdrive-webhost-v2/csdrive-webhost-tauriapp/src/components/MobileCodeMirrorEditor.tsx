import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import { Clipboard, ClipboardPaste, ExternalLink, Link2, Redo2, Search, TextCursorInput, Undo2 } from 'lucide-react'
import { basicSetup, EditorView } from 'codemirror'
import { Compartment, EditorState } from '@codemirror/state'
import { highlightWhitespace, keymap } from '@codemirror/view'
import { indentUnit } from '@codemirror/language'
import { history, historyKeymap, indentWithTab, redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import { openSearchPanel } from '@codemirror/search'
import { javascript } from '@codemirror/lang-javascript'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import IconButton from './IconButton'
import MarkdownLinkModal from './MarkdownLinkModal'
import { languageOf, type Language } from '../lib/highlight'
import { linkAt, markdownLinkAt, type LinkHandler } from '../lib/textLinks'
import { selectParagraphs } from '../lib/paragraphs'
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
  /** More buttons in the toolbar, beside "Edit or insert a link" — see `CodeEditor.tsx`'s own `Props.extra` doc. */
  extra?: ReactNode
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
 * floating clipboard menu doesn't attach here either; the same toolbar buttons stand in: "Select paragraphs"
 * (`selectParagraphs`, `lib/paragraphs.ts`), app clipboard copy/paste, "Open link", **"Edit or insert a link"**
 * (`markdownLinkAt` + the shared `MarkdownLinkModal`, the exact mirror of `MonacoCodeEditor.tsx`'s own — see
 * its doc comment for the full reasoning, repeated here only where CodeMirror's own API differs: a `Range`
 * built from `model.getPositionAt` there, a plain `{from, to}` offset pair into `view.state.doc` here, since
 * CodeMirror addresses positions by character offset natively and has no separate `Position`/`Range` type to
 * convert through), and `extra` (Notes' own User Action launch/close pair — asked for directly, "the
 * launch/reset custom action buttons should be added back to editors for any text file," mirroring
 * `MonacoCodeEditor.tsx`'s own `extra` exactly, including that the Files tab's own editor passes nothing).
 *
 * **Find is CodeMirror's own too, and was already reachable — just invisibly.** `basicSetup` already bundles
 * `@codemirror/search`'s `searchKeymap` (`Mod-f` → `openSearchPanel`, with the panel's own regex/case/word
 * toggles and replace fields), but a touch screen has no keyboard shortcut to discover that with — the
 * toolbar's `Search` button below just calls `openSearchPanel(view)` directly, the same function the keymap
 * already calls. `openSearchPanel` installs the rest of `@codemirror/search`'s own state on first use if it
 * isn't already present (confirmed by reading its own source — `StateEffect.appendConfig.of(searchExtensions)`
 * — rather than assumed), so `basicSetup` not including the full `search()` extension up front is not a gap:
 * nothing more had to be added here for this to work, the button is the whole fix. */
const MobileCodeMirrorEditor = forwardRef<CodeEditorHandle, Props>(function MobileCodeMirrorEditor(
  { value, onChange, fileName, onOpenLink, readOnly, language, onVisibleLineChange, onScrollNudge, extra },
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
  // The "Edit or insert a link" popup's own in-flight state — see `MonacoCodeEditor.tsx`'s identical field for
  // the full reasoning; `range` is already a plain character-offset pair here, CodeMirror's own native currency.
  const [linkEdit, setLinkEdit] = useState<{ heading: string; range: { start: number; end: number }; image: boolean; text: string; address: string } | null>(null)

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

  /** Computes, fresh on each tap (the same "decide at click time" shape `openLinkAtCursor` already uses), whether
   * the caret is in an existing markdown link — opening "Edit link" on it — or not — opening "Insert a link"
   * empty, pre-filled from the current selection. See `MonacoCodeEditor.tsx`'s own identical action for the full
   * reasoning; this is its CodeMirror counterpart. */
  function editOrInsertLink() {
    const view = viewRef.current
    if (!view) return
    const sel = view.state.selection.main
    const text = view.state.doc.toString()
    const hit = markdownLinkAt(text, sel.from, sel.to)
    if (hit) setLinkEdit({ heading: 'Edit link', range: { start: hit.start, end: hit.end }, image: hit.image, text: hit.text, address: hit.address })
    else setLinkEdit({ heading: 'Insert a link', range: { start: sel.from, end: sel.to }, image: false, text: text.slice(sel.from, sel.to), address: '' })
  }

  /** Writes the "Edit or insert a link" popup's result back — CodeMirror's own `changes`/`selection` dispatch is
   * the direct equivalent of `MonacoCodeEditor.tsx`'s `executeEdits`/`setPosition`: one real edit, in the view's
   * own history (Ctrl+Z included), with the caret landing right after the written link. */
  function submitLink(text: string, address: string) {
    const edit = linkEdit
    setLinkEdit(null)
    const view = viewRef.current
    if (!edit || !view) return
    const newText = `${edit.image ? '!' : ''}[${text}](${address})`
    view.dispatch({ changes: { from: edit.range.start, to: edit.range.end, insert: newText }, selection: { anchor: edit.range.start + newText.length } })
    view.focus()
  }

  function selectParagraphsAtCursor() {
    const view = viewRef.current
    if (!view) return
    const sel = view.state.selection.main
    const text = view.state.doc.toString()
    const range = selectParagraphs(text, sel.from, sel.to)
    view.dispatch({ selection: { anchor: range.start, head: range.end } })
    view.focus()
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
          <IconButton icon={TextCursorInput} label="Select paragraphs" onClick={selectParagraphsAtCursor} />
          <IconButton icon={Clipboard} label="Copy the selection to the app’s clipboard" onClick={copySelectionToAppClipboard} />
          <IconButton icon={ClipboardPaste} label="Paste from the app’s clipboard" onClick={pasteFromAppClipboard} />
          <IconButton icon={Search} label="Find" onClick={() => viewRef.current && openSearchPanel(viewRef.current)} />
          {onOpenLink && <IconButton icon={ExternalLink} label="Open link at the caret" onClick={openLinkAtCursor} />}
          {onOpenLink && <IconButton icon={Link2} label="Edit the link at the caret, or insert a new one" onClick={editOrInsertLink} />}
          {extra}
        </div>
      )}
      <div className="code-editor" data-text-menu-anchor>
        <div ref={hostRef} className="codemirror-editor-host" />
        {linkEdit && (
          <MarkdownLinkModal
            heading={linkEdit.heading}
            initialText={linkEdit.text}
            initialAddress={linkEdit.address}
            onSubmit={submitLink}
            onCancel={() => setLinkEdit(null)}
            onOpenExternal={onOpenLink ? (address) => void onOpenLink({ kind: 'web', target: address, start: 0, end: 0 }) : undefined}
          />
        )}
      </div>
    </div>
  )
})

export default MobileCodeMirrorEditor
