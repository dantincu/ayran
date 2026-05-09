import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { readDir, readFile, writeFile, remove, mkdir, rename as fsRename, copyFile as fsCopyFile } from '@tauri-apps/plugin-fs';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import type { StoredAccount } from '../types';
import { deleteAccount } from '../lib/account-store';

interface FsEntry { name: string; isDirectory: boolean; path: string; }

interface Props { account: StoredAccount; onDisconnect: () => void; }

function fileIcon(name: string, isDirectory: boolean): string {
  if (isDirectory) return '📁';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg','jpeg','png','gif','webp','svg','avif'].includes(ext)) return '🖼';
  if (['mp4','mkv','avi','mov','webm'].includes(ext)) return '🎬';
  if (['mp3','wav','ogg','flac','m4a','aac'].includes(ext)) return '🎵';
  if (ext === 'pdf') return '📄';
  if (['xls','xlsx','csv'].includes(ext)) return '📊';
  if (['ppt','pptx'].includes(ext)) return '📑';
  if (['doc','docx','txt','md'].includes(ext)) return '📝';
  return '📄';
}

const SEP = navigator.platform.startsWith('Win') ? '\\' : '/';

export default function FileSystemExplorer({ account, onDisconnect }: Props) {
  const rootPath = account.path ?? '';
  const navKey = `notes-fs-nav-${account.id}`;

  const savedNav = useMemo(() => {
    try {
      const raw = localStorage.getItem(navKey);
      return raw ? JSON.parse(raw) as { path: string; breadcrumbs: { name: string; path: string }[] } : null;
    } catch { return null; }
  }, [navKey]);

  const [currentPath, setCurrentPath] = useState(savedNav?.path ?? rootPath);
  const [breadcrumbs, setBreadcrumbs] = useState<{ name: string; path: string }[]>(
    savedNav?.breadcrumbs ?? [
      { name: account.displayName ?? rootPath.split(/[\\/]/).pop() ?? rootPath, path: rootPath },
    ],
  );
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [copyingPath, setCopyingPath] = useState<string | null>(null);
  const [movingPath, setMovingPath] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const anyBusy = !!downloadingPath || !!deletingPath || !!editingPath || !!renamingPath || !!copyingPath || !!movingPath;

  const loadDir = useCallback(async (path: string, query?: string) => {
    setLoading(true); setError(null);
    try {
      const raw = await readDir(path);
      let list: FsEntry[] = raw
        .filter((e) => e.name != null)
        .map((e) => ({ name: e.name!, isDirectory: e.isDirectory, path: `${path}${SEP}${e.name!}` }));
      if (query) list = list.filter((e) => e.name.toLowerCase().includes(query.toLowerCase()));
      list.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(list);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to read directory'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadDir(currentPath); setSearch(''); }, [currentPath, loadDir]);

  function navigate(path: string, crumbs: { name: string; path: string }[]) {
    setCurrentPath(path);
    setBreadcrumbs(crumbs);
    setSearch('');
    localStorage.setItem(navKey, JSON.stringify({ path, breadcrumbs: crumbs }));
  }

  const openDir = (entry: FsEntry) => {
    if (!entry.isDirectory) return;
    navigate(entry.path, [...breadcrumbs, { name: entry.name, path: entry.path }]);
  };

  const navigateTo = (i: number) => {
    navigate(breadcrumbs[i].path, breadcrumbs.slice(0, i + 1));
  };

  const handleSearch = (e: React.SyntheticEvent<HTMLFormElement>) => { e.preventDefault(); loadDir(currentPath, search || undefined); };

  const handleDownload = async (entry: FsEntry) => {
    setDownloadingPath(entry.path);
    try {
      const data = await readFile(entry.path);
      const blob = new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = entry.name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    } finally {
      setDownloadingPath(null);
    }
  };

  const handleDelete = async (entry: FsEntry) => {
    if (!confirm(`Delete "${entry.name}"?`)) return;
    setDeletingPath(entry.path);
    try {
      await remove(entry.path, { recursive: true });
      setEntries((p) => p.filter((e) => e.path !== entry.path));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeletingPath(null);
    }
  };

  const handleEdit = async (entry: FsEntry) => {
    const srcPath = await dialogOpen({ multiple: false, directory: false });
    if (!srcPath || typeof srcPath !== 'string') return;
    setEditingPath(entry.path);
    try {
      const data = await readFile(srcPath);
      await writeFile(entry.path, data);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Edit failed');
    } finally {
      setEditingPath(null);
    }
  };

  const handleRename = async (entry: FsEntry) => {
    const newName = prompt('New name:', entry.name);
    if (!newName?.trim() || newName.trim() === entry.name) return;
    const dir = entry.path.substring(0, entry.path.lastIndexOf(SEP));
    const newPath = `${dir}${SEP}${newName.trim()}`;
    setRenamingPath(entry.path);
    try {
      await fsRename(entry.path, newPath);
      setEntries((p) => p.map((e) => e.path === entry.path
        ? { ...e, name: newName.trim(), path: newPath }
        : e,
      ));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Rename failed');
    } finally {
      setRenamingPath(null);
    }
  };

  const handleCopy = async (entry: FsEntry) => {
    const destDir = await dialogOpen({ multiple: false, directory: true });
    if (!destDir || typeof destDir !== 'string') return;
    setCopyingPath(entry.path);
    try {
      await fsCopyFile(entry.path, `${destDir}${SEP}${entry.name}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Copy failed');
    } finally {
      setCopyingPath(null);
    }
  };

  const handleMove = async (entry: FsEntry) => {
    const destDir = await dialogOpen({ multiple: false, directory: true });
    if (!destDir || typeof destDir !== 'string') return;
    setMovingPath(entry.path);
    try {
      const destPath = `${destDir}${SEP}${entry.name}`;
      await fsRename(entry.path, destPath);
      setEntries((p) => p.filter((e) => e.path !== entry.path));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Move failed');
    } finally {
      setMovingPath(null);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      await writeFile(`${currentPath}${SEP}${file.name}`, data);
      loadDir(currentPath);
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
      loadDir(currentPath);
    } catch (err) { alert(err instanceof Error ? err.message : 'Upload failed'); }
  };

  const handleNewFolder = async () => {
    const name = prompt('Folder name:'); if (!name?.trim()) return;
    setCreatingFolder(true);
    try { await mkdir(`${currentPath}${SEP}${name.trim()}`); loadDir(currentPath); }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed to create folder'); }
    finally { setCreatingFolder(false); }
  };

  const handleDisconnect = async () => {
    const ok = confirm(`Remove "${account.displayName ?? rootPath}" from connected storage?\n\nThis app will lose access immediately.`);
    if (!ok) return;
    await deleteAccount(account.id);
    onDisconnect();
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
      <div className="p-4 border-b border-gray-100 dark:border-gray-700 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">Local file system</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={handleNewFolder} disabled={creatingFolder} className="px-3 py-1 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors">{creatingFolder ? 'Creating…' : '+ New folder'}</button>
            <button onClick={handlePickAndUpload} className="px-3 py-1 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">Upload file</button>
            <input ref={fileInputRef} type="file" className="hidden" onChange={handleUpload} />
            <button onClick={handleDisconnect} className="px-3 py-1 text-xs text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors">Revoke & remove</button>
          </div>
        </div>
        <form onSubmit={handleSearch} className="flex gap-2">
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search files…"
            className="flex-1 text-sm px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-700" />
          <button type="submit" className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">Search</button>
          {search && <button type="button" onClick={() => { setSearch(''); loadDir(currentPath); }} className="px-3 py-1.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-sm rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600">Clear</button>}
        </form>
        <nav className="flex items-center flex-wrap gap-1 text-sm text-gray-500 dark:text-gray-400">
          {breadcrumbs.map((c, i) => (
            <span key={c.path} className="flex items-center gap-1">
              {i > 0 && <span className="text-gray-300 dark:text-gray-600">/</span>}
              <button onClick={() => navigateTo(i)} className={i === breadcrumbs.length - 1 ? 'text-gray-800 dark:text-gray-200 font-medium' : 'hover:text-blue-600 dark:hover:text-blue-400'}>{c.name}</button>
            </span>
          ))}
        </nav>
      </div>
      <div className="p-4 min-h-48">
        {loading && <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">Loading…</div>}
        {!loading && error && <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 text-red-600 dark:text-red-400 rounded-lg text-sm">{error}</div>}
        {!loading && !error && entries.length === 0 && <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">This folder is empty</div>}
        {!loading && !error && entries.length > 0 && (
          <div className="divide-y divide-gray-50 dark:divide-gray-700">
            {entries.map((entry) => {
              const activeOnThis = editingPath === entry.path || renamingPath === entry.path || copyingPath === entry.path || movingPath === entry.path || downloadingPath === entry.path || deletingPath === entry.path;
              return (
                <div key={entry.path} className="flex items-center gap-3 py-2 px-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 group">
                  <span className="text-lg select-none w-7 text-center">{fileIcon(entry.name, entry.isDirectory)}</span>
                  <div className="flex-1 min-w-0">
                    <button onClick={() => openDir(entry)} disabled={!entry.isDirectory}
                      className={`text-sm font-medium truncate block text-left w-full ${entry.isDirectory ? 'hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer' : 'cursor-default text-gray-800 dark:text-gray-200'}`}>
                      {entry.name}
                    </button>
                  </div>
                  <div className={`flex gap-2 transition-opacity shrink-0 ${activeOnThis ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                    {!entry.isDirectory && (
                      <button onClick={() => handleEdit(entry)} disabled={anyBusy} className="text-xs text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300 disabled:opacity-50">
                        {editingPath === entry.path ? 'Editing…' : 'Edit'}
                      </button>
                    )}
                    <button onClick={() => handleRename(entry)} disabled={anyBusy} className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-50">
                      {renamingPath === entry.path ? 'Renaming…' : 'Rename'}
                    </button>
                    {!entry.isDirectory && (
                      <button onClick={() => handleCopy(entry)} disabled={anyBusy} className="text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 disabled:opacity-50">
                        {copyingPath === entry.path ? 'Copying…' : 'Copy'}
                      </button>
                    )}
                    <button onClick={() => handleMove(entry)} disabled={anyBusy} className="text-xs text-purple-600 dark:text-purple-400 hover:text-purple-800 dark:hover:text-purple-300 disabled:opacity-50">
                      {movingPath === entry.path ? 'Moving…' : 'Move'}
                    </button>
                    {!entry.isDirectory && (
                      <button onClick={() => handleDownload(entry)} disabled={anyBusy} className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-50">
                        {downloadingPath === entry.path ? 'Downloading…' : 'Download'}
                      </button>
                    )}
                    <button onClick={() => handleDelete(entry)} disabled={anyBusy} className="text-xs text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-50">
                      {deletingPath === entry.path ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
