import { useState, useEffect, useRef } from 'react';
import Popover from './common/Popover';
import { getCurrentWebviewWindow, getAllWebviewWindows } from '@tauri-apps/api/webviewWindow';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import type { StoredAccount, CachedItem } from '../types';
import { listAccounts, upsertAccount, deleteAccount } from '../lib/account-store';
import { connectGoogleDrive } from '../lib/google-auth';
import { addNotebook } from '../lib/notebooks-db';
import ManageAccountsPage from './ManageAccountsPage';
import GoogleDriveExplorer from './explorer/GoogleDriveExplorer';
import FilenExplorer from './explorer/FilenExplorer';
import FileSystemExplorer from './explorer/FileSystemExplorer';
import FilenLoginModal from './FilenLoginModal';
import FileViewer from './explorer/FileViewer';
import ThemeToggle from './ThemeToggle';
import DevToolsPage from './devTools/DevToolsPage';
import ManageNotebooksPage from './notebook/ManageNotebooksPage';
import NotebookPage from './notebook/NotebookPage';

type Page = 'files' | 'notebooks' | 'devtools' | 'notebook' | 'accounts';

const PAGE_KEY = 'notes-current-page';

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
  const acctSwitcherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listAccounts().then((accs) => {
      setAccounts(accs);
      if (accs.length === 0) {
        setCurrentPage('accounts');
        return;
      }
      const saved = localStorage.getItem('notes-selected-account');
      const id = saved && accs.some((a) => a.id === saved) ? saved : accs[0].id;
      setSelectedId(id);
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

      {viewingFile && (
        <FileViewer
          key={viewingFile.item.itemId}
          account={viewingFile.account}
          item={viewingFile.item}
          displayPath={viewingFile.displayPath}
          siblings={viewingFile.siblings}
          siblingIdx={viewingFile.siblingIdx}
          onClose={() => setViewingFile(null)}
          onOpenNotebook={handleOpenNotebook}
          onNavigate={handleFileNavigate}
        />
      )}

      <div className={isFilesPage ? 'h-screen flex flex-col overflow-hidden' : 'container mx-auto p-6 max-w-7xl'}>
        {/* App header — fades with the explorer toolbar when compact */}
        <div className={isFilesPage ? `shrink-0 overflow-hidden transition-[max-height,opacity] duration-200 ${explorerCompact ? 'max-h-0 opacity-0' : 'max-h-[80px] opacity-100'}` : ''}>
        <header className={`flex items-center gap-2 ${isFilesPage ? 'px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900' : 'mb-6'}`}>
          <h1 className="text-lg font-bold text-gray-900 dark:text-white flex-1 truncate">Ayran Notes</h1>

          {/* Account switcher (files page only) */}
          {isFilesPage && accounts.length > 0 && (
            <div ref={acctSwitcherRef} className="relative">
              <button
                onClick={() => setAcctSwitcherOpen((o) => !o)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors max-w-[200px]"
              >
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

          <ThemeToggle />

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
                  <button onClick={() => navigateTo('devtools')} className={`w-full text-left px-4 py-2 text-sm transition-colors ${currentPage === 'devtools' ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>
                    DevTools
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
            />
          </div>
        )}

        {currentPage === 'notebooks' && (
          <div className="py-6 px-4 overflow-y-auto flex-1">
            <ManageNotebooksPage
              onOpenNotebook={(id) => { setNotebookNavId(id); setCurrentPage('notebook'); }}
            />
          </div>
        )}

        {currentPage === 'notebook' && notebookNavId && (
          <div className="py-6 px-4 overflow-y-auto flex-1">
            <NotebookPage
              notebookId={notebookNavId}
              onBack={() => setCurrentPage('notebooks')}
              onDeleted={() => setCurrentPage('notebooks')}
              onOpenedInNewWindow={() => setCurrentPage('notebooks')}
            />
          </div>
        )}

        {currentPage === 'notebook' && !notebookNavId && (
          <div className="py-6 px-4 overflow-y-auto flex-1">
            <ManageNotebooksPage
              onOpenNotebook={(id) => { setNotebookNavId(id); setCurrentPage('notebook'); }}
            />
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
                onOpenNotebook={handleOpenNotebook} onCompactChange={setExplorerCompact} />
            )}
            {selected?.provider === 'filen' && (
              <FilenExplorer key={selected.id} account={selected} onDisconnect={handleExplorerDisconnect}
                onNeedsRelogin={() => setShowFilenLogin(true)}
                onOpenFile={(item, displayPath, siblings, siblingIdx) => handleOpenFile(selected, item, displayPath, siblings, siblingIdx)}
                onOpenNotebook={handleOpenNotebook} onCompactChange={setExplorerCompact} />
            )}
            {selected?.provider === 'local-fs' && (
              <FileSystemExplorer key={selected.id} account={selected} onDisconnect={handleExplorerDisconnect}
                onOpenFile={(item, displayPath, siblings, siblingIdx) => handleOpenFile(selected, item, displayPath, siblings, siblingIdx)}
                onOpenNotebook={handleOpenNotebook} onCompactChange={setExplorerCompact} />
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
