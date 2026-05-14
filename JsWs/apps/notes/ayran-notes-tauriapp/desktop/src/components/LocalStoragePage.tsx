import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import Popover from './Popover';
import PaginationBar from './PaginationBar';
import config from '../config.json';

const PAGE_SIZE = config.defaultListPageSize;

function truncate(s: string, max = 120): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

interface CtxMenu { x: number; y: number; key: string; }

export default function LocalStoragePage() {
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState('');
  const [entries, setEntries] = useState<{ key: string; value: string }[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  // Selection
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const lastCheckedIdxRef = useRef<number | null>(null);
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);

  const reload = useCallback(() => {
    const list: { key: string; value: string }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      list.push({ key: k, value: localStorage.getItem(k) ?? '' });
    }
    list.sort((a, b) => a.key.localeCompare(b.key));
    setEntries(list);
  }, []);

  useEffect(() => { reload(); }, [reload]);


  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    return q ? entries.filter((e) => e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q)) : entries;
  }, [entries, filter]);

  const pageItems = useMemo(
    () => filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [filtered, page],
  );

  const handleFilter = (v: string) => { setFilter(v); setPage(0); lastCheckedIdxRef.current = null; };
  const handlePage = (p: number) => { setPage(p); lastCheckedIdxRef.current = null; };

  // ── Selection ──────────────────────────────────────────────────────────────

  const handleCheck = useCallback((idx: number, shiftHeld: boolean, deselect = false) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (shiftHeld && lastCheckedIdxRef.current !== null) {
        const from = Math.min(idx, lastCheckedIdxRef.current);
        const to   = Math.max(idx, lastCheckedIdxRef.current);
        for (let i = from; i <= to; i++) {
          const k = pageItems[i].key;
          if (deselect) next.delete(k); else next.add(k);
        }
      } else {
        const k = pageItems[idx].key;
        if (next.has(k)) next.delete(k); else next.add(k);
      }
      return next;
    });
    lastCheckedIdxRef.current = idx;
  }, [pageItems]);

  const allSelected = pageItems.length > 0 && pageItems.every((i) => selectedKeys.has(i.key));
  const someSelected = pageItems.some((i) => selectedKeys.has(i.key));

  const toggleSelectAll = () => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (allSelected) pageItems.forEach((i) => next.delete(i.key));
      else pageItems.forEach((i) => next.add(i.key));
      return next;
    });
  };

  // ── CRUD ───────────────────────────────────────────────────────────────────

  const handleDelete = (key: string) => {
    localStorage.removeItem(key);
    setCtxMenu(null);
    setEditing(null);
    setExpanded(null);
    setSelectedKeys((prev) => { const next = new Set(prev); next.delete(key); return next; });
    reload();
  };

  const handleDeleteSelected = () => {
    setBulkMenuOpen(false);
    selectedKeys.forEach((k) => localStorage.removeItem(k));
    setSelectedKeys(new Set());
    lastCheckedIdxRef.current = null;
    reload();
  };

  const startEdit = (key: string, value: string) => {
    setEditing(key); setEditValue(value); setExpanded(null);
  };

  const commitEdit = (key: string) => {
    localStorage.setItem(key, editValue);
    setEditing(null); reload();
  };

  const handleAdd = () => {
    if (!newKey.trim()) return;
    localStorage.setItem(newKey.trim(), newValue);
    setNewKey(''); setNewValue(''); setShowAdd(false); reload();
  };

  // ── Context menu / row click ───────────────────────────────────────────────

  const handleContextMenu = (e: React.MouseEvent, idx: number, key: string) => {
    e.preventDefault();
    if (selectedKeys.size > 0) {
      // Range select/deselect instead of showing the context menu
      handleCheck(idx, true, selectedKeys.has(key));
    } else {
      setCtxMenu({ x: e.clientX, y: e.clientY, key });
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <input type="text" placeholder="Filter keys / values…" value={filter}
          onChange={(e) => handleFilter(e.target.value)}
          className="flex-1 min-w-0 px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
        <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
          {filtered.length} / {entries.length}
        </span>

        {/* Bulk actions (shown when ≥1 selected) */}
        {selectedKeys.size > 0 && (
          <>
            <span className="text-xs text-blue-600 dark:text-blue-400 shrink-0 tabular-nums">
              {selectedKeys.size} selected
            </span>
            {/* Clear selection */}
            <button onClick={() => { setSelectedKeys(new Set()); lastCheckedIdxRef.current = null; }}
              title="Clear selection"
              className="w-7 h-7 flex items-center justify-center rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-sm shrink-0">
              ✕
            </button>
            {/* Three-dots bulk menu */}
            <div className="relative shrink-0">
              <button onClick={() => setBulkMenuOpen((o) => !o)} title="Bulk actions"
                className="w-7 h-7 flex items-center justify-center rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <circle cx="8" cy="2.5" r="1.4"/>
                  <circle cx="8" cy="8"   r="1.4"/>
                  <circle cx="8" cy="13.5" r="1.4"/>
                </svg>
              </button>
              {bulkMenuOpen && (
                <Popover title="Bulk actions" onClose={() => setBulkMenuOpen(false)} panelClassName="absolute right-0 top-full mt-1 min-w-[150px]">
                  <div className="py-1">
                    <button onClick={handleDeleteSelected}
                      className="w-full text-left px-4 py-2 text-sm text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20">
                      Delete Selected
                    </button>
                  </div>
                </Popover>
              )}
            </div>
          </>
        )}

        <button onClick={() => setShowAdd((v) => !v)}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors shrink-0">
          + Add
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="border border-blue-200 dark:border-blue-800 rounded-lg p-3 bg-blue-50 dark:bg-blue-900/20 space-y-2">
          <input type="text" placeholder="Key" value={newKey} onChange={(e) => setNewKey(e.target.value)}
            className="w-full px-3 py-1.5 text-sm font-mono border border-gray-200 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          <textarea placeholder="Value" value={newValue} onChange={(e) => setNewValue(e.target.value)} rows={3}
            className="w-full px-3 py-1.5 text-sm font-mono border border-gray-200 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y" />
          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowAdd(false)}
              className="px-3 py-1 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors">Cancel</button>
            <button onClick={handleAdd}
              className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors">Save</button>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center">No entries found.</p>
      ) : (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input type="checkbox" checked={allSelected} onChange={toggleSelectAll}
                    ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                    className="w-4 h-4 rounded accent-blue-600" />
                </th>
                <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400 w-2/5">Key</th>
                <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-300 dark:divide-gray-700">
              {pageItems.map((entry, idx) => (
                <tr key={entry.key}
                  className={`cursor-pointer ${selectedKeys.has(entry.key) ? 'bg-blue-50 dark:bg-blue-900/20' : 'bg-white dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
                  onClick={() => { if (editing === entry.key) return; setExpanded(expanded === entry.key ? null : entry.key); }}
                  onContextMenu={(e) => handleContextMenu(e, idx, entry.key)}>
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selectedKeys.has(entry.key)} onChange={() => {}}
                      onClick={(e) => { e.stopPropagation(); handleCheck(idx, e.shiftKey, e.shiftKey && selectedKeys.has(entry.key)); }}
                      className="w-4 h-4 rounded accent-blue-600" />
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-blue-700 dark:text-blue-400 break-all align-top">
                    {entry.key}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-700 dark:text-gray-300 break-all">
                    {editing === entry.key ? (
                      <div className="space-y-1" onClick={(e) => e.stopPropagation()}>
                        <textarea value={editValue} onChange={(e) => setEditValue(e.target.value)} rows={4}
                          className="w-full px-2 py-1 font-mono text-xs border border-blue-400 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none resize-y"
                          // eslint-disable-next-line jsx-a11y/no-autofocus
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setEditing(null);
                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitEdit(entry.key);
                          }} />
                        <div className="flex gap-2">
                          <button onClick={() => commitEdit(entry.key)}
                            className="px-2 py-0.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">
                            Save (Ctrl+Enter)
                          </button>
                          <button onClick={() => setEditing(null)}
                            className="px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <span title="Double-click to edit"
                        onDoubleClick={(e) => { e.stopPropagation(); startEdit(entry.key, entry.value); }}>
                        {expanded === entry.key ? entry.value : truncate(entry.value)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <PaginationBar page={page} total={filtered.length} pageSize={PAGE_SIZE} onPage={handlePage} />
        </div>
      )}

      {/* Single-row context menu */}
      {ctxMenu && (
        <Popover title={ctxMenu.key} onClose={() => setCtxMenu(null)} panelStyle={{ top: ctxMenu.y, left: ctxMenu.x }}>
          <div className="py-1">
            <button onClick={() => { startEdit(ctxMenu.key, localStorage.getItem(ctxMenu.key) ?? ''); setCtxMenu(null); }}
              className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
              Edit
            </button>
            <button onClick={() => handleDelete(ctxMenu.key)}
              className="w-full text-left px-4 py-2 text-sm text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20">
              Delete
            </button>
          </div>
        </Popover>
      )}
    </div>
  );
}
