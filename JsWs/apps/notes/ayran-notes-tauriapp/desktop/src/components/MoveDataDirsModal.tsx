import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface Props {
  isMainWindow: boolean;
  onDone: () => void;
}

export default function MoveDataDirsModal({ isMainWindow, onDone }: Props) {
  const [copied, setCopied] = useState(0);
  const [total, setTotal] = useState(0);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    listen<{ copied: number; total: number }>('data-dirs-move-progress', (e) => {
      setCopied(e.payload.copied);
      setTotal(e.payload.total);
    }).then((fn) => unlisteners.push(fn)).catch(() => {});

    listen('data-dirs-move-done', () => onDone())
      .then((fn) => unlisteners.push(fn)).catch(() => {});

    listen('data-dirs-move-cancelled', () => onDone())
      .then((fn) => unlisteners.push(fn)).catch(() => {});

    return () => unlisteners.forEach((fn) => fn());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    try { await invoke('cancel_move_data_dirs'); } catch { /* fire and forget */ }
  };

  const pct = total > 0 ? Math.round((copied / total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm flex items-center justify-center">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl p-8 w-full max-w-sm mx-4 flex flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-10 h-10 text-blue-500">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 11v6m-3-3l3 3 3-3"/>
          </svg>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Relocating data folders…
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {isMainWindow
              ? 'Moving c/, t/, and s/ to the new location. Do not close the app.'
              : 'Data folders are being relocated. Please wait until the operation is complete.'}
          </p>
        </div>

        {isMainWindow && (
          <>
            <div className="w-full">
              <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1.5">
                <span>{total > 0 ? `${copied} / ${total} files` : 'Preparing…'}</span>
                {total > 0 && <span>{pct}%</span>}
              </div>
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5 overflow-hidden">
                <div
                  className="bg-blue-500 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${total > 0 ? pct : 0}%` }}
                />
              </div>
            </div>

            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="px-5 py-2 text-sm bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-200 dark:hover:bg-red-800/40 disabled:opacity-40 transition-colors"
            >
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
