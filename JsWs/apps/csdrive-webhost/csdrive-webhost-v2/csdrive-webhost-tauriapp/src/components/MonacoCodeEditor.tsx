import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Clipboard, ClipboardPaste, ExternalLink, Redo2, Undo2 } from 'lucide-react'
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/languages/definitions/javascript/register.js'
import 'monaco-editor/languages/definitions/css/register.js'
import 'monaco-editor/languages/definitions/html/register.js'
import 'monaco-editor/languages/definitions/markdown/register.js'
import 'monaco-editor/languages/features/json/register.js'
// `monaco-editor/editor/editor.api` is Monaco's bare core API — it registers no *contribution* at all (Find,
// folding, bracket matching, multicursor…): those all live behind `monaco-editor/editor/editor.main.js`
// (`esm/vs/editor/editor.main.js`), which imports *every* one of them plus every language's own definition —
// a much bigger bundle than this file otherwise needs. Found live, not assumed: with only `editor.api`
// imported, Ctrl+F did nothing at all (confirmed via a direct `editor.trigger('', 'actions.find', null)` call,
// which silently no-ops when the command was never registered) — the module doc below used to claim "real
// find/replace… come from Monaco itself," which was aspirational, not yet true, until this import landed.
// `contrib/find/browser/findController.js` is self-contained (its own imports are only base/platform services
// already set up by `editor.api.js` for any standalone editor, confirmed by reading its import list) and pulls
// in no other contribution, so importing it alone — rather than the whole `editor.main.js` — registers Find/
// Replace (`Ctrl+F`/`Ctrl+H`, the regex/case/whole-word toggles, Find All) with nothing else added. It renders
// its own icons with Monaco's `codicon` font, which nothing before this imported either (confirmed live: the
// toggle buttons showed as empty boxes without it).
import 'monaco-editor/editor/contrib/find/browser/findController.js'
// **The two codicon CSS files are imported by a literal relative path into `node_modules`, not by
// `monaco-editor`'s own package specifier** — found live, not assumed: `monaco-editor`'s `package.json` only
// has two wildcard `exports` patterns (`./*.js` and `./*`), and *both* append a literal `.js` to the resolved
// target. That's exactly right for every other import in this file (`'monaco-editor/editor/editor.api'` →
// `esm/vs/editor/editor.api.js`, the bare pattern assuming a `.js` suffix was simply omitted from the
// specifier — true for every `.js` module this file reaches), but it's *wrong* for a `.css` path: the bare
// `./*` pattern resolves `codicon.css` to a nonexistent `codicon.css.js`. Vite's own CSS pipeline tolerated
// this (the build's first pass actually emitted real `codicon.ttf`/CSS output), but Rolldown's separate,
// stricter post-transform import-validation pass then failed the *identical* specifier as unresolved —
// a real build failure, not a lint warning, caught by `npm run build` itself. A plain relative path
// (`../../node_modules/...`) is a plain filesystem reference, never a bare package specifier, so neither
// tool's `exports`-map handling is involved at all — this is the standard escape hatch for a package whose
// own `exports` map doesn't support what's actually needed from it.
import '../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css'
import '../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css'
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

/** Our own replacement for Monaco's built-in `cursorWordLeft`/`cursorWordRight` (and their `Select`
 * variants) — see the long comment where these are wired up, in the mount effect, for why: every one of
 * Monaco's own word-navigation commands (including the Windows/NVDA-tuned "Accessibility" variants its own
 * default keybinding falls back to) turned out to be unreachable through `editor.trigger()` on this
 * platform/Monaco build, confirmed live with a plain non-word command (`cursorLeft`) working fine the same
 * way. With no command id left to delegate to, this computes the target position itself — using the
 * model's own public `getWordAtPosition` (Monaco's own word-definition logic, respecting `wordSeparators`,
 * not a hand-rolled regex guessing at word boundaries) for the actual "where is the nearest word" question,
 * and only hand-rolling the *walk* across whitespace/line boundaries between one word and the next, which
 * `getWordAtPosition` alone doesn't do. Deliberately modest in scope — it does not try to replicate every
 * one of Monaco's own corner cases (camelCase sub-word stops, `WordNavigationType.WordAccessibility`'s own
 * NVDA-specific behavior) — just the ordinary "jump to the start of the previous/next word" shape Ctrl+Arrow
 * has always meant here, which is what was reported broken. */
