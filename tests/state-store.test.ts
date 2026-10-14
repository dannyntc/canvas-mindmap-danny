import test from "node:test";
import assert from "node:assert/strict";
import { CanvasMindMapStore, migratePluginData } from "../src/state-store";
import { defaultCanvasState } from "../src/types";

test("migration preserves legacy settings and adds disabled per-canvas state", () => {
	const migrated = migratePluginData({
		navigate: { useNavigate: false },
		layout: { direction: "RL" },
	});
	const legacy = migrated as typeof migrated & { navigate: { useNavigate: boolean }; layout: { direction: string } };
	assert.equal(legacy.navigate.useNavigate, false);
	assert.equal(legacy.layout.direction, "RL");
	assert.deepEqual(migrated.mindMaps, {});
	const store = new CanvasMindMapStore(migrated);
	assert.equal(store.get("Maps/demo.canvas").enabled, false);
});

test("canvas records survive rename and stale metadata cleanup", () => {
	const store = new CanvasMindMapStore();
	const state = defaultCanvasState();
	state.enabled = true;
	state.collapsedNodeIds = ["missing"];
	state.relations.missing = { parentId: "root", edgeId: "missing-edge", order: 0 };
	store.set("old.canvas", state);
	store.rename("old.canvas", "new.canvas");
	assert.equal(store.has("old.canvas"), false);
	assert.equal(store.get("new.canvas").enabled, true);
	const clean = store.cleanup("new.canvas", {
		nodes: [{ id: "root", x: 0, y: 0, width: 100, height: 60, type: "text" }],
		edges: [],
	});
	assert.deepEqual(clean.collapsedNodeIds, []);
	assert.deepEqual(clean.relations, {});
});

test("state snapshots are defensive copies", () => {
	const store = new CanvasMindMapStore();
	const state = store.get("copy.canvas");
	state.enabled = true;
	assert.equal(store.get("copy.canvas").enabled, false);
	store.set("copy.canvas", state);
	const snapshot = store.snapshot();
	(snapshot.mindMaps["copy.canvas"] as any).enabled = false;
	assert.equal(store.get("copy.canvas").enabled, true);
});
