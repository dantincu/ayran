import { useState, useRef } from 'react';
import { save as dialogSave } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useKeyboardShortcuts } from './common/KeyboardShortcutsContext';

interface Props {
  onBack: () => void;
}

function ChevronLeft() {
  return (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <path d="M9 2L4 7l5 5"/>
    </svg>
  );
}

function parseKeysInput(raw: string): string {
  // Normalize whitespace between chords; preserve as-is otherwise
  return raw.trim().replace(/\s+/g, ' ');
}

export default function KeyboardShortcutsPage({ onBack }: Props) {
  const { shortcuts, defaultShortcuts, overrides, updateShortcutKeys, resetShortcutKeys, saveShortcuts } = useKeyboardShortcuts();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [syncPath, setSyncPath] = useState<string | null>(() => {
    try { return localStorage.getItem('kb-sync-path'); } catch { return null; }
  });
  const [loadingCloud, setLoadingCloud] = useState(false);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pending local edits — applied to state on Save
  const [pendingOverrides, setPendingOverrides] = useState<Record<string, string>>({ ...overrides });

  const startEdit = (id: string) => {
    setEditingId(id);
    setEditValue(shortcuts[id]?.keys ?? '');
    setEditError(null);
  };

  const confirmEdit = () => {
    if (!editingId) return;
    const normalized = parseKeysInput(editValue);
    if (!normalized) { setEditError('Shortcut cannot be empty'); return; }
    const isDefault = normalized === defaultShortcuts[editingId]?.keys;
    if (isDefault) {
      // Reset to default
      const next = { ...pendingOverrides };
      delete next[editingId];
      setPendingOverrides(next);
      resetShortcutKeys(editingId);
    } else {
      setPendingOverrides((p) => ({ ...p, [editingId]: normalized }));
      updateShortcutKeys(editingId, normalized);
    }
    setEditingId(null);
    setEditError(null);
  };

  const cancelEdit = () => { setEditingId(null); setEditError(null); };

  const handleReset = (id: string) => {
    const next = { ...pendingOverrides };
    delete next[id];
    setPendingOverrides(next);
    resetShortcutKeys(id);
    if (editingId === id) setEditingId(null);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveShortcuts(pendingOverrides, syncPath);
      setSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      alert(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleChooseSyncPath = async () => {
    const path = await dialogSave({
      title: 'Choose sync file for keyboard shortcuts',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      defaultPath: syncPath ?? undefined,
    });
    if (!path) return;
    setSyncPath(path);
    localStorage.setItem('kb-sync-path', path);

    // Load existing shortcuts from the chosen file and merge
    setLoadingCloud(true);
    setCloudError(null);
    try {
      const content = await invoke<string | null>('read_file_text', { path });
      if (content) {
        const data = JSON.parse(content) as Record<string, string>;
        const merged = { ...pendingOverrides, ...data };
        setPendingOverrides(merged);
        for (const [id, keys] of Object.entries(data)) {
          updateShortcutKeys(id, keys);
        }
      }
    } catch (e) {
      setCloudError(`Could not load sync file: ${String(e)}`);
    } finally {
      setLoadingCloud(false);
    }
  };

  const handleClearSyncPath = () => {
    setSyncPath(null);
    localStorage.removeItem('kb-sync-path');
  };

  const shortcutIds = Object.keys(shortcuts);

  const inputCls = 'w-full px-2 py-1 text-sm bg-white dark:bg-gray-700 border border-blue-400 dark:border-blue-500 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 font-mono';
  const btnSm = 'px-2 py-0.5 text-xs rounded transition-colors';

  return (
    <div className="space-y-4 max-w-xl">
      {/* Header */}
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 transition-colors" title="Back">
          <ChevronLeft />
        </button>
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">Keyboard Shortcuts</h2>
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400">
        Chords are separated by spaces. Use <code className="font-mono">Ctrl</code>, <code className="font-mono">Shift</code>, <code className="font-mono">Alt</code> as modifiers.
        Example: <code className="font-mono">Ctrl+T N</code>
      </p>

      {/* Shortcuts list */}
      <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden divide-y divide-gray-100 dark:divide-gray-700">
        {shortcutIds.map((id) => {
          const def = shortcuts[id];
          const isOverridden = id in pendingOverrides;
          const isEditing = editingId === id;
          return (
            <div key={id} className="px-4 py-3 bg-white dark:bg-gray-800">
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{def.name}</p>
                  {isEditing ? (
                    <div className="mt-1 space-y-1">
                      <input
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); confirmEdit(); }
                          if (e.key === 'Escape') { e.stopPropagation(); cancelEdit(); }
                        }}
                        className={inputCls}
                        placeholder="e.g. Ctrl+T N"
                      />
                      {editError && <p className="text-xs text-red-500">{editError}</p>}
                      <div className="flex gap-1">
                        <button onClick={confirmEdit} className={`${btnSm} bg-blue-600 hover:bg-blue-700 text-white`}>Apply</button>
                        <button onClick={cancelEdit} className={`${btnSm} bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600`}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs font-mono text-gray-500 dark:text-gray-400 mt-0.5">
                      {def.keys}
                      {isOverridden && <span className="ml-1 text-blue-500 dark:text-blue-400">(modified)</span>}
                    </p>
                  )}
                </div>
                {!isEditing && (
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => startEdit(id)} className={`${btnSm} bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600`}>Edit</button>
                    {isOverridden && (
                      <button onClick={() => handleReset(id)} className={`${btnSm} text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40`}>Reset</button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Cloud sync section */}
      <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-200">Cloud sync</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Optionally sync your shortcuts to a local JSON file (e.g. inside a cloud-synced folder).
          </p>
        </div>
        <div className="px-4 py-3 bg-white dark:bg-gray-800 space-y-2">
          {syncPath ? (
            <div className="space-y-1">
              <p className="text-xs font-mono text-gray-600 dark:text-gray-300 break-all">{syncPath}</p>
              {cloudError && <p className="text-xs text-red-500">{cloudError}</p>}
              <div className="flex gap-2">
                <button onClick={handleChooseSyncPath} disabled={loadingCloud} className={`${btnSm} bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50`}>
                  Change path…
                </button>
                <button onClick={handleClearSyncPath} className={`${btnSm} text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40`}>
                  Remove sync
                </button>
              </div>
            </div>
          ) : (
            <button onClick={handleChooseSyncPath} className={`${btnSm} bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600`}>
              Choose sync file…
            </button>
          )}
        </div>
      </div>

      {/* Save button */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-1.5 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-sm text-green-600 dark:text-green-400">Saved</span>}
      </div>
    </div>
  );
}
