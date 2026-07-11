import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import type { SavedCrop } from "../lib/types";
import { listSavedCrops, deleteSavedCrop } from "../lib/db";

export function LoadCropModal({
  onApply,
  onClose,
}: {
  onApply: (crop: SavedCrop) => void;
  onClose: () => void;
}) {
  const [crops, setCrops] = useState<SavedCrop[] | null>(null);

  useEffect(() => {
    listSavedCrops().then(setCrops);
  }, []);

  async function handleDelete(id: string) {
    await deleteSavedCrop(id);
    setCrops((prev) => prev?.filter((c) => c.id !== id) ?? null);
  }

  return (
    <Modal title="Saved Crop Coordinates" onClose={onClose}>
      {crops === null && (
        <p className="text-sm text-neutral-500">Loading…</p>
      )}
      {crops?.length === 0 && (
        <p className="text-sm text-neutral-500">
          No saved crops yet. Apply a crop and choose "Save Crop Coordinates" to create one.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {crops?.map((crop) => (
          <li
            key={crop.id}
            className="flex items-center justify-between gap-2 rounded border border-neutral-200 px-3 py-2 dark:border-neutral-700"
          >
            <button
              onClick={() => onApply(crop)}
              className="min-w-0 flex-1 text-left"
            >
              <div className="truncate font-medium text-neutral-900 dark:text-neutral-100">
                {crop.name}
              </div>
              <div className="text-xs text-neutral-500">
                {Math.round(crop.rect.w)}×{Math.round(crop.rect.h)} on{" "}
                {crop.sourceWidth}×{crop.sourceHeight}
              </div>
            </button>
            <button
              onClick={() => handleDelete(crop.id)}
              className="shrink-0 rounded p-1.5 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
              aria-label={`Delete ${crop.name}`}
            >
              🗑
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