function wordBoundaryLeft(model: monaco.editor.ITextModel, position: monaco.Position): monaco.Position {
  if (position.column === 1) {
    if (position.lineNumber === 1) return position
    const line = position.lineNumber - 1
    return new monaco.Position(line, model.getLineMaxColumn(line))
  }
  const lineContent = model.getLineContent(position.lineNumber)
  let idx = position.column - 2 // 0-based index of the character immediately before the caret
  while (idx >= 0 && /\s/.test(lineContent[idx])) idx--
  if (idx < 0) return new monaco.Position(position.lineNumber, 1)
  const word = model.getWordAtPosition(new monaco.Position(position.lineNumber, idx + 2))
  // `getWordAtPosition` queried exactly at a word's own boundary can match that word even when the
  // character actually being asked about (here, `idx`) sits just *outside* it — found live, landing on a
  // line ending in `…lineNumber0() {`: querying right at the boundary between "lineNumber0" and the "("
  // right after it returned "lineNumber0" itself (its own `endColumn` exactly matching the query column),
  // silently producing "no movement at all" since that word's own start was already behind the caret.
  // Checking the word's own range genuinely contains `idx` is what `getWordAtPosition`'s own "under or
  // *besides*" contract doesn't guarantee on its own.
  if (word && word.startColumn <= idx + 1 && idx + 1 < word.endColumn) return new monaco.Position(position.lineNumber, word.startColumn)
  // `idx`'s own character isn't part of a "word" by Monaco's own definition (e.g. a lone punctuation run) —
  // land just before it; a further press walks over it the same way one more whitespace-skip would.
  return new monaco.Position(position.lineNumber, idx + 1)
}

function wordBoundaryRight(model: monaco.editor.ITextModel, position: monaco.Position): monaco.Position {
  const lastLine = model.getLineCount()
  const maxCol = model.getLineMaxColumn(position.lineNumber)
  if (position.column === maxCol) {
    if (position.lineNumber === lastLine) return position
    return new monaco.Position(position.lineNumber + 1, 1)
  }
  const lineContent = model.getLineContent(position.lineNumber)
  let idx = position.column - 1 // 0-based index of the character right at/after the caret
  while (idx < lineContent.length && /\s/.test(lineContent[idx])) idx++
  if (idx >= lineContent.length) return new monaco.Position(position.lineNumber, maxCol)
  const word = model.getWordAtPosition(new monaco.Position(position.lineNumber, idx + 1))
  // Same boundary check as `wordBoundaryLeft`'s own, mirrored: confirm the word actually contains `idx`
  // before trusting it, rather than one that merely touches the query column from the far side.
  if (word && word.startColumn <= idx + 1 && idx + 1 < word.endColumn) return new monaco.Position(position.lineNumber, word.endColumn)
  return new monaco.Position(position.lineNumber, idx + 2)
}

/** Moves the caret (collapsing any selection) or, with `select`, extends the current selection — the
 * anchor (`getSelectionStart()`) stays put and only the active end moves — exactly how Monaco's own
 * `cursorWordLeft`/`cursorWordLeftSelect` already behave for every *other* editor in this app that still
 * reaches them through a real keybinding; this is purely a same-behavior stand-in for the one platform
 * where that reach is broken. */
