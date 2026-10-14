import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildSync } from "esbuild";
import { PASTEL_COLORS } from "../src/colors";

async function loadController(): Promise<{ Controller: any; window: any }> {
	const { Window } = await import("happy-dom");
	const window = new Window({ url: "https://obsidian.local/" });
	const bundle = buildSync({
		entryPoints: ["src/canvas-controller.ts"],
		bundle: true,
		platform: "node",
		format: "cjs",
		external: ["obsidian"],
		write: false,
	});
	const module = { exports: {} as Record<string, unknown> };
	const obsidian = {
		Menu: class {},
		Notice: class {},
		setIcon: () => undefined,
		setTooltip: () => undefined,
	};
	vm.runInNewContext(bundle.outputFiles[0].text, {
		module,
		exports: module.exports,
		require: (specifier: string) => specifier === "obsidian" ? obsidian : require(specifier),
		window,
		document: window.document,
		MutationObserver: window.MutationObserver,
		ResizeObserver: window.ResizeObserver,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		CSS: window.CSS,
		Map,
		Set,
		WeakMap,
		console,
		setTimeout,
		clearTimeout,
		crypto: globalThis.crypto,
		getComputedStyle: window.getComputedStyle.bind(window),
	});
	return { Controller: module.exports.CanvasController, window };
}

function appendNativePicker(window: any, wrapper: any): any {
	const menu = window.document.createElement("div");
	menu.className = "canvas-menu";
	const paletteButton = window.document.createElement("button");
	paletteButton.className = "clickable-icon";
	paletteButton.setAttribute("aria-label", "Set colour");
	menu.append(paletteButton);
	const submenu = window.document.createElement("div");
	submenu.className = "canvas-submenu";
	for (let index = 0; index < 7; index += 1) {
		const item = window.document.createElement("div");
		item.className = "canvas-color-picker-item";
		submenu.append(item);
	}
	const custom = window.document.createElement("div");
	custom.className = "canvas-color-picker-item canvas-color-picker-custom";
	const input = window.document.createElement("input");
	input.type = "color";
	custom.append(input);
	submenu.append(custom);
	menu.append(submenu);
	paletteButton.addEventListener("click", () => submenu.remove());
	wrapper.append(menu);
	return submenu;
}

test("controller preserves native picker input and applies a pastel colour to the selected card", async () => {
	const { Controller, window } = await loadController();
	const wrapper = window.document.createElement("div");
	wrapper.className = "canvas-wrapper";
	window.document.body.append(wrapper);
	const nodeElement = window.document.createElement("div");
	nodeElement.className = "canvas-node";
	wrapper.append(nodeElement);

	let data: any = {
		nodes: [{ id: "node", x: 0, y: 0, width: 100, height: 60, type: "text", text: "Node" }],
		edges: [],
	};
	const node = { ...data.nodes[0], nodeEl: nodeElement };
	let saves = 0;
	const canvas: any = {
		wrapperEl: wrapper,
		nodes: new Map([["node", node]]),
		selection: new Set([node]),
		getData: () => data,
		importData: (next: any) => {
			data = next;
			node.color = next.nodes[0].color;
		},
		requestSave: () => {
			saves += 1;
		},
		requestFrame: () => undefined,
		x: 0,
		y: 0,
		zoom: 0,
		scale: 1,
	};
	const state = {
		version: 1,
		enabled: true,
		autoLayout: false,
		autoHeight: false,
		defaultLayout: "balanced" as const,
		trees: {},
		relations: {},
		collapsedNodeIds: [],
		manualHeightNodeIds: [],
	};
	const controller = new Controller({
		view: { canvas, containerEl: wrapper },
		state,
		onStateChange: () => undefined,
	});
	controller.mount();

	const submenu = appendNativePicker(window, wrapper);
	await new Promise((resolve) => setTimeout(resolve, 20));
	const swatch: any = submenu.querySelector(".canvas-mindmap-native-color-swatch");
	assert.ok(swatch);

	const pointerDown = new window.PointerEvent("pointerdown", {
		bubbles: true,
		cancelable: true,
		isPrimary: true,
		pointerType: "mouse",
		button: 0,
		pointerId: 1,
	});
	swatch.dispatchEvent(pointerDown);
	assert.equal(pointerDown.defaultPrevented, false);
	assert.equal(canvas.x, 0);

	swatch.click();
	assert.equal(data.nodes[0].color, PASTEL_COLORS[0].hex);
	assert.equal(saves, 1);
	assert.equal(wrapper.querySelector(".canvas-mindmap-native-color-controls"), null);

	controller.dispose();
});

