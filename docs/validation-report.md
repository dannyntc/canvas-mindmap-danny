# Canvas Mindmap 1.1.2 validation report

Date: 2026-10-14

## Verified in this workspace

- `npm install` completed with the pinned lockfile and reported no vulnerabilities.
- `npm run typecheck` passes with strict TypeScript checking.
- `npm test` passes all 31 Node model/layout/interaction tests.
- `npm run build` produces the installable `main.js` bundle.
- `manifest.json` reports plugin id `canvas-mindmap-danny`, version `1.1.2`, desktop-only distribution, and minimum Obsidian version `1.5.0`.
- The original 1.0.2 distribution remains available under `baseline/`.
- Mind-map behavior is enabled automatically when the plugin opens a Canvas; the former sidebar toggle and toggle command are removed.

The automated coverage exercises unambiguous tree adoption, cycle and multiple-parent rejection, traversal/order, reparenting, branch deletion, duplication with fresh IDs, stale metadata cleanup, migration/rename, all five layouts, unequal card dimensions, balanced branch sides, independent trees, and collapsed layout bounds.

## Runtime boundary

This workspace does not include an embedded Obsidian runtime or disposable test vault. A local Obsidian 1.14.4 installation was inspected statically, but the native app-control surface was unavailable in this session, so no live interaction test is claimed. The private Canvas adapter performs capability checks and the controller leaves the Canvas untouched when required methods are missing. Before publishing, validate at least one current macOS desktop build and one current Windows desktop build, including native Canvas undo/redo for create, reparent, delete, duplicate, collapse, and redo.

Structural mutations use Canvas `importData(data, true)` and the native `requestSave()` history boundary. The exact undo/redo behavior still requires live desktop validation because the history object is private to Obsidian.

The repaired interaction model includes matching native `.canvas-control-item` zoom controls, receiver-bound left-drag background panning, immediate exit from card editing on outside clicks, editor-mutation refresh filtering, contact-based prospective-parent selection, explicit managed-connector replacement during reparenting, final-geometry connector endpoint routing, and an accessible `Arrange mind map` sidebar action that scopes layout to selected trees or all trees when no card is selected. Automated coverage includes native editor-exit support, editor mutation filtering, selected-root resolution, repeated managed-edge replacement, preservation of cross-links, direct horizontal/vertical routing, unequal card dimensions, overlap, and deterministic ties. DOM gesture behavior and the exact loaded plugin bundle remain live desktop acceptance checks because this workspace cannot control the installed Obsidian window.

Also validate the auto-height matrix in a live vault (Markdown editing/preview, long wrapped content, code blocks, tables, delayed images, width changes, theme/font changes, and the `node-auto-resize` interoperability path). Mobile-specific validation, AI generation, image/PDF export, and publication are outside this release.
