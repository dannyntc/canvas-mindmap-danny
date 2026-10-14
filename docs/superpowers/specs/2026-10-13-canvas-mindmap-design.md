# Canvas Mindmap 1.1 design

## Intent

Canvas Mindmap 1.1 keeps Canvas nodes, Markdown editing, native colors, native connectors, and ordinary cross-links intact. Mind-map behavior follows plugin activation for each open Canvas. The plugin must be safe when its private Canvas capabilities are unavailable: it should leave the canvas unchanged and explain what is unavailable.

## Boundaries

- Pure tree/state/layout code lives in `src/` modules and has no DOM or Obsidian dependency.
- `CanvasAdapter` is the only module that touches Canvas internals.
- `CanvasMindMapStore` owns versioned plugin metadata keyed by Canvas path.
- A per-view controller owns keyboard, menu, visibility, height, drag, and layout coordination.
- The production entry point keeps legacy command IDs and settings while enabling mind-map behavior whenever the plugin is active.

## Persisted model

The existing settings object remains readable. A versioned `mindMaps` record is added under `data.json`. Each record stores activation, layout preferences, explicit parent relations, collapse state, manual-height opt-outs, and balanced branch sides. Canvas JSON remains the source of truth for card content, geometry, colors, and connectors; plugin metadata stores relationships only.

Existing directed connections are adopted only when they form an unambiguous acyclic parent tree. Ambiguous or cyclic connections remain cross-links. New child operations always create a fresh managed relation and connector.

## Layout and interaction

Five pure layouts are supported: LR, RL, TB, BT, and balanced. Layout uses actual node dimensions, stable sibling order, collapsed visibility, and explicit balanced branch sides. Dragging moves a branch as a unit and reparenting occurs only on a valid card drop without Cmd/Ctrl. Layout and metadata updates are grouped through an adapter transaction boundary.

Mind-map behavior is enabled automatically for every Canvas opened while the plugin is active. Opening a Canvas does not rearrange existing content. Disabling the plugin removes runtime hiding, shortcuts, controls, automatic height, and automatic layout while saved relationships remain.

## Verification

Model and layout tests use Node's built-in test runner and cover migration, tree validation, traversal, reparenting, all layouts, balanced side assignment, collapse, deletion, duplication, and stale-reference cleanup. Type-checking and a production esbuild are required before delivery. Obsidian runtime behavior is guarded by capability checks and documented as requiring desktop validation.
