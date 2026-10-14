import { Menu, Notice, setIcon, setTooltip } from "obsidian";
import {
	CanvasAdapter,
	CanvasLike,
	CanvasNodeLike,
	CanvasViewport,
} from "./canvas-adapter";
import { applyCanvasColors, branchColorTargets } from "./color-actions";
import { PASTEL_COLORS } from "./colors";
import { ColorApplyResult, ColorPaletteHandle, openColorPalette } from "./color-palette";
import { HeightController } from "./height-controller";
import { NativeColorPickerHandle, enhanceNativeColorPicker } from "./native-color-picker";
import {
	findContactParent,
	findCanvasControlContainers,
	findCanvasHistoryAnchor,
	hasPassedDragThreshold,
	hasStructuralCanvasMutation,
	isCanvasInteractionOverlay,
	panViewport,
	Rect,
} from "./interaction";
import {
	assignMissingBalancedSides,
	calculateLayout,
	chooseStraightConnectorSides,
	layoutRootsForSelection,
} from "./layout";
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
	hiddenNodeIds,
	parentOf,
	relationChildren,
	replaceManagedEdge,
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
}

interface DragSnapshot {
	nodeId: NodeId;
	pointerId: number;
	startClient: { x: number; y: number };
	beforeData: CanvasData;
	beforeState: CanvasMindMapState;
	branchIds: Set<NodeId>;
	directSelection: Set<NodeId>;
	movementRoots: Set<NodeId>;
	positions: Record<NodeId, { x: number; y: number }>;
	modifier: boolean;
	active: boolean;
	canReparent: boolean;
	modifierDuringDrag: boolean;
	nativeLifecycle?: boolean;
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

interface HistoryBaseline {
	beforeData: CanvasData;
	beforeState: CanvasMindMapState;
}

interface ColorPaletteTarget {
	label: string;
	nodeIds: ReadonlySet<NodeId>;
	edgeIds: ReadonlySet<string>;
}

type LayoutOutcome = "changed" | "unchanged" | "failed";

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
	private keyTarget?: HTMLElement;
	private domObserver?: MutationObserver;
	private domSyncTimer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private drag?: DragSnapshot;
	private pan?: PanSnapshot;
	private panNoticeShown = false;
	private readonly zoomControlStates = new WeakMap<HTMLElement, { ariaHidden: string | null; tabIndex: string | null }>();
	private arrangeControl?: HTMLButtonElement;
	private readonly historyStates = new Map<string, CanvasMindMapState>();
	private readonly height: HeightController;
	private colorPalette?: ColorPaletteHandle;
	private readonly nativeColorPickers = new Map<HTMLElement, NativeColorPickerHandle>();
	private removeNativeDragHook?: () => void;
	private removeDataImportHook?: () => void;
	private historySyncTimer?: number;
	private lastCanvasStructureKey?: string;
	private layoutOutcome: LayoutOutcome = "unchanged";

	private get win(): Window {
		return this.view.containerEl.ownerDocument.defaultView ?? window;
	}

	constructor(options: ControllerOptions) {
		this.options = options;
		this.view = options.view;
		this.state = { ...cloneJson(options.state), enabled: true };
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
		this.keyTarget = this.adapter.canvas.wrapperEl ?? this.view.containerEl;
		this.removeNativeDragHook = this.adapter.observeSelectionDrag({
			onStart: (event, node) => this.onNativeDragStart(event, node),
			onMove: (event) => this.onNativeDragMove(event),
			onEnd: (event) => this.onNativeDragEnd(event),
			onCancel: (event) => this.onNativeDragCancel(event),
		});
		this.lastCanvasStructureKey = this.canvasStructureKey(this.adapter.getData());
		this.removeDataImportHook = this.adapter.observeDataImport((data) => this.scheduleHistorySync(data));
		this.keyTarget.addEventListener("keydown", this.onKeyDown, true);
		this.keyTarget.addEventListener("pointerdown", this.onPointerDown, true);
		this.win.addEventListener("pointermove", this.onPointerMove, true);
		this.win.addEventListener("pointerup", this.onPointerUp, true);
		this.win.addEventListener("pointercancel", this.onPointerCancel, true);
		this.win.addEventListener("blur", this.onWindowBlur);
		this.observeCanvasDom();
		this.syncNativeColorPickers();
		this.refreshRuntime();
	}

	private observeCanvasDom(): void {
		if (typeof MutationObserver === "undefined") return;
		const observeHosts = (): void => {
			if (!this.domObserver) return;
			for (const target of this.canvasHostRoots()) {
				this.domObserver.observe(target, { childList: true, subtree: true });
			}
		};
		this.domObserver = new MutationObserver((records) => {
			this.syncNativeColorPickers();
			if (!hasStructuralCanvasMutation(records)) return;
			if (!this.state.enabled || this.domSyncTimer) return;
			this.domSyncTimer = setTimeout(() => {
				this.domSyncTimer = undefined;
				if (!this.domObserver || this.disposed || !this.state.enabled) return;
				this.domObserver.disconnect();
				this.reconcileStateWithCanvas();
				this.updateZoomControls();
				this.applyVisibility();
				this.refreshControls();
				observeHosts();
			}, 0);
		});
		observeHosts();
	}

