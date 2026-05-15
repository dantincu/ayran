import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';
import type { StoredAccount, ShelvesetChange, ShelvesetContentItem, ShelvesetAllChanges } from '../../types';
import {
  trashFile, trashDirectory, renameFile, renameDirectory,
  moveFile, moveDirectory, overwriteFile,
} from '../../lib/filen-client';

const PAGE_SIZE = 50;

// ── Unified change item ───────────────────────────────────────────────────────

type ChangeKind = 'delete' | 'rename' | 'move' | 'modified' | 'new-file' | 'new-folder';

interface UnifiedChange {
  key: string; // unique key for selection
  kind: ChangeKind;
  displayPath: string;
  itemName: string;
  structural?: ShelvesetChange;
  content?: ShelvesetContentItem;
}

function kindLabel(kind: ChangeKind): string {
  switch (kind) {
    case 'delete': return 'Delete';
    case 'rename': return 'Rename';
    case 'move': return 'Move';
    case 'modified': return 'Modified';
    case 'new-file': return 'New file';
    case 'new-folder': return 'New folder';
  }
}

function kindColors(kind: ChangeKind): string {
  switch (kind) {
    case 'delete': return 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400';
    case 'rename':
    case 'move': return 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400';
    case 'modified': return 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400';
    case 'new-file':
    case 'new-folder': return 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400';
  }
}

function badgeColors(kind: ChangeKind): string {
  switch (kind) {
    case 'delete': return 'bg-red-100 dark:bg-red-800/40 text-red-600 dark:text-red-300';
    case 'rename':
    case 'move': return 'bg-blue-100 dark:bg-blue-800/40 text-blue-600 dark:text-blue-300';
    case 'modified': return 'bg-amber-100 dark:bg-amber-800/40 text-amber-600 dark:text-amber-300';
    case 'new-file':
    case 'new-folder': return 'bg-emerald-100 dark:bg-emerald-800/40 text-emerald-600 dark:text-emerald-300';
  }
}

function buildUnified(changes: ShelvesetAllChanges): UnifiedChange[] {
  const items: UnifiedChange[] = [];
  for (const s of changes.structural) {
    const kind: ChangeKind = s.operation === 'delete' ? 'delete' : s.operation === 'rename' ? 'rename' : 'move';
    items.push({ key: `s-${s.id}`, kind, displayPath: s.displayPath, itemName: s.itemName, structural: s });
  }
  for (const c of changes.content) {
    const kind: ChangeKind = c.isNew ? (c.isDir ? 'new-folder' : 'new-file') : 'modified';
    items.push({ key: `c-${c.id}`, kind, displayPath: c.displayPath, itemName: c.itemName, content: c });
  }
  items.sort((a, b) => a.displayPath.localeCompare(b.displayPath));
  return items;
}

// ── Commit logic ──────────────────────────────────────────────────────────────

