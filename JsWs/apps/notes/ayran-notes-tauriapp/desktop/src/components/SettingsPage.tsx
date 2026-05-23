import { useState } from 'react';
import AppDataFolderModal from './AppDataFolderModal';
import KeyboardShortcutsPage from './KeyboardShortcutsPage';

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round"
      className={`w-4 h-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>
      <path d="M2 5l5 5 5-5"/>
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round"
      className="w-4 h-4 shrink-0 text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-200 transition-colors">
      <path d="M5 2l5 5-5 5"/>
    </svg>
  );
}

export default function SettingsPage() {
  const [subPage, setSubPage] = useState<'main' | 'keyboard-shortcuts'>('main');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [showDataFolderModal, setShowDataFolderModal] = useState(false);

  if (subPage === 'keyboard-shortcuts') {
    return <KeyboardShortcutsPage onBack={() => setSubPage('main')} />;
  }

  return (
    <>
      {showDataFolderModal && (
        <AppDataFolderModal onClose={() => setShowDataFolderModal(false)} />
      )}

      <div className="space-y-4 max-w-xl">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">Settings</h2>

        {/* Keyboard shortcuts row */}
        <button
          onClick={() => setSubPage('keyboard-shortcuts')}
          className="w-full flex items-center justify-between px-4 py-3 text-left border border-gray-200 dark:border-gray-700 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors group"
        >
          <div>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100">Keyboard Shortcuts</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">View and customize keyboard shortcuts</p>
          </div>
          <ChevronRight />
        </button>

        {/* Advanced section */}
        <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
          <button
            onClick={() => setAdvancedOpen((o) => !o)}
            className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-sm font-medium text-gray-700 dark:text-gray-200"
          >
            <span>Advanced</span>
            <ChevronIcon open={advancedOpen} />
          </button>

          {advancedOpen && (
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {/* App Data Folder row */}
              <button
                onClick={() => setShowDataFolderModal(true)}
                className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors group"
              >
                <div>
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-100">App Data Folder</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">View or change where this app keeps its data and cache</p>
                </div>
                <ChevronRight />
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
