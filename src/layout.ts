import {
	Bounds,
	CanvasData,
	CanvasNodeData,
	CanvasMindMapState,
	EdgeSides,
	LayoutMode,
	LayoutResult,
	NodeId,
	Point,
} from "./types";
import {
	getNodeMap,
	hiddenNodeIds,
	relationChildren,
	rootOf,
	roots,
	ensureTreePreference,
} from "./tree-model";

export interface LayoutOptions {
	horizontalGap?: number;
	verticalGap?: number;
	defaultLayout?: LayoutMode;
	rootIds?: NodeId[];
}

interface Size {
	width: number;
	height: number;
}

interface LayoutContext {
	data: CanvasData;
	state: CanvasMindMapState;
	nodes: Map<NodeId, CanvasNodeData>;
	hidden: Set<NodeId>;
	horizontalGap: number;
	verticalGap: number;
	positions: Record<NodeId, Point>;
	bounds: Record<NodeId, Bounds>;
	visible: Set<NodeId>;
}

function rectangle(x: number, y: number, width: number, height: number): Bounds {
	return { minX: x, minY: y, maxX: x + width, maxY: y + height, width, height };
}

function unionBounds(items: Bounds[]): Bounds {
	if (items.length === 0) return rectangle(0, 0, 0, 0);
	const minX = Math.min(...items.map((item) => item.minX));
	const minY = Math.min(...items.map((item) => item.minY));
	const maxX = Math.max(...items.map((item) => item.maxX));
	const maxY = Math.max(...items.map((item) => item.maxY));
	return rectangle(minX, minY, maxX - minX, maxY - minY);
}

function nodeSize(node: CanvasNodeData): Size {
	return { width: Math.max(1, node.width), height: Math.max(1, node.height) };
}

function visibleChildren(ctx: LayoutContext, nodeId: NodeId): NodeId[] {
	if (ctx.hidden.has(nodeId)) return [];
	return relationChildren(ctx.state, nodeId).filter((childId) => !ctx.hidden.has(childId));
}

function measureHorizontal(ctx: LayoutContext, nodeId: NodeId): Size {
	const node = ctx.nodes.get(nodeId);
	if (!node) return { width: 0, height: 0 };
	const size = nodeSize(node);
	const children = visibleChildren(ctx, nodeId);
	if (children.length === 0) return size;
	const childSizes = children.map((childId) => measureHorizontal(ctx, childId));
	const childHeight = childSizes.reduce((sum, child) => sum + child.height, 0) +
		ctx.verticalGap * Math.max(0, childSizes.length - 1);
	return {
		width: size.width + ctx.horizontalGap + Math.max(...childSizes.map((child) => child.width)),
		height: Math.max(size.height, childHeight),
	};
}

function measureVertical(ctx: LayoutContext, nodeId: NodeId): Size {
	const node = ctx.nodes.get(nodeId);
	if (!node) return { width: 0, height: 0 };
	const size = nodeSize(node);
	const children = visibleChildren(ctx, nodeId);
	if (children.length === 0) return size;
	const childSizes = children.map((childId) => measureVertical(ctx, childId));
	const childWidth = childSizes.reduce((sum, child) => sum + child.width, 0) +
		ctx.horizontalGap * Math.max(0, childSizes.length - 1);
	return {
		width: Math.max(size.width, childWidth),
		height: size.height + ctx.verticalGap + Math.max(...childSizes.map((child) => child.height)),
	};
}

function placeHorizontal(
	ctx: LayoutContext,
	nodeId: NodeId,
	x: number,
	centerY: number,
	direction: 1 | -1,
): Bounds {
	const node = ctx.nodes.get(nodeId);
	if (!node) return rectangle(x, centerY, 0, 0);
	const size = nodeSize(node);
	const y = centerY - size.height / 2;
	ctx.positions[nodeId] = { x, y };
	ctx.visible.add(nodeId);
	const selfBounds = rectangle(x, y, size.width, size.height);
	const children = visibleChildren(ctx, nodeId);
	if (children.length === 0) {
		ctx.bounds[nodeId] = selfBounds;
		return selfBounds;
	}
	const childSizes = children.map((childId) => measureHorizontal(ctx, childId));
	const totalHeight = childSizes.reduce((sum, child) => sum + child.height, 0) +
		ctx.verticalGap * Math.max(0, children.length - 1);
	let cursor = centerY - totalHeight / 2;
	const childBounds: Bounds[] = [selfBounds];
	for (let index = 0; index < children.length; index += 1) {
		const childId = children[index];
		const childSize = childSizes[index];
		const childX = direction === 1
			? x + size.width + ctx.horizontalGap
			: x - ctx.horizontalGap - childSize.width;
		const childCenterY = cursor + childSize.height / 2;
		childBounds.push(placeHorizontal(ctx, childId, childX, childCenterY, direction));
		cursor += childSize.height + ctx.verticalGap;
	}
	const result = unionBounds(childBounds);
	ctx.bounds[nodeId] = result;
	return result;
}

