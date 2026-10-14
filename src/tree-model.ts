import {
	CanvasData,
	CanvasEdgeData,
	CanvasNodeData,
	CanvasMindMapState,
	CURRENT_STATE_VERSION,
	LayoutMode,
	NodeId,
	ParentRelation,
	TreePreferences,
	cloneJson,
	defaultCanvasState,
	isTreeNode,
} from "./types";

export interface AdoptionResult {
	state: CanvasMindMapState;
	managedEdgeIds: Set<string>;
}

export interface BranchDeletion {
	nodeIds: Set<NodeId>;
	edgeIds: Set<string>;
}

export interface DuplicateBranchResult {
	state: CanvasMindMapState;
	nodes: CanvasNodeData[];
	edges: CanvasEdgeData[];
	rootId: NodeId;
	oldToNew: Map<NodeId, NodeId>;
}

function nodeMap(data: CanvasData): Map<NodeId, CanvasNodeData> {
	return new Map(data.nodes.map((node) => [node.id, node]));
}

function edgeMap(data: CanvasData): Map<string, CanvasEdgeData> {
	return new Map(data.edges.map((edge) => [edge.id, edge]));
}

export function getNodeMap(data: CanvasData): Map<NodeId, CanvasNodeData> {
	return nodeMap(data);
}

export function getEdgeMap(data: CanvasData): Map<string, CanvasEdgeData> {
	return edgeMap(data);
}

export function relationChildren(
	state: CanvasMindMapState,
	parentId: NodeId,
): NodeId[] {
	return Object.entries(state.relations)
		.filter(([, relation]) => relation.parentId === parentId)
		.sort(([leftId, left], [rightId, right]) => {
			return left.order - right.order || leftId.localeCompare(rightId);
		})
		.map(([childId]) => childId);
}

export function parentOf(
	state: CanvasMindMapState,
	childId: NodeId,
): NodeId | undefined {
	return state.relations[childId]?.parentId;
}

export function rootOf(
	state: CanvasMindMapState,
	nodeId: NodeId,
): NodeId {
	let current = nodeId;
	const visited = new Set<NodeId>();
	while (state.relations[current] && !visited.has(current)) {
		visited.add(current);
		current = state.relations[current].parentId;
	}
	return current;
}

export function roots(
	data: CanvasData,
	state: CanvasMindMapState,
): NodeId[] {
	return data.nodes
		.filter((node) => isTreeNode(node) && !state.relations[node.id])
		.map((node) => node.id);
}

export function descendants(
	state: CanvasMindMapState,
	nodeId: NodeId,
	includeSelf = false,
): NodeId[] {
	const result: NodeId[] = includeSelf ? [nodeId] : [];
	const queue = relationChildren(state, nodeId);
	const visited = new Set(result);
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || visited.has(current)) continue;
		visited.add(current);
		result.push(current);
		queue.push(...relationChildren(state, current));
	}
	return result;
}

export function hiddenNodeIds(state: CanvasMindMapState): Set<NodeId> {
	const hidden = new Set<NodeId>();
	for (const nodeId of state.collapsedNodeIds) {
		for (const descendant of descendants(state, nodeId)) hidden.add(descendant);
	}
	return hidden;
}

export function hiddenDescendantCount(
	state: CanvasMindMapState,
	nodeId: NodeId,
): number {
	return descendants(state, nodeId).length;
}

export function managedEdgeIds(state: CanvasMindMapState): Set<string> {
	return new Set(Object.values(state.relations).map((relation) => relation.edgeId));
}

/**
 * Replace one managed connector in a Canvas snapshot.
 *
 * Canvas keeps live edge instances keyed by their IDs. Removing the old
 * managed edge before adding the replacement prevents a reparent operation
 * from leaving the old live connector behind when the endpoints change.
 * Unrelated edges, including cross-links, are retained.
 */
export function replaceManagedEdge(
	data: CanvasData,
	previousEdgeId: string | undefined,
	replacement: CanvasEdgeData,
): void {
	data.edges = data.edges.filter((edge) =>
		edge.id !== previousEdgeId && edge.id !== replacement.id,
	);
	data.edges.push(replacement);
}

