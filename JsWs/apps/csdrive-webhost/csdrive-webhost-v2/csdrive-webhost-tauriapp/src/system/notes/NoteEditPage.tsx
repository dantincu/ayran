import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { confirm } from '../../lib/dialogs'
import { AppWindow, ArrowLeft, Link2, Paperclip, RefreshCw, Save } from 'lucide-react'
import CodeEditor, { type CodeEditorHandle } from '../../components/CodeEditor'
import IconButton from '../../components/IconButton'
import PathStyleModal from '../../components/PathStyleModal'
import { getAppState, setAppState } from '../../lib/appState'
import { onShowTopBar, openExternalSite, openNoteTab, syncRefreshWithoutScroll, syncScrollNudge, syncScrollToLine } from '../../lib/secondaryWindows'
import { resolveLinkedPath, type LinkHit } from '../../lib/textLinks'
import { absolutePathFrom, relativePathFrom } from '../../lib/relativePath'
import { useScrollAutohide } from '../../lib/scrollAutohide'
import { findMarkdown, readNote, renameNote, titleFromMarkdown, touchNote, type NoteRef } from './noteModel'
import type { FileVersion } from './sources'
import { reportNotePlace, type Place, type Tab } from './tabs'
import { useNotesSources } from './useSources'
import { loadNotebooks } from './notebooks'
import { useNotesSettings } from './settings'
import { notebookContaining } from './userAction'
import UserActionButton from './UserActionButton'
import CacheMenu from './CacheMenu'
import InsertPathModal from './InsertPathModal'

/** The unsaved text of note editors that were left (a tab switched away from, a window closed): `<source>|<markdown path>` → text. */
const DRAFTS_KEY = 'notes.noteDrafts'

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/** The dedicated page for editing a note's markdown (a file of the File Manager has one of its own too, `NotesApp.tsx`'s
 * `editing` — neither is a popup any more). What isn't saved is kept as a draft while the page is left and comes back with it; saving asks Filen first when the
 * note is in an account, keeps the note's title in step with its first heading (the folder and file names follow, as the
 * strategy says) and tells the windows that show the note as a web app to reload. */
