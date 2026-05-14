import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Popover from './Popover';
import { invoke } from '@tauri-apps/api/core';
import { save, open as dialogOpen } from '@tauri-apps/plugin-dialog';
import type { StoredAccount, CachedItem, FolderPage } from '../types';
import { deleteAccount } from '../lib/account-store';
import FolderPickerModal, { type FolderEntry } from './FolderPickerModal';
import PaginationBar from './PaginationBar';
import config from '../config.json';

const PAGE_SIZE = config.defaultListPageSize;

interface DriveFile {
  id: string; name: string; mimeType: string; size?: string; modifiedTime?: string;
}

interface Props {
  account: StoredAccount;
  onDisconnect: () => void;
  onOpenFile: (item: CachedItem) => void;
}

type SortBy = 'name' | 'size' | 'modified';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

function fileIcon(item: CachedItem): string {
  if (item.isDir) return '📁';
  const mime = item.mimeType ?? '';
  const ext = item.name.split('.').pop()?.toLowerCase() ?? '';
  if (mime.startsWith('image/') || ['jpg','jpeg','png','gif','webp','svg','avif'].includes(ext)) return '🖼';
  if (mime.startsWith('video/') || ['mp4','mkv','avi','mov','webm'].includes(ext)) return '🎬';
  if (mime.startsWith('audio/') || ['mp3','wav','ogg','flac','m4a'].includes(ext)) return '🎵';
  if (mime.includes('pdf') || ext === 'pdf') return '📄';
  if (mime.includes('spreadsheet') || mime.includes('excel') || ['xls','xlsx','csv'].includes(ext)) return '📊';
  if (mime.includes('presentation') || mime.includes('powerpoint') || ['ppt','pptx'].includes(ext)) return '📑';
  if (mime.includes('document') || mime.includes('word') || ['doc','docx','txt','md'].includes(ext)) return '📝';
  return '📄';
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export default function GoogleDriveExplorer({ account, onDisconnect, onOpenFile }: Props) {
  const navKey = `notes-gdrive-nav-${account.id}`;

  const savedNav = useMemo(() => {
    try {
      const raw = localStorage.getItem(navKey);
      return raw ? JSON.parse(raw) as {
        path?: string;
        id?: string; // old format — kept for graceful migration
        breadcrumbs: { name: string }[];
        page: number;
        search: string;
        sortBy: SortBy;
        ascending: boolean;
      } : null;
    } catch { return null; }
  }, [navKey]);

  const [folderId, setFolderId] = useState('root');
  const [breadcrumbs, setBreadcrumbs] = useState<{ id: string; name: string }[]>(
    [{ id: 'root', name: 'My Drive' }],
  );
  const [files, setFiles] = useState<CachedItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('name');
  const [ascending, setAscending] = useState(true);
  const [page, setPage] = useState(0);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cacheCleared, setCacheCleared] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<'copy' | 'move' | null>(null);
  const lastCheckedIdxRef = useRef<number | null>(null);
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const [folderPicker, setFolderPicker] = useState<{
    fileId: string; fileName: string; isDir: boolean; action: 'copy' | 'move';
  } | null>(null);

  const anyBusy = !!uploadingId || !!downloadingId || !!deletingId || !!editingId
    || !!renamingId || !!copyingId || !!movingId;

  // ── Persist state to localStorage whenever anything changes ──────────────────
  useEffect(() => {
    const crumbNames = breadcrumbs.map(b => b.name);
    const path = crumbNames.slice(1).join('/'); // skip root label "My Drive"
    localStorage.setItem(navKey, JSON.stringify({
      path, breadcrumbs: crumbNames.map(name => ({ name })),
      page, search, sortBy, ascending,
    }));
  }, [folderId, breadcrumbs, page, search, sortBy, ascending, navKey]);

  // ── Query SQLite cache (no network call) ─────────────────────────────────────
  const queryCache = useCallback(async (
    folder: string, sq: string, sb: SortBy, asc: boolean, pg: number,
  ) => {
    const result = await invoke<FolderPage>('query_folder_items', {
      accountId: account.id, parentId: folder,
      search: sq || null, sortBy: sb, ascending: asc,
      page: pg, pageSize: PAGE_SIZE,
    });
    setFiles(result.items);
    setTotal(result.total);
  }, [account.id]);

  // ── Full folder load: network fetch (if needed) + cache query ────────────────
  const loadFolder = useCallback(async (
    folder: string, force: boolean, pg: number, sq: string, sb: SortBy, asc: boolean,
  ) => {
    setLoading(true); setError(null);
    try {
      await invoke('list_folder', { accountId: account.id, parentId: folder, force });
      await queryCache(folder, sq, sb, asc, pg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [account.id, queryCache]);

  // ── Initial mount: restore saved state ───────────────────────────────────────
  useEffect(() => {
    const init = async () => {
      let startId = 'root';
      let startCrumbs: { id: string; name: string }[] = [{ id: 'root', name: 'My Drive' }];
      let startPage = 0;
      let startSearch = '';
      let startSort: SortBy = 'name';
      let startAsc = true;

      if (savedNav) {
        startPage = savedNav.page ?? 0;
        startSearch = savedNav.search ?? '';
        startSort = savedNav.sortBy ?? 'name';
        startAsc = savedNav.ascending ?? true;

        // Support both old format (id field) and new format (path field).
        const crumbNames: string[] = (savedNav.breadcrumbs ?? []).map((b: { name: string }) => b.name);
        const pathComponents = crumbNames.slice(1); // skip root "My Drive"
        if (pathComponents.length > 0) {
          const allPaths = pathComponents.map((_, i) =>
            pathComponents.slice(0, i + 1).join('/'));
          try {
            const resolved = await invoke<(string | null)[]>('resolve_folder_paths', {
              accountId: account.id, paths: allPaths,
            });
            if (resolved.every(r => r !== null)) {
              startCrumbs = [
                { id: 'root', name: crumbNames[0] ?? 'My Drive' },
                ...pathComponents.map((name, i) => ({ id: resolved[i]!, name })),
              ];
              startId = resolved[resolved.length - 1]!;
            }
          } catch { /* fall back to root */ }
        }
      }

      setFolderId(startId);
      setBreadcrumbs(startCrumbs);
      setSortBy(startSort);
      setAscending(startAsc);
      await loadFolder(startId, false, startPage, startSearch, startSort, startAsc);
    };
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // ── Navigation ───────────────────────────────────────────────────────────────
  function navigate(id: string, crumbs: { id: string; name: string }[]) {
    setFolderId(id); setBreadcrumbs(crumbs); setPage(0); setSearch('');
    setSelectedIds(new Set()); lastCheckedIdxRef.current = null;
    void loadFolder(id, false, 0, '', sortBy, ascending);
  }
  const openFolder = (item: CachedItem) => {
    if (!item.isDir) return;
    navigate(item.itemId, [...breadcrumbs, { id: item.itemId, name: item.name }]);
  };
  const navigateTo = (i: number) => navigate(breadcrumbs[i].id, breadcrumbs.slice(0, i + 1));

  // ── Search / sort / page ─────────────────────────────────────────────────────
  const handleSearch = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault(); setPage(0);
    try { await queryCache(folderId, search, sortBy, ascending, 0); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const handleClearSearch = async () => {
    setSearch(''); setPage(0);
    try { await queryCache(folderId, '', sortBy, ascending, 0); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const handleSort = async (col: SortBy) => {
    const newAsc = col === sortBy ? !ascending : true;
    setSortBy(col); setAscending(newAsc); setPage(0);
    try { await queryCache(folderId, search, col, newAsc, 0); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const handlePage = async (pg: number) => {
    setPage(pg); setSelectedIds(new Set()); lastCheckedIdxRef.current = null;
    try { await queryCache(folderId, search, sortBy, ascending, pg); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  // ── Refresh split-button handlers ────────────────────────────────────────────
  const handleRefresh = () => void loadFolder(folderId, false, page, search, sortBy, ascending);
  const handleHardRefresh = () => { setMenuOpen(false); void loadFolder(folderId, true, page, search, sortBy, ascending); };
  const handleClearCache = async () => {
    setMenuOpen(false);
    try {
      await invoke('invalidate_folder_cache', { accountId: account.id, parentId: folderId });
      setCacheCleared(true);
      setTimeout(() => setCacheCleared(false), 2000);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  // ── File actions ─────────────────────────────────────────────────────────────
  const handleDownload = async (item: CachedItem) => {
    const destPath = await save({ defaultPath: item.name });
    if (!destPath) return;
    setDownloadingId(item.itemId);
    try { await invoke('gdrive_download_file', { accountId: account.id, fileId: item.itemId, destPath }); }
    catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setDownloadingId(null); }
  };
  const handleDelete = async (item: CachedItem) => {
    if (!confirm(`Delete "${item.name}"?`)) return;
    setDeletingId(item.itemId);
    try {
      await invoke('gdrive_delete_file', { accountId: account.id, fileId: item.itemId });
      setFiles((p) => p.filter((f) => f.itemId !== item.itemId));
      invoke('uncache_item', { accountId: account.id, itemId: item.itemId }).catch(() => {});
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setDeletingId(null); }
  };
  const handleEdit = async (item: CachedItem) => {
    const filePath = await dialogOpen({ multiple: false, directory: false });
    if (!filePath || typeof filePath !== 'string') return;
    setEditingId(item.itemId);
    try {
      await invoke('gdrive_edit_file', { accountId: account.id, fileId: item.itemId, filePath });
      void loadFolder(folderId, true, 0, search, sortBy, ascending);
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setEditingId(null); }
  };
  const handleRename = async (item: CachedItem) => {
    const newName = prompt('New name:', item.name);
    if (!newName?.trim() || newName.trim() === item.name) return;
    setRenamingId(item.itemId);
    try {
      await invoke('gdrive_rename', { accountId: account.id, fileId: item.itemId, newName: newName.trim() });
      setFiles((p) => p.map((f) => f.itemId === item.itemId ? { ...f, name: newName.trim() } : f));
      invoke('rename_cached_item', { accountId: account.id, itemId: item.itemId, newName: newName.trim() }).catch(() => {});
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setRenamingId(null); }
  };
  const handleUpload = async () => {
    const filePath = await dialogOpen({ multiple: false, directory: false });
    if (!filePath || typeof filePath !== 'string') return;
    setUploadingId('__upload__');
    try {
      await invoke('gdrive_upload_file', { accountId: account.id, folderId, filePath });
      void loadFolder(folderId, true, 0, search, sortBy, ascending);
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setUploadingId(null); }
  };
  const handleNewFolder = async () => {
    const name = prompt('Folder name:'); if (!name?.trim()) return;
    setCreatingFolder(true);
    try {
      await invoke('gdrive_create_folder', { accountId: account.id, parentId: folderId, name: name.trim() });
      void loadFolder(folderId, true, 0, search, sortBy, ascending);
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setCreatingFolder(false); }
  };
  const handleDisconnect = async () => {
    if (!confirm(`Disconnect ${account.displayName ?? account.email} from Google Drive?`)) return;
    await deleteAccount(account.id);
    onDisconnect();
  };

  const listDriveFolders = async (id: string): Promise<FolderEntry[]> => {
    const list = await invoke<DriveFile[]>('gdrive_list_files', { accountId: account.id, folderId: id, query: null });
    return list.filter((f) => f.mimeType === FOLDER_MIME).map((f) => ({ id: f.id, name: f.name }));
  };
  const handleFolderPickerConfirm = async (destId: string) => {
    if (!folderPicker) return;
    const { fileId, fileName, isDir, action } = folderPicker;
    try {
      if (action === 'copy') {
        setCopyingId(fileId);
        await invoke('gdrive_copy_file', { accountId: account.id, fileId, destFolderId: destId, name: fileName });
      } else {
        setMovingId(fileId);
        const fromFolderId = isDir ? breadcrumbs[breadcrumbs.length - 1].id : folderId;
        await invoke('gdrive_move_file', { accountId: account.id, fileId, fromFolderId, toFolderId: destId });
        setFiles((p) => p.filter((f) => f.itemId !== fileId));
      }
      setFolderPicker(null);
    } finally { setCopyingId(null); setMovingId(null); }
  };

  const toggleSelect = (id: string) => setSelectedIds((prev) => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });
  const handleCheck = (idx: number, shiftHeld: boolean, deselect = false) => {
    if (shiftHeld && lastCheckedIdxRef.current !== null) {
      const lo = Math.min(lastCheckedIdxRef.current, idx);
      const hi = Math.max(lastCheckedIdxRef.current, idx);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        files.slice(lo, hi + 1).forEach((f) => deselect ? next.delete(f.itemId) : next.add(f.itemId));
        return next;
      });
    } else {
      toggleSelect(files[idx].itemId);
      lastCheckedIdxRef.current = idx;
    }
  };
  const handleTouchStart = (idx: number) => {
    longPressTriggeredRef.current = false;
    longPressRef.current = setTimeout(() => { longPressTriggeredRef.current = true; handleCheck(idx, true); }, 500);
  };
  const handleTouchEnd = () => { if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; } };
  const allSelected = files.length > 0 && files.every((f) => selectedIds.has(f.itemId));
  const someSelected = files.some((f) => selectedIds.has(f.itemId));
  const selectedHasDir = files.some((f) => selectedIds.has(f.itemId) && f.isDir);
  const toggleSelectAll = () => setSelectedIds(allSelected ? new Set() : new Set(files.map((f) => f.itemId)));

  const handleBulkDelete = async () => {
    if (!confirm(`Delete ${selectedIds.size} item(s)?`)) return;
    const ids = [...selectedIds]; setSelectedIds(new Set());
    for (const id of ids) {
      try {
        await invoke('gdrive_delete_file', { accountId: account.id, fileId: id });
        invoke('uncache_item', { accountId: account.id, itemId: id }).catch(() => {});
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    }
    void loadFolder(folderId, true, 0, search, sortBy, ascending);
  };
  const handleBulkPickerConfirm = async (destId: string) => {
    const action = bulkAction;
    const ids = [...selectedIds]; setSelectedIds(new Set());
    for (const id of ids) {
      const item = files.find((f) => f.itemId === id); if (!item) continue;
      try {
        if (action === 'copy') await invoke('gdrive_copy_file', { accountId: account.id, fileId: id, destFolderId: destId, name: item.name });
        else await invoke('gdrive_move_file', { accountId: account.id, fileId: id, fromFolderId: folderId, toFolderId: destId });
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    }
    setBulkAction(null);
    void loadFolder(folderId, true, 0, search, sortBy, ascending);
  };

  const sortBtn = (col: SortBy, label: string) => (
    <button
      onClick={() => handleSort(col)}
      className={`text-xs px-2 py-0.5 rounded transition-colors ${
        sortBy === col
          ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
          : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'
      }`}
    >
      {label}{sortBy === col ? (ascending ? ' ↑' : ' ↓') : ''}
    </button>
  );

  return (
    <>
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
        <div className="p-4 border-b border-gray-100 dark:border-gray-700 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">Google Drive</span>
            <span className="text-xs text-gray-400 dark:text-gray-500 truncate">{account.displayName ?? account.email}</span>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={handleNewFolder} disabled={creatingFolder || anyBusy} className="px-3 py-1 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors">
                {creatingFolder ? 'Creating…' : '+ New folder'}
              </button>
              <button onClick={handleUpload} disabled={anyBusy} className="px-3 py-1 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {uploadingId ? 'Uploading…' : 'Upload file'}
              </button>
              {cacheCleared && <span className="text-xs text-green-600 dark:text-green-400">✓ Cache cleared</span>}
              <div className="relative flex items-center">
                <button onClick={handleRefresh} disabled={loading} title="Refresh" className="px-2 py-1 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-l-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors border-r border-gray-200 dark:border-gray-600">↻</button>
                <button onClick={() => setMenuOpen((o) => !o)} disabled={loading} title="More options" className="px-1.5 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-r-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors">▾</button>
                {menuOpen && (
                  <Popover title="Options" onClose={() => setMenuOpen(false)} panelClassName="absolute right-0 top-full mt-1 min-w-max">
                    <div className="py-1">
                      <button onClick={handleHardRefresh} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">Hard refresh</button>
                      <button onClick={handleClearCache} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">Clear cached listing</button>
                    </div>
                  </Popover>
                )}
              </div>
              <button onClick={handleDisconnect} className="px-3 py-1 text-xs text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors">
                Disconnect
              </button>
            </div>
          </div>
          <form onSubmit={handleSearch} className="flex gap-2">
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search files…"
              className="flex-1 text-sm px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-700" />
            <button type="submit" className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">Search</button>
            {search && <button type="button" onClick={handleClearSearch} className="px-3 py-1.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-sm rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600">Clear</button>}
          </form>
          <div className="flex items-center justify-between">
            <nav className="flex items-center flex-wrap gap-1 text-sm text-gray-500 dark:text-gray-400">
              {breadcrumbs.map((c, i) => (
                <span key={c.id} className="flex items-center gap-1">
                  {i > 0 && <span className="text-gray-300 dark:text-gray-600">/</span>}
                  <button onClick={() => navigateTo(i)} className={i === breadcrumbs.length - 1 ? 'text-gray-800 dark:text-gray-200 font-medium' : 'hover:text-blue-600 dark:hover:text-blue-400'}>
                    {c.name}
                  </button>
                </span>
              ))}
            </nav>
            <div className="flex items-center gap-1">
              {files.length > 0 && (
                <input type="checkbox" checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                  onChange={toggleSelectAll}
                  className="w-4 h-4 mr-1 rounded accent-blue-600" title="Select all on this page" />
              )}
              {sortBtn('name', 'Name')}{sortBtn('size', 'Size')}{sortBtn('modified', 'Date')}
            </div>
          </div>
        </div>
        <div className="p-4 min-h-48">
          {selectedIds.size > 0 && (
            <div className="mb-3 flex items-center gap-3 px-3 py-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg text-sm">
              <span className="font-medium text-blue-700 dark:text-blue-300">{selectedIds.size} selected</span>
              <div className="flex gap-1 ml-auto">
                {!selectedHasDir && <button onClick={() => setBulkAction('copy')} className="px-2 py-1 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded transition-colors">Copy</button>}
                <button onClick={() => setBulkAction('move')} className="px-2 py-1 text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/30 rounded transition-colors">Move</button>
                <button onClick={handleBulkDelete} className="px-2 py-1 text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded transition-colors">Delete</button>
                <button onClick={() => setSelectedIds(new Set())} className="px-2 py-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors">✕</button>
              </div>
            </div>
          )}
          {loading && <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">Loading…</div>}
          {error && (
            <div className="mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 text-red-600 dark:text-red-400 rounded-lg text-sm flex items-start justify-between gap-2">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 dark:hover:text-red-300 shrink-0 leading-none">✕</button>
            </div>
          )}
          {!loading && !error && files.length === 0 && <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">This folder is empty</div>}
          {!loading && files.length > 0 && (
            <div className="divide-y divide-gray-300 dark:divide-gray-700 cursor-pointer">
              {files.map((item, idx) => {
                const activeOnThis = editingId === item.itemId || renamingId === item.itemId
                  || copyingId === item.itemId || movingId === item.itemId
                  || downloadingId === item.itemId || deletingId === item.itemId;
                return (
                  <div key={item.itemId}
                    className={`flex items-center gap-3 py-2 px-2 rounded-lg group cursor-pointer ${selectedIds.has(item.itemId) ? 'bg-blue-50 dark:bg-blue-900/20' : 'bg-white dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
                    onClick={(e) => { if ((e.target as HTMLElement).closest('button,input')) return; item.isDir ? openFolder(item) : onOpenFile(item); }}>
                    <input type="checkbox" checked={selectedIds.has(item.itemId)} onChange={() => {}}
                      onClick={(e) => { e.stopPropagation(); if (!longPressTriggeredRef.current) handleCheck(idx, e.shiftKey, e.shiftKey && selectedIds.has(item.itemId)); }}
                      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleCheck(idx, true, selectedIds.has(item.itemId)); }}
                      onTouchStart={() => handleTouchStart(idx)} onTouchEnd={handleTouchEnd} onTouchMove={handleTouchEnd}
                      className="w-4 h-4 shrink-0 rounded accent-blue-600" />
                    <span className="text-lg select-none w-7 text-center">{fileIcon(item)}</span>
                    <div className="flex-1 min-w-0">
                      <button onClick={() => item.isDir ? openFolder(item) : onOpenFile(item)}
                        className={`text-sm font-medium truncate block text-left w-full hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer ${item.isDir ? '' : 'text-gray-800 dark:text-gray-200'}`}>
                        {item.name}
                      </button>
                      <p className="text-xs text-gray-400 dark:text-gray-500">
                        {formatSize(item.size)}{item.size != null && item.modifiedMs != null && ' · '}
                        {item.modifiedMs != null && new Date(item.modifiedMs).toLocaleDateString()}
                      </p>
                    </div>
                    <div className={`flex gap-2 transition-opacity shrink-0 ${activeOnThis ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                      {!item.isDir && <button onClick={() => handleEdit(item)} disabled={anyBusy} className="text-xs text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300 disabled:opacity-50">{editingId === item.itemId ? 'Editing…' : 'Edit'}</button>}
                      <button onClick={() => handleRename(item)} disabled={anyBusy} className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-50">{renamingId === item.itemId ? 'Renaming…' : 'Rename'}</button>
                      {!item.isDir && <button onClick={() => setFolderPicker({ fileId: item.itemId, fileName: item.name, isDir: false, action: 'copy' })} disabled={anyBusy} className="text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 disabled:opacity-50">{copyingId === item.itemId ? 'Copying…' : 'Copy'}</button>}
                      <button onClick={() => setFolderPicker({ fileId: item.itemId, fileName: item.name, isDir: item.isDir, action: 'move' })} disabled={anyBusy} className="text-xs text-purple-600 dark:text-purple-400 hover:text-purple-800 dark:hover:text-purple-300 disabled:opacity-50">{movingId === item.itemId ? 'Moving…' : 'Move'}</button>
                      {!item.isDir && <button onClick={() => handleDownload(item)} disabled={anyBusy} className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-50">{downloadingId === item.itemId ? 'Downloading…' : 'Download'}</button>}
                      <button onClick={() => handleDelete(item)} disabled={anyBusy} className="text-xs text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-50">{deletingId === item.itemId ? 'Deleting…' : 'Delete'}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <PaginationBar page={page} total={total} pageSize={PAGE_SIZE} onPage={handlePage} />
      </div>

      {folderPicker && (
        <FolderPickerModal
          title={folderPicker.action === 'copy' ? 'Copy to…' : 'Move to…'}
          rootId="root" rootName="My Drive"
          onList={listDriveFolders}
          onConfirm={handleFolderPickerConfirm}
          onClose={() => setFolderPicker(null)}
        />
      )}
      {bulkAction && (
        <FolderPickerModal
          title={bulkAction === 'copy' ? `Copy ${selectedIds.size} item(s) to…` : `Move ${selectedIds.size} item(s) to…`}
          rootId="root" rootName="My Drive"
          onList={listDriveFolders}
          onConfirm={handleBulkPickerConfirm}
          onClose={() => setBulkAction(null)}
        />
      )}
    </>
  );
}
