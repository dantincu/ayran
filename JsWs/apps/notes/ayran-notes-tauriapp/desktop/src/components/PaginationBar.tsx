import { useState } from 'react';
import Popover from './Popover';
import Modal from './Modal';
import config from '../config.json';

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
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;

  if (totalPages <= 1) return null;

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
        <button onClick={() => onPage(page - 1)} disabled={page === 0}
          className="px-2.5 py-0.5 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 transition-colors"
          title="Previous page">←</button>

        {/* Page label — left-click: picker modal · right-click: numeric input popover */}
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
            <Popover
              title={`Go to page (1 – ${totalPages})`}
              onClose={() => setEditOpen(false)}
              panelClassName="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 min-w-[200px]"
            >
              <div className="p-3">
                <div className="flex items-center gap-1">
                  <input
                    type="number" min={1} max={totalPages} value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitEdit();
                      if (e.key === 'Escape') setEditOpen(false);
                    }}
                    className="flex-1 min-w-0 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                  />
                  <button onClick={submitEdit} title="Confirm"
                    className="w-7 h-7 flex items-center justify-center rounded text-green-600 dark:text-green-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-base">
                    ✓
                  </button>
                </div>
              </div>
            </Popover>
          )}
        </div>

        <button onClick={() => onPage(page + 1)} disabled={page >= totalPages - 1}
          className="px-2.5 py-0.5 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 transition-colors"
          title="Next page">→</button>
      </div>

      {/* Page-picker modal (left-click) */}
      {pickerOpen && (() => {
        const half = Math.floor(config.defaultListPageSize / 2);
        const windowed = totalPages > config.defaultListPageSize;
        const startPage = windowed ? Math.max(0, page - half) : 0;
        const endPage   = windowed ? Math.min(totalPages - 1, page + half) : totalPages - 1;
        const pages = Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage + i);
        return (
          <Modal title="Go to page" onClose={() => setPickerOpen(false)} maxWidth="max-w-xs">
            <div className="py-2 overflow-y-auto max-h-64">
              {startPage > 0 && (
                <p className="px-4 py-1 text-xs text-gray-400 dark:text-gray-500">… pages 1 – {startPage} not shown</p>
              )}
              {pages.map((i) => (
                <button key={i} onClick={() => { onPage(i); setPickerOpen(false); }}
                  className={`w-full text-left px-4 py-1.5 text-sm transition-colors ${i === page ? 'bg-blue-600 text-white' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>
                  {i + 1}
                </button>
              ))}
              {endPage < totalPages - 1 && (
                <p className="px-4 py-1 text-xs text-gray-400 dark:text-gray-500">… pages {endPage + 2} – {totalPages} not shown</p>
              )}
            </div>
          </Modal>
        );
      })()}
    </>
  );
}
