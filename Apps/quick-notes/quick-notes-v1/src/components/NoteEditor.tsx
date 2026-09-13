import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import Header from './Header';
import ShadowScope from './ShadowScope';
import StylesheetPickerDialog from './StylesheetPickerDialog';
import LabelEditorDialog from './LabelEditorDialog';
import { createId, putNote, putTemplate } from '../db/notesDb';
import { deriveTitle } from '../utils/markdownTitle';
import { computeWholeParagraphsSelection } from '../utils/snapSelect';
import { computeMarkdownHighlightRanges } from '../utils/markdownEditorHighlight';
import { isEffectivelyEmpty } from '../utils/newNoteTemplate';
import type { Note, NoteTemplate, Stylesheet } from '../types';
import './NoteEditor.css';

const AUTOSAVE_DELAY_MS = 500;

// Always-on mechanical CSS for the two shadow-scoped content areas. Never
// toggleable and never visible to custom stylesheets - see ShadowScope.
const EDITOR_SHELL_CSS = `
*, *::before, *::after { box-sizing: border-box; }

.note-editor-highlight-backdrop,
.note-editor-textarea {
  position: absolute;
  inset: 0;
  margin: 0;
  border: none;
  padding: 20px calc(20px + env(safe-area-inset-right, 0px)) calc(20px + env(safe-area-inset-bottom, 0px))
    calc(20px + env(safe-area-inset-left, 0px));
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 14.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-wrap: break-word;
  tab-size: 2;
}

.note-editor-highlight-backdrop {
  overflow: hidden;
  pointer-events: none;
  color: var(--text);
}

.note-editor-textarea {
  width: 100%;
  height: 100%;
  outline: none;
  resize: none;
  overflow: auto;
  background: transparent;
  color: transparent;
  caret-color: var(--text);
}

.note-editor-textarea::placeholder {
  color: var(--text-muted);
}
`;

const PREVIEW_SHELL_CSS = `
*, *::before, *::after { box-sizing: border-box; }

.note-editor-preview-empty {
  color: var(--text-muted);
  font-style: italic;
}

.note-editor-preview :first-child {
  margin-top: 0;
}

.note-editor-preview :last-child {
  margin-bottom: 0;
}
`;

function resolveStylesheetCss(ids: string[], stylesheets: Stylesheet[]): string[] {
  return ids
    .map((id) => stylesheets.find((s) => s.id === id)?.cssText)
    .filter((css): css is string => css !== undefined);
}

// A few harmless, attribute-free inline formatting tags people reasonably embed
// in notes (highlighting, chemistry/math notation, keyboard shortcuts, collapsible
// sections) that the default sanitize schema doesn't include. Nothing here grants
// new attributes (style, on*, etc. stay blocked) - just a few extra tag names.
const previewSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'mark', 'sub', 'sup', 'kbd', 'u', 'ins', 'abbr', 'details', 'summary'],
};

function renderHighlightedMarkdown(content: string): ReactNode[] {
  const ranges = computeMarkdownHighlightRanges(content);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((r, i) => {
    const start = Math.max(r.start, cursor);
    if (start > cursor) nodes.push(content.slice(cursor, start));
    if (r.end > start) {
      nodes.push(
        <span key={i} className={r.className}>
          {content.slice(start, r.end)}
        </span>,
      );
    }
    cursor = Math.max(cursor, r.end);
  });
  if (cursor < content.length) nodes.push(content.slice(cursor));
  return nodes;
}

interface NoteEditorProps {
  note: Note;
  stylesheets: Stylesheet[];
  onSaved: (note: Note) => void;
  onTemplateSaved: (template: NoteTemplate) => void;
  onDiscardEmpty: (id: string) => void;
  onDelete: (id: string) => void;
  onBack: () => void;
}

