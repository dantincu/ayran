import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';
import type { StoredAccount, ShelvesetChange, ShelvesetContentItem, ShelvesetAllChanges } from '../../types';
import { isTextFile } from '../../lib/file-type';
const DiffViewerModal = lazy(() => import('./DiffViewerModal'));
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

  // Process structural changes one by one in recorded order.
  for (const s of all.structural) {
    if (s.operation === 'delete') {
      if (provider === 'filen') {
        if (s.isDir) await trashDirectory(account.id, s.itemId);
        else await trashFile(account.id, s.itemId);
      } else if (provider === 'google-drive') {
        await invoke('gdrive_delete_file', { accountId: account.id, fileId: s.itemId });
      }
      invoke('uncache_item', { accountId: account.id, itemId: s.itemId }).catch(() => {});

    } else if (s.operation === 'rename') {
      const newName = s.newName!;
      if (provider === 'filen') {
        if (s.isDir) await renameDirectory(account.id, s.itemId, newName);
        else await renameFile(account.id, s.itemId, newName);
      } else if (provider === 'google-drive') {
        await invoke('gdrive_rename', { accountId: account.id, fileId: s.itemId, newName, isDir: s.isDir });
      }
      invoke('rename_cached_item', { accountId: account.id, itemId: s.itemId, newName }).catch(() => {});

    } else if (s.operation === 'move') {
      const newParentId = s.newParentId!;
      if (provider === 'filen') {
        if (s.isDir) await moveDirectory(account.id, s.itemId, newParentId);
        else await moveFile(account.id, s.itemId, newParentId);
      } else if (provider === 'google-drive') {
        await invoke('gdrive_move_file', { accountId: account.id, fileId: s.itemId, fromFolderId: s.parentId, toFolderId: newParentId });
      }
      invoke('move_cached_item', { accountId: account.id, itemId: s.itemId, newParentId }).catch(() => {});
    }
  }

  // Process content changes one by one in recorded order.
  // shv- IDs are mapped to real IDs as new folders are created, so that
  // subsequent items referencing them as a parent resolve correctly.
  const shvToReal = new Map<string, string>();
  const resolveId = (id: string) => shvToReal.get(id) ?? id;

  for (const c of all.content) {
    if (!c.isNew) {
      // Existing file with modified content.
      const localPath = await invoke<string | null>('shelveset_get_content_path', {
        accountId: account.id, itemId: c.itemId,
      });
      if (!localPath) continue;
      if (provider === 'filen') {
        await overwriteFile(account.id, c.itemId, c.parentId, localPath);
      } else if (provider === 'google-drive') {
        await invoke('gdrive_edit_file', { accountId: account.id, fileId: c.itemId, filePath: localPath });
      }
    } else if (c.isDir) {
      // New folder.
      const parentId = resolveId(c.parentId);
      let realId: string;
      if (provider === 'filen') {
        realId = await invoke<string>('filen_create_directory', { accountId: account.id, parentId, name: c.itemName });
      } else if (provider === 'google-drive') {
        realId = await invoke<string>('gdrive_create_folder', { accountId: account.id, parentId, name: c.itemName });
      } else { continue; }
      shvToReal.set(c.itemId, realId);
      invoke('invalidate_folder_cache', { accountId: account.id, folderId: parentId }).catch(() => {});
    } else {
      // New file — upload content from s/ folder.
      const parentId = resolveId(c.parentId);
      const localPath = await invoke<string | null>('shelveset_get_content_path', {
        accountId: account.id, itemId: c.itemId,
      });
      if (provider === 'filen') {
        await invoke('filen_upload_file', { accountId: account.id, parentId, localPath: localPath ?? '' });
      } else if (provider === 'google-drive') {
        const content = localPath ? new TextDecoder('utf-8').decode(await readFile(localPath)) : '';
        await invoke('gdrive_upload_file', { accountId: account.id, parentId, name: c.itemName, content });
      }
      invoke('invalidate_folder_cache', { accountId: account.id, folderId: parentId }).catch(() => {});
    }
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
  const [scanning, setScanning] = useState(false);
  const [scanWarnings, setScanWarnings] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<string[]>([]); // display paths with cloud conflicts
  const [rowCtxMenu, setRowCtxMenu] = useState<{ x: number; y: number; item: UnifiedChange } | null>(null);
  const [diffItem, setDiffItem] = useState<UnifiedChange | null>(null);
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

  // ── Rescan ────────────────────────────────────────────────────────────────

  const handleRescan = async (): Promise<boolean> => {
    setScanning(true); setScanWarnings([]); setError(null);
    try {
      const result = await invoke<{ updated: string[]; missingFromDisk: string[]; extraOnDisk: string[] }>(
        'shelveset_rescan', { accountId: account.id }
      );
      const warnings: string[] = [];
      if (result.updated.length)
        warnings.push(`${result.updated.length} file(s) modified externally: ${result.updated.slice(0, 3).join(', ')}${result.updated.length > 3 ? '…' : ''}`);
      if (result.missingFromDisk.length)
        warnings.push(`${result.missingFromDisk.length} file(s) missing from disk: ${result.missingFromDisk.slice(0, 3).join(', ')}${result.missingFromDisk.length > 3 ? '…' : ''}`);
      if (result.extraOnDisk.length)
        warnings.push(`${result.extraOnDisk.length} untracked file(s) found on disk.`);
      setScanWarnings(warnings);
      if (result.updated.length > 0) await load();
      return warnings.length === 0;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setScanning(false);
    }
  };

  // ── Conflict check ────────────────────────────────────────────────────────

  const checkConflicts = async (changes: ShelvesetAllChanges): Promise<string[]> => {
    const provider = account.provider;
    if (provider === 'local-fs') return [];
    const modifiedExisting = changes.content.filter((c) => !c.isNew);
    const conflicting: string[] = [];
    for (const item of modifiedExisting) {
      const cachedMs = await invoke<number | null>('get_item_cached_mtime', {
        accountId: account.id, itemId: item.itemId,
      }).catch(() => null);
      if (cachedMs == null) continue;
      const serverMs = await invoke<number | null>(
        provider === 'filen' ? 'filen_get_file_mtime' : 'gdrive_get_file_mtime',
        { accountId: account.id, [provider === 'filen' ? 'uuid' : 'fileId']: item.itemId }
      ).catch(() => null);
      if (serverMs != null && serverMs > cachedMs) {
        conflicting.push(item.displayPath);
      }
    }
    return conflicting;
  };

  // ── Commit ────────────────────────────────────────────────────────────────

  const handleCommit = async () => {
    if (!allChanges) return;
    if (!confirm('Commit all pending changes to the cloud provider?')) return;
    setCommitting(true); setError(null); setConflicts([]);

    // 1. Auto-rescan.
    const scanOk = await handleRescan();
    if (!scanOk) {
      setCommitting(false);
      setError('Rescan found discrepancies. Please review the warnings above before committing.');
      return;
    }

    // 2. Re-load after rescan and check for cloud conflicts.
    const freshChanges = await invoke<ShelvesetAllChanges>('shelveset_get_all_changes', { accountId: account.id });
    const conflictPaths = await checkConflicts(freshChanges);
    if (conflictPaths.length > 0) {
      setConflicts(conflictPaths);
      setCommitting(false);
      setError(`${conflictPaths.length} file(s) were modified on the server since you last fetched them. Resolve conflicts before committing.`);
      return;
    }

    try {
      await commitShelveset(account, freshChanges);
      await invoke('shelveset_discard', { accountId: account.id });
      onCommitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCommitting(false);
    }
  };

  // ── Diff viewer loader ────────────────────────────────────────────────────

  const openDiff = (item: UnifiedChange) => {
    setRowCtxMenu(null);
    setDiffItem(item);
  };

  const makeDiffInfo = (item: UnifiedChange) => {
    if (!item.content) return null;
    const contentItem = item.content;
    const binary = !isTextFile(contentItem.itemName);
    const loadLeft = async (): Promise<string> => {
      const path = await invoke<string>('open_file', {
        accountId: account.id, itemId: contentItem.itemId, force: false,
      });
      return new TextDecoder('utf-8').decode(await readFile(path));
    };
    const loadRight = async (): Promise<string> => {
      const path = await invoke<string | null>('shelveset_get_content_path', {
        accountId: account.id, itemId: contentItem.itemId,
      });
      if (!path) return '';
      return new TextDecoder('utf-8').decode(await readFile(path));
    };
    return { loadLeft, loadRight, binary, contentItem };
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const totalPages = Math.max(1, Math.ceil(unified.length / PAGE_SIZE));
  const pageItems = unified.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const anyBusy = committing || undoing || scanning;

  const ctxBtn = 'w-full text-left px-4 py-2 text-sm flex items-center gap-2 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors';

  return (
    <>
    {diffItem && (() => {
      const info = makeDiffInfo(diffItem);
      if (!info) return null;
      return (
        <Suspense fallback={null}>
          <DiffViewerModal
            filename={diffItem.itemName}
            leftLabel="Cloud (original)"
            rightLabel="Shelved (modified)"
            binaryMode={info.binary}
            loadLeft={info.loadLeft}
            loadRight={info.loadRight}
            onDiscard={async () => {
              await invoke('shelveset_undo_content', {
                accountId: account.id, id: info.contentItem.id,
                itemId: info.contentItem.itemId, isNew: info.contentItem.isNew,
              }).catch(() => {});
              setDiffItem(null);
              await load();
            }}
            onClose={() => setDiffItem(null)}
          />
        </Suspense>
      );
    })()}

    {rowCtxMenu && (
      <div className="fixed inset-0 z-[55]" onClick={() => setRowCtxMenu(null)}>
        <div
          className="absolute bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl py-1 min-w-[180px]"
          style={{ left: rowCtxMenu.x, top: rowCtxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {(rowCtxMenu.item.kind === 'modified') && (
            <button onClick={() => openDiff(rowCtxMenu.item)} className={ctxBtn}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5 shrink-0"><path d="M3 4h4M3 8h3M3 12h4"/><path d="M13 4H9M13 8h-3M13 12H9"/><path d="M7.5 2v12" strokeDasharray="2 1"/></svg>
              Compare with original
            </button>
          )}
          <button onClick={() => { setRowCtxMenu(null); undoItems(new Set([rowCtxMenu.item.key])); }} className={ctxBtn}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5 shrink-0 text-amber-500"><path d="M3 8a5 5 0 105.5-4.97M3 8V4M3 8H7"/></svg>
            Undo this change
          </button>
        </div>
      </div>
    )}

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
        <button onClick={handleCommit} disabled={anyBusy || unified.length === 0}
          className="px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors">
          {committing ? 'Committing…' : 'Commit all'}
        </button>
        <button onClick={() => undoItems(selectedKeys)} disabled={anyBusy || selectedKeys.size === 0}
          className="px-3 py-1.5 text-sm bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-40 transition-colors">
          Undo selected ({selectedKeys.size})
        </button>
        <button onClick={() => undoItems(new Set(unified.map((u) => u.key)))} disabled={anyBusy || unified.length === 0}
          className="px-3 py-1.5 text-sm bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 rounded-lg hover:bg-amber-200 dark:hover:bg-amber-800/40 disabled:opacity-40 transition-colors">
          Undo all
        </button>
        <button onClick={() => handleRescan()} disabled={anyBusy}
          className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40 transition-colors">
          {scanning ? 'Scanning…' : 'Rescan'}
        </button>
        <div className="flex-1" />
        <button onClick={handleDiscard} disabled={anyBusy}
          className="px-3 py-1.5 text-sm bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-200 dark:hover:bg-red-800/40 disabled:opacity-40 transition-colors">
          Discard shelveset
        </button>
      </div>

      {/* Scan warnings */}
      {scanWarnings.length > 0 && (
        <div className="mx-4 mt-2 shrink-0 p-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 rounded text-xs space-y-0.5">
          {scanWarnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
        </div>
      )}

      {/* Conflict warnings */}
      {conflicts.length > 0 && (
        <div className="mx-4 mt-2 shrink-0 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded text-xs space-y-0.5">
          <div className="font-semibold mb-1">⚡ Cloud conflicts — these files were modified on the server:</div>
          {conflicts.map((p, i) => <div key={i} className="pl-2">• {p}</div>)}
        </div>
      )}

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
              const isConflict = conflicts.includes(item.displayPath);
              return (
                <div
                  key={item.key}
                  onClick={(e) => handleCheck(idx, e.shiftKey)}
                  onContextMenu={(e) => { e.preventDefault(); setRowCtxMenu({ x: e.clientX, y: e.clientY, item }); }}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer select-none transition-colors ${
                    isConflict ? 'ring-2 ring-red-400 dark:ring-red-500 ' : ''
                  }${selected ? 'ring-2 ring-blue-400 dark:ring-blue-500 ' : ''}${kindColors(item.kind)}`}
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
                  {isConflict && <span title="Cloud conflict" className="text-red-500 shrink-0">⚡</span>}
                  <span className="flex-1 text-sm truncate" title={item.displayPath}>
                    {item.displayPath || item.itemName}
                  </span>
                  {item.kind === 'modified' && (
                    <button onClick={(e) => { e.stopPropagation(); openDiff(item); }} title="Compare with original"
                      className="p-0.5 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 shrink-0 transition-colors">
                      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5"><path d="M2 3.5h4M2 7h3M2 10.5h4"/><path d="M12 3.5H8M12 7H9M12 10.5H8"/><path d="M6.5 1.5v11" strokeDasharray="2 1"/></svg>
                    </button>
                  )}
                  {item.structural?.operation === 'rename' && item.structural.newName && (
                    <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0 truncate max-w-[160px]">→ {item.structural.newName}</span>
                  )}
                  {item.structural?.operation === 'move' && item.structural.newParentId && (
                    <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0 truncate max-w-[160px]">→ {item.structural.newParentId}</span>
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
    </>
  );
}
