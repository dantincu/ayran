import { useState, useEffect, useRef } from 'react';
import Modal from '../common/Modal';
import Popover from '../common/Popover';
import PaginationBar from './PaginationBar';
import { FolderPlusIcon, AncestorsIcon } from './ExplorerIcons';
import BreadcrumbAncestorsModal, { type AncestorEntry } from './BreadcrumbAncestorsModal';
import BreadcrumbChangePathModal from './BreadcrumbChangePathModal';
import config from '../../config.json';

export interface FolderEntry {
  id: string;
  name: string;
  isDir: boolean;
}

interface Props {
  title: string;
  rootId: string;
  rootName: string;
  initialFolderId?: string;
  initialBreadcrumbs?: { id: string; name: string }[];
  onList: (id: string) => Promise<FolderEntry[]>;
  /** destNames[i] is the new name for sourceItems[i] at the destination. */
  onConfirm: (folderId: string, destNames: string[]) => Promise<void>;
  onClose: () => void;
  /** Items being copied / moved — drives the "Change destination name" feature. */
  sourceItems?: Array<{ id: string; name: string; isDir: boolean }>;
  /** If provided, each item row shows a Rename button. */
  onRename?: (item: FolderEntry, newName: string) => Promise<void>;
  /** If provided, each item row shows a Delete button. */
  onDelete?: (item: FolderEntry) => Promise<void>;
  /** If provided, a "New folder" button appears in the breadcrumb bar. */
  onCreateFolder?: (parentId: string, name: string) => Promise<FolderEntry>;
  /**
   * If provided, the breadcrumb context menu shows a "Change path" option.
   * Should resolve a path string (e.g. "Documents/Projects") to breadcrumb
   * entries relative to the root. Return null if the path is not found; throw
   * with an error message if the path is ambiguous.
   */
  onResolvePath?: (pathStr: string) => Promise<Array<{ id: string; name: string }> | null>;
  /** When true the modal keeps its state but renders nothing (minimize). */
  isMinimized?: boolean;
  /** Whether to show the minimize button. */
  minimizable?: boolean;
  onMinimize?: () => void;
  /** When provided, shows a "Pick from previous tab" suggestion in the path editor. */
  prevExplorerPath?: string;
}

