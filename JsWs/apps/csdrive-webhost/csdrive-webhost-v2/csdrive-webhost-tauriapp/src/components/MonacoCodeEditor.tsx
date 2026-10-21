import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Clipboard, ClipboardPaste, ExternalLink, Redo2, Undo2 } from 'lucide-react'
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/languages/definitions/javascript/register.js'
import 'monaco-editor/languages/definitions/css/register.js'
import 'monaco-editor/languages/definitions/html/register.js'
import 'monaco-editor/languages/definitions/markdown/register.js'
import 'monaco-editor/languages/features/json/register.js'
import IconButton from './IconButton'
import { languageOf, type Language } from '../lib/highlight'
import { linkAt, type LinkHandler } from '../lib/textLinks'
import { internalClipboard } from '../lib/clipboard'
import { subscribeEditorSettings, type EditorSettings } from '../lib/editorSettings'
import { reportVirtualScroll } from '../lib/scrollAutohide'
import type { CodeEditorHandle } from './CodeEditor'

/** `getWorker` is called lazily, once per label Monaco actually needs a worker for — each branch's own
 * `new URL(<literal>, import.meta.url)` is what lets Vite statically find and code-split that one worker's
 * entry point, so a file that never touches JSON/CSS/HTML/TypeScript's richer language service never pays to
 * load that worker's own chunk. No AMD loader anywhere in this file (`monaco-editor/editor/editor.api`,
 * not the classic `vs/loader.js`) — the AMD loader's own module system uses `eval`/`new Function` internally,
 * which this app's CSP (`script-src 'self' 'unsafe-inline'`, no `'unsafe-eval'`) refuses; the plain ESM imports
 * here don't need either. */
self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === 'json') {
      return new Worker(new URL('monaco-editor/languages/features/json/json.worker.js', import.meta.url), { type: 'module' })
    }
    if (label === 'css' || label === 'less' || label === 'scss') {
      return new Worker(new URL('monaco-editor/languages/features/css/css.worker.js', import.meta.url), { type: 'module' })
    }
    if (label === 'html' || label === 'handlebars' || label === 'razor') {
      return new Worker(new URL('monaco-editor/languages/features/html/html.worker.js', import.meta.url), { type: 'module' })
    }
    return new Worker(new URL('monaco-editor/editor/editor.worker.js', import.meta.url), { type: 'module' })
  },
}

