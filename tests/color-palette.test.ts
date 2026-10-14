import test from "node:test";
import assert from "node:assert/strict";
import { openColorPalette } from "../src/color-palette";
import { PASTEL_COLORS } from "../src/colors";

async function paletteWindow(): Promise<any> {
	const { Window } = await import("happy-dom");
	return new Window({ url: "https://obsidian.local/" });
}

test("a pointer activation applies a swatch and closes the floating palette", async () => {
	const window = await paletteWindow();
	const applied: string[] = [];
	const palette = openColorPalette({
		document: window.document,
		window,
		label: "Node colour",
		colors: PASTEL_COLORS,
		apply: (color: string) => {
			applied.push(color);
			return { status: "applied" };
		},
		reset: () => ({ status: "unchanged" }),
	});

	const swatch: any = window.document.querySelector(".canvas-mindmap-color-swatch");
	assert.ok(swatch);
	swatch.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
	swatch.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

	assert.deepEqual(applied, [PASTEL_COLORS[0].hex]);
	assert.equal(window.document.querySelector(".canvas-mindmap-color-palette"), null);
	palette.close();
});

test("keyboard activation applies a swatch and does not depend on native click synthesis", async () => {
	const window = await paletteWindow();
	const applied: string[] = [];
	openColorPalette({
		document: window.document,
		window,
		label: "Node colour",
		colors: PASTEL_COLORS,
		apply: (color: string) => {
			applied.push(color);
			return { status: "applied" };
		},
		reset: () => ({ status: "unchanged" }),
	});

	const swatch: any = window.document.querySelector(".canvas-mindmap-color-swatch");
	assert.ok(swatch);
	swatch.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

	assert.deepEqual(applied, [PASTEL_COLORS[0].hex]);
	assert.equal(window.document.querySelector(".canvas-mindmap-color-palette"), null);
});

test("a failed colour application stays open and exposes an actionable error", async () => {
	const window = await paletteWindow();
	openColorPalette({
		document: window.document,
		window,
		label: "Node colour",
		colors: PASTEL_COLORS,
		apply: () => ({ status: "failed", reason: "read-only", message: "This Canvas is read-only." }),
		reset: () => ({ status: "failed", reason: "read-only", message: "This Canvas is read-only." }),
	});

	const swatch: any = window.document.querySelector(".canvas-mindmap-color-swatch");
	assert.ok(swatch);
	swatch.click();

	assert.ok(window.document.querySelector(".canvas-mindmap-color-palette"));
	assert.equal(
		window.document.querySelector(".canvas-mindmap-color-palette-error")?.textContent,
		"This Canvas is read-only.",
	);
});
