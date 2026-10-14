# Canvas Mindmap 1.1.16 validation report

This release increases the default real-time space-making clearance from 24px to 48px. Dragging, branch movement, node creation, duplication, and heading splitting now preserve the wider buffer while retaining the existing reversible local-push behavior.

## Automated validation

- `npm run typecheck`
- `npm test`
- `npm run test:ui`
- `npm run build`
- `node --check main.js`
- `git diff --check`

The solver tests verify the 48px default for a direct obstruction, propagated chains, and reversible movement. Controller tests verify the wider drag displacement and creation displacement. Live Obsidian validation remains required for private Canvas runtime behavior, native history grouping, and persistence after reopening a Canvas.
