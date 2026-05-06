'use client';

import type { AccountInfo, FsAccountInfo } from '@/types';

interface Props {
  googleAccounts: AccountInfo[];
  filenAccounts: AccountInfo[];
  fsAccounts: FsAccountInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDisconnectServer: (id: string) => void;
  onDisconnectFs: (id: string) => void;
  onConnectFs: () => void;
  onConnectFilen: () => void;
}

export default function AccountManager({
  googleAccounts,
  filenAccounts,
  fsAccounts,
  selectedId,
  onSelect,
  onDisconnectServer,
  onDisconnectFs,
  onConnectFs,
  onConnectFilen,
}: Props) {
  const hasAny = googleAccounts.length > 0 || filenAccounts.length > 0 || fsAccounts.length > 0;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 space-y-4">
      <h2 className="font-semibold text-gray-800">Storage</h2>

      {!hasAny && <p className="text-sm text-gray-400">No storage connected</p>}

      {googleAccounts.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">Google Drive</p>
          <div className="space-y-1">
            {googleAccounts.map((a) => (
              <AccountRow
                key={a.id}
                label={a.displayName ?? a.email}
                sublabel={a.email}
                selected={selectedId === a.id}
                onSelect={() => onSelect(a.id)}
                onRemove={() => onDisconnectServer(a.id)}
              />
            ))}
          </div>
        </div>
      )}

      {filenAccounts.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">Filen</p>
          <div className="space-y-1">
            {filenAccounts.map((a) => (
              <AccountRow
                key={a.id}
                label={a.displayName ?? a.email}
                sublabel={a.email}
                selected={selectedId === a.id}
                onSelect={() => onSelect(a.id)}
                onRemove={() => onDisconnectServer(a.id)}
              />
            ))}
          </div>
        </div>
      )}

      {fsAccounts.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">Local file system</p>
          <div className="space-y-1">
            {fsAccounts.map((a) => (
              <AccountRow
                key={a.id}
                label={a.name}
                selected={selectedId === a.id}
                onSelect={() => onSelect(a.id)}
                onRemove={() => onDisconnectFs(a.id)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2 pt-1">
        <button
          onClick={() => (window.location.href = '/api/auth/google')}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 active:bg-blue-800 transition-colors"
        >
          <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
          </svg>
          Connect Google Account
        </button>

        <button
          onClick={onConnectFilen}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 active:bg-indigo-800 transition-colors"
        >
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
          </svg>
          Connect Filen Account
        </button>

        <button
          onClick={onConnectFs}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200 active:bg-gray-300 transition-colors"
        >
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          Open Local Folder
        </button>
      </div>
    </div>
  );
}

function AccountRow({
  label,
  sublabel,
  selected,
  onSelect,
  onRemove,
}: {
  label: string;
  sublabel?: string;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={`flex items-center justify-between px-2 py-1.5 rounded-lg cursor-pointer ${
        selected ? 'bg-blue-50 ring-1 ring-blue-200' : 'hover:bg-gray-50'
      }`}
      onClick={onSelect}
    >
      <div className="min-w-0 flex-1">
        <p className={`text-sm truncate ${selected ? 'font-medium text-blue-700' : 'text-gray-700'}`}>{label}</p>
        {sublabel && <p className="text-xs text-gray-400 truncate">{sublabel}</p>}
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="ml-2 text-xs text-gray-300 hover:text-red-500 shrink-0 transition-colors"
        aria-label="Remove"
      >
        ✕
      </button>
    </div>
  );
}
