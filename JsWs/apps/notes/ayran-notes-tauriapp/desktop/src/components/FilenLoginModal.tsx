import { useState } from 'react';
import { loginFilen } from '../lib/filen-client';
import type { StoredAccount } from '../types';
import Modal from './common/Modal';

interface Props {
  onSuccess: (account: StoredAccount) => void;
  onClose: () => void;
}

export default function FilenLoginModal({ onSuccess, onClose }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [twoFactor, setTwoFactor] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const account = await loginFilen(email, password, twoFactor || undefined);
      onSuccess(account);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Connect Filen account" onClose={onClose} maxWidth="max-w-sm">
      <div className="p-6 space-y-4">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus
              className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-700" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
              className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-700" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Two-factor code <span className="text-gray-400 dark:text-gray-500 font-normal">(if enabled)</span>
            </label>
            <input type="text" value={twoFactor} onChange={(e) => setTwoFactor(e.target.value)} placeholder="6-digit code"
              className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-700" />
          </div>
          {error && <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 text-red-600 dark:text-red-400 rounded-lg text-sm">{error}</div>}
          <button type="submit" disabled={loading}
            className="w-full py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="text-xs text-center text-gray-400 dark:text-gray-500">
          Your credentials are used only on this device.
        </p>
      </div>
    </Modal>
  );
}
