import { useState, useEffect, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save, open } from '@tauri-apps/plugin-dialog';
import { deleteAccount } from '../lib/account-store';
import {
  downloadFile,
  uploadFile,
  createDirectory,
  trashFile,
  trashDirectory,
  renameFile,
  renameDirectory,
  moveFile,
  moveDirectory,
  copyFile,
  overwriteFile,
  hasSession,
  logout,
  listDirectory,
} from '../lib/filen-client';
import type { StoredAccount, CachedItem } from '../types';
import FolderPickerModal, { type FolderEntry } from './FolderPickerModal';

interface Props {
  account: StoredAccount;
  onDisconnect: () => void;
  onNeedsRelogin: () => void;
}

type SortBy = 'name' | 'size' | 'modified';

function fileIcon(item: CachedItem): string {
  if (item.isDir) return '📁';
  const mime = item.mimeType ?? '';
  const ext = item.name.split('.').pop()?.toLowerCase() ?? '';
  if (mime.startsWith('image/') || ['jpg','jpeg','png','gif','webp','svg','avif'].includes(ext)) return '🖼';
  if (mime.startsWith('video/') || ['mp4','mkv','avi','mov','webm'].includes(ext)) return '🎬';
  if (mime.startsWith('audio/') || ['mp3','wav','ogg','flac','m4a'].includes(ext)) return '🎵';
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

export default function FilenExplorer({ account, onDisconnect, onNeedsRelogin }: Props) {
  const rootUuid = (account.providerData as { baseFolderUuid?: string } | undefined)?.baseFolderUuid ?? '';
  const navKey = `notes-filen-nav-${account.id}`;

  const savedNav = useMemo(() => {
    try {
      const raw = localStorage.getItem(navKey);
      return raw ? JSON.parse(raw) as { uuid: string; breadcrumbs: { uuid: string; name: string }[] } : null;
    } catch { return null; }
  }, [navKey]);

  const [folderUUID, setFolderUUID] = useState(savedNav?.uuid ?? rootUuid);
  const [breadcrumbs, setBreadcrumbs] = useState(
    savedNav?.breadcrumbs ?? [{ uuid: rootUuid, name: 'My Filen' }],
  );
  const [items, setItems] = useState<CachedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('name');
  const [ascending, setAscending] = useState(true);
  const [busy, setBusy] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [folderPicker, setFolderPicker] = useState<{
    uuid: string; isDir: boolean; action: 'copy' | 'move';
  } | null>(null);

  const anyBusy = busy || !!downloadingId || !!deletingId || !!editingId
    || !!renamingId || !!copyingId || !!movingId;

  const queryCache = useCallback(
    async (uuid: string, sq: string, sb: SortBy, asc: boolean) => {
      const result = await invoke<CachedItem[]>('query_folder_items', {
        accountId: account.id, parentId: uuid,
        search: sq || null, sortBy: sb, ascending: asc,
      });
      setItems(result);
    },
    [account.id],
  );

  const fetchItems = useCallback(
    async (uuid: string, force = false) => {
      setLoading(true); setError(null); setSearch('');
      try {
        await invoke('list_folder', { accountId: account.id, parentId: uuid, force });
        await queryCache(uuid, '', sortBy, ascending);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [account.id, sortBy, ascending, queryCache],
  );

  useEffect(() => {
    hasSession(account.id).then((active) => {
      if (!active) {
        onNeedsRelogin();
      } else {
        fetchItems(folderUUID);
      }
    });
    // folderUUID is intentionally read once on mount (savedNav value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, fetchItems, onNeedsRelogin]);

  function navigate(uuid: string, crumbs: { uuid: string; name: string }[]) {
    setFolderUUID(uuid);
    setBreadcrumbs(crumbs);
    setSearch('');
    localStorage.setItem(navKey, JSON.stringify({ uuid, breadcrumbs: crumbs }));
    fetchItems(uuid);
  }

  function navigateTo(index: number) {
    navigate(breadcrumbs[index].uuid, breadcrumbs.slice(0, index + 1));
  }

  function openDir(item: CachedItem) {
    navigate(item.itemId, [...breadcrumbs, { uuid: item.itemId, name: item.name }]);
  }

  const handleSearch = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    try { await queryCache(folderUUID, search, sortBy, ascending); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const handleClearSearch = async () => {
    setSearch('');
    try { await queryCache(folderUUID, '', sortBy, ascending); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const handleSort = async (col: SortBy) => {
    const newAsc = col === sortBy ? !ascending : true;
    setSortBy(col); setAscending(newAsc);
    try { await queryCache(folderUUID, search, col, newAsc); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const handleDownload = async (item: CachedItem) => {
    const destPath = await save({ defaultPath: item.name });
    if (!destPath) return;
    setDownloadingId(item.itemId);
    try {
      await downloadFile(account.id, item.itemId, destPath);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setDownloadingId(null); }
  };

  const handleDelete = async (item: CachedItem) => {
    if (!confirm(`Move "${item.name}" to trash?`)) return;
    setDeletingId(item.itemId);
    try {
      if (item.isDir) {
        await trashDirectory(account.id, item.itemId);
      } else {
        await trashFile(account.id, item.itemId);
      }
      setItems((p) => p.filter((i) => i.itemId !== item.itemId));
      invoke('uncache_item', { accountId: account.id, itemId: item.itemId }).catch(() => {});
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setDeletingId(null); }
  };

  const handleEdit = async (item: CachedItem) => {
    const filePath = await open({ multiple: false, directory: false });
    if (!filePath || typeof filePath !== 'string') return;
    setEditingId(item.itemId);
    try {
      await overwriteFile(account.id, item.itemId, folderUUID, filePath);
      fetchItems(folderUUID, true);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setEditingId(null); }
  };

  const handleRename = async (item: CachedItem) => {
    const newName = prompt('New name:', item.name);
    if (!newName?.trim() || newName.trim() === item.name) return;
    setRenamingId(item.itemId);
    try {
      if (item.isDir) {
        await renameDirectory(account.id, item.itemId, newName.trim());
      } else {
        await renameFile(account.id, item.itemId, newName.trim());
      }
      setItems((p) => p.map((i) => i.itemId === item.itemId ? { ...i, name: newName.trim() } : i));
      invoke('rename_cached_item', { accountId: account.id, itemId: item.itemId, newName: newName.trim() }).catch(() => {});
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setRenamingId(null); }
  };

  const handleUpload = async () => {
    const filePath = await open({ multiple: false, directory: false });
    if (!filePath || typeof filePath !== 'string') return;
    setBusy(true);
    try {
      await uploadFile(account.id, folderUUID, filePath);
      fetchItems(folderUUID, true);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const handleNewFolder = async () => {
    const name = prompt('Folder name:');
    if (!name?.trim()) return;
    setCreatingFolder(true);
    try {
      await createDirectory(account.id, folderUUID, name.trim());
      fetchItems(folderUUID, true);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setCreatingFolder(false); }
  };

  const handleDisconnect = async () => {
    if (!confirm(`Disconnect ${account.email} from Filen?`)) return;
    logout(account.id);
    await deleteAccount(account.id);
    onDisconnect();
  };

  const listFoldersForPicker = async (uuid: string): Promise<FolderEntry[]> => {
    const all = await listDirectory(account.id, uuid);
    return all.filter((i) => i.type === 'directory').map((i) => ({ id: i.uuid, name: i.name }));
  };

  const handleFolderPickerConfirm = async (destUuid: string) => {
    if (!folderPicker) return;
    const { uuid, isDir, action } = folderPicker;
    try {
      if (action === 'copy') {
        setCopyingId(uuid);
        await copyFile(account.id, uuid, destUuid);
      } else if (isDir) {
        setMovingId(uuid);
        await moveDirectory(account.id, uuid, destUuid);
      } else {
        setMovingId(uuid);
        await moveFile(account.id, uuid, destUuid);
      }
      if (action === 'move') {
        setItems((p) => p.filter((i) => i.itemId !== uuid));
      }
      setFolderPicker(null);
    } finally { setCopyingId(null); setMovingId(null); }
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
            <span className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">Filen</span>
            <span className="text-xs text-gray-400 dark:text-gray-500 truncate">{account.email}</span>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={handleNewFolder} disabled={creatingFolder || anyBusy} className="px-3 py-1 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors">
                {creatingFolder ? 'Creating…' : '+ New folder'}
              </button>
              <button onClick={handleUpload} disabled={anyBusy} className="px-3 py-1 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {busy ? 'Working…' : 'Upload file'}
              </button>
              <button onClick={handleDisconnect} className="px-3 py-1 text-xs text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors">
                Disconnect
              </button>
            </div>
          </div>
          <form onSubmit={handleSearch} className="flex gap-2">
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search files…"
              className="flex-1 text-sm px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-700" />
            <button type="submit" className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">Search</button>
            {search && (
              <button type="button" onClick={handleClearSearch} className="px-3 py-1.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-sm rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600">
                Clear
              </button>
            )}
          </form>
          <div className="flex items-center justify-between">
            <nav className="flex items-center flex-wrap gap-1 text-sm text-gray-500 dark:text-gray-400">
              {breadcrumbs.map((c, i) => (
                <span key={c.uuid} className="flex items-center gap-1">
                  {i > 0 && <span className="text-gray-300 dark:text-gray-600">/</span>}
                  <button onClick={() => navigateTo(i)}
                    className={i === breadcrumbs.length - 1 ? 'text-gray-800 dark:text-gray-200 font-medium' : 'hover:text-blue-600 dark:hover:text-blue-400'}>
                    {c.name}
                  </button>
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
          {!loading && error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 text-red-600 dark:text-red-400 rounded-lg text-sm">{error}</div>
          )}
          {!loading && !error && items.length === 0 && (
            <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">This folder is empty</div>
          )}
          {!loading && !error && items.length > 0 && (
            <div className="divide-y divide-gray-50 dark:divide-gray-700">
              {items.map((item) => {
                const activeOnThis = editingId === item.itemId || renamingId === item.itemId
                  || copyingId === item.itemId || movingId === item.itemId
                  || downloadingId === item.itemId || deletingId === item.itemId;
                return (
                  <div key={item.itemId} className="flex items-center gap-3 py-2 px-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 group">
                    <span className="text-lg select-none w-7 text-center">{fileIcon(item)}</span>
                    <div className="flex-1 min-w-0">
                      <button onClick={() => item.isDir && openDir(item)} disabled={!item.isDir}
                        className={`text-sm font-medium truncate block text-left w-full ${item.isDir ? 'hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer' : 'cursor-default text-gray-800 dark:text-gray-200'}`}>
                        {item.name}
                      </button>
                      <p className="text-xs text-gray-400 dark:text-gray-500">
                        {formatSize(item.size)}{item.size != null && item.modifiedMs != null && ' · '}
                        {item.modifiedMs != null && new Date(item.modifiedMs).toLocaleDateString()}
                      </p>
                    </div>
                    <div className={`flex gap-2 transition-opacity shrink-0 ${activeOnThis ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                      {!item.isDir && (
                        <button onClick={() => handleEdit(item)} disabled={anyBusy} className="text-xs text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300 disabled:opacity-50">
                          {editingId === item.itemId ? 'Editing…' : 'Edit'}
                        </button>
                      )}
                      <button onClick={() => handleRename(item)} disabled={anyBusy} className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-50">
                        {renamingId === item.itemId ? 'Renaming…' : 'Rename'}
                      </button>
                      {!item.isDir && (
                        <button onClick={() => setFolderPicker({ uuid: item.itemId, isDir: false, action: 'copy' })} disabled={anyBusy} className="text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 disabled:opacity-50">
                          {copyingId === item.itemId ? 'Copying…' : 'Copy'}
                        </button>
                      )}
                      <button onClick={() => setFolderPicker({ uuid: item.itemId, isDir: item.isDir, action: 'move' })} disabled={anyBusy} className="text-xs text-purple-600 dark:text-purple-400 hover:text-purple-800 dark:hover:text-purple-300 disabled:opacity-50">
                        {movingId === item.itemId ? 'Moving…' : 'Move'}
                      </button>
                      {!item.isDir && (
                        <button onClick={() => handleDownload(item)} disabled={anyBusy} className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-50">
                          {downloadingId === item.itemId ? 'Downloading…' : 'Download'}
                        </button>
                      )}
                      <button onClick={() => handleDelete(item)} disabled={anyBusy} className="text-xs text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-50">
                        {deletingId === item.itemId ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {folderPicker && (
        <FolderPickerModal
          title={folderPicker.action === 'copy' ? 'Copy to…' : 'Move to…'}
          rootId={rootUuid}
          rootName="My Filen"
          onList={listFoldersForPicker}
          onConfirm={handleFolderPickerConfirm}
          onClose={() => setFolderPicker(null)}
        />
      )}
    </>
  );
}