export default function NoteEditor({
  note,
  stylesheets,
  onSaved,
  onTemplateSaved,
  onDiscardEmpty,
  onDelete,
  onBack,
}: NoteEditorProps) {
  const [content, setContent] = useState(note.content);
  const [previewing, setPreviewing] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [stylesheetPickerOpen, setStylesheetPickerOpen] = useState(false);
  const [labelEditorOpen, setLabelEditorOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLPreElement>(null);
  const selectionRef = useRef({ start: note.content.length, end: note.content.length });
  const lastPersistedRef = useRef(note);
  const undoStackRef = useRef<string[]>([]);
  const redoStackRef = useRef<string[]>([]);

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

  const persistMeta = useCallback(
    (patch: Partial<Pick<Note, 'labels' | 'editorStylesheetIds' | 'previewStylesheetIds'>>) => {
      const updated: Note = { ...note, ...patch, updatedAt: Date.now() };
      lastPersistedRef.current = { ...lastPersistedRef.current, ...patch };
      onSaved(updated);
      void putNote(updated);
    },
    [note, onSaved],
  );

  const handleChangeEditorStylesheets = (ids: string[]) => persistMeta({ editorStylesheetIds: ids });
  const handleChangePreviewStylesheets = (ids: string[]) => persistMeta({ previewStylesheetIds: ids });
  const handleChangeLabels = (labels: Note['labels']) => persistMeta({ labels });

  const handleSaveAsTemplate = (name: string) => {
    const template: NoteTemplate = {
      id: createId(),
      name,
      editorStylesheetIds: note.editorStylesheetIds,
      previewStylesheetIds: note.previewStylesheetIds,
      createdAt: Date.now(),
    };
    onTemplateSaved(template);
    void putTemplate(template);
  };

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
    if (redoStackRef.current.length > 0) {
      redoStackRef.current = [];
      setCanRedo(false);
    }
  };

  const handleUndo = () => {
    if (content !== lastPersistedRef.current.content) {
      // Revert the not-yet-autosaved edit first, without consuming a history entry.
      redoStackRef.current.push(content);
      setContent(lastPersistedRef.current.content);
      setCanUndo(undoStackRef.current.length > 0);
      setCanRedo(true);
      return;
    }
    const prev = undoStackRef.current.pop();
    if (prev === undefined) {
      setCanUndo(false);
      return;
    }
    redoStackRef.current.push(lastPersistedRef.current.content);
    persist(prev);
    setContent(prev);
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);
  };

  const handleRedo = () => {
    const next = redoStackRef.current.pop();
    if (next === undefined) {
      setCanRedo(false);
      return;
    }
    undoStackRef.current.push(lastPersistedRef.current.content);
    persist(next);
    setContent(next);
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);
  };

  const handleBack = () => {
    if (isEffectivelyEmpty(content)) {
      onDiscardEmpty(note.id);
    } else {
      flushPendingSave();
    }
    onBack();
  };

  const highlightedContent = useMemo(() => renderHighlightedMarkdown(content), [content]);
  const editorCss = useMemo(
    () => resolveStylesheetCss(note.editorStylesheetIds, stylesheets),
    [note.editorStylesheetIds, stylesheets],
  );
  const previewCss = useMemo(
    () => resolveStylesheetCss(note.previewStylesheetIds, stylesheets),
    [note.previewStylesheetIds, stylesheets],
  );

  const syncBackdropScroll = useCallback(() => {
    const ta = textareaRef.current;
    const backdrop = backdropRef.current;
    if (ta && backdrop) {
      backdrop.scrollTop = ta.scrollTop;
      backdrop.scrollLeft = ta.scrollLeft;
    }
  }, []);

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
        onOpenStylesheets={() => setStylesheetPickerOpen(true)}
        onOpenLabels={() => setLabelEditorOpen(true)}
        onDeleteNote={() => onDelete(note.id)}
        onUndo={handleUndo}
        canUndo={canUndo}
        onRedo={handleRedo}
        canRedo={canRedo}
      />
      <div className="note-editor-body">
        {previewing ? (
          <ShadowScope hostClassName="note-editor-preview-host" shellCss={PREVIEW_SHELL_CSS} contentCss={previewCss}>
            <div className="note-editor-preview">
              {content.trim() ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeRaw, [rehypeSanitize, previewSchema], rehypeHighlight]}
                >
                  {content}
                </ReactMarkdown>
              ) : (
                <p className="note-editor-preview-empty">Nothing to preview yet.</p>
              )}
            </div>
          </ShadowScope>
        ) : (
          <ShadowScope hostClassName="note-editor-code-wrap" shellCss={EDITOR_SHELL_CSS} contentCss={editorCss}>
            <pre className="note-editor-highlight-backdrop" ref={backdropRef} aria-hidden="true">
              {content ? highlightedContent : ''}
              {'\n'}
            </pre>
            <textarea
              ref={textareaRef}
              className="note-editor-textarea"
              value={content}
              onChange={(e) => handleContentChange(e.target.value)}
              onSelect={captureSelection}
              onKeyUp={captureSelection}
              onMouseUp={captureSelection}
              onTouchEnd={captureSelection}
              onScroll={syncBackdropScroll}
              placeholder="Start writing in Markdown…"
              autoFocus
              spellCheck
            />
          </ShadowScope>
        )}
      </div>
      {stylesheetPickerOpen && (
        <StylesheetPickerDialog
          stylesheets={stylesheets}
          editorStylesheetIds={note.editorStylesheetIds}
          previewStylesheetIds={note.previewStylesheetIds}
          onChangeEditor={handleChangeEditorStylesheets}
          onChangePreview={handleChangePreviewStylesheets}
          onSaveAsTemplate={handleSaveAsTemplate}
          onClose={() => setStylesheetPickerOpen(false)}
        />
      )}
      {labelEditorOpen && (
        <LabelEditorDialog
          labels={note.labels}
          onChange={handleChangeLabels}
          onClose={() => setLabelEditorOpen(false)}
        />
      )}
    </div>
  );
}
