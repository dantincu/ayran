'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { AccountInfo } from '@/types';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
}

interface Props {
  accounts: AccountInfo[];
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

export default function DriveExplorer({ accounts }: Props) {
  const [selectedId, setSelectedId] = useState(accounts[0]?.id ?? '');
  const [folderId, setFolderId] = useState('root');
  const [breadcrumbs, setBreadcrumbs] = useState([{ id: 'root', name: 'My Drive' }]);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchFiles = useCallback(async (accountId: string, folder: string, query?: string) => {
    if (!accountId) return;
    setLoading(true);
    setError(null);
    try {
      let q = `'${folder}' in parents and trashed = false`;
      if (query) q = `name contains '${query}' and trashed = false`;
      const params = new URLSearchParams({
        q,
        fields: 'files(id,name,mimeType,size,modifiedTime)',
        orderBy: 'folder,name',
        pageSize: '200',
      });
      const res = await fetch(`/api/drive/${accountId}/files?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setFiles(data.files ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load files');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFiles(selectedId, folderId);
    setSearch('');
  }, [selectedId, folderId, fetchFiles]);

  const switchAccount = (id: string) => {
    setSelectedId(id);
    setFolderId('root');
    setBreadcrumbs([{ id: 'root', name: 'My Drive' }]);
  };

  const openFolder = (file: DriveFile) => {
    if (file.mimeType !== FOLDER_MIME) return;
    setFolderId(file.id);
    setBreadcrumbs((prev) => [...prev, { id: file.id, name: file.name }]);
    setSearch('');
  };

  const navigateTo = (index: number) => {
    const crumb = breadcrumbs[index];
    setFolderId(crumb.id);
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
    setSearch('');
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    fetchFiles(selectedId, folderId, search || undefined);
  };

  const handleDownload = async (file: DriveFile) => {
    const res = await fetch(`/api/drive/${selectedId}/files/${file.id}?alt=media`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDelete = async (file: DriveFile) => {
    if (!confirm(`Delete "${file.name}"?`)) return;
    const res = await fetch(`/api/drive/${selectedId}/files/${file.id}`, { method: 'DELETE' });
    if (res.ok || res.status === 204) {
      setFiles((prev) => prev.filter((f) => f.id !== file.id));
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const boundary = 'csdrive_' + Date.now().toString(36);
      const metadata = JSON.stringify({ name: file.name, parents: [folderId] });
      const fileBytes = await file.arrayBuffer();
      const enc = new TextEncoder();

      const pre = enc.encode(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`
      );
      const post = enc.encode(`\r\n--${boundary}--`);

      const merged = new Uint8Array(pre.byteLength + fileBytes.byteLength + post.byteLength);
      merged.set(pre, 0);
      merged.set(new Uint8Array(fileBytes), pre.byteLength);
      merged.set(post, pre.byteLength + fileBytes.byteLength);

      const res = await fetch(`/api/drive/${selectedId}/upload/files?uploadType=multipart`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: merged,
      });
      if (res.ok) fetchFiles(selectedId, folderId);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleNewFolder = async () => {
    const name = prompt('Folder name:');
    if (!name?.trim()) return;
    const res = await fetch(`/api/drive/${selectedId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), mimeType: FOLDER_MIME, parents: [folderId] }),
    });
    if (res.ok) fetchFiles(selectedId, folderId);
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200">
      {/* Toolbar */}
      <div className="p-4 border-b border-gray-100 space-y-3">
        {/* Account tabs */}
        <div className="flex flex-wrap items-center gap-2">
          {accounts.map((a) => (
            <button
              key={a.id}
              onClick={() => switchAccount(a.id)}
              className={`px-3 py-1 rounded-full text-sm transition-colors ${
                selectedId === a.id
                  ? 'bg-blue-100 text-blue-700 font-medium'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {a.displayName ?? a.email}
            </button>
          ))}

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={handleNewFolder}
              className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
            >
              + New folder
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="px-3 py-1 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {uploading ? 'Uploading…' : 'Upload file'}
            </button>
            <input ref={fileInputRef} type="file" className="hidden" onChange={handleUpload} />
          </div>
        </div>

        {/* Search */}
        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search files…"
            className="flex-1 text-sm px-3 py-1.5 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
          <button type="submit" className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">
            Search
          </button>
          {search && (
            <button
              type="button"
              onClick={() => { setSearch(''); fetchFiles(selectedId, folderId); }}
              className="px-3 py-1.5 bg-gray-100 text-gray-600 text-sm rounded-lg hover:bg-gray-200"
            >
              Clear
            </button>
          )}
        </form>

        {/* Breadcrumbs */}
        <nav className="flex items-center flex-wrap gap-1 text-sm text-gray-500">
          {breadcrumbs.map((crumb, i) => (
            <span key={crumb.id} className="flex items-center gap-1">
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

      {/* File list */}
      <div className="p-4 min-h-48">
        {loading && (
          <div className="flex items-center justify-center h-32 text-gray-400 text-sm">Loading…</div>
        )}
        {!loading && error && (
          <div className="p-3 bg-red-50 border border-red-100 text-red-600 rounded-lg text-sm">{error}</div>
        )}
        {!loading && !error && files.length === 0 && (
          <div className="flex items-center justify-center h-32 text-gray-400 text-sm">This folder is empty</div>
        )}
        {!loading && !error && files.length > 0 && (
          <div className="divide-y divide-gray-50">
            {files.map((file) => (
              <div
                key={file.id}
                className="flex items-center gap-3 py-2 px-2 rounded-lg hover:bg-gray-50 group"
              >
                <span className="text-lg select-none w-7 text-center">{fileIcon(file.mimeType)}</span>

                <div className="flex-1 min-w-0">
                  <button
                    onClick={() => openFolder(file)}
                    disabled={file.mimeType !== FOLDER_MIME}
                    className={`text-sm font-medium truncate block text-left w-full ${
                      file.mimeType === FOLDER_MIME
                        ? 'hover:text-blue-600 cursor-pointer'
                        : 'cursor-default text-gray-800'
                    }`}
                  >
                    {file.name}
                  </button>
                  <p className="text-xs text-gray-400">
                    {formatSize(file.size)}
                    {file.size && file.modifiedTime && ' · '}
                    {file.modifiedTime && new Date(file.modifiedTime).toLocaleDateString()}
                  </p>
                </div>

                <div className="flex gap-3 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  {file.mimeType !== FOLDER_MIME && (
                    <button
                      onClick={() => handleDownload(file)}
                      className="text-xs text-blue-600 hover:text-blue-800"
                    >
                      Download
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(file)}
                    className="text-xs text-red-500 hover:text-red-700"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
