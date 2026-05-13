import { useState, useEffect, useCallback } from 'react';
import PaginationBar from './PaginationBar';

const PAGE_SIZE = 20;

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
    const req = version !== undefined
      ? indexedDB.open(name, version)
      : indexedDB.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database is blocked'));
  });
}

function getStoreCount(db: IDBDatabase, storeName: string): Promise<number> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  });
}

function getRecordsPage(
  db: IDBDatabase, storeName: string, page: number,
): Promise<RecordEntry[]> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const offset = page * PAGE_SIZE;
      const items: RecordEntry[] = [];
      let skipped = false;

      const req = store.openCursor();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(items); return; }
        if (!skipped && offset > 0) {
          skipped = true;
          cursor.advance(offset);
          return;
        }
        skipped = true;
        items.push({ key: cursor.key, value: cursor.value });
        if (items.length >= PAGE_SIZE) { resolve(items); return; }
        cursor.continue();
      };
    } catch (e) { reject(e); }
  });
}

// ── Sub-views ─────────────────────────────────────────────────────────────────

function RecordsView({
  db, storeName, onBack,
}: { db: IDBDatabase; storeName: string; onBack: () => void }) {
  const [records, setRecords] = useState<RecordEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async (p: number) => {
    setLoading(true); setError(null); setExpanded(null);
    try {
      const [count, rows] = await Promise.all([
        getStoreCount(db, storeName),
        getRecordsPage(db, storeName, p),
      ]);
      setTotal(count);
      setRecords(rows);
      setPage(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [db, storeName]);

  useEffect(() => { void load(0); }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <button onClick={onBack} className="hover:text-blue-600 dark:hover:text-blue-400">← Stores</button>
        <span>/</span>
        <span className="font-medium text-gray-800 dark:text-gray-200">{storeName}</span>
        <span className="ml-auto text-xs">{total} records</span>
      </div>

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
                <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400 w-1/4">Key</th>
                <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {records.map((rec, i) => (
                <tr
                  key={i}
                  className="bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
                  onClick={() => setExpanded(expanded === i ? null : i)}
                >
                  <td className="px-4 py-2 font-mono text-xs text-blue-700 dark:text-blue-400 align-top break-all">
                    {displayValue(rec.key)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-700 dark:text-gray-300 break-all">
                    {expanded === i ? displayValue(rec.value) : truncate(displayValue(rec.value))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <PaginationBar page={page} total={total} pageSize={PAGE_SIZE} onPage={load} />
        </div>
      )}
    </div>
  );
}

function StoresView({
  dbInfo, onBack,
}: { dbInfo: DbInfo; onBack: () => void }) {
  const [db, setDb] = useState<IDBDatabase | null>(null);
  const [stores, setStores] = useState<string[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedStore, setSelectedStore] = useState<string | null>(null);

  useEffect(() => {
    let idb: IDBDatabase | null = null;
    openDb(dbInfo.name, dbInfo.version)
      .then(async (opened) => {
        idb = opened;
        setDb(opened);
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
  }, [dbInfo]);

  if (selectedStore && db) {
    return (
      <RecordsView
        db={db}
        storeName={selectedStore}
        onBack={() => setSelectedStore(null)}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <button onClick={onBack} className="hover:text-blue-600 dark:hover:text-blue-400">← Databases</button>
        <span>/</span>
        <span className="font-medium text-gray-800 dark:text-gray-200">{dbInfo.name}</span>
        <span className="text-xs ml-1">v{dbInfo.version}</span>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}
      {loading && <p className="text-sm text-gray-400 py-6 text-center">Opening database…</p>}

      {!loading && stores.length === 0 && !error && (
        <p className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center">No object stores found.</p>
      )}

      {!loading && stores.length > 0 && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Object Store</th>
                <th className="text-right px-4 py-2 font-medium text-gray-500 dark:text-gray-400 w-24">Records</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {stores.map((name) => (
                <tr
                  key={name}
                  className="bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
                  onClick={() => setSelectedStore(name)}
                >
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
    </div>
  );
}

// ── Top-level: database list ──────────────────────────────────────────────────

export default function IndexedDbPage() {
  const [databases, setDatabases] = useState<DbInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DbInfo | null>(null);
  const [page, setPage] = useState(0);

  useEffect(() => {
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

  if (selected) {
    return <StoresView dbInfo={selected} onBack={() => setSelected(null)} />;
  }

  const pageItems = databases.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400 dark:text-gray-500">
          {databases.length} database{databases.length !== 1 ? 's' : ''}
        </span>
        <button
          onClick={() => { setLoading(true); setError(null); indexedDB.databases().then((dbs) => { const valid = dbs.filter((d): d is Required<IDBDatabaseInfo> => !!d.name).map((d) => ({ name: d.name, version: d.version ?? 1 })).sort((a, b) => a.name.localeCompare(b.name)); setDatabases(valid); }).catch((e) => setError(String(e))).finally(() => setLoading(false)); }}
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
        >
          Refresh
        </button>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}
      {loading && <p className="text-sm text-gray-400 py-6 text-center">Enumerating databases…</p>}

      {!loading && databases.length === 0 && !error && (
        <p className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center">No IndexedDB databases found.</p>
      )}

      {!loading && databases.length > 0 && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Database</th>
                <th className="text-right px-4 py-2 font-medium text-gray-500 dark:text-gray-400 w-20">Version</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {pageItems.map((db) => (
                <tr
                  key={db.name}
                  className="bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
                  onClick={() => setSelected(db)}
                >
                  <td className="px-4 py-2 font-mono text-xs text-blue-700 dark:text-blue-400">{db.name}</td>
                  <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400 text-right tabular-nums">{db.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <PaginationBar page={page} total={databases.length} pageSize={PAGE_SIZE} onPage={setPage} />
        </div>
      )}
    </div>
  );
}
