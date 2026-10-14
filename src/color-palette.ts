export type ColorApplyResult =
	| { status: "applied" | "unchanged" }
	| {
		status: "failed";
		reason: "read-only" | "target-missing" | "unsupported" | "write-rejected" | "runtime-error";
		message: string;
	};

export interface ColorPaletteColor {
	label: string;
	hex: string;
}

export interface ColorPaletteOptions {
	document: Document;
	window: Window;
	label: string;
	colors: readonly ColorPaletteColor[];
	currentColor?: string;
	apply: (color: string) => ColorApplyResult;
	reset: () => ColorApplyResult;
}

export interface ColorPaletteHandle {
	element: HTMLElement;
	close: () => void;
	setError: (message: string) => void;
}

function failureMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return "The colour could not be applied. Check that this Canvas is writable and try again.";
}

/**
 * Creates the floating palette used by the node menu. Keeping its event
 * lifecycle outside CanvasController makes pointer and keyboard activation
 * testable without a running Obsidian Canvas.
 */
export function openColorPalette(options: ColorPaletteOptions): ColorPaletteHandle {
	const { document, window } = options;
	const palette = document.createElement("div");
	palette.className = "canvas-mindmap-color-palette";
	palette.setAttribute("role", "dialog");
	palette.setAttribute("aria-label", options.label);

	const title = document.createElement("div");
	title.className = "canvas-mindmap-color-palette-title";
	title.textContent = options.label;
	palette.append(title);

	const error = document.createElement("div");
	error.className = "canvas-mindmap-color-palette-error";
	error.setAttribute("role", "alert");
	error.hidden = true;
	palette.append(error);

	let closed = false;
	let outsideListenerRegistered = false;
	let outsideRegistrationTimer: number | undefined;
	let handle: ColorPaletteHandle;

	const setError = (message: string): void => {
		error.textContent = message;
		error.hidden = !message;
	};

	const close = (): void => {
		if (closed) return;
		closed = true;
		if (outsideRegistrationTimer !== undefined) {
			window.clearTimeout(outsideRegistrationTimer);
			outsideRegistrationTimer = undefined;
		}
		if (outsideListenerRegistered) {
			document.removeEventListener("pointerdown", onOutsidePointerDown, true);
			outsideListenerRegistered = false;
		}
		window.removeEventListener("keydown", onWindowKeyDown, true);
		palette.remove();
	};

	const applyResult = (result: ColorApplyResult): void => {
		if (result.status === "failed") setError(result.message);
		else close();
	};

	const runApply = (apply: () => ColorApplyResult): void => {
		if (closed) return;
		try {
			applyResult(apply());
		} catch (caught) {
			setError(failureMessage(caught));
		}
	};

	const activateFromKeyboard = (event: KeyboardEvent, button: HTMLButtonElement): void => {
		if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
		event.preventDefault();
		event.stopPropagation();
		button.click();
	};

	const swatches = document.createElement("div");
	swatches.className = "canvas-mindmap-color-swatches";
	for (const color of options.colors) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "canvas-mindmap-color-swatch";
		button.style.setProperty("--canvas-mindmap-swatch", color.hex);
		button.setAttribute("aria-label", `${options.label}: ${color.label}`);
		button.setAttribute("title", color.label);
		button.setAttribute("aria-pressed", String(options.currentColor === color.hex));
		if (options.currentColor === color.hex) button.classList.add("is-selected");
		button.addEventListener("pointerdown", (event) => {
			event.stopPropagation();
		});
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			runApply(() => options.apply(color.hex));
		});
		button.addEventListener("keydown", (event) => activateFromKeyboard(event, button));
		swatches.append(button);
	}
	palette.append(swatches);

	const reset = document.createElement("button");
	reset.type = "button";
	reset.className = "canvas-mindmap-color-reset";
	reset.textContent = "Theme default";
	reset.setAttribute("aria-label", `${options.label}: Theme default`);
	reset.addEventListener("pointerdown", (event) => event.stopPropagation());
	reset.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		runApply(options.reset);
	});
	reset.addEventListener("keydown", (event) => activateFromKeyboard(event, reset));
	palette.append(reset);

	const onOutsidePointerDown = (event: PointerEvent): void => {
		if (!palette.contains(event.target as Node)) close();
	};
	const onWindowKeyDown = (event: KeyboardEvent): void => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		close();
	};

	palette.addEventListener("pointerdown", (event) => event.stopPropagation());
	outsideRegistrationTimer = (window.setTimeout(() => {
		if (closed) return;
		document.addEventListener("pointerdown", onOutsidePointerDown, true);
		outsideListenerRegistered = true;
	}, 0) as unknown) as number;
	window.addEventListener("keydown", onWindowKeyDown, true);
	(document.body ?? document.documentElement).append(palette);

	handle = { element: palette, close, setError };
	swatches.querySelector<HTMLButtonElement>("button")?.focus();
	return handle;
}
