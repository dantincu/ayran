export const BOARD_SIZE = 9;
export const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;

export type PencilMarkColor = "normal" | "red";
export type PencilMarks = Partial<Record<number, PencilMarkColor>>;

export interface CellState {
  value: number | null;
  isDark: boolean;
  bgColor: string | null;
  pencilMarks: PencilMarks;
}

export type Board = CellState[];

export function createEmptyCell(): CellState {
  return { value: null, isDark: false, bgColor: null, pencilMarks: {} };
}

export function createEmptyBoard(): Board {
  return Array.from({ length: CELL_COUNT }, createEmptyCell);
}

export function cloneBoard(board: Board): Board {
  return board.map((cell) => ({ ...cell, pencilMarks: { ...cell.pencilMarks } }));
}

/** Cycles a cell's pencil mark for `digit`: absent -> normal -> red -> absent. */
export function cyclePencilMark(marks: PencilMarks, digit: number): PencilMarks {
  const next = { ...marks };
  const current = next[digit];
  if (current === undefined) next[digit] = "normal";
  else if (current === "normal") next[digit] = "red";
  else delete next[digit];
  return next;
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

const BOX_CELLS: number[][] = Array.from({ length: 9 }, () => []);
for (let i = 0; i < CELL_COUNT; i++) {
  const { row, col } = indexToRowCol(i);
  BOX_CELLS[boxIndexOf(row, col)].push(i);
}

export type DigitStatus = "normal" | "complete" | "impossible";

/**
 * For each digit 1-9: "complete" if all 9 instances are already placed, "impossible" if it can
 * never reach 9 (some 3x3 box neither has it nor has any empty cell left that could take it
 * without conflicting a peer — a dead end caused by how other digits were placed), else "normal".
 * Recomputed from scratch every call, so it's always correct regardless of which digit changed —
 * placing/clearing one digit can invalidate a completely different digit.
 */
export function computeDigitStatuses(board: Board): Record<number, DigitStatus> {
  const statuses = {} as Record<number, DigitStatus>;
  for (let digit = 1; digit <= 9; digit++) {
    const count = board.reduce((n, cell) => n + (cell.value === digit ? 1 : 0), 0);
    if (count >= 9) {
      statuses[digit] = "complete";
      continue;
    }
    const isDead = BOX_CELLS.some((cells) => {
      if (cells.some((i) => board[i].value === digit)) return false;
      return !cells.some((i) => board[i].value == null && !wouldConflict(board, i, digit));
    });
    statuses[digit] = isDead ? "impossible" : "normal";
  }
  return statuses;
}
