import { useCallback, useEffect, useState } from 'react'
import {
  ArrowRightLeft,
  ArrowUpDown,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Copy,
  FilePlus,
  Fingerprint,
  FolderPlus,
  ListOrdered,
  Pause,
  PauseCircle,
  Play,
  Plus,
  RefreshCw,
  Tag,
  X,
  XCircle,
} from 'lucide-react'
import IconButton from './IconButton'
import Modal from './Modal'
import ReorderList from './ReorderList'
import { getAppState, setAppState } from '../lib/appState'
import {
  addSecondaryWindowEntry,
  addWindowTag,
  closeAllSecondaryWindows,
  closeSecondaryWindow,
  createTabGroup,
  focusSecondaryWindow,
  listSecondaryWindows,
  moveTabToGroup,
  onSecondaryWindowsChanged,
  removeWindowTag,
  reopenSecondaryWindow,
  suspendAllSecondaryWindows,
  suspendSecondaryWindow,
  type SecondaryWindowRecord,
  type TabGroupRecord,
  type TabRecord,
  type TagRecord,
} from '../lib/secondaryWindows'

const PRESET_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
  '#3b82f6', '#8b5cf6', '#ec4899', '#ffffff', '#000000', '#6b7280',
]

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

const COLLAPSED_GROUPS_KEY = 'windowsTab.collapsedGroups'
const USE_CUSTOM_ORDER_KEY = 'windowsTab.useCustomOrder'
const GROUP_ORDER_KEY = 'windowsTab.groupOrder'
const ITEM_ORDER_KEY = 'windowsTab.itemOrder'
const TAB_GROUP_ORDER_KEY = 'windowsTab.tabGroupOrder'
const TAB_ORDER_KEY = 'windowsTab.tabOrder'
const COLLAPSED_TAB_GROUPS_KEY = 'windowsTab.collapsedTabGroups'

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="color-field">
      <span className="muted">{label}</span>
      <div className="color-swatches">
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`color-swatch ${value.toLowerCase() === c ? 'selected' : ''}`}
            style={{ background: c }}
            onClick={() => onChange(c)}
            title={c}
          />
        ))}
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="color-custom"
          title="Custom color"
        />
      </div>
    </div>
  )
}

function AddTagModal({
  onAdd,
  onClose,
}: {
  onAdd: (text: string, fgColor: string, bgColor: string) => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [fgColor, setFgColor] = useState('#ffffff')
  const [bgColor, setBgColor] = useState('#3b82f6')

  function submit() {
    if (text.trim()) onAdd(text.trim(), fgColor, bgColor)
  }

  return (
    <Modal title="Add tag" onClose={onClose}>
      <input
        autoFocus
        placeholder="tag text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') onClose()
        }}
      />
      <ColorField label="Text color" value={fgColor} onChange={setFgColor} />
      <ColorField label="Background color" value={bgColor} onChange={setBgColor} />
      <div>
        <div className="modal-field-label">Preview</div>
        <span className="tag-badge tag-preview" style={{ color: fgColor, background: bgColor }}>
          {text.trim() || 'preview'}
        </span>
      </div>
      <div className="toolbar-actions" style={{ justifyContent: 'flex-end' }}>
        <IconButton icon={Check} label="Add tag" disabled={!text.trim()} onClick={submit} />
        <IconButton icon={X} label="Cancel" onClick={onClose} />
      </div>
    </Modal>
  )
}

function TagBadge({ tag, onRemove }: { tag: TagRecord; onRemove: () => void }) {
  return (
    <span className="tag-badge" style={{ color: tag.fgColor, background: tag.bgColor }}>
      {tag.text}
      <button className="tag-remove" onClick={onRemove} title="Remove tag" aria-label="Remove tag">
        <X size={11} strokeWidth={2.5} aria-hidden="true" />
      </button>
    </span>
  )
}

function AddTagButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="add-tag-button" onClick={onClick} title="Add tag" aria-label="Add tag">
      <Tag size={12} strokeWidth={2} aria-hidden="true" />
    </button>
  )
}

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

