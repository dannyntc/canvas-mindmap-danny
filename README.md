# Canvas-Mindmap-Danny 1.1.16

Canvas-Mindmap-Danny is an Obsidian desktop plugin maintained by Danny and based on the original Canvas Mindmap work by Boninall. It keeps native Canvas cards, Markdown editing, colors, connectors, themes, and ordinary cross-links.

## Build

```bash
npm install
npm run typecheck
npm test
npm run test:ui
npm run build
```

The production outputs are `main.js`, `manifest.json`, and `styles.css`. Obsidian is an external runtime dependency; its private Canvas APIs are accessed only through the capability-checked adapter in `src/canvas-adapter.ts`.

## Install locally

1. Create `<vault>/.obsidian/plugins/canvas-mindmap-danny/`.
2. Copy `main.js`, `manifest.json`, and `styles.css` into that directory.
3. In Obsidian, reload installed plugins if needed, then enable **Canvas Mindmap**.
4. Open a Canvas; mind-map behavior is enabled automatically.

Existing directed connections are adopted only when they form an unambiguous acyclic tree; ambiguous connections remain cross-links.

## Main interactions

- `Tab` creates a child; `Enter` creates a sibling for a non-root card.
- `Space` starts editing; native Markdown editor keys remain native while editing.
- Clicking outside an editing card exits editing immediately and returns focus to Canvas navigation.
- Arrow keys select the nearest visible card; Shift+ArrowUp/Down are intentionally ignored so they do not shift cards.
- `Delete`/`Backspace` deletes the selected branch, including collapsed descendants.
- The native Canvas zoom-in and zoom-out controls are hidden; mouse-wheel and trackpad zoom remain available.
- The Canvas sidebar includes an `Arrange mind map` button. With cards selected it arranges their trees; with no card selected it arranges all trees.
- Left-drag empty canvas space to pan around the map. Hold `Shift` while dragging empty space to retain native Canvas selection-box behavior.
- Drag a single branch until its card touches another visible card, then hold briefly for the prospective parent to highlight before releasing to attach the branch. Hold `Cmd` on macOS or `Ctrl` on Windows to move without attaching.
- When Auto layout is enabled, dragging or creating cards makes nearby cards and their branches move aside in real time, maintaining a 48px clearance. The space-making preview is recalculated from the original positions, so cards return when the path clears. Hold over a prospective parent for about half a second before releasing to attach; ordinary contact only makes space.
- Reparenting replaces the branch's managed connector, so the old parent line is removed while unrelated cross-links remain.
- Managed connectors choose opposing endpoints from the final card geometry, using the dominant horizontal or vertical direction for a direct path.
- The node menu provides independent pastel palettes for a node, its branch nodes, its incoming managed arrow, or all managed arrows in its branch. The Theme default action restores native Canvas styling; unrelated cross-links keep their existing colours.
- The native palette icon above a selected card or selection includes the same pastel colours. Native custom-colour input remains available, and the picker remains usable with mouse or keyboard input.
- Cards do not display plugin controls when hovered; use the node menu or keyboard shortcuts for mind-map actions.
- Automatic height is enabled for text cards by default, with per-card manual opt-out.

## Source layout

- `src/tree-model.ts` — pure tree validation, adoption, traversal, branch operations, and duplication.
- `src/layout.ts` — pure variable-size directional and balanced layout.
- `src/space-making.ts` — pure real-time collision resolution and branch grouping.
- `src/state-store.ts` — versioned per-Canvas metadata migration and cleanup.
- `src/canvas-adapter.ts` — the private Canvas capability boundary and transaction wrapper.
- `src/color-palette.ts` — floating pastel palette lifecycle and pointer/keyboard interaction.
- `src/native-color-picker.ts` — pastel integration for Obsidian's native Canvas colour submenu.
- `src/canvas-controller.ts` — per-view keyboard, controls, visibility, drag, and structural actions.
- `src/height-controller.ts` — debounced natural text measurement and resize observation.
- `src/main.ts` — Obsidian lifecycle, commands, settings, and multi-view synchronization.

The original installed 1.0.2 files are preserved in `baseline/` for comparison. The reconstructed commit and tag history is documented in [`docs/version-history.md`](docs/version-history.md), with machine-readable provenance in [`docs/reconstruction-manifest.json`](docs/reconstruction-manifest.json). This repository does not overwrite a vault installation.
