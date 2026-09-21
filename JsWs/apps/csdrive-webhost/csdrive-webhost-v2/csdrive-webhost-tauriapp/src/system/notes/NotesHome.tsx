import { FolderOpen, Notebook, Settings } from 'lucide-react'

/** The page a Notes tab opens at: two ways in — the file manager, and the page for managing notebooks. */
export default function NotesHome({ onFiles, onNotebooks, onSettings }: { onFiles: () => void; onNotebooks: () => void; onSettings: () => void }) {
  return (
    <div className="app-shell">
      <main className="tab-content">
        <div className="tab-panel notes-home">
          <h1 className="notes-home-title">Notes</h1>
          <div className="notes-cards">
            <button type="button" className="notes-card" onClick={onNotebooks}>
              <Notebook size={28} strokeWidth={1.75} aria-hidden="true" />
              <strong>Manage notebooks</strong>
              <span className="muted">Your notebooks: add one that exists, create a new one, rename or remove them.</span>
            </button>
            <button type="button" className="notes-card" onClick={onFiles}>
              <FolderOpen size={28} strokeWidth={1.75} aria-hidden="true" />
              <strong>File manager</strong>
              <span className="muted">Browse, edit, copy and upload files — on this device and in your Filen accounts.</span>
            </button>
            <button type="button" className="notes-card" onClick={onSettings}>
              <Settings size={28} strokeWidth={1.75} aria-hidden="true" />
              <strong>Settings</strong>
              <span className="muted">What the notes show, and the app's clipboard.</span>
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}