export default function NoteEditPage({
  tab,
  sourceId,
  folder,
  onPlace,
}: {
  tab: Tab | null
  sourceId: string
  folder: string
  onPlace: (place: Place) => void
}) {
  const { ready, sourceOf } = useNotesSources()
  const source = useMemo(() => sourceOf(sourceId), [sourceOf, sourceId])
  const { settings: notesSettings } = useNotesSettings()
  const [note, setNote] = useState<NoteRef | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [saved, setSaved] = useState('')
  const [version, setVersion] = useState<FileVersion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const draftTimer = useRef<number | undefined>(undefined)
  const dirty = loaded && text !== saved
  const editorRef = useRef<CodeEditorHandle>(null)
  const [inserting, setInserting] = useState(false)
  const [pathChoice, setPathChoice] = useState<{ relative: string; absolute: string } | null>(null)
  // This page's own header doubles as an autohiding header (`useScrollAutohide` — see CLAUDE.md's "Top bar
  // autohide and nested scrollable content"), and follows the same "show it" trigger as Notes' own top bar, so
  // the admin-app's "show top bar" reveals both together.
  const [headerHidden, showHeader] = useScrollAutohide()
  useEffect(() => {
    const stop = onShowTopBar(showHeader)
    return () => {
      stop.then((unlisten) => unlisten())
    }
  }, [showHeader])

  const draftKey = (markdown: string) => `${sourceId}|${markdown}`

  async function writeDraft(markdown: string, value: string | null) {
    const drafts = (await getAppState<Record<string, string>>(DRAFTS_KEY).catch(() => undefined)) ?? {}
    if (value === null) delete drafts[draftKey(markdown)]
    else drafts[draftKey(markdown)] = value
    await setAppState(DRAFTS_KEY, drafts).catch(() => {})
  }

  const load = useCallback(async () => {
    if (!source) return
    setError(null)
    try {
      const here = await readNote(source, folder)
      const markdown = await findMarkdown(source, folder)
      if (!here || !markdown) throw new Error('That folder is not a note (it has no [note].json and markdown file).')
      const content = new TextDecoder().decode(await source.read(markdown))
      const drafts = (await getAppState<Record<string, string>>(DRAFTS_KEY).catch(() => undefined)) ?? {}
      const draft = drafts[`${sourceId}|${markdown}`]
      setNote(here)
      setPath(markdown)
      setSaved(content)
      setText(draft !== undefined && draft !== content ? draft : content)
      if (draft !== undefined && draft !== content) setNotice('What you had not saved is back.')
      setVersion((await source.version?.(markdown).catch(() => null)) ?? null)
      setLoaded(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [source, sourceId, folder])

  useEffect(() => {
    if (ready) load()
  }, [ready, load])

  useEffect(() => {
    if (tab && note) reportNotePlace(tab, { view: 'noteEdit', sourceId, folder }, note.title, dirty)
  }, [tab, note, sourceId, folder, dirty])

  // The unsaved text is written a moment after the last key.
  useEffect(() => {
    if (!loaded || !path) return
    window.clearTimeout(draftTimer.current)
    draftTimer.current = window.setTimeout(() => writeDraft(path, text === saved ? null : text), 600)
    return () => window.clearTimeout(draftTimer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, saved, loaded, path])

  async function save(): Promise<boolean> {
    if (!source || !path || !note) return false
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      if (source.checkVersion && version) {
        const check = await source.checkVersion(path, version)
        if (!check.upToDate && !(await confirm(`${check.problem ?? 'Filen has another version of this note'}. Save over it?`))) return false
      }
      await source.write(path, new TextEncoder().encode(text))
      let current = note
      let currentPath = path
      // The title follows the first heading: the folder and the file names, and both JSON files, are made to match.
      const heading = titleFromMarkdown(text)
      if (heading && heading !== note.title) {
        current = await renameNote(source, note, heading)
        currentPath = (await findMarkdown(source, folder)) ?? path
        setNotice(`The note is now called "${heading}".`)
      } else {
        await touchNote(source, note)
      }
      setNote(current)
      setPath(currentPath)
      setSaved(text)
      setVersion((await source.version?.(currentPath).catch(() => null)) ?? null)
      await writeDraft(path, null)
      if (currentPath !== path) await writeDraft(currentPath, null)
      // Autosync (on by default): the tab that follows this editor reloads. Off, saving leaves it as it is — the
      // editor's own "Refresh the web app" button (below) still works regardless of this setting.
      if (notesSettings.autosync) await source.notifySaved?.(currentPath)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setSaving(false)
    }
  }

  // Leaving the page any other way (another tab of the window is shown, the window closes): the text is kept as a draft.
  useEffect(() => {
    function flush() {
      if (dirty && path) writeDraft(path, text)
    }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, path, text])

  // Ctrl+S saves.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (dirty) save()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  /** The note as a web app in a window of its own — the tab there follows this editor (it reloads when the note is saved), which
   * is why it is not a tab of this window: showing it here would take the editor away. */
  async function openAsWebApp() {
    if (!source?.fileRef || !path) return
    try {
      // What is shown is what is saved: unsaved changes are saved first (asking what the person wants when it can't be done).
      if (dirty && !(await save())) return
      await openNoteTab(source.fileRef(path), true, true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** Mirror-scroll (off by default): the editor's own topmost visible line, forwarded to the syncing web app —
   * a no-op on the backend when none is open, so this doesn't need to track that itself. */
  function visibleLineChanged(line: number) {
    if (!notesSettings.syncScrollMirror || !source?.fileRef || !path) return
    syncScrollToLine(source.fileRef(path), line).catch(() => {})
  }

  /** Ctrl+Alt+arrows/PageUp/PageDown in the editor: a discrete nudge of the syncing web app's scroll,
   * independent of mirror-scroll. */
  function scrollNudged(direction: 'up' | 'down' | 'pageUp' | 'pageDown') {
    if (!notesSettings.syncScrollKeyboard || !source?.fileRef || !path) return
    syncScrollNudge(source.fileRef(path), direction).catch(() => {})
  }

  /** The editor's own "Refresh the web app" button: unlike the automatic reload on save (autosync, above), this
   * is a deliberate "start over" that does not try to keep or restore the web app's scroll position. */
  async function refreshWebApp() {
    if (!source?.fileRef || !path) return
    try {
      const told = await syncRefreshWithoutScroll(source.fileRef(path))
      setNotice(told === 0 ? 'This note has no open web app to refresh.' : null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function leave(place: Place) {
    if (dirty && path) {
      await writeDraft(path, text) // kept: it comes back with the page
    }
    onPlace(place)
  }

  // "Open link" in the editor: a web address is asked about (as an external web site of this window); a path is opened
  // as a web app when it is a page, and shown in the File Manager otherwise.
  async function openLink(link: LinkHit) {
    if (link.kind === 'web') {
      await openExternalSite(link.target)
      return
    }
    const target = resolveLinkedPath(path ?? '', link.target)
    if (!target || !source) throw new Error('That path leaves the notebook.')
    if (/\.(html?|md|markdown)$/i.test(target.path) && source.openAsWebApp) {
      await source.openAsWebApp(target.path)
      return
    }
    await leave({ view: 'files', location: { sourceId, branch: null, path: target.path } })
  }

  /** "Insert a path…" picked one: works out both the relative form (from this note's own folder) and the
   * absolute one (from the notebook's root — this note is always inside one, being a note — see
   * `lib/relativePath.ts`), then asks which to insert. */
  async function pathPicked(target: string) {
    setInserting(false)
    const notebook = notebookContaining(await loadNotebooks(), sourceId, folder)
    setPathChoice({ relative: relativePathFrom(folder, target), absolute: absolutePathFrom(target, notebook?.folder ?? null) })
  }

  if (!ready) return null
  return (
    <div className="app-shell">
      <main className="tab-content">
        <div className="tab-panel note-edit-page">
          <div className={`notes-page-header editor-top-bar ${headerHidden ? 'editor-top-bar-hidden' : ''}`} data-primary-actions>
            <IconButton icon={ArrowLeft} label="Back to the notes" onClick={() => leave({ view: 'notes', sourceId, folder: parentOf(folder) })} />
            <h2>{note?.title ?? 'Note'}</h2>
            {dirty && <span className="muted">unsaved changes</span>}
            <CacheMenu source={source} path={path ?? folder} isDirectory={false} editing={dirty ? 'dirty' : 'open'} onDone={(kind) => (kind === 'soft' ? load() : undefined)} onError={setError} onNotice={setNotice} />
            <IconButton icon={Save} label="Save (Ctrl+S)" onClick={() => save()} disabled={!dirty || saving} />
            <IconButton icon={AppWindow} label="Open it as a web app in a window of its own — it follows this editor" onClick={openAsWebApp} disabled={!path} />
            <IconButton icon={RefreshCw} label="Refresh the web app — starts it over, without keeping its scroll position" onClick={refreshWebApp} disabled={!path} />
            <IconButton icon={Paperclip} label="Its files" onClick={() => leave({ view: 'noteFiles', sourceId, folder, path: '' })} />
            <IconButton icon={Link2} label="Insert a path…" onClick={() => setInserting(true)} disabled={!path} />
            <UserActionButton sourceId={sourceId} folder={folder} />
          </div>
          {error && <div className="error-banner">{error}</div>}
          {notice && <div className="status-banner">{notice}</div>}
          {loaded && path ? (
            <CodeEditor
              ref={editorRef}
              value={text}
              fileName={path}
              onChange={setText}
              onOpenLink={openLink}
              onVisibleLineChange={visibleLineChanged}
              onScrollNudge={scrollNudged}
            />
          ) : (
            !error && <div className="muted">Loading…</div>
          )}
        </div>
      </main>
      {inserting && source && path && (
        <InsertPathModal source={source} sourceId={sourceId} initialPath={parentOf(path)} onPick={pathPicked} onClose={() => setInserting(false)} />
      )}
      {pathChoice && (
        <PathStyleModal
          relative={pathChoice.relative}
          absolute={pathChoice.absolute}
          onPick={(inserted) => {
            editorRef.current?.insertAtCursor(inserted)
            setPathChoice(null)
          }}
          onClose={() => setPathChoice(null)}
        />
      )}
    </div>
  )
}
