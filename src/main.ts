import {
	Menu,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	WorkspaceLeaf,
} from "obsidian";
import { CanvasController, CanvasViewLike } from "./canvas-controller";
import { CanvasAdapter } from "./canvas-adapter";
import { CanvasMindMapStore, deepMergeDefaults } from "./state-store";
import { CanvasMindMapState, LayoutMode } from "./types";

interface LegacySettings {
	navigate: { useNavigate: boolean; modifierKey: string[] };
	hotkey: { hotkeyMode: string };
	create: {
		createFloat: boolean;
		createCustomChildNode: boolean;
		childNodeWidth: number;
		childNodeHeight: number;
		floatGap: number;
		floatWidth: number;
		floatHeight: number;
		parentChildGapForVertical: number;
		parentChildGapForHorizontal: number;
		siblingGapForVertical: number;
		siblingGapForHorizontal: number;
		siblingTolerance: number;
	};
	layout: {
		direction: string;
		autoLayout: boolean;
		autoLayoutDirection: string;
		autoHeight: boolean;
		ignoreFilesRegex: string;
	};
	resize: { autoResize: boolean; widthAutoResize: boolean; maxWidth: number };
	advanced: { transferToCommands: boolean; showChangelogAutomatically: boolean; lastUpdatedVersion: string };
}

const DEFAULT_LEGACY_SETTINGS: LegacySettings = {
	navigate: { useNavigate: true, modifierKey: ["Alt"] },
	hotkey: { hotkeyMode: "Space" },
	create: {
		createFloat: true,
		createCustomChildNode: true,
		childNodeWidth: 200,
		childNodeHeight: 100,
		floatGap: 100,
		floatWidth: 200,
		floatHeight: 100,
		parentChildGapForVertical: 160,
		parentChildGapForHorizontal: 200,
		siblingGapForVertical: 50,
		siblingGapForHorizontal: 40,
		siblingTolerance: 50,
	},
	layout: {
		direction: "LR",
		autoLayout: true,
		autoLayoutDirection: "LR",
		autoHeight: true,
		ignoreFilesRegex: "",
	},
	resize: { autoResize: false, widthAutoResize: false, maxWidth: 500 },
	advanced: {
		transferToCommands: false,
		showChangelogAutomatically: true,
		lastUpdatedVersion: "1.1.8",
	},
};

function legacyLayout(value: unknown): LayoutMode {
	switch (value) {
		case "RL": return "right-to-left";
		case "TB": return "top-to-bottom";
		case "BT": return "bottom-to-top";
		case "balanced": return "balanced";
		default: return "left-to-right";
	}
}

function isCanvasView(view: any): view is CanvasViewLike {
	return !!view && (view.getViewType?.() === "canvas" || !!view.canvas);
}

export default class CanvasMindMapPlugin extends Plugin {
	settings: LegacySettings = deepMergeDefaults(DEFAULT_LEGACY_SETTINGS, undefined);
	private store = new CanvasMindMapStore();
	private readonly controllers = new Map<any, CanvasController>();
	private readonly controllerPaths = new Map<CanvasController, string>();
	private saveTimer?: ReturnType<typeof setTimeout>;
	private readonly compatibilityNotices = new Set<string>();

	async onload(): Promise<void> {
		const raw = await this.loadData().catch(() => ({}));
		this.settings = deepMergeDefaults(DEFAULT_LEGACY_SETTINGS, raw) as LegacySettings;
		this.store = new CanvasMindMapStore(raw);
		this.addSettingTab(new CanvasMindMapSettingTab(this.app, this));
		this.registerCommands();
		this.registerWorkspaceHooks();
		this.app.workspace.onLayoutReady?.(() => this.attachOpenCanvases());
	}

	async onunload(): Promise<void> {
		for (const controller of this.controllers.values()) controller.dispose();
		this.controllers.clear();
		this.controllerPaths.clear();
		if (this.saveTimer) clearTimeout(this.saveTimer);
		await this.saveData(this.store.snapshot());
	}

