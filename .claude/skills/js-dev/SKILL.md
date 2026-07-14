---
name: js-dev
description: Use when writing plain JavaScript in this repo (not React-specific, not Node-specific) — module systems, style, and the front/back split.
---

# JS conventions (something2)

Two module systems coexist. Do not mix them.

- **Frontend** (`frontend/src/`) is **ES modules**: `import` / `export`. Vite 8 bundles it.
- **Backend** (`backend/src/`) is **CommonJS**: `require` / `module.exports`. See `.ai/styleguides/backend.md`.
- The canvas game under `frontend/src/games/something2/src/js/` is plain ES-module JS (no framework), organized as `core/`, `systems/`, `entities/`, `managers/`, `net/`.

Rules:
- Match the module system of the directory you are in. Never add `"type": "module"` to `backend/package.json`.
- Prefer small, single-responsibility files — the game keeps one class per file (`Player.js`, `Camera.js`, ...).
- No new runtime dependencies without a reason; this repo keeps the game engine dependency-free.
- Lint the frontend with `npm run lint` (ESLint 10 flat config, `frontend/eslint.config.js`). Don't disable rules inline without a comment.

Related: [[react-dev]], [[nodejs-dev]], [[js-game-dev]].
