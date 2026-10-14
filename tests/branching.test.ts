import test from "node:test";
import assert from "node:assert/strict";
import { BranchingOverlay, branchGroupKey, managedBranchGroups, projectRatio } from "../src/branching";
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

test("branching overlay renders one persisted label on the shared trunk", async () => {
	const { Window } = await import("happy-dom");
	const window = new Window();
	const wrapper = window.document.createElement("div") as unknown as HTMLElement;
	const root = window.document.createElement("div") as unknown as HTMLElement;
	const first = window.document.createElement("div") as unknown as HTMLElement;
	const second = window.document.createElement("div") as unknown as HTMLElement;
	const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
	Object.defineProperty(wrapper, "getBoundingClientRect", { value: () => rect(0, 0, 1000, 1000) });
	Object.defineProperty(root, "getBoundingClientRect", { value: () => rect(0, 0, 100, 60) });
	Object.defineProperty(first, "getBoundingClientRect", { value: () => rect(300, 0, 400, 60) });
	Object.defineProperty(second, "getBoundingClientRect", { value: () => rect(300, 100, 400, 160) });
	const nodes = new Map<string, HTMLElement>([["root", root], ["a", first], ["b", second]]);
	const canvas = data();
	const state = defaultCanvasState();
	attachChild(state, "a", "root", "edge-a", 0);
	attachChild(state, "b", "root", "edge-b", 1);
	state.branchLabels.root = { right: "shared context" };
	const overlay = new BranchingOverlay(wrapper, {
		canEdit: () => false,
		getNodeIdAt: () => undefined,
		onJunctionPreview: () => undefined,
		onJunctionCommit: () => undefined,
		onConnect: () => undefined,
		onPathContextMenu: () => undefined,
		onJunctionContextMenu: () => undefined,
	});
	const rendered = overlay.update(canvas, state, new Set(), (nodeId) => nodes.get(nodeId));
	assert.deepEqual([...rendered].sort(), ["edge-a", "edge-b"]);
	assert.equal(wrapper.querySelector("[data-branching-label]")?.textContent, "shared context");
	overlay.dispose();
});
