import { ColorApplyResult, ColorPaletteColor } from "./color-palette";

export interface NativeColorPickerOptions {
	document: Document;
	window: Window;
	submenu: HTMLElement;
	colors: readonly ColorPaletteColor[];
	currentColor?: string;
	apply: (color: string) => ColorApplyResult;
	reset: () => ColorApplyResult;
	closeNative?: () => void;
}

export interface NativeColorPickerHandle {
	dispose: () => void;
}

interface NativeItemSnapshot {
	element: HTMLElement;
	hidden: boolean;
	ariaHidden: string | null;
	tabIndex: string | null;
}

const ENHANCED_ATTRIBUTE = "data-canvas-mindmap-native-color-picker";

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return "The colour could not be applied. Check that this Canvas is writable and try again.";
}

function nativePresetItems(submenu: HTMLElement): HTMLElement[] {
	return Array.from(submenu.querySelectorAll<HTMLElement>(
		".canvas-color-picker-item:not(.canvas-color-picker-custom)",
	));
}

function restoreNativeItems(items: readonly NativeItemSnapshot[]): void {
	for (const snapshot of items) {
		snapshot.element.classList.remove("canvas-mindmap-native-color-hidden");
		snapshot.element.hidden = snapshot.hidden;
		if (snapshot.ariaHidden === null) snapshot.element.removeAttribute("aria-hidden");
		else snapshot.element.setAttribute("aria-hidden", snapshot.ariaHidden);
		if (snapshot.tabIndex === null) snapshot.element.removeAttribute("tabindex");
		else snapshot.element.setAttribute("tabindex", snapshot.tabIndex);
	}
}

function setError(element: HTMLElement, message: string): void {
	element.textContent = message;
	element.hidden = !message;
}

/**
 * Adds the plugin's pastel choices to Obsidian's native selection colour
 * submenu. The native preset items remain available after disposal.
 */
export function enhanceNativeColorPicker(
	options: NativeColorPickerOptions,
): NativeColorPickerHandle | undefined {
	const { submenu } = options;
	if (submenu.getAttribute(ENHANCED_ATTRIBUTE) === "true") return undefined;
	const nativeItems = nativePresetItems(submenu);
	const customItem = submenu.querySelector<HTMLElement>(".canvas-color-picker-custom");
	if (nativeItems.length === 0 || !customItem) return undefined;
	const customInput = customItem.querySelector<HTMLInputElement>("input[type='color']");
	const originalCustomAriaLabel = customInput?.getAttribute("aria-label") ?? null;

	const nativeSnapshots = nativeItems.map((element) => ({
		element,
		hidden: element.hidden,
		ariaHidden: element.getAttribute("aria-hidden"),
		tabIndex: element.getAttribute("tabindex"),
	}));
	for (const element of nativeItems) {
		element.classList.add("canvas-mindmap-native-color-hidden");
		element.hidden = true;
		element.setAttribute("aria-hidden", "true");
		element.setAttribute("tabindex", "-1");
	}

	const document = options.document;
	const controls = document.createElement("div");
	controls.className = "canvas-mindmap-native-color-controls";
	controls.setAttribute("role", "group");
	controls.setAttribute("aria-label", "Pastel colours");

	const swatches = document.createElement("div");
	swatches.className = "canvas-mindmap-native-color-swatches";
	controls.append(swatches);

	const error = document.createElement("div");
	error.className = "canvas-mindmap-native-color-error";
	error.setAttribute("role", "alert");
	error.hidden = true;
	controls.append(error);
	if (customInput && !customInput.getAttribute("aria-label")) {
		customInput.setAttribute("aria-label", "Custom colour");
	}

	const restoreCustomInputLabel = (): void => {
		if (!customInput) return;
		if (originalCustomAriaLabel === null) customInput.removeAttribute("aria-label");
		else customInput.setAttribute("aria-label", originalCustomAriaLabel);
	};

	let closed = false;
	let handle: NativeColorPickerHandle;

	const dispose = (): void => {
		if (closed) return;
		closed = true;
		controls.remove();
		restoreNativeItems(nativeSnapshots);
		restoreCustomInputLabel();
		submenu.removeAttribute(ENHANCED_ATTRIBUTE);
	};

	const close = (): void => {
		if (closed) return;
		closed = true;
		controls.remove();
		restoreNativeItems(nativeSnapshots);
		restoreCustomInputLabel();
		submenu.removeAttribute(ENHANCED_ATTRIBUTE);
		try {
			options.closeNative?.();
		} finally {
			// If the native palette button cannot be found or its private state has
			// already been cleared, do not leave an orphaned submenu visible.
			if (submenu.isConnected) submenu.remove();
		}
	};

	const runApply = (apply: () => ColorApplyResult): void => {
		if (closed) return;
		try {
			const result = apply();
			if (result.status === "failed") setError(error, result.message);
			else close();
		} catch (caught) {
			setError(error, errorMessage(caught));
		}
	};

	const activateFromKeyboard = (event: KeyboardEvent, button: HTMLButtonElement): void => {
		if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
		event.preventDefault();
		event.stopPropagation();
		button.click();
	};

	for (const color of options.colors) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "canvas-mindmap-native-color-swatch";
		button.style.setProperty("--canvas-mindmap-swatch", color.hex);
		// Obsidian's native submenu applies theme button rules with selectors
		// that can override the plugin stylesheet. Paint the actual colour on
		// the element as well so the swatch cannot silently fall back to grey.
		button.style.setProperty("background-color", color.hex, "important");
		button.style.setProperty("background-image", "none", "important");
		button.style.setProperty("opacity", "1", "important");
		button.setAttribute("aria-label", `Pastel colour: ${color.label}`);
		button.setAttribute("title", color.label);
		button.setAttribute("aria-pressed", String(options.currentColor === color.hex));
		if (options.currentColor === color.hex) button.classList.add("is-selected");
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			runApply(() => options.apply(color.hex));
		});
		button.addEventListener("keydown", (event) => activateFromKeyboard(event, button));
		swatches.append(button);
	}

	const reset = document.createElement("button");
	reset.type = "button";
	reset.className = "canvas-mindmap-native-color-reset";
	reset.textContent = "Theme default";
	reset.setAttribute("aria-label", "Theme default");
	reset.addEventListener("pointerdown", (event) => event.stopPropagation());
	reset.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		runApply(options.reset);
	});
	reset.addEventListener("keydown", (event) => activateFromKeyboard(event, reset));
	controls.append(reset);

	submenu.setAttribute(ENHANCED_ATTRIBUTE, "true");
	submenu.append(controls);
	handle = { dispose };
	swatches.querySelector<HTMLButtonElement>("button")?.focus();
	return handle;
}
