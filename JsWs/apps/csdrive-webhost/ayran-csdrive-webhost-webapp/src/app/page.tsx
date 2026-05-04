import { listAccounts } from '@/lib/token-store';
import AccountManager from '@/components/AccountManager';
import DriveExplorer from '@/components/DriveExplorer';

const ERROR_MESSAGES: Record<string, string> = {
  missing_code: 'Authentication failed: no authorization code received',
  auth_failed: 'Authentication failed. Please try again.',
  missing_env: 'Server is missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — check your .env.local file.',
  access_denied: 'Access was denied by the user.',
};

interface PageProps {
  searchParams: Promise<{ connected?: string; error?: string }>;
}

export default async function Home({ searchParams }: PageProps) {
  const { connected, error } = await searchParams;
  const accounts = await listAccounts();
  const accountInfos = accounts.map(({ id, email, displayName, provider }) => ({
    id,
    email,
    displayName,
    provider,
  }));

  return (
    <main className="container mx-auto p-6 max-w-7xl">
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">CsDrive WebHost</h1>
        <p className="text-gray-500 mt-1">Access and manage your cloud storage</p>
      </header>

      {connected && (
        <div className="mb-5 p-3 bg-green-50 border border-green-200 text-green-700 rounded-lg text-sm">
          Account connected successfully.
        </div>
      )}
      {error && (
        <div className="mb-5 p-3 bg-red-50 border border-red-200 text-red-600 rounded-lg text-sm">
          {ERROR_MESSAGES[error] ?? `Error: ${error.replace(/_/g, ' ')}`}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <aside className="lg:col-span-1">
          <AccountManager accounts={accountInfos} />
        </aside>

        <section className="lg:col-span-3">
          {accountInfos.length > 0 ? (
            <DriveExplorer accounts={accountInfos} />
          ) : (
            <div className="flex flex-col items-center justify-center h-64 text-center text-gray-400 border-2 border-dashed border-gray-200 rounded-xl">
              <svg className="w-12 h-12 mb-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              <p className="text-lg font-medium">No accounts connected</p>
              <p className="text-sm mt-1">Connect a Google account to get started</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
