import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppSession, AppTab, AppState } from '../types/session.types';
import { StorageProviderType } from '../types/storage.types';

interface SessionStore {
  sessions: AppSession[];
  currentSessionId: string | null;
  legalAccepted: boolean;

  // Actions
  acceptLegal: () => void;
  addSession: (session: AppSession) => void;
  removeSession: (sessionId: string) => void;
  updateSession: (sessionId: string, updates: Partial<AppSession>) => void;
  setCurrentSession: (sessionId: string) => void;
  getCurrentSession: () => AppSession | null;
}

function createInitialTab(): AppTab {
  return {
    id: generateId(),
    uri: '/',
    activeModalStack: [],
    minimizedModalStacks: [],
    docking: null,
  };
}

export function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const useSessionStore = create<SessionStore>()(
  persist(
    (set, get) => ({
      sessions: [],
      currentSessionId: null,
      legalAccepted: false,

      acceptLegal: () => set({ legalAccepted: true }),

      addSession: (session) =>
        set((state) => ({
          sessions: [...state.sessions, session],
          currentSessionId: state.currentSessionId ?? session.id,
        })),

      removeSession: (sessionId) =>
        set((state) => {
          const sessions = state.sessions.filter((s) => s.id !== sessionId);
          const currentSessionId =
            state.currentSessionId === sessionId
              ? sessions[0]?.id ?? null
              : state.currentSessionId;
          return { sessions, currentSessionId };
        }),

      updateSession: (sessionId, updates) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, ...updates } : s,
          ),
        })),

      setCurrentSession: (sessionId) => set({ currentSessionId: sessionId }),

      getCurrentSession: () => {
        const { sessions, currentSessionId } = get();
        return sessions.find((s) => s.id === currentSessionId) ?? null;
      },
    }),
    {
      name: 'ayran-sessions',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

export function createSession(
  storageProviderId: string,
  storageProviderType: StorageProviderType,
  notebookRootPath: string,
  notebookTitle: string,
): AppSession {
  const tab = createInitialTab();
  return {
    id: generateId(),
    name: notebookTitle,
    syncNameWithNotebook: true,
    storageProviderId,
    storageProviderType,
    notebookRootPath,
    tabs: [tab],
    currentTabId: tab.id,
  };
}
