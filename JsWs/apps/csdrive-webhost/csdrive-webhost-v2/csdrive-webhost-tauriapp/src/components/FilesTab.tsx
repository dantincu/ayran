import { useCallback, useEffect, useRef, useState } from 'react'
import { confirm } from '@tauri-apps/plugin-dialog'
import { exportToDevice, isMobile, pickFilesFromDevice } from '../lib/platform'
import {
  Copy,
  Download,
  ExternalLink,
  File,
  FilePlus,
  Folder,
  FolderPlus,
  Pencil,
  RefreshCw,
  Rocket,
  Save,
  Scissors,
  Trash2,
  Upload,
  X,
  ClipboardPaste,
} from 'lucide-react'
import IconButton from './IconButton'
import Modal from './Modal'
import Pagination from './Pagination'
import { TagList } from './Tags'
import { getAppState, setAppState } from '../lib/appState'
import { DEFAULT_PAGE_SIZE, getGlobalPageSize, setGlobalPageSize } from '../lib/listPageSize'
import { getDeployableAppHtml, listDeployableApps, type DeployableAppInfo } from '../lib/deployableApps'
import { joinRelative } from '../lib/localFs'
import {
  copyRootPath,
  forgetRoot,
  type FileRoot,
  getUserRoot,
  listRootDir,
  loadSavedRoots,
  mkdirRoot,
  pickNewRoot,
  readRootFile,
  readRootTextFile,
  removeRootPath,
  renameRootPath,
  type RootEntry,
  rootPathExists,
  statRootPath,
  uniqueRootName,
  USER_ROOT_ID,
  writeRootFile,
  writeRootTextFile,
} from '../lib/fileRoots'
import { rootTagGuid } from '../lib/rootTags'
import { listTags, openNewSecondaryWindow, type TagRecord } from '../lib/secondaryWindows'