	private nativeColorSubmenus(): HTMLElement[] {
		const result: HTMLElement[] = [];
		const seen = new Set<HTMLElement>();
		for (const root of this.canvasHostRoots()) {
			const candidates = [
				...(root.matches(".canvas-submenu") ? [root] : []),
				...Array.from(root.querySelectorAll<HTMLElement>(".canvas-submenu")),
			];
			for (const submenu of candidates) {
				if (seen.has(submenu) ||
					!submenu.querySelector(".canvas-color-picker-item") ||
					!submenu.querySelector(".canvas-color-picker-custom input[type='color']")) continue;
				seen.add(submenu);
				result.push(submenu);
			}
		}
		return result;
	}

	private selectionColorTarget(): ColorPaletteTarget {
		const selected = new Set(this.adapter.selectionIds());
		const data = this.adapter.getData();
		return {
			label: "Canvas colours",
			nodeIds: new Set(data.nodes.filter((node) => selected.has(node.id)).map((node) => node.id)),
			edgeIds: new Set(data.edges.filter((edge) => selected.has(edge.id)).map((edge) => edge.id)),
		};
	}

	private closeNativeColorPicker(submenu: HTMLElement): void {
		const menu = submenu.closest<HTMLElement>(".canvas-menu");
		const paletteButton = menu
			? Array.from(menu.querySelectorAll<HTMLElement>("button, .clickable-icon, [role='button']"))
				.find((element) => {
					const icons = Array.from(element.querySelectorAll<HTMLElement>("svg, [data-lucide], .svg-icon"));
					const semantic = [
						element.getAttribute("aria-label"),
						element.getAttribute("title"),
						element.getAttribute("data-tooltip"),
						element.className,
						...icons.map((icon) => `${icon.getAttribute("data-lucide") ?? ""} ${icon.className}`),
					].filter(Boolean).join(" ").toLowerCase();
					return semantic.includes("palette") || semantic.includes("color") || semantic.includes("colour");
				})
			: undefined;
		if (paletteButton && typeof (paletteButton as HTMLElement).click === "function") {
			paletteButton.click();
			return;
		}
		submenu.remove();
	}

	private syncNativeColorPickers(): void {
		if (this.disposed || !this.state.enabled || this.adapter.capabilities.readOnly) {
			for (const handle of this.nativeColorPickers.values()) handle.dispose();
			this.nativeColorPickers.clear();
			return;
		}
		const submenus = new Set(this.nativeColorSubmenus());
		for (const [submenu, handle] of this.nativeColorPickers) {
			if (!submenus.has(submenu) || !submenu.isConnected) {
				handle.dispose();
				this.nativeColorPickers.delete(submenu);
			}
		}
		const target = this.selectionColorTarget();
		let currentColor: string | undefined;
		try {
			currentColor = this.targetColor(target);
		} catch {
			currentColor = undefined;
		}
		for (const submenu of submenus) {
			if (this.nativeColorPickers.has(submenu)) continue;
			const handle = enhanceNativeColorPicker({
				document: submenu.ownerDocument,
				window: submenu.ownerDocument.defaultView ?? this.win,
				submenu,
				colors: PASTEL_COLORS,
				currentColor,
				apply: (color) => this.applyColorTarget(target, color, `Canvas colour: ${PASTEL_COLORS.find((pastel) => pastel.hex === color)?.label ?? "Pastel"}`),
				reset: () => this.applyColorTarget(target, undefined, "Canvas colour: Theme default"),
				closeNative: () => this.closeNativeColorPicker(submenu),
			});
			if (handle) this.nativeColorPickers.set(submenu, handle);
		}
	}

	private reconcileStateWithCanvas(): void {
		const data = this.adapter.getData();
		const knownState = this.historyStates.get(JSON.stringify(data));
		if (knownState) {
			if (JSON.stringify(knownState) !== JSON.stringify(this.state)) {
				this.state = cloneJson(knownState);
				this.commitState();
				this.applyVisibility();
				this.refreshControls();
			}
			return;
		}
		const clean = sanitizeState(data, this.state, this.state.defaultLayout);
		if (JSON.stringify(clean) === JSON.stringify(this.state)) return;
		this.state = clean;
		this.commitState();
	}

	private rememberHistoryStates(
		beforeData: CanvasData,
		beforeState: CanvasMindMapState,
		afterData: CanvasData,
		afterState: CanvasMindMapState,
	): void {
		this.historyStates.set(JSON.stringify(beforeData), cloneJson(beforeState));
		this.historyStates.set(JSON.stringify(afterData), cloneJson(afterState));
	}

	private canvasStructureKey(data: CanvasData): string {
		return JSON.stringify({
			nodes: data.nodes
				.map((node) => ({
					id: node.id,
					type: node.type,
					x: node.x,
					y: node.y,
					width: node.width,
					height: node.height,
				}))
				.sort((first, second) => first.id.localeCompare(second.id)),
			edges: data.edges
				.map((edge) => ({
					id: edge.id,
					fromNode: edge.fromNode,
					fromSide: edge.fromSide,
					toNode: edge.toNode,
					toSide: edge.toSide,
				}))
				.sort((first, second) => first.id.localeCompare(second.id)),
		});
	}

