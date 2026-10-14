import {
	CanvasData,
	CanvasEdgeData,
	CanvasMindMapState,
	CanvasNodeData,
	NodeId,
	Point,
	cloneJson,
} from "./types";

export interface CanvasNodeLike {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	type: string;
	nodeEl?: HTMLElement;
	isEditing?: boolean;
	startEditing?: () => void;
	stopEditing?: () => void;
	setIsEditing?: (editing: boolean) => void;
	moveTo?: (position: Point) => void;
	resize?: (size: { width: number; height: number }) => void;
	setColor?: (color: string) => void;
	[key: string]: unknown;
}

export interface NativeSelectionDragCallbacks {
	move?: (event: PointerEvent) => unknown;
	end?: (event: PointerEvent) => unknown;
	cancel?: (event?: PointerEvent) => unknown;
	cleanup?: () => unknown;
	[key: string]: unknown;
}

export interface NativeSelectionDragHooks {
	onStart?: (event: PointerEvent, node?: CanvasNodeLike) => void;
	onMove?: (event: PointerEvent) => void;
	onEnd?: (event: PointerEvent) => void;
	onCancel?: (event?: PointerEvent) => void;
}

export interface CanvasViewport {
	x: number;
	y: number;
	/** Effective screen scale used for pointer-to-canvas conversion. */
	zoom: number;
	/** Native Canvas zoom value when the runtime stores zoom as log2(scale). */
	rawZoom?: number;
}

export interface CanvasLike {
	nodes?: Map<string, CanvasNodeLike> | Record<string, CanvasNodeLike>;
	edges?: Map<string, unknown> | Record<string, unknown>;
	selection?: Set<CanvasNodeLike | string>;
	readonly?: boolean;
	wrapperEl?: HTMLElement;
	x?: number;
	y?: number;
	zoom?: number;
	scale?: number;
	getViewport?: () => CanvasViewport;
	setViewport?: (this: CanvasLike, x: number, y: number, zoom: number) => void;
	handleSelectionDrag?: (
		this: CanvasLike,
		event: PointerEvent,
		target: HTMLElement,
		node?: CanvasNodeLike,
	) => NativeSelectionDragCallbacks;
	getData?: () => CanvasData;
	importData?: (data: CanvasData, removeMissing?: boolean) => void;
	requestSave?: () => void;
	requestFrame?: () => void;
	deselectAll?: () => void;
	selectOnly?: (node: CanvasNodeLike) => void;
	select?: (node: CanvasNodeLike) => void;
	zoomToSelection?: () => void;
	getEdgesForNode?: (node: CanvasNodeLike) => unknown[];
	history?: Record<string, unknown>;
	undoRedo?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface CapabilityReport {
	available: boolean;
	missing: string[];
	hasHistoryBridge: boolean;
	readOnly: boolean;
}

export interface AdapterTransaction {
	label: string;
	beforeData: CanvasData;
	afterData: CanvasData;
	beforeSelection: string[];
	afterSelection: string[];
}

function isFunction(value: unknown): value is (...args: any[]) => any {
	return typeof value === "function";
}

function asNodeMap(
	nodes: Map<string, CanvasNodeLike> | Record<string, CanvasNodeLike> | undefined,
): Map<string, CanvasNodeLike> {
	if (nodes instanceof Map) return nodes;
	return new Map(Object.entries(nodes ?? {}));
}

function asEdgeMap(
	edges: Map<string, unknown> | Record<string, unknown> | undefined,
): Map<string, unknown> {
	if (edges instanceof Map) return edges;
	return new Map(Object.entries(edges ?? {}));
}

type DomElement = HTMLElement | SVGElement;

function domElement(value: unknown): DomElement | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as { nodeType?: unknown; style?: unknown };
	return candidate.nodeType === 1 && candidate.style ? value as DomElement : undefined;
}

function nestedDomElement(value: unknown, key: string): DomElement | undefined {
	if (!value || typeof value !== "object") return undefined;
	return domElement((value as Record<string, unknown>)[key]);
}

function nestedNestedDomElement(value: unknown, firstKey: string, secondKey: string): DomElement | undefined {
	if (!value || typeof value !== "object") return undefined;
	return nestedDomElement((value as Record<string, unknown>)[firstKey], secondKey);
}

export class CanvasAdapter {
	readonly canvas: CanvasLike;
	readonly capabilities: CapabilityReport;
	lastTransaction?: AdapterTransaction;

