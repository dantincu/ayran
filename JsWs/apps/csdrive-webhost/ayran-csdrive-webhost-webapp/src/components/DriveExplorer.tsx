'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { AccountInfo } from '@/types';

interface DriveFile {
  id: string; name: string; mimeType: string; size?: string; modifiedTime?: string;
}

interface Props { account: AccountInfo; }

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

export default function DriveExplorer({ account }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const initialFolder = searchParams.get('folder') ?? 'root';
  const [folderId, setFolderId] = useState(initialFolder);
  const [breadcrumbs, setBreadcrumbs] = useState(() =>
    initialFolder !== 'root'
      ? [{ id: 'root', name: 'My Drive' }, { id: initialFolder, name: '…' }]
      : [{ id: 'root', name: 'My Drive' }]
  );
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchFiles = useCallback(async (folder: string, query?: string) => {
    setLoading(true); setError(null);
    try {
      let q = `'${folder}' in parents and trashed = false`;
      if (query) q = `name contains '${query}' and trashed = false`;
      const params = new URLSearchParams({ q, fields: 'files(id,name,mimeType,size,modifiedTime)', orderBy: 'folder,name', pageSize: '200' });
      const res = await fetch(`/api/drive/${account.id}/files?${params}`);
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body?.error?.message ?? `HTTP ${res.status}`); }
      const data = await res.json();
      setFiles(data.files ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load files'); }
    finally { setLoading(false); }
  }, [account.id]);

  useEffect(() => { fetchFiles(folderId); setSearch(''); }, [folderId, fetchFiles]);

  function setFolderAndUrl(id: string, name: string, append: boolean) {
    const nextCrumbs = append
      ? [...breadcrumbs, { id, name }]
      : breadcrumbs.slice(0, breadcrumbs.findIndex((c) => c.id === id) + 1);
    setFolderId(id); setBreadcrumbs(nextCrumbs); setSearch('');
    const url = new URL(window.location.href);
    if (id === 'root') url.searchParams.delete('folder'); else url.searchParams.set('folder', id);
    router.replace(url.pathname + url.search, { scroll: false });
  }

  const openFolder = (file: DriveFile) => { if (file.mimeType !== FOLDER_MIME) return; setFolderAndUrl(file.id, file.name, true); };

  const navigateTo = (index: number) => {
    const crumb = breadcrumbs[index];
    setFolderAndUrl(crumb.id, crumb.name, false);
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
  };

  const handleSearch = (e: React.SyntheticEvent<HTMLFormElement>) => { e.preventDefault(); fetchFiles(folderId, search || undefined); };

  const handleDownload = async (file: DriveFile) => {
    const res = await fetch(`/api/drive/${account.id}/files/${file.id}?alt=media`);
    if (!res.ok) return;
    const blob = await res.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const handleDelete = async (file: DriveFile) => {
    if (!confirm(`Delete "${file.name}"?`)) return;
    const res = await fetch(`/api/drive/${account.id}/files/${file.id}`, { method: 'DELETE' });
    if (res.ok || res.status === 204) setFiles((prev) => prev.filter((f) => f.id !== file.id));
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setUploading(true);
    try {
      const boundary = 'csdrive_' + Date.now().toString(36);
      const metadata = JSON.stringify({ name: file.name, parents: [folderId] });
      const fileBytes = await file.arrayBuffer(); const enc = new TextEncoder();
      const pre = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`);
      const post = enc.encode(`\r\n--${boundary}--`);
      const merged = new Uint8Array(pre.byteLength + fileBytes.byteLength + post.byteLength);
      merged.set(pre, 0); merged.set(new Uint8Array(fileBytes), pre.byteLength); merged.set(post, pre.byteLength + fileBytes.byteLength);
      const res = await fetch(`/api/drive/${account.id}/upload/files?uploadType=multipart`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: merged });
      if (res.ok) fetchFiles(folderId);
    } finally { setUploading(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
  };

  const handleNewFolder = async () => {
    const name = prompt('Folder name:'); if (!name?.trim()) return;
    const res = await fetch(`/api/drive/${account.id}/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), mimeType: FOLDER_MIME, parents: [folderId] }) });
    if (res.ok) fetchFiles(folderId);
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
      <div className="p-4 border-b border-gray-100 dark:border-gray-700 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">Google Drive</span>
          <span className="text-xs text-gray-400 dark:text-gray-500 truncate">{account.displayName ?? account.email}</span>
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
          </div>
        </div>

        <form onSubmit={handleSearch} className="flex gap-2">
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search files…"
            className="flex-1 text-sm px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-700" />
          <button type="submit" className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">Search</button>
          {search && (
            <button type="button" onClick={() => { setSearch(''); fetchFiles(folderId); }}
              className="px-3 py-1.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-sm rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600">
              Clear
            </button>
          )}
        </form>

        <nav className="flex items-center flex-wrap gap-1 text-sm text-gray-500 dark:text-gray-400">
          {breadcrumbs.map((crumb, i) => (
            <span key={crumb.id} className="flex items-center gap-1">
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
        {!loading && !error && files.length === 0 && <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">This folder is empty</div>}
        {!loading && !error && files.length > 0 && (
          <div className="divide-y divide-gray-50 dark:divide-gray-700">
            {files.map((file) => (
              <div key={file.id} className="flex items-center gap-3 py-2 px-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 group">
                <span className="text-lg select-none w-7 text-center">{fileIcon(file.mimeType)}</span>
                <div className="flex-1 min-w-0">
                  <button onClick={() => openFolder(file)} disabled={file.mimeType !== FOLDER_MIME}
                    className={`text-sm font-medium truncate block text-left w-full ${
                      file.mimeType === FOLDER_MIME ? 'hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer' : 'cursor-default text-gray-800 dark:text-gray-200'
                    }`}>
                    {file.name}
                  </button>
                  <p className="text-xs text-gray-400 dark:text-gray-500">
                    {formatSize(file.size)}{file.size && file.modifiedTime && ' · '}{file.modifiedTime && new Date(file.modifiedTime).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex gap-3 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  {file.mimeType !== FOLDER_MIME && (
                    <button onClick={() => handleDownload(file)} className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300">Download</button>
                  )}
                  <button onClick={() => handleDelete(file)} className="text-xs text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300">Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
