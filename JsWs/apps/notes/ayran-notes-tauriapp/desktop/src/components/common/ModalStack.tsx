import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

interface ModalEntry {
  id: string;
  hasClose: boolean;
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

  // Callbacks live in a ref — updating them never triggers a re-render.
  const callbacksRef = useRef<Map<string, ModalCallbacks>>(new Map());
  // Mirror of stack in a ref so action callbacks can read it without a dep.
  const stackRef = useRef<ModalEntry[]>([]);
  stackRef.current = stack;

  const register = useCallback((id: string, hasClose: boolean) => {
    setStack((s) => [...s, { id, hasClose }]);
  }, []);

  const unregister = useCallback((id: string) => {
    callbacksRef.current.delete(id);
    setStack((s) => s.filter((e) => e.id !== id));
  }, []);

  const updateHasClose = useCallback((id: string, hasClose: boolean) => {
    setStack((s) => s.map((e) => e.id === id ? { ...e, hasClose } : e));
  }, []);

  // Pure ref write — no setState, no re-render cascade.
  const updateCallbacks = useCallback((id: string, callbacks: ModalCallbacks) => {
    callbacksRef.current.set(id, callbacks);
  }, []);

  const triggerCloseAll = useCallback(() => {
    setCloseAllCounter((c) => c + 1);
  }, []);

  // All three action callbacks are stable (no stack dep) because they read
  // through refs. This breaks the re-render loop caused by consumers
  // re-registering callbacks when the context value changes.
  const closeTop = useCallback(() => {
    const top = stackRef.current[stackRef.current.length - 1];
    if (top?.hasClose) callbacksRef.current.get(top.id)?.onClose?.();
  }, []);

  const toggleMaximizeTop = useCallback(() => {
    const top = stackRef.current[stackRef.current.length - 1];
    callbacksRef.current.get(top?.id ?? '')?.onToggleMaximize?.();
  }, []);

  const minimizeAll = useCallback(() => {
    stackRef.current.forEach((e) => callbacksRef.current.get(e.id)?.onMinimize?.());
  }, []);

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
