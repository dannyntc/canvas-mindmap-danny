import test from "node:test";
import assert from "node:assert/strict";
import { assignMissingBalancedSides, calculateLayout } from "../src/layout";
import { attachChild } from "../src/tree-model";
import { CanvasData, defaultCanvasState } from "../src/types";

function node(id: string, x = 100, y = 100, width = 100, height = 60) {
	return { id, x, y, width, height, type: "text" as const, text: id };
}

function edge(id: string, fromNode: string, toNode: string) {
	return { id, fromNode, toNode, fromSide: "right" as const, toSide: "left" as const };
}

function data(): CanvasData {
	return {
		nodes: [node("root", 100, 100, 120, 80), node("wide", 0, 0, 240, 100), node("short", 0, 0, 80, 40), node("grand", 0, 0, 130, 70)],
		edges: [edge("e-wide", "root", "wide"), edge("e-short", "root", "short"), edge("e-grand", "wide", "grand")],
	};
}

function state() {
	const result = defaultCanvasState();
	attachChild(result, "wide", "root", "e-wide", 0);
	attachChild(result, "short", "root", "e-short", 1);
	attachChild(result, "grand", "wide", "e-grand", 0);
	result.trees.root = { layout: "left-to-right", branchSides: {} };
	return result;
}

test("all directional layouts use real dimensions and keep the root anchored", () => {
	for (const mode of ["left-to-right", "right-to-left", "top-to-bottom", "bottom-to-top"] as const) {
		const canvas = data();
		const map = state();
		map.trees.root.layout = mode;
		const result = calculateLayout(canvas, map, { horizontalGap: 20, verticalGap: 15 });
		assert.deepEqual(result.positions.root, { x: 100, y: 100 });
		if (mode === "left-to-right") assert.ok(result.positions.wide.x > 220);
		if (mode === "right-to-left") assert.ok(result.positions.wide.x + 240 < 100);
		if (mode === "top-to-bottom") assert.ok(result.positions.wide.y > 180);
		if (mode === "bottom-to-top") assert.ok(result.positions.wide.y + 100 < 100);
		assert.equal(result.positions.grand.x !== undefined, true);
		assert.ok(result.bounds.root.width > 120 || result.bounds.root.height > 80);
	}
});

test("balanced layout preserves explicit sides and assigns missing branches right on a tie", () => {
	const canvas = data();
	const map = state();
	map.trees.root.layout = "balanced";
	map.trees.root.branchSides = { wide: "left" };
	const assigned = assignMissingBalancedSides(canvas, map, "root", 15);
	assert.equal(assigned.wide, "left");
	assert.equal(assigned.short, "right");
	const result = calculateLayout(canvas, map, { horizontalGap: 20, verticalGap: 15 });
	assert.ok(result.positions.wide.x + 240 < 100);
	assert.ok(result.positions.short.x > 220);
	assert.ok(result.positions.grand.x < result.positions.wide.x);
});

test("collapsed descendants remain in saved geometry but are excluded from layout", () => {
	const canvas = data();
	const map = state();
	canvas.nodes.find((item) => item.id === "grand")!.x = 777;
	canvas.nodes.find((item) => item.id === "grand")!.y = 888;
	map.trees.root.layout = "left-to-right";
	map.collapsedNodeIds = ["wide"];
	const result = calculateLayout(canvas, map, { horizontalGap: 20, verticalGap: 15 });
	assert.ok(!result.visibleNodeIds.includes("grand"));
	assert.deepEqual(result.positions.grand, { x: 777, y: 888 });
	assert.equal(result.visibleNodeIds.includes("wide"), true);
});

test("independent trees are laid out without moving an unselected root", () => {
	const canvas = data();
	canvas.nodes.push(node("other", 900, 900));
	const map = state();
	const result = calculateLayout(canvas, map, { rootIds: ["root"], horizontalGap: 20, verticalGap: 15 });
	assert.deepEqual(result.positions.other, { x: 900, y: 900 });
	assert.deepEqual(result.positions.root, { x: 100, y: 100 });
});