async function commitShelveset(account: StoredAccount, all: ShelvesetAllChanges): Promise<void> {
  const provider = account.provider;

  // 1. Deletes — deepest paths first
  const deletes = all.structural
    .filter((s) => s.operation === 'delete')
    .sort((a, b) => b.displayPath.split('/').length - a.displayPath.split('/').length);
  for (const d of deletes) {
    if (provider === 'filen') {
      if (d.isDir) await trashDirectory(account.id, d.itemId);
      else await trashFile(account.id, d.itemId);
    } else if (provider === 'google-drive') {
      await invoke('gdrive_delete_file', { accountId: account.id, fileId: d.itemId });
    }
    invoke('uncache_item', { accountId: account.id, itemId: d.itemId }).catch(() => {});
  }

  // 2. Renames
  const renames = all.structural.filter((s) => s.operation === 'rename');
  for (const r of renames) {
    const newName = r.newName!;
    if (provider === 'filen') {
      if (r.isDir) await renameDirectory(account.id, r.itemId, newName);
      else await renameFile(account.id, r.itemId, newName);
      invoke('rename_cached_item', { accountId: account.id, itemId: r.itemId, newName }).catch(() => {});
    } else if (provider === 'google-drive') {
      await invoke('gdrive_rename', { accountId: account.id, fileId: r.itemId, newName, isDir: r.isDir });
      invoke('rename_cached_item', { accountId: account.id, itemId: r.itemId, newName }).catch(() => {});
    }
  }

  // 3. Moves
  const moves = all.structural.filter((s) => s.operation === 'move');
  for (const m of moves) {
    const newParentId = m.newParentId!;
    if (provider === 'filen') {
      if (m.isDir) await moveDirectory(account.id, m.itemId, newParentId);
      else await moveFile(account.id, m.itemId, newParentId);
      invoke('move_cached_item', { accountId: account.id, itemId: m.itemId, newParentId }).catch(() => {});
    } else if (provider === 'google-drive') {
      await invoke('gdrive_move_file', { accountId: account.id, fileId: m.itemId, fromFolderId: m.parentId, toFolderId: newParentId });
      invoke('move_cached_item', { accountId: account.id, itemId: m.itemId, newParentId }).catch(() => {});
    }
  }

  // 4. Content modifications for existing files
  const modifications = all.content.filter((c) => !c.isNew && !c.isDir);
  for (const mod of modifications) {
    const localPath = await invoke<string | null>('shelveset_get_content_path', {
      accountId: account.id, itemId: mod.itemId,
    });
    if (!localPath) continue;
    const bytes = await readFile(localPath);
    const content = new TextDecoder('utf-8').decode(bytes);
    if (provider === 'filen') {
      await overwriteFile(account.id, mod.itemId, mod.parentId, localPath);
    } else if (provider === 'google-drive') {
      await invoke('gdrive_edit_file', { accountId: account.id, fileId: mod.itemId, content });
    }
  }

  // 5. New folders — shallowest first; map shv- IDs to real IDs
  const shvToReal = new Map<string, string>();
  const resolveId = (id: string) => shvToReal.get(id) ?? id;

  const newFolders = all.content
    .filter((c) => c.isNew && c.isDir)
    .sort((a, b) => a.displayPath.split('/').length - b.displayPath.split('/').length);
  for (const nf of newFolders) {
    const parentId = resolveId(nf.parentId);
    let realId: string;
    if (provider === 'filen') {
      realId = await invoke<string>('filen_create_directory', { accountId: account.id, parentId, name: nf.itemName });
    } else if (provider === 'google-drive') {
      realId = await invoke<string>('gdrive_create_folder', { accountId: account.id, parentId, name: nf.itemName });
    } else {
      continue;
    }
    shvToReal.set(nf.itemId, realId);
    invoke('invalidate_folder_cache', { accountId: account.id, folderId: parentId }).catch(() => {});
  }

  // 6. New files — upload content from s/ folder
  const newFiles = all.content.filter((c) => c.isNew && !c.isDir);
  for (const nf of newFiles) {
    const parentId = resolveId(nf.parentId);
    const localPath = await invoke<string | null>('shelveset_get_content_path', {
      accountId: account.id, itemId: nf.itemId,
    });
    if (provider === 'filen') {
      if (localPath) {
        await invoke('filen_upload_file', { accountId: account.id, parentId, localPath });
      } else {
        // Empty file via create_text_file path
        await invoke('filen_upload_file', { accountId: account.id, parentId, localPath: '' }).catch(() => {});
      }
    } else if (provider === 'google-drive') {
      const content = localPath ? new TextDecoder('utf-8').decode(await readFile(localPath)) : '';
      await invoke('gdrive_upload_file', { accountId: account.id, parentId, name: nf.itemName, content });
    }
    invoke('invalidate_folder_cache', { accountId: account.id, folderId: parentId }).catch(() => {});
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  account: StoredAccount;
  onClose: () => void;
  onDiscarded: () => void;
  onCommitted: () => void;
}

export default function ShelvesetChangesModal({ account, onClose, onDiscarded, onCommitted }: Props) {
  const [allChanges, setAllChanges] = useState<ShelvesetAllChanges | null>(null);
  const [unified, setUnified] = useState<UnifiedChange[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const lastCheckedIdxRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await invoke<ShelvesetAllChanges>('shelveset_get_all_changes', { accountId: account.id });
      setAllChanges(data);
      setUnified(buildUnified(data));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [account.id]);

  useEffect(() => { void load(); }, [load]);

  // ── Selection ─────────────────────────────────────────────────────────────

  const toggleSelect = (key: string) => setSelectedKeys((prev) => {
    const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next;
  });

  const handleCheck = (idx: number, shiftHeld: boolean) => {
    const pageStart = page * PAGE_SIZE;
    const absIdx = pageStart + idx;
    if (shiftHeld && lastCheckedIdxRef.current !== null) {
      const lo = Math.min(lastCheckedIdxRef.current, absIdx);
      const hi = Math.max(lastCheckedIdxRef.current, absIdx);
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        unified.slice(lo, hi + 1).forEach((u) => next.add(u.key));
        return next;
      });
    } else {
      toggleSelect(unified[absIdx].key);
      lastCheckedIdxRef.current = absIdx;
    }
  };

  // ── Undo ──────────────────────────────────────────────────────────────────

  const undoItems = async (keys: Set<string>) => {
    if (keys.size === 0) return;
    setUndoing(true); setError(null);
    try {
      for (const key of keys) {
        const item = unified.find((u) => u.key === key);
        if (!item) continue;
        if (item.structural) {
          await invoke('shelveset_undo_structural', { id: item.structural.id });
        } else if (item.content) {
          await invoke('shelveset_undo_content', {
            accountId: account.id,
            id: item.content.id,
            itemId: item.content.itemId,
            isNew: item.content.isNew,
          });
        }
      }
      setSelectedKeys(new Set());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUndoing(false);
    }
  };

  // ── Discard ───────────────────────────────────────────────────────────────

  const handleDiscard = async () => {
    if (!confirm('Discard the entire shelveset? All pending changes will be lost.')) return;
    try {
      await invoke('shelveset_discard', { accountId: account.id });
      onDiscarded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // ── Commit ────────────────────────────────────────────────────────────────

  const handleCommit = async () => {
    if (!allChanges) return;
    if (!confirm('Commit all pending changes to the cloud provider?')) return;
    setCommitting(true); setError(null);
    try {
      await commitShelveset(account, allChanges);
      await invoke('shelveset_discard', { accountId: account.id });
      onCommitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCommitting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const totalPages = Math.max(1, Math.ceil(unified.length / PAGE_SIZE));
  const pageItems = unified.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const anyBusy = committing || undoing;

  return (
    <div className="fixed inset-0 z-50 bg-white dark:bg-gray-900 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white flex-1 truncate">
          Pending Changes
          {unified.length > 0 && <span className="ml-2 text-sm font-normal text-gray-400 dark:text-gray-500">({unified.length})</span>}
        </h2>
        <button onClick={onClose} className="p-1.5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4"><path d="M3.3 3.3a1 1 0 011.4 0L8 6.6l3.3-3.3a1 1 0 111.4 1.4L9.4 8l3.3 3.3a1 1 0 01-1.4 1.4L8 9.4l-3.3 3.3a1 1 0 01-1.4-1.4L6.6 8 3.3 4.7a1 1 0 010-1.4z"/></svg>
        </button>
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100 dark:border-gray-800 shrink-0 flex-wrap">
        <button
          onClick={handleCommit}
          disabled={anyBusy || unified.length === 0}
          className="px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          {committing ? 'Committing…' : 'Commit all'}
        </button>
        <button
          onClick={() => undoItems(selectedKeys)}
          disabled={anyBusy || selectedKeys.size === 0}
          className="px-3 py-1.5 text-sm bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-40 transition-colors"
        >
          Undo selected ({selectedKeys.size})
        </button>
        <button
          onClick={() => undoItems(new Set(unified.map((u) => u.key)))}
          disabled={anyBusy || unified.length === 0}
          className="px-3 py-1.5 text-sm bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 rounded-lg hover:bg-amber-200 dark:hover:bg-amber-800/40 disabled:opacity-40 transition-colors"
        >
          Undo all
        </button>
        <div className="flex-1" />
        <button
          onClick={handleDiscard}
          disabled={anyBusy}
          className="px-3 py-1.5 text-sm bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-200 dark:hover:bg-red-800/40 disabled:opacity-40 transition-colors"
        >
          Discard shelveset
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-4 mt-2 shrink-0 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded text-sm">
          {error}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-2">
        {loading && (
          <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">Loading…</div>
        )}
        {!loading && unified.length === 0 && (
          <div className="flex flex-col items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">
            <p>No pending changes.</p>
          </div>
        )}
        {!loading && unified.length > 0 && (
          <div className="space-y-1">
            {pageItems.map((item, idx) => {
              const absIdx = page * PAGE_SIZE + idx;
              const selected = selectedKeys.has(item.key);
              return (
                <div
                  key={item.key}
                  onClick={(e) => handleCheck(idx, e.shiftKey)}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer select-none transition-colors ${
                    selected
                      ? 'ring-2 ring-blue-400 dark:ring-blue-500 ' + kindColors(item.kind)
                      : kindColors(item.kind)
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => handleCheck(absIdx, false)}
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0 accent-blue-500"
                  />
                  <span className={`shrink-0 text-[11px] font-semibold px-1.5 py-0.5 rounded ${badgeColors(item.kind)}`}>
                    {kindLabel(item.kind)}
                  </span>
                  <span className="flex-1 text-sm truncate" title={item.displayPath}>
                    {item.displayPath || item.itemName}
                  </span>
                  {item.structural?.operation === 'rename' && item.structural.newName && (
                    <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0 truncate max-w-[160px]">
                      → {item.structural.newName}
                    </span>
                  )}
                  {item.structural?.operation === 'move' && item.structural.newParentId && (
                    <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0 truncate max-w-[160px]">
                      → {item.structural.newParentId}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="shrink-0 flex items-center justify-center gap-2 px-4 py-2 border-t border-gray-100 dark:border-gray-800">
          <button onClick={() => setPage(0)} disabled={page === 0} className="px-2 py-1 text-xs rounded disabled:opacity-30 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300">«</button>
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="px-2 py-1 text-xs rounded disabled:opacity-30 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300">‹</button>
          <span className="text-xs text-gray-500 dark:text-gray-400">{page + 1} / {totalPages}</span>
          <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page === totalPages - 1} className="px-2 py-1 text-xs rounded disabled:opacity-30 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300">›</button>
          <button onClick={() => setPage(totalPages - 1)} disabled={page === totalPages - 1} className="px-2 py-1 text-xs rounded disabled:opacity-30 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300">»</button>
        </div>
      )}
    </div>
  );
}
