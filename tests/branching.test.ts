import test from "node:test";
import assert from "node:assert/strict";
import { branchGroupKey, managedBranchGroups, projectRatio } from "../src/branching";
import { CanvasData, defaultCanvasState } from "../src/types";
import { attachChild } from "../src/tree-model";

function data(): CanvasData {
	return {
		nodes: [
			{ id: "root", x: 0, y: 0, width: 100, height: 60, type: "text" },
			{ id: "a", x: 300, y: -80, width: 100, height: 60, type: "text" },
			{ id: "b", x: 300, y: 80, width: 100, height: 60, type: "text" },
		],
		edges: [
			{ id: "edge-a", fromNode: "root", toNode: "a", fromSide: "right", toSide: "left" },
			{ id: "edge-b", fromNode: "root", toNode: "b", fromSide: "right", toSide: "left" },
		],
	};
}

test("projectRatio clamps a dragged junction to its source arrow", () => {
	assert.equal(projectRatio({ x: -50, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }), 0.05);
	assert.equal(projectRatio({ x: 50, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }), 0.5);
	assert.equal(projectRatio({ x: 150, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }), 0.95);
});

test("managed branch groups collect sibling arrows and preserve side identity", () => {
	const canvas = data();
	const state = defaultCanvasState();
	attachChild(state, "a", "root", "edge-a", 0);
	attachChild(state, "b", "root", "edge-b", 1);

	const groups = managedBranchGroups(canvas, state);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].key, branchGroupKey("root", "right"));
	assert.deepEqual(groups[0].edges.map((edge) => edge.id), ["edge-a", "edge-b"]);
	assert.deepEqual(groups[0].junctions, []);
});

test("manual junctions are scoped to their parent and selected outgoing edges", () => {
	const canvas = data();
	const state = defaultCanvasState();
	attachChild(state, "a", "root", "edge-a", 0);
	attachChild(state, "b", "root", "edge-b", 1);
	state.junctions.manual = {
		id: "manual",
		parentId: "root",
		anchorEdgeId: "edge-a",
		side: "right",
		ratio: 0.7,
		edgeIds: ["edge-a", "missing"],
	};

	const groups = managedBranchGroups(canvas, state);
	assert.deepEqual(groups[0].junctions[0].edgeIds, ["edge-a"]);
});
