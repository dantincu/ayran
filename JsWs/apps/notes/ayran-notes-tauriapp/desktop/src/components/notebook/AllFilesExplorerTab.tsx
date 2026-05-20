import { useState, useEffect } from 'react';
import type { StoredAccount, CachedItem } from '../../types';
import { getAccount } from '../../lib/account-store';
import GoogleDriveExplorer from '../explorer/GoogleDriveExplorer';
import FilenExplorer from '../explorer/FilenExplorer';
import FileSystemExplorer from '../explorer/FileSystemExplorer';
import FileViewer from '../explorer/FileViewer';

interface Props {
  accountId: string;
}

interface ViewingFile {
  item: CachedItem;
  displayPath: string;
  siblings?: CachedItem[];
  siblingIdx?: number;
}

export default function AllFilesExplorerTab({ accountId }: Props) {
  const [account, setAccount] = useState<StoredAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<ViewingFile | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getAccount(accountId)
      .then((acct) => {
        if (!acct) setError('Account not found.');
        else setAccount(acct);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [accountId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center flex-1 text-gray-400 dark:text-gray-500 text-sm">
        Loading…
      </div>
    );
  }

  if (error || !account) {
    return (
      <div className="flex items-center justify-center flex-1 text-red-500 dark:text-red-400 text-sm p-4 text-center">
        {error ?? 'Account not found.'}
      </div>
    );
  }

  const handleOpenFile = (item: CachedItem, displayPath: string, siblings?: CachedItem[], siblingIdx?: number) => {
    setViewingFile({ item, displayPath, siblings, siblingIdx });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">

      {/* ── File viewer overlay ───────────────────────────────────────────────── */}

      {viewingFile && (
        <FileViewer
          account={account}
          item={viewingFile.item}
          displayPath={viewingFile.displayPath}
          siblings={viewingFile.siblings}
          siblingIdx={viewingFile.siblingIdx}
          onClose={() => setViewingFile(null)}
          onNavigate={(item, siblingIdx) =>
            setViewingFile((prev) => prev ? { ...prev, item, siblingIdx } : null)
          }
        />
      )}

      {/* ── Explorer ──────────────────────────────────────────────────────────── */}

      <div className="flex-1 min-h-0 overflow-hidden">
        {account.provider === 'google-drive' && (
          <GoogleDriveExplorer
            key={account.id}
            account={account}
            onDisconnect={() => {}}
            onOpenFile={handleOpenFile}
          />
        )}
        {account.provider === 'filen' && (
          <FilenExplorer
            key={account.id}
            account={account}
            onDisconnect={() => {}}
            onNeedsRelogin={() => {}}
            onOpenFile={handleOpenFile}
          />
        )}
        {account.provider === 'local-fs' && (
          <FileSystemExplorer
            key={account.id}
            account={account}
            onDisconnect={() => {}}
            onOpenFile={handleOpenFile}
          />
        )}
      </div>
    </div>
  );
}
