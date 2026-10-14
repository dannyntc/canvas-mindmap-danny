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
