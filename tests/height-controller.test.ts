import test from "node:test";
import assert from "node:assert/strict";
import { CanvasAdapter } from "../src/canvas-adapter";
import { HeightController } from "../src/height-controller";
import { CanvasMindMapState, CanvasNodeData } from "../src/types";

interface HarnessOptions {
	width?: number;
	height?: number;
	measuredHeight?: number;
	manual?: boolean;
	externalResizeOwner?: boolean;
}

function state(manual: boolean): CanvasMindMapState {
	return {
		version: 1,
		enabled: true,
		autoLayout: false,
		autoHeight: true,
		defaultLayout: "left-to-right",
		trees: {},
		relations: {},
		collapsedNodeIds: [],
		manualHeightNodeIds: manual ? ["node"] : [],
	};
}

function harness(options: HarnessOptions = {}) {
	const nodeEl = {
		style: { height: "" },
		classList: { contains: () => false },
		querySelector: () => null,
		scrollHeight: options.measuredHeight ?? 120,
		offsetHeight: options.measuredHeight ?? 120,
	} as unknown as HTMLElement;
	const node: CanvasNodeData & { nodeEl: HTMLElement } = {
		id: "node",
		x: 0,
		y: 0,
		width: options.width ?? 200,
		height: options.height ?? 60,
		type: "text",
		nodeEl,
	};
	const resizes: Array<{ width: number; height: number }> = [];
	const adapter = {
		nodes: () => [node],
		node: (id: string) => id === node.id ? node : undefined,
		resizeNode: (_id: string, width: number, height: number) => {
			node.width = width;
			node.height = height;
			resizes.push({ width, height });
			return true;
		},
		isTextNode: () => true,
		requestFrame: () => undefined,
	} as unknown as CanvasAdapter;
	const controller = new HeightController({
		adapter,
		getState: () => state(options.manual ?? false),
		isEnabled: () => true,
		isExternalResizeOwner: () => options.externalResizeOwner ?? false,
	});
	const originalGetComputedStyle = globalThis.getComputedStyle;
	globalThis.getComputedStyle = (() => ({
		paddingTop: "0px",
		paddingBottom: "0px",
		borderTopWidth: "0px",
		borderBottomWidth: "0px",
	}) as unknown) as typeof globalThis.getComputedStyle;
	return {
		node,
		controller,
		resizes,
		restore: () => {
			globalThis.getComputedStyle = originalGetComputedStyle;
		},
	};
}

test("automatic sizing keeps width and gives one-line cards a 60px minimum", () => {
	const testHarness = harness();
	try {
		assert.equal(testHarness.controller.recalculate("node"), true);
		assert.deepEqual(testHarness.resizes, [{ width: 200, height: 152 }]);
	} finally {
		testHarness.restore();
	}
});

test("automatic sizing is independent of Canvas zoom", () => {
	const testHarness = harness();
	try {
		assert.equal(testHarness.controller.recalculate("node"), true);
		assert.deepEqual(testHarness.resizes, [{ width: 200, height: 152 }]);
	} finally {
		testHarness.restore();
	}
});

test("repeated automatic measurements do not accumulate clearance", () => {
	const testHarness = harness();
	try {
		assert.equal(testHarness.controller.recalculate("node"), true);
		assert.equal(testHarness.controller.recalculate("node"), false);
		testHarness.controller.pause();
		assert.equal(testHarness.controller.recalculate("node"), false);
		assert.equal(testHarness.resizes.length, 1);
	} finally {
		testHarness.restore();
	}
});

test("automatic height repairs a card that was shrunk after its target was cached", () => {
	const testHarness = harness();
	try {
		assert.equal(testHarness.controller.recalculate("node"), true);
		testHarness.node.height = 60;
		assert.equal(testHarness.controller.recalculate("node"), true);
		assert.deepEqual(testHarness.resizes, [
			{ width: 200, height: 152 },
			{ width: 200, height: 152 },
		]);
	} finally {
		testHarness.restore();
	}
});

test("an externally changed width is preserved by automatic height", () => {
	const testHarness = harness();
	try {
		assert.equal(testHarness.controller.recalculate("node"), true);
		testHarness.node.width = 300;
		assert.equal(testHarness.controller.recalculate("node"), false);
		assert.deepEqual(testHarness.resizes, [{ width: 200, height: 152 }]);
	} finally {
		testHarness.restore();
	}
});

test("automatic sizing keeps the minimum height", () => {
	const testHarness = harness({ measuredHeight: 20, height: 40 });
	try {
		assert.equal(testHarness.controller.recalculate("node"), true);
		assert.deepEqual(testHarness.resizes, [{ width: 200, height: 60 }]);
	} finally {
		testHarness.restore();
	}
});

test("explicit bottom fitting remains stable until the card changes again", () => {
	const testHarness = harness({ measuredHeight: 20, height: 72 });
	try {
		testHarness.controller.setExplicitFitHeight("node", 72);
		assert.equal(testHarness.controller.recalculate("node"), false);
		assert.deepEqual(testHarness.resizes, []);

		testHarness.node.height = 40;
		assert.equal(testHarness.controller.recalculate("node"), true);
		assert.deepEqual(testHarness.resizes, [{ width: 200, height: 60 }]);
	} finally {
		testHarness.restore();
	}
});

test("manual vertical resizing defers automatic correction until release", () => {
	const testHarness = harness({ measuredHeight: 120, height: 60 });
	try {
		testHarness.controller.beginManualResize("node");
		testHarness.node.height = 220;
		assert.equal(testHarness.controller.recalculate("node"), false);
		assert.equal(testHarness.controller.schedule("node"), undefined);
		assert.deepEqual(testHarness.resizes, []);

		testHarness.controller.endManualResize("node");
		assert.deepEqual(testHarness.resizes, [{ width: 200, height: 152 }]);
	} finally {
		testHarness.restore();
	}
});

test("manual and externally owned cards are not resized", () => {
	for (const options of [{ manual: true }, { externalResizeOwner: true }]) {
		const testHarness = harness(options);
		try {
			assert.equal(testHarness.controller.recalculate("node"), false);
			assert.deepEqual(testHarness.resizes, []);
		} finally {
			testHarness.restore();
		}
	}
});
