import { useState } from "react";
import type { SnapshotTreeNode } from "../../lib/snapshotTree";
import { useGame } from "../../state/GameContext";
import { LABEL_COLORS } from "../../lib/colors";
import { SnapshotPencilButton } from "./SnapshotPencilButton";

interface SnapshotNodeProps {
  node: SnapshotTreeNode;
  currentSnapshotId: string | null;
  depth: number;
}

const INDENT = 20;
const CIRCLE_CENTER = 7; // half of the h-3.5/w-3.5 (14px) label circle

export function SnapshotNode({ node, currentSnapshotId, depth }: SnapshotNodeProps) {
  const { revertToSnapshot, deleteSnapshot, setSnapshotLabelColor } = useGame();
  const [pickerOpen, setPickerOpen] = useState(false);
  const isCurrent = node.id === currentSnapshotId;

  return (
    <div>
      <div
        className="relative flex min-w-0 items-center gap-2 py-1"
        style={{ paddingLeft: `${depth * INDENT}px` }}
      >
        {depth > 0 && (
          <span
            aria-hidden="true"
            className="absolute h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-gray-400"
            style={{ left: `${(depth - 1) * INDENT + CIRCLE_CENTER - 3}px`, top: "50%" }}
          />
        )}

        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="h-3.5 w-3.5 shrink-0 rounded-full border border-gray-300"
          style={{ backgroundColor: node.labelColor ?? "#ffffff" }}
          title="Set label color"
        />

        <span
          className={`min-w-0 flex-1 truncate text-sm ${isCurrent ? "font-semibold text-blue-700" : "text-gray-800"}`}
        >
          {node.name}
          {isCurrent && <span className="ml-1 text-xs font-normal text-blue-500">(current)</span>}
        </span>

        <SnapshotPencilButton snapshotId={node.id} snapshotName={node.name} />
        <button
          type="button"
          onClick={() => revertToSnapshot(node.id)}
          title="Revert to this snapshot"
          aria-label="Revert to this snapshot"
          className="shrink-0 rounded border border-gray-300 px-1.5 py-0.5 text-sm leading-none text-gray-700 hover:bg-gray-50"
        >
          ↺
        </button>
        <button
          type="button"
          onClick={() => {
            if (confirm(`Delete "${node.name}"? This also deletes all of its child snapshots.`)) {
              deleteSnapshot(node.id);
            }
          }}
          title="Delete this snapshot"
          aria-label="Delete this snapshot"
          className="shrink-0 rounded border border-red-300 px-1.5 py-0.5 text-sm leading-none text-red-600 hover:bg-red-50"
        >
          🗑
        </button>
      </div>

      {pickerOpen && (
        <div
          className="mb-1 flex flex-wrap gap-1.5"
          style={{ paddingLeft: `${depth * INDENT + 22}px` }}
        >
          <button
            type="button"
            onClick={() => {
              setSnapshotLabelColor(node.id, null);
              setPickerOpen(false);
            }}
            className="h-5 w-5 rounded-full border-2 border-gray-300 bg-white"
            title="No label"
          />
          {LABEL_COLORS.map((c) => (
            <button
              key={c.hex}
              type="button"
              title={c.name}
              onClick={() => {
                setSnapshotLabelColor(node.id, c.hex);
                setPickerOpen(false);
              }}
              className="h-5 w-5 rounded-full border border-gray-300"
              style={{ backgroundColor: c.hex }}
            />
          ))}
        </div>
      )}

      {node.children.length > 0 && (
        <div className="relative">
          <div
            aria-hidden="true"
            className="absolute bottom-0 top-0 border-l-2 border-gray-300"
            style={{ left: `${depth * INDENT + CIRCLE_CENTER}px` }}
          />
          {node.children.map((child) => (
            <SnapshotNode
              key={child.id}
              node={child}
              currentSnapshotId={currentSnapshotId}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
