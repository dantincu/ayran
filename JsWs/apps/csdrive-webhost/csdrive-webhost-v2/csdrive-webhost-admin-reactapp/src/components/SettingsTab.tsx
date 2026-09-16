import { useCallback, useEffect, useState } from 'react'
import { confirm } from '@tauri-apps/plugin-dialog'
import { FolderOpen, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import IconButton from './IconButton'
import {
  clearCustomDataFolderContents,
  deleteAppData,
  getDataFolderInfo,
  pickAndSetCustomDataFolder,
  resetDataFolderToDefault,
  type DataFolderInfo,
} from '../lib/dataFolder'

export default function SettingsTab() {
  const [info, setInfo] = useState<DataFolderInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [changed, setChanged] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setInfo(await getDataFolderInfo())
    } catch (e) {
      setError(String(e))
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

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
      <div className="toolbar">
        <strong>Data folder</strong>
        <div className="toolbar-actions">
          <IconButton icon={RefreshCw} label="Refresh" onClick={refresh} />
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <p className="muted">
        This is where the <code>user</code> folder, the <code>data.db</code> database, and any
        stored Filen.io session tokens live. Moving it does not move any existing files or
        folders — it only changes where the app looks next time it starts.
      </p>

      {info && (
        <div className="new-db-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <div>
            <div className="muted">Default location</div>
            <div className="path">{info.defaultPath}</div>
          </div>
          <div>
            <div className="muted">Custom location {info.customPath ? '(active)' : '(not set)'}</div>
            <div className="path">{info.customPath ?? '—'}</div>
          </div>
          <div>
            <div className="muted">Currently in use</div>
            <div className="path">{info.effectivePath}</div>
          </div>
        </div>
      )}

      <div className="toolbar-actions" style={{ marginTop: 16 }}>
        <IconButton icon={FolderOpen} label="Change data folder…" onClick={changeFolder} disabled={busy} />
        <IconButton
          icon={RotateCcw}
          label="Reset to default"
          onClick={resetFolder}
          disabled={busy || !info?.customPath}
        />
      </div>

      {changed && (
        <div className="error-banner" style={{ marginTop: 12 }}>
          Restart the app for this change to take effect.
        </div>
      )}

      <div className="toolbar" style={{ marginTop: 24 }}>
        <strong>Danger zone</strong>
      </div>
      <p className="muted">
        These delete files immediately and cannot be undone. Before deleting, the app closes
        every open secondary window, any open SQLite connections, and its own browser
        storage, then closes its database connection — and restarts itself automatically
        once the deletion finishes.
      </p>
      <div className="toolbar-actions">
        <IconButton
          icon={Trash2}
          label="Delete custom folder contents"
          variant="danger"
          onClick={clearCustomFolder}
          disabled={busy || !info?.customPath}
        />
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
