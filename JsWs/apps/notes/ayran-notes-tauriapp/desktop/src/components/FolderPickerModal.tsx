import { useState, useEffect, useRef } from 'react';

export interface FolderEntry {
  id: string;
  name: string;
}

interface Props {
  title: string;
  rootId: string;
  rootName: string;
  onList: (id: string) => Promise<FolderEntry[]>;
  onConfirm: (folderId: string) => Promise<void>;
  onClose: () => void;
}

export default function FolderPickerModal({ title, rootId, rootName, onList, onConfirm, onClose }: Props) {
  const [folderId, setFolderId] = useState(rootId);
  const [breadcrumbs, setBreadcrumbs] = useState([{ id: rootId, name: rootName }]);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep onList ref stable so the effect only re-runs when folderId changes.
  const onListRef = useRef(onList);
  onListRef.current = onList;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    onListRef.current(folderId)
      .then(f => { if (!cancelled) setFolders(f); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [folderId]);

  function navigate(id: string, name: string) {
    setFolderId(id);
    setBreadcrumbs(prev => [...prev, { id, name }]);
  }

  function navigateTo(index: number) {
    setFolderId(breadcrumbs[index].id);
    setBreadcrumbs(prev => prev.slice(0, index + 1));
  }

  async function handleConfirm() {
    setConfirming(true);
    setError(null);
    try {
      await onConfirm(folderId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConfirming(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 w-full max-w-md mx-4">
        <div className="p-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none">&times;</button>
        </div>

        <nav className="px-4 py-2 border-b border-gray-100 dark:border-gray-700 flex items-center flex-wrap gap-1 text-sm text-gray-500 dark:text-gray-400">
          {breadcrumbs.map((c, i) => (
            <span key={c.id + i} className="flex items-center gap-1">
              {i > 0 && <span className="text-gray-300 dark:text-gray-600">/</span>}
              <button
                onClick={() => navigateTo(i)}
                className={i === breadcrumbs.length - 1 ? 'text-gray-800 dark:text-gray-200 font-medium' : 'hover:text-blue-600 dark:hover:text-blue-400'}
              >
                {c.name}
              </button>
            </span>
          ))}
        </nav>

        <div className="p-2 min-h-40 max-h-64 overflow-y-auto">
          {loading && <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">Loading…</div>}
          {!loading && error && <div className="p-3 text-sm text-red-500 dark:text-red-400">{error}</div>}
          {!loading && !error && folders.length === 0 && (
            <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">No subfolders</div>
          )}
          {!loading && !error && folders.map(f => (
            <button
              key={f.id}
              onClick={() => navigate(f.id, f.name)}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded-lg"
            >
              <span className="select-none">📁</span>
              <span className="truncate text-gray-800 dark:text-gray-200">{f.name}</span>
            </button>
          ))}
        </div>

        <div className="p-4 border-t border-gray-100 dark:border-gray-700 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={confirming}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {confirming ? 'Working…' : 'Select this folder'}
          </button>
        </div>
      </div>
    </div>
  );
}
