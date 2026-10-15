import test from "node:test";
import assert from "node:assert/strict";
import {
	applyBranchDeletion,
	attachChild,
	adoptCanvasConnections,
	branchDeletion,
	canReparent,
	deleteBranches,
	descendants,
	duplicateBranch,
	hiddenNodeIds,
	managedEdgeIds,
	parentOf,
	replaceManagedEdge,
	relationChildren,
	reorderSibling,
	rootOf,
	roots,
	sanitizeState,
} from "../src/tree-model";
import { CanvasData, CanvasMindMapState, defaultCanvasState } from "../src/types";

function node(id: string, x = 0, y = 0, width = 100, height = 60) {
	return { id, x, y, width, height, type: "text" as const, text: id };
}

function edge(id: string, fromNode: string, toNode: string) {
	return { id, fromNode, toNode, fromSide: "right" as const, toSide: "left" as const };
}

function stateWithRelations(): CanvasMindMapState {
	const state = defaultCanvasState();
	attachChild(state, "b", "a", "e-ab", 0);
	attachChild(state, "c", "a", "e-ac", 1);
	attachChild(state, "d", "b", "e-bd", 0);
	state.trees.a = { layout: "balanced", branchSides: { b: "left", c: "right" } };
	return state;
}

function treeData(): CanvasData {
	return {
		nodes: [node("a", 100, 100), node("b", 0, 0), node("c", 0, 0), node("d", 0, 0)],
		edges: [edge("e-ab", "a", "b"), edge("e-ac", "a", "c"), edge("e-bd", "b", "d")],
	};
}

test("adopts only unambiguous acyclic directed connections", () => {
	const data: CanvasData = {
		nodes: [node("a"), node("b"), node("c"), node("d"), node("e")],
		edges: [
			edge("e-ab", "a", "b"),
			edge("e-ba", "b", "a"),
			edge("e-ad", "a", "d"),
			edge("e-cd", "c", "d"),
		{ ...edge("e-group", "a", "e"), fromNode: "a", toNode: "e" },
		{ ...edge("e-file", "a", "c"), fromNode: "a", toNode: "c", color: "red" },
		{ ...edge("e-group-node", "a", "e"), fromNode: "a", toNode: "e" },
		],
	};
	data.nodes[4].type = "group";
	const state = defaultCanvasState();
	// Make c's incoming connection unambiguous, while d has two candidates.
	const adopted = adoptCanvasConnections(data, state).state;
	assert.equal(parentOf(adopted, "b"), "a");
	assert.equal(parentOf(adopted, "c"), "a");
	assert.equal(parentOf(adopted, "a"), undefined);
	assert.equal(parentOf(adopted, "d"), undefined);
	assert.equal(parentOf(adopted, "e"), undefined);
});

test("adoption repairs a stale relation from the current Canvas edge", () => {
	const data = treeData();
	const state = defaultCanvasState();
	state.relations.b = { parentId: "a", edgeId: "missing-edge", order: 0 };

	const repaired = adoptCanvasConnections(data, state).state;

	assert.deepEqual(repaired.relations.b, {
		parentId: "a",
		edgeId: "e-ab",
		order: 0,
	});
});

test("traversal, collapse, root lookup, and sibling order are stable", () => {
	const state = stateWithRelations();
	assert.deepEqual(relationChildren(state, "a"), ["b", "c"]);
	assert.deepEqual(descendants(state, "a", true), ["a", "b", "c", "d"]);
	assert.equal(rootOf(state, "d"), "a");
	state.collapsedNodeIds = ["b"];
	assert.deepEqual([...hiddenNodeIds(state)], ["d"]);
	assert.equal(roots(treeData(), state)[0], "a");
	assert.equal(reorderSibling(state, "c", "before"), true);
	assert.deepEqual(relationChildren(state, "a"), ["c", "b"]);
});

test("reparenting rejects cycles and preserves managed connector identity", () => {
	const state = stateWithRelations();
	assert.equal(canReparent(state, "d", "c"), true);
	assert.equal(canReparent(state, "a", "d"), false);
	assert.equal(attachChild(state, "d", "c", "e-cd"), true);
	assert.equal(parentOf(state, "d"), "c");
	assert.equal(state.relations.d.edgeId, "e-cd");
});

