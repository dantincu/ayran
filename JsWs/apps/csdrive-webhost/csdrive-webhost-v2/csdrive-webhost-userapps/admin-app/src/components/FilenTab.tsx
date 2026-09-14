import { useCallback, useEffect, useState } from 'react'
import { Buffer } from 'buffer'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { readFile as readAbsoluteFile, writeFile as writeAbsoluteFile } from '@tauri-apps/plugin-fs'
import { Cloud, Download, File, Folder, FolderPlus, LogOut, Pencil, RefreshCw, Save, Trash2, Upload, UserPlus, X } from 'lucide-react'
import IconButton from './IconButton'
import {
  addAccount,
  type FilenAccountMeta,
  getSdkForAccount,
  listAccounts,
  removeAccount,
  setActiveAccount,
} from '../lib/filenAccounts'
import { writeUserFile } from '../lib/localFs'
import type FilenSDK from '@filen/sdk'

interface RemoteEntry {
  name: string
  isDirectory: boolean
  size?: number
}

function joinFilenPath(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base}/${name}`
}

export default function FilenTab() {
  const [accounts, setAccounts] = useState<FilenAccountMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [sdk, setSdk] = useState<FilenSDK | null>(null)
  const [needsReconnect, setNeedsReconnect] = useState(false)

  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [showAddForm, setShowAddForm] = useState(false)
  const [form, setForm] = useState({ email: '', password: '', twoFactorCode: '' })
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const loadAccounts = useCallback(async () => {
    const index = await listAccounts()
    setAccounts(index.accounts)
    setActiveId(index.activeId)
  }, [])

  useEffect(() => {
    loadAccounts()
  }, [loadAccounts])

  const refreshDir = useCallback(
    async (activeSdk: FilenSDK, dirPath: string) => {
      setLoading(true)
      setError(null)
      try {
        const names = await activeSdk.fs().readdir({ path: dirPath })
        const withStats = await Promise.all(
          names.map(async (name) => {
            const full = joinFilenPath(dirPath, name)
            try {
              const info = await activeSdk.fs().stat({ path: full })
              return { name, isDirectory: info.isDirectory(), size: info.isFile() ? info.size : undefined }
            } catch {
              return { name, isDirectory: false }
            }
          }),
        )
        withStats.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        setEntries(withStats)
      } catch (e) {
        setError(String(e))
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (!activeId) {
      setSdk(null)
      setEntries([])
      return
    }
    let cancelled = false
    setNeedsReconnect(false)
    getSdkForAccount(activeId)
      .then((activeSdk) => {
        if (cancelled) return
        setSdk(activeSdk)
        setPath('/')
        refreshDir(activeSdk, '/')
      })
      .catch(() => {
        if (!cancelled) setNeedsReconnect(true)
      })
    return () => {
      cancelled = true
    }
  }, [activeId, refreshDir])

  async function handleSwitch(id: string) {
    await setActiveAccount(id)
    setActiveId(id)
  }

  async function handleRemove() {
    if (!activeId) return
    if (!window.confirm(`Disconnect account "${activeId}"? You can reconnect it later.`)) return
    await removeAccount(activeId)
    await loadAccounts()
  }

  async function handleAddSubmit(e: React.FormEvent) {
    e.preventDefault()
    setAddBusy(true)
    setAddError(null)
    try {
      const id = await addAccount(form)
      setForm({ email: '', password: '', twoFactorCode: '' })
      setShowAddForm(false)
      await loadAccounts()
      setActiveId(id)
    } catch (e) {
      setAddError(String(e))
    } finally {
      setAddBusy(false)
    }
  }

  function openEntry(entry: RemoteEntry) {
    if (entry.isDirectory) setPath(joinFilenPath(path, entry.name))
  }

  async function createFolder() {
    if (!sdk) return
    const name = window.prompt('New folder name:')
    if (!name) return
    try {
      await sdk.fs().mkdir({ path: joinFilenPath(path, name) })
      await refreshDir(sdk, path)
    } catch (e) {
      setError(String(e))
    }
  }

  async function deleteEntry(entry: RemoteEntry) {
    if (!sdk) return
    if (!window.confirm(`Move "${entry.name}" to Filen trash?`)) return
    try {
      await sdk.fs().rm({ path: joinFilenPath(path, entry.name) })
      await refreshDir(sdk, path)
    } catch (e) {
      setError(String(e))
    }
  }

  async function renameEntry(entry: RemoteEntry) {
    if (!sdk) return
    const newName = window.prompt('New name:', entry.name)
    if (!newName || newName === entry.name) return
    try {
      await sdk.fs().rename({ from: joinFilenPath(path, entry.name), to: joinFilenPath(path, newName) })
      await refreshDir(sdk, path)
    } catch (e) {
      setError(String(e))
    }
  }

  async function uploadFromComputer() {
    if (!sdk) return
    try {
      const selected = await openDialog({ multiple: true })
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : []
      for (const absPath of paths) {
        const name = absPath.split(/[\\/]/).pop() ?? 'file'
        const data = await readAbsoluteFile(absPath)
        await sdk.fs().writeFile({ path: joinFilenPath(path, name), content: Buffer.from(data) })
      }
      if (paths.length) await refreshDir(sdk, path)
    } catch (e) {
      setError(String(e))
    }
  }

  async function downloadToComputer(entry: RemoteEntry) {
    if (!sdk) return
    try {
      const dest = await saveDialog({ defaultPath: entry.name })
      if (!dest) return
      const buf = await sdk.fs().readFile({ path: joinFilenPath(path, entry.name) })
      await writeAbsoluteFile(dest, new Uint8Array(buf))
    } catch (e) {
      setError(String(e))
    }
  }

  async function saveToUserFolder(entry: RemoteEntry) {
    if (!sdk) return
    try {
      const buf = await sdk.fs().readFile({ path: joinFilenPath(path, entry.name) })
      await writeUserFile(entry.name, new Uint8Array(buf))
      window.alert(`Saved "${entry.name}" to your local user folder.`)
    } catch (e) {
      setError(String(e))
    }
  }

  const breadcrumbs = path === '/' ? [''] : ['', ...path.split('/').filter(Boolean)]

  return (
    <div className="tab-panel">
      <div className="toolbar">
        <div className="filen-account-bar">
          {accounts.length > 0 && (
            <select value={activeId ?? ''} onChange={(e) => handleSwitch(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </select>
          )}
          {activeId && <IconButton icon={LogOut} label="Disconnect" onClick={handleRemove} />}
          <IconButton
            icon={showAddForm ? X : UserPlus}
            label={showAddForm ? 'Cancel' : 'Add account'}
            onClick={() => setShowAddForm((v) => !v)}
          />
        </div>
      </div>

      {showAddForm && (
        <form className="add-account-form" onSubmit={handleAddSubmit}>
          <input
            type="email"
            placeholder="Email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <input
            type="password"
            placeholder="Password"
            required
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <input
            placeholder="2FA code (if enabled)"
            value={form.twoFactorCode}
            onChange={(e) => setForm({ ...form, twoFactorCode: e.target.value })}
          />
          <button type="submit" disabled={addBusy}>
            {addBusy ? 'Connecting…' : 'Connect'}
          </button>
          {addError && <div className="error-banner">{addError}</div>}
        </form>
      )}

      {!activeId && !showAddForm && (
        <div className="muted">No Filen account connected yet. Click "Add account" to connect one.</div>
      )}

      {needsReconnect && (
        <div className="error-banner">
          Could not restore the saved session for "{activeId}". Please remove and reconnect it.
        </div>
      )}

      {sdk && (
        <>
          <div className="toolbar">
            <div className="breadcrumbs">
              {breadcrumbs.map((seg, i) => {
                const target = '/' + breadcrumbs.slice(1, i + 1).join('/')
                return (
                  <span key={i}>
                    {i > 0 && <span className="crumb-sep">/</span>}
                    <button className="link-button" onClick={() => setPath(target)}>
                      {i === 0 ? (
                        <>
                          <Cloud size={14} strokeWidth={2} aria-hidden="true" /> root
                        </>
                      ) : (
                        seg
                      )}
                    </button>
                  </span>
                )
              })}
            </div>
            <div className="toolbar-actions">
              <IconButton icon={FolderPlus} label="New folder" onClick={createFolder} />
              <IconButton icon={Upload} label="Upload from computer…" onClick={uploadFromComputer} />
              <IconButton icon={RefreshCw} label="Refresh" onClick={() => refreshDir(sdk, path)} />
            </div>
          </div>

          {error && <div className="error-banner">{error}</div>}
          {loading && <div className="muted">Loading…</div>}

          {!loading && (
            <table className="file-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {entries.length === 0 && (
                  <tr>
                    <td colSpan={2} className="muted">
                      This folder is empty.
                    </td>
                  </tr>
                )}
                {entries.map((entry) => (
                  <tr key={entry.name}>
                    <td>
                      <button className="link-button entry-name" onClick={() => openEntry(entry)}>
                        {entry.isDirectory ? (
                          <Folder size={15} strokeWidth={2} aria-hidden="true" />
                        ) : (
                          <File size={15} strokeWidth={2} aria-hidden="true" />
                        )}
                        {entry.name}
                      </button>
                    </td>
                    <td className="row-actions">
                      {!entry.isDirectory && (
                        <>
                          <IconButton icon={Download} label="Export…" onClick={() => downloadToComputer(entry)} />
                          <IconButton icon={Save} label="Save to user folder" onClick={() => saveToUserFolder(entry)} />
                        </>
                      )}
                      <IconButton icon={Pencil} label="Rename" onClick={() => renameEntry(entry)} />
                      <IconButton icon={Trash2} label="Delete" variant="danger" onClick={() => deleteEntry(entry)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}