function WindowDetailsModal({ record, onClose }: { record: SecondaryWindowRecord; onClose: () => void }) {
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
        {record.tags.length === 0 ? (
          <div className="muted">No tags.</div>
        ) : (
          <div className="window-item-tags" style={{ padding: 0 }}>
            {record.tags.map((tag) => (
              <span key={tag.id} className="tag-badge" style={{ color: tag.fgColor, background: tag.bgColor }}>
                {tag.text}
              </span>
            ))}
          </div>
        )}
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

function ReorderGroupsModal({
  groups,
  onConfirm,
  onClose,
}: {
  groups: Group[]
  onConfirm: (order: string[]) => void
  onClose: () => void
}) {
  const [order, setOrder] = useState<Group[]>(groups)

  return (
    <Modal title="Reorder groups" onClose={onClose}>
      <ReorderList
        items={order}
        getId={(g) => g.relativePath}
        renderItem={(g) => <span className="window-group-path">{g.relativePath}</span>}
        onChange={setOrder}
      />
      <div className="toolbar-actions" style={{ justifyContent: 'flex-end' }}>
        <IconButton
          icon={Check}
          label="Confirm order"
          onClick={() => {
            onConfirm(order.map((g) => g.relativePath))
            onClose()
          }}
        />
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
        placeholder="Type or paste a relative path (e.g. asdf/index.html) to add a new group…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      <IconButton icon={FolderPlus} label="Add group" onClick={submit} disabled={!value.trim() || busy} />
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

function TabRow({
  tab,
  onAddTag,
  onRemoveTag,
  onMove,
}: {
  tab: TabRecord
  onAddTag: () => void
  onRemoveTag: (id: number) => void
  onMove: () => void
}) {
  return (
    <div className="tab-row">
      <div className="tab-row-header">
        <div className="tab-row-title-block">
          <div className="tab-row-title">{tab.title}</div>
          <div className="muted tab-row-type">{tab.resourceType}</div>
        </div>
        <div className="row-actions">
          <IconButton icon={ArrowRightLeft} label="Move to…" onClick={onMove} />
        </div>
      </div>
      <div className="window-item-tags">
        {tab.tags.map((tag) => (
          <TagBadge key={tag.id} tag={tag} onRemove={() => onRemoveTag(tag.id)} />
        ))}
        <AddTagButton onClick={onAddTag} />
      </div>
    </div>
  )
}

function TabGroupBlock({
  group,
  collapsed,
  onToggleCollapse,
  orderedTabs,
  onReorderTabs,
  onAddGroupTag,
  onRemoveGroupTag,
  onAddTabTag,
  onRemoveTabTag,
  onMoveTab,
}: {
  group: TabGroupRecord
  collapsed: boolean
  onToggleCollapse: () => void
  orderedTabs: TabRecord[]
  onReorderTabs: (tabs: TabRecord[]) => void
  onAddGroupTag: () => void
  onRemoveGroupTag: (id: number) => void
  onAddTabTag: (tabGuid: string) => void
  onRemoveTabTag: (id: number) => void
  onMoveTab: (tab: TabRecord) => void
}) {
  return (
    <div className="tab-group">
      <div className="tab-group-header">
        <button
          className="group-toggle"
          onClick={onToggleCollapse}
          title={collapsed ? 'Expand' : 'Collapse'}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? (
            <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
          ) : (
            <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
          )}
          <span className="muted">Tab group</span>
          <span className="muted window-group-count">({group.tabs.length})</span>
        </button>
        <div className="window-item-tags" style={{ padding: 0 }}>
          {group.tags.map((tag) => (
            <TagBadge key={tag.id} tag={tag} onRemove={() => onRemoveGroupTag(tag.id)} />
          ))}
          <AddTagButton onClick={onAddGroupTag} />
        </div>
      </div>
      {!collapsed &&
        (group.tabs.length === 0 ? (
          <div className="muted tab-group-empty">No tabs yet.</div>
        ) : (
          <ReorderList
            items={orderedTabs}
            getId={(t) => t.guid}
            renderItem={(t) => (
              <TabRow tab={t} onAddTag={() => onAddTabTag(t.guid)} onRemoveTag={onRemoveTabTag} onMove={() => onMoveTab(t)} />
            )}
            onChange={onReorderTabs}
          />
        ))}
    </div>
  )
}

export default function WindowsTab() {
  const [records, setRecords] = useState<SecondaryWindowRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addingTagFor, setAddingTagFor] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [detailsFor, setDetailsFor] = useState<SecondaryWindowRecord | null>(null)
  const [useCustomOrder, setUseCustomOrderState] = useState(false)
  const [groupOrder, setGroupOrderState] = useState<string[]>([])
  const [itemOrder, setItemOrderState] = useState<Record<string, string[]>>({})
  const [reorderGroupsOpen, setReorderGroupsOpen] = useState(false)
  const [reorderItemsFor, setReorderItemsFor] = useState<string | null>(null)
  const [tabGroupOrder, setTabGroupOrderState] = useState<Record<string, string[]>>({})
  const [tabOrder, setTabOrderState] = useState<Record<string, string[]>>({})
  const [collapsedTabGroups, setCollapsedTabGroups] = useState<Record<string, boolean>>({})
  const [movingTab, setMovingTab] = useState<TabRecord | null>(null)

  useEffect(() => {
    getAppState<Record<string, boolean>>(COLLAPSED_GROUPS_KEY).then((saved) => setCollapsed(saved ?? {}))
    getAppState<boolean>(USE_CUSTOM_ORDER_KEY).then((saved) => setUseCustomOrderState(saved ?? false))
    getAppState<string[]>(GROUP_ORDER_KEY).then((saved) => setGroupOrderState(saved ?? []))
    getAppState<Record<string, string[]>>(ITEM_ORDER_KEY).then((saved) => setItemOrderState(saved ?? {}))
    getAppState<Record<string, string[]>>(TAB_GROUP_ORDER_KEY).then((saved) => setTabGroupOrderState(saved ?? {}))
    getAppState<Record<string, string[]>>(TAB_ORDER_KEY).then((saved) => setTabOrderState(saved ?? {}))
    getAppState<Record<string, boolean>>(COLLAPSED_TAB_GROUPS_KEY).then((saved) => setCollapsedTabGroups(saved ?? {}))
  }, [])

  function toggleGroup(relativePath: string) {
    setCollapsed((prev) => {
      const next = { ...prev, [relativePath]: !prev[relativePath] }
      setAppState(COLLAPSED_GROUPS_KEY, next)
      return next
    })
  }

  function toggleTabGroupCollapse(groupGuid: string) {
    setCollapsedTabGroups((prev) => {
      const next = { ...prev, [groupGuid]: !prev[groupGuid] }
      setAppState(COLLAPSED_TAB_GROUPS_KEY, next)
      return next
    })
  }

  function setUseCustomOrder(value: boolean) {
    setUseCustomOrderState(value)
    setAppState(USE_CUSTOM_ORDER_KEY, value)
    if (!value) setReorderItemsFor(null)
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

  async function handleRowClick(record: SecondaryWindowRecord) {
    try {
      if (record.isOpen) {
        await focusSecondaryWindow(record.guid)
      } else {
        await reopenSecondaryWindow(record.guid, record.relativePath)
      }
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

  async function handleAddTag(guid: string, text: string, fgColor: string, bgColor: string) {
    try {
      await addWindowTag(guid, text, fgColor, bgColor)
      setAddingTagFor(null)
    } catch (e) {
      setError(String(e))
    }
  }

  async function handleRemoveTag(id: number) {
    try {
      await removeWindowTag(id)
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

  let groups = applyOrder(groupByPath(records), (g) => g.relativePath, useCustomOrder, groupOrder)
  groups = groups.map((g) => ({
    ...g,
    windows: applyOrder(g.windows, (w) => w.guid, useCustomOrder, itemOrder[g.relativePath]),
  }))
  const liveDetailsFor = detailsFor ? records.find((r) => r.guid === detailsFor.guid) ?? null : null
  const moveCandidates: MoveCandidate[] = movingTab
    ? records
        .filter((r) => r.relativePath === movingTab.relativePath)
        .flatMap((r) => r.tabGroups.map((group) => ({ windowGuid: r.guid, windowCreatedAt: r.createdAt, group })))
        .filter((c) => c.group.guid !== movingTab.groupGuid)
    : []

  return (
    <div className="tab-panel">
      <div className="toolbar">
        <strong>Secondary windows</strong>
        <div className="toolbar-actions">
          <IconButton icon={PauseCircle} label="Suspend all" onClick={() => handleSuspendAll()} disabled={records.length === 0} />
          <IconButton icon={XCircle} label="Close all" variant="danger" onClick={() => handleCloseAll()} disabled={records.length === 0} />
          <IconButton icon={RefreshCw} label="Refresh" onClick={refresh} />
        </div>
      </div>

      <div className="toolbar">
        <label className="custom-order-toggle">
          <input
            type="checkbox"
            checked={useCustomOrder}
            onChange={(e) => setUseCustomOrder(e.target.checked)}
          />
          Use custom order
        </label>
        <div className="toolbar-actions">
          <IconButton
            icon={ListOrdered}
            label="Reorder groups…"
            onClick={() => setReorderGroupsOpen(true)}
            disabled={!useCustomOrder || groups.length < 2}
          />
        </div>
      </div>

      <AddGroupRow onAdd={handleAddEntry} />

      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="muted">Loading…</div>}

      {!loading && groups.length === 0 && (
        <div className="muted">
          No web apps open yet. Open an .html file from the Files tab as a web app to see it here.
        </div>
      )}

      <div className="window-groups">
        {groups.map((group) => {
          const isReorderingItems = reorderItemsFor === group.relativePath
          return (
            <div key={group.relativePath} className="window-group">
              <div className="window-group-header">
                <button
                  className="group-toggle"
                  onClick={() => toggleGroup(group.relativePath)}
                  title={collapsed[group.relativePath] ? 'Expand' : 'Collapse'}
                  aria-label={collapsed[group.relativePath] ? 'Expand' : 'Collapse'}
                >
                  {collapsed[group.relativePath] ? (
                    <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
                  ) : (
                    <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
                  )}
                  <span className="window-group-path">{group.relativePath}</span>
                  <span className="muted window-group-count">({group.windows.length})</span>
                </button>
                <div className="toolbar-actions">
                  {useCustomOrder && (
                    <IconButton
                      icon={ArrowUpDown}
                      label={isReorderingItems ? 'Stop reordering items' : 'Reorder items'}
                      variant={isReorderingItems ? 'danger' : 'default'}
                      onClick={() => setReorderItemsFor(isReorderingItems ? null : group.relativePath)}
                      disabled={group.windows.length < 2 && !isReorderingItems}
                    />
                  )}
                  <IconButton
                    icon={FilePlus}
                    label="Add a new entry without opening it"
                    onClick={() => handleAddEntry(group.relativePath)}
                  />
                  <IconButton icon={PauseCircle} label="Suspend all" onClick={() => handleSuspendAll(group.relativePath)} />
                  <IconButton icon={XCircle} label="Close all" variant="danger" onClick={() => handleCloseAll(group.relativePath)} />
                </div>
              </div>
              {isReorderingItems ? (
                <div className="reorder-panel">
                  <ReorderList
                    items={group.windows}
                    getId={(w) => w.guid}
                    renderItem={(w) => (
                      <span className="reorder-window-item">
                        <span className={`status-dot ${w.isOpen ? 'status-open' : 'status-suspended'}`} />
                        <span className="muted">{formatDateTime(w.createdAt)}</span>
                        <span className="muted">{w.isOpen ? 'Open' : 'Suspended'}</span>
                      </span>
                    )}
                    onChange={(newOrder) => saveItemOrder(group.relativePath, newOrder.map((w) => w.guid))}
                  />
                  <div className="toolbar-actions" style={{ justifyContent: 'flex-end' }}>
                    <IconButton icon={Check} label="Done reordering" onClick={() => setReorderItemsFor(null)} />
                  </div>
                </div>
              ) : (
                !collapsed[group.relativePath] && (
                  <ul className="window-list">
                    {group.windows.map((record) => (
                      <li key={record.guid} className={`window-item ${record.isOpen ? 'open' : 'suspended'}`}>
                        <div className="window-item-row">
                          <button className="link-button window-item-main" onClick={() => handleRowClick(record)}>
                            <span className={`status-dot ${record.isOpen ? 'status-open' : 'status-suspended'}`} />
                            <span className="muted window-item-date">{formatDateTime(record.createdAt)}</span>
                            <span className="muted window-item-state">{record.isOpen ? 'Open' : 'Suspended'}</span>
                          </button>
                          <div className="row-actions">
                            <IconButton icon={Fingerprint} label="Details" onClick={() => setDetailsFor(record)} />
                            {record.isOpen ? (
                              <>
                                <IconButton icon={Pause} label="Suspend" onClick={() => handleSuspend(record.guid)} />
                                <IconButton icon={X} label="Close" variant="danger" onClick={() => handleClose(record.guid)} />
                              </>
                            ) : (
                              <IconButton icon={Play} label="Reopen" onClick={() => handleReopen(record)} />
                            )}
                          </div>
                        </div>

                        <div className="window-item-tags">
                          {record.tags.map((tag) => (
                            <TagBadge key={tag.id} tag={tag} onRemove={() => handleRemoveTag(tag.id)} />
                          ))}
                          <AddTagButton onClick={() => setAddingTagFor(record.guid)} />
                        </div>

                        <div className="tab-groups-section">
                          <div className="tab-groups-header">
                            <span className="muted">Tabs</span>
                            <IconButton icon={Plus} label="New tab group" onClick={() => handleCreateTabGroup(record.guid)} />
                          </div>
                          {record.tabGroups.length === 0 ? (
                            <div className="muted">No tab groups yet.</div>
                          ) : (
                            <ReorderList
                              items={applyOrder(record.tabGroups, (g) => g.guid, true, tabGroupOrder[record.guid])}
                              getId={(g) => g.guid}
                              renderItem={(g) => (
                                <TabGroupBlock
                                  group={g}
                                  collapsed={!!collapsedTabGroups[g.guid]}
                                  onToggleCollapse={() => toggleTabGroupCollapse(g.guid)}
                                  orderedTabs={applyOrder(g.tabs, (t) => t.guid, true, tabOrder[g.guid])}
                                  onReorderTabs={(newTabs) => saveTabOrder(g.guid, newTabs.map((t) => t.guid))}
                                  onAddGroupTag={() => setAddingTagFor(g.guid)}
                                  onRemoveGroupTag={handleRemoveTag}
                                  onAddTabTag={(tabGuid) => setAddingTagFor(tabGuid)}
                                  onRemoveTabTag={handleRemoveTag}
                                  onMoveTab={(tab) => setMovingTab(tab)}
                                />
                              )}
                              onChange={(newGroups) => saveTabGroupOrder(record.guid, newGroups.map((g) => g.guid))}
                            />
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )
              )}
            </div>
          )
        })}
      </div>

      {liveDetailsFor && <WindowDetailsModal record={liveDetailsFor} onClose={() => setDetailsFor(null)} />}

      {addingTagFor && (
        <AddTagModal
          onAdd={(text, fg, bg) => handleAddTag(addingTagFor, text, fg, bg)}
          onClose={() => setAddingTagFor(null)}
        />
      )}

      {reorderGroupsOpen && (
        <ReorderGroupsModal
          groups={groups}
          onConfirm={saveGroupOrder}
          onClose={() => setReorderGroupsOpen(false)}
        />
      )}

      {movingTab && (
        <MoveTabModal candidates={moveCandidates} onMove={handleMoveTab} onClose={() => setMovingTab(null)} />
      )}
    </div>
  )
}
