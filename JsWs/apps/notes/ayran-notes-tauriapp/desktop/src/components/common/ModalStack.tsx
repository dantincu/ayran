import { createContext, useCallback, useContext, useMemo, useState } from 'react';

interface ModalEntry {
  id: string;
  hasClose: boolean;
}

interface ModalStackContextValue {
  stack: ModalEntry[];
  register: (id: string, hasClose: boolean) => void;
  unregister: (id: string) => void;
  updateHasClose: (id: string, hasClose: boolean) => void;
  closeAllCounter: number;
  triggerCloseAll: () => void;
}

const ModalStackContext = createContext<ModalStackContextValue>({
  stack: [],
  register: () => {},
  unregister: () => {},
  updateHasClose: () => {},
  closeAllCounter: 0,
  triggerCloseAll: () => {},
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

  const triggerCloseAll = useCallback(() => {
    setCloseAllCounter((c) => c + 1);
  }, []);

  const value = useMemo(
    () => ({ stack, register, unregister, updateHasClose, closeAllCounter, triggerCloseAll }),
    [stack, register, unregister, updateHasClose, closeAllCounter, triggerCloseAll],
  );

  return <ModalStackContext.Provider value={value}>{children}</ModalStackContext.Provider>;
}

export function useModalStack() {
  return useContext(ModalStackContext);
}
