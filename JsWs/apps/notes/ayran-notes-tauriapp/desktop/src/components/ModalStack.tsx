import { createContext, useCallback, useContext, useMemo, useState } from 'react';

interface ModalStackContextValue {
  stack: string[];
  register: (id: string) => void;
  unregister: (id: string) => void;
}

const ModalStackContext = createContext<ModalStackContextValue>({
  stack: [],
  register: () => {},
  unregister: () => {},
});

export function ModalStackProvider({ children }: { children: React.ReactNode }) {
  const [stack, setStack] = useState<string[]>([]);

  const register = useCallback((id: string) => {
    setStack((s) => [...s, id]);
  }, []);

  const unregister = useCallback((id: string) => {
    setStack((s) => s.filter((x) => x !== id));
  }, []);

  const value = useMemo(
    () => ({ stack, register, unregister }),
    [stack, register, unregister],
  );

  return <ModalStackContext.Provider value={value}>{children}</ModalStackContext.Provider>;
}

export function useModalStack() {
  return useContext(ModalStackContext);
}
