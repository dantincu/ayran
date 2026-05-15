import { useState } from 'react';
import Modal from '../common/Modal';

interface Props {
  /** Names that already exist in the current folder (for collision check). */
  existingNames: string[];
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
}

export default function CreateTextFileModal({ existingNames, onCreate, onClose }: Props) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validate = (n: string): string => {
    const t = n.trim();
    if (!t) return 'File name cannot be empty.';
    if (existingNames.some(e => e === t)) return `"${t}" already exists in this folder.`;
    return '';
  };

  const handleCreate = async () => {
    const err = validate(name);
    if (err) { setError(err); return; }
    setBusy(true);
    setError(null);
    try {
      await onCreate(name.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Create text file" onClose={onClose} maxWidth="max-w-sm">
      <div className="p-4 space-y-3">
        {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}
        <input
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
          placeholder="filename.txt"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-700"
        />
        <p className="text-xs text-gray-400 dark:text-gray-500">
          The file will be created empty and opened for editing.
        </p>
        <div className="flex justify-end gap-2">
          <button onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors">
            Cancel
          </button>
          <button onClick={() => void handleCreate()} disabled={busy || !name.trim()}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
