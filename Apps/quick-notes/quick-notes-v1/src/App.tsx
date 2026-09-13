import { useEffect, useState } from 'react';
import Header from './components/Header';
import NotesList from './components/NotesList';
import NoteEditor from './components/NoteEditor';
import StylesheetsListPage from './components/StylesheetsListPage';
import StylesheetEditor from './components/StylesheetEditor';
import TemplatePickerDialog from './components/TemplatePickerDialog';
import {
  createId,
  createNoteId,
  deleteNotes,
  deleteStylesheet,
  deleteTemplate,
  getAllNotes,
  getAllStylesheets,
  getAllTemplates,
  putStylesheet,
} from './db/notesDb';
import { DEFAULT_EDITOR_STYLESHEET_IDS, DEFAULT_PREVIEW_STYLESHEET_IDS } from './db/defaultStylesheets';
import { NEW_NOTE_TEMPLATE } from './utils/newNoteTemplate';
import type { Note, NoteTemplate, Stylesheet } from './types';
import './App.css';

type View =
  | { kind: 'list' }
  | { kind: 'editor'; noteId: string }
  | { kind: 'stylesheets' }
  | { kind: 'stylesheet-editor'; stylesheetId: string | null };

export default function App() {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [stylesheets, setStylesheets] = useState<Stylesheet[]>([]);
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    void getAllNotes().then(setNotes);
    void getAllStylesheets().then(setStylesheets);
    void getAllTemplates().then(setTemplates);
  }, []);

  const createNoteWithStylesheets = (editorStylesheetIds: string[], previewStylesheetIds: string[]) => {
    const now = Date.now();
    const note: Note = {
      id: createNoteId(),
      title: '',
      content: NEW_NOTE_TEMPLATE,
      createdAt: now,
      updatedAt: now,
      labels: [],
      editorStylesheetIds,
      previewStylesheetIds,
    };
    setNotes((prev) => [note, ...(prev ?? [])]);
    setView({ kind: 'editor', noteId: note.id });
  };

  const handleNewNote = () => {
    createNoteWithStylesheets(DEFAULT_EDITOR_STYLESHEET_IDS, DEFAULT_PREVIEW_STYLESHEET_IDS);
  };

  const handleNewNoteFromTemplate = () => {
    setTemplatePickerOpen(true);
  };

  const handleChooseTemplate = (template: NoteTemplate) => {
    setTemplatePickerOpen(false);
    createNoteWithStylesheets(template.editorStylesheetIds, template.previewStylesheetIds);
  };

  const handleDeleteTemplate = (template: NoteTemplate) => {
    const confirmed = window.confirm(`Delete template "${template.name}"? This can't be undone.`);
    if (!confirmed) return;
    setTemplates((prev) => prev.filter((t) => t.id !== template.id));
    void deleteTemplate(template.id);
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

  const handleSaveStylesheet = (stylesheet: Stylesheet) => {
    setStylesheets((prev) => {
      const exists = prev.some((s) => s.id === stylesheet.id);
      return exists ? prev.map((s) => (s.id === stylesheet.id ? stylesheet : s)) : [...prev, stylesheet];
    });
    void putStylesheet(stylesheet);
  };

  const handleCloneStylesheet = (original: Stylesheet) => {
    const now = Date.now();
    const clone: Stylesheet = {
      id: createId(),
      name: `${original.name} copy`,
      cssText: original.cssText,
      builtin: false,
      createdAt: now,
      updatedAt: now,
    };
    setStylesheets((prev) => [...prev, clone]);
    void putStylesheet(clone);
    setView({ kind: 'stylesheet-editor', stylesheetId: clone.id });
  };

  const handleDeleteStylesheet = (stylesheet: Stylesheet) => {
    if (stylesheet.builtin) return;
    const confirmed = window.confirm(`Delete stylesheet "${stylesheet.name}"? This can't be undone.`);
    if (!confirmed) return;
    setStylesheets((prev) => prev.filter((s) => s.id !== stylesheet.id));
    void deleteStylesheet(stylesheet.id);
  };

  if (notes === null) {
    return <div className="app" />;
  }

  if (view.kind === 'stylesheets') {
    return (
      <div className="app">
        <StylesheetsListPage
          stylesheets={stylesheets}
          onBack={() => setView({ kind: 'list' })}
          onOpenEditor={(s) => setView({ kind: 'stylesheet-editor', stylesheetId: s?.id ?? null })}
          onClone={handleCloneStylesheet}
          onDelete={handleDeleteStylesheet}
        />
      </div>
    );
  }

  if (view.kind === 'stylesheet-editor') {
    const editing = stylesheets.find((s) => s.id === view.stylesheetId) ?? null;
    return (
      <div className="app">
        <StylesheetEditor
          key={view.stylesheetId ?? 'new'}
          stylesheet={editing}
          onSave={handleSaveStylesheet}
          onBack={() => setView({ kind: 'stylesheets' })}
        />
      </div>
    );
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
          stylesheets={stylesheets}
          onSaved={handleNoteSaved}
          onTemplateSaved={(template) => setTemplates((prev) => [...prev, template])}
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
        onManageStylesheets={() => setView({ kind: 'stylesheets' })}
        onNewNoteFromTemplate={handleNewNoteFromTemplate}
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
      {templatePickerOpen && (
        <TemplatePickerDialog
          templates={templates}
          onChoose={handleChooseTemplate}
          onDelete={handleDeleteTemplate}
          onClose={() => setTemplatePickerOpen(false)}
        />
      )}
    </div>
  );
}
