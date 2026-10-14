import test from "node:test";
import assert from "node:assert/strict";
import { enhanceNativeColorPicker } from "../src/native-color-picker";
import { PASTEL_COLORS } from "../src/colors";

async function pickerWindow(): Promise<any> {
	const { Window } = await import("happy-dom");
	return new Window({ url: "https://obsidian.local/" });
}

function nativeSubmenu(window: any): any {
	const menu = window.document.createElement("div");
	menu.className = "canvas-menu";
	const paletteButton = window.document.createElement("button");
	paletteButton.className = "clickable-icon";
	paletteButton.addEventListener("click", () => menu.remove());
	menu.append(paletteButton);
	const submenu = window.document.createElement("div");
	submenu.className = "canvas-submenu";
	for (let index = 0; index < 7; index += 1) {
		const item = window.document.createElement("div");
		item.className = "canvas-color-picker-item";
		item.setAttribute("aria-label", index === 0 ? "Theme default" : `Native ${index}`);
		submenu.append(item);
	}
	const custom = window.document.createElement("div");
	custom.className = "canvas-color-picker-item canvas-color-picker-custom";
	const input = window.document.createElement("input");
	input.type = "color";
	custom.append(input);
	submenu.append(custom);
	menu.append(submenu);
	window.document.body.append(menu);
	return submenu;
}

test("native picker receives pastel swatches and applies the selected colour", async () => {
	const window = await pickerWindow();
	const submenu = nativeSubmenu(window);
	const applied: string[] = [];
	let closed = 0;
	const handle = enhanceNativeColorPicker({
		document: window.document,
		window,
		submenu,
		colors: PASTEL_COLORS,
		apply: (color: string) => {
			applied.push(color);
			return { status: "applied" };
		},
		reset: () => ({ status: "unchanged" }),
		closeNative: () => {
			closed += 1;
		},
	});

	assert.ok(handle);
	assert.equal(submenu.querySelectorAll(".canvas-mindmap-native-color-swatch").length, PASTEL_COLORS.length);
	assert.equal(
		Array.from(submenu.querySelectorAll(".canvas-color-picker-item:not(.canvas-color-picker-custom)"))
			.filter((item: any) => item.hidden).length,
		7,
	);
	assert.ok(submenu.querySelector(".canvas-color-picker-custom input[type='color']"));

	const swatch: any = submenu.querySelector(".canvas-mindmap-native-color-swatch");
	swatch.click();
	assert.deepEqual(applied, [PASTEL_COLORS[0].hex]);
	assert.equal(closed, 1);
	assert.equal(submenu.querySelectorAll(".canvas-mindmap-native-color-swatch").length, 0);
});

test("native picker supports keyboard activation and keeps an error visible on failure", async () => {
	const window = await pickerWindow();
	const submenu = nativeSubmenu(window);
	let calls = 0;
	const handle = enhanceNativeColorPicker({
		document: window.document,
		window,
		submenu,
		colors: PASTEL_COLORS,
		apply: () => {
			calls += 1;
			return { status: "failed", reason: "write-rejected", message: "Canvas rejected the colour." };
		},
		reset: () => ({ status: "unchanged" }),
	});
	assert.ok(handle);

	const swatch: any = submenu.querySelector(".canvas-mindmap-native-color-swatch");
	swatch.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
	assert.equal(calls, 1);
	assert.equal(submenu.querySelector(".canvas-mindmap-native-color-error")?.textContent, "Canvas rejected the colour.");
	assert.ok(submenu.querySelector(".canvas-mindmap-native-color-swatch"));
});

test("native picker enhancement is idempotent and restores native items on dispose", async () => {
	const window = await pickerWindow();
	const submenu = nativeSubmenu(window);
	const options = {
		document: window.document,
		window,
		submenu,
		colors: PASTEL_COLORS,
		apply: () => ({ status: "unchanged" as const }),
		reset: () => ({ status: "unchanged" as const }),
	};
	const first = enhanceNativeColorPicker(options);
	assert.ok(first);
	assert.equal(enhanceNativeColorPicker(options), undefined);
	assert.equal(submenu.querySelectorAll(".canvas-mindmap-native-color-swatch").length, PASTEL_COLORS.length);

	first.dispose();
	assert.equal(submenu.querySelectorAll(".canvas-mindmap-native-color-swatch").length, 0);
	assert.equal(submenu.querySelectorAll(".canvas-color-picker-item:not(.canvas-color-picker-custom)").length, 7);
	assert.equal(submenu.querySelector(".canvas-color-picker-custom input")?.getAttribute("aria-label"), null);
});
