import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import Popover from '../common/Popover';
import { invoke } from '@tauri-apps/api/core';
import { save, open as dialogOpen } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import type { StoredAccount, CachedItem, FolderPage, ShelvesetAllChanges } from '../../types';
import { warnAndConfirmConflict } from '../../lib/conflict-check';
import { isTextFile } from '../../lib/file-type';
const DiffViewerModal = lazy(() => import('./DiffViewerModal'));
import { deleteAccount } from '../../lib/account-store';
import FolderPickerModal, { type FolderEntry } from './FolderPickerModal';
import PaginationBar, { type PaginationBarHandle } from './PaginationBar';
import { useListKeyNav } from '../../hooks/useListKeyNav';
import NewNotebookModal from './NewNotebookModal';
import ThumbnailImage from './ThumbnailImage';
import BreadcrumbAncestorsModal, { type AncestorEntry } from './BreadcrumbAncestorsModal';
import BreadcrumbChangePathModal from './BreadcrumbChangePathModal';
import CreateTextFileModal from './CreateTextFileModal';
import Modal from '../common/Modal';
import { UploadIcon, FolderPlusIcon, NewFileIcon, PencilIcon, TypeCursorIcon, CopyFilesIcon, MoveArrowIcon, DownloadArrowIcon, TrashIcon, DotsHorizontalIcon, ArrowUpIcon, ArrowDownIcon, AncestorsIcon } from './ExplorerIcons';
import config from '../../config.json';

const PAGE_SIZE = config.defaultListPageSize;

interface DriveFile {
  id: string; name: string; mimeType: string; size?: string; modifiedTime?: string;
}

interface Props {
  account: StoredAccount;
  onDisconnect: () => void;
  onOpenFile: (item: CachedItem, displayPath: string, siblings?: CachedItem[], siblingIdx?: number) => void;
  onOpenNotebook?: (info: { title: string; itemId: string; parentId: string; displayName: string; description?: string }) => void;
  onCompactChange?: (compact: boolean) => void;
  highlightItemId?: string;
  stackMinimized?: boolean;
  canMinimize?: boolean;
  onMinimize?: () => void;
  instanceKey?: string;
  onFolderPathChange?: (folderName: string, displayPath: string) => void;
  prevExplorerPath?: string;
  onQuickActions?: () => void;
}

type SortBy = 'name' | 'size' | 'modified';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

