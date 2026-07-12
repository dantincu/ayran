import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  addCustomColor as dbAddCustomColor,
  deleteCustomColor as dbDeleteCustomColor,
  deleteSnapshots,
  getLiveState,
  getSetting,
  listCustomColors,
  listSnapshots,
  putLiveState,
  putSetting,
  putSnapshot,
  type CustomColorRecord,
  type SnapshotRecord,
} from "../lib/db";
import {
  cloneBoard,
  createEmptyBoard,
  cyclePencilMark,
  findConflicts,
  indexToRowCol,
  wouldConflict,
  type Board,
} from "../lib/sudoku";
import { getAncestorChain, getDescendantIds } from "../lib/snapshotTree";

interface LastInput {
  row: number;
  col: number;
  value: number;
}

const SHOW_ALL_SNAPSHOT_PENCIL_DIGITS_KEY = "showAllSnapshotPencilDigits";

interface GameContextValue {
  board: Board;
  conflicts: Set<number>;
  selectedIndex: number | null;
  rejectedIndex: number | null;
  rejectedValue: number | null;
  currentSnapshotId: string | null;
  lastInput: LastInput | null;
  snapshots: SnapshotRecord[];
  customColors: CustomColorRecord[];
  loaded: boolean;
  pencilMode: boolean;
  togglePencilMode: () => void;
  selectCell: (index: number | null) => void;
  setCellValue: (index: number, value: number) => void;
  clearCell: (index: number) => void;
  toggleCellDark: (index: number) => void;
  setCellColor: (index: number, hex: string | null) => void;
  togglePencilMark: (index: number, digit: number) => void;
  saveSnapshot: (name: string, labelColor: string | null) => Promise<void>;
  revertToSnapshot: (id: string) => Promise<void>;
  deleteSnapshot: (id: string) => Promise<void>;
  setSnapshotLabelColor: (id: string, hex: string | null) => Promise<void>;
  toggleSnapshotPencilMark: (snapshotId: string, cellIndex: number, digit: number) => void;
  showAllSnapshotPencilDigits: boolean;
  setShowAllSnapshotPencilDigits: (value: boolean) => void;
  importBoard: (board: Board) => Promise<void>;
  resetBoard: () => Promise<void>;
  addCustomColor: (hex: string) => Promise<void>;
  removeCustomColor: (id: string) => Promise<void>;
  defaultSnapshotName: () => string;
}

const GameContext = createContext<GameContextValue | null>(null);

