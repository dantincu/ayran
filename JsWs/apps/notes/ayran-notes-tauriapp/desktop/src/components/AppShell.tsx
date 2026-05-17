import { useState, useEffect, useRef } from 'react';
import Popover from './common/Popover';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow, getAllWebviewWindows } from '@tauri-apps/api/webviewWindow';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import type { StoredAccount, CachedItem } from '../types';
import { listAccounts, upsertAccount, deleteAccount } from '../lib/account-store';
import { connectGoogleDrive } from '../lib/google-auth';
import { addNotebook } from '../lib/notebooks-db';
import { useTheme } from '../hooks/useTheme';
import ManageAccountsPage from './ManageAccountsPage';
import ShelvesetChangesModal from './explorer/ShelvesetChangesModal';
import MoveDataDirsModal from './MoveDataDirsModal';
import InterruptedMoveModal from './InterruptedMoveModal';
import GoogleDriveExplorer from './explorer/GoogleDriveExplorer';
import FilenExplorer from './explorer/FilenExplorer';
import FileSystemExplorer from './explorer/FileSystemExplorer';
import FilenLoginModal from './FilenLoginModal';
import FileViewer from './explorer/FileViewer';
import DevToolsPage from './devTools/DevToolsPage';
import ManageNotebooksPage from './notebook/ManageNotebooksPage';
import NotebookPage from './notebook/NotebookPage';
import SettingsPage from './SettingsPage';

const isMainWindow = getCurrentWebviewWindow().label === 'main';
const isNotebookWindow = !!new URLSearchParams(window.location.search).get('wlabel');

type Page = 'files' | 'notebooks' | 'devtools' | 'notebook' | 'accounts' | 'settings';

const PAGE_KEY = 'notes-current-page';
const VIEWER_KEY = 'notes-viewer-v1';

