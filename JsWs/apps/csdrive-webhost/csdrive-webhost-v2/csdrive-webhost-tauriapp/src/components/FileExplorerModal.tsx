import { useEffect, useState, type ReactNode } from 'react'
import { File as FileIcon, Folder } from 'lucide-react'
import Modal from './Modal'
import IconButton from './IconButton'

export interface ExplorerEntry {
  name: string
  isDirectory: boolean
}

interface Props {
  title: string
  /** Lists one folder (a path relative to whatever root the caller means, no leading/trailing slash; `''` is
   * the root) — thrown errors are shown and leave the folder shown unchanged. */
  list: (path: string) => Promise<ExplorerEntry[]>
  /** Where to start browsing — usually the file's own folder. */
  initialPath: string
  /** A file was clicked: its path, the same convention as `list`'s own. */
  onPick: (path: string) => void
  onClose: () => void
  /** Extra buttons in the header, before Cancel — a caller with more than one way to browse (Notes' own
   * "Files" / "Notes" switch, `system/notes/InsertPathModal.tsx`) puts its own tab buttons here. */
  actions?: ReactNode
}

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
export const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)

/** A plain folder browser for picking a file — breadcrumbs, a list of the folder's entries (folders navigate,
 * files call `onPick`) — with no idea of what kind of storage `list` actually reaches: the caller supplies that
 * (a `FileSource`'s own `list`, `listRootDir`, …), so this one component works for the admin-app's Files tab and
 * for Notes alike. `system/notes/InsertPathModal.tsx` wraps this for Notes' own "Insert a path…", adding a
 * second, notes-aware way to browse alongside this one. */
export default function FileExplorerModal({ title, list, initialPath, onPick, onClose, actions }: Props) {
  const [path, setPath] = useState(initialPath)
  const [entries, setEntries] = useState<ExplorerEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setEntries(null)
    setError(null)
    list(path).then(
      (result) => alive && setEntries(result),
      (e) => alive && setError(e instanceof Error ? e.message : String(e)),
    )
    return () => {
      alive = false
    }
  }, [list, path])

  const segments = path ? path.split('/') : []

  return (
    <Modal title={title} actions={actions} onClose={onClose}>
      <div className="breadcrumbs">
        <button className="link-button" onClick={() => setPath('')}>
          /
        </button>
        {segments.map((segment, i) => (
          <span key={i}>
            <span className="crumb-sep">/</span>
            <button className="link-button" onClick={() => setPath(segments.slice(0, i + 1).join('/'))}>
              {segment}
            </button>
          </span>
        ))}
      </div>
      {error && <div className="error-banner">{error}</div>}
      <ul className="picker-list">
        {entries === null && !error && <li className="muted">Loading…</li>}
        {entries?.length === 0 && <li className="muted">This folder is empty.</li>}
        {entries?.map((entry) => (
          <li key={entry.name}>
            {entry.isDirectory ? (
              <button className="link-button entry-name" onClick={() => setPath(joinPath(path, entry.name))}>
                <Folder size={15} strokeWidth={2} aria-hidden="true" /> {entry.name}
              </button>
            ) : (
              <button className="link-button entry-name" onClick={() => onPick(joinPath(path, entry.name))}>
                <FileIcon size={15} strokeWidth={2} aria-hidden="true" /> {entry.name}
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <IconButton icon={Folder} label="Up a folder" onClick={() => setPath(parentOf(path))} disabled={!path} />
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}
