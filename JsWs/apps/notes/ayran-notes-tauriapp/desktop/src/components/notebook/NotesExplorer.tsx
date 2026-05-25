import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readFile, mkdir, copyFile, rename as fsRename, remove as fsRemove } from '@tauri-apps/plugin-fs';
import { marked } from 'marked';
import type { StoredAccount, CachedItem, FolderPage } from '../../types';
import { getAccount } from '../../lib/account-store';
import nc from '../../notesConfig.json';
import config from '../../config.json';
import {
  computeShortFolderName, computeFullFolderName, computeFullNamePart,
  computeMarkdownFileName, computeHtmlFileName, computePdfFileName,
  extractDigits, extractDigitsFromFullFolderName,
  initialMarkdownContent, noteJsonContent, addNoteToChildrenJson, updateNoteUpdatedAt,
  toAbsPath, joinRelPath,
  isValidNoteNumber, nextDigitsInInterval,
} from '../../lib/notes-utils';
import { extractFirstH1 } from '../../lib/markdown-utils';
import FileViewer from '../explorer/FileViewer';
import PaginationBar, { type PaginationBarHandle } from '../explorer/PaginationBar';
import Popover from '../common/Popover';
import Modal from '../common/Modal';
import { useListKeyNav } from '../../hooks/useListKeyNav';

const PAGE_SIZE = config.defaultListPageSize;

// ── Types ────────────────────────────────────────────────────────────────────

interface NoteMetadata {
  Title: string;
  CreatedAt: string;
  UpdatedAt?: string;
}
interface NoteChildrenJson {
  ChildNotes: Record<string, NoteMetadata>;
}
interface NoteEntry {
  digits: string;
  shortFolderName: string;
  shortFolderId: string | null;
  title: string;
  createdAt: string;
  updatedAt?: string;
}
interface BreadcrumbEntry {
  folderId: string;
  label: string;
  /** Digits of this note within its parent's [note-children].json. Absent at root level. */
  digits?: string;
  /** [note-children].json item ID that was active at the PARENT level when we navigated into this note. */
  parentChildrenJsonId?: string | null;
}
interface ViewingFile {
  item: CachedItem;
  displayPath: string;
}
interface RepairPair {
  digits: string;
  shortFolderId: string;
  hasFullFolder: boolean;
}

// ── Props ────────────────────────────────────────────────────────────────────

interface Props {
  accountId: string;
  notebookParentId: string;
  /** Relative cloud path of the notes folder (e.g. "Drive/Notes"). Used to
   *  seed path_index so open_file caches files in the correct hierarchy. */
  notebookFolderRelPath?: string;
  instanceKey?: string;
  onDisplayNameChange?: (name: string) => void;
  onViewingFileChange?: (isViewing: boolean) => void;
  onQuickActions?: () => void;
}

// ── Icons ────────────────────────────────────────────────────────────────────

function PlusIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="w-3.5 h-3.5">
      <path d="M7 2v10M2 7h10"/>
    </svg>
  );
}


function QuickActionsIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
      <path d="M8 1L4 8h5l-3 5"/>
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
      <path d="M9.5 2.5l2 2L4 12H2v-2L9.5 2.5z"/>
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
      <path d="M9 2L4 7l5 5"/>
    </svg>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export default function NotesExplorer({ accountId, notebookParentId, notebookFolderRelPath, instanceKey, onDisplayNameChange, onViewingFileChange, onQuickActions }: Props) {
  const [account, setAccount] = useState<StoredAccount | null>(null);
  const [acctLoading, setAcctLoading] = useState(true);
  const [acctError, setAcctError] = useState<string | null>(null);

  const navKey = `notes-explorer-nav-${accountId}${instanceKey ? `-${instanceKey}` : ''}`;
  const savedNav = useMemo(() => {
    try {
      const raw = localStorage.getItem(navKey);
      return raw ? (JSON.parse(raw) as { breadcrumbs: BreadcrumbEntry[]; viewingFile?: ViewingFile | null }) : null;
    } catch { return null; }
  }, [navKey]);

  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbEntry[]>(
    savedNav?.breadcrumbs ?? [{ folderId: notebookParentId, label: 'Notes' }],
  );
  const [noteEntries, setNoteEntries] = useState<NoteEntry[]>([]);
  const [noteChildrenJsonId, setNoteChildrenJsonId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const [viewingFile, setViewingFile] = useState<ViewingFile | null>(savedNav?.viewingFile ?? null);

  // ── Repair state (rebuild missing [note-children].json) ───────────────────
  const [indexMissing, setIndexMissing] = useState(false);
  const [repairPairs, setRepairPairs] = useState<RepairPair[]>([]);
  const [repairing, setRepairing] = useState(false);
  const [repairProgress, setRepairProgress] = useState<string | null>(null);
  const [repairNoteErrors, setRepairNoteErrors] = useState<string[]>([]);

  // ── Rename state ─────────────────────────────────────────────────────────
  const [renamingNote, setRenamingNote] = useState<NoteEntry | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [noteCtxMenu, setNoteCtxMenu] = useState<{ note: NoteEntry; x: number; y: number } | null>(null);

  // ── Delete state ──────────────────────────────────────────────────────────
  const [deletingNote, setDeletingNote] = useState<NoteEntry | null>(null);
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ── Create-note form state ────────────────────────────────────────────────
  const [refreshMenuOpen, setRefreshMenuOpen] = useState(false);
  const [cacheCleared, setCacheCleared] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Index selection: either an interval index (0-3) or custom
  const [createIntervalIdx, setCreateIntervalIdx] = useState(0);
  const [showIntervalPicker, setShowIntervalPicker] = useState(false);
  const [useCustomIndex, setUseCustomIndex] = useState(false);
  const [customIndexStr, setCustomIndexStr] = useState('');
  const [customIndexError, setCustomIndexError] = useState<string | null>(null);

  const intervalPickerRef = useRef<HTMLDivElement>(null);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    try { localStorage.setItem(navKey, JSON.stringify({ breadcrumbs, viewingFile })); } catch { /* non-fatal */ }
  }, [navKey, breadcrumbs, viewingFile]);

  // Close interval picker on outside click.
  useEffect(() => {
    if (!showIntervalPicker) return;
    const handler = (e: MouseEvent) => {
      if (intervalPickerRef.current && !intervalPickerRef.current.contains(e.target as Node)) {
        setShowIntervalPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showIntervalPicker]);

  const currentFolderId = breadcrumbs[breadcrumbs.length - 1]?.folderId ?? notebookParentId;

  // ── Index helpers ─────────────────────────────────────────────────────────

  const nextIndexForInterval = (idx: number): string | null => {
    const { lo, hi } = nc.noteIntervals[idx];
    return nextDigitsInInterval(noteEntries.map((e) => e.digits), lo, hi);
  };

  const effectiveCreateDigits = (): string | null => {
    if (useCustomIndex) {
      const n = parseInt(customIndexStr, 10);
      if (isNaN(n) || !isValidNoteNumber(n)) return null;
      if (noteEntries.some((e) => parseInt(e.digits, 10) === n)) return null;
      return String(n);
    }
    return nextIndexForInterval(createIntervalIdx);
  };

  const openCreateForm = () => {
    // Default to "plain notes" (last interval); fall back to first non-full interval.
    const existingDigits = noteEntries.map((e) => e.digits);
    let defaultIdx = nc.noteIntervals.length - 1;
    if (nextDigitsInInterval(existingDigits, nc.noteIntervals[defaultIdx].lo, nc.noteIntervals[defaultIdx].hi) === null) {
      for (let i = 0; i < nc.noteIntervals.length; i++) {
        const { lo, hi } = nc.noteIntervals[i];
        if (nextDigitsInInterval(existingDigits, lo, hi) !== null) { defaultIdx = i; break; }
      }
    }
    setCreateIntervalIdx(defaultIdx);
    setShowIntervalPicker(false);
    setUseCustomIndex(false);
    setCustomIndexStr('');
    setCustomIndexError(null);
    setCreateTitle('');
    setCreateError(null);
    setShowCreate(true);
  };

  // ── Load account ──────────────────────────────────────────────────────────

  useEffect(() => {
    setAcctLoading(true);
    getAccount(accountId)
      .then((a) => { if (isMountedRef.current) { if (!a) setAcctError('Account not found.'); else setAccount(a); } })
      .catch((e) => { if (isMountedRef.current) setAcctError(String(e)); })
      .finally(() => { if (isMountedRef.current) setAcctLoading(false); });
  }, [accountId]);


  // ── Notify parent of display name ─────────────────────────────────────────

  const onDisplayNameChangeRef = useRef(onDisplayNameChange);
  onDisplayNameChangeRef.current = onDisplayNameChange;

  const onViewingFileChangeRef = useRef(onViewingFileChange);
  onViewingFileChangeRef.current = onViewingFileChange;

  useEffect(() => {
    onDisplayNameChangeRef.current?.(
      viewingFile
        ? (viewingFile.displayPath || viewingFile.item.name)
        : breadcrumbs[breadcrumbs.length - 1]?.label ?? 'Notes Explorer'
    );
    onViewingFileChangeRef.current?.(!!viewingFile);
  }, [breadcrumbs, viewingFile]);

  // ── Load notes at current folder ──────────────────────────────────────────

  const loadNotes = useCallback(async (folderId: string, force = false) => {
    if (!account) return;
    if (!isMountedRef.current) return;
    setLoading(true);
    setError(null);
    setNoteEntries([]);
    setNoteChildrenJsonId(null);
    setPage(0);
    setIndexMissing(false);
    setRepairPairs([]);
    setRepairNoteErrors([]);
    try {
      // 1. List folder to populate SQLite cache with the latest items
      //    (including any files just created by repair or create_text_file).
      await invoke('list_folder', { accountId: account.id, parentId: folderId, force });

      // 2. Seed path_index AFTER listing so that every item now in folder_items —
      //    including ones just created — gets a correct cloud-mirrored cache path.
      //    Also evicts stale content_cache entries so re-downloads go to the right place.
      if (folderId === notebookParentId && notebookFolderRelPath !== undefined) {
        const folderPath = notebookFolderRelPath.replace(/^\/+|\/+$/g, '');
        await invoke('register_path_in_index', {
          accountId: account.id, itemId: notebookParentId, path: folderPath,
        }).catch(() => {});
      }

      // 2. Single paginated scan — find [note-children].json by exact name and
      //    build the shortFolderMap in the same pass (avoids search-filter quirks).
      const newShortFolderMap = new Map<string, string>(); // digits → itemId
      const fullFolderDigits = new Set<string>();           // digits that have a full folder
      let jsonItem: CachedItem | null = null;
      let pg = 0;
      while (true) {
        const r = await invoke<FolderPage>('query_folder_items', {
          accountId: account.id, parentId: folderId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          search: null as any, sortBy: 'name', ascending: true,
          page: pg, pageSize: PAGE_SIZE,
        });
        for (const item of r.items) {
          if (!item.isDir && item.name === nc.noteChildrenJsonFileName) {
            jsonItem = item;
          } else if (item.isDir) {
            const shortDigits = extractDigits(item.name);
            if (shortDigits !== null) {
              newShortFolderMap.set(shortDigits, item.itemId);
            } else {
              const fullDigits = extractDigitsFromFullFolderName(item.name);
              if (fullDigits !== null) fullFolderDigits.add(fullDigits);
            }
          }
        }
        if (r.items.length < PAGE_SIZE) break;
        pg++;
      }
      if (!isMountedRef.current) return;

      if (!jsonItem) {
        const pairs: RepairPair[] = [];
        for (const [digits, shortFolderId] of newShortFolderMap.entries()) {
          if (isValidNoteNumber(parseInt(digits, 10))) {
            pairs.push({ digits, shortFolderId, hasFullFolder: fullFolderDigits.has(digits) });
          }
        }
        setRepairPairs(pairs);
        setIndexMissing(true);
        setError(`Note index file (${nc.noteChildrenJsonFileName}) not found in this folder.`);
        return;
      }
      setNoteChildrenJsonId(jsonItem.itemId);

      // 3. Download and parse [note-children].json.
      // On hard refresh, evict the local content cache entry first so open_file
      // unconditionally re-downloads from the provider.
      if (force) {
        await invoke('delete_cached_file', { accountId: account.id, itemId: jsonItem.itemId }).catch(() => {});
      }
      const localPath = await invoke<string>('open_file', {
        accountId: account.id, itemId: jsonItem.itemId, force,
        itemName: nc.noteChildrenJsonFileName,
      });
      const bytes = await readFile(localPath);
      const data = JSON.parse(new TextDecoder().decode(bytes)) as NoteChildrenJson;

      // 4. Build sorted NoteEntry list.
      const entries: NoteEntry[] = Object.entries(data.ChildNotes ?? {})
        .map(([digits, meta]) => ({
          digits,
          shortFolderName: computeShortFolderName(digits),
          shortFolderId: newShortFolderMap.get(digits) ?? null,
          title: meta.Title,
          createdAt: meta.CreatedAt,
          updatedAt: meta.UpdatedAt,
        }))
        .sort((a, b) => parseInt(a.digits, 10) - parseInt(b.digits, 10));

      if (isMountedRef.current) setNoteEntries(entries);
    } catch (e) {
      if (isMountedRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [account]);

  useEffect(() => {
    if (account) void loadNotes(currentFolderId);
  }, [account, currentFolderId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Repair: rebuild missing [note-children].json ──────────────────────────

  const repairIndex = useCallback(async () => {
    if (!account) return;
    setRepairing(true);
    setRepairProgress(null);
    setRepairNoteErrors([]);

    const entries: Array<{ digits: string; title: string; createdAt: string }> = [];
    const errors: string[] = [];

    for (const { digits, shortFolderId } of repairPairs) {
      setRepairProgress(`Scanning note ${digits}…`);
      try {
        await invoke('list_folder', { accountId: account.id, parentId: shortFolderId, force: false });

        const noteJsonItem = await invoke<CachedItem | null>('query_item_by_name', {
          accountId: account.id, parentId: shortFolderId, name: nc.noteJsonFileName,
        });

        let title: string;
        let createdAt: string;

        if (noteJsonItem) {
          const path = await invoke<string>('open_file', {
            accountId: account.id, itemId: noteJsonItem.itemId, force: false,
            itemName: nc.noteJsonFileName,
          });
          const data = JSON.parse(new TextDecoder().decode(await readFile(path))) as { Title?: string; CreatedAt?: string };
          title = data.Title ?? `Note ${digits}`;
          createdAt = data.CreatedAt ?? new Date().toISOString();
        } else {
          // Look for the single markdown file in the short folder.
          const r = await invoke<FolderPage>('query_folder_items', {
            accountId: account.id, parentId: shortFolderId,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            search: null as any, sortBy: 'name', ascending: true,
            page: 0, pageSize: 200,
          });
          const mdItems = r.items.filter(
            (i) => !i.isDir
              && i.name.endsWith(nc.noteMarkdownSuffix)
              && !i.name.endsWith(nc.noteHtmlSuffix)
              && !i.name.endsWith(nc.notePdfSuffix),
          );

          if (mdItems.length === 0) {
            errors.push(`Note ${digits}: no [note].json or markdown file found.`);
            continue;
          }
          if (mdItems.length > 1) {
            errors.push(`Note ${digits}: ${mdItems.length} markdown files found — cannot determine which to use.`);
            continue;
          }

          const mdItem = mdItems[0];
          const mdPath = await invoke<string>('open_file', {
            accountId: account.id, itemId: mdItem.itemId, force: false, itemName: mdItem.name,
          });
          const mdContent = new TextDecoder().decode(await readFile(mdPath));
          const h1 = await extractFirstH1(mdContent);
          if (!h1) errors.push(`Note ${digits}: no h1 heading found — using folder name as title.`);
          title = h1 ?? `Note ${digits}`;
          createdAt = new Date().toISOString();

          await invoke('create_text_file', {
            accountId: account.id, parentId: shortFolderId,
            filename: nc.noteJsonFileName, content: noteJsonContent(title),
          });
        }

        entries.push({ digits, title, createdAt });
      } catch (e) {
        errors.push(`Note ${digits}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    setRepairNoteErrors(errors);

    const childNotes: Record<string, { Title: string; CreatedAt: string }> = {};
    for (const { digits, title, createdAt } of entries) {
      childNotes[digits] = { Title: title, CreatedAt: createdAt };
    }
    const content = JSON.stringify({ ChildNotes: childNotes }, null, 2);

    try {
      await invoke('create_text_file', {
        accountId: account.id, parentId: currentFolderId,
        filename: nc.noteChildrenJsonFileName, content,
      });
      setRepairProgress(null);
      setRepairing(false);
      setError(null);
      setIndexMissing(false);
      await loadNotes(currentFolderId, false);
    } catch (e) {
      setRepairProgress(null);
      setRepairing(false);
      setError(`Failed to create index: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [account, currentFolderId, repairPairs, loadNotes]);

  // ── Rename note ───────────────────────────────────────────────────────────

  const startDelete = useCallback((note: NoteEntry) => {
    setDeletingNote(note);
    setDeleteError(null);
  }, []);

  const performDeleteNote = useCallback(async (note: NoteEntry) => {
    if (!account || !note.shortFolderId) throw new Error('Cannot delete: short folder not found');

    // Delete short folder and all its contents.
    try {
      if (account.provider === 'filen') {
        await invoke('filen_trash_directory', { accountId: account.id, uuid: note.shortFolderId });
      } else if (account.provider === 'google-drive') {
        await invoke('gdrive_delete_file', { accountId: account.id, fileId: note.shortFolderId });
      } else if (account.provider === 'local-fs') {
        await fsRemove(toAbsPath(account.path ?? '', note.shortFolderId), { recursive: true });
      }
      await invoke('invalidate_folder_cache', { accountId: account.id, parentId: note.shortFolderId }).catch(() => {});
    } catch { /* non-fatal if already gone */ }

    // Delete full folder (e.g. "110-Note Title").
    try {
      const fullFolderName = computeFullFolderName(note.digits, note.title);
      const fullFolderItem = await invoke<CachedItem | null>('query_item_by_name', {
        accountId: account.id, parentId: currentFolderId, name: fullFolderName,
      });
      if (fullFolderItem) {
        if (account.provider === 'filen') {
          await invoke('filen_trash_directory', { accountId: account.id, uuid: fullFolderItem.itemId });
        } else if (account.provider === 'google-drive') {
          await invoke('gdrive_delete_file', { accountId: account.id, fileId: fullFolderItem.itemId });
        } else if (account.provider === 'local-fs') {
          await fsRemove(toAbsPath(account.path ?? '', joinRelPath(currentFolderId, fullFolderName)), { recursive: true });
        }
      }
    } catch { /* non-fatal */ }

    // Remove the note from parent [note-children].json.
    if (noteChildrenJsonId) {
      try {
        const path = await invoke<string>('open_file', {
          accountId: account.id, itemId: noteChildrenJsonId, force: false, itemName: nc.noteChildrenJsonFileName,
        });
        const data = JSON.parse(new TextDecoder().decode(await readFile(path))) as NoteChildrenJson;
        delete data.ChildNotes[note.digits];
        await invoke('save_text_file', {
          accountId: account.id, itemId: noteChildrenJsonId, parentId: currentFolderId,
          content: JSON.stringify(data, null, 2), itemName: nc.noteChildrenJsonFileName,
        });
      } catch { /* non-fatal */ }
    }

    // Update local state.
    setNoteEntries((prev) => prev.filter((e) => e.digits !== note.digits));
    setViewingFile((prev) => (prev?.item.parentId === note.shortFolderId ? null : prev));
  }, [account, noteChildrenJsonId, currentFolderId]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deletingNote || deleteConfirming) return;
    setDeleteConfirming(true);
    setDeleteError(null);
    try {
      await performDeleteNote(deletingNote);
      setDeletingNote(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleteConfirming(false);
    }
  }, [deletingNote, deleteConfirming, performDeleteNote]);

  const startRename = useCallback((note: NoteEntry) => {
    setRenamingNote(note);
    setRenameTitle(note.title);
    setRenameError(null);
  }, []);

  const performRenameNote = useCallback(async (
    note: NoteEntry,
    newTitle: string,
    currentMdContent?: string,
  ): Promise<string> => {
    if (!account || !note.shortFolderId) throw new Error('Cannot rename: short folder not found');

    const newFullNamePart = computeFullNamePart(newTitle);
    const newMarkdownFileName = computeMarkdownFileName(newFullNamePart);
    const newHtmlFileName = computeHtmlFileName(newFullNamePart);
    const newPdfFileName = computePdfFileName(newFullNamePart);

    // List the short folder to get up-to-date file list.
    await invoke('list_folder', { accountId: account.id, parentId: note.shortFolderId, force: false });
    const r = await invoke<FolderPage>('query_folder_items', {
      accountId: account.id, parentId: note.shortFolderId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      search: null as any, sortBy: 'name', ascending: true, page: 0, pageSize: 200,
    });
    const allFiles = r.items.filter((i) => !i.isDir);
    const oldMarkdownFiles = allFiles.filter((i) =>
      i.name.endsWith(nc.noteMarkdownSuffix)
      && !i.name.endsWith(nc.noteHtmlSuffix)
      && !i.name.endsWith(nc.notePdfSuffix),
    );
    const oldHtmlPdfFiles = allFiles.filter((i) =>
      i.name.endsWith(nc.noteHtmlSuffix) || i.name.endsWith(nc.notePdfSuffix),
    );
    const markdownFile = oldMarkdownFiles[0] ?? null;
    const noteJsonFileItem = allFiles.find((i) => i.name === nc.noteJsonFileName);

    // Get markdown content. For a manual rename (no currentMdContent), also update
    // the h1 heading to match the new title.
    let mdContent = currentMdContent;
    if (mdContent === undefined) {
      if (!markdownFile) throw new Error('Markdown file not found in note folder');
      const path = await invoke<string>('open_file', {
        accountId: account.id, itemId: markdownFile.itemId, force: false, itemName: markdownFile.name,
      });
      const raw = new TextDecoder().decode(await readFile(path));
      const escaped = newTitle.replace(/[\\`*_[\]]/g, '\\$&');
      mdContent = /^#\s+.+/m.test(raw)
        ? raw.replace(/^#\s+.+/m, `# ${escaped}`)
        : `# ${escaped}\n${raw}`;
    }

    // Create new files first so the note is never left without content if an
    // error occurs mid-way. Old files are deleted afterwards by their original IDs.
    const newMarkdownItemId = await invoke<string>('create_text_file', {
      accountId: account.id, parentId: note.shortFolderId,
      filename: newMarkdownFileName, content: mdContent ?? '',
    });

    // Regenerate HTML and PDF from the new content.
    if (mdContent) {
      const htmlContent = String(await marked.parse(mdContent));
      const hasExtraContent = mdContent.replace(/^#[^\n]*\n?/, '').trim().length > 0;

      if (nc.generatePdf) {
        try {
          const tempPdfPath = await invoke<string>('generate_note_pdf', { htmlContent, filename: newPdfFileName });
          const sep = tempPdfPath.includes('\\') ? '\\' : '/';
          const tempPdfDir = tempPdfPath.substring(0, tempPdfPath.lastIndexOf(sep));
          try {
            if (account.provider === 'filen') {
              await invoke('filen_upload_file', { accountId: account.id, parentUuid: note.shortFolderId, filePath: tempPdfPath });
            } else if (account.provider === 'google-drive') {
              await invoke('gdrive_upload_file', { accountId: account.id, folderId: note.shortFolderId, filePath: tempPdfPath });
            } else if (account.provider === 'local-fs') {
              await copyFile(tempPdfPath, toAbsPath(account.path ?? '', joinRelPath(note.shortFolderId, newPdfFileName)));
            }
          } finally {
            void invoke('remove_temp_dir', { path: tempPdfDir });
          }
        } catch { /* non-fatal */ }
      }

      if (hasExtraContent) {
        await invoke('create_text_file', {
          accountId: account.id, parentId: note.shortFolderId,
          filename: newHtmlFileName, content: htmlContent,
        });
      }
    }

    // Delete old markdown, HTML, and PDF files by their original IDs.
    for (const f of [...oldMarkdownFiles, ...oldHtmlPdfFiles]) {
      try {
        if (account.provider === 'filen') {
          await invoke('filen_trash_file', { accountId: account.id, uuid: f.itemId });
        } else if (account.provider === 'google-drive') {
          await invoke('gdrive_delete_file', { accountId: account.id, fileId: f.itemId });
        } else if (account.provider === 'local-fs') {
          await fsRemove(toAbsPath(account.path ?? '', joinRelPath(note.shortFolderId, f.name)));
        }
        await invoke('delete_cached_file', { accountId: account.id, itemId: f.itemId }).catch(() => {});
      } catch { /* non-fatal */ }
    }

    // Update [note].json with the new title.
    const updatedAt = new Date().toISOString();
    if (noteJsonFileItem) {
      try {
        const path = await invoke<string>('open_file', {
          accountId: account.id, itemId: noteJsonFileItem.itemId, force: false, itemName: nc.noteJsonFileName,
        });
        const existing = JSON.parse(new TextDecoder().decode(await readFile(path))) as { Title: string; CreatedAt: string };
        await invoke('save_text_file', {
          accountId: account.id, itemId: noteJsonFileItem.itemId, parentId: note.shortFolderId,
          content: JSON.stringify({ ...existing, Title: newTitle, UpdatedAt: updatedAt }, null, 2),
          itemName: nc.noteJsonFileName,
        });
      } catch { /* non-fatal */ }
    } else {
      await invoke('create_text_file', {
        accountId: account.id, parentId: note.shortFolderId,
        filename: nc.noteJsonFileName, content: noteJsonContent(newTitle),
      }).catch(() => {});
    }

    // Update the parent [note-children].json.
    if (noteChildrenJsonId) {
      try {
        const path = await invoke<string>('open_file', {
          accountId: account.id, itemId: noteChildrenJsonId, force: false, itemName: nc.noteChildrenJsonFileName,
        });
        const data = JSON.parse(new TextDecoder().decode(await readFile(path))) as {
          ChildNotes: Record<string, { Title: string; CreatedAt: string; UpdatedAt?: string }>;
        };
        if (data.ChildNotes?.[note.digits]) {
          data.ChildNotes[note.digits] = { ...data.ChildNotes[note.digits], Title: newTitle, UpdatedAt: updatedAt };
        }
        await invoke('save_text_file', {
          accountId: account.id, itemId: noteChildrenJsonId, parentId: currentFolderId,
          content: JSON.stringify(data, null, 2), itemName: nc.noteChildrenJsonFileName,
        });
      } catch { /* non-fatal */ }
    }

    // Rename the full folder (e.g. "110-Old Title" → "110-New Title") in the parent.
    const oldFullFolderName = computeFullFolderName(note.digits, note.title);
    const newFullFolderName = computeFullFolderName(note.digits, newTitle);
    if (oldFullFolderName !== newFullFolderName) {
      try {
        const fullFolderItem = await invoke<CachedItem | null>('query_item_by_name', {
          accountId: account.id, parentId: currentFolderId, name: oldFullFolderName,
        });
        if (fullFolderItem) {
          if (account.provider === 'filen') {
            await invoke('filen_rename_directory', { accountId: account.id, uuid: fullFolderItem.itemId, newName: newFullFolderName });
          } else if (account.provider === 'google-drive') {
            await invoke('gdrive_rename', { accountId: account.id, fileId: fullFolderItem.itemId, newName: newFullFolderName });
          } else if (account.provider === 'local-fs') {
            await fsRename(
              toAbsPath(account.path ?? '', joinRelPath(currentFolderId, oldFullFolderName)),
              toAbsPath(account.path ?? '', joinRelPath(currentFolderId, newFullFolderName)),
            );
          }
          await invoke('rename_cached_item', { accountId: account.id, itemId: fullFolderItem.itemId, newName: newFullFolderName }).catch(() => {});
        }
      } catch { /* non-fatal */ }
    }

    // Force-refresh the short folder cache so next open reads fresh data from the cloud.
    await invoke('list_folder', { accountId: account.id, parentId: note.shortFolderId, force: true }).catch(() => {});

    // Update local UI state.
    setNoteEntries((prev) => prev.map((e) =>
      e.digits === note.digits ? { ...e, title: newTitle, updatedAt } : e,
    ));
    setViewingFile((prev) => {
      if (!prev || prev.item.parentId !== note.shortFolderId) return prev;
      return { item: { ...prev.item, itemId: newMarkdownItemId, name: newMarkdownFileName }, displayPath: newTitle };
    });
    return newMarkdownItemId;
  }, [account, noteChildrenJsonId, currentFolderId]);

  // Stable refs so handleAfterSave always reads the latest values even when
  // noteEntries or viewingFile weren't populated at the time of the last render.
  const noteEntriesRef = useRef(noteEntries);
  noteEntriesRef.current = noteEntries;
  const viewingFileRef = useRef(viewingFile);
  viewingFileRef.current = viewingFile;
  const performRenameNoteRef = useRef(performRenameNote);
  performRenameNoteRef.current = performRenameNote;

  const handleBeforeSave = useCallback(async (content: string): Promise<string | null> => {
    const vf = viewingFileRef.current;
    if (!vf) return null;
    const note = noteEntriesRef.current.find((e) => e.shortFolderId === vf.item.parentId) ?? null;
    if (!note) return null;
    const m = /^#\s+(.+)$/m.exec(content);
    const newTitle = m ? m[1].trim() : '';
    const oldTitle = (vf.displayPath ?? '').trim();
    if (!newTitle || newTitle === oldTitle) return null;
    return await performRenameNoteRef.current(note, newTitle, content);
  }, []);

  const handleRename = useCallback(async () => {
    if (!renamingNote || !renameTitle.trim() || renameSaving) return;
    setRenameSaving(true);
    setRenameError(null);
    try {
      await performRenameNote(renamingNote, renameTitle.trim());
      setRenamingNote(null);
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : String(e));
    } finally {
      setRenameSaving(false);
    }
  }, [renamingNote, renameTitle, renameSaving, performRenameNote]);

  // ── Folder creation (provider-agnostic) ───────────────────────────────────

  const createFolderInParent = useCallback(async (parentId: string, folderName: string): Promise<string> => {
    if (!account) throw new Error('No account');
    switch (account.provider) {
      case 'filen':
        return await invoke<string>('filen_create_directory', {
          accountId: account.id, parentUuid: parentId, name: folderName,
        });
      case 'google-drive':
        return await invoke<string>('gdrive_create_folder', {
          accountId: account.id, parentId, name: folderName,
        });
      case 'local-fs': {
        const relPath = joinRelPath(parentId, folderName);
        await mkdir(toAbsPath(account.path ?? '', relPath));
        return relPath;
      }
      default:
        throw new Error(`Unsupported provider: ${account.provider}`);
    }
  }, [account]);

  // ── Create note ───────────────────────────────────────────────────────────

  const createNote = async () => {
    const title = createTitle.trim();
    if (!title || !account) return;

    // Validate index.
    if (useCustomIndex) {
      const n = parseInt(customIndexStr, 10);
      if (isNaN(n) || !isValidNoteNumber(n)) {
        setCustomIndexError('Index must fall within a valid interval (110–199, 200–299, 300–399, 400–999).');
        return;
      }
      if (noteEntries.some((e) => parseInt(e.digits, 10) === n)) {
        setCustomIndexError('This index is already in use.');
        return;
      }
    }

    const digits = effectiveCreateDigits();
    if (!digits) {
      setCreateError('No available index. Choose a different interval or enter a custom index.');
      return;
    }

    setCreating(true);
    setCreateError(null);
    setCustomIndexError(null);
    try {
      // Read existing [note-children].json for up-to-date data.
      let existingContent: string | null = null;
      if (noteChildrenJsonId) {
        try {
          const path = await invoke<string>('open_file', {
            accountId: account.id, itemId: noteChildrenJsonId, force: true,
            itemName: nc.noteChildrenJsonFileName,
          });
          existingContent = new TextDecoder().decode(await readFile(path));
        } catch { /* empty on first note */ }
      }

      const shortFolderName = computeShortFolderName(digits);
      const fullNamePart = computeFullNamePart(title);
      const fullFolderName = computeFullFolderName(digits, title);
      const markdownFileName = computeMarkdownFileName(fullNamePart);
      const htmlFileName = computeHtmlFileName(fullNamePart);
      const pdfFileName = computePdfFileName(fullNamePart);

      // Create the two folders.
      const shortFolderId = await createFolderInParent(currentFolderId, shortFolderName);
      const fullFolderId = await createFolderInParent(currentFolderId, fullFolderName);

      // Create .keep in the full folder.
      await invoke('create_text_file', {
        accountId: account.id, parentId: fullFolderId,
        filename: nc.keepFileName, content: nc.keepFileContent,
      });

      // Create markdown in the short folder.
      await invoke('create_text_file', {
        accountId: account.id, parentId: shortFolderId,
        filename: markdownFileName, content: initialMarkdownContent(title),
      });

      // Create [note].json in the short folder.
      await invoke('create_text_file', {
        accountId: account.id, parentId: shortFolderId,
        filename: nc.noteJsonFileName, content: noteJsonContent(title),
      });

      // Create empty [note-children].json so the note is immediately navigable.
      await invoke('create_text_file', {
        accountId: account.id, parentId: shortFolderId,
        filename: nc.noteChildrenJsonFileName,
        content: JSON.stringify({ ChildNotes: {} }, null, 2),
      });

      // Generate HTML in memory, then PDF (always), then write HTML file only
      // when there is content beyond the title line.
      const mdContent = initialMarkdownContent(title);
      const htmlContent = String(await marked.parse(mdContent));
      const hasExtraContent = mdContent.replace(/^#[^\n]*\n?/, '').trim().length > 0;

      if (nc.generatePdf) {
        try {
          const tempPdfPath = await invoke<string>('generate_note_pdf', { htmlContent, filename: pdfFileName });
          const sep = tempPdfPath.includes('\\') ? '\\' : '/';
          const tempPdfDir = tempPdfPath.substring(0, tempPdfPath.lastIndexOf(sep));
          try {
            if (account.provider === 'filen') {
              await invoke('filen_upload_file', { accountId: account.id, parentUuid: shortFolderId, filePath: tempPdfPath });
            } else if (account.provider === 'google-drive') {
              await invoke('gdrive_upload_file', { accountId: account.id, folderId: shortFolderId, filePath: tempPdfPath });
            } else if (account.provider === 'local-fs') {
              const targetPath = toAbsPath(account.path ?? '', joinRelPath(shortFolderId, pdfFileName));
              await copyFile(tempPdfPath, targetPath);
            }
          } finally {
            void invoke('remove_temp_dir', { path: tempPdfDir });
          }
        } catch { /* PDF generation is non-fatal */ }
      }

      if (hasExtraContent) {
        await invoke('create_text_file', {
          accountId: account.id, parentId: shortFolderId,
          filename: htmlFileName, content: htmlContent,
        });
      }

      // Create / update [note-children].json in the current folder.
      const newChildrenContent = addNoteToChildrenJson(existingContent, digits, title);
      let newChildrenJsonId: string;
      if (noteChildrenJsonId) {
        newChildrenJsonId = await invoke<string>('save_text_file', {
          accountId: account.id, itemId: noteChildrenJsonId,
          parentId: currentFolderId, content: newChildrenContent,
          itemName: nc.noteChildrenJsonFileName,
        });
      } else {
        newChildrenJsonId = await invoke<string>('create_text_file', {
          accountId: account.id, parentId: currentFolderId,
          filename: nc.noteChildrenJsonFileName, content: newChildrenContent,
        });
      }

      // If we are inside a parent note, update its UpdatedAt in the grandparent's JSON.
      const currentCrumb = breadcrumbs[breadcrumbs.length - 1];
      if (currentCrumb.digits && currentCrumb.parentChildrenJsonId) {
        try {
          const parentJsonPath = await invoke<string>('open_file', {
            accountId: account.id, itemId: currentCrumb.parentChildrenJsonId, force: false,
            itemName: nc.noteChildrenJsonFileName,
          });
          const parentJsonContent = new TextDecoder().decode(await readFile(parentJsonPath));
          const updatedParentJson = updateNoteUpdatedAt(parentJsonContent, currentCrumb.digits, new Date().toISOString());
          await invoke('save_text_file', {
            accountId: account.id, itemId: currentCrumb.parentChildrenJsonId,
            parentId: breadcrumbs[breadcrumbs.length - 2].folderId,
            content: updatedParentJson, itemName: nc.noteChildrenJsonFileName,
          });
        } catch { /* non-fatal */ }
      }

      // Update state without a full reload.
      const newEntry: NoteEntry = {
        digits, shortFolderName, shortFolderId,
        title, createdAt: new Date().toISOString(),
      };
      setNoteEntries((prev) => [...prev, newEntry].sort((a, b) => parseInt(a.digits, 10) - parseInt(b.digits, 10)));
      setNoteChildrenJsonId(newChildrenJsonId);
      setShowCreate(false);
      setCreateTitle('');
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  // ── Navigate into a note's children ──────────────────────────────────────

  const navigateInto = async (note: NoteEntry) => {
    if (!account) return;
    let folderId = note.shortFolderId;
    if (!folderId) {
      await invoke('list_folder', { accountId: account.id, parentId: currentFolderId, force: true });
      const r = await invoke<FolderPage>('query_folder_items', {
        accountId: account.id, parentId: currentFolderId,
        search: note.shortFolderName, sortBy: 'name', ascending: true,
        page: 0, pageSize: PAGE_SIZE,
      });
      const found = r.items.find((i) => i.isDir && i.name === note.shortFolderName);
      if (!found) { setError(`Folder "${note.shortFolderName}" not found on this account.`); return; }
      folderId = found.itemId;
      setNoteEntries((prev) => prev.map((e) => e.digits === note.digits ? { ...e, shortFolderId: folderId! } : e));
    }
    setBreadcrumbs((prev) => [...prev, {
      folderId: folderId!,
      label: note.title || note.shortFolderName,
      digits: note.digits,
      parentChildrenJsonId: noteChildrenJsonId,
    }]);
  };

  // ── Navigate back via breadcrumb ──────────────────────────────────────────

  const navigateTo = (index: number) => {
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
  };

  // ── Open the markdown file for a note ────────────────────────────────────

  const openNoteMarkdown = async (note: NoteEntry) => {
    if (!account) return;
    let folderId = note.shortFolderId;
    if (!folderId) {
      await invoke('list_folder', { accountId: account.id, parentId: currentFolderId, force: false });
      const r = await invoke<FolderPage>('query_folder_items', {
        accountId: account.id, parentId: currentFolderId,
        search: note.shortFolderName, sortBy: 'name', ascending: true,
        page: 0, pageSize: PAGE_SIZE,
      });
      const found = r.items.find((i) => i.isDir && i.name === note.shortFolderName);
      if (!found) { setError('Note folder not found.'); return; }
      folderId = found.itemId;
    }

    await invoke('list_folder', { accountId: account.id, parentId: folderId, force: false });
    const r = await invoke<FolderPage>('query_folder_items', {
      accountId: account.id, parentId: folderId,
      search: nc.noteMarkdownSuffix, sortBy: 'name', ascending: true,
      page: 0, pageSize: PAGE_SIZE,
    });
    const mdItem = r.items.find(
      (i) => !i.isDir && i.name.endsWith(nc.noteMarkdownSuffix)
        && !i.name.endsWith(nc.noteHtmlSuffix) && !i.name.endsWith(nc.notePdfSuffix),
    );
    if (mdItem) {
      setViewingFile({ item: mdItem, displayPath: note.title });
    }
  };

  const notesListRef = useRef<HTMLDivElement>(null);
  const notesPaginationRef = useRef<PaginationBarHandle>(null);

  const { focusedRelIdx: notesFocusedRelIdx, containerProps: notesContainerProps } = useListKeyNav({
    totalItems: noteEntries.length,
    pageSize: PAGE_SIZE,
    page,
    onPage: setPage,
    onOpen: (absIdx) => { void openNoteMarkdown(noteEntries[absIdx]); },
    onNavigateInto: (absIdx) => { void navigateInto(noteEntries[absIdx]); },
    onParent: breadcrumbs.length > 1 ? () => navigateTo(breadcrumbs.length - 2) : undefined,
    onOpenSelectPageModal: () => notesPaginationRef.current?.openPicker(),
    onOpenEditPagePopover: () => notesPaginationRef.current?.openEdit(),
    containerRef: notesListRef,
    listKey: currentFolderId,
  });

  // ── Render guards ─────────────────────────────────────────────────────────

  if (acctLoading) return <div className="flex items-center justify-center flex-1 text-gray-400 dark:text-gray-500 text-sm">Loading…</div>;
  if (acctError || !account) return <div className="flex items-center justify-center flex-1 text-red-500 dark:text-red-400 text-sm p-4">{acctError ?? 'Account not found.'}</div>;

  // ── Derived state ─────────────────────────────────────────────────────────

  // The NoteEntry that owns the currently-viewed markdown file (if any).
  const currentViewingNote = viewingFile
    ? noteEntries.find((e) => e.shortFolderId === viewingFile.item.parentId) ?? null
    : null;

  const digits = effectiveCreateDigits();
  const pageStart = page * PAGE_SIZE;
  const visibleNotes = noteEntries.slice(pageStart, pageStart + PAGE_SIZE);
  const hdrBtn = 'shrink-0 w-7 h-7 flex items-center justify-center rounded text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors';
  const menuRow = 'w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700';

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-white dark:bg-gray-900">

      {/* ── Note context menu ────────────────────────────────────────────── */}
      {noteCtxMenu && (
        <Popover
          title={noteCtxMenu.note.title || noteCtxMenu.note.shortFolderName}
          onClose={() => setNoteCtxMenu(null)}
          panelStyle={{ left: noteCtxMenu.x, top: noteCtxMenu.y }}
        >
          <div className="py-1">
            <button onClick={() => { setNoteCtxMenu(null); startRename(noteCtxMenu.note); }} className={menuRow}>
              Rename
            </button>
            <button onClick={() => { setNoteCtxMenu(null); startDelete(noteCtxMenu.note); }}
              className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20">
              Delete
            </button>
          </div>
        </Popover>
      )}

      {/* ── Delete confirmation modal ────────────────────────────────────── */}
      {deletingNote && (
        <Modal title={`Delete "${deletingNote.title || deletingNote.shortFolderName}"?`} onClose={() => setDeletingNote(null)} maxWidth="max-w-sm">
          <div className="p-4 space-y-3 overflow-y-auto">
            {deleteError && <p className="text-sm text-red-500 dark:text-red-400">{deleteError}</p>}
            <p className="text-sm text-gray-600 dark:text-gray-300">
              This will permanently delete the note and all its files. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeletingNote(null)} disabled={deleteConfirming}
                className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors">
                Cancel
              </button>
              <button onClick={() => void handleDeleteConfirm()} disabled={deleteConfirming}
                className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors">
                {deleteConfirming ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Rename modal ─────────────────────────────────────────────────── */}
      {renamingNote && (
        <Modal title={`Rename "${renamingNote.title || renamingNote.shortFolderName}"`} onClose={() => setRenamingNote(null)} maxWidth="max-w-sm">
          <div className="p-4 space-y-3 overflow-y-auto">
            {renameError && <p className="text-sm text-red-500 dark:text-red-400">{renameError}</p>}
            <input
              type="text"
              value={renameTitle}
              onChange={(e) => setRenameTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleRename(); if (e.key === 'Escape') setRenamingNote(null); }}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setRenamingNote(null)} className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors">
                Cancel
              </button>
              <button
                onClick={() => void handleRename()}
                disabled={renameSaving || !renameTitle.trim()}
                className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors"
              >
                {renameSaving ? 'Renaming…' : 'Rename'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── File viewer (shown instead of notes list) ────────────────────── */}
      {viewingFile && (
        <FileViewer
          key={viewingFile.item.itemId}
          account={account}
          item={viewingFile.item}
          displayPath={viewingFile.displayPath}
          onClose={() => setViewingFile(null)}
          inNotebook
          onBeforeSave={handleBeforeSave}
          onRenameNote={currentViewingNote ? () => startRename(currentViewingNote) : undefined}
          onDeleteNote={currentViewingNote ? () => startDelete(currentViewingNote) : undefined}
        />
      )}

      {/* ── Notes list (hidden while viewing a file) ─────────────────────── */}
      {!viewingFile && (<>

      {/* ── Header ──────────────────────────────────────────────────────── */}

      <div className="shrink-0 border-b border-gray-200 dark:border-gray-700 px-3 py-2 flex items-center gap-2">
        {/* Breadcrumb navigation */}
        <nav className="flex items-center flex-wrap gap-1 text-sm text-gray-500 dark:text-gray-400 flex-1 min-w-0">
          {breadcrumbs.map((crumb, i) => (
            <span key={crumb.folderId + i} className="flex items-center gap-1">
              {i > 0 && <span className="text-gray-300 dark:text-gray-600">/</span>}
              <button
                onClick={() => navigateTo(i)}
                className={
                  i === breadcrumbs.length - 1
                    ? 'font-medium text-gray-800 dark:text-gray-200 truncate max-w-[200px]'
                    : 'hover:text-blue-600 dark:hover:text-blue-400 truncate max-w-[120px]'
                }
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>

        {/* Refresh split-button */}
        {cacheCleared && <span className="text-xs text-green-600 dark:text-green-400 mr-1">✓ Cache cleared</span>}
        <div className="relative flex items-center shrink-0">
          <button
            onClick={() => void loadNotes(currentFolderId, false)}
            disabled={loading}
            title="Refresh"
            className="px-2 py-1 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-l-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors border-r border-gray-200 dark:border-gray-600"
          >↻</button>
          <button
            onClick={() => setRefreshMenuOpen((o) => !o)}
            disabled={loading}
            title="Refresh options"
            className="px-1.5 py-1 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-r-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors"
          >▾</button>
          {refreshMenuOpen && (
            <Popover title="Options" onClose={() => setRefreshMenuOpen(false)} panelClassName="absolute right-0 top-full mt-1 min-w-max">
              <div className="py-1">
                <button
                  onClick={() => { setRefreshMenuOpen(false); void loadNotes(currentFolderId, true); }}
                  className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                >Hard refresh</button>
                <button
                  onClick={async () => {
                    setRefreshMenuOpen(false);
                    try {
                      await invoke('invalidate_folder_cache', { accountId: account.id, parentId: currentFolderId });
                      if (noteChildrenJsonId) {
                        await invoke('delete_cached_file', { accountId: account.id, itemId: noteChildrenJsonId });
                      }
                      setCacheCleared(true);
                      setTimeout(() => setCacheCleared(false), 2000);
                    } catch { /* non-fatal */ }
                  }}
                  className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                >Clear cached listing</button>
              </div>
            </Popover>
          )}
        </div>

        {/* New Note */}
        <button
          onClick={openCreateForm}
          title="New note"
          className={hdrBtn}
        >
          <PlusIcon />
        </button>

        {/* Quick actions */}
        {onQuickActions !== undefined && (
          <button onClick={onQuickActions} title="Quick actions" className={hdrBtn}>
            <QuickActionsIcon />
          </button>
        )}
      </div>

      {/* ── Create note dialog ───────────────────────────────────────────── */}

      {showCreate && (
        <div className="shrink-0 border-b border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-2.5 space-y-2">
          {createError && <p className="text-xs text-red-500 dark:text-red-400">{createError}</p>}

          {/* Title input */}
          <input
            type="text"
            value={createTitle}
            onChange={(e) => setCreateTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !useCustomIndex) void createNote(); if (e.key === 'Escape') setShowCreate(false); }}
            placeholder="Note title…"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-400"
          />

          {/* Index row */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">Index:</span>

            {!useCustomIndex ? (
              /* Interval picker trigger */
              <div className="relative shrink-0" ref={intervalPickerRef}>
                <button
                  onClick={() => setShowIntervalPicker((p) => !p)}
                  title="Choose interval"
                  className={[
                    'px-2.5 py-0.5 rounded-md text-xs font-mono font-semibold border transition-colors',
                    digits !== null
                      ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700 hover:bg-emerald-200 dark:hover:bg-emerald-800/50'
                      : 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 border-red-300 dark:border-red-700',
                  ].join(' ')}
                >
                  {digits ?? '—'}
                </button>

                {showIntervalPicker && (
                  <div className="absolute top-full left-0 mt-1 z-10 w-64 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 overflow-hidden">
                    {nc.noteIntervals.map((interval, i) => {
                      const next = nextDigitsInInterval(noteEntries.map((e) => e.digits), interval.lo, interval.hi);
                      const isSelected = i === createIntervalIdx;
                      return (
                        <button
                          key={i}
                          disabled={next === null}
                          onClick={() => { setCreateIntervalIdx(i); setShowIntervalPicker(false); }}
                          className={[
                            'w-full flex items-center justify-between px-3 py-2 text-sm transition-colors',
                            next === null
                              ? 'opacity-40 cursor-default'
                              : isSelected
                                ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                                : 'hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200',
                          ].join(' ')}
                        >
                          <span className="capitalize">{interval.label}</span>
                          <span className="font-mono text-xs shrink-0 ml-3 tabular-nums">
                            {next !== null ? next : '(full)'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              /* Custom index input */
              <div className="flex items-center gap-1.5 shrink-0">
                <input
                  type="number"
                  value={customIndexStr}
                  onChange={(e) => { setCustomIndexStr(e.target.value); setCustomIndexError(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') void createNote(); if (e.key === 'Escape') setShowCreate(false); }}
                  placeholder="e.g. 450"
                  className="w-24 px-2 py-0.5 text-sm font-mono border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-400"
                />
                {customIndexError && (
                  <span className="text-xs text-red-500 dark:text-red-400">{customIndexError}</span>
                )}
              </div>
            )}

            {/* Toggle custom / interval */}
            <button
              onClick={() => {
                setUseCustomIndex((c) => !c);
                setCustomIndexStr('');
                setCustomIndexError(null);
                setShowIntervalPicker(false);
              }}
              title={useCustomIndex ? 'Use interval picker' : 'Enter custom index'}
              className={hdrBtn}
            >
              {useCustomIndex ? <BackIcon /> : <EditIcon />}
            </button>

            <div className="flex-1" />

            <button
              onClick={() => void createNote()}
              disabled={creating || !createTitle.trim() || digits === null}
              className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors shrink-0"
            >
              {creating ? 'Creating…' : 'Create'}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors shrink-0"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Error banner ─────────────────────────────────────────────────── */}

      {error && (
        <div className="shrink-0 px-3 py-2 bg-red-50 dark:bg-red-900/20 border-b border-red-100 dark:border-red-800 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="text-red-600 dark:text-red-400 flex-1">{error}</span>
            <div className="flex items-center gap-1.5 shrink-0">
              {indexMissing && !repairing && (
                <button
                  onClick={() => void repairIndex()}
                  className="px-2 py-0.5 text-xs rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-800/50 transition-colors"
                >
                  {repairPairs.length > 0 ? 'Reconstruct index' : 'Create empty index'}
                </button>
              )}
              {repairing && (
                <span className="text-xs text-amber-600 dark:text-amber-400 italic">
                  {repairProgress ?? 'Working…'}
                </span>
              )}
              <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 dark:hover:text-red-300">✕</button>
            </div>
          </div>
          {repairNoteErrors.length > 0 && (
            <div className="mt-1.5 pt-1.5 border-t border-red-200 dark:border-red-800 space-y-0.5">
              {repairNoteErrors.map((e, i) => (
                <p key={i} className="text-xs text-red-500 dark:text-red-400">{e}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Notes list ───────────────────────────────────────────────────── */}

      <div ref={notesListRef} className="flex-1 min-h-0 overflow-y-auto outline-none" {...notesContainerProps}>
        {loading && (
          <div className="flex items-center justify-center h-32 text-sm text-gray-400 dark:text-gray-500">Loading…</div>
        )}
        {!loading && noteEntries.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 gap-3 text-center px-6">
            <p className="text-gray-400 dark:text-gray-500 text-sm">
              {breadcrumbs.length === 1 ? 'No notes yet.' : 'No child notes.'}
            </p>
            <button
              onClick={openCreateForm}
              className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors"
            >
              Create first note
            </button>
          </div>
        )}
        {!loading && visibleNotes.map((note, relIdx) => (
          <div
            key={note.digits}
            data-nav-idx={relIdx}
            className={`flex items-center gap-2 px-3 py-2.5 border-b border-gray-100 dark:border-gray-700/60 transition-colors ${relIdx === notesFocusedRelIdx ? 'bg-emerald-50 dark:bg-emerald-900/20' : 'hover:bg-gray-50 dark:hover:bg-gray-700/30'}`}
          >
            {/* Short name button — navigate into children */}
            <button
              onClick={() => void navigateInto(note)}
              title={`Show children of note ${note.shortFolderName}`}
              className="shrink-0 px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-xs font-mono font-semibold text-gray-600 dark:text-gray-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 hover:text-emerald-700 dark:hover:text-emerald-300 transition-colors border border-gray-200 dark:border-gray-600"
            >
              {note.shortFolderName}
            </button>

            {/* Note title button — open markdown; right-click to rename */}
            <button
              onClick={() => void openNoteMarkdown(note)}
              onContextMenu={(e) => { e.preventDefault(); setNoteCtxMenu({ note, x: e.clientX, y: e.clientY }); }}
              title={`Open "${note.title}"`}
              className="flex-1 min-w-12 text-left text-sm text-gray-800 dark:text-gray-200 hover:text-emerald-700 dark:hover:text-emerald-300 truncate transition-colors"
            >
              {note.title || <span className="italic text-gray-400">(untitled)</span>}
            </button>

            {/* Date — small, trailing */}
            {note.updatedAt ?? note.createdAt ? (
              <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500 tabular-nums">
                {new Date(note.updatedAt ?? note.createdAt).toLocaleDateString()}
              </span>
            ) : null}
          </div>
        ))}
      </div>

      {/* ── Pagination ───────────────────────────────────────────────────── */}

      {noteEntries.length > PAGE_SIZE && (
        <div className="shrink-0">
          <PaginationBar ref={notesPaginationRef} page={page} total={noteEntries.length} pageSize={PAGE_SIZE} onPage={setPage} />
        </div>
      )}

      </>)}
    </div>
  );
}
