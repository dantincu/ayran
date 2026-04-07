import { useState, useEffect, useCallback } from 'react';
import { NoteMetadata } from '../types/note.types';
import { useNotebookStore } from '../store/notebook.store';
import { useSessionStore } from '../store/session.store';
import { getStorageProvider } from '../storage/StorageProviderFactory';
import { readNoteChildrenJson, childEntryToMetadata } from '../notebook/NoteReader';
import {
  createNote,
  deleteNoteFiles,
  removeChildFromParent,
  renameNote,
  updateNoteStarAndLabel,
} from '../notebook/NoteWriter';
import { buildMdFileName } from '../notebook/NoteFileNaming';
import { useSettingsStore } from '../store/settings.store';

export function useNoteList(parentNotePath: string) {
  const [notes, setNotes] = useState<NoteMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const notebookMeta = useNotebookStore((s) => s.metadata);
  const session = useSessionStore((s) => s.getCurrentSession());
  const addStarredNote = useSettingsStore((s) => s.addStarredNote);
  const removeStarredNote = useSettingsStore((s) => s.removeStarredNote);

  const getProvider = useCallback(() => {
    if (!session) return null;
    return getStorageProvider(session.storageProviderId) ?? null;
  }, [session]);

  const getParentShortFolderPath = useCallback((): string | null => {
    if (!notebookMeta) return null;
    const provider = getProvider();
    if (!provider) return null;
    if (!parentNotePath) return notebookMeta.rootPath;
    const segments = parentNotePath.split('/').filter(Boolean);
    return provider.joinPath(notebookMeta.rootPath, ...segments);
  }, [notebookMeta, parentNotePath, getProvider]);

  const loadNotes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const provider = getProvider();
      const parentPath = getParentShortFolderPath();
      if (!provider || !parentPath) return;

      const childrenJson = await readNoteChildrenJson(provider, parentPath);
      const metadataList: NoteMetadata[] = Object.entries(childrenJson.ChildNotes)
        .map(([indexStr, entry]) => childEntryToMetadata(entry, indexStr, parentNotePath))
        .sort((a, b) => parseInt(b.index, 10) - parseInt(a.index, 10));

      setNotes(metadataList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load notes');
    } finally {
      setLoading(false);
    }
  }, [getProvider, getParentShortFolderPath, parentNotePath]);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  const handleCreateNote = useCallback(async (title: string) => {
    const provider = getProvider();
    const parentPath = getParentShortFolderPath();
    if (!provider || !parentPath) return;
    try {
      const result = await createNote(provider, parentPath, parentNotePath, title);
      await loadNotes();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create note';
      setError(msg);
    }
  }, [getProvider, getParentShortFolderPath, parentNotePath, loadNotes]);

  const handleDeleteNote = useCallback(async (notePath: string) => {
    const provider = getProvider();
    const parentPath = getParentShortFolderPath();
    if (!provider || !parentPath) return;
    try {
      const segments = notePath.split('/').filter(Boolean);
      const childIndexStr = segments[segments.length - 1];
      const note = notes.find((n) => n.notePath === notePath);
      if (!note) return;
      await deleteNoteFiles(provider, parentPath, childIndexStr, note.title);
      await removeChildFromParent(provider, parentPath, childIndexStr);
      removeStarredNote(notePath);
      await loadNotes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete note');
    }
  }, [getProvider, getParentShortFolderPath, notes, removeStarredNote, loadNotes]);

  const handleRenameNote = useCallback(async (notePath: string, newTitle: string) => {
    const provider = getProvider();
    const parentPath = getParentShortFolderPath();
    if (!provider || !parentPath) return;
    try {
      const segments = notePath.split('/').filter(Boolean);
      const childIndexStr = segments[segments.length - 1];
      const childShortPath = provider.joinPath(parentPath, childIndexStr);
      const note = notes.find((n) => n.notePath === notePath);
      const oldMdFileName = buildMdFileName(note?.title ?? newTitle);
      await renameNote(provider, parentPath, childShortPath, oldMdFileName, newTitle);
      await loadNotes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename note');
    }
  }, [getProvider, getParentShortFolderPath, notes, loadNotes]);

  const handleStarNote = useCallback(async (notePath: string, starred: boolean) => {
    const provider = getProvider();
    const parentPath = getParentShortFolderPath();
    if (!provider || !parentPath) return;
    try {
      const segments = notePath.split('/').filter(Boolean);
      const childIndexStr = segments[segments.length - 1];
      const childShortPath = provider.joinPath(parentPath, childIndexStr);
      const note = notes.find((n) => n.notePath === notePath);
      await updateNoteStarAndLabel(provider, parentPath, childShortPath, starred, note?.labelColor ?? null);
      if (starred) addStarredNote(notePath); else removeStarredNote(notePath);
      setNotes((prev) => prev.map((n) => n.notePath === notePath ? { ...n, starred } : n));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update star');
    }
  }, [getProvider, getParentShortFolderPath, notes, addStarredNote, removeStarredNote]);

  const handleLabelColor = useCallback(async (notePath: string, color: string | null) => {
    const provider = getProvider();
    const parentPath = getParentShortFolderPath();
    if (!provider || !parentPath) return;
    try {
      const segments = notePath.split('/').filter(Boolean);
      const childIndexStr = segments[segments.length - 1];
      const childShortPath = provider.joinPath(parentPath, childIndexStr);
      const note = notes.find((n) => n.notePath === notePath);
      await updateNoteStarAndLabel(provider, parentPath, childShortPath, note?.starred ?? false, color);
      setNotes((prev) => prev.map((n) => n.notePath === notePath ? { ...n, labelColor: color } : n));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update label color');
    }
  }, [getProvider, getParentShortFolderPath, notes]);

  return {
    notes,
    loading,
    error,
    refresh: loadNotes,
    handleCreateNote,
    handleDeleteNote,
    handleRenameNote,
    handleStarNote,
    handleLabelColor,
  };
}
