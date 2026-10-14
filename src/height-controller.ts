import { CanvasAdapter } from "./canvas-adapter";
import { CanvasMindMapState, NodeId } from "./types";

export interface HeightControllerOptions {
	adapter: CanvasAdapter;
	getState: () => CanvasMindMapState;
	isEnabled: () => boolean;
	isExternalResizeOwner?: () => boolean;
	onResized?: (nodeId: NodeId) => void;
}

function numberStyle(value: string): number {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function measureElement(element: HTMLElement): number | undefined {
	const candidates = [
		element.querySelector<HTMLElement>(".cm-scroller"),
		element.querySelector<HTMLElement>(".markdown-preview-sizer"),
		element.querySelector<HTMLElement>(".markdown-rendered"),
		element.querySelector<HTMLElement>(".markdown-preview-view"),
		element.querySelector<HTMLElement>(".canvas-node-content"),
		element,
	].filter((candidate): candidate is HTMLElement => !!candidate);
	for (const candidate of candidates) {
		const height = Math.max(candidate.scrollHeight, candidate.offsetHeight);
		if (height <= 0) continue;
		const style = getComputedStyle(candidate);
		const padding = numberStyle(style.paddingTop) + numberStyle(style.paddingBottom);
		const border = numberStyle(style.borderTopWidth) + numberStyle(style.borderBottomWidth);
		return height + padding + border;
	}
	return undefined;
}

export class HeightController {
	private readonly options: HeightControllerOptions;
	private readonly timers = new Map<NodeId, ReturnType<typeof setTimeout>>();
	private readonly observers = new Map<NodeId, ResizeObserver>();
	private readonly mutationObservers = new Map<NodeId, MutationObserver>();
	private readonly inputListeners = new Map<NodeId, { element: HTMLElement; listener: () => void }>();
	private readonly lastHeights = new Map<NodeId, number>();
	private disposed = false;

	constructor(options: HeightControllerOptions) {
		this.options = options;
	}

	refreshAll(): void {
		if (this.disposed || !this.options.isEnabled()) return;
		for (const node of this.options.adapter.nodes()) {
			if (node.type === "text") this.schedule(node.id, true);
		}
	}

	pause(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		for (const observer of this.observers.values()) observer.disconnect();
		for (const observer of this.mutationObservers.values()) observer.disconnect();
		for (const { element, listener } of this.inputListeners.values()) element.removeEventListener("input", listener);
		this.timers.clear();
		this.observers.clear();
		this.mutationObservers.clear();
		this.inputListeners.clear();
	}

	schedule(nodeId: NodeId, immediate = false): void {
		if (this.disposed || !this.options.isEnabled()) return;
		const current = this.timers.get(nodeId);
		if (current) clearTimeout(current);
		if (immediate) {
			this.timers.delete(nodeId);
			this.recalculate(nodeId);
			return;
		}
		this.timers.set(nodeId, setTimeout(() => {
			this.timers.delete(nodeId);
			this.recalculate(nodeId);
		}, 150));
	}

	recalculate(nodeId: NodeId): boolean {
		if (this.disposed || !this.options.isEnabled()) return false;
		if (this.options.isExternalResizeOwner?.()) return false;
		const state = this.options.getState();
		if (state.manualHeightNodeIds.includes(nodeId)) return false;
		const node = this.options.adapter.node(nodeId);
		if (!node || node.type !== "text" || !node.nodeEl) return false;
		if (node.nodeEl.classList.contains("canvas-mindmap-hidden")) return false;
		const measured = measureElement(node.nodeEl);
		if (measured === undefined) return false;
		const height = Math.max(60, Math.round(measured / this.options.adapter.zoom()));
		const previous = this.lastHeights.get(nodeId) ?? node.height;
		if (Math.abs(height - previous) < 2 || Math.abs(height - node.height) < 2) {
			this.lastHeights.set(nodeId, height);
			return false;
		}
		this.lastHeights.set(nodeId, height);
		const changed = this.options.adapter.resizeNode(nodeId, node.width, height);
		if (changed) {
			this.options.onResized?.(nodeId);
			this.options.adapter.requestFrame();
		}
		return changed;
	}

	observe(nodeId: NodeId): void {
		const node = this.options.adapter.node(nodeId);
		if (!node?.nodeEl || node.type !== "text") return;
		this.observers.get(nodeId)?.disconnect();
		if (typeof ResizeObserver !== "undefined") {
			const observer = new ResizeObserver(() => this.schedule(nodeId));
			observer.observe(node.nodeEl);
			this.observers.set(nodeId, observer);
		}
		this.mutationObservers.get(nodeId)?.disconnect();
		if (typeof MutationObserver !== "undefined") {
			const observer = new MutationObserver(() => this.schedule(nodeId));
			observer.observe(node.nodeEl, { childList: true, subtree: true, characterData: true });
			this.mutationObservers.set(nodeId, observer);
		}
		const previousInput = this.inputListeners.get(nodeId);
		previousInput?.element.removeEventListener("input", previousInput.listener);
		const editor = node.nodeEl.querySelector<HTMLElement>(".cm-editor, textarea, [contenteditable='true']");
		if (editor) {
			const listener = () => this.schedule(nodeId);
			editor.addEventListener("input", listener);
			this.inputListeners.set(nodeId, { element: editor, listener });
		}
	}

	observeAll(): void {
		for (const node of this.options.adapter.nodes()) {
			if (node.type === "text") this.observe(node.id);
		}
	}

	setManualHeight(nodeId: NodeId, manual: boolean): void {
		const state = this.options.getState();
		state.manualHeightNodeIds = state.manualHeightNodeIds.filter((id) => id !== nodeId);
		if (manual) state.manualHeightNodeIds.push(nodeId);
	}

	dispose(): void {
		this.disposed = true;
		this.pause();
		this.lastHeights.clear();
	}
}
