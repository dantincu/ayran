import { useMemo } from "react";
import { useGame } from "../../state/GameContext";
import { getPeers } from "../../lib/sudoku";
import { SudokuCell } from "./SudokuCell";

export function SudokuGrid() {
  const { board, conflicts, selectedIndex, rejectedIndex, rejectedValue, selectCell } = useGame();

  const selectedValue = selectedIndex != null ? board[selectedIndex].value : null;

  const highlighted = useMemo(() => {
    if (selectedIndex == null) return new Set<number>();
    const set = new Set(getPeers(selectedIndex));
    if (selectedValue != null) {
      for (let i = 0; i < board.length; i++) {
        if (board[i].value === selectedValue) {
          set.add(i);
          for (const peer of getPeers(i)) set.add(peer);
        }
      }
    }
    return set;
  }, [board, selectedIndex, selectedValue]);

  return (
    <div className="grid aspect-square w-full max-w-[min(96vw,560px)] grid-cols-9 grid-rows-[repeat(9,minmax(0,1fr))] overflow-hidden rounded-md shadow-sm">
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
          rejectedValue={rejectedIndex === index ? rejectedValue : null}
          isPeer={highlighted.has(index)}
          onSelect={selectCell}
        />
      ))}
    </div>
  );
}
