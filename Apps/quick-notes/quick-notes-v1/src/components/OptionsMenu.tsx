import { useEffect, useRef, useState } from 'react';
import './OptionsMenu.css';

export type MenuEntry =
  | { type: 'item'; label: string; onSelect: () => void; disabled?: boolean; danger?: boolean }
  | { type: 'submenu'; label: string; items: MenuEntry[] };

interface OptionsMenuProps {
  entries: MenuEntry[];
  /** Called right when the menu button is pressed, before the click/select handler runs. */
  onOpen?: () => void;
}

export default function OptionsMenu({ entries, onOpen }: OptionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setOpenSubmenu(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setOpenSubmenu(null);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const closeAll = () => {
    setOpen(false);
    setOpenSubmenu(null);
  };

  const renderEntries = (list: MenuEntry[]) =>
    list.map((entry) => {
      if (entry.type === 'item') {
        return (
          <button
            key={entry.label}
            type="button"
            className={`options-menu-item${entry.danger ? ' options-menu-item-danger' : ''}`}
            disabled={entry.disabled}
            onClick={() => {
              entry.onSelect();
              closeAll();
            }}
          >
            {entry.label}
          </button>
        );
      }
      const expanded = openSubmenu === entry.label;
      return (
        <div key={entry.label} className="options-menu-submenu">
          <button
            type="button"
            className="options-menu-item options-menu-submenu-trigger"
            onClick={() => setOpenSubmenu(expanded ? null : entry.label)}
            aria-expanded={expanded}
          >
            {entry.label}
            <span className="options-menu-submenu-arrow">{expanded ? '▾' : '▸'}</span>
          </button>
          {expanded && <div className="options-menu-submenu-panel">{renderEntries(entry.items)}</div>}
        </div>
      );
    });

  return (
    <div className="options-menu-root" ref={rootRef}>
      <button
        type="button"
        className="icon-button"
        aria-label="Options"
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerDown={() => onOpen?.()}
        onClick={() => setOpen((v) => !v)}
      >
        <DotsIcon />
      </button>
      {open && (
        <div className="options-menu-panel" role="menu">
          {renderEntries(entries)}
        </div>
      )}
    </div>
  );
}

function DotsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}
