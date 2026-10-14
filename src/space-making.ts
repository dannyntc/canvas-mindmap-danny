import { NodeId, Point } from "./types";

export interface SpaceMakingNode {
	id: NodeId;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface SpaceMakingGroup {
	id: NodeId;
	memberIds: NodeId[];
}

export interface SpaceMakingOptions {
	clearance?: number;
	maxIterations?: number;
	protectedGroupIds?: ReadonlySet<NodeId>;
}

export interface SpaceMakingResult {
	positions: Record<NodeId, Point>;
	groupOffsets: Record<NodeId, Point>;
	iterations: number;
}

interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

interface Offset {
	x: number;
	y: number;
}

interface QueueItem {
	kind: "moving" | "group";
	id: NodeId;
}

const DEFAULT_SPACE_MAKING_CLEARANCE = 48;

function rect(node: SpaceMakingNode, position: Point): Rect {
	return {
		left: position.x,
		top: position.y,
		right: position.x + Math.max(1, node.width),
		bottom: position.y + Math.max(1, node.height),
	};
}

function overlap(first: Rect, second: Rect): { x: number; y: number } | undefined {
	const x = Math.min(first.right, second.right) - Math.max(first.left, second.left);
	const y = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
	return x > 0 && y > 0 ? { x, y } : undefined;
}

function separation(
	source: Rect,
	target: Rect,
	clearance: number,
): Offset | undefined {
	const penetration = overlap(source, target);
	if (!penetration) return undefined;
	const sourceCenterX = (source.left + source.right) / 2;
	const sourceCenterY = (source.top + source.bottom) / 2;
	const targetCenterX = (target.left + target.right) / 2;
	const targetCenterY = (target.top + target.bottom) / 2;
	const horizontal = targetCenterX >= sourceCenterX
		? { x: source.right + clearance - target.left, y: 0 }
		: { x: source.left - clearance - target.right, y: 0 };
	const vertical = targetCenterY >= sourceCenterY
		? { x: 0, y: source.bottom + clearance - target.top }
		: { x: 0, y: source.top - clearance - target.bottom };
	return Math.abs(horizontal.x) <= Math.abs(vertical.y) ? horizontal : vertical;
}

function addOffset(current: Offset, change: Offset): Offset {
	return { x: current.x + change.x, y: current.y + change.y };
}

function offsetIsZero(offset: Offset | undefined): boolean {
	return !offset || (Math.abs(offset.x) < 0.01 && Math.abs(offset.y) < 0.01);
}

function cellRange(rectangle: Rect, cellSize: number): string[] {
	const minX = Math.floor(rectangle.left / cellSize);
	const maxX = Math.floor((rectangle.right - 0.000001) / cellSize);
	const minY = Math.floor(rectangle.top / cellSize);
	const maxY = Math.floor((rectangle.bottom - 0.000001) / cellSize);
	const cells: string[] = [];
	for (let x = minX; x <= maxX; x += 1) {
		for (let y = minY; y <= maxY; y += 1) cells.push(`${x}:${y}`);
	}
	return cells;
}

function groupRoot(
	nodeId: NodeId,
	parentById: Readonly<Record<NodeId, NodeId | undefined>>,
	movingAncestors: ReadonlySet<NodeId>,
	movingIds: ReadonlySet<NodeId>,
): NodeId {
	let current = nodeId;
	const visited = new Set<NodeId>();
	while (!visited.has(current)) {
		visited.add(current);
		const parentId = parentById[current];
		if (!parentId || movingIds.has(parentId)) return current;
		if (movingAncestors.has(parentId)) return parentId;
		current = parentId;
	}
	return current;
}

/**
 * Build movable branch groups while keeping the user-controlled branch out of
 * every obstacle group. A side branch is moved as one unit so its connectors
 * and descendants retain their relative geometry during a drag.
 */
export function buildSpaceMakingGroups(
	nodeIds: readonly NodeId[],
	movingIds: ReadonlySet<NodeId>,
	parentById: Readonly<Record<NodeId, NodeId | undefined>>,
): SpaceMakingGroup[] {
	const movingAncestors = new Set<NodeId>();
	for (const movingId of movingIds) {
		let current = parentById[movingId];
		const visited = new Set<NodeId>();
		while (current && !visited.has(current)) {
			visited.add(current);
			movingAncestors.add(current);
			current = parentById[current];
		}
	}
	const members = new Map<NodeId, NodeId[]>();
	for (const nodeId of nodeIds) {
		if (movingIds.has(nodeId)) continue;
		const rootId = groupRoot(nodeId, parentById, movingAncestors, movingIds);
		const group = members.get(rootId) ?? [];
		group.push(nodeId);
		members.set(rootId, group);
	}
	return [...members.entries()]
		.sort(([first], [second]) => first.localeCompare(second))
		.map(([id, memberIds]) => ({ id, memberIds: memberIds.sort((a, b) => a.localeCompare(b)) }));
}

/**
 * Resolve local space making from the original geometry on every call. The
 * moving nodes are supplied at their live positions; obstacle groups start at
 * their original positions and are pushed only as far as necessary. Returning
 * original positions for untouched groups makes the preview reversible.
 */
export function resolveSpaceMaking(
	nodes: readonly SpaceMakingNode[],
	movingIds: ReadonlySet<NodeId>,
	movingPositions: Readonly<Record<NodeId, Point>>,
	groups: readonly SpaceMakingGroup[],
	options: SpaceMakingOptions = {},
): SpaceMakingResult {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const groupById = new Map(groups.map((group) => [group.id, group]));
	const groupOffsets = new Map<NodeId, Offset>();
	for (const group of groups) groupOffsets.set(group.id, { x: 0, y: 0 });
	const protectedGroups = options.protectedGroupIds ?? new Set<NodeId>();
	const clearance = Math.max(0, options.clearance ?? DEFAULT_SPACE_MAKING_CLEARANCE);
	const maxIterations = Math.max(1, options.maxIterations ?? Math.max(100, groups.length * 16));
	const cellSize = 256;
	const spatialIndex = new Map<string, Set<NodeId>>();
	const indexedCells = new Map<NodeId, string[]>();
	const queue: QueueItem[] = [...[...movingIds]
		.filter((id) => byId.has(id))
		.sort((a, b) => a.localeCompare(b))
		.map((id) => ({ kind: "moving" as const, id }))];
	let queueIndex = 0;
	let iterations = 0;

	const positionsForGroup = (group: SpaceMakingGroup): Array<{ node: SpaceMakingNode; position: Point }> => {
		const offset = groupOffsets.get(group.id) ?? { x: 0, y: 0 };
		return group.memberIds
			.map((id) => {
				const node = byId.get(id);
				return node ? { node, position: { x: node.x + offset.x, y: node.y + offset.y } } : undefined;
			})
			.filter((item): item is { node: SpaceMakingNode; position: Point } => !!item);
	};

	const positionsForSource = (source: QueueItem): Array<{ node: SpaceMakingNode; position: Point }> => {
		if (source.kind === "moving") {
			const node = byId.get(source.id);
			if (!node) return [];
			return [{ node, position: movingPositions[source.id] ?? { x: node.x, y: node.y } }];
		}
		const group = groupById.get(source.id);
		return group ? positionsForGroup(group) : [];
	};

	const indexGroup = (groupId: NodeId): void => {
		for (const cell of indexedCells.get(groupId) ?? []) {
			const groupIds = spatialIndex.get(cell);
			groupIds?.delete(groupId);
			if (groupIds?.size === 0) spatialIndex.delete(cell);
		}
		const cells = new Set<string>();
		const group = groupById.get(groupId);
		if (!group) return;
		for (const item of positionsForGroup(group)) {
			for (const cell of cellRange(rect(item.node, item.position), cellSize)) cells.add(cell);
		}
		indexedCells.set(groupId, [...cells]);
		for (const cell of cells) {
			const groupIds = spatialIndex.get(cell) ?? new Set<NodeId>();
			groupIds.add(groupId);
			spatialIndex.set(cell, groupIds);
		}
	};
	for (const group of groups) indexGroup(group.id);

	const candidateGroups = (sourceRects: readonly Rect[]): SpaceMakingGroup[] => {
		const groupIds = new Set<NodeId>();
		for (const sourceRect of sourceRects) {
			for (const cell of cellRange(sourceRect, cellSize)) {
				for (const groupId of spatialIndex.get(cell) ?? []) groupIds.add(groupId);
			}
		}
		return [...groupIds]
			.sort((first, second) => first.localeCompare(second))
			.map((groupId) => groupById.get(groupId))
			.filter((group): group is SpaceMakingGroup => !!group);
	};

	while (queueIndex < queue.length && iterations < maxIterations) {
		const source = queue[queueIndex++];
		const sourceRects = positionsForSource(source).map(({ node, position }) => rect(node, position));
		if (sourceRects.length === 0) continue;
		for (const target of candidateGroups(sourceRects)) {
			if (target.id === source.id || protectedGroups.has(target.id)) continue;
			const targetOffset = groupOffsets.get(target.id) ?? { x: 0, y: 0 };
			if (source.kind === "group" && !offsetIsZero(targetOffset)) continue;
			const targetItems = positionsForGroup(target);
			let shift: Offset | undefined;
			for (const sourceRect of sourceRects) {
				for (const targetItem of targetItems) {
					const candidate = separation(sourceRect, rect(targetItem.node, targetItem.position), clearance);
					if (!candidate) continue;
					if (!shift || Math.abs(candidate.x) + Math.abs(candidate.y) > Math.abs(shift.x) + Math.abs(shift.y)) {
						shift = candidate;
					}
				}
			}
			if (!shift) continue;
			groupOffsets.set(target.id, addOffset(targetOffset, shift));
			indexGroup(target.id);
			queue.push({ kind: "group", id: target.id });
			iterations += 1;
			if (iterations >= maxIterations) break;
		}
	}

	const positions: Record<NodeId, Point> = {};
	for (const group of groups) {
		const offset = groupOffsets.get(group.id) ?? { x: 0, y: 0 };
		for (const memberId of group.memberIds) {
			const node = byId.get(memberId);
			if (node) positions[memberId] = { x: node.x + offset.x, y: node.y + offset.y };
		}
	}
	const serializedOffsets: Record<NodeId, Point> = {};
	for (const [groupId, offset] of groupOffsets) serializedOffsets[groupId] = { ...offset };
	return { positions, groupOffsets: serializedOffsets, iterations };
}
