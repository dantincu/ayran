import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';

interface DataDirsInfo { current: string; default: string; isCustom: boolean; }

interface Props {
  onClose: () => void;
}

export default function AppDataFolderModal({ onClose }: Props) {
  const [info, setInfo] = useState<DataDirsInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    invoke<DataDirsInfo>('get_data_dirs_info')
      .then(setInfo)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const handleCopy = async () => {
    if (!info) return;
    await navigator.clipboard.writeText(info.current);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const startMove = async (newPath: string) => {
    setError(null);
    try {
      await invoke('start_move_data_dirs', { newPath });
      onClose(); // MoveDataDirsModal takes over from here
    } catch (e) {
      setError(String(e));
    }
  };

  const handleEdit = async () => {
    const sel = await dialogOpen({ directory: true, multiple: false });
    if (!sel || typeof sel !== 'string') return;
    await startMove(sel);
  };

  const handleReset = async () => {
    if (!confirm('Move data back to the default location?')) return;
    setError(null);
    try {
      await invoke('reset_data_dirs_to_default');
      onClose();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm flex items-center justify-center">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl p-6 w-full max-w-lg mx-4 flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">App Data Folder</h2>
          <button onClick={onClose}
            className="p-1.5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
            <svg viewBox="0 0 14 14" fill="currentColor" className="w-3.5 h-3.5"><path d="M2.3 2.3a1 1 0 011.4 0L7 5.6l3.3-3.3a1 1 0 111.4 1.4L8.4 7l3.3 3.3a1 1 0 01-1.4 1.4L7 8.4l-3.3 3.3a1 1 0 01-1.4-1.4L5.6 7 2.3 3.7a1 1 0 010-1.4z"/></svg>
          </button>
        </div>

        <p className="text-sm text-gray-500 dark:text-gray-400">
          The location where this app keeps its data and cache.
        </p>

        {loading && (
          <div className="text-sm text-gray-400 dark:text-gray-500">Loading…</div>
        )}

        {!loading && info && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2">
              {info.isCustom && (
                <span className="shrink-0 text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/30 px-1.5 py-0.5 rounded">Custom</span>
              )}
              <span className="flex-1 text-sm font-mono text-gray-800 dark:text-gray-200 truncate" title={info.current}>
                {info.current}
              </span>
              <button onClick={handleCopy} title="Copy path"
                className="shrink-0 p-1 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors">
                {copied
                  ? <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-emerald-500"><path d="M2 7l3 3 7-6"/></svg>
                  : <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><rect x="4.5" y="4.5" width="8" height="8" rx="1"/><path d="M9.5 4.5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v6.5a1 1 0 001 1H4.5"/></svg>
                }
              </button>
              <button onClick={handleEdit} title="Change data folder"
                className="shrink-0 p-1 rounded text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors">
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M9.5 2.5l2 2L4 12H2V10L9.5 2.5z"/></svg>
              </button>
            </div>
            {info.isCustom && (
              <button onClick={handleReset}
                className="self-start text-xs text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 underline underline-offset-2 transition-colors">
                Reset to default location
              </button>
            )}
          </div>
        )}

        {error && (
          <div className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded text-sm">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