	private registerWorkspaceHooks(): void {
		const workspace = this.app.workspace;
		if (workspace.on) {
			this.registerEvent(workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null) => {
				if (leaf) this.attachLeaf(leaf);
			}));
			this.registerEvent(workspace.on("layout-change", () => this.attachOpenCanvases()));
			this.registerEvent(workspace.on("file-rename", (file: any, oldPath: string) => {
				const newPath = typeof file === "string" ? file : file?.path;
				if (newPath && oldPath) {
					this.store.rename(oldPath, newPath);
					for (const [controller, path] of this.controllerPaths) {
						if (path === oldPath) this.controllerPaths.set(controller, newPath);
					}
					this.scheduleSave();
				}
			}));
			try {
				this.registerEvent(workspace.on("canvas:node-menu", (menu: Menu, node: any) => {
					const controller = this.controllerForCanvas(node?.canvas) ??
						this.controllerForView(workspace.activeLeaf?.view);
					const nodeId = node?.id;
					if (controller && nodeId) {
						menu.addItem((item: any) => item.setTitle("Mind-map actions").setIcon("git-branch").onClick(() => controller.showNodeMenu(nodeId)));
					}
				}));
			} catch {
				// Older Canvas builds do not expose the node-menu workspace event.
			}
		}
	}

	private attachOpenCanvases(): void {
		const leaves = this.app.workspace.getLeavesOfType?.("canvas") ?? [];
		const liveViews = new Set(leaves.map((leaf: WorkspaceLeaf) => leaf.view));
		for (const leaf of leaves) this.attachLeaf(leaf);
		for (const [view, controller] of this.controllers) {
			if (liveViews.has(view)) continue;
			controller.dispose();
			this.controllerPaths.delete(controller);
			this.controllers.delete(view);
		}
	}

	private pathForView(view: CanvasViewLike): string | undefined {
		if (view.file?.path) return view.file.path;
		const file = view.getState?.().file;
		return typeof file === "string" ? file : undefined;
	}

	private attachLeaf(leaf: WorkspaceLeaf): void {
		const view = leaf.view as CanvasViewLike;
		if (!isCanvasView(view) || !view.canvas || this.controllers.has(view)) return;
		const path = this.pathForView(view);
		if (!path) return;
		const adapter = new CanvasAdapter(view.canvas);
		if (!adapter.capabilities.available) {
			this.showCompatibilityNotice(path, adapter.capabilities.missing);
			return;
		}
		const hadState = this.store.has(path);
		let state = hadState
			? this.store.cleanup(path, adapter.getData(), legacyLayout(this.settings.layout.autoLayoutDirection))
			: this.store.adopt(path, adapter.getData(), legacyLayout(this.settings.layout.autoLayoutDirection));
		if (!hadState) {
			state = {
				...state,
				autoLayout: this.settings.layout.autoLayout,
				autoHeight: this.settings.layout.autoHeight,
				defaultLayout: "balanced",
			};
			this.store.set(path, state);
		}
		if (this.hasExternalResizePlugin()) {
			this.showCompatibilityNotice(`${path}:external-resize`, [
				"node-auto-resize is active; it owns card sizing and Canvas Mindmap automatic height is paused",
			]);
		}
		let controller: CanvasController;
		controller = new CanvasController({
			view,
			state,
			childWidth: this.settings.create.childNodeWidth,
			childHeight: this.settings.create.childNodeHeight,
			horizontalGap: this.settings.create.parentChildGapForHorizontal,
			verticalGap: this.settings.create.siblingGapForVertical,
			onStateChange: (nextState) => this.updateControllerState(controller, path, nextState),
			notify: (message) => new Notice(message),
			isExternalResizeOwner: () => this.hasExternalResizePlugin(),
		});
		this.controllers.set(view, controller);
		this.controllerPaths.set(controller, path);
		controller.mount();
		this.scheduleSave();
	}

	private updateControllerState(
		source: CanvasController,
		path: string,
		state: CanvasMindMapState,
	): void {
		this.store.set(path, state);
		for (const [controller, controllerPath] of this.controllerPaths) {
			if (controller !== source && controllerPath === path) controller.refreshFromState(state);
		}
		this.scheduleSave();
	}

	private showCompatibilityNotice(path: string, missing: string[]): void {
		if (this.compatibilityNotices.has(path)) return;
		this.compatibilityNotices.add(path);
		new Notice(`Canvas Mindmap needs newer Canvas capabilities: ${missing.join(", ")}.`);
	}

	private hasExternalResizePlugin(): boolean {
		const plugins = this.app.plugins;
		return !!plugins?.enabledPlugins?.has?.("node-auto-resize") ||
			!!plugins?.enabledPlugins?.has?.("obsidian-node-auto-resize");
	}

	private activeController(): CanvasController | undefined {
		const leaf = this.app.workspace.activeLeaf;
		return leaf ? this.controllers.get(leaf.view) : undefined;
	}

	private controllerForView(view: any): CanvasController | undefined {
		if (!view) return this.activeController();
		return this.controllers.get(view);
	}

	private controllerForCanvas(canvas: any): CanvasController | undefined {
		if (!canvas) return undefined;
		for (const controller of this.controllers.values()) {
			if (controller.adapter.canvas === canvas) return controller;
		}
		return undefined;
	}

	private command(
		id: string,
		name: string,
		action: (controller: CanvasController) => void,
		requiresEnabled = true,
	): void {
		this.addCommand({
			id,
			name,
			checkCallback: (checking) => {
				const controller = this.activeController();
				if (!controller || (requiresEnabled && !controller.isEnabled())) return false;
				if (!checking) action(controller);
				return true;
			},
		});
	}

	private registerCommands(): void {
		this.command("layout-selected-tree", "Layout selected mind-map tree", (controller) => controller.layoutSelectedTree());
		this.command("layout-all-trees", "Layout all mind-map trees", (controller) => controller.layoutAllTrees());
		this.command("create-child-node", "Create child node", (controller) => controller.createChild(controller.adapter.selectionIds()[0]));
		this.command("create-next-sibling-node", "Create next sibling node", (controller) => controller.createSibling(controller.adapter.selectionIds()[0], "after"));
		this.command("create-previous-sibling-node", "Create previous sibling node", (controller) => controller.createSibling(controller.adapter.selectionIds()[0], "before"));
		this.command("create-floating-node", "Create floating node", (controller) => controller.createFloatingNode());
		this.command("enter-edit-mode", "Enter card edit mode", (controller) => controller.startEditingSelected());
		this.command("exit-edit-mode", "Exit card edit mode", (controller) => controller.stopEditingSelected());
		this.command("change-direction", "Cycle mind-map layout direction", (controller) => controller.cycleSelectedLayout());
		this.command("split-heading-into-mindmap", "Split headings into mind-map cards", (controller) => controller.splitSelectedHeadings());
		this.command("select-branch", "Select mind-map branch", (controller) => controller.selectBranch());
		this.command("collapse-branch", "Collapse or expand mind-map branch", (controller) => {
			const nodeId = controller.adapter.selectionIds()[0];
			if (nodeId) controller.toggleCollapse(nodeId);
		});
		this.command("duplicate-branch", "Duplicate mind-map branch", (controller) => controller.duplicateSelectedBranch());
		this.command("delete-branch", "Delete mind-map branch", (controller) => controller.deleteSelectedBranch());
		this.addCommand({
			id: "open-changelog",
			name: "Open Canvas Mindmap changelog",
			callback: () => new Notice("Canvas Mindmap 1.1.8 removes all hover card controls."),
		});
	}

	async saveSettings(): Promise<void> {
		this.settings.advanced.lastUpdatedVersion = "1.1.8";
		const current = this.store.snapshot();
		await this.saveData({ ...this.settings, ...current });
	}

	private scheduleSave(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			void this.saveData({ ...this.settings, ...this.store.snapshot() });
		}, 120);
	}
}