function isHtmlFile(name: string): boolean {
  return /\.html?$/i.test(name)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

type EntryRow = RootEntry

interface ClipboardItem {
  rootId: string
  mode: 'copy' | 'cut'
  sourcePath: string
  name: string
  isDirectory: boolean
}

function isSameOrWithin(ancestor: string, candidate: string): boolean {
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`)
}

const LOCATION_KEY = 'filesTab.location'

interface SavedLocation {
  rootId: string
  path: string
}

function DeployAppsModal({
  apps,
  onPick,
  onClose,
}: {
  apps: DeployableAppInfo[]
  onPick: (app: DeployableAppInfo) => void
  onClose: () => void
}) {
  return (
    <Modal title="Deploy an app" onClose={onClose}>
      {apps.length === 0 ? (
        <div className="muted">No deployable apps available.</div>
      ) : (
        <ul className="deploy-apps-list">
          {apps.map((app) => (
            <li key={app.id}>
              <button className="link-button deploy-app-option" onClick={() => onPick(app)}>
                {app.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

function DeployFolderNameModal({
  app,
  existingNames,
  onConfirm,
  onClose,
}: {
  app: DeployableAppInfo
  existingNames: string[]
  onConfirm: (folderName: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState(app.defaultFolderName)
  const trimmed = name.trim()
  const conflict = trimmed !== '' && existingNames.some((n) => n.toLowerCase() === trimmed.toLowerCase())

  function submit() {
    if (!trimmed || conflict) return
    onConfirm(trimmed)
  }

  return (
    <Modal title={`Deploy "${app.name}"`} onClose={onClose}>
      <div className="modal-field-label">New folder name</div>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') onClose()
        }}
      />
      {conflict && <div className="error-banner">"{trimmed}" already exists here — pick a different name.</div>}
      <div className="toolbar-actions" style={{ justifyContent: 'flex-end' }}>
        <IconButton icon={Rocket} label="Deploy" disabled={!trimmed || conflict} onClick={submit} />
        <IconButton icon={X} label="Cancel" onClick={onClose} />
      </div>
    </Modal>
  )
}

export default function FilesTab() {
  const [roots, setRoots] = useState<FileRoot[]>([])
  const [activeRootId, setActiveRootId] = useState<string>(USER_ROOT_ID)
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<EntryRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ path: string; content: string; dirty: boolean } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [clipboard, setClipboard] = useState<ClipboardItem | null>(null)
  const [deployableApps, setDeployableApps] = useState<DeployableAppInfo[]>([])
  const [pickingAppToDeploy, setPickingAppToDeploy] = useState(false)
  const [deployingApp, setDeployingApp] = useState<DeployableAppInfo | null>(null)
  const [rootTags, setRootTags] = useState<TagRecord[]>([])
  const [hydrated, setHydrated] = useState(false)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE)

  useEffect(() => {
    ;(async () => {
      // Resolve both before touching state, so the root and the restored path land
      // in the same render — otherwise an intermediate render with the root but not
      // yet the restored path would kick off a wasted (and potentially racy) fetch.
      const root = await getUserRoot()
      // Folders picked in earlier sessions (Android remembers them; elsewhere they last one session).
      const savedRoots = await loadSavedRoots().catch(() => [])
      const saved = await getAppState<SavedLocation>(LOCATION_KEY)
      const savedPageSize = await getGlobalPageSize()
      const all = [root, ...savedRoots]
      setRoots(all)
      if (saved && typeof saved.path === 'string' && all.some((r) => r.id === saved.rootId)) {
        setActiveRootId(saved.rootId)
        setPath(saved.path)
      }
      setPageSizeState(savedPageSize)
      setHydrated(true)
    })()
  }, [])

  function setPageSize(size: number) {
    setPageSizeState(size)
    setGlobalPageSize(size)
    setPage(0)
  }

  useEffect(() => {
    setPage(0)
  }, [activeRootId, path])

  useEffect(() => {
    if (!hydrated) return
    setAppState<SavedLocation>(LOCATION_KEY, { rootId: activeRootId, path })
  }, [hydrated, activeRootId, path])

  const activeRoot = roots.find((r) => r.id === activeRootId)

  const refreshRootTags = useCallback(async () => {
    if (roots.length === 0) return
    try {
      setRootTags(await listTags(roots.map((r) => rootTagGuid(r.id))))
    } catch (e) {
      setError(String(e))
    }
  }, [roots])

  useEffect(() => {
    refreshRootTags()
  }, [refreshRootTags])

  // Guards against out-of-order responses: if the folder changes again before an
  // in-flight listing resolves, the stale response must not overwrite the newer one.
  const latestRequestRef = useRef(0)

  const refresh = useCallback(async () => {
    if (!activeRoot) return
    const requestId = ++latestRequestRef.current
    setLoading(true)
    setError(null)
    try {
      const list = await listRootDir(activeRoot, path)
      const withSizes = await Promise.all(
        list.map(async (e) => {
          // Some roots hand the size over with the listing, so it needs no further call.
          if (e.isDirectory || e.size !== undefined) return { ...e }
          try {
            const info = await statRootPath(activeRoot, joinRelative(path, e.name))
            return { ...e, size: info.size }
          } catch {
            return { ...e }
          }
        }),
      )
      if (requestId !== latestRequestRef.current) return
      setEntries(withSizes)
    } catch (e) {
      if (requestId === latestRequestRef.current) setError(String(e))
    } finally {
      if (requestId === latestRequestRef.current) setLoading(false)
    }
  }, [activeRoot, path])

  useEffect(() => {
    refresh()
  }, [refresh])

  const breadcrumbs = ['', ...path.split('/').filter(Boolean)]

  function switchRoot(id: string) {
    setActiveRootId(id)
    setPath('')
  }

  async function addRoot() {
    try {
      const root = await pickNewRoot()
      if (!root) return
      setRoots((prev) => (prev.some((r) => r.id === root.id) ? prev : [...prev, root]))
      switchRoot(root.id)
    } catch (e) {
      setError(String(e))
    }
  }

  async function removeRoot(root: FileRoot) {
    try {
      await forgetRoot(root)
    } catch (e) {
      setError(String(e))
      return
    }
    setRoots((prev) => prev.filter((r) => r.id !== root.id))
    if (activeRootId === root.id) switchRoot(USER_ROOT_ID)
  }

  async function openEntry(entry: EntryRow) {
    if (!activeRoot) return
    const rel = joinRelative(path, entry.name)
    if (entry.isDirectory) {
      setPath(rel)
      return
    }
    try {
      const content = await readRootTextFile(activeRoot, rel)
      setEditing({ path: rel, content, dirty: false })
    } catch (e) {
      setError(String(e))
    }
  }

  async function saveEditing() {
    if (!editing || !activeRoot) return
    try {
      await writeRootTextFile(activeRoot, editing.path, editing.content)
      setEditing({ ...editing, dirty: false })
      await refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  async function createFolder() {
    if (!activeRoot) return
    const name = window.prompt('New folder name:')
    if (!name) return
    try {
      await mkdirRoot(activeRoot, joinRelative(path, name))
      await refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  async function createFile() {
    if (!activeRoot) return
    const name = window.prompt('New file name:', 'untitled.txt')
    if (!name) return
    try {
      const rel = joinRelative(path, name)
      if (await rootPathExists(activeRoot, rel)) {
        setError(`"${name}" already exists.`)
        return
      }
      await writeRootTextFile(activeRoot, rel, '')
      await refresh()
      setEditing({ path: rel, content: '', dirty: false })
    } catch (e) {
      setError(String(e))
    }
  }

  async function deleteEntry(entry: EntryRow) {
    if (!activeRoot) return
    if (!(await confirm(`Delete "${entry.name}"? This cannot be undone.`))) return
    try {
      await removeRootPath(activeRoot, joinRelative(path, entry.name), entry.isDirectory)
      await refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  function startRename(entry: EntryRow) {
    setRenaming(entry.name)
    setRenameValue(entry.name)
  }

  async function commitRename(oldName: string) {
    if (!activeRoot) return
    const newName = renameValue.trim()
    setRenaming(null)
    if (!newName || newName === oldName) return
    try {
      await renameRootPath(activeRoot, joinRelative(path, oldName), joinRelative(path, newName))
      await refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  function copyEntry(entry: EntryRow) {
    if (!activeRoot) return
    setClipboard({
      rootId: activeRoot.id,
      mode: 'copy',
      sourcePath: joinRelative(path, entry.name),
      name: entry.name,
      isDirectory: entry.isDirectory,
    })
  }

  function cutEntry(entry: EntryRow) {
    if (!activeRoot) return
    setClipboard({
      rootId: activeRoot.id,
      mode: 'cut',
      sourcePath: joinRelative(path, entry.name),
      name: entry.name,
      isDirectory: entry.isDirectory,
    })
  }

  async function paste() {
    if (!clipboard || !activeRoot) return
    setError(null)
    try {
      if (clipboard.rootId !== activeRoot.id) {
        throw new Error('Copying or moving files between different root folders is not supported yet.')
      }
      if (clipboard.isDirectory && isSameOrWithin(clipboard.sourcePath, path)) {
        throw new Error('Cannot move or copy a folder into itself or one of its subfolders.')
      }

      if (clipboard.mode === 'cut') {
        const destPath = joinRelative(path, clipboard.name)
        if (destPath === clipboard.sourcePath) {
          setClipboard(null)
          return
        }
        const destName = (await rootPathExists(activeRoot, destPath))
          ? await uniqueRootName(activeRoot, path, clipboard.name)
          : clipboard.name
        await renameRootPath(activeRoot, clipboard.sourcePath, joinRelative(path, destName))
        setClipboard(null)
      } else {
        const destName = (await rootPathExists(activeRoot, joinRelative(path, clipboard.name)))
          ? await uniqueRootName(activeRoot, path, clipboard.name)
          : clipboard.name
        await copyRootPath(activeRoot, clipboard.sourcePath, joinRelative(path, destName))
      }
      await refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  async function uploadFiles() {
    if (!activeRoot) return
    try {
      const picked = await pickFilesFromDevice()
      for (const file of picked) {
        await writeRootFile(activeRoot, joinRelative(path, file.name), file.data)
      }
      if (picked.length) await refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  async function openAsWebApp(entry: EntryRow) {
    try {
      await openNewSecondaryWindow('user', joinRelative(path, entry.name))
    } catch (e) {
      setError(String(e))
    }
  }

  async function downloadEntry(entry: EntryRow) {
    if (!activeRoot) return
    try {
      const saved = await exportToDevice(entry.name, () => readRootFile(activeRoot, joinRelative(path, entry.name)))
      if (saved && isMobile) window.alert(`Saved to ${saved}`)
    } catch (e) {
      setError(String(e))
    }
  }

  async function openDeployApps() {
    try {
      setDeployableApps(await listDeployableApps())
      setPickingAppToDeploy(true)
    } catch (e) {
      setError(String(e))
    }
  }

  function pickAppToDeploy(app: DeployableAppInfo) {
    setPickingAppToDeploy(false)
    setDeployingApp(app)
  }

  async function deployApp(app: DeployableAppInfo, folderName: string) {
    if (!activeRoot) return
    try {
      const html = await getDeployableAppHtml(app.id)
      const folderPath = joinRelative(path, folderName)
      await mkdirRoot(activeRoot, folderPath)
      await writeRootTextFile(activeRoot, joinRelative(folderPath, 'index.html'), html)
      setDeployingApp(null)
      await refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const pagedEntries = entries.slice(currentPage * pageSize, (currentPage + 1) * pageSize)

  return (
    <div className="tab-panel files-tab">
      <div className="root-switcher">
        {roots.map((root) => (
          <div key={root.id} className="root-item">
            <span className={`root-pill ${root.id === activeRootId ? 'active' : ''}`}>
              <button className="link-button" onClick={() => switchRoot(root.id)} title={root.absolutePath || root.label}>
                <Folder size={14} strokeWidth={2} aria-hidden="true" /> {root.id === USER_ROOT_ID ? 'user' : root.label}
              </button>
              {root.id !== USER_ROOT_ID && (
                <button className="root-pill-remove" onClick={() => removeRoot(root)} title="Stop browsing this folder">
                  <X size={12} strokeWidth={2} aria-hidden="true" />
                </button>
              )}
            </span>
            <TagList
              guid={rootTagGuid(root.id)}
              tags={rootTags.filter((t) => t.guid === rootTagGuid(root.id))}
              className="root-item-tags"
              onChanged={refreshRootTags}
              onError={setError}
            />
          </div>
        ))}
        <IconButton icon={FolderPlus} label="Add root folder…" onClick={addRoot} />
      </div>

      <div className="toolbar">
        <div className="breadcrumbs">
          {breadcrumbs.map((seg, i) => {
            const target = breadcrumbs.slice(1, i + 1).join('/')
            return (
              <span key={i}>
                {i > 0 && <span className="crumb-sep">/</span>}
                <button className="link-button" onClick={() => setPath(target)}>
                  {i === 0 ? (activeRoot?.label ?? '') : seg}
                </button>
              </span>
            )
          })}
        </div>
        <div className="toolbar-actions">
          <IconButton icon={FilePlus} label="New file" onClick={createFile} />
          <IconButton icon={FolderPlus} label="New folder" onClick={createFolder} />
          <IconButton icon={Upload} label="Upload…" onClick={uploadFiles} />
          <IconButton icon={Rocket} label="Deploy apps…" onClick={openDeployApps} />
          {clipboard && (
            <IconButton icon={ClipboardPaste} label={`Paste "${clipboard.name}"`} onClick={paste} />
          )}
          <IconButton icon={RefreshCw} label="Refresh" onClick={refresh} />
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="muted">Loading…</div>}

      {!loading && (
        <table className="file-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Size</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  This folder is empty.
                </td>
              </tr>
            )}
            {pagedEntries.map((entry) => (
              <tr key={entry.name}>
                <td>
                  {renaming === entry.name ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => commitRename(entry.name)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(entry.name)
                        if (e.key === 'Escape') setRenaming(null)
                      }}
                    />
                  ) : (
                    <button className="link-button entry-name" onClick={() => openEntry(entry)}>
                      {entry.isDirectory ? (
                        <Folder size={15} strokeWidth={2} aria-hidden="true" />
                      ) : (
                        <File size={15} strokeWidth={2} aria-hidden="true" />
                      )}
                      {entry.name}
                    </button>
                  )}
                </td>
                <td className="muted">{!entry.isDirectory && entry.size != null ? formatBytes(entry.size) : ''}</td>
                <td className="row-actions">
                  {!entry.isDirectory && activeRootId === USER_ROOT_ID && isHtmlFile(entry.name) && (
                    <IconButton icon={ExternalLink} label="Open as web app" onClick={() => openAsWebApp(entry)} />
                  )}
                  {!entry.isDirectory && <IconButton icon={Download} label="Export" onClick={() => downloadEntry(entry)} />}
                  <IconButton icon={Copy} label="Copy" onClick={() => copyEntry(entry)} />
                  <IconButton icon={Scissors} label="Cut" onClick={() => cutEntry(entry)} />
                  <IconButton icon={Pencil} label="Rename" onClick={() => startRename(entry)} />
                  <IconButton icon={Trash2} label="Delete" variant="danger" onClick={() => deleteEntry(entry)} />
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

      {editing && (
        <div className="editor-overlay">
          <div className="editor-panel">
            <div className="editor-header">
              <strong>{editing.path}</strong>
              <div>
                <IconButton icon={Save} label="Save" onClick={saveEditing} disabled={!editing.dirty} />
                <IconButton icon={X} label="Close" onClick={() => setEditing(null)} />
              </div>
            </div>
            <textarea
              value={editing.content}
              onChange={(e) => setEditing({ ...editing, content: e.target.value, dirty: true })}
              spellCheck={false}
            />
          </div>
        </div>
      )}

      {pickingAppToDeploy && (
        <DeployAppsModal
          apps={deployableApps}
          onPick={pickAppToDeploy}
          onClose={() => setPickingAppToDeploy(false)}
        />
      )}

      {deployingApp && (
        <DeployFolderNameModal
          app={deployingApp}
          existingNames={entries.map((e) => e.name)}
          onConfirm={(folderName) => deployApp(deployingApp, folderName)}
          onClose={() => setDeployingApp(null)}
        />
      )}
    </div>
  )
}
