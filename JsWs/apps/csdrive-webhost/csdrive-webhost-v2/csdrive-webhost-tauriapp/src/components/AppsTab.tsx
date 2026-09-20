import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowRightLeft,
  ArrowUpDown,
  Check,
  CheckCheck,
  ClipboardPaste,
  Copy,
  CopyPlus,
  AppWindow,
  ExternalLink,
  FilePlus,
  Fingerprint,
  Globe,
  Hash,
  FolderPlus,
  Link,
  Pause,
  PauseCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Scissors,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'
import { confirm } from '@tauri-apps/plugin-dialog'
import IconButton from './IconButton'
import Modal from './Modal'
import { TagList } from './Tags'
import ReorderList from './ReorderList'
import { getAppState, setAppState } from '../lib/appState'
import { kbdItem, useListKeyboard } from '../lib/keyboard'
import { isObject, isStringOrNull } from '../lib/tabState'
import { rootOfTab } from '../lib/rootTags'
import {
  activateTab,
  addBlankTab,
  addSecondaryWindowEntry,
  cloneTab,
  closeAllSecondaryWindows,
  closeExternalSite,
  closeSecondaryWindow,
  closeTab,
  createTabGroup,
  deleteTabGroup,
  focusExternalSite,
  focusSecondaryWindow,
  listSecondaryWindows,
  listSystemApps,
  listTags,
  moveTabToGroup,
  onSecondaryWindowsChanged,
  openNewSecondaryWindow,
  renameTabGroup,
  reopenExternalSite,
  reopenSecondaryWindow,
  suspendAllSecondaryWindows,
  suspendExternalSite,
  suspendSecondaryWindow,
  type ExternalPageRecord,
  type OpenedAppRecord,
  type SecondaryWindowRecord,
  type SystemAppInfo,
  type TabGroupRecord,
  type TabRecord,
  type TabTextSpan,
  type TagRecord,
  type WindowKind,
} from '../lib/secondaryWindows'

/** What the two ways of getting rid of a window do — the buttons say so in their tooltips. */
const SUSPEND_HINT = 'Suspend — closes the window, keeps its entry in this list'
const CLOSE_HINT = 'Close — closes the window and removes its entry from this list'
const SUSPEND_ALL_HINT = 'Suspend all — closes the windows, keeps their entries in this list'
const CLOSE_ALL_HINT = 'Close all — closes the windows and removes their entries from this list'

/** The levels of the window manager. `external` — the external web sites opened from one tab's page — is
 * one level below the tabs: those sites are not tabs, but children of the tab that asked for them. */
type View = 'apps' | 'windows' | 'groups' | 'tabs' | 'external'
const VIEW_DEPTH: Record<View, number> = { apps: 0, windows: 1, groups: 2, tabs: 3, external: 4 }

interface Group {
  relativePath: string
  windows: SecondaryWindowRecord[]
}

/** `catalog` is the fixed list of system apps (empty for user apps, which exist only through their
 * windows): each is listed even before it has a window. */
