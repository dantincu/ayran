import { useGame } from "../../state/GameContext";

export function NumberPad() {
  const {
    selectedIndex,
    setCellValue,
    clearCell,
    toggleCellDark,
    board,
    pencilMode,
    togglePencilMode,
    togglePencilMark,
  } = useGame();

  const disabled = selectedIndex == null;
  const selectedCell = selectedIndex != null ? board[selectedIndex] : null;
  const digitsDisabled = disabled || (pencilMode && selectedCell?.value != null);

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-5 gap-2 sm:grid-cols-9">
        {Array.from({ length: 9 }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            type="button"
            disabled={digitsDisabled}
            onClick={() => {
              if (selectedIndex == null) return;
              if (pencilMode) togglePencilMark(selectedIndex, n);
              else setCellValue(selectedIndex, n);
            }}
            className="aspect-square rounded-md border border-gray-300 bg-white text-lg font-medium text-gray-800 shadow-sm active:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {n}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => selectedIndex != null && clearCell(selectedIndex)}
          className="flex-1 rounded-md border border-gray-300 bg-white py-2 text-sm font-medium text-gray-700 shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
        >
          Clear
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => selectedIndex != null && toggleCellDark(selectedIndex)}
          className="flex-1 rounded-md border border-gray-300 bg-white py-2 text-sm font-medium text-gray-700 shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
        >
          {selectedCell?.isDark ? "Undo dark mode" : "Dark mode"}
        </button>
      </div>
      <button
        type="button"
        onClick={togglePencilMode}
        className={`w-full rounded-md border py-2 text-sm font-medium shadow-sm ${
          pencilMode
            ? "border-blue-400 bg-blue-50 text-blue-700"
            : "border-gray-300 bg-white text-gray-700"
        }`}
      >
        Pencil marks: {pencilMode ? "On" : "Off"}
      </button>
    </div>
  );
}
