import { useRef } from 'react';
import LabelChip from './LabelChip';
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
  showDragHandle: boolean;
  isDragging: boolean;
  dragTranslateY: number;
  onDragHandleDown: (e: React.PointerEvent<HTMLSpanElement>) => void;
  onDragHandleMove: (e: React.PointerEvent<HTMLSpanElement>) => void;
  onDragHandleUp: (e: React.PointerEvent<HTMLSpanElement>) => void;
  itemRef: (el: HTMLButtonElement | null) => void;
}

export default function NoteListItem({
  note,
  selectionMode,
  selected,
  onOpen,
  onToggleSelect,
  onLongPress,
  showDragHandle,
  isDragging,
  dragTranslateY,
  onDragHandleDown,
  onDragHandleMove,
  onDragHandleUp,
  itemRef,
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
      ref={itemRef}
      className={`note-item${selected ? ' note-item-selected' : ''}${isDragging ? ' note-item-dragging' : ''}`}
      style={isDragging ? { transform: `translateY(${dragTranslateY}px)` } : undefined}
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
        {note.labels.length > 0 && (
          <span className="note-item-labels">
            {note.labels.map((label) => (
              <LabelChip key={label.id} label={label} />
            ))}
          </span>
        )}
        {snippet && <span className="note-item-snippet">{snippet}</span>}
      </span>
      {showDragHandle && (
        <span
          className="note-item-drag-handle"
          aria-label={`Reorder ${note.title || 'untitled note'}`}
          onPointerDown={(e) => {
            // Otherwise this bubbles to the row's own onPointerDown and starts
            // its long-press-to-select timer at the same time as the drag.
            e.stopPropagation();
            clearPressTimer();
            onDragHandleDown(e);
          }}
          onPointerMove={(e) => {
            e.stopPropagation();
            onDragHandleMove(e);
          }}
          onPointerUp={(e) => {
            e.stopPropagation();
            onDragHandleUp(e);
          }}
          onPointerCancel={(e) => {
            e.stopPropagation();
            onDragHandleUp(e);
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <DragHandleIcon />
        </span>
      )}
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

function DragHandleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="6" r="1.5" />
      <circle cx="15" cy="6" r="1.5" />
      <circle cx="9" cy="12" r="1.5" />
      <circle cx="15" cy="12" r="1.5" />
      <circle cx="9" cy="18" r="1.5" />
      <circle cx="15" cy="18" r="1.5" />
    </svg>
  );
}
