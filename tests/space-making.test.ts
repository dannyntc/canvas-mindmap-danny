import test from "node:test";
import assert from "node:assert/strict";
import {
	buildSpaceMakingGroups,
	resolveSpaceMaking,
	SpaceMakingNode,
} from "../src/space-making";

function node(id: string, x: number, y: number, width = 100, height = 60): SpaceMakingNode {
	return { id, x, y, width, height };
}

function positions(result: ReturnType<typeof resolveSpaceMaking>, ...ids: string[]): Record<string, { x: number; y: number }> {
	return Object.fromEntries(ids.map((id) => [id, result.positions[id]]));
}

test("pushes an obstructing card clear of the moving card", () => {
	const nodes = [node("moving", 0, 0), node("near", 110, 0), node("far", 400, 0)];
	const groups = [
		{ id: "near", memberIds: ["near"] },
		{ id: "far", memberIds: ["far"] },
	];
	const result = resolveSpaceMaking(nodes, new Set(["moving"]), {
		moving: { x: 20, y: 0 },
	}, groups);

	assert.deepEqual(positions(result, "near", "far"), {
		near: { x: 168, y: 0 },
		far: { x: 400, y: 0 },
	});
});

test("propagates a push through a chain while leaving distant cards fixed", () => {
	const nodes = [node("moving", 0, 0), node("first", 110, 0), node("second", 220, 0), node("distant", 500, 0)];
	const groups = nodes.slice(1).map((item) => ({ id: item.id, memberIds: [item.id] }));
	const result = resolveSpaceMaking(nodes, new Set(["moving"]), {
		moving: { x: 40, y: 0 },
	}, groups);

	assert.equal(result.positions.first.x, 188);
	assert.deepEqual(result.positions.second, { x: 220, y: 108 });
	assert.deepEqual(result.positions.distant, { x: 500, y: 0 });
});

test("recomputing from the original geometry lets cards return when the mover retreats", () => {
	const nodes = [node("moving", 0, 0), node("near", 110, 0)];
	const groups = [{ id: "near", memberIds: ["near"] }];
	const pushed = resolveSpaceMaking(nodes, new Set(["moving"]), { moving: { x: 40, y: 0 } }, groups);
	const clear = resolveSpaceMaking(nodes, new Set(["moving"]), { moving: { x: 0, y: 0 } }, groups);

	assert.equal(pushed.positions.near.x, 188);
	assert.equal(clear.positions.near.x, 110);
});

test("moves a branch group together and keeps the moving branch out of obstacle groups", () => {
	const groups = buildSpaceMakingGroups(
		["root", "moving", "moving-child", "side", "side-child"],
		new Set(["moving", "moving-child"]),
		{
			root: undefined,
			moving: "root",
			"moving-child": "moving",
			side: "root",
			"side-child": "side",
		},
	);

	assert.deepEqual(groups, [
		{ id: "root", memberIds: ["root", "side", "side-child"] },
	]);
});

test("protected groups remain at their original positions while other groups move", () => {
	const nodes = [node("moving", 0, 0), node("target", 110, 0), node("other", 220, 0)];
	const groups = [
		{ id: "target", memberIds: ["target"] },
		{ id: "other", memberIds: ["other"] },
	];
	const result = resolveSpaceMaking(
		nodes,
		new Set(["moving"]),
		{ moving: { x: 40, y: 0 } },
		groups,
		{ protectedGroupIds: new Set(["target"]) },
	);

	assert.deepEqual(result.positions.target, { x: 110, y: 0 });
	assert.equal(result.positions.other.x, 220);
});
