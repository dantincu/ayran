import { useState } from "react";
import { useGame } from "../../state/GameContext";
import { indexToRowCol } from "../../lib/sudoku";

interface SnapshotPencilButtonProps {
  snapshotId: string;
  snapshotName: string;
}

const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export function SnapshotPencilButton({ snapshotId, snapshotName }: SnapshotPencilButtonProps) {
  const {
    snapshots,
    toggleSnapshotPencilMark,
    showAllSnapshotPencilDigits,
    setShowAllSnapshotPencilDigits,
  } = useGame();
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const snapshot = snapshots.find((s) => s.id === snapshotId);
  const selectedCell = selectedIndex != null && snapshot ? snapshot.board[selectedIndex] : null;

  const close = () => {
    setOpen(false);
    setSelectedIndex(null);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
      >
        Pencils
      </button>

      {open && snapshot && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-4 shadow-xl">
            <h2 className="mb-1 text-base font-semibold text-gray-800">Edit pencil marks</h2>
            <p className="mb-3 text-xs text-gray-500">
              "{snapshotName}" — select an empty cell, then tap digits below to cycle them off →
              normal → red. This edits the snapshot directly and does not affect the current board.
            </p>

            <label className="mb-3 flex items-center gap-2 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={showAllSnapshotPencilDigits}
                onChange={(e) => setShowAllSnapshotPencilDigits(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Show all digit positions in every cell
            </label>

            <div className="mb-3 grid grid-cols-9 overflow-hidden rounded border-2 border-gray-700">
              {snapshot.board.map((cell, index) => {
                const { row, col } = indexToRowCol(index);
                const borderClasses = [
                  "border-t",
                  row % 3 === 0 ? "border-t-2 border-t-gray-700" : "border-t-gray-200",
                  "border-l",
                  col % 3 === 0 ? "border-l-2 border-l-gray-700" : "border-l-gray-200",
                ].join(" ");
                const filled = cell.value != null;
                const isSelected = selectedIndex === index;
                const hasMarks = Object.keys(cell.pencilMarks).length > 0;

                return (
                  <button
                    key={index}
                    type="button"
                    disabled={filled}
                    onClick={() => setSelectedIndex(index)}
                    className={`relative flex aspect-square min-w-0 min-h-0 items-center justify-center overflow-hidden text-2xl font-bold disabled:cursor-not-allowed ${borderClasses} ${
                      filled
                        ? "bg-gray-50 text-gray-400"
                        : isSelected
                          ? "bg-blue-100 ring-2 ring-inset ring-blue-400"
                          : "bg-white"
                    }`}
                  >
                    {filled ? (
                      cell.value
                    ) : hasMarks || showAllSnapshotPencilDigits ? (
                      <span className="grid h-full w-full grid-cols-3 grid-rows-3 p-px text-[12px] leading-none font-bold">
                        {DIGITS.map((digit) => {
                          const state = cell.pencilMarks[digit];
                          const visible = state != null || showAllSnapshotPencilDigits;
                          return (
                            <span
                              key={digit}
                              className="flex items-center justify-center"
                              style={{
                                color:
                                  state === "red" ? "#dc2626" : state === "normal" ? "#374151" : "#d1d5db",
                              }}
                            >
                              {visible ? digit : ""}
                            </span>
                          );
                        })}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            <div className="mb-4 grid grid-cols-9 gap-1">
              {DIGITS.map((digit) => {
                const state = selectedCell?.pencilMarks[digit];
                return (
                  <button
                    key={digit}
                    type="button"
                    disabled={selectedIndex == null || selectedCell?.value != null}
                    onClick={() => selectedIndex != null && toggleSnapshotPencilMark(snapshotId, selectedIndex, digit)}
                    className="aspect-square rounded border border-gray-300 bg-white text-xl font-bold shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
                    style={{ color: state === "red" ? "#dc2626" : state === "normal" ? "#111827" : "#9ca3af" }}
                  >
                    {digit}
                  </button>
                );
              })}
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={close}
                className="rounded-md bg-gray-800 px-3 py-1.5 text-sm text-white"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
