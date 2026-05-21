import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readFile, mkdir } from '@tauri-apps/plugin-fs';
import type { StoredAccount, CachedItem, FolderPage } from '../../types';
import { getAccount } from '../../lib/account-store';
import nc from '../../notesConfig.json';
import config from '../../config.json';
import {
  computeShortFolderName, computeFullFolderName, computeFullNamePart,
  computeMarkdownFileName, extractDigits,
  initialMarkdownContent, noteJsonContent, addNoteToChildrenJson,
  toAbsPath, joinRelPath,
  isValidNoteNumber, nextDigitsInInterval,
} from '../../lib/notes-utils';
import FileViewer from '../explorer/FileViewer';
import PaginationBar from '../explorer/PaginationBar';

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
}
interface ViewingFile {
  item: CachedItem;
  displayPath: string;
}

// ── Props ────────────────────────────────────────────────────────────────────

interface Props {
  accountId: string;
  notebookParentId: string;
  onDisplayNameChange?: (name: string) => void;
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

function RefreshIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
      <path d="M2 7a5 5 0 1 0 .9-2.9M2 4v3h3"/>
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

export default function NotesExplorer({ accountId, notebookParentId, onDisplayNameChange, onQuickActions }: Props) {
  const [account, setAccount] = useState<StoredAccount | null>(null);
  const [acctLoading, setAcctLoading] = useState(true);
  const [acctError, setAcctError] = useState<string | null>(null);

  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbEntry[]>([
    { folderId: notebookParentId, label: 'Notes' },
  ]);
  const [noteEntries, setNoteEntries] = useState<NoteEntry[]>([]);
  const [noteChildrenJsonId, setNoteChildrenJsonId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const [viewingFile, setViewingFile] = useState<ViewingFile | null>(null);

  // ── Create-note form state ────────────────────────────────────────────────
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

  useEffect(() => {
    onDisplayNameChangeRef.current?.(
      viewingFile
        ? viewingFile.item.name
        : breadcrumbs[breadcrumbs.length - 1]?.label ?? 'Notes Explorer'
    );
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
    try {
      // 1. List folder to populate SQLite cache.
      await invoke('list_folder', { accountId: account.id, parentId: folderId, force });

      // 2. Single paginated scan — find [note-children].json by exact name and
      //    build the shortFolderMap in the same pass (avoids search-filter quirks).
      const newShortFolderMap = new Map<string, string>();
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
            const d = extractDigits(item.name);
            if (d !== null) newShortFolderMap.set(d, item.itemId);
          }
        }
        if (r.items.length < PAGE_SIZE) break;
        pg++;
      }
      if (!isMountedRef.current) return;

      if (!jsonItem) {
        setError(`Note index file (${nc.noteChildrenJsonFileName}) not found in this folder.`);
        return;
      }
      setNoteChildrenJsonId(jsonItem.itemId);

      // 3. Download and parse [note-children].json.
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
    setBreadcrumbs((prev) => [...prev, { folderId: folderId!, label: note.title || note.shortFolderName }]);
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

  // ── Render guards ─────────────────────────────────────────────────────────

  if (acctLoading) return <div className="flex items-center justify-center flex-1 text-gray-400 dark:text-gray-500 text-sm">Loading…</div>;
  if (acctError || !account) return <div className="flex items-center justify-center flex-1 text-red-500 dark:text-red-400 text-sm p-4">{acctError ?? 'Account not found.'}</div>;

  // ── File viewer ───────────────────────────────────────────────────────────

  if (viewingFile) {
    return (
      <FileViewer
        account={account}
        item={viewingFile.item}
        displayPath={viewingFile.displayPath}
        onClose={() => setViewingFile(null)}
        inNotebook
      />
    );
  }

  // ── Derived create state ──────────────────────────────────────────────────

  const digits = effectiveCreateDigits();
  const pageStart = page * PAGE_SIZE;
  const visibleNotes = noteEntries.slice(pageStart, pageStart + PAGE_SIZE);

  // ── Button style constants ────────────────────────────────────────────────

  const hdrBtn = 'shrink-0 w-7 h-7 flex items-center justify-center rounded text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors';

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-white dark:bg-gray-900">

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

        {/* Refresh */}
        <button
          onClick={() => void loadNotes(currentFolderId, true)}
          disabled={loading}
          title="Refresh"
          className={hdrBtn}
        >
          <RefreshIcon />
        </button>

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
        <div className="shrink-0 px-3 py-2 bg-red-50 dark:bg-red-900/20 border-b border-red-100 dark:border-red-800 text-red-600 dark:text-red-400 text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 dark:hover:text-red-300 ml-2">✕</button>
        </div>
      )}

      {/* ── Notes list ───────────────────────────────────────────────────── */}

      <div className="flex-1 min-h-0 overflow-y-auto">
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
        {!loading && visibleNotes.map((note) => (
          <div
            key={note.digits}
            className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-100 dark:border-gray-700/60 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
          >
            {/* Short name button — navigate into children */}
            <button
              onClick={() => void navigateInto(note)}
              title={`Show children of note ${note.shortFolderName}`}
              className="shrink-0 px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-xs font-mono font-semibold text-gray-600 dark:text-gray-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 hover:text-emerald-700 dark:hover:text-emerald-300 transition-colors border border-gray-200 dark:border-gray-600"
            >
              {note.shortFolderName}
            </button>

            {/* Note title button — open markdown */}
            <button
              onClick={() => void openNoteMarkdown(note)}
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
          <PaginationBar page={page} total={noteEntries.length} pageSize={PAGE_SIZE} onPage={setPage} />
        </div>
      )}
    </div>
  );
}
