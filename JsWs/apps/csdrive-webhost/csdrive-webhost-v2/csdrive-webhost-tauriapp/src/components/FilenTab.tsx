import { useCallback, useEffect, useRef, useState } from 'react'
import { confirm } from '@tauri-apps/plugin-dialog'
import { exportToDevice, isMobile, pickFilesFromDevice } from '../lib/platform'
import { Cloud, Download, File, Folder, FolderPlus, Info, LogOut, Navigation, Pencil, RefreshCw, Save, Trash2, Upload, UserPlus, X } from 'lucide-react'
import DetailsModal, { type DetailField } from './DetailsModal'
import GoToPathModal from './GoToPathModal'
import IconButton from './IconButton'
import RowActions from './RowActions'
import Pagination from './Pagination'
import { getAppState, setAppState } from '../lib/appState'
import { kbdItem, useListKeyboard } from '../lib/keyboard'
import { isObject } from '../lib/tabState'
import { offsetOfPage, pageOfOffset, validOffset } from '../lib/pagedPosition'
import {
  filenMkdir,
  filenReadFile,
  filenReaddir,
  filenRename,
  filenRm,
  filenStat,
  filenWriteFile,
  listFilenAccounts,
  loginFilen,
  logoutFilen,
  type FilenAccount,
  type FilenEntry,
} from '../lib/filen'
import { DEFAULT_PAGE_SIZE, getGlobalPageSize, setGlobalPageSize } from '../lib/listPageSize'
import { writeUserFile } from '../lib/localFs'
import { formatBytesExact } from '../lib/format'
import { pathForInput } from '../lib/pathInput'

/** Where the person was: the account and the folder in it. */
const LOCATION_KEY = 'filenTab.location'