function placeVertical(
	ctx: LayoutContext,
	nodeId: NodeId,
	centerX: number,
	y: number,
	direction: 1 | -1,
): Bounds {
	const node = ctx.nodes.get(nodeId);
	if (!node) return rectangle(centerX, y, 0, 0);
	const size = nodeSize(node);
	const x = centerX - size.width / 2;
	ctx.positions[nodeId] = { x, y };
	ctx.visible.add(nodeId);
	const selfBounds = rectangle(x, y, size.width, size.height);
	const children = visibleChildren(ctx, nodeId);
	if (children.length === 0) {
		ctx.bounds[nodeId] = selfBounds;
		return selfBounds;
	}
	const childSizes = children.map((childId) => measureVertical(ctx, childId));
	const totalWidth = childSizes.reduce((sum, child) => sum + child.width, 0) +
		ctx.horizontalGap * Math.max(0, children.length - 1);
	let cursor = centerX - totalWidth / 2;
	const childBounds: Bounds[] = [selfBounds];
	for (let index = 0; index < children.length; index += 1) {
		const childId = children[index];
		const childSize = childSizes[index];
		const childY = direction === 1
			? y + size.height + ctx.verticalGap
			: y - ctx.verticalGap - childSize.height;
		const childCenterX = cursor + childSize.width / 2;
		childBounds.push(placeVertical(ctx, childId, childCenterX, childY, direction));
		cursor += childSize.width + ctx.horizontalGap;
	}
	const result = unionBounds(childBounds);
	ctx.bounds[nodeId] = result;
	return result;
}

function balancedSides(
	ctx: LayoutContext,
	rootId: NodeId,
): Map<NodeId, "left" | "right"> {
	const preference = ctx.state.trees[rootId] ?? { layout: "balanced" as const, branchSides: {} };
	const result = new Map<NodeId, "left" | "right">();
	let leftHeight = 0;
	let rightHeight = 0;
	for (const childId of relationChildren(ctx.state, rootId)) {
		const explicit = preference.branchSides[childId];
		const side = explicit ?? (leftHeight < rightHeight ? "left" : "right");
		result.set(childId, side);
		const height = measureHorizontal(ctx, childId).height;
		if (side === "left") leftHeight += height + (leftHeight > 0 ? ctx.verticalGap : 0);
		else rightHeight += height + (rightHeight > 0 ? ctx.verticalGap : 0);
	}
	return result;
}

function placeBalanced(ctx: LayoutContext, rootId: NodeId): Bounds {
	const root = ctx.nodes.get(rootId);
	if (!root) return rectangle(0, 0, 0, 0);
	const rootSize = nodeSize(root);
	const rootCenterX = root.x + rootSize.width / 2;
	const rootCenterY = root.y + rootSize.height / 2;
	ctx.positions[rootId] = { x: root.x, y: root.y };
	ctx.visible.add(rootId);
	const rootBounds = rectangle(root.x, root.y, rootSize.width, rootSize.height);
	const groups = new Map<"left" | "right", NodeId[]>();
	groups.set("left", []);
	groups.set("right", []);
	for (const [childId, side] of balancedSides(ctx, rootId)) groups.get(side)!.push(childId);
	const branchBounds: Bounds[] = [rootBounds];
	for (const side of ["left", "right"] as const) {
		const children = groups.get(side)!;
		const sizes = children.map((childId) => measureHorizontal(ctx, childId));
		const totalHeight = sizes.reduce((sum, size) => sum + size.height, 0) +
			ctx.verticalGap * Math.max(0, sizes.length - 1);
		let cursor = rootCenterY - totalHeight / 2;
		for (let index = 0; index < children.length; index += 1) {
			const childId = children[index];
			const size = sizes[index];
			const childX = side === "right"
				? root.x + rootSize.width + ctx.horizontalGap
				: root.x - ctx.horizontalGap - size.width;
			const childCenterY = cursor + size.height / 2;
			branchBounds.push(
				placeHorizontal(ctx, childId, childX, childCenterY, side === "right" ? 1 : -1),
			);
			cursor += size.height + ctx.verticalGap;
		}
	}
	const result = unionBounds(branchBounds);
	ctx.bounds[rootId] = result;
	return result;
}

