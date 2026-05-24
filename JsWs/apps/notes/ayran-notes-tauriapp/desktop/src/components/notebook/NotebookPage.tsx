import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emit, listen } from '@tauri-apps/api/event';
import { getNotebook, updateNotebook, updateNotebooksByFile, deleteNotebook, type NotebookEntry } from '../../lib/notebooks-db';
import config from '../../config.json';
import { MAX_TAB_HISTORY } from '../../lib/config';
import AllFilesExplorerTab from './AllFilesExplorerTab';
import NotesExplorer from './NotesExplorer';
import { useTheme } from '../../hooks/useTheme';
import { useKeyboardShortcut, useKeyboardScopes } from '../common/KeyboardShortcutsContext';
import Modal from '../common/Modal';
import Popover from '../common/Popover';

// ── Tab types ─────────────────────────────────────────────────────────────────

type TabType = 'home' | 'notes-explorer' | 'all-files-explorer' | 'settings';
type SplitMode = 'vertical' | 'horizontal';

interface SplitPair {
  id: string;
  primaryId: string;   // left / top tab
  secondaryId: string; // right / bottom tab
  mode: SplitMode;
}

interface NbTab {
  id: string;
  type: TabType;
  name: string;
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function NotebookIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="shrink-0 text-emerald-600 dark:text-emerald-400">
      <rect x="4" y="2" width="12" height="16" rx="1.5" fill="currentColor" opacity="0.15"/>
      <rect x="4" y="2" width="12" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
      <line x1="7" y1="6" x2="13" y2="6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="7" y1="9" x2="13" y2="9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <line x1="7" y1="12" x2="11" y2="12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      <rect x="2" y="5" width="2.5" height="10" rx="0.5" fill="currentColor" opacity="0.5"/>
    </svg>
  );
}

function HomeIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M2 7L8 2l6 5v7a1 1 0 01-1 1H3a1 1 0 01-1-1V7z"/>
      <path d="M6 15V9h4v6"/>
    </svg>
  );
}

function ExplorerIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5H12A1.5 1.5 0 0113.5 6v6A1.5 1.5 0 0112 13.5H3.5A1.5 1.5 0 012 12V4.5z"/>
      <circle cx="8" cy="9" r="2"/>
      <path d="M9.4 10.4l1.6 1.6"/>
    </svg>
  );
}

function AllFilesIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M2 3.5A1.5 1.5 0 013.5 2H8l1.5 1.5H13A1.5 1.5 0 0114.5 5v8A1.5 1.5 0 0113 14.5H3.5A1.5 1.5 0 012 13V3.5z"/>
      <path d="M6 9h4M8 7v4"/>
    </svg>
  );
}

function SettingsIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="8" cy="8" r="2"/>
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.42 1.42M11.54 11.54l1.41 1.41M3.05 12.95l1.42-1.41M11.53 4.47l1.42-1.42"/>
    </svg>
  );
}

function TabsListIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="2" y="3" width="12" height="3" rx="1"/>
      <rect x="2" y="8.5" width="12" height="3" rx="1"/>
    </svg>
  );
}

function PlusIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className={className}>
      <path d="M8 3v10M3 8h10"/>
    </svg>
  );
}

function MoreDotsIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className}>
      <circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/>
    </svg>
  );
}

function tabIcon(type: TabType, className?: string) {
  switch (type) {
    case 'home': return <HomeIcon className={className} />;
    case 'notes-explorer': return <ExplorerIcon className={className} />;
    case 'all-files-explorer': return <AllFilesIcon className={className} />;
    case 'settings': return <SettingsIcon className={className} />;
  }
}

// ── Sort strip (Ayran reorder strategy) ───────────────────────────────────────

interface StripProps {
  hasSelected: boolean;
  active: boolean;
  stripPos: number;
  maxPos: number;
  onUp: () => void;
  onDown: () => void;
  onConfirm: () => void;
}

function SortStrip({ hasSelected, active, stripPos, maxPos, onUp, onDown, onConfirm }: StripProps) {
  const label = !hasSelected
    ? 'Select tabs to reorder'
    : !active
      ? 'Tap anywhere to move selected tabs'
      : 'Move selected tabs here';

  const btnBase = 'p-1 rounded transition-colors disabled:opacity-30';
  const btnGhost = `${btnBase} text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30`;
  const btnConfirm = `${btnBase} text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/30`;

  return (
    <div className="flex items-center gap-2 px-3 py-1 my-0.5 mx-2 rounded-lg border border-dashed border-amber-400 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="w-3.5 h-3.5 shrink-0 text-amber-500">
        <path d="M7 2v10M4 8l3 3 3-3M4 6l3-3 3 3" opacity="0.6"/>
      </svg>
      <span className="flex-1 text-xs font-medium text-amber-700 dark:text-amber-300">{label}</span>
      {active && (
        <>
          <button onClick={onUp} disabled={stripPos === 0} className={btnGhost} title="Move strip up">
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3"><path d="M2 8l4-4 4 4"/></svg>
          </button>
          <button onClick={onDown} disabled={stripPos === maxPos} className={btnGhost} title="Move strip down">
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3"><path d="M2 4l4 4 4-4"/></svg>
          </button>
          <button onClick={onConfirm} className={btnConfirm} title="Confirm move">
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3"><path d="M1.5 6l3 3 6-6"/></svg>
          </button>
        </>
      )}
    </div>
  );
}

// ── Home tab ──────────────────────────────────────────────────────────────────

interface HomeTabProps {
  onOpenExplorer: () => void;
  onOpenAllFiles: () => void;
  onNewTab: () => void;
  onOpenSettings: () => void;
  onContextMenu: (type: TabType, name: string, e: React.MouseEvent) => void;
  onQuickActions: () => void;
}

function QuickActionsIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M8 1L4 8h5l-3 5"/>
    </svg>
  );
}

function NotebookHomeTab({ onOpenExplorer, onOpenAllFiles, onNewTab, onOpenSettings, onContextMenu, onQuickActions }: HomeTabProps) {
  const btn = 'flex flex-col items-center gap-2 p-5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 hover:border-emerald-400 dark:hover:border-emerald-500 transition-colors cursor-pointer group';
  const iconWrap = 'w-10 h-10 flex items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-700 group-hover:bg-emerald-100 dark:group-hover:bg-emerald-900/40 transition-colors text-gray-500 dark:text-gray-400 group-hover:text-emerald-600 dark:group-hover:text-emerald-400';
  const label = 'text-xs font-medium text-gray-600 dark:text-gray-400 group-hover:text-emerald-700 dark:group-hover:text-emerald-300 text-center';

  return (
    <div className="flex items-center justify-center flex-1 p-8">
      <div className="flex gap-4 flex-wrap justify-center">
        <button onClick={onOpenExplorer} onContextMenu={(e) => onContextMenu('notes-explorer', 'Notes Explorer', e)} className={btn}>
          <div className={iconWrap}><ExplorerIcon className="w-5 h-5"/></div>
          <span className={label}>Notes Explorer</span>
        </button>
        <button onClick={onOpenAllFiles} onContextMenu={(e) => onContextMenu('all-files-explorer', 'All Files Explorer', e)} className={btn}>
          <div className={iconWrap}><AllFilesIcon className="w-5 h-5"/></div>
          <span className={label}>All Files Explorer</span>
        </button>
        <button onClick={onNewTab} onContextMenu={(e) => onContextMenu('home', 'Home', e)} className={btn}>
          <div className={iconWrap}><PlusIcon className="w-5 h-5"/></div>
          <span className={label}>New Tab</span>
        </button>
        <button onClick={onOpenSettings} onContextMenu={(e) => onContextMenu('settings', 'Notebook Settings', e)} className={btn}>
          <div className={iconWrap}><SettingsIcon className="w-5 h-5"/></div>
          <span className={label}>Notebook Settings</span>
        </button>
        <button onClick={onQuickActions} className={btn}>
          <div className={iconWrap}><QuickActionsIcon /></div>
          <span className={label}>Quick Actions</span>
        </button>
      </div>
    </div>
  );
}

