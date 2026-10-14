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
