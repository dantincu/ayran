import { useState, useEffect, useRef } from 'react';
import Modal from '../common/Modal';
import Popover from '../common/Popover';
import PaginationBar from './PaginationBar';
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
}

export default function FolderPickerModal({
  title, rootId, rootName, initialFolderId, initialBreadcrumbs,
  onList, onConfirm, onClose,
  sourceItems = [],
  onRename, onDelete, onCreateFolder,
}: Props) {
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

  const pageSize = config.defaultListPageSize;
  const pageStart = page * pageSize;
  const visibleItems = items.slice(pageStart, pageStart + pageSize);

  const cls = {
    iconBtn: 'p-1 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors text-xs',
    danger: 'p-1 rounded text-red-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-xs',
    input: 'flex-1 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-400',
  };

  return (
    <Modal title={title} onClose={onClose}>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">

        {/* Breadcrumb + New Folder button */}
        <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2 shrink-0 flex-wrap">
          <nav className="flex items-center flex-wrap gap-1 text-sm text-gray-500 dark:text-gray-400 flex-1 min-w-0">
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
              className="shrink-0 px-2 py-1 text-xs rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors">
              + New folder
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
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">Set the name each item will have at the destination:</p>
            {sourceItems.map((si, i) => (
              <div key={si.id} className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-base select-none">{si.isDir ? '📁' : '📄'}</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400 truncate flex-1">{si.name}</span>
                  <span className="text-gray-300 dark:text-gray-600">→</span>
                  <input
                    value={destNames[i] ?? si.name}
                    onChange={(e) => updateDestName(i, e.target.value)}
                    className={cls.input + ' max-w-[180px]'}
                  />
                </div>
                {destNamesErrors[i] && (
                  <p className="text-xs text-red-500 dark:text-red-400 pl-6">{destNamesErrors[i]}</p>
                )}
              </div>
            ))}
            <button onClick={() => setDestNamesMode(false)} disabled={destNamesHaveError}
              className="mt-2 px-4 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
              Done
            </button>
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
                      className="group flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-700/40 border-b border-gray-50 dark:border-gray-700/50 last:border-0">

                      {/* Icon + name / rename input */}
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
  );
}
