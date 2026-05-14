import { useState, useEffect, useCallback, useRef } from 'react';
import Popover from './Popover';
import PaginationBar from './PaginationBar';
import config from '../config.json';

const PAGE_SIZE = config.defaultListPageSize;

interface DbInfo { name: string; version: number; }
interface RecordEntry { key: IDBValidKey; value: unknown; }

function displayValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  try { return JSON.stringify(v); } catch { return String(v); }
}

function truncate(s: string, max = 140): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

// ── IDB helpers ───────────────────────────────────────────────────────────────

function openDb(name: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version !== undefined ? indexedDB.open(name, version) : indexedDB.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database is blocked'));
  });
}

function idbOp<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getStoreCount(db: IDBDatabase, storeName: string): Promise<number> {
  return idbOp(db.transaction(storeName, 'readonly').objectStore(storeName).count());
}

function getRecordsPage(db: IDBDatabase, storeName: string, page: number): Promise<RecordEntry[]> {
  return new Promise((resolve, reject) => {
    try {
      const store = db.transaction(storeName, 'readonly').objectStore(storeName);
      const offset = page * PAGE_SIZE;
      const items: RecordEntry[] = [];
      let skipped = false;
      const req = store.openCursor();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(items); return; }
        if (!skipped && offset > 0) { skipped = true; cursor.advance(offset); return; }
        skipped = true;
        items.push({ key: cursor.key, value: cursor.value });
        if (items.length >= PAGE_SIZE) { resolve(items); return; }
        cursor.continue();
      };
    } catch (e) { reject(e); }
  });
}

function deleteRecord(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<void> {
  return idbOp(db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key));
}

function addRecord(db: IDBDatabase, storeName: string, value: unknown, key?: IDBValidKey): Promise<IDBValidKey> {
  const store = db.transaction(storeName, 'readwrite').objectStore(storeName);
  return idbOp(key !== undefined ? store.add(value, key) : store.add(value));
}

// ── Records view ──────────────────────────────────────────────────────────────

