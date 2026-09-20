import { useCallback, useEffect, useRef, useState } from 'react'
import { confirm } from '@tauri-apps/plugin-dialog'
import { Clock, Database as DatabaseIcon, HardDrive, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react'
import IconButton from './IconButton'
import { getAppState, setAppState } from '../lib/appState'
import { kbdItem, useListKeyboard } from '../lib/keyboard'
import { isObject, usePersistedState } from '../lib/tabState'
import {
  clearStore,
  createDatabase,
  createStore,
  deleteDatabase,
  deleteRecord,
  deleteStore,
  getStoreInfo,
  listDatabases,
  listRecords,
  listStores,
  putRecord,
  wipeAllBrowserStorage,
  type IdbInfo,
  type StoreInfo,
  type StoreRecord,
} from '../lib/storageInspector'

type SubTab = 'local' | 'session' | 'indexeddb'

const SUB_TABS: SubTab[] = ['local', 'session', 'indexeddb']
/** Which panel is shown, and — in IndexedDB — which database and object store are open: kept for the
 * next visit to this tab page. */
const SUB_TAB_KEY = 'storageTab.panel'
const IDB_NAVIGATION_KEY = 'storageTab.indexedDb'

function WebStoragePanel({ storage, label }: { storage: Storage; label: string }) {
  const [rows, setRows] = useState<{ key: string; value: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  const refresh = useCallback(() => {
    const list: { key: string; value: string }[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key !== null) list.push({ key, value: storage.getItem(key) ?? '' })
    }
    list.sort((a, b) => a.key.localeCompare(b.key))
    setRows(list)
  }, [storage])

  useEffect(() => {
    refresh()
  }, [refresh])

  function addItem() {
    if (!newKey.trim()) return
    try {
      storage.setItem(newKey, newValue)
      setNewKey('')
      setNewValue('')
      refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  function startEdit(row: { key: string; value: string }) {
    setEditing(row.key)
    setEditValue(row.value)
  }

  function saveEdit(key: string) {
    try {
      storage.setItem(key, editValue)
      setEditing(null)
      refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  function removeItem(key: string) {
    storage.removeItem(key)
    refresh()
  }

  async function clearAll() {
    if (!(await confirm(`Clear all ${label} entries?`))) return
    storage.clear()
    refresh()
  }

  return (
    <div className="tab-panel">
      <div className="toolbar">
        <strong>{label}</strong>
        <div className="toolbar-actions">
          <IconButton icon={Trash2} label="Clear all" variant="danger" onClick={clearAll} disabled={rows.length === 0} />
          <IconButton icon={RefreshCw} label="Refresh" onClick={refresh} />
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <table className="file-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="muted">
                No entries.
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={row.key}>
              <td>{row.key}</td>
              <td>
                {editing === row.key ? (
                  <input
                    autoFocus
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => saveEdit(row.key)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveEdit(row.key)
                      if (e.key === 'Escape') setEditing(null)
                    }}
                  />
                ) : (
                  <button className="link-button" onClick={() => startEdit(row)}>
                    {row.value}
                  </button>
                )}
              </td>
              <td className="row-actions">
                <IconButton icon={Trash2} label="Delete" variant="danger" onClick={() => removeItem(row.key)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="new-db-row">
        <input placeholder="key" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
        <input placeholder="value" value={newValue} onChange={(e) => setNewValue(e.target.value)} />
        <IconButton icon={Plus} label="Add" onClick={addItem} />
      </div>
    </div>
  )
}

function IndexedDbPanel() {
  const [databases, setDatabases] = useState<IdbInfo[]>([])
  const [selectedDb, setSelectedDb] = useState<string | null>(null)
  const [stores, setStores] = useState<string[]>([])
  const [selectedStore, setSelectedStore] = useState<string | null>(null)
  const [storeInfo, setStoreInfo] = useState<StoreInfo | null>(null)
  const [records, setRecords] = useState<StoreRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [newDbName, setNewDbName] = useState('')
  const [newStoreName, setNewStoreName] = useState('')
  const [newStoreKeyPath, setNewStoreKeyPath] = useState('')
  const [newStoreAutoIncrement, setNewStoreAutoIncrement] = useState(true)
  const [recordKey, setRecordKey] = useState('')
  const [recordValue, setRecordValue] = useState('{}')
  const [navigationLoaded, setNavigationLoaded] = useState(false)
  // The item the arrow keys are on, in whichever of the three lists (databases, object stores, records)
  // is the deepest one open; and whether the level was reached with the keys.
  const [kbdFocus, setKbdFocus] = useState(-1)
  const keyboardMovedRef = useRef(false)
  const leftItemRef = useRef<string | null>(null)

  const refreshDatabases = useCallback(async (): Promise<string[]> => {
    try {
      const found = await listDatabases()
      setDatabases(found)
      return found.map((d) => d.name)
    } catch (e) {
      setError(String(e))
      return []
    }
  }, [])

  // The start: the databases, then back to the database and store of the last visit — where they still are.
  useEffect(() => {
    ;(async () => {
      const [saved, names] = await Promise.all([getAppState<unknown>(IDB_NAVIGATION_KEY).catch(() => undefined), refreshDatabases()])
      if (isObject(saved) && typeof saved.db === 'string' && names.includes(saved.db)) {
        await openDatabase(saved.db, typeof saved.store === 'string' ? saved.store : null)
      }
      setNavigationLoaded(true)
    })()
  }, [refreshDatabases])

  useEffect(() => {
    if (navigationLoaded) setAppState(IDB_NAVIGATION_KEY, { db: selectedDb, store: selectedStore }).catch(() => {})
  }, [navigationLoaded, selectedDb, selectedStore])

  /** Opens the database, and — if `store` is given and it has it — that object store. */
  async function openDatabase(name: string, store: string | null = null) {
    setError(null)
    setSelectedDb(name)
    setSelectedStore(null)
    setRecords([])
    try {
      const found = await listStores(name)
      setStores(found)
      if (store && found.includes(store)) await showStore(name, store)
    } catch (e) {
      setError(String(e))
    }
  }

  async function showStore(database: string, name: string) {
    setError(null)
    setSelectedStore(name)
    try {
      setStoreInfo(await getStoreInfo(database, name))
      setRecords(await listRecords(database, name))
    } catch (e) {
      setError(String(e))
    }
  }

  async function openStore(name: string) {
    if (selectedDb) await showStore(selectedDb, name)
  }

  // ── Keyboard: databases → object stores → records; Right goes down a level, Left back up ──

  const level: 'databases' | 'stores' | 'records' = selectedStore ? 'records' : selectedDb ? 'stores' : 'databases'
  useEffect(() => {
    const byKeyboard = keyboardMovedRef.current
    keyboardMovedRef.current = false
    if (!byKeyboard) return setKbdFocus(-1)
    const left = leftItemRef.current
    setKbdFocus(
      level === 'databases' ? Math.max(0, databases.findIndex((d) => d.name === left)) : level === 'stores' ? Math.max(0, stores.indexOf(left ?? '')) : 0,
    )
  }, [level])

  useListKeyboard({
    count: level === 'databases' ? databases.length : level === 'stores' ? stores.length : records.length,
    focused: kbdFocus,
    setFocused: setKbdFocus,
    onOpen: (i) => {
      if (level === 'records') return
      keyboardMovedRef.current = true
      if (level === 'databases') openDatabase(databases[i].name)
      else openStore(stores[i])
    },
    onParent:
      level === 'databases'
        ? undefined
        : () => {
            keyboardMovedRef.current = true
            if (level === 'records') {
              leftItemRef.current = selectedStore
              setSelectedStore(null)
              setRecords([])
            } else {
              leftItemRef.current = selectedDb
              setSelectedDb(null)
              setStores([])
            }
          },
  })

  async function refreshRecords() {
    if (!selectedDb || !selectedStore) return
    try {
      setRecords(await listRecords(selectedDb, selectedStore))
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleCreateDatabase() {
    const name = newDbName.trim()
    if (!name) return
    try {
      await createDatabase(name)
      setNewDbName('')
      await refreshDatabases()
      await openDatabase(name)
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleDeleteDatabase(name: string) {
    if (!(await confirm(`Permanently delete IndexedDB database "${name}"?`))) return
    try {
      await deleteDatabase(name)
      if (selectedDb === name) {
        setSelectedDb(null)
        setStores([])
        setSelectedStore(null)
        setRecords([])
      }
      await refreshDatabases()
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleCreateStore() {
    if (!selectedDb) return
    const name = newStoreName.trim()
    if (!name) return
    try {
      await createStore(selectedDb, name, newStoreKeyPath.trim() || null, newStoreAutoIncrement)
      setNewStoreName('')
      setNewStoreKeyPath('')
      setStores(await listStores(selectedDb))
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleDeleteStore(name: string) {
    if (!selectedDb) return
    if (!(await confirm(`Delete object store "${name}"?`))) return
    try {
      await deleteStore(selectedDb, name)
      if (selectedStore === name) {
        setSelectedStore(null)
        setRecords([])
      }
      setStores(await listStores(selectedDb))
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleAddRecord() {
    if (!selectedDb || !selectedStore) return
    try {
      const value = JSON.parse(recordValue)
      const keyless = storeInfo?.keyPath != null || storeInfo?.autoIncrement
      if (keyless) {
        await putRecord(selectedDb, selectedStore, value)
      } else {
        if (!recordKey.trim()) {
          setError('This store has no key path — a key is required.')
          return
        }
        await putRecord(selectedDb, selectedStore, value, recordKey)
      }
      setRecordKey('')
      setRecordValue('{}')
      await refreshRecords()
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleDeleteRecord(key: IDBValidKey) {
    if (!selectedDb || !selectedStore) return
    try {
      await deleteRecord(selectedDb, selectedStore, key)
      await refreshRecords()
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleClearStore() {
    if (!selectedDb || !selectedStore) return
    if (!(await confirm(`Clear all records in "${selectedStore}"?`))) return
    try {
      await clearStore(selectedDb, selectedStore)
      await refreshRecords()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div className="tab-panel sqlite-tab">
      <div className="toolbar">
        <strong>IndexedDB</strong>
        <div className="toolbar-actions">
          <IconButton icon={RefreshCw} label="Refresh" onClick={() => refreshDatabases()} />
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="sqlite-body">
        <div className="sqlite-sidebar">
          <div className="muted">Databases</div>
          <ul className="table-list">
            {databases.map((d, i) => (
              <li key={d.name} {...(level === 'databases' ? kbdItem(kbdFocus, i, setKbdFocus) : {})}>
                <button
                  className={`link-button ${selectedDb === d.name ? 'active' : ''}`}
                  onClick={() => openDatabase(d.name)}
                >
                  <DatabaseIcon size={14} strokeWidth={2} aria-hidden="true" /> {d.name}
                </button>
                <IconButton icon={X} label="Delete database" variant="danger" onClick={() => handleDeleteDatabase(d.name)} />
              </li>
            ))}
            {databases.length === 0 && <li className="muted">No databases yet.</li>}
          </ul>
          <div className="new-db-row">
            <input placeholder="new-database" value={newDbName} onChange={(e) => setNewDbName(e.target.value)} />
            <IconButton icon={Plus} label="Create" onClick={handleCreateDatabase} />
          </div>

          {selectedDb && (
            <>
              <div className="muted" style={{ marginTop: 16 }}>
                Object stores in {selectedDb}
              </div>
              <ul className="table-list">
                {stores.map((s, i) => (
                  <li key={s} {...(level === 'stores' ? kbdItem(kbdFocus, i, setKbdFocus) : {})}>
                    <button
                      className={`link-button ${selectedStore === s ? 'active' : ''}`}
                      onClick={() => openStore(s)}
                    >
                      <DatabaseIcon size={14} strokeWidth={2} aria-hidden="true" /> {s}
                    </button>
                    <IconButton icon={X} label="Delete store" variant="danger" onClick={() => handleDeleteStore(s)} />
                  </li>
                ))}
                {stores.length === 0 && <li className="muted">No object stores yet.</li>}
              </ul>
              <div className="new-db-row">
                <input placeholder="store name" value={newStoreName} onChange={(e) => setNewStoreName(e.target.value)} />
              </div>
              <div className="new-db-row">
                <input
                  placeholder="key path (optional)"
                  value={newStoreKeyPath}
                  onChange={(e) => setNewStoreKeyPath(e.target.value)}
                />
              </div>
              <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={newStoreAutoIncrement}
                  onChange={(e) => setNewStoreAutoIncrement(e.target.checked)}
                />
                Auto-increment key
              </label>
              <IconButton icon={Plus} label="Create store" onClick={handleCreateStore} />
            </>
          )}
        </div>

        <div className="sqlite-main">
          {selectedStore ? (
            <>
              <div className="toolbar">
                <strong>{selectedStore}</strong>
                <div className="toolbar-actions">
                  <IconButton
                    icon={Trash2}
                    label="Clear all"
                    variant="danger"
                    onClick={handleClearStore}
                    disabled={records.length === 0}
                  />
                  <IconButton icon={RefreshCw} label="Refresh" onClick={refreshRecords} />
                </div>
              </div>

              {storeInfo && (
                <div className="muted">
                  keyPath: {storeInfo.keyPath ? JSON.stringify(storeInfo.keyPath) : 'none (out-of-line keys)'} · autoIncrement:{' '}
                  {String(storeInfo.autoIncrement)}
                </div>
              )}

              <div className="result-grid-wrapper">
                <table className="result-grid">
                  <thead>
                    <tr>
                      <th>Key</th>
                      <th>Value</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r, i) => (
                      <tr key={String(r.key)} {...(level === 'records' ? kbdItem(kbdFocus, i, setKbdFocus) : {})}>
                        <td>{String(r.key)}</td>
                        <td>{JSON.stringify(r.value)}</td>
                        <td>
                          <IconButton icon={Trash2} label="Delete" variant="danger" onClick={() => handleDeleteRecord(r.key)} />
                        </td>
                      </tr>
                    ))}
                    {records.length === 0 && (
                      <tr>
                        <td colSpan={3} className="muted">
                          No records.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="sql-runner">
                {!(storeInfo?.keyPath != null || storeInfo?.autoIncrement) && (
                  <input placeholder="key" value={recordKey} onChange={(e) => setRecordKey(e.target.value)} />
                )}
                <textarea
                  placeholder='JSON value, e.g. {"name":"hello"}'
                  value={recordValue}
                  onChange={(e) => setRecordValue(e.target.value)}
                  rows={2}
                />
                <IconButton icon={Save} label="Put record" onClick={handleAddRecord} />
              </div>
            </>
          ) : (
            <div className="muted">Select an object store to browse its records.</div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function StorageTab() {
  const [sub, setSub, subLoaded] = usePersistedState<SubTab>(SUB_TAB_KEY, 'local', (raw) => (SUB_TABS.includes(raw as SubTab) ? (raw as SubTab) : undefined))
  const [wipeKey, setWipeKey] = useState(0)
  const [wipeError, setWipeError] = useState<string | null>(null)
  const [wiping, setWiping] = useState(false)

  async function handleWipeAll() {
    if (
      !(await confirm(
        'Wipe ALL browser storage for this app — local storage, session storage, and every IndexedDB database (including this app’s own saved tab/folder state)?\n\nThis cannot be undone.',
      ))
    ) {
      return
    }
    setWipeError(null)
    setWiping(true)
    try {
      await wipeAllBrowserStorage()
      setWipeKey((k) => k + 1)
    } catch (e) {
      setWipeError(String(e))
    } finally {
      setWiping(false)
    }
  }

  return (
    <div className="tab-panel">
      <div className="toolbar">
        <strong>Browser storage</strong>
        <div className="toolbar-actions">
          <IconButton icon={Trash2} label="Wipe all browser storage" variant="danger" onClick={handleWipeAll} disabled={wiping} />
        </div>
      </div>

      {wipeError && <div className="error-banner">{wipeError}</div>}

      <nav className="tab-nav sub-nav">
        <button className={`tab-button ${sub === 'local' ? 'active' : ''}`} onClick={() => setSub('local')} title="Local Storage">
          <HardDrive size={18} strokeWidth={2} aria-hidden="true" />
          <span>Local</span>
        </button>
        <button className={`tab-button ${sub === 'session' ? 'active' : ''}`} onClick={() => setSub('session')} title="Session Storage">
          <Clock size={18} strokeWidth={2} aria-hidden="true" />
          <span>Session</span>
        </button>
        <button className={`tab-button ${sub === 'indexeddb' ? 'active' : ''}`} onClick={() => setSub('indexeddb')} title="IndexedDB">
          <DatabaseIcon size={18} strokeWidth={2} aria-hidden="true" />
          <span>IndexedDB</span>
        </button>
      </nav>
      <div className="tab-content" key={wipeKey}>
        {subLoaded && sub === 'local' && <WebStoragePanel storage={window.localStorage} label="Local Storage" />}
        {subLoaded && sub === 'session' && <WebStoragePanel storage={window.sessionStorage} label="Session Storage" />}
        {subLoaded && sub === 'indexeddb' && <IndexedDbPanel />}
      </div>
    </div>
  )
}
