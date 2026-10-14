# Canvas Mindmap 1.1.17 validation report

This release removes the Shift+ArrowUp/Down card-shifting behavior. With a card selected, those key presses are consumed without moving or changing selection. Plain arrow keys continue to select the nearest visible card, and other Shift interactions remain unchanged.

## Automated validation

- `npm run typecheck`
- `npm test`
- `npm run test:ui`
- `npm run build`
- `node --check main.js`
- `git diff --check`

Controller regression coverage verifies both shifted vertical arrows are prevented with no movement or selection change, while ordinary ArrowDown navigation still selects the nearest card. Live Obsidian validation remains required for private Canvas keyboard behavior and the installed plugin bundle.
