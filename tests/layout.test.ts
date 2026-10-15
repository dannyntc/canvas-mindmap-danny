import test from "node:test";
import assert from "node:assert/strict";
import {
	assignMissingBalancedSides,
	calculateLayout,
	chooseStraightConnectorSides,
	layoutRootsForSelection,
	layoutSubtreeRootsForSelection,
} from "../src/layout";
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

test("arrange selection resolves unique card roots and ignores connectors", () => {
	const canvas = data();
	canvas.nodes.push(node("other", 900, 900));
	const map = state();

	assert.deepEqual(
		layoutRootsForSelection(["grand", "wide", "e-grand", "other"], canvas, map),
		["root", "other"],
	);
	assert.deepEqual(layoutRootsForSelection([], canvas, map), []);
});

test("arrange selection resolves independent subtree anchors and drops descendants", () => {
	const canvas = data();
	canvas.nodes.push(node("other", 900, 900));
	const map = state();

	assert.deepEqual(
		layoutSubtreeRootsForSelection(["grand", "wide", "e-grand", "other"], canvas, map),
		["wide", "other"],
	);
});

test("subtree layout keeps the selected card fixed and moves only its descendants", () => {
	const canvas = data();
	const map = state();
	const result = calculateLayout(canvas, map, {
		horizontalGap: 20,
		verticalGap: 15,
		subtreeRootIds: ["wide"],
	});

	assert.deepEqual(result.positions.wide, { x: 0, y: 0 });
	assert.deepEqual(result.positions.grand, { x: 260, y: 15 });
	assert.deepEqual(result.positions.root, { x: 100, y: 100 });
	assert.deepEqual(result.positions.short, { x: 0, y: 0 });
	assert.deepEqual(result.visibleNodeIds.sort(), ["grand", "wide"]);
});

test("balanced subtree layout preserves the selected branch side", () => {
	const canvas = data();
	const map = state();
	map.trees.root.layout = "balanced";
	map.trees.root.branchSides = { wide: "left", short: "right" };
	const result = calculateLayout(canvas, map, {
		horizontalGap: 20,
		verticalGap: 15,
		subtreeRootIds: ["wide"],
	});

	assert.deepEqual(result.positions.wide, { x: 0, y: 0 });
	assert.equal(result.positions.grand.x, -150);
});

test("straight connector sides follow final card geometry", () => {
	assert.deepEqual(
		chooseStraightConnectorSides(node("parent", 0, 0, 100, 100), node("child", 220, 10, 100, 100)),
		{ fromSide: "right", toSide: "left" },
	);
	assert.deepEqual(
		chooseStraightConnectorSides(node("parent", 220, 10, 100, 100), node("child", 0, 0, 100, 100)),
		{ fromSide: "left", toSide: "right" },
	);
	assert.deepEqual(
		chooseStraightConnectorSides(node("parent", 0, 0, 100, 100), node("child", 10, 220, 100, 100)),
		{ fromSide: "bottom", toSide: "top" },
	);
	assert.deepEqual(
		chooseStraightConnectorSides(node("parent", 10, 220, 100, 100), node("child", 0, 0, 100, 100)),
		{ fromSide: "top", toSide: "bottom" },
	);
});

test("straight connector routing uses card centers and breaks equal axes horizontally", () => {
	assert.deepEqual(
		chooseStraightConnectorSides(node("parent", 0, 0, 400, 40), node("child", 300, 100, 20, 300)),
		{ fromSide: "bottom", toSide: "top" },
	);
	assert.deepEqual(
		chooseStraightConnectorSides(node("parent", 0, 0, 100, 100), node("child", 100, 100, 100, 100)),
		{ fromSide: "right", toSide: "left" },
	);
});
