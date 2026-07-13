import { useGame } from "../../state/GameContext";

const DIGIT_STATUS_CLASSES: Record<string, string> = {
  complete: "border-green-400 bg-green-50 text-green-800",
  impossible: "border-red-400 bg-red-50 text-red-700",
  normal: "border-gray-300 bg-white text-gray-800",
};

export function NumberPad() {
  const {
    selectedIndex,
    setCellValue,
    clearCell,
    toggleCellDark,
    board,
    digitStatuses,
    pencilMode,
    togglePencilMode,
    togglePencilMark,
  } = useGame();

  const disabled = selectedIndex == null;
  const selectedCell = selectedIndex != null ? board[selectedIndex] : null;
  const digitsDisabled = disabled || (pencilMode && selectedCell?.value != null);
  const hasComplete = Object.values(digitStatuses).includes("complete");
  const hasImpossible = Object.values(digitStatuses).includes("impossible");

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-5 gap-2 sm:grid-cols-9">
        {Array.from({ length: 9 }, (_, i) => i + 1).map((n) => {
          const status = digitStatuses[n] ?? "normal";
          return (
            <button
              key={n}
              type="button"
              disabled={digitsDisabled}
              title={
                status === "complete"
                  ? "All 9 placed"
                  : status === "impossible"
                    ? "Can no longer reach 9 — a placement elsewhere blocked it"
                    : undefined
              }
              onClick={() => {
                if (selectedIndex == null) return;
                if (pencilMode) togglePencilMark(selectedIndex, n);
                else setCellValue(selectedIndex, n);
              }}
              className={`relative aspect-square rounded-md border text-2xl font-bold shadow-sm active:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40 ${DIGIT_STATUS_CLASSES[status]}`}
            >
              {n}
              {status === "complete" && (
                <span aria-hidden="true" className="absolute right-0.5 top-0.5 text-xs leading-none text-green-600">
                  ✓
                </span>
              )}
              {status === "impossible" && (
                <span aria-hidden="true" className="absolute right-0.5 top-0.5 text-xs leading-none text-red-600">
                  ✕
                </span>
              )}
            </button>
          );
        })}
      </div>
      {(hasComplete || hasImpossible) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
          {hasComplete && (
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-sm border border-green-400 bg-green-50" />
              All 9 placed
            </span>
          )}
          {hasImpossible && (
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-sm border border-red-400 bg-red-50" />
              Can no longer reach 9
            </span>
          )}
        </div>
      )}
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
