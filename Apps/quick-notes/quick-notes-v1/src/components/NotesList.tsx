import type { Note } from '../types';
import NoteListItem from './NoteListItem';
import './NotesList.css';

interface NotesListProps {
  notes: Note[];
  selectionMode: boolean;
  selectedIds: Set<string>;
  onOpenNote: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onLongPressNote: (id: string) => void;
  onCreateFirst: () => void;
}

export default function NotesList({
  notes,
  selectionMode,
  selectedIds,
  onOpenNote,
  onToggleSelect,
  onLongPressNote,
  onCreateFirst,
}: NotesListProps) {
  if (notes.length === 0) {
    return (
      <div className="notes-empty-state">
        <button type="button" className="primary-button" onClick={onCreateFirst}>
          Create your first note
        </button>
      </div>
    );
  }

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
        />
      ))}
    </div>
  );
}
