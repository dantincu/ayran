import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  ArrowRightLeft,
  ArrowUpDown,
  Check,
  CheckCheck,
  ClipboardPaste,
  Copy,
  CopyPlus,
  ExternalLink,
  FilePlus,
  Fingerprint,
  FolderPlus,
  Pause,
  PauseCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Scissors,
  X,
  XCircle,
} from 'lucide-react'
import IconButton from './IconButton'
import Modal from './Modal'
import { TagList } from './Tags'
import ReorderList from './ReorderList'
import { getAppState, setAppState } from '../lib/appState'
import {
  activateTab,
  addBlankTab,
  addSecondaryWindowEntry,
  cloneTab,
  closeAllSecondaryWindows,
  closeSecondaryWindow,
  createTabGroup,
  focusSecondaryWindow,
  listSecondaryWindows,
  moveTabToGroup,
  onSecondaryWindowsChanged,
  renameTabGroup,
  reopenSecondaryWindow,
  suspendAllSecondaryWindows,
  suspendSecondaryWindow,
  type SecondaryWindowRecord,
  type TabGroupRecord,
  type TabRecord,
  type TabTextSpan,
} from '../lib/secondaryWindows'

type View = 'apps' | 'windows' | 'groups' | 'tabs'
const VIEW_DEPTH: Record<View, number> = { apps: 0, windows: 1, groups: 2, tabs: 3 }

interface Group {
  relativePath: string
  windows: SecondaryWindowRecord[]
}

function groupByPath(records: SecondaryWindowRecord[]): Group[] {
  const map = new Map<string, SecondaryWindowRecord[]>()
  for (const record of records) {
    const list = map.get(record.relativePath) ?? []
    list.push(record)
    map.set(record.relativePath, list)
  }
  const groups = Array.from(map.entries()).map(([relativePath, windows]) => ({
    relativePath,
    windows: windows.slice().sort((a, b) => b.createdAt - a.createdAt),
  }))
  groups.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return groups
}

/** Reorders `items` per `order` (a list of ids in the desired sequence), appending
 * anything not mentioned in `order` (new items) at the end in their existing order.
 * Falls back to `items` unchanged when custom order is off or nothing is saved yet. */
function applyOrder<T>(items: T[], getId: (item: T) => string, useCustom: boolean, order: string[] | undefined): T[] {
  if (!useCustom || !order || order.length === 0) return items
  const remaining = new Map(items.map((item) => [getId(item), item]))
  const ordered: T[] = []
  for (const id of order) {
    const item = remaining.get(id)
    if (item) {
      ordered.push(item)
      remaining.delete(id)
    }
  }
  for (const item of items) {
    if (remaining.has(getId(item))) ordered.push(item)
  }
  return ordered
}

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

const USE_CUSTOM_ORDER_KEY = 'windowsTab.useCustomOrder'
const GROUP_ORDER_KEY = 'windowsTab.groupOrder'
const ITEM_ORDER_KEY = 'windowsTab.itemOrder'
const TAB_GROUP_ORDER_KEY = 'windowsTab.tabGroupOrder'
const TAB_ORDER_KEY = 'windowsTab.tabOrder'

/** Synchronous, no permission prompt involved — the reliable path in a desktop
 * webview. Tried first so a slow/hanging clipboard permission negotiation (seen with
 * the async Clipboard API when the window lacks OS focus) never leaves the button
 * stuck waiting. */
function copyViaExecCommand(text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(textarea)
  return ok
}

async function copyToClipboard(text: string): Promise<void> {
  if (copyViaExecCommand(text)) return
  await navigator.clipboard.writeText(text)
}

function WindowDetailsModal({
  record,
  onClose,
  onError,
}: {
  record: SecondaryWindowRecord
  onClose: () => void
  onError: (message: string) => void
}) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    await copyToClipboard(record.guid)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Modal title="Window details" onClose={onClose}>
      <div>
        <div className="modal-field-label">Created</div>
        <div>{formatDateTime(record.createdAt)}</div>
      </div>

      <div>
        <div className="modal-field-label">Tags</div>
        <TagList guid={record.guid} tags={record.tags} className="window-item-tags tag-list-flush" onError={onError} />
      </div>

      <div>
        <div className="modal-field-label">GUID</div>
        <div className="modal-guid-row">
          <span className="window-item-guid">{record.guid}</span>
          <IconButton icon={copied ? CheckCheck : Copy} label="Copy GUID" onClick={handleCopy} />
        </div>
      </div>
    </Modal>
  )
}