function positionForNode(node: CanvasNodeData): Point {
	return { x: node.x, y: node.y };
}

function edgeSidesFor(
	data: CanvasData,
	state: CanvasMindMapState,
	positions: Record<NodeId, Point>,
	nodes: Map<NodeId, CanvasNodeData>,
): Record<string, EdgeSides> {
	const sides: Record<string, EdgeSides> = {};
	for (const edge of data.edges) {
		const from = nodes.get(edge.fromNode);
		const to = nodes.get(edge.toNode);
		if (!from || !to) continue;
		const fromPosition = positions[edge.fromNode] ?? positionForNode(from);
		const toPosition = positions[edge.toNode] ?? positionForNode(to);
		const dx = toPosition.x + to.width / 2 - (fromPosition.x + from.width / 2);
		const dy = toPosition.y + to.height / 2 - (fromPosition.y + from.height / 2);
		if (Math.abs(dx) >= Math.abs(dy)) {
			sides[edge.id] = {
				fromSide: dx >= 0 ? "right" : "left",
				toSide: dx >= 0 ? "left" : "right",
			};
		} else {
			sides[edge.id] = {
				fromSide: dy >= 0 ? "bottom" : "top",
				toSide: dy >= 0 ? "top" : "bottom",
			};
		}
	}
	return sides;
}

export function assignMissingBalancedSides(
	data: CanvasData,
	state: CanvasMindMapState,
	rootId: NodeId,
	verticalGap = 50,
): Record<NodeId, "left" | "right"> {
	const ctx: LayoutContext = {
		data,
		state,
		nodes: getNodeMap(data),
		hidden: hiddenNodeIds(state),
		horizontalGap: 200,
		verticalGap,
		positions: {},
		bounds: {},
		visible: new Set(),
	};
	const sides = balancedSides(ctx, rootId);
	const preference = ensureTreePreference(state, rootOf(state, rootId));
	for (const [childId, side] of sides) preference.branchSides[childId] = side;
	return Object.fromEntries(sides);
}

export function calculateLayout(
	data: CanvasData,
	state: CanvasMindMapState,
	options: LayoutOptions = {},
): LayoutResult {
	const ctx: LayoutContext = {
		data,
		state,
		nodes: getNodeMap(data),
		hidden: hiddenNodeIds(state),
		horizontalGap: options.horizontalGap ?? 200,
		verticalGap: options.verticalGap ?? 50,
		positions: Object.fromEntries(data.nodes.map((node) => [node.id, positionForNode(node)])),
		bounds: {},
		visible: new Set(),
	};
	const rootFilter = options.rootIds ? new Set(options.rootIds) : undefined;
	for (const rootId of roots(data, state)) {
		if (rootFilter && !rootFilter.has(rootId)) continue;
		const preference = state.trees[rootId];
		const mode = preference?.layout ?? options.defaultLayout ?? state.defaultLayout;
		if (mode === "left-to-right") {
			const root = ctx.nodes.get(rootId)!;
			placeHorizontal(ctx, rootId, root.x, root.y + root.height / 2, 1);
		} else if (mode === "right-to-left") {
			const root = ctx.nodes.get(rootId)!;
			placeHorizontal(ctx, rootId, root.x, root.y + root.height / 2, -1);
		} else if (mode === "top-to-bottom") {
			const root = ctx.nodes.get(rootId)!;
			placeVertical(ctx, rootId, root.x + root.width / 2, root.y, 1);
		} else if (mode === "bottom-to-top") {
			const root = ctx.nodes.get(rootId)!;
			placeVertical(ctx, rootId, root.x + root.width / 2, root.y, -1);
		} else {
			placeBalanced(ctx, rootId);
		}
	}
	return {
		positions: ctx.positions,
		visibleNodeIds: [...ctx.visible],
		bounds: ctx.bounds,
		edgeSides: edgeSidesFor(data, state, ctx.positions, ctx.nodes),
	};
}
