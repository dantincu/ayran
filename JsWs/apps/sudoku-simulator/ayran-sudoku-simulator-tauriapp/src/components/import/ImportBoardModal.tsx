import { useRef, useState } from "react";
import { useGame } from "../../state/GameContext";
import { recognizeBoardFromImage, type OcrResult } from "../../lib/ocr";
import { findConflicts, type Board } from "../../lib/sudoku";

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function ImportBoardModal() {
  const { board, importBoard } = useGame();
  const [open_, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OcrResult | null>(null);
  const [editableBoard, setEditableBoard] = useState<Board | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setResult(null);
    setEditableBoard(null);
    setError(null);
  };

  const onFileChosen = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const dataUrl = await fileToDataUrl(file);
      const ocrResult = await recognizeBoardFromImage(dataUrl);
      setResult(ocrResult);
      setEditableBoard(ocrResult.board);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read or recognize the image.");
    } finally {
      setBusy(false);
    }
  };

  const conflicts = editableBoard ? findConflicts(editableBoard) : new Set<number>();
  const lowConfidence = new Set(result?.lowConfidenceIndices ?? []);
  const boardIsBlank = board.every((cell) => cell.value == null);

  return (
    <>
      <button
        type="button"
        disabled={!boardIsBlank}
        title={boardIsBlank ? undefined : "Import is only available on a blank board"}
        onClick={() => setOpen(true)}
        className="w-full rounded-md border border-gray-300 bg-white py-2 text-sm font-medium text-gray-700 shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
      >
        Import from screenshot
      </button>

      {open_ && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-4 shadow-xl">
            <h2 className="mb-3 text-base font-semibold text-gray-800">Import board from image</h2>

            {!editableBoard && (
              <div className="mb-4">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => onFileChosen(e.target.files?.[0])}
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full rounded-md bg-[var(--theme-accent)] py-2 text-sm font-semibold text-[var(--theme-accent-fg)] disabled:opacity-60"
                >
                  {busy ? "Recognizing…" : "Choose cropped board image…"}
                </button>
                {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
              </div>
            )}

            {editableBoard && (
              <>
                <p className="mb-2 text-xs text-gray-500">
                  Review the recognized digits. Cells outlined in amber had low OCR confidence;
                  cells in red conflict with another cell. Click a cell to correct it (0 clears).
                  Confirming will save this as a new snapshot.
                </p>
                <div className="mb-4 grid grid-cols-9 overflow-hidden rounded border border-gray-400">
                  {editableBoard.map((cell, index) => {
                    const isConflict = conflicts.has(index);
                    const isLow = lowConfidence.has(index);
                    return (
                      <button
                        key={index}
                        type="button"
                        onClick={() => {
                          const input = window.prompt("Enter digit 1-9 (blank to clear):", cell.value?.toString() ?? "");
                          if (input === null) return;
                          const trimmed = input.trim();
                          const next = editableBoard.map((c) => ({ ...c }));
                          next[index].value = trimmed === "" ? null : Math.min(9, Math.max(1, Number(trimmed) || 0)) || null;
                          setEditableBoard(next);
                        }}
                        className={`aspect-square border border-gray-200 text-lg font-semibold sm:text-xl ${
                          isConflict
                            ? "bg-red-100 text-red-700"
                            : isLow
                              ? "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-400"
                              : "bg-white text-gray-800"
                        }`}
                      >
                        {cell.value ?? ""}
                      </button>
                    );
                  })}
                </div>

                <div className="flex justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => reset()}
                    className="rounded-md px-3 py-1.5 text-sm text-gray-600"
                  >
                    Choose another image
                  </button>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        reset();
                        setOpen(false);
                      }}
                      className="rounded-md px-3 py-1.5 text-sm text-gray-600"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={conflicts.size > 0}
                      onClick={async () => {
                        await importBoard(editableBoard);
                        reset();
                        setOpen(false);
                      }}
                      className="rounded-md bg-[var(--theme-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--theme-accent-fg)] disabled:opacity-40"
                    >
                      Import
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
