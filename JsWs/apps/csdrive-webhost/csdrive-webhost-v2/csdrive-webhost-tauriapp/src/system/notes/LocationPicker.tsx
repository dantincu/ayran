import { useEffect, useMemo, useState } from 'react'
import { Cloud, File as FileIcon, Folder, FolderPlus, TriangleAlert } from 'lucide-react'
import IconButton from '../../components/IconButton'
import Modal from '../../components/Modal'
import Pagination from '../../components/Pagination'
import { DEFAULT_PAGE_SIZE, getGlobalPageSize, setGlobalPageSize } from '../../lib/listPageSize'
import { pickNewRoot, type FileRoot } from '../../lib/fileRoots'
import { joinRelative } from '../../lib/localFs'
import { FILEN_PREFIX, LOCAL_PREFIX, type DirListing, type FilenAccountInfo, type FileSource } from './sources'
import { notebookFilesIn, readNotebookFile, resolveSource, type NotebookEntry } from './notebooks'
import { isNotebookFileName } from './notebookFile'

/** What the person chose: a folder of a source — and, when a notebook file was asked for, the file in it. */
export interface Picked {
  source: FileSource
  folder: string
  fileName: string | null
}

interface Props {
  /** `folder`: a folder is chosen (for a notebook's root); `notebook`: a notebook file is (the folder it is in is then its root). */
  mode: 'folder' | 'notebook'
  title: string
  roots: FileRoot[]
  accounts: FilenAccountInfo[]
  /** A folder of this device was added to the list of folders. */
  onAddRoot: (root: FileRoot) => void
  /** The notebooks the app already lists — the ones among the files shown are marked. */
  listed: NotebookEntry[]
  initial?: { sourceId: string; path: string }
  onPick: (picked: Picked) => void
  onCancel: () => void
}

/** What the picker knows of a notebook file it lists: whose it is, and whether the app lists it already. */
interface FileInfo {
  title: string | null
  guid: string | null
  problem: string | null
}

/** A dialog for choosing where: a folder of this device or of a Filen account, browsed like the file manager does — and
 * folders can be made in it. It marks the notebook files it shows (with their title, and whether the app lists them), so
 * that a notebook that is only *found* on a disk or in Filen is told apart from one that is *listed*. */
