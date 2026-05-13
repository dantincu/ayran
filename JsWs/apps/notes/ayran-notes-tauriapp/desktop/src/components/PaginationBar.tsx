import { useState, useEffect, useRef } from 'react';

interface Props {
  page: number;      // 0-indexed
  total: number;     // total matching items across all pages
  pageSize: number;
  onPage: (page: number) => void;
}

export default function PaginationBar({ page, total, pageSize, onPage }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editValue, setEditValue] = useState('');
  const editRef = useRef<HTMLDivElement>(null);
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;

  if (totalPages <= 1) return null;

  // Close numeric-input popover on outside click
  useEffect(() => {
    if (!editOpen) return;
    const close = (e: MouseEvent) => {
      if (editRef.current && !editRef.current.contains(e.target as Node)) setEditOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [editOpen]);

  const openEdit = (e: React.MouseEvent) => {
    e.preventDefault();
    setEditValue(String(page + 1));
    setEditOpen(true);
  };

  const submitEdit = () => {
    const p = parseInt(editValue, 10);
    if (!isNaN(p) && p >= 1 && p <= totalPages) onPage(p - 1);
    setEditOpen(false);
  };

  return (
    <>
      <div className="flex items-center justify-center gap-1 py-2.5 border-t border-gray-100 dark:border-gray-700 text-sm select-none">
        <button
          onClick={() => onPage(page - 1)}
          disabled={page === 0}
          className="px-2.5 py-0.5 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 transition-colors"
          title="Previous page"
        >
          ←
        </button>

        {/* Page label — left-click: dropdown, right-click: numeric input */}
        <div className="relative">
          <button
            onClick={() => setPickerOpen(true)}
            onContextMenu={openEdit}
            className="px-3 py-0.5 rounded text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors tabular-nums font-medium"
            title="Left-click: pick page · Right-click: type page number"
          >
            {page + 1} / {totalPages}
          </button>

          {editOpen && (
            <div
              ref={editRef}
              className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 min-w-[170px]"
            >
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                Go to page (1 – {totalPages})
              </p>
              <div className="flex gap-2">
                <input
                  type="number"
                  min={1}
                  max={totalPages}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitEdit();
                    if (e.key === 'Escape') setEditOpen(false);
                  }}
                  className="w-20 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                />
                <button
                  onClick={submitEdit}
                  className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
                >
                  Go
                </button>
              </div>
            </div>
          )}
        </div>

        <button
          onClick={() => onPage(page + 1)}
          disabled={page >= totalPages - 1}
          className="px-2.5 py-0.5 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 transition-colors"
          title="Next page"
        >
          →
        </button>
      </div>

      {/* Page-picker dropdown (left-click) */}
      {pickerOpen && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onMouseDown={() => setPickerOpen(false)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-xl shadow-xl py-2 overflow-y-auto max-h-72 min-w-36"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <p className="px-4 pt-1 pb-2 text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">
              Go to page
            </p>
            {Array.from({ length: totalPages }, (_, i) => (
              <button
                key={i}
                onClick={() => { onPage(i); setPickerOpen(false); }}
                className={`w-full text-left px-4 py-1.5 text-sm transition-colors ${
                  i === page
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
              >
                {i + 1}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
