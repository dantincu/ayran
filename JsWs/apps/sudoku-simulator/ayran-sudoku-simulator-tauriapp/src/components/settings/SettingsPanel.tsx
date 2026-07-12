import { useState } from "react";
import { clearAllData } from "../../lib/db";

const CONFIRM_WORD = "RESET";

export function SettingsPanel() {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);

  const close = () => {
    setOpen(false);
    setConfirmText("");
  };

  const handleClear = async () => {
    setBusy(true);
    await clearAllData();
    window.location.reload();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border border-red-200 bg-white p-3">
        <h2 className="mb-1 text-sm font-semibold text-red-700">Danger zone</h2>
        <p className="mb-3 text-xs text-gray-500">
          Permanently deletes every saved snapshot, custom color, theme, and preference, and
          resets the board to a blank slate. This cannot be undone.
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-semibold text-red-600 hover:bg-red-50"
        >
          Clear app data
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl">
            <h2 className="mb-2 text-base font-semibold text-red-700">Clear app data</h2>
            <p className="mb-3 text-sm text-gray-600">
              This permanently deletes all snapshots, custom colors, themes, and preferences, and
              cannot be undone. Type <span className="font-mono font-semibold">{CONFIRM_WORD}</span>{" "}
              to confirm.
            </p>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={CONFIRM_WORD}
              className="mb-4 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={close}
                disabled={busy}
                className="rounded-md px-3 py-1.5 text-sm text-gray-600 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={confirmText !== CONFIRM_WORD || busy}
                onClick={handleClear}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "Clearing…" : "Clear data"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