	constructor(canvas: CanvasLike) {
		this.canvas = canvas;
		this.capabilities = CanvasAdapter.inspect(canvas);
	}

	static inspect(canvas: CanvasLike): CapabilityReport {
		const missing: string[] = [];
		if (!isFunction(canvas.getData)) missing.push("Canvas data export");
		if (!isFunction(canvas.importData)) missing.push("Canvas data import");
		if (!canvas.nodes) missing.push("Canvas node lookup");
		if (!canvas.selection) missing.push("Canvas selection");
		if (!isFunction(canvas.requestSave)) missing.push("Canvas save scheduling");
		if (!isFunction(canvas.requestFrame)) missing.push("Canvas rendering");
		const history = CanvasAdapter.historyTarget(canvas);
		const hasHistoryBridge = !!history &&
			["add", "push", "execute", "record"].some((name) => isFunction(history[name]));
		return {
			available: missing.length === 0,
			missing,
			hasHistoryBridge,
			readOnly: canvas.readonly === true,
		};
	}

	private static historyTarget(canvas: CanvasLike): Record<string, unknown> | undefined {
		if (canvas.history && typeof canvas.history === "object") return canvas.history;
		if (canvas.undoRedo && typeof canvas.undoRedo === "object") return canvas.undoRedo;
		return undefined;
	}

	getData(): CanvasData {
		if (!isFunction(this.canvas.getData)) return { nodes: [], edges: [] };
		const data = this.canvas.getData();
		return cloneJson({ ...data, nodes: data.nodes ?? [], edges: data.edges ?? [] });
	}

	writeData(data: CanvasData): boolean {
		if (this.capabilities.readOnly || !isFunction(this.canvas.importData)) return false;
		try {
			// Obsidian's Canvas importData(data, true) removes live nodes and
			// edges that are absent from the snapshot. Omitting the flag leaves
			// deleted branch cards behind in the live Canvas.
			this.canvas.importData(cloneJson(data), true);
			this.requestFrame();
			return true;
		} catch {
			return false;
		}
	}

	node(nodeId: NodeId): CanvasNodeLike | undefined {
		return asNodeMap(this.canvas.nodes).get(nodeId);
	}

	nodes(): CanvasNodeLike[] {
		return [...asNodeMap(this.canvas.nodes).values()];
	}

	selectionIds(): string[] {
		return [...(this.canvas.selection ?? new Set())].map((selected) => {
			return typeof selected === "string" ? selected : selected.id;
		});
	}

	selectOnly(nodeId: NodeId): boolean {
		const node = this.node(nodeId);
		if (!node || this.capabilities.readOnly) return false;
		this.canvas.deselectAll?.();
		if (isFunction(this.canvas.selectOnly)) this.canvas.selectOnly(node);
		else this.canvas.selection?.add(node);
		return true;
	}

	clearSelection(): void {
		this.canvas.deselectAll?.();
	}

	startEditing(nodeId: NodeId): boolean {
		const node = this.node(nodeId);
		if (!node || this.capabilities.readOnly) return false;
		if (isFunction(node.startEditing)) node.startEditing();
		else if (isFunction(node.setIsEditing)) node.setIsEditing(true);
		else return false;
		return true;
	}

	stopEditing(nodeId: NodeId): boolean {
		const node = this.node(nodeId);
		if (!node) return false;
		if (isFunction(node.stopEditing)) node.stopEditing();
		else if (isFunction(node.setIsEditing)) node.setIsEditing(false);
		else return false;
		return true;
	}

	focusCanvas(): boolean {
		const target = this.canvas.wrapperEl;
		if (!target || typeof target.focus !== "function") return false;
		try {
			target.focus({ preventScroll: true });
			return true;
		} catch {
			try {
				target.focus();
				return true;
			} catch {
				return false;
			}
		}
	}

	moveNode(nodeId: NodeId, position: Point): boolean {
		const node = this.node(nodeId);
		if (!node || this.capabilities.readOnly) return false;
		if (isFunction(node.moveTo)) node.moveTo(position);
		else {
			node.x = position.x;
			node.y = position.y;
		}
		return true;
	}

	resizeNode(nodeId: NodeId, width: number, height: number): boolean {
		const node = this.node(nodeId);
		if (!node || this.capabilities.readOnly) return false;
		if (isFunction(node.resize)) node.resize({ width, height });
		else {
			node.width = width;
			node.height = height;
		}
		return true;
	}

