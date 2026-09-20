import { useCallback, useEffect, useRef, useState } from 'react'
import Database from '../lib/sqlite'
import { Database as DatabaseIcon, Eye, Play, Plus, RefreshCw, Table2, X } from 'lucide-react'
import IconButton from './IconButton'
import { joinRelative, listUserDir } from '../lib/localFs'
import { getAppState, setAppState } from '../lib/appState'
import { kbdItem, useListKeyboard } from '../lib/keyboard'
import { isObject } from '../lib/tabState'

/** Which database is open, and which of its tables is shown — kept for the next visit to this tab page. */
const NAVIGATION_KEY = 'sqliteTab.navigation'

const DB_EXTENSIONS = new Set(['db', 'sqlite', 'sqlite3', 'db3'])

async function findDbFiles(relPath: string, depth: number): Promise<string[]> {
  if (depth > 6) return []
  const entries = await listUserDir(relPath)
  const found: string[] = []
  for (const entry of entries) {
    const rel = joinRelative(relPath, entry.name)
    if (entry.isDirectory) {
      found.push(...(await findDbFiles(rel, depth + 1)))
    } else {
      const ext = entry.name.split('.').pop()?.toLowerCase() ?? ''
      if (DB_EXTENSIONS.has(ext)) found.push(rel)
    }
  }
  return found
}

interface TableInfo {
  name: string
  type: string
}

function isSelectLike(sql: string): boolean {
  const trimmed = sql.trim().toLowerCase()
  return trimmed.startsWith('select') || trimmed.startsWith('pragma') || trimmed.startsWith('explain')
}

