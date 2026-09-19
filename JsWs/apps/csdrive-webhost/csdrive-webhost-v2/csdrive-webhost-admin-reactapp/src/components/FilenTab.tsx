import { useCallback, useEffect, useState } from 'react'
import { confirm, open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { readFile as readAbsoluteFile, writeFile as writeAbsoluteFile } from '@tauri-apps/plugin-fs'
import { Cloud, Download, File, Folder, FolderPlus, LogOut, Pencil, RefreshCw, Save, Trash2, Upload, UserPlus, X } from 'lucide-react'
import IconButton from './IconButton'
import Pagination from './Pagination'
import { getAppState, setAppState } from '../lib/appState'
import {
  filenMkdir,
  filenReadFile,
  filenReaddir,
  filenRename,
  filenRm,
  filenWriteFile,
  listFilenAccounts,
  loginFilen,
  logoutFilen,
  type FilenAccount,
  type FilenEntry,
} from '../lib/filen'
import { DEFAULT_PAGE_SIZE, getGlobalPageSize, setGlobalPageSize } from '../lib/listPageSize'
import { writeUserFile } from '../lib/localFs'

const ACTIVE_ACCOUNT_KEY = 'filenTab.activeAccount'

function joinFilenPath(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base}/${name}`
}

export default function FilenTab() {
  const [accounts, setAccounts] = useState<FilenAccount[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)

  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<FilenEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [showAddForm, setShowAddForm] = useState(false)
  const [form, setForm] = useState({ email: '', password: '', twoFactorCode: '' })
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const [page, setPage] = useState(0)
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE)

  useEffect(() => {
    getGlobalPageSize().then(setPageSizeState)
  }, [])

  function setPageSize(size: number) {
    setPageSizeState(size)
    setGlobalPageSize(size)
    setPage(0)
  }

  useEffect(() => {
    setPage(0)
  }, [path])

  const loadAccounts = useCallback(async () => {
    const list = await listFilenAccounts()
    setAccounts(list)
    const saved = await getAppState<number>(ACTIVE_ACCOUNT_KEY)
    setActiveId((current) => {
      if (current != null && list.some((a) => a.userId === current)) return current
      return list.find((a) => a.userId === saved)?.userId ?? list[0]?.userId ?? null
    })
  }, [])

  useEffect(() => {
    loadAccounts().catch((e) => setError(String(e)))
  }, [loadAccounts])

  const refreshDir = useCallback(async (userId: number, dirPath: string) => {
    setLoading(true)
    setError(null)
    try {
      setEntries(await filenReaddir(userId, dirPath))
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (activeId == null) {
      setEntries([])
      return
    }
    refreshDir(activeId, path)
  }, [activeId, path, refreshDir])

  function switchAccount(userId: number) {
    setActiveId(userId)
    setPath('/')
    setAppState(ACTIVE_ACCOUNT_KEY, userId)
  }

  async function handleRemove() {
    const account = accounts.find((a) => a.userId === activeId)
    if (!account) return
    if (!(await confirm(`Disconnect account "${account.email}"? You can reconnect it later.`))) return
    try {
      await logoutFilen(account.userId)
      setPath('/')
      await loadAccounts()
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleAddSubmit(e: React.FormEvent) {
    e.preventDefault()
    setAddBusy(true)
    setAddError(null)
    try {
      const account = await loginFilen(form)
      setForm({ email: '', password: '', twoFactorCode: '' })
      setShowAddForm(false)
      await loadAccounts()
      switchAccount(account.userId)
    } catch (e) {
      setAddError(String(e))
    } finally {
      setAddBusy(false)
    }
  }

  // Runs an operation on the active account, then reloads the current folder.
  async function act(operation: (userId: number) => Promise<void>) {
    if (activeId == null) return
    try {
      await operation(activeId)
      await refreshDir(activeId, path)
    } catch (e) {
      setError(String(e))
    }
  }

  function openEntry(entry: FilenEntry) {
    if (entry.isDirectory) setPath(joinFilenPath(path, entry.name))
  }

  async function createFolder() {
    const name = window.prompt('New folder name:')
    if (!name) return
    await act((userId) => filenMkdir(userId, joinFilenPath(path, name)))
  }

  async function deleteEntry(entry: FilenEntry) {
    if (!(await confirm(`Move "${entry.name}" to Filen trash?`))) return
    await act((userId) => filenRm(userId, joinFilenPath(path, entry.name)))
  }

  async function renameEntry(entry: FilenEntry) {
    const newName = window.prompt('New name:', entry.name)
    if (!newName || newName === entry.name) return
    await act((userId) => filenRename(userId, joinFilenPath(path, entry.name), joinFilenPath(path, newName)))
  }

  async function uploadFromComputer() {
    await act(async (userId) => {
      const selected = await openDialog({ multiple: true })
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : []
      for (const absPath of paths) {
        const name = absPath.split(/[\\/]/).pop() ?? 'file'
        await filenWriteFile(userId, joinFilenPath(path, name), await readAbsoluteFile(absPath))
      }
    })
  }

  async function downloadToComputer(entry: FilenEntry) {
    if (activeId == null) return
    try {
      const dest = await saveDialog({ defaultPath: entry.name })
      if (!dest) return
      await writeAbsoluteFile(dest, await filenReadFile(activeId, joinFilenPath(path, entry.name)))
    } catch (e) {
      setError(String(e))
    }
  }

  async function saveToUserFolder(entry: FilenEntry) {
    if (activeId == null) return
    try {
      await writeUserFile(entry.name, await filenReadFile(activeId, joinFilenPath(path, entry.name)))
      window.alert(`Saved "${entry.name}" to your local user folder.`)
    } catch (e) {
      setError(String(e))
    }
  }

  const breadcrumbs = path === '/' ? [''] : ['', ...path.split('/').filter(Boolean)]
  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const pagedEntries = entries.slice(currentPage * pageSize, (currentPage + 1) * pageSize)

  return (
    <div className="tab-panel">
      <div className="toolbar">
        <div className="filen-account-bar">
          {accounts.length > 0 && (
            <select value={activeId ?? ''} onChange={(e) => switchAccount(Number(e.target.value))}>
              {accounts.map((a) => (
                <option key={a.userId} value={a.userId}>
                  {a.email}
                </option>
              ))}
            </select>
          )}
          {activeId != null && <IconButton icon={LogOut} label="Disconnect" onClick={handleRemove} />}
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

      {activeId == null && !showAddForm && (
        <div className="muted">No Filen account connected yet. Click "Add account" to connect one.</div>
      )}

      {activeId != null && (
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
              <IconButton icon={RefreshCw} label="Refresh" onClick={() => refreshDir(activeId, path)} />
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
                {pagedEntries.map((entry) => (
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

          <Pagination
            page={currentPage}
            pageSize={pageSize}
            totalItems={entries.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </>
      )}
    </div>
  )
}
