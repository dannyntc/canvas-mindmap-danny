# Canvas Mindmap 1.1.20 validation report

## Automated checks

- `npm run typecheck` — passed.
- `npm test` — passed: 68 tests, 68 passed.
- `npm run test:ui` — passed: 14 tests, 14 passed.
- `npm run build` — passed.
- `node --check main.js` — passed.
- `git diff --check` — passed.

## Shared-label and lifecycle coverage

- Common labels are stored per parent card and connector side, independently of child edge labels.
- The label is rendered once on the shared trunk before the first junction.
- Arrow and junction menus provide set, edit, and clear actions.
- Existing Canvas views refresh on active-leaf and layout lifecycle events.
- Detached or replaced branching SVG overlays are recreated before native edge visibility is synchronized.

## Live Obsidian checks

The private Obsidian Canvas runtime was not available in this environment. Before release, add a common label, switch to another document, return to the Canvas, and verify that the label and one shared route remain visible. Also verify Enter-created children, Tab-created siblings, zoom, pan, card movement, reload, and undo or redo.
