import { listAccounts } from '@/lib/token-store';
import AppShell from '@/components/AppShell';

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

      <AppShell serverAccounts={serverAccounts} />
    </main>
  );
}
