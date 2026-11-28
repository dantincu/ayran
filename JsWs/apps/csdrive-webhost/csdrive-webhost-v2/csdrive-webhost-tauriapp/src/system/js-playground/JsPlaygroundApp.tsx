import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Eraser, HelpCircle, Layers, Play, RotateCcw, Save } from 'lucide-react'
import CodeEditor from '../../components/CodeEditor'
import IconButton from '../../components/IconButton'
import Modal from '../../components/Modal'
import { getAppState, setAppState } from '../../lib/appState'
import { formatConsoleValue } from '../../lib/consoleFormat'
import { runScript } from '../../lib/scriptTagRunner'
import { readTextFile } from '../../lib/fs'
import { filenReadFile } from '../../lib/filen'
import { getAyranGlobalName } from '../../lib/ayranGlobalName'
import { confirm } from '../../lib/dialogs'
import { loadJsPlaygroundProfiles, saveJsPlaygroundProfiles, type JsPlaygroundProfile, type JsPlaygroundProfiles } from '../../lib/jsPlaygroundProfiles'
import ProfilesModal from './ProfilesModal'

const CODE_KEY = 'jsPlayground.code'
/** Written a moment after the last keystroke, the same debounce (and reasoning — a keystroke shouldn't
 * mean a round trip) `NoteEditPage.tsx`'s own draft-saving already uses. */
const SAVE_DEBOUNCE_MS = 600
/** Caps the output the same way the app's own internal clipboard caps its stack — a runaway `setInterval`
 * printing forever shouldn't grow this without bound. */
const MAX_OUTPUT_ENTRIES = 2000

const DEFAULT_CODE = "// Type JavaScript here, then press Run (or Ctrl+Shift+Enter).\nconsole.log('Hello, world!')\n"

type OutputKind = 'log' | 'info' | 'warn' | 'error' | 'debug'

interface OutputEntry {
  id: number
  kind: OutputKind
  text: string
}

/** The JS Playground's own page — see CLAUDE.md's "JS Playground" for the whole feature and its trust
 * model. A code editor, an output pane showing whatever the code prints (via `console.*`, plus uncaught
 * errors and unhandled promise rejections), a Run action that — exactly as asked for — executes the typed
 * code by inserting it as a real `<script>` element (no `eval`, no sandboxing, no separate realm — the
 * code runs with this window's own, ordinary rights), and a set of named **profiles** whose code can run
 * automatically whenever a new playground window opens. */
