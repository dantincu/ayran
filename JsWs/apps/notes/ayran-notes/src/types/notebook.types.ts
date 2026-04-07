import { NoteInternalDir } from './note.types';

export interface NotebookJson {
  Title: string;
  InternalDirs?: Record<string, NoteInternalDir>;
}

export interface NotebookMetadata {
  title: string;
  /** Absolute path to the root folder of the notebook on the storage provider */
  rootPath: string;
  storageProviderId: string;
  internalDirs: Record<string, NoteInternalDir>;
}

export interface NotebookSettings {
  darkMode: 'system' | 'light' | 'dark';
  customStylesheet: string | null;
  shortcuts: Record<string, string>;
  starredNotes: string[]; // note paths
  recentLabelColors: string[];
}

export const DEFAULT_NOTEBOOK_SETTINGS: NotebookSettings = {
  darkMode: 'system',
  customStylesheet: null,
  shortcuts: {},
  starredNotes: [],
  recentLabelColors: [],
};