export default function SqliteTab() {
  const [dbFiles, setDbFiles] = useState<string[]>([])
  const [scanning, setScanning] = useState(false)
  const [newDbName, setNewDbName] = useState('')

  const [selectedRel, setSelectedRel] = useState<string | null>(null)
  const [db, setDb] = useState<Database | null>(null)
  const [tables, setTables] = useState<TableInfo[]>([])
  const [activeTable, setActiveTable] = useState<string | null>(null)
  const [columns, setColumns] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [sqlText, setSqlText] = useState('')
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The place of the last visit is read once, when the list of databases has been; nothing is saved
  // over it before that.
  const [navigationLoaded, setNavigationLoaded] = useState(false)
  // The item the arrow keys are on; and whether the level being shown was reached with the keys (then
  // the first item — or, going back up, the database just left — is focused, otherwise none).
  const [kbdFocus, setKbdFocus] = useState(-1)
  const keyboardMovedRef = useRef(false)
  const leftDatabaseRef = useRef<string | null>(null)

  const scan = useCallback(async (): Promise<string[]> => {
    setScanning(true)
    setError(null)
    try {
      const found = await findDbFiles('', 0)
      setDbFiles(found)
      return found
    } catch (e) {
      setError(String(e))
      return []
    } finally {
      setScanning(false)
    }
  }, [])

  const refreshTables = useCallback(async (database: Database): Promise<TableInfo[]> => {
    const result = await database.select<TableInfo[]>(
      "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    setTables(result)
    return result
  }, [])

  /** Opens the database, and — if `table` is given and it has it — shows that table. */
  async function openDatabase(rel: string, table: string | null = null) {
    setError(null)
    try {
      const database = await Database.load('user', rel)
      setDb(database)
      setSelectedRel(rel)
      setActiveTable(null)
      setRows([])
      setColumns([])
      const found = await refreshTables(database)
      if (table && found.some((t) => t.name === table)) await showTable(database, table)
    } catch (e) {
      setError(String(e))
    }
  }

  // The start: the databases, then back to where the person was — if that database and table are still there.
  useEffect(() => {
    ;(async () => {
      const [saved, found] = await Promise.all([getAppState<unknown>(NAVIGATION_KEY).catch(() => undefined), scan()])
      if (isObject(saved) && typeof saved.db === 'string' && found.includes(saved.db)) {
        await openDatabase(saved.db, typeof saved.table === 'string' ? saved.table : null)
      }
      setNavigationLoaded(true)
    })()
  }, [])

  useEffect(() => {
    if (navigationLoaded) setAppState(NAVIGATION_KEY, { db: selectedRel, table: activeTable }).catch(() => {})
  }, [navigationLoaded, selectedRel, activeTable])

  async function createDatabase() {
    const name = newDbName.trim()
    if (!name) return
    const rel = name.match(/\.(db|sqlite|sqlite3|db3)$/i) ? name : `${name}.sqlite`
    setNewDbName('')
    await openDatabase(rel)
    await scan()
  }

  async function closeDatabase() {
    leftDatabaseRef.current = selectedRel
    if (db) {
      try {
        await db.close()
      } catch {
        // ignore
      }
    }
    setDb(null)
    setSelectedRel(null)
    setTables([])
    setActiveTable(null)
    setRows([])
    setColumns([])
    setSqlText('')
    setStatusMsg(null)
  }

  async function showTable(database: Database, name: string) {
    setError(null)
    setActiveTable(name)
    try {
      const result = await database.select<Record<string, unknown>[]>(`SELECT * FROM "${name}" LIMIT 200`)
      setRows(result)
      setColumns(result.length > 0 ? Object.keys(result[0]) : [])
      if (result.length === 0) {
        const info = await database.select<{ name: string }[]>(`PRAGMA table_info("${name}")`)
        setColumns(info.map((c) => c.name))
      }
    } catch (e) {
      setError(String(e))
    }
  }

  async function viewTable(name: string) {
    if (db) await showTable(db, name)
  }

  // ── Keyboard: the list of databases, and — in one — the list of its tables ──

  useEffect(() => {
    const byKeyboard = keyboardMovedRef.current
    keyboardMovedRef.current = false
    if (!byKeyboard) return setKbdFocus(-1)
    setKbdFocus(db ? 0 : Math.max(0, dbFiles.indexOf(leftDatabaseRef.current ?? '')))
  }, [db])

  useListKeyboard({
    count: db ? tables.length : dbFiles.length,
    focused: kbdFocus,
    setFocused: setKbdFocus,
    onOpen: (i) => {
      if (db) viewTable(tables[i].name)
      else {
        keyboardMovedRef.current = true
        openDatabase(dbFiles[i])
      }
    },
    onParent: db
      ? () => {
          keyboardMovedRef.current = true
          closeDatabase()
        }
      : undefined,
  })

  async function runSql() {
    if (!db || !sqlText.trim()) return
    setError(null)
    setStatusMsg(null)
    try {
      if (isSelectLike(sqlText)) {
        const result = await db.select<Record<string, unknown>[]>(sqlText)
        setRows(result)
        setColumns(result.length > 0 ? Object.keys(result[0]) : [])
        setActiveTable(null)
        setStatusMsg(`${result.length} row(s) returned.`)
      } else {
        const result = await db.execute(sqlText)
        setStatusMsg(
          `OK — ${result.rowsAffected} row(s) affected${result.lastInsertId ? `, last insert id ${result.lastInsertId}` : ''}.`,
        )
        await refreshTables(db)
      }
    } catch (e) {
      setError(String(e))
    }
  }

  if (!db) {
    return (
      <div className="tab-panel">
        <div className="toolbar">
          <strong>SQLite databases in your user folder</strong>
          <div className="toolbar-actions">
            <IconButton icon={RefreshCw} label={scanning ? 'Scanning…' : 'Rescan'} onClick={() => scan()} disabled={scanning} />
          </div>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <ul className="db-list">
          {dbFiles.length === 0 && !scanning && <li className="muted">No .db/.sqlite files found.</li>}
          {dbFiles.map((rel, i) => (
            <li key={rel} {...kbdItem(kbdFocus, i, setKbdFocus)}>
              <button className="link-button" onClick={() => openDatabase(rel)}>
                <DatabaseIcon size={14} strokeWidth={2} aria-hidden="true" /> {rel}
              </button>
            </li>
          ))}
        </ul>
        <div className="new-db-row">
          <input
            placeholder="new-database.sqlite"
            value={newDbName}
            onChange={(e) => setNewDbName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createDatabase()}
          />
          <IconButton icon={Plus} label="Create new database" onClick={createDatabase} />
        </div>
      </div>
    )
  }

  return (
    <div className="tab-panel sqlite-tab">
      <div className="toolbar">
        <strong>{selectedRel}</strong>
        <div className="toolbar-actions">
          <IconButton icon={RefreshCw} label="Refresh schema" onClick={() => refreshTables(db)} />
          <IconButton icon={X} label="Close" onClick={closeDatabase} />
        </div>
      </div>

      <div className="sqlite-body">
        <div className="sqlite-sidebar">
          <div className="muted">Tables &amp; views</div>
          <ul className="table-list">
            {tables.map((t, i) => (
              <li key={t.name} {...kbdItem(kbdFocus, i, setKbdFocus)}>
                <button
                  className={`link-button ${activeTable === t.name ? 'active' : ''}`}
                  onClick={() => viewTable(t.name)}
                >
                  {t.type === 'view' ? (
                    <Eye size={14} strokeWidth={2} aria-hidden="true" />
                  ) : (
                    <Table2 size={14} strokeWidth={2} aria-hidden="true" />
                  )}{' '}
                  {t.name}
                </button>
              </li>
            ))}
            {tables.length === 0 && <li className="muted">No tables yet.</li>}
          </ul>
        </div>

        <div className="sqlite-main">
          <div className="sql-runner">
            <textarea
              placeholder="SELECT * FROM my_table;  -- or any INSERT/UPDATE/DELETE/CREATE/ALTER/DROP statement"
              value={sqlText}
              onChange={(e) => setSqlText(e.target.value)}
              rows={3}
            />
            <IconButton icon={Play} label="Run SQL" onClick={runSql} />
          </div>

          {error && <div className="error-banner">{error}</div>}
          {statusMsg && <div className="status-banner">{statusMsg}</div>}

          {columns.length > 0 && (
            <div className="result-grid-wrapper">
              <table className="result-grid">
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i}>
                      {columns.map((c) => (
                        <td key={c}>{row[c] === null ? <em className="muted">NULL</em> : String(row[c])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