class CanvasMindMapSettingTab extends PluginSettingTab {
	private readonly pluginRef: CanvasMindMapPlugin;

	constructor(app: any, plugin: CanvasMindMapPlugin) {
		super(app, plugin);
		this.pluginRef = plugin;
	}

	display(): void {
		const container = this.containerEl;
		container.replaceChildren();
		const heading = document.createElement("h2");
		heading.textContent = "Canvas Mindmap";
		if (!heading.parentElement) container.appendChild(heading);
		new Setting(container)
			.setName("Default layout")
			.setDesc("Used for newly adopted or newly created trees; existing trees keep their layout.")
			.addDropdown((dropdown: any) => dropdown
				.addOption("left-to-right", "Left to right")
				.addOption("right-to-left", "Right to left")
				.addOption("top-to-bottom", "Top to bottom")
				.addOption("bottom-to-top", "Bottom to top")
				.addOption("balanced", "Balanced left/right")
				.setValue(legacyLayout(this.pluginRef.settings.layout.autoLayoutDirection))
				.onChange(async (value: LayoutMode) => {
					this.pluginRef.settings.layout.autoLayoutDirection = value;
					await this.pluginRef.saveSettings();
				}));
		new Setting(container)
			.setName("Automatic layout for new canvases")
			.setDesc("Canvas Mindmap behavior is enabled automatically whenever the plugin is active.")
			.addToggle((toggle: any) => toggle
				.setValue(this.pluginRef.settings.layout.autoLayout)
				.onChange(async (value: boolean) => {
					this.pluginRef.settings.layout.autoLayout = value;
					await this.pluginRef.saveSettings();
				}));
		new Setting(container)
			.setName("Automatic text-card height for new canvases")
			.setDesc("Manual resizing opts an individual text card out; the card menu can re-enable it.")
			.addToggle((toggle: any) => toggle
				.setValue(this.pluginRef.settings.layout.autoHeight)
				.onChange(async (value: boolean) => {
					this.pluginRef.settings.layout.autoHeight = value;
					await this.pluginRef.saveSettings();
				}));
		new Setting(container)
			.setName("Child card width")
			.addText((text: any) => text
				.setValue(String(this.pluginRef.settings.create.childNodeWidth))
				.onChange(async (value: string) => {
					const width = Number(value);
					if (Number.isFinite(width) && width >= 80) {
						this.pluginRef.settings.create.childNodeWidth = width;
						await this.pluginRef.saveSettings();
					}
				}));
		new Setting(container)
			.setName("Child card minimum height")
			.addText((text: any) => text
				.setValue(String(this.pluginRef.settings.create.childNodeHeight))
				.onChange(async (value: string) => {
					const height = Number(value);
					if (Number.isFinite(height) && height >= 60) {
						this.pluginRef.settings.create.childNodeHeight = height;
						await this.pluginRef.saveSettings();
					}
				}));
	}
}