	private scheduleHistorySync(data?: CanvasData): void {
		const structureKey = this.canvasStructureKey(data ?? this.adapter.getData());
		if (structureKey === this.lastCanvasStructureKey) return;
		this.lastCanvasStructureKey = structureKey;
		if (this.historySyncTimer) this.win.clearTimeout(this.historySyncTimer);
		this.historySyncTimer = this.win.setTimeout(() => {
			this.historySyncTimer = undefined;
			if (this.disposed) return;
			this.reconcileStateWithCanvas();
			this.updateZoomControls();
			this.applyVisibility();
			this.refreshControls();
		}, 0);
	}

	refreshFromState(state: CanvasMindMapState): void {
		if (this.disposed) return;
		this.state = { ...cloneJson(state), enabled: true };
		this.refreshRuntime();
	}

	getState(): CanvasMindMapState {
		return cloneJson(this.state);
	}

	isEnabled(): boolean {
		return this.state.enabled;
	}

	private notify(message: string): void {
		if (this.options.notify) this.options.notify(message);
		else new Notice(message);
	}

	private commitState(): void {
		this.options.onStateChange(cloneJson(this.state));
	}

	private refreshRuntime(): void {
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
		if (!this.state.enabled || this.disposed || !this.adapter.capabilities.available || this.adapter.capabilities.readOnly) {
			this.restoreZoomControls(this.canvasHostRoots());
			this.removeArrangeControl();
			return;
		}
		for (const controls of this.canvasControlContainers()) {
			for (const control of Array.from(controls.querySelectorAll<HTMLElement>(
				".canvas-control-item, button, [role='button']",
			))) {
				if (this.isZoomInOrOutControl(control)) this.hideZoomControl(control);
			}
		}
		this.ensureArrangeControl();
	}

	private canvasHostRoots(): HTMLElement[] {
		const roots: HTMLElement[] = [];
		const seen = new Set<HTMLElement>();
		for (const root of [this.adapter.canvas.wrapperEl, this.view.contentEl, this.view.containerEl]) {
			if (!root || seen.has(root)) continue;
			seen.add(root);
			roots.push(root);
		}
		return roots;
	}

	private canvasControlContainers(): HTMLElement[] {
		return findCanvasControlContainers(this.canvasHostRoots());
	}

