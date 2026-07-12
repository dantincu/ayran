import { useGame } from "../../state/GameContext";
import { getPeers } from "../../lib/sudoku";
import { SudokuCell } from "./SudokuCell";

export function SudokuGrid() {
  const { board, conflicts, selectedIndex, rejectedIndex, selectCell } = useGame();

  const peerSet = selectedIndex != null ? new Set(getPeers(selectedIndex)) : null;

  return (
    <div className="grid aspect-square w-full max-w-[min(90vw,560px)] grid-cols-9 overflow-hidden rounded-md shadow-sm">
      {board.map((cell, index) => (
        <SudokuCell
          key={index}
          index={index}
          value={cell.value}
          isDark={cell.isDark}
          bgColor={cell.bgColor}
          pencilMarks={cell.pencilMarks}
          isSelected={selectedIndex === index}
          isConflict={conflicts.has(index)}
          isRejected={rejectedIndex === index}
          isPeer={peerSet?.has(index) ?? false}
          onSelect={selectCell}
        />
      ))}
    </div>
  );
}
