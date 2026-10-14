# Canvas Mindmap 1.1.18 validation report

## Automated checks

- `npm run typecheck` — passed.
- `npm test` — passed: 66 tests, 66 passed.
- `npm run test:ui` — passed: 14 tests, 14 passed.
- `npm run build` — passed.
- `node --check main.js` — passed.
- `git diff --check` — passed.

## Branching coverage

- Managed child arrows are grouped by source card and connector side.
- Groups with multiple visible children receive an automatic shared junction.
- Right-clicking a managed path exposes junction creation and child creation.
- Junction positions are clamped to the upstream arrow and stored per Canvas mind-map state.
- Dragging a junction onto a card invokes the existing cycle-safe reparenting flow.
- Stale junctions are discarded during state cleanup; branch deletion and duplication update junction metadata.
- The setting and node-menu toggle restore native managed arrows when shared branching is disabled.

## Live Obsidian checks

The private Obsidian Canvas runtime was not available in this environment. Before release, open a Canvas with at least two child cards on one side and verify junction alignment while zooming, panning, moving cards, collapsing branches, reloading the Canvas, and undoing or redoing Canvas edits.