export function crossLinkEdges(
	data: CanvasData,
	state: CanvasMindMapState,
): CanvasEdgeData[] {
	const managed = managedEdgeIds(state);
	return data.edges.filter((edge) => !managed.has(edge.id));
}

function createsCycle(
	state: CanvasMindMapState,
	childId: NodeId,
	parentId: NodeId,
	excludedChild?: NodeId,
): boolean {
	if (childId === parentId) return true;
	let current: NodeId | undefined = parentId;
	const visited = new Set<NodeId>();
	while (current && !visited.has(current)) {
		if (current === childId || current === excludedChild) return true;
		visited.add(current);
		current = state.relations[current]?.parentId;
	}
	return false;
}

export function canReparent(
	state: CanvasMindMapState,
	childId: NodeId,
	parentId: NodeId,
): boolean {
	return !createsCycle(state, childId, parentId, childId);
}

function nextOrder(state: CanvasMindMapState, parentId: NodeId): number {
	const siblings = relationChildren(state, parentId);
	return siblings.reduce((max, childId) => {
		return Math.max(max, state.relations[childId]?.order ?? -1);
	}, -1) + 1;
}

export function attachChild(
	state: CanvasMindMapState,
	childId: NodeId,
	parentId: NodeId,
	edgeId: string,
	order?: number,
): boolean {
	if (!canReparent(state, childId, parentId)) return false;
	const previous = state.relations[childId];
	if (previous && previous.parentId === parentId && previous.edgeId === edgeId) {
		return true;
	}
	state.relations[childId] = {
		parentId,
		edgeId,
		order: order ?? nextOrder(state, parentId),
	};
	return true;
}

export function detachChild(
	state: CanvasMindMapState,
	childId: NodeId,
): ParentRelation | undefined {
	const previous = state.relations[childId];
	delete state.relations[childId];
	return previous;
}

export function reorderSibling(
	state: CanvasMindMapState,
	childId: NodeId,
	direction: "before" | "after",
	): boolean {
	const relation = state.relations[childId];
	if (!relation) return false;
	const siblings = relationChildren(state, relation.parentId);
	const index = siblings.indexOf(childId);
	const swapWith = direction === "before" ? index - 1 : index + 1;
	if (index < 0 || swapWith < 0 || swapWith >= siblings.length) return false;
	const otherId = siblings[swapWith];
	const other = state.relations[otherId];
	if (!other) return false;
	const order = relation.order;
	relation.order = other.order;
	other.order = order;
	return true;
}

export function branchDeletion(
	data: CanvasData,
	state: CanvasMindMapState,
	nodeId: NodeId,
): BranchDeletion {
	const nodeIds = new Set(descendants(state, nodeId, true));
	const edgeIds = new Set<string>();
	for (const edge of data.edges) {
		if (nodeIds.has(edge.fromNode) || nodeIds.has(edge.toNode)) edgeIds.add(edge.id);
	}
	return { nodeIds, edgeIds };
}

export function deleteBranches(
	data: CanvasData,
	state: CanvasMindMapState,
	nodeIds: Iterable<NodeId>,
): BranchDeletion {
	const requested = new Set(nodeIds);
	const all = new Set<NodeId>();
	for (const nodeId of requested) {
		if (!all.has(nodeId)) {
			for (const descendant of descendants(state, nodeId, true)) all.add(descendant);
		}
	}
	const edgeIds = new Set<string>();
	for (const edge of data.edges) {
		if (all.has(edge.fromNode) || all.has(edge.toNode)) edgeIds.add(edge.id);
	}
	return { nodeIds: all, edgeIds };
}

