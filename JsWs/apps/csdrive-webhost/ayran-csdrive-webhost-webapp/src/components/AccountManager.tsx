'use client';

import { useRouter } from 'next/navigation';
import type { AccountInfo } from '@/types';

interface Props {
  accounts: AccountInfo[];
}

export default function AccountManager({ accounts }: Props) {
  const router = useRouter();

  const handleConnect = () => {
    window.location.href = '/api/auth/google';
  };

  const handleDisconnect = async (id: string) => {
    await fetch(`/api/auth/accounts/${id}`, { method: 'DELETE' });
    router.refresh();
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
      <h2 className="font-semibold text-gray-800 mb-3">Connected accounts</h2>

      <div className="space-y-2 mb-4">
        {accounts.length === 0 ? (
          <p className="text-sm text-gray-400">No accounts connected</p>
        ) : (
          accounts.map((account) => (
            <div key={account.id} className="flex items-center justify-between p-2 rounded-lg bg-gray-50">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{account.displayName ?? account.email}</p>
                <p className="text-xs text-gray-400 truncate">{account.email}</p>
                <p className="text-xs text-gray-300 capitalize">{account.provider.replace('-', ' ')}</p>
              </div>
              <button
                onClick={() => handleDisconnect(account.id)}
                className="ml-2 text-xs text-red-500 hover:text-red-700 shrink-0"
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>

      <button
        onClick={handleConnect}
        className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 active:bg-blue-800 transition-colors"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
        </svg>
        Connect Google Account
      </button>
    </div>
  );
}
