import { useCallback, useEffect, useState } from 'react'
import { Eraser, House } from 'lucide-react'
import IconButton from '../../components/IconButton'
import { internalClipboard } from '../../lib/clipboard'
import { useNotesSettings } from './settings'

/** The Notes app's settings: what it shows (the notes' indexes) and the app's clipboard, which can be cleared here. */
export default function NotesSettingsPage({ onHome }: { onHome: () => void }) {
  const { settings, change } = useNotesSettings()
  const [clipboard, setClipboard] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const read = useCallback(async () => {
    try {
      setClipboard(await internalClipboard.get())
    } catch (e) {
      setError(String(e))
    }
  }, [])
  useEffect(() => {
    read()
  }, [read])

  async function clear() {
    setError(null)
    try {
      await internalClipboard.clear()
      await read()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div className="app-shell">
      <main className="tab-content">
        <div className="tab-panel notes-page">
          <div className="notes-page-header">
            <IconButton icon={House} label="Notes home" onClick={onHome} />
            <h2>Notes settings</h2>
          </div>
          {error && <div className="error-banner">{error}</div>}

          <section className="notes-settings-section">
            <strong>Notes</strong>
            <label className="notes-settings-row">
              <input type="checkbox" checked={settings.showIndexes} onChange={(e) => change({ showIndexes: e.target.checked })} />
              <span>Show the notes' indexes (001, 002…) before their titles</span>
            </label>
          </section>

          <section className="notes-settings-section">
            <strong>The app's clipboard</strong>
            <p className="muted">
              One text that every window of the app — the admin-app, Notes and web apps — can copy to and paste from. It is kept in memory only.
            </p>
            <div className="notes-panel-row">
              <span className="muted">
                {clipboard === null ? 'Reading…' : clipboard === '' ? 'It is empty.' : `It holds ${clipboard.length.toLocaleString()} character${clipboard.length === 1 ? '' : 's'}.`}
              </span>
              <IconButton icon={Eraser} label="Clear the app's clipboard" onClick={clear} disabled={!clipboard} />
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
