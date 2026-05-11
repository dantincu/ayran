import { useState } from 'react';

interface Props {
  page: number;      // 0-indexed
  total: number;     // total matching items across all pages
  pageSize: number;
  onPage: (page: number) => void;
}

export default function PaginationBar({ page, total, pageSize, onPage }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;

  if (totalPages <= 1) return null;

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
        <button
          onClick={() => setPickerOpen(true)}
          className="px-3 py-0.5 rounded text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors tabular-nums font-medium"
          title="Jump to page"
        >
          {page + 1} / {totalPages}
        </button>
        <button
          onClick={() => onPage(page + 1)}
          disabled={page >= totalPages - 1}
          className="px-2.5 py-0.5 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 transition-colors"
          title="Next page"
        >
          →
        </button>
      </div>

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
