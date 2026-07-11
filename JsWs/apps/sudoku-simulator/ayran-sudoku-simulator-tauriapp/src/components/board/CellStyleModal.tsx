import { useState } from "react";
import { useGame } from "../../state/GameContext";
import { PREDEFINED_DARK_COLORS } from "../../lib/colors";

export function CellStyleModal() {
  const { selectedIndex, board, setCellColor, customColors, addCustomColor, removeCustomColor } =
    useGame();
  const [open, setOpen] = useState(false);
  const [newColor, setNewColor] = useState("#334155");

  const selectedCell = selectedIndex != null ? board[selectedIndex] : null;
  const canOpen = selectedIndex != null && !!selectedCell?.isDark;

  const pick = (hex: string) => {
    if (selectedIndex != null) setCellColor(selectedIndex, hex);
  };

  return (
    <>
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => setOpen(true)}
        className="w-full rounded-md border border-gray-300 bg-white py-2 text-sm font-medium text-gray-700 shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
      >
        Cell background color
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl">
            <h2 className="mb-3 text-base font-semibold text-gray-800">Cell background color</h2>

            <p className="mb-1 text-xs font-medium uppercase text-gray-500">Predefined</p>
            <div className="mb-3 grid grid-cols-8 gap-2">
              {PREDEFINED_DARK_COLORS.map((c) => (
                <button
                  key={c.hex}
                  type="button"
                  title={c.name}
                  onClick={() => pick(c.hex)}
                  className="h-8 w-8 rounded-full border border-gray-300"
                  style={{ backgroundColor: c.hex }}
                />
              ))}
            </div>

            {customColors.length > 0 && (
              <>
                <p className="mb-1 text-xs font-medium uppercase text-gray-500">Custom</p>
                <div className="mb-3 grid grid-cols-8 gap-2">
                  {customColors.map((c) => (
                    <div key={c.id} className="relative">
                      <button
                        type="button"
                        onClick={() => pick(c.hex)}
                        className="h-8 w-8 rounded-full border border-gray-300"
                        style={{ backgroundColor: c.hex }}
                      />
                      <button
                        type="button"
                        title="Delete custom color"
                        onClick={() => removeCustomColor(c.id)}
                        className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-gray-700 text-[10px] leading-none text-white"
                      >
                        x
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="mb-4 flex items-center gap-2">
              <input
                type="color"
                value={newColor}
                onChange={(e) => setNewColor(e.target.value)}
                className="h-8 w-10 cursor-pointer rounded border border-gray-300"
              />
              <button
                type="button"
                onClick={() => addCustomColor(newColor)}
                className="rounded-md border border-gray-300 bg-white px-3 py-1 text-sm text-gray-700"
              >
                Save custom color
              </button>
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  if (selectedIndex != null) setCellColor(selectedIndex, null);
                }}
                className="rounded-md px-3 py-1.5 text-sm text-gray-600"
              >
                Clear color
              </button>
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
