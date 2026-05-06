import { Suspense } from 'react';
import { listAccounts } from '@/lib/token-store';
import AppShell from '@/components/AppShell';
import ThemeToggle from '@/components/ThemeToggle';

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
  const serverAccounts = accounts.map(({ id, email, displayName, provider }) => ({
    id, email, displayName, provider,
  }));

  return (
    <main className="container mx-auto p-6 max-w-7xl">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Ayran CsDrive WebHost</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">Access and manage your cloud storage</p>
        </div>
        <ThemeToggle />
      </header>

      {connected && (
        <div className="mb-5 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-400 rounded-lg text-sm">
          Account connected successfully.
        </div>
      )}
      {error && (
        <div className="mb-5 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 rounded-lg text-sm">
          {ERROR_MESSAGES[error] ?? `Error: ${error.replace(/_/g, ' ')}`}
        </div>
      )}

      <Suspense>
        <AppShell serverAccounts={serverAccounts} />
      </Suspense>
    </main>
  );
}
