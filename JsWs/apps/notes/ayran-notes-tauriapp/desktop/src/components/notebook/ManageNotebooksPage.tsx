import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getAllWebviewWindows, WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen, emit } from '@tauri-apps/api/event';
import { readFile } from '@tauri-apps/plugin-fs';
import { getAllNotebooks, deleteNotebook, reorderNotebooks, updateNotebook, updateNotebooksByFile, type NotebookEntry } from '../../lib/notebooks-db';
import Modal from '../common/Modal';
import Popover from '../common/Popover';

function NotebookIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" className="shrink-0 text-emerald-600 dark:text-emerald-400">
      <rect x="4" y="2" width="12" height="16" rx="1.5" fill="currentColor" opacity="0.15"/>
      <rect x="4" y="2" width="12" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
      <line x1="7" y1="6" x2="13" y2="6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="7" y1="9" x2="13" y2="9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="7" y1="12" x2="11" y2="12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <rect x="2" y="5" width="2.5" height="10" rx="0.5" fill="currentColor" opacity="0.5"/>
    </svg>
  );
}

export default function ManageNotebooksPage() {
  const [notebooks, setNotebooks] = useState<NotebookEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entry: NotebookEntry } | null>(null);
  const [nbStates, setNbStates] = useState<Record<string, { fullscreen: boolean; headerVisible: boolean }>>({});
  const [showEdit, setShowEdit] = useState(false);
  const [editEntry, setEditEntry] = useState<NotebookEntry | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);


  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setNotebooks(await getAllNotebooks());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  // Listen for window open/close/state events from notebook windows.
  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    listen<{ notebookId: string }>('notebook-window-closed', (event) => {
      setNotebooks((prev) =>
        prev.map((n) => n.id === event.payload.notebookId ? { ...n, windowLabel: undefined } : n)
      );
      setNbStates((prev) => { const next = { ...prev }; delete next[event.payload.notebookId]; return next; });
    }).then((fn) => unlisteners.push(fn)).catch(() => {});

    listen<{ notebookId: string; windowLabel: string }>('notebook-window-opened', (event) => {
      setNotebooks((prev) =>
        prev.map((n) => n.id === event.payload.notebookId ? { ...n, windowLabel: event.payload.windowLabel } : n)
      );
      setNbStates((prev) => ({ ...prev, [event.payload.notebookId]: { fullscreen: false, headerVisible: true } }));
    }).then((fn) => unlisteners.push(fn)).catch(() => {});

    listen<{ notebookId: string; fullscreen: boolean; headerVisible: boolean }>('notebook-state', (event) => {
      setNbStates((prev) => ({ ...prev, [event.payload.notebookId]: { fullscreen: event.payload.fullscreen, headerVisible: event.payload.headerVisible } }));
    }).then((fn) => unlisteners.push(fn)).catch(() => {});

    // Request current state from any already-open notebook windows.
    void emit('notebook-request-state', {});

    return () => { unlisteners.forEach((fn) => fn()); };
  }, []);


  const handleDragStart = (idx: number) => setDragIdx(idx);
  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    setDragOverIdx(idx);
  };
  const handleDrop = async (idx: number) => {
    if (dragIdx === null || dragIdx === idx) {
      setDragIdx(null);
      setDragOverIdx(null);
      return;
    }
    const reordered = [...notebooks];
    const [moved] = reordered.splice(dragIdx, 1);
    reordered.splice(idx, 0, moved);
    setNotebooks(reordered);
    setDragIdx(null);
    setDragOverIdx(null);
    await reorderNotebooks(reordered.map((n) => n.id));
  };
  const handleDragEnd = () => { setDragIdx(null); setDragOverIdx(null); };

  const handleContextMenu = (e: React.MouseEvent, entry: NotebookEntry) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, entry });
  };

  const openInNewWindow = async (nb: NotebookEntry) => {
    // If already open in a known window, just focus it.
    if (nb.windowLabel) {
      let found = false;
      try {
        const windows = await getAllWebviewWindows();
        const win = windows.find((w) => w.label === nb.windowLabel);
        if (win) {
          found = true;
          try { await win.setFocus(); } catch { /* non-fatal */ }
        }
      } catch { /* non-fatal */ }
      if (found) return;
      // Stale label — clear it.
      try {
        await updateNotebook(nb.id, { windowLabel: undefined });
        setNotebooks((prev) => prev.map((n) => n.id === nb.id ? { ...n, windowLabel: undefined } : n));
      } catch { /* non-fatal */ }
    }

    const label = 'nb-' + Date.now();
    try { await updateNotebook(nb.id, { windowLabel: label }); } catch { /* non-fatal */ }
    try {
      void new WebviewWindow(label, {
        url: '/?notebook=' + nb.id + '&wlabel=' + label,
        title: nb.title || 'Notebook',
        width: 1280,
        height: 800,
      });
    } catch { /* non-fatal */ }
    try { await emit('notebook-window-opened', { notebookId: nb.id, windowLabel: label }); } catch { /* non-fatal */ }
    setNotebooks((prev) => prev.map((n) => n.id === nb.id ? { ...n, windowLabel: label } : n));
  };

  const handleRowClick = async (nb: NotebookEntry) => { await openInNewWindow(nb); };

  const handleCtxOpen = async () => {
    if (!ctxMenu) return;
    const entry = ctxMenu.entry;
    setCtxMenu(null);
    await openInNewWindow(entry);
  };
  const handleCtxEdit = () => {
    if (!ctxMenu) return;
    setEditEntry(ctxMenu.entry);
    setEditTitle(ctxMenu.entry.title);
    setEditDesc(ctxMenu.entry.description ?? '');
    setCtxMenu(null);
    setShowEdit(true);
  };
  const handleCtxDelete = async () => {
    if (!ctxMenu) return;
    const id = ctxMenu.entry.id;
    setCtxMenu(null);
    await deleteNotebook(id);
    await reload();
  };
  const closeWindowForEntry = async (entry: NotebookEntry) => {
    if (!entry.windowLabel) return;
    try {
      const windows = await getAllWebviewWindows();
      const win = windows.find((w) => w.label === entry.windowLabel);
      if (win) await win.close();
    } catch { /* non-fatal */ }
    try {
      await updateNotebook(entry.id, { windowLabel: undefined });
    } catch { /* non-fatal */ }
    setNotebooks((prev) => prev.map((n) => n.id === entry.id ? { ...n, windowLabel: undefined } : n));
  };
  const handleCtxCloseWindow = async () => {
    if (!ctxMenu) return;
    const entry = ctxMenu.entry;
    setCtxMenu(null);
    await closeWindowForEntry(entry);
  };
  const handleCtxToggleFullscreen = async () => {
    if (!ctxMenu) return;
    const id = ctxMenu.entry.id;
    setCtxMenu(null);
    await emit('notebook-cmd', { notebookId: id, cmd: 'toggle-fullscreen' });
  };
  const handleCtxToggleHeader = async () => {
    if (!ctxMenu) return;
    const id = ctxMenu.entry.id;
    setCtxMenu(null);
    await emit('notebook-cmd', { notebookId: id, cmd: 'toggle-header' });
  };
  const handleEditSave = async () => {
    if (!editEntry || !editTitle.trim()) return;
    setEditSaving(true);
    setEditError(null);
    try {
      const oldItemId = editEntry.itemId;

      // Download (or hit cache), update the Title field, and save back to the provider.
      const path = await invoke<string>('open_file', {
        accountId: editEntry.accountId,
        itemId: oldItemId,
        force: false,
      });
      const bytes = await readFile(path);
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      parsed.Title = editTitle;
      const updatedJson = JSON.stringify(parsed, null, 2);
      const newItemId = await invoke<string>('save_text_file', {
        accountId: editEntry.accountId,
        itemId: oldItemId,
        parentId: editEntry.parentId,
        content: updatedJson,
      });

      // Update title on every instance that references the same file.
      await updateNotebooksByFile(editEntry.accountId, editEntry.provider, oldItemId, {
        title: editTitle,
        ...(newItemId !== oldItemId ? { itemId: newItemId } : {}),
      });
      // Description is per-instance — update only this entry.
      await updateNotebook(editEntry.id, { description: editDesc || undefined });
      setShowEdit(false);
      setEditEntry(null);
      await reload();
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      setEditSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold text-gray-900 dark:text-white">Notebooks</h2>

      {/* Context menu */}
      {ctxMenu && (
        <Popover title={ctxMenu.entry.title || '(Untitled)'} onClose={() => setCtxMenu(null)} panelStyle={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <div className="py-1">
            <button onClick={() => { void handleCtxOpen(); }} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">Open</button>
            <button onClick={handleCtxEdit} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">Edit</button>
            {ctxMenu.entry.windowLabel && (() => {
              const st = nbStates[ctxMenu.entry.id];
              return (
                <>
                  <button onClick={() => { void handleCtxToggleFullscreen(); }} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
                    {st?.fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                  </button>
                  <button onClick={() => { void handleCtxToggleHeader(); }} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
                    {st?.headerVisible === false ? 'Show header' : 'Hide header'}
                  </button>
                  <button onClick={() => { void handleCtxCloseWindow(); }} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">Close</button>
                </>
              );
            })()}
            <button onClick={() => { void handleCtxDelete(); }} className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-50 dark:hover:bg-gray-700">Remove</button>
          </div>
        </Popover>
      )}

      {/* Edit modal */}
      {showEdit && editEntry && (
        <Modal title="Edit Notebook">
          <div className="p-6 space-y-4">
            {editError && <p className="text-sm text-red-500 dark:text-red-400">{editError}</p>}
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Title</label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
                <textarea
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  placeholder="Description (optional) — stored locally only"
                  rows={3}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowEdit(false); setEditEntry(null); setEditError(null); }}
                className="px-4 py-2 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600"
              >
                Cancel
              </button>
              <button
                onClick={handleEditSave}
                disabled={editSaving || !editTitle.trim()}
                className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40"
              >
                {editSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500">
          Loading…
        </div>
      ) : notebooks.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-center text-gray-400 dark:text-gray-500 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl px-6">
          <NotebookIcon />
          <p className="mt-3 text-sm">No notebooks yet.</p>
          <p className="text-sm mt-1">Open a <code className="font-mono text-xs bg-gray-100 dark:bg-gray-700 px-1 py-0.5 rounded">[note-book].json</code> file and click &ldquo;Open as Notebook&rdquo;.</p>
        </div>
      ) : (
        <div className="space-y-1">
          {notebooks.map((nb, idx) => {
            const isOpen = !!nb.windowLabel;
            return (
              <div
                key={nb.id}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDrop={() => handleDrop(idx)}
                onDragEnd={handleDragEnd}
                onClick={() => { void handleRowClick(nb); }}
                onContextMenu={(e) => handleContextMenu(e, nb)}
                className={[
                  'flex items-center gap-2 px-3 py-1.5 rounded-lg cursor-pointer transition-colors',
                  'border',
                  isOpen
                    ? 'bg-emerald-50 dark:bg-emerald-900/10 border-l-4 border-emerald-500 border-t-gray-100 border-r-gray-100 border-b-gray-100 dark:border-t-gray-700 dark:border-r-gray-700 dark:border-b-gray-700'
                    : 'bg-white dark:bg-gray-800 border-gray-100 dark:border-gray-700',
                  'hover:bg-gray-50 dark:hover:bg-gray-700',
                  dragIdx === idx ? 'opacity-50' : '',
                  dragOverIdx === idx ? 'border-t-2 border-blue-500' : '',
                ].join(' ')}
              >
                <div className="shrink-0">
                  <NotebookIcon />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-gray-900 dark:text-white truncate text-sm">
                    {nb.title || '(Untitled notebook)'}
                  </p>
                  {(nb.description || nb.displayPath) && (
                    <p className={`text-xs truncate mt-0.5 ${nb.description ? 'text-gray-500 dark:text-gray-400' : 'text-gray-400 dark:text-gray-500 italic'}`}>
                      {nb.description ?? nb.displayPath}
                    </p>
                  )}
                </div>
                {isOpen && (
                  <div className="shrink-0 flex items-center gap-1.5">
                    <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-900/30 px-1.5 py-0.5 rounded">
                      ↗ open
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); void closeWindowForEntry(nb); }}
                      className="text-gray-400 hover:text-red-500 dark:hover:text-red-400 w-5 h-5 flex items-center justify-center rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                      title="Close window"
                    >
                      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3"><path d="M1 1l10 10M11 1L1 11"/></svg>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
