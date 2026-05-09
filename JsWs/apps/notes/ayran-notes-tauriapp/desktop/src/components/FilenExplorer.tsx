import { useState, useEffect, useCallback, useMemo } from 'react';
import { save, open } from '@tauri-apps/plugin-dialog';
import { deleteAccount } from '../lib/account-store';
import {
  listDirectory,
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
  type FilenItem,
} from '../lib/filen-client';
import type { StoredAccount } from '../types';
import FolderPickerModal, { type FolderEntry } from './FolderPickerModal';

interface Props {
  account: StoredAccount;
  onDisconnect: () => void;
  onNeedsRelogin: () => void;
}

function fileIcon(item: FilenItem): string {
  if (item.type === 'directory') return '📁';
  const mime = item.mime ?? '';
  const ext = item.name.split('.').pop()?.toLowerCase() ?? '';
  if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif'].includes(ext)) return '🖼';
  if (mime.startsWith('video/') || ['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext)) return '🎬';
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return '🎵';
  if (ext === 'pdf') return '📄';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  if (['ppt', 'pptx'].includes(ext)) return '📑';
  if (['doc', 'docx', 'txt', 'md'].includes(ext)) return '📝';
  return '📄';
}

function formatSize(bytes: number): string {
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
  const [items, setItems] = useState<FilenItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [folderPicker, setFolderPicker] = useState<{
    uuid: string;
    isDir: boolean;
    action: 'copy' | 'move';
  } | null>(null);

  const anyBusy = busy || !!downloadingId || !!deletingId || !!editingId || !!renamingId || !!copyingId || !!movingId;

  const fetchItems = useCallback(
    async (uuid: string, query?: string) => {
      setLoading(true);
      setError(null);
      try {
        let list = await listDirectory(account.id, uuid);
        if (query) list = list.filter((i) => i.name.toLowerCase().includes(query.toLowerCase()));
        setItems(list);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [account.id],
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

  function openDir(item: FilenItem) {
    navigate(item.uuid, [...breadcrumbs, { uuid: item.uuid, name: item.name }]);
  }

  const handleSearch = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    fetchItems(folderUUID, search || undefined);
  };

  const handleDownload = async (item: FilenItem) => {
    const destPath = await save({ defaultPath: item.name });
    if (!destPath) return;
    setDownloadingId(item.uuid);
    try {
      await downloadFile(account.id, item.uuid, destPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDelete = async (item: FilenItem) => {
    if (!confirm(`Move "${item.name}" to trash?`)) return;
    setDeletingId(item.uuid);
    try {
      if (item.type === 'directory') {
        await trashDirectory(account.id, item.uuid);
      } else {
        await trashFile(account.id, item.uuid);
      }
      setItems((p) => p.filter((i) => i.uuid !== item.uuid));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingId(null);
    }
  };

  const handleEdit = async (item: FilenItem) => {
    const filePath = await open({ multiple: false, directory: false });
    if (!filePath || typeof filePath !== 'string') return;
    setEditingId(item.uuid);
    try {
      await overwriteFile(account.id, item.uuid, folderUUID, filePath);
      fetchItems(folderUUID);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEditingId(null);
    }
  };

  const handleRename = async (item: FilenItem) => {
    const newName = prompt('New name:', item.name);
    if (!newName?.trim() || newName.trim() === item.name) return;
    setRenamingId(item.uuid);
    try {
      if (item.type === 'directory') {
        await renameDirectory(account.id, item.uuid, newName.trim());
      } else {
        await renameFile(account.id, item.uuid, newName.trim());
      }
      setItems((p) => p.map((i) => i.uuid === item.uuid ? { ...i, name: newName.trim() } : i));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRenamingId(null);
    }
  };

  const handleUpload = async () => {
    const filePath = await open({ multiple: false, directory: false });
    if (!filePath || typeof filePath !== 'string') return;
    setBusy(true);
    try {
      await uploadFile(account.id, folderUUID, filePath);
      fetchItems(folderUUID);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleNewFolder = async () => {
    const name = prompt('Folder name:');
    if (!name?.trim()) return;
    setCreatingFolder(true);
    try {
      await createDirectory(account.id, folderUUID, name.trim());
      fetchItems(folderUUID);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm(`Disconnect ${account.email} from Filen?`)) return;
    logout(account.id);
    await deleteAccount(account.id);
    onDisconnect();
  };

  const listFoldersForPicker = async (uuid: string): Promise<FolderEntry[]> => {
    const all = await listDirectory(account.id, uuid);
    return all
      .filter((i) => i.type === 'directory')
      .map((i) => ({ id: i.uuid, name: i.name }));
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
        setItems((p) => p.filter((i) => i.uuid !== uuid));
      }
      setFolderPicker(null);
    } finally {
      setCopyingId(null);
      setMovingId(null);
    }
  };

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
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search files…"
              className="flex-1 text-sm px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-700"
            />
            <button type="submit" className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">Search</button>
            {search && (
              <button type="button" onClick={() => { setSearch(''); fetchItems(folderUUID); }} className="px-3 py-1.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-sm rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600">
                Clear
              </button>
            )}
          </form>
          <nav className="flex items-center flex-wrap gap-1 text-sm text-gray-500 dark:text-gray-400">
            {breadcrumbs.map((c, i) => (
              <span key={c.uuid} className="flex items-center gap-1">
                {i > 0 && <span className="text-gray-300 dark:text-gray-600">/</span>}
                <button
                  onClick={() => navigateTo(i)}
                  className={i === breadcrumbs.length - 1 ? 'text-gray-800 dark:text-gray-200 font-medium' : 'hover:text-blue-600 dark:hover:text-blue-400'}
                >
                  {c.name}
                </button>
              </span>
            ))}
          </nav>
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
                const activeOnThis = editingId === item.uuid || renamingId === item.uuid || copyingId === item.uuid || movingId === item.uuid || downloadingId === item.uuid || deletingId === item.uuid;
                return (
                  <div key={item.uuid} className="flex items-center gap-3 py-2 px-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 group">
                    <span className="text-lg select-none w-7 text-center">{fileIcon(item)}</span>
                    <div className="flex-1 min-w-0">
                      <button
                        onClick={() => item.type === 'directory' && openDir(item)}
                        disabled={item.type !== 'directory'}
                        className={`text-sm font-medium truncate block text-left w-full ${item.type === 'directory' ? 'hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer' : 'cursor-default text-gray-800 dark:text-gray-200'}`}
                      >
                        {item.name}
                      </button>
                      <p className="text-xs text-gray-400 dark:text-gray-500">
                        {item.type === 'file' && item.size != null && formatSize(item.size)}
                        {item.type === 'file' && item.size != null && item.lastModified ? ' · ' : ''}
                        {item.lastModified ? new Date(item.lastModified).toLocaleDateString() : ''}
                      </p>
                    </div>
                    <div className={`flex gap-2 transition-opacity shrink-0 ${activeOnThis ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                      {item.type === 'file' && (
                        <button onClick={() => handleEdit(item)} disabled={anyBusy} className="text-xs text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300 disabled:opacity-50">
                          {editingId === item.uuid ? 'Editing…' : 'Edit'}
                        </button>
                      )}
                      <button onClick={() => handleRename(item)} disabled={anyBusy} className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-50">
                        {renamingId === item.uuid ? 'Renaming…' : 'Rename'}
                      </button>
                      {item.type === 'file' && (
                        <button onClick={() => setFolderPicker({ uuid: item.uuid, isDir: false, action: 'copy' })} disabled={anyBusy} className="text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 disabled:opacity-50">
                          {copyingId === item.uuid ? 'Copying…' : 'Copy'}
                        </button>
                      )}
                      <button onClick={() => setFolderPicker({ uuid: item.uuid, isDir: item.type === 'directory', action: 'move' })} disabled={anyBusy} className="text-xs text-purple-600 dark:text-purple-400 hover:text-purple-800 dark:hover:text-purple-300 disabled:opacity-50">
                        {movingId === item.uuid ? 'Moving…' : 'Move'}
                      </button>
                      {item.type === 'file' && (
                        <button onClick={() => handleDownload(item)} disabled={anyBusy} className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-50">
                          {downloadingId === item.uuid ? 'Downloading…' : 'Download'}
                        </button>
                      )}
                      <button onClick={() => handleDelete(item)} disabled={anyBusy} className="text-xs text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-50">
                        {deletingId === item.uuid ? 'Deleting…' : 'Delete'}
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
