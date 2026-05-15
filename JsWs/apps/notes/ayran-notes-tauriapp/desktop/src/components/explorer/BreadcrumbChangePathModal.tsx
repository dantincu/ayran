import { useState } from 'react';
import Modal from '../common/Modal';

interface Props {
  defaultValue: string;
  placeholder?: string;
  onNavigate: (path: string) => Promise<void>;
  onClose: () => void;
}

export default function BreadcrumbChangePathModal({ defaultValue, placeholder, onNavigate, onClose }: Props) {
  const [value, setValue] = useState(defaultValue);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      await onNavigate(trimmed);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Navigate to Folder" onClose={onClose} maxWidth="max-w-sm">
      <div className="p-4 space-y-3">
        {error && (
          <p className="text-sm text-red-500 dark:text-red-400">{error}</p>
        )}
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); }}
          placeholder={placeholder}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-700"
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={loading || !value.trim()}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Navigating…' : 'Go'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
