import { create } from 'zustand';
import { ModalDescriptor, ModalStack } from '../types/session.types';
import { useSessionStore, generateId } from './session.store';

interface ModalStore {
  /** Get the active modal stack for the current tab */
  getActiveModalStack: () => ModalStack;
  /** Get all minimized stacks for the current tab */
  getMinimizedStacks: () => ModalStack[];

  /** Push a modal onto the active stack */
  pushModal: (descriptor: Omit<ModalDescriptor, 'id'>) => void;
  /** Pop the top modal from the active stack */
  popModal: () => void;
  /** Close all modals in the active stack */
  closeAllModals: () => void;
  /** Minimize the active modal stack */
  minimizeModalStack: () => void;
  /** Restore a minimized stack by index */
  restoreMinimizedStack: (stackIndex: number) => void;
  /** Close a minimized stack by index */
  closeMinimizedStack: (stackIndex: number) => void;
}

function getCurrentTabId(): string | null {
  return useSessionStore.getState().getCurrentSession()?.currentTabId ?? null;
}

function updateCurrentTab(
  updater: (tab: { activeModalStack: ModalStack; minimizedModalStacks: ModalStack[] }) => {
    activeModalStack: ModalStack;
    minimizedModalStacks: ModalStack[];
  },
): void {
  const session = useSessionStore.getState().getCurrentSession();
  if (!session) return;
  const currentTabId = session.currentTabId;
  const tabs = session.tabs.map((t) => {
    if (t.id !== currentTabId) return t;
    const updated = updater({
      activeModalStack: t.activeModalStack,
      minimizedModalStacks: t.minimizedModalStacks,
    });
    return { ...t, ...updated };
  });
  useSessionStore.getState().updateSession(session.id, { tabs });
}

export const useModalStore = create<ModalStore>()(() => ({
  getActiveModalStack: () => {
    const session = useSessionStore.getState().getCurrentSession();
    if (!session) return [];
    const currentTab = session.tabs.find((t) => t.id === session.currentTabId);
    return currentTab?.activeModalStack ?? [];
  },

  getMinimizedStacks: () => {
    const session = useSessionStore.getState().getCurrentSession();
    if (!session) return [];
    const currentTab = session.tabs.find((t) => t.id === session.currentTabId);
    return currentTab?.minimizedModalStacks ?? [];
  },

  pushModal: (descriptor) => {
    updateCurrentTab(({ activeModalStack, minimizedModalStacks }) => ({
      activeModalStack: [...activeModalStack, { ...descriptor, id: generateId() }],
      minimizedModalStacks,
    }));
  },

  popModal: () => {
    updateCurrentTab(({ activeModalStack, minimizedModalStacks }) => ({
      activeModalStack: activeModalStack.slice(0, -1),
      minimizedModalStacks,
    }));
  },

  closeAllModals: () => {
    updateCurrentTab(({ minimizedModalStacks }) => ({
      activeModalStack: [],
      minimizedModalStacks,
    }));
  },

  minimizeModalStack: () => {
    updateCurrentTab(({ activeModalStack, minimizedModalStacks }) => {
      if (activeModalStack.length === 0) return { activeModalStack, minimizedModalStacks };
      return {
        activeModalStack: [],
        minimizedModalStacks: [...minimizedModalStacks, activeModalStack],
      };
    });
  },

  restoreMinimizedStack: (stackIndex) => {
    updateCurrentTab(({ activeModalStack, minimizedModalStacks }) => {
      const stack = minimizedModalStacks[stackIndex];
      if (!stack) return { activeModalStack, minimizedModalStacks };
      const newMinimized = minimizedModalStacks.filter((_, i) => i !== stackIndex);
      // If there's an active stack, minimize it first
      const prevMinimized = activeModalStack.length > 0
        ? [...newMinimized, activeModalStack]
        : newMinimized;
      return {
        activeModalStack: stack,
        minimizedModalStacks: prevMinimized,
      };
    });
  },

  closeMinimizedStack: (stackIndex) => {
    updateCurrentTab(({ activeModalStack, minimizedModalStacks }) => ({
      activeModalStack,
      minimizedModalStacks: minimizedModalStacks.filter((_, i) => i !== stackIndex),
    }));
  },
}));
