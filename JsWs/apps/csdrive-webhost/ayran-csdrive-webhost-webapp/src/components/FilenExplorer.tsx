'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { AccountInfo } from '@/types';
import type { CloudItem } from '@filen/sdk';

interface Props { account: AccountInfo; onDisconnect: () => void; }

type CloudFile = Extract<CloudItem, { type: 'file' }>;
type CloudDir = Extract<CloudItem, { type: 'directory' }>;

function fileIcon(item: CloudItem): string {
  if (item.type === 'directory') return '📁';
  const mime = (item as CloudFile).mime ?? '';
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

function sortItems(list: CloudItem[]): CloudItem[] {
  return [...list].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export default function FilenExplorer({ account, onDisconnect }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialFolderRef = useRef(searchParams.get('folder'));

  const [rootUUID, setRootUUID] = useState('');
  const [folderUUID, setFolderUUID] = useState('');
  const [breadcrumbs, setBreadcrumbs] = useState<{ uuid: string; name: string }[]>([]);
  const [items, setItems] = useState<CloudItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchItems = useCallback(async (parent: string, query?: string) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/filen/${account.id}/list?parent=${encodeURIComponent(parent)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      let list: CloudItem[] = data.items ?? [];
      if (query) list = list.filter((i) => i.name.toLowerCase().includes(query.toLowerCase()));
      setItems(sortItems(list));
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load'); }
    finally { setLoading(false); }
  }, [account.id]);

  useEffect(() => {
    const bootstrap = async () => {
      setLoading(true); setError(null);
      try {
        const folderFromUrl = initialFolderRef.current;
        const target = folderFromUrl ?? '';
        const res = await fetch(`/api/filen/${account.id}/list${target ? `?parent=${encodeURIComponent(target)}` : ''}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const root: string = data.root ?? '';
        setRootUUID(root);
        const startFolder = folderFromUrl ?? root;
        setFolderUUID(startFolder);
        setBreadcrumbs(folderFromUrl && folderFromUrl !== root
          ? [{ uuid: root, name: 'My Filen' }, { uuid: folderFromUrl, name: '…' }]
          : [{ uuid: root, name: 'My Filen' }]);
        setItems(sortItems(data.items ?? []));
      } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load'); }
      finally { setLoading(false); }
    };
    bootstrap();
  }, [account.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function setFolderAndUrl(uuid: string, name: string, append: boolean) {
    const nextCrumbs = append
      ? [...breadcrumbs, { uuid, name }]
      : breadcrumbs.slice(0, breadcrumbs.findIndex((c) => c.uuid === uuid) + 1);
    setFolderUUID(uuid); setBreadcrumbs(nextCrumbs); setSearch('');
    fetchItems(uuid);
    const url = new URL(window.location.href);
    if (uuid === rootUUID) url.searchParams.delete('folder'); else url.searchParams.set('folder', uuid);
    router.replace(url.pathname + url.search, { scroll: false });
  }

  const openDir = (item: CloudDir) => setFolderAndUrl(item.uuid, item.name, true);
  const navigateTo = (index: number) => { const c = breadcrumbs[index]; setFolderAndUrl(c.uuid, c.name, false); setBreadcrumbs((p) => p.slice(0, index + 1)); };
  const handleSearch = (e: React.SyntheticEvent<HTMLFormElement>) => { e.preventDefault(); fetchItems(folderUUID, search || undefined); };

  const handleDownload = async (item: CloudFile) => {
    const res = await fetch(`/api/filen/${account.id}/download`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uuid: item.uuid, bucket: item.bucket, region: item.region, chunks: item.chunks, version: item.version, key: item.key, size: item.size, mime: item.mime, name: item.name }) });
    if (!res.ok) return;
    const blob = await res.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = item.name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const handleDelete = async (item: CloudItem) => {
    if (!confirm(`Move "${item.name}" to trash?`)) return;
    const res = await fetch(`/api/filen/${account.id}/item?uuid=${encodeURIComponent(item.uuid)}&type=${item.type}`, { method: 'DELETE' });
    if (res.ok) setItems((prev) => prev.filter((i) => i.uuid !== item.uuid));
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setUploading(true);
    try {
      const form = new FormData(); form.append('file', file);
      const res = await fetch(`/api/filen/${account.id}/upload?parent=${encodeURIComponent(folderUUID)}`, { method: 'POST', body: form });
      if (res.ok) fetchItems(folderUUID);
    } finally { setUploading(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
  };

  const handleNewFolder = async () => {
    const name = prompt('Folder name:'); if (!name?.trim()) return;
    const res = await fetch(`/api/filen/${account.id}/mkdir`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), parent: folderUUID }) });
    if (res.ok) fetchItems(folderUUID);
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
      <div className="p-4 border-b border-gray-100 dark:border-gray-700 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">Filen</span>
          <span className="text-xs text-gray-400 dark:text-gray-500 truncate">{account.email}</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={handleNewFolder}
              className="px-3 py-1 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
              + New folder
            </button>
            <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
              className="px-3 py-1 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
              {uploading ? 'Uploading…' : 'Upload file'}
            </button>
            <input ref={fileInputRef} type="file" className="hidden" onChange={handleUpload} />
            <button
              onClick={() => confirm(`Disconnect ${account.email} from Filen?`) && onDisconnect()}
              className="px-3 py-1 text-xs text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
            >
              Disconnect
            </button>
          </div>
        </div>

        <form onSubmit={handleSearch} className="flex gap-2">
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search files…"
            className="flex-1 text-sm px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-700" />
          <button type="submit" className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">Search</button>
          {search && (
            <button type="button" onClick={() => { setSearch(''); fetchItems(folderUUID); }}
              className="px-3 py-1.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-sm rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600">
              Clear
            </button>
          )}
        </form>

        <nav className="flex items-center flex-wrap gap-1 text-sm text-gray-500 dark:text-gray-400">
          {breadcrumbs.map((crumb, i) => (
            <span key={crumb.uuid} className="flex items-center gap-1">
              {i > 0 && <span className="text-gray-300 dark:text-gray-600">/</span>}
              <button onClick={() => navigateTo(i)}
                className={i === breadcrumbs.length - 1 ? 'text-gray-800 dark:text-gray-200 font-medium' : 'hover:text-blue-600 dark:hover:text-blue-400'}>
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>
      </div>

      <div className="p-4 min-h-48">
        {loading && <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">Loading…</div>}
        {!loading && error && <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 text-red-600 dark:text-red-400 rounded-lg text-sm">{error}</div>}
        {!loading && !error && items.length === 0 && <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">This folder is empty</div>}
        {!loading && !error && items.length > 0 && (
          <div className="divide-y divide-gray-50 dark:divide-gray-700">
            {items.map((item) => (
              <div key={item.uuid} className="flex items-center gap-3 py-2 px-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 group">
                <span className="text-lg select-none w-7 text-center">{fileIcon(item)}</span>
                <div className="flex-1 min-w-0">
                  <button onClick={() => item.type === 'directory' && openDir(item as CloudDir)} disabled={item.type !== 'directory'}
                    className={`text-sm font-medium truncate block text-left w-full ${
                      item.type === 'directory' ? 'hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer' : 'cursor-default text-gray-800 dark:text-gray-200'
                    }`}>
                    {item.name}
                  </button>
                  <p className="text-xs text-gray-400 dark:text-gray-500">
                    {item.type === 'file' && formatSize((item as CloudFile).size)}
                    {item.type === 'file' && item.lastModified ? ' · ' : ''}
                    {item.lastModified ? new Date(item.lastModified).toLocaleDateString() : ''}
                  </p>
                </div>
                <div className="flex gap-3 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  {item.type === 'file' && (
                    <button onClick={() => handleDownload(item as CloudFile)} className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300">Download</button>
                  )}
                  <button onClick={() => handleDelete(item)} className="text-xs text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300">Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
