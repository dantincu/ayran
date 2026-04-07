import { create } from 'zustand';
import { NotebookMetadata } from '../types/notebook.types';
import { NoteMetadata, NoteChildrenJson } from '../types/note.types';

interface NoteListCache {
  /** Note path of parent (empty string for root) */
  parentNotePath: string;
  notes: NoteMetadata[];
  loadedAt: number;
}

interface NotebookStore {
  metadata: NotebookMetadata | null;
  noteListCache: NoteListCache[];
  /** Currently open note path */
  openNotePath: string | null;
  /** Content of the note currently being edited */
  editingContent: string | null;
  /** Whether there are unsaved changes */
  hasUnsavedChanges: boolean;

  setNotebook: (metadata: NotebookMetadata) => void;
  clearNotebook: () => void;

  setCachedNoteList: (parentNotePath: string, notes: NoteMetadata[]) => void;
  getCachedNoteList: (parentNotePath: string) => NoteMetadata[] | null;
  invalidateCacheFor: (parentNotePath: string) => void;

  setOpenNote: (notePath: string | null) => void;
  setEditingContent: (content: string | null) => void;
  setHasUnsavedChanges: (value: boolean) => void;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const useNotebookStore = create<NotebookStore>()((set, get) => ({
  metadata: null,
  noteListCache: [],
  openNotePath: null,
  editingContent: null,
  hasUnsavedChanges: false,

  setNotebook: (metadata) => set({ metadata }),
  clearNotebook: () => set({ metadata: null, noteListCache: [], openNotePath: null }),

  setCachedNoteList: (parentNotePath, notes) =>
    set((state) => {
      const existing = state.noteListCache.filter((c) => c.parentNotePath !== parentNotePath);
      return {
        noteListCache: [...existing, { parentNotePath, notes, loadedAt: Date.now() }],
      };
    }),

  getCachedNoteList: (parentNotePath) => {
    const cached = get().noteListCache.find((c) => c.parentNotePath === parentNotePath);
    if (!cached) return null;
    if (Date.now() - cached.loadedAt > CACHE_TTL_MS) return null;
    return cached.notes;
  },

  invalidateCacheFor: (parentNotePath) =>
    set((state) => ({
      noteListCache: state.noteListCache.filter((c) => c.parentNotePath !== parentNotePath),
    })),

  setOpenNote: (notePath) => set({ openNotePath: notePath }),
  setEditingContent: (content) => set({ editingContent: content }),
  setHasUnsavedChanges: (value) => set({ hasUnsavedChanges: value }),
}));
