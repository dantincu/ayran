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
}

export default function AccountManager({
  accounts, selectedId,
  onSelect, onDisconnect,
  onConnectGoogle, onConnectFilen, onConnectFs,
}: Props) {
  const google = p.GoogleDrive.enabled     ? accounts.filter((a) => a.provider === 'google-drive') : [];
  const filen  = p.Filen.enabled           ? accounts.filter((a) => a.provider === 'filen')        : [];
  const fs     = p.LocalFileSystem.enabled ? accounts.filter((a) => a.provider === 'local-fs')     : [];
  const hasAny = google.length > 0 || filen.length > 0 || fs.length > 0;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4 space-y-4">
      <h2 className="font-semibold text-gray-800 dark:text-gray-200">Storage</h2>

      {!hasAny && <p className="text-sm text-gray-400 dark:text-gray-500">No storage connected</p>}

      {google.length > 0 && (
        <Section label="Google Drive">
          {google.map((a) => <AccountRow key={a.id} account={a} selected={selectedId === a.id} onSelect={onSelect} onDisconnect={onDisconnect} />)}
        </Section>
      )}
      {filen.length > 0 && (
        <Section label="Filen">
          {filen.map((a) => <AccountRow key={a.id} account={a} selected={selectedId === a.id} onSelect={onSelect} onDisconnect={onDisconnect} />)}
        </Section>
      )}
      {fs.length > 0 && (
        <Section label="Local file system">
          {fs.map((a) => <AccountRow key={a.id} account={a} selected={selectedId === a.id} onSelect={onSelect} onDisconnect={onDisconnect} />)}
        </Section>
      )}

      <div className="space-y-2 pt-1">
        {p.GoogleDrive.enabled && (
          <button onClick={onConnectGoogle}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors">
            <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
            </svg>
            Connect Google Account
          </button>
        )}

        {p.Filen.enabled && (
          <button onClick={onConnectFilen}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 transition-colors">
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
            </svg>
            Connect Filen Account
          </button>
        )}

        {p.LocalFileSystem.enabled && (
          <button onClick={onConnectFs}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-sm rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
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

function AccountRow({ account, selected, onSelect, onDisconnect }: {
  account: StoredAccount; selected: boolean;
  onSelect: (id: string) => void; onDisconnect: (id: string) => void;
}) {
  return (
    <div onClick={() => onSelect(account.id)}
      className={`flex items-center justify-between px-2 py-1.5 rounded-lg cursor-pointer ${
        selected ? 'bg-blue-50 dark:bg-blue-900/30 ring-1 ring-blue-200 dark:ring-blue-700'
          : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'}`}>
      <div className="min-w-0 flex-1">
        <p className={`text-sm truncate ${selected ? 'font-medium text-blue-700 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300'}`}>
          {account.displayName ?? account.email}
        </p>
        {account.email !== account.displayName && (
          <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{account.email}</p>
        )}
      </div>
      <button onClick={(e) => { e.stopPropagation(); onDisconnect(account.id); }}
        className="ml-2 text-xs text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 shrink-0 transition-colors"
        aria-label="Remove">✕</button>
    </div>
  );
}
