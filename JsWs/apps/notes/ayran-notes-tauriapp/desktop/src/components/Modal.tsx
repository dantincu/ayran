import { useState } from 'react';

interface Props {
  title: string;
  onClose?: () => void;
  children: React.ReactNode;
  /** Tailwind max-width class for the normal (non-maximised) state, e.g. 'max-w-md' */
  maxWidth?: string;
}

function MaximizeIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className="w-3.5 h-3.5">
      <path d="M1 5V1h4M13 9v4H9M9 1h4v4M5 13H1V9"/>
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className="w-3.5 h-3.5">
      <path d="M5 1v4H1M9 13v-4h4M13 5H9V1M1 9h4v4"/>
    </svg>
  );
}

export default function Modal({ title, onClose, children, maxWidth = 'max-w-md' }: Props) {
  const [maximized, setMaximized] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className={`bg-white dark:bg-gray-800 shadow-xl flex flex-col rounded-xl ${
          maximized ? 'fixed' : `w-full ${maxWidth} mx-4 max-h-[90vh]`
        }`}
        style={maximized ? { inset: '10px' } : undefined}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white truncate pr-2">{title}</h2>
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={() => setMaximized((m) => !m)}
              title={maximized ? 'Restore' : 'Maximize'}
              className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              {maximized ? <RestoreIcon /> : <MaximizeIcon />}
            </button>
            {onClose && (
              <button
                onClick={onClose}
                title="Close"
                className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="w-3.5 h-3.5">
                  <path d="M1 1l12 12M13 1L1 13"/>
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Content — fills remaining height; children control their own overflow */}
        <div className="flex-1 min-h-0">
          {children}
        </div>
      </div>
    </div>
  );
}
