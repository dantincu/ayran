import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useModalStack } from './ModalStack';
import { useDraggable } from '../hooks/useDraggable';

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
  const [id] = useState(() => crypto.randomUUID());
  const [isRegistered, setIsRegistered] = useState(false);
  const { stack, register, unregister } = useModalStack();
  const panelRef = useRef<HTMLDivElement>(null);
  const { dragPos, setDragPos, onHeaderMouseDown } = useDraggable(panelRef, maximized);

  useLayoutEffect(() => {
    register(id);
    setIsRegistered(true);
    return () => unregister(id);
  }, [id, register, unregister]);

  // Leaving maximized → reset drag so the modal returns to the centered position.
  useEffect(() => { if (!maximized) setDragPos(null); }, [maximized, setDragPos]);

  // Before registration (first render) show unconditionally to avoid a flash.
  // Once registered, only the stack-top modal is shown.
  const isTop = !isRegistered || stack[stack.length - 1] === id;

  // IMPORTANT: we never conditionally remove elements from the tree based on
  // isTop, because changing the DOM structure unmounts children (like
  // PaginationBar) and destroys their state (e.g. pickerOpen = true).
  //
  // Instead we use CSS visibility which:
  //   • hides the whole modal when not on top (visibility: hidden)
  //   • lets a nested Modal that IS on top override with visibility: visible
  //   • keeps children in the React tree at the same position always
  //
  // The backdrop and header use display:none when not on top so they take no
  // space, but the content wrapper always exists so children stay mounted.

  const panelCls = `relative bg-white dark:bg-gray-800 shadow-xl flex flex-col rounded-xl ${
    maximized ? 'fixed' : dragPos ? `${maxWidth} max-h-[90vh]` : `w-full ${maxWidth} mx-4 max-h-[90vh]`
  }`;

  const panelStyle: React.CSSProperties | undefined = maximized
    ? { inset: '10px' }
    : dragPos
    ? { position: 'fixed', left: dragPos.x, top: dragPos.y, width: dragPos.w, margin: 0 }
    : undefined;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        visibility: isTop ? 'visible' : 'hidden',
        pointerEvents: isTop ? 'auto' : 'none',
      }}
    >
      {/* Backdrop — hidden (no space) when not top */}
      <div
        className="absolute inset-0 bg-black/50"
        style={{ display: isTop ? undefined : 'none' }}
      />

      {/* Panel */}
      <div ref={panelRef} className={panelCls} style={panelStyle}>
        {/* Header — doubles as drag handle; hidden (no space) when not top */}
        <div
          className={`flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0 ${!maximized ? 'cursor-grab active:cursor-grabbing' : ''}`}
          onMouseDown={onHeaderMouseDown}
          style={{ display: isTop ? undefined : 'none' }}
        >
          <h2 className="text-base font-semibold text-gray-900 dark:text-white truncate pr-2 select-none">{title}</h2>
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

        {/* Content — ALWAYS rendered at the same index so nested components
            (e.g. PaginationBar) are never unmounted when this modal loses focus */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {children}
        </div>
      </div>
    </div>
  );
}
