'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { FsEntry } from '@/lib/fs-store';

interface FsItem {
  name: string;
  kind: 'file' | 'directory';
  handle: FileSystemHandle;
}

interface Props {
  entry: FsEntry;
}

function fileIcon(name: string, kind: 'file' | 'directory'): string {
  if (kind === 'directory') return '📁';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif'].includes(ext)) return '🖼';
  if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'].includes(ext)) return '🎵';
  if (ext === 'pdf') return '📄';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  if (['ppt', 'pptx'].includes(ext)) return '📑';
  if (['doc', 'docx', 'txt', 'md'].includes(ext)) return '📝';
  return '📄';
}

async function ensurePermission(handle: FileSystemDirectoryHandle, mode: 'read' | 'readwrite'): Promise<boolean> {
  if ((await handle.queryPermission({ mode })) === 'granted') return true;
  return (await handle.requestPermission({ mode })) === 'granted';
}

export default function FileSystemExplorer({ entry }: Props) {
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle>(entry.handle);
  const [breadcrumbs, setBreadcrumbs] = useState([{ name: entry.name, handle: entry.handle }]);
  const [items, setItems] = useState<FsItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadItems = useCallback(async (handle: FileSystemDirectoryHandle, query?: string) => {
    setLoading(true);
    setError(null);
    try {
      if (!(await ensurePermission(handle, 'read'))) throw new Error('Read permission denied');
      const result: FsItem[] = [];
      for await (const [name, h] of handle.entries()) {
        if (query && !name.toLowerCase().includes(query.toLowerCase())) continue;
        result.push({ name, kind: h.kind, handle: h });
      }
      result.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setItems(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to read directory');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setDirHandle(entry.handle);
    setBreadcrumbs([{ name: entry.name, handle: entry.handle }]);
    setSearch('');
  }, [entry]);

  useEffect(() => {
    loadItems(dirHandle);
  }, [dirHandle, loadItems]);

  const openDir = (item: FsItem) => {
    if (item.kind !== 'directory') return;
    const h = item.handle as FileSystemDirectoryHandle;
    setDirHandle(h);
    setBreadcrumbs((prev) => [...prev, { name: item.name, handle: h }]);
    setSearch('');
  };

  const navigateTo = (index: number) => {
    const crumb = breadcrumbs[index];
    setDirHandle(crumb.handle);
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
    setSearch('');
  };

  const handleSearch = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    loadItems(dirHandle, search || undefined);
  };

  const handleDownload = async (item: FsItem) => {
    if (item.kind !== 'file') return;
    const file = await (item.handle as FileSystemFileHandle).getFile();
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDelete = async (item: FsItem) => {
    if (!confirm(`Delete "${item.name}"?`)) return;
    try {
      if (!(await ensurePermission(dirHandle, 'readwrite'))) throw new Error('Write permission denied');
      await dirHandle.removeEntry(item.name, { recursive: true });
      setItems((prev) => prev.filter((f) => f.name !== item.name));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      if (!(await ensurePermission(dirHandle, 'readwrite'))) throw new Error('Write permission denied');
      const fh = await dirHandle.getFileHandle(file.name, { create: true });
      const writable = await fh.createWritable();
      await writable.write(file);
      await writable.close();
      loadItems(dirHandle);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleNewFolder = async () => {
    const name = prompt('Folder name:');
    if (!name?.trim()) return;
    try {
      if (!(await ensurePermission(dirHandle, 'readwrite'))) throw new Error('Write permission denied');
      await dirHandle.getDirectoryHandle(name.trim(), { create: true });
      loadItems(dirHandle);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to create folder');
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200">
      <div className="p-4 border-b border-gray-100 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">Local file system</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={handleNewFolder} className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors">
              + New folder
            </button>
            <button onClick={() => fileInputRef.current?.click()} className="px-3 py-1 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
              Upload file
            </button>
            <input ref={fileInputRef} type="file" className="hidden" onChange={handleUpload} />
          </div>
        </div>

        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search files…"
            className="flex-1 text-sm px-3 py-1.5 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
          <button type="submit" className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">Search</button>
          {search && (
            <button type="button" onClick={() => { setSearch(''); loadItems(dirHandle); }}
              className="px-3 py-1.5 bg-gray-100 text-gray-600 text-sm rounded-lg hover:bg-gray-200">
              Clear
            </button>
          )}
        </form>

        <nav className="flex items-center flex-wrap gap-1 text-sm text-gray-500">
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-gray-300">/</span>}
              <button
                onClick={() => navigateTo(i)}
                className={i === breadcrumbs.length - 1 ? 'text-gray-800 font-medium' : 'hover:text-blue-600'}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>
      </div>

      <div className="p-4 min-h-48">
        {loading && <div className="flex items-center justify-center h-32 text-gray-400 text-sm">Loading…</div>}
        {!loading && error && (
          <div className="p-3 bg-red-50 border border-red-100 text-red-600 rounded-lg text-sm">{error}</div>
        )}
        {!loading && !error && items.length === 0 && (
          <div className="flex items-center justify-center h-32 text-gray-400 text-sm">This folder is empty</div>
        )}
        {!loading && !error && items.length > 0 && (
          <div className="divide-y divide-gray-50">
            {items.map((item) => (
              <div key={item.name} className="flex items-center gap-3 py-2 px-2 rounded-lg hover:bg-gray-50 group">
                <span className="text-lg select-none w-7 text-center">{fileIcon(item.name, item.kind)}</span>
                <div className="flex-1 min-w-0">
                  <button
                    onClick={() => openDir(item)}
                    disabled={item.kind !== 'directory'}
                    className={`text-sm font-medium truncate block text-left w-full ${
                      item.kind === 'directory' ? 'hover:text-blue-600 cursor-pointer' : 'cursor-default text-gray-800'
                    }`}
                  >
                    {item.name}
                  </button>
                </div>
                <div className="flex gap-3 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  {item.kind === 'file' && (
                    <button onClick={() => handleDownload(item)} className="text-xs text-blue-600 hover:text-blue-800">Download</button>
                  )}
                  <button onClick={() => handleDelete(item)} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
