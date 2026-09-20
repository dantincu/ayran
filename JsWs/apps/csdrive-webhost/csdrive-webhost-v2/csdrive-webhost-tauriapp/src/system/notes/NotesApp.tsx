import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { confirm } from '@tauri-apps/plugin-dialog'
import {
  ClipboardPaste,
  Cloud,
  CloudOff,
  Copy,
  Download,
  Eraser,
  File as FileIcon,
  FileCheck,
  FilePlus,
  Folder,
  FolderPlus,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  AppWindow,
  ListChecks,
  Lock,
  Pencil,
  RefreshCw,
  Save,
  Scissors,
  Trash2,
  Undo2,
  Unlock,
  Upload,
  X,
} from 'lucide-react'
import IconButton from '../../components/IconButton'
import Modal from '../../components/Modal'
import Pagination from '../../components/Pagination'
import { exportPathToDevice, isMobile, pickDeviceFiles } from '../../lib/platform'
import { DEFAULT_PAGE_SIZE, getGlobalPageSize, setGlobalPageSize } from '../../lib/listPageSize'
import { joinRelative } from '../../lib/localFs'
import { forgetRoot, getUserRoot, loadSavedRoots, pickNewRoot, type FileRoot } from '../../lib/fileRoots'
import { listFilenAccounts } from '../../lib/filen'
import { getAppState, setAppState } from '../../lib/appState'
import { offsetOfPage, pageOfOffset } from '../../lib/pagedPosition'
import { kbdItem, useListKeyboard } from '../../lib/keyboard'
import {
  copyTree,
  filenCache,
  filenSource,
  FILEN_PREFIX,
  isSameOrWithin,
  LOCAL_PREFIX,
  localSource,
  uniqueName,
  type BranchChange,
  type BranchInfo,
  type CacheInfo,
  type DirListing,
  type Entry,
  type FileSource,
  type FileVersion,
  type FilenAccountInfo,
  type VersionCheck,
} from './sources'
import { decodeLocation, reportLocation, subscribeNavigate, type Location, type Tab } from './tabs'

const LAST_LOCATION_KEY = 'notes.lastLocation'
/** Unsaved text of files being edited, kept per tab so that it survives switching tabs and restarting the
 * app: tab guid → the draft. (Only while there is something unsaved; saved, discarded or closed, it goes.) */
const DRAFTS_KEY = 'notes.drafts'

interface Draft {
  sourceId: string
  branch: number | null
  path: string
  content: string
  version: FileVersion | null
}

/** A place without the file being edited: for a tab that names no place of its own, the last place is only
 * a fallback for where to be — not for what to be doing. */
const withoutEdit = (location: Location | null | undefined): Location | null => {
  if (!location) return null
  if (!location.edit) return location
  return { sourceId: location.sourceId, branch: location.branch, path: location.path, ...(location.offset ? { offset: location.offset } : {}) }
}
const MAX_BRANCH_NAME_CHARS = 100
/** Bigger than this isn't opened in the text editor (export it instead). */
const MAX_EDIT_BYTES = 2 * 1024 * 1024

/** How long cached Filen data stays valid — `null` never expires it, which makes it available offline. */
const INTERVAL_CHOICES: { secs: number | null; label: string }[] = [
  { secs: null, label: 'Never (available offline)' },
  { secs: 60, label: '1 minute' },
  { secs: 300, label: '5 minutes' },
  { secs: 900, label: '15 minutes' },
  { secs: 3600, label: '1 hour' },
  { secs: 6 * 3600, label: '6 hours' },
  { secs: 24 * 3600, label: '1 day' },
  { secs: 7 * 24 * 3600, label: '7 days' },
]

