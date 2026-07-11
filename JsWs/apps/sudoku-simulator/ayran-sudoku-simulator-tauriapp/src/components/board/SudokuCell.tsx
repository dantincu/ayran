import { contrastTextColor } from "../../lib/colors";
import { indexToRowCol } from "../../lib/sudoku";

interface SudokuCellProps {
  index: number;
  value: number | null;
  isDark: boolean;
  bgColor: string | null;
  isSelected: boolean;
  isConflict: boolean;
  isRejected: boolean;
  isPeer: boolean;
  onSelect: (index: number) => void;
}

export function SudokuCell({
  index,
  value,
  isDark,
  bgColor,
  isSelected,
  isConflict,
  isRejected,
  isPeer,
  onSelect,
}: SudokuCellProps) {
  const { row, col } = indexToRowCol(index);

  const borderClasses = [
    "border-t",
    row % 3 === 0 ? "border-t-2 border-t-gray-700" : "border-t-gray-300",
    "border-l",
    col % 3 === 0 ? "border-l-2 border-l-gray-700" : "border-l-gray-300",
    row === 8 ? "border-b-2 border-b-gray-700" : "",
    col === 8 ? "border-r-2 border-r-gray-700" : "",
  ].join(" ");

  const darkStyle = isDark
    ? { backgroundColor: bgColor ?? "#334155", color: contrastTextColor(bgColor ?? "#334155") }
    : undefined;

  let bgClass = "bg-white";
  if (!isDark) {
    if (isConflict) bgClass = "bg-cell-conflict";
    else if (isSelected) bgClass = "bg-cell-selected";
    else if (isPeer) bgClass = "bg-cell-peer";
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(index)}
      className={`relative flex aspect-square w-full items-center justify-center text-lg font-medium transition-colors sm:text-2xl ${borderClasses} ${bgClass} ${
        isRejected ? "animate-pulse ring-2 ring-inset ring-red-500" : ""
      } ${isSelected && isDark ? "ring-2 ring-inset ring-blue-400" : ""}`}
      style={darkStyle}
    >
      <span className={!isDark && isConflict ? "text-cell-conflict-text" : undefined}>
        {value ?? ""}
      </span>
    </button>
  );
}
