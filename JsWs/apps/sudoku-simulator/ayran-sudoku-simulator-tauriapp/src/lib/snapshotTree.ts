import type { SnapshotRecord } from "./db";

export interface SnapshotTreeNode extends SnapshotRecord {
  children: SnapshotTreeNode[];
}

/** Builds a forest of trees from a flat snapshot list, sorted oldest-first at every level. */
export function buildSnapshotForest(snapshots: SnapshotRecord[]): SnapshotTreeNode[] {
  const nodes = new Map<string, SnapshotTreeNode>();
  for (const snapshot of snapshots) {
    nodes.set(snapshot.id, { ...snapshot, children: [] });
  }

  const roots: SnapshotTreeNode[] = [];
  for (const node of nodes.values()) {
    if (node.parentId && nodes.has(node.parentId)) {
      nodes.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const byCreatedAt = (a: SnapshotTreeNode, b: SnapshotTreeNode) => a.createdAt - b.createdAt;
  const sortRecursive = (list: SnapshotTreeNode[]) => {
    list.sort(byCreatedAt);
    for (const node of list) sortRecursive(node.children);
  };
  sortRecursive(roots);

  return roots;
}

/** Returns the id set of `rootId` plus every descendant, walking the flat list. */
export function getDescendantIds(snapshots: SnapshotRecord[], rootId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const snapshot of snapshots) {
    if (!snapshot.parentId) continue;
    const list = childrenByParent.get(snapshot.parentId) ?? [];
    list.push(snapshot.id);
    childrenByParent.set(snapshot.parentId, list);
  }

  const result = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const childId of childrenByParent.get(current) ?? []) {
      if (!result.has(childId)) {
        result.add(childId);
        queue.push(childId);
      }
    }
  }
  return result;
}

/** Returns the chain from `id` up to its root ancestor (inclusive of `id`), nearest-first. */
export function getAncestorChain(snapshots: SnapshotRecord[], id: string): SnapshotRecord[] {
  const byId = new Map(snapshots.map((s) => [s.id, s]));
  const chain: SnapshotRecord[] = [];
  let current = byId.get(id);
  while (current) {
    chain.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return chain;
}
