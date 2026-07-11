export const BOARD_SIZE = 9;
export const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;

export interface CellState {
  value: number | null;
  isDark: boolean;
  bgColor: string | null;
}

export type Board = CellState[];

export function createEmptyCell(): CellState {
  return { value: null, isDark: false, bgColor: null };
}

export function createEmptyBoard(): Board {
  return Array.from({ length: CELL_COUNT }, createEmptyCell);
}

export function cloneBoard(board: Board): Board {
  return board.map((cell) => ({ ...cell }));
}

export function indexToRowCol(index: number): { row: number; col: number } {
  return { row: Math.floor(index / BOARD_SIZE), col: index % BOARD_SIZE };
}

export function rowColToIndex(row: number, col: number): number {
  return row * BOARD_SIZE + col;
}

export function boxIndexOf(row: number, col: number): number {
  return Math.floor(row / 3) * 3 + Math.floor(col / 3);
}

function peersOf(index: number): number[] {
  const { row, col } = indexToRowCol(index);
  const box = boxIndexOf(row, col);
  const peers: number[] = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    if (i === index) continue;
    const rc = indexToRowCol(i);
    if (rc.row === row || rc.col === col || boxIndexOf(rc.row, rc.col) === box) {
      peers.push(i);
    }
  }
  return peers;
}

const PEER_CACHE: number[][] = Array.from({ length: CELL_COUNT }, (_, i) => peersOf(i));

export function getPeers(index: number): number[] {
  return PEER_CACHE[index];
}

/** Would placing `value` at `index` conflict with any peer's current value? */
export function wouldConflict(board: Board, index: number, value: number): boolean {
  return getPeers(index).some((peerIndex) => board[peerIndex].value === value);
}

/** Returns the set of cell indices that are in conflict with at least one peer. */
export function findConflicts(board: Board): Set<number> {
  const conflicts = new Set<number>();
  for (let i = 0; i < CELL_COUNT; i++) {
    const value = board[i].value;
    if (value == null) continue;
    for (const peerIndex of getPeers(i)) {
      if (peerIndex > i && board[peerIndex].value === value) {
        conflicts.add(i);
        conflicts.add(peerIndex);
      }
    }
  }
  return conflicts;
}
