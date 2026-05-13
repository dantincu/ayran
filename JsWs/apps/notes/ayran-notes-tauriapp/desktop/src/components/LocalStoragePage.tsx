import { useState, useMemo } from 'react';
import PaginationBar from './PaginationBar';

const PAGE_SIZE = 20;

function truncate(s: string, max = 120): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

export default function LocalStoragePage() {
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const allEntries = useMemo(() => {
    const entries: { key: string; value: string }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      entries.push({ key, value: localStorage.getItem(key) ?? '' });
    }
    return entries.sort((a, b) => a.key.localeCompare(b.key));
  }, []);

  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    return q ? allEntries.filter((e) => e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q)) : allEntries;
  }, [allEntries, filter]);

  const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleFilter = (v: string) => { setFilter(v); setPage(0); };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="Filter keys / values…"
          value={filter}
          onChange={(e) => handleFilter(e.target.value)}
          className="flex-1 px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
          {filtered.length} / {allEntries.length} entries
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center">No entries found.</p>
      ) : (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400 w-2/5">Key</th>
                <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {pageItems.map((entry) => (
                <tr
                  key={entry.key}
                  className="bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
                  onClick={() => setExpanded(expanded === entry.key ? null : entry.key)}
                >
                  <td className="px-4 py-2 font-mono text-xs text-blue-700 dark:text-blue-400 break-all align-top">
                    {entry.key}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-700 dark:text-gray-300 break-all">
                    {expanded === entry.key ? entry.value : truncate(entry.value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <PaginationBar page={page} total={filtered.length} pageSize={PAGE_SIZE} onPage={setPage} />
        </div>
      )}
    </div>
  );
}
