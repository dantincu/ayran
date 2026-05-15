import { useState } from 'react';
import Modal from '../common/Modal';

interface Props {
  onConfirm: (title: string, description?: string) => Promise<void>;
  onClose: () => void;
}

export default function NewNotebookModal({ onConfirm, onClose }: Props) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onConfirm(title.trim(), description.trim() || undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  const inputCls =
    'w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500';

  return (
    <Modal title="New Notebook" onClose={onClose} maxWidth="max-w-sm">
      <div className="p-6 space-y-4">
        {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Title <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleSave(); }}
            autoFocus
            className={inputCls}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Description <span className="text-xs text-gray-400 font-normal">(optional — stored locally)</span>
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleSave(); }}
            className={inputCls}
          />
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!title.trim() || saving}
            className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-40"
          >
            {saving ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
