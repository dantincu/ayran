import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

interface PopoverEntry {
  id: string;
}

interface PopoverStackContextValue {
  stack: PopoverEntry[];
  register: (id: string, onClose: () => void) => void;
  unregister: (id: string) => void;
  closeTop: () => void;
  closeAll: () => void;
}

const PopoverStackContext = createContext<PopoverStackContextValue>({
  stack: [],
  register: () => {},
  unregister: () => {},
  closeTop: () => {},
  closeAll: () => {},
});

export function PopoverStackProvider({ children }: { children: React.ReactNode }) {
  const [stack, setStack] = useState<PopoverEntry[]>([]);

  // Callbacks live in a ref — updating them never triggers a re-render.
  const callbacksRef = useRef<Map<string, () => void>>(new Map());
  // Ref mirror so closeTop / closeAll are stable with no stack dep.
  const stackRef = useRef<PopoverEntry[]>([]);
  stackRef.current = stack;

  const register = useCallback((id: string, onClose: () => void) => {
    callbacksRef.current.set(id, onClose);
    setStack((s) => [...s, { id }]);
  }, []);

  const unregister = useCallback((id: string) => {
    callbacksRef.current.delete(id);
    setStack((s) => s.filter((e) => e.id !== id));
  }, []);

  // Stable — read through refs, no state dep.
  const closeTop = useCallback(() => {
    const top = stackRef.current[stackRef.current.length - 1];
    if (top) callbacksRef.current.get(top.id)?.();
  }, []);

  const closeAll = useCallback(() => {
    [...stackRef.current].forEach((e) => callbacksRef.current.get(e.id)?.());
  }, []);

  const value = useMemo(
    () => ({ stack, register, unregister, closeTop, closeAll }),
    [stack, register, unregister, closeTop, closeAll],
  );

  return <PopoverStackContext.Provider value={value}>{children}</PopoverStackContext.Provider>;
}

export function usePopoverStack() {
  return useContext(PopoverStackContext);
}