	requestSave(): void {
		this.canvas.requestSave?.();
	}

	requestFrame(): void {
		this.canvas.requestFrame?.();
	}

	observeSelectionDrag(hooks: NativeSelectionDragHooks): (() => void) | undefined {
		const original = this.canvas.handleSelectionDrag;
		if (!isFunction(original)) return undefined;
		const canvas = this.canvas;
		const wrapped = function (
			this: CanvasLike,
			event: PointerEvent,
			target: HTMLElement,
			node?: CanvasNodeLike,
		): NativeSelectionDragCallbacks {
			const callbacks = original.call(this, event, target, node);
			hooks.onStart?.(event, node);
			if (!callbacks || typeof callbacks !== "object") return callbacks;
			const nativeCallbacks = callbacks as NativeSelectionDragCallbacks;
			return {
				...nativeCallbacks,
				move: (moveEvent: PointerEvent) => {
					const result = nativeCallbacks.move?.call(nativeCallbacks, moveEvent);
					hooks.onMove?.(moveEvent);
					return result;
				},
				end: (endEvent: PointerEvent) => {
					const result = nativeCallbacks.end?.call(nativeCallbacks, endEvent);
					hooks.onEnd?.(endEvent);
					return result;
				},
				cancel: (cancelEvent?: PointerEvent) => {
					const result = nativeCallbacks.cancel?.call(nativeCallbacks, cancelEvent);
					hooks.onCancel?.(cancelEvent);
					return result;
				},
			};
		};
		try {
			this.canvas.handleSelectionDrag = wrapped;
		} catch {
			return undefined;
		}
		return () => {
			if (this.canvas.handleSelectionDrag === wrapped) {
				try {
					this.canvas.handleSelectionDrag = original;
				} catch {
					// Another runtime owns this private method now.
				}
			}
		};
	}

	observeDataImport(onImport: (data: CanvasData) => void): (() => void) | undefined {
		const original = this.canvas.importData;
		if (!isFunction(original)) return undefined;
		const wrapped = function (this: CanvasLike, data: CanvasData, removeMissing?: boolean): unknown {
			const result = original.call(this, data, removeMissing);
			onImport(cloneJson(data));
			return result;
		};
		try {
			this.canvas.importData = wrapped;
		} catch {
			return undefined;
		}
		return () => {
			if (this.canvas.importData === wrapped) {
				try {
					this.canvas.importData = original;
				} catch {
					// Another runtime owns this private method now.
				}
			}
		};
	}

	viewport(): CanvasViewport | undefined {
		if (isFunction(this.canvas.getViewport)) {
			try {
				const viewport = this.canvas.getViewport();
				if (viewport && Number.isFinite(viewport.x) && Number.isFinite(viewport.y) && viewport.zoom > 0) {
					return cloneJson(viewport);
				}
			} catch {
				// Fall through to the known Canvas x/y/zoom fields.
			}
		}
		if (typeof this.canvas.x !== "number" || typeof this.canvas.y !== "number") return undefined;
		const rawZoom = typeof this.canvas.zoom === "number" ? this.canvas.zoom : 0;
		const zoom = typeof this.canvas.scale === "number" && this.canvas.scale > 0
			? this.canvas.scale
			: rawZoom > 0 ? rawZoom : Math.pow(2, rawZoom);
		return {
			x: this.canvas.x,
			y: this.canvas.y,
			zoom,
			...(typeof this.canvas.scale === "number" ? { rawZoom } : {}),
		};
	}

	setViewport(viewport: CanvasViewport): boolean {
		const setter = this.canvas.setViewport;
		try {
			if (isFunction(setter)) {
				const rawZoom = viewport.rawZoom ?? (
					typeof this.canvas.scale === "number" ? Math.log2(viewport.zoom) : viewport.zoom
				);
				// Canvas.setViewport is an instance method. Calling an extracted
				// function loses `this` and silently prevents native viewport state
				// from changing.
				setter.call(this.canvas, viewport.x, viewport.y, rawZoom);
				this.requestFrame();
				return true;
			}
			if (typeof this.canvas.x !== "number" || typeof this.canvas.y !== "number") return false;
			this.canvas.x = viewport.x;
			this.canvas.y = viewport.y;
			if (typeof this.canvas.scale === "number") {
				this.canvas.scale = viewport.zoom;
				if (typeof this.canvas.zoom === "number") this.canvas.zoom = viewport.rawZoom ?? Math.log2(viewport.zoom);
			} else if (typeof this.canvas.zoom === "number") {
				this.canvas.zoom = viewport.zoom;
			}
			this.requestFrame();
			return true;
		} catch {
			return false;
		}
	}

