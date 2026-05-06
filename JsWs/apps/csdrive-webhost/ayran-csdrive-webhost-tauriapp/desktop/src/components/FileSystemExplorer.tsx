import { useState, useEffect, useCallback, useRef } from 'react';
import { readDir, readFile, writeFile, remove, mkdir } from '@tauri-apps/plugin-fs';
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
  const [currentPath, setCurrentPath] = useState(rootPath);
  const [breadcrumbs, setBreadcrumbs] = useState<{ name: string; path: string }[]>([
    { name: account.displayName ?? rootPath.split(/[\\/]/).pop() ?? rootPath, path: rootPath },
  ]);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const openDir = (entry: FsEntry) => {
    if (!entry.isDirectory) return;
    setCurrentPath(entry.path);
    setBreadcrumbs((p) => [...p, { name: entry.name, path: entry.path }]);
    setSearch('');
  };

  const navigateTo = (i: number) => {
    const c = breadcrumbs[i];
    setCurrentPath(c.path);
    setBreadcrumbs((p) => p.slice(0, i + 1));
    setSearch('');
  };

  const handleSearch = (e: React.SyntheticEvent<HTMLFormElement>) => { e.preventDefault(); loadDir(currentPath, search || undefined); };

  const handleDownload = async (entry: FsEntry) => {
    const data = await readFile(entry.path);
    const blob = new Blob([data]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = entry.name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const handleDelete = async (entry: FsEntry) => {
    if (!confirm(`Delete "${entry.name}"?`)) return;
    try { await remove(entry.path, { recursive: true }); setEntries((p) => p.filter((e) => e.path !== entry.path)); }
    catch (e) { alert(e instanceof Error ? e.message : 'Delete failed'); }
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
    try { await mkdir(`${currentPath}${SEP}${name.trim()}`); loadDir(currentPath); }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed to create folder'); }
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
            <button onClick={handleNewFolder} className="px-3 py-1 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">+ New folder</button>
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
            {entries.map((entry) => (
              <div key={entry.path} className="flex items-center gap-3 py-2 px-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 group">
                <span className="text-lg select-none w-7 text-center">{fileIcon(entry.name, entry.isDirectory)}</span>
                <div className="flex-1 min-w-0">
                  <button onClick={() => openDir(entry)} disabled={!entry.isDirectory}
                    className={`text-sm font-medium truncate block text-left w-full ${entry.isDirectory ? 'hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer' : 'cursor-default text-gray-800 dark:text-gray-200'}`}>
                    {entry.name}
                  </button>
                </div>
                <div className="flex gap-3 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  {!entry.isDirectory && <button onClick={() => handleDownload(entry)} className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300">Download</button>}
                  <button onClick={() => handleDelete(entry)} className="text-xs text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300">Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}