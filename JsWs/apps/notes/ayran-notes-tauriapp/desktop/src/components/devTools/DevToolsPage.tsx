import { useState } from 'react';
import LocalStoragePage from './LocalStoragePage';
import IndexedDbPage from './IndexedDbPage';

type DevTab = 'localstorage' | 'indexeddb';

const TABS: { id: DevTab; label: string }[] = [
  { id: 'localstorage', label: 'Explore LocalStorage' },
  { id: 'indexeddb',   label: 'Explore IndexedDB' },
];

export default function DevToolsPage() {
  const [tab, setTab] = useState<DevTab>('localstorage');

  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'localstorage' && <LocalStoragePage />}
      {tab === 'indexeddb'   && <IndexedDbPage />}
    </div>
  );
}
