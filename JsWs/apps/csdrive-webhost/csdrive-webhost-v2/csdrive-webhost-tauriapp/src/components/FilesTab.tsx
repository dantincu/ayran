import { useCallback, useEffect, useRef, useState } from 'react'
import { confirm } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { exportPathToDevice, isMobile, pickDeviceFiles } from '../lib/platform'
import {
  Copy,
  Download,
  ExternalLink,
  File,
  FilePlus,
  Folder,
  FolderPlus,
  Info,
  Navigation,
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
import RowActions from './RowActions'
import CodeEditor from './CodeEditor'
import EditorPanel from './EditorPanel'
import DetailsModal, { type DetailField } from './DetailsModal'
import GoToPathModal from './GoToPathModal'
import Modal from './Modal'
import Pagination from './Pagination'
import { TagList } from './Tags'
import { getAppState, setAppState } from '../lib/appState'
import { offsetOfPage, pageOfOffset, validOffset } from '../lib/pagedPosition'
import { kbdItem, useListKeyboard } from '../lib/keyboard'
import { DEFAULT_PAGE_SIZE, getGlobalPageSize, setGlobalPageSize } from '../lib/listPageSize'
import { getDeployableAppHtml, listDeployableApps, type DeployableAppInfo } from '../lib/deployableApps'
import { joinRelative } from '../lib/localFs'
import { formatBytesExact } from '../lib/format'
import { pathForInput } from '../lib/pathInput'
import type { FileInfo } from '../lib/fs'
import {
  copyRootPath,
  forgetRoot,
  type FileRoot,
  getUserRoot,
  listRootDir,
  loadSavedRoots,
  realPathOf,
  mkdirRoot,
  pickNewRoot,
  readRootTextFile,
  removeRootPath,
  renameRootPath,
  type RootEntry,
  rootPathExists,
  statRootPath,
  uniqueRootName,
  USER_ROOT_ID,
  writeRootFileFrom,
  writeRootTextFile,
} from '../lib/fileRoots'
import { rootTagGuid } from '../lib/rootTags'
import { contextTrigger } from './ContextMenu'
import { listTags, notifyFileSaved, openNewSecondaryWindow, openWebAddress, type TagRecord } from '../lib/secondaryWindows'
import { isNoteQuery, resolveLinkedPath, type LinkHit } from '../lib/textLinks'

/** A file that can be opened as a web app: a page, or a markdown document (rendered to a page by the backend). */
function isHtmlFile(name: string): boolean {
  return /\.(html?|md|markdown)$/i.test(name)
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

/** What the details popup is about: an entry of the folder, the folder itself, or a root (whose tags are edited there). */
type Details =
  | { kind: 'entry'; entry: EntryRow; info: FileInfo | null }
  | { kind: 'here'; info: FileInfo | null }
  | { kind: 'root'; root: FileRoot }

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
  /** How many records of the folder's listing were skipped (see lib/pagedPosition.ts) — not a page number. */
  offset?: number
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
  // The sizes of the files on the pages shown so far, by name (the listing itself doesn't carry them).
  const [sizes, setSizes] = useState<Record<string, number>>({})
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
  const [details, setDetails] = useState<Details | null>(null)
  const [goingTo, setGoingTo] = useState(false)
  // Where each root really is, for its tooltip — the admin-app may ask; nothing else may.
  const [rootPaths, setRootPaths] = useState<Record<string, string>>({})
  const [hydrated, setHydrated] = useState(false)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE)
  // The item the arrow keys are on (an index into all the entries, not just the page shown), and — for a
  // move made with the keys — which item of the folder that opens to start from.
  const [kbdFocus, setKbdFocus] = useState(-1)
  const pendingFocusRef = useRef<string | 'first' | null>(null)
  // The folder was restored from the last visit and hasn't been listed yet: if it can't be, go to the
  // root's top instead of showing an error about somewhere the person never asked to be.
  const restoredPathRef = useRef(false)
  // The position in the folder's listing, restored from the last visit once the listing is there; until
  // then nothing is saved over it (the page would still say 0).
  const restoredOffsetRef = useRef<number | null>(null)
  const [restoringPage, setRestoringPage] = useState(false)
  const pageSizeRef = useRef(pageSize)
  pageSizeRef.current = pageSize

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
        restoredPathRef.current = saved.path !== ''
        restoredOffsetRef.current = validOffset(saved.offset)
        setRestoringPage(restoredOffsetRef.current !== null)
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
    if (restoringPage) return
    setAppState<SavedLocation>(LOCATION_KEY, { rootId: activeRootId, path, offset: offsetOfPage(page, pageSize) })
  }, [hydrated, activeRootId, path, page, pageSize, restoringPage])

  useEffect(() => {
    let cancelled = false
    Promise.all(roots.map(async (r) => [r.id, await realPathOf(r)] as const)).then((pairs) => {
      if (!cancelled) setRootPaths(Object.fromEntries(pairs.filter((p): p is [string, string] => p[1] !== null)))
    })
    return () => {
      cancelled = true
    }
  }, [roots])

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
      if (requestId !== latestRequestRef.current) return
      restoredPathRef.current = false
      // Only the names come with the listing: a size is asked for the entries of the page on screen (below), never for a
      // whole folder — a folder of a hundred thousand files would otherwise be a hundred thousand calls before it showed.
      setSizes({})
      setEntries(list)
      if (restoredOffsetRef.current !== null) {
        setPage(pageOfOffset(restoredOffsetRef.current, pageSizeRef.current)) // the page that holds the record it was at
        restoredOffsetRef.current = null
        setRestoringPage(false)
      }
    } catch (e) {
      if (requestId === latestRequestRef.current) {
        restoredOffsetRef.current = null // the folder isn't there (or can't be read): its position means nothing
        setRestoringPage(false)
        if (restoredPathRef.current && path !== '') {
          restoredPathRef.current = false
          setPath('')
        } else {
          setError(String(e))
        }
      }
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

  async function openEntry(entry: EntryRow, at?: string) {
    if (!activeRoot) return
    const rel = at ?? joinRelative(path, entry.name)
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
      // Web apps that show the file reload.
      notifyFileSaved({ storage: activeRoot.id === USER_ROOT_ID ? 'UserFolder' : 'DeviceFolder', root: activeRoot.id, path: editing.path }).catch(() => {})
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
      const picked = await pickDeviceFiles()
      for (const file of picked) {
        await writeRootFileFrom(activeRoot, joinRelative(path, file.name), file)
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
      const saved = await exportPathToDevice(entry.name, (token) =>
        invoke<string>('export_local_file', { root: activeRoot.id, path: joinRelative(path, entry.name), name: entry.name, token }),
      )
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

  // The sizes of the page on screen.
  useEffect(() => {
    if (!activeRoot || loading) return
    const wanted = pagedEntries.filter((e) => !e.isDirectory && e.size === undefined && sizes[e.name] === undefined)
    if (wanted.length === 0) return
    let cancelled = false
    Promise.all(
      wanted.map(async (e) => {
        try {
          return [e.name, (await statRootPath(activeRoot, joinRelative(path, e.name))).size] as const
        } catch {
          return null
        }
      }),
    ).then((found) => {
      if (cancelled) return
      const got = found.filter((f): f is readonly [string, number] => f !== null)
      if (got.length > 0) setSizes((current) => ({ ...current, ...Object.fromEntries(got) }))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoot, path, loading, currentPage, pageSize, entries])

  // ── Keyboard ──

  // A new folder: nothing is focused until a key is pressed — unless the folder was entered with the
  // keys, which then start at its first item (or, going up, at the folder just left).
  useEffect(() => {
    setKbdFocus(-1)
  }, [activeRootId, path])
  useEffect(() => {
    const pending = pendingFocusRef.current
    if (pending === null || loading) return
    pendingFocusRef.current = null
    setKbdFocus(pending === 'first' ? (entries.length > 0 ? 0 : -1) : Math.max(0, entries.findIndex((e) => e.name === pending)))
  }, [entries, loading])
  // The page shown follows the focus.
  useEffect(() => {
    if (kbdFocus >= 0) setPage(Math.floor(kbdFocus / pageSize))
  }, [kbdFocus, pageSize])

  useListKeyboard({
    count: entries.length,
    focused: kbdFocus,
    setFocused: setKbdFocus,
    pageSize,
    page: currentPage,
    onOpen: (i) => {
      const entry = entries[i]
      if (!entry) return
      pendingFocusRef.current = entry.isDirectory ? 'first' : null
      openEntry(entry)
    },
    onParent: () => {
      if (path === '') return
      const cut = path.lastIndexOf('/')
      pendingFocusRef.current = path.slice(cut + 1)
      setPath(cut < 0 ? '' : path.slice(0, cut))
    },
  })

  /** Opens the details of an entry, of the folder shown or of a root; what the file system says about the first two (its
   * date) is asked for and fills in when it arrives. */
  async function showDetails(target: { kind: 'entry'; entry: EntryRow } | { kind: 'here' } | { kind: 'root'; root: FileRoot }) {
    if (target.kind === 'root') {
      setDetails(target)
      return
    }
    if (!activeRoot) return
    const rel = target.kind === 'entry' ? joinRelative(path, target.entry.name) : path
    const opened: Details = { ...target, info: null }
    setDetails(opened)
    try {
      const info = await statRootPath(activeRoot, rel)
      setDetails((current) => (current === opened ? { ...opened, info } : current))
    } catch {
      // no date, then: what the listing already said is shown
    }
  }

  /** The guid of the root whose details are open (asked of the backend, which keeps it). */
  const [rootGuidShown, setRootGuidShown] = useState<{ root: string; guid: string } | null>(null)
  useEffect(() => {
    if (details?.kind !== 'root') return
    const id = details.root.id
    let cancelled = false
    invoke<string>('root_guid', { root: id }).then((guid) => !cancelled && setRootGuidShown({ root: id, guid }), () => {})
    return () => {
      cancelled = true
    }
  }, [details])

  function detailFields(): { title: string; fields: DetailField[] } | null {
    if (!details) return null
    if (details.kind === 'root') {
      const root = details.root
      const where = rootPaths[root.id]
      return {
        title: root.id === USER_ROOT_ID ? 'The user folder' : `Folder "${root.label}"`,
        fields: [
          { label: 'Name', value: root.id === USER_ROOT_ID ? 'user' : root.label },
          { label: 'Root identifier', value: root.id, mono: true },
          ...(rootGuidShown?.root === root.id ? [{ label: 'Guid', value: rootGuidShown.guid, mono: true }] : []),
          ...(where ? [{ label: 'Location on this device', value: where, mono: true }] : []),
        ],
      }
    }
    const rel = details.kind === 'entry' ? joinRelative(path, details.entry.name) : path
    const isDirectory = details.kind === 'entry' ? details.entry.isDirectory : true
    const name = details.kind === 'entry' ? details.entry.name : (rel.split('/').pop() || activeRoot?.label || '')
    const info = details.info
    const size = info && !isDirectory ? info.size : details.kind === 'entry' ? (details.entry.size ?? sizes[details.entry.name]) : undefined
    const base = activeRoot ? rootPaths[activeRoot.id] : undefined
    const sep = base?.includes('\\') ? '\\' : '/'
    const fields: DetailField[] = [
      { label: 'Name', value: name },
      { label: 'Kind', value: details.kind === 'entry' && details.entry.isSymlink ? 'Link' : isDirectory ? 'Folder' : 'File', copy: false },
      { label: 'Path', value: pathForInput(rel), mono: true },
      { label: 'In', value: activeRoot ? (activeRoot.id === USER_ROOT_ID ? 'user' : activeRoot.label) : '' },
    ]
    if (base) fields.push({ label: 'Location on this device', value: rel === '' ? base : base.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep), mono: true })
    if (size !== undefined) fields.push({ label: 'Size', value: formatBytesExact(size) })
    if (info?.mtimeMs != null) fields.push({ label: 'Modified', value: new Date(info.mtimeMs).toLocaleString() })
    return { title: isDirectory ? 'Folder' : 'File', fields }
  }

  /** "Go to a path": a folder of this root — or a file, whose folder is opened with the file focused. */
  async function goToPath(segments: string[], query: string | null = null): Promise<string | null> {
    if (!activeRoot) return 'No folder is open.'
    if (isNoteQuery(query)) return "A note's address is opened in the Notes app."
    const rel = segments.join('/')
    if (rel === '') {
      setPath('')
      return null
    }
    let info: FileInfo
    try {
      info = await statRootPath(activeRoot, rel)
    } catch {
      return `There is nothing at ${pathForInput(rel)} in ${activeRoot.id === USER_ROOT_ID ? 'the user folder' : activeRoot.label}.`
    }
    if (info.isDirectory) {
      setPath(rel)
    } else {
      // A file: the view its own kind has — the editor — in its folder.
      const cut = rel.lastIndexOf('/')
      const folder = cut < 0 ? '' : rel.slice(0, cut)
      setPath(folder)
      await openEntry({ name: rel.slice(cut + 1), isDirectory: false, isFile: true, isSymlink: false }, rel)
    }
    return null
  }

  const shownDetails = detailFields()

  /** "Open link" in the editor: a web address goes to the OS browser (after the person agrees); a path — relative to the
   * file, or absolute from the root — opens its folder, or the file in the editor. What the editor holds must be saved first:
   * the linked file replaces it. */
  async function openLinkFromEditor(link: LinkHit) {
    if (!editing || !activeRoot) return
    if (link.kind === 'web') {
      await openWebAddress(link.target)
      return
    }
    const target = resolveLinkedPath(editing.path, link.target)
    if (!target) throw new Error('That path leaves the folder.')
    if (isNoteQuery(target.query)) throw new Error("Notes can't be opened from a link yet.")
    let info: FileInfo
    try {
      info = target.path === '' ? { isFile: false, isDirectory: true, isSymlink: false, size: 0, mtimeMs: null } : await statRootPath(activeRoot, target.path)
    } catch {
      throw new Error(`There is nothing at ${pathForInput(target.path)}.`)
    }
    if (editing.dirty) throw new Error('Save the changes first — the linked file takes this one\'s place in the editor.')
    setEditing(null)
    if (info.isDirectory) {
      setPath(target.path)
    } else {
      const cut = target.path.lastIndexOf('/')
      setPath(cut < 0 ? '' : target.path.slice(0, cut))
      await openEntry({ name: target.path.slice(cut + 1), isDirectory: false, isFile: true, isSymlink: false }, target.path)
    }
  }

  return (
    <div className="tab-panel files-tab">
      <div className="root-switcher">
        {roots.map((root) => (
          <div key={root.id} className="root-item">
            <span className={`root-pill ${root.id === activeRootId ? 'active' : ''}`} {...contextTrigger(() => showDetails({ kind: 'root', root }))}>
              <button className="link-button" onClick={() => switchRoot(root.id)} title={rootPaths[root.id] ?? root.label}>
                <Folder size={14} strokeWidth={2} aria-hidden="true" /> {root.id === USER_ROOT_ID ? 'user' : root.label}
              </button>
              <button className="root-pill-remove" onClick={() => showDetails({ kind: 'root', root })} title="Details — and tags">
                <Info size={12} strokeWidth={2} aria-hidden="true" />
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
          <IconButton icon={Navigation} label="Go to a path…" onClick={() => setGoingTo(true)} />
          <IconButton icon={Info} label="Details of this folder" onClick={() => showDetails({ kind: 'here' })} />
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
            {pagedEntries.map((entry, i) => (
              <tr key={entry.name} {...kbdItem(kbdFocus, currentPage * pageSize + i, setKbdFocus)}>
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
                <td className="muted">{!entry.isDirectory && (entry.size ?? sizes[entry.name]) != null ? formatBytes((entry.size ?? sizes[entry.name])!) : ''}</td>
                <td className="row-actions">
                  <RowActions
                    actions={[
                      { icon: Info, label: 'Details', onClick: () => showDetails({ kind: 'entry', entry }) },
                      ...(!entry.isDirectory && activeRootId === USER_ROOT_ID && isHtmlFile(entry.name)
                        ? [{ icon: ExternalLink, label: 'Open as web app', onClick: () => openAsWebApp(entry) }]
                        : []),
                      ...(!entry.isDirectory ? [{ icon: Download, label: 'Export', onClick: () => downloadEntry(entry) }] : []),
                      { icon: Copy, label: 'Copy', onClick: () => copyEntry(entry) },
                      { icon: Scissors, label: 'Cut', onClick: () => cutEntry(entry) },
                      { icon: Pencil, label: 'Rename', onClick: () => startRename(entry) },
                      { icon: Trash2, label: 'Delete', danger: true, onClick: () => deleteEntry(entry) },
                    ]}
                  />
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
        <EditorPanel
          title={editing.path}
          actions={<IconButton icon={Save} label="Save" onClick={saveEditing} disabled={!editing.dirty} />}
          onClose={() => setEditing(null)}
        >
          <CodeEditor
            value={editing.content}
            fileName={editing.path}
            onChange={(content) => setEditing({ ...editing, content, dirty: true })}
            onOpenLink={openLinkFromEditor}
          />
        </EditorPanel>
      )}

      {shownDetails && details && (
        <DetailsModal
          title={shownDetails.title}
          fields={shownDetails.fields}
          tags={details.kind === 'root' ? { guid: rootTagGuid(details.root.id), tags: rootTags.filter((t) => t.guid === rootTagGuid(details.root.id)), onChanged: refreshRootTags } : undefined}
          onClose={() => setDetails(null)}
          onError={setError}
        />
      )}

      {goingTo && (
        <GoToPathModal
          current={pathForInput(path)}
          hint={`A path in ${activeRoot?.id === USER_ROOT_ID ? 'the user folder' : (activeRoot?.label ?? 'this folder')} — /folder/subfolder`}
          onGo={goToPath}
          onClose={() => setGoingTo(false)}
        />
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
