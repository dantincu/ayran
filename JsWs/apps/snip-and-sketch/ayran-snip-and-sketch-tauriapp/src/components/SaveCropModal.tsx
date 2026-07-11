import { useState } from "react";
import { Modal } from "./Modal";
import type { Rect } from "../lib/types";
import { formatRectName } from "../lib/geometry";

export function SaveCropModal({
  rect,
  onSave,
  onClose,
}: {
  rect: Rect;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(formatRectName(rect));

  return (
    <Modal title="Save Crop Coordinates" onClose={onClose}>
      <label className="mb-1 block text-sm text-neutral-600 dark:text-neutral-300">
        Name
      </label>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="mb-4 w-full rounded border border-neutral-300 bg-white px-3 py-2 text-neutral-900 focus:border-accent-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
      />
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700"
        >
          Cancel
        </button>
        <button
          onClick={() => onSave(name.trim() || formatRectName(rect))}
          className="rounded bg-accent-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-600"
        >
          Save
        </button>
      </div>
    </Modal>
  );
}
