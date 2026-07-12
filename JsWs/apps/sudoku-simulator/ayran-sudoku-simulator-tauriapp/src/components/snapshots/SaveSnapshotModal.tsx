import { useEffect, useState } from "react";
import { useGame } from "../../state/GameContext";
import { LABEL_COLORS } from "../../lib/colors";

export function SaveSnapshotModal() {
  const { saveSnapshot, defaultSnapshotName } = useGame();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [labelColor, setLabelColor] = useState<string | null>(null);

  useEffect(() => {
    if (open) setName(defaultSnapshotName());
  }, [open, defaultSnapshotName]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-md bg-[var(--theme-accent)] py-2 text-sm font-semibold text-[var(--theme-accent-fg)] shadow-sm"
      >
        Save snapshot
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl">
            <h2 className="mb-3 text-base font-semibold text-gray-800">Save snapshot</h2>

            <label className="mb-1 block text-xs font-medium uppercase text-gray-500">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mb-3 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
            />

            <p className="mb-1 text-xs font-medium uppercase text-gray-500">Label (optional)</p>
            <div className="mb-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setLabelColor(null)}
                className={`h-7 w-7 rounded-full border-2 ${labelColor === null ? "border-gray-800" : "border-gray-300"} bg-white`}
                title="No label"
              />
              {LABEL_COLORS.map((c) => (
                <button
                  key={c.hex}
                  type="button"
                  title={c.name}
                  onClick={() => setLabelColor(c.hex)}
                  className={`h-7 w-7 rounded-full border-2 ${labelColor === c.hex ? "border-gray-800" : "border-transparent"}`}
                  style={{ backgroundColor: c.hex }}
                />
              ))}
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-1.5 text-sm text-gray-600"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  await saveSnapshot(name, labelColor);
                  setOpen(false);
                }}
                className="rounded-md bg-[var(--theme-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--theme-accent-fg)]"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
