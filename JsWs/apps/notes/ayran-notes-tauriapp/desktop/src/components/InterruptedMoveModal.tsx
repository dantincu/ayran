import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface Props {
  oldPath: string;
  newPath: string;
  onDismiss: () => void;
}

export default function InterruptedMoveModal({ oldPath, newPath, onDismiss }: Props) {
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCleanup = async () => {
    setCleaning(true); setError(null);
    try {
      await invoke('cleanup_interrupted_move');
      onDismiss();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCleaning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] bg-black/50 backdrop-blur-sm flex items-center justify-center">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl p-6 w-full max-w-md mx-4 flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7 text-amber-500 shrink-0 mt-0.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
          </svg>
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">
              Interrupted data folder move
            </h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              The app was closed while moving data folders. The move may be incomplete.
            </p>
          </div>
        </div>

        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-xs text-gray-600 dark:text-gray-400 space-y-1">
          <div><span className="font-medium text-gray-700 dark:text-gray-300">From:</span> {oldPath}</div>
          <div><span className="font-medium text-gray-700 dark:text-gray-300">To:</span> {newPath}</div>
        </div>

        <p className="text-sm text-gray-600 dark:text-gray-400">
          The destination location may contain partial data. You can delete the incomplete copy from the <strong>original</strong> location (the app is already using the destination), or keep both and clean up manually.
        </p>

        {error && (
          <div className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded text-sm">
            {error}
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onDismiss}
            disabled={cleaning}
            className="px-4 py-2 text-sm text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40 transition-colors"
          >
            Keep both
          </button>
          <button
            onClick={handleCleanup}
            disabled={cleaning}
            className="px-4 py-2 text-sm text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/30 rounded-lg hover:bg-red-200 dark:hover:bg-red-800/40 disabled:opacity-40 transition-colors"
          >
            {cleaning ? 'Deleting…' : 'Delete from original location'}
          </button>
        </div>
      </div>
    </div>
  );
}
