import { useCallback, useEffect, useState } from 'react'
import Database from '../lib/sqlite'
import { Database as DatabaseIcon, Eye, Play, Plus, RefreshCw, Table2, X } from 'lucide-react'
import IconButton from './IconButton'
import { joinRelative, listUserDir } from '../lib/localFs'

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

  const scan = useCallback(async () => {
    setScanning(true)
    setError(null)
    try {
      setDbFiles(await findDbFiles('', 0))
    } catch (e) {
      setError(String(e))
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    scan()
  }, [scan])

  const refreshTables = useCallback(async (database: Database) => {
    const result = await database.select<TableInfo[]>(
      "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    setTables(result)
  }, [])

  async function openDatabase(rel: string) {
    setError(null)
    try {
      const database = await Database.load('user', rel)
      setDb(database)
      setSelectedRel(rel)
      setActiveTable(null)
      setRows([])
      setColumns([])
      await refreshTables(database)
    } catch (e) {
      setError(String(e))
    }
  }

  async function createDatabase() {
    const name = newDbName.trim()
    if (!name) return
    const rel = name.match(/\.(db|sqlite|sqlite3|db3)$/i) ? name : `${name}.sqlite`
    setNewDbName('')
    await openDatabase(rel)
    await scan()
  }

  async function closeDatabase() {
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

  async function viewTable(name: string) {
    if (!db) return
    setError(null)
    setActiveTable(name)
    try {
      const result = await db.select<Record<string, unknown>[]>(`SELECT * FROM "${name}" LIMIT 200`)
      setRows(result)
      setColumns(result.length > 0 ? Object.keys(result[0]) : [])
      if (result.length === 0) {
        const info = await db.select<{ name: string }[]>(`PRAGMA table_info("${name}")`)
        setColumns(info.map((c) => c.name))
      }
    } catch (e) {
      setError(String(e))
    }
  }

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
            <IconButton icon={RefreshCw} label={scanning ? 'Scanning…' : 'Rescan'} onClick={scan} disabled={scanning} />
          </div>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <ul className="db-list">
          {dbFiles.length === 0 && !scanning && <li className="muted">No .db/.sqlite files found.</li>}
          {dbFiles.map((rel) => (
            <li key={rel}>
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
            {tables.map((t) => (
              <li key={t.name}>
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