// ── Placeholder tabs ───────────────────────────────────────────────────────────

function PlaceholderTab({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center flex-1 text-gray-400 dark:text-gray-500 text-sm">
      {label} — coming soon
    </div>
  );
}

// ── Split tab mini-header ──────────────────────────────────────────────────────

interface SplitTabHeaderProps {
  tab: NbTab;
  isPrimary: boolean;
  isNotesViewing?: boolean;
  onClose: () => void;
  onOpenTabsList?: () => void;
  onOpenSplitOptions?: (e: React.MouseEvent) => void;
}

function SplitTabHeader({ tab, isPrimary, isNotesViewing, onClose, onOpenTabsList, onOpenSplitOptions }: SplitTabHeaderProps) {
  const btn = 'shrink-0 w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors';
  const closeBtn = (
    <button onClick={onClose} title="Close tab" className={btn}>
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="w-3 h-3"><path d="M1 1l10 10M11 1L1 11"/></svg>
    </button>
  );
  return (
    <div className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-2 py-1.5 shrink-0 flex items-center gap-1.5">
      <span className={`shrink-0 ${isNotesViewing ? 'text-amber-500 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400'}`}>{tabIcon(tab.type, 'w-3.5 h-3.5')}</span>
      <span className="flex-1 text-xs font-medium text-gray-700 dark:text-gray-200 truncate select-none">{tab.name}</span>
      {isPrimary ? (
        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={onOpenTabsList} title="Open tabs" className={btn}>
            <TabsListIcon className="w-3.5 h-3.5"/>
          </button>
          {closeBtn}
        </div>
      ) : (
        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={onOpenSplitOptions} title="Tab options" className={btn}>
            <MoreDotsIcon className="w-3.5 h-3.5"/>
          </button>
          {closeBtn}
        </div>
      )}
    </div>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  notebookId: string;
  onBack: () => void;
  onDeleted: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function NotebookPage({ notebookId, onBack, onDeleted }: Props) {
  const isSecondaryWindow = !!new URLSearchParams(window.location.search).get('wlabel');
  const { theme, toggleTheme } = useTheme();

  const [entry, setEntry] = useState<NotebookEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showHeader, setShowHeader] = useState(true);
  const [showTabsHeader, setShowTabsHeader] = useState(true);
  const [showTabsList, setShowTabsList] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [showTitlePrompt, setShowTitlePrompt] = useState(false);
  const [promptTitle, setPromptTitle] = useState('');
  const [showEdit, setShowEdit] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // ── Tab state ────────────────────────────────────────────────────────────────
  const initialTabIdRef = useRef<string>(crypto.randomUUID());
  const [tabs, setTabs] = useState<NbTab[]>([{ id: initialTabIdRef.current, type: 'home', name: 'Home' }]);
  const [activeTabId, setActiveTabId] = useState<string>(initialTabIdRef.current);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  // Prevents saving tabs before the initial load has had a chance to restore them.
  const tabsReadyRef = useRef(false);
  // Full tab navigation history for back/forward support.
  const [tabHistory, setTabHistory] = useState<string[]>([initialTabIdRef.current]);
  const [historyIndex, setHistoryIndex] = useState(0);
  // Preview index: moves with back/forward buttons inside the modal without committing navigation.
  const [historyPreviewIndex, setHistoryPreviewIndex] = useState(0);

  // ── Split view ────────────────────────────────────────────────────────────────
  const [splitPairs, setSplitPairs] = useState<SplitPair[]>([]);
  const [splitOptionsMenu, setSplitOptionsMenu] = useState<{ x: number; y: number } | null>(null);
  // Derived: the split pair (if any) that contains the currently active tab.
  const activeSplitPair = splitPairs.find((p) => p.primaryId === activeTabId || p.secondaryId === activeTabId) ?? null;

  // ── Notes-explorer file-viewing state ────────────────────────────────────────
  const [notesViewingTabIds, setNotesViewingTabIds] = useState<Set<string>>(new Set());

  const handleNotesViewingFileChange = (tabId: string, isViewing: boolean) => {
    setNotesViewingTabIds((prev) => {
      const next = new Set(prev);
      isViewing ? next.add(tabId) : next.delete(tabId);
      return next;
    });
  };

  // ── Minimized explorer stacks ─────────────────────────────────────────────────
  const [minimizedExplorerTabs, setMinimizedExplorerTabs] = useState<Set<string>>(new Set());
  const [explorerRestoreTriggers, setExplorerRestoreTriggers] = useState<Map<string, number>>(new Map());
  // tabId → displayPath / folderName of the current folder in that explorer tab
  const [explorerFolderPaths, setExplorerFolderPaths] = useState<Map<string, string>>(new Map());
  const [explorerFolderNames, setExplorerFolderNames] = useState<Map<string, string>>(new Map());

  const handleExplorerMinimizedChange = (tabId: string, isMinimized: boolean) => {
    setMinimizedExplorerTabs((prev) => {
      const next = new Set(prev);
      if (isMinimized) next.add(tabId); else next.delete(tabId);
      return next;
    });
  };

  const handleRestoreMinimized = () => {
    const tabId = [...minimizedExplorerTabs][0];
    if (!tabId) return;
    navigateToTab(tabId);
    setExplorerRestoreTriggers((prev) => {
      const next = new Map(prev);
      next.set(tabId, (prev.get(tabId) ?? 0) + 1);
      return next;
    });
  };

  const handleExplorerFolderPathChange = (tabId: string, folderName: string, displayPath: string) => {
    const name = folderName || 'All Files';
    setExplorerFolderPaths((prev) => new Map(prev).set(tabId, displayPath));
    setExplorerFolderNames((prev) => new Map(prev).set(tabId, name));
    setTabs((prev) => prev.map((t) => t.id === tabId ? { ...t, name } : t));
  };

  const handleExplorerViewingFileChange = (tabId: string, fileName: string | null) => {
    if (fileName !== null) {
      setTabs((prev) => prev.map((t) => t.id === tabId ? { ...t, name: fileName } : t));
    } else {
      const folderName = explorerFolderNames.get(tabId) ?? 'All Files';
      setTabs((prev) => prev.map((t) => t.id === tabId ? { ...t, name: folderName } : t));
    }
  };

  const getPrevExplorerPath = (tabId: string): string | undefined => {
    for (let i = historyIndex - 1; i >= 0; i--) {
      const hid = tabHistory[i];
      if (hid === tabId) continue;
      const t = tabs.find((t) => t.id === hid);
      if (!t) continue;
      return t.type === 'all-files-explorer' ? explorerFolderPaths.get(hid) : undefined;
    }
    return undefined;
  };

  // ── Home tab context menu ─────────────────────────────────────────────────────
  const [homeCtxMenu, setHomeCtxMenu] = useState<{ x: number; y: number; type: TabType; name: string } | null>(null);

  // ── Tab sort state ───────────────────────────────────────────────────────────
  const [selectedTabIds, setSelectedTabIds] = useState<Set<string>>(new Set());
  const [tabSortMode, setTabSortMode] = useState(false);
  const [tabWorkingOrder, setTabWorkingOrder] = useState<NbTab[]>([]);
  const [tabStripPos, setTabStripPos] = useState(0);
  const [tabStripActive, setTabStripActive] = useState(false);
  const lastCheckedTabIdxRef = useRef<number | null>(null);

  // ── Tab management ───────────────────────────────────────────────────────────

  const navigateToTab = (tabId: string) => {
    const truncated = tabHistory.slice(0, historyIndex + 1);
    const next = [...truncated, tabId];
    const trimmed = next.length > MAX_TAB_HISTORY ? next.slice(next.length - MAX_TAB_HISTORY) : next;
    const newIndex = trimmed.length - 1;
    setTabHistory(trimmed);
    setHistoryIndex(newIndex);
    setHistoryPreviewIndex(newIndex);
    setActiveTabId(tabId);
  };

  // Close a tab by ID, remove any split pairs containing it, and navigate if needed.
  const closeTabById = (tabId: string) => {
    setSplitPairs((pairs) => pairs.filter((p) => p.primaryId !== tabId && p.secondaryId !== tabId));
    const tabsAfterClose = tabs.filter((t) => t.id !== tabId);
    if (tabsAfterClose.length === 0) {
      const newHome: NbTab = { id: crypto.randomUUID(), type: 'home', name: 'Home' };
      setTabs([newHome]);
      navigateToTab(newHome.id);
      return;
    }
    setTabs(tabsAfterClose);
    if (tabId === activeTabId) {
      let nextId: string | null = null;
      for (let i = historyIndex - 1; i >= 0; i--) {
        const hid = tabHistory[i];
        if (hid !== tabId && tabsAfterClose.some((t) => t.id === hid)) { nextId = hid; break; }
      }
      if (!nextId) {
        const idx = tabs.findIndex((t) => t.id === tabId);
        nextId = (tabsAfterClose[idx - 1] ?? tabsAfterClose[Math.min(idx, tabsAfterClose.length - 1)]).id;
      }
      navigateToTab(nextId);
    }
  };

  // Toggle or create a split pair for the active tab.
  const enableSplit = (mode: SplitMode) => {
    if (activeSplitPair) {
      if (activeSplitPair.mode === mode) {
        setSplitPairs((pairs) => pairs.filter((p) => p.id !== activeSplitPair.id));
      } else {
        setSplitPairs((pairs) => pairs.map((p) => p.id === activeSplitPair.id ? { ...p, mode } : p));
      }
      return;
    }
    // Create a new pair — prefer most-recently-visited tab not already in any pair.
    const occupied = new Set(splitPairs.flatMap((p) => [p.primaryId, p.secondaryId]));
    let secondaryId: string | null = null;
    for (let i = historyIndex - 1; i >= 0; i--) {
      const hid = tabHistory[i];
      if (hid !== activeTabId && !occupied.has(hid) && tabs.some((t) => t.id === hid)) { secondaryId = hid; break; }
    }
    if (!secondaryId) secondaryId = tabs.find((t) => t.id !== activeTabId && !occupied.has(t.id))?.id ?? null;
    if (!secondaryId) return;
    setSplitPairs((pairs) => [...pairs, { id: crypto.randomUUID(), primaryId: activeTabId, secondaryId, mode }]);
  };

  const swapSplitTabs = (pairId: string) => {
    setSplitPairs((pairs) => pairs.map((p) =>
      p.id === pairId ? { ...p, primaryId: p.secondaryId, secondaryId: p.primaryId } : p
    ));
  };

  const openNewHomeTab = () => {
    const id = crypto.randomUUID();
    setTabs((prev) => [...prev, { id, type: 'home', name: 'Home' }]);
    navigateToTab(id);
  };

  // Opens a new home tab, navigates to it, and shows the tabs modal.
  const openNewHomeTabWithModal = () => {
    const id = crypto.randomUUID();
    setTabs((prev) => [...prev, { id, type: 'home', name: 'Home' }]);
    navigateToTab(id);
    setShowTabsList(true);
  };

  // Creates a new tab of any type; optionally navigates (+ opens modal) or stays.
  const openInNewTab = (type: TabType, name: string, stayHere: boolean) => {
    const id = crypto.randomUUID();
    setTabs((prev) => [...prev, { id, type, name }]);
    if (!stayHere) {
      navigateToTab(id);
      setShowTabsList(true);
    }
  };

  // Mutates the active tab's type in-place (no new tab, no history change).
  const navigateCurrentTabTo = (type: TabType, name: string) => {
    setTabs((prev) => prev.map((t) => t.id === activeTabId ? { ...t, type, name } : t));
  };

  const navigateCurrentTabToHome = () => navigateCurrentTabTo('home', 'Home');

  const closeCurrentTab = () => closeTabById(activeTabId);
  const closeTab = (id: string) => closeTabById(id);

  // ── Keyboard shortcut handlers ────────────────────────────────────────────────

  // Navigate backward in tab history without truncating (browser back-button model).
  const navigateBackInHistory = () => {
    for (let i = historyIndex - 1; i >= 0; i--) {
      const id = tabHistory[i];
      if (tabs.some((t) => t.id === id)) {
        setHistoryIndex(i);
        setHistoryPreviewIndex(i);
        setActiveTabId(id);
        break;
      }
    }
  };

  // Navigate forward in tab history (only possible after going back without navigating elsewhere).
  const navigateForwardInHistory = () => {
    for (let i = historyIndex + 1; i < tabHistory.length; i++) {
      const id = tabHistory[i];
      if (tabs.some((t) => t.id === id)) {
        setHistoryIndex(i);
        setHistoryPreviewIndex(i);
        setActiveTabId(id);
        break;
      }
    }
  };

  // Push 'notebookModule' scope so tab shortcuts are active in this window.
  useKeyboardScopes(['global', 'notebookModule']);

  useKeyboardShortcut('showCurrentlyOpenedTabsModal', () => {
    setHistoryPreviewIndex(historyIndex);
    setShowTabsList(true);
  });
  useKeyboardShortcut('openNewTab', openNewHomeTab);
  useKeyboardShortcut('goToPrevTabFromHistory', navigateBackInHistory);
  useKeyboardShortcut('goToNextTabFromHistory', navigateForwardInHistory);
  useKeyboardShortcut('goToNextTab', () => {
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    const next = tabs[(idx + 1) % tabs.length];
    if (next) navigateToTab(next.id);
  });
  useKeyboardShortcut('goToPrevTab', () => {
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
    if (prev) navigateToTab(prev.id);
  });

  // ── Tab sort handlers ────────────────────────────────────────────────────────

  const toggleTabSelected = (id: string) => setSelectedTabIds((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const handleTabCheck = (idx: number, shiftHeld: boolean, deselect = false) => {
    const list = tabSortMode ? tabWorkingOrder : tabs;
    if (shiftHeld && lastCheckedTabIdxRef.current !== null) {
      const lo = Math.min(lastCheckedTabIdxRef.current, idx);
      const hi = Math.max(lastCheckedTabIdxRef.current, idx);
      setSelectedTabIds((prev) => {
        const next = new Set(prev);
        list.slice(lo, hi + 1).forEach((t) => deselect ? next.delete(t.id) : next.add(t.id));
        return next;
      });
    } else {
      toggleTabSelected(list[idx].id);
      lastCheckedTabIdxRef.current = idx;
    }
  };

  const enterTabSortMode = () => {
    setTabWorkingOrder([...tabs]);
    setTabStripPos(0);
    setTabStripActive(false);
    setTabSortMode(true);
  };

  const cancelTabSortMode = () => {
    setTabSortMode(false);
    setTabWorkingOrder([]);
    setTabStripPos(0);
    setTabStripActive(false);
  };

  const handleTabRowBodyClick = (idx: number) => {
    const tab = tabWorkingOrder[idx];
    if (selectedTabIds.has(tab.id)) return;
    setTabStripPos(idx + 1);
    setTabStripActive(true);
  };

  const handleTabConfirmMove = () => {
    const selected = tabWorkingOrder.filter((t) => selectedTabIds.has(t.id));
    const nonSelected = tabWorkingOrder.filter((t) => !selectedTabIds.has(t.id));

    let insertAfterNonSelected = -1;
    for (let i = tabStripPos - 1; i >= 0; i--) {
      if (!selectedTabIds.has(tabWorkingOrder[i].id)) {
        insertAfterNonSelected = nonSelected.findIndex((t) => t.id === tabWorkingOrder[i].id);
        break;
      }
    }

    setTabWorkingOrder([
      ...nonSelected.slice(0, insertAfterNonSelected + 1),
      ...selected,
      ...nonSelected.slice(insertAfterNonSelected + 1),
    ]);
    setTabStripPos(0);
    setTabStripActive(false);
  };

  const removeSelectedTabs = () => {
    setSplitPairs((pairs) => pairs.filter((p) => !selectedTabIds.has(p.primaryId) && !selectedTabIds.has(p.secondaryId)));
    setTabs((prev) => {
      const next = prev.filter((t) => !selectedTabIds.has(t.id));
      if (next.length === 0) {
        const newHome: NbTab = { id: crypto.randomUUID(), type: 'home', name: 'Home' };
        setActiveTabId(newHome.id);
        return [newHome];
      }
      if (selectedTabIds.has(activeTabId)) {
        const firstRemoved = prev.findIndex((t) => selectedTabIds.has(t.id));
        const fallback = next[Math.min(firstRemoved, next.length - 1)];
        setActiveTabId(fallback.id);
      }
      return next;
    });
    setSelectedTabIds(new Set());
    if (tabs.filter((t) => !selectedTabIds.has(t.id)).length === 0) closeTabsList();
  };

  const handleTabSubmitOrder = () => {
    setTabs([...tabWorkingOrder]);
    setTabSortMode(false);
    setTabWorkingOrder([]);
    setTabStripPos(0);
    setTabStripActive(false);
    setSelectedTabIds(new Set());
  };

  const closeTabsList = () => {
    setShowTabsList(false);
    cancelTabSortMode();
    setSelectedTabIds(new Set());
    lastCheckedTabIdxRef.current = null;
  };

  // ── Load notebook entry ───────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true); setLoadError(null);
      try {
        const nb = await getNotebook(notebookId);
        if (cancelled) return;
        if (!nb) { setLoadError('Notebook not found.'); setLoading(false); return; }
        setEntry(nb);

        // Restore persisted tabs and tabs-header state for this notebook instance.
        if (nb.tabs && nb.tabs.length > 0) {
          const restored = nb.tabs.map((t) => ({ id: t.id, type: t.type as TabType, name: t.name }));
          const restoredActiveId = nb.activeTabId && restored.some((t) => t.id === nb.activeTabId) ? nb.activeTabId : restored[0].id;
          if (!cancelled) {
            setTabs(restored);
            setActiveTabId(restoredActiveId);
            // Restore history, validating the index is in bounds.
            const restoredHistory = nb.tabHistory && nb.tabHistory.length > 0 ? nb.tabHistory : [restoredActiveId];
            const restoredIdx = nb.tabHistoryIndex !== undefined && nb.tabHistoryIndex >= 0 && nb.tabHistoryIndex < restoredHistory.length
              ? nb.tabHistoryIndex
              : restoredHistory.length - 1;
            setTabHistory(restoredHistory);
            setHistoryIndex(restoredIdx);
            setHistoryPreviewIndex(restoredIdx);
            // Restore split pairs, dropping any that reference tabs no longer in the list.
            if (nb.splitPairs && nb.splitPairs.length > 0 && !cancelled) {
              const validIds = new Set(restored.map((t) => t.id));
              setSplitPairs(nb.splitPairs.filter((p) => validIds.has(p.primaryId) && validIds.has(p.secondaryId)));
            }
          }
        }
        if (nb.tabsHeaderVisible !== undefined && !cancelled) {
          setShowTabsHeader(nb.tabsHeaderVisible);
        }
        tabsReadyRef.current = true;

        let content: string | null = null;
        try {
          // Seed path_index so open_file resolves to the correct cloud-mirrored path
          // instead of flat under c/001/.
          // nb.itemId    = [note-book].json file UUID
          // nb.displayPath = full relative path including the filename
          //                  (e.g. "My Filen/Notes/MyNotebook/[note-book].json")
          const fullFilePath = (nb.displayPath ?? '').replace(/^\/+|\/+$/g, '');
          if (fullFilePath) {
            await invoke('register_path_in_index', {
              accountId: nb.accountId, itemId: nb.itemId, path: fullFilePath,
            }).catch(() => {});
          }
          const path = await invoke<string>('open_file', { accountId: nb.accountId, itemId: nb.itemId, force: false, itemName: config.notebookFileName });
          const bytes = await readFile(path);
          content = new TextDecoder().decode(bytes);
          setFileContent(content);
        } catch { /* non-fatal */ }

        let parsedTitle = '';
        if (content) {
          try { parsedTitle = (JSON.parse(content) as { Title?: string }).Title ?? ''; } catch { /* empty */ }
        }
        if (parsedTitle && parsedTitle !== nb.title) {
          await updateNotebook(nb.id, { title: parsedTitle });
          if (!cancelled) setEntry((prev) => prev ? { ...prev, title: parsedTitle } : prev);
        }
        if (!cancelled) {
          setLoading(false);
          if (!nb.title && !parsedTitle) setShowTitlePrompt(true);
        }
      } catch (e) {
        if (!cancelled) { setLoadError(e instanceof Error ? e.message : String(e)); setLoading(false); }
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [notebookId]);

  // ── Persist tabs to IndexedDB whenever they change ───────────────────────────

  useEffect(() => {
    if (!tabsReadyRef.current) return;
    void updateNotebook(notebookId, { tabs, activeTabId, tabsHeaderVisible: showTabsHeader, tabHistory, tabHistoryIndex: historyIndex, splitPairs });
  }, [notebookId, tabs, activeTabId, showTabsHeader, tabHistory, historyIndex, splitPairs]);

  // ── Remove split pairs whose tabs no longer exist ────────────────────────────

  useEffect(() => {
    setSplitPairs((pairs) => pairs.filter(
      (p) => tabs.some((t) => t.id === p.primaryId) && tabs.some((t) => t.id === p.secondaryId)
    ));
  }, [tabs]);

  // ── Window lifecycle ──────────────────────────────────────────────────────────

  useEffect(() => {
    const wlabel = new URLSearchParams(window.location.search).get('wlabel');
    if (!wlabel) return;
    let unlisten: (() => void) | undefined;
    getCurrentWebviewWindow().onCloseRequested(async (e) => {
      e.preventDefault();
      try { await updateNotebook(notebookId, { windowLabel: undefined }); } catch { /* non-fatal */ }
      try { await emit('notebook-window-closed', { notebookId }); } catch { /* non-fatal */ }
      try { await getCurrentWebviewWindow().destroy(); } catch { /* non-fatal */ }
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { if (unlisten) unlisten(); };
  }, [notebookId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebviewWindow().listen('tauri://resize', async () => {
      try { setIsFullscreen(await getCurrentWebviewWindow().isFullscreen()); } catch { /* non-fatal */ }
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { if (unlisten) unlisten(); };
  }, []);

  // ── State broadcast / remote commands ────────────────────────────────────────

  useEffect(() => {
    if (!entry) return;
    void emit('notebook-state', { notebookId, fullscreen: isFullscreen, headerVisible: showHeader });
  }, [notebookId, isFullscreen, showHeader, entry]);

  useEffect(() => {
    const unlisteners: (() => void)[] = [];
    listen('notebook-request-state', () => {
      if (!entry) return;
      void emit('notebook-state', { notebookId, fullscreen: isFullscreen, headerVisible: showHeader });
    }).then((fn) => unlisteners.push(fn)).catch(() => {});
    listen<{ notebookId: string; cmd: string }>('notebook-cmd', async (e) => {
      if (e.payload.notebookId !== notebookId) return;
      if (e.payload.cmd === 'toggle-fullscreen') {
        try { const win = getCurrentWebviewWindow(); const cur = await win.isFullscreen(); await win.setFullscreen(!cur); setIsFullscreen(!cur); } catch { /* non-fatal */ }
      } else if (e.payload.cmd === 'toggle-header') {
        setShowHeader((h) => !h);
      }
    }).then((fn) => unlisteners.push(fn)).catch(() => {});
    return () => unlisteners.forEach((fn) => fn());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebookId, entry, isFullscreen, showHeader]);

  // ── Context menu & edit ───────────────────────────────────────────────────────

  const handleContextMenu = (e: React.MouseEvent) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); };
  const handleCtxEdit = () => { setCtxMenu(null); setEditTitle(entry?.title ?? ''); setEditDesc(entry?.description ?? ''); setShowEdit(true); };
  const handleCtxDelete = async () => { setCtxMenu(null); await deleteNotebook(notebookId); onDeleted(); };
  const handleCtxToggleFullscreen = async () => {
    setCtxMenu(null);
    try { const win = getCurrentWebviewWindow(); const cur = await win.isFullscreen(); await win.setFullscreen(!cur); setIsFullscreen(!cur); } catch { /* non-fatal */ }
  };

  const handleEditSave = async () => {
    if (!entry || !editTitle.trim()) return;
    setSaving(true); setSaveError(null);
    try {
      const oldItemId = entry.itemId;
      let newItemId = oldItemId;
      if (fileContent !== null) {
        const parsed = JSON.parse(fileContent) as Record<string, unknown>;
        parsed.Title = editTitle;
        const updatedJson = JSON.stringify(parsed, null, 2);
        newItemId = await invoke<string>('save_text_file', { accountId: entry.accountId, itemId: oldItemId, parentId: entry.parentId, content: updatedJson, itemName: config.notebookFileName });
        setFileContent(updatedJson);
      }
      await updateNotebooksByFile(entry.accountId, entry.provider, oldItemId, { title: editTitle, ...(newItemId !== oldItemId ? { itemId: newItemId } : {}) });
      await updateNotebook(entry.id, { description: editDesc || undefined });
      setEntry({ ...entry, title: editTitle, description: editDesc || undefined, itemId: newItemId });
      setShowEdit(false);
    } catch (e) { setSaveError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  const handlePromptSave = async () => {
    if (!entry || !promptTitle.trim()) return;
    setSaving(true); setSaveError(null);
    try {
      const oldItemId = entry.itemId;
      let newItemId = oldItemId;
      if (fileContent !== null) {
        const parsed = JSON.parse(fileContent) as Record<string, unknown>;
        parsed.Title = promptTitle;
        const updatedJson = JSON.stringify(parsed, null, 2);
        newItemId = await invoke<string>('save_text_file', { accountId: entry.accountId, itemId: oldItemId, parentId: entry.parentId, content: updatedJson, itemName: config.notebookFileName });
        setFileContent(updatedJson);
      }
      await updateNotebooksByFile(entry.accountId, entry.provider, oldItemId, { title: promptTitle, ...(newItemId !== oldItemId ? { itemId: newItemId } : {}) });
      setEntry({ ...entry, title: promptTitle, itemId: newItemId });
      setShowTitlePrompt(false);
    } catch (e) { setSaveError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  // ── Render guards ─────────────────────────────────────────────────────────────

  if (loading) return <div className="flex items-center justify-center h-64 text-gray-400 dark:text-gray-500">Loading notebook…</div>;

  if (loadError) return (
    <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
      <p className="text-red-500 dark:text-red-400">{loadError}</p>
      <button onClick={onBack} className="px-4 py-2 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600">Back</button>
    </div>
  );

  // ── Icon button style ─────────────────────────────────────────────────────────
  const hdrBtn = 'shrink-0 w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors';

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-white dark:bg-gray-900">

      {/* ── Modals ──────────────────────────────────────────────────────────── */}

      {showTabsList && (() => {
        const displayTabs = tabSortMode ? tabWorkingOrder : tabs;
        const someTabSelected = selectedTabIds.size > 0;
        const allTabsSelected = displayTabs.length > 0 && selectedTabIds.size === displayTabs.length;
        const tbBtn = 'px-2 py-0.5 text-xs rounded-lg transition-colors';
        const tbBtnGray = `${tbBtn} bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600`;
        const tbBtnAmber = `${tbBtn} bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-800/40`;
        const tbBtnEmerald = `${tbBtn} bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-200 dark:hover:bg-emerald-800/40`;
        return (
          <Modal title="Open tabs" onClose={closeTabsList} maxWidth="max-w-xs">
            {/* Toolbar */}
            <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 flex-wrap">
              {/* Back / Forward history buttons */}
              {(() => {
                const iconBtn = 'w-6 h-6 flex items-center justify-center rounded transition-colors text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-30 disabled:pointer-events-none';
                // Skip over history entries whose tabs have been closed.
                let backTarget = -1;
                for (let i = historyPreviewIndex - 1; i >= 0; i--) {
                  if (tabs.some((t) => t.id === tabHistory[i])) { backTarget = i; break; }
                }
                let forwardTarget = -1;
                for (let i = historyPreviewIndex + 1; i <= historyIndex; i++) {
                  if (tabs.some((t) => t.id === tabHistory[i])) { forwardTarget = i; break; }
                }
                return (
                  <>
                    <button
                      onClick={() => { if (backTarget >= 0) setHistoryPreviewIndex(backTarget); }}
                      disabled={backTarget < 0}
                      title="Back"
                      className={iconBtn}
                    >
                      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M7 2L3 6l4 4"/></svg>
                    </button>
                    <button
                      onClick={() => { if (forwardTarget >= 0) setHistoryPreviewIndex(forwardTarget); }}
                      disabled={forwardTarget < 0}
                      title="Forward"
                      className={iconBtn}
                    >
                      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M5 2l4 4-4 4"/></svg>
                    </button>
                  </>
                );
              })()}
              {!allTabsSelected
                ? <button onClick={() => setSelectedTabIds(new Set(displayTabs.map((t) => t.id)))} className={tbBtnGray}>Select all</button>
                : <button onClick={() => setSelectedTabIds(new Set())} className={tbBtnGray}>Deselect all</button>
              }
              {someTabSelected && !allTabsSelected && (
                <button onClick={() => setSelectedTabIds(new Set())} className={tbBtnGray}>Deselect all</button>
              )}
              <div className="flex-1"/>
              {someTabSelected && !tabSortMode && (
                <button onClick={removeSelectedTabs} className={`${tbBtn} bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-800/40`}>Remove</button>
              )}
              {!tabSortMode ? (
                <>
                  <button onClick={enterTabSortMode} className={tbBtnAmber}>Reorder</button>
                  {/* Home button: navigates the current tab to home */}
                  <button
                    onClick={navigateCurrentTabToHome}
                    title="Go to home"
                    className="w-6 h-6 flex items-center justify-center rounded transition-colors text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600 hover:text-gray-700 dark:hover:text-gray-200"
                  >
                    <HomeIcon className="w-3.5 h-3.5"/>
                  </button>
                  {/* Plus button: open a new home tab and make it current */}
                  <button
                    onClick={() => { openNewHomeTab(); }}
                    title="New tab"
                    className="w-6 h-6 flex items-center justify-center rounded transition-colors text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600 hover:text-gray-700 dark:hover:text-gray-200"
                  >
                    <PlusIcon className="w-3.5 h-3.5"/>
                  </button>
                </>
              ) : (
                <>
                  <button onClick={handleTabSubmitOrder} className={tbBtnEmerald}>Apply order</button>
                  <button onClick={cancelTabSortMode} className={tbBtnGray}>Cancel</button>
                </>
              )}
            </div>

            {/* Tab list */}
            <div className="py-1">
              {/* Strip above first row */}
              {tabSortMode && tabStripPos === 0 && (
                <SortStrip hasSelected={someTabSelected} active={tabStripActive} stripPos={tabStripPos} maxPos={tabWorkingOrder.length}
                  onUp={() => setTabStripPos((p) => Math.max(0, p - 1))}
                  onDown={() => setTabStripPos((p) => Math.min(tabWorkingOrder.length, p + 1))}
                  onConfirm={handleTabConfirmMove} />
              )}
              {(() => {
                const previewedId = historyPreviewIndex !== historyIndex
                  ? (tabs.some((t) => t.id === tabHistory[historyPreviewIndex]) ? tabHistory[historyPreviewIndex] : null)
                  : null;
                return displayTabs.map((tab, idx) => {
                const isActive = tab.id === activeTabId;
                const isSelected = selectedTabIds.has(tab.id);
                const isPreviewed = tab.id === previewedId;
                const isSplitPrimary = !tabSortMode && splitPairs.some((p) => p.primaryId === tab.id);
                const isSplitSecondary = !tabSortMode && splitPairs.some((p) => p.secondaryId === tab.id);
                return (
                  <div key={tab.id}>
                    <div
                      onClick={(e) => {
                        if (tabSortMode) { handleTabRowBodyClick(idx); return; }
                        if (e.shiftKey) { handleTabCheck(idx, true, isSelected); return; }
                        if (tab.id === activeTabId && !isPreviewed) { closeTabsList(); return; }
                        if (isPreviewed) {
                          // Commit the previewed history position
                          setHistoryIndex(historyPreviewIndex);
                          setActiveTabId(tab.id);
                          closeTabsList();
                        } else {
                          // Normal navigation: add to history (truncates forward entries)
                          navigateToTab(tab.id);
                          closeTabsList();
                        }
                      }}
                      className={[
                        'flex items-center gap-2 px-3 py-2 transition-colors cursor-pointer',
                        isSelected
                          ? 'bg-blue-50 dark:bg-blue-900/20'
                          : isPreviewed
                            ? 'bg-violet-50 dark:bg-violet-900/20 ring-1 ring-inset ring-violet-300 dark:ring-violet-700'
                            : isActive
                              ? 'bg-emerald-50 dark:bg-emerald-900/20'
                              : 'hover:bg-gray-50 dark:hover:bg-gray-700',
                      ].join(' ')}
                    >
                      {/* Checkbox */}
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {}}
                        onClick={(e) => { e.stopPropagation(); handleTabCheck(idx, e.shiftKey, e.shiftKey && isSelected); }}
                        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleTabCheck(idx, true, isSelected); }}
                        className="shrink-0 accent-blue-500 w-3.5 h-3.5"
                      />
                      <span className={`shrink-0 ${isSelected ? 'text-blue-500 dark:text-blue-400' : isPreviewed ? 'text-violet-600 dark:text-violet-400' : notesViewingTabIds.has(tab.id) ? 'text-amber-500 dark:text-amber-400' : isActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400 dark:text-gray-500'}`}>
                        {tabIcon(tab.type, 'w-3.5 h-3.5')}
                      </span>
                      <span className={`flex-1 text-sm truncate ${isSelected ? 'text-blue-700 dark:text-blue-300' : isPreviewed ? 'text-violet-700 dark:text-violet-300 font-medium' : isActive ? 'text-emerald-700 dark:text-emerald-300 font-medium' : 'text-gray-700 dark:text-gray-200'}`}>
                        {tab.name}
                      </span>
                      {isSplitPrimary && (
                        <span title="Left / top in a split view" className="shrink-0 text-amber-500 dark:text-amber-400">
                          <svg viewBox="0 0 10 8" className="w-3 h-2.5" fill="currentColor" aria-hidden>
                            <rect x="0" y="0" width="4.5" height="8"/><rect x="5.5" y="0" width="4.5" height="8" fillOpacity="0.25"/>
                          </svg>
                        </span>
                      )}
                      {isSplitSecondary && (
                        <span title="Right / bottom in a split view" className="shrink-0 text-sky-500 dark:text-sky-400">
                          <svg viewBox="0 0 10 8" className="w-3 h-2.5" fill="currentColor" aria-hidden>
                            <rect x="0" y="0" width="4.5" height="8" fillOpacity="0.25"/><rect x="5.5" y="0" width="4.5" height="8"/>
                          </svg>
                        </span>
                      )}
                      {!tabSortMode && tabs.length > 1 && (
                        <button
                          onClick={(e) => { e.stopPropagation(); closeTab(tab.id); if (tabs.length === 1) closeTabsList(); }}
                          className="shrink-0 text-gray-400 hover:text-red-500 dark:hover:text-red-400 w-5 h-5 flex items-center justify-center rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                          title="Close tab"
                        >
                          <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="w-2.5 h-2.5"><path d="M1 1l8 8M9 1L1 9"/></svg>
                        </button>
                      )}
                    </div>
                    {/* Strip below this row */}
                    {tabSortMode && tabStripPos === idx + 1 && (
                      <SortStrip hasSelected={someTabSelected} active={tabStripActive} stripPos={tabStripPos} maxPos={tabWorkingOrder.length}
                        onUp={() => setTabStripPos((p) => Math.max(0, p - 1))}
                        onDown={() => setTabStripPos((p) => Math.min(tabWorkingOrder.length, p + 1))}
                        onConfirm={handleTabConfirmMove} />
                    )}
                  </div>
                );
              });
              })()}
            </div>
          </Modal>
        );
      })()}

      {splitOptionsMenu && (
        <Popover title="Tab options" onClose={() => setSplitOptionsMenu(null)} panelStyle={{ left: splitOptionsMenu.x, top: splitOptionsMenu.y }}>
          {(() => {
            const check = <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 shrink-0"><path d="M1.5 6l3 3 6-6"/></svg>;
            const row = 'w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2';
            const close = () => setSplitOptionsMenu(null);
            return (
              <div className="py-1">
                {tabs.length > 1 && (
                  <>
                    <button onClick={() => { enableSplit('vertical'); close(); }} className={row}>
                      {activeSplitPair?.mode === 'vertical' ? check : <span className="w-3"/>}
                      <span>Split Tabs Vertically</span>
                    </button>
                    <button onClick={() => { enableSplit('horizontal'); close(); }} className={row}>
                      {activeSplitPair?.mode === 'horizontal' ? check : <span className="w-3"/>}
                      <span>Split Tabs Horizontally</span>
                    </button>
                    {activeSplitPair && (
                      <button onClick={() => { swapSplitTabs(activeSplitPair.id); close(); }} className={row}>
                        <span className="w-3"/>
                        <span>Swap split tabs</span>
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })()}
        </Popover>
      )}

      {homeCtxMenu && (
        <Popover title={homeCtxMenu.name} onClose={() => setHomeCtxMenu(null)} panelStyle={{ left: homeCtxMenu.x, top: homeCtxMenu.y }}>
          <div className="py-1">
            <button onClick={() => { navigateCurrentTabTo(homeCtxMenu.type, homeCtxMenu.name); setHomeCtxMenu(null); }} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">Open in current tab</button>
            <button onClick={() => { openInNewTab(homeCtxMenu.type, homeCtxMenu.name, false); setHomeCtxMenu(null); }} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">Open in new tab</button>
            <button onClick={() => { openInNewTab(homeCtxMenu.type, homeCtxMenu.name, true); setHomeCtxMenu(null); }} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">Open in new tab and stay here</button>
          </div>
        </Popover>
      )}

      {ctxMenu && (
        <Popover title={entry?.title || '(Untitled)'} onClose={() => setCtxMenu(null)} panelStyle={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <div className="py-1">
            <button onClick={handleCtxEdit} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">Edit</button>
            <button onClick={handleCtxToggleFullscreen} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">{isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}</button>
            <button onClick={handleCtxDelete} className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-50 dark:hover:bg-gray-700">Remove</button>
            <div className="border-t border-gray-100 dark:border-gray-700 my-1"/>
            <button onClick={() => { setCtxMenu(null); toggleTheme(); }} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2">
              {theme === 'dark'
                ? <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707M17.657 17.657l-.707-.707M6.343 6.343l-.707-.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
                : <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>
              }
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
          </div>
        </Popover>
      )}

      {showEdit && (
        <Modal title="Edit Notebook">
          <div className="p-6 space-y-4">
            {saveError && <p className="text-sm text-red-500 dark:text-red-400">{saveError}</p>}
            <div className="space-y-3">
              <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Title</label>
                <input type="text" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
              </div>
              <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
                <textarea value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="Description (optional) — stored locally only" rows={3} className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none"/>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => { setShowEdit(false); setSaveError(null); }} className="px-4 py-2 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600">Cancel</button>
              <button onClick={handleEditSave} disabled={saving || !editTitle.trim()} className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40">{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </Modal>
      )}

      {showTitlePrompt && (
        <Modal title="Name this Notebook">
          <div className="p-6 space-y-4">
            <p className="text-sm text-gray-500 dark:text-gray-400">This notebook has no title yet.</p>
            {saveError && <p className="text-sm text-red-500 dark:text-red-400">{saveError}</p>}
            <input type="text" value={promptTitle} onChange={(e) => setPromptTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && promptTitle.trim()) void handlePromptSave(); }}
              placeholder="Notebook title" autoFocus // eslint-disable-line jsx-a11y/no-autofocus
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
            <div className="flex justify-end">
              <button onClick={handlePromptSave} disabled={saving || !promptTitle.trim()} className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40">{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Main notebook header ──────────────────────────────────────────────── */}

      {showHeader && (
        <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-3 py-2 shrink-0" onContextMenu={handleContextMenu}>
          <div className="flex items-center gap-1.5">
            {!isSecondaryWindow && (
              <button onClick={onBack} title="Back" className={hdrBtn}>
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M9 1L3 7l6 6"/></svg>
              </button>
            )}
            <NotebookIcon />
            <div className="flex-1 min-w-0 px-1">
              <p className="font-semibold text-sm text-gray-900 dark:text-white truncate">{entry?.title || '(Untitled notebook)'}</p>
              {(entry?.description || entry?.displayPath) && (
                <p className={`text-xs truncate ${entry?.description ? 'text-gray-500 dark:text-gray-400' : 'text-gray-400 dark:text-gray-500 italic'}`}>
                  {entry?.description ?? entry?.displayPath}
                </p>
              )}
            </div>
            {/* Expand tabs header — only shown when tabs header is hidden */}
            {!showTabsHeader && (
              <button onClick={() => setShowTabsHeader(true)} title="Show tabs header" className={hdrBtn}>
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M2 4L7 10l5-6"/></svg>
              </button>
            )}
            {/* Hide main header */}
            <button onClick={() => setShowHeader(false)} title="Hide header" className={hdrBtn}>
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M2 10L7 4l5 6"/></svg>
            </button>
          </div>
        </div>
      )}

      {/* ── Tabs header (single — hidden when split is active) ────────────────── */}

      {showTabsHeader && !activeSplitPair && (
        <div className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-3 py-1.5 shrink-0 flex items-center gap-2">
          <span className={`shrink-0 ${notesViewingTabIds.has(activeTabId) ? 'text-amber-500 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400'}`}>
            {tabIcon(activeTab.type, 'w-3.5 h-3.5')}
          </span>
          <span className="flex-1 text-sm font-medium text-gray-700 dark:text-gray-200 truncate select-none">
            {activeTab.name}
          </span>
          {/* Minimized-stack restore indicator */}
          {minimizedExplorerTabs.size > 0 && (
            <button onClick={handleRestoreMinimized} title="Restore minimized modals" className={`${hdrBtn} text-amber-500 dark:text-amber-400 hover:text-amber-600 dark:hover:text-amber-300`}>
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                <rect x="1" y="4" width="12" height="8" rx="1"/>
                <rect x="3" y="2" width="8" height="2" rx="0.5" fill="currentColor" stroke="none" opacity="0.5"/>
              </svg>
            </button>
          )}
          <button onClick={() => { setHistoryPreviewIndex(historyIndex); setShowTabsList((o) => !o); }} title="Open tabs" className={hdrBtn}>
            <TabsListIcon className="w-3.5 h-3.5"/>
          </button>
          <button onClick={() => setShowTabsHeader(false)} title="Hide tabs header" className={hdrBtn}>
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M2 10L7 4l5 6"/></svg>
          </button>
          {/* Three-dots — only when 2+ tabs open */}
          {tabs.length > 1 && (
            <button onClick={(e) => setSplitOptionsMenu({ x: e.clientX, y: e.clientY })} title="Tab options" className={hdrBtn}>
              <MoreDotsIcon className="w-3.5 h-3.5"/>
            </button>
          )}
          {tabs.length > 1 && (
            <button onClick={closeCurrentTab} title="Close tab" className={hdrBtn}>
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="w-3.5 h-3.5"><path d="M2 2l10 10M12 2L2 12"/></svg>
            </button>
          )}
        </div>
      )}

      {/* ── Tab content (split-aware) ─────────────────────────────────────────── */}

      {(() => {
        const renderTabContent = (tab: NbTab) => (
          <>
            {tab.type === 'home' && (
              <NotebookHomeTab
                onOpenExplorer={() => navigateCurrentTabTo('notes-explorer', 'Notes Explorer')}
                onOpenAllFiles={() => navigateCurrentTabTo('all-files-explorer', 'All Files Explorer')}
                onNewTab={openNewHomeTabWithModal}
                onOpenSettings={() => navigateCurrentTabTo('settings', 'Notebook Settings')}
                onContextMenu={(type, name, e) => { e.preventDefault(); setHomeCtxMenu({ x: e.clientX, y: e.clientY, type, name }); }}
                onQuickActions={() => {}}
              />
            )}
            {tab.type === 'all-files-explorer' && entry && (
              <AllFilesExplorerTab
                accountId={entry.accountId}
                onMinimizedChange={(isMin) => handleExplorerMinimizedChange(tab.id, isMin)}
                restoreTrigger={explorerRestoreTriggers.get(tab.id) ?? 0}
                instanceKey={tab.id}
                onFolderPathChange={(name, path) => handleExplorerFolderPathChange(tab.id, name, path)}
                prevExplorerPath={getPrevExplorerPath(tab.id)}
                onViewingFileChange={(fileName) => handleExplorerViewingFileChange(tab.id, fileName)}
              />
            )}
            {tab.type === 'settings' && <PlaceholderTab label="Notebook Settings" />}
          </>
        );

        const primaryTab = activeSplitPair ? (tabs.find((t) => t.id === activeSplitPair.primaryId) ?? activeTab) : activeTab;
        const secondaryTab = activeSplitPair ? (tabs.find((t) => t.id === activeSplitPair.secondaryId) ?? null) : null;

        if (activeSplitPair && secondaryTab) {
          const isVertical = activeSplitPair.mode === 'vertical';
          const dividerCls = isVertical ? 'border-r border-gray-200 dark:border-gray-700' : 'border-b border-gray-200 dark:border-gray-700';
          const openTabsList = () => { setHistoryPreviewIndex(historyIndex); setShowTabsList(true); };
          return (
            <div className={`flex-1 min-h-0 flex ${isVertical ? 'flex-row' : 'flex-col'} overflow-hidden`}>
              {/* Primary panel (left / top) */}
              <div className={`flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden ${dividerCls}`}>
                {showTabsHeader && (
                  <SplitTabHeader tab={primaryTab} isPrimary isNotesViewing={notesViewingTabIds.has(primaryTab.id)} onClose={() => closeTabById(activeSplitPair.primaryId)} onOpenTabsList={openTabsList}/>
                )}
                <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                  {renderTabContent(primaryTab)}
                </div>
              </div>
              {/* Secondary panel (right / bottom) */}
              <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
                {showTabsHeader && (
                  <SplitTabHeader tab={secondaryTab} isPrimary={false} isNotesViewing={notesViewingTabIds.has(secondaryTab.id)} onClose={() => closeTabById(activeSplitPair.secondaryId)}
                    onOpenSplitOptions={(e) => setSplitOptionsMenu({ x: e.clientX, y: e.clientY })}/>
                )}
                <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                  {renderTabContent(secondaryTab)}
                </div>
              </div>
            </div>
          );
        }

        // Notes-explorer and all-files-explorer tabs stay permanently mounted so
        // their state survives tab switches. Other tab types unmount when inactive.
        return (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {tabs.filter((t) => t.type === 'notes-explorer').map((tab) => (
              <div
                key={tab.id}
                className={tab.id === activeTabId ? 'flex-1 min-h-0 flex flex-col overflow-hidden' : 'hidden'}
              >
                {entry && (
                  <NotesExplorer
                    accountId={entry.accountId}
                    notebookParentId={entry.parentId}
                    notebookFolderRelPath={(() => {
                      const p = entry.displayPath ?? '';
                      const slash = p.lastIndexOf('/');
                      return slash >= 0 ? p.substring(0, slash) : '';
                    })()}
                    instanceKey={tab.id}
                    onDisplayNameChange={(name) => setTabs((prev) => prev.map((t) => t.id === tab.id ? { ...t, name } : t))}
                    onViewingFileChange={(isViewing) => handleNotesViewingFileChange(tab.id, isViewing)}
                    onQuickActions={() => {}}
                  />
                )}
              </div>
            ))}
            {tabs.filter((t) => t.type === 'all-files-explorer').map((tab) => (
              <div
                key={tab.id}
                className={tab.id === activeTabId ? 'flex-1 min-h-0 flex flex-col overflow-hidden' : 'hidden'}
              >
                {entry && (
                  <AllFilesExplorerTab
                    accountId={entry.accountId}
                    onMinimizedChange={(isMin) => handleExplorerMinimizedChange(tab.id, isMin)}
                    restoreTrigger={explorerRestoreTriggers.get(tab.id) ?? 0}
                    instanceKey={tab.id}
                    onFolderPathChange={(name, path) => handleExplorerFolderPathChange(tab.id, name, path)}
                    prevExplorerPath={getPrevExplorerPath(tab.id)}
                    onViewingFileChange={(fileName) => handleExplorerViewingFileChange(tab.id, fileName)}
                  />
                )}
              </div>
            ))}
            {activeTab.type !== 'all-files-explorer' && activeTab.type !== 'notes-explorer' && renderTabContent(activeTab)}
          </div>
        );
      })()}
    </div>
  );
}
