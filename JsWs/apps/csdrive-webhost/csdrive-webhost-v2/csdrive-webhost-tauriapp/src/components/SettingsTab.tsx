import { useCallback, useEffect, useState } from 'react'
import { confirm } from '@tauri-apps/plugin-dialog'
import { ClipboardList, Eraser, FolderOpen, PanelTop, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import IconButton from './IconButton'
import AppearanceSettings from './AppearanceSettings'
import ClipboardManagerModal from './ClipboardManagerModal'
import { internalClipboard } from '../lib/clipboard'
import { invoke } from '@tauri-apps/api/core'
import {
  clearCustomDataFolderContents,
  deleteAppData,
  getDataFolderInfo,
  pickAndSetCustomDataFolder,
  resetDataFolderToDefault,
  type DataFolderInfo,
} from '../lib/dataFolder'
import { setRowActionsCompact, subscribeRowActionsCompact } from '../lib/rowActionsCompact'
import { setEditorSetting, subscribeEditorSettings, type EditorSettings } from '../lib/editorSettings'
import { showTopBar } from '../lib/secondaryWindows'
import { useDevToolsEnabled } from '../lib/devTools'

export default function SettingsTab() {
  const { enabled: devToolsEnabled, setEnabled: setDevToolsEnabled } = useDevToolsEnabled()
  const [info, setInfo] = useState<DataFolderInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [changed, setChanged] = useState(false)
  // What the app's own clipboard holds (`null`: not read yet) and whether the manage popup is open.
  const [clipboardEntries, setClipboardEntries] = useState<string[] | null>(null)
  const [managingClipboard, setManagingClipboard] = useState(false)
  // Whether every list's row of icon buttons collapses into a single "more actions" menu (`rowActionsCompact.ts`).
  const [rowActionsCompact, setRowActionsCompactState] = useState(false)
  useEffect(() => subscribeRowActionsCompact(setRowActionsCompactState), [])
  // The text editors' shared settings (`editorSettings.ts`): wrapping, whitespace, line numbers, the Tab key.
  const [editorSettings, setEditorSettingsState] = useState<EditorSettings | null>(null)
  useEffect(() => subscribeEditorSettings(setEditorSettingsState), [])
  const [tabSpaceCountText, setTabSpaceCountText] = useState('')
  useEffect(() => {
    if (editorSettings) setTabSpaceCountText(String(editorSettings.tabSpaceCount))
  }, [editorSettings?.tabSpaceCount])
  function setEditorFlag<K extends 'wrapLines' | 'showWhitespace' | 'lineNumbers' | 'tabInsertsSpaces'>(key: K, value: boolean) {
    setEditorSetting(key, value).catch((e) => setError(String(e)))
  }
  function commitTabSpaceCount() {
    const n = Number(tabSpaceCountText)
    if (!Number.isInteger(n) || n < 1 || n > 16) {
      setTabSpaceCountText(String(editorSettings?.tabSpaceCount ?? 4))
      return
    }
    setEditorSetting('tabSpaceCount', n).catch((e) => setError(String(e)))
  }
  // The global top-bar settings (`topBar.*` in `global_settings`; the backend reads the same keys when it
  // renders a tab's `topBarHtml` and decides whether it starts hidden — `top_bar.rs`). `autohide` defaults to
  // on, the other two to off, matching the backend's own defaults when a key was never set.
  const [topBarAutohide, setTopBarAutohideState] = useState(true)
  const [topBarHideLabels, setTopBarHideLabelsState] = useState(false)
  const [topBarHideRoot, setTopBarHideRootState] = useState(false)
  useEffect(() => {
    invoke<string | null>('get_global_setting', { key: 'topBar.autohide' }).then((v) => setTopBarAutohideState(v !== '0'))
    invoke<string | null>('get_global_setting', { key: 'topBar.hideLabels' }).then((v) => setTopBarHideLabelsState(v === '1'))
    invoke<string | null>('get_global_setting', { key: 'topBar.hideRoot' }).then((v) => setTopBarHideRootState(v === '1'))
  }, [])
  function setTopBarSetting(key: string, value: boolean, apply: (v: boolean) => void) {
    apply(value)
    invoke('set_global_setting', { key, value: value ? '1' : '0' }).catch((e) => setError(String(e)))
  }
  // The ayran-tag markup transform's configuration (`ayran_tags.rs`): the three configurable names. An
  // empty tag name disables the whole feature. Committed on blur, the same as the tab space-count field
  // above — not per keystroke, since every change re-parses and re-serializes nothing until it's saved.
  const [ayranTagName, setAyranTagNameText] = useState('')
  const [ayranIdAttr, setAyranIdAttrText] = useState('')
  const [ayranSelectorAttr, setAyranSelectorAttrText] = useState('')
  useEffect(() => {
    invoke<{ tagName: string; idAttr: string; selectorAttr: string }>('get_ayran_tag_config').then((c) => {
      setAyranTagNameText(c.tagName)
      setAyranIdAttrText(c.idAttr)
      setAyranSelectorAttrText(c.selectorAttr)
    })
  }, [])
  function commitAyranConfig() {
    invoke('set_ayran_tag_config', { config: { tagName: ayranTagName, idAttr: ayranIdAttr, selectorAttr: ayranSelectorAttr } }).catch((e) =>
      setError(String(e)),
    )
  }
  // Whether prompts are prevented, and how many windows are open of how many are allowed (`prompt_guard.rs`).
  const [guard, setGuard] = useState<{ promptsPrevented: boolean; openWindows: number; maxWindows: number } | null>(null)
  const readGuard = useCallback(() => {
    invoke<{ promptsPrevented: boolean; openWindows: number; maxWindows: number }>('prompt_guard_status').then(setGuard, () => setGuard(null))
  }, [])

  const readClipboard = useCallback(async () => {
    try {
      setClipboardEntries(await internalClipboard.list())
    } catch (e) {
      setError(String(e))
    }
  }, [])

  async function clearClipboard() {
    setError(null)
    try {
      await internalClipboard.clear()
      await readClipboard()
    } catch (e) {
      setError(String(e))
    }
  }

  const refresh = useCallback(async () => {
    try {
      setInfo(await getDataFolderInfo())
    } catch (e) {
      setError(String(e))
    }
  }, [])

  useEffect(() => {
    refresh()
    readClipboard()
    readGuard()
  }, [refresh, readClipboard, readGuard])

  async function changeFolder() {
    setError(null)
    setBusy(true)
    try {
      const picked = await pickAndSetCustomDataFolder()
      if (picked !== null) {
        setChanged(true)
        await refresh()
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function resetFolder() {
    setError(null)
    setBusy(true)
    try {
      await resetDataFolderToDefault()
      setChanged(true)
      await refresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function clearCustomFolder() {
    if (!info?.customPath) return
    if (
      !(await confirm(
        `Permanently delete everything inside the custom data folder?\n\n${info.customPath}\n\nThe folder itself is kept, but its contents cannot be recovered.`,
      ))
    ) {
      return
    }
    setError(null)
    setBusy(true)
    try {
      await clearCustomDataFolderContents()
      setChanged(true)
      await refresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function showAllTopBars() {
    setError(null)
    try {
      await showTopBar()
    } catch (e) {
      setError(String(e))
    }
  }

  async function wipeAppData() {
    if (!info) return
    if (
      !(await confirm(
        `Permanently delete all app data in the default folder?\n\n${info.defaultPath}\n\nThis removes the user folder, data.db, and the saved custom-folder location — just like clearing app data from the OS settings. Your custom data folder (if any) is not touched. This cannot be undone.`,
      ))
    ) {
      return
    }
    setError(null)
    setBusy(true)
    try {
      await deleteAppData()
      setChanged(true)
      await refresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="tab-panel">
      <AppearanceSettings />

      <div className="toolbar">
        <strong>Lists</strong>
      </div>
      <p className="muted">
        Every list in the app — Files, Filen.io, the System/User Apps tabs, Storage, Notes — shows each record's own
        row of icon buttons (edit, delete, details, …) inline. Turning this on collapses them all into a single{' '}
        <strong>⋯</strong> button per row instead, everywhere at once.
      </p>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={rowActionsCompact}
          onChange={(e) => setRowActionsCompact(e.target.checked).catch((err) => setError(String(err)))}
        />
        Compact row actions
      </label>

      <div className="toolbar" style={{ marginTop: 24 }}>
        <strong>Text editors</strong>
      </div>
      <p className="muted">
        Every text editor in the app — the Files tab's and Notes' alike — shares these settings.
      </p>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={editorSettings?.wrapLines ?? true}
          onChange={(e) => setEditorFlag('wrapLines', e.target.checked)}
        />
        Wrap long lines
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={editorSettings?.lineNumbers ?? true}
          onChange={(e) => setEditorFlag('lineNumbers', e.target.checked)}
        />
        Show line numbers
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={editorSettings?.showWhitespace ?? false}
          onChange={(e) => setEditorFlag('showWhitespace', e.target.checked)}
        />
        Show whitespace (spaces, tabs and non-breaking spaces)
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={editorSettings?.tabInsertsSpaces ?? false}
          onChange={(e) => setEditorFlag('tabInsertsSpaces', e.target.checked)}
        />
        The Tab key inserts{' '}
        <input
          type="number"
          min={1}
          max={16}
          step={1}
          style={{ width: '3.5em' }}
          disabled={!editorSettings?.tabInsertsSpaces}
          value={tabSpaceCountText}
          onChange={(e) => setTabSpaceCountText(e.target.value)}
          onBlur={commitTabSpaceCount}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />{' '}
        spaces instead of a tab character
      </label>

      <div className="toolbar" style={{ marginTop: 24 }}>
        <strong>Top bar</strong>
      </div>
      <p className="muted">
        Notes' pages, and any web app that has drawn a header of its own the same way, can hide their own top bar —
        this shows it again everywhere it was hidden, in one click, without having to find each tab in the System/User
        Apps tabs, and overrides a bar the person closed or that started hidden by the autohide setting below (until
        it's closed again).
      </p>
      <div className="toolbar-actions" data-primary-actions>
        <IconButton icon={PanelTop} label="Show the top bar for every open window" onClick={showAllTopBars} />
      </div>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={topBarAutohide}
          onChange={(e) => setTopBarSetting('topBar.autohide', e.target.checked, setTopBarAutohideState)}
        />
        Hide the top bar by default (on by default) — the person can still show it, and closing it after that is remembered
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={topBarHideLabels}
          onChange={(e) => setTopBarSetting('topBar.hideLabels', e.target.checked, setTopBarHideLabelsState)}
        />
        Hide the tab's labels (tags) in the top bar
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={topBarHideRoot}
          onChange={(e) => setTopBarSetting('topBar.hideRoot', e.target.checked, setTopBarHideRootState)}
        />
        Hide the tab's root in the top bar
      </label>

      <div className="toolbar" style={{ marginTop: 24 }}>
        <strong>Markdown: the ayran tag</strong>
      </div>
      <p className="muted">
        A configurable html element a markdown file's own source can use to insert a real html element of
        its own choosing into the rendered page: two matching tags — the same id, siblings in the rendered
        markup — collapse into one new element (its tag name, id and class parsed from a tiny
        <code> tag#id.class</code> selector) holding whatever was between them. See the Help tab for the
        full rule. <strong>Leave the tag name blank to turn the whole feature off.</strong>
      </p>
      <label className="checkbox-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
        Tag name (blank disables the feature)
        <input
          type="text"
          value={ayranTagName}
          onChange={(e) => setAyranTagNameText(e.target.value)}
          onBlur={commitAyranConfig}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          style={{ width: '10em' }}
        />
      </label>
      <label className="checkbox-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
        Internal id attribute — matches a tag to its partner
        <input
          type="text"
          value={ayranIdAttr}
          onChange={(e) => setAyranIdAttrText(e.target.value)}
          onBlur={commitAyranConfig}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          style={{ width: '10em' }}
        />
      </label>
      <label className="checkbox-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
        CSS-selector attribute — the new element's tag, id and class
        <input
          type="text"
          value={ayranSelectorAttr}
          onChange={(e) => setAyranSelectorAttrText(e.target.value)}
          onBlur={commitAyranConfig}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          style={{ width: '10em' }}
        />
      </label>

      <div className="toolbar" style={{ marginTop: 24 }}>
        <strong>Data folder</strong>
        <div className="toolbar-actions">
          <IconButton icon={RefreshCw} label="Refresh" onClick={refresh} />
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <p className="muted">
        This is where the <code>user</code> folder, the <code>data.db</code> database, and any
        stored Filen.io session tokens live.
        {info?.canRelocate &&
          ' Moving it does not move any existing files or folders — it only changes where the app looks next time it starts.'}
      </p>

      {info && (
        <div className="new-db-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <div>
            <div className="muted">Default location</div>
            <div className="path">{info.defaultPath}</div>
          </div>
          {info.canRelocate && (
            <div>
              <div className="muted">Custom location {info.customPath ? '(active)' : '(not set)'}</div>
              <div className="path">{info.customPath ?? '—'}</div>
            </div>
          )}
          <div>
            <div className="muted">Currently in use</div>
            <div className="path">{info.effectivePath}</div>
          </div>
        </div>
      )}

      {info?.canRelocate && (
        <div className="toolbar-actions" style={{ marginTop: 16 }}>
          <IconButton icon={FolderOpen} label="Change data folder…" onClick={changeFolder} disabled={busy} />
          <IconButton
            icon={RotateCcw}
            label="Reset to default"
            onClick={resetFolder}
            disabled={busy || !info?.customPath}
          />
        </div>
      )}

      {changed && (
        <div className="error-banner" style={{ marginTop: 12 }}>
          Restart the app for this change to take effect.
        </div>
      )}

      <div className="toolbar" style={{ marginTop: 24 }}>
        <strong>The app's clipboard</strong>
        <div className="toolbar-actions">
          <IconButton icon={RefreshCw} label="Read it again" onClick={readClipboard} />
        </div>
      </div>
      <p className="muted">
        A stack of text that every window of the app — the admin-app, Notes and web apps — can copy to and paste from. It is
        kept in memory only and is gone when the app closes; the system's clipboard is not touched.
      </p>
      <div className="toolbar-actions">
        <span className="muted">
          {clipboardEntries === null
            ? 'Reading…'
            : clipboardEntries.length === 0
              ? 'It is empty.'
              : `It holds ${clipboardEntries.length.toLocaleString()} entr${clipboardEntries.length === 1 ? 'y' : 'ies'}.`}
        </span>
        <IconButton icon={ClipboardList} label="Manage the app's clipboard…" onClick={() => setManagingClipboard(true)} />
        <IconButton icon={Eraser} label="Clear the app's clipboard" onClick={clearClipboard} disabled={!clipboardEntries || clipboardEntries.length === 0} />
      </div>
      {managingClipboard && (
        <ClipboardManagerModal
          onClose={() => {
            setManagingClipboard(false)
            void readClipboard()
          }}
        />
      )}

      <div className="toolbar" style={{ marginTop: 24 }}>
        <strong>Prompts and windows</strong>
        <div className="toolbar-actions">
          <IconButton icon={RefreshCw} label="Read them again" onClick={readGuard} />
        </div>
      </div>
      <p className="muted">
        Every question the app asks you — a link, a file to save, a web site to open — is one box at a time. Each has a button, <em>Prevent this
        app from showing prompts</em>, that stops all of them until the app is <strong>restarted</strong> (nothing is remembered: they are allowed
        again after a restart). At most {guard?.maxWindows ?? 10} windows are open at once; close or suspend one to open another.
      </p>
      <div className="toolbar-actions">
        <span className={guard?.promptsPrevented ? 'error-banner' : 'muted'}>
          {guard === null ? 'Reading…' : guard.promptsPrevented ? 'Prompts are prevented until the app is restarted.' : 'Prompts are allowed.'}
        </span>
        {guard && (
          <span className="muted">
            {guard.openWindows} of {guard.maxWindows} windows open.
          </span>
        )}
      </div>

      <div className="toolbar" style={{ marginTop: 24 }}>
        <strong>Danger zone</strong>
      </div>
      <p className="muted">
        These delete files immediately and cannot be undone. Before deleting, the app closes
        every open secondary window, any open SQLite connections, and its own browser
        storage, then closes its database connection — and restarts itself once the deletion
        finishes{info && !info.canRestart ? ' (on this device it just closes — open it again)' : ''}.
      </p>
      <div className="toolbar-actions">
        {info?.canRelocate && (
          <IconButton
            icon={Trash2}
            label="Delete custom folder contents"
            variant="danger"
            onClick={clearCustomFolder}
            disabled={busy || !info?.customPath}
          />
        )}
        <IconButton
          icon={Trash2}
          label="Delete app data"
          variant="danger"
          onClick={wipeAppData}
          disabled={busy || !info}
        />
      </div>

      <details className="settings-advanced" style={{ marginTop: 24 }}>
        <summary>
          <strong>Advanced</strong>
        </summary>
        <label className="checkbox-row">
          <input type="checkbox" checked={devToolsEnabled} onChange={(e) => setDevToolsEnabled(e.target.checked)} />
          Show the Dev Tools tab
        </label>
        <p className="muted">Adds a tab, just before Help, with a Logs page: the app's own log level, its log file's location and recent content.</p>
      </details>
    </div>
  )
}