export default function AppShell() {
  const [accounts, setAccounts] = useState<StoredAccount[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [, setConnecting] = useState(false);
  const [showFilenLogin, setShowFilenLogin] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<{
    account: StoredAccount;
    item: CachedItem;
    displayPath: string;
    siblings?: CachedItem[];
    siblingIdx?: number;
  } | null>(null);
  const [currentPage, setCurrentPage] = useState<Page>(() => {
    if (new URLSearchParams(window.location.search).get('notebook')) return 'notebook';
    return (localStorage.getItem(PAGE_KEY) as Page | null) ?? 'files';
  });
  const [notebookNavId, setNotebookNavId] = useState<string | null>(() => {
    const urlParam = new URLSearchParams(window.location.search).get('notebook');
    return urlParam ?? localStorage.getItem('notes-notebook-id');
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [acctSwitcherOpen, setAcctSwitcherOpen] = useState(false);
  const [explorerCompact, setExplorerCompact] = useState(false);
  const [highlightItemId, setHighlightItemId] = useState<string | null>(null);
  const [shelvesetModalOpen, setShelvesetModalOpen] = useState(false);
  const [moveInProgress, setMoveInProgress] = useState(false);
  const [interruptedMove, setInterruptedMove] = useState<{ old: string; new: string } | null>(null);
  const { theme, toggleTheme } = useTheme();
  const acctSwitcherRef = useRef<HTMLDivElement>(null);
  // Must be true before the persist effect is allowed to write/clear storage,
  // so the initial null render doesn't wipe a saved viewer on startup.
  const viewerRestoredRef = useRef(false);

  useEffect(() => {
    listAccounts().then((accs) => {
      setAccounts(accs);
      if (accs.length === 0) {
        setCurrentPage('accounts');
        viewerRestoredRef.current = true;
        return;
      }
      const saved = localStorage.getItem('notes-selected-account');
      const id = saved && accs.some((a) => a.id === saved) ? saved : accs[0].id;
      setSelectedId(id);
      // Restore persisted file viewer session.
      try {
        const raw = localStorage.getItem(VIEWER_KEY);
        if (raw) {
          const { accountId, item, displayPath } = JSON.parse(raw) as {
            accountId: string; item: CachedItem; displayPath: string;
          };
          const account = accs.find((a) => a.id === accountId);
          if (account) setViewingFile({ account, item, displayPath });
        }
      } catch { /* ignore corrupt storage */ }
      viewerRestoredRef.current = true;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedId) localStorage.setItem('notes-selected-account', selectedId);
  }, [selectedId]);

  useEffect(() => {
    if (notebookNavId) localStorage.setItem('notes-notebook-id', notebookNavId);
  }, [notebookNavId]);

  useEffect(() => {
    if (currentPage !== 'accounts') localStorage.setItem(PAGE_KEY, currentPage);
  }, [currentPage]);

  // Persist the active file viewer so it can be restored on next app launch.
  useEffect(() => {
    if (!viewerRestoredRef.current) return; // skip the initial null render
    if (viewingFile) {
      localStorage.setItem(VIEWER_KEY, JSON.stringify({
        accountId: viewingFile.account.id,
        item: viewingFile.item,
        displayPath: viewingFile.displayPath,
        // siblings intentionally excluded — stale after restart
      }));
    } else {
      localStorage.removeItem(VIEWER_KEY);
    }
  }, [viewingFile]);

  // Close account switcher on outside click
  useEffect(() => {
    if (!acctSwitcherOpen) return;
    const handler = (e: MouseEvent) => {
      if (acctSwitcherRef.current && !acctSwitcherRef.current.contains(e.target as Node)) {
        setAcctSwitcherOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [acctSwitcherOpen]);

  useEffect(() => {
    if (getCurrentWebviewWindow().label !== 'main') return;
    let unlisten: (() => void) | undefined;
    getCurrentWebviewWindow().onCloseRequested(async (e) => {
      e.preventDefault();
      try {
        const windows = await getAllWebviewWindows();
        await Promise.all(windows.filter((w) => w.label !== 'main').map((w) => w.destroy().catch(() => {})));
      } catch { /* non-fatal */ }
      try { await getCurrentWebviewWindow().destroy(); } catch { /* non-fatal */ }
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { if (unlisten) unlisten(); };
  }, []);

  // Check data-dir move state on startup and subscribe to move events.
  useEffect(() => {
    invoke<boolean>('is_move_in_progress').then((inProgress) => {
      if (inProgress) setMoveInProgress(true);
    }).catch(() => {});

    invoke<{ old: string; new: string } | null>('get_interrupted_move_info').then((info) => {
      if (info) setInterruptedMove(info);
    }).catch(() => {});

    const unlisteners: (() => void)[] = [];
    listen('data-dirs-move-started', () => setMoveInProgress(true))
      .then((fn) => unlisteners.push(fn)).catch(() => {});
    listen('data-dirs-move-done', () => setMoveInProgress(false))
      .then((fn) => unlisteners.push(fn)).catch(() => {});
    listen('data-dirs-move-cancelled', () => setMoveInProgress(false))
      .then((fn) => unlisteners.push(fn)).catch(() => {});
    return () => unlisteners.forEach((fn) => fn());
  }, []);

  const selected = accounts.find((a) => a.id === selectedId) ?? null;
  const refresh = async () => { setAccounts(await listAccounts()); };

  const handleConnectGoogle = async () => {
    setConnecting(true); setConnectError(null);
    await connectGoogleDrive(
      async (account) => {
        const updated = [...accounts.filter((a) => a.id !== account.id), account];
        setAccounts(updated);
        setSelectedId(account.id);
        setConnecting(false);
        if (currentPage === 'accounts') setCurrentPage('files');
      },
      (msg) => { setConnectError(msg); setConnecting(false); }
    );
  };

  const handleFilenSuccess = (account: StoredAccount) => {
    setShowFilenLogin(false);
    const updated = [...accounts.filter((a) => a.id !== account.id), account];
    setAccounts(updated);
    setSelectedId(account.id);
    if (currentPage === 'accounts') setCurrentPage('files');
  };

  const handleConnectFs = async () => {
    const sel = await dialogOpen({ directory: true, multiple: false });
    if (!sel || typeof sel !== 'string') return;
    const name = sel.split(/[\\/]/).pop() ?? sel;
    const account: StoredAccount = {
      id: `fs-${Date.now()}`, email: name, displayName: name,
      provider: 'local-fs', path: sel,
    };
    await upsertAccount(account);
    setAccounts((p) => [...p, account]);
    setSelectedId(account.id);
    if (currentPage === 'accounts') setCurrentPage('files');
  };

  const handleDisconnect = async (id: string) => {
    await deleteAccount(id);
    await refresh();
    const remaining = accounts.filter((a) => a.id !== id);
    if (selectedId === id) setSelectedId(remaining[0]?.id ?? null);
    if (remaining.length === 0) setCurrentPage('accounts');
  };

  const handleExplorerDisconnect = async () => {
    if (!selected) return;
    await deleteAccount(selected.id);
    const remaining = accounts.filter((a) => a.id !== selected.id);
    setAccounts(remaining);
    setSelectedId(remaining[0]?.id ?? null);
    if (remaining.length === 0) setCurrentPage('accounts');
  };

  const navigateTo = (page: Page) => { setCurrentPage(page); setMenuOpen(false); };

  const handleActivateShelveset = async () => {
    if (!selected) return;
    setMenuOpen(false);
    try {
      await invoke('shelveset_activate', { accountId: selected.id });
      setAccounts((prev) => prev.map((a) => a.id === selected.id ? { ...a, shelvesetActive: true } : a));
    } catch (e) { alert(String(e)); }
  };

  const handleDeleteAccountCache = async (id: string) => {
    if (!confirm('Delete all cached folder/file data for this account?')) return;
    try { await invoke('delete_account_cache', { accountId: id }); }
    catch (e) { alert(String(e)); }
  };

  const handleDeleteAccountAppData = async (id: string) => {
    if (!confirm('Delete ALL app data for this account? This will remove the account connection as well.')) return;
    try {
      await invoke('delete_account_app_data', { accountId: id });
      await handleDisconnect(id);
    } catch (e) { alert(String(e)); }
  };

  const handleOpenNotebook = async (info: { title: string; itemId: string; parentId: string; displayName: string; description?: string }) => {
    if (!selected) return;
    const entry = await addNotebook({
      accountId: selected.id,
      provider: selected.provider,
      itemId: info.itemId,
      parentId: info.parentId,
      displayPath: info.displayName,
      title: info.title,
      description: info.description,
    });
    setViewingFile(null);
    setNotebookNavId(entry.id);
    setCurrentPage('notebook');
  };

  const handleOpenFile = (
    account: StoredAccount,
    item: CachedItem,
    displayPath: string,
    siblings?: CachedItem[],
    siblingIdx?: number,
  ) => {
    setViewingFile({ account, item, displayPath, siblings, siblingIdx });
  };

  const handleFileNavigate = (item: CachedItem, siblingIdx: number) => {
    if (!viewingFile) return;
    setViewingFile({ ...viewingFile, item, siblingIdx });
  };

  const selectedLabel = selected
    ? (selected.displayName ?? selected.email)
    : null;

  const isFilesPage = currentPage === 'files';

  return (
    <>
      {showFilenLogin && (
        <FilenLoginModal onSuccess={handleFilenSuccess} onClose={() => setShowFilenLogin(false)} />
      )}

      {moveInProgress && (
        <MoveDataDirsModal isMainWindow={isMainWindow} onDone={() => setMoveInProgress(false)} />
      )}

      {interruptedMove && (
        <InterruptedMoveModal
          oldPath={interruptedMove.old}
          newPath={interruptedMove.new}
          onDismiss={() => setInterruptedMove(null)}
        />
      )}

      {shelvesetModalOpen && selected && (
        <ShelvesetChangesModal
          account={selected}
          onClose={() => setShelvesetModalOpen(false)}
          onDiscarded={() => {
            setShelvesetModalOpen(false);
            setAccounts((prev) => prev.map((a) =>
              a.id === selected.id ? { ...a, shelvesetActive: false } : a
            ));
          }}
          onCommitted={() => {
            setShelvesetModalOpen(false);
            setAccounts((prev) => prev.map((a) =>
              a.id === selected.id ? { ...a, shelvesetActive: false } : a
            ));
          }}
        />
      )}

      {viewingFile && (
        <FileViewer
          key={viewingFile.item.itemId}
          account={viewingFile.account}
          item={viewingFile.item}
          displayPath={viewingFile.displayPath}
          siblings={viewingFile.siblings}
          siblingIdx={viewingFile.siblingIdx}
          onClose={() => { setHighlightItemId(viewingFile.item.itemId); setViewingFile(null); }}
          onOpenNotebook={handleOpenNotebook}
          onNavigate={handleFileNavigate}
        />
      )}

      <div className="h-screen flex flex-col overflow-hidden">
        {/* App header — same height on all pages; fades out when explorer is compact */}
        <div className={`shrink-0 transition-[max-height,opacity] duration-200 ${isFilesPage && explorerCompact ? 'max-h-0 opacity-0 overflow-hidden' : 'max-h-[80px] opacity-100 overflow-visible'}`}>
        <header className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shrink-0">
          <h1 className="text-lg font-bold text-gray-900 dark:text-white flex-1 truncate">Ayran Notes</h1>

          {/* Account switcher (files page only) */}
          {isFilesPage && accounts.length > 0 && (
            <div ref={acctSwitcherRef} className="relative">
              <button
                onClick={() => setAcctSwitcherOpen((o) => !o)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-colors max-w-[200px] ${
                  selected?.shelvesetActive
                    ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 ring-1 ring-amber-400 dark:ring-amber-600 hover:bg-amber-200 dark:hover:bg-amber-800/50'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {selected?.shelvesetActive && (
                  <svg viewBox="0 0 14 14" fill="currentColor" className="w-3 h-3 shrink-0 text-amber-500 dark:text-amber-400">
                    <circle cx="7" cy="7" r="3.5"/>
                  </svg>
                )}
                <span className="truncate">{selectedLabel ?? 'No account'}</span>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" className="shrink-0 opacity-60">
                  <path d="M6 8L1 3h10z" />
                </svg>
              </button>
              {acctSwitcherOpen && (
                <div className="absolute left-0 top-full mt-1 z-50 min-w-[200px] max-w-[280px] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1">
                  {accounts.map((a) => (
                    <button key={a.id} onClick={() => { setSelectedId(a.id); setAcctSwitcherOpen(false); }}
                      className={`w-full text-left px-3 py-2 text-sm truncate transition-colors ${a.id === selectedId ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 font-medium' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>
                      {a.displayName ?? a.email}
                    </button>
                  ))}
                  <div className="border-t border-gray-100 dark:border-gray-700 mt-1 pt-1">
                    <button onClick={() => { setAcctSwitcherOpen(false); navigateTo('accounts'); }}
                      className="w-full text-left px-3 py-2 text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                      Manage accounts…
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Three-dots menu */}
          <div className="relative">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
              title="Options"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
                <circle cx="9" cy="3"  r="1.6"/>
                <circle cx="9" cy="9"  r="1.6"/>
                <circle cx="9" cy="15" r="1.6"/>
              </svg>
            </button>
            {menuOpen && (
              <Popover title="Navigation" onClose={() => setMenuOpen(false)} panelClassName="absolute right-0 top-full mt-1 min-w-[160px]">
                <div className="py-1">
                  <button onClick={() => navigateTo('files')} className={`w-full text-left px-4 py-2 text-sm transition-colors ${currentPage === 'files' ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>
                    Files
                  </button>
                  <button onClick={() => navigateTo('notebooks')} className={`w-full text-left px-4 py-2 text-sm transition-colors ${currentPage === 'notebooks' || currentPage === 'notebook' ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>
                    Notebooks
                  </button>
                  <button onClick={() => navigateTo('accounts')} className={`w-full text-left px-4 py-2 text-sm transition-colors ${currentPage === 'accounts' ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>
                    Accounts
                  </button>
                  <button onClick={() => navigateTo('settings')} className={`w-full text-left px-4 py-2 text-sm transition-colors ${currentPage === 'settings' ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>
                    Settings
                  </button>
                  <button onClick={() => navigateTo('devtools')} className={`w-full text-left px-4 py-2 text-sm transition-colors ${currentPage === 'devtools' ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>
                    DevTools
                  </button>
                  {isFilesPage && selected && selected.provider !== 'local-fs' && (
                    <>
                      <div className="border-t border-gray-100 dark:border-gray-700 my-1"/>
                      {!selected.shelvesetActive ? (
                        <button onClick={handleActivateShelveset} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2">
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4 shrink-0 text-amber-500"><rect x="2" y="4" width="12" height="9" rx="1.5"/><path d="M5 4V3a3 3 0 016 0v1"/></svg>
                          Create shelveset
                        </button>
                      ) : (
                        <button onClick={() => { setMenuOpen(false); setShelvesetModalOpen(true); }} className="w-full text-left px-4 py-2 text-sm text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/20 flex items-center gap-2">
                          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 shrink-0 text-amber-500"><circle cx="8" cy="8" r="3"/><path fillRule="evenodd" d="M8 1a7 7 0 100 14A7 7 0 008 1zM0 8a8 8 0 1116 0A8 8 0 010 8z"/></svg>
                          View pending changes
                        </button>
                      )}
                    </>
                  )}
                  <div className="border-t border-gray-100 dark:border-gray-700 my-1"/>
                  <button onClick={() => { setMenuOpen(false); toggleTheme(); }} className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2">
                    {theme === 'dark'
                      ? <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707M17.657 17.657l-.707-.707M6.343 6.343l-.707-.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
                      : <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>
                    }
                    {theme === 'dark' ? 'Light mode' : 'Dark mode'}
                  </button>
                </div>
              </Popover>
            )}
          </div>
        </header>
        </div>{/* end animated header wrapper */}

        {/* Page content */}
        {currentPage === 'accounts' && (
          <div className="py-6 px-4 overflow-y-auto flex-1">
            <ManageAccountsPage
              accounts={accounts}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onDisconnect={handleDisconnect}
              onConnectGoogle={handleConnectGoogle}
              onConnectFilen={() => setShowFilenLogin(true)}
              onConnectFs={handleConnectFs}
              connectError={connectError}
              onDeleteCache={handleDeleteAccountCache}
              onDeleteAppData={handleDeleteAccountAppData}
            />
          </div>
        )}

        {(currentPage === 'notebooks' || currentPage === 'notebook') && (
          isNotebookWindow && notebookNavId
            ? <NotebookPage
                notebookId={notebookNavId}
                onBack={() => setCurrentPage('notebooks')}
                onDeleted={() => setCurrentPage('notebooks')}
              />
            : <div className="py-6 px-4 overflow-y-auto flex-1">
                <ManageNotebooksPage />
              </div>
        )}

        {currentPage === 'settings' && (
          <div className="py-6 px-4 overflow-y-auto flex-1">
            <SettingsPage />
          </div>
        )}

        {currentPage === 'devtools' && (
          <div className="py-6 px-4 overflow-y-auto flex-1">
            <DevToolsPage />
          </div>
        )}

        {currentPage === 'files' && (
          <div className="flex-1 overflow-hidden">
            {selected?.provider === 'google-drive' && (
              <GoogleDriveExplorer key={selected.id} account={selected} onDisconnect={handleExplorerDisconnect}
                onOpenFile={(item, displayPath, siblings, siblingIdx) => handleOpenFile(selected, item, displayPath, siblings, siblingIdx)}
                onOpenNotebook={handleOpenNotebook} onCompactChange={setExplorerCompact}
                highlightItemId={highlightItemId ?? undefined} />
            )}
            {selected?.provider === 'filen' && (
              <FilenExplorer key={selected.id} account={selected} onDisconnect={handleExplorerDisconnect}
                onNeedsRelogin={() => setShowFilenLogin(true)}
                onOpenFile={(item, displayPath, siblings, siblingIdx) => handleOpenFile(selected, item, displayPath, siblings, siblingIdx)}
                onOpenNotebook={handleOpenNotebook} onCompactChange={setExplorerCompact}
                highlightItemId={highlightItemId ?? undefined} />
            )}
            {selected?.provider === 'local-fs' && (
              <FileSystemExplorer key={selected.id} account={selected} onDisconnect={handleExplorerDisconnect}
                onOpenFile={(item, displayPath, siblings, siblingIdx) => handleOpenFile(selected, item, displayPath, siblings, siblingIdx)}
                onOpenNotebook={handleOpenNotebook} onCompactChange={setExplorerCompact}
                highlightItemId={highlightItemId ?? undefined} />
            )}
            {!selected && (
              <div className="flex flex-col items-center justify-center h-full text-center text-gray-400 dark:text-gray-500 p-8">
                <svg className="w-12 h-12 mb-3 text-gray-300 dark:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <p className="text-lg font-medium">No storage connected</p>
                <p className="text-sm mt-1">Connect an account in <button onClick={() => navigateTo('accounts')} className="underline hover:text-gray-600 dark:hover:text-gray-300">Accounts</button></p>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