function monacoLanguageId(language: Language, highlightDisabled: boolean): string {
  if (highlightDisabled) return 'plaintext'
  if (language === 'text') return 'plaintext'
  return language
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

/** The desktop default editor while `editor.useBuiltInEditor` is off (`lib/editorSettings.ts`) — asked for
 * directly: "use a third party code editor... Monaco for desktop." Real find/replace, folding, multi-cursor,
 * bracket matching and (for JSON/CSS/HTML/JS) real diagnostics come from Monaco itself, not anything this
 * wrapper adds — it owns the model, wires this app's own settings onto Monaco's native options, and bridges
 * the handful of things that are specific to how this app's editors are used elsewhere (a caller's
 * `insertAtCursor`, mirror-scroll, the Ctrl+Alt+arrow scroll-nudge, "Open link").
 *
 * **`TextFieldMenu`'s own floating clipboard menu does not attach to this editor** — it recognises a plain
 * `HTMLTextAreaElement`/`HTMLInputElement` gaining focus, and Monaco's real editing surface is a `contenteditable`-
 * adjacent view with its own internal (off-screen) textarea used only for IME composition, never the focused
 * element a person actually clicks into. "Select paragraphs" and "Manage the app's clipboard…" are not
 * reproduced here (Monaco's own multi-cursor/expand-selection already covers much of the first; the clipboard
 * manager modal is still reachable from Settings) — what *is* kept, as toolbar buttons next to Undo/Redo
 * (`Clipboard`/`ClipboardPaste`/`ExternalLink`, matching the icons used elsewhere in the app for the same
 * actions): copying the current selection to the app's own clipboard, pasting its top entry over the
 * selection, and opening the link at the caret through the same `onOpenLink` dispatch every other editor
 * uses. The OS clipboard needs nothing special — copy/paste on any editable surface is the browser's own,
 * ordinary behaviour. */
const MonacoCodeEditor = forwardRef<CodeEditorHandle, Props>(function MonacoCodeEditor(
  { value, onChange, fileName, onOpenLink, readOnly, language, onVisibleLineChange, onScrollNudge },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const [settings, setSettings] = useState<EditorSettings | null>(null)
  useEffect(() => subscribeEditorSettings(setSettings), [])
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const lastVisibleLine = useRef<number | null>(null)
  const effectiveLanguage = language ?? languageOf(fileName)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const model = monaco.editor.createModel(value, monacoLanguageId(effectiveLanguage, false))
    const editor = monaco.editor.create(host, {
      model,
      readOnly,
      automaticLayout: true,
      minimap: { enabled: false },
      // Monaco 0.57's default input surface is a `<div class="native-edit-context">` built on the browser's
      // EditContext API, not the classic hidden `<textarea class="inputarea">` — reported live: "Ctrl+LeftArrow
      // and Ctrl+RightArrow (along Ctrl+Shift+LeftArrow and Ctrl+Shift+RightArrow) don't work... they do
      // nothing," while Ctrl+Backspace/Ctrl+Delete (word deletion) work correctly. Confirmed live with a real
      // CDP keystroke and a diagnostic bubble-phase `keydown` listener on `document`: the event reaches
      // `document` with `defaultPrevented: false` (nothing in this app's own code ever touches it) and its
      // `target` is the `.native-edit-context` div — the cursor simply never moves, a gap in Monaco's own
      // EditContext-mode word-navigation wiring on this platform/WebView2 combination, not anything this app
      // controls. `editContext: false` (a real, documented `IEditorOptions` field: "Sets whether the new
      // experimental edit context should be used instead of the text area") falls back to the long-standing,
      // thoroughly-proven hidden-textarea input path, where Ctrl+Left/Right/Shift+Left/Right are plain,
      // always-correct default keybindings.
      editContext: false,
    })
    editorRef.current = editor
    const changeSub = editor.onDidChangeModelContent(() => {
      onChangeRef.current(editor.getValue())
      // Monaco keeps no public "can undo/redo" flag — `trigger('', 'undo'/'redo')` is a no-op when there's
      // nothing to do, so the buttons stay enabled slightly more often than strictly accurate; harmless.
      setCanUndo(true)
      setCanRedo(false)
    })
    const scrollSub = editor.onDidScrollChange(() => {
      // Monaco never fires a real DOM `scroll` event (it renders via its own internal transform, not native
      // overflow) — this is the one and only place that's true, so it's reported here unconditionally, not
      // folded into the `onVisibleLineChange`-only branch below (see `lib/scrollAutohide.ts`'s own doc
      // comment for the live-confirmed root cause and why a plain exported function, not a prop, is correct).
      reportVirtualScroll(host, editor.getScrollTop(), editor.getScrollHeight(), editor.getLayoutInfo().height)
      if (!onVisibleLineChange) return
      const visible = editor.getVisibleRanges()[0]
      if (!visible) return
      const line = visible.startLineNumber
      if (line !== lastVisibleLine.current) {
        lastVisibleLine.current = line
        onVisibleLineChange(line)
      }
    })
    // Each of the four needs its own literal keybinding — Monaco's `KeyMod`/`KeyCode` constants have no
    // lookup-by-name table to drive this from a loop.
    const nudgeActions = onScrollNudge
      ? [
          editor.addAction({
            id: 'csdrive.scrollNudge.up',
            label: 'Scroll the syncing web app up',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.UpArrow],
            run: () => onScrollNudge('up'),
          }),
          editor.addAction({
            id: 'csdrive.scrollNudge.down',
            label: 'Scroll the syncing web app down',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.DownArrow],
            run: () => onScrollNudge('down'),
          }),
          editor.addAction({
            id: 'csdrive.scrollNudge.pageUp',
            label: 'Scroll the syncing web app up a page',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.PageUp],
            run: () => onScrollNudge('pageUp'),
          }),
          editor.addAction({
            id: 'csdrive.scrollNudge.pageDown',
            label: 'Scroll the syncing web app down a page',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.PageDown],
            run: () => onScrollNudge('pageDown'),
          }),
        ]
      : []
    const openLinkAction = onOpenLink
      ? editor.addAction({
          id: 'csdrive.openLink',
          label: 'Open link',
          contextMenuGroupId: 'navigation',
          run: () => {
            const pos = editor.getPosition()
            const sel = editor.getSelection()
            if (!pos) return
            const text = editor.getValue()
            const offset = editor.getModel()?.getOffsetAt(pos) ?? 0
            const selStart = sel ? editor.getModel()?.getOffsetAt(sel.getStartPosition()) ?? offset : offset
            const selEnd = sel ? editor.getModel()?.getOffsetAt(sel.getEndPosition()) ?? offset : offset
            const hit = linkAt(text, selStart, selEnd)
            if (hit) void onOpenLink(hit)
          },
        })
      : null
    const copyToAppClipboardAction = editor.addAction({
      id: 'csdrive.copyToAppClipboard',
      label: 'Copy to the app’s clipboard',
      contextMenuGroupId: '9_cutcopypaste',
      run: () => {
        const sel = editor.getSelection()
        const model = editor.getModel()
        if (!sel || !model) return
        const text = model.getValueInRange(sel)
        if (text) void internalClipboard.push(text)
      },
    })
    const pasteFromAppClipboardAction = editor.addAction({
      id: 'csdrive.pasteFromAppClipboard',
      label: 'Paste from the app’s clipboard',
      contextMenuGroupId: '9_cutcopypaste',
      run: async () => {
        const text = await internalClipboard.peek()
        if (text === null) return
        const sel = editor.getSelection()
        if (!sel) return
        editor.executeEdits('csdrive.pasteFromAppClipboard', [{ range: sel, text }])
      },
    })
    return () => {
      changeSub.dispose()
      scrollSub.dispose()
      openLinkAction?.dispose()
      copyToAppClipboardAction.dispose()
      pasteFromAppClipboardAction.dispose()
      nudgeActions.forEach((a) => a.dispose())
      editor.dispose()
      model.dispose()
      editorRef.current = null
    }
    // Mount-only: `value`/`language`/`onOpenLink`/`onVisibleLineChange`/`onScrollNudge` are read fresh inside
    // the callbacks above (via refs or the editor's own live state) rather than re-running this whole effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // External `value` changes (a file re-read, undo/redo from outside) — never fight an in-progress edit the
  // model already has, mirroring the other editors' own "already current, do nothing" check.
  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (model && model.getValue() !== value) model.setValue(value)
  }, [value])

  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (model) monaco.editor.setModelLanguage(model, monacoLanguageId(effectiveLanguage, settings?.highlightDisabled ?? false))
  }, [effectiveLanguage, settings?.highlightDisabled])

  useEffect(() => {
    editorRef.current?.updateOptions({
      readOnly,
      wordWrap: settings?.wrapLines === false ? 'off' : 'on',
      lineNumbers: settings?.lineNumbers === false ? 'off' : 'on',
      renderWhitespace: settings?.showWhitespace ? 'all' : 'none',
      insertSpaces: settings?.tabInsertsSpaces ?? false,
      tabSize: settings?.tabSpaceCount ?? 4,
    })
  }, [readOnly, settings?.wrapLines, settings?.lineNumbers, settings?.showWhitespace, settings?.tabInsertsSpaces, settings?.tabSpaceCount])

  useImperativeHandle(ref, () => ({
    insertAtCursor(text) {
      const editor = editorRef.current
      const sel = editor?.getSelection()
      if (!editor || !sel) return
      editor.executeEdits('csdrive.insertAtCursor', [{ range: sel, text }])
      editor.focus()
    },
  }))

  return (
    <div className="code-editor-wrap">
      {!readOnly && (
        <div className="code-editor-toolbar">
          <IconButton icon={Undo2} label="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => editorRef.current?.trigger('', 'undo', null)} />
          <IconButton icon={Redo2} label="Redo (Ctrl+Y)" disabled={!canRedo} onClick={() => editorRef.current?.trigger('', 'redo', null)} />
          <IconButton
            icon={Clipboard}
            label="Copy the selection to the app’s clipboard"
            onClick={() => editorRef.current?.trigger('', 'csdrive.copyToAppClipboard', null)}
          />
          <IconButton
            icon={ClipboardPaste}
            label="Paste from the app’s clipboard"
            onClick={() => editorRef.current?.trigger('', 'csdrive.pasteFromAppClipboard', null)}
          />
          {onOpenLink && (
            <IconButton icon={ExternalLink} label="Open link at the caret" onClick={() => editorRef.current?.trigger('', 'csdrive.openLink', null)} />
          )}
          <span className="code-editor-menu-slot" data-text-menu-target />
        </div>
      )}
      <div className="code-editor" data-text-menu-anchor>
        <div ref={hostRef} className="monaco-editor-host" />
      </div>
    </div>
  )
})

export default MonacoCodeEditor