	private ensureArrangeControl(): void {
		const controls = this.canvasControlContainers()[0];
		if (!controls) {
			this.removeArrangeControl();
			return;
		}
		const existing = controls.querySelector<HTMLButtonElement>(
			"[data-canvas-mindmap-action='arrange']",
		);
		if (existing) {
			this.arrangeControl = existing;
			this.positionArrangeControl(controls, existing);
			return;
		}
		this.removeArrangeControl();
		const button = controls.ownerDocument.createElement("button");
		button.type = "button";
		button.className = "canvas-control-item canvas-mindmap-arrange-control clickable-icon";
		button.dataset.canvasMindmapAction = "arrange";
		button.setAttribute("aria-label", "Arrange mind map");
		setTooltip(button, "Arrange mind map");
		setIcon(button, "git-branch");
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.arrangeNeatly();
		});
		this.positionArrangeControl(controls, button);
		this.arrangeControl = button;
	}

	private positionArrangeControl(controls: HTMLElement, button: HTMLButtonElement): void {
		const historyAnchor = findCanvasHistoryAnchor(controls);
		if (historyAnchor) {
			if (historyAnchor.nextElementSibling !== button) {
				historyAnchor.insertAdjacentElement("afterend", button);
			}
			return;
		}
		if (controls.lastElementChild !== button) controls.append(button);
	}

	private removeArrangeControl(): void {
		this.arrangeControl?.remove();
		this.arrangeControl = undefined;
		for (const root of this.canvasHostRoots()) {
			for (const control of Array.from(root.querySelectorAll(
				"[data-canvas-mindmap-action='arrange']",
			))) control.remove();
		}
	}

	private isZoomInOrOutControl(element: HTMLElement): boolean {
		// Obsidian's native sidebar controls are div.canvas-control-item elements
		// containing Lucide icons. Check the icon identity first so localized
		// labels and unrelated plugin buttons cannot affect the result.
		const icons = Array.from(element.querySelectorAll<HTMLElement>(
			"svg, [data-lucide], .svg-icon",
		));
		if (icons.some((icon) => {
			const iconName = icon.getAttribute("data-lucide")?.toLowerCase();
			return iconName === "plus" || iconName === "minus" ||
				icon.classList.contains("lucide-plus") || icon.classList.contains("lucide-minus");
		})) return true;

		const semanticText = [
			element.getAttribute("aria-label"),
			element.getAttribute("title"),
			element.getAttribute("data-tooltip"),
			element.getAttribute("data-tooltip-content"),
			element.className,
			...icons.map((icon) => `${icon.getAttribute("data-lucide") ?? ""} ${icon.getAttribute("class") ?? ""}`),
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

	private restoreZoomControls(roots: readonly HTMLElement[]): void {
		const restored = new Set<HTMLElement>();
		for (const root of roots) {
			for (const element of Array.from(root.querySelectorAll<HTMLElement>(".canvas-mindmap-zoom-hidden"))) {
				if (restored.has(element)) continue;
				restored.add(element);
				element.classList.remove("canvas-mindmap-zoom-hidden");
				const previous = this.zoomControlStates.get(element);
				if (!previous || previous.ariaHidden === null) element.removeAttribute("aria-hidden");
				else element.setAttribute("aria-hidden", previous.ariaHidden);
				if (!previous || previous.tabIndex === null) element.removeAttribute("tabindex");
				else element.setAttribute("tabindex", previous.tabIndex);
			}
		}
		for (const root of roots) root.classList.remove("canvas-mindmap-mode-active");
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
	}

	private onKeyDown = (event: KeyboardEvent): void => {
		if (!this.state.enabled || this.disposed || this.adapter.capabilities.readOnly) return;
		if (isEditableTarget(event.target)) {
			if (event.key === "Escape") {
				let stopped = false;
				for (const node of this.adapter.nodes()) {
					if (node.isEditing) stopped = this.adapter.stopEditing(node.id) || stopped;
				}
				if (stopped) {
					this.adapter.focusCanvas();
					event.preventDefault();
					event.stopPropagation();
				}
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
	): CanvasEdgeData {
		const sides = chooseStraightConnectorSides(parent, child);
		return {
			id,
			fromNode: parent.id,
			toNode: child.id,
			...sides,
			...(parent.color ? { color: parent.color } : {}),
		};
	}

	private updateManagedConnectorSides(
		data: CanvasData,
		state: CanvasMindMapState,
		affectedNodeIds: ReadonlySet<NodeId>,
	): boolean {
		const nodes = new Map(data.nodes.map((node) => [node.id, node]));
		let changed = false;
		for (const [childId, relation] of Object.entries(state.relations)) {
			if (!affectedNodeIds.has(childId)) continue;
			const parent = nodes.get(relation.parentId);
			const child = nodes.get(childId);
			const edge = data.edges.find((candidate) => candidate.id === relation.edgeId);
			if (!parent || !child || !edge) continue;
			const sides = chooseStraightConnectorSides(parent, child);
			if (edge.fromSide === sides.fromSide && edge.toSide === sides.toSide) continue;
			edge.fromSide = sides.fromSide;
			edge.toSide = sides.toSide;
			changed = true;
		}
		return changed;
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
		const edge = this.createEdge(edgeId, parent, child);
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
		const edge = this.createEdge(edgeId, parent, child);
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
		const stopped = this.adapter.stopEditing(selected);
		if (stopped) this.adapter.focusCanvas();
		return stopped;
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
			const edge = this.createEdge(edgeId, parent, child);
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

	arrangeNeatly(): boolean {
		if (!this.state.enabled || this.adapter.capabilities.readOnly) {
			this.notify("Arrange mind map is unavailable in this Canvas.");
			return false;
		}
		const data = this.adapter.getData();
		const selectedIds = this.adapter.selectionIds();
		const selectedCardIds = selectedIds.filter((id) => data.nodes.some((node) => node.id === id));
		const rootsInSelection = layoutRootsForSelection(selectedCardIds, data, this.state);
		const connectedRoots = rootsInSelection.filter((rootId) => relationChildren(this.state, rootId).length > 0);
		if (selectedCardIds.length > 0 && connectedRoots.length === 0) {
			this.notify("This card has no connected branch to arrange.");
			return false;
		}
		const arranged = this.applyLayout(
			selectedCardIds.length > 0 ? connectedRoots : undefined,
			"Arrange mind map",
		);
		if (arranged) this.notify("Mind map arranged.");
		else if (this.layoutOutcome === "failed") this.notify("Mind map could not be arranged because Canvas rejected the update.");
		else this.notify("Mind map is already arranged.");
		return arranged;
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

	private applyLayout(rootIds?: NodeId[], label = "Layout mind-map tree"): boolean {
		this.layoutOutcome = "unchanged";
		const data = this.adapter.getData();
		const result = calculateLayout(data, this.state, {
			horizontalGap: this.options.horizontalGap ?? 200,
			verticalGap: this.options.verticalGap ?? 50,
			rootIds,
		});
		const allowed = new Set(result.visibleNodeIds);
		const childByEdge = new Map(
			Object.entries(this.state.relations).map(([childId, relation]) => [relation.edgeId, childId]),
		);
		let changed = false;
		for (const node of data.nodes) {
			const position = result.positions[node.id];
			if (!position || !allowed.has(node.id)) continue;
			const x = Math.round(position.x);
			const y = Math.round(position.y);
			if (node.x !== x || node.y !== y) changed = true;
		}
		for (const edge of data.edges) {
			const sides = result.edgeSides[edge.id];
			if (!childByEdge.has(edge.id) || !sides) continue;
			if (edge.fromSide !== sides.fromSide || edge.toSide !== sides.toSide) changed = true;
		}
		if (!changed) return false;
		const transaction = this.adapter.transaction(label, (next) => {
			for (const node of next.nodes) {
				const position = result.positions[node.id];
				if (position && allowed.has(node.id)) {
					node.x = Math.round(position.x);
					node.y = Math.round(position.y);
				}
			}
			for (const edge of next.edges) {
				if (childByEdge.has(edge.id) && result.edgeSides[edge.id]) {
					edge.fromSide = result.edgeSides[edge.id].fromSide;
					edge.toSide = result.edgeSides[edge.id].toSide;
				}
			}
		}, (_before, _requested, after) => {
			for (const node of after.nodes) {
				const position = result.positions[node.id];
				if (position && allowed.has(node.id) &&
					(node.x !== Math.round(position.x) || node.y !== Math.round(position.y))) return false;
			}
			for (const edge of after.edges) {
				const sides = result.edgeSides[edge.id];
				if (sides && childByEdge.has(edge.id) &&
					(edge.fromSide !== sides.fromSide || edge.toSide !== sides.toSide)) return false;
			}
			return true;
		});
		if (!transaction) {
			this.layoutOutcome = changed ? "failed" : "unchanged";
			return false;
		}
		this.layoutOutcome = "changed";
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

	private applyColorTarget(
		target: ColorPaletteTarget,
		color: string | undefined,
		label: string,
	): ColorApplyResult {
		if (!this.state.enabled) {
			return {
				status: "failed",
				reason: "unsupported",
				message: "Mind-map mode is not enabled for this Canvas.",
			};
		}
		if (this.adapter.capabilities.readOnly) {
			return {
				status: "failed",
				reason: "read-only",
				message: "This Canvas is read-only.",
			};
		}
		if (!this.adapter.capabilities.available) {
			return {
				status: "failed",
				reason: "unsupported",
				message: "This Canvas version does not support colour changes.",
			};
		}
		if (target.nodeIds.size === 0 && target.edgeIds.size === 0) {
			return {
				status: "failed",
				reason: "target-missing",
				message: "The selected Canvas target is no longer available.",
			};
		}

		try {
			const current = this.adapter.getData();
			const nodeIds = new Set(current.nodes.map((node) => node.id));
			const edgeIds = new Set(current.edges.map((edge) => edge.id));
			if ([...target.nodeIds].some((nodeId) => !nodeIds.has(nodeId)) ||
				[...target.edgeIds].some((edgeId) => !edgeIds.has(edgeId))) {
				return {
					status: "failed",
					reason: "target-missing",
					message: "The selected Canvas target is no longer available. Reopen the menu and try again.",
				};
			}

			let changed = false;
			const transaction = this.adapter.transaction(
				label,
				(next) => changed = applyCanvasColors(next, {
					nodeIds: target.nodeIds,
					edgeIds: target.edgeIds,
					color,
				}),
				(_before, _requested, after) => {
					const nodes = new Map(after.nodes.map((node) => [node.id, node]));
					const edges = new Map(after.edges.map((edge) => [edge.id, edge]));
					for (const nodeId of target.nodeIds) {
						if (nodes.get(nodeId)?.color !== color) return false;
					}
					for (const edgeId of target.edgeIds) {
						if (edges.get(edgeId)?.color !== color) return false;
					}
					return true;
				},
			);
			if (!changed) return { status: "unchanged" };
			if (!transaction) {
				return {
					status: "failed",
					reason: "write-rejected",
					message: "Canvas rejected the colour change. Reopen the menu and try again.",
				};
			}
			this.adapter.requestFrame();
			return { status: "applied" };
		} catch {
			return {
				status: "failed",
				reason: "runtime-error",
				message: "The colour could not be applied. Reopen the menu and try again.",
			};
		}
	}

	private targetColor(target: ColorPaletteTarget): string | undefined {
		const data = this.adapter.getData();
		const colors: Array<string | undefined> = [];
		for (const node of data.nodes) if (target.nodeIds.has(node.id)) colors.push(node.color);
		for (const edge of data.edges) if (target.edgeIds.has(edge.id)) colors.push(edge.color);
		if (colors.length === 0) return undefined;
		const first = colors[0];
		return colors.every((color) => color === first) ? first : undefined;
	}

	private scheduleColorPalette(nodeId: NodeId, target: ColorPaletteTarget): void {
		// Obsidian closes its native Menu after the item callback returns. Open on
		// the next task so the menu's pointer cleanup cannot consume or dismiss
		// the first interaction with the floating palette.
		this.win.setTimeout(() => {
			if (!this.disposed && this.state.enabled) this.showColorPalette(nodeId, target);
		}, 0);
	}

	private showColorPalette(nodeId: NodeId, target: ColorPaletteTarget, anchorElement?: HTMLElement): void {
		this.closeColorPalette();
		const doc = this.view.containerEl.ownerDocument;
		const win = doc.defaultView ?? window;
		let currentColor: string | undefined;
		try {
			currentColor = this.targetColor(target);
		} catch {
			currentColor = undefined;
		}
		const palette = openColorPalette({
			document: doc,
			window: win,
			label: target.label,
			colors: PASTEL_COLORS,
			currentColor,
			apply: (color) => this.applyColorTarget(target, color, `${target.label}: ${PASTEL_COLORS.find((pastel) => pastel.hex === color)?.label ?? "Colour"}`),
			reset: () => this.applyColorTarget(target, undefined, `${target.label}: Theme default`),
		});
		this.colorPalette = palette;
		const paletteElement = palette.element;
		const anchor = anchorElement ?? this.adapter.node(nodeId)?.nodeEl ?? this.view.containerEl;
		const rect = anchor.getBoundingClientRect?.();
		const width = paletteElement.offsetWidth || 220;
		const height = paletteElement.offsetHeight || 150;
		const viewportWidth = win.innerWidth || width + 16;
		const viewportHeight = win.innerHeight || height + 16;
		const preferredLeft = rect ? rect.right + 8 : 16;
		const preferredTop = rect ? rect.bottom + 8 : 16;
		const left = Math.max(8, Math.min(preferredLeft, viewportWidth - width - 8));
		const top = Math.max(8, Math.min(preferredTop, viewportHeight - height - 8));
		paletteElement.style.left = `${left}px`;
		paletteElement.style.top = `${top}px`;
	}

	private closeColorPalette(): void {
		this.colorPalette?.close();
		this.colorPalette = undefined;
	}

	applyBranchColor(color?: string, nodeId?: NodeId): boolean {
		const selected = nodeId ? [nodeId] : this.adapter.selectionIds();
		if (selected.length === 0 || !this.state.enabled) return false;
		const data = this.adapter.getData();
		const nodeIds = new Set<NodeId>();
		const edgeIds = new Set<string>();
		for (const id of selected) {
			const targets = branchColorTargets(this.state, data, id);
			for (const targetId of targets.nodeIds) nodeIds.add(targetId);
			for (const edgeId of targets.edgeIds) edgeIds.add(edgeId);
		}
		return this.applyColorTarget(
			{ label: "Branch colours", nodeIds, edgeIds },
			color,
			"Apply branch colours",
		).status !== "failed";
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

	reparentNode(
		childId: NodeId,
		parentId: NodeId,
		side?: BranchSide,
		historyBaseline?: HistoryBaseline,
	): boolean {
		if (!this.state.enabled || childId === parentId || !canReparent(this.state, childId, parentId)) return false;
		if (parentOf(this.state, childId) === parentId) return false;
		const data = this.adapter.getData();
		const beforeState = cloneJson(this.state);
		const child = data.nodes.find((node) => node.id === childId);
		const parent = data.nodes.find((node) => node.id === parentId);
		if (!child || !parent || child.type === "group" || parent.type === "group") return false;
		const oldRoot = rootOf(this.state, childId);
		const nextState = cloneJson(this.state);
		const previous = nextState.relations[childId];
		const ids = this.nextIds();
		// Reparenting gets a fresh edge ID. Canvas can retain a live edge object
		// when an existing ID changes endpoints, which leaves the old connector
		// visible beside the new one. Removing the old ID and adding a fresh edge
		// makes the replacement explicit to both Canvas data and its edge index.
		const edgeId = randomId("canvas-mindmap-edge", ids.edgeIds);
		const previousEdge = previous && data.edges.find((edge) => edge.id === previous.edgeId);
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
		const affectedBranch = new Set(descendants(nextState, childId, true));
		const transaction = this.adapter.transaction("Reparent branch", (next) => {
			const edge = {
				...(previousEdge ? cloneJson(previousEdge) : {}),
				...this.createEdge(edgeId, parent, child),
			};
			if (previousEdge && previousEdge.color === undefined) delete edge.color;
			else if (previousEdge?.color !== undefined) edge.color = previousEdge.color;
			replaceManagedEdge(next, previous?.edgeId, edge);
			if (plannedLayout) {
				const visible = new Set(plannedLayout.visibleNodeIds);
				for (const node of next.nodes) {
					const position = plannedLayout.positions[node.id];
					if (position && visible.has(node.id)) {
						node.x = Math.round(position.x);
						node.y = Math.round(position.y);
					}
				}
			}
			this.updateManagedConnectorSides(next, nextState, affectedBranch);
		});
		if (!transaction) return false;
		this.state = nextState;
		this.rememberHistoryStates(
			historyBaseline?.beforeData ?? transaction.beforeData,
			historyBaseline?.beforeState ?? beforeState,
			transaction.beforeData,
			beforeState,
		);
		this.historyStates.set(JSON.stringify(transaction.afterData), cloneJson(nextState));
		this.commitState();
		this.applyVisibility();
		this.refreshControls();
		return true;
	}

	private onPointerDown = (event: PointerEvent): void => {
		if (!this.state.enabled || this.disposed || event.button !== 0) return;
		if (!isDomElement(event.target)) return;
		if (isCanvasInteractionOverlay(event.target)) return;
		this.stopEditingOutside(event.target);
		if (isEditableTarget(event.target)) return;

		const nodeId = this.nodeIdFromElement(event.target);
		if (!nodeId) {
			if (!event.shiftKey && this.isCanvasBackground(event.target)) {
				// Native Canvas normally clears selection on a background click. The
				// plugin claims this gesture for panning, so keep that selection
				// transition explicit before the native handler is bypassed.
				this.adapter.clearSelection();
			}
			if (!event.shiftKey && this.isCanvasBackground(event.target) && this.beginPan(event)) {
				// Claim the background gesture before native Canvas starts its
				// rectangle-selection tracker.
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
			}
			return;
		}
		const selectedBeforePress = this.adapter.selectionIds();
		if (!event.shiftKey && !selectedBeforePress.includes(nodeId)) this.adapter.selectOnly(nodeId);
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
			beforeData: this.adapter.getData(),
			beforeState: cloneJson(this.state),
			branchIds,
			directSelection,
			movementRoots,
			positions,
			modifier: event.metaKey || event.ctrlKey || event.altKey,
			active: false,
			canReparent: directSelection.size === 1 && directSelection.has(nodeId) &&
				movementRoots.size === 1 && movementRoots.has(nodeId),
			modifierDuringDrag: event.metaKey || event.ctrlKey || event.altKey,
		};
	};

	private stopEditingOutside(target: Element): void {
		let stopped = false;
		for (const node of this.adapter.nodes()) {
			if (!node.isEditing || node.nodeEl?.contains(target)) continue;
			stopped = this.adapter.stopEditing(node.id) || stopped;
		}
		if (!stopped) return;
		const nodeId = this.nodeIdFromElement(target);
		const isResizeHandle = !!target.closest(
			".canvas-node-resizer, .canvas-node-resize, [data-resize-handle]",
		);
		if (!isEditableTarget(target) && (!nodeId || !isResizeHandle)) this.adapter.focusCanvas();
	}

	private onNativeDragStart(event: PointerEvent, node?: CanvasNodeLike): void {
		const drag = this.drag;
		if (!drag || drag.pointerId !== event.pointerId || !node || node.id !== drag.nodeId) return;
		drag.nativeLifecycle = true;
		drag.active = true;
	}

	private onNativeDragMove(event: PointerEvent): void {
		const drag = this.drag;
		if (!drag?.nativeLifecycle || drag.pointerId !== event.pointerId) return;
		drag.modifierDuringDrag = event.metaKey || event.ctrlKey || event.altKey;
		if (drag.modifierDuringDrag) {
			this.updateContactHighlight(drag, undefined);
			return;
		}
		this.syncDraggedBranch(drag);
		this.updateContactHighlight(drag, this.findContactTarget(drag));
	}

	private onNativeDragEnd(event: PointerEvent): void {
		if (this.drag?.nativeLifecycle && this.drag.pointerId === event.pointerId) this.finishDrag(event);
	}

	private onNativeDragCancel(event?: PointerEvent): void {
		const drag = this.drag;
		if (!drag?.nativeLifecycle || (event && drag.pointerId !== event.pointerId)) return;
		if (drag.frame !== undefined) this.win.cancelAnimationFrame(drag.frame);
		this.restoreDraggedBranch(drag);
		this.drag = undefined;
		this.clearContactHighlight();
	}

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
		if (drag.nativeLifecycle) return;
		drag.modifierDuringDrag = event.metaKey || event.ctrlKey || event.altKey;
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
		if (this.drag?.nativeLifecycle) return;
		this.finishDrag(event);
	};

	private finishDrag(event: PointerEvent): void {
		const drag = this.drag;
		if (!drag || drag.pointerId !== event.pointerId) return;
		this.drag = undefined;
		if (drag.frame !== undefined) this.win.cancelAnimationFrame(drag.frame);
		this.syncDraggedBranch(drag);
		drag.modifierDuringDrag = event.metaKey || event.ctrlKey || event.altKey;
		const targetId = drag.active && !drag.modifier && !drag.modifierDuringDrag &&
			!event.metaKey && !event.ctrlKey && !event.altKey
			? this.findContactTarget(drag)
			: undefined;
		this.clearContactHighlight();
		if (!this.state.enabled || !drag.active) return;
		const moved = this.branchMoved(drag);
		const suppressed = !drag.canReparent || this.adapter.capabilities.readOnly || drag.modifier ||
			drag.modifierDuringDrag || event.metaKey || event.ctrlKey || event.altKey;
		if (!targetId || suppressed) {
			if (moved) {
				const routed = this.adapter.transaction("Route moved branch connectors", (next) =>
					this.updateManagedConnectorSides(next, this.state, drag.branchIds));
				if (!routed) this.adapter.requestSave();
			}
			return;
		}
		const side = this.balancedDropSide(drag.nodeId, targetId);
		this.reparentNode(drag.nodeId, targetId, side, {
			beforeData: drag.beforeData,
			beforeState: drag.beforeState,
		});
	}

	private onPointerCancel = (event: PointerEvent): void => {
		if (this.pan?.pointerId === event.pointerId) this.cancelPan();
		if (this.drag?.pointerId === event.pointerId) {
			const drag = this.drag;
			if (drag.frame !== undefined) this.win.cancelAnimationFrame(drag.frame);
			this.restoreDraggedBranch(drag);
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

	private restoreDraggedBranch(drag: DragSnapshot): void {
		for (const branchId of drag.branchIds) {
			const original = drag.positions[branchId];
			if (original) this.adapter.moveNode(branchId, original);
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
			.filter((node) => {
				const dataNode = dataById.get(node.id);
				return !!dataNode && dataNode.type !== "group" &&
					node.id !== drag.nodeId && !drag.branchIds.has(node.id) && !hidden.has(node.id);
			})
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
		if (this.drag) this.restoreDraggedBranch(this.drag);
		this.drag = undefined;
		this.clearContactHighlight();
	}

	private isCanvasBackground(element: Element): boolean {
		return !element.closest(".canvas-node, .canvas-edge, [data-edge-id]") &&
			!isCanvasInteractionOverlay(element);
	}

	private nodeIdFromElement(element: Element): NodeId | undefined {
		const explicit = element.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
		if (explicit && this.adapter.node(explicit)) return explicit;
		for (const node of this.adapter.nodes()) if (node.nodeEl?.contains(element)) return node.id;
		return undefined;
	}

	showNodeMenu(nodeId: NodeId, event?: MouseEvent): void {
		if (!this.state.enabled) return;
		const data = this.adapter.getData();
		const branchTargets = branchColorTargets(this.state, data, nodeId);
		const incomingEdgeIds = new Set<string>();
		const incomingRelation = this.state.relations[nodeId];
		if (incomingRelation && data.edges.some((edge) => edge.id === incomingRelation.edgeId)) {
			incomingEdgeIds.add(incomingRelation.edgeId);
		}
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
		menu.addItem((item: any) => item.setTitle("Node colour").setIcon("palette").onClick(() => this.scheduleColorPalette(
			nodeId,
			{ label: "Node colour", nodeIds: new Set([nodeId]), edgeIds: new Set() },
		)));
		menu.addItem((item: any) => item.setTitle("Branch node colours").setIcon("palette").onClick(() => this.scheduleColorPalette(
			nodeId,
			{ label: "Branch node colours", nodeIds: branchTargets.nodeIds, edgeIds: new Set() },
		)));
		menu.addItem((item: any) => {
			item.setTitle("Incoming arrow colour").setIcon("palette");
			item.setDisabled?.(incomingEdgeIds.size === 0);
			return item.onClick(() => this.scheduleColorPalette(
				nodeId,
				{ label: "Incoming arrow colour", nodeIds: new Set(), edgeIds: incomingEdgeIds },
			));
		});
		menu.addItem((item: any) => {
			item.setTitle("Branch arrow colours").setIcon("palette");
			item.setDisabled?.(branchTargets.edgeIds.size === 0);
			return item.onClick(() => this.scheduleColorPalette(
				nodeId,
				{ label: "Branch arrow colours", nodeIds: new Set(), edgeIds: branchTargets.edgeIds },
			));
		});
		if (this.adapter.node(nodeId)?.type === "text") {
			menu.addItem((item: any) => item.setTitle("Toggle automatic height").setIcon("move-vertical").onClick(() => {
				const manual = !this.state.manualHeightNodeIds.includes(nodeId);
				this.state.manualHeightNodeIds = this.state.manualHeightNodeIds.filter((id) => id !== nodeId);
				if (manual) this.state.manualHeightNodeIds.push(nodeId);
				this.commitState();
				if (!manual) this.height.schedule(nodeId, true);
			}));
		}
		if (event) {
			menu.showAtMouseEvent(event);
		} else {
			const nodeElement = this.adapter.node(nodeId)?.nodeEl;
			const rect = nodeElement?.getBoundingClientRect?.();
			menu.showAtPosition(rect
				? { x: rect.right, y: rect.top }
				: { x: 24, y: 24 });
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.closeColorPalette();
		for (const handle of this.nativeColorPickers.values()) handle.dispose();
		this.nativeColorPickers.clear();
		this.cancelPointerInteraction();
		this.removeNativeDragHook?.();
		this.removeNativeDragHook = undefined;
		this.removeDataImportHook?.();
		this.removeDataImportHook = undefined;
		this.revealAll();
		this.removeControls();
		this.restoreZoomControls(this.canvasHostRoots());
		this.height.dispose();
		this.keyTarget?.removeEventListener("keydown", this.onKeyDown, true);
		this.keyTarget?.removeEventListener("pointerdown", this.onPointerDown, true);
		this.win.removeEventListener("pointermove", this.onPointerMove, true);
		this.win.removeEventListener("pointerup", this.onPointerUp, true);
		this.win.removeEventListener("pointercancel", this.onPointerCancel, true);
		this.win.removeEventListener("blur", this.onWindowBlur);
		if (this.domSyncTimer) clearTimeout(this.domSyncTimer);
		if (this.historySyncTimer) this.win.clearTimeout(this.historySyncTimer);
		this.domObserver?.disconnect();
	}
}
