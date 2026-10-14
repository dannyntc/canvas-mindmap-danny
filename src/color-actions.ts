import { CanvasData, CanvasMindMapState, EdgeId, NodeId } from "./types";
import { descendants } from "./tree-model";

export interface CanvasColorTargets {
	nodeIds?: ReadonlySet<NodeId> | readonly NodeId[];
	edgeIds?: ReadonlySet<EdgeId> | readonly EdgeId[];
}

function asSet(values: ReadonlySet<string> | readonly string[] | undefined): ReadonlySet<string> {
	if (!values) return new Set();
	return values instanceof Set ? values : new Set(values);
}

/** Resolve a branch to its cards and managed tree connectors only. */
export function branchColorTargets(
	state: CanvasMindMapState,
	data: CanvasData,
	rootId: NodeId,
): { nodeIds: Set<NodeId>; edgeIds: Set<EdgeId> } {
	const dataNodeIds = new Set(data.nodes.map((node) => node.id));
	const nodeIds = new Set(
		descendants(state, rootId, true).filter((nodeId) => dataNodeIds.has(nodeId)),
	);
	const dataEdgeIds = new Set(data.edges.map((edge) => edge.id));
	const edgeIds = new Set<EdgeId>();
	for (const [childId, relation] of Object.entries(state.relations)) {
		if (nodeIds.has(childId) && dataEdgeIds.has(relation.edgeId)) edgeIds.add(relation.edgeId);
	}
	return { nodeIds, edgeIds };
}

/** Apply or clear Canvas colour fields on an already-cloned Canvas snapshot. */
export function applyCanvasColors(
	data: CanvasData,
	targets: CanvasColorTargets & { color?: string },
): boolean {
	const nodeIds = asSet(targets.nodeIds);
	const edgeIds = asSet(targets.edgeIds);
	const color = targets.color?.trim() || undefined;
	let changed = false;

	for (const node of data.nodes) {
		if (!nodeIds.has(node.id)) continue;
		if (color) {
			if (node.color === color) continue;
			node.color = color;
			changed = true;
		} else if (node.color !== undefined) {
			delete node.color;
			changed = true;
		}
	}

	for (const edge of data.edges) {
		if (!edgeIds.has(edge.id)) continue;
		if (color) {
			if (edge.color === color) continue;
			edge.color = color;
			changed = true;
		} else if (edge.color !== undefined) {
			delete edge.color;
			changed = true;
		}
	}

	return changed;
}