test("ordinary card clicks replace selection and empty-space clicks clear it", async () => {
	const { Controller, window } = await loadController();
	const wrapper = window.document.createElement("div");
	wrapper.className = "canvas-wrapper";
	window.document.body.append(wrapper);

	const firstElement = window.document.createElement("div");
	firstElement.className = "canvas-node";
	const secondElement = window.document.createElement("div");
	secondElement.className = "canvas-node";
	wrapper.append(firstElement, secondElement);
	const first = { id: "first", x: 0, y: 0, width: 100, height: 60, type: "text", nodeEl: firstElement };
	const second = { id: "second", x: 200, y: 0, width: 100, height: 60, type: "text", nodeEl: secondElement };
	const selection = new Set<any>([first]);
	const data: any = {
		nodes: [
			{ id: first.id, x: first.x, y: first.y, width: first.width, height: first.height, type: first.type },
			{ id: second.id, x: second.x, y: second.y, width: second.width, height: second.height, type: second.type },
		],
		edges: [],
	};
	const canvas: any = {
		wrapperEl: wrapper,
		nodes: new Map([[first.id, first], [second.id, second]]),
		selection,
		getData: () => data,
		importData: () => undefined,
		requestSave: () => undefined,
		requestFrame: () => undefined,
		deselectAll: () => selection.clear(),
		selectOnly: (node: any) => {
			selection.clear();
			selection.add(node);
		},
		x: 0,
		y: 0,
		zoom: 0,
		scale: 1,
	};
	const controller = new Controller({
		view: { canvas, containerEl: wrapper },
		state: {
			version: 1,
			enabled: true,
			autoLayout: false,
			autoHeight: false,
			defaultLayout: "balanced" as const,
			trees: {},
			relations: {},
			collapsedNodeIds: [],
			manualHeightNodeIds: [],
		},
		onStateChange: () => undefined,
	});
	controller.mount();

	secondElement.dispatchEvent(new window.PointerEvent("pointerdown", {
		bubbles: true,
		cancelable: true,
		isPrimary: true,
		pointerType: "mouse",
		button: 0,
		pointerId: 2,
	}));
	assert.deepEqual([...selection].map((node) => node.id), ["second"]);

	firstElement.dispatchEvent(new window.PointerEvent("pointerdown", {
		bubbles: true,
		cancelable: true,
		isPrimary: true,
		pointerType: "mouse",
		button: 0,
		pointerId: 3,
	}));
	assert.deepEqual([...selection].map((node) => node.id), ["first"]);

	secondElement.dispatchEvent(new window.PointerEvent("pointerdown", {
		bubbles: true,
		cancelable: true,
		isPrimary: true,
		pointerType: "mouse",
		button: 0,
		pointerId: 5,
		shiftKey: true,
	}));
	assert.deepEqual([...selection].map((node) => node.id), ["first"]);

	wrapper.dispatchEvent(new window.PointerEvent("pointerdown", {
		bubbles: true,
		cancelable: true,
		isPrimary: true,
		pointerType: "mouse",
		button: 0,
		pointerId: 4,
	}));
	assert.equal(selection.size, 0);

	controller.dispose();
});

test("dragging a card makes nearby cards move aside and return when the path clears", async () => {
	const { Controller, window } = await loadController();
	const wrapper = window.document.createElement("div");
	wrapper.className = "canvas-wrapper";
	window.document.body.append(wrapper);
	const movingElement = window.document.createElement("div");
	movingElement.className = "canvas-node";
	const nearbyElement = window.document.createElement("div");
	nearbyElement.className = "canvas-node";
	wrapper.append(movingElement, nearbyElement);
	const moving: any = { id: "moving", x: 0, y: 0, width: 100, height: 60, type: "text", nodeEl: movingElement };
	const nearby: any = { id: "nearby", x: 110, y: 0, width: 100, height: 60, type: "text", nodeEl: nearbyElement };
	const data: any = { nodes: [moving, nearby], edges: [] };
	const selection = new Set<any>([moving]);
	const canvas: any = {
		wrapperEl: wrapper,
		nodes: new Map([[moving.id, moving], [nearby.id, nearby]]),
		selection,
		getData: () => data,
		importData: (next: any) => {
			data.nodes = next.nodes;
			data.edges = next.edges;
		},
		requestSave: () => undefined,
		requestFrame: () => undefined,
		deselectAll: () => selection.clear(),
		handleSelectionDrag: (_event: any, _target: any, node: any) => ({
			move: (event: any) => {
				node.x = event.clientX;
				node.y = event.clientY;
			},
			end: () => undefined,
		}),
		x: 0,
		y: 0,
		zoom: 0,
		scale: 1,
	};
	const controller = new Controller({
		view: { canvas, containerEl: wrapper },
		state: {
			version: 1,
			enabled: true,
			autoLayout: true,
			autoHeight: false,
			defaultLayout: "balanced" as const,
			trees: {},
			relations: {},
			collapsedNodeIds: [],
			manualHeightNodeIds: [],
		},
		onStateChange: () => undefined,
	});
	controller.mount();

	movingElement.dispatchEvent(new window.PointerEvent("pointerdown", {
		bubbles: true,
		cancelable: true,
		isPrimary: true,
		pointerType: "mouse",
		button: 0,
		pointerId: 9,
	}));
	const start = new window.PointerEvent("pointerdown", { pointerId: 9, clientX: 0, clientY: 0 });
	const callbacks = canvas.handleSelectionDrag(start, movingElement, moving);
	callbacks.move(new window.PointerEvent("pointermove", { pointerId: 9, clientX: 20, clientY: 0 }));
	assert.equal(nearby.x, 144);
	callbacks.move(new window.PointerEvent("pointermove", { pointerId: 9, clientX: 0, clientY: 0 }));
	assert.equal(nearby.x, 110);
	callbacks.end(new window.PointerEvent("pointerup", { pointerId: 9, clientX: 0, clientY: 0 }));
	controller.dispose();
});