function groupByPath(records: SecondaryWindowRecord[], catalog: SystemAppInfo[]): Group[] {
  const map = new Map<string, SecondaryWindowRecord[]>()
  for (const app of catalog) map.set(app.relativePath, [])
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

/** The tags of every root that the tabs of `records` show. */
async function fetchRootTags(records: SecondaryWindowRecord[]): Promise<TagRecord[]> {
  const guids = new Set<string>()
  for (const record of records) {
    for (const group of record.tabGroups) {
      for (const tab of group.tabs) {
        const root = rootOfTab(tab)
        if (root) guids.add(root.guid)
      }
    }
  }
  return guids.size > 0 ? listTags(Array.from(guids)) : []
}

/** What is listed under a tab: an external web site opened from its page, or a web app opened from it (a Notes
 * tab's files) — oldest first before any saved order is applied. */
type Child =
  | { kind: 'site'; guid: string; createdAt: number; page: ExternalPageRecord }
  | { kind: 'app'; guid: string; createdAt: number; app: OpenedAppRecord }

function childrenOf(tab: TabRecord): Child[] {
  const all: Child[] = [
    ...tab.externalPages.map((page): Child => ({ kind: 'site', guid: page.guid, createdAt: page.createdAt, page })),
    ...tab.openedApps.map((app): Child => ({ kind: 'app', guid: app.guid, createdAt: app.createdAt, app })),
  ]
  return all.sort((a, b) => a.createdAt - b.createdAt)
}

/** What a tab is called in a breadcrumb: its label's first row, else its resource id. */
function tabLabel(tab: TabRecord): string {
  const first = tab.tabText?.firstRow.map((span) => span.text).join('')
  return first || tab.resourceId || 'New tab'
}

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

/** The two tabs (User Apps, System Apps) are this same component and each keeps its own saved order. */
const STATE_PREFIX: Record<WindowKind, string> = { user: 'windowsTab', system: 'systemAppsTab' }

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

/** A tab's resource identifier — what identifies the resource the tab shows, inside its app (a file, a
 * folder, an address…; for a Notes tab, `system:notes?s=…&p=…`) — to read and to copy. */
function ResourceIdModal({ tab, onClose, onError }: { tab: TabRecord; onClose: () => void; onError: (message: string) => void }) {
  const id = tab.resourceId
  return (
    <Modal title="Resource identifier" onClose={onClose}>
      <div className="modal-field-label">Identifies what this tab shows, within its app</div>
      <div className="modal-guid-row">
        <code className="window-item-guid resource-id">{id || '(none yet — the app hasn\'t said)'}</code>
        <IconButton
          icon={Copy}
          label="Copy the resource identifier"
          disabled={!id}
          onClick={() => copyToClipboard(id).catch((e) => onError(String(e)))}
        />
      </div>
      <div className="modal-field-label">The app's page</div>
      <code className="window-item-guid">{tab.relativePath}</code>
    </Modal>
  )
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
  rootTags,
  cut,
  onError,
  onRootTagsChanged,
  onMove,
  onCut,
  onClone,
  onActivate,
  onClose,
  onOpenExternal,
  onShowResourceId,
}: {
  tab: TabRecord
  /** The tags of every root the listed tabs show (see `rootOfTab`); this tab's are picked out by guid. */
  rootTags: TagRecord[]
  cut: boolean
  onError: (message: string) => void
  onRootTagsChanged: () => void
  onMove: () => void
  onCut: () => void
  onClone: () => void
  onActivate: () => void
  onClose: () => void
  /** Shows the external web sites opened from this tab. */
  onOpenExternal: () => void
  /** Shows the tab's resource identifier (to read and copy). */
  onShowResourceId: () => void
}) {
  // A tab that shows a root (a folder, a Filen account) has two sets of tags: the root's — the same
  // wherever that root appears — and its own. When both are shown each line says which it is.
  const root = rootOfTab(tab)
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
          <IconButton
            icon={Globe}
            label={
              tab.externalPages.length + tab.openedApps.length > 0
                ? `Opened from this tab — web apps and external web sites (${tab.externalPages.length + tab.openedApps.length})`
                : 'Opened from this tab — web apps and external web sites (none yet)'
            }
            onClick={onOpenExternal}
          />
          {tab.externalPages.length + tab.openedApps.length > 0 && (
            <span className="muted tab-row-external-count">{tab.externalPages.length + tab.openedApps.length}</span>
          )}
          <IconButton icon={Hash} label="Resource identifier — view and copy" onClick={onShowResourceId} />
          <IconButton icon={ArrowRightLeft} label="Move to…" onClick={onMove} />
          <IconButton icon={Scissors} label="Cut (paste into another tab group)" onClick={onCut} />
          <IconButton icon={CopyPlus} label="Clone tab" onClick={onClone} />
          <IconButton icon={X} label="Close tab (suspends its window if the window is showing it)" variant="danger" onClick={onClose} />
        </div>
      </div>
      {root ? (
        <>
          <div className="tab-tags-line">
            <span className="tab-tags-caption" title="Tags of the folder or account this tab shows — shared by every tab on it, and by the Files tab">
              Root
            </span>
            <TagList
              guid={root.guid}
              tags={rootTags.filter((t) => t.guid === root.guid)}
              className="tab-tags-list"
              onChanged={onRootTagsChanged}
              onError={onError}
            />
          </div>
          <div className="tab-tags-line">
            <span className="tab-tags-caption" title="Tags of this tab only">
              Tab
            </span>
            <TagList guid={tab.guid} tags={tab.tags} className="tab-tags-list" onError={onError} />
          </div>
        </>
      ) : (
        <TagList guid={tab.guid} tags={tab.tags} className="window-item-tags" onError={onError} />
      )}
    </div>
  )
}

/** One external web site, listed under the tab whose page opened it: an icon for "a web site", the page's
 * title on the top row (once it has one) and its address on the bottom row. Its own commands — no
 * init/update requests come from an external page, so nothing else is known about it. */
