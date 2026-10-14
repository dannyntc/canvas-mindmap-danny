# Canvas Mindmap 1.1.19 validation report

## Automated checks

- `npm run typecheck` — passed.
- `npm test` — passed: 67 tests, 67 passed.
- `npm run test:ui` — passed: 14 tests, 14 passed.
- `npm run build` — passed.
- `node --check main.js` — passed.
- `git diff --check` — passed.

## Duplicate-arrow coverage

- Native Obsidian Canvas edge paths are resolved from live edge objects, including interaction, display, and line-end elements.
- The adapter ignores the plugin-owned branching SVG when applying native edge visibility.
- The overlay reports only edge IDs for which a visible branching route was successfully rendered.
- Native visibility is restored when branching is disabled or a route cannot be rendered.
- The regression test confirms that hiding a managed native edge does not hide the corresponding branching overlay path.

## Live Obsidian checks

The private Obsidian Canvas runtime was not available in this environment. Before release, open a Canvas and verify that Enter-created children and Tab-created siblings each show one arrow, including after Canvas rerender, zoom, pan, card movement, reload, and undo or redo.
