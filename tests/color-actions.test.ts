import test from "node:test";
import assert from "node:assert/strict";
import { applyCanvasColors, branchColorTargets, colorControlTargets } from "../src/color-actions";
import { PASTEL_COLORS } from "../src/colors";
import { attachChild } from "../src/tree-model";
import { CanvasData, defaultCanvasState } from "../src/types";

function node(id: string, color?: string) {
	return { id, x: 0, y: 0, width: 100, height: 60, type: "text" as const, text: id, ...(color ? { color } : {}) };
}

function edge(id: string, fromNode: string, toNode: string, color?: string) {
	return {
		id,
		fromNode,
		toNode,
		fromSide: "right" as const,
		toSide: "left" as const,
		...(color ? { color } : {}),
	};
}

function branchFixture(): { data: CanvasData; state: ReturnType<typeof defaultCanvasState> } {
	const state = defaultCanvasState();
	attachChild(state, "child", "root", "edge-root-child", 0);
	attachChild(state, "grandchild", "child", "edge-child-grandchild", 0);
	return {
		data: {
			nodes: [node("root"), node("child", "#old-child"), node("grandchild"), node("outside")],
			edges: [
				edge("edge-root-child", "root", "child", "#old-edge"),
				edge("edge-child-grandchild", "child", "grandchild"),
				edge("cross-link", "outside", "child", "#cross-link"),
		],
		},
		state,
	};
}

test("pastel palette exposes the fixed colours used by the Canvas UI", () => {
	assert.equal(PASTEL_COLORS.length, 8);
	assert.deepEqual(PASTEL_COLORS.map((colour) => colour.hex), [
		"#F4B6C2",
		"#F7C59F",
		"#F5E6A8",
		"#B8E0C2",
		"#B9D7EA",
		"#C7C5F2",
		"#DCC6E0",
		"#C8D5B9",
	]);
});

test("node colour changes only the requested node", () => {
	const { data } = branchFixture();
	assert.equal(applyCanvasColors(data, { nodeIds: ["child"], color: "#F4B6C2" }), true);
	assert.equal(data.nodes.find((item) => item.id === "child")?.color, "#F4B6C2");
	assert.equal(data.nodes.find((item) => item.id === "root")?.color, undefined);
	assert.equal(data.nodes.find((item) => item.id === "grandchild")?.color, undefined);
});

test("branch colour targets include descendants and managed edges but exclude cross-links", () => {
	const { data, state } = branchFixture();
	const targets = branchColorTargets(state, data, "child");
	assert.deepEqual([...targets.nodeIds].sort(), ["child", "grandchild"]);
	assert.deepEqual([...targets.edgeIds].sort(), ["edge-child-grandchild", "edge-root-child"]);

	applyCanvasColors(data, { ...targets, color: "#B8E0C2" });
	assert.equal(data.nodes.find((item) => item.id === "child")?.color, "#B8E0C2");
	assert.equal(data.nodes.find((item) => item.id === "grandchild")?.color, "#B8E0C2");
	assert.equal(data.edges.find((item) => item.id === "edge-child-grandchild")?.color, "#B8E0C2");
	assert.equal(data.edges.find((item) => item.id === "edge-root-child")?.color, "#B8E0C2");
	assert.equal(data.edges.find((item) => item.id === "cross-link")?.color, "#cross-link");
});

test("clearing colours removes only the targeted Canvas fields", () => {
	const { data } = branchFixture();
	assert.equal(applyCanvasColors(data, {
		nodeIds: ["child"],
		edgeIds: ["edge-root-child"],
		color: "#F7C59F",
	}), true);
	assert.equal(applyCanvasColors(data, {
		nodeIds: ["child"],
		edgeIds: ["edge-root-child"],
	}), true);
	assert.equal(data.nodes.find((item) => item.id === "child")?.color, undefined);
	assert.equal(data.edges.find((item) => item.id === "edge-root-child")?.color, undefined);
	assert.equal(data.edges.find((item) => item.id === "cross-link")?.color, "#cross-link");
});

test("colour controls expose the selected node and its managed incoming arrow", () => {
	const { data, state } = branchFixture();
	const targets = colorControlTargets(state, data, "child");

	assert.deepEqual([...targets.nodeIds], ["child"]);
	assert.deepEqual([...targets.incomingEdgeIds], ["edge-root-child"]);
});