function intervalLabel(secs: number | null): string {
  return INTERVAL_CHOICES.find((c) => c.secs === secs)?.label ?? `${secs} seconds`
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

const formatTime = (ms: number) => new Date(ms).toLocaleString()

/** The file's text, or null if it isn't text (or is too big to edit here). */
function decodeText(bytes: Uint8Array): string | null {
  if (bytes.length > MAX_EDIT_BYTES || bytes.subarray(0, 8000).includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

interface Clipboard {
  source: FileSource
  mode: 'copy' | 'cut'
  path: string
  name: string
  isDirectory: boolean
}

interface Editing {
  /** Where the file is — kept, because switching tabs can change what the file manager shows. */
  source: FileSource
  path: string
  content: string
  dirty: boolean
  /** Filen: the version of the file that was opened (or saved last) — what is checked against Filen
   * before saving over it. `null` for a file that isn't one. */
  version: FileVersion | null
}

/** The folder a path is in (paths have no leading slash; the root is `''`). */
const parentPath = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

export default function NotesApp({ tab: initialTab, initial }: { tab: Tab | null; initial: Location | null }) {
  // The tab this page is showing: the one it registered as, then whichever the user switches to.
  const [tab, setTab] = useState<Tab | null>(initialTab)
  const [roots, setRoots] = useState<FileRoot[]>([])
  const [accounts, setAccounts] = useState<FilenAccountInfo[]>([])
  const [ready, setReady] = useState(false)

  const [sourceId, setSourceId] = useState(initial?.sourceId ?? `${LOCAL_PREFIX}user`)
  const [branch, setBranch] = useState<number | null>(initial?.branch ?? null)
  const [path, setPath] = useState(initial?.path ?? '')

  const [listing, setListing] = useState<DirListing | null>(null)
  const [meta, setMeta] = useState<Record<string, { size: number | null; mtimeMs: number | null }>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [page, setPage] = useState(0)
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE)

  const [cacheInfo, setCacheInfo] = useState<CacheInfo | null>(null)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [branchesLoaded, setBranchesLoaded] = useState(false)
  const [changes, setChanges] = useState<BranchChange[] | null>(null)

  const [editing, setEditing] = useState<Editing | null>(null)
  // The file a place says is being edited (path in the source), waiting for the source to be there to open it.
  const [editToRestore, setEditToRestore] = useState<string | null>(null)
  const editingRef = useRef<Editing | null>(null)
  editingRef.current = editing
  const tabRef = useRef<Tab | null>(initialTab)
  tabRef.current = tab
  // Filen has another version of the file being saved than the one being edited: what it found, until
  // the person has chosen what to do.
  const [conflict, setConflict] = useState<VersionCheck | null>(null)
  // The item the arrow keys are on (an index into all the entries), and which item of a folder that was
  // opened or left with the keys to start from.
  const [kbdFocus, setKbdFocus] = useState(-1)
  const pendingFocusRef = useRef<string | 'first' | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [clipboard, setClipboard] = useState<Clipboard | null>(null)

  // ── Sources ──

  // Where the person last was (the fallback for a tab that names no place), and — for a switch of tab
  // that arrives before the sources are loaded — the tab to show once they are.
  const lastRef = useRef<Location | null>(null)
  // The position in the listing (records skipped, see lib/pagedPosition.ts) to go to once it has loaded;
  // until then the place isn't reported, or it would be reported at the start of the folder.
  const restoredOffsetRef = useRef<number | null>(null)
  const [restoringPage, setRestoringPage] = useState(false)
  const pageSizeRef = useRef(DEFAULT_PAGE_SIZE)
  const loadedForRef = useRef<string | null>(null)
  const earlyNavigationRef = useRef<Tab | null>(null)
  const sourcesRef = useRef<{ roots: FileRoot[]; accounts: FilenAccountInfo[] } | null>(null)

  /** Shows `target` if its source still exists, otherwise the start of the user folder. */
  function showLocation(target: Location | null, allRoots: FileRoot[], filen: FilenAccountInfo[]) {
    const exists = (id: string) =>
      allRoots.some((r) => `${LOCAL_PREFIX}${r.id}` === id) || filen.some((a) => `${FILEN_PREFIX}${a.userId}` === id)
    restoredOffsetRef.current = null
    setRestoringPage(false)
    // The editor follows the place: a tab that was editing a file opens it again, any other closes it (what
    // was unsaved has been kept as a draft — see flushDraft).
    setEditToRestore(target && exists(target.sourceId) ? (target.edit ?? null) : null)
    if (!target?.edit) setEditing(null)
    if (target && exists(target.sourceId)) {
      setSourceId(target.sourceId)
      setBranch(target.branch ?? null)
      setPath(target.path ?? '')
      // Where in the folder's listing it was, restored when the listing is there (see load).
      if (target.offset) {
        restoredOffsetRef.current = target.offset
        setRestoringPage(true)
      }
    } else {
      setSourceId(`${LOCAL_PREFIX}user`)
      setBranch(null)
      setPath('')
    }
  }

  useEffect(() => {
    ;(async () => {
      const [userRoot, saved, filen, savedPageSize, last] = await Promise.all([
        getUserRoot(),
        loadSavedRoots().catch(() => []),
        listFilenAccounts().catch(() => []),
        getGlobalPageSize().catch(() => DEFAULT_PAGE_SIZE),
        initial ? Promise.resolve(null) : getAppState<Location>(LAST_LOCATION_KEY).catch(() => null),
      ])
      lastRef.current = last ?? null
      const allRoots = [userRoot, ...saved]
      setRoots(allRoots)
      setAccounts(filen)
      setPageSizeState(savedPageSize)

      // Where to start: the tab the user switched to while this was loading, else the tab's own place,
      // else where the person last was — if it still exists.
      const early = earlyNavigationRef.current
      earlyNavigationRef.current = null
      if (early) setTab(early)
      sourcesRef.current = { roots: allRoots, accounts: filen }
      showLocation((early ? (decodeLocation(early.resourceId) ?? withoutEdit(last)) : (initial ?? withoutEdit(last))) ?? null, allRoots, filen)
      setReady(true)
    })()
  }, [])

  useEffect(() => {
    if (ready) sourcesRef.current = { roots, accounts }
  }, [ready, roots, accounts])

  // The user switched to another tab of this window: show its place, in place — no reload.
  useEffect(
    () =>
      subscribeNavigate((next) => {
        const sources = sourcesRef.current
        if (!sources) {
          earlyNavigationRef.current = next
          return
        }
        flushDraft() // the tab being left keeps what it hadn't saved
        setTab(next)
        showLocation(decodeLocation(next.resourceId) ?? withoutEdit(lastRef.current), sources.roots, sources.accounts)
      }),
    [],
  )

  const account = useMemo(() => accounts.find((a) => `${FILEN_PREFIX}${a.userId}` === sourceId) ?? null, [accounts, sourceId])
  const source = useMemo<FileSource | null>(() => {
    if (account) return filenSource(account, branch)
    const root = roots.find((r) => `${LOCAL_PREFIX}${r.id}` === sourceId)
    return root ? localSource(root) : null
  }, [account, branch, roots, sourceId])

  const currentBranch = branches.find((b) => b.index === branch) ?? null

  // ── Filen account settings and branches ──

  const reloadBranches = useCallback(async () => {
    if (!account) return
    try {
      setBranches(await filenCache.branches(account.userId))
      setBranchesLoaded(true)
    } catch (e) {
      setError(String(e))
    }
  }, [account])

  useEffect(() => {
    setCacheInfo(null)
    setBranches([])
    setBranchesLoaded(false)
    if (!account) return
    filenCache.account(account.userId).then(setCacheInfo, (e) => setError(String(e)))
    reloadBranches()
  }, [account, reloadBranches])

  // A branch that no longer exists (committed or discarded elsewhere) is left.
  useEffect(() => {
    if (branch !== null && account && branchesLoaded && !branches.some((b) => b.index === branch)) setBranch(null)
  }, [branch, branches, branchesLoaded, account])

  // ── Listing ──

  const latestRequest = useRef(0)

  const load = useCallback(
    async (force: boolean) => {
      if (!source) return
      const requestId = ++latestRequest.current
      setLoading(true)
      setError(null)
      try {
        const result = await source.list(path, force)
        if (requestId !== latestRequest.current) return
        setListing(result)
        setMeta({})
        loadedForRef.current = `${source.viewKey}|${path}` // (an effect below then applies a restored position)
      } catch (e) {
        if (requestId !== latestRequest.current) return
        restoredOffsetRef.current = null
        setRestoringPage(false)
        setListing(null)
        setError(String(e))
      } finally {
        if (requestId === latestRequest.current) setLoading(false)
      }
    },
    [source, path],
  )

  useEffect(() => {
    if (ready) load(false)
  }, [ready, load])

  useEffect(() => {
    setPage(0)
  }, [sourceId, branch, path])

  const entries = listing?.entries ?? []
  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const pagedEntries = entries.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
  pageSizeRef.current = pageSize

  // Tell the window manager (and the address, and next start) where we are — including how far into the
  // folder's listing, as the number of records skipped so it means the same under any page size.
  useEffect(() => {
    if (!ready || !source || restoringPage) return
    const location: Location = {
      sourceId,
      branch,
      path,
      ...(currentPage > 0 ? { offset: offsetOfPage(currentPage, pageSize) } : {}),
      ...(editing ? { edit: editing.path } : {}),
    }
    lastRef.current = location
    setAppState(LAST_LOCATION_KEY, location).catch(() => {})
    if (tab) reportLocation(tab, location, source.label, currentBranch?.name ?? null, !!editing?.dirty)
  }, [ready, source, sourceId, branch, path, currentPage, pageSize, restoringPage, tab, currentBranch, editing?.path, editing?.dirty])

  // ── Editing that outlives the editor: the place names the file, a draft keeps the unsaved text ──

  const draftKey = () => tabRef.current?.tabGuid ?? 'window'

  async function readDrafts(): Promise<Record<string, Draft>> {
    return (await getAppState<Record<string, Draft>>(DRAFTS_KEY).catch(() => undefined)) ?? {}
  }

  async function writeDraft(key: string, draft: Draft | null) {
    const drafts = await readDrafts()
    if (draft) drafts[key] = draft
    else delete drafts[key]
    await setAppState(DRAFTS_KEY, drafts).catch(() => {})
  }

  /** Keeps the editor's unsaved text as this tab's draft (right away, e.g. before another tab is shown). */
  function flushDraft() {
    const now = editingRef.current
    if (now?.dirty) writeDraft(draftKey(), { sourceId: now.source.id, branch: now.source.branch ?? null, path: now.path, content: now.content, version: now.version })
  }

  // While there are unsaved changes, the draft follows them (a moment after the last key).
  useEffect(() => {
    if (!editing?.dirty) return
    const timer = window.setTimeout(flushDraft, 500)
    return () => window.clearTimeout(timer)
  }, [editing?.content, editing?.dirty, editing?.path])

  // A place that says a file is being edited: open it in the editor, with the tab's draft if it has one for it.
  useEffect(() => {
    if (!ready || !source || editToRestore === null) return
    const wanted = editToRestore
    setEditToRestore(null)
    ;(async () => {
      try {
        const [bytes, drafts] = await Promise.all([source.read(wanted), readDrafts()])
        const saved = decodeText(bytes)
        if (saved === null) throw new Error(`"${wanted}" isn't a text file this small any more.`)
        const version = (await source.version?.(wanted).catch(() => null)) ?? null
        const draft = drafts[draftKey()]
        const mine = draft && draft.sourceId === source.id && (draft.branch ?? null) === (source.branch ?? null) && draft.path === wanted
        setEditing({
          source,
          path: wanted,
          content: mine ? draft.content : saved,
          dirty: !!mine && draft.content !== saved,
          version: mine ? (draft.version ?? version) : version,
        })
      } catch (e) {
        setError(String(e))
      }
    })()
  }, [ready, source, editToRestore])

  // A position restored for the place shown (a tab switched to, or the start): go to the page that holds
  // the record it was at, as soon as the listing of that very place is in.
  useEffect(() => {
    if (!restoringPage || restoredOffsetRef.current === null || !listing || !source) return
    if (loadedForRef.current !== `${source.viewKey}|${path}`) return // that is another folder's listing
    setPage(pageOfOffset(restoredOffsetRef.current, pageSizeRef.current))
    restoredOffsetRef.current = null
    setRestoringPage(false)
  }, [restoringPage, listing, source, path])

  // Sizes and dates of a local folder aren't in its listing: fetch them for the page shown only.
  useEffect(() => {
    if (!source?.stat || !listing) return
    const stat = source.stat
    let cancelled = false
    for (const entry of pagedEntries) {
      if (entry.size !== null || entry.mtimeMs !== null || meta[entry.name]) continue
      stat(joinRelative(path, entry.name)).then(
        (info) => !cancelled && setMeta((prev) => ({ ...prev, [entry.name]: info })),
        () => {},
      )
    }
    return () => {
      cancelled = true
    }
  }, [source, listing, currentPage, pageSize])

  function setPageSize(size: number) {
    setPageSizeState(size)
    setGlobalPageSize(size).catch(() => {})
    setPage(0)
  }

  // ── Actions ──

  /** Runs a change, then shows the folder as it is now (and the branch's change count). Resolves
   * to whether the change worked. */
  async function act(work: () => Promise<void>): Promise<boolean> {
    setError(null)
    setNotice(null)
    let ok = true
    try {
      await work()
    } catch (e) {
      setError(String(e))
      ok = false
    }
    await load(false)
    if (account) await reloadBranches()
    return ok
  }

  // (The clipboard deliberately survives switching sources: copying between them is the point.)
  function selectSource(id: string) {
    setSourceId(id)
    setBranch(null)
    setPath('')
  }

  async function addFolder() {
    try {
      const root = await pickNewRoot()
      if (!root) return
      setRoots((prev) => (prev.some((r) => r.id === root.id) ? prev : [...prev, root]))
      selectSource(`${LOCAL_PREFIX}${root.id}`)
    } catch (e) {
      setError(String(e))
    }
  }

  async function removeFolder(root: FileRoot) {
    try {
      await forgetRoot(root)
    } catch (e) {
      setError(String(e))
      return
    }
    setRoots((prev) => prev.filter((r) => r.id !== root.id))
    if (sourceId === `${LOCAL_PREFIX}${root.id}`) selectSource(`${LOCAL_PREFIX}user`)
  }

  async function openEntry(entry: Entry) {
    if (!source) return
    const rel = joinRelative(path, entry.name)
    if (entry.isDirectory) {
      setPath(rel)
      return
    }
    setError(null)
    const size = entry.size ?? meta[entry.name]?.size ?? (await source.stat?.(rel).catch(() => null))?.size ?? null
    if (size !== null && size > MAX_EDIT_BYTES) {
      setError(`"${entry.name}" is too big to edit here (${formatBytes(size)}) — export it instead.`)
      return
    }
    setLoading(true)
    try {
      const text = decodeText(await source.read(rel))
      if (text === null) {
        setError(`"${entry.name}" isn't a text file this small — export it instead.`)
      } else {
        // Right after the read, so it is the version of what was read that is remembered.
        const version = (await source.version?.(rel).catch(() => null)) ?? null
        setEditing({ source, path: rel, content: text, dirty: false, version })
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
      // Opening a Filen file caches it: show that.
      if (account) load(false)
    }
  }

  /** Saves the file being edited. A Filen file is first checked against Filen itself: if it isn't the
   * version that was being worked on any more, nothing is written and the person is asked (see
   * `conflict`). `overwrite` is the answer "overwrite it": the check is skipped, and in a branch the
   * change is then based on Filen's version, so the commit doesn't warn about it again. */
  async function save(overwrite = false) {
    if (!editing) return
    const { source: editedSource, path: filePath, content, version } = editing
    setError(null)
    setNotice(null)
    try {
      if (!overwrite && editedSource.checkVersion && version) {
        let check: VersionCheck | null = null
        try {
          check = await editedSource.checkVersion(filePath, version)
        } catch (e) {
          // In a branch the save stays on this device and the commit checks again; the account itself
          // can't be written to offline anyway, so the person is told.
          if (editedSource.branch === null) throw e
        }
        if (check && !check.upToDate) {
          setConflict(check)
          return
        }
      }
      await editedSource.write(filePath, new TextEncoder().encode(content))
      if (overwrite) await editedSource.rebase?.(filePath)
      const saved = (await editedSource.version?.(filePath).catch(() => null)) ?? null
      setEditing((e) => (e && e.path === filePath ? { ...e, dirty: false, version: saved ?? e.version } : e))
      writeDraft(draftKey(), null)
      await load(false)
      if (account) await reloadBranches()
    } catch (e) {
      setError(String(e))
    }
  }

  /** "Discard changes": the edits are dropped and the file is read again — Filen's version, or in a
   * branch that already holds the file, the branch's. */
  async function discardEdits() {
    if (!editing) return
    const { source: editedSource, path: filePath } = editing
    setConflict(null)
    try {
      await editedSource.list(parentPath(filePath), true) // Filen's own idea of the folder, so a newer file replaces the cached one
      const text = decodeText(await editedSource.read(filePath))
      if (text === null) throw new Error(`"${filePath}" isn't a text file this small any more — export it instead.`)
      const fresh = (await editedSource.version?.(filePath).catch(() => null)) ?? null
      setEditing((e) => (e && e.path === filePath ? { ...e, content: text, dirty: false, version: fresh ?? e.version } : e))
      writeDraft(draftKey(), null)
      setNotice('Your changes were discarded; this is the file as it is now.')
    } catch (e) {
      setEditing(null) // it is gone (or isn't text now): there is nothing to go on editing
      setError(String(e))
    }
    await load(false)
  }

  /** "New branch…" from the editor: makes a branch and carries on in it — an unchanged file is checked
   * out there, an edited one is saved into it with the next Save. */
  async function newBranchFromEditor() {
    if (!editing) return
    const editedAccount = accounts.find((a) => `${FILEN_PREFIX}${a.userId}` === editing.source.id)
    if (!editedAccount) return
    const name = window.prompt(`Name of the new branch (up to ${MAX_BRANCH_NAME_CHARS} characters):`)?.trim()
    if (!name) return
    if ([...name].length > MAX_BRANCH_NAME_CHARS) return setError(`A branch name has at most ${MAX_BRANCH_NAME_CHARS} characters.`)
    setError(null)
    try {
      const created = await filenCache.createBranch(editedAccount.userId, name)
      const inBranch = filenSource(editedAccount, created.index)
      // (The file the editor shows came from the account, so that is what is checked out — a file open
      // from another branch isn't the account's.)
      if (!editing.dirty && editing.source.branch === null) await inBranch.checkout?.(editing.path)
      setEditing((e) => (e ? { ...e, source: inBranch } : e))
      if (editedAccount.userId === account?.userId) {
        await reloadBranches()
        setBranch(created.index)
      }
      setNotice(`Working in the new branch "${name}".`)
    } catch (e) {
      setError(String(e))
    }
  }

  async function closeEditor() {
    if (editing?.dirty && !(await confirm('Close without saving your changes?'))) return
    writeDraft(draftKey(), null)
    setEditing(null)
  }

  function nameOk(name: string): boolean {
    if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) {
      setError('That is not a valid file name.')
      return false
    }
    return true
  }

  async function createFolder() {
    if (!source) return
    const name = window.prompt('New folder name:')?.trim()
    if (!name || !nameOk(name)) return
    if (entries.some((e) => e.name === name)) return setError(`"${name}" already exists.`)
    await act(() => source.mkdir(joinRelative(path, name)))
  }

  async function createFile() {
    if (!source) return
    const name = window.prompt('New file name:', 'untitled.md')?.trim()
    if (!name || !nameOk(name)) return
    if (entries.some((e) => e.name === name)) return setError(`"${name}" already exists.`)
    const rel = joinRelative(path, name)
    if (await act(() => source.write(rel, new Uint8Array()))) {
      const version = (await source.version?.(rel).catch(() => null)) ?? null
      setEditing({ source, path: rel, content: '', dirty: false, version })
    }
  }

  async function uploadFiles() {
    if (!source) return
    try {
      // The files are handed over unread: a big one is read and sent on piece by piece.
      for (const file of await pickDeviceFiles()) {
        if (entries.some((e) => e.name === file.name) && !(await confirm(`Replace "${file.name}"?`))) continue
        await act(async () => {
          const target = joinRelative(path, file.name)
          if (source.writeFromFile) await source.writeFromFile(target, file)
          else await source.write(target, new Uint8Array(await file.arrayBuffer()))
        })
      }
    } catch (e) {
      setError(String(e))
    }
  }

  async function exportEntry(entry: Entry) {
    if (!source) return
    try {
      const saved = await exportPathToDevice(entry.name, (token) => source.exportFile(joinRelative(path, entry.name), entry.name, token))
      if (saved && isMobile) setNotice(`Saved to ${saved}`)
      if (account) load(false)
    } catch (e) {
      setError(String(e))
    }
  }

  async function deleteEntry(entry: Entry) {
    if (!source) return
    const where =
      account && branch !== null
        ? 'in this branch (the account is only changed when you commit it)'
        : account
          ? "from the account — it goes to Filen's trash"
          : 'for good'
    if (!(await confirm(`Delete "${entry.name}" ${where}?`))) return
    await act(() => source.remove(joinRelative(path, entry.name), entry.isDirectory))
  }

  /** Locks the file against caching, or unlocks it: a locked file's cached copy is never refreshed, expired
   * or cleared. It is the account's file that is locked, so this is the same from the account and from
   * any branch. */
  async function toggleLock(entry: Entry) {
    if (!source?.setLocked) return
    const target = joinRelative(path, entry.name)
    const lock = !entry.locked
    if (await act(() => source.setLocked!(target, lock))) {
      setNotice(lock ? `"${entry.name}" is locked: this copy is kept as it is until you unlock it.` : `"${entry.name}" is unlocked: it is refreshed like the rest of the cache again.`)
    }
  }

  /** Takes the file into the branch without changing it, so it is among the branch's pending changes. */
  async function checkoutEntry(entry: Entry) {
    if (!source?.checkout) return
    if (await act(() => source.checkout!(joinRelative(path, entry.name)))) setNotice(`"${entry.name}" is checked out in this branch.`)
  }

  async function releaseEntry(entry: Entry) {
    if (!source?.release) return
    await act(() => source.release!(joinRelative(path, entry.name)))
  }

  /** Opens the html or markdown file as a web app: a window of its own, listed under this tab. */
  async function openAsWebApp(entry: Entry) {
    if (!source?.openAsWebApp) return
    setError(null)
    try {
      await source.openAsWebApp(joinRelative(path, entry.name))
    } catch (e) {
      setError(String(e))
    }
  }

  function startRename(entry: Entry) {
    setRenaming(entry.name)
    setRenameValue(entry.name)
  }

  async function commitRename(oldName: string) {
    const newName = renameValue.trim()
    setRenaming(null)
    if (!source || !newName || newName === oldName || !nameOk(newName)) return
    await act(() => source.rename(joinRelative(path, oldName), joinRelative(path, newName)))
  }

  function clip(entry: Entry, mode: 'copy' | 'cut') {
    if (!source) return
    setClipboard({ source, mode, path: joinRelative(path, entry.name), name: entry.name, isDirectory: entry.isDirectory })
  }

  async function paste() {
    if (!clipboard || !source) return
    const sameSource = clipboard.source.viewKey === source.viewKey
    if (sameSource && clipboard.isDirectory && isSameOrWithin(clipboard.path, path)) {
      return setError('Cannot move or copy a folder into itself or one of its subfolders.')
    }
    const name = uniqueName(clipboard.name, entries.map((e) => e.name))
    const target = joinRelative(path, name)
    await act(async () => {
      if (clipboard.mode === 'cut' && sameSource) {
        if (target !== clipboard.path) await source.rename(clipboard.path, target)
      } else {
        await copyTree(clipboard.source, clipboard.path, clipboard.isDirectory, source, target)
        if (clipboard.mode === 'cut') await clipboard.source.remove(clipboard.path, clipboard.isDirectory)
      }
      setClipboard(null)
    })
  }

  // ── Filen cache and branches ──

  async function changeInterval(value: string) {
    if (!account) return
    const secs = value === 'never' ? null : Number(value)
    try {
      await filenCache.setInterval(account.userId, secs)
      setCacheInfo((info) => (info ? { ...info, ttlSecs: secs } : info))
      await load(false)
    } catch (e) {
      setError(String(e))
    }
  }

  async function clearCache() {
    if (!account) return
    if (!(await confirm('Throw away everything cached for this account? Branches, and files you locked against caching, are kept.'))) return
    try {
      await filenCache.clear(account.userId)
      await load(false)
    } catch (e) {
      setError(String(e))
    }
  }

  async function newBranch() {
    if (!account) return
    const name = window.prompt(`Name of the new branch (up to ${MAX_BRANCH_NAME_CHARS} characters):`)?.trim()
    if (!name) return
    if ([...name].length > MAX_BRANCH_NAME_CHARS) return setError(`A branch name has at most ${MAX_BRANCH_NAME_CHARS} characters.`)
    try {
      const created = await filenCache.createBranch(account.userId, name)
      await reloadBranches()
      setBranch(created.index)
    } catch (e) {
      setError(String(e))
    }
  }

  async function showChanges() {
    if (!account || branch === null) return
    try {
      setChanges(await filenCache.branchChanges(account.userId, branch))
    } catch (e) {
      setError(String(e))
    }
  }

  async function commitBranch() {
    if (!account || branch === null) return
    const name = currentBranch?.name ?? 'this branch'
    if (!(await confirm(`Apply the changes of "${name}" to the account and delete the branch?`))) return
    try {
      let report = await filenCache.commitBranch(account.userId, branch, false)
      if (!report.committed && report.conflicts.length > 0) {
        const shown = report.conflicts.slice(0, 8).join('\n') + (report.conflicts.length > 8 ? '\n…' : '')
        const overwrite = await confirm(
          `The account changed since "${name}" touched these:\n\n${shown}\n\nNothing was applied. Apply the branch anyway and overwrite them?`,
        )
        if (!overwrite) return
        report = await filenCache.commitBranch(account.userId, branch, true)
      }
      if (report.committed) {
        setNotice(`Committed "${name}": ${report.applied} change${report.applied === 1 ? '' : 's'} applied.`)
        setBranch(null)
        await reloadBranches()
        await load(false)
      }
    } catch (e) {
      setError(String(e))
    }
  }

  async function discardBranch() {
    if (!account || branch === null) return
    const name = currentBranch?.name ?? 'this branch'
    if (!(await confirm(`Discard "${name}" and everything changed in it? This cannot be undone.`))) return
    try {
      await filenCache.discardBranch(account.userId, branch)
      setBranch(null)
      await reloadBranches()
      await load(false)
    } catch (e) {
      setError(String(e))
    }
  }

  // ── Keyboard ──

  // A new folder: nothing is focused until a key is pressed — unless it was entered with the keys.
  useEffect(() => {
    setKbdFocus(-1)
  }, [sourceId, branch, path])
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
    enabled: ready && !editing && !changes && !conflict && renaming === null,
    onOpen: (i) => {
      const entry = entries[i]
      if (!entry) return
      pendingFocusRef.current = entry.isDirectory ? 'first' : null
      openEntry(entry)
    },
    onParent: () => {
      if (path === '') return
      pendingFocusRef.current = path.slice(path.lastIndexOf('/') + 1)
      setPath(parentPath(path))
    },
  })

  // ── Rendering ──

  const crumbs = ['', ...path.split('/').filter(Boolean)]
  const rootLabel = source?.label ?? ''

  if (!ready) return null

  return (
    <div className="app-shell">
      <main className="tab-content">
        <div className="tab-panel files-tab">
          <div className="root-switcher">
            {roots.map((root) => {
              const id = `${LOCAL_PREFIX}${root.id}`
              return (
                <span key={id} className={`root-pill ${id === sourceId ? 'active' : ''}`}>
                  <button className="link-button" onClick={() => selectSource(id)} title={root.label}>
                    <Folder size={14} strokeWidth={2} aria-hidden="true" /> {root.label}
                  </button>
                  {root.id !== 'user' && (
                    <button className="root-pill-remove" onClick={() => removeFolder(root)} title="Stop browsing this folder">
                      <X size={12} strokeWidth={2} aria-hidden="true" />
                    </button>
                  )}
                </span>
              )
            })}
            <IconButton icon={FolderPlus} label="Add folder…" onClick={addFolder} />
            {accounts.map((a) => {
              const id = `${FILEN_PREFIX}${a.userId}`
              return (
                <span key={id} className={`root-pill ${id === sourceId ? 'active' : ''}`}>
                  <button className="link-button" onClick={() => selectSource(id)} title="Filen account">
                    <Cloud size={14} strokeWidth={2} aria-hidden="true" /> {a.email}
                  </button>
                </span>
              )
            })}
            {accounts.length === 0 && <span className="muted">Connect a Filen account in the admin-app's Filen.io tab to see it here.</span>}
          </div>

          {account && (
            <div className="notes-filen-panel">
              <div className="notes-panel-row">
                <label className="notes-field">
                  <span className="muted">Cache expires after</span>
                  <select
                    value={cacheInfo?.ttlSecs === null ? 'never' : String(cacheInfo?.ttlSecs ?? '')}
                    onChange={(e) => changeInterval(e.target.value)}
                    disabled={!cacheInfo}
                  >
                    {cacheInfo && !INTERVAL_CHOICES.some((c) => c.secs === cacheInfo.ttlSecs) && (
                      <option value={String(cacheInfo.ttlSecs)}>{intervalLabel(cacheInfo.ttlSecs)}</option>
                    )}
                    {INTERVAL_CHOICES.map((c) => (
                      <option key={c.label} value={c.secs === null ? 'never' : String(c.secs)}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <IconButton icon={Eraser} label="Clear the cache" onClick={clearCache} />
                {listing && (
                  <span className="muted notes-cache-status">
                    {listing.stale ? <CloudOff size={13} aria-hidden="true" /> : null}
                    {listing.stale ? ' Offline — showing the listing as it was ' : ' Listing fetched '}
                    {listing.fetchedAt ? formatTime(listing.fetchedAt) : ''}
                  </span>
                )}
              </div>
              <div className="notes-panel-row">
                <label className="notes-field">
                  <GitBranch size={14} aria-hidden="true" />
                  <select value={branch === null ? '' : String(branch)} onChange={(e) => setBranch(e.target.value === '' ? null : Number(e.target.value))}>
                    <option value="">Account (no branch)</option>
                    {branches.map((b) => (
                      <option key={b.index} value={String(b.index)}>
                        {b.name} ({b.changes} change{b.changes === 1 ? '' : 's'})
                      </option>
                    ))}
                  </select>
                </label>
                <IconButton icon={GitBranchPlus} label="New branch…" onClick={newBranch} />
                {branch !== null && (
                  <>
                    <IconButton icon={ListChecks} label="Show the branch's changes" onClick={showChanges} />
                    <IconButton icon={GitMerge} label="Commit the branch to the account" onClick={commitBranch} />
                    <IconButton icon={Trash2} label="Discard the branch" variant="danger" onClick={discardBranch} />
                  </>
                )}
              </div>
            </div>
          )}

          <div className="toolbar">
            <div className="breadcrumbs">
              {crumbs.map((seg, i) => {
                const target = crumbs.slice(1, i + 1).join('/')
                return (
                  <span key={i}>
                    {i > 0 && <span className="crumb-sep">/</span>}
                    <button className="link-button" onClick={() => setPath(target)}>
                      {i === 0 ? rootLabel : seg}
                    </button>
                  </span>
                )
              })}
            </div>
            <div className="toolbar-actions">
              <IconButton icon={FilePlus} label="New file" onClick={createFile} />
              <IconButton icon={FolderPlus} label="New folder" onClick={createFolder} />
              <IconButton icon={Upload} label="Upload…" onClick={uploadFiles} />
              {clipboard && <IconButton icon={ClipboardPaste} label={`Paste "${clipboard.name}"`} onClick={paste} />}
              <IconButton icon={RefreshCw} label={account ? 'Refresh from Filen' : 'Refresh'} onClick={() => load(true)} />
            </div>
          </div>

          {error && <div className="error-banner">{error}</div>}
          {notice && <div className="status-banner">{notice}</div>}
          {loading && <div className="muted">Loading…</div>}

          {!loading && (
            <table className="file-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Size</th>
                  <th>Modified</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {entries.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      {listing ? 'This folder is empty.' : ''}
                    </td>
                  </tr>
                )}
                {pagedEntries.map((entry, i) => {
                  const size = entry.size ?? meta[entry.name]?.size ?? null
                  const mtimeMs = entry.mtimeMs ?? meta[entry.name]?.mtimeMs ?? null
                  return (
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
                            {entry.isDirectory ? <Folder size={15} strokeWidth={2} aria-hidden="true" /> : <FileIcon size={15} strokeWidth={2} aria-hidden="true" />}
                            {entry.name}
                            {account && !entry.isDirectory && entry.cached && <span className="notes-badge" title="Its content is cached">cached</span>}
                            {account && !entry.isDirectory && entry.locked && (
                              <span className="notes-badge notes-badge-locked" title="Locked against caching: this copy is never refreshed, expired or cleared">
                                <Lock size={11} aria-hidden="true" /> locked
                              </span>
                            )}
                            {entry.changed && (
                              <span
                                className={`notes-badge notes-badge-${entry.changed}`}
                                title={entry.changed === 'checkout' ? 'Checked out in this branch, not changed' : 'Changed in this branch'}
                              >
                                {entry.changed === 'mkdir' ? 'new folder' : entry.changed === 'checkout' ? 'checked out' : 'changed'}
                              </span>
                            )}
                          </button>
                        )}
                      </td>
                      <td className="muted">{!entry.isDirectory && size !== null ? formatBytes(size) : ''}</td>
                      <td className="muted">{mtimeMs !== null ? formatTime(mtimeMs) : ''}</td>
                      <td className="row-actions">
                        {!entry.isDirectory && source?.openAsWebApp && /\.(html?|md|markdown)$/i.test(entry.name) && (
                          <IconButton icon={AppWindow} label="Open as web app — in a window of its own, listed under this tab" onClick={() => openAsWebApp(entry)} />
                        )}
                        {!entry.isDirectory && <IconButton icon={Download} label="Export" onClick={() => exportEntry(entry)} />}
                        {account && !entry.isDirectory && (
                          <IconButton
                            icon={entry.locked ? Unlock : Lock}
                            label={entry.locked ? 'Unlock — let it be refreshed like the rest of the cache' : 'Lock against caching — keep this copy: never refresh, expire or clear it'}
                            onClick={() => toggleLock(entry)}
                          />
                        )}
                        {account && branch !== null && !entry.isDirectory && !entry.changed && (
                          <IconButton icon={FileCheck} label="Check out into this branch — it then appears in the pending changes" onClick={() => checkoutEntry(entry)} />
                        )}
                        {account && branch !== null && entry.changed === 'checkout' && (
                          <IconButton icon={Undo2} label="Let go of the checkout" onClick={() => releaseEntry(entry)} />
                        )}
                        <IconButton icon={Copy} label="Copy" onClick={() => clip(entry, 'copy')} />
                        <IconButton icon={Scissors} label="Cut" onClick={() => clip(entry, 'cut')} />
                        <IconButton icon={Pencil} label="Rename" onClick={() => startRename(entry)} />
                        <IconButton icon={Trash2} label="Delete" variant="danger" onClick={() => deleteEntry(entry)} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          <Pagination page={currentPage} pageSize={pageSize} totalItems={entries.length} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </div>
      </main>

      {editing && (
        <div className="editor-overlay">
          <div className="editor-panel">
            <div className="editor-header">
              <strong>
                {editing.source.label} · {editing.path}
              </strong>
              <div>
                {editing.source.kind === 'filen' && <IconButton icon={GitBranchPlus} label="New branch… — carry on in a branch of the account" onClick={newBranchFromEditor} />}
                <IconButton icon={Save} label="Save" onClick={() => save()} disabled={!editing.dirty} />
                <IconButton icon={X} label="Close" onClick={closeEditor} />
              </div>
            </div>
            <textarea value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value, dirty: true })} spellCheck={false} />
          </div>
        </div>
      )}

      {conflict && editing && (
        <Modal title="Filen has changed this file" onClose={() => setConflict(null)}>
          <p>
            <strong>{editing.path}</strong>: {conflict.problem ?? 'Filen has another version of it'}.
          </p>
          {conflict.current.exists && (
            <p className="muted">
              Filen's version: {conflict.current.size !== null ? formatBytes(conflict.current.size) : '?'}
              {conflict.current.mtimeMs !== null ? `, changed ${formatTime(conflict.current.mtimeMs)}` : ''}.
            </p>
          )}
          <ul className="notes-conflict-options">
            <li>
              <strong>Overwrite</strong> — {editing.source.branch === null ? "your version replaces Filen's" : "your version is saved in the branch, based on Filen's version as it is now"}.
            </li>
            <li>
              <strong>Discard changes</strong> — your changes are lost and {editing.source.branch === null ? "Filen's version is loaded" : 'the file is loaded again as this branch has it'}.
            </li>
            <li>
              <strong>Cancel</strong> — back to the editor, as if Save had not been pressed.
            </li>
          </ul>
          <div className="dialog-actions">
            <button
              type="button"
              className="dialog-danger"
              onClick={() => {
                setConflict(null)
                save(true)
              }}
            >
              Overwrite
            </button>
            <button type="button" className="dialog-danger" onClick={discardEdits}>
              Discard changes
            </button>
            <button type="button" autoFocus onClick={() => setConflict(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}

      {changes && (
        <Modal title={`Changes in "${currentBranch?.name ?? 'the branch'}"`} onClose={() => setChanges(null)}>
          {changes.length === 0 ? (
            <div className="muted">Nothing has been changed in this branch yet.</div>
          ) : (
            <ul className="notes-changes">
              {changes.map((c) => (
                <li key={`${c.kind}:${c.path}`}>
                  <span className={`notes-badge notes-badge-${c.kind}`}>{c.kind === 'put' ? (c.isNew ? 'new file' : 'changed') : c.kind === 'mkdir' ? 'new folder' : c.kind === 'checkout' ? 'checked out' : 'deleted'}</span> {c.path}
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
    </div>
  )
}
