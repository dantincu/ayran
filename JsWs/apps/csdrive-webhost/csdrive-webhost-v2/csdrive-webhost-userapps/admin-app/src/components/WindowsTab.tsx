import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronRight, FilePlus, Pause, PauseCircle, Play, RefreshCw, Tag, X, XCircle } from 'lucide-react'
import IconButton from './IconButton'
import { getAppState, setAppState } from '../lib/appState'
import {
  addSecondaryWindowEntry,
  addWindowTag,
  closeAllSecondaryWindows,
  closeSecondaryWindow,
  focusSecondaryWindow,
  listSecondaryWindows,
  onSecondaryWindowsChanged,
  removeWindowTag,
  reopenSecondaryWindow,
  suspendAllSecondaryWindows,
  suspendSecondaryWindow,
  type SecondaryWindowRecord,
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

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

const COLLAPSED_GROUPS_KEY = 'windowsTab.collapsedGroups'

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

function AddTagForm({
  onAdd,
  onCancel,
}: {
  onAdd: (text: string, fgColor: string, bgColor: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const [fgColor, setFgColor] = useState('#ffffff')
  const [bgColor, setBgColor] = useState('#3b82f6')

  return (
    <div className="add-tag-form">
      <input
        autoFocus
        placeholder="tag text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text.trim()) onAdd(text.trim(), fgColor, bgColor)
          if (e.key === 'Escape') onCancel()
        }}
      />
      <ColorField label="Text color" value={fgColor} onChange={setFgColor} />
      <ColorField label="Background" value={bgColor} onChange={setBgColor} />
      <span className="tag-badge tag-preview" style={{ color: fgColor, background: bgColor }}>
        {text.trim() || 'preview'}
      </span>
      <div className="toolbar-actions">
        <IconButton icon={Check} label="Add tag" disabled={!text.trim()} onClick={() => onAdd(text.trim(), fgColor, bgColor)} />
        <IconButton icon={X} label="Cancel" onClick={onCancel} />
      </div>
    </div>
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

export default function WindowsTab() {
  const [records, setRecords] = useState<SecondaryWindowRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addingTagFor, setAddingTagFor] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  useEffect(() => {
    getAppState<Record<string, boolean>>(COLLAPSED_GROUPS_KEY).then((saved) => setCollapsed(saved ?? {}))
  }, [])

  function toggleGroup(relativePath: string) {
    setCollapsed((prev) => {
      const next = { ...prev, [relativePath]: !prev[relativePath] }
      setAppState(COLLAPSED_GROUPS_KEY, next)
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

  async function handleAddEntry(relativePath: string) {
    try {
      await addSecondaryWindowEntry(relativePath)
    } catch (e) {
      setError(String(e))
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

  const groups = groupByPath(records)

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

      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="muted">Loading…</div>}

      {!loading && groups.length === 0 && (
        <div className="muted">
          No web apps open yet. Open an .html file from the Files tab as a web app to see it here.
        </div>
      )}

      <div className="window-groups">
        {groups.map((group) => (
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
                <IconButton
                  icon={FilePlus}
                  label="Add a new entry without opening it"
                  onClick={() => handleAddEntry(group.relativePath)}
                />
                <IconButton icon={PauseCircle} label="Suspend all" onClick={() => handleSuspendAll(group.relativePath)} />
                <IconButton icon={XCircle} label="Close all" variant="danger" onClick={() => handleCloseAll(group.relativePath)} />
              </div>
            </div>
            {!collapsed[group.relativePath] && (
            <ul className="window-list">
              {group.windows.map((record) => (
                <li key={record.guid} className={`window-item ${record.isOpen ? 'open' : 'suspended'}`}>
                  <div className="window-item-row">
                    <button className="link-button window-item-main" onClick={() => handleRowClick(record)}>
                      <span className={`status-dot ${record.isOpen ? 'status-open' : 'status-suspended'}`} />
                      <span className="window-item-guid">{record.guid}</span>
                      <span className="muted window-item-date">{formatDateTime(record.createdAt)}</span>
                      <span className="muted window-item-state">{record.isOpen ? 'Open' : 'Suspended'}</span>
                    </button>
                    <div className="row-actions">
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
                    {addingTagFor === record.guid ? (
                      <AddTagForm
                        onAdd={(text, fg, bg) => handleAddTag(record.guid, text, fg, bg)}
                        onCancel={() => setAddingTagFor(null)}
                      />
                    ) : (
                      <button
                        className="add-tag-button"
                        onClick={() => setAddingTagFor(record.guid)}
                        title="Add tag"
                        aria-label="Add tag"
                      >
                        <Tag size={12} strokeWidth={2} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
