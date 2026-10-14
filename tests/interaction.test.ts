import test from "node:test";
import assert from "node:assert/strict";
import {
	findContactParent,
	hasStructuralCanvasMutation,
	hasPassedDragThreshold,
	intersectionArea,
	isEditorMutationTarget,
	panViewport,
	rectanglesTouch,
} from "../src/interaction";

const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

test("contact includes overlap, edge contact, and corner contact but rejects a gap", () => {
	assert.equal(rectanglesTouch(rect(0, 0, 10, 10), rect(10, 2, 20, 12)), true);
	assert.equal(rectanglesTouch(rect(0, 0, 10, 10), rect(10, 10, 20, 20)), true);
	assert.equal(rectanglesTouch(rect(0, 0, 10, 10), rect(10.01, 0, 20, 10)), false);
	assert.equal(intersectionArea(rect(0, 0, 10, 10), rect(10, 2, 20, 12)), 0);
});

test("contact parent ranking prefers overlap, then distance, then stable ID", () => {
	const dragged = rect(10, 10, 30, 30);
	assert.equal(findContactParent(dragged, [
		{ id: "far", bounds: rect(30, 10, 60, 40) },
		{ id: "overlap", bounds: rect(20, 15, 40, 35) },
	], new Set()), "overlap");
	assert.equal(findContactParent(dragged, [
		{ id: "b", bounds: rect(30, 30, 40, 40) },
		{ id: "a", bounds: rect(30, 30, 40, 40) },
	], new Set()), "a");
});

test("contact candidates can be excluded or marked ineligible", () => {
	const dragged = rect(0, 0, 10, 10);
	assert.equal(findContactParent(dragged, [
		{ id: "cycle", bounds: rect(5, 0, 15, 10) },
		{ id: "group", bounds: rect(0, 5, 10, 15), eligible: false },
	], new Set(["cycle"])), undefined);
});

test("pan viewport keeps zoom and converts screen movement to world movement", () => {
	assert.deepEqual(panViewport({ x: 100, y: 50, zoom: 2 }, { x: 40, y: -20 }), {
		x: 80,
		y: 60,
		zoom: 2,
	});
	assert.equal(hasPassedDragThreshold({ x: 10, y: 10 }, { x: 13, y: 11 }), false);
	assert.equal(hasPassedDragThreshold({ x: 10, y: 10 }, { x: 14, y: 10 }), true);
});

test("editor mutations are ignored by structural Canvas refreshes", () => {
	const editorTarget = {
		closest: (selector: string) => selector.includes(".cm-editor") ? {} as Element : null,
	} as unknown as Node;
	const canvasTarget = {
		closest: () => null,
	} as unknown as Node;
	assert.equal(isEditorMutationTarget(editorTarget), true);
	assert.equal(isEditorMutationTarget(canvasTarget), false);
	assert.equal(hasStructuralCanvasMutation([{ target: editorTarget } as MutationRecord]), false);
	assert.equal(hasStructuralCanvasMutation([{ target: canvasTarget } as MutationRecord]), true);
});
