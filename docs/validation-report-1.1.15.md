# Canvas Mindmap 1.1.15 validation report

This release adds real-time local space making. When Auto layout is enabled, a dragged or newly created card pushes overlapping nearby cards and their movable branches aside. The calculation is recomputed from the pre-gesture geometry on every frame, so temporary displacements return when the path clears. A prospective parent becomes attachable only after a short hover hold and is then highlighted.

Validated in the repository:

- `npm run typecheck`
- `npm test` — 60 tests passed
- `npm run test:ui` — 13 tests passed
- `npm run build`
- `node --check main.js`

The controller regression tests simulate native Canvas drag callbacks, verify that a nearby card moves from `x=110` to `x=144` during contact, verify that it returns to `x=110` when the dragged card retreats, and verify the delayed connection-target highlight. Live Obsidian validation remains required for private Canvas runtime behavior, native history grouping, and persistence after reopening a Canvas.

A 500-card chained solver stress run completed in about 4–5 ms per warm solve on the development machine; the first cold solve was about 20 ms because of JavaScript startup and allocation warm-up.