	zoom(): number {
		return this.viewport()?.zoom ?? (typeof this.canvas.zoom === "number" && this.canvas.zoom > 0
			? this.canvas.zoom
			: 1);
	}

	transaction(
		label: string,
		mutator: (data: CanvasData) => boolean | void,
		verify?: (beforeData: CanvasData, requestedData: CanvasData, afterData: CanvasData) => boolean,
	): AdapterTransaction | undefined {
		if (!this.capabilities.available || this.capabilities.readOnly) return undefined;
		const beforeData = this.getData();
		const beforeSelection = this.selectionIds();
		const nextData = cloneJson(beforeData);
		const result = mutator(nextData);
		if (result === false || !this.writeData(nextData)) return undefined;
		const afterData = this.getData();
		const changed = JSON.stringify(beforeData) !== JSON.stringify(afterData);
		if (!changed || (verify && !verify(beforeData, nextData, afterData))) {
			if (changed) this.writeData(beforeData);
			return undefined;
		}
		const transaction: AdapterTransaction = {
			label,
			beforeData,
			afterData,
			beforeSelection,
			afterSelection: this.selectionIds(),
		};
		try {
			this.requestSave();
		} catch {
			// Do not leave a successfully imported snapshot without a matching
			// save boundary. Restore the exact pre-transaction data instead.
			this.writeData(beforeData);
			return undefined;
		}
		this.lastTransaction = transaction;
		return transaction;
	}

	applyPositions(
		positions: Record<NodeId, Point>,
	): boolean {
		if (this.capabilities.readOnly) return false;
		let changed = false;
		for (const [nodeId, position] of Object.entries(positions)) {
			changed = this.moveNode(nodeId, position) || changed;
		}
		if (changed) {
			this.requestFrame();
			this.requestSave();
		}
		return changed;
	}

	setNodeVisibility(nodeId: NodeId, visible: boolean): void {
		const node = this.node(nodeId);
		const element = node?.nodeEl;
		if (!element) return;
		element.classList.toggle("canvas-mindmap-hidden", !visible);
		element.setAttribute("aria-hidden", visible ? "false" : "true");
		element.style.pointerEvents = visible ? "" : "none";
		element.style.visibility = visible ? "" : "hidden";
	}

	setEdgeVisibility(edgeId: string, visible: boolean): void {
		const wrapper = this.canvas.wrapperEl;
		if (!wrapper) return;
		const elements = new Set<DomElement>();
		const liveEdge = asEdgeMap(this.canvas.edges).get(edgeId);
		if (liveEdge && typeof liveEdge === "object") {
			const edge = liveEdge as Record<string, unknown>;
			const path = edge.path;
			for (const candidate of [
				domElement(path),
				nestedNestedDomElement(path, "interaction", "el"),
				nestedNestedDomElement(path, "display", "el"),
				nestedDomElement(edge, "pathEl"),
				nestedDomElement(edge, "edgeEl"),
				nestedDomElement(edge, "el"),
				nestedDomElement(edge.fromLineEnd, "el"),
				nestedDomElement(edge.toLineEnd, "el"),
			]) {
				if (candidate && wrapper.contains(candidate)) elements.add(candidate);
			}
		}
		for (const element of Array.from(wrapper.querySelectorAll<HTMLElement>("[data-edge-id]"))) {
			if (element.dataset.edgeId === edgeId && !element.closest(".canvas-mindmap-branching-overlay")) {
				elements.add(element);
			}
		}
		for (const element of elements) {
			element.classList.toggle("canvas-mindmap-hidden", !visible);
			element.style.pointerEvents = visible ? "" : "none";
			element.style.visibility = visible ? "" : "hidden";
		}
	}

	zoomToSelection(): void {
		this.canvas.zoomToSelection?.();
	}

	static dataNodeFromLive(node: CanvasNodeLike): CanvasNodeData {
		return {
			id: node.id,
			x: node.x,
			y: node.y,
			width: node.width,
			height: node.height,
			type: node.type,
		};
	}
}