function ExternalRow({
  page,
  onError,
  onCopy,
  onOpen,
  onFocus,
  onSuspend,
  onClose,
}: {
  page: ExternalPageRecord
  onError: (message: string) => void
  onCopy: (text: string) => void
  onOpen: () => void
  onFocus: () => void
  onSuspend: () => void
  onClose: () => void
}) {
  const redirected = page.url !== page.initialUrl
  return (
    <div className={`window-item tab-row ${page.isOpen ? 'open' : 'suspended'}`}>
      <div className="tab-row-header">
        <span className="tab-row-icon external-icon" title="An external web site">
          <Globe size={18} strokeWidth={2} aria-hidden="true" />
        </span>
        <button className="link-button tab-row-title-block" onClick={page.isOpen ? onFocus : onOpen} title={page.isOpen ? 'Bring its window to the front' : 'Open its window again'}>
          <div className={`tab-row-title ${page.title ? '' : 'muted'}`}>{page.title ?? 'No title'}</div>
          <div className="tab-row-subtitle external-url" title={page.url}>
            {page.url}
          </div>
        </button>
        <div className="row-actions">
          <span className={`status-dot ${page.isOpen ? 'status-open' : 'status-suspended'}`} title={page.isOpen ? 'Open' : 'Suspended'} />
          <IconButton icon={Copy} label="Copy the address to the clipboard" onClick={() => onCopy(page.url)} />
          <IconButton
            icon={Link}
            label={`Copy the address it was first opened at${redirected ? '' : ' (the same as its address now)'}`}
            onClick={() => onCopy(page.initialUrl)}
          />
          {page.isOpen ? (
            <>
              <IconButton icon={ExternalLink} label="Bring its window to the front" onClick={onFocus} />
              <IconButton icon={Pause} label={SUSPEND_HINT} onClick={onSuspend} />
            </>
          ) : (
            <IconButton icon={Play} label="Reopen its window" onClick={onOpen} />
          )}
          <IconButton icon={X} label={CLOSE_HINT} variant="danger" onClick={onClose} />
        </div>
      </div>
      <TagList guid={page.guid} tags={page.tags} className="window-item-tags" onError={onError} />
    </div>
  )
}

/** A web app opened from a Notes tab: its own window (its file is in a folder or in a Filen account), listed under
 * the tab that opened it. The page's title and path on two rows, and the window's own commands. */
function OpenedAppRow({
  app,
  onError,
  onOpen,
  onFocus,
  onSuspend,
  onClose,
}: {
  app: OpenedAppRecord
  onError: (message: string) => void
  onOpen: () => void
  onFocus: () => void
  onSuspend: () => void
  onClose: () => void
}) {
  const title = app.tabText?.firstRow.map((s) => s.text).join('') || app.path.split('/').pop() || app.path
  const where = app.storage === 'FilenCloud' ? 'Filen' : app.storage === 'DeviceFolder' ? 'This device' : 'User folder'
  return (
    <div className={`window-item tab-row ${app.isOpen ? 'open' : 'suspended'}`}>
      <div className="tab-row-header">
        <span className="tab-row-icon external-icon" title="A web app opened from this Notes tab">
          <AppWindow size={18} strokeWidth={2} aria-hidden="true" />
        </span>
        <button className="link-button tab-row-title-block" onClick={app.isOpen ? onFocus : onOpen} title={app.isOpen ? 'Bring its window to the front' : 'Reopen its window'}>
          <div className="tab-row-title">{title}</div>
          <div className="tab-row-subtitle external-url" title={app.path}>
            {where} · {app.path}
          </div>
        </button>
        <div className="row-actions">
          <span className={`status-dot ${app.isOpen ? 'status-open' : 'status-suspended'}`} title={app.isOpen ? 'Open' : 'Suspended'} />
          {app.isOpen ? (
            <>
              <IconButton icon={ExternalLink} label="Bring its window to the front" onClick={onFocus} />
              <IconButton icon={Pause} label={SUSPEND_HINT} onClick={onSuspend} />
            </>
          ) : (
            <IconButton icon={Play} label="Reopen its window" onClick={onOpen} />
          )}
          <IconButton icon={X} label={CLOSE_HINT} variant="danger" onClick={onClose} />
        </div>
      </div>
      <TagList guid={app.guid} tags={app.tags} className="window-item-tags" onError={onError} />
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
  focusedIndex,
  onFocusItem,
}: {
  items: T[]
  getId: (item: T) => string
  renderRow: (item: T) => ReactNode
  renderReorderLabel: (item: T) => ReactNode
  reordering: boolean
  onDoneReordering: () => void
  onReorder: (items: T[]) => void
  emptyMessage: string
  /** The item the arrow keys are on, and how a press on an item moves it there. */
  focusedIndex: number
  onFocusItem: (index: number) => void
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
      {items.map((item, i) => (
        <li key={getId(item)} {...kbdItem(focusedIndex, i, onFocusItem)}>
          {renderRow(item)}
        </li>
      ))}
    </ul>
  )
}