export default function JsPlaygroundApp() {
  const [code, setCodeState] = useState<string | null>(null)
  const [entries, setEntries] = useState<OutputEntry[]>([])
  const [profiles, setProfiles] = useState<JsPlaygroundProfiles | null>(null)
  const [profilesModalOpen, setProfilesModalOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  // The configured name of the shared `window.<name>` namespace object `jsPlayground` lives under (default
  // `"ayran"`, admin-configurable — see `lib/ayranGlobalName.ts`) — read once, purely so the help text and
  // the toolbar hint can show the *real*, current name rather than a hardcoded one that could drift from it.
  const [ayranName, setAyranName] = useState('ayran')
  // The profile currently open in the dedicated editor view (below) — a *draft*, not the live list entry,
  // so editing can be discarded without touching what's actually saved until Save is pressed.
  const [editingProfile, setEditingProfile] = useState<JsPlaygroundProfile | null>(null)
  const [editingOriginal, setEditingOriginal] = useState<JsPlaygroundProfile | null>(null)
  const editingProfileRef = useRef<JsPlaygroundProfile | null>(null)
  const editingOriginalRef = useRef<JsPlaygroundProfile | null>(null)
  const profilesRef = useRef<JsPlaygroundProfiles | null>(null)
  const codeRef = useRef('')
  const saveTimer = useRef<number | null>(null)
  const nextEntryId = useRef(0)
  const outputRef = useRef<HTMLDivElement | null>(null)

  const pushEntry = useCallback((kind: OutputKind, text: string) => {
    setEntries((prev) => {
      const next = prev.length >= MAX_OUTPUT_ENTRIES ? prev.slice(prev.length - MAX_OUTPUT_ENTRIES + 1) : prev.slice()
      next.push({ id: nextEntryId.current++, kind, text })
      return next
    })
  }, [])

  // Loads the persisted code once; a fresh install (nothing saved yet) starts from a small, working example
  // rather than a blank box, so the Run button and its shortcut have something to show off immediately.
  useEffect(() => {
    let cancelled = false
    getAppState<string>(CODE_KEY).then((saved) => {
      if (cancelled) return
      const initial = saved ?? DEFAULT_CODE
      codeRef.current = initial
      setCodeState(initial)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Sets up the globals a running script can call back into (see `lib/scriptTagRunner.ts`'s own doc comment
  // for `run`'s exact semantics), then loads the saved profiles and — if one is starred as the one that runs
  // automatically — runs its code once, right away: "whenever a new playground is opened," the same thing a
  // reload of this same page already means (there's no separate "has the init already run this session" flag
  // to track — a reload is as much "opening a fresh playground" as a brand-new window is). Deliberately one
  // combined effect, not two: the global has to exist *before* the profile's own code could possibly try to
  // call back into it.
  //
  // `jsPlayground` is a property of the shared `window.<name>` namespace (default `"ayran"`, the same object
  // `markdown.rs`'s own bootstrap script creates for its own, unrelated purpose — `window.ayran = window.ayran
  // || {}` — reused here rather than a second bare global of its own, asked for directly: "the jsPlayground
  // object should not be a global object, but live as a property on the ayran global object"), **not** a bare
  // `window.jsPlayground` — the namespace's own name has to be fetched first (`getAyranGlobalName`, the
  // generic `get_global_setting` read every window already has, since the dedicated `get_ayran_global_name`
  // command is admin-only at the capability level and would be refused outright for this window).
  useEffect(() => {
    let cancelled = false
    let namespaceName: string | null = null
    const playground = {
      run: runScript,
      readFile: (root: string, path: string) => readTextFile(root, path),
      readFilenFile: (userId: number, path: string) => filenReadFile(userId, path).then((bytes) => new TextDecoder().decode(bytes)),
    }

    getAyranGlobalName()
      .then((name) => {
        if (cancelled) return
        namespaceName = name
        setAyranName(name)
        const w = window as unknown as Record<string, Record<string, unknown> | undefined>
        const namespace = w[name] ?? {}
        namespace.jsPlayground = playground
        w[name] = namespace

        return loadJsPlaygroundProfiles().then((loaded) => {
          if (cancelled) return
          setProfiles(loaded)
          const active = loaded.profiles.find((p) => p.id === loaded.activeId)
          if (active) runScript(active.code)
        })
      })
      .catch(() => {})

    return () => {
      cancelled = true
      if (namespaceName) {
        const w = window as unknown as Record<string, Record<string, unknown> | undefined>
        // Only this app's own property — the namespace object itself may hold other things too (today
        // nothing else does, in this particular window, but it's never this page's to delete wholesale).
        if (w[namespaceName]) delete w[namespaceName]!.jsPlayground
      }
    }
  }, [])

  // Saves a moment after the last keystroke, and flushes immediately if the window closes mid-debounce —
  // the same shape `NoteEditPage.tsx`'s own draft-saving already uses, for the same reason.
  const handleChange = useCallback((value: string) => {
    codeRef.current = value
    setCodeState(value)
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      setAppState(CODE_KEY, value).catch(() => {})
    }, SAVE_DEBOUNCE_MS)
  }, [])
  useEffect(
    () => () => {
      if (saveTimer.current != null) {
        window.clearTimeout(saveTimer.current)
        setAppState(CODE_KEY, codeRef.current).catch(() => {})
      }
    },
    [],
  )

  // Console interception and uncaught-error/unhandled-rejection capture both stay active for this page's
  // whole lifetime, not just while a run is in flight — a `setTimeout`/`setInterval`/`.then()` the typed
  // code schedules keeps printing (or can keep failing) long after Run returns, and that output is just as
  // much "stuff printed by the javascript code" as what happens synchronously. Forwards to the real
  // `console` too (not a silent override) so DevTools still sees everything, same as the admin-app's own
  // code-snippet injection already does for its own scripts.
  useEffect(() => {
    const original = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      debug: console.debug.bind(console),
    }
    console.log = (...args: unknown[]) => {
      original.log(...args)
      pushEntry('log', args.map(formatConsoleValue).join(' '))
    }
    console.info = (...args: unknown[]) => {
      original.info(...args)
      pushEntry('info', args.map(formatConsoleValue).join(' '))
    }
    console.warn = (...args: unknown[]) => {
      original.warn(...args)
      pushEntry('warn', args.map(formatConsoleValue).join(' '))
    }
    console.error = (...args: unknown[]) => {
      original.error(...args)
      pushEntry('error', args.map(formatConsoleValue).join(' '))
    }
    console.debug = (...args: unknown[]) => {
      original.debug(...args)
      pushEntry('debug', args.map(formatConsoleValue).join(' '))
    }

    function onError(e: ErrorEvent) {
      pushEntry('error', e.error !== undefined ? formatConsoleValue(e.error) : e.message)
    }
    function onRejection(e: PromiseRejectionEvent) {
      pushEntry('error', `Unhandled promise rejection: ${formatConsoleValue(e.reason)}`)
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)

    return () => {
      console.log = original.log
      console.info = original.info
      console.warn = original.warn
      console.error = original.error
      console.debug = original.debug
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [pushEntry])

  // Keeps the output pane scrolled to whatever just printed, the same "follow the newest line" behaviour
  // any console/terminal has.
  useEffect(() => {
    const el = outputRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])

  // The top-level Run action: clears the pane first (the one place in this file that does — a nested
  // `jsPlayground.run(...)` call, or a profile's own auto-run, never clears what's already printed, only
  // this one, the person's own explicit "start over" gesture). `runScript` itself is what actually replaces
  // whatever script element is currently inserted, whether that was a profile's own init code, an earlier
  // Run, or a nested call — see its own doc comment.
  const run = useCallback(() => {
    const src = codeRef.current
    if (!src.trim()) return
    setEntries([])
    nextEntryId.current = 0
    runScript(src)
  }, [])

  // Ctrl+Shift+Enter, not the more common bare Ctrl+Enter — checked directly against the actual bundled
  // editors before picking it: CodeMirror's `basicSetup` binds `Mod-Enter` to `insertBlankLine` by default
  // (`@codemirror/commands`'s `defaultKeymap`), so a plain Ctrl+Enter would also insert a blank line in the
  // editor on top of running the code on Android/mobile. Ctrl+Shift+Enter isn't claimed by anything in
  // either bundled editor (Monaco's bare `editor.api` core ships none of its contrib keybindings — see
  // `MonacoCodeEditor.tsx`'s own doc comment — and CodeMirror's bundled keymaps have no `Shift-Mod-Enter`
  // entry either), so the window-level listener here is the only thing that ever reacts to it. Ignored while
  // the profile editor view is open — that one has its own Ctrl+S, and Ctrl+Shift+Enter there would run the
  // *main* editor's code behind it, not the profile being edited.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (editingProfileRef.current) return
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key === 'Enter') {
        e.preventDefault()
        run()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [run])

  function openProfileEditor(profile: JsPlaygroundProfile) {
    setProfilesModalOpen(false)
    setEditingProfile({ ...profile })
    setEditingOriginal({ ...profile })
  }

  const profileDirty = !!editingProfile && !!editingOriginal && (editingProfile.name !== editingOriginal.name || editingProfile.code !== editingOriginal.code)

  // Kept in sync on every render (a plain assignment, not an effect — there's nothing to react to, just a
  // value a stable callback below needs to read without being recreated on every keystroke): the same
  // reason `codeRef`/`handleChange` above avoid re-registering the Ctrl+Shift+Enter listener on every
  // keystroke, applied here so editing a profile's code doesn't churn the Ctrl+S listener the same way.
  editingProfileRef.current = editingProfile
  editingOriginalRef.current = editingOriginal
  profilesRef.current = profiles

  const closeProfileEditor = useCallback(async () => {
    const dirty = !!editingProfileRef.current && !!editingOriginalRef.current && (editingProfileRef.current.name !== editingOriginalRef.current.name || editingProfileRef.current.code !== editingOriginalRef.current.code)
    if (dirty && !(await confirm('Discard your unsaved changes to this profile?'))) return
    setEditingProfile(null)
    setEditingOriginal(null)
    setProfilesModalOpen(true)
  }, [])

  const discardProfileEdits = useCallback(() => {
    if (editingOriginalRef.current) setEditingProfile({ ...editingOriginalRef.current })
  }, [])

  const saveProfileEdits = useCallback(async () => {
    const current = editingProfileRef.current
    const currentProfiles = profilesRef.current
    if (!currentProfiles || !current) return
    const trimmedName = current.name.trim() || 'Untitled profile'
    const saved = { ...current, name: trimmedName }
    const next = { ...currentProfiles, profiles: currentProfiles.profiles.map((p) => (p.id === saved.id ? saved : p)) }
    setProfiles(next)
    await saveJsPlaygroundProfiles(next)
    setEditingProfile(null)
    setEditingOriginal(null)
    setProfilesModalOpen(true)
  }, [])

  // Ctrl+S saves the profile being edited — the same shortcut every other text editor in this app already
  // answers to (CLAUDE.md: "Ctrl+S now saves in every text editor"). Mounted once (every callback it calls
  // is stable, reading the latest state through the refs above), and a no-op whenever nothing is being
  // edited — harmless, since nothing else in this page's normal view uses Ctrl+S.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!editingProfileRef.current) return
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        saveProfileEdits()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [saveProfileEdits])

  if (code === null) {
    return <div className="js-playground-status muted">Loading…</div>
  }

  if (editingProfile) {
    return (
      <div className="js-playground">
        <div className="js-playground-toolbar toolbar-actions js-playground-profile-header" data-primary-actions>
          <IconButton icon={ArrowLeft} label="Back to the profiles list" onClick={closeProfileEditor} />
          <input
            className="js-playground-profile-name"
            value={editingProfile.name}
            onChange={(e) => setEditingProfile({ ...editingProfile, name: e.target.value })}
            aria-label="This profile's name"
          />
          <IconButton icon={RotateCcw} label="Discard your unsaved changes" onClick={discardProfileEdits} disabled={!profileDirty} />
          <IconButton icon={Save} label="Save (Ctrl+S)" onClick={saveProfileEdits} disabled={!profileDirty} />
        </div>
        <div className="js-playground-panes">
          <div className="js-playground-pane js-playground-editor-pane js-playground-profile-pane">
            <CodeEditor value={editingProfile.code} onChange={(value) => setEditingProfile({ ...editingProfile, code: value })} fileName="profile.js" />
          </div>
        </div>
      </div>
    )
  }

  const activeProfile = profiles?.profiles.find((p) => p.id === profiles.activeId) ?? null

  return (
    <div className="js-playground">
      <div className="js-playground-toolbar toolbar-actions" data-primary-actions>
        <button type="button" className="js-playground-run" onClick={run} disabled={!code.trim()}>
          <Play size={14} aria-hidden="true" />
          Run
        </button>
        <IconButton icon={Eraser} label="Clear the output" onClick={() => setEntries([])} disabled={entries.length === 0} />
        <IconButton icon={Layers} label="Manage profiles…" onClick={() => setProfilesModalOpen(true)} />
        <IconButton icon={HelpCircle} label="What is this?" onClick={() => setHelpOpen(true)} />
        <span className="muted js-playground-hint">
          Ctrl+Shift+Enter runs the code{activeProfile ? ` · "${activeProfile.name}" runs automatically on open` : ''}
        </span>
      </div>
      <div className="js-playground-panes">
        <div className="js-playground-pane js-playground-editor-pane">
          <CodeEditor value={code} onChange={handleChange} fileName="playground.js" />
        </div>
        <div className="js-playground-pane js-playground-output-pane">
          <div className="js-playground-output" ref={outputRef}>
            {entries.length === 0 ? (
              <p className="muted js-playground-output-empty">Nothing printed yet. Press Run (or Ctrl+Shift+Enter) to execute the code.</p>
            ) : (
              entries.map((entry) => (
                <div key={entry.id} className={`js-playground-output-entry js-playground-output-${entry.kind}`}>
                  {entry.text}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
      {profilesModalOpen && profiles && (
        <ProfilesModal
          profiles={profiles}
          onChange={(next) => {
            setProfiles(next)
            saveJsPlaygroundProfiles(next).catch(() => {})
          }}
          onEditProfile={openProfileEditor}
          onRunProfile={(profileCode) => runScript(profileCode)}
          onClose={() => setProfilesModalOpen(false)}
        />
      )}
      {helpOpen && (
        <Modal title="What is this?" onClose={() => setHelpOpen(false)}>
          <p>
            The code here runs with this window's own, ordinary rights — the same trust level as hand-authoring a <code>&lt;script&gt;</code> tag into a
            file you already control. Nothing is sandboxed: Run inserts your code as a real <code>&lt;script&gt;</code> element, and a profile's own code
            (Manage profiles…) runs the same way, automatically, whenever a new playground window opens.
          </p>
          <p>
            Three things any of that code can call, whether it's the main editor's, a profile's, or code run through one of these — all under{' '}
            <code>window.{ayranName}.jsPlayground</code> (the <code>{ayranName}</code> namespace is shared with other parts of the app and is renamed from
            Settings; <code>jsPlayground</code> below is for short):
          </p>
          <ul>
            <li>
              <code>{ayranName}.jsPlayground.run(code)</code> — runs a string of JavaScript the same way Run does (replacing whatever it most recently ran,
              the same "no `eval`" mechanism — see CLAUDE.md's "JS Playground").
            </li>
            <li>
              <code>{ayranName}.jsPlayground.readFile(root, path)</code> — reads a local file as text (<code>root</code> is <code>'user'</code> for the user
              folder, or a picked folder's own id).
            </li>
            <li>
              <code>{ayranName}.jsPlayground.readFilenFile(userId, path)</code> — reads a file from a connected Filen account as text.
            </li>
          </ul>
          <p className="muted">
            Both <code>readFile</code> functions return a <code>Promise</code> — a plain script has no top-level <code>await</code>, so use
            <code> .then(...)</code> or wrap the call in <code>(async () =&gt; {'{'} ... {'}'})()</code>. Everything else the Notes app can do is already
            reachable too, directly, through <code>window.__TAURI__.core.invoke(...)</code> — nothing here is sandboxed away from it.
          </p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setHelpOpen(false)}>
              Close
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
