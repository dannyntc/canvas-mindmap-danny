import test from "node:test";
import assert from "node:assert/strict";
import { CanvasAdapter, CanvasLike, CanvasNodeLike } from "../src/canvas-adapter";
import { CanvasData } from "../src/types";

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

test("node type resolves from the native getData method", () => {
	const liveNode: CanvasNodeLike = {
		id: "node",
		x: 0,
		y: 0,
		width: 100,
		height: 60,
		getData: () => ({ id: "node", x: 0, y: 0, width: 100, height: 60, type: "text" }),
	};
	const adapter = new CanvasAdapter(canvas({ nodes: new Map([[liveNode.id, liveNode]]) }));
	assert.equal(adapter.isTextNode(liveNode), true);
});

test("viewport adapter supports a native three-argument setter", () => {
	let latest = { x: 0, y: 0, zoom: 1 };
	let receiverSeen = false;
	const target = canvas({
		getViewport: () => latest,
		setViewport: function (this: CanvasLike, x: number, y: number, zoom: number) {
			receiverSeen = this === target;
			latest = { x, y, zoom };
		},
	});
	const adapter = new CanvasAdapter(target);
	assert.equal(adapter.setViewport({ x: -20, y: 30, zoom: 1.5 }), true);
	assert.equal(receiverSeen, true);
	assert.deepEqual(adapter.viewport(), { x: -20, y: 30, zoom: 1.5 });
});

test("writeData asks Canvas importData to remove missing live objects", () => {
	let removeMissing: boolean | undefined;
	const target = canvas({
		importData: function (_data, shouldRemoveMissing) {
			removeMissing = shouldRemoveMissing;
		},
	});
	const adapter = new CanvasAdapter(target);
	assert.equal(adapter.writeData({ nodes: [], edges: [] }), true);
	assert.equal(removeMissing, true);
});

test("transaction rejects a Canvas import that does not persist the requested colour", () => {
	const originalData: CanvasData = {
		nodes: [{ id: "node", x: 0, y: 0, width: 100, height: 60, type: "text", text: "Node" }],
		edges: [],
	};
	const target = canvas({
		getData: () => originalData,
		importData: function () {
			// Simulate a runtime that accepts importData but does not apply it.
		},
	});
	const adapter = new CanvasAdapter(target);

	const transaction = adapter.transaction("Set node colour", (data) => {
		data.nodes[0].color = "#F4B6C2";
	});

	assert.equal(transaction, undefined);
});

test("transaction verification can reject a partially applied Canvas snapshot", () => {
	let storedData: CanvasData = {
		nodes: [{ id: "node", x: 0, y: 0, width: 100, height: 60, type: "text", text: "Node" }],
		edges: [],
	};
	const target = canvas({
		getData: () => storedData,
		importData: (data) => {
			storedData = {
				...data,
				nodes: data.nodes.map(({ color: _color, ...node }) => node),
			};
		},
	});
	const adapter = new CanvasAdapter(target);

	const transaction = adapter.transaction(
		"Set node colour",
		(data) => {
			data.nodes[0].color = "#F4B6C2";
		},
		(_before, _requested, after) => after.nodes[0]?.color === "#F4B6C2",
	);

	assert.equal(transaction, undefined);
	assert.equal(storedData.nodes[0]?.color, undefined);
});

test("transaction rolls back when Canvas save scheduling fails", () => {
	const originalData: CanvasData = {
		nodes: [{ id: "node", x: 0, y: 0, width: 100, height: 60, type: "text", text: "Node" }],
		edges: [],
	};
	let storedData = originalData;
	const target = canvas({
		getData: () => storedData,
		importData: (data) => {
			storedData = data;
		},
		requestSave: () => {
			throw new Error("save unavailable");
		},
	});
	const adapter = new CanvasAdapter(target);

	const transaction = adapter.transaction("Set node colour", (data) => {
		data.nodes[0].color = "#F4B6C2";
	});

	assert.equal(transaction, undefined);
	assert.deepEqual(storedData, originalData);
});

test("selection-drag observer preserves native receiver and callback order", () => {
	const events: string[] = [];
	let nativeReceiver: CanvasLike | undefined;
	const original = function (this: CanvasLike) {
		nativeReceiver = this;
		return {
			move: () => events.push("native-move"),
			end: () => events.push("native-end"),
		};
	};
	const target = canvas({ handleSelectionDrag: original });
	const adapter = new CanvasAdapter(target);
	const remove = adapter.observeSelectionDrag({
		onStart: () => events.push("start"),
		onMove: () => events.push("move"),
		onEnd: () => events.push("end"),
	});
	assert.ok(remove);
	const callbacks = target.handleSelectionDrag!.call(
		target,
		{} as PointerEvent,
		{} as HTMLElement,
		{ id: "node", x: 0, y: 0, width: 10, height: 10, type: "text" },
	);
	callbacks.move?.({} as PointerEvent);
	callbacks.end?.({} as PointerEvent);
	assert.equal(nativeReceiver, target);
	assert.deepEqual(events, ["start", "native-move", "move", "native-end", "end"]);
	remove?.();
	assert.equal(target.handleSelectionDrag, original);
});

test("data-import observer preserves native receiver and snapshot payload", () => {
	const events: string[] = [];
	const original = function (this: CanvasLike, data: CanvasData, removeMissing?: boolean) {
		events.push(`${this === target}:${removeMissing}:${data.nodes.length}`);
	};
	const target = canvas({ importData: original });
	const adapter = new CanvasAdapter(target);
	const remove = adapter.observeDataImport((data) => events.push(`observed:${data.edges.length}`));
	target.importData!({ nodes: [], edges: [] }, true);
	assert.deepEqual(events, ["true:true:0", "observed:0"]);
	remove?.();
	assert.equal(target.importData, original);
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

test("stopEditing invokes the native exit method and reports support", () => {
	let receiverSeen = false;
	let editing = true;
	const node: CanvasNodeLike = {
		id: "node",
		x: 0,
		y: 0,
		width: 100,
		height: 60,
		type: "text",
		stopEditing: function (this: CanvasNodeLike) {
			receiverSeen = this === node;
			editing = false;
		},
	};
	const target = canvas({ nodes: new Map([[node.id, node]]) });
	const adapter = new CanvasAdapter(target);
	assert.equal(adapter.stopEditing(node.id), true);
	assert.equal(receiverSeen, true);
	assert.equal(editing, false);
	assert.equal(adapter.stopEditing("missing"), false);
});
