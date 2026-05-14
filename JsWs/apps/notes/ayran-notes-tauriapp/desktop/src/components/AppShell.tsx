import { useState, useEffect } from 'react';
import Popover from './Popover';
import { getCurrentWebviewWindow, getAllWebviewWindows } from '@tauri-apps/api/webviewWindow';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import type { StoredAccount, CachedItem } from '../types';
import { listAccounts, upsertAccount, deleteAccount } from '../lib/account-store';
import { connectGoogleDrive } from '../lib/google-auth';
import { addNotebook } from '../lib/notebooks-db';
import AccountManager from './AccountManager';
import GoogleDriveExplorer from './GoogleDriveExplorer';
import FilenExplorer from './FilenExplorer';
import FileSystemExplorer from './FileSystemExplorer';
import FilenLoginModal from './FilenLoginModal';
import FileViewer from './FileViewer';
import ThemeToggle from './ThemeToggle';
import DevToolsPage from './DevToolsPage';
import ManageNotebooksPage from './notebook/ManageNotebooksPage';
import NotebookPage from './notebook/NotebookPage';

type Page = 'files' | 'notebooks' | 'devtools' | 'notebook';

const PAGE_KEY = 'notes-current-page';

export default function AppShell() {
  const [accounts, setAccounts] = useState<StoredAccount[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [showFilenLogin, setShowFilenLogin] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<{ account: StoredAccount; item: CachedItem; displayPath: string } | null>(null);
  const [currentPage, setCurrentPage] = useState<Page>(() => {
    if (new URLSearchParams(window.location.search).get('notebook')) return 'notebook';
    return (localStorage.getItem(PAGE_KEY) as Page | null) ?? 'files';
  });
  const [notebookNavId, setNotebookNavId] = useState<string | null>(() => {
    const urlParam = new URLSearchParams(window.location.search).get('notebook');
    return urlParam ?? localStorage.getItem('notes-notebook-id');
  });
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    listAccounts().then((accs) => {
      setAccounts(accs);
      if (accs.length === 0) return;
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
    localStorage.setItem(PAGE_KEY, currentPage);
  }, [currentPage]);

  // When main window closes, destroy all secondary notebook windows first.
  // Guard: only register this handler in the actual main window, not in nb-* secondary windows
  // (which also render AppShell and would otherwise close every window when they themselves close).
  useEffect(() => {
    if (getCurrentWebviewWindow().label !== 'main') return;
    let unlisten: (() => void) | undefined;
    getCurrentWebviewWindow().onCloseRequested(async (e) => {
      e.preventDefault();
      try {
        const windows = await getAllWebviewWindows();
        await Promise.all(windows.filter((w) => w.label !== 'main').map((w) => w.destroy().catch(() => {})));
      } catch { /* non-fatal */ }
      try {
        await getCurrentWebviewWindow().destroy();
      } catch { /* non-fatal */ }
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { if (unlisten) unlisten(); };
  }, []);


  const selected = accounts.find((a) => a.id === selectedId) ?? null;

  const refresh = async () => { setAccounts(await listAccounts()); };

  const handleConnectGoogle = async () => {
    setConnecting(true); setConnectError(null);
    await connectGoogleDrive(
      async (account) => {
        setAccounts((p) => [...p.filter((a) => a.id !== account.id), account]);
        setSelectedId(account.id);
        setConnecting(false);
      },
      (msg) => { setConnectError(msg); setConnecting(false); }
    );
  };

  const handleFilenSuccess = (account: StoredAccount) => {
    setShowFilenLogin(false);
    setAccounts((p) => [...p.filter((a) => a.id !== account.id), account]);
    setSelectedId(account.id);
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
  };

  const handleDisconnect = async (id: string) => {
    await deleteAccount(id);
    await refresh();
    if (selectedId === id) setSelectedId(accounts.find((a) => a.id !== id)?.id ?? null);
  };

  const handleExplorerDisconnect = async () => {
    if (!selected) return;
    await deleteAccount(selected.id);
    const remaining = accounts.filter((a) => a.id !== selected.id);
    setAccounts(remaining);
    setSelectedId(remaining[0]?.id ?? null);
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

  return (
    <>
      {showFilenLogin && (
        <FilenLoginModal onSuccess={handleFilenSuccess} onClose={() => setShowFilenLogin(false)} />
      )}

      {viewingFile && (
        <FileViewer
          account={viewingFile.account}
          item={viewingFile.item}
          displayPath={viewingFile.displayPath}
          onClose={() => setViewingFile(null)}
          onOpenNotebook={handleOpenNotebook}
        />
      )}

      <div className="container mx-auto p-6 max-w-7xl">
        <header className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Ayran Notes</h1>
            <p className="text-gray-500 dark:text-gray-400 mt-1">Access and manage your cloud storage</p>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            {/* Three-dots menu */}
            <div className="relative">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                className="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
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
                    <button onClick={() => navigateTo('devtools')} className={`w-full text-left px-4 py-2 text-sm transition-colors ${currentPage === 'devtools' ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'}`}>
                      DevTools
                    </button>
                  </div>
                </Popover>
              )}
            </div>
          </div>
        </header>

        {connectError && (
          <div className="mb-5 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded-lg text-sm">
            Connection error: {connectError}
          </div>
        )}

        {currentPage === 'notebooks' && (
          <ManageNotebooksPage
            onOpenNotebook={(id) => { setNotebookNavId(id); setCurrentPage('notebook'); }}
          />
        )}

        {currentPage === 'notebook' && notebookNavId && (
          <NotebookPage
            notebookId={notebookNavId}
            onBack={() => setCurrentPage('notebooks')}
            onDeleted={() => setCurrentPage('notebooks')}
            onOpenedInNewWindow={() => setCurrentPage('notebooks')}
          />
        )}

        {currentPage === 'notebook' && !notebookNavId && (
          <ManageNotebooksPage
            onOpenNotebook={(id) => { setNotebookNavId(id); setCurrentPage('notebook'); }}
          />
        )}

        {currentPage === 'devtools' && <DevToolsPage />}

        {currentPage === 'files' && (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            <aside className="lg:col-span-1">
              <AccountManager
                accounts={accounts}
                selectedId={selectedId}
                connecting={connecting}
                onSelect={setSelectedId}
                onDisconnect={handleDisconnect}
                onConnectGoogle={handleConnectGoogle}
                onConnectFilen={() => setShowFilenLogin(true)}
                onConnectFs={handleConnectFs}
              />
            </aside>

            <section className="lg:col-span-3">
              {selected?.provider === 'google-drive' && (
                <GoogleDriveExplorer key={selected.id} account={selected} onDisconnect={handleExplorerDisconnect}
                  onOpenFile={(item, displayPath) => setViewingFile({ account: selected!, item, displayPath })}
                  onOpenNotebook={handleOpenNotebook} />
              )}
              {selected?.provider === 'filen' && (
                <FilenExplorer key={selected.id} account={selected} onDisconnect={handleExplorerDisconnect}
                  onNeedsRelogin={() => setShowFilenLogin(true)}
                  onOpenFile={(item, displayPath) => setViewingFile({ account: selected!, item, displayPath })}
                  onOpenNotebook={handleOpenNotebook} />
              )}
              {selected?.provider === 'local-fs' && (
                <FileSystemExplorer key={selected.id} account={selected} onDisconnect={handleExplorerDisconnect}
                  onOpenFile={(item, displayPath) => setViewingFile({ account: selected!, item, displayPath })}
                  onOpenNotebook={handleOpenNotebook} />
              )}
              {!selected && (
                <div className="flex flex-col items-center justify-center h-64 text-center text-gray-400 dark:text-gray-500 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl">
                  <svg className="w-12 h-12 mb-3 text-gray-300 dark:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  <p className="text-lg font-medium">No storage connected</p>
                  <p className="text-sm mt-1">Connect a Google account, sign in to Filen, or open a local folder</p>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </>
  );
}
