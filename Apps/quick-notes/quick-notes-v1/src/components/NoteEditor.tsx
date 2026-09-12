import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Header from './Header';
import { putNote } from '../db/notesDb';
import { deriveTitle } from '../utils/markdownTitle';
import { computeWholeParagraphsSelection } from '../utils/snapSelect';
import { isEffectivelyEmpty } from '../utils/newNoteTemplate';
import type { Note } from '../types';
import './NoteEditor.css';

const AUTOSAVE_DELAY_MS = 500;

interface NoteEditorProps {
  note: Note;
  onSaved: (note: Note) => void;
  onDiscardEmpty: (id: string) => void;
  onDelete: (id: string) => void;
  onBack: () => void;
}

export default function NoteEditor({ note, onSaved, onDiscardEmpty, onDelete, onBack }: NoteEditorProps) {
  const [content, setContent] = useState(note.content);
  const [previewing, setPreviewing] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selectionRef = useRef({ start: note.content.length, end: note.content.length });
  const lastPersistedRef = useRef(note);
  const undoStackRef = useRef<string[]>([]);

  const persist = useCallback(
    (text: string) => {
      const updated: Note = {
        ...note,
        content: text,
        title: deriveTitle(text),
        updatedAt: Date.now(),
      };
      lastPersistedRef.current = updated;
      onSaved(updated);
      void putNote(updated);
    },
    [note, onSaved],
  );

  useEffect(() => {
    if (content === lastPersistedRef.current.content) return;
    const timer = window.setTimeout(() => {
      undoStackRef.current.push(lastPersistedRef.current.content);
      persist(content);
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [content, persist]);

  const flushPendingSave = useCallback(() => {
    if (content !== lastPersistedRef.current.content) {
      persist(content);
    }
  }, [content, persist]);

  const captureSelection = useCallback(() => {
    const ta = textareaRef.current;
    if (ta) selectionRef.current = { start: ta.selectionStart, end: ta.selectionEnd };
  }, []);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const { end } = selectionRef.current;
    ta.setSelectionRange(end, end);
  }, []);

  const handleContentChange = (value: string) => {
    setContent(value);
    if (value !== lastPersistedRef.current.content) setCanUndo(true);
  };

  const handleUndo = () => {
    if (content !== lastPersistedRef.current.content) {
      // Revert the not-yet-autosaved edit first, without consuming a history entry.
      setContent(lastPersistedRef.current.content);
      setCanUndo(undoStackRef.current.length > 0);
      return;
    }
    const prev = undoStackRef.current.pop();
    if (prev === undefined) {
      setCanUndo(false);
      return;
    }
    persist(prev);
    setContent(prev);
    setCanUndo(undoStackRef.current.length > 0);
  };

  const handleBack = () => {
    if (isEffectivelyEmpty(content)) {
      onDiscardEmpty(note.id);
    } else {
      flushPendingSave();
    }
    onBack();
  };

  const handleSnapWholeParagraphs = () => {
    const ta = textareaRef.current;
    if (!ta || previewing) return;
    const { start, end } = selectionRef.current;
    const result = computeWholeParagraphsSelection(content, start, end);
    if (!result) return;
    ta.focus();
    ta.setSelectionRange(result.start, result.end);
    selectionRef.current = result;
  };

  return (
    <div className="note-editor">
      <Header
        mode="editor"
        onBack={handleBack}
        previewing={previewing}
        onTogglePreview={() => setPreviewing((v) => !v)}
        onOptionsOpen={captureSelection}
        onSnapWholeParagraphs={handleSnapWholeParagraphs}
        onDeleteNote={() => onDelete(note.id)}
        onUndo={handleUndo}
        canUndo={canUndo}
      />
      <div className="note-editor-body">
        {previewing ? (
          <div className="note-editor-preview">
            {content.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            ) : (
              <p className="note-editor-preview-empty">Nothing to preview yet.</p>
            )}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            className="note-editor-textarea"
            value={content}
            onChange={(e) => handleContentChange(e.target.value)}
            onSelect={captureSelection}
            onKeyUp={captureSelection}
            onMouseUp={captureSelection}
            onTouchEnd={captureSelection}
            placeholder="Start writing in Markdown…"
            autoFocus
            spellCheck
          />
        )}
      </div>
    </div>
  );
}
