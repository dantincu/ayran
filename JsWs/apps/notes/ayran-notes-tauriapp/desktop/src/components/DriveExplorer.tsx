import { useState, useEffect, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save, open as dialogOpen } from '@tauri-apps/plugin-dialog';
import type { StoredAccount } from '../types';
import { deleteAccount } from '../lib/account-store';
import FolderPickerModal, { type FolderEntry } from './FolderPickerModal';

interface DriveFile {
  id: string; name: string; mimeType: string; size?: string; modifiedTime?: string;
}

interface Props {
  account: StoredAccount;
  onDisconnect: () => void;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

function fileIcon(mimeType: string): string {
  if (mimeType === FOLDER_MIME) return '📁';
  if (mimeType.startsWith('image/')) return '🖼';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType.startsWith('audio/')) return '🎵';
  if (mimeType.includes('pdf')) return '📄';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return '📊';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '📑';
  if (mimeType.includes('document') || mimeType.includes('word')) return '📝';
  return '📄';
}

function formatSize(size?: string): string {
  if (!size) return '';
  const n = parseInt(size);
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export default function DriveExplorer({ account, onDisconnect }: Props) {
  const navKey = `csdrive-drive-nav-${account.id}`;

  const savedNav = useMemo(() => {
    try {
      const raw = localStorage.getItem(navKey);
      return raw ? JSON.parse(raw) as { id: string; breadcrumbs: { id: string; name: string }[] } : null;
    } catch { return null; }
  }, [navKey]);

  const [folderId, setFolderId] = useState(savedNav?.id ?? 'root');
  const [breadcrumbs, setBreadcrumbs] = useState(
    savedNav?.breadcrumbs ?? [{ id: 'root', name: 'My Drive' }],
  );
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [folderPicker, setFolderPicker] = useState<{
    fileId: string;
    fileName: string;
    isDir: boolean;
    action: 'copy' | 'move';
  } | null>(null);

  const anyBusy = !!uploadingId || !!downloadingId || !!deletingId || !!editingId || !!renamingId || !!copyingId || !!movingId;

  const fetchFiles = useCallback(async (folder: string, query?: string) => {
    setLoading(true); setError(null);
    try {
      const list = await invoke<DriveFile[]>('gdrive_list_files', {
        accountId: account.id,
        folderId: folder,
        query: query ?? null,
      });
      setFiles(list);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [account.id]);

  useEffect(() => { fetchFiles(folderId); setSearch(''); }, [folderId, fetchFiles]);

  function navigate(id: string, crumbs: { id: string; name: string }[]) {
    setFolderId(id);
    setBreadcrumbs(crumbs);
    setSearch('');
    localStorage.setItem(navKey, JSON.stringify({ id, breadcrumbs: crumbs }));
  }

  const openFolder = (f: DriveFile) => {
    if (f.mimeType !== FOLDER_MIME) return;
    navigate(f.id, [...breadcrumbs, { id: f.id, name: f.name }]);
  };

  const navigateTo = (i: number) => navigate(breadcrumbs[i].id, breadcrumbs.slice(0, i + 1));

  const handleSearch = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault(); fetchFiles(folderId, search || undefined);
  };

  const handleDownload = async (file: DriveFile) => {
    const destPath = await save({ defaultPath: file.name });
    if (!destPath) return;
    setDownloadingId(file.id);
    try {
      await invoke('gdrive_download_file', { accountId: account.id, fileId: file.id, destPath });
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDelete = async (file: DriveFile) => {
    if (!confirm(`Delete "${file.name}"?`)) return;
    setDeletingId(file.id);
    try {
      await invoke('gdrive_delete_file', { accountId: account.id, fileId: file.id });
      setFiles((p) => p.filter((f) => f.id !== file.id));
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingId(null);
    }
  };

  const handleEdit = async (file: DriveFile) => {
    const filePath = await dialogOpen({ multiple: false, directory: false });
    if (!filePath || typeof filePath !== 'string') return;
    setEditingId(file.id);
    try {
      await invoke('gdrive_edit_file', { accountId: account.id, fileId: file.id, filePath });
      fetchFiles(folderId);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setEditingId(null);
    }
  };

  const handleRename = async (file: DriveFile) => {
    const newName = prompt('New name:', file.name);
    if (!newName?.trim() || newName.trim() === file.name) return;
    setRenamingId(file.id);
    try {
      await invoke('gdrive_rename', { accountId: account.id, fileId: file.id, newName: newName.trim() });
      setFiles((p) => p.map((f) => f.id === file.id ? { ...f, name: newName.trim() } : f));
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setRenamingId(null);
    }
  };

  const handleUpload = async () => {
    const filePath = await dialogOpen({ multiple: false, directory: false });
    if (!filePath || typeof filePath !== 'string') return;
    setUploadingId('__upload__');
    try {
      await invoke('gdrive_upload_file', { accountId: account.id, folderId, filePath });
      fetchFiles(folderId);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setUploadingId(null);
    }
  };

  const handleNewFolder = async () => {
    const name = prompt('Folder name:'); if (!name?.trim()) return;
    setCreatingFolder(true);
    try {
      await invoke('gdrive_create_folder', { accountId: account.id, parentId: folderId, name: name.trim() });
      fetchFiles(folderId);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm(`Disconnect ${account.displayName ?? account.email} from Google Drive?`)) return;
    await deleteAccount(account.id);
    onDisconnect();
  };

  const listDriveFolders = async (id: string): Promise<FolderEntry[]> => {
    const list = await invoke<DriveFile[]>('gdrive_list_files', {
      accountId: account.id,
      folderId: id,
      query: null,
    });
    return list
      .filter((f) => f.mimeType === FOLDER_MIME)
      .map((f) => ({ id: f.id, name: f.name }));
  };

  const handleFolderPickerConfirm = async (destId: string) => {
    if (!folderPicker) return;
    const { fileId, fileName, isDir, action } = folderPicker;
    try {
      if (action === 'copy') {
        setCopyingId(fileId);
        await invoke('gdrive_copy_file', {
          accountId: account.id, fileId, destFolderId: destId, name: fileName,
        });
      } else {
        setMovingId(fileId);
        const fromFolderId = isDir ? breadcrumbs[breadcrumbs.length - 1].id : folderId;
        await invoke('gdrive_move_file', {
          accountId: account.id, fileId, fromFolderId, toFolderId: destId,
        });
        setFiles((p) => p.filter((f) => f.id !== fileId));
      }
      setFolderPicker(null);
    } finally {
      setCopyingId(null);
      setMovingId(null);
    }
  };

  const isUploading = uploadingId !== null;

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
                {isUploading ? 'Uploading…' : 'Upload file'}
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
            {search && <button type="button" onClick={() => { setSearch(''); fetchFiles(folderId); }} className="px-3 py-1.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-sm rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600">Clear</button>}
          </form>
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
        </div>
        <div className="p-4 min-h-48">
          {loading && <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">Loading…</div>}
          {!loading && error && <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 text-red-600 dark:text-red-400 rounded-lg text-sm">{error}</div>}
          {!loading && !error && files.length === 0 && <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">This folder is empty</div>}
          {!loading && !error && files.length > 0 && (
            <div className="divide-y divide-gray-50 dark:divide-gray-700">
              {files.map((file) => {
                const isFolder = file.mimeType === FOLDER_MIME;
                const activeOnThis = editingId === file.id || renamingId === file.id || copyingId === file.id || movingId === file.id || downloadingId === file.id || deletingId === file.id;
                return (
                  <div key={file.id} className="flex items-center gap-3 py-2 px-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 group">
                    <span className="text-lg select-none w-7 text-center">{fileIcon(file.mimeType)}</span>
                    <div className="flex-1 min-w-0">
                      <button onClick={() => openFolder(file)} disabled={!isFolder}
                        className={`text-sm font-medium truncate block text-left w-full ${isFolder ? 'hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer' : 'cursor-default text-gray-800 dark:text-gray-200'}`}>
                        {file.name}
                      </button>
                      <p className="text-xs text-gray-400 dark:text-gray-500">
                        {formatSize(file.size)}{file.size && file.modifiedTime && ' · '}
                        {file.modifiedTime && new Date(file.modifiedTime).toLocaleDateString()}
                      </p>
                    </div>
                    <div className={`flex gap-2 transition-opacity shrink-0 ${activeOnThis ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                      {!isFolder && (
                        <button onClick={() => handleEdit(file)} disabled={anyBusy} className="text-xs text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300 disabled:opacity-50">
                          {editingId === file.id ? 'Editing…' : 'Edit'}
                        </button>
                      )}
                      <button onClick={() => handleRename(file)} disabled={anyBusy} className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-50">
                        {renamingId === file.id ? 'Renaming…' : 'Rename'}
                      </button>
                      {!isFolder && (
                        <button onClick={() => setFolderPicker({ fileId: file.id, fileName: file.name, isDir: false, action: 'copy' })} disabled={anyBusy} className="text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 disabled:opacity-50">
                          {copyingId === file.id ? 'Copying…' : 'Copy'}
                        </button>
                      )}
                      <button onClick={() => setFolderPicker({ fileId: file.id, fileName: file.name, isDir: isFolder, action: 'move' })} disabled={anyBusy} className="text-xs text-purple-600 dark:text-purple-400 hover:text-purple-800 dark:hover:text-purple-300 disabled:opacity-50">
                        {movingId === file.id ? 'Moving…' : 'Move'}
                      </button>
                      {!isFolder && (
                        <button onClick={() => handleDownload(file)} disabled={anyBusy} className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-50">
                          {downloadingId === file.id ? 'Downloading…' : 'Download'}
                        </button>
                      )}
                      <button onClick={() => handleDelete(file)} disabled={anyBusy} className="text-xs text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-50">
                        {deletingId === file.id ? 'Deleting…' : 'Delete'}
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
          rootId="root"
          rootName="My Drive"
          onList={listDriveFolders}
          onConfirm={handleFolderPickerConfirm}
          onClose={() => setFolderPicker(null)}
        />
      )}
    </>
  );
}
