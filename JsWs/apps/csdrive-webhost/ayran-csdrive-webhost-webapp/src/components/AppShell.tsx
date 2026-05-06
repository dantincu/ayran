'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { AccountInfo, FsAccountInfo } from '@/types';
import { listFsEntries, saveFsEntry, deleteFsEntry, type FsEntry } from '@/lib/fs-store';
import AccountManager from './AccountManager';
import DriveExplorer from './DriveExplorer';
import FilenExplorer from './FilenExplorer';
import FileSystemExplorer from './FileSystemExplorer';
import FilenLoginModal from './FilenLoginModal';

interface Props {
  serverAccounts: AccountInfo[];
}

export default function AppShell({ serverAccounts }: Props) {
  const router = useRouter();
  const [fsEntries, setFsEntries] = useState<FsEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(serverAccounts[0]?.id ?? null);
  const [showFilenLogin, setShowFilenLogin] = useState(false);

  useEffect(() => {
    listFsEntries().then((entries) => {
      setFsEntries(entries);
      if (serverAccounts.length === 0 && entries.length > 0 && !selectedId) {
        setSelectedId(entries[0].id);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const googleAccounts = serverAccounts.filter((a) => a.provider === 'google-drive');
  const filenAccounts = serverAccounts.filter((a) => a.provider === 'filen');
  const fsAccountInfos: FsAccountInfo[] = fsEntries.map((e) => ({
    id: e.id,
    name: e.name,
    provider: 'file-system',
  }));

  const allIds = new Set([...serverAccounts.map((a) => a.id), ...fsEntries.map((e) => e.id)]);
  const effectiveId =
    selectedId && allIds.has(selectedId)
      ? selectedId
      : serverAccounts[0]?.id ?? fsEntries[0]?.id ?? null;

  const selectedGoogle = googleAccounts.find((a) => a.id === effectiveId) ?? null;
  const selectedFilen = filenAccounts.find((a) => a.id === effectiveId) ?? null;
  const selectedFsEntry = fsEntries.find((e) => e.id === effectiveId) ?? null;

  const handleConnectFs = async () => {
    if (!('showDirectoryPicker' in window)) {
      alert('Your browser does not support the File System Access API.\nPlease use Chrome or Edge.');
      return;
    }
    try {
      const handle = await showDirectoryPicker({ mode: 'readwrite' });
      const entry: FsEntry = { id: `fs-${Date.now()}`, name: handle.name, handle };
      await saveFsEntry(entry);
      setFsEntries((prev) => [...prev, entry]);
      setSelectedId(entry.id);
    } catch {
      // User cancelled
    }
  };

  const handleFilenLoginSuccess = (id: string) => {
    setShowFilenLogin(false);
    router.refresh();
    setSelectedId(id);
  };

  const handleDisconnectServer = async (id: string) => {
    await fetch(`/api/auth/accounts/${id}`, { method: 'DELETE' });
    if (effectiveId === id) setSelectedId(null);
    router.refresh();
  };

  const handleDisconnectFs = async (id: string) => {
    await deleteFsEntry(id);
    setFsEntries((prev) => prev.filter((e) => e.id !== id));
    if (effectiveId === id) setSelectedId(null);
  };

  const hasAny = serverAccounts.length > 0 || fsEntries.length > 0;

  return (
    <>
      {showFilenLogin && (
        <FilenLoginModal
          onSuccess={handleFilenLoginSuccess}
          onClose={() => setShowFilenLogin(false)}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <aside className="lg:col-span-1">
          <AccountManager
            googleAccounts={googleAccounts}
            filenAccounts={filenAccounts}
            fsAccounts={fsAccountInfos}
            selectedId={effectiveId}
            onSelect={setSelectedId}
            onDisconnectServer={handleDisconnectServer}
            onDisconnectFs={handleDisconnectFs}
            onConnectFs={handleConnectFs}
            onConnectFilen={() => setShowFilenLogin(true)}
          />
        </aside>

        <section className="lg:col-span-3">
          {selectedGoogle && <DriveExplorer key={selectedGoogle.id} account={selectedGoogle} />}
          {selectedFilen && <FilenExplorer key={selectedFilen.id} account={selectedFilen} />}
          {selectedFsEntry && <FileSystemExplorer key={selectedFsEntry.id} entry={selectedFsEntry} />}
          {!hasAny && <EmptyState />}
        </section>
      </div>
    </>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-64 text-center text-gray-400 border-2 border-dashed border-gray-200 rounded-xl">
      <svg className="w-12 h-12 mb-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
      </svg>
      <p className="text-lg font-medium">No storage connected</p>
      <p className="text-sm mt-1">Connect a Google account, sign in to Filen, or open a local folder</p>
    </div>
  );
}
