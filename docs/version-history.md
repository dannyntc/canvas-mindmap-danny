# Reconstructed version history

This repository reconstructs the customised Canvas Mindmap plugin from the preserved 1.0.2 baseline, recorded workspace file changes, and the saved version exports in `/Users/danny/Desktop/codex's outputs`. Each version below has its own annotated Git tag and commit.

## Version commits

| Tag | Reconstructed change |
| --- | --- |
| `v1.0.2` | Original upstream Canvas Mindmap distribution, retained as the baseline. |
| `v1.1.0` | New TypeScript project with tree/state models, directional and balanced layouts, branch operations, keyboard actions, persistence, automatic height, and initial Canvas interaction support. |
| `v1.1.1` | Canvas activation, zoom/pan gestures, touch-parent dragging, connector replacement, editor exit, deletion-safe imports, and related lifecycle repairs. |
| `v1.1.2` | Scoped `Arrange mind map` sidebar action for selected trees or all trees. |
| `v1.1.3` | Canvas control discovery across unique host roots and branch-tree icon support. |
| `v1.1.4` | Arrange action placement after native Undo/Redo controls. |
| `v1.1.5` | Pastel node, branch, and managed-arrow colour actions. |
| `v1.1.6` | Direct colour-control targeting, import verification, and partial-snapshot rollback coverage. |
| `v1.1.7` | Removal of directional child arrows and hover-only colour controls. |
| `v1.1.8` | Removal of the remaining hover card controls. |
| `v1.1.9` | Floating pastel palette pointer/keyboard lifecycle repair and DOM regression coverage. |
| `v1.1.10` | Integration with Obsidian's native Canvas colour picker, including gesture protection. |
| `v1.1.11` | Native picker visibility repair. |
| `v1.1.12` | Native picker selection semantics and lifecycle hardening. |
| `v1.1.13` | Arrange notices, selected-root verification, and related test coverage. |
| `v1.1.14` | Stale Arrange-handler disposal and remount repair. |
| `v1.1.15` | Real-time local space making for dragging, node creation, duplication, and heading splitting, with hold-to-connect drag targets. |
| `v1.1.16` | Increase real-time space-making clearance from 24px to 48px for dragging, branch movement, and node creation. |

## Reconstruction method

- `v1.0.2` starts from the supplied `baseline/main.js`, `baseline/manifest.json`, and `baseline/styles.css`.
- `v1.1.0` through `v1.1.8` replay the exact `FileChange` records from the Codex session records. The feature boundary is used when the next version's tests/code started before its later metadata bump.
- The unrecorded identity transition from `Canvas Mindmap`/`canvas-mindmap` to `Canvas-Mindmap-Danny`/`canvas-mindmap-danny` is grouped at the `v1.1.0` → `v1.1.1` boundary because the first subsequent recorded diffs require that context.
- `v1.1.5` through `v1.1.8` are additionally checked against their saved distribution exports. `v1.1.9` uses the nested full-project export; `v1.1.10` through `v1.1.14` use their supplied full-project exports.
- The original installed baseline is preserved under `baseline/`. Vault data files (`data.json` and `baseline/data.json`) remain local and ignored.

## Verification

Every reconstructed checkpoint passed `npm run typecheck` and `npm test`; the 1.1.9–1.1.14 checkpoints also passed `npm run test:ui`. The supplied installable artifacts for 1.1.5–1.1.14 match their staged exports byte-for-byte for `main.js`, `manifest.json`, and `styles.css`. Obsidian's private runtime and a live vault were not available, so desktop interaction, native undo/redo, and reopen-persistence remain live acceptance checks.

The machine-readable provenance and export hashes are in [`reconstruction-manifest.json`](reconstruction-manifest.json).
