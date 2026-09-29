import { useCallback, useEffect, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import IconButton from './IconButton'
import { exportLogFile, getLogFileInfo, getLogLevel, readLogTail, setLogLevel, LOG_LEVELS, type LogFileInfo, type LogLevel } from '../lib/logging'
import { formatBytesExact } from '../lib/format'

const LEVEL_DESCRIPTIONS: Record<LogLevel, string> = {
  off: 'Nothing is written.',
  error: 'Errors only.',
  warn: 'Errors and warnings.',
  info: 'The above, plus every admin-only operation and every notebook added or removed.',
  debug: 'The above, plus every Filen.io request (one line each).',
  trace: 'Everything: Filen requests in more detail (before and after, not just the outcome), every local file-system request, every tag change and every settings/app-state change (never a value, a file’s contents, or the text of a search).',
}

/** Dev Tools → Logs (Settings → "Advanced" turns the tab on — `lib/devTools.ts`): the app's own log level,
 * its log file's location and size, and its recent content — see `logging.rs` for what's actually written
 * and when; this page only ever asks Rust for those four things, never decides any of it itself. */
export default function DevToolsTab() {
  const [level, setLevel] = useState<LogLevel | null>(null)
  const [info, setInfo] = useState<LogFileInfo | null>(null)
  const [tail, setTail] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const [l, i, t] = await Promise.all([getLogLevel(), getLogFileInfo(), readLogTail()])
      setLevel(l)
      setInfo(i)
      setTail(t)
    } catch (e) {
      setError(String(e))
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function changeLevel(next: LogLevel) {
    setError(null)
    setBusy(true)
    try {
      await setLogLevel(next)
      setLevel(next)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function exportFile() {
    setError(null)
    try {
      await exportLogFile()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div className="tab-panel">
      <div className="toolbar">
        <strong>Logs</strong>
        <div className="toolbar-actions" data-primary-actions>
          <IconButton icon={RefreshCw} label="Read it again" onClick={refresh} />
          <IconButton icon={Download} label="Export the log file" onClick={exportFile} disabled={!info} />
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <p className="muted">
        A plain text file this app writes to itself — never anything a window asks it to; see the level
        descriptions below for exactly what each one adds. It never holds a file's contents or the text of a
        search — only names, relative paths, cloud item ids, keys and counts.
      </p>

      <div className="checkbox-row" style={{ flexWrap: 'wrap', gap: 12 }}>
        {LOG_LEVELS.map((l) => (
          <label key={l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="radio" name="log-level" checked={level === l} disabled={busy || level === null} onChange={() => changeLevel(l)} />
            {l}
          </label>
        ))}
      </div>
      {level && <p className="muted">{LEVEL_DESCRIPTIONS[level]}</p>}

      {info && (
        <div className="new-db-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, marginTop: 12 }}>
          <div>
            <div className="muted">Log file</div>
            <div className="path">{info.path}</div>
          </div>
          <div className="muted">{formatBytesExact(info.sizeBytes)}</div>
        </div>
      )}

      <div className="toolbar" style={{ marginTop: 24 }}>
        <strong>Recent content</strong>
      </div>
      <p className="muted">The end of the file — at most 200 KB shown here; export it for the whole thing.</p>
      <pre className="path" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto' }}>
        {tail === null ? 'Reading…' : tail === '' ? 'The log is empty.' : tail}
      </pre>
    </div>
  )
}