export function applyBranchDeletion(
	data: CanvasData,
	state: CanvasMindMapState,
	deletion: BranchDeletion,
): void {
	data.nodes = data.nodes.filter((node) => !deletion.nodeIds.has(node.id));
	data.edges = data.edges.filter((edge) => !deletion.edgeIds.has(edge.id));
	for (const nodeId of deletion.nodeIds) {
		delete state.relations[nodeId];
		delete state.trees[nodeId];
		delete state.trees[rootOf(state, nodeId)];
	}
	state.collapsedNodeIds = state.collapsedNodeIds.filter(
		(nodeId) => !deletion.nodeIds.has(nodeId),
	);
	state.manualHeightNodeIds = state.manualHeightNodeIds.filter(
		(nodeId) => !deletion.nodeIds.has(nodeId),
	);
	for (const [childId, relation] of Object.entries(state.relations)) {
		if (deletion.nodeIds.has(relation.parentId) || deletion.nodeIds.has(childId)) {
			delete state.relations[childId];
		}
	}
}

function relationIsValid(
	childId: NodeId,
	relation: ParentRelation,
	nodes: Map<NodeId, CanvasNodeData>,
	edges: Map<string, CanvasEdgeData>,
	state: CanvasMindMapState,
): boolean {
	const child = nodes.get(childId);
	const parent = nodes.get(relation.parentId);
	const edge = edges.get(relation.edgeId);
	return (
		isTreeNode(child) &&
		isTreeNode(parent) &&
		!!edge &&
		edge.fromNode === relation.parentId &&
		edge.toNode === childId &&
		!createsCycle(state, childId, relation.parentId)
	);
}

export function sanitizeState(
	data: CanvasData,
	input: CanvasMindMapState,
	defaultLayout: LayoutMode = "balanced",
): CanvasMindMapState {
	const state = cloneJson(input);
	state.version = CURRENT_STATE_VERSION;
	state.defaultLayout = state.defaultLayout ?? defaultLayout;
	state.trees ??= {};
	state.relations ??= {};
	state.collapsedNodeIds ??= [];
	state.manualHeightNodeIds ??= [];
	const nodes = nodeMap(data);
	const edges = edgeMap(data);
	const clean: Record<NodeId, ParentRelation> = {};
	for (const [childId, relation] of Object.entries(state.relations)) {
		if (!relation || clean[childId]) continue;
		const candidate = { ...relation, order: Number(relation.order) || 0 };
		const candidateState = { ...state, relations: clean };
		if (relationIsValid(childId, candidate, nodes, edges, candidateState)) {
			clean[childId] = candidate;
		}
	}
	state.relations = clean;
	const existingIds = new Set(nodes.keys());
	state.collapsedNodeIds = [...new Set(state.collapsedNodeIds)].filter((id) =>
		existingIds.has(id),
	);
	state.manualHeightNodeIds = [...new Set(state.manualHeightNodeIds)].filter((id) =>
		existingIds.has(id),
	);
	const validRoots = new Set(roots(data, state));
	const trees: Record<NodeId, TreePreferences> = {};
	for (const rootId of validRoots) {
		const previous = state.trees[rootId];
		trees[rootId] = {
			layout: previous?.layout ?? state.defaultLayout ?? defaultLayout,
			branchSides: { ...(previous?.branchSides ?? {}) },
		};
	}
	state.trees = trees;
	const parentIds = new Set(Object.values(state.relations).map((relation) => relation.parentId));
	for (const parentId of parentIds) {
		const siblings = relationChildren(state, parentId);
		for (const [index, childId] of siblings.entries()) {
			state.relations[childId].order = index;
		}
	}
	return state;
}

export function adoptCanvasConnections(
	data: CanvasData,
	input: CanvasMindMapState = defaultCanvasState(),
	defaultLayout: LayoutMode = "balanced",
): AdoptionResult {
	const state = sanitizeState(data, input, defaultLayout);
	const nodes = nodeMap(data);
	const managed = managedEdgeIds(state);
	const candidatesByChild = new Map<NodeId, CanvasEdgeData[]>();
	for (const edge of data.edges) {
		if (managed.has(edge.id)) continue;
		const child = nodes.get(edge.toNode);
		const parent = nodes.get(edge.fromNode);
		if (!isTreeNode(child) || !isTreeNode(parent)) continue;
		const candidates = candidatesByChild.get(edge.toNode) ?? [];
		candidates.push(edge);
		candidatesByChild.set(edge.toNode, candidates);
	}
	for (const [childId, candidates] of candidatesByChild) {
		if (state.relations[childId] || candidates.length !== 1) continue;
		const edge = candidates[0];
		if (attachChild(state, childId, edge.fromNode, edge.id)) managed.add(edge.id);
	}
	const clean = sanitizeState(data, state, defaultLayout);
	return { state: clean, managedEdgeIds: managedEdgeIds(clean) };
}

