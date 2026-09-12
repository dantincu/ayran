import { useEffect, useState } from 'react';
import Header from './components/Header';
import NotesList from './components/NotesList';
import NoteEditor from './components/NoteEditor';
import { createNoteId, deleteNotes, getAllNotes } from './db/notesDb';
import { NEW_NOTE_TEMPLATE } from './utils/newNoteTemplate';
import type { Note } from './types';
import './App.css';

type View = { kind: 'list' } | { kind: 'editor'; noteId: string };

export default function App() {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    void getAllNotes().then(setNotes);
  }, []);

  const handleNewNote = () => {
    const now = Date.now();
    const note: Note = {
      id: createNoteId(),
      title: '',
      content: NEW_NOTE_TEMPLATE,
      createdAt: now,
      updatedAt: now,
    };
    setNotes((prev) => [note, ...(prev ?? [])]);
    setView({ kind: 'editor', noteId: note.id });
  };

  const handleNoteSaved = (updated: Note) => {
    setNotes((prev) => prev?.map((n) => (n.id === updated.id ? updated : n)) ?? prev);
  };

  const handleDiscardEmptyNote = (id: string) => {
    setNotes((prev) => prev?.filter((n) => n.id !== id) ?? prev);
    void deleteNotes([id]);
  };

  const handleSelectAll = () => {
    setSelectionMode(true);
    setSelectedIds(new Set((notes ?? []).map((n) => n.id)));
  };

  const handleCancelSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    const confirmed = window.confirm(
      `Delete ${count} ${count === 1 ? 'note' : 'notes'}? This can't be undone.`,
    );
    if (!confirmed) return;
    const ids = [...selectedIds];
    setNotes((prev) => prev?.filter((n) => !selectedIds.has(n.id)) ?? prev);
    setSelectionMode(false);
    setSelectedIds(new Set());
    void deleteNotes(ids);
  };

  const handleLongPressNote = (id: string) => {
    if (selectionMode) {
      handleToggleSelect(id);
    } else {
      setSelectionMode(true);
      setSelectedIds(new Set([id]));
    }
  };

  const handleDeleteNote = (id: string) => {
    const confirmed = window.confirm("Delete this note? This can't be undone.");
    if (!confirmed) return;
    setNotes((prev) => prev?.filter((n) => n.id !== id) ?? prev);
    void deleteNotes([id]);
    setView({ kind: 'list' });
  };

  if (notes === null) {
    return <div className="app" />;
  }

  if (view.kind === 'editor') {
    const note = notes.find((n) => n.id === view.noteId);
    if (!note) {
      return null;
    }
    return (
      <div className="app">
        <NoteEditor
          key={note.id}
          note={note}
          onSaved={handleNoteSaved}
          onDiscardEmpty={handleDiscardEmptyNote}
          onDelete={handleDeleteNote}
          onBack={() => setView({ kind: 'list' })}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <Header
        mode="list"
        selectionMode={selectionMode}
        selectedCount={selectedIds.size}
        hasNotes={notes.length > 0}
        onNewNote={handleNewNote}
        onSelectAll={handleSelectAll}
        onCancelSelection={handleCancelSelection}
        onDeleteSelected={handleDeleteSelected}
      />
      <main className="app-scroll">
        <NotesList
          notes={notes}
          selectionMode={selectionMode}
          selectedIds={selectedIds}
          onOpenNote={(id) => setView({ kind: 'editor', noteId: id })}
          onToggleSelect={handleToggleSelect}
          onLongPressNote={handleLongPressNote}
          onCreateFirst={handleNewNote}
        />
      </main>
    </div>
  );
}
