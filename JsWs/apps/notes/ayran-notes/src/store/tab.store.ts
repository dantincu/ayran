import { create } from 'zustand';
import { AppTab, DockingState } from '../types/session.types';
import { useSessionStore, generateId } from './session.store';

interface TabStore {
  // Derived from session store - no local state needed for tabs themselves
  // These actions mutate the session store
  getCurrentTab: () => AppTab | null;
  getTab: (tabId: string) => AppTab | null;

  addTab: (uri?: string) => AppTab;
  removeTab: (tabId: string) => void;
  setCurrentTab: (tabId: string) => void;
  updateTabUri: (tabId: string, uri: string) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  setDocking: (tabId: string, docking: DockingState | null) => void;
  getPreviousTabId: () => string | null;
}

// We implement tab operations as functions that operate on the session store
export const useTabStore = create<TabStore>()((set, get) => ({
  getCurrentTab: () => {
    const session = useSessionStore.getState().getCurrentSession();
    if (!session) return null;
    return session.tabs.find((t) => t.id === session.currentTabId) ?? null;
  },

  getTab: (tabId) => {
    const session = useSessionStore.getState().getCurrentSession();
    return session?.tabs.find((t) => t.id === tabId) ?? null;
  },

  addTab: (uri = '/') => {
    const session = useSessionStore.getState().getCurrentSession();
    if (!session) throw new Error('No current session');
    const newTab: AppTab = {
      id: generateId(),
      uri,
      activeModalStack: [],
      minimizedModalStacks: [],
      docking: null,
    };
    useSessionStore.getState().updateSession(session.id, {
      tabs: [...session.tabs, newTab],
      currentTabId: newTab.id,
    });
    return newTab;
  },

  removeTab: (tabId) => {
    const session = useSessionStore.getState().getCurrentSession();
    if (!session) return;
    const tabs = session.tabs.filter((t) => t.id !== tabId);
    const currentTabId =
      session.currentTabId === tabId
        ? tabs[tabs.length - 1]?.id ?? ''
        : session.currentTabId;
    useSessionStore.getState().updateSession(session.id, { tabs, currentTabId });
  },

  setCurrentTab: (tabId) => {
    const session = useSessionStore.getState().getCurrentSession();
    if (!session) return;
    useSessionStore.getState().updateSession(session.id, { currentTabId: tabId });
  },

  updateTabUri: (tabId, uri) => {
    const session = useSessionStore.getState().getCurrentSession();
    if (!session) return;
    const tabs = session.tabs.map((t) => (t.id === tabId ? { ...t, uri } : t));
    useSessionStore.getState().updateSession(session.id, { tabs });
  },

  reorderTabs: (fromIndex, toIndex) => {
    const session = useSessionStore.getState().getCurrentSession();
    if (!session) return;
    const tabs = [...session.tabs];
    const [moved] = tabs.splice(fromIndex, 1);
    tabs.splice(toIndex, 0, moved);
    useSessionStore.getState().updateSession(session.id, { tabs });
  },

  setDocking: (tabId, docking) => {
    const session = useSessionStore.getState().getCurrentSession();
    if (!session) return;
    const tabs = session.tabs.map((t) => (t.id === tabId ? { ...t, docking } : t));
    useSessionStore.getState().updateSession(session.id, { tabs });
  },

  getPreviousTabId: () => {
    const session = useSessionStore.getState().getCurrentSession();
    if (!session || session.tabs.length < 2) return null;
    const currentIdx = session.tabs.findIndex((t) => t.id === session.currentTabId);
    const prevIdx = currentIdx > 0 ? currentIdx - 1 : session.tabs.length - 1;
    if (prevIdx === currentIdx) return null;
    return session.tabs[prevIdx].id;
  },
}));