test("a connection target is highlighted only after the hold delay", async () => {
	const { Controller, window } = await loadController();
	const wrapper = window.document.createElement("div");
	wrapper.className = "canvas-wrapper";
	window.document.body.append(wrapper);
	const movingElement = window.document.createElement("div");
	movingElement.className = "canvas-node";
	const targetElement = window.document.createElement("div");
	targetElement.className = "canvas-node";
	wrapper.append(movingElement, targetElement);
	const moving: any = { id: "moving", x: 0, y: 0, width: 100, height: 60, type: "text", nodeEl: movingElement };
	const target: any = { id: "target", x: 110, y: 0, width: 100, height: 60, type: "text", nodeEl: targetElement };
	const data: any = { nodes: [moving, target], edges: [] };
	const selection = new Set<any>([moving]);
	const canvas: any = {
		wrapperEl: wrapper,
		nodes: new Map([[moving.id, moving], [target.id, target]]),
		selection,
		getData: () => data,
		importData: (next: any) => { data.nodes = next.nodes; data.edges = next.edges; },
		requestSave: () => undefined,
		requestFrame: () => undefined,
		deselectAll: () => selection.clear(),
		handleSelectionDrag: (_event: any, _target: any, node: any) => ({
			move: (event: any) => { node.x = event.clientX; node.y = event.clientY; },
			end: () => undefined,
		}),
		x: 0,
		y: 0,
		zoom: 0,
		scale: 1,
	};
	const controller = new Controller({
		view: { canvas, containerEl: wrapper },
		state: {
			version: 1,
			enabled: true,
			autoLayout: true,
			autoHeight: false,
			defaultLayout: "balanced" as const,
			trees: {},
			relations: {},
			collapsedNodeIds: [],
			manualHeightNodeIds: [],
		},
		onStateChange: () => undefined,
	});
	controller.mount();
	movingElement.dispatchEvent(new window.PointerEvent("pointerdown", {
		bubbles: true,
		cancelable: true,
		isPrimary: true,
		pointerType: "mouse",
		button: 0,
		pointerId: 10,
	}));
	const callbacks = canvas.handleSelectionDrag(new window.PointerEvent("pointerdown", { pointerId: 10 }), movingElement, moving);
	callbacks.move(new window.PointerEvent("pointermove", { pointerId: 10, clientX: 20, clientY: 0 }));
	assert.equal(targetElement.classList.contains("canvas-mindmap-drop-target"), false);
	await new Promise((resolve) => setTimeout(resolve, 550));
	assert.equal(targetElement.classList.contains("canvas-mindmap-drop-target"), true);
	assert.equal(target.x, 110);
	callbacks.cancel?.(new window.PointerEvent("pointercancel", { pointerId: 10 }));
	controller.dispose();
});

