import { useMemo } from "react";
import { useGame } from "../../state/GameContext";
import { buildSnapshotForest } from "../../lib/snapshotTree";
import { SnapshotNode } from "./SnapshotNode";

export function SnapshotTree() {
  const { snapshots, currentSnapshotId } = useGame();
  const forest = useMemo(() => buildSnapshotForest(snapshots), [snapshots]);

  if (forest.length === 0) {
    return <p className="text-sm text-gray-500">No snapshots saved yet.</p>;
  }

  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      {forest.map((root) => (
        <SnapshotNode key={root.id} node={root} currentSnapshotId={currentSnapshotId} depth={0} />
      ))}
    </div>
  );
}
