import { create } from 'zustand';
import { NotebookSettings, DEFAULT_NOTEBOOK_SETTINGS } from '../types/notebook.types';

interface SettingsStore extends NotebookSettings {
  setDarkMode: (mode: NotebookSettings['darkMode']) => void;
  setCustomStylesheet: (css: string | null) => void;
  setShortcut: (action: string, keys: string) => void;
  removeShortcut: (action: string) => void;
  addRecentLabelColor: (color: string) => void;
  setStarredNotes: (paths: string[]) => void;
  addStarredNote: (notePath: string) => void;
  removeStarredNote: (notePath: string) => void;
  loadSettings: (settings: NotebookSettings) => void;
  resetSettings: () => void;
}

export const useSettingsStore = create<SettingsStore>()((set) => ({
  ...DEFAULT_NOTEBOOK_SETTINGS,

  setDarkMode: (darkMode) => set({ darkMode }),

  setCustomStylesheet: (customStylesheet) => set({ customStylesheet }),

  setShortcut: (action, keys) =>
    set((state) => ({ shortcuts: { ...state.shortcuts, [action]: keys } })),

  removeShortcut: (action) =>
    set((state) => {
      const shortcuts = { ...state.shortcuts };
      delete shortcuts[action];
      return { shortcuts };
    }),

  addRecentLabelColor: (color) =>
    set((state) => {
      const recent = [color, ...state.recentLabelColors.filter((c) => c !== color)].slice(0, 20);
      return { recentLabelColors: recent };
    }),

  setStarredNotes: (starredNotes) => set({ starredNotes }),

  addStarredNote: (notePath) =>
    set((state) => ({
      starredNotes: state.starredNotes.includes(notePath)
        ? state.starredNotes
        : [...state.starredNotes, notePath],
    })),

  removeStarredNote: (notePath) =>
    set((state) => ({ starredNotes: state.starredNotes.filter((p) => p !== notePath) })),

  loadSettings: (settings) => set(settings),

  resetSettings: () => set(DEFAULT_NOTEBOOK_SETTINGS),
}));
