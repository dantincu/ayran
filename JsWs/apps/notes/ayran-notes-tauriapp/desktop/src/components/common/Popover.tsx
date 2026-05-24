import { useState, useEffect, useLayoutEffect, useRef, useId } from 'react';
import { useDraggable } from '../../hooks/useDraggable';
import { usePopoverStack } from './PopoverStack';

interface Props {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /**
   * Tailwind classes for the panel when not maximised and not dragged.
   * Examples:
   *   anchor-attached : 'absolute right-0 top-full mt-1 min-w-[160px]'
   *   cursor-positioned: use panelStyle instead (leave this at default 'fixed')
   */
  panelClassName?: string;
  /** Inline style for cursor-positioned panels (context menus). Ignored when maximised or dragged. */
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
  const id = useId();
  const { register, unregister } = usePopoverStack();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    register(id, () => onCloseRef.current());
    return () => unregister(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const [maximized, setMaximized] = useState(false);
  const [adjustedStyle, setAdjustedStyle] = useState<React.CSSProperties | undefined>(panelStyle);
  const panelRef = useRef<HTMLDivElement>(null);
  const { dragPos, setDragPos, onHeaderMouseDown } = useDraggable(panelRef, maximized);

  // Clamp cursor-positioned panels within the viewport after first render.
  useLayoutEffect(() => {
    if (!panelStyle || maximized || dragPos) return;
    const el = panelRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const dl = (panelStyle.left as number | undefined) ?? 0;
    const dt = (panelStyle.top as number | undefined) ?? 0;
    setAdjustedStyle({
      ...panelStyle,
      left: Math.max(4, Math.min(dl, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(dt, window.innerHeight - height - 4)),
    });
  }, [panelStyle, maximized, dragPos]);

  // Re-clamp on window resize.
  useEffect(() => {
    const handler = () => {
      const el = panelRef.current;
      if (!el) return;
      const { width, height } = el.getBoundingClientRect();
      setDragPos(prev =>
        prev
          ? { x: Math.max(0, Math.min(prev.x, window.innerWidth - width)), y: Math.max(0, Math.min(prev.y, window.innerHeight - height)), w: prev.w }
          : prev,
      );
      if (panelStyle && !maximized) {
        const dl = (panelStyle.left as number | undefined) ?? 0;
        const dt = (panelStyle.top as number | undefined) ?? 0;
        setAdjustedStyle({
          ...panelStyle,
          left: Math.max(4, Math.min(dl, window.innerWidth - width - 4)),
          top: Math.max(4, Math.min(dt, window.innerHeight - height - 4)),
        });
      }
    };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [panelStyle, maximized, setDragPos]);

  // Leaving maximized → reset drag so panel returns to its original position.
  useEffect(() => { if (!maximized) setDragPos(null); }, [maximized, setDragPos]);

  const resolvedStyle: React.CSSProperties | undefined = maximized
    ? { inset: '10px' }
    : dragPos
    ? { position: 'fixed', left: dragPos.x, top: dragPos.y, width: dragPos.w, margin: 0 }
    : adjustedStyle ?? panelStyle;

  const panelCls = `z-[60] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg flex flex-col ${
    maximized ? 'fixed rounded-xl' : dragPos ? '' : panelClassName
  }`;

  const btnCls =
    'w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors';

  return (
    <>
      {/* Transparent backdrop — blocks click-through to background controls */}
      <div
        className={`fixed inset-0 z-[55] ${maximized ? 'bg-black/50' : ''}`}
        onClick={onClose}
      />

      {/* Panel */}
      <div ref={panelRef} className={panelCls} style={resolvedStyle}>
        {/* Controls bar — doubles as drag handle */}
        <div
          className={`flex items-center justify-between pl-3 pr-1 py-1 border-b border-gray-100 dark:border-gray-700 shrink-0 ${!maximized ? 'cursor-grab active:cursor-grabbing' : ''}`}
          onMouseDown={onHeaderMouseDown}
        >
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400 truncate pr-1 select-none">{title}</span>
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