export function ensureTreePreference(
	state: CanvasMindMapState,
	rootId: NodeId,
	layout: LayoutMode = state.defaultLayout,
): TreePreferences {
	return (state.trees[rootId] ??= { layout, branchSides: {} });
}

export function toggleCollapsed(
	state: CanvasMindMapState,
	nodeId: NodeId,
	collapsed?: boolean,
): boolean {
	const current = state.collapsedNodeIds.includes(nodeId);
	const next = collapsed ?? !current;
	state.collapsedNodeIds = state.collapsedNodeIds.filter((id) => id !== nodeId);
	if (next) state.collapsedNodeIds.push(nodeId);
	return next;
}

export function duplicateBranch(
	data: CanvasData,
	state: CanvasMindMapState,
	rootId: NodeId,
	makeId: (kind: "node" | "edge", oldId: string) => string,
	offset = { x: 40, y: 40 },
): DuplicateBranchResult {
	const branch = new Set(descendants(state, rootId, true));
	const oldToNew = new Map<NodeId, NodeId>();
	for (const nodeId of branch) oldToNew.set(nodeId, makeId("node", nodeId));
	const nodes = data.nodes
		.filter((node) => branch.has(node.id))
		.map((node) => ({
			...cloneJson(node),
			id: oldToNew.get(node.id)!,
			x: node.x + offset.x,
			y: node.y + offset.y,
		}));
	const edgeIds = new Map<string, string>();
	const managed = managedEdgeIds(state);
	const edges = data.edges
		.filter((edge) => managed.has(edge.id) && branch.has(edge.fromNode) && branch.has(edge.toNode))
		.map((edge) => {
			const id = makeId("edge", edge.id);
			edgeIds.set(edge.id, id);
			return {
				...cloneJson(edge),
				id,
				fromNode: oldToNew.get(edge.fromNode)!,
				toNode: oldToNew.get(edge.toNode)!,
			};
		});
	const nextState = cloneJson(state);
	for (const oldNodeId of branch) delete nextState.relations[oldNodeId];
	for (const oldNodeId of branch) {
		const relation = state.relations[oldNodeId];
		const newId = oldToNew.get(oldNodeId)!;
		if (!relation || !oldToNew.has(relation.parentId)) continue;
		nextState.relations[newId] = {
			parentId: oldToNew.get(relation.parentId)!,
			edgeId: edgeIds.get(relation.edgeId) ?? makeId("edge", relation.edgeId),
			order: relation.order,
		};
	}
	const sourceRoot = rootOf(state, rootId);
	const newRoot = oldToNew.get(rootId)!;
	const sourcePreference = state.trees[sourceRoot];
	if (sourcePreference) {
		nextState.trees[newRoot] = {
			layout: sourcePreference.layout,
			branchSides: Object.fromEntries(
				Object.entries(sourcePreference.branchSides)
					.filter(([oldChildId]) => oldToNew.has(oldChildId))
					.map(([oldChildId, side]) => [oldToNew.get(oldChildId)!, side]),
			),
		};
	}
	nextState.collapsedNodeIds = state.collapsedNodeIds
		.filter((id) => branch.has(id))
		.map((id) => oldToNew.get(id)!)
		.filter(Boolean);
	nextState.manualHeightNodeIds = state.manualHeightNodeIds
		.filter((id) => branch.has(id))
		.map((id) => oldToNew.get(id)!)
		.filter(Boolean);
	return { state: nextState, nodes, edges, rootId: newRoot, oldToNew };
}