function moveWord(editor: monaco.editor.IStandaloneCodeEditor, direction: 'left' | 'right', select: boolean): void {
  const model = editor.getModel()
  const selection = editor.getSelection()
  if (!model || !selection) return
  const from = selection.getPosition()
  const to = direction === 'left' ? wordBoundaryLeft(model, from) : wordBoundaryRight(model, from)
  if (select) {
    const anchor = selection.getSelectionStart()
    editor.setSelection(new monaco.Selection(anchor.lineNumber, anchor.column, to.lineNumber, to.column))
  } else {
    editor.setPosition(to)
  }
  editor.revealPosition(to)
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
 * directly: "use a third party code editor... Monaco for desktop." Folding, multi-cursor, bracket matching and
 * (for JSON/CSS/HTML/JS) real diagnostics come from Monaco itself, not anything this wrapper adds — it owns
 * the model, wires this app's own settings onto Monaco's native options, and bridges the handful of things
 * that are specific to how this app's editors are used elsewhere (a caller's `insertAtCursor`, mirror-scroll,
 * the Ctrl+Alt+arrow scroll-nudge, "Open link"). **Find/Replace is Monaco's own too** (Ctrl+F/Ctrl+H, regex
 * and case/whole-word toggles, Find All) — asked for directly, alongside a custom find bar for this app's own
 * built-in editor (`FindBar.tsx`, used by `CodeEditor.tsx`'s `HighlightedEditor`/`PlainTextEditor`, which had
 * no such capability of its own): see the `contrib/find/browser/findController.js` import above for why this
 * needed an import at all, rather than already working.
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
    })
    editorRef.current = editor
    // Monaco 0.57's default input surface is a `<div class="native-edit-context">` built on the browser's
    // EditContext API, not the classic hidden `<textarea class="inputarea">` — reported live: "Ctrl+LeftArrow
    // and Ctrl+RightArrow (along Ctrl+Shift+LeftArrow and Ctrl+Shift+RightArrow) don't work... they do
    // nothing," while Ctrl+Backspace/Ctrl+Delete (word deletion) work correctly. First fixed with
    // `editContext: false`, falling back to the classic hidden-textarea input path — but that path turned
    // out to have its *own*, worse bug: reported live again, "Ctrl+Shift+arrow keys only work well for 1
    // press... the selection is reset after each press" once scrolled far from the start of a large file.
    // Root cause, confirmed live with Monaco's own debug API: the legacy textarea controller never mirrors
    // the *whole* document into the real textarea, only a bounded window of text around the cursor, and a
    // growing Ctrl+Shift+Arrow selection that crosses that window's edge makes Monaco's own internal
    // selection freeze while the browser's native textarea selection keeps drifting on its own — a second,
    // separate Monaco bug in that same legacy path, and the legacy path itself isn't a mode to keep leaning
    // on regardless (asked for directly: "using a legacy mode for the monaco editor is not ideal").
    //
    // **`editContext` is back at Monaco's own default (`true`, the modern surface); the original, narrower
    // gap is fixed directly instead of by changing modes at all.** Reading Monaco's own source
    // (`wordOperations.js`) explains the original gap precisely: the default Ctrl+Left/Right/Shift+Left/
    // Right keybindings carry `kbExpr: ... ContextKeyExpr.and(CONTEXT_ACCESSIBILITY_MODE_ENABLED,
    // IsWindowsContext)?.negate()` — on Windows, whenever Monaco's own "accessibility mode" context key
    // reads true, those keybindings are *deliberately disabled* in favour of a separate, NVDA-tuned
    // "Accessibility" word-navigation variant instead ("Accessibility navigation commands should only be
    // enabled on windows since they are tuned to what NVDA expects" — Monaco's own comment). Confirmed live
    // that this matters here: calling *any* of the built-in word-navigation commands — `cursorWordLeft`,
    // `cursorWordLeftSelect`, the `Start`/`End` variants, and the "Accessibility" ones Windows falls back
    // to — via `editor.trigger()` does nothing at all, while the exact same call for a plain, non-word
    // command (`cursorLeft`) works correctly; real Ctrl+Backspace (`deleteWordLeft`, a *different* command
    // family) still working, as originally reported, is consistent with this being specific to the
    // word-*navigation* commands, not a blanket EditContext-mode failure. With no working command id to
    // delegate to by any means (not just real keyboard dispatch — a bare JS call fails identically), this
    // computes the target position itself: `wordBoundaryLeft`/`wordBoundaryRight` (module-level, above) use
    // the model's own public `getWordAtPosition` for Monaco's actual word-boundary definition (so this isn't
    // a hand-rolled regex guessing at word shape — only the walk across whitespace/line boundaries between
    // one word and the next, which `getWordAtPosition` alone doesn't do, is this file's own), and `moveWord`
    // applies the result with the always-reliable `setPosition`/`setSelection` — confirmed live to work
    // correctly, repeatedly, including far from the start of a large file, with no equivalent of either
    // bug above (there is no textarea-content window to cross in EditContext mode, and no reliance on any
    // of the broken command ids at all).
    const wordNavActions = [
      editor.addAction({
        id: 'csdrive.cursorWordLeft',
        label: 'Move left one word',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.LeftArrow],
        run: () => moveWord(editor, 'left', false),
      }),
      editor.addAction({
        id: 'csdrive.cursorWordRight',
        label: 'Move right one word',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.RightArrow],
        run: () => moveWord(editor, 'right', false),
      }),
      editor.addAction({
        id: 'csdrive.cursorWordLeftSelect',
        label: 'Select left one word',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.LeftArrow],
        run: () => moveWord(editor, 'left', true),
      }),
      editor.addAction({
        id: 'csdrive.cursorWordRightSelect',
        label: 'Select right one word',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.RightArrow],
        run: () => moveWord(editor, 'right', true),
      }),
    ]
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
      wordNavActions.forEach((a) => a.dispose())
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