export default function LocationPicker({ mode, title, roots, accounts, onAddRoot, listed, initial, onPick, onCancel }: Props) {
  const [sourceId, setSourceId] = useState(initial?.sourceId ?? `${LOCAL_PREFIX}user`)
  const [path, setPath] = useState(initial?.path ?? '')
  const [listing, setListing] = useState<DirListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE)
  const [infos, setInfos] = useState<Record<string, FileInfo>>({})
  const [newFolder, setNewFolder] = useState<string | null>(null)

  useEffect(() => {
    getGlobalPageSize().then(setPageSizeState, () => {})
  }, [])

  const source = useMemo(() => resolveSource(sourceId, roots, accounts), [sourceId, roots, accounts])

  useEffect(() => {
    if (!source) {
      setListing(null)
      return
    }
    let alive = true
    setLoading(true)
    setError(null)
    source.list(path).then(
      (result) => {
        if (!alive) return
        setListing(result)
        setPage(0)
        setLoading(false)
      },
      (e) => {
        if (!alive) return
        setListing(null)
        setError(String(e))
        setLoading(false)
      },
    )
    return () => {
      alive = false
    }
  }, [source, path])

  const entries = listing?.entries ?? []
  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const shown = entries.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
  const notebookFiles = notebookFilesIn(entries)

  // What the notebook files on this page hold — read as they come on screen (they are small).
  useEffect(() => {
    if (!source) return
    let alive = true
    for (const entry of shown) {
      if (entry.isDirectory || !isNotebookFileName(entry.name)) continue
      const key = `${source.viewKey}|${path}|${entry.name}`
      if (infos[key]) continue
      readNotebookFile(source, path, entry.name).then(
        (read) => alive && setInfos((all) => ({ ...all, [key]: read.ok ? { title: read.notebook.Title, guid: read.guid, problem: null } : { title: null, guid: null, problem: read.reason } })),
        (e) => alive && setInfos((all) => ({ ...all, [key]: { title: null, guid: null, problem: String(e) } })),
      )
    }
    return () => {
      alive = false
    }
  }, [source, path, listing, currentPage, pageSize])

  const infoOf = (name: string): FileInfo | undefined => (source ? infos[`${source.viewKey}|${path}|${name}`] : undefined)
  const listedAs = (name: string, info: FileInfo | undefined): NotebookEntry | undefined =>
    listed.find((n) => (info?.guid && n.guid === info.guid) || (n.sourceId === sourceId && n.folder === path && n.fileName === name))

  function go(next: string) {
    setNewFolder(null)
    setPath(next)
  }

  function chooseSource(id: string) {
    setNewFolder(null)
    setSourceId(id)
    setPath('')
  }

  async function addFolder() {
    try {
      const root = await pickNewRoot()
      if (!root) return
      onAddRoot(root)
      chooseSource(`${LOCAL_PREFIX}${root.id}`)
    } catch (e) {
      setError(String(e))
    }
  }

  async function makeFolder() {
    const name = (newFolder ?? '').trim()
    if (!source || !name) return
    if (/[\\/]/.test(name)) {
      setError('A folder name can\'t contain / or \\.')
      return
    }
    try {
      await source.mkdir(joinRelative(path, name))
      setNewFolder(null)
      go(joinRelative(path, name))
    } catch (e) {
      setError(String(e))
    }
  }

  const segments = path ? path.split('/') : []

  return (
    <Modal title={title} onClose={onCancel}>
      <div className="picker">
        <div className="root-switcher">
          {roots.map((root) => {
            const id = `${LOCAL_PREFIX}${root.id}`
            return (
              <span key={id} className={`root-pill ${id === sourceId ? 'active' : ''}`}>
                <button className="link-button" onClick={() => chooseSource(id)} title={root.label}>
                  <Folder size={14} strokeWidth={2} aria-hidden="true" /> {root.label}
                </button>
              </span>
            )
          })}
          <IconButton icon={FolderPlus} label="Add a folder of this device…" onClick={addFolder} />
          {accounts.map((a) => {
            const id = `${FILEN_PREFIX}${a.userId}`
            return (
              <span key={id} className={`root-pill ${id === sourceId ? 'active' : ''}`}>
                <button className="link-button" onClick={() => chooseSource(id)} title="Filen account">
                  <Cloud size={14} strokeWidth={2} aria-hidden="true" /> {a.email}
                </button>
              </span>
            )
          })}
        </div>

        {source && (
          <div className="breadcrumbs">
            <button className="link-button" onClick={() => go('')}>
              {source.label}
            </button>
            {segments.map((segment, i) => (
              <span key={i}>
                <span className="crumb-sep">/</span>
                <button className="link-button" onClick={() => go(segments.slice(0, i + 1).join('/'))}>
                  {segment}
                </button>
              </span>
            ))}
          </div>
        )}

        {error && <div className="error-banner">{error}</div>}

        {mode === 'folder' && notebookFiles.length > 0 && (
          <div className="warning-banner">
            <TriangleAlert size={15} aria-hidden="true" /> This folder already holds a notebook ({notebookFiles.join(', ')}). A notebook's notes live in its root folder, so a
            second one here would share them.
          </div>
        )}

        <ul className="picker-list">
          {loading && <li className="muted">Loading…</li>}
          {!loading && listing && entries.length === 0 && <li className="muted">This folder is empty.</li>}
          {!loading &&
            shown.map((entry) => {
              if (entry.isDirectory) {
                return (
                  <li key={entry.name}>
                    <button className="link-button entry-name" onClick={() => go(joinRelative(path, entry.name))}>
                      <Folder size={15} strokeWidth={2} aria-hidden="true" /> {entry.name}
                    </button>
                  </li>
                )
              }
              const isNotebook = isNotebookFileName(entry.name)
              const info = isNotebook ? infoOf(entry.name) : undefined
              const inList = isNotebook ? listedAs(entry.name, info) : undefined
              const badges = isNotebook && (
                <>
                  {info?.title && <span className="notes-badge notes-badge-notebook" title="The notebook's title">{info.title}</span>}
                  {info?.problem && <span className="notes-badge notes-badge-delete" title={info.problem}>not a valid notebook file</span>}
                  {info && !info.problem && (
                    <span className={`notes-badge ${inList ? 'notes-badge-listed' : ''}`} title={inList ? `Listed as "${inList.title}"` : 'It exists here, but the app has not been told about it'}>
                      {inList ? 'in your list' : 'not in your list yet'}
                    </span>
                  )}
                </>
              )
              if (mode === 'notebook' && isNotebook) {
                return (
                  <li key={entry.name}>
                    <button className="link-button entry-name" onClick={() => source && onPick({ source, folder: path, fileName: entry.name })}>
                      <FileIcon size={15} strokeWidth={2} aria-hidden="true" /> {entry.name}
                      {badges}
                    </button>
                  </li>
                )
              }
              return (
                <li key={entry.name} className={isNotebook ? '' : 'muted'}>
                  <span className="entry-name">
                    <FileIcon size={15} strokeWidth={2} aria-hidden="true" /> {entry.name}
                    {badges}
                  </span>
                </li>
              )
            })}
        </ul>

        <Pagination
          page={currentPage}
          pageSize={pageSize}
          totalItems={entries.length}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSizeState(size)
            setGlobalPageSize(size).catch(() => {})
          }}
        />

        {newFolder !== null && (
          <form
            className="notes-panel-row"
            onSubmit={(e) => {
              e.preventDefault()
              makeFolder()
            }}
          >
            <input autoFocus value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="Name of the new folder" aria-label="Name of the new folder" />
            <button type="submit" disabled={!newFolder.trim()}>
              Create
            </button>
            <button type="button" onClick={() => setNewFolder(null)}>
              Cancel
            </button>
          </form>
        )}

        <div className="dialog-actions picker-footer">
          {mode === 'folder' ? (
            <>
              <span className="muted picker-info">
                {listing ? (entries.length === 0 ? 'This folder is empty.' : `This folder has ${entries.length} item${entries.length === 1 ? '' : 's'}.`) : ''}
              </span>
              <button type="button" onClick={() => setNewFolder(newFolder === null ? '' : null)} disabled={!source}>
                New folder…
              </button>
              <button type="button" onClick={onCancel}>
                Cancel
              </button>
              <button type="button" className="primary" disabled={!source || !listing} onClick={() => source && onPick({ source, folder: path, fileName: null })}>
                Use this folder
              </button>
            </>
          ) : (
            <>
              <span className="muted picker-info">Pick a file whose name ends with [note-book].json.</span>
              <button type="button" onClick={onCancel}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