function RenameGroupModal({
  group,
  onRename,
  onClose,
}: {
  group: TabGroupRecord
  onRename: (name: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState(group.name ?? '')

  function submit() {
    onRename(name)
    onClose()
  }

  return (
    <Modal title="Rename tab group" onClose={onClose}>
      <input
        autoFocus
        placeholder="Tab group name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') onClose()
        }}
      />
      <div className="toolbar-actions" style={{ justifyContent: 'flex-end' }}>
        <IconButton icon={Check} label="Save" onClick={submit} />
        <IconButton icon={X} label="Cancel" onClick={onClose} />
      </div>
    </Modal>
  )
}

function AddGroupRow({ onAdd }: { onAdd: (relativePath: string) => Promise<boolean> }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    const path = value.trim()
    if (!path || busy) return
    setBusy(true)
    try {
      const ok = await onAdd(path)
      if (ok) setValue('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="add-group-row">
      <input
        placeholder="Type or paste a relative path (e.g. asdf/index.html) to add a new window entry…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      <IconButton icon={FolderPlus} label="Add entry" onClick={submit} disabled={!value.trim() || busy} />
    </div>
  )
}

interface MoveCandidate {
  windowGuid: string
  windowCreatedAt: number
  group: TabGroupRecord
}

function MoveTabModal({
  candidates,
  onMove,
  onClose,
}: {
  candidates: MoveCandidate[]
  onMove: (targetGroupGuid: string) => void
  onClose: () => void
}) {
  return (
    <Modal title="Move tab to…" onClose={onClose}>
      {candidates.length === 0 ? (
        <div className="muted">No other tab groups available — open another window for this app, or create a new group first.</div>
      ) : (
        <ul className="move-tab-list">
          {candidates.map(({ windowGuid, windowCreatedAt, group }) => (
            <li key={group.guid}>
              <button
                className="link-button move-tab-option"
                onClick={() => {
                  onMove(group.guid)
                  onClose()
                }}
              >
                <span>Window opened {formatDateTime(windowCreatedAt)}</span>
                <span className="muted">
                  {group.tabs.length} tab{group.tabs.length === 1 ? '' : 's'} · id {windowGuid.slice(0, 8)}…
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

function TabTextRow({ spans, className }: { spans: TabTextSpan[]; className: string }) {
  return (
    <div className={className}>
      {spans.map((span, i) => (
        <span key={i}>
          {i > 0 && <span className="tab-text-bullet">•</span>}
          <span style={{ fontWeight: span.bold ? 700 : 400, fontStyle: span.italic ? 'italic' : 'normal' }}>
            {span.text}
          </span>
        </span>
      ))}
    </div>
  )
}

function TabRow({
  tab,
  cut,
  onError,
  onMove,
  onCut,
  onClone,
  onActivate,
}: {
  tab: TabRecord
  cut: boolean
  onError: (message: string) => void
  onMove: () => void
  onCut: () => void
  onClone: () => void
  onActivate: () => void
}) {
  return (
    <div className={`window-item tab-row ${cut ? 'tab-row-cut' : ''}`}>
      <div className="tab-row-header">
        {tab.icon && <span className="tab-row-icon" dangerouslySetInnerHTML={{ __html: tab.icon }} />}
        <button className="link-button tab-row-title-block" onClick={onActivate} title="Reopen this tab's web app">
          {tab.tabText ? (
            <>
              <TabTextRow spans={tab.tabText.firstRow} className="tab-row-title" />
              <TabTextRow spans={tab.tabText.secondRow} className="tab-row-subtitle" />
            </>
          ) : (
            <div className="muted tab-row-title">{tab.resourceId || 'New tab'}</div>
          )}
        </button>
        <div className="row-actions">
          <IconButton icon={ArrowRightLeft} label="Move to…" onClick={onMove} />
          <IconButton icon={Scissors} label="Cut (paste into another tab group)" onClick={onCut} />
          <IconButton icon={CopyPlus} label="Clone tab" onClick={onClone} />
        </div>
      </div>
      <TagList guid={tab.guid} tags={tab.tags} className="window-item-tags" onError={onError} />
    </div>
  )
}

/** The list area shared by all four drill-down levels: either a plain browsable
 * list, or (toggled via the level's own "Sort" button) a drag/arrow-reorderable
 * list showing a simplified label per item. */
function LevelPanel<T>({
  items,
  getId,
  renderRow,
  renderReorderLabel,
  reordering,
  onDoneReordering,
  onReorder,
  emptyMessage,
}: {
  items: T[]
  getId: (item: T) => string
  renderRow: (item: T) => ReactNode
  renderReorderLabel: (item: T) => ReactNode
  reordering: boolean
  onDoneReordering: () => void
  onReorder: (items: T[]) => void
  emptyMessage: string
}) {
  if (reordering) {
    return (
      <div className="reorder-panel">
        <ReorderList items={items} getId={getId} renderItem={renderReorderLabel} onChange={onReorder} />
        <div className="toolbar-actions" style={{ justifyContent: 'flex-end' }}>
          <IconButton icon={Check} label="Done reordering" onClick={onDoneReordering} />
        </div>
      </div>
    )
  }
  if (items.length === 0) {
    return <div className="muted">{emptyMessage}</div>
  }
  return (
    <ul className="window-list">
      {items.map((item) => (
        <li key={getId(item)}>{renderRow(item)}</li>
      ))}
    </ul>
  )
}

export default function AppsTab() {
  const [records, setRecords] = useState<SecondaryWindowRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [view, setView] = useState<View>('apps')
  const [currentApp, setCurrentApp] = useState<string | null>(null)
  const [currentWindowGuid, setCurrentWindowGuid] = useState<string | null>(null)
  const [currentGroupGuid, setCurrentGroupGuid] = useState<string | null>(null)
  const [reordering, setReordering] = useState(false)

  const [detailsFor, setDetailsFor] = useState<SecondaryWindowRecord | null>(null)
  const [movingTab, setMovingTab] = useState<TabRecord | null>(null)
  const [cutTab, setCutTab] = useState<TabRecord | null>(null)
  const [renamingGroup, setRenamingGroup] = useState<TabGroupRecord | null>(null)

  const [useCustomOrder, setUseCustomOrderState] = useState(false)
  const [groupOrder, setGroupOrderState] = useState<string[]>([])
  const [itemOrder, setItemOrderState] = useState<Record<string, string[]>>({})
  const [tabGroupOrder, setTabGroupOrderState] = useState<Record<string, string[]>>({})
  const [tabOrder, setTabOrderState] = useState<Record<string, string[]>>({})

  useEffect(() => {
    getAppState<boolean>(USE_CUSTOM_ORDER_KEY).then((saved) => setUseCustomOrderState(saved ?? false))
    getAppState<string[]>(GROUP_ORDER_KEY).then((saved) => setGroupOrderState(saved ?? []))
    getAppState<Record<string, string[]>>(ITEM_ORDER_KEY).then((saved) => setItemOrderState(saved ?? {}))
    getAppState<Record<string, string[]>>(TAB_GROUP_ORDER_KEY).then((saved) => setTabGroupOrderState(saved ?? {}))
    getAppState<Record<string, string[]>>(TAB_ORDER_KEY).then((saved) => setTabOrderState(saved ?? {}))
  }, [])

  function navigate(next: View) {
    setView(next)
    setReordering(false)
  }

  function openApp(relativePath: string) {
    setCurrentApp(relativePath)
    navigate('windows')
  }

  function openWindow(guid: string) {
    setCurrentWindowGuid(guid)
    navigate('groups')
  }

  function openGroup(guid: string) {
    setCurrentGroupGuid(guid)
    navigate('tabs')
  }

  function setUseCustomOrder(value: boolean) {
    setUseCustomOrderState(value)
    setAppState(USE_CUSTOM_ORDER_KEY, value)
    if (!value) setReordering(false)
  }

  function saveGroupOrder(order: string[]) {
    setGroupOrderState(order)
    setAppState(GROUP_ORDER_KEY, order)
  }

  function saveItemOrder(relativePath: string, order: string[]) {
    setItemOrderState((prev) => {
      const next = { ...prev, [relativePath]: order }
      setAppState(ITEM_ORDER_KEY, next)
      return next
    })
  }

  function saveTabGroupOrder(windowGuid: string, order: string[]) {
    setTabGroupOrderState((prev) => {
      const next = { ...prev, [windowGuid]: order }
      setAppState(TAB_GROUP_ORDER_KEY, next)
      return next
    })
  }

  function saveTabOrder(groupGuid: string, order: string[]) {
    setTabOrderState((prev) => {
      const next = { ...prev, [groupGuid]: order }
      setAppState(TAB_ORDER_KEY, next)
      return next
    })
  }

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setRecords(await listSecondaryWindows())
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const unlistenPromise = onSecondaryWindowsChanged(refresh)
    return () => {
      unlistenPromise.then((unlisten) => unlisten())
    }
  }, [refresh])

  async function handleClose(guid: string) {
    try {
      await closeSecondaryWindow(guid)
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleSuspend(guid: string) {
    try {
      await suspendSecondaryWindow(guid)
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleFocus(guid: string) {
    try {
      await focusSecondaryWindow(guid)
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleReopen(record: SecondaryWindowRecord) {
    try {
      await reopenSecondaryWindow(record.guid, record.relativePath)
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleCloseAll(relativePath?: string) {
    try {
      await closeAllSecondaryWindows(relativePath)
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleSuspendAll(relativePath?: string) {
    try {
      await suspendAllSecondaryWindows(relativePath)
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleAddEntry(relativePath: string): Promise<boolean> {
    try {
      await addSecondaryWindowEntry(relativePath)
      return true
    } catch (e) {
      setError(String(e))
      return false
    }
  }

  async function handleCreateTabGroup(windowGuid: string) {
    try {
      await createTabGroup(windowGuid)
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleRenameGroup(guid: string, name: string) {
    try {
      await renameTabGroup(guid, name)
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleAddBlankTab(groupGuid: string) {
    try {
      await addBlankTab(groupGuid)
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleCloneTab(tabGuid: string) {
    try {
      await cloneTab(tabGuid)
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleActivateTab(tabGuid: string) {
    try {
      await activateTab(tabGuid)
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleMoveTab(targetGroupGuid: string) {
    if (!movingTab) return
    try {
      await moveTabToGroup(movingTab.guid, targetGroupGuid)
    } catch (e) {
      setError(String(e))
    } finally {
      setMovingTab(null)
    }
  }

  async function handlePasteTab() {
    if (!cutTab || !currentGroup) return
    if (cutTab.groupGuid === currentGroup.guid) {
      setCutTab(null)
      return
    }
    try {
      await moveTabToGroup(cutTab.guid, currentGroup.guid)
    } catch (e) {
      setError(String(e))
    } finally {
      setCutTab(null)
    }
  }

  const apps = applyOrder(groupByPath(records), (g) => g.relativePath, useCustomOrder, groupOrder)
  const currentAppGroup = currentApp ? apps.find((g) => g.relativePath === currentApp) ?? null : null
  const windowsOfCurrentApp = currentAppGroup
    ? applyOrder(currentAppGroup.windows, (w) => w.guid, useCustomOrder, itemOrder[currentApp!])
    : []
  const currentWindow = currentAppGroup?.windows.find((w) => w.guid === currentWindowGuid) ?? null
  const groupsOfCurrentWindow = currentWindow
    ? applyOrder(currentWindow.tabGroups, (g) => g.guid, true, tabGroupOrder[currentWindow.guid])
    : []
  const currentGroup = currentWindow?.tabGroups.find((g) => g.guid === currentGroupGuid) ?? null
  const tabsOfCurrentGroup = currentGroup ? applyOrder(currentGroup.tabs, (t) => t.guid, true, tabOrder[currentGroup.guid]) : []

  // If whatever the user last drilled into has since vanished (window closed,
  // etc.), fall back to the deepest level that's still valid instead of showing
  // a blank/broken screen.
  useEffect(() => {
    if (view === 'apps') return
    if (!currentAppGroup) {
      setView('apps')
      setCurrentApp(null)
      setCurrentWindowGuid(null)
      setCurrentGroupGuid(null)
      return
    }
    if (view === 'windows') return
    if (!currentWindow) {
      setView('windows')
      setCurrentWindowGuid(null)
      setCurrentGroupGuid(null)
      return
    }
    if (view === 'groups') return
    if (!currentGroup) {
      setView('groups')
      setCurrentGroupGuid(null)
    }
  }, [records, view, currentAppGroup, currentWindow, currentGroup])

  const liveDetailsFor = detailsFor ? records.find((r) => r.guid === detailsFor.guid) ?? null : null
  const moveCandidates: MoveCandidate[] = movingTab
    ? records
        .filter((r) => r.relativePath === movingTab.relativePath)
        .flatMap((r) => r.tabGroups.map((group) => ({ windowGuid: r.guid, windowCreatedAt: r.createdAt, group })))
        .filter((c) => c.group.guid !== movingTab.groupGuid)
    : []

  const depth = VIEW_DEPTH[view]
  const canPaste = !!(cutTab && currentGroup && cutTab.relativePath === currentApp && cutTab.groupGuid !== currentGroup.guid)

  return (
    <div className="tab-panel">
      <div className="toolbar">
        <div className="breadcrumbs">
          <span>
            <button className={`link-button ${view === 'apps' ? 'active' : ''}`} onClick={() => navigate('apps')}>
              Apps
            </button>
          </span>
          {depth >= 1 && currentApp && (
            <span>
              <span className="crumb-sep">/</span>
              <button className={`link-button ${view === 'windows' ? 'active' : ''}`} onClick={() => navigate('windows')}>
                {currentApp}
              </button>
            </span>
          )}
          {depth >= 2 && currentWindow && (
            <span>
              <span className="crumb-sep">/</span>
              <button className={`link-button ${view === 'groups' ? 'active' : ''}`} onClick={() => navigate('groups')}>
                Window · {formatDateTime(currentWindow.createdAt)}
              </button>
            </span>
          )}
          {depth >= 3 && currentGroup && (
            <span>
              <span className="crumb-sep">/</span>
              <button className={`link-button ${view === 'tabs' ? 'active' : ''}`} onClick={() => navigate('tabs')}>
                {currentGroup.name ?? `Tab group · ${formatDateTime(currentGroup.createdAt)}`}
              </button>
            </span>
          )}
        </div>
        <div className="toolbar-actions">
          <IconButton icon={RefreshCw} label="Refresh" onClick={refresh} />
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="muted">Loading…</div>}

      {view === 'apps' && (
        <>
          <div className="toolbar">
            <strong>Web apps</strong>
            <div className="toolbar-actions">
              <IconButton icon={PauseCircle} label="Suspend all" onClick={() => handleSuspendAll()} disabled={records.length === 0} />
              <IconButton icon={XCircle} label="Close all" variant="danger" onClick={() => handleCloseAll()} disabled={records.length === 0} />
            </div>
          </div>
          <div className="toolbar">
            <label className="custom-order-toggle">
              <input type="checkbox" checked={useCustomOrder} onChange={(e) => setUseCustomOrder(e.target.checked)} />
              Use custom order
            </label>
            <div className="toolbar-actions">
              <IconButton
                icon={ArrowUpDown}
                label={reordering ? 'Stop sorting' : 'Sort'}
                variant={reordering ? 'danger' : 'default'}
                onClick={() => setReordering((v) => !v)}
                disabled={!useCustomOrder || (!reordering && apps.length < 2)}
              />
            </div>
          </div>

          <AddGroupRow onAdd={handleAddEntry} />

          <div className="window-group">
            <LevelPanel
              items={apps}
              getId={(g) => g.relativePath}
              reordering={reordering}
              onDoneReordering={() => setReordering(false)}
              onReorder={(newApps) => saveGroupOrder(newApps.map((g) => g.relativePath))}
              emptyMessage="No web apps open yet. Open an .html file from the Files tab as a web app to see it here."
              renderReorderLabel={(g) => (
                <span>
                  <span className="window-group-path">{g.relativePath}</span>{' '}
                  <span className="muted">
                    ({g.windows.length} window{g.windows.length === 1 ? '' : 's'})
                  </span>
                </span>
              )}
              renderRow={(g) => (
                <div className={`window-item ${g.relativePath === currentApp ? 'recently-visited' : ''}`}>
                  <div className="window-item-row">
                    <button className="link-button window-item-main" onClick={() => openApp(g.relativePath)}>
                      <span className="window-group-path">{g.relativePath}</span>
                      <span className="muted window-item-state">
                        {g.windows.length} window{g.windows.length === 1 ? '' : 's'}
                      </span>
                    </button>
                    <div className="row-actions">
                      <IconButton icon={FilePlus} label="Add a new window entry without opening it" onClick={() => handleAddEntry(g.relativePath)} />
                      <IconButton icon={PauseCircle} label="Suspend all" onClick={() => handleSuspendAll(g.relativePath)} />
                      <IconButton icon={XCircle} label="Close all" variant="danger" onClick={() => handleCloseAll(g.relativePath)} />
                    </div>
                  </div>
                </div>
              )}
            />
          </div>
        </>
      )}

      {view === 'windows' && currentAppGroup && (
        <>
          <div className="toolbar">
            <label className="custom-order-toggle">
              <input type="checkbox" checked={useCustomOrder} onChange={(e) => setUseCustomOrder(e.target.checked)} />
              Use custom order
            </label>
            <div className="toolbar-actions">
              <IconButton icon={FilePlus} label="Add a new window entry without opening it" onClick={() => handleAddEntry(currentApp!)} />
              <IconButton icon={PauseCircle} label="Suspend all" onClick={() => handleSuspendAll(currentApp!)} />
              <IconButton icon={XCircle} label="Close all" variant="danger" onClick={() => handleCloseAll(currentApp!)} />
              <IconButton
                icon={ArrowUpDown}
                label={reordering ? 'Stop sorting' : 'Sort'}
                variant={reordering ? 'danger' : 'default'}
                onClick={() => setReordering((v) => !v)}
                disabled={!useCustomOrder || (!reordering && windowsOfCurrentApp.length < 2)}
              />
            </div>
          </div>

          <div className="window-group">
            <LevelPanel
              items={windowsOfCurrentApp}
              getId={(w) => w.guid}
              reordering={reordering}
              onDoneReordering={() => setReordering(false)}
              onReorder={(newWindows) => saveItemOrder(currentApp!, newWindows.map((w) => w.guid))}
              emptyMessage="No windows for this app yet."
              renderReorderLabel={(w) => (
                <span className="reorder-window-item">
                  <span className={`status-dot ${w.isOpen ? 'status-open' : 'status-suspended'}`} />
                  <span className="muted">{formatDateTime(w.createdAt)}</span>
                  <span className="muted">{w.isOpen ? 'Open' : 'Suspended'}</span>
                </span>
              )}
              renderRow={(w) => (
                <div className={`window-item ${w.isOpen ? 'open' : 'suspended'} ${w.guid === currentWindowGuid ? 'recently-visited' : ''}`}>
                  <div className="window-item-row">
                    <button className="link-button window-item-main" onClick={() => openWindow(w.guid)}>
                      <span className={`status-dot ${w.isOpen ? 'status-open' : 'status-suspended'}`} />
                      <span className="muted window-item-date">{formatDateTime(w.createdAt)}</span>
                      <span className="muted window-item-state">{w.isOpen ? 'Open' : 'Suspended'}</span>
                    </button>
                    <div className="row-actions">
                      <IconButton icon={Fingerprint} label="Details" onClick={() => setDetailsFor(w)} />
                      {w.isOpen ? (
                        <>
                          <IconButton icon={ExternalLink} label="Focus" onClick={() => handleFocus(w.guid)} />
                          <IconButton icon={Pause} label="Suspend" onClick={() => handleSuspend(w.guid)} />
                          <IconButton icon={X} label="Close" variant="danger" onClick={() => handleClose(w.guid)} />
                        </>
                      ) : (
                        <IconButton icon={Play} label="Reopen" onClick={() => handleReopen(w)} />
                      )}
                    </div>
                  </div>
                  <TagList guid={w.guid} tags={w.tags} className="window-item-tags" onError={setError} />
                </div>
              )}
            />
          </div>
        </>
      )}

      {view === 'groups' && currentWindow && (
        <>
          <div className="toolbar">
            <span className="muted">Tab groups</span>
            <div className="toolbar-actions">
              <IconButton icon={Plus} label="New tab group" onClick={() => handleCreateTabGroup(currentWindow.guid)} />
              <IconButton
                icon={ArrowUpDown}
                label={reordering ? 'Stop sorting' : 'Sort'}
                variant={reordering ? 'danger' : 'default'}
                onClick={() => setReordering((v) => !v)}
                disabled={!reordering && groupsOfCurrentWindow.length < 2}
              />
            </div>
          </div>

          <div className="window-group">
            <LevelPanel
              items={groupsOfCurrentWindow}
              getId={(g) => g.guid}
              reordering={reordering}
              onDoneReordering={() => setReordering(false)}
              onReorder={(newGroups) => saveTabGroupOrder(currentWindow.guid, newGroups.map((g) => g.guid))}
              emptyMessage="No tab groups yet."
              renderReorderLabel={(g) => (
                <span className="muted">
                  {g.name ?? `Tab group · ${formatDateTime(g.createdAt)}`} ({g.tabs.length} tab{g.tabs.length === 1 ? '' : 's'})
                </span>
              )}
              renderRow={(g) => (
                <div className={`window-item ${g.guid === currentGroupGuid ? 'recently-visited' : ''}`}>
                  <div className="window-item-row">
                    <button className="link-button window-item-main" onClick={() => openGroup(g.guid)}>
                      <span className="muted window-item-date">{g.name ?? `Tab group · ${formatDateTime(g.createdAt)}`}</span>
                      <span className="muted window-item-state">
                        {g.tabs.length} tab{g.tabs.length === 1 ? '' : 's'}
                      </span>
                    </button>
                    <div className="row-actions">
                      <IconButton icon={Pencil} label="Rename tab group" onClick={() => setRenamingGroup(g)} />
                    </div>
                  </div>
                  <TagList guid={g.guid} tags={g.tags} className="window-item-tags" onError={setError} />
                </div>
              )}
            />
          </div>
        </>
      )}

      {view === 'tabs' && currentGroup && (
        <>
          <div className="toolbar">
            <span className="muted">Tabs</span>
            <div className="toolbar-actions">
              <IconButton icon={Plus} label="New tab" onClick={() => handleAddBlankTab(currentGroup.guid)} />
              {canPaste && <IconButton icon={ClipboardPaste} label="Paste tab into this group" onClick={handlePasteTab} />}
              <IconButton
                icon={ArrowUpDown}
                label={reordering ? 'Stop sorting' : 'Sort'}
                variant={reordering ? 'danger' : 'default'}
                onClick={() => setReordering((v) => !v)}
                disabled={!reordering && tabsOfCurrentGroup.length < 2}
              />
            </div>
          </div>

          <div className="window-group">
            <LevelPanel
              items={tabsOfCurrentGroup}
              getId={(t) => t.guid}
              reordering={reordering}
              onDoneReordering={() => setReordering(false)}
              onReorder={(newTabs) => saveTabOrder(currentGroup.guid, newTabs.map((t) => t.guid))}
              emptyMessage="No tabs yet."
              renderReorderLabel={(t) => <span>{t.tabText ? t.tabText.firstRow.map((s) => s.text).join(' ') : t.resourceId}</span>}
              renderRow={(t) => (
                <TabRow
                  tab={t}
                  cut={cutTab?.guid === t.guid}
                  onError={setError}
                  onMove={() => setMovingTab(t)}
                  onCut={() => setCutTab(t)}
                  onClone={() => handleCloneTab(t.guid)}
                  onActivate={() => handleActivateTab(t.guid)}
                />
              )}
            />
          </div>
        </>
      )}

      {liveDetailsFor && (
        <WindowDetailsModal record={liveDetailsFor} onClose={() => setDetailsFor(null)} onError={setError} />
      )}

      {movingTab && (
        <MoveTabModal candidates={moveCandidates} onMove={handleMoveTab} onClose={() => setMovingTab(null)} />
      )}

      {renamingGroup && (
        <RenameGroupModal
          group={renamingGroup}
          onRename={(name) => handleRenameGroup(renamingGroup.guid, name)}
          onClose={() => setRenamingGroup(null)}
        />
      )}
    </div>
  )
}
