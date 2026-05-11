import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readFile, writeFile, remove, mkdir, rename as fsRename, copyFile as fsCopyFile } from '@tauri-apps/plugin-fs';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import type { StoredAccount, CachedItem, FolderPage } from '../types';
import { deleteAccount } from '../lib/account-store';
import PaginationBar from './PaginationBar';
import config from '../config.json';

const PAGE_SIZE = config.defaultListPageSize;

interface Props { account: StoredAccount; onDisconnect: () => void; }

type SortBy = 'name' | 'size' | 'modified';

function fileIcon(item: CachedItem): string {
  if (item.isDir) return '📁';
  const ext = item.name.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg','jpeg','png','gif','webp','svg','avif'].includes(ext)) return '🖼';
  if (['mp4','mkv','avi','mov','webm'].includes(ext)) return '🎬';
  if (['mp3','wav','ogg','flac','m4a','aac'].includes(ext)) return '🎵';
  if (ext === 'pdf') return '📄';
  if (['xls','xlsx','csv'].includes(ext)) return '📊';
  if (['ppt','pptx'].includes(ext)) return '📑';
  if (['doc','docx','txt','md'].includes(ext)) return '📝';
  return '📄';
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

const SEP = navigator.platform.startsWith('Win') ? '\\' : '/';

export default function FileSystemExplorer({ account, onDisconnect }: Props) {
  const rootPath = account.path ?? '';
  const navKey = `notes-fs-nav-${account.id}`;

  const savedNav = useMemo(() => {
    try {
      const raw = localStorage.getItem(navKey);
      return raw ? JSON.parse(raw) as {
        path: string;
        breadcrumbs: { name: string; path: string }[];
        page: number;
        search: string;
        sortBy: SortBy;
        ascending: boolean;
      } : null;
    } catch { return null; }
  }, [navKey]);

  const [currentPath, setCurrentPath] = useState(savedNav?.path ?? rootPath);
  const [breadcrumbs, setBreadcrumbs] = useState<{ name: string; path: string }[]>(
    savedNav?.breadcrumbs ?? [{ name: account.displayName ?? rootPath.split(/[\\/]/).pop() ?? rootPath, path: rootPath }],
  );
  const [entries, setEntries] = useState<CachedItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(savedNav?.search ?? '');
  const [sortBy, setSortBy] = useState<SortBy>(savedNav?.sortBy ?? 'name');
  const [ascending, setAscending] = useState(savedNav?.ascending ?? true);
  const [page, setPage] = useState(savedNav?.page ?? 0);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [copyingPath, setCopyingPath] = useState<string | null>(null);
  const [movingPath, setMovingPath] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cacheCleared, setCacheCleared] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const anyBusy = !!downloadingPath || !!deletingPath || !!editingPath || !!renamingPath
    || !!copyingPath || !!movingPath;

  // ── Persist state to localStorage whenever anything changes ──────────────────
  useEffect(() => {
    localStorage.setItem(navKey, JSON.stringify({ path: currentPath, breadcrumbs, page, search, sortBy, ascending }));
  }, [currentPath, breadcrumbs, page, search, sortBy, ascending, navKey]);

  // ── Query SQLite cache (no network call) ─────────────────────────────────────
  const queryCache = useCallback(async (
    path: string, sq: string, sb: SortBy, asc: boolean, pg: number,
  ) => {
    const result = await invoke<FolderPage>('query_folder_items', {
      accountId: account.id, parentId: path,
      search: sq || null, sortBy: sb, ascending: asc,
      page: pg, pageSize: PAGE_SIZE,
    });
    setEntries(result.items);
    setTotal(result.total);
  }, [account.id]);

  // ── Full folder load: disk read (if needed) + cache query ────────────────────
  const loadDir = useCallback(async (
    path: string, force: boolean, pg: number, sq: string, sb: SortBy, asc: boolean,
  ) => {
    setLoading(true); setError(null);
    try {
      await invoke('list_folder', { accountId: account.id, parentId: path, force });
      await queryCache(path, sq, sb, asc, pg);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to read directory');
    } finally {
      setLoading(false);
    }
  }, [account.id, queryCache]);

  // ── Initial mount: restore saved state ───────────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadDir(currentPath, false, page, search, sortBy, ascending); }, []);

  // ── Close split-button menu on outside click ─────────────────────────────────
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  // ── Navigation ───────────────────────────────────────────────────────────────
  function navigate(path: string, crumbs: { name: string; path: string }[]) {
    setCurrentPath(path); setBreadcrumbs(crumbs); setPage(0); setSearch('');
    void loadDir(path, false, 0, '', sortBy, ascending);
  }
  const openDir = (item: CachedItem) => {
    if (!item.isDir) return;
    navigate(item.itemId, [...breadcrumbs, { name: item.name, path: item.itemId }]);
  };
  const navigateTo = (i: number) => navigate(breadcrumbs[i].path, breadcrumbs.slice(0, i + 1));

  // ── Search / sort / page ─────────────────────────────────────────────────────
  const handleSearch = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault(); setPage(0);
    try { await queryCache(currentPath, search, sortBy, ascending, 0); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const handleClearSearch = async () => {
    setSearch(''); setPage(0);
    try { await queryCache(currentPath, '', sortBy, ascending, 0); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const handleSort = async (col: SortBy) => {
    const newAsc = col === sortBy ? !ascending : true;
    setSortBy(col); setAscending(newAsc); setPage(0);
    try { await queryCache(currentPath, search, col, newAsc, 0); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const handlePage = async (pg: number) => {
    setPage(pg);
    try { await queryCache(currentPath, search, sortBy, ascending, pg); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  // ── Refresh split-button handlers ────────────────────────────────────────────
  const handleRefresh = () => void loadDir(currentPath, false, page, search, sortBy, ascending);
  const handleHardRefresh = () => { setMenuOpen(false); void loadDir(currentPath, true, page, search, sortBy, ascending); };
  const handleClearCache = async () => {
    setMenuOpen(false);
    try {
      await invoke('invalidate_folder_cache', { accountId: account.id, parentId: currentPath });
      setCacheCleared(true);
      setTimeout(() => setCacheCleared(false), 2000);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  // ── File actions ─────────────────────────────────────────────────────────────
  const handleDownload = async (item: CachedItem) => {
    setDownloadingPath(item.itemId);
    try {
      const data = await readFile(item.itemId);
      const blob = new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = item.name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    } finally { setDownloadingPath(null); }
  };
  const handleDelete = async (item: CachedItem) => {
    if (!confirm(`Delete "${item.name}"?`)) return;
    setDeletingPath(item.itemId);
    try {
      await remove(item.itemId, { recursive: true });
      setEntries((p) => p.filter((e) => e.itemId !== item.itemId));
      invoke('uncache_item', { accountId: account.id, itemId: item.itemId }).catch(() => {});
    } catch (e) { alert(e instanceof Error ? e.message : 'Delete failed'); }
    finally { setDeletingPath(null); }
  };
  const handleEdit = async (item: CachedItem) => {
    const srcPath = await dialogOpen({ multiple: false, directory: false });
    if (!srcPath || typeof srcPath !== 'string') return;
    setEditingPath(item.itemId);
    try { const data = await readFile(srcPath); await writeFile(item.itemId, data); }
    catch (err) { alert(err instanceof Error ? err.message : 'Edit failed'); }
    finally { setEditingPath(null); }
  };
  const handleRename = async (item: CachedItem) => {
    const newName = prompt('New name:', item.name);
    if (!newName?.trim() || newName.trim() === item.name) return;
    const dir = item.itemId.substring(0, item.itemId.lastIndexOf(SEP));
    const newPath = `${dir}${SEP}${newName.trim()}`;
    setRenamingPath(item.itemId);
    try {
      await fsRename(item.itemId, newPath);
      void loadDir(currentPath, true, 0, search, sortBy, ascending);
    } catch (err) { alert(err instanceof Error ? err.message : 'Rename failed'); }
    finally { setRenamingPath(null); }
  };
  const handleCopy = async (item: CachedItem) => {
    const destDir = await dialogOpen({ multiple: false, directory: true });
    if (!destDir || typeof destDir !== 'string') return;
    setCopyingPath(item.itemId);
    try { await fsCopyFile(item.itemId, `${destDir}${SEP}${item.name}`); }
    catch (err) { alert(err instanceof Error ? err.message : 'Copy failed'); }
    finally { setCopyingPath(null); }
  };
  const handleMove = async (item: CachedItem) => {
    const destDir = await dialogOpen({ multiple: false, directory: true });
    if (!destDir || typeof destDir !== 'string') return;
    setMovingPath(item.itemId);
    try {
      await fsRename(item.itemId, `${destDir}${SEP}${item.name}`);
      setEntries((p) => p.filter((e) => e.itemId !== item.itemId));
    } catch (err) { alert(err instanceof Error ? err.message : 'Move failed'); }
    finally { setMovingPath(null); }
  };
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      await writeFile(`${currentPath}${SEP}${file.name}`, data);
      void loadDir(currentPath, true, 0, search, sortBy, ascending);
    } catch (err) { alert(err instanceof Error ? err.message : 'Upload failed'); }
    finally { if (fileInputRef.current) fileInputRef.current.value = ''; }
  };
  const handlePickAndUpload = async () => {
    const selected = await dialogOpen({ multiple: false, directory: false });
    if (!selected || typeof selected !== 'string') return;
    try {
      const name = selected.split(/[\\/]/).pop() ?? 'file';
      const data = await readFile(selected);
      await writeFile(`${currentPath}${SEP}${name}`, data);
      void loadDir(currentPath, true, 0, search, sortBy, ascending);
    } catch (err) { alert(err instanceof Error ? err.message : 'Upload failed'); }
  };
  const handleNewFolder = async () => {
    const name = prompt('Folder name:'); if (!name?.trim()) return;
    setCreatingFolder(true);
    try { await mkdir(`${currentPath}${SEP}${name.trim()}`); void loadDir(currentPath, true, 0, search, sortBy, ascending); }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed to create folder'); }
    finally { setCreatingFolder(false); }
  };
  const handleDisconnect = async () => {
    const ok = confirm(`Remove "${account.displayName ?? rootPath}" from connected storage?\n\nThis app will lose access immediately.`);
    if (!ok) return;
    await deleteAccount(account.id);
    onDisconnect();
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
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
      <div className="p-4 border-b border-gray-100 dark:border-gray-700 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">Local file system</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={handleNewFolder} disabled={creatingFolder} className="px-3 py-1 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors">{creatingFolder ? 'Creating…' : '+ New folder'}</button>
            <button onClick={handlePickAndUpload} className="px-3 py-1 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">Upload file</button>
            <input ref={fileInputRef} type="file" className="hidden" onChange={handleUpload} />
            {cacheCleared && <span className="text-xs text-green-600 dark:text-green-400">✓ Cache cleared</span>}
            <div ref={menuRef} className="relative flex items-center">
              <button onClick={handleRefresh} disabled={loading} title="Refresh" className="px-2 py-1 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-l-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors border-r border-gray-200 dark:border-gray-600">↻</button>
              <button onClick={() => setMenuOpen((o) => !o)} disabled={loading} title="More options" className="px-1.5 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-r-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors">▾</button>
              {menuOpen && (
                <div className="absolute right-0 top-full mt-1 z-10 min-w-max bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1">
                  <button onClick={handleHardRefresh} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">Hard refresh</button>
                  <button onClick={handleClearCache} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">Clear cached listing</button>
                </div>
              )}
            </div>
            <button onClick={handleDisconnect} className="px-3 py-1 text-xs text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors">Revoke & remove</button>
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
              <span key={c.path} className="flex items-center gap-1">
                {i > 0 && <span className="text-gray-300 dark:text-gray-600">/</span>}
                <button onClick={() => navigateTo(i)} className={i === breadcrumbs.length - 1 ? 'text-gray-800 dark:text-gray-200 font-medium' : 'hover:text-blue-600 dark:hover:text-blue-400'}>{c.name}</button>
              </span>
            ))}
          </nav>
          <div className="flex items-center gap-1">
            {sortBtn('name', 'Name')}{sortBtn('size', 'Size')}{sortBtn('modified', 'Date')}
          </div>
        </div>
      </div>
      <div className="p-4 min-h-48">
        {loading && <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">Loading…</div>}
        {error && (
          <div className="mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 text-red-600 dark:text-red-400 rounded-lg text-sm flex items-start justify-between gap-2">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 dark:hover:text-red-300 shrink-0 leading-none">✕</button>
          </div>
        )}
        {!loading && !error && entries.length === 0 && <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">This folder is empty</div>}
        {!loading && entries.length > 0 && (
          <div className="divide-y divide-gray-300 dark:divide-gray-700">
            {entries.map((item) => {
              const activeOnThis = editingPath === item.itemId || renamingPath === item.itemId
                || copyingPath === item.itemId || movingPath === item.itemId
                || downloadingPath === item.itemId || deletingPath === item.itemId;
              return (
                <div key={item.itemId} className="flex items-center gap-3 py-2 px-2 rounded-lg bg-white dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 group">
                  <span className="text-lg select-none w-7 text-center">{fileIcon(item)}</span>
                  <div className="flex-1 min-w-0">
                    <button onClick={() => openDir(item)} disabled={!item.isDir}
                      className={`text-sm font-medium truncate block text-left w-full ${item.isDir ? 'hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer' : 'cursor-default text-gray-800 dark:text-gray-200'}`}>
                      {item.name}
                    </button>
                    <p className="text-xs text-gray-400 dark:text-gray-500">
                      {formatSize(item.size)}{item.size != null && item.modifiedMs != null && ' · '}
                      {item.modifiedMs != null && new Date(item.modifiedMs).toLocaleDateString()}
                    </p>
                  </div>
                  <div className={`flex gap-2 transition-opacity shrink-0 ${activeOnThis ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                    {!item.isDir && <button onClick={() => handleEdit(item)} disabled={anyBusy} className="text-xs text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300 disabled:opacity-50">{editingPath === item.itemId ? 'Editing…' : 'Edit'}</button>}
                    <button onClick={() => handleRename(item)} disabled={anyBusy} className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-50">{renamingPath === item.itemId ? 'Renaming…' : 'Rename'}</button>
                    {!item.isDir && <button onClick={() => handleCopy(item)} disabled={anyBusy} className="text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 disabled:opacity-50">{copyingPath === item.itemId ? 'Copying…' : 'Copy'}</button>}
                    <button onClick={() => handleMove(item)} disabled={anyBusy} className="text-xs text-purple-600 dark:text-purple-400 hover:text-purple-800 dark:hover:text-purple-300 disabled:opacity-50">{movingPath === item.itemId ? 'Moving…' : 'Move'}</button>
                    {!item.isDir && <button onClick={() => handleDownload(item)} disabled={anyBusy} className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-50">{downloadingPath === item.itemId ? 'Downloading…' : 'Download'}</button>}
                    <button onClick={() => handleDelete(item)} disabled={anyBusy} className="text-xs text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-50">{deletingPath === item.itemId ? 'Deleting…' : 'Delete'}</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <PaginationBar page={page} total={total} pageSize={PAGE_SIZE} onPage={handlePage} />
    </div>
  );
}
