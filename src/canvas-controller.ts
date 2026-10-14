import { Menu, Notice, setTooltip } from "obsidian";
import { CanvasAdapter, CanvasLike, CanvasViewport } from "./canvas-adapter";
import { HeightController } from "./height-controller";
import {
	findContactParent,
	hasPassedDragThreshold,
	panViewport,
	Rect,
} from "./interaction";
import { assignMissingBalancedSides, calculateLayout } from "./layout";
import {
	CanvasData,
	CanvasEdgeData,
	CanvasMindMapState,
	CanvasNodeData,
	BranchSide,
	LayoutMode,
	NodeId,
	cloneJson,
} from "./types";
import {
	applyBranchDeletion,
	attachChild,
	branchDeletion,
	canReparent,
	deleteBranches,
	descendants,
	duplicateBranch,
	ensureTreePreference,
	hiddenDescendantCount,
	hiddenNodeIds,
	parentOf,
	relationChildren,
	reorderSibling,
	rootOf,
	roots,
	sanitizeState,
	toggleCollapsed,
} from "./tree-model";

export interface CanvasViewLike {
	canvas?: CanvasLike;
	containerEl: HTMLElement;
	contentEl?: HTMLElement;
	file?: { path: string };
	getViewType?: () => string;
	getState?: () => { file?: string; [key: string]: unknown };
	[key: string]: unknown;
}

export interface ControllerOptions {
	view: CanvasViewLike;
	state: CanvasMindMapState;
	onStateChange: (state: CanvasMindMapState) => void;
	notify?: (message: string) => void;
	childWidth?: number;
	childHeight?: number;
	horizontalGap?: number;
	verticalGap?: number;
	isExternalResizeOwner?: () => boolean;
	onEnabled?: (requested: CanvasMindMapState) => CanvasMindMapState;
}

interface DragSnapshot {
	nodeId: NodeId;
	pointerId: number;
	startClient: { x: number; y: number };
	branchIds: Set<NodeId>;
	directSelection: Set<NodeId>;
	movementRoots: Set<NodeId>;
	positions: Record<NodeId, { x: number; y: number }>;
	modifier: boolean;
	active: boolean;
	canReparent: boolean;
	modifierDuringDrag: boolean;
	contactTargetId?: NodeId;
	frame?: number;
}

interface PanSnapshot {
	pointerId: number;
	captureTarget?: Element & { releasePointerCapture?: (pointerId: number) => void };
	startClient: { x: number; y: number };
	lastClient: { x: number; y: number };
	startViewport: CanvasViewport;
	active: boolean;
	frame?: number;
}

