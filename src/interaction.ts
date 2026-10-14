export interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface ContactCandidate {
	id: string;
	bounds: Rect;
	eligible?: boolean;
}

export interface ViewportOrigin {
	x: number;
	y: number;
	zoom: number;
}

const EDITOR_MUTATION_SELECTOR =
	".cm-editor, .markdown-source-view, .markdown-preview-view, .markdown-rendered, .canvas-node-content";

const CANVAS_INTERACTION_OVERLAY_SELECTOR = [
	".canvas-submenu",
	".canvas-menu .clickable-icon",
	".canvas-menu button",
	".canvas-color-picker-item",
	".canvas-color-picker-custom",
	".canvas-controls",
	".canvas-control-item",
	".canvas-mindmap-color-palette",
	".canvas-mindmap-native-color-controls",
	".canvas-mindmap-branching-overlay",
	"[data-branching-path]",
	"[data-branching-junction]",
	".canvas-mindmap-control",
	".canvas-node-resizer",
	".canvas-node-resize",
	"[data-resize-handle]",
	"input",
	"textarea",
	"select",
	"button",
	"[role='button']",
	"[contenteditable='true']",
].join(", ");

/** Return true when a pointer target belongs to Canvas UI rather than map space. */
export function isCanvasInteractionOverlay(element: Element): boolean {
	return !!element.closest(CANVAS_INTERACTION_OVERLAY_SELECTOR);
}

/**
 * Returns true when a DOM mutation target belongs to card content. Content
 * edits should not trigger a full Canvas control refresh.
 */
export function isEditorMutationTarget(target: Node): boolean {
	const candidate = target as unknown as {
		closest?: (selector: string) => Element | null;
		parentElement?: Element | null;
	};
	const element = typeof candidate.closest === "function"
		? candidate as unknown as Element
		: candidate.parentElement;
	return !!element?.closest?.(EDITOR_MUTATION_SELECTOR);
}

export function hasStructuralCanvasMutation(records: readonly MutationRecord[]): boolean {
	return records.some((record) => !isEditorMutationTarget(record.target));
}

/**
 * Find native Canvas sidebar containers across the possible view host roots.
 * Obsidian can place the controls under the wrapper, content, or outer view
 * element depending on the desktop view implementation.
 */
export function findCanvasControlContainers(roots: readonly HTMLElement[]): HTMLElement[] {
	const containers: HTMLElement[] = [];
	const seen = new Set<HTMLElement>();
	const add = (element: HTMLElement): void => {
		if (seen.has(element)) return;
		seen.add(element);
		containers.push(element);
	};
	for (const root of roots) {
		if (root.classList?.contains("canvas-controls")) add(root);
		for (const container of Array.from(root.querySelectorAll<HTMLElement>(".canvas-controls"))) {
			add(container);
		}
	}
	return containers;
}

/**
 * Identify native Canvas history controls without relying on one locale or
 * one Obsidian icon class name.
 */
export function isCanvasHistoryControl(element: HTMLElement): boolean {
	const icons = Array.from(element.querySelectorAll<HTMLElement>(
		"svg, [data-lucide], .svg-icon",
	));
	const semanticText = [
		element.getAttribute("aria-label"),
		element.getAttribute("title"),
		element.getAttribute("data-tooltip"),
		element.getAttribute("data-tooltip-content"),
		String(element.className ?? ""),
		...icons.map((icon) => `${icon.getAttribute("data-lucide") ?? ""} ${String(icon.className ?? "")}`),
	].filter(Boolean).join(" ").toLowerCase();
	return /(?:^|[\s_-])(undo|redo)(?:[\s_-]|$)/.test(semanticText);
}

/**
 * Return the last native Undo/Redo control so plugin actions can be placed
 * directly after the editing-history group.
 */
export function findCanvasHistoryAnchor(container: HTMLElement): HTMLElement | undefined {
	const controls = Array.from(container.querySelectorAll<HTMLElement>(
		".canvas-control-item, button, [role='button']",
	));
	return [...controls].reverse().find(isCanvasHistoryControl);
}

export function rectanglesTouch(first: Rect, second: Rect): boolean {
	return first.left <= second.right &&
		first.right >= second.left &&
		first.top <= second.bottom &&
		first.bottom >= second.top;
}

export function intersectionArea(first: Rect, second: Rect): number {
	if (!rectanglesTouch(first, second)) return 0;
	const width = Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left));
	const height = Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
	return width * height;
}

function center(rect: Rect): { x: number; y: number } {
	return {
		x: (rect.left + rect.right) / 2,
		y: (rect.top + rect.bottom) / 2,
	};
}

function centerDistanceSquared(first: Rect, second: Rect): number {
	const firstCenter = center(first);
	const secondCenter = center(second);
	const dx = firstCenter.x - secondCenter.x;
	const dy = firstCenter.y - secondCenter.y;
	return dx * dx + dy * dy;
}

/**
 * Returns the best eligible card touching the dragged card. The final ID tie
 * break keeps the result stable when cards have identical geometry.
 */
export function findContactParent(
	draggedBounds: Rect,
	candidates: ContactCandidate[],
	excludedIds: ReadonlySet<string>,
): string | undefined {
	return candidates
		.filter((candidate) =>
			candidate.eligible !== false &&
			!excludedIds.has(candidate.id) &&
			rectanglesTouch(draggedBounds, candidate.bounds),
		)
		.sort((first, second) => {
			const areaDifference = intersectionArea(second.bounds, draggedBounds) -
				intersectionArea(first.bounds, draggedBounds);
			if (areaDifference !== 0) return areaDifference;
			const distanceDifference = centerDistanceSquared(first.bounds, draggedBounds) -
				centerDistanceSquared(second.bounds, draggedBounds);
			if (distanceDifference !== 0) return distanceDifference;
			return first.id.localeCompare(second.id);
		})
		.map((candidate) => candidate.id)[0];
}

export function hasPassedDragThreshold(
	start: { x: number; y: number },
	current: { x: number; y: number },
	threshold = 4,
): boolean {
	return Math.hypot(current.x - start.x, current.y - start.y) >= threshold;
}

/**
 * Canvas viewport origins move opposite to the pointer when the map is
 * dragged. Keeping this calculation pure makes zoom behavior easy to test.
 */
export function panViewport(
	start: ViewportOrigin,
	screenDelta: { x: number; y: number },
): ViewportOrigin {
	const zoom = start.zoom > 0 ? start.zoom : 1;
	return {
		x: start.x - screenDelta.x / zoom,
		y: start.y - screenDelta.y / zoom,
		zoom: start.zoom,
	};
}
