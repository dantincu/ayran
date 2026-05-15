import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';
import { WebviewWindow, getAllWebviewWindows, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emit } from '@tauri-apps/api/event';
import { getNotebook, updateNotebook, updateNotebooksByFile, deleteNotebook, type NotebookEntry } from '../../lib/notebooks-db';
import Modal from '../Modal';
import Popover from '../Popover';

interface Props {
  notebookId: string;
  onBack: () => void;
  onDeleted: () => void;
  onOpenedInNewWindow: () => void;
}

function NotebookIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="shrink-0 text-emerald-600 dark:text-emerald-400">
      <rect x="4" y="2" width="12" height="16" rx="1.5" fill="currentColor" opacity="0.15"/>
      <rect x="4" y="2" width="12" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
      <line x1="7" y1="6" x2="13" y2="6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="7" y1="9" x2="13" y2="9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="7" y1="12" x2="11" y2="12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <rect x="2" y="5" width="2.5" height="10" rx="0.5" fill="currentColor" opacity="0.5"/>
    </svg>
  );
}

export default function NotebookPage({ notebookId, onBack, onDeleted, onOpenedInNewWindow }: Props) {
  const isSecondaryWindow = !!new URLSearchParams(window.location.search).get('wlabel');

  const [entry, setEntry] = useState<NotebookEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showHeader, setShowHeader] = useState(true);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [showTitlePrompt, setShowTitlePrompt] = useState(false);
  const [promptTitle, setPromptTitle] = useState('');
  const [showEdit, setShowEdit] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);


  // Load notebook entry and file content
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const nb = await getNotebook(notebookId);
        if (cancelled) return;
        if (!nb) {
          setLoadError('Notebook not found.');
          setLoading(false);
          return;
        }
        setEntry(nb);

        let content: string | null = null;
        try {
          const path = await invoke<string>('open_file', {
            accountId: nb.accountId,
            itemId: nb.itemId,
            force: false,
          });
          const bytes = await readFile(path);
          content = new TextDecoder().decode(bytes);
          setFileContent(content);
        } catch {
          // file load failure is non-fatal
        }

        let parsedTitle = '';
        if (content) {
          try {
            parsedTitle = (JSON.parse(content) as { Title?: string }).Title ?? '';
          } catch { /* empty */ }
        }

        if (parsedTitle && parsedTitle !== nb.title) {
          await updateNotebook(nb.id, { title: parsedTitle });
          if (!cancelled) setEntry((prev) => prev ? { ...prev, title: parsedTitle } : prev);
        }

        if (!cancelled) {
          setLoading(false);
          if (!nb.title && !parsedTitle) {
            setShowTitlePrompt(true);
          }
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [notebookId]);

  // Close window listener: when this page is opened as a dedicated window (wlabel param present).
  useEffect(() => {
    const wlabel = new URLSearchParams(window.location.search).get('wlabel');
    if (!wlabel) return;

    let unlisten: (() => void) | undefined;
    getCurrentWebviewWindow().onCloseRequested(async (e) => {
      e.preventDefault();
      try {
        await updateNotebook(notebookId, { windowLabel: undefined });
      } catch { /* non-fatal */ }
      try {
        await emit('notebook-window-closed', { notebookId });
      } catch { /* non-fatal */ }
      try {
        await getCurrentWebviewWindow().destroy();
      } catch { /* non-fatal */ }
    }).then((fn) => { unlisten = fn; }).catch(() => { /* non-fatal */ });

    return () => { if (unlisten) unlisten(); };
  }, [notebookId]);

  // Sync isFullscreen state with actual window fullscreen (user can exit via Escape / OS chrome)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebviewWindow().listen('tauri://resize', async () => {
      try {
        const full = await getCurrentWebviewWindow().isFullscreen();
        setIsFullscreen(full);
      } catch { /* non-fatal */ }
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { if (unlisten) unlisten(); };
  }, []);


  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  const handleCtxBack = () => { setCtxMenu(null); onBack(); };
  const handleCtxEdit = () => {
    setCtxMenu(null);
    setEditTitle(entry?.title ?? '');
    setEditDesc(entry?.description ?? '');
    setShowEdit(true);
  };
  const handleCtxDelete = async () => {
    setCtxMenu(null);
    await deleteNotebook(notebookId);
    onDeleted();
  };
  const handleCtxToggleFullscreen = async () => {
    setCtxMenu(null);
    try {
      const win = getCurrentWebviewWindow();
      const current = await win.isFullscreen();
      await win.setFullscreen(!current);
      setIsFullscreen(!current);
    } catch { /* non-fatal */ }
  };
  const handleCtxNewWindow = async () => {
    setCtxMenu(null);
    if (!entry) return;

    // Check if already open in a window
    if (entry.windowLabel) {
      let found = false;
      try {
        const windows = await getAllWebviewWindows();
        const existing = windows.find((w) => w.label === entry.windowLabel);
        if (existing) {
          found = true;
          try { await existing.setFocus(); } catch { /* non-fatal */ }
        }
      } catch { /* non-fatal */ }
      if (found) return;
      // Stale label — clear it
      try {
        await updateNotebook(entry.id, { windowLabel: undefined });
        setEntry((prev) => prev ? { ...prev, windowLabel: undefined } : prev);
      } catch { /* non-fatal */ }
    }

    const label = 'nb-' + Date.now();
    try {
      await updateNotebook(entry.id, { windowLabel: label });
      setEntry((prev) => prev ? { ...prev, windowLabel: label } : prev);
    } catch { /* non-fatal */ }

    try {
      void new WebviewWindow(label, {
        url: '/?notebook=' + notebookId + '&wlabel=' + label,
        title: entry.title || 'Notebook',
        width: 1280,
        height: 800,
      });
    } catch { /* non-fatal */ }

    try {
      await emit('notebook-window-opened', { notebookId, windowLabel: label });
    } catch { /* non-fatal */ }

    onOpenedInNewWindow();
  };

  const handleEditSave = async () => {
    if (!entry || !editTitle.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const oldItemId = entry.itemId;
      let newItemId = oldItemId;

      if (fileContent !== null) {
        const parsed = JSON.parse(fileContent) as Record<string, unknown>;
        parsed.Title = editTitle;
        const updatedJson = JSON.stringify(parsed, null, 2);
        newItemId = await invoke<string>('save_text_file', {
          accountId: entry.accountId,
          itemId: oldItemId,
          parentId: entry.parentId,
          content: updatedJson,
        });
        setFileContent(updatedJson);
      }

      // Update title (and itemId if the file provider changed it) on all
      // instances that reference the same underlying file.
      await updateNotebooksByFile(entry.accountId, entry.provider, oldItemId, {
        title: editTitle,
        ...(newItemId !== oldItemId ? { itemId: newItemId } : {}),
      });
      // Description is per-instance.
      await updateNotebook(entry.id, { description: editDesc || undefined });

      setEntry({ ...entry, title: editTitle, description: editDesc || undefined, itemId: newItemId });
      setShowEdit(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handlePromptSave = async () => {
    if (!entry || !promptTitle.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const oldItemId = entry.itemId;
      let newItemId = oldItemId;

      if (fileContent !== null) {
        const parsed = JSON.parse(fileContent) as Record<string, unknown>;
        parsed.Title = promptTitle;
        const updatedJson = JSON.stringify(parsed, null, 2);
        newItemId = await invoke<string>('save_text_file', {
          accountId: entry.accountId,
          itemId: oldItemId,
          parentId: entry.parentId,
          content: updatedJson,
        });
        setFileContent(updatedJson);
      }

      await updateNotebooksByFile(entry.accountId, entry.provider, oldItemId, {
        title: promptTitle,
        ...(newItemId !== oldItemId ? { itemId: newItemId } : {}),
      });

      setEntry({ ...entry, title: promptTitle, itemId: newItemId });
      setShowTitlePrompt(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400 dark:text-gray-500">
        Loading notebook…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
        <p className="text-red-500 dark:text-red-400">{loadError}</p>
        <button onClick={onBack} className="px-4 py-2 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600">
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-white dark:bg-gray-900">
      {/* Context menu */}
      {ctxMenu && (
        <Popover title={entry?.title || '(Untitled)'} onClose={() => setCtxMenu(null)} panelStyle={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <div className="py-1">
            {!isSecondaryWindow && (
              <button onClick={handleCtxBack} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">Back</button>
            )}
            <button onClick={handleCtxEdit} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">Edit</button>
            <button onClick={handleCtxToggleFullscreen} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
              {isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
            </button>
            <button onClick={handleCtxDelete} className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-50 dark:hover:bg-gray-700">Remove</button>
            <button onClick={() => { void handleCtxNewWindow(); }} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">Open in new window</button>
          </div>
        </Popover>
      )}

      {/* Edit modal */}
      {showEdit && (
        <Modal title="Edit Notebook">
          <div className="p-6 space-y-4">
            {saveError && <p className="text-sm text-red-500 dark:text-red-400">{saveError}</p>}
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
              <button onClick={() => { setShowEdit(false); setSaveError(null); }} className="px-4 py-2 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600">
                Cancel
              </button>
              <button onClick={handleEditSave} disabled={saving || !editTitle.trim()} className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Title prompt modal */}
      {showTitlePrompt && (
        <Modal title="Name this Notebook">
          <div className="p-6 space-y-4">
            <p className="text-sm text-gray-500 dark:text-gray-400">This notebook has no title yet.</p>
            {saveError && <p className="text-sm text-red-500 dark:text-red-400">{saveError}</p>}
            <input
              type="text"
              value={promptTitle}
              onChange={(e) => setPromptTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && promptTitle.trim()) void handlePromptSave(); }}
              placeholder="Notebook title"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <div className="flex justify-end">
              <button onClick={handlePromptSave} disabled={saving || !promptTitle.trim()} className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Header */}
      {showHeader && (
        <div
          className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-2 shrink-0"
          onContextMenu={handleContextMenu}
        >
          <div className="flex items-center gap-2">
            <NotebookIcon />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm text-gray-900 dark:text-white truncate">
                {entry?.title || '(Untitled notebook)'}
              </p>
              {(entry?.description || entry?.displayPath) && (
                <p className={`text-xs truncate ${entry?.description ? 'text-gray-500 dark:text-gray-400' : 'text-gray-400 dark:text-gray-500 italic'}`}>
                  {entry?.description ?? entry?.displayPath}
                </p>
              )}
            </div>
            <button
              onClick={() => setShowHeader(false)}
              className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 w-6 h-6 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-xs"
            >
              ✕
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
