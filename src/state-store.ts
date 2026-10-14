import {
	CanvasData,
	CanvasMindMapState,
	LayoutMode,
	PersistedPluginData,
	cloneJson,
	defaultCanvasState,
	isLayoutMode,
} from "./types";
import { adoptCanvasConnections, sanitizeState } from "./tree-model";

export const DEFAULT_PLUGIN_DATA: PersistedPluginData = {
	mindMapVersion: 1,
	mindMaps: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeRecord(
	defaults: Record<string, unknown>,
	value: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...defaults };
	for (const [key, next] of Object.entries(value ?? {})) {
		if (isRecord(result[key]) && isRecord(next)) {
			result[key] = mergeRecord(result[key] as Record<string, unknown>, next);
		} else {
			result[key] = cloneJson(next);
		}
	}
	return result;
}

export function deepMergeDefaults<T>(defaults: T, value: unknown): T {
	if (isRecord(defaults) && isRecord(value)) {
		return mergeRecord(defaults, value) as T;
	}
	return (value === undefined ? cloneJson(defaults) : cloneJson(value)) as T;
}

function normalizeLayout(value: unknown, fallback: LayoutMode): LayoutMode {
	if (isLayoutMode(value)) return value;
	if (value === "LR") return "left-to-right";
	if (value === "RL") return "right-to-left";
	if (value === "TB") return "top-to-bottom";
	if (value === "BT") return "bottom-to-top";
	return fallback;
}

export function normalizeCanvasState(
	value: unknown,
	defaultLayout: LayoutMode = "balanced",
): CanvasMindMapState {
	const raw = isRecord(value) ? value : {};
	const state = defaultCanvasState(defaultLayout);
	state.version = Number(raw.version) || 1;
	// Mind-map behavior follows plugin activation. Keep the field for
	// backwards-compatible metadata, but normalize legacy disabled records.
	state.enabled = true;
	state.autoLayout = raw.autoLayout !== false;
	state.autoHeight = raw.autoHeight !== false;
	state.defaultLayout = normalizeLayout(raw.defaultLayout, defaultLayout);
	if (isRecord(raw.trees)) {
		for (const [rootId, rawPreference] of Object.entries(raw.trees)) {
			if (!isRecord(rawPreference)) continue;
			const branchSides: Record<string, "left" | "right"> = {};
			if (isRecord(rawPreference.branchSides)) {
				for (const [nodeId, side] of Object.entries(rawPreference.branchSides)) {
					if (side === "left" || side === "right") branchSides[nodeId] = side;
				}
			}
			state.trees[rootId] = {
				layout: normalizeLayout(rawPreference.layout, state.defaultLayout),
				branchSides,
			};
		}
	}
	if (isRecord(raw.relations)) {
		for (const [childId, rawRelation] of Object.entries(raw.relations)) {
			if (!isRecord(rawRelation)) continue;
			if (typeof rawRelation.parentId !== "string" || typeof rawRelation.edgeId !== "string") {
				continue;
			}
			state.relations[childId] = {
				parentId: rawRelation.parentId,
				edgeId: rawRelation.edgeId,
				order: Number(rawRelation.order) || 0,
			};
		}
	}
	if (Array.isArray(raw.collapsedNodeIds)) {
		state.collapsedNodeIds = raw.collapsedNodeIds.filter(
			(value): value is string => typeof value === "string",
		);
	}
	if (Array.isArray(raw.manualHeightNodeIds)) {
		state.manualHeightNodeIds = raw.manualHeightNodeIds.filter(
			(value): value is string => typeof value === "string",
		);
	}
	return state;
}

export function migratePluginData(
	value: unknown,
	defaultLayout: LayoutMode = "balanced",
): PersistedPluginData {
	const raw = isRecord(value) ? value : {};
	const result = deepMergeDefaults(DEFAULT_PLUGIN_DATA, raw) as PersistedPluginData;
	result.mindMapVersion = 1;
	result.mindMaps = {};
	if (isRecord(raw.mindMaps)) {
		for (const [path, rawState] of Object.entries(raw.mindMaps)) {
			result.mindMaps[path] = normalizeCanvasState(rawState, defaultLayout);
		}
	}
	return result;
}

export class CanvasMindMapStore {
	private data: PersistedPluginData;

	constructor(raw: unknown = {}) {
		this.data = migratePluginData(raw);
	}

	get(path: string, defaultLayout: LayoutMode = "balanced"): CanvasMindMapState {
		const existing = this.data.mindMaps[path];
		if (!existing) return defaultCanvasState(defaultLayout);
		return cloneJson(normalizeCanvasState(existing, defaultLayout));
	}

	has(path: string): boolean {
		return !!this.data.mindMaps[path];
	}

	set(path: string, state: CanvasMindMapState): void {
		this.data.mindMaps[path] = cloneJson(normalizeCanvasState(state, state.defaultLayout));
	}

	update(
		path: string,
		mutator: (state: CanvasMindMapState) => void,
		defaultLayout: LayoutMode = "balanced",
	): CanvasMindMapState {
		const state = this.get(path, defaultLayout);
		mutator(state);
		this.set(path, state);
		return cloneJson(state);
	}

	adopt(
		path: string,
		data: CanvasData,
		defaultLayout: LayoutMode = "balanced",
	): CanvasMindMapState {
		const current = this.get(path, defaultLayout);
		const adopted = adoptCanvasConnections(data, current, defaultLayout).state;
		this.set(path, adopted);
		return cloneJson(adopted);
	}

	cleanup(
		path: string,
		data: CanvasData,
		defaultLayout: LayoutMode = "balanced",
	): CanvasMindMapState {
		const state = sanitizeState(data, this.get(path, defaultLayout), defaultLayout);
		this.set(path, state);
		return cloneJson(state);
	}

	rename(oldPath: string, newPath: string): void {
		if (!this.data.mindMaps[oldPath] || oldPath === newPath) return;
		if (!this.data.mindMaps[newPath]) this.data.mindMaps[newPath] = this.data.mindMaps[oldPath];
		delete this.data.mindMaps[oldPath];
	}

	remove(path: string): void {
		delete this.data.mindMaps[path];
	}

	snapshot(): PersistedPluginData {
		return cloneJson(this.data);
	}
}
