import { useState } from "react";
import { useGame } from "../../state/GameContext";
import { indexToRowCol } from "../../lib/sudoku";

interface SnapshotPencilButtonProps {
  snapshotId: string;
  snapshotName: string;
}

const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export function SnapshotPencilButton({ snapshotId, snapshotName }: SnapshotPencilButtonProps) {
  const { snapshots, toggleSnapshotPencilMark } = useGame();
  const [open, setOpen] = useState(false);

  const snapshot = snapshots.find((s) => s.id === snapshotId);

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
              "{snapshotName}" — tap a digit in an empty cell to cycle it off → normal → red.
              This edits the snapshot directly and does not affect the current board.
            </p>

            <div className="mb-4 grid grid-cols-9 overflow-hidden rounded border-2 border-gray-700">
              {snapshot.board.map((cell, index) => {
                const { row, col } = indexToRowCol(index);
                const borderClasses = [
                  "border-t",
                  row % 3 === 0 ? "border-t-2 border-t-gray-700" : "border-t-gray-200",
                  "border-l",
                  col % 3 === 0 ? "border-l-2 border-l-gray-700" : "border-l-gray-200",
                ].join(" ");

                if (cell.value != null) {
                  return (
                    <div
                      key={index}
                      className={`flex aspect-square items-center justify-center bg-gray-50 text-sm font-medium text-gray-400 ${borderClasses}`}
                    >
                      {cell.value}
                    </div>
                  );
                }

                return (
                  <div key={index} className={`grid aspect-square grid-cols-3 grid-rows-3 bg-white ${borderClasses}`}>
                    {DIGITS.map((digit) => {
                      const state = cell.pencilMarks[digit];
                      return (
                        <button
                          key={digit}
                          type="button"
                          onClick={() => toggleSnapshotPencilMark(snapshotId, index, digit)}
                          className="flex items-center justify-center text-[9px] leading-none sm:text-[10px]"
                          style={{
                            color: state === "red" ? "#dc2626" : state === "normal" ? "#374151" : "#d1d5db",
                          }}
                        >
                          {digit}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
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
