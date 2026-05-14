import { useState } from 'react';

interface Props {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /**
   * Tailwind classes for the panel when not maximised — include position, sizing, etc.
   * Examples:
   *   anchor-attached : 'absolute right-0 top-full mt-1 min-w-[160px]'
   *   cursor-positioned: use panelStyle instead (leave this at default 'fixed')
   */
  panelClassName?: string;
  /** Inline style for cursor-positioned panels (context menus). Ignored when maximised. */
  panelStyle?: React.CSSProperties;
}

function MaximizeIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className="w-3 h-3">
      <path d="M1 5V1h4M13 9v4H9M9 1h4v4M5 13H1V9"/>
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className="w-3 h-3">
      <path d="M5 1v4H1M9 13v-4h4M13 5H9V1M1 9h4v4"/>
    </svg>
  );
}

export default function Popover({
  title,
  onClose,
  children,
  panelClassName = 'absolute right-0 top-full mt-1 min-w-[160px]',
  panelStyle,
}: Props) {
  const [maximized, setMaximized] = useState(false);

  const btnCls =
    'w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors';

  return (
    <>
      {/* Transparent backdrop — blocks click-through to background controls */}
      <div
        className={`fixed inset-0 z-40 ${maximized ? 'bg-black/50' : ''}`}
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className={`z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg flex flex-col ${
          maximized ? 'fixed rounded-xl' : panelClassName
        }`}
        style={maximized ? { inset: '10px' } : panelStyle}
      >
        {/* Controls bar */}
        <div className="flex items-center justify-between pl-3 pr-1 py-1 border-b border-gray-100 dark:border-gray-700 shrink-0">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400 truncate pr-1">{title}</span>
          <div className="flex items-center gap-0.5 shrink-0">
            <button onClick={(e) => { e.stopPropagation(); setMaximized((m) => !m); }} title={maximized ? 'Restore' : 'Maximize'} className={btnCls}>
              {maximized ? <RestoreIcon /> : <MaximizeIcon />}
            </button>
            <button onClick={(e) => { e.stopPropagation(); onClose(); }} title="Close" className={btnCls}>
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="w-3 h-3">
                <path d="M1 1l12 12M13 1L1 13"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className={maximized ? 'flex-1 overflow-auto' : ''}>
          {children}
        </div>
      </div>
    </>
  );
}