/** Manages the windows, tab groups and tabs of one kind of app: the web apps in the user folder
 * (`user`) or the app's own system apps (`system`, whose list is fixed — nothing can be added). */
export default function AppsTab({ kind }: { kind: WindowKind }) {
  const statePrefix = STATE_PREFIX[kind]
  const USE_CUSTOM_ORDER_KEY = `${statePrefix}.useCustomOrder`
  const GROUP_ORDER_KEY = `${statePrefix}.groupOrder`
  const ITEM_ORDER_KEY = `${statePrefix}.itemOrder`
  const TAB_GROUP_ORDER_KEY = `${statePrefix}.tabGroupOrder`
  const TAB_ORDER_KEY = `${statePrefix}.tabOrder`
  const EXTERNAL_ORDER_KEY = `${statePrefix}.externalOrder`
  const isSystem = kind === 'system'

  const [records, setRecords] = useState<SecondaryWindowRecord[]>([])
  const [catalog, setCatalog] = useState<SystemAppInfo[]>([])
  const [rootTags, setRootTags] = useState<TagRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [view, setView] = useState<View>('apps')
  const [currentApp, setCurrentApp] = useState<string | null>(null)
  const [currentWindowGuid, setCurrentWindowGuid] = useState<string | null>(null)
  const [currentGroupGuid, setCurrentGroupGuid] = useState<string | null>(null)
  // The tab whose external web sites are shown (the `external` level).
  const [currentTabGuid, setCurrentTabGuid] = useState<string | null>(null)
  const [reordering, setReordering] = useState(false)
  // Where the person was (and so where they are back to on returning to this tab page), read at the start.
  const NAVIGATION_KEY = `${statePrefix}.navigation`
  const [navigationLoaded, setNavigationLoaded] = useState(false)
  const [recordsLoaded, setRecordsLoaded] = useState(false)
  // The item the arrow keys are on, and whether the last move of the view was made with the keys.
  const [kbdFocus, setKbdFocus] = useState(-1)
  const keyboardMovedRef = useRef(false)

  const [detailsFor, setDetailsFor] = useState<SecondaryWindowRecord | null>(null)
  const [movingTab, setMovingTab] = useState<TabRecord | null>(null)
  const [cutTab, setCutTab] = useState<TabRecord | null>(null)
  const [renamingGroup, setRenamingGroup] = useState<TabGroupRecord | null>(null)
  const [resourceIdFor, setResourceIdFor] = useState<TabRecord | null>(null)

  const [useCustomOrder, setUseCustomOrderState] = useState(false)
  const [groupOrder, setGroupOrderState] = useState<string[]>([])
  const [itemOrder, setItemOrderState] = useState<Record<string, string[]>>({})
  const [tabGroupOrder, setTabGroupOrderState] = useState<Record<string, string[]>>({})
  const [tabOrder, setTabOrderState] = useState<Record<string, string[]>>({})
  // The order of the external web sites of each tab. They can be reordered within their tab and nowhere
  // else: there is no way to move one under another tab, which is the one that opened it.
  const [externalOrder, setExternalOrderState] = useState<Record<string, string[]>>({})

  const appName = (relativePath: string) => catalog.find((a) => a.relativePath === relativePath)?.name ?? relativePath

  useEffect(() => {
    getAppState<boolean>(USE_CUSTOM_ORDER_KEY).then((saved) => setUseCustomOrderState(saved ?? false))
    getAppState<string[]>(GROUP_ORDER_KEY).then((saved) => setGroupOrderState(saved ?? []))
    getAppState<Record<string, string[]>>(ITEM_ORDER_KEY).then((saved) => setItemOrderState(saved ?? {}))
    getAppState<Record<string, string[]>>(TAB_GROUP_ORDER_KEY).then((saved) => setTabGroupOrderState(saved ?? {}))
    getAppState<Record<string, string[]>>(TAB_ORDER_KEY).then((saved) => setTabOrderState(saved ?? {}))
    getAppState<Record<string, string[]>>(EXTERNAL_ORDER_KEY).then((saved) => setExternalOrderState(saved ?? {}))
  }, [])

  // Restore the navigation. Whether it still leads anywhere is judged once the list has loaded (below).
  useEffect(() => {
    getAppState<unknown>(NAVIGATION_KEY).then((saved) => {
      if (isObject(saved) && typeof saved.view === 'string' && saved.view in VIEW_DEPTH && isStringOrNull(saved.app) && isStringOrNull(saved.window) && isStringOrNull(saved.group) && (saved.tab === undefined || isStringOrNull(saved.tab))) {
        setView(saved.view as View)
        setCurrentApp(saved.app)
        setCurrentWindowGuid(saved.window)
        setCurrentGroupGuid(saved.group)
        setCurrentTabGuid(saved.tab ?? null)
      }
      setNavigationLoaded(true)
    }, () => setNavigationLoaded(true))
  }, [])

  useEffect(() => {
    if (navigationLoaded) setAppState(NAVIGATION_KEY, { view, app: currentApp, window: currentWindowGuid, group: currentGroupGuid, tab: currentTabGuid }).catch(() => {})
  }, [navigationLoaded, view, currentApp, currentWindowGuid, currentGroupGuid, currentTabGuid])

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

  function saveExternalOrder(tabGuid: string, order: string[]) {
    setExternalOrderState((prev) => {
      const next = { ...prev, [tabGuid]: order }
      setAppState(EXTERNAL_ORDER_KEY, next)
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
      if (isSystem) setCatalog(await listSystemApps())
      const list = await listSecondaryWindows(kind)
      setRecords(list)
      setRecordsLoaded(true)
      setRootTags(await fetchRootTags(list))
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [kind, isSystem])

  useEffect(() => {
    refresh()
    const unlistenPromise = onSecondaryWindowsChanged(refresh)
    return () => {
      unlistenPromise.then((unlisten) => unlisten())
    }
  }, [refresh])

  async function refreshRootTags() {
    try {
      setRootTags(await fetchRootTags(records))
    } catch (e) {
      setError(String(e))
    }
  }

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
      await reopenSecondaryWindow(record.guid)
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleCloseAll(relativePath?: string) {
    try {
      await closeAllSecondaryWindows(kind, relativePath)
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleSuspendAll(relativePath?: string) {
    try {
      await suspendAllSecondaryWindows(kind, relativePath)
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleAddEntry(relativePath: string): Promise<boolean> {
    try {
      await addSecondaryWindowEntry(kind, relativePath)
      return true
    } catch (e) {
      setError(String(e))
      return false
    }
  }

  async function handleOpenNew(relativePath: string) {
    try {
      await openNewSecondaryWindow(kind, relativePath)
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleCloseTab(tabGuid: string) {
    try {
      await closeTab(tabGuid)
      // Nothing may keep pointing at the tab that's gone.
      setCutTab((cut) => (cut?.guid === tabGuid ? null : cut))
      setMovingTab((moving) => (moving?.guid === tabGuid ? null : moving))
      setCurrentTabGuid((current) => (current === tabGuid ? null : current))
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleExternal(work: () => Promise<void>) {
    try {
      await work()
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleCopy(text: string) {
    try {
      await copyToClipboard(text)
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleDeleteTabGroup(group: TabGroupRecord) {
    const what = group.name ?? 'this tab group'
    const tabs = group.tabs.length
    if (tabs > 0 && !(await confirm(`Delete "${what}" and its ${tabs} tab${tabs === 1 ? '' : 's'}?`))) return
    try {
      await deleteTabGroup(group.guid)
      // Nothing may keep pointing at a tab that's gone.
      setCutTab((cut) => (cut?.groupGuid === group.guid ? null : cut))
      setMovingTab((moving) => (moving?.groupGuid === group.guid ? null : moving))
    } catch (e) {
      setError(String(e))
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

  const apps = applyOrder(groupByPath(records, catalog), (g) => g.relativePath, useCustomOrder, groupOrder)
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
  const currentTab = currentGroup?.tabs.find((t) => t.guid === currentTabGuid) ?? null
  const externalOfCurrentTab = currentTab ? applyOrder(childrenOf(currentTab), (c) => c.guid, true, externalOrder[currentTab.guid]) : []

  // If whatever the user last drilled into has since vanished (window closed,
  // etc.), fall back to the deepest level that's still valid instead of showing
  // a blank/broken screen.
  useEffect(() => {
    if (!navigationLoaded || !recordsLoaded) return // (a saved place isn't judged against a list that hasn't arrived)
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
      return
    }
    if (view === 'tabs') return
    if (!currentTab) {
      setView('tabs')
      setCurrentTabGuid(null)
    }
  }, [navigationLoaded, recordsLoaded, records, view, currentAppGroup, currentWindow, currentGroup, currentTab])

  // ── Keyboard: Up/Down/Home/End/PageUp/PageDown through the list of the level shown, Left to the level
  // above, Right into (or, for a tab, to) the focused item.
  const levelIds =
    view === 'apps'
      ? apps.map((g) => g.relativePath)
      : view === 'windows'
        ? windowsOfCurrentApp.map((w) => w.guid)
        : view === 'groups'
          ? groupsOfCurrentWindow.map((g) => g.guid)
          : view === 'tabs'
            ? tabsOfCurrentGroup.map((t) => t.guid)
            : externalOfCurrentTab.map((c) => c.guid)
  const levelCurrent = view === 'apps' ? currentApp : view === 'windows' ? currentWindowGuid : view === 'groups' ? currentGroupGuid : view === 'tabs' ? currentTabGuid : null

  // A new level: the keys start from the item the person came from (going up) or the first one (going
  // down); after a click, nothing is focused until a key is pressed.
  useEffect(() => {
    const byKeyboard = keyboardMovedRef.current
    keyboardMovedRef.current = false
    setKbdFocus(byKeyboard && levelIds.length > 0 ? Math.max(0, levelCurrent ? levelIds.indexOf(levelCurrent) : 0) : -1)
  }, [view, recordsLoaded])

  const PARENT_VIEW: Record<View, View | null> = { apps: null, windows: 'apps', groups: 'windows', tabs: 'groups', external: 'tabs' }
  /** A listed child's window (an external web site, or a web app opened from the tab): brought to the front if it is
   * open, otherwise opened again. */
  const showExternal = (child: Child) => {
    const open = child.kind === 'site' ? child.page.isOpen : child.app.isOpen
    if (child.kind === 'site') return handleExternal(() => (open ? focusExternalSite(child.guid) : reopenExternalSite(child.guid)))
    return handleExternal(() => (open ? focusSecondaryWindow(child.guid) : reopenSecondaryWindow(child.guid)))
  }
  useListKeyboard({
    count: levelIds.length,
    focused: kbdFocus,
    setFocused: setKbdFocus,
    enabled: !reordering && !detailsFor && !movingTab && !renamingGroup && !resourceIdFor,
    // Right: into the item — and on an external web site, which has nothing below it, to its window.
    onOpen: (i) => {
      if (view === 'external') {
        const child = externalOfCurrentTab[i]
        if (child) showExternal(child)
        return
      }
      keyboardMovedRef.current = true
      if (view === 'apps') openApp(levelIds[i])
      else if (view === 'windows') openWindow(levelIds[i])
      else if (view === 'groups') openGroup(levelIds[i])
      else {
        setCurrentTabGuid(levelIds[i])
        navigate('external')
      }
    },
    // Enter: a tab is shown (its window opened if need be); everything else is opened, as with Right.
    onActivate: (i) => {
      if (view === 'tabs') handleActivateTab(levelIds[i])
      else if (view === 'external') {
        const child = externalOfCurrentTab[i]
        if (child) showExternal(child)
      } else {
        keyboardMovedRef.current = true
        if (view === 'apps') openApp(levelIds[i])
        else if (view === 'windows') openWindow(levelIds[i])
        else openGroup(levelIds[i])
      }
    },
    onParent: PARENT_VIEW[view]
      ? () => {
          keyboardMovedRef.current = true
          navigate(PARENT_VIEW[view]!)
        }
      : undefined,
  })

  const liveDetailsFor = detailsFor ? records.find((r) => r.guid === detailsFor.guid) ?? null : null
  const moveCandidates: MoveCandidate[] = movingTab
    ? records
        .filter((r) => r.relativePath === movingTab.relativePath)
        .flatMap((r) => r.tabGroups.map((group) => ({ windowGuid: r.guid, windowCreatedAt: r.createdAt, group })))
        .filter((c) => c.group.guid !== movingTab.groupGuid)
    : []

  // What can be done with the window being browsed — shown in its tab groups view and in the tabs view of
  // one of its groups (suspend/close there act on the whole window, not on the group or the tab).
  const currentWindowActions = currentWindow && (
    <>
      {currentWindow.isOpen ? (
        <IconButton icon={Pause} label={SUSPEND_HINT} onClick={() => handleSuspend(currentWindow.guid)} />
      ) : (
        <IconButton icon={Play} label="Reopen" onClick={() => handleReopen(currentWindow)} />
      )}
      <IconButton icon={X} label={CLOSE_HINT} variant="danger" onClick={() => handleClose(currentWindow.guid)} />
    </>
  )

  const depth = VIEW_DEPTH[view]
  const canPaste = !!(cutTab && currentGroup && cutTab.relativePath === currentApp && cutTab.groupGuid !== currentGroup.guid)

  return (
    <div className="tab-panel">
      <div className="toolbar">
        <div className="breadcrumbs">
          <span>
            <button className={`link-button ${view === 'apps' ? 'active' : ''}`} onClick={() => navigate('apps')}>
              {isSystem ? 'System Apps' : 'User Apps'}
            </button>
          </span>
          {depth >= 1 && currentApp && (
            <span>
              <span className="crumb-sep">/</span>
              <button className={`link-button ${view === 'windows' ? 'active' : ''}`} onClick={() => navigate('windows')}>
                {appName(currentApp)}
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
          {depth >= 4 && currentTab && (
            <span>
              <span className="crumb-sep">/</span>
              <button className={`link-button ${view === 'external' ? 'active' : ''}`} onClick={() => navigate('external')}>
                Opened from · {tabLabel(currentTab)}
              </button>
            </span>
          )}
        </div>
        <div className="toolbar-actions">
          {view === 'apps' && (
            <>
              <IconButton icon={PauseCircle} label={SUSPEND_ALL_HINT} onClick={() => handleSuspendAll()} disabled={records.length === 0} />
              <IconButton icon={XCircle} label={CLOSE_ALL_HINT} variant="danger" onClick={() => handleCloseAll()} disabled={records.length === 0} />
            </>
          )}
          <IconButton icon={RefreshCw} label="Refresh" onClick={refresh} />
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="muted">Loading…</div>}

      {view === 'apps' && (
        <>
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

          {!isSystem && <AddGroupRow onAdd={handleAddEntry} />}

          <div className="window-group">
            <LevelPanel
              items={apps}
              getId={(g) => g.relativePath}
              reordering={reordering}
              onDoneReordering={() => setReordering(false)}
              onReorder={(newApps) => saveGroupOrder(newApps.map((g) => g.relativePath))}
              emptyMessage={isSystem ? 'No system apps.' : 'No web apps open yet. Open an .html file from the Files tab as a web app to see it here.'}
              focusedIndex={kbdFocus}
              onFocusItem={setKbdFocus}
              renderReorderLabel={(g) => (
                <span>
                  <span className="window-group-path">{appName(g.relativePath)}</span>{' '}
                  <span className="muted">
                    ({g.windows.length} window{g.windows.length === 1 ? '' : 's'})
                  </span>
                </span>
              )}
              renderRow={(g) => (
                <div className={`window-item ${g.relativePath === currentApp ? 'recently-visited' : ''}`}>
                  <div className="window-item-row">
                    <button className="link-button window-item-main" onClick={() => openApp(g.relativePath)}>
                      <span className="window-group-path">{appName(g.relativePath)}</span>
                      <span className="muted window-item-state">
                        {g.windows.length} window{g.windows.length === 1 ? '' : 's'}
                      </span>
                    </button>
                    <div className="row-actions">
                      {isSystem && <IconButton icon={ExternalLink} label="Open in a new window" onClick={() => handleOpenNew(g.relativePath)} />}
                      <IconButton icon={FilePlus} label="Add a new window entry without opening it" onClick={() => handleAddEntry(g.relativePath)} />
                      <IconButton icon={PauseCircle} label={SUSPEND_ALL_HINT} onClick={() => handleSuspendAll(g.relativePath)} />
                      <IconButton icon={XCircle} label={CLOSE_ALL_HINT} variant="danger" onClick={() => handleCloseAll(g.relativePath)} />
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
              {isSystem && <IconButton icon={ExternalLink} label="Open in a new window" onClick={() => handleOpenNew(currentApp!)} />}
              <IconButton icon={FilePlus} label="Add a new window entry without opening it" onClick={() => handleAddEntry(currentApp!)} />
              <IconButton icon={PauseCircle} label={SUSPEND_ALL_HINT} onClick={() => handleSuspendAll(currentApp!)} />
              <IconButton icon={XCircle} label={CLOSE_ALL_HINT} variant="danger" onClick={() => handleCloseAll(currentApp!)} />
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
              focusedIndex={kbdFocus}
              onFocusItem={setKbdFocus}
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
                          <IconButton icon={Pause} label={SUSPEND_HINT} onClick={() => handleSuspend(w.guid)} />
                          <IconButton icon={X} label={CLOSE_HINT} variant="danger" onClick={() => handleClose(w.guid)} />
                        </>
                      ) : (
                        <>
                          <IconButton icon={Play} label="Reopen" onClick={() => handleReopen(w)} />
                          <IconButton icon={X} label={CLOSE_HINT} variant="danger" onClick={() => handleClose(w.guid)} />
                        </>
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
              {currentWindowActions}
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
              focusedIndex={kbdFocus}
              onFocusItem={setKbdFocus}
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
                      <IconButton
                        icon={Trash2}
                        label="Delete tab group (and its tabs)"
                        variant="danger"
                        onClick={() => handleDeleteTabGroup(g)}
                      />
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
              {currentWindowActions}
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
              focusedIndex={kbdFocus}
              onFocusItem={setKbdFocus}
              renderReorderLabel={(t) => <span>{t.tabText ? t.tabText.firstRow.map((s) => s.text).join(' ') : t.resourceId}</span>}
              renderRow={(t) => (
                <TabRow
                  tab={t}
                  rootTags={rootTags}
                  cut={cutTab?.guid === t.guid}
                  onError={setError}
                  onRootTagsChanged={refreshRootTags}
                  onMove={() => setMovingTab(t)}
                  onCut={() => setCutTab(t)}
                  onClone={() => handleCloneTab(t.guid)}
                  onActivate={() => handleActivateTab(t.guid)}
                  onClose={() => handleCloseTab(t.guid)}
                  onOpenExternal={() => {
                    setCurrentTabGuid(t.guid)
                    navigate('external')
                  }}
                  onShowResourceId={() => setResourceIdFor(t)}
                />
              )}
            />
          </div>
        </>
      )}

      {view === 'external' && currentTab && (
        <>
          <div className="toolbar">
            <span className="muted">Web apps and external web sites opened from this tab</span>
            <div className="toolbar-actions">
              <IconButton
                icon={ArrowUpDown}
                label={reordering ? 'Stop sorting' : 'Sort'}
                variant={reordering ? 'danger' : 'default'}
                onClick={() => setReordering((v) => !v)}
                disabled={!reordering && externalOfCurrentTab.length < 2}
              />
            </div>
          </div>

          <div className="window-group">
            <LevelPanel
              items={externalOfCurrentTab}
              getId={(c) => c.guid}
              reordering={reordering}
              onDoneReordering={() => setReordering(false)}
              onReorder={(children) => saveExternalOrder(currentTab.guid, children.map((c) => c.guid))}
              emptyMessage="Nothing has been opened from this tab yet."
              focusedIndex={kbdFocus}
              onFocusItem={setKbdFocus}
              renderReorderLabel={(c) =>
                c.kind === 'site' ? (
                  <span>
                    {c.page.title ?? 'No title'} <span className="muted">{c.page.url}</span>
                  </span>
                ) : (
                  <span>
                    {c.app.tabText?.firstRow.map((s) => s.text).join('') || c.app.path} <span className="muted">{c.app.path}</span>
                  </span>
                )
              }
              renderRow={(c) =>
                c.kind === 'site' ? (
                  <ExternalRow
                    page={c.page}
                    onError={setError}
                    onCopy={handleCopy}
                    onOpen={() => handleExternal(() => reopenExternalSite(c.guid))}
                    onFocus={() => handleExternal(() => focusExternalSite(c.guid))}
                    onSuspend={() => handleExternal(() => suspendExternalSite(c.guid))}
                    onClose={() => handleExternal(() => closeExternalSite(c.guid))}
                  />
                ) : (
                  <OpenedAppRow
                    app={c.app}
                    onError={setError}
                    onOpen={() => handleExternal(() => reopenSecondaryWindow(c.guid))}
                    onFocus={() => handleExternal(() => focusSecondaryWindow(c.guid))}
                    onSuspend={() => handleExternal(() => suspendSecondaryWindow(c.guid))}
                    onClose={() => handleExternal(() => closeSecondaryWindow(c.guid))}
                  />
                )
              }
            />
          </div>
        </>
      )}

      {resourceIdFor && <ResourceIdModal tab={resourceIdFor} onClose={() => setResourceIdFor(null)} onError={setError} />}

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
