import type { StoredAccount } from '../types';
import config from '../config.json';

const p = config.storageProviders;

interface Props {
  accounts: StoredAccount[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDisconnect: (id: string) => void;
  onConnectGoogle: () => void;
  onConnectFilen: () => void;
  onConnectFs: () => void;
  connectError?: string | null;
  onDeleteCache?: (id: string) => void;
  onDeleteAppData?: (id: string) => void;
}

export default function ManageAccountsPage({
  accounts, selectedId,
  onSelect, onDisconnect,
  onConnectGoogle, onConnectFilen, onConnectFs,
  connectError,
  onDeleteCache, onDeleteAppData,
}: Props) {
  const google = p.GoogleDrive.enabled     ? accounts.filter((a) => a.provider === 'google-drive') : [];
  const filen  = p.Filen.enabled           ? accounts.filter((a) => a.provider === 'filen')        : [];
  const fs     = p.LocalFileSystem.enabled ? accounts.filter((a) => a.provider === 'local-fs')     : [];

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Storage Accounts</h2>

      {connectError && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded-lg text-sm">
          Connection error: {connectError}
        </div>
      )}

      {accounts.length === 0 && (
        <p className="text-sm text-gray-400 dark:text-gray-500">No storage connected. Connect an account below to get started.</p>
      )}

      {google.length > 0 && (
        <Section label="Google Drive">
          {google.map((a) => <AccountRow key={a.id} account={a} selected={selectedId === a.id} onSelect={onSelect} onDisconnect={onDisconnect} onDeleteCache={onDeleteCache} onDeleteAppData={onDeleteAppData} />)}
        </Section>
      )}
      {filen.length > 0 && (
        <Section label="Filen">
          {filen.map((a) => <AccountRow key={a.id} account={a} selected={selectedId === a.id} onSelect={onSelect} onDisconnect={onDisconnect} onDeleteCache={onDeleteCache} onDeleteAppData={onDeleteAppData} />)}
        </Section>
      )}
      {fs.length > 0 && (
        <Section label="Local file system">
          {fs.map((a) => <AccountRow key={a.id} account={a} selected={selectedId === a.id} onSelect={onSelect} onDisconnect={onDisconnect} onDeleteCache={onDeleteCache} onDeleteAppData={onDeleteAppData} />)}
        </Section>
      )}

      <div className="space-y-2 pt-2">
        <p className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">Connect new account</p>

        {p.GoogleDrive.enabled && (
          <button onClick={onConnectGoogle}
            className="w-full flex items-center gap-3 px-4 py-2.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors">
            <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
            </svg>
            Connect Google Account
          </button>
        )}

        {p.Filen.enabled && (
          <button onClick={onConnectFilen}
            className="w-full flex items-center gap-3 px-4 py-2.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 transition-colors">
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
            </svg>
            Connect Filen Account
          </button>
        )}

        {p.LocalFileSystem.enabled && (
          <button onClick={onConnectFs}
            className="w-full flex items-center gap-3 px-4 py-2.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-sm rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            Open Local Folder
          </button>
        )}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide mb-2">{label}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function AccountRow({ account, selected, onSelect, onDisconnect, onDeleteCache, onDeleteAppData }: {
  account: StoredAccount; selected: boolean;
  onSelect: (id: string) => void; onDisconnect: (id: string) => void;
  onDeleteCache?: (id: string) => void; onDeleteAppData?: (id: string) => void;
}) {
  const providerLabel = account.provider === 'google-drive' ? 'Google Drive'
    : account.provider === 'filen' ? 'Filen'
    : 'Local folder';

  return (
    <div className={`rounded-lg border transition-colors ${
      selected
        ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-700 ring-1 ring-blue-300 dark:ring-blue-600'
        : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700'}`}>
      <div onClick={() => onSelect(account.id)}
        className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded-lg transition-colors">
        <div className="min-w-0 flex-1">
          <p className={`text-sm truncate ${selected ? 'font-medium text-blue-700 dark:text-blue-400' : 'text-gray-800 dark:text-gray-200'}`}>
            {account.displayName ?? account.email}
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 truncate">
            {providerLabel}{account.email !== account.displayName ? ` · ${account.email}` : ''}
          </p>
        </div>
        <button onClick={(e) => { e.stopPropagation(); onDisconnect(account.id); }}
          className="ml-3 text-xs text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 shrink-0 transition-colors px-1"
          aria-label="Remove">✕</button>
      </div>
      {(onDeleteCache || onDeleteAppData) && (
        <div className="flex gap-2 px-3 pb-2">
          {onDeleteCache && (
            <button onClick={(e) => { e.stopPropagation(); onDeleteCache(account.id); }}
              className="text-xs text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 transition-colors">
              Delete cache
            </button>
          )}
          {onDeleteAppData && (
            <button onClick={(e) => { e.stopPropagation(); onDeleteAppData(account.id); }}
              className="text-xs text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 transition-colors">
              Delete app data
            </button>
          )}
        </div>
      )}
    </div>
  );
}
