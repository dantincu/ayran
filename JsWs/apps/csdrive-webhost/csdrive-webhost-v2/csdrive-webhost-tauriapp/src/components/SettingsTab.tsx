import { useCallback, useEffect, useState } from 'react'
import { confirm } from '@tauri-apps/plugin-dialog'
import { Eye, EyeOff, Eraser, FolderOpen, PanelTop, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import IconButton from './IconButton'
import AppearanceSettings from './AppearanceSettings'
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
import { showTopBar } from '../lib/secondaryWindows'

export default function SettingsTab() {
  const [info, setInfo] = useState<DataFolderInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [changed, setChanged] = useState(false)
  // What the app's own clipboard holds (`null`: not read yet) and whether its text is shown.
  const [clipboardText, setClipboardText] = useState<string | null>(null)
  const [clipboardShown, setClipboardShown] = useState(false)
  // Whether every list's row of icon buttons collapses into a single "more actions" menu (`rowActionsCompact.ts`).
  const [rowActionsCompact, setRowActionsCompactState] = useState(false)
  useEffect(() => subscribeRowActionsCompact(setRowActionsCompactState), [])
  // Whether prompts are prevented, and how many windows are open of how many are allowed (`prompt_guard.rs`).
  const [guard, setGuard] = useState<{ promptsPrevented: boolean; openWindows: number; maxWindows: number } | null>(null)
  const readGuard = useCallback(() => {
    invoke<{ promptsPrevented: boolean; openWindows: number; maxWindows: number }>('prompt_guard_status').then(setGuard, () => setGuard(null))
  }, [])

  const readClipboard = useCallback(async () => {
    try {
      setClipboardText(await internalClipboard.get())
    } catch (e) {
      setError(String(e))
    }
  }, [])

  async function clearClipboard() {
    setError(null)
    try {
      await internalClipboard.clear()
      setClipboardShown(false)
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
        <strong>Top bar</strong>
      </div>
      <p className="muted">
        Notes' pages, and any web app that has drawn a header of its own the same way, can hide their own top bar —
        this shows it again everywhere it was hidden, in one click, without having to find each tab in the System/User
        Apps tabs.
      </p>
      <div className="toolbar-actions">
        <IconButton icon={PanelTop} label="Show the top bar for every open window" onClick={showAllTopBars} />
      </div>

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
        One text that every window of the app — the admin-app, Notes and web apps — can copy to and paste from. It is kept in
        memory only and is gone when the app closes; the system's clipboard is not touched.
      </p>
      <div className="toolbar-actions">
        <span className="muted">
          {clipboardText === null ? 'Reading…' : clipboardText === '' ? 'It is empty.' : `It holds ${clipboardText.length.toLocaleString()} character${clipboardText.length === 1 ? '' : 's'}.`}
        </span>
        {clipboardText !== null && clipboardText !== '' && (
          <IconButton
            icon={clipboardShown ? EyeOff : Eye}
            label={clipboardShown ? 'Hide what it holds' : 'Show what it holds'}
            onClick={() => setClipboardShown((shown) => !shown)}
          />
        )}
        <IconButton icon={Eraser} label="Clear the app's clipboard" onClick={clearClipboard} disabled={!clipboardText} />
      </div>
      {clipboardShown && clipboardText && (
        <pre className="path" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 160, overflow: 'auto' }}>
          {clipboardText.length > 2000 ? `${clipboardText.slice(0, 2000)}…` : clipboardText}
        </pre>
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
    </div>
  )
}
