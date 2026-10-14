import {
	BranchJunction,
	CanvasData,
	CanvasEdgeData,
	CanvasMindMapState,
	CanvasSide,
	EdgeId,
	NodeId,
} from "./types";

export interface BranchingGroup {
	key: string;
	parentId: NodeId;
	side: CanvasSide;
	edges: CanvasEdgeData[];
	junctions: BranchJunction[];
}

export interface BranchingOverlayCallbacks {
	canEdit: () => boolean;
	getNodeIdAt: (clientX: number, clientY: number) => NodeId | undefined;
	onJunctionPreview: (junctionId: string, ratio: number) => void;
	onJunctionCommit: (junctionId: string, ratio: number) => void;
	onConnect: (junctionId: string, nodeId: NodeId) => void;
	onPathContextMenu: (edgeId: EdgeId, ratio: number, event: MouseEvent) => void;
	onJunctionContextMenu: (junctionId: string, event: MouseEvent) => void;
}

interface ScreenPoint {
	x: number;
	y: number;
}

interface ScreenRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

interface EdgeGeometry {
	edge: CanvasEdgeData;
	parentId: NodeId;
	childId: NodeId;
	source: ScreenPoint;
	target: ScreenPoint;
}

interface GroupGeometry extends BranchingGroup {
	anchor: EdgeGeometry;
	junctionPoints: Map<string, ScreenPoint>;
}

