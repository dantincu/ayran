import { useRef } from 'react';
import type { Note } from '../types';
import './NoteListItem.css';

const LONG_PRESS_MS = 450;

interface NoteListItemProps {
  note: Note;
  selectionMode: boolean;
  selected: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
  onLongPress: () => void;
}

export default function NoteListItem({
  note,
  selectionMode,
  selected,
  onOpen,
  onToggleSelect,
  onLongPress,
}: NoteListItemProps) {
  const snippet = firstContentLine(note.content);
  const pressTimer = useRef<number | null>(null);
  const longPressFired = useRef(false);

  const clearPressTimer = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  const handlePointerDown = () => {
    longPressFired.current = false;
    clearPressTimer();
    pressTimer.current = window.setTimeout(() => {
      longPressFired.current = true;
      onLongPress();
    }, LONG_PRESS_MS);
  };

  const handleClick = () => {
    if (longPressFired.current) {
      longPressFired.current = false;
      return;
    }
    if (selectionMode) onToggleSelect();
    else onOpen();
  };

  return (
    <button
      type="button"
      className={`note-item${selected ? ' note-item-selected' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerUp={clearPressTimer}
      onPointerLeave={clearPressTimer}
      onPointerCancel={clearPressTimer}
      onClick={handleClick}
    >
      {selectionMode && (
        <span className={`note-item-checkbox${selected ? ' checked' : ''}`} aria-hidden="true">
          {selected && <CheckIcon />}
        </span>
      )}
      <span className="note-item-body">
        {note.title ? (
          <span className="note-item-title">{note.title}</span>
        ) : (
          <span className="note-item-title note-item-untitled">untitled note</span>
        )}
        {snippet && <span className="note-item-snippet">{snippet}</span>}
      </span>
    </button>
  );
}

function firstContentLine(content: string): string {
  const withoutHeading = content.replace(/^\s*#[^\n]*\n?/, '');
  const line = withoutHeading.split(/\r\n|\r|\n/).find((l) => l.trim().length > 0);
  return (line ?? '').trim();
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}