function joinFilenPath(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base}/${name}`
}

/** What the details popup is about: an entry of the folder, or the folder itself (whose id the listing doesn't carry, so it
 * is asked for). */
type Details = { kind: 'entry'; entry: FilenEntry } | { kind: 'here'; entry: FilenEntry | null }

export default function FilenTab() {
  const [accounts, setAccounts] = useState<FilenAccount[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)

  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<FilenEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [details, setDetails] = useState<Details | null>(null)
  const [goingTo, setGoingTo] = useState(false)

  const [showAddForm, setShowAddForm] = useState(false)
  const [form, setForm] = useState({ email: '', password: '', twoFactorCode: '' })
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const [page, setPage] = useState(0)
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE)
  // The saved place is read once, with the first list of accounts; until then nothing is saved over it.
  const [locationLoaded, setLocationLoaded] = useState(false)
  const locationLoadedRef = useRef(false)
  const restoredPathRef = useRef(false)
  // The position in the folder's listing (the number of records skipped, see lib/pagedPosition.ts),
  // restored once the listing is there; until then nothing is saved over it.
  const restoredOffsetRef = useRef<number | null>(null)
  const [restoringPage, setRestoringPage] = useState(false)
  const pageSizeRef = useRef(pageSize)
  pageSizeRef.current = pageSize
  // The item the arrow keys are on (an index into all the entries), and which item of a folder that was
  // opened or left with the keys to start from.
  const [kbdFocus, setKbdFocus] = useState(-1)
  const pendingFocusRef = useRef<string | 'first' | null>(null)

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
    const saved = locationLoadedRef.current ? undefined : await getAppState<unknown>(LOCATION_KEY)
    const place =
      isObject(saved) && typeof saved.userId === 'number' && typeof saved.path === 'string' && saved.path.startsWith('/')
        ? { userId: saved.userId, path: saved.path, offset: validOffset(saved.offset) }
        : null
    setActiveId((current) => {
      if (current != null && list.some((a) => a.userId === current)) return current
      return list.find((a) => a.userId === place?.userId)?.userId ?? list[0]?.userId ?? null
    })
    if (!locationLoadedRef.current) {
      locationLoadedRef.current = true
      // Back to the folder of the last visit — if its account is still connected (the folder itself is
      // judged when it is listed: one that is gone falls back to the top).
      if (place && list.some((a) => a.userId === place.userId)) {
        setPath(place.path)
        restoredPathRef.current = place.path !== '/'
        restoredOffsetRef.current = place.offset
        setRestoringPage(place.offset !== null)
      }
      setLocationLoaded(true)
    }
  }, [])

  useEffect(() => {
    loadAccounts().catch((e) => setError(String(e)))
  }, [loadAccounts])

  const refreshDir = useCallback(async (userId: number, dirPath: string) => {
    setLoading(true)
    setError(null)
    try {
      setEntries(await filenReaddir(userId, dirPath))
      restoredPathRef.current = false
      if (restoredOffsetRef.current !== null) {
        setPage(pageOfOffset(restoredOffsetRef.current, pageSizeRef.current)) // the page that holds the record it was at
        restoredOffsetRef.current = null
        setRestoringPage(false)
      }
    } catch (e) {
      restoredOffsetRef.current = null
      setRestoringPage(false)
      if (restoredPathRef.current && dirPath !== '/') {
        restoredPathRef.current = false
        setPath('/') // the folder of the last visit is gone: start at the top
      } else {
        setError(String(e))
      }
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

  useEffect(() => {
    if (locationLoaded && activeId != null && !restoringPage) {
      setAppState(LOCATION_KEY, { userId: activeId, path, offset: offsetOfPage(page, pageSize) }).catch(() => {})
    }
  }, [locationLoaded, activeId, path, page, pageSize, restoringPage])

  function switchAccount(userId: number) {
    setActiveId(userId)
    setPath('/')
  }

  async function handleRemove() {
    const account = accounts.find((a) => a.userId === activeId)
    if (!account) return
    const question =
      `Disconnect account "${account.email}"? You can reconnect it later. ` +
      "Everything the Notes app cached for it goes too — cached files and any branches that haven't been committed. Nothing in the account itself is touched."
    if (!(await confirm(question))) return
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
      for (const file of await pickFilesFromDevice()) {
        // A file of that name is there: say so (and how it is) instead of quietly replacing it.
        const existing = entries.find((e) => e.name === file.name && !e.isDirectory)
        if (existing) {
          const when = existing.mtimeMs != null ? `, last changed ${new Date(existing.mtimeMs).toLocaleString()}` : ''
          if (!(await confirm(`"${file.name}" is already in this folder in Filen (${existing.size ?? '?'} bytes${when}). Replace it with the file you chose?`))) continue
        }
        await filenWriteFile(userId, joinFilenPath(path, file.name), file.data)
      }
    })
  }

  async function downloadToComputer(entry: FilenEntry) {
    if (activeId == null) return
    try {
      const saved = await exportToDevice(entry.name, () => filenReadFile(activeId, joinFilenPath(path, entry.name)))
      if (saved && isMobile) window.alert(`Saved to ${saved}`)
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

  async function showDetails(target: { kind: 'entry'; entry: FilenEntry } | { kind: 'here' }) {
    if (target.kind === 'entry') {
      setDetails(target)
      return
    }
    const opened: Details = { kind: 'here', entry: null }
    setDetails(opened)
    if (activeId == null) return
    try {
      const entry = await filenStat(activeId, path)
      setDetails((current) => (current === opened ? { kind: 'here', entry } : current))
    } catch {
      // no id, then: the path is still shown
    }
  }

  function detailFields(): { title: string; fields: DetailField[] } | null {
    if (!details) return null
    const account = accounts.find((a) => a.userId === activeId)
    const entry = details.entry
    const shownPath = details.kind === 'entry' ? joinFilenPath(path, details.entry.name) : path
    const isDirectory = details.kind === 'here' ? true : details.entry.isDirectory
    const fields: DetailField[] = [
      { label: 'Name', value: details.kind === 'entry' ? details.entry.name : shownPath === '/' ? 'root' : (shownPath.split('/').pop() ?? '') },
      { label: 'Kind', value: isDirectory ? 'Folder' : 'File', copy: false },
      { label: 'Path', value: shownPath, mono: true },
      { label: 'Account', value: account?.email ?? '' },
      // The id is kept out of sight until asked for; it can be copied to either clipboard.
      { label: 'Item id', value: entry?.id ?? '', mono: true, hidden: true },
    ]
    if (entry && !isDirectory && entry.size != null) fields.push({ label: 'Size', value: formatBytesExact(entry.size) })
    if (entry?.mtimeMs != null) fields.push({ label: 'Modified', value: new Date(entry.mtimeMs).toLocaleString() })
    return { title: isDirectory ? 'Folder in Filen' : 'File in Filen', fields }
  }

  /** "Go to a path": a folder of the account — or a file, whose folder is opened with the file focused. */
  async function goToPath(segments: string[]): Promise<string | null> {
    if (activeId == null) return 'No account is open.'
    const target = '/' + segments.join('/')
    if (target === '/') {
      setPath('/')
      return null
    }
    let found: FilenEntry
    try {
      found = await filenStat(activeId, target)
    } catch {
      return `There is nothing at ${target} in this account.`
    }
    if (found.isDirectory) {
      setPath(target)
    } else {
      const cut = target.lastIndexOf('/')
      pendingFocusRef.current = target.slice(cut + 1)
      setPath(cut <= 0 ? '/' : target.slice(0, cut))
    }
    return null
  }

  const shownDetails = detailFields()

  const breadcrumbs = path === '/' ? [''] : ['', ...path.split('/').filter(Boolean)]
  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const pagedEntries = entries.slice(currentPage * pageSize, (currentPage + 1) * pageSize)

  // ── Keyboard ──

  // A new folder: nothing is focused until a key is pressed — unless it was entered with the keys.
  useEffect(() => {
    setKbdFocus(-1)
  }, [activeId, path])
  useEffect(() => {
    const pending = pendingFocusRef.current
    if (pending === null || loading) return
    pendingFocusRef.current = null
    setKbdFocus(pending === 'first' ? (entries.length > 0 ? 0 : -1) : Math.max(0, entries.findIndex((e) => e.name === pending)))
  }, [entries, loading])
  useEffect(() => {
    if (kbdFocus >= 0) setPage(Math.floor(kbdFocus / pageSize))
  }, [kbdFocus, pageSize])

  useListKeyboard({
    count: entries.length,
    focused: kbdFocus,
    setFocused: setKbdFocus,
    pageSize,
    page: currentPage,
    enabled: activeId != null && !showAddForm,
    onOpen: (i) => {
      const entry = entries[i]
      if (!entry?.isDirectory) return
      pendingFocusRef.current = 'first'
      openEntry(entry)
    },
    onParent: () => {
      if (path === '/') return
      const cut = path.lastIndexOf('/')
      pendingFocusRef.current = path.slice(cut + 1)
      setPath(cut <= 0 ? '/' : path.slice(0, cut))
    },
  })

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
              <IconButton icon={Navigation} label="Go to a path…" onClick={() => setGoingTo(true)} />
              <IconButton icon={Info} label="Details of this folder" onClick={() => showDetails({ kind: 'here' })} />
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
                {pagedEntries.map((entry, i) => (
                  <tr key={entry.name} {...kbdItem(kbdFocus, currentPage * pageSize + i, setKbdFocus)}>
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
                      <RowActions
                        actions={[
                          { icon: Info, label: 'Details', onClick: () => showDetails({ kind: 'entry', entry }) },
                          ...(!entry.isDirectory
                            ? [
                                { icon: Download, label: 'Export…', onClick: () => downloadToComputer(entry) },
                                { icon: Save, label: 'Save to user folder', onClick: () => saveToUserFolder(entry) },
                              ]
                            : []),
                          { icon: Pencil, label: 'Rename', onClick: () => renameEntry(entry) },
                          { icon: Trash2, label: 'Delete', danger: true, onClick: () => deleteEntry(entry) },
                        ]}
                      />
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

      {shownDetails && <DetailsModal title={shownDetails.title} fields={shownDetails.fields} onClose={() => setDetails(null)} onError={setError} />}

      {goingTo && (
        <GoToPathModal
          current={pathForInput(path)}
          hint="A path in this Filen account — /folder/subfolder"
          onGo={goToPath}
          onClose={() => setGoingTo(false)}
        />
      )}
    </div>
  )
}