interface ActiveJunctionDrag {
	id: string;
	pointerId: number;
	group: GroupGeometry;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function clampRatio(value: number): number {
	return Math.min(0.95, Math.max(0.05, value));
}

function lerp(from: ScreenPoint, to: ScreenPoint, ratio: number): ScreenPoint {
	return {
		x: from.x + (to.x - from.x) * ratio,
		y: from.y + (to.y - from.y) * ratio,
	};
}

export function projectRatio(point: ScreenPoint, from: ScreenPoint, to: ScreenPoint): number {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared <= 0.0001) return 0.5;
	return clampRatio(((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared);
}

export function branchGroupKey(parentId: NodeId, side: CanvasSide): string {
	return `${parentId}:${side}`;
}

export function managedBranchGroups(
	data: CanvasData,
	state: CanvasMindMapState,
): BranchingGroup[] {
	const managedByEdge = new Map<string, { parentId: NodeId }>();
	for (const [childId, relation] of Object.entries(state.relations)) {
		managedByEdge.set(relation.edgeId, { parentId: relation.parentId });
		if (!data.nodes.some((node) => node.id === childId)) managedByEdge.delete(relation.edgeId);
	}
	const groups = new Map<string, BranchingGroup>();
	for (const edge of data.edges) {
		const managed = managedByEdge.get(edge.id);
		if (!managed) continue;
		const key = branchGroupKey(managed.parentId, edge.fromSide);
		const group = groups.get(key) ?? {
			key,
			parentId: managed.parentId,
			side: edge.fromSide,
			edges: [],
			junctions: [],
		};
		group.edges.push(edge);
		groups.set(key, group);
	}
	for (const group of groups.values()) {
		const edgeIds = new Set(group.edges.map((edge) => edge.id));
		group.junctions = Object.values(state.junctions)
			.filter((junction) => junction.parentId === group.parentId && junction.side === group.side)
			.map((junction) => ({
				...junction,
				edgeIds: junction.edgeIds.filter((edgeId) => edgeIds.has(edgeId)),
			}))
			.filter((junction) => junction.edgeIds.length > 0);
	}
	return [...groups.values()]
		.filter((group) => group.edges.length > 0)
		.sort((left, right) => left.key.localeCompare(right.key));
}

function elementRect(element: HTMLElement | undefined): ScreenRect | undefined {
	if (!element || typeof element.getBoundingClientRect !== "function") return undefined;
	const rect = element.getBoundingClientRect();
	return {
		left: rect.left,
		top: rect.top,
		right: rect.right,
		bottom: rect.bottom,
	};
}

function endpoint(rect: ScreenRect, side: CanvasSide, wrapper: ScreenRect): ScreenPoint {
	const absolute = side === "left"
		? { x: rect.left, y: (rect.top + rect.bottom) / 2 }
		: side === "right"
			? { x: rect.right, y: (rect.top + rect.bottom) / 2 }
			: side === "top"
				? { x: (rect.left + rect.right) / 2, y: rect.top }
				: { x: (rect.left + rect.right) / 2, y: rect.bottom };
	return { x: absolute.x - wrapper.left, y: absolute.y - wrapper.top };
}

function safeColor(color: string | undefined): string {
	if (!color) return "#8b8f98";
	if (/^#[0-9a-f]{3,8}$/i.test(color) || /^(?:rgb|hsl)a?\(/i.test(color)) return color;
	return "#8b8f98";
}

function svgElement<K extends keyof SVGElementTagNameMap>(
	document: Document,
	tag: K,
): SVGElementTagNameMap[K] {
	return document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
}

export class BranchingOverlay {
	private readonly wrapper: HTMLElement;
	private readonly callbacks: BranchingOverlayCallbacks;
	private readonly svg: SVGSVGElement;
	private readonly previewRatios = new Map<string, number>();
	private currentData?: CanvasData;
	private currentState?: CanvasMindMapState;
	private currentHidden = new Set<NodeId>();
	private getNodeElement?: (nodeId: NodeId) => HTMLElement | undefined;
	private groups: GroupGeometry[] = [];
	private activeDrag?: ActiveJunctionDrag;
	private disposed = false;

	constructor(wrapper: HTMLElement, callbacks: BranchingOverlayCallbacks) {
		this.wrapper = wrapper;
		this.callbacks = callbacks;
		this.svg = svgElement(wrapper.ownerDocument, "svg");
		this.svg.classList.add("canvas-mindmap-branching-overlay");
		this.svg.setAttribute("aria-hidden", "true");
		this.svg.style.position = "absolute";
		this.svg.style.inset = "0";
		this.svg.style.width = "100%";
		this.svg.style.height = "100%";
		this.svg.style.overflow = "visible";
		this.svg.style.pointerEvents = "none";
		this.svg.addEventListener("pointermove", this.onPointerMove);
		this.svg.addEventListener("pointerup", this.onPointerUp);
		this.svg.addEventListener("pointercancel", this.onPointerCancel);
		this.svg.addEventListener("contextmenu", this.onContextMenu);
		wrapper.appendChild(this.svg);
	}

	update(
		data: CanvasData,
		state: CanvasMindMapState,
		hidden: ReadonlySet<NodeId>,
		getNodeElement: (nodeId: NodeId) => HTMLElement | undefined,
	): void {
		if (this.disposed) return;
		this.currentData = data;
		this.currentState = state;
		this.currentHidden = new Set(hidden);
		this.getNodeElement = getNodeElement;
		this.groups = [];
		this.svg.replaceChildren();
		if (!state.branchingEnabled) return;
		const wrapperRect = elementRect(this.wrapper);
		if (!wrapperRect) return;
		const dataNodes = new Map(data.nodes.map((node) => [node.id, node]));
		const edgeToChild = new Map(Object.entries(state.relations).map(([childId, relation]) => [relation.edgeId, childId]));
		const groups = managedBranchGroups(data, state);
		const defs = svgElement(this.wrapper.ownerDocument, "defs");
		this.svg.appendChild(defs);
		for (const group of groups) {
			const geometries: EdgeGeometry[] = [];
			for (const edge of group.edges) {
				const childId = edgeToChild.get(edge.id);
				const parent = dataNodes.get(edge.fromNode);
				const child = childId ? dataNodes.get(childId) : undefined;
				if (!childId || !parent || !child || this.currentHidden.has(parent.id) || this.currentHidden.has(child.id)) continue;
				const parentRect = elementRect(getNodeElement(parent.id));
				const childRect = elementRect(getNodeElement(child.id));
				if (!parentRect || !childRect) continue;
				geometries.push({
					edge,
					parentId: parent.id,
					childId,
					source: endpoint(parentRect, edge.fromSide, wrapperRect),
					target: endpoint(childRect, edge.toSide, wrapperRect),
				});
			}
			if (geometries.length === 0) continue;
			const visibleGroup: GroupGeometry = {
				...group,
				edges: geometries.map((geometry) => geometry.edge),
				junctions: [...group.junctions],
				anchor: geometries[0],
				junctionPoints: new Map(),
			};
			if (visibleGroup.junctions.length === 0 && geometries.length > 1) {
				visibleGroup.junctions.push({
					id: `auto:${group.key}`,
					parentId: group.parentId,
					anchorEdgeId: geometries[0].edge.id,
					side: group.side,
					ratio: 0.5,
					edgeIds: geometries.map((geometry) => geometry.edge.id),
				});
			}
			visibleGroup.junctions.sort((left, right) => left.ratio - right.ratio || left.id.localeCompare(right.id));
			const anchorTarget = geometries.find((geometry) => geometry.edge.id === visibleGroup.junctions[0]?.anchorEdgeId) ?? geometries[0];
			visibleGroup.anchor = anchorTarget;
			for (const junction of visibleGroup.junctions) {
				const ratio = this.previewRatios.get(junction.id) ?? junction.ratio;
				visibleGroup.junctionPoints.set(junction.id, lerp(anchorTarget.source, anchorTarget.target, ratio));
			}
			this.groups.push(visibleGroup);
			this.renderGroup(visibleGroup, geometries, defs);
		}
	}

	previewJunction(junctionId: string, ratio: number): void {
		this.previewRatios.set(junctionId, clampRatio(ratio));
		this.rerenderCurrent();
	}

	clearPreview(junctionId: string): void {
		this.previewRatios.delete(junctionId);
	}

	private rerenderCurrent(): void {
		if (!this.currentData || !this.currentState) return;
		this.update(this.currentData, this.currentState, this.currentHidden, this.getNodeElement ?? (() => undefined));
	}

	private renderGroup(group: GroupGeometry, geometries: EdgeGeometry[], defs: SVGDefsElement): void {
		const document = this.wrapper.ownerDocument;
		const hitOnly = group.junctions.length === 0 && geometries.length === 1;
		const pathFor = (from: ScreenPoint, to: ScreenPoint, edge: CanvasEdgeData, arrow: boolean): void => {
			const path = svgElement(document, "path");
			path.setAttribute("d", `M ${from.x} ${from.y} L ${to.x} ${to.y}`);
			path.setAttribute("fill", "none");
			path.setAttribute("stroke", safeColor(edge.color));
			path.setAttribute("stroke-width", hitOnly ? "12" : "3");
			if (hitOnly) path.setAttribute("stroke-opacity", "0");
			path.setAttribute("stroke-linecap", "round");
			path.dataset.edgeId = edge.id;
			path.dataset.branchingPath = "true";
			path.style.pointerEvents = "stroke";
			if (arrow && !hitOnly) {
				const markerId = this.marker(defs, safeColor(edge.color));
				path.setAttribute("marker-end", `url(#${markerId})`);
			}
			this.svg.appendChild(path);
		};

		let previous = group.anchor.source;
		for (const junction of group.junctions) {
			const point = group.junctionPoints.get(junction.id);
			if (!point) continue;
			pathFor(previous, point, group.anchor.edge, false);
			previous = point;
			const circle = svgElement(document, "circle");
			circle.setAttribute("cx", String(point.x));
			circle.setAttribute("cy", String(point.y));
			circle.setAttribute("r", junction.id.startsWith("auto:") ? "6" : "8");
			circle.setAttribute("fill", "var(--interactive-accent)");
			circle.setAttribute("stroke", "var(--background-primary)");
			circle.setAttribute("stroke-width", "2");
			circle.dataset.junctionId = junction.id;
			circle.dataset.branchingJunction = "true";
			circle.style.pointerEvents = this.callbacks.canEdit() ? "all" : "none";
			this.svg.appendChild(circle);
		}
		const junctionsByEdge = new Map<EdgeId, BranchJunction[]>();
		for (const junction of group.junctions) {
			for (const edgeId of junction.edgeIds) {
				const list = junctionsByEdge.get(edgeId) ?? [];
				list.push(junction);
				junctionsByEdge.set(edgeId, list);
			}
		}
		for (const geometry of geometries) {
			const routeJunctions = junctionsByEdge.get(geometry.edge.id) ?? [];
			const finalJunction = routeJunctions
				.map((junction) => ({ junction, point: group.junctionPoints.get(junction.id) }))
				.filter((item): item is { junction: BranchJunction; point: ScreenPoint } => !!item.point)
				.sort((left, right) => left.junction.ratio - right.junction.ratio)
				.at(-1);
			pathFor(finalJunction?.point ?? geometry.source, geometry.target, geometry.edge, true);
		}
	}

	private marker(defs: SVGDefsElement, color: string): string {
		const id = `canvas-mindmap-arrow-${color.replace(/[^a-z0-9]/gi, "") || "default"}`;
		if (defs.querySelector(`#${id}`)) return id;
		const marker = svgElement(this.wrapper.ownerDocument, "marker");
		marker.id = id;
		marker.setAttribute("viewBox", "0 0 10 10");
		marker.setAttribute("refX", "9");
		marker.setAttribute("refY", "5");
		marker.setAttribute("markerWidth", "7");
		marker.setAttribute("markerHeight", "7");
		marker.setAttribute("orient", "auto-start-reverse");
		const arrow = svgElement(this.wrapper.ownerDocument, "path");
		arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
		arrow.setAttribute("fill", color);
		marker.appendChild(arrow);
		defs.appendChild(marker);
		return id;
	}

	private findGroupForEdge(edgeId: EdgeId): GroupGeometry | undefined {
		return this.groups.find((group) => group.edges.some((edge) => edge.id === edgeId));
	}

	private onContextMenu = (event: MouseEvent): void => {
		const target = event.target as Element | null;
		if (!target) return;
		const junctionId = target.closest<SVGCircleElement>("[data-branching-junction]")?.dataset.junctionId;
		if (junctionId) {
			event.preventDefault();
			event.stopPropagation();
			this.callbacks.onJunctionContextMenu(junctionId, event);
			return;
		}
		const edgeId = target.closest<SVGPathElement>("[data-branching-path]")?.dataset.edgeId;
		if (!edgeId) return;
		const group = this.findGroupForEdge(edgeId);
		if (!group) return;
		event.preventDefault();
		event.stopPropagation();
		const wrapperRect = elementRect(this.wrapper);
		if (!wrapperRect) return;
		const ratio = projectRatio(
			{ x: event.clientX - wrapperRect.left, y: event.clientY - wrapperRect.top },
			group.anchor.source,
			group.anchor.target,
		);
		this.callbacks.onPathContextMenu(edgeId, ratio, event);
	};

	private onPointerDown = (event: PointerEvent): void => {
		if (!this.callbacks.canEdit()) return;
		const target = event.target as Element | null;
		const junctionId = target?.closest<SVGCircleElement>("[data-branching-junction]")?.dataset.junctionId;
		if (!junctionId) return;
		const group = this.groups.find((candidate) => candidate.junctions.some((junction) => junction.id === junctionId));
		const circle = target?.closest<SVGCircleElement>("[data-branching-junction]");
		if (!group || !circle) return;
		event.preventDefault();
		event.stopPropagation();
		this.activeDrag = { id: junctionId, pointerId: event.pointerId, group };
		circle.setPointerCapture?.(event.pointerId);
	};

	private onPointerMove = (event: PointerEvent): void => {
		const drag = this.activeDrag;
		if (!drag || drag.pointerId !== event.pointerId) return;
		event.preventDefault();
		event.stopPropagation();
		const rect = elementRect(this.wrapper);
		if (!rect) return;
		const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
		const ratio = projectRatio(point, drag.group.anchor.source, drag.group.anchor.target);
		this.previewRatios.set(drag.id, ratio);
		this.rerenderCurrent();
		this.callbacks.onJunctionPreview(drag.id, ratio);
	};

	private onPointerUp = (event: PointerEvent): void => {
		const drag = this.activeDrag;
		if (!drag || drag.pointerId !== event.pointerId) return;
		this.finishDrag(event, false);
	};

	private onPointerCancel = (event: PointerEvent): void => {
		const drag = this.activeDrag;
		if (!drag || drag.pointerId !== event.pointerId) return;
		this.finishDrag(event, true);
	};

	private finishDrag(event: PointerEvent, cancelled: boolean): void {
		const drag = this.activeDrag;
		if (!drag) return;
		const ratio = this.previewRatios.get(drag.id) ?? 0.5;
		if (!cancelled) {
			const nodeId = this.callbacks.getNodeIdAt(event.clientX, event.clientY);
			if (nodeId) this.callbacks.onConnect(drag.id, nodeId);
			this.callbacks.onJunctionCommit(drag.id, ratio);
		}
		this.previewRatios.delete(drag.id);
		this.activeDrag = undefined;
		this.rerenderCurrent();
	};

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.activeDrag = undefined;
		this.svg.removeEventListener("pointermove", this.onPointerMove);
		this.svg.removeEventListener("pointerup", this.onPointerUp);
		this.svg.removeEventListener("pointercancel", this.onPointerCancel);
		this.svg.removeEventListener("contextmenu", this.onContextMenu);
		this.svg.remove();
	}
}
