import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useModalStack } from './ModalStack';
import { useKeyboardScopes } from './KeyboardShortcutsContext';
import { useDraggable } from '../../hooks/useDraggable';

interface Props {
  title: string;
  onClose?: () => void;
  /** When provided, a minimize button is shown in the header. */
  onMinimize?: () => void;
  children: React.ReactNode;
  /** Tailwind max-width class for the normal (non-maximised) state, e.g. 'max-w-md' */
  maxWidth?: string;
}

function BackIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
      <path d="M9 1L3 7l6 6"/>
    </svg>
  );
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

function MinimizeIcon() {
  return (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="w-3.5 h-3.5">
      <path d="M2 10h10"/>
    </svg>
  );
}

const GLOBAL_ONLY_SCOPES = ['global'];

export default function Modal({ title, onClose, onMinimize, children, maxWidth = 'max-w-md' }: Props) {
  const [maximized, setMaximized] = useState(false);
  const [id] = useState(() => crypto.randomUUID());
  const [isRegistered, setIsRegistered] = useState(false);
  const { stack, register, unregister, updateHasClose, updateCallbacks, closeAllCounter, triggerCloseAll } = useModalStack();
  const panelRef = useRef<HTMLDivElement>(null);
  const { dragPos, setDragPos, onHeaderMouseDown } = useDraggable(panelRef, maximized);
  const closeAllSeenRef = useRef(closeAllCounter);

  // Isolate: suppress module-level scopes; only global shortcuts remain active.
  useKeyboardScopes(GLOBAL_ONLY_SCOPES, true);

  useLayoutEffect(() => {
    register(id, !!onClose);
    setIsRegistered(true);
    return () => unregister(id);
  }, [id, register, unregister]);

  // Keep the stack entry in sync when onClose availability changes.
  // Depend on the boolean, not the function reference — function refs change on
  // every parent re-render but the boolean value rarely does, preventing a loop.
  const hasClose = !!onClose;
  useEffect(() => {
    if (isRegistered) updateHasClose(id, hasClose);
  }, [id, isRegistered, hasClose, updateHasClose]);

  const toggleMaximize = useCallback(() => setMaximized((m) => !m), []);

  // Register close/maximize/minimize callbacks for keyboard shortcut handlers.
  // updateCallbacks writes to a ref only — no setState, no re-render cascade.
  useEffect(() => {
    if (isRegistered) {
      updateCallbacks(id, { onClose, onToggleMaximize: toggleMaximize, onMinimize });
    }
  }, [id, isRegistered, onClose, toggleMaximize, onMinimize, updateCallbacks]);

  // Close this modal when the close-all trigger fires.
  useEffect(() => {
    if (closeAllCounter > closeAllSeenRef.current && onClose) {
      closeAllSeenRef.current = closeAllCounter;
      onClose();
    }
  }, [closeAllCounter, onClose]);

  // Leaving maximized → reset drag so the modal returns to the centered position.
  useEffect(() => { if (!maximized) setDragPos(null); }, [maximized, setDragPos]);

  const isTop = !isRegistered || stack[stack.length - 1]?.id === id;
  const canCloseAll = stack.every((e) => e.hasClose);
  const showBack = isTop && !!onClose && stack.length > 1;
  const showCloseAll = isTop && !!onClose && canCloseAll;

  // See Modal.tsx in the session notes for the visibility:hidden approach rationale.
  const panelCls = `relative bg-white dark:bg-gray-800 shadow-xl flex flex-col rounded-xl ${
    maximized ? '' : `w-full ${maxWidth} mx-4 max-h-[90vh]`
  }`;

  const panelStyle: React.CSSProperties | undefined = maximized
    ? { position: 'fixed', inset: '10px' }
    : dragPos
    ? { position: 'fixed', left: dragPos.x, top: dragPos.y, width: dragPos.w, margin: 0 }
    : undefined;

  const btnCls = 'w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        visibility: isTop ? 'visible' : 'hidden',
        pointerEvents: isTop ? 'auto' : 'none',
      }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" style={{ display: isTop ? undefined : 'none' }} />

      {/* Panel */}
      <div ref={panelRef} className={panelCls} style={panelStyle}>
        {/* Header — drag handle; hidden when not top */}
        <div
          className={`flex items-center px-3 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0 gap-1 ${!maximized ? 'cursor-grab active:cursor-grabbing' : ''}`}
          onMouseDown={onHeaderMouseDown}
          style={{ display: isTop ? undefined : 'none' }}
        >
          {/* Back button (left) — close current modal only */}
          <div className="shrink-0 w-6">
            {showBack && (
              <button onClick={onClose} title="Back" className={btnCls}>
                <BackIcon />
              </button>
            )}
          </div>

          {/* Title */}
          <h2 className="text-base font-semibold text-gray-900 dark:text-white truncate select-none flex-1 min-w-0 px-1">{title}</h2>

          {/* Right controls */}
          <div className="flex items-center gap-0.5 shrink-0">
            {isTop && onMinimize && (
              <button onClick={onMinimize} title="Minimize" className={btnCls}>
                <MinimizeIcon />
              </button>
            )}
            <button onClick={toggleMaximize} title={maximized ? 'Restore' : 'Maximize'} className={btnCls}>
              {maximized ? <RestoreIcon /> : <MaximizeIcon />}
            </button>
            {showCloseAll && (
              <button onClick={triggerCloseAll} title="Close" className={btnCls}>
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="w-3.5 h-3.5">
                  <path d="M1 1l12 12M13 1L1 13"/>
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Content — always rendered at same index to preserve nested component state */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {children}
        </div>
      </div>
    </div>
  );
}