function RecordsView({ db, storeName, onBack }: { db: IDBDatabase; storeName: string; onBack: () => void }) {
  const [records, setRecords] = useState<RecordEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; key: IDBValidKey } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addKey, setAddKey] = useState('');
  const [addValue, setAddValue] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  // Selection — keyed by displayValue(rec.key) (strings are Set-safe)
  const [selectedDisplayKeys, setSelectedDisplayKeys] = useState<Set<string>>(new Set());
  const lastCheckedIdxRef = useRef<number | null>(null);
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  const load = useCallback(async (p: number) => {
    setLoading(true); setError(null); setExpanded(null); lastCheckedIdxRef.current = null;
    try {
      const [count, rows] = await Promise.all([getStoreCount(db, storeName), getRecordsPage(db, storeName, p)]);
      setTotal(count); setRecords(rows); setPage(p);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [db, storeName]);

  useEffect(() => { void load(0); }, [load]);


  // ── Selection ────────────────────────────────────────────────────────────

  const handleCheck = useCallback((idx: number, shiftHeld: boolean, deselect = false) => {
    setSelectedDisplayKeys((prev) => {
      const next = new Set(prev);
      if (shiftHeld && lastCheckedIdxRef.current !== null) {
        const from = Math.min(idx, lastCheckedIdxRef.current);
        const to   = Math.max(idx, lastCheckedIdxRef.current);
        for (let i = from; i <= to; i++) {
          const dk = displayValue(records[i].key);
          if (deselect) next.delete(dk); else next.add(dk);
        }
      } else {
        const dk = displayValue(records[idx].key);
        if (next.has(dk)) next.delete(dk); else next.add(dk);
      }
      return next;
    });
    lastCheckedIdxRef.current = idx;
  }, [records]);

  const allSelected = records.length > 0 && records.every((r) => selectedDisplayKeys.has(displayValue(r.key)));
  const someSelected = records.some((r) => selectedDisplayKeys.has(displayValue(r.key)));

  const toggleSelectAll = () => {
    setSelectedDisplayKeys((prev) => {
      const next = new Set(prev);
      if (allSelected) records.forEach((r) => next.delete(displayValue(r.key)));
      else records.forEach((r) => next.add(displayValue(r.key)));
      return next;
    });
  };

  // ── CRUD ──────────────────────────────────────────────────────────────────

  const handleDelete = async (key: IDBValidKey) => {
    setCtxMenu(null);
    try {
      await deleteRecord(db, storeName, key);
      setSelectedDisplayKeys((prev) => { const next = new Set(prev); next.delete(displayValue(key)); return next; });
      await load(page);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const handleDeleteSelected = async () => {
    setBulkMenuOpen(false);
    const toDelete = records.filter((r) => selectedDisplayKeys.has(displayValue(r.key)));
    for (const rec of toDelete) {
      try { await deleteRecord(db, storeName, rec.key); } catch { /* continue */ }
    }
    setSelectedDisplayKeys(new Set());
    lastCheckedIdxRef.current = null;
    await load(page);
  };

  const handleAdd = async () => {
    setAddError(null);
    try {
      const parsed: unknown = JSON.parse(addValue || 'null');
      const keyArg = addKey.trim() ? JSON.parse(addKey.trim()) as IDBValidKey : undefined;
      await addRecord(db, storeName, parsed, keyArg);
      setAddKey(''); setAddValue(''); setShowAdd(false);
      await load(page);
    } catch (e) { setAddError(e instanceof Error ? e.message : String(e)); }
  };

  // ── Context menu / row handlers ───────────────────────────────────────────

  const handleContextMenu = (e: React.MouseEvent, idx: number, key: IDBValidKey) => {
    e.preventDefault();
    if (selectedDisplayKeys.size > 0) {
      handleCheck(idx, true, selectedDisplayKeys.has(displayValue(key)));
    } else {
      setCtxMenu({ x: e.clientX, y: e.clientY, key });
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {/* Breadcrumb + toolbar */}
      <div className="flex items-center gap-2 flex-wrap text-sm">
        <button onClick={onBack} className="text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400">← Stores</button>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        <span className="font-medium text-gray-800 dark:text-gray-200">{storeName}</span>
        <span className="text-xs text-gray-400 dark:text-gray-500">{total} records</span>

        {/* Bulk actions */}
        {selectedDisplayKeys.size > 0 && (
          <>
            <span className="text-xs text-blue-600 dark:text-blue-400 tabular-nums">
              {selectedDisplayKeys.size} selected
            </span>
            <button onClick={() => { setSelectedDisplayKeys(new Set()); lastCheckedIdxRef.current = null; }}
              title="Clear selection"
              className="w-7 h-7 flex items-center justify-center rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-sm">
              ✕
            </button>
            <div className="relative">
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
          className="ml-auto px-3 py-1 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors shrink-0">
          + Add
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="border border-blue-200 dark:border-blue-800 rounded-lg p-3 bg-blue-50 dark:bg-blue-900/20 space-y-2">
          <input type="text" placeholder='Key (optional JSON — e.g. "myKey" or 42)'
            value={addKey} onChange={(e) => setAddKey(e.target.value)}
            className="w-full px-3 py-1.5 text-sm font-mono border border-gray-200 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          <textarea placeholder='Value (JSON — e.g. {"name":"Alice"})'
            value={addValue} onChange={(e) => setAddValue(e.target.value)} rows={4}
            className="w-full px-3 py-1.5 text-sm font-mono border border-gray-200 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y" />
          {addError && <p className="text-xs text-red-500">{addError}</p>}
          <div className="flex gap-2 justify-end">
            <button onClick={() => { setShowAdd(false); setAddError(null); }}
              className="px-3 py-1 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors">Cancel</button>
            <button onClick={handleAdd}
              className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors">Save</button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}
      {loading && <p className="text-sm text-gray-400 py-6 text-center">Loading…</p>}
      {!loading && records.length === 0 && !error && (
        <p className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center">Object store is empty.</p>
      )}

      {!loading && records.length > 0 && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input type="checkbox" checked={allSelected} onChange={toggleSelectAll}
                    ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                    className="w-4 h-4 rounded accent-blue-600" />
                </th>
                <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400 w-1/4">Key</th>
                <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-300 dark:divide-gray-700">
              {records.map((rec, idx) => {
                const dk = displayValue(rec.key);
                return (
                  <tr key={idx}
                    className={`cursor-pointer ${selectedDisplayKeys.has(dk) ? 'bg-blue-50 dark:bg-blue-900/20' : 'bg-white dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
                    onClick={() => setExpanded(expanded === idx ? null : idx)}
                    onContextMenu={(e) => handleContextMenu(e, idx, rec.key)}>
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selectedDisplayKeys.has(dk)} onChange={() => {}}
                        onClick={(e) => { e.stopPropagation(); handleCheck(idx, e.shiftKey, e.shiftKey && selectedDisplayKeys.has(dk)); }}
                        className="w-4 h-4 rounded accent-blue-600" />
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-blue-700 dark:text-blue-400 align-top break-all">
                      {dk}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-700 dark:text-gray-300 break-all">
                      {expanded === idx ? displayValue(rec.value) : truncate(displayValue(rec.value))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <PaginationBar page={page} total={total} pageSize={PAGE_SIZE} onPage={load} />
        </div>
      )}

      {/* Single-row context menu */}
      {ctxMenu && (
        <Popover title={String(ctxMenu.key)} onClose={() => setCtxMenu(null)} panelStyle={{ top: ctxMenu.y, left: ctxMenu.x }}>
          <div className="py-1">
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

// ── Stores view ───────────────────────────────────────────────────────────────

function BulkBar({ count, onClear, onDelete }: { count: number; onClear: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span className="text-xs text-blue-600 dark:text-blue-400 tabular-nums">{count} selected</span>
      <button onClick={onClear} title="Clear selection"
        className="w-7 h-7 flex items-center justify-center rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-sm">✕</button>
      <div className="relative">
        <button onClick={() => setOpen((o) => !o)} title="Bulk actions"
          className="w-7 h-7 flex items-center justify-center rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="8" cy="2.5" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="8" cy="13.5" r="1.4"/>
          </svg>
        </button>
        {open && (
          <Popover title="Bulk actions" onClose={() => setOpen(false)} panelClassName="absolute right-0 top-full mt-1 min-w-[150px]">
            <div className="py-1">
              <button onClick={() => { setOpen(false); onDelete(); }}
                className="w-full text-left px-4 py-2 text-sm text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20">
                Delete Selected
              </button>
            </div>
          </Popover>
        )}
      </div>
    </>
  );
}

function StoresView({ dbInfo, onBack }: { dbInfo: DbInfo; onBack: () => void }) {
  const [version, setVersion] = useState(dbInfo.version);
  const [db, setDb] = useState<IDBDatabase | null>(null);
  const [stores, setStores] = useState<string[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedStore, setSelectedStore] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newStore, setNewStore] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastCheckedIdxRef = useRef<number | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  useEffect(() => {
    let idb: IDBDatabase | null = null;
    setLoading(true); setError(null);
    openDb(dbInfo.name, version)
      .then(async (opened) => {
        idb = opened; setDb(opened);
        const names = Array.from(opened.objectStoreNames).sort();
        setStores(names);
        const c: Record<string, number> = {};
        await Promise.all(names.map(async (n) => {
          try { c[n] = await getStoreCount(opened, n); } catch { c[n] = -1; }
        }));
        setCounts(c);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    return () => { idb?.close(); };
  }, [dbInfo.name, version]);

  const handleCheck = useCallback((idx: number, shiftHeld: boolean, deselect = false) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shiftHeld && lastCheckedIdxRef.current !== null) {
        const from = Math.min(idx, lastCheckedIdxRef.current);
        const to   = Math.max(idx, lastCheckedIdxRef.current);
        for (let i = from; i <= to; i++) {
          if (deselect) next.delete(stores[i]); else next.add(stores[i]);
        }
      } else {
        if (next.has(stores[idx])) next.delete(stores[idx]); else next.add(stores[idx]);
      }
      return next;
    });
    lastCheckedIdxRef.current = idx;
  }, [stores]);

  const allSelected = stores.length > 0 && stores.every((s) => selected.has(s));
  const someSelected = stores.some((s) => selected.has(s));

  const deleteStores = (names: Set<string>) => {
    db?.close(); setDb(null);
    const nextVersion = version + 1;
    const req = indexedDB.open(dbInfo.name, nextVersion);
    req.onupgradeneeded = () => {
      names.forEach((n) => { if (req.result.objectStoreNames.contains(n)) req.result.deleteObjectStore(n); });
    };
    req.onsuccess = () => { req.result.close(); setSelected(new Set()); lastCheckedIdxRef.current = null; setVersion(nextVersion); };
    req.onerror = () => setError(req.error?.message ?? 'Failed to delete stores');
  };

  const handleCreateStore = () => {
    const name = newStore.trim();
    if (!name) return;
    setAddError(null);
    db?.close(); setDb(null);
    const nextVersion = version + 1;
    const req = indexedDB.open(dbInfo.name, nextVersion);
    req.onupgradeneeded = () => { req.result.createObjectStore(name, { autoIncrement: true }); };
    req.onsuccess = () => { req.result.close(); setNewStore(''); setShowAdd(false); setVersion(nextVersion); };
    req.onerror = () => setAddError(req.error?.message ?? 'Failed to create store');
  };

  if (selectedStore && db) {
    return <RecordsView db={db} storeName={selectedStore} onBack={() => setSelectedStore(null)} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm flex-wrap">
        <button onClick={onBack} className="text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400">← Databases</button>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        <span className="font-medium text-gray-800 dark:text-gray-200">{dbInfo.name}</span>
        <span className="text-xs text-gray-400 dark:text-gray-500 ml-1">v{version}</span>
        {selected.size > 0 && (
          <BulkBar count={selected.size}
            onClear={() => { setSelected(new Set()); lastCheckedIdxRef.current = null; }}
            onDelete={() => deleteStores(selected)} />
        )}
        <button onClick={() => setShowAdd((v) => !v)}
          className="ml-auto px-3 py-1 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors shrink-0">
          + Create store
        </button>
      </div>

      {showAdd && (
        <div className="border border-blue-200 dark:border-blue-800 rounded-lg p-3 bg-blue-50 dark:bg-blue-900/20 space-y-2">
          <input type="text" placeholder="Object store name" value={newStore}
            onChange={(e) => setNewStore(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateStore(); if (e.key === 'Escape') setShowAdd(false); }}
            className="w-full px-3 py-1.5 text-sm font-mono border border-gray-200 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus />
          <p className="text-xs text-gray-400 dark:text-gray-500">Store will use auto-increment integer keys.</p>
          {addError && <p className="text-xs text-red-500">{addError}</p>}
          <div className="flex gap-2 justify-end">
            <button onClick={() => { setShowAdd(false); setAddError(null); }}
              className="px-3 py-1 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors">Cancel</button>
            <button onClick={handleCreateStore}
              className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors">Create</button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}
      {loading && <p className="text-sm text-gray-400 py-6 text-center">Opening database…</p>}
      {!loading && stores.length === 0 && !error && (
        <p className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center">No object stores — create one above.</p>
      )}
      {!loading && stores.length > 0 && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input type="checkbox" checked={allSelected} onChange={() => {
                    setSelected(allSelected ? new Set() : new Set(stores));
                  }}
                    ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                    className="w-4 h-4 rounded accent-blue-600" />
                </th>
                <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Object Store</th>
                <th className="text-right px-4 py-2 font-medium text-gray-500 dark:text-gray-400 w-24">Records</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-300 dark:divide-gray-700">
              {stores.map((name, idx) => (
                <tr key={name}
                  className={`cursor-pointer ${selected.has(name) ? 'bg-blue-50 dark:bg-blue-900/20' : 'bg-white dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
                  onClick={() => { if (!selected.has(name) || selected.size === 0) setSelectedStore(name); }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (selected.size > 0) handleCheck(idx, true, selected.has(name));
                    else setCtxMenu({ x: e.clientX, y: e.clientY, name });
                  }}>
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(name)} onChange={() => {}}
                      onClick={(e) => { e.stopPropagation(); handleCheck(idx, e.shiftKey, e.shiftKey && selected.has(name)); }}
                      className="w-4 h-4 rounded accent-blue-600" />
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-blue-700 dark:text-blue-400">{name}</td>
                  <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400 text-right tabular-nums">
                    {counts[name] === -1 ? '—' : (counts[name] ?? '…')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ctxMenu && (
        <Popover title={ctxMenu.name} onClose={() => setCtxMenu(null)} panelStyle={{ top: ctxMenu.y, left: ctxMenu.x }}>
          <div className="py-1">
            <button onClick={() => { setCtxMenu(null); deleteStores(new Set([ctxMenu.name])); }}
              className="w-full text-left px-4 py-2 text-sm text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20">
              Delete
            </button>
          </div>
        </Popover>
      )}
    </div>
  );
}

// ── Databases list ────────────────────────────────────────────────────────────

export default function IndexedDbPage() {
  const [databases, setDatabases] = useState<DbInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DbInfo | null>(null);
  const [page, setPage] = useState(0);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; db: DbInfo } | null>(null);
  const [selectedDbs, setSelectedDbs] = useState<Set<string>>(new Set());
  const lastCheckedIdxRef = useRef<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newDbName, setNewDbName] = useState('');
  const [newStoreName, setNewStoreName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const loadDbs = useCallback(() => {
    setLoading(true); setError(null);
    indexedDB.databases()
      .then((dbs) => {
        const valid = dbs
          .filter((d): d is Required<IDBDatabaseInfo> => !!d.name)
          .map((d) => ({ name: d.name, version: d.version ?? 1 }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setDatabases(valid);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadDbs(); }, [loadDbs]);

  const handleCheck = useCallback((idx: number, shiftHeld: boolean, deselect = false) => {
    const items = databases.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    setSelectedDbs((prev) => {
      const next = new Set(prev);
      if (shiftHeld && lastCheckedIdxRef.current !== null) {
        const from = Math.min(idx, lastCheckedIdxRef.current);
        const to   = Math.max(idx, lastCheckedIdxRef.current);
        for (let i = from; i <= to; i++) {
          if (deselect) next.delete(items[i].name); else next.add(items[i].name);
        }
      } else {
        const n = items[idx].name;
        if (next.has(n)) next.delete(n); else next.add(n);
      }
      return next;
    });
    lastCheckedIdxRef.current = idx;
  }, [databases, page]);

  const handleDeleteSelectedDbs = useCallback(() => {
    const names = Array.from(selectedDbs);
    let remaining = names.length;
    if (remaining === 0) return;
    names.forEach((name) => {
      const req = indexedDB.deleteDatabase(name);
      const done = () => { if (--remaining === 0) { setSelectedDbs(new Set()); lastCheckedIdxRef.current = null; loadDbs(); } };
      req.onsuccess = done; req.onerror = done;
    });
  }, [selectedDbs, loadDbs]);

  const handleCreateDb = () => {
    const db = newDbName.trim();
    const store = newStoreName.trim();
    if (!db || !store) { setCreateError('Both fields are required.'); return; }
    setCreateError(null);
    const req = indexedDB.open(db, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(store, { autoIncrement: true });
    };
    req.onsuccess = () => { req.result.close(); setNewDbName(''); setNewStoreName(''); setShowCreate(false); loadDbs(); };
    req.onerror = () => setCreateError(req.error?.message ?? 'Failed to create database');
  };

  const handleDeleteDb = (dbInfo: DbInfo) => {
    setCtxMenu(null);
    const req = indexedDB.deleteDatabase(dbInfo.name);
    req.onsuccess = () => loadDbs();
    req.onerror = () => setError(`Failed to delete "${dbInfo.name}"`);
  };

  if (selected) {
    return <StoresView dbInfo={selected} onBack={() => setSelected(null)} />;
  }

  const pageItems = databases.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-gray-400 dark:text-gray-500">
          {databases.length} database{databases.length !== 1 ? 's' : ''}
        </span>
        <button onClick={loadDbs} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Refresh</button>
        {selectedDbs.size > 0 && (
          <BulkBar count={selectedDbs.size}
            onClear={() => { setSelectedDbs(new Set()); lastCheckedIdxRef.current = null; }}
            onDelete={handleDeleteSelectedDbs} />
        )}
        <button onClick={() => setShowCreate((v) => !v)}
          className="ml-auto px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors shrink-0">
          + Create database
        </button>
      </div>

      {showCreate && (
        <div className="border border-blue-200 dark:border-blue-800 rounded-lg p-3 bg-blue-50 dark:bg-blue-900/20 space-y-2">
          <input type="text" placeholder="Database name" value={newDbName}
            onChange={(e) => setNewDbName(e.target.value)}
            className="w-full px-3 py-1.5 text-sm font-mono border border-gray-200 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus />
          <input type="text" placeholder="First object store name (required)" value={newStoreName}
            onChange={(e) => setNewStoreName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateDb(); if (e.key === 'Escape') setShowCreate(false); }}
            className="w-full px-3 py-1.5 text-sm font-mono border border-gray-200 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          <p className="text-xs text-gray-400 dark:text-gray-500">A database requires at least one object store. More stores can be added after creation.</p>
          {createError && <p className="text-xs text-red-500">{createError}</p>}
          <div className="flex gap-2 justify-end">
            <button onClick={() => { setShowCreate(false); setCreateError(null); }}
              className="px-3 py-1 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors">Cancel</button>
            <button onClick={handleCreateDb}
              className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors">Create</button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}
      {loading && <p className="text-sm text-gray-400 py-6 text-center">Enumerating databases…</p>}
      {!loading && databases.length === 0 && !error && (
        <p className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center">No databases yet — create one above.</p>
      )}

      {!loading && databases.length > 0 && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input type="checkbox"
                    checked={pageItems.length > 0 && pageItems.every((d) => selectedDbs.has(d.name))}
                    onChange={() => {
                      const allSel = pageItems.every((d) => selectedDbs.has(d.name));
                      setSelectedDbs((prev) => { const next = new Set(prev); pageItems.forEach((d) => allSel ? next.delete(d.name) : next.add(d.name)); return next; });
                    }}
                    ref={(el) => { if (el) el.indeterminate = pageItems.some((d) => selectedDbs.has(d.name)) && !pageItems.every((d) => selectedDbs.has(d.name)); }}
                    className="w-4 h-4 rounded accent-blue-600" />
                </th>
                <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Database</th>
                <th className="text-right px-4 py-2 font-medium text-gray-500 dark:text-gray-400 w-20">Version</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-300 dark:divide-gray-700">
              {pageItems.map((db, idx) => (
                <tr key={db.name}
                  className={`cursor-pointer ${selectedDbs.has(db.name) ? 'bg-blue-50 dark:bg-blue-900/20' : 'bg-white dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
                  onClick={() => setSelected(db)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (selectedDbs.size > 0) handleCheck(idx, true, selectedDbs.has(db.name));
                    else setCtxMenu({ x: e.clientX, y: e.clientY, db });
                  }}>
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selectedDbs.has(db.name)} onChange={() => {}}
                      onClick={(e) => { e.stopPropagation(); handleCheck(idx, e.shiftKey, e.shiftKey && selectedDbs.has(db.name)); }}
                      className="w-4 h-4 rounded accent-blue-600" />
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-blue-700 dark:text-blue-400">{db.name}</td>
                  <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400 text-right tabular-nums">{db.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <PaginationBar page={page} total={databases.length} pageSize={PAGE_SIZE} onPage={setPage} />
        </div>
      )}

      {ctxMenu && (
        <Popover title={ctxMenu.db.name} onClose={() => setCtxMenu(null)} panelStyle={{ top: ctxMenu.y, left: ctxMenu.x }}>
          <div className="py-1">
            <button onClick={() => handleDeleteDb(ctxMenu.db)}
              className="w-full text-left px-4 py-2 text-sm text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20">
              Delete database
            </button>
          </div>
        </Popover>
      )}
    </div>
  );
}
