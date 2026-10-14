# Canvas Mindmap 1.1.0 validation report

Date: 2026-10-14

## Verified in this workspace

- `npm install` completed with the pinned lockfile and reported no vulnerabilities.
- `npm run typecheck` passes with strict TypeScript checking.
- `npm test` passes all 21 Node model/layout/interaction tests.
- `npm run build` produces the installable `main.js` bundle.
- `manifest.json` reports plugin id `canvas-mindmap`, version `1.1.0`, desktop-only distribution, and minimum Obsidian version `1.5.0`.
- The original 1.0.2 distribution remains available under `baseline/`.

The automated coverage exercises unambiguous tree adoption, cycle and multiple-parent rejection, traversal/order, reparenting, branch deletion, duplication with fresh IDs, stale metadata cleanup, migration/rename, all five layouts, unequal card dimensions, balanced branch sides, independent trees, and collapsed layout bounds.

## Runtime boundary

This workspace does not contain an Obsidian desktop runtime or a vault, so no Obsidian-version interaction test is claimed. The private Canvas adapter performs capability checks and the controller leaves the Canvas untouched when required methods are missing. Before publishing, validate at least one current macOS desktop build and one current Windows desktop build, including native Canvas undo/redo for create, reparent, delete, duplicate, collapse, and redo.

The history bridge intentionally does not guess private history method signatures. Structural mutations go through Canvas `importData`/save boundaries and record a transaction snapshot; the exact native history integration must be confirmed against the running desktop build before treating undo/redo as release-certified.

The mouse interaction model now includes zoom-control hiding, left-drag background panning through the Canvas viewport, and contact-based prospective-parent selection. The pure contact ranking and zoom-aware pan conversion are covered by automated tests. DOM gesture behavior and the exact viewport setter remain live desktop acceptance checks because this workspace has no Obsidian runtime.

Also validate the auto-height matrix in a live vault (Markdown editing/preview, long wrapped content, code blocks, tables, delayed images, width changes, theme/font changes, and the `node-auto-resize` interoperability path). Mobile-specific validation, AI generation, image/PDF export, and publication are outside this release.
