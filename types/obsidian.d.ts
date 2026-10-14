declare module "obsidian" {
	export interface PluginManifest {
		id: string;
		name: string;
		version: string;
		minAppVersion: string;
		[key: string]: unknown;
	}

	export interface App {
	workspace: any;
	metadataCache: any;
	 vault: any;
	[key: string]: any;
	}

	export interface WorkspaceLeaf {
		view: any;
		[key: string]: any;
	}

	export interface Command {
		id: string;
		name: string;
		checkCallback?: (checking: boolean) => boolean | void;
		callback?: () => void;
	}

	export class Plugin {
		app: App;
		manifest: PluginManifest;
		constructor(app: App, manifest: PluginManifest);
		loadData(): Promise<any>;
		saveData(data: any): Promise<void>;
		addCommand(command: Command): any;
		addSettingTab(tab: PluginSettingTab): any;
		addRibbonIcon(icon: string, title: string, callback: (event: MouseEvent) => void): HTMLElement;
		addStatusBarItem(): HTMLElement;
		registerEvent(event: any): void;
		registerDomEvent(
			el: HTMLElement | Document | Window,
			event: string,
			callback: (event: any) => any,
			options?: boolean | AddEventListenerOptions,
		): void;
		registerInterval(id: number): void;
		register(cb: () => void): void;
		registerView(type: string, viewCreator: (leaf: WorkspaceLeaf) => ItemView): void;
		[key: string]: any;
	}

	export class PluginSettingTab {
		app: App;
		plugin: Plugin;
		containerEl: HTMLElement;
		constructor(app: App, plugin: Plugin);
		display(): void;
	}

	export class Setting {
		constructor(containerEl: HTMLElement);
		setName(name: string): this;
		setDesc(description: string | DocumentFragment): this;
		setClass(className: string): this;
		addToggle(callback: (component: any) => any): this;
		addDropdown(callback: (component: any) => any): this;
		addText(callback: (component: any) => any): this;
		addSlider(callback: (component: any) => any): this;
		addButton(callback: (component: any) => any): this;
		addExtraButton(callback: (component: any) => any): this;
		addColorPicker(callback: (component: any) => any): this;
	}

	export class Menu {
		addItem(callback: (item: any) => any): this;
		addSeparator(): this;
		showAtMouseEvent(event: MouseEvent): void;
		showAtPosition(position: { x: number; y: number }): void;
	}

	export class Notice {
		constructor(message: string, timeout?: number);
		setMessage(message: string): void;
		hide(): void;
	}

	export class ItemView {
		app: App;
		leaf: WorkspaceLeaf;
		containerEl: HTMLElement;
		contentEl: HTMLElement;
		constructor(leaf: WorkspaceLeaf);
		getViewType(): string;
		getDisplayText(): string;
		getState(): any;
		setState(state: any, result: any): Promise<void>;
		onOpen(): Promise<void>;
		onClose(): Promise<void>;
	}

	export class TFile {
		path: string;
		name: string;
		extension: string;
		stat: { mtime: number; ctime: number; size: number };
	}

	export function debounce<T extends (...args: any[]) => any>(
		fn: T,
		delay: number,
		resetTimer?: boolean,
	): T;
	export function setIcon(element: HTMLElement, icon: string): void;
	export function setTooltip(element: HTMLElement, tooltip: string, placement?: string): void;
	export function requireApiVersion(version: string): boolean;
	export function normalizePath(path: string): string;
	export const Platform: { isMacOS: boolean; isDesktopApp: boolean };
}
