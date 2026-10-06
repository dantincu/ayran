import { useCallback, useEffect, useState } from 'react'
import { ClipboardList, Eraser, House } from 'lucide-react'
import ClipboardManagerModal from '../../components/ClipboardManagerModal'
import IconButton from '../../components/IconButton'
import { internalClipboard } from '../../lib/clipboard'
import { useNotesSettings } from './settings'
import UserActionButton from './UserActionButton'

/** The Notes app's settings: what it shows (the notes' indexes) and the app's clipboard, which can be managed or cleared here. */
export default function NotesSettingsPage({ onHome }: { onHome: () => void }) {
  const { settings, change } = useNotesSettings()
  const [clipboardEntries, setClipboardEntries] = useState<string[] | null>(null)
  const [managingClipboard, setManagingClipboard] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const read = useCallback(async () => {
    try {
      setClipboardEntries(await internalClipboard.list())
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
          <div className="notes-page-header" data-primary-actions>
            <IconButton icon={House} label="Notes home" onClick={onHome} />
            <h2>Notes settings</h2>
            <UserActionButton />
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
            <strong>Editor ↔ syncing web app</strong>
            <p className="muted">When a note's editor and its web app (opened from it) are open in two windows at once.</p>
            <label className="notes-settings-row">
              <input type="checkbox" checked={settings.syncScrollMirror} onChange={(e) => change({ syncScrollMirror: e.target.checked })} />
              <span>Scroll the web app as the editor scrolls, similar to a split preview</span>
            </label>
            <label className="notes-settings-row">
              <input type="checkbox" checked={settings.syncScrollKeyboard} onChange={(e) => change({ syncScrollKeyboard: e.target.checked })} />
              <span>Scroll the web app from the editor with Ctrl+Alt+↑/↓/Page Up/Page Down</span>
            </label>
            <label className="notes-settings-row">
              <input type="checkbox" checked={settings.autosync} onChange={(e) => change({ autosync: e.target.checked })} />
              <span>Automatically refresh the web app when the note is saved</span>
            </label>
          </section>

          <section className="notes-settings-section">
            <strong>The app's clipboard</strong>
            <p className="muted">
              A stack of text that every window of the app — the admin-app, Notes and web apps — can copy to and paste from. It is kept in memory only.
            </p>
            <div className="notes-panel-row">
              <span className="muted">
                {clipboardEntries === null
                  ? 'Reading…'
                  : clipboardEntries.length === 0
                    ? 'It is empty.'
                    : `It holds ${clipboardEntries.length.toLocaleString()} entr${clipboardEntries.length === 1 ? 'y' : 'ies'}.`}
              </span>
              <IconButton icon={ClipboardList} label="Manage the app's clipboard…" onClick={() => setManagingClipboard(true)} />
              <IconButton icon={Eraser} label="Clear the app's clipboard" onClick={clear} disabled={!clipboardEntries || clipboardEntries.length === 0} />
            </div>
          </section>
        </div>
      </main>
      {managingClipboard && (
        <ClipboardManagerModal
          onClose={() => {
            setManagingClipboard(false)
            void read()
          }}
        />
      )}
    </div>
  )
}
