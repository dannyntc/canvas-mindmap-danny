import test from "node:test";
import assert from "node:assert/strict";
import { CanvasAdapter, CanvasLike } from "../src/canvas-adapter";

function canvas(overrides: Partial<CanvasLike> = {}): CanvasLike {
	return {
		nodes: new Map(),
		selection: new Set(),
		getData: () => ({ nodes: [], edges: [] }),
		importData: () => undefined,
		requestSave: () => undefined,
		requestFrame: () => undefined,
		x: 100,
		y: 50,
		zoom: 2,
		...overrides,
	};
}

test("viewport adapter reads and writes Canvas x/y/zoom without changing card data", () => {
	const target = canvas();
	const adapter = new CanvasAdapter(target);
	assert.deepEqual(adapter.viewport(), { x: 100, y: 50, zoom: 2 });
	assert.equal(adapter.setViewport({ x: 80, y: 60, zoom: 2 }), true);
	assert.deepEqual(adapter.viewport(), { x: 80, y: 60, zoom: 2 });
});

test("viewport adapter supports a native three-argument setter", () => {
	let latest = { x: 0, y: 0, zoom: 1 };
	const target = canvas({
		getViewport: () => latest,
		setViewport: (x: number, y: number, zoom: number) => {
			latest = { x, y, zoom };
		},
	});
	const adapter = new CanvasAdapter(target);
	assert.equal(adapter.setViewport({ x: -20, y: 30, zoom: 1.5 }), true);
	assert.deepEqual(adapter.viewport(), { x: -20, y: 30, zoom: 1.5 });
});

test("viewport adapter converts effective scale to native log2 zoom", () => {
	let rawZoom = 0;
	let scale = 1;
	const target = canvas({
		x: 0,
		y: 0,
		zoom: rawZoom,
		scale,
		getViewport: undefined,
		setViewport: (x: number, y: number, zoom: number) => {
			target.x = x;
			target.y = y;
			rawZoom = zoom;
			scale = Math.pow(2, zoom);
			target.zoom = rawZoom;
			target.scale = scale;
		},
	});
	const adapter = new CanvasAdapter(target);
	assert.deepEqual(adapter.viewport(), { x: 0, y: 0, zoom: 1, rawZoom: 0 });
	assert.equal(adapter.setViewport({ x: 10, y: -20, zoom: 4 }), true);
	assert.deepEqual(adapter.viewport(), { x: 10, y: -20, zoom: 4, rawZoom: 2 });
});