function randomId(prefix: string, used: Set<string>): string {
	let id = "";
	while (!id || used.has(id)) {
		const uuid = globalThis.crypto?.randomUUID?.();
		id = `${prefix}-${uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
	}
	used.add(id);
	return id;
}

function isEditableTarget(target: EventTarget | null): boolean {
	if (!target || typeof (target as Element).closest !== "function") return false;
	return !!(target as Element).closest(
		"input, textarea, select, button, [contenteditable='true'], .cm-editor, .markdown-source-view",
	);
}

function isDomElement(target: EventTarget | null): target is Element {
	return !!target && typeof (target as Element).closest === "function";
}

function center(node: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
	return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

function directionLayout(mode: LayoutMode): "horizontal" | "vertical" {
	return mode === "top-to-bottom" || mode === "bottom-to-top" ? "vertical" : "horizontal";
}

export class CanvasController {
	readonly adapter: CanvasAdapter;
	readonly view: CanvasViewLike;
	private readonly options: ControllerOptions;
	private state: CanvasMindMapState;
	private toolbar?: HTMLElement;
	private modeButton?: HTMLButtonElement;
	private modeStatus?: HTMLElement;
	private keyTarget?: HTMLElement;
	private domObserver?: MutationObserver;
	private domSyncTimer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private drag?: DragSnapshot;
	private pan?: PanSnapshot;
	private panNoticeShown = false;
	private readonly zoomControlStates = new WeakMap<HTMLElement, { ariaHidden: string | null; tabIndex: string | null }>();
	private readonly height: HeightController;

	private get win(): Window {
		return this.view.containerEl.ownerDocument.defaultView ?? window;
	}

	constructor(options: ControllerOptions) {
		this.options = options;
		this.view = options.view;
		this.state = cloneJson(options.state);
		this.adapter = new CanvasAdapter(options.view.canvas!);
		this.height = new HeightController({
			adapter: this.adapter,
			getState: () => this.state,
			isEnabled: () => this.state.enabled && this.state.autoHeight && !this.disposed,
			isExternalResizeOwner: options.isExternalResizeOwner,
			onResized: (nodeId) => {
				if (this.state.autoLayout) this.layoutTree(rootOf(this.state, nodeId));
			},
		});
	}

	mount(): void {
		if (this.disposed) return;
		this.createToolbar();
		this.keyTarget = this.adapter.canvas.wrapperEl ?? this.view.containerEl;
		this.keyTarget.addEventListener("keydown", this.onKeyDown, true);
		this.keyTarget.addEventListener("pointerdown", this.onPointerDown, true);
		this.win.addEventListener("pointermove", this.onPointerMove, true);
		this.win.addEventListener("pointerup", this.onPointerUp, true);
		this.win.addEventListener("pointercancel", this.onPointerCancel, true);
		this.win.addEventListener("blur", this.onWindowBlur);
		this.observeCanvasDom();
		this.refreshRuntime();
	}

	private observeCanvasDom(): void {
		if (typeof MutationObserver === "undefined") return;
		const target = this.view.containerEl;
		this.domObserver = new MutationObserver(() => {
			if (!this.state.enabled || this.domSyncTimer) return;
			this.domSyncTimer = setTimeout(() => {
				this.domSyncTimer = undefined;
				if (!this.domObserver || this.disposed || !this.state.enabled) return;
				this.domObserver.disconnect();
				this.reconcileStateWithCanvas();
				this.updateZoomControls();
				this.applyVisibility();
				this.refreshControls();
				this.domObserver.observe(target, { childList: true, subtree: true });
			}, 0);
		});
		this.domObserver.observe(target, { childList: true, subtree: true });
	}

	private reconcileStateWithCanvas(): void {
		const clean = sanitizeState(this.adapter.getData(), this.state, this.state.defaultLayout);
		if (JSON.stringify(clean) === JSON.stringify(this.state)) return;
		this.state = clean;
		this.commitState();
	}

	refreshFromState(state: CanvasMindMapState): void {
		if (this.disposed) return;
		this.state = cloneJson(state);
		this.refreshRuntime();
	}

	getState(): CanvasMindMapState {
		return cloneJson(this.state);
	}

	isEnabled(): boolean {
		return this.state.enabled;
	}

	toggleEnabled(): boolean {
		if (this.adapter.capabilities.readOnly) {
			this.notify("This Canvas is read-only.");
			return false;
		}
		if (!this.adapter.capabilities.available) {
			this.notify(`Mind-map mode is unavailable: ${this.adapter.capabilities.missing.join(", ")}.`);
			return false;
		}
		const enabled = !this.state.enabled;
		if (enabled) {
			const requested = { ...cloneJson(this.state), enabled: true };
			this.state = cloneJson(this.options.onEnabled?.(requested) ?? requested);
			// Adoption may start from a previously saved disabled state. The
			// requested transition is authoritative for this view.
			this.state.enabled = true;
		} else {
			this.state.enabled = false;
		}
		this.commitState();
		this.refreshRuntime();
		return this.state.enabled;
	}

	setEnabled(enabled: boolean): boolean {
		if (enabled === this.state.enabled) return enabled;
		if (enabled && (this.adapter.capabilities.readOnly || !this.adapter.capabilities.available)) {
			this.notify("Mind-map mode cannot be enabled for this Canvas version.");
			return false;
		}
		if (enabled) {
			const requested = { ...cloneJson(this.state), enabled: true };
			this.state = cloneJson(this.options.onEnabled?.(requested) ?? requested);
			this.state.enabled = true;
		} else {
			this.state.enabled = false;
		}
		this.commitState();
		this.refreshRuntime();
		return enabled;
	}

	private notify(message: string): void {
		if (this.options.notify) this.options.notify(message);
		else new Notice(message);
	}

	private commitState(): void {
		this.options.onStateChange(cloneJson(this.state));
	}

	private createToolbar(): void {
		const doc = this.view.containerEl.ownerDocument;
		const host = this.view.containerEl.querySelector<HTMLElement>(".canvas-controls") ??
			this.view.containerEl;
		this.toolbar = doc.createElement("div");
		this.toolbar.className = "canvas-mindmap-toolbar";
		this.toolbar.setAttribute("role", "toolbar");
		this.modeButton = doc.createElement("button");
		this.modeButton.type = "button";
		this.modeButton.className = "clickable-icon canvas-mindmap-mode-toggle";
		this.modeButton.addEventListener("click", () => this.toggleEnabled());
		this.modeStatus = doc.createElement("span");
		this.modeStatus.className = "canvas-mindmap-mode-status";
		this.modeStatus.setAttribute("aria-live", "polite");
		this.toolbar.append(this.modeButton, this.modeStatus);
		host.prepend(this.toolbar);
		this.updateToolbar();
	}

	private updateToolbar(): void {
		if (!this.modeButton || !this.modeStatus) return;
		this.modeButton.textContent = this.state.enabled ? "Mind-map: On" : "Mind-map: Off";
		this.modeButton.setAttribute("aria-pressed", this.state.enabled ? "true" : "false");
		this.modeButton.setAttribute(
			"aria-label",
			this.state.enabled ? "Disable mind-map mode" : "Enable mind-map mode",
		);
		setTooltip(this.modeButton, "Toggle mind-map mode for this Canvas");
		this.modeStatus.textContent = this.state.enabled ? "Enabled" : "Disabled";
		this.modeStatus.classList.toggle("is-enabled", this.state.enabled);
	}

	private refreshRuntime(): void {
		this.updateToolbar();
		this.updateZoomControls();
		if (!this.state.enabled || this.disposed) {
			this.cancelPointerInteraction();
			this.height.pause();
			this.revealAll();
			this.removeControls();
			return;
		}
		if (!this.adapter.capabilities.available) {
			this.notify(`Mind-map mode is unavailable: ${this.adapter.capabilities.missing.join(", ")}.`);
			return;
		}
		this.applyVisibility();
		if (this.adapter.capabilities.readOnly) {
			this.height.pause();
			this.removeControls();
		} else {
			this.refreshControls();
		}
		if (!this.adapter.capabilities.readOnly && this.state.autoHeight && !this.options.isExternalResizeOwner?.()) {
			this.height.observeAll();
			this.height.refreshAll();
		} else {
			this.height.pause();
		}
	}

	private updateZoomControls(): void {
		const controlRoot = this.view.containerEl;
		controlRoot.classList.toggle("canvas-mindmap-mode-active", this.state.enabled && !this.disposed);
		if (!this.state.enabled || this.disposed) {
			this.restoreZoomControls(controlRoot);
			return;
		}
		for (const control of Array.from(controlRoot.querySelectorAll<HTMLElement>(
			".canvas-controls .canvas-control-item, .canvas-controls button, .canvas-controls [role='button']",
		))) {
			if (this.isZoomInOrOutControl(control)) this.hideZoomControl(control);
		}
	}

	private isZoomInOrOutControl(element: HTMLElement): boolean {
		const icon = element.querySelector<HTMLElement>(
			"svg.lucide-plus, svg.lucide-minus, .lucide-plus, .lucide-minus, [data-lucide='plus'], [data-lucide='minus'], svg, [data-lucide], .svg-icon",
		);
		const semanticText = [
			element.getAttribute("aria-label"),
			element.getAttribute("title"),
			element.getAttribute("data-tooltip"),
			element.getAttribute("data-tooltip-content"),
			element.className,
			icon?.getAttribute("data-lucide"),
			icon?.getAttribute("class"),
		].filter(Boolean).join(" ").toLowerCase();
		return /(?:zoom[\s_-]*(?:in|out)|(?:zoom|canvas)[\s_-]*(?:plus|minus)|lucide[-_](?:plus|minus)|(?:^|[\s_-])(?:plus|minus)(?:$|[\s_-]))/.test(semanticText);
	}

	private hideZoomControl(element: HTMLElement): void {
		if (!this.zoomControlStates.has(element)) {
			this.zoomControlStates.set(element, {
				ariaHidden: element.getAttribute("aria-hidden"),
				tabIndex: element.getAttribute("tabindex"),
			});
		}
		element.classList.add("canvas-mindmap-zoom-hidden");
		element.setAttribute("aria-hidden", "true");
		element.setAttribute("tabindex", "-1");
	}

	private restoreZoomControls(wrapper: HTMLElement): void {
		for (const element of Array.from(wrapper.querySelectorAll<HTMLElement>(".canvas-mindmap-zoom-hidden"))) {
			element.classList.remove("canvas-mindmap-zoom-hidden");
			const previous = this.zoomControlStates.get(element);
			if (!previous || previous.ariaHidden === null) element.removeAttribute("aria-hidden");
			else element.setAttribute("aria-hidden", previous.ariaHidden);
			if (!previous || previous.tabIndex === null) element.removeAttribute("tabindex");
			else element.setAttribute("tabindex", previous.tabIndex);
		}
		wrapper.classList.remove("canvas-mindmap-mode-active");
	}

	private revealAll(): void {
		for (const node of this.adapter.nodes()) this.adapter.setNodeVisibility(node.id, true);
		for (const edge of this.adapter.getData().edges) this.adapter.setEdgeVisibility(edge.id, true);
	}

	private removeControls(): void {
		for (const control of Array.from(this.view.containerEl.querySelectorAll(".canvas-mindmap-controls"))) {
			control.remove();
		}
	}

	private applyVisibility(): void {
		const hidden = hiddenNodeIds(this.state);
		for (const node of this.adapter.nodes()) {
			this.adapter.setNodeVisibility(node.id, !hidden.has(node.id));
		}
		for (const edge of this.adapter.getData().edges) {
			this.adapter.setEdgeVisibility(
				edge.id,
				!hidden.has(edge.fromNode) && !hidden.has(edge.toNode),
			);
		}
		const selected = this.adapter.selectionIds();
		const hiddenSelection = selected.find((nodeId) => hidden.has(nodeId));
		if (hiddenSelection) {
			let visibleAncestor = parentOf(this.state, hiddenSelection);
			while (visibleAncestor && hidden.has(visibleAncestor)) {
				visibleAncestor = parentOf(this.state, visibleAncestor);
			}
			if (visibleAncestor) this.adapter.selectOnly(visibleAncestor);
		}
	}

	private refreshControls(): void {
		this.removeControls();
		if (!this.state.enabled) return;
		const hidden = hiddenNodeIds(this.state);
		const dataById = new Map(this.adapter.getData().nodes.map((node) => [node.id, node]));
		const doc = this.view.containerEl.ownerDocument;
		for (const node of this.adapter.nodes()) {
			if (hidden.has(node.id) || !node.nodeEl || dataById.get(node.id)?.type === "group") continue;
			const controls = doc.createElement("div");
			controls.className = "canvas-mindmap-controls";
			controls.setAttribute("role", "group");
			const root = rootOf(this.state, node.id);
			const layout = this.state.trees[root]?.layout ?? this.state.defaultLayout;
			if (node.id === root && layout === "balanced") {
				controls.append(
					this.controlButton("Create left child", "←", () => this.createChild(node.id, "left")),
					this.controlButton("Create right child", "→", () => this.createChild(node.id, "right")),
				);
			} else {
				controls.append(this.controlButton("Create child", "+", () => this.createChild(node.id)));
			}
			const childCount = relationChildren(this.state, node.id).length;
			if (childCount > 0 && this.state.collapsedNodeIds.includes(node.id)) {
				const count = hiddenDescendantCount(this.state, node.id);
				controls.append(
					this.controlButton(`Expand ${count} hidden card${count === 1 ? "" : "s"}`, `${count}`, () =>
						this.toggleCollapse(node.id),
					),
				);
			} else if (childCount > 0) {
				controls.append(this.controlButton("Collapse descendants", "−", () => this.toggleCollapse(node.id)));
			}
			node.nodeEl.append(controls);
		}
	}

	private controlButton(label: string, text: string, callback: () => void): HTMLButtonElement {
		const button = this.view.containerEl.ownerDocument.createElement("button");
		button.type = "button";
		button.className = "canvas-mindmap-control clickable-icon";
		button.textContent = text;
		button.setAttribute("aria-label", label);
		setTooltip(button, label);
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			callback();
		});
		return button;
	}

	private onKeyDown = (event: KeyboardEvent): void => {
		if (!this.state.enabled || this.disposed || this.adapter.capabilities.readOnly) return;
		if (isEditableTarget(event.target)) {
			if (event.key === "Escape") {
				for (const nodeId of this.adapter.selectionIds()) this.adapter.stopEditing(nodeId);
			}
			return;
		}
		const selected = this.adapter.selectionIds().filter((id) => !!this.adapter.node(id));
		if (selected.length === 0) return;
		const nodeId = selected[0];
		const node = this.adapter.node(nodeId);
		if (node?.isEditing) return;
		let handled = false;
		switch (event.key) {
			case "Tab":
				if (!event.shiftKey && selected.length === 1) handled = this.createChild(nodeId);
				break;
			case "Enter":
				if (!event.shiftKey && parentOf(this.state, nodeId) && selected.length === 1) {
					handled = this.createSibling(nodeId, "after");
				}
				break;
			case " ":
			case "Spacebar":
				if (selected.length === 1) handled = this.adapter.startEditing(nodeId);
				break;
			case "ArrowLeft":
			case "ArrowRight":
			case "ArrowUp":
			case "ArrowDown":
				if (selected.length === 1) handled = this.selectNearest(nodeId, event.key);
				break;
			case "Delete":
			case "Backspace":
				handled = this.deleteSelection(selected);
				break;
		}
		if (handled) {
			event.preventDefault();
			event.stopPropagation();
		}
	};

	private selectNearest(nodeId: NodeId, key: string): boolean {
		const data = this.adapter.getData();
		const current = data.nodes.find((node) => node.id === nodeId);
		if (!current) return false;
		const hidden = hiddenNodeIds(this.state);
		const from = center(current);
		const direction = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
		const vertical = key === "ArrowUp" ? -1 : key === "ArrowDown" ? 1 : 0;
		let best: { id: NodeId; score: number } | undefined;
		for (const node of data.nodes) {
			if (node.id === nodeId || hidden.has(node.id) || node.type === "group") continue;
			const to = center(node);
			const dx = to.x - from.x;
			const dy = to.y - from.y;
			if (direction && Math.sign(dx) !== direction) continue;
			if (vertical && Math.sign(dy) !== vertical) continue;
			const axis = direction ? Math.abs(dx) : Math.abs(dy);
			const offAxis = direction ? Math.abs(dy) : Math.abs(dx);
			const score = axis + offAxis * 1.5;
			if (!best || score < best.score) best = { id: node.id, score };
		}
		return !!best && this.adapter.selectOnly(best.id);
	}

	private nextIds(): { nodeIds: Set<string>; edgeIds: Set<string> } {
		const data = this.adapter.getData();
		return {
			nodeIds: new Set(data.nodes.map((node) => node.id)),
			edgeIds: new Set(data.edges.map((edge) => edge.id)),
		};
	}

	private currentLayout(nodeId: NodeId): LayoutMode {
		return this.state.trees[rootOf(this.state, nodeId)]?.layout ?? this.state.defaultLayout;
	}

	private branchSide(nodeId: NodeId): BranchSide | undefined {
		const root = rootOf(this.state, nodeId);
		const preference = this.state.trees[root];
		let current = nodeId;
		while (parentOf(this.state, current) && parentOf(this.state, current) !== root) {
			current = parentOf(this.state, current)!;
		}
		return preference?.branchSides[current];
	}

	private positionForChild(
		parent: CanvasNodeData,
		width: number,
		height: number,
		nodeId: NodeId,
		side?: BranchSide,
	): { x: number; y: number } {
		const gapX = this.options.horizontalGap ?? 200;
		const gapY = this.options.verticalGap ?? 50;
		const mode = this.currentLayout(parent.id);
		if (mode === "balanced") {
			const branch = side ?? this.branchSide(parent.id) ?? "right";
			return {
				x: branch === "right" ? parent.x + parent.width + gapX : parent.x - gapX - width,
				y: parent.y,
			};
		}
		if (mode === "right-to-left") return { x: parent.x - gapX - width, y: parent.y };
		if (mode === "top-to-bottom") return { x: parent.x, y: parent.y + parent.height + gapY };
		if (mode === "bottom-to-top") return { x: parent.x, y: parent.y - gapY - height };
		return { x: parent.x + parent.width + gapX, y: parent.y };
	}

	private newTextNode(
		parent: CanvasNodeData | undefined,
		id: string,
		position: { x: number; y: number },
	): CanvasNodeData {
		return {
			id,
			x: Math.round(position.x),
			y: Math.round(position.y),
			width: this.options.childWidth ?? 200,
			height: Math.max(60, this.options.childHeight ?? 100),
			type: "text",
			text: "",
			...(parent?.color ? { color: parent.color } : {}),
		};
	}

	private createEdge(
		id: string,
		parent: CanvasNodeData,
		child: CanvasNodeData,
		mode: LayoutMode,
		side?: BranchSide,
	): CanvasEdgeData {
		const branch = side ?? (child.x >= parent.x ? "right" : "left");
		if (mode === "balanced") {
			return {
				id,
				fromNode: parent.id,
				fromSide: branch === "left" ? "left" : "right",
				toNode: child.id,
				toSide: branch === "left" ? "right" : "left",
			};
		}
		if (mode === "right-to-left") {
			return { id, fromNode: parent.id, fromSide: "left", toNode: child.id, toSide: "right" };
		}
		if (mode === "top-to-bottom") {
			return { id, fromNode: parent.id, fromSide: "bottom", toNode: child.id, toSide: "top" };
		}
		if (mode === "bottom-to-top") {
			return { id, fromNode: parent.id, fromSide: "top", toNode: child.id, toSide: "bottom" };
		}
		return { id, fromNode: parent.id, fromSide: "right", toNode: child.id, toSide: "left" };
	}

	createChild(parentId: NodeId | undefined, side?: BranchSide): boolean {
		if (!this.state.enabled || this.adapter.capabilities.readOnly) return false;
		if (!parentId) return false;
		const parent = this.adapter.getData().nodes.find((node) => node.id === parentId);
		if (!parent || parent.type === "group") return false;
		const ids = this.nextIds();
		const nodeId = randomId("canvas-mindmap-node", ids.nodeIds);
		const edgeId = randomId("canvas-mindmap-edge", ids.edgeIds);
		const mode = this.currentLayout(parentId);
		const position = this.positionForChild(parent, this.options.childWidth ?? 200, this.options.childHeight ?? 100, nodeId, side);
		const child = this.newTextNode(parent, nodeId, position);
		const edge = this.createEdge(edgeId, parent, child, mode, side);
		const order = relationChildren(this.state, parentId).length;
		if (!canReparent(this.state, nodeId, parentId)) return false;
		const transaction = this.adapter.transaction("Create child", (data) => {
			data.nodes.push(child);
			data.edges.push(edge);
		});
		if (!transaction) return false;
		attachChild(this.state, nodeId, parentId, edgeId, order);
		const root = rootOf(this.state, parentId);
		ensureTreePreference(this.state, root, this.state.defaultLayout);
		if (mode === "balanced" && parentId === root) {
			const preference = this.state.trees[root];
			if (side) preference.branchSides[nodeId] = side;
			else assignMissingBalancedSides(this.adapter.getData(), this.state, root, this.options.verticalGap ?? 50);
		}
		this.commitState();
		this.finishCreation(nodeId, root);
		return true;
	}

	createSibling(nodeId: NodeId | undefined, direction: "before" | "after" = "after"): boolean {
		if (!this.state.enabled || this.adapter.capabilities.readOnly) return false;
		if (!nodeId) return false;
		const parentId = parentOf(this.state, nodeId);
		if (!parentId) return false;
		const data = this.adapter.getData();
		const source = data.nodes.find((node) => node.id === nodeId);
		const parent = data.nodes.find((node) => node.id === parentId);
		if (!source || !parent) return false;
		const ids = this.nextIds();
		const newId = randomId("canvas-mindmap-node", ids.nodeIds);
		const edgeId = randomId("canvas-mindmap-edge", ids.edgeIds);
		const mode = this.currentLayout(nodeId);
		const side = mode === "balanced" ? this.branchSide(nodeId) : undefined;
		const width = this.options.childWidth ?? 200;
		const height = Math.max(60, this.options.childHeight ?? 100);
		let position = this.positionForChild(parent, width, height, newId, side);
		if (direction === "after") {
			if (directionLayout(mode) === "horizontal") position = { x: source.x, y: source.y + source.height + (this.options.verticalGap ?? 50) };
			else position = { x: source.x + source.width + (this.options.horizontalGap ?? 200), y: source.y };
		} else if (directionLayout(mode) === "horizontal") {
			position = { x: source.x, y: source.y - height - (this.options.verticalGap ?? 50) };
		} else {
			position = { x: source.x - width - (this.options.horizontalGap ?? 200), y: source.y };
		}
		const child = this.newTextNode(parent, newId, position);
		const edge = this.createEdge(edgeId, parent, child, mode, side);
		const sourceOrder = this.state.relations[nodeId]?.order ?? relationChildren(this.state, parentId).length;
		const order = direction === "before" ? sourceOrder - 0.5 : sourceOrder + 0.5;
		const transaction = this.adapter.transaction(
			direction === "before" ? "Create previous sibling" : "Create next sibling",
			(next) => {
				next.nodes.push(child);
				next.edges.push(edge);
			},
		);
		if (!transaction) return false;
		attachChild(this.state, newId, parentId, edgeId, order);
		if (mode === "balanced" && parentId === rootOf(this.state, parentId) && side) {
			ensureTreePreference(this.state, parentId).branchSides[newId] = side;
		}
		this.commitState();
		this.finishCreation(newId, rootOf(this.state, parentId));
		return true;
	}

	createFloatingNode(): boolean {
		if (!this.state.enabled || this.adapter.capabilities.readOnly) return false;
		const ids = this.nextIds();
		const nodeId = randomId("canvas-mindmap-node", ids.nodeIds);
		const selected = this.adapter.selectionIds()[0];
		const selectedNode = selected ? this.adapter.getData().nodes.find((node) => node.id === selected) : undefined;
		const position = selectedNode
			? { x: selectedNode.x + 40, y: selectedNode.y + 40 }
			: { x: 0, y: 0 };
		const node = this.newTextNode(undefined, nodeId, position);
		const transaction = this.adapter.transaction("Create floating node", (data) => {
			data.nodes.push(node);
		});
		if (!transaction) return false;
		this.finishCreation(nodeId);
		return true;
	}

	private finishCreation(nodeId: NodeId, rootId?: NodeId): void {
		if (this.state.autoLayout && rootId) this.layoutTree(rootId);
		this.applyVisibility();
		this.refreshControls();
		this.adapter.selectOnly(nodeId);
		this.win.setTimeout(() => this.adapter.startEditing(nodeId), 0);
	}

	startEditingSelected(): boolean {
		const selected = this.adapter.selectionIds()[0];
		return !!selected && this.adapter.startEditing(selected);
	}

	stopEditingSelected(): boolean {
		const selected = this.adapter.selectionIds()[0];
		if (!selected) return false;
		this.adapter.stopEditing(selected);
		return true;
	}

	cycleSelectedLayout(): boolean {
		const selected = this.adapter.selectionIds()[0];
		if (!selected) return false;
		const current = this.currentLayout(selected);
		const modes: LayoutMode[] = [
			"left-to-right",
			"right-to-left",
			"top-to-bottom",
			"bottom-to-top",
			"balanced",
		];
		const next = modes[(modes.indexOf(current) + 1) % modes.length];
		return this.setTreeLayout(next, selected);
	}

	splitSelectedHeadings(): boolean {
		const selected = this.adapter.selectionIds()[0];
		if (!selected || !this.state.enabled) return false;
		const data = this.adapter.getData();
		const source = data.nodes.find((node) => node.id === selected);
		if (!source || source.type !== "text" || typeof source.text !== "string") return false;
		const headings = [...source.text.matchAll(/^\s*(#{1,6})\s+(.+?)\s*$/gm)].map((match) => ({
			level: match[1].length,
			text: match[2],
		}));
		if (headings.length < 2) return false;
		const nextState = cloneJson(this.state);
		const nextData = cloneJson(data);
		const nextIds = {
			nodeIds: new Set(nextData.nodes.map((node) => node.id)),
			edgeIds: new Set(nextData.edges.map((edge) => edge.id)),
		};
		const stack: Array<{ level: number; id: NodeId }> = [{ level: headings[0].level - 1, id: selected }];
		const rootLayout = this.currentLayout(selected);
		const createdIds: NodeId[] = [];
		const sourceNode = nextData.nodes.find((node) => node.id === selected)!;
		sourceNode.text = headings[0].text;
		for (const heading of headings.slice(1)) {
			while (stack.length > 1 && stack[stack.length - 1].level >= heading.level) stack.pop();
			const parentId = stack[stack.length - 1].id;
			const parent = nextData.nodes.find((node) => node.id === parentId)!;
			const newId = randomId("canvas-mindmap-node", nextIds.nodeIds);
			const edgeId = randomId("canvas-mindmap-edge", nextIds.edgeIds);
			const child = this.newTextNode(parent, newId, this.positionForChild(
				parent,
				this.options.childWidth ?? 200,
				this.options.childHeight ?? 100,
				newId,
				rootLayout === "balanced" && parentId === rootOf(nextState, selected) ? "right" : undefined,
			));
			child.text = heading.text;
			const edge = this.createEdge(edgeId, parent, child, rootLayout);
			nextData.nodes.push(child);
			nextData.edges.push(edge);
			attachChild(nextState, newId, parentId, edgeId, relationChildren(nextState, parentId).length);
			createdIds.push(newId);
			stack.push({ level: heading.level, id: newId });
		}
		if (rootLayout === "balanced") {
			assignMissingBalancedSides(nextData, nextState, rootOf(nextState, selected), this.options.verticalGap ?? 50);
		}
		const transaction = this.adapter.transaction("Split headings into mind-map cards", (next) => {
			const target = next.nodes.find((node) => node.id === selected);
			if (target) target.text = sourceNode.text;
			next.nodes.push(...nextData.nodes.filter((node) => !data.nodes.some((existing) => existing.id === node.id)));
			next.edges.push(...nextData.edges.filter((edge) => !data.edges.some((existing) => existing.id === edge.id)));
		});
		if (!transaction) return false;
		this.state = nextState;
		this.commitState();
		if (this.state.autoLayout) this.layoutTree(rootOf(this.state, selected));
		this.adapter.selectOnly(createdIds[0] ?? selected);
		this.refreshControls();
		return true;
	}

	private deleteSelection(selected: NodeId[]): boolean {
		if (selected.length === 0) return false;
		const data = this.adapter.getData();
		const deletion = deleteBranches(data, this.state, selected);
		if (deletion.nodeIds.size === 0) return false;
		let fallback: NodeId | undefined;
		for (const nodeId of selected) {
			const parentId = parentOf(this.state, nodeId);
			const siblings = parentId ? relationChildren(this.state, parentId) : [];
			const index = siblings.indexOf(nodeId);
			fallback = siblings.slice(index + 1).find((id) => !deletion.nodeIds.has(id)) ??
				siblings.slice(0, index).reverse().find((id) => !deletion.nodeIds.has(id)) ??
				(parentId && !deletion.nodeIds.has(parentId) ? parentId : undefined);
			if (fallback) break;
		}
		const transaction = this.adapter.transaction("Delete branch", (next) => {
			next.nodes = next.nodes.filter((node) => !deletion.nodeIds.has(node.id));
			next.edges = next.edges.filter((edge) => !deletion.edgeIds.has(edge.id));
		});
		if (!transaction) return false;
		applyBranchDeletion(data, this.state, deletion);
		this.commitState();
		this.applyVisibility();
		this.refreshControls();
		if (fallback && this.adapter.node(fallback)) this.adapter.selectOnly(fallback);
		else this.adapter.clearSelection();
		return true;
	}

	deleteSelectedBranch(): boolean {
		return this.deleteSelection(this.adapter.selectionIds());
	}

	toggleCollapse(nodeId: NodeId, collapsed?: boolean): boolean {
		if (!this.state.enabled || this.adapter.capabilities.readOnly) return false;
		if (relationChildren(this.state, nodeId).length === 0) return false;
		toggleCollapsed(this.state, nodeId, collapsed);
		this.commitState();
		this.applyVisibility();
		this.refreshControls();
		if (this.state.autoLayout) this.layoutTree(rootOf(this.state, nodeId));
		return true;
	}

	layoutSelectedTree(): boolean {
		const selected = this.adapter.selectionIds()[0];
		if (!selected || !this.state.enabled) return false;
		return this.layoutTree(rootOf(this.state, selected));
	}

	layoutAllTrees(): boolean {
		if (!this.state.enabled) return false;
		return this.applyLayout();
	}

	setTreeLayout(mode: LayoutMode, nodeId?: NodeId): boolean {
		const selected = nodeId ?? this.adapter.selectionIds()[0];
		if (!selected || !this.state.enabled) return false;
		const root = rootOf(this.state, selected);
		ensureTreePreference(this.state, root).layout = mode;
		if (mode === "balanced") assignMissingBalancedSides(this.adapter.getData(), this.state, root, this.options.verticalGap ?? 50);
		this.commitState();
		if (this.state.autoLayout) this.layoutTree(root);
		this.refreshControls();
		return true;
	}

	private layoutSelectedOrChanged(): void {
		if (!this.state.enabled || !this.state.autoLayout) return;
		const selected = this.adapter.selectionIds()[0];
		if (selected) this.layoutTree(rootOf(this.state, selected));
	}

	private layoutTree(rootId: NodeId): boolean {
		return this.applyLayout([rootId]);
	}

	private applyLayout(rootIds?: NodeId[]): boolean {
		const data = this.adapter.getData();
		const result = calculateLayout(data, this.state, {
			horizontalGap: this.options.horizontalGap ?? 200,
			verticalGap: this.options.verticalGap ?? 50,
			rootIds,
		});
		const allowed = new Set(result.visibleNodeIds);
		const transaction = this.adapter.transaction("Layout mind-map tree", (next) => {
			for (const node of next.nodes) {
				const position = result.positions[node.id];
				if (position && allowed.has(node.id)) {
					node.x = Math.round(position.x);
					node.y = Math.round(position.y);
				}
			}
			for (const edge of next.edges) {
				const childId = Object.entries(this.state.relations).find(([, relation]) => relation.edgeId === edge.id)?.[0];
				if (childId && result.edgeSides[edge.id]) {
					edge.fromSide = result.edgeSides[edge.id].fromSide;
					edge.toSide = result.edgeSides[edge.id].toSide;
				}
			}
		});
		if (!transaction) return false;
		this.adapter.requestFrame();
		this.applyVisibility();
		this.refreshControls();
		return true;
	}

	selectBranch(nodeId?: NodeId): boolean {
		const target = nodeId ?? this.adapter.selectionIds()[0];
		if (!target) return false;
		const hidden = hiddenNodeIds(this.state);
		const branch = descendants(this.state, target, true).filter((id) => !hidden.has(id));
		this.adapter.clearSelection();
		for (const id of branch) {
			const node = this.adapter.node(id);
			if (node) this.adapter.canvas.select?.(node);
		}
		return branch.length > 0;
	}

	applyBranchColor(color?: string, nodeId?: NodeId): boolean {
		const selected = nodeId ? [nodeId] : this.adapter.selectionIds();
		if (selected.length === 0 || !this.state.enabled) return false;
		const data = this.adapter.getData();
		const nodeMap = new Map(data.nodes.map((node) => [node.id, node]));
		const target = color ?? nodeMap.get(selected[0])?.color ?? "1";
		const branches = new Set<NodeId>();
		for (const id of selected) for (const branchId of descendants(this.state, id, true)) branches.add(branchId);
		const edgeIds = new Set<string>();
		for (const [childId, relation] of Object.entries(this.state.relations)) {
			if (branches.has(childId)) edgeIds.add(relation.edgeId);
		}
		const transaction = this.adapter.transaction("Apply branch color", (next) => {
			for (const node of next.nodes) if (branches.has(node.id)) node.color = target;
			for (const edge of next.edges) if (edgeIds.has(edge.id)) edge.color = target;
		});
		return !!transaction;
	}

	duplicateSelectedBranch(nodeId?: NodeId): boolean {
		const target = nodeId ?? this.adapter.selectionIds()[0];
		if (!target || !this.state.enabled) return false;
		const data = this.adapter.getData();
		const ids = this.nextIds();
		const result = duplicateBranch(data, this.state, target, (kind, oldId) =>
			randomId(`canvas-mindmap-${kind}`, kind === "node" ? ids.nodeIds : ids.edgeIds),
		);
		const transaction = this.adapter.transaction("Duplicate branch", (next) => {
			next.nodes.push(...result.nodes);
			next.edges.push(...result.edges);
		});
		if (!transaction) return false;
		this.state = result.state;
		this.commitState();
		this.adapter.selectOnly(result.rootId);
		this.refreshControls();
		return true;
	}

	moveBeforeSibling(nodeId?: NodeId): boolean {
		return this.reorderSelected(nodeId, "before");
	}

	moveAfterSibling(nodeId?: NodeId): boolean {
		return this.reorderSelected(nodeId, "after");
	}

	private reorderSelected(nodeId: NodeId | undefined, direction: "before" | "after"): boolean {
		const target = nodeId ?? this.adapter.selectionIds()[0];
		if (!target || !reorderSibling(this.state, target, direction)) return false;
		this.commitState();
		if (this.state.autoLayout) this.layoutTree(rootOf(this.state, target));
		return true;
	}

	reparentNode(childId: NodeId, parentId: NodeId, side?: BranchSide): boolean {
		if (!this.state.enabled || childId === parentId || !canReparent(this.state, childId, parentId)) return false;
		if (parentOf(this.state, childId) === parentId) return false;
		const data = this.adapter.getData();
		const child = data.nodes.find((node) => node.id === childId);
		const parent = data.nodes.find((node) => node.id === parentId);
		if (!child || !parent || child.type === "group" || parent.type === "group") return false;
		const oldRoot = rootOf(this.state, childId);
		const nextState = cloneJson(this.state);
		const previous = nextState.relations[childId];
		const ids = this.nextIds();
		const edgeId = previous?.edgeId ?? randomId("canvas-mindmap-edge", ids.edgeIds);
		const order = relationChildren(nextState, parentId).length;
		if (!attachChild(nextState, childId, parentId, edgeId, order)) return false;
		const mode = this.currentLayout(parentId);
		const actualSide = side ?? (child.x >= parent.x ? "right" : "left");
		const root = rootOf(nextState, parentId);
		if (mode === "balanced" && parentId === root) {
			ensureTreePreference(nextState, root).branchSides[childId] = actualSide;
		}
		for (const treeId of Object.keys(nextState.trees)) {
			if (nextState.relations[treeId]) delete nextState.trees[treeId];
		}
		const affectedRoots = [oldRoot, root].filter((rootId, index, all) =>
			all.indexOf(rootId) === index && roots(data, nextState).includes(rootId),
		);
		const plannedLayout = this.state.autoLayout
			? calculateLayout(data, nextState, {
				horizontalGap: this.options.horizontalGap ?? 200,
				verticalGap: this.options.verticalGap ?? 50,
				rootIds: affectedRoots,
			})
			: undefined;
		const transaction = this.adapter.transaction("Reparent branch", (next) => {
			const existing = next.edges.find((candidate) => candidate.id === edgeId);
			const edge = existing ?? this.createEdge(edgeId, parent, child, mode, actualSide);
			if (!existing) {
				next.edges.push(edge);
			}
			edge.fromNode = parentId;
			edge.toNode = childId;
			if (mode === "balanced") {
				edge.fromSide = actualSide === "left" ? "left" : "right";
				edge.toSide = actualSide === "left" ? "right" : "left";
			}
			if (plannedLayout) {
				const visible = new Set(plannedLayout.visibleNodeIds);
				for (const node of next.nodes) {
					const position = plannedLayout.positions[node.id];
					if (position && visible.has(node.id)) {
						node.x = Math.round(position.x);
						node.y = Math.round(position.y);
					}
				}
				for (const managed of Object.values(nextState.relations)) {
					const nextEdge = next.edges.find((candidate) => candidate.id === managed.edgeId);
					const sides = plannedLayout.edgeSides[managed.edgeId];
					if (nextEdge && sides) {
						nextEdge.fromSide = sides.fromSide;
						nextEdge.toSide = sides.toSide;
					}
				}
			}
		});
		if (!transaction) return false;
		this.state = nextState;
		this.commitState();
		this.applyVisibility();
		this.refreshControls();
		return true;
	}

	private onPointerDown = (event: PointerEvent): void => {
		if (!this.state.enabled || this.disposed || event.button !== 0) return;
		if (!isDomElement(event.target)) return;
		if (event.target.closest(".canvas-mindmap-control, .canvas-mindmap-toolbar")) return;
		if (isEditableTarget(event.target)) return;

		const nodeId = this.nodeIdFromElement(event.target);
		if (!nodeId) {
			if (!event.shiftKey && this.isCanvasBackground(event.target) && this.beginPan(event)) {
				// Claim the background gesture before native Canvas starts its
				// rectangle-selection tracker.
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
			}
			return;
		}
		if (this.adapter.capabilities.readOnly) return;
		if (event.target.closest(".canvas-node-resizer, .canvas-node-resize, [data-resize-handle]")) {
			if (!this.state.manualHeightNodeIds.includes(nodeId)) {
				this.state.manualHeightNodeIds.push(nodeId);
				this.commitState();
			}
			return;
		}

		const selected = this.adapter.selectionIds().filter((id) => !!this.adapter.node(id));
		const selectedIds = selected.includes(nodeId) ? selected : [nodeId];
		const directSelection = new Set(selectedIds);
		const branchIds = new Set<NodeId>();
		for (const selectedId of selectedIds) {
			for (const branchId of descendants(this.state, selectedId, true)) branchIds.add(branchId);
		}
		const movementRoots = new Set(
			selectedIds.filter((candidate) => !selectedIds.some((other) =>
				other !== candidate && this.isDescendantOf(candidate, other))),
		);
		const positions: Record<NodeId, { x: number; y: number }> = {};
		for (const branchId of branchIds) {
			const node = this.adapter.node(branchId);
			if (node) positions[branchId] = { x: node.x, y: node.y };
		}
		this.drag = {
			nodeId,
			pointerId: event.pointerId,
			startClient: { x: event.clientX, y: event.clientY },
			branchIds,
			directSelection,
			movementRoots,
			positions,
			modifier: event.metaKey || event.ctrlKey,
			active: false,
			canReparent: directSelection.size === 1 && directSelection.has(nodeId) &&
				movementRoots.size === 1 && movementRoots.has(nodeId),
			modifierDuringDrag: event.metaKey || event.ctrlKey,
		};
	};

	private onPointerMove = (event: PointerEvent): void => {
		if (this.pan?.pointerId === event.pointerId) {
			this.pan.lastClient = { x: event.clientX, y: event.clientY };
			if (!this.pan.active && hasPassedDragThreshold(this.pan.startClient, this.pan.lastClient)) {
				this.pan.active = true;
				this.setPanningCursor(true);
			}
			if (this.pan.active) {
				event.preventDefault();
				event.stopPropagation();
				this.schedulePanFrame();
			}
			return;
		}
		const drag = this.drag;
		if (!drag || this.disposed || this.adapter.capabilities.readOnly) return;
		if (drag.pointerId !== event.pointerId) return;
		drag.modifierDuringDrag = event.metaKey || event.ctrlKey;
		if (!drag.active && hasPassedDragThreshold(
			drag.startClient,
			{ x: event.clientX, y: event.clientY },
		)) {
			// Native Canvas owns the card's world-coordinate movement. The pointer
			// threshold is handled by Canvas, while this flag enables branch sync.
			drag.active = true;
		}
		if (!drag.active) return;
		event.preventDefault();
		if (drag.modifierDuringDrag) this.updateContactHighlight(drag, undefined);
		this.scheduleDragFrame();
	};

	private onPointerUp = (event: PointerEvent): void => {
		if (this.pan?.pointerId === event.pointerId) {
			this.flushPanFrame();
			this.cancelPan();
			event.preventDefault();
			return;
		}
		const drag = this.drag;
		if (!drag) return;
		if (drag.pointerId !== event.pointerId) return;
		this.drag = undefined;
		if (drag.frame !== undefined) this.win.cancelAnimationFrame(drag.frame);
		this.syncDraggedBranch(drag);
		drag.modifierDuringDrag = event.metaKey || event.ctrlKey;
		const targetId = drag.active && !drag.modifier && !drag.modifierDuringDrag && !event.metaKey && !event.ctrlKey
			? this.findContactTarget(drag)
			: undefined;
		this.clearContactHighlight();
		if (!this.state.enabled || !drag.active) return;
		const moved = this.branchMoved(drag);
		if (moved) this.adapter.requestSave();
		if (!drag.canReparent || this.adapter.capabilities.readOnly || drag.modifier || drag.modifierDuringDrag || event.metaKey || event.ctrlKey) return;
		if (!targetId) return;
		const side = this.balancedDropSide(drag.nodeId, targetId);
		this.reparentNode(drag.nodeId, targetId, side);
	};

	private onPointerCancel = (event: PointerEvent): void => {
		if (this.pan?.pointerId === event.pointerId) this.cancelPan();
		if (this.drag?.pointerId === event.pointerId) {
			if (this.drag.frame !== undefined) this.win.cancelAnimationFrame(this.drag.frame);
			this.drag = undefined;
		}
		this.clearContactHighlight();
	};

	private onWindowBlur = (): void => {
		this.cancelPointerInteraction();
	};

	private beginPan(event: PointerEvent): boolean {
		const startViewport = this.adapter.viewport();
		if (!startViewport) {
			if (!this.panNoticeShown) {
				this.panNoticeShown = true;
				this.notify("Mouse panning is unavailable in this Canvas version; native Canvas navigation remains available.");
			}
			return false;
		}
		this.pan = {
			pointerId: event.pointerId,
			captureTarget: this.keyTarget as Element & { releasePointerCapture?: (pointerId: number) => void },
			startClient: { x: event.clientX, y: event.clientY },
			lastClient: { x: event.clientX, y: event.clientY },
			startViewport,
			active: false,
		};
		const captureTarget = this.keyTarget as (Element & { setPointerCapture?: (pointerId: number) => void }) | undefined;
		captureTarget?.setPointerCapture?.(event.pointerId);
		return true;
	}

	private schedulePanFrame(): void {
		if (!this.pan || this.pan.frame !== undefined) return;
		this.pan.frame = this.win.requestAnimationFrame(() => {
			if (!this.pan) return;
			this.pan.frame = undefined;
			const delta = {
				x: this.pan.lastClient.x - this.pan.startClient.x,
				y: this.pan.lastClient.y - this.pan.startClient.y,
			};
			this.adapter.setViewport(panViewport(this.pan.startViewport, delta));
		});
	}

	private flushPanFrame(): void {
		if (!this.pan) return;
		if (this.pan.frame !== undefined) this.win.cancelAnimationFrame(this.pan.frame);
		this.pan.frame = undefined;
		const delta = {
			x: this.pan.lastClient.x - this.pan.startClient.x,
			y: this.pan.lastClient.y - this.pan.startClient.y,
		};
		this.adapter.setViewport(panViewport(this.pan.startViewport, delta));
	}

	private scheduleDragFrame(): void {
		if (!this.drag || this.drag.frame !== undefined) return;
		this.drag.frame = this.win.requestAnimationFrame(() => {
			if (!this.drag) return;
			this.drag.frame = undefined;
			this.syncDraggedBranch(this.drag);
			this.updateContactHighlight(this.drag, this.findContactTarget(this.drag));
		});
	}

	private syncDraggedBranch(drag: DragSnapshot): void {
		for (const branchId of drag.branchIds) {
			if (drag.directSelection.has(branchId)) continue;
			const owner = [...drag.movementRoots].find((root) => branchId === root || this.isDescendantOf(branchId, root));
			if (!owner) continue;
			const root = this.adapter.node(owner);
			const originalRoot = drag.positions[owner];
			const original = drag.positions[branchId];
			if (!root || !originalRoot || !original) continue;
			this.adapter.moveNode(branchId, {
				x: original.x + root.x - originalRoot.x,
				y: original.y + root.y - originalRoot.y,
			});
		}
		this.adapter.requestFrame();
	}

	private branchMoved(drag: DragSnapshot): boolean {
		return [...drag.movementRoots].some((rootId) => {
			const current = this.adapter.node(rootId);
			const original = drag.positions[rootId];
			return !!current && !!original && (Math.abs(current.x - original.x) > 0.5 || Math.abs(current.y - original.y) > 0.5);
		});
	}

	private isDescendantOf(nodeId: NodeId, ancestorId: NodeId): boolean {
		let current = parentOf(this.state, nodeId);
		const visited = new Set<NodeId>();
		while (current && !visited.has(current)) {
			if (current === ancestorId) return true;
			visited.add(current);
			current = parentOf(this.state, current);
		}
		return false;
	}

	private findContactTarget(drag: DragSnapshot): NodeId | undefined {
		if (!drag.canReparent || drag.modifier || drag.modifierDuringDrag || !this.state.enabled) return undefined;
		const draggedBounds = this.nodeBounds(drag.nodeId);
		if (!draggedBounds) return undefined;
		const hidden = hiddenNodeIds(this.state);
		const dataById = new Map(this.adapter.getData().nodes.map((node) => [node.id, node]));
		const candidates = this.adapter.nodes()
			.filter((node) => node.id !== drag.nodeId && dataById.get(node.id)?.type !== "group" && !drag.branchIds.has(node.id) && !hidden.has(node.id))
			.map((node) => {
				const bounds = this.nodeBounds(node.id);
				return bounds ? { id: node.id, bounds, eligible: canReparent(this.state, drag.nodeId, node.id) } : undefined;
			})
			.filter((candidate): candidate is { id: NodeId; bounds: Rect; eligible: boolean } => !!candidate);
		return findContactParent(draggedBounds, candidates, drag.branchIds);
	}

	private updateContactHighlight(drag: DragSnapshot, targetId?: NodeId): void {
		if (targetId === drag.contactTargetId) {
			if (targetId) this.adapter.node(targetId)?.nodeEl?.classList.add("canvas-mindmap-drop-target");
			return;
		}
		this.clearContactHighlight();
		drag.contactTargetId = targetId;
		if (!targetId) return;
		const element = this.adapter.node(targetId)?.nodeEl;
		if (!element) return;
		element.classList.add("canvas-mindmap-drop-target");
		element.setAttribute("data-canvas-mindmap-drop-target", "true");
	}

	private clearContactHighlight(): void {
		const wrapper = this.adapter.canvas.wrapperEl ?? this.view.containerEl;
		for (const element of Array.from(wrapper.querySelectorAll<HTMLElement>(".canvas-mindmap-drop-target"))) {
			element.classList.remove("canvas-mindmap-drop-target");
			element.removeAttribute("data-canvas-mindmap-drop-target");
		}
	}

	private nodeBounds(nodeId: NodeId): Rect | undefined {
		const node = this.adapter.node(nodeId);
		if (!node) return undefined;
		return {
			left: node.x,
			top: node.y,
			right: node.x + node.width,
			bottom: node.y + node.height,
		};
	}

	private balancedDropSide(childId: NodeId, parentId: NodeId): BranchSide | undefined {
		if (this.currentLayout(parentId) !== "balanced") return undefined;
		const child = this.nodeBounds(childId);
		const parent = this.nodeBounds(parentId);
		if (!child || !parent) return undefined;
		return (child.left + child.right) / 2 < (parent.left + parent.right) / 2 ? "left" : "right";
	}

	private setPanningCursor(active: boolean): void {
		const wrapper = this.adapter.canvas.wrapperEl ?? this.view.containerEl;
		wrapper.classList.toggle("canvas-mindmap-panning", active);
	}

	private cancelPan(): void {
		if (this.pan?.frame !== undefined) this.win.cancelAnimationFrame(this.pan.frame);
		try {
			this.pan?.captureTarget?.releasePointerCapture?.(this.pan.pointerId);
		} catch {
			// The pointer may already have been released by the browser.
		}
		this.pan = undefined;
		this.setPanningCursor(false);
	}

	private cancelPointerInteraction(): void {
		this.cancelPan();
		if (this.drag?.frame !== undefined) this.win.cancelAnimationFrame(this.drag.frame);
		this.drag = undefined;
		this.clearContactHighlight();
	}

	private isCanvasBackground(element: Element): boolean {
		return !element.closest(
			".canvas-node, .canvas-edge, [data-edge-id], .canvas-node-resizer, .canvas-node-resize, [data-resize-handle], .canvas-controls, .canvas-mindmap-control, .canvas-mindmap-toolbar, input, textarea, select, button, [role='button'], [contenteditable='true']",
		);
	}

	private nodeIdFromElement(element: Element): NodeId | undefined {
		const explicit = element.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
		if (explicit && this.adapter.node(explicit)) return explicit;
		for (const node of this.adapter.nodes()) if (node.nodeEl?.contains(element)) return node.id;
		return undefined;
	}

	showNodeMenu(nodeId: NodeId, event?: MouseEvent): void {
		if (!this.state.enabled) return;
		const menu = new Menu();
		menu.addItem((item: any) => item.setTitle("Create child").setIcon("plus").onClick(() => this.createChild(nodeId)));
		if (parentOf(this.state, nodeId)) {
			menu.addItem((item: any) => item.setTitle("Create next sibling").setIcon("plus").onClick(() => this.createSibling(nodeId, "after")));
			menu.addItem((item: any) => item.setTitle("Create previous sibling").setIcon("plus").onClick(() => this.createSibling(nodeId, "before")));
			menu.addItem((item: any) => item.setTitle("Move before sibling").onClick(() => this.moveBeforeSibling(nodeId)));
			menu.addItem((item: any) => item.setTitle("Move after sibling").onClick(() => this.moveAfterSibling(nodeId)));
		}
		menu.addItem((item: any) => item.setTitle("Select branch").setIcon("select").onClick(() => this.selectBranch(nodeId)));
		if (relationChildren(this.state, nodeId).length > 0) {
			menu.addItem((item: any) => item.setTitle(this.state.collapsedNodeIds.includes(nodeId) ? "Expand branch" : "Collapse branch").setIcon("chevrons-down-up").onClick(() => this.toggleCollapse(nodeId)));
		}
		for (const [mode, label] of [
			["left-to-right", "Left to right"],
			["right-to-left", "Right to left"],
			["top-to-bottom", "Top to bottom"],
			["bottom-to-top", "Bottom to top"],
			["balanced", "Balanced left/right"],
		] as const) {
			menu.addItem((item: any) => item.setTitle(`Layout: ${label}`).setIcon("layout-dashboard").onClick(() => this.setTreeLayout(mode, nodeId)));
		}
		menu.addItem((item: any) => item.setTitle("Duplicate branch").setIcon("copy").onClick(() => this.duplicateSelectedBranch(nodeId)));
		menu.addItem((item: any) => item.setTitle("Delete branch").setIcon("trash").onClick(() => this.deleteSelection([nodeId])));
		menu.addItem((item: any) => item.setTitle("Layout this tree").setIcon("layout-dashboard").onClick(() => this.layoutTree(rootOf(this.state, nodeId))));
		menu.addItem((item: any) => item.setTitle("Apply branch color").setIcon("palette").onClick(() => this.applyBranchColor(undefined, nodeId)));
		if (this.adapter.node(nodeId)?.type === "text") {
			menu.addItem((item: any) => item.setTitle("Toggle automatic height").setIcon("move-vertical").onClick(() => {
				const manual = !this.state.manualHeightNodeIds.includes(nodeId);
				this.state.manualHeightNodeIds = this.state.manualHeightNodeIds.filter((id) => id !== nodeId);
				if (manual) this.state.manualHeightNodeIds.push(nodeId);
				this.commitState();
				if (!manual) this.height.schedule(nodeId, true);
			}));
		}
		if (event) menu.showAtMouseEvent(event);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelPointerInteraction();
		this.revealAll();
		this.removeControls();
		this.restoreZoomControls(this.view.containerEl);
		this.height.dispose();
		this.keyTarget?.removeEventListener("keydown", this.onKeyDown, true);
		this.keyTarget?.removeEventListener("pointerdown", this.onPointerDown, true);
		this.win.removeEventListener("pointermove", this.onPointerMove, true);
		this.win.removeEventListener("pointerup", this.onPointerUp, true);
		this.win.removeEventListener("pointercancel", this.onPointerCancel, true);
		this.win.removeEventListener("blur", this.onWindowBlur);
		if (this.domSyncTimer) clearTimeout(this.domSyncTimer);
		this.domObserver?.disconnect();
		this.toolbar?.remove();
	}
}
