import { useRef, useState } from 'react';
import type { Note } from '../types';
import NoteListItem from './NoteListItem';
import { moveGroup } from '../utils/noteOrder';
import './NotesList.css';

interface NotesListProps {
  /** Already sorted for the current display order (default or custom). */
  notes: Note[];
  orderMode: 'default' | 'custom';
  selectionMode: boolean;
  selectedIds: Set<string>;
  onOpenNote: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onLongPressNote: (id: string) => void;
  onCreateFirst: () => void;
  onReorder: (newOrderedIds: string[]) => void;
}

interface Rect {
  top: number;
  bottom: number;
}

interface DragState {
  pointerId: number;
  draggingIds: string[];
  startY: number;
  currentY: number;
  rects: Rect[];
  overIndex: number;
}

function computeOverIndex(clientY: number, notes: Note[], rects: Rect[], draggingSet: Set<string>): number {
  for (let i = 0; i < notes.length; i++) {
    if (draggingSet.has(notes[i].id)) continue;
    const mid = (rects[i].top + rects[i].bottom) / 2;
    if (clientY < mid) return i;
  }
  return notes.length;
}

export default function NotesList({
  notes,
  orderMode,
  selectionMode,
  selectedIds,
  onOpenNote,
  onToggleSelect,
  onLongPressNote,
  onCreateFirst,
  onReorder,
}: NotesListProps) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const handleDragHandleDown = (note: Note, e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const draggingIds =
      selectionMode && selectedIds.has(note.id)
        ? notes.filter((n) => selectedIds.has(n.id)).map((n) => n.id)
        : [note.id];
    const rects: Rect[] = notes.map((n) => {
      const r = rowRefs.current.get(n.id)?.getBoundingClientRect();
      return { top: r?.top ?? 0, bottom: r?.bottom ?? 0 };
    });
    const draggingSet = new Set(draggingIds);
    setDrag({
      pointerId: e.pointerId,
      draggingIds,
      startY: e.clientY,
      currentY: e.clientY,
      rects,
      overIndex: computeOverIndex(e.clientY, notes, rects, draggingSet),
    });
  };

  const handleDragHandleMove = (e: React.PointerEvent<HTMLSpanElement>) => {
    setDrag((prev) => {
      if (!prev || e.pointerId !== prev.pointerId) return prev;
      const draggingSet = new Set(prev.draggingIds);
      return {
        ...prev,
        currentY: e.clientY,
        overIndex: computeOverIndex(e.clientY, notes, prev.rects, draggingSet),
      };
    });
  };

  const handleDragHandleUp = (e: React.PointerEvent<HTMLSpanElement>) => {
    // Read `drag` directly (not via a setState updater) since calling onReorder -
    // which updates App's state - from inside a setDrag updater function counts as
    // a side effect during render from React's perspective and gets flagged.
    if (!drag || e.pointerId !== drag.pointerId) return;
    const newOrder = moveGroup(notes.map((n) => n.id), drag.draggingIds, drag.overIndex);
    setDrag(null);
    onReorder(newOrder);
  };

  if (notes.length === 0) {
    return (
      <div className="notes-empty-state">
        <button type="button" className="primary-button" onClick={onCreateFirst}>
          Create your first note
        </button>
      </div>
    );
  }

  const showDragHandles = orderMode === 'custom';
  const draggingSet = drag ? new Set(drag.draggingIds) : null;
  const indicatorTop = drag
    ? drag.overIndex < drag.rects.length
      ? drag.rects[drag.overIndex].top
      : (drag.rects[drag.rects.length - 1]?.bottom ?? 0)
    : null;

  return (
    <div className="notes-list">
      {notes.map((note) => (
        <NoteListItem
          key={note.id}
          note={note}
          selectionMode={selectionMode}
          selected={selectedIds.has(note.id)}
          onOpen={() => onOpenNote(note.id)}
          onToggleSelect={() => onToggleSelect(note.id)}
          onLongPress={() => onLongPressNote(note.id)}
          showDragHandle={showDragHandles}
          isDragging={draggingSet?.has(note.id) ?? false}
          dragTranslateY={drag ? drag.currentY - drag.startY : 0}
          onDragHandleDown={(e) => handleDragHandleDown(note, e)}
          onDragHandleMove={handleDragHandleMove}
          onDragHandleUp={handleDragHandleUp}
          itemRef={(el) => {
            if (el) rowRefs.current.set(note.id, el);
            else rowRefs.current.delete(note.id);
          }}
        />
      ))}
      {drag && indicatorTop !== null && (
        <div className="notes-list-drop-indicator" style={{ top: indicatorTop }} />
      )}
    </div>
  );
}