test("reparenting replaces the managed connector without removing cross-links", () => {
	const data = treeData();
	data.edges.push(edge("cross-a-d", "a", "d"));
	const state = stateWithRelations();
	const replacement = edge("e-cd-new", "c", "d");

	replaceManagedEdge(data, state.relations.d.edgeId, replacement);

	assert.deepEqual(
		data.edges.map((item) => item.id).sort(),
		["cross-a-d", "e-ab", "e-ac", "e-cd-new"],
	);
	assert.equal(data.edges.find((item) => item.id === "e-cd-new")?.fromNode, "c");
	assert.equal(data.edges.some((item) => item.id === "e-bd"), false);
});

test("repeated reparenting leaves only the latest managed connector", () => {
	const data = treeData();
	const state = stateWithRelations();
	const first = edge("e-cd-new", "c", "d");
	const second = edge("e-ad-new", "a", "d");

	replaceManagedEdge(data, state.relations.d.edgeId, first);
	replaceManagedEdge(data, first.id, second);

	assert.equal(data.edges.some((item) => item.id === "e-bd"), false);
	assert.equal(data.edges.some((item) => item.id === "e-cd-new"), false);
	assert.deepEqual(
		data.edges.filter((item) => item.toNode === "d").map((item) => item.id),
		["e-ad-new"],
	);
});

test("branch deletion removes descendants and incident edges but not unrelated nodes", () => {
	const data = treeData();
	data.edges.push(edge("cross-bd", "b", "d"));
	const state = stateWithRelations();
	const deletion = branchDeletion(data, state, "b");
	assert.deepEqual([...deletion.nodeIds].sort(), ["b", "d"]);
	assert.deepEqual([...deletion.edgeIds].sort(), ["cross-bd", "e-ab", "e-bd"]);
	const expected = new Set(["a", "c"]);
	applyBranchDeletion(data, state, deletion);
	assert.deepEqual(new Set(data.nodes.map((item) => item.id)), expected);
	assert.equal(state.relations.b, undefined);
	assert.equal(state.relations.d, undefined);
});

test("multi-selection deletion takes the union of branches", () => {
	const data = treeData();
	const state = stateWithRelations();
	const deletion = deleteBranches(data, state, ["b", "d"]);
	assert.deepEqual([...deletion.nodeIds].sort(), ["b", "d"]);
	assert.deepEqual([...deletion.edgeIds].sort(), ["e-ab", "e-bd"]);
});

test("duplicateBranch creates fresh internal IDs and retains nested state", () => {
	const data = treeData();
	data.edges.push(edge("cross-bd", "b", "d"));
	const state = stateWithRelations();
	let count = 0;
	const result = duplicateBranch(data, state, "b", (kind) => `${kind}-copy-${++count}`);
	assert.equal(result.nodes.length, 2);
	assert.equal(result.edges.length, 1);
	assert.notEqual(result.rootId, "b");
	assert.equal(result.state.relations[result.nodes[1].id]?.parentId, result.rootId);
	assert.ok(result.nodes.every((item) => item.x >= 40 && item.y >= 40));
	assert.equal(new Set(result.nodes.map((item) => item.id)).size, result.nodes.length);
});

test("sanitizeState removes stale references, cycles, and non-root preferences", () => {
	const data = treeData();
	const state = stateWithRelations();
	state.relations.missing = { parentId: "a", edgeId: "missing-edge", order: 0 };
	state.relations.a = { parentId: "d", edgeId: "e-bd", order: 0 };
	state.trees.missing = { layout: "left-to-right", branchSides: {} };
	state.collapsedNodeIds = ["a", "missing"];
	const clean = sanitizeState(data, state);
	assert.equal(clean.relations.missing, undefined);
	assert.equal(clean.relations.a, undefined);
	assert.deepEqual(clean.collapsedNodeIds, ["a"]);
	assert.equal(clean.trees.missing, undefined);
	assert.deepEqual([...managedEdgeIds(clean)].sort(), ["e-ab", "e-ac", "e-bd"]);
});