test("creating a child makes room at its intended insertion point", async () => {
	const { Controller, window } = await loadController();
	const wrapper = window.document.createElement("div");
	wrapper.className = "canvas-wrapper";
	window.document.body.append(wrapper);
	const parentElement = window.document.createElement("div");
	parentElement.className = "canvas-node";
	const nearbyElement = window.document.createElement("div");
	nearbyElement.className = "canvas-node";
	wrapper.append(parentElement, nearbyElement);
	const parent: any = { id: "parent", x: 0, y: 0, width: 100, height: 60, type: "text", nodeEl: parentElement };
	const nearby: any = { id: "nearby", x: 450, y: 0, width: 100, height: 60, type: "text", nodeEl: nearbyElement };
	const data: any = { nodes: [parent, nearby], edges: [] };
	const selection = new Set<any>([parent]);
	const canvas: any = {
		wrapperEl: wrapper,
		nodes: new Map([[parent.id, parent], [nearby.id, nearby]]),
		selection,
		getData: () => data,
		importData: (next: any) => { data.nodes = next.nodes; data.edges = next.edges; },
		requestSave: () => undefined,
		requestFrame: () => undefined,
		deselectAll: () => selection.clear(),
		x: 0,
		y: 0,
		zoom: 0,
		scale: 1,
	};
	const controller = new Controller({
		view: { canvas, containerEl: wrapper },
		state: {
			version: 1,
			enabled: true,
			autoLayout: true,
			autoHeight: false,
			defaultLayout: "balanced" as const,
			trees: {},
			relations: {},
			collapsedNodeIds: [],
			manualHeightNodeIds: [],
		},
		onStateChange: () => undefined,
	});
	controller.mount();

	assert.equal(controller.createChild("parent"), true);
	assert.equal(data.nodes.some((node: any) => node.id.startsWith("canvas-mindmap-node-")), true);
	assert.equal(data.nodes.find((node: any) => node.id === "nearby").x, 524);
	controller.dispose();
});

test("clicking Arrange mind map moves the selected tree and reports success", async () => {
	const { Controller, window } = await loadController();
	const wrapper = window.document.createElement("div");
	wrapper.className = "canvas-wrapper";
	const controls = window.document.createElement("div");
	controls.className = "canvas-controls";
	const history = window.document.createElement("div");
	history.className = "canvas-control-item";
	history.setAttribute("aria-label", "Undo");
	controls.append(history);
	wrapper.append(controls);
	window.document.body.append(wrapper);

	let data: any = {
		nodes: [
			{ id: "root", x: 100, y: 100, width: 120, height: 80, type: "text", text: "Root" },
			{ id: "child", x: 700, y: 700, width: 100, height: 60, type: "text", text: "Child" },
		],
		edges: [{ id: "edge", fromNode: "root", fromSide: "right", toNode: "child", toSide: "left" }],
	};
	const root = { ...data.nodes[0] };
	const child = { ...data.nodes[1] };
	const selection = new Set<any>([child]);
	const notices: string[] = [];
	const canvas: any = {
		wrapperEl: wrapper,
		nodes: new Map([[root.id, root], [child.id, child]]),
		selection,
		getData: () => data,
		importData: (next: any) => { data = next; },
		requestSave: () => undefined,
		requestFrame: () => undefined,
		deselectAll: () => selection.clear(),
		x: 0,
		y: 0,
		zoom: 0,
		scale: 1,
	};
	const controller = new Controller({
		view: { canvas, containerEl: wrapper },
		state: {
			version: 1,
			enabled: true,
			autoLayout: false,
			autoHeight: false,
			defaultLayout: "left-to-right" as const,
			trees: { root: { layout: "left-to-right", branchSides: {} } },
			relations: { child: { parentId: "root", edgeId: "edge", order: 0 } },
			collapsedNodeIds: [],
			manualHeightNodeIds: [],
		},
		onStateChange: () => undefined,
		notify: (message: string) => notices.push(message),
	});
	controller.mount();

	const arrange = wrapper.querySelector("[data-canvas-mindmap-action='arrange']") as HTMLButtonElement | null;
	assert.ok(arrange);
	arrange.click();

	assert.equal(data.nodes.find((node: any) => node.id === "child").x, 420);
	assert.deepEqual(notices, ["Mind map arranged."]);
	controller.dispose();

	const replacementNotices: string[] = [];
	const replacement = new Controller({
		view: { canvas, containerEl: wrapper },
		state: {
			version: 1,
			enabled: true,
			autoLayout: false,
			autoHeight: false,
			defaultLayout: "left-to-right" as const,
			trees: { root: { layout: "left-to-right", branchSides: {} } },
			relations: { child: { parentId: "root", edgeId: "edge", order: 0 } },
			collapsedNodeIds: [],
			manualHeightNodeIds: [],
		},
		onStateChange: () => undefined,
		notify: (message: string) => replacementNotices.push(message),
	});
	replacement.mount();
	const replacementArrange = wrapper.querySelector("[data-canvas-mindmap-action='arrange']") as HTMLButtonElement | null;
	assert.ok(replacementArrange);
	assert.notEqual(replacementArrange, arrange);
	replacementArrange.click();
	assert.deepEqual(replacementNotices, ["Mind map is already arranged."]);
	replacement.dispose();
});
