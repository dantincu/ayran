import { useState, useEffect } from 'react';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import type { StoredAccount, CachedItem } from '../types';
import { listAccounts, upsertAccount, deleteAccount } from '../lib/account-store';
import { connectGoogleDrive } from '../lib/google-auth';
import AccountManager from './AccountManager';
import GoogleDriveExplorer from './GoogleDriveExplorer';
import FilenExplorer from './FilenExplorer';
import FileSystemExplorer from './FileSystemExplorer';
import FilenLoginModal from './FilenLoginModal';
import FileViewer from './FileViewer';
import ThemeToggle from './ThemeToggle';

export default function AppShell() {
  const [accounts, setAccounts] = useState<StoredAccount[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [showFilenLogin, setShowFilenLogin] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<{ account: StoredAccount; item: CachedItem } | null>(null);

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

  const selected = accounts.find((a) => a.id === selectedId) ?? null;

  const refresh = async () => {
    const accs = await listAccounts();
    setAccounts(accs);
  };

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
    const selected = await dialogOpen({ directory: true, multiple: false });
    if (!selected || typeof selected !== 'string') return;
    const name = selected.split(/[\\/]/).pop() ?? selected;
    const account: StoredAccount = {
      id: `fs-${Date.now()}`, email: name, displayName: name,
      provider: 'local-fs', path: selected,
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

  return (
    <>
      {showFilenLogin && (
        <FilenLoginModal onSuccess={handleFilenSuccess} onClose={() => setShowFilenLogin(false)} />
      )}

      {viewingFile && (
        <FileViewer
          account={viewingFile.account}
          item={viewingFile.item}
          onClose={() => setViewingFile(null)}
        />
      )}

      <div className="container mx-auto p-6 max-w-7xl">
        <header className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Ayran Notes</h1>
            <p className="text-gray-500 dark:text-gray-400 mt-1">Access and manage your cloud storage</p>
          </div>
          <ThemeToggle />
        </header>

        {connectError && (
          <div className="mb-5 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded-lg text-sm">
            Connection error: {connectError}
          </div>
        )}

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
                onOpenFile={(item) => setViewingFile({ account: selected!, item })} />
            )}
            {selected?.provider === 'filen' && (
              <FilenExplorer key={selected.id} account={selected} onDisconnect={handleExplorerDisconnect}
                onNeedsRelogin={() => setShowFilenLogin(true)}
                onOpenFile={(item) => setViewingFile({ account: selected!, item })} />
            )}
            {selected?.provider === 'local-fs' && (
              <FileSystemExplorer key={selected.id} account={selected} onDisconnect={handleExplorerDisconnect}
                onOpenFile={(item) => setViewingFile({ account: selected!, item })} />
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
      </div>
    </>
  );
}