export default function FolderPickerModal({
  title, rootId, rootName, initialFolderId, initialBreadcrumbs,
  onList, onConfirm, onClose,
  sourceItems = [],
  onRename, onDelete, onCreateFolder, onResolvePath,
  isMinimized = false, minimizable = false, onMinimize,
  prevExplorerPath,
}: Props) {
  // Keep state alive but render nothing while minimized.
  if (isMinimized) return <></>;

  const [folderId, setFolderId] = useState(initialFolderId ?? rootId);
  const [breadcrumbs, setBreadcrumbs] = useState(
    initialBreadcrumbs ?? [{ id: rootId, name: rootName }]
  );
  const [items, setItems] = useState<FolderEntry[]>([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline rename
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);

  // Inline delete
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Create folder
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const [newFolderBusy, setNewFolderBusy] = useState(false);

  // Destination rename mode
  const [destNamesMode, setDestNamesMode] = useState(false);
  const [destNames, setDestNames] = useState<string[]>(() => sourceItems.map(si => si.name));
  const [destNamesErrors, setDestNamesErrors] = useState<string[]>(() => sourceItems.map(() => ''));

  // Three-dots menu
  const [moreOpen, setMoreOpen] = useState(false);

  // Context menus
  const [crumbCtx, setCrumbCtx] = useState<{ x: number; y: number } | null>(null);
  const [rowCtxMenu, setRowCtxMenu] = useState<{ x: number; y: number; item: FolderEntry } | null>(null);
  const [ancestorsConfig, setAncestorsConfig] = useState<{ entries: AncestorEntry[]; onNavigate: (i: number) => void } | null>(null);
  const [showChangePath, setShowChangePath] = useState(false);

  const onListRef = useRef(onList);
  onListRef.current = onList;

  const reload = () => {
    setLoading(true);
    setError(null);
    setPage(0);
    setRenamingId(null);
    setDeletingId(null);
    setCreatingFolder(false);
    setNewFolderName('');
    setNewFolderError(null);
    onListRef.current(folderId)
      .then(f => setItems(f))
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [folderId]);

  function navigate(id: string, name: string) {
    setFolderId(id);
    setBreadcrumbs(prev => [...prev, { id, name }]);
  }
  function navigateTo(index: number) {
    setFolderId(breadcrumbs[index].id);
    setBreadcrumbs(prev => prev.slice(0, index + 1));
  }

  // ── Rename ──────────────────────────────────────────────────────────────────
  function startRename(item: FolderEntry) {
    setRenamingId(item.id);
    setRenameValue(item.name);
    setRenameError(null);
    setDeletingId(null);
  }
  function validateRename(id: string, name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return 'Name cannot be empty.';
    if (items.some(i => i.id !== id && i.name === trimmed)) return `"${trimmed}" already exists here.`;
    return '';
  }
  async function commitRename(item: FolderEntry) {
    const err = validateRename(item.id, renameValue);
    if (err) { setRenameError(err); return; }
    setRenameBusy(true);
    try {
      await onRename!(item, renameValue.trim());
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, name: renameValue.trim() } : i));
      setRenamingId(null);
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : String(e));
    } finally {
      setRenameBusy(false);
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────────
  async function commitDelete(item: FolderEntry) {
    setDeleteBusy(true);
    try {
      await onDelete!(item);
      setItems(prev => prev.filter(i => i.id !== item.id));
      setDeletingId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleteBusy(false);
    }
  }

  // ── Create folder ────────────────────────────────────────────────────────────
  function startCreateFolder() {
    setCreatingFolder(true);
    setNewFolderName('');
    setNewFolderError(null);
    setPage(0);
  }
  async function commitCreateFolder() {
    const trimmed = newFolderName.trim();
    if (!trimmed) { setNewFolderError('Name cannot be empty.'); return; }
    if (items.some(i => i.name === trimmed)) { setNewFolderError(`"${trimmed}" already exists here.`); return; }
    setNewFolderBusy(true);
    try {
      const created = await onCreateFolder!(folderId, trimmed);
      setItems(prev => [{ ...created, isDir: true }, ...prev]);
      setCreatingFolder(false);
    } catch (e) {
      setNewFolderError(e instanceof Error ? e.message : String(e));
    } finally {
      setNewFolderBusy(false);
    }
  }

  // ── Confirm ──────────────────────────────────────────────────────────────────
  async function handleConfirm() {
    setConfirming(true);
    setError(null);
    try {
      await onConfirm(folderId, destNames);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConfirming(false);
    }
  }

  // ── Destination names ────────────────────────────────────────────────────────
  function updateDestName(i: number, val: string) {
    setDestNames(prev => { const n = [...prev]; n[i] = val; return n; });
    const trimmed = val.trim();
    const err = !trimmed ? 'Name cannot be empty.'
      : items.some(item => item.name === trimmed) ? `"${trimmed}" already exists here.`
      : '';
    setDestNamesErrors(prev => { const n = [...prev]; n[i] = err; return n; });
  }
  const destNamesHaveError = destNamesErrors.some(e => !!e);

  // ── Breadcrumb context ───────────────────────────────────────────────────────
  function openAncestorsForBreadcrumb() {
    setCrumbCtx(null);
    setAncestorsConfig({
      entries: breadcrumbs.map(b => ({ name: b.name, navigable: true })),
      onNavigate: (i) => { setAncestorsConfig(null); navigateTo(i); },
    });
  }

  async function handlePickerChangePath(pathStr: string) {
    const parts = pathStr.trim().split(/[/\\]/).map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) {
      setBreadcrumbs([{ id: rootId, name: rootName }]);
      setFolderId(rootId);
      return;
    }
    const result = await onResolvePath!(pathStr);
    if (!result) throw new Error(`Path "${pathStr}" not found.`);
    setBreadcrumbs([{ id: rootId, name: rootName }, ...result]);
    setFolderId(result[result.length - 1].id);
  }

  // ── Row context ──────────────────────────────────────────────────────────────
  function openAncestorsForItem(item: FolderEntry) {
    setRowCtxMenu(null);
    setAncestorsConfig({
      entries: [
        ...breadcrumbs.map(b => ({ name: b.name, navigable: true })),
        { name: item.name, navigable: item.isDir },
      ],
      onNavigate: (i) => {
        setAncestorsConfig(null);
        if (i < breadcrumbs.length) navigateTo(i);
        else if (item.isDir) navigate(item.id, item.name);
      },
    });
  }

  const pageSize = config.defaultListPageSize;
  const pageStart = page * pageSize;
  const visibleItems = items.slice(pageStart, pageStart + pageSize);

  const cls = {
    iconBtn: 'p-1 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors text-xs',
    danger: 'p-1 rounded text-red-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-xs',
    input: 'flex-1 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-400',
    ctxBtn: 'w-full text-left px-4 py-2 text-sm flex items-center gap-2 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700',
  };

  return (
    <>
      {/* Breadcrumb context menu */}
      {crumbCtx && (
        <Popover title="Location" onClose={() => setCrumbCtx(null)} panelStyle={{ left: crumbCtx.x, top: crumbCtx.y }}>
          <div className="py-1 min-w-[180px]">
            <button onClick={openAncestorsForBreadcrumb} className={cls.ctxBtn}>
              <AncestorsIcon className="w-3.5 h-3.5 shrink-0"/>Show ancestors
            </button>
            {onResolvePath && (
              <button onClick={() => { setCrumbCtx(null); setShowChangePath(true); }} className={cls.ctxBtn}>
                📂 Change path
              </button>
            )}
          </div>
        </Popover>
      )}

      {/* Row context menu */}
      {rowCtxMenu && (
        <Popover title={rowCtxMenu.item.name} onClose={() => setRowCtxMenu(null)} panelStyle={{ left: rowCtxMenu.x, top: rowCtxMenu.y }}>
          <div className="py-1 min-w-[160px]">
            {onDelete && (
              <button onClick={() => { setRowCtxMenu(null); setDeletingId(rowCtxMenu.item.id); }} className={`${cls.ctxBtn} text-red-600 dark:text-red-400`}>
                🗑 Delete
              </button>
            )}
            <button onClick={() => openAncestorsForItem(rowCtxMenu.item)} className={cls.ctxBtn}>
              <AncestorsIcon className="w-3.5 h-3.5 shrink-0"/>Show ancestors
            </button>
          </div>
        </Popover>
      )}

      {/* Ancestors modal */}
      {ancestorsConfig && (
        <BreadcrumbAncestorsModal
          entries={ancestorsConfig.entries}
          onNavigate={ancestorsConfig.onNavigate}
          onClose={() => setAncestorsConfig(null)}
        />
      )}

      {/* Change path modal */}
      {showChangePath && (
        <BreadcrumbChangePathModal
          defaultValue={breadcrumbs.slice(1).map(b => b.name).join('/')}
          placeholder="e.g. /Documents/Projects"
          onNavigate={handlePickerChangePath}
          onClose={() => setShowChangePath(false)}
          previousTabSuggestion={prevExplorerPath}
        />
      )}

      <Modal title={title} onClose={onClose} onMinimize={minimizable ? onMinimize : undefined}>
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">

          {/* Breadcrumb + New Folder button */}
          <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2 shrink-0 flex-wrap">
            <nav
              className="flex items-center flex-wrap gap-1 text-sm text-gray-500 dark:text-gray-400 flex-1 min-w-0"
              onContextMenu={(e) => { e.preventDefault(); setCrumbCtx({ x: e.clientX, y: e.clientY }); }}
            >
              {breadcrumbs.map((c, i) => (
                <span key={c.id + i} className="flex items-center gap-1">
                  {i > 0 && <span className="text-gray-300 dark:text-gray-600">/</span>}
                  <button onClick={() => navigateTo(i)}
                    className={i === breadcrumbs.length - 1 ? 'text-gray-800 dark:text-gray-200 font-medium' : 'hover:text-blue-600 dark:hover:text-blue-400'}>
                    {c.name}
                  </button>
                </span>
              ))}
            </nav>
            {onCreateFolder && (
              <button onClick={startCreateFolder} disabled={creatingFolder}
                title="New folder"
                className="shrink-0 p-1.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors">
                <FolderPlusIcon className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Error banner */}
          {error && (
            <div className="px-3 py-2 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-xs border-b border-red-100 dark:border-red-800 shrink-0">
              {error}
            </div>
          )}

          {/* ── Destination-names editor ── */}
          {destNamesMode ? (
            <div className="flex-1 overflow-y-auto flex flex-col">
              {/* Back button header row */}
              <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700 shrink-0 flex items-center">
                <button
                  onClick={() => setDestNamesMode(false)}
                  className="flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
                >
                  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                    <path d="M9 1L3 7l6 6"/>
                  </svg>
                  Back
                </button>
              </div>
              <div className="p-4 space-y-4 overflow-y-auto">
                <p className="text-xs text-gray-500 dark:text-gray-400">Set the name each item will have at the destination:</p>
                {sourceItems.map((si, i) => (
                  <div key={si.id} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-base select-none shrink-0">{si.isDir ? '📁' : '📄'}</span>
                      <span className="text-sm text-gray-600 dark:text-gray-400 truncate">{si.name}</span>
                    </div>
                    <div className="pl-1 text-gray-400 dark:text-gray-500 text-sm leading-none select-none">↓</div>
                    <input
                      value={destNames[i] ?? si.name}
                      onChange={(e) => updateDestName(i, e.target.value)}
                      className={cls.input}
                    />
                    {destNamesErrors[i] && (
                      <p className="text-xs text-red-500 dark:text-red-400">{destNamesErrors[i]}</p>
                    )}
                  </div>
                ))}
                <button onClick={() => setDestNamesMode(false)} disabled={destNamesHaveError}
                  className="mt-2 px-4 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                  Done
                </button>
              </div>
            </div>
          ) : (
            /* ── Normal folder browser ── */
            <div className="flex-1 overflow-y-auto min-h-40">
              {loading && <div className="flex items-center justify-center h-32 text-sm text-gray-400 dark:text-gray-500">Loading…</div>}
              {!loading && !error && (
                <div>
                  {/* Create-folder inline form */}
                  {creatingFolder && (
                    <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 dark:border-gray-700 bg-blue-50 dark:bg-blue-900/10">
                      <span className="text-base select-none">📁</span>
                      <input
                        value={newFolderName}
                        onChange={(e) => { setNewFolderName(e.target.value); setNewFolderError(null); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') void commitCreateFolder(); if (e.key === 'Escape') setCreatingFolder(false); }}
                        placeholder="New folder name"
                        // eslint-disable-next-line jsx-a11y/no-autofocus
                        autoFocus
                        className={cls.input}
                      />
                      <button onClick={() => void commitCreateFolder()} disabled={newFolderBusy || !newFolderName.trim()}
                        className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
                        {newFolderBusy ? '…' : '✓'}
                      </button>
                      <button onClick={() => setCreatingFolder(false)} className={cls.iconBtn}>✕</button>
                      {newFolderError && <span className="text-xs text-red-500">{newFolderError}</span>}
                    </div>
                  )}

                  {items.length === 0 && !creatingFolder && (
                    <div className="flex items-center justify-center h-32 text-sm text-gray-400 dark:text-gray-500">
                      This folder is empty
                    </div>
                  )}

                  {visibleItems.map((item) => {
                    const isRenaming = renamingId === item.id;
                    const isConfirmingDelete = deletingId === item.id;
                    return (
                      <div key={item.id}
                        className="group flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-700/40 border-b border-gray-50 dark:border-gray-700/50 last:border-0"
                        onContextMenu={(e) => { e.preventDefault(); setRowCtxMenu({ x: e.clientX, y: e.clientY, item }); }}>

                        <span className="text-base select-none shrink-0">{item.isDir ? '📁' : '📄'}</span>

                        {isRenaming ? (
                          <div className="flex-1 flex items-center gap-1 min-w-0">
                            <input
                              value={renameValue}
                              onChange={(e) => { setRenameValue(e.target.value); setRenameError(null); }}
                              onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(item); if (e.key === 'Escape') setRenamingId(null); }}
                              // eslint-disable-next-line jsx-a11y/no-autofocus
                              autoFocus
                              className={cls.input}
                            />
                            <button onClick={() => void commitRename(item)} disabled={renameBusy || !renameValue.trim()}
                              className="px-1.5 py-0.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
                              {renameBusy ? '…' : '✓'}
                            </button>
                            <button onClick={() => setRenamingId(null)} className={cls.iconBtn}>✕</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => item.isDir ? navigate(item.id, item.name) : undefined}
                            disabled={!item.isDir}
                            className={`flex-1 text-left text-sm truncate ${item.isDir ? 'text-gray-800 dark:text-gray-200 hover:text-blue-600 dark:hover:text-blue-400' : 'text-gray-400 dark:text-gray-500 cursor-default'}`}>
                            {item.name}
                          </button>
                        )}

                        {renameError && isRenaming && (
                          <span className="text-xs text-red-500 shrink-0">{renameError}</span>
                        )}

                        {/* Action buttons */}
                        {!isRenaming && (
                          <div className={`flex items-center gap-0.5 shrink-0 transition-opacity ${isConfirmingDelete ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                            {onRename && (
                              <button onClick={() => startRename(item)} title="Rename" className={cls.iconBtn}>
                                ✏
                              </button>
                            )}
                            {onDelete && !isConfirmingDelete && (
                              <button onClick={() => setDeletingId(item.id)} title="Delete" className={cls.danger}>
                                🗑
                              </button>
                            )}
                            {onDelete && isConfirmingDelete && (
                              <>
                                <span className="text-xs text-red-500 mr-1">Delete?</span>
                                <button onClick={() => void commitDelete(item)} disabled={deleteBusy}
                                  className="px-1.5 py-0.5 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50">
                                  {deleteBusy ? '…' : 'Yes'}
                                </button>
                                <button onClick={() => setDeletingId(null)} className={cls.iconBtn}>No</button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Pagination + three-dots */}
          {!destNamesMode && (
            <div className="flex items-center shrink-0 border-t border-gray-100 dark:border-gray-700">
              <div className="flex-1">
                <PaginationBar page={page} total={items.length} pageSize={pageSize} onPage={setPage} />
              </div>
              {sourceItems.length > 0 && (
                <div className="relative pr-2">
                  <button onClick={() => setMoreOpen(o => !o)}
                    className="p-1.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                      <circle cx="2" cy="7" r="1.4"/><circle cx="7" cy="7" r="1.4"/><circle cx="12" cy="7" r="1.4"/>
                    </svg>
                  </button>
                  {moreOpen && (
                    <Popover title="Options" onClose={() => setMoreOpen(false)} panelClassName="absolute right-0 bottom-full mb-1 min-w-max">
                      <div className="py-1">
                        <button onClick={() => { setMoreOpen(false); setDestNamesMode(true); }}
                          className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
                          Change destination name
                        </button>
                      </div>
                    </Popover>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Confirm / cancel footer */}
          {!destNamesMode && (
            <div className="p-3 border-t border-gray-100 dark:border-gray-700 flex justify-end gap-2 shrink-0">
              <button onClick={onClose}
                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors">
                Cancel
              </button>
              <button onClick={handleConfirm} disabled={confirming}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {confirming ? 'Working…' : 'Select this folder'}
              </button>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
