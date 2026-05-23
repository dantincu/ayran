import { createContext, useCallback, useContext, useMemo, useState } from 'react';

interface ModalEntry {
  id: string;
  hasClose: boolean;
  onClose?: () => void;
  onToggleMaximize?: () => void;
  onMinimize?: () => void;
}

interface ModalCallbacks {
  onClose?: () => void;
  onToggleMaximize?: () => void;
  onMinimize?: () => void;
}

interface ModalStackContextValue {
  stack: ModalEntry[];
  register: (id: string, hasClose: boolean) => void;
  unregister: (id: string) => void;
  updateHasClose: (id: string, hasClose: boolean) => void;
  updateCallbacks: (id: string, callbacks: ModalCallbacks) => void;
  closeAllCounter: number;
  triggerCloseAll: () => void;
  closeTop: () => void;
  toggleMaximizeTop: () => void;
  minimizeAll: () => void;
}

const ModalStackContext = createContext<ModalStackContextValue>({
  stack: [],
  register: () => {},
  unregister: () => {},
  updateHasClose: () => {},
  updateCallbacks: () => {},
  closeAllCounter: 0,
  triggerCloseAll: () => {},
  closeTop: () => {},
  toggleMaximizeTop: () => {},
  minimizeAll: () => {},
});

export function ModalStackProvider({ children }: { children: React.ReactNode }) {
  const [stack, setStack] = useState<ModalEntry[]>([]);
  const [closeAllCounter, setCloseAllCounter] = useState(0);

  const register = useCallback((id: string, hasClose: boolean) => {
    setStack((s) => [...s, { id, hasClose }]);
  }, []);

  const unregister = useCallback((id: string) => {
    setStack((s) => s.filter((e) => e.id !== id));
  }, []);

  const updateHasClose = useCallback((id: string, hasClose: boolean) => {
    setStack((s) => s.map((e) => e.id === id ? { ...e, hasClose } : e));
  }, []);

  const updateCallbacks = useCallback((id: string, callbacks: ModalCallbacks) => {
    setStack((s) => s.map((e) => e.id === id ? { ...e, ...callbacks } : e));
  }, []);

  const triggerCloseAll = useCallback(() => {
    setCloseAllCounter((c) => c + 1);
  }, []);

  const closeTop = useCallback(() => {
    const top = stack[stack.length - 1];
    if (top?.hasClose && top?.onClose) top.onClose();
  }, [stack]);

  const toggleMaximizeTop = useCallback(() => {
    const top = stack[stack.length - 1];
    top?.onToggleMaximize?.();
  }, [stack]);

  const minimizeAll = useCallback(() => {
    stack.forEach((e) => e.onMinimize?.());
  }, [stack]);

  const value = useMemo(
    () => ({
      stack, register, unregister, updateHasClose, updateCallbacks,
      closeAllCounter, triggerCloseAll, closeTop, toggleMaximizeTop, minimizeAll,
    }),
    [stack, register, unregister, updateHasClose, updateCallbacks, closeAllCounter, triggerCloseAll, closeTop, toggleMaximizeTop, minimizeAll],
  );

  return <ModalStackContext.Provider value={value}>{children}</ModalStackContext.Provider>;
}

export function useModalStack() {
  return useContext(ModalStackContext);
}