export function GameProvider({ children }: { children: ReactNode }) {
  const [board, setBoard] = useState<Board>(createEmptyBoard);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [rejectedIndex, setRejectedIndex] = useState<number | null>(null);
  const [rejectedValue, setRejectedValue] = useState<number | null>(null);
  const rejectionTimeoutRef = useRef<number | null>(null);
  const [currentSnapshotId, setCurrentSnapshotId] = useState<string | null>(null);
  const [lastInput, setLastInput] = useState<LastInput | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotRecord[]>([]);
  const [customColors, setCustomColors] = useState<CustomColorRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pencilMode, setPencilMode] = useState(false);
  const [showAllSnapshotPencilDigits, setShowAllSnapshotPencilDigitsState] = useState(false);

  useEffect(() => {
    (async () => {
      const [live, snaps, colors, showAllPencilDigits] = await Promise.all([
        getLiveState(),
        listSnapshots(),
        listCustomColors(),
        getSetting<boolean>(SHOW_ALL_SNAPSHOT_PENCIL_DIGITS_KEY),
      ]);
      if (live) {
        setBoard(live.board);
        setCurrentSnapshotId(live.currentSnapshotId);
        setLastInput(live.lastInput);
      }
      setSnapshots(snaps);
      setCustomColors(colors);
      if (showAllPencilDigits != null) setShowAllSnapshotPencilDigitsState(showAllPencilDigits);
      setLoaded(true);
    })();
  }, []);

  const persistLive = useCallback(
    (nextBoard: Board, nextSnapshotId: string | null, nextLastInput: LastInput | null) => {
      void putLiveState({
        key: "current",
        board: nextBoard,
        currentSnapshotId: nextSnapshotId,
        lastInput: nextLastInput,
      });
    },
    [],
  );

  const conflicts = useMemo(() => findConflicts(board), [board]);

  const clearRejection = useCallback(() => {
    if (rejectionTimeoutRef.current != null) {
      window.clearTimeout(rejectionTimeoutRef.current);
      rejectionTimeoutRef.current = null;
    }
    setRejectedIndex(null);
    setRejectedValue(null);
  }, []);

  useEffect(() => clearRejection, [clearRejection]);

  const selectCell = useCallback(
    (index: number | null) => {
      setSelectedIndex(index);
      clearRejection();
    },
    [clearRejection],
  );

  const setCellValue = useCallback(
    (index: number, value: number) => {
      setBoard((prev) => {
        if (wouldConflict(prev, index, value)) {
          if (rejectionTimeoutRef.current != null) window.clearTimeout(rejectionTimeoutRef.current);
          setRejectedIndex(index);
          setRejectedValue(value);
          rejectionTimeoutRef.current = window.setTimeout(() => {
            setRejectedIndex(null);
            setRejectedValue(null);
            rejectionTimeoutRef.current = null;
          }, 900);
          return prev;
        }
        clearRejection();
        const next = cloneBoard(prev);
        next[index] = { ...next[index], value, pencilMarks: {} };
        const { row, col } = indexToRowCol(index);
        const nextLastInput = { row, col, value };
        setLastInput(nextLastInput);
        persistLive(next, currentSnapshotId, nextLastInput);
        return next;
      });
    },
    [clearRejection, currentSnapshotId, persistLive],
  );

  const clearCell = useCallback(
    (index: number) => {
      clearRejection();
      setBoard((prev) => {
        const next = cloneBoard(prev);
        next[index] = { ...next[index], value: null };
        persistLive(next, currentSnapshotId, lastInput);
        return next;
      });
    },
    [clearRejection, currentSnapshotId, lastInput, persistLive],
  );

  const toggleCellDark = useCallback(
    (index: number) => {
      setBoard((prev) => {
        const next = cloneBoard(prev);
        next[index] = { ...next[index], isDark: !next[index].isDark };
        persistLive(next, currentSnapshotId, lastInput);
        return next;
      });
    },
    [currentSnapshotId, lastInput, persistLive],
  );

  const setCellColor = useCallback(
    (index: number, hex: string | null) => {
      setBoard((prev) => {
        const next = cloneBoard(prev);
        next[index] = { ...next[index], bgColor: hex };
        persistLive(next, currentSnapshotId, lastInput);
        return next;
      });
    },
    [currentSnapshotId, lastInput, persistLive],
  );

  const togglePencilMode = useCallback(() => {
    setPencilMode((v) => !v);
  }, []);

  /** Live-board pencil marks, fully independent of any saved snapshot's pencil marks. */
  const togglePencilMark = useCallback(
    (index: number, digit: number) => {
      setBoard((prev) => {
        if (prev[index].value != null) return prev;
        const next = cloneBoard(prev);
        next[index] = { ...next[index], pencilMarks: cyclePencilMark(next[index].pencilMarks, digit) };
        persistLive(next, currentSnapshotId, lastInput);
        return next;
      });
    },
    [currentSnapshotId, lastInput, persistLive],
  );

  const defaultSnapshotName = useCallback(() => {
    if (!lastInput) return "New snapshot";
    return `R${lastInput.row + 1}C${lastInput.col + 1}=${lastInput.value}`;
  }, [lastInput]);

  const saveSnapshot = useCallback(
    async (name: string, labelColor: string | null) => {
      const record: SnapshotRecord = {
        id: crypto.randomUUID(),
        parentId: currentSnapshotId,
        name: name.trim() || defaultSnapshotName(),
        board: cloneBoard(board),
        labelColor,
        createdAt: Date.now(),
      };
      await putSnapshot(record);
      setSnapshots((prev) => [...prev, record]);
      setCurrentSnapshotId(record.id);
      persistLive(board, record.id, lastInput);
    },
    [board, currentSnapshotId, defaultSnapshotName, lastInput, persistLive],
  );

  const revertToSnapshot = useCallback(
    async (id: string) => {
      const snapshot = snapshots.find((s) => s.id === id);
      if (!snapshot) return;
      const nextBoard = cloneBoard(snapshot.board);
      setBoard(nextBoard);
      setCurrentSnapshotId(id);
      setSelectedIndex(null);
      persistLive(nextBoard, id, lastInput);
    },
    [lastInput, persistLive, snapshots],
  );

  const resetBoard = useCallback(async () => {
    const empty = createEmptyBoard();
    setBoard(empty);
    setCurrentSnapshotId(null);
    setLastInput(null);
    setSelectedIndex(null);
    persistLive(empty, null, null);
  }, [persistLive]);

  const deleteSnapshot = useCallback(
    async (id: string) => {
      const deletedIds = getDescendantIds(snapshots, id);
      await deleteSnapshots([...deletedIds]);
      const remaining = snapshots.filter((s) => !deletedIds.has(s.id));
      setSnapshots(remaining);

      if (currentSnapshotId && deletedIds.has(currentSnapshotId)) {
        const chain = getAncestorChain(snapshots, currentSnapshotId);
        const survivor = chain.find((s) => !deletedIds.has(s.id));
        if (survivor) {
          const nextBoard = cloneBoard(survivor.board);
          setBoard(nextBoard);
          setCurrentSnapshotId(survivor.id);
          persistLive(nextBoard, survivor.id, lastInput);
        } else {
          await resetBoard();
        }
      }
    },
    [currentSnapshotId, lastInput, persistLive, resetBoard, snapshots],
  );

  const setSnapshotLabelColor = useCallback(async (id: string, hex: string | null) => {
    setSnapshots((prev) => {
      const next = prev.map((s) => (s.id === id ? { ...s, labelColor: hex } : s));
      const updated = next.find((s) => s.id === id);
      if (updated) void putSnapshot(updated);
      return next;
    });
  }, []);

  /**
   * Edits a saved snapshot's pencil marks directly, in place — independent of the live
   * board/currentSnapshotId. Committed digits and dark-mode styling stay immutable; this is
   * the one mutable facet of an otherwise-immutable snapshot.
   */
  const toggleSnapshotPencilMark = useCallback(
    (snapshotId: string, cellIndex: number, digit: number) => {
      setSnapshots((prev) => {
        const snapshot = prev.find((s) => s.id === snapshotId);
        if (!snapshot || snapshot.board[cellIndex].value != null) return prev;
        const nextBoard = cloneBoard(snapshot.board);
        nextBoard[cellIndex] = {
          ...nextBoard[cellIndex],
          pencilMarks: cyclePencilMark(nextBoard[cellIndex].pencilMarks, digit),
        };
        const updated: SnapshotRecord = { ...snapshot, board: nextBoard };
        void putSnapshot(updated);
        return prev.map((s) => (s.id === snapshotId ? updated : s));
      });
    },
    [],
  );

  /**
   * Imports a freshly-recognized board (only allowed while the board is blank — enforced by the
   * caller) and immediately saves it as a root snapshot, so the imported state is never lost.
   */
  const setShowAllSnapshotPencilDigits = useCallback((value: boolean) => {
    setShowAllSnapshotPencilDigitsState(value);
    void putSetting(SHOW_ALL_SNAPSHOT_PENCIL_DIGITS_KEY, value);
  }, []);

  const importBoard = useCallback(
    async (newBoard: Board) => {
      const record: SnapshotRecord = {
        id: crypto.randomUUID(),
        parentId: null,
        name: "Imported from screenshot",
        board: cloneBoard(newBoard),
        labelColor: null,
        createdAt: Date.now(),
      };
      await putSnapshot(record);
      setSnapshots((prev) => [...prev, record]);
      setBoard(newBoard);
      setCurrentSnapshotId(record.id);
      setLastInput(null);
      setSelectedIndex(null);
      clearRejection();
      persistLive(newBoard, record.id, null);
    },
    [clearRejection, persistLive],
  );

  const addCustomColor = useCallback(async (hex: string) => {
    const record: CustomColorRecord = { id: crypto.randomUUID(), hex, createdAt: Date.now() };
    await dbAddCustomColor(record);
    setCustomColors((prev) => [...prev, record]);
  }, []);

  const removeCustomColor = useCallback(async (id: string) => {
    await dbDeleteCustomColor(id);
    setCustomColors((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const value: GameContextValue = {
    board,
    conflicts,
    selectedIndex,
    rejectedIndex,
    rejectedValue,
    currentSnapshotId,
    lastInput,
    snapshots,
    customColors,
    loaded,
    pencilMode,
    togglePencilMode,
    selectCell,
    setCellValue,
    clearCell,
    toggleCellDark,
    setCellColor,
    togglePencilMark,
    saveSnapshot,
    revertToSnapshot,
    deleteSnapshot,
    setSnapshotLabelColor,
    toggleSnapshotPencilMark,
    showAllSnapshotPencilDigits,
    setShowAllSnapshotPencilDigits,
    importBoard,
    resetBoard,
    addCustomColor,
    removeCustomColor,
    defaultSnapshotName,
  };

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGame(): GameContextValue {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error("useGame must be used within a GameProvider");
  return ctx;
}
