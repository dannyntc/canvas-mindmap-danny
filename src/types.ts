export type NodeId = string;
export type EdgeId = string;

export type LayoutMode =
	| "left-to-right"
	| "right-to-left"
	| "top-to-bottom"
	| "bottom-to-top"
	| "balanced";

export const DEFAULT_LAYOUT: LayoutMode = "left-to-right";

export type BranchSide = "left" | "right";
export type CanvasNodeType = "text" | "file" | "link" | "group" | string;
export type CanvasSide = "top" | "bottom" | "left" | "right";

export interface CanvasNodeData {
	id: NodeId;
	x: number;
	y: number;
	width: number;
	height: number;
	type: CanvasNodeType;
	text?: string;
	file?: string;
	subpath?: string;
	url?: string;
	color?: string;
	[key: string]: unknown;
}

export interface CanvasEdgeData {
	id: EdgeId;
	fromNode: NodeId;
	fromSide: CanvasSide;
	toNode: NodeId;
	toSide: CanvasSide;
	color?: string;
	[key: string]: unknown;
}

export interface CanvasData {
	nodes: CanvasNodeData[];
	edges: CanvasEdgeData[];
	[key: string]: unknown;
}

export interface ParentRelation {
	parentId: NodeId;
	edgeId: EdgeId;
	order: number;
}

export interface TreePreferences {
	layout: LayoutMode;
	branchSides: Record<NodeId, BranchSide>;
}

export interface CanvasMindMapState {
	version: number;
	enabled: boolean;
	autoLayout: boolean;
	autoHeight: boolean;
	defaultLayout: LayoutMode;
	trees: Record<NodeId, TreePreferences>;
	relations: Record<NodeId, ParentRelation>;
	collapsedNodeIds: NodeId[];
	manualHeightNodeIds: NodeId[];
}

export interface PersistedPluginData {
	[key: string]: unknown;
	mindMapVersion: number;
	mindMaps: Record<string, CanvasMindMapState>;
}

export interface Point {
	x: number;
	y: number;
}

export interface Bounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	width: number;
	height: number;
}

export interface EdgeSides {
	fromSide: CanvasSide;
	toSide: CanvasSide;
}

export interface LayoutResult {
	positions: Record<NodeId, Point>;
	visibleNodeIds: NodeId[];
	bounds: Record<NodeId, Bounds>;
	edgeSides: Record<EdgeId, EdgeSides>;
}

export const CURRENT_STATE_VERSION = 1;

export function defaultCanvasState(
	defaultLayout: LayoutMode = DEFAULT_LAYOUT,
): CanvasMindMapState {
	return {
		version: CURRENT_STATE_VERSION,
		enabled: true,
		autoLayout: true,
		autoHeight: true,
		defaultLayout,
		trees: {},
		relations: {},
		collapsedNodeIds: [],
		manualHeightNodeIds: [],
	};
}

export function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

export function isLayoutMode(value: unknown): value is LayoutMode {
	return (
		value === "left-to-right" ||
		value === "right-to-left" ||
		value === "top-to-bottom" ||
		value === "bottom-to-top" ||
		value === "balanced"
	);
}

export function isTreeNode(node: CanvasNodeData | undefined): boolean {
	return !!node && node.type !== "group";
}