function fileIcon(item: CachedItem): string {
  if (item.isDir) return '📁';
  const mime = item.mimeType ?? '';
  const ext = item.name.split('.').pop()?.toLowerCase() ?? '';
  if (mime.startsWith('image/') || ['jpg','jpeg','png','gif','webp','svg','avif'].includes(ext)) return '🖼';
  if (mime.startsWith('video/') || ['mp4','mkv','avi','mov','webm'].includes(ext)) return '🎬';
  if (mime.startsWith('audio/') || ['mp3','wav','ogg','flac','m4a'].includes(ext)) return '🎵';
  if (mime.includes('pdf') || ext === 'pdf') return '📄';
  if (mime.includes('spreadsheet') || mime.includes('excel') || ['xls','xlsx','csv'].includes(ext)) return '📊';
  if (mime.includes('presentation') || mime.includes('powerpoint') || ['ppt','pptx'].includes(ext)) return '📑';
  if (mime.includes('document') || mime.includes('word') || ['doc','docx','txt','md'].includes(ext)) return '📝';
  return '📄';
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function isImageItem(item: CachedItem): boolean {
  const mime = item.mimeType ?? '';
  const ext = item.name.split('.').pop()?.toLowerCase() ?? '';
  return mime.startsWith('image/') || ['jpg','jpeg','png','gif','webp','bmp','avif'].includes(ext);
}

type MediaMode = 'image' | 'audio' | 'video' | 'other';
function getItemMode(item: CachedItem): MediaMode {
  if (item.isDir) return 'other';
  const mime = item.mimeType ?? '';
  const ext = item.name.split('.').pop()?.toLowerCase() ?? '';
  if (mime.startsWith('image/') || ['jpg','jpeg','png','gif','webp','svg','avif','bmp','ico'].includes(ext)) return 'image';
  if (mime.startsWith('audio/') || ['mp3','wav','ogg','flac','m4a','aac','opus'].includes(ext)) return 'audio';
  if (mime.startsWith('video/') || ['mp4','mkv','avi','mov','webm','m4v'].includes(ext)) return 'video';
  return 'other';
}

function openFileSiblings(item: CachedItem, allItems: CachedItem[]): { siblings: CachedItem[]; siblingIdx: number } {
  const mode = getItemMode(item);
  if (mode === 'other') return { siblings: [], siblingIdx: -1 };
  const siblings = allItems.filter((i) => !i.isDir && getItemMode(i) === mode);
  return { siblings, siblingIdx: siblings.findIndex((i) => i.itemId === item.itemId) };
}

export default function GoogleDriveExplorer({ account, onDisconnect, onOpenFile, onOpenNotebook, onCompactChange, highlightItemId, stackMinimized, canMinimize, onMinimize, instanceKey, onFolderPathChange, prevExplorerPath, onQuickActions }: Props) {
  const navKey = `notes-gdrive-nav-${account.id}${instanceKey ? `-${instanceKey}` : ''}`;

  const savedNav = useMemo(() => {
    try {
      const raw = localStorage.getItem(navKey);
      return raw ? JSON.parse(raw) as {
        path?: string;
        id?: string; // old format — kept for graceful migration
        breadcrumbs: { name: string }[];
        page: number;
        search: string;
        sortBy: SortBy;
        ascending: boolean;
        viewMode?: 'list' | 'thumbnails';
      } : null;
    } catch { return null; }
  }, [navKey]);

  const [folderId, setFolderId] = useState('root');
  const [breadcrumbs, setBreadcrumbs] = useState<{ id: string; name: string }[]>(
    [{ id: 'root', name: 'My Drive' }],
  );
  const [files, setFiles] = useState<CachedItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('name');
  const [ascending, setAscending] = useState(true);
  const [page, setPage] = useState(0);
  const [viewMode, setViewMode] = useState<'list' | 'thumbnails'>(savedNav?.viewMode ?? 'list');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cacheCleared, setCacheCleared] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<'copy' | 'move' | null>(null);
  const lastCheckedIdxRef = useRef<number | null>(null);
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const [folderPicker, setFolderPicker] = useState<{
    fileId: string; fileName: string; isDir: boolean; action: 'copy' | 'move';
  } | null>(null);

  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [rowCtxMenu, setRowCtxMenu] = useState<{ x: number; y: number; item: CachedItem } | null>(null);
  const [crumbCtx, setCrumbCtx] = useState<{ x: number; y: number } | null>(null);
  const [ancestorsConfig, setAncestorsConfig] = useState<{ entries: AncestorEntry[]; onNavigate: (i: number) => void } | null>(null);
  const [showChangePath, setShowChangePath] = useState(false);
  const [lastOpenedId, setLastOpenedId] = useState<string | null>(null);
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const [shelvedIds, setShelvedIds] = useState<Set<string>>(new Set());
  const [diffItem, setDiffItem] = useState<CachedItem | null>(null);
  const [autoHide, setAutoHide] = useState(() => localStorage.getItem(`notes-autohide-${account.id}`) !== 'false');
  const scrollBlockedRef = useRef(0);
  const [showCreateTextFile, setShowCreateTextFile] = useState(false);
  const [duplicateNameError, setDuplicateNameError] = useState<CachedItem | null>(null);

  const anyBusy = !!uploadingId || !!downloadingId || !!deletingId || !!editingId
    || !!renamingId || !!copyingId || !!movingId;

  // Detect duplicate sibling names (GDrive allows them, but we can't cache by name)
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    files.forEach(f => counts.set(f.name, (counts.get(f.name) ?? 0) + 1));
    const dups = new Set<string>();
    counts.forEach((n, name) => { if (n > 1) dups.add(name); });
    return dups;
  }, [files]);

  useEffect(() => { localStorage.setItem(`notes-autohide-${account.id}`, String(autoHide)); }, [autoHide, account.id]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { onCompactChange?.(headerCollapsed); }, [headerCollapsed]);
  useEffect(() => { if (highlightItemId) setLastOpenedId(highlightItemId); }, [highlightItemId]);

  useEffect(() => {
    if (!account.shelvesetActive) { setShelvedIds(new Set()); return; }
    invoke<ShelvesetAllChanges>('shelveset_get_all_changes', { accountId: account.id })
      .then((c) => setShelvedIds(new Set(c.content.filter((x) => !x.isNew).map((x) => x.itemId))))
      .catch(() => {});
  }, [account.id, account.shelvesetActive]);

  const handleListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (Date.now() < scrollBlockedRef.current) return;
    if (autoHide && !headerCollapsed && e.currentTarget.scrollTop > 40) setHeaderCollapsed(true);
  };

  // ── Persist state to localStorage whenever anything changes ──────────────────
  useEffect(() => {
    const crumbNames = breadcrumbs.map(b => b.name);
    const path = crumbNames.slice(1).join('/'); // skip root label "My Drive"
    localStorage.setItem(navKey, JSON.stringify({
      path, breadcrumbs: crumbNames.map(name => ({ name })),
      page, search, sortBy, ascending, viewMode,
    }));
  }, [folderId, breadcrumbs, page, search, sortBy, ascending, viewMode, navKey]);

  // ── Notify parent of current folder ─────────────────────────────────────────
  const onFolderPathChangeRef = useRef(onFolderPathChange);
  onFolderPathChangeRef.current = onFolderPathChange;
  useEffect(() => {
    const displayPath = breadcrumbs.slice(1).map(b => b.name).join('/');
    onFolderPathChangeRef.current?.(breadcrumbs[breadcrumbs.length - 1].name, displayPath);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId, breadcrumbs]);

  // ── Query SQLite cache (no network call) ─────────────────────────────────────
  const queryCache = useCallback(async (
    folder: string, sq: string, sb: SortBy, asc: boolean, pg: number,
  ) => {
    const result = await invoke<FolderPage>('query_folder_items', {
      accountId: account.id, parentId: folder,
      search: sq || null, sortBy: sb, ascending: asc,
      page: pg, pageSize: PAGE_SIZE,
    });
    setFiles(result.items);
    setTotal(result.total);
  }, [account.id]);

  // ── Full folder load: network fetch (if needed) + cache query ────────────────
  const loadFolder = useCallback(async (
    folder: string, force: boolean, pg: number, sq: string, sb: SortBy, asc: boolean,
  ) => {
    setLoading(true); setError(null);
    try {
      await invoke('list_folder', { accountId: account.id, parentId: folder, force });
      await queryCache(folder, sq, sb, asc, pg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [account.id, queryCache]);

  // ── Initial mount: restore saved state ───────────────────────────────────────
  useEffect(() => {
    const init = async () => {
      let startId = 'root';
      let startCrumbs: { id: string; name: string }[] = [{ id: 'root', name: 'My Drive' }];
      let startPage = 0;
      let startSearch = '';
      let startSort: SortBy = 'name';
      let startAsc = true;

      if (savedNav) {
        startPage = savedNav.page ?? 0;
        startSearch = savedNav.search ?? '';
        startSort = savedNav.sortBy ?? 'name';
        startAsc = savedNav.ascending ?? true;

        // Support both old format (id field) and new format (path field).
        const crumbNames: string[] = (savedNav.breadcrumbs ?? []).map((b: { name: string }) => b.name);
        const pathComponents = crumbNames.slice(1); // skip root "My Drive"
        if (pathComponents.length > 0) {
          const allPaths = pathComponents.map((_, i) =>
            pathComponents.slice(0, i + 1).join('/'));
          try {
            const resolved = await invoke<(string | null)[]>('resolve_folder_paths', {
              accountId: account.id, paths: allPaths,
            });
            if (resolved.every(r => r !== null)) {
              startCrumbs = [
                { id: 'root', name: crumbNames[0] ?? 'My Drive' },
                ...pathComponents.map((name, i) => ({ id: resolved[i]!, name })),
              ];
              startId = resolved[resolved.length - 1]!;
            }
          } catch { /* fall back to root */ }
        }
      }

      setFolderId(startId);
      setBreadcrumbs(startCrumbs);
      setSortBy(startSort);
      setAscending(startAsc);
      await loadFolder(startId, false, startPage, startSearch, startSort, startAsc);
    };
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // ── Navigation ───────────────────────────────────────────────────────────────
  function navigate(id: string, crumbs: { id: string; name: string }[]) {
    setFolderId(id); setBreadcrumbs(crumbs); setPage(0); setSearch('');
    setSelectedIds(new Set()); lastCheckedIdxRef.current = null;
    void loadFolder(id, false, 0, '', sortBy, ascending);
  }
  const openFolder = (item: CachedItem) => {
    if (!item.isDir) return;
    navigate(item.itemId, [...breadcrumbs, { id: item.itemId, name: item.name }]);
  };
  const navigateTo = (i: number) => {
    if (i < breadcrumbs.length - 1) setLastOpenedId(breadcrumbs[i + 1].id);
    navigate(breadcrumbs[i].id, breadcrumbs.slice(0, i + 1));
  };

  // ── Search / sort / page ─────────────────────────────────────────────────────
  const handleSearch = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault(); setPage(0);
    try { await queryCache(folderId, search, sortBy, ascending, 0); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const handleClearSearch = async () => {
    setSearch(''); setPage(0);
    try { await queryCache(folderId, '', sortBy, ascending, 0); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const handleSort = async (col: SortBy) => {
    const newAsc = col === sortBy ? !ascending : true;
    setSortBy(col); setAscending(newAsc); setPage(0);
    try { await queryCache(folderId, search, col, newAsc, 0); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const handlePage = async (pg: number) => {
    setPage(pg); setSelectedIds(new Set()); lastCheckedIdxRef.current = null;
    try { await queryCache(folderId, search, sortBy, ascending, pg); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  // ── Refresh split-button handlers ────────────────────────────────────────────
  const handleRefresh = () => void loadFolder(folderId, false, page, search, sortBy, ascending);
  const handleHardRefresh = () => { setMenuOpen(false); void loadFolder(folderId, true, page, search, sortBy, ascending); };
  const handleClearCache = async () => {
    setMenuOpen(false);
    try {
      await invoke('invalidate_folder_cache', { accountId: account.id, parentId: folderId });
      setCacheCleared(true);
      setTimeout(() => setCacheCleared(false), 2000);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  // ── File actions ─────────────────────────────────────────────────────────────
  const handleDownload = async (item: CachedItem) => {
    const destPath = await save({ defaultPath: item.name });
    if (!destPath) return;
    setDownloadingId(item.itemId);
    try { await invoke('gdrive_download_file', { accountId: account.id, fileId: item.itemId, destPath }); }
    catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setDownloadingId(null); }
  };
  const handleDelete = async (item: CachedItem) => {
    if (!confirm(`Delete "${item.name}"?`)) return;
    if (!item.isDir && !account.shelvesetActive) {
      if (!await warnAndConfirmConflict(account, item.itemId, item.name)) return;
    }
    setDeletingId(item.itemId);
    try {
      if (account.shelvesetActive) {
        const displayPath = [...breadcrumbs.map(b => b.name), item.name].join('/');
        await invoke('shelveset_record_change', {
          accountId: account.id, operation: 'delete',
          itemId: item.itemId, itemName: item.name, parentId: item.parentId,
          isDir: item.isDir, displayPath,
        });
      } else {
        await invoke('gdrive_delete_file', { accountId: account.id, fileId: item.itemId });
      }
      setFiles((p) => p.filter((f) => f.itemId !== item.itemId));
      invoke('uncache_item', { accountId: account.id, itemId: item.itemId }).catch(() => {});
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setDeletingId(null); }
  };
  const handleEdit = async (item: CachedItem) => {
    const filePath = await dialogOpen({ multiple: false, directory: false });
    if (!filePath || typeof filePath !== 'string') return;
    setEditingId(item.itemId);
    try {
      if (account.shelvesetActive) {
        const displayPath = [...breadcrumbs.map(b => b.name), item.name].join('/');
        await invoke('shelveset_save_file_path', {
          accountId: account.id, itemId: item.itemId, itemName: item.name,
          parentId: item.parentId, isNew: false, displayPath, localPath: filePath,
        });
        setShelvedIds((prev) => new Set([...prev, item.itemId]));
      } else {
        await invoke('gdrive_edit_file', { accountId: account.id, fileId: item.itemId, filePath });
        void loadFolder(folderId, true, 0, search, sortBy, ascending);
      }
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setEditingId(null); }
  };
  const validateRenameInExplorer = (item: CachedItem, newName: string): string => {
    const t = newName.trim();
    if (!t) return 'Name cannot be empty.';
    if (files.some(f => f.itemId !== item.itemId && f.name === t))
      return `"${t}" already exists in this folder. Google Drive allows duplicates but we cannot cache files with duplicate names.`;
    return '';
  };
  const handleRename = async (item: CachedItem) => {
    const newName = prompt('New name:', item.name);
    if (!newName?.trim() || newName.trim() === item.name) return;
    const validErr = validateRenameInExplorer(item, newName);
    if (validErr) { alert(validErr); return; }
    if (!account.shelvesetActive) {
      if (!await warnAndConfirmConflict(account, item.itemId, item.name)) return;
    }
    setRenamingId(item.itemId);
    try {
      const trimmed = newName.trim();
      if (account.shelvesetActive) {
        const displayPath = [...breadcrumbs.map(b => b.name), item.name].join('/');
        await invoke('shelveset_record_change', {
          accountId: account.id, operation: 'rename',
          itemId: item.itemId, itemName: item.name, parentId: item.parentId,
          newName: trimmed, isDir: item.isDir, displayPath,
        });
      } else {
        await invoke('gdrive_rename', { accountId: account.id, fileId: item.itemId, newName: trimmed });
        invoke('rename_cached_item', { accountId: account.id, itemId: item.itemId, newName: trimmed }).catch(() => {});
      }
      setFiles((p) => p.map((f) => f.itemId === item.itemId ? { ...f, name: trimmed } : f));
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setRenamingId(null); }
  };
  const handleCreateTextFile = async (fileName: string) => {
    let newItemId: string;
    if (account.shelvesetActive) {
      const displayPath = [...breadcrumbs.map(b => b.name), fileName].join('/');
      newItemId = await invoke<string>('shelveset_create_item', {
        accountId: account.id, parentId: folderId, itemName: fileName, isDir: false, displayPath, content: '',
      });
    } else {
      newItemId = await invoke<string>('create_text_file', {
        accountId: account.id, parentId: folderId, filename: fileName, content: '',
      });
    }
    const newItem: CachedItem = {
      accountId: account.id, accountEmail: account.email, storageType: 1,
      itemId: newItemId, parentId: folderId, name: fileName, isDir: false,
      mimeType: 'text/plain', size: 0, modifiedMs: Date.now(),
    };
    setShowCreateTextFile(false);
    onOpenFile(newItem, [...breadcrumbs.map(b => b.name), fileName].join(' / '));
    void loadFolder(folderId, true, 0, search, sortBy, ascending);
  };
  const handleUpload = async () => {
    const filePath = await dialogOpen({ multiple: false, directory: false });
    if (!filePath || typeof filePath !== 'string') return;
    setUploadingId('__upload__');
    try {
      await invoke('gdrive_upload_file', { accountId: account.id, folderId, filePath });
      void loadFolder(folderId, true, 0, search, sortBy, ascending);
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setUploadingId(null); }
  };
  const handleNewFolder = async () => {
    const name = prompt('Folder name:'); if (!name?.trim()) return;
    setCreatingFolder(true);
    try {
      await invoke('gdrive_create_folder', { accountId: account.id, parentId: folderId, name: name.trim() });
      void loadFolder(folderId, true, 0, search, sortBy, ascending);
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setCreatingFolder(false); }
  };
  const handleDisconnect = async () => {
    if (!confirm(`Disconnect ${account.displayName ?? account.email} from Google Drive?`)) return;
    await deleteAccount(account.id);
    onDisconnect();
  };

  const listItemsForPicker = async (id: string): Promise<FolderEntry[]> => {
    const list = await invoke<DriveFile[]>('gdrive_list_files', { accountId: account.id, folderId: id, query: null });
    return list.map((f) => ({ id: f.id, name: f.name, isDir: f.mimeType === FOLDER_MIME }));
  };
  const handleFolderPickerConfirm = async (destId: string, destNames: string[]) => {
    if (!folderPicker) return;
    const { fileId, fileName, isDir, action } = folderPicker;
    const destName = destNames[0] ?? fileName;
    try {
      if (action === 'copy') {
        setCopyingId(fileId);
        await invoke('gdrive_copy_file', { accountId: account.id, fileId, destFolderId: destId, name: destName });
      } else {
        setMovingId(fileId);
        const fromFolderId = isDir ? breadcrumbs[breadcrumbs.length - 1].id : folderId;
        if (account.shelvesetActive) {
          const displayPath = [...breadcrumbs.map(b => b.name), fileName].join('/');
          await invoke('shelveset_record_change', {
            accountId: account.id, operation: 'move',
            itemId: fileId, itemName: fileName, parentId: fromFolderId,
            newParentId: destId, isDir, displayPath,
          });
          if (destName !== fileName) {
            await invoke('shelveset_record_change', {
              accountId: account.id, operation: 'rename',
              itemId: fileId, itemName: fileName, parentId: destId,
              newName: destName, isDir, displayPath,
            });
          }
          invoke('move_cached_item', { accountId: account.id, itemId: fileId, newParentId: destId }).catch(() => {});
        } else {
          await invoke('gdrive_move_file', { accountId: account.id, fileId, fromFolderId, toFolderId: destId });
          if (destName !== fileName) await invoke('gdrive_rename', { accountId: account.id, fileId, newName: destName });
        }
        setFiles((p) => p.filter((f) => f.itemId !== fileId));
      }
      setFolderPicker(null);
    } finally { setCopyingId(null); setMovingId(null); }
  };
  const pickerRenameForGDrive = async (item: FolderEntry, newName: string) => {
    await invoke('gdrive_rename', { accountId: account.id, fileId: item.id, newName });
  };
  const pickerDeleteForGDrive = async (item: FolderEntry) => {
    await invoke('gdrive_delete_file', { accountId: account.id, fileId: item.id });
  };
  const pickerCreateFolderForGDrive = async (parentId: string, name: string): Promise<FolderEntry> => {
    const newId = await invoke<string>('gdrive_create_folder', { accountId: account.id, parentId, name });
    return { id: newId, name, isDir: true };
  };
  const pickerResolvePath = async (pathStr: string): Promise<Array<{ id: string; name: string }> | null> => {
    const parts = pathStr.split('/').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return [];
    let parentId = 'root';
    const result: Array<{ id: string; name: string }> = [];
    for (const seg of parts) {
      const found = await invoke<string[]>('gdrive_find_children_by_name', {
        accountId: account.id, parentId, name: seg,
      });
      if (found.length === 0) return null;
      if (found.length > 1) throw new Error(`"${seg}" is ambiguous — ${found.length} items share this name in the parent folder.`);
      result.push({ id: found[0], name: seg });
      parentId = found[0];
    }
    return result;
  };

  const toggleSelect = (id: string) => setSelectedIds((prev) => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });
  const handleCheck = (idx: number, shiftHeld: boolean, deselect = false) => {
    if (shiftHeld && lastCheckedIdxRef.current !== null) {
      const lo = Math.min(lastCheckedIdxRef.current, idx);
      const hi = Math.max(lastCheckedIdxRef.current, idx);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        files.slice(lo, hi + 1).forEach((f) => deselect ? next.delete(f.itemId) : next.add(f.itemId));
        return next;
      });
    } else {
      toggleSelect(files[idx].itemId);
      lastCheckedIdxRef.current = idx;
    }
  };
  const handleTouchStart = (idx: number) => {
    longPressTriggeredRef.current = false;
    longPressRef.current = setTimeout(() => { longPressTriggeredRef.current = true; handleCheck(idx, true); }, 500);
  };
  const handleTouchEnd = () => { if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; } };
  const allSelected = files.length > 0 && files.every((f) => selectedIds.has(f.itemId));
  const someSelected = files.some((f) => selectedIds.has(f.itemId));
  const selectedHasDir = files.some((f) => selectedIds.has(f.itemId) && f.isDir);
  const toggleSelectAll = () => setSelectedIds(allSelected ? new Set() : new Set(files.map((f) => f.itemId)));

  const handleBulkDelete = async () => {
    if (!confirm(`Delete ${selectedIds.size} item(s)?`)) return;
    const ids = [...selectedIds]; setSelectedIds(new Set());
    for (const id of ids) {
      try {
        await invoke('gdrive_delete_file', { accountId: account.id, fileId: id });
        invoke('uncache_item', { accountId: account.id, itemId: id }).catch(() => {});
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    }
    void loadFolder(folderId, true, 0, search, sortBy, ascending);
  };
  const handleBulkPickerConfirm = async (destId: string, destNames: string[]) => {
    const action = bulkAction;
    const ids = [...selectedIds]; setSelectedIds(new Set());
    let nameIdx = 0;
    for (const id of ids) {
      const item = files.find((f) => f.itemId === id); if (!item) continue;
      const destName = destNames[nameIdx++] ?? item.name;
      try {
        if (action === 'copy') {
          await invoke('gdrive_copy_file', { accountId: account.id, fileId: id, destFolderId: destId, name: destName });
        } else {
          await invoke('gdrive_move_file', { accountId: account.id, fileId: id, fromFolderId: folderId, toFolderId: destId });
          if (destName !== item.name) await invoke('gdrive_rename', { accountId: account.id, fileId: id, newName: destName });
        }
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    }
    setBulkAction(null);
    void loadFolder(folderId, true, 0, search, sortBy, ascending);
  };

  const handleNavigateUp = () => {
    if (breadcrumbs.length <= 1) return;
    navigateTo(breadcrumbs.length - 2);
  };

  const handleChangePath = async (pathStr: string) => {
    const parts = pathStr.split('/').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) {
      navigate('root', [{ id: 'root', name: breadcrumbs[0]?.name ?? 'My Drive' }]);
      return;
    }
    const resolvedIds: string[] = [];
    let parentId = 'root';
    for (const seg of parts) {
      const found = await invoke<string[]>('gdrive_find_children_by_name', {
        accountId: account.id, parentId, name: seg,
      });
      if (found.length === 0) throw new Error(`"${seg}" not found in this folder.`);
      if (found.length > 1) throw new Error(`"${seg}" is ambiguous — ${found.length} items share this name in the parent folder. Rename duplicates in Google Drive first.`);
      resolvedIds.push(found[0]);
      parentId = found[0];
    }
    navigate(resolvedIds[resolvedIds.length - 1], [
      { id: 'root', name: breadcrumbs[0]?.name ?? 'My Drive' },
      ...parts.map((name, i) => ({ id: resolvedIds[i], name })),
    ]);
  };

  const openAncestorsForItem = (item: CachedItem) => {
    setAncestorsConfig({
      entries: [
        ...breadcrumbs.map(b => ({ name: b.name, navigable: true })),
        { name: item.name, navigable: item.isDir },
      ],
      onNavigate: (i) => {
        setAncestorsConfig(null);
        if (i < breadcrumbs.length) navigateTo(i);
        else if (item.isDir) openFolder(item);
      },
    });
  };

  const listContainerRef = useRef<HTMLDivElement>(null);
  const paginationBarRef = useRef<PaginationBarHandle>(null);

  const lastOpenedRelIdx = lastOpenedId ? files.findIndex((i) => i.itemId === lastOpenedId) : -1;

  const { focusedRelIdx: listFocusedRelIdx, containerProps: listContainerProps } = useListKeyNav({
    totalItems: total,
    pageSize: PAGE_SIZE,
    page,
    onPage: (pg) => void handlePage(pg),
    onOpen: (absIdx) => {
      const relIdx = absIdx - page * PAGE_SIZE;
      const item = files[relIdx];
      if (!item) return;
      if (item.isDir) { openFolder(item); return; }
      const isDup = duplicateNames.has(item.name);
      if (isDup) { setDuplicateNameError(item); return; }
      setLastOpenedId(item.itemId);
      const s = openFileSiblings(item, files.filter(f => !duplicateNames.has(f.name)));
      onOpenFile(item, [...breadcrumbs.map(b => b.name), item.name].join(' / '), s.siblings, s.siblingIdx);
    },
    onParent: breadcrumbs.length > 1 ? handleNavigateUp : undefined,
    onOpenSelectPageModal: () => paginationBarRef.current?.openPicker(),
    onOpenEditPagePopover: () => paginationBarRef.current?.openEdit(),
    onRefresh: handleRefresh,
    onHardRefresh: handleHardRefresh,
    onClearCache: () => void handleClearCache(),
    containerRef: listContainerRef,
    listKey: folderId,
    currentAbsIdx: lastOpenedRelIdx >= 0 ? page * PAGE_SIZE + lastOpenedRelIdx : -1,
  });

  const sortBtn = (col: SortBy, label: string) => (
    <button
      onClick={() => handleSort(col)}
      className={`text-xs px-2 py-0.5 rounded transition-colors ${
        sortBy === col
          ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
          : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'
      }`}
    >
      {label}{sortBy === col ? (ascending ? ' ↑' : ' ↓') : ''}
    </button>
  );

  const [showNewNb, setShowNewNb] = useState(false);

  const handleCreateNotebook = async (title: string, description?: string) => {
    if (files.some(f => f.name === config.notebookFileName)) {
      throw new Error('A notebook already exists in this folder. Open a different folder to create one there.');
    }
    const content = JSON.stringify({ Title: title }, null, 2);
    const itemId = await invoke<string>('create_text_file', {
      accountId: account.id, parentId: folderId,
      filename: config.notebookFileName, content,
    });
    setShowNewNb(false);
    onOpenNotebook?.({
      title, itemId, parentId: folderId,
      displayName: [...breadcrumbs.map(b => b.name), config.notebookFileName].join(' / '),
      description,
    });
  };

  return (
    <>
      {diffItem && (
        <Suspense fallback={null}>
          <DiffViewerModal
            filename={diffItem.name}
            leftLabel="Cloud (original)" rightLabel="Shelved (modified)"
            binaryMode={!isTextFile(diffItem.name, diffItem.mimeType)}
            loadLeft={async () => {
              const path = await invoke<string>('open_file', { accountId: account.id, itemId: diffItem.itemId, force: false });
              return new TextDecoder('utf-8').decode(await readFile(path));
            }}
            loadRight={async () => {
              const path = await invoke<string | null>('shelveset_get_content_path', { accountId: account.id, itemId: diffItem.itemId });
              if (!path) return '';
              return new TextDecoder('utf-8').decode(await readFile(path));
            }}
            onDiscard={async () => {
              await invoke('shelveset_undo_content', { accountId: account.id, id: 0, itemId: diffItem.itemId, isNew: false }).catch(() => {});
              setShelvedIds((prev) => { const n = new Set(prev); n.delete(diffItem.itemId); return n; });
              setDiffItem(null);
            }}
            onClose={() => setDiffItem(null)}
          />
        </Suspense>
      )}
      {showNewNb && <NewNotebookModal onConfirm={handleCreateNotebook} onClose={() => setShowNewNb(false)} />}
      {showCreateTextFile && (
        <CreateTextFileModal
          existingNames={files.map(f => f.name)}
          onCreate={handleCreateTextFile}
          onClose={() => setShowCreateTextFile(false)}
        />
      )}
      <div className="h-full flex flex-col bg-white dark:bg-gray-900 overflow-hidden">
        {/* Full collapsible header */}
        <div className={`shrink-0 border-b border-gray-200 dark:border-gray-700 transition-[max-height,opacity] duration-200 ${headerCollapsed ? 'max-h-0 opacity-0 pointer-events-none overflow-hidden' : 'max-h-[400px] opacity-100 overflow-visible'}`}>
        <div className="px-3 py-2 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">Google Drive</span>
            <span className="text-xs text-gray-400 dark:text-gray-500 truncate">{account.displayName ?? account.email}</span>
            <div className="ml-auto flex items-center gap-1.5">
              {cacheCleared && <span className="text-xs text-green-600 dark:text-green-400 mr-1">✓ Cache cleared</span>}
              <button onClick={handleNewFolder} disabled={creatingFolder || anyBusy} title={creatingFolder ? 'Creating…' : 'New folder'} className="p-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors">
                <FolderPlusIcon className="w-4 h-4"/>
              </button>
              <button onClick={() => setShowCreateTextFile(true)} disabled={anyBusy} title="Create text file" className="p-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors">
                <NewFileIcon className="w-4 h-4"/>
              </button>
              <button onClick={handleUpload} disabled={anyBusy} title={uploadingId ? 'Uploading…' : 'Upload file'} className="p-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 disabled:opacity-50 transition-colors">
                <UploadIcon className="w-4 h-4"/>
              </button>
              <button onClick={() => setViewMode(m => m === 'list' ? 'thumbnails' : 'list')} title={viewMode === 'list' ? 'Thumbnail view' : 'List view'} className="px-2 py-1 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">{viewMode === 'list' ? '⊞' : '≡'}</button>
              <div className="relative flex items-center">
                <button onClick={handleRefresh} disabled={loading} title="Refresh" className="px-2 py-1 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-l-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors border-r border-gray-200 dark:border-gray-600">↻</button>
                <button onClick={() => setMenuOpen((o) => !o)} disabled={loading} title="Cache options" className="px-1.5 py-1 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-r-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors">▾</button>
                {menuOpen && (
                  <Popover title="Options" onClose={() => setMenuOpen(false)} panelClassName="absolute right-0 top-full mt-1 min-w-max">
                    <div className="py-1">
                      <button onClick={handleHardRefresh} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">Hard refresh</button>
                      <button onClick={handleClearCache} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">Clear cached listing</button>
                    </div>
                  </Popover>
                )}
              </div>
              <div className="relative">
                <button onClick={() => setMoreMenuOpen(o => !o)} title="More options" className="p-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
                  <DotsHorizontalIcon className="w-4 h-4"/>
                </button>
                {moreMenuOpen && (
                  <Popover title="More" onClose={() => setMoreMenuOpen(false)} panelClassName="absolute right-0 top-full mt-1 min-w-max">
                    <div className="py-1">
                      {onOpenNotebook && (
                        <button onClick={() => { setMoreMenuOpen(false); setShowNewNb(true); }} disabled={anyBusy} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50">📓 Create Notebook</button>
                      )}
                      <div className="border-t border-gray-100 dark:border-gray-700 my-1"/>
                      <button onClick={() => { setMoreMenuOpen(false); setAutoHide(a => !a); }} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2">
                        <span className="w-3.5 text-center text-xs">{autoHide ? '✓' : ''}</span>
                        Auto-hide toolbar on scroll
                      </button>
                    </div>
                  </Popover>
                )}
              </div>
              {onQuickActions !== undefined && (
                <button onClick={onQuickActions} title="Quick actions"
                  className="p-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
                  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M8 1L4 8h5l-3 5"/></svg>
                </button>
              )}
              <button onClick={() => setHeaderCollapsed(true)} title="Collapse toolbar"
                className="p-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4"><path d="M2 10l5-5 5 5"/></svg>
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
            {search && <button type="button" onClick={handleClearSearch} className="px-3 py-1.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-sm rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600">Clear</button>}
          </form>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1 min-w-0 flex-1">
              <button onClick={handleNavigateUp} disabled={breadcrumbs.length <= 1} title="Parent folder" className="p-1 shrink-0 rounded text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 transition-colors" data-back-btn>
                <ArrowUpIcon/>
              </button>
              <nav
                className="flex items-center flex-wrap gap-1 text-sm text-gray-500 dark:text-gray-400 min-w-0"
                onContextMenu={(e) => { e.preventDefault(); setCrumbCtx({ x: e.clientX, y: e.clientY }); }}
              >
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
            <div className="flex items-center gap-1">
              {files.length > 0 && (
                <input type="checkbox" checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                  onChange={toggleSelectAll}
                  className="w-4 h-4 mr-1 rounded accent-blue-600" title="Select all on this page" />
              )}
              {sortBtn('name', 'Name')}{sortBtn('size', 'Size')}{sortBtn('modified', 'Date')}
            </div>
          </div>
        </div>
        </div>{/* end collapsible full header */}

        {/* Mini header — shown only when full header is collapsed */}
        {headerCollapsed && (
          <div className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
            <button onClick={handleNavigateUp} disabled={breadcrumbs.length <= 1} title="Parent folder" className="p-1 shrink-0 rounded text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 transition-colors" data-back-btn>
              <ArrowUpIcon/>
            </button>
            <nav
              className="flex items-center flex-wrap gap-1 text-sm text-gray-500 dark:text-gray-400 min-w-0 flex-1"
              onContextMenu={(e) => { e.preventDefault(); setCrumbCtx({ x: e.clientX, y: e.clientY }); }}
            >
              {breadcrumbs.map((c, i) => (
                <span key={c.id} className="flex items-center gap-1">
                  {i > 0 && <span className="text-gray-300 dark:text-gray-600">/</span>}
                  <button onClick={() => navigateTo(i)} className={i === breadcrumbs.length - 1 ? 'text-gray-800 dark:text-gray-200 font-medium text-xs' : 'hover:text-blue-600 dark:hover:text-blue-400 text-xs'}>{c.name}</button>
                </span>
              ))}
            </nav>
            <button
              onClick={() => { setHeaderCollapsed(false); scrollBlockedRef.current = Date.now() + 600; }}
              title="Show toolbar"
              className="shrink-0 p-1 rounded text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              <ArrowDownIcon/>
            </button>
          </div>
        )}

        {/* Scrollable list */}
        <div ref={listContainerRef} className="flex-1 overflow-y-auto outline-none" onScroll={handleListScroll} {...listContainerProps}>
        <div className="px-3 py-2">
          {selectedIds.size > 0 && (
            <div className="mb-3 flex items-center gap-3 px-3 py-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg text-sm">
              <span className="font-medium text-blue-700 dark:text-blue-300">{selectedIds.size} selected</span>
              <div className="flex gap-1 ml-auto">
                {!selectedHasDir && <button onClick={() => setBulkAction('copy')} title="Copy selected" className="p-1.5 rounded text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors"><CopyFilesIcon/></button>}
                <button onClick={() => setBulkAction('move')} title="Move selected" className="p-1.5 rounded text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/30 transition-colors"><MoveArrowIcon/></button>
                <button onClick={handleBulkDelete} title="Delete selected" className="p-1.5 rounded text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"><TrashIcon/></button>
                <button onClick={() => setSelectedIds(new Set())} className="px-2 py-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors">✕</button>
              </div>
            </div>
          )}
          {loading && <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">Loading…</div>}
          {error && (
            <div className="mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 text-red-600 dark:text-red-400 rounded-lg text-sm flex items-start justify-between gap-2">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 dark:hover:text-red-300 shrink-0 leading-none">✕</button>
            </div>
          )}
          {!loading && !error && files.length === 0 && <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">This folder is empty</div>}
          {!loading && files.length > 0 && viewMode === 'thumbnails' && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-3 p-1">
              {files.map(item => {
                const isDup = duplicateNames.has(item.name);
                const handleClick = () => {
                  if (item.isDir) { openFolder(item); return; }
                  if (isDup) { setDuplicateNameError(item); return; }
                  setLastOpenedId(item.itemId);
                  const s = openFileSiblings(item, files.filter(f => !duplicateNames.has(f.name)));
                  onOpenFile(item, [...breadcrumbs.map(b => b.name), item.name].join(' / '), s.siblings, s.siblingIdx);
                };
                return (
                <button key={item.itemId}
                  onClick={handleClick}
                  onContextMenu={(e) => { e.preventDefault(); setRowCtxMenu({ x: e.clientX, y: e.clientY, item }); }}
                  className={`flex flex-col items-center gap-1.5 p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-center ${!item.isDir && item.itemId === lastOpenedId ? 'ring-2 ring-blue-400 dark:ring-blue-500 bg-blue-50 dark:bg-blue-900/20' : ''}`}>
                  {!item.isDir && isImageItem(item) && !isDup
                    ? <ThumbnailImage accountId={account.id} itemId={item.itemId} size={item.size} />
                    : <div className="w-20 h-20 flex items-center justify-center text-4xl">{fileIcon(item)}</div>}
                  <span className="text-xs text-gray-700 dark:text-gray-300 truncate w-full flex items-center justify-center gap-1">
                    {isDup && <span title="Duplicate name — cannot cache content" className="text-amber-500 shrink-0">⚠</span>}
                    {item.name}
                  </span>
                </button>
                );
              })}
            </div>
          )}
          {!loading && files.length > 0 && viewMode === 'list' && (
            <div className="divide-y divide-gray-300 dark:divide-gray-700 cursor-pointer">
              {files.map((item, idx) => {
                const activeOnThis = editingId === item.itemId || renamingId === item.itemId
                  || copyingId === item.itemId || movingId === item.itemId
                  || downloadingId === item.itemId || deletingId === item.itemId;
                return (
                  <div key={item.itemId}
                    data-nav-idx={idx}
                    className={`flex items-center gap-3 py-2 px-2 rounded-lg group cursor-pointer ${idx === listFocusedRelIdx ? 'ring-1 ring-inset ring-blue-400 dark:ring-blue-500' : ''} ${selectedIds.has(item.itemId) ? 'bg-blue-50 dark:bg-blue-900/20' : item.itemId === lastOpenedId ? 'bg-amber-50 dark:bg-amber-900/10 ring-1 ring-amber-300 dark:ring-amber-700' : 'bg-white dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
                    onClick={(e) => { if ((e.target as HTMLElement).closest('button,input')) return; const isDup = duplicateNames.has(item.name); if (item.isDir) { openFolder(item); } else if (isDup) { setDuplicateNameError(item); } else { setLastOpenedId(item.itemId); const s = openFileSiblings(item, files.filter(f => !duplicateNames.has(f.name))); onOpenFile(item, [...breadcrumbs.map(b => b.name), item.name].join(' / '), s.siblings, s.siblingIdx); } }}
                    onContextMenu={(e) => { e.preventDefault(); setRowCtxMenu({ x: e.clientX, y: e.clientY, item }); }}>
                    <input type="checkbox" checked={selectedIds.has(item.itemId)} onChange={() => {}}
                      onClick={(e) => { e.stopPropagation(); if (!longPressTriggeredRef.current) handleCheck(idx, e.shiftKey, e.shiftKey && selectedIds.has(item.itemId)); }}
                      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleCheck(idx, true, selectedIds.has(item.itemId)); }}
                      onTouchStart={() => handleTouchStart(idx)} onTouchEnd={handleTouchEnd} onTouchMove={handleTouchEnd}
                      className="w-4 h-4 shrink-0 rounded accent-blue-600" />
                    <span className="text-lg select-none w-7 text-center">{fileIcon(item)}</span>
                    <div className="flex-1 min-w-0">
                      <button onClick={() => { const isDup = duplicateNames.has(item.name); if (item.isDir) { openFolder(item); } else if (isDup) { setDuplicateNameError(item); } else { setLastOpenedId(item.itemId); const s = openFileSiblings(item, files.filter(f => !duplicateNames.has(f.name))); onOpenFile(item, [...breadcrumbs.map(b => b.name), item.name].join(' / '), s.siblings, s.siblingIdx); } }}
                        className={`text-sm font-medium truncate block text-left w-full hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer ${item.isDir ? '' : 'text-gray-800 dark:text-gray-200'}`}>
                        {duplicateNames.has(item.name) && <span title="Duplicate name — cannot cache content" className="text-amber-500 mr-1">⚠</span>}
                        {item.name}
                      </button>
                      <p className="text-xs text-gray-400 dark:text-gray-500">
                        {formatSize(item.size)}{item.size != null && item.modifiedMs != null && ' · '}
                        {item.modifiedMs != null && new Date(item.modifiedMs).toLocaleDateString()}
                      </p>
                    </div>
                    <div className={`flex gap-0.5 transition-opacity shrink-0 ${activeOnThis ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                      {!item.isDir && <button onClick={() => handleEdit(item)} disabled={anyBusy} title={editingId === item.itemId ? 'Editing…' : 'Edit'} className="p-1 rounded text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/30 disabled:opacity-50 transition-colors"><PencilIcon/></button>}
                      <button onClick={() => handleRename(item)} disabled={anyBusy} title={renamingId === item.itemId ? 'Renaming…' : 'Rename'} className="p-1 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"><TypeCursorIcon/></button>
                      {!item.isDir && <button onClick={() => setFolderPicker({ fileId: item.itemId, fileName: item.name, isDir: false, action: 'copy' })} disabled={anyBusy} title={copyingId === item.itemId ? 'Copying…' : 'Copy'} className="p-1 rounded text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/30 disabled:opacity-50 transition-colors"><CopyFilesIcon/></button>}
                      <button onClick={() => setFolderPicker({ fileId: item.itemId, fileName: item.name, isDir: item.isDir, action: 'move' })} disabled={anyBusy} title={movingId === item.itemId ? 'Moving…' : 'Move'} className="p-1 rounded text-purple-600 dark:text-purple-400 hover:bg-purple-100 dark:hover:bg-purple-900/30 disabled:opacity-50 transition-colors"><MoveArrowIcon/></button>
                      {!item.isDir && <button onClick={() => handleDownload(item)} disabled={anyBusy} title={downloadingId === item.itemId ? 'Downloading…' : 'Download'} className="p-1 rounded text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 disabled:opacity-50 transition-colors"><DownloadArrowIcon/></button>}
                      <button onClick={() => handleDelete(item)} disabled={anyBusy} title={deletingId === item.itemId ? 'Deleting…' : 'Delete'} className="p-1 rounded text-red-500 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 disabled:opacity-50 transition-colors"><TrashIcon/></button>
                      {!item.isDir && shelvedIds.has(item.itemId) && <button onClick={() => setDiffItem(item)} title="Compare with original" className="p-1 rounded text-amber-500 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5"><path d="M2 3.5h4M2 7h3M2 10.5h4"/><path d="M12 3.5H8M12 7H9M12 10.5H8"/><path d="M6.5 1.5v11" strokeDasharray="2 1"/></svg></button>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        </div>{/* end scrollable list */}
        <div className="shrink-0">
          <PaginationBar ref={paginationBarRef} page={page} total={total} pageSize={PAGE_SIZE} onPage={handlePage} />
        </div>
      </div>

      {folderPicker && (
        <FolderPickerModal
          title={folderPicker.action === 'copy' ? 'Copy to…' : 'Move to…'}
          rootId="root" rootName="My Drive"
          initialFolderId={folderId}
          initialBreadcrumbs={breadcrumbs}
          onList={listItemsForPicker}
          onConfirm={handleFolderPickerConfirm}
          onClose={() => setFolderPicker(null)}
          sourceItems={folderPicker ? [{ id: folderPicker.fileId, name: folderPicker.fileName, isDir: folderPicker.isDir }] : []}
          onRename={pickerRenameForGDrive}
          onDelete={pickerDeleteForGDrive}
          onCreateFolder={pickerCreateFolderForGDrive}
          onResolvePath={pickerResolvePath}
          isMinimized={stackMinimized} minimizable={canMinimize} onMinimize={onMinimize}
          prevExplorerPath={prevExplorerPath}
        />
      )}
      {bulkAction && (
        <FolderPickerModal
          title={bulkAction === 'copy' ? `Copy ${selectedIds.size} item(s) to…` : `Move ${selectedIds.size} item(s) to…`}
          rootId="root" rootName="My Drive"
          initialFolderId={folderId}
          initialBreadcrumbs={breadcrumbs}
          onList={listItemsForPicker}
          onConfirm={handleBulkPickerConfirm}
          onClose={() => setBulkAction(null)}
          sourceItems={files.filter(f => selectedIds.has(f.itemId)).map(f => ({ id: f.itemId, name: f.name, isDir: f.isDir }))}
          onRename={pickerRenameForGDrive}
          onDelete={pickerDeleteForGDrive}
          onCreateFolder={pickerCreateFolderForGDrive}
          onResolvePath={pickerResolvePath}
          isMinimized={stackMinimized} minimizable={canMinimize} onMinimize={onMinimize}
          prevExplorerPath={prevExplorerPath}
        />
      )}
      {/* Duplicate-name error modal */}
      {duplicateNameError && (
        <Modal title="Cannot preview this file" onClose={() => setDuplicateNameError(null)} maxWidth="max-w-md">
          <div className="p-5 space-y-4">
            <p className="text-sm text-gray-700 dark:text-gray-300">
              Google Drive allows multiple items with the same name{' '}
              <strong className="font-semibold">"{duplicateNameError.name}"</strong>{' '}
              in the same folder. However, this device's file system does not allow
              duplicate file names, so we cannot cache and display this file's content.
            </p>
            <p className="text-sm text-gray-700 dark:text-gray-300">
              To view this file, please rename it so it has a unique name in its folder.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDuplicateNameError(null)}
                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors">
                Close
              </button>
              <button onClick={() => { const item = duplicateNameError; setDuplicateNameError(null); void handleRename(item); }}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
                Rename file…
              </button>
            </div>
          </div>
        </Modal>
      )}
      {showCreateTextFile && (
        <CreateTextFileModal
          existingNames={files.map(f => f.name)}
          onCreate={handleCreateTextFile}
          onClose={() => setShowCreateTextFile(false)}
        />
      )}

      {rowCtxMenu && (() => {
        const item = rowCtxMenu.item;
        const ctxBtn = "w-full text-left px-4 py-2 text-sm flex items-center gap-2 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors";
        return (
          <Popover title={item.name} onClose={() => setRowCtxMenu(null)} panelStyle={{ left: rowCtxMenu.x, top: rowCtxMenu.y }}>
            <div className="py-1 min-w-[180px]">
              {!item.isDir && <button onClick={() => { setRowCtxMenu(null); handleEdit(item); }} disabled={anyBusy} className={ctxBtn}><PencilIcon className="w-3.5 h-3.5 shrink-0 text-green-600 dark:text-green-400"/>Edit</button>}
              <button onClick={() => { setRowCtxMenu(null); handleRename(item); }} disabled={anyBusy} className={ctxBtn}><TypeCursorIcon className="w-3.5 h-3.5 shrink-0 text-gray-500 dark:text-gray-400"/>Rename</button>
              {!item.isDir && <button onClick={() => { setRowCtxMenu(null); setFolderPicker({ fileId: item.itemId, fileName: item.name, isDir: false, action: 'copy' }); }} disabled={anyBusy} className={ctxBtn}><CopyFilesIcon className="w-3.5 h-3.5 shrink-0 text-indigo-600 dark:text-indigo-400"/>Copy to…</button>}
              <button onClick={() => { setRowCtxMenu(null); setFolderPicker({ fileId: item.itemId, fileName: item.name, isDir: item.isDir, action: 'move' }); }} disabled={anyBusy} className={ctxBtn}><MoveArrowIcon className="w-3.5 h-3.5 shrink-0 text-purple-600 dark:text-purple-400"/>Move to…</button>
              {!item.isDir && <button onClick={() => { setRowCtxMenu(null); handleDownload(item); }} disabled={anyBusy} className={ctxBtn}><DownloadArrowIcon className="w-3.5 h-3.5 shrink-0 text-blue-600 dark:text-blue-400"/>Download</button>}
              <button onClick={() => { setRowCtxMenu(null); handleDelete(item); }} disabled={anyBusy} className={ctxBtn}><TrashIcon className="w-3.5 h-3.5 shrink-0 text-red-500 dark:text-red-400"/>Delete</button>
              <div className="border-t border-gray-100 dark:border-gray-700 my-1"/>
              <button onClick={() => { setRowCtxMenu(null); openAncestorsForItem(item); }} className={ctxBtn}><AncestorsIcon className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-gray-500"/>Show ancestors</button>
            </div>
          </Popover>
        );
      })()}

      {crumbCtx && (
        <Popover title="Location" onClose={() => setCrumbCtx(null)} panelStyle={{ left: crumbCtx.x, top: crumbCtx.y }}>
          <div className="py-1 min-w-[160px]">
            <button onClick={() => { setCrumbCtx(null); setAncestorsConfig({ entries: breadcrumbs.map(b => ({ name: b.name, navigable: true })), onNavigate: (i) => { setAncestorsConfig(null); navigateTo(i); } }); }} className="w-full text-left px-4 py-2 text-sm flex items-center gap-2 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"><AncestorsIcon className="w-3.5 h-3.5 shrink-0"/>Show ancestors</button>
            <button onClick={() => { setCrumbCtx(null); setShowChangePath(true); }} className="w-full text-left px-4 py-2 text-sm flex items-center gap-2 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">📂 Change path</button>
          </div>
        </Popover>
      )}

      {ancestorsConfig && (
        <BreadcrumbAncestorsModal entries={ancestorsConfig.entries} onNavigate={ancestorsConfig.onNavigate} onClose={() => setAncestorsConfig(null)} />
      )}
      {showChangePath && (
        <BreadcrumbChangePathModal
          defaultValue={breadcrumbs.slice(1).map(b => b.name).join('/')}
          placeholder="e.g. Documents/Projects"
          onNavigate={handleChangePath}
          onClose={() => setShowChangePath(false)}
        />
      )}
    </>
  );
}
