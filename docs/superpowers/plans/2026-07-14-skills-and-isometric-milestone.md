# Skills + Isometric Rendering Milestone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author nine project-specific skills in `.claude/skills/`, then convert the something2 canvas game from top-down to true isometric rendering — without changing any movement or collision logic.

**Architecture:** All game logic (movement, collision, tile lookup, spawning) stays in the existing **world-pixel coordinate space** (a 10000×10000 Cartesian plane, `MAP_TILE_SIZE=100`). Isometric is introduced as a pure **rendering projection**: a new `iso.js` module converts world coordinates to screen (diamond) coordinates and back. Only the camera and the render paths (`Camera.js`, `Map.render`, `RenderSystem.js`, `Entity.render`) change. Depth ordering is handled by sorting all drawables back-to-front by their world `(x + y)` before drawing.

**Tech Stack:** Vite 8, React 19, plain ES modules for the canvas game, Vitest 3 for unit tests (added by this plan), `.claude/skills/` markdown for skills.

## Global Constraints

- **Do not modify movement or collision logic.** `Player.update()` and `Map.getTileAt()` operate in world pixels and must stay byte-for-byte unchanged. Isometric is rendering-only.
- **Do not touch the Go engine** (`engine/`). It is frozen; the `go-dev` skill documents this.
- Skills live in `.claude/skills/<name>/SKILL.md`, committed to the repo (shared by Claude and Codex per `AGENTS.md`).
- Skills are **thin and project-specific** — reference real files, do not write generic language tutorials.
- Frontend is **ES modules**; backend is **CommonJS** — never mix (per `.ai/styleguides/backend.md`).
- Isometric tile footprint: **2:1 diamond, `ISO_TILE_W = 128`, `ISO_TILE_H = 64`** (world tiles remain `MAP_TILE_SIZE = 100`; the projection maps between them).
- `1rem = 10px` in the frontend (`GlobalStyles.js` sets `font-size: 62.5%`) — only relevant if a skill task shows CSS.
- Run frontend lint with `npm run lint` from `frontend/`; run unit tests with `npm run test` from `frontend/` (added in Task 10).
- Commit after every task with a `feat:`/`docs:`/`test:` prefixed message.

---

## Skill authoring convention (applies to Tasks 1–9)

Every skill is a single file `.claude/skills/<name>/SKILL.md` with YAML frontmatter:

```markdown
---
name: <name>
description: <one line — when to use this skill>
---

<body>
```

A skill task's "test" is not a unit test — it is this checklist, run manually at the end of the task:
1. File exists at the exact path.
2. Frontmatter has `name` (matching the directory) and a `description`.
3. Every repo file the skill links to actually exists (verify with `ls`).
4. Body is project-specific — no generic filler.

Each skill task is: create the file → verify the checklist → commit. Steps are written once here and referenced by each task as "the standard skill steps."

**Standard skill steps (used by Tasks 1–9):**

- [ ] Step A: Create `.claude/skills/<name>/SKILL.md` with the frontmatter and body given in the task.
- [ ] Step B: Verify every file path referenced in the body exists: `for f in <paths>; do test -e "$f" && echo "ok $f" || echo "MISSING $f"; done` — expect all `ok`.
- [ ] Step C: Commit: `git add .claude/skills/<name>/SKILL.md && git commit -m "docs: add <name> skill"`.

---

### Task 1: `js-dev` skill

**Files:**
- Create: `.claude/skills/js-dev/SKILL.md`

Run the **standard skill steps** with this content:

```markdown
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
```

Referenced paths to verify in Step B: `frontend/src` `backend/src` `frontend/src/games/something2/src/js` `.ai/styleguides/backend.md` `frontend/eslint.config.js`.

---

### Task 2: `react-dev` skill

**Files:**
- Create: `.claude/skills/react-dev/SKILL.md`

Run the **standard skill steps** with this content:

```markdown
---
name: react-dev
description: Use when writing or editing React components in frontend/src — provider stack, styled-components tokens, TanStack Query data hooks, routing.
---

# React conventions (something2)

Full detail lives in `.ai/styleguides/frontend.md`; this is the short version.

- **React 19 + Vite 8.** Function components only.
- **Provider stack:** new providers go in `frontend/src/App.jsx` (order: `DarkModeProvider > QueryClientProvider > BrowserRouter`), unless they must render above the error boundary in `frontend/src/main.jsx`.
- **Styling:** styled-components 6. Reusable UI primitives in `frontend/src/ui/` read CSS-variable design tokens from `frontend/src/styles/GlobalStyles.js` (`var(--color-grey-0)`, etc). Don't hardcode hex in UI primitives — add a token instead. Exception: in-game UI (`frontend/src/games/something2/Something2.jsx`) deliberately uses a hardcoded dark gaming palette — leave it.
- **Transient props:** style-only props that must not hit the DOM get a `$` prefix (`$active`). React 19 warns otherwise.
- **Data:** all server I/O goes through TanStack Query hooks co-located in `<feature>/use<Thing>.js` (reference `frontend/src/games/something2/useMaps.js`). Never `fetch` from a component. API base is `import.meta.env.VITE_API_URL`.
- **Feedback:** `toast.success` / `toast.error` from react-hot-toast. No custom notification components.
- **Routing:** route tree in `App.jsx`; new pages under `frontend/src/pages/`.

Related: [[js-dev]], [[js-game-dev]].
```

Referenced paths to verify in Step B: `.ai/styleguides/frontend.md` `frontend/src/App.jsx` `frontend/src/main.jsx` `frontend/src/ui` `frontend/src/styles/GlobalStyles.js` `frontend/src/games/something2/Something2.jsx` `frontend/src/games/something2/useMaps.js` `frontend/src/pages`.

---

### Task 3: `nodejs-dev` skill

**Files:**
- Create: `.claude/skills/nodejs-dev/SKILL.md`

Run the **standard skill steps** with this content:

```markdown
---
name: nodejs-dev
description: Use when writing or editing the Express backend in backend/src — CommonJS, inline routes, raw pg queries, error shape, migrations.
---

# Node/Express conventions (something2)

Full detail lives in `.ai/styleguides/backend.md`; this is the short version.

- **CommonJS** (`require` / `module.exports`). Express 4.
- **Routes** currently live inline in `backend/src/index.js`. Don't add a per-resource router until that file passes ~600 lines or a resource has 5+ routes.
- **Postgres** via a single `pg` `Pool` from `process.env.DATABASE_URL`, raw parameterized queries (`$1, $2`). No ORM. JSON columns: `JSON.stringify` in, read raw out.
- **Error shape:** `try { ...; res.json(row) } catch (err) { console.error(err); res.status(500).json({ error: '...' }) }`. Validation → 400, not-found → 404 `{ error: '<resource> not found' }`, created → 201 with the row, destructive success → `{ success: true, id }`.
- **Migrations:** `node-pg-migrate` JS files in `backend/migrations/`, `<timestamp>_<description>.js`, run on startup. Never edit a committed migration — add a new one. Manual: `npm run migrate:up`.
- **Pure logic** goes in `backend/src/services/<name>.js` (reference `backend/src/services/mapService.js`); routes do I/O, services do algorithms.
- **No auth** yet — when it lands, add middleware before routes, not per-route checks.

Related: [[js-dev]], [[game-netcode]].
```

Referenced paths to verify in Step B: `.ai/styleguides/backend.md` `backend/src/index.js` `backend/migrations` `backend/src/services/mapService.js`.

---

### Task 4: `go-dev` skill (PAUSED)

**Files:**
- Create: `.claude/skills/go-dev/SKILL.md`

Run the **standard skill steps** with this content:

```markdown
---
name: go-dev
description: Use before touching anything in engine/ — the Go engine is PAUSED. Read this first; do not do new Go work without an explicit decision to un-pause.
---

# Go engine — PAUSED ⏸️

> **The Go engine (`engine/`) is frozen as reference.** Its realtime-authority role is being rebuilt fresh in Node (`realtime/`, a separate future sub-project). Do **not** add features, refactor, or "improve" the Go code. Do not delete it either — it is the reference for the Node port.

If a task seems to require Go changes, stop and confirm the pause is being lifted.

What the engine is (for reference only):
- Entry point `engine/cmd/engine`, config `engine/internal/config`, JWT auth `engine/internal/auth` (HS256, shared secret with backend), stores `engine/internal/store` (Postgres + Redis), world/tick/collision `engine/internal/game`, WebSocket hub `engine/internal/ws`, 5-min flush `engine/internal/ticker`.
- WebSocket protocol is documented in `engine/README.md` — the Node rebuild must match it. See [[game-netcode]].

Build/test commands (only if the pause is lifted): `make engine-test`, `cd engine && go test ./...`.
```

Referenced paths to verify in Step B: `engine/cmd/engine` `engine/internal/config` `engine/internal/auth` `engine/internal/store` `engine/internal/game` `engine/internal/ws` `engine/internal/ticker` `engine/README.md`.

---

### Task 5: `local-ai-dev` skill

**Files:**
- Create: `.claude/skills/local-ai-dev/SKILL.md`

Run the **standard skill steps** with this content:

```markdown
---
name: local-ai-dev
description: Use when working on the local AI sprite-generation tooling — Stable Diffusion in a Python container, CPU-first with a CUDA switch. (Tool built in a later sub-project; this captures the ground rules.)
---

# Local AI dev (something2)

The sprite generator is a **separate Python container** (`sprite-gen/`, built in sub-project D), not part of the Node backend. It runs Stable Diffusion locally via `diffusers`.

Ground rules:
- **CPU-first.** A single image is 30s–several minutes on CPU. Never put generation in a request path a user waits on synchronously in the game — it is an **admin, background-job** tool only.
- **Device switch:** all model/device selection goes through a single `DEVICE` env var (`cpu` | `cuda`). Default `cpu`. When a GPU arrives, flipping `DEVICE=cuda` is the only change. Do not hardcode `.to("cpu")` / `.to("cuda")` at call sites.
- **Determinism:** fix the RNG seed per creature so re-runs and multi-frame sets are reproducible. Frame-to-frame consistency uses a fixed seed + ControlNet pose conditioning (see [[sprite-pipeline]]).
- **Isometric target:** output must match the renderer's sprite spec — 8 facings × N walk frames, transparent background, cropped to the iso footprint. See [[sprite-pipeline]] and [[iso-rendering]].
- **Storage:** generated frames go to MinIO (asset storage already in the stack), not committed to git.

This skill is about the *workflow and constraints*; the concrete container and API are specified in sub-project D's plan.
```

Referenced paths to verify in Step B: `compose/docker-compose.yml` (the stack the container joins). Note: `sprite-gen/` does not exist yet — do **not** list it in Step B.

---

### Task 6: `js-game-dev` skill

**Files:**
- Create: `.claude/skills/js-game-dev/SKILL.md`

Run the **standard skill steps** with this content:

```markdown
---
name: js-game-dev
description: Use when editing the canvas game under frontend/src/games/something2/src/js — game loop, coordinate space, entity model, input, networking hooks.
---

# JS game dev (something2)

The in-browser game is plain ES-module JS. Entry: `frontend/src/games/something2/src/js/main.js`. Mounted from React via `frontend/src/games/something2/Something2.jsx`.

Structure:
- `core/Game.js` — owns the loop (`requestAnimationFrame` → `update(dt)` + `render()`), input, state (`menu`/`playing`/`paused`), and reconciliation with the engine.
- `core/Map.js` — tile grid + entities; `getTileAt`, `findSafeSpawn`, `render`.
- `core/Camera.js` — follows the player; `apply(ctx)` / `reset(ctx)` wrap world-space drawing.
- `core/constants.js` — `GAME_WIDTH/HEIGHT`, `WORLD_WIDTH/HEIGHT`, `MAP_TILE_SIZE`, iso constants.
- `entities/` — `Entity` base + `Player`, `Tree`, `Stone`, `IceRock`, `MapEntity`.
- `systems/RenderSystem.js` — draws the frame. `managers/ImageManager.js` — sprite loading. `net/EngineClient.js` — WebSocket client.

**Coordinate space (critical):** all game logic — movement, collision, spawn, tile lookup — runs in **world-pixel space** (a `WORLD_WIDTH`×`WORLD_HEIGHT` Cartesian plane). Rendering projects world → screen. Keep logic in world space; do projection only at draw time. See [[iso-rendering]].

- `dt` is seconds, clamped to 0.1 max. Movement is `speed * dt`.
- Input is polled from a `keys` map (WASD/arrows), not event-driven per-frame.
- The engine is authoritative once connected; the client predicts and reconciles (`Game._reconcileSelf`). See [[game-netcode]].

Related: [[iso-rendering]], [[sprite-pipeline]], [[game-netcode]], [[js-dev]].
```

Referenced paths to verify in Step B: `frontend/src/games/something2/src/js/main.js` `frontend/src/games/something2/Something2.jsx` `frontend/src/games/something2/src/js/core/Game.js` `frontend/src/games/something2/src/js/core/Map.js` `frontend/src/games/something2/src/js/core/Camera.js` `frontend/src/games/something2/src/js/core/constants.js` `frontend/src/games/something2/src/js/entities/Entity.js` `frontend/src/games/something2/src/js/systems/RenderSystem.js` `frontend/src/games/something2/src/js/managers/ImageManager.js` `frontend/src/games/something2/src/js/net/EngineClient.js`.

---

### Task 7: `iso-rendering` skill

**Files:**
- Create: `.claude/skills/iso-rendering/SKILL.md`

Run the **standard skill steps** with this content. (Write this AFTER Tasks 10–16 land so the file references exist; if authored earlier, still verify paths in Step B and reorder if any are missing.)

```markdown
---
name: iso-rendering
description: Use when working on isometric rendering in the something2 client — the world↔screen projection, tile diamonds, depth sorting, camera.
---

# Isometric rendering (something2)

Isometric is a **rendering projection only**. Game logic stays in world-pixel space; nothing about movement or collision knows about isometric.

- **Projection module:** `frontend/src/games/something2/src/js/core/iso.js` exposes `worldToScreen(wx, wy)` and `screenToWorld(sx, sy)`, exact inverses. Constants `ISO_TILE_W = 128`, `ISO_TILE_H = 64` (2:1 diamond) live in `core/constants.js`.
- **Formula:** `screenX = (wx - wy) * K`, `screenY = (wx + wy) * K / 2`, where `K = ISO_TILE_W / (2 * MAP_TILE_SIZE)`. Inverse: `wx = (sx / K + 2 * sy / K) / 2`, `wy = (2 * sy / K - sx / K) / 2`.
- **Depth sorting:** draw everything back-to-front by world `(x + y)`. `RenderSystem` collects all drawables (map entities, local player, remote players), sorts, and draws in order so overlap is correct. Tiles are drawn first (they never overlap sprites incorrectly), sprites second.
- **Sprite anchor:** a creature's world `(x, y)` top-left is projected; the sprite is drawn so its *feet* sit at the tile center (`drawImage` offset up by the sprite height above the diamond). Sprites are taller than the tile.
- **Camera:** `Camera` centers on the player's *projected* screen position and translates the context so the player is mid-canvas. It no longer clamps to a world rectangle the way the top-down camera did.

Related: [[js-game-dev]], [[sprite-pipeline]].
```

Referenced paths to verify in Step B (only after Tasks 10–16): `frontend/src/games/something2/src/js/core/iso.js` `frontend/src/games/something2/src/js/core/constants.js` `frontend/src/games/something2/src/js/systems/RenderSystem.js` `frontend/src/games/something2/src/js/core/Camera.js`.

---

### Task 8: `sprite-pipeline` skill

**Files:**
- Create: `.claude/skills/sprite-pipeline/SKILL.md`

Run the **standard skill steps** with this content:

```markdown
---
name: sprite-pipeline
description: Use when defining or consuming creature sprites — the directional/animated frame spec, naming, storage layout, and frame-consistency approach.
---

# Sprite pipeline (something2)

Creatures (heroes, monsters) are **isometric, directional, and animated**.

- **Per creature:** 8 iso facings (N, NE, E, SE, S, SW, W, NW) × N walk frames. Static-idle is facing S, frame 0.
- **Format:** PNG, transparent background, cropped to the iso footprint, feet-anchored (see [[iso-rendering]] for the anchor). Sprites are taller than the `128×64` tile.
- **Storage (MinIO):** `sprites/<creature>/<dir>/<frame>.png` plus a packed atlas `sprites/<creature>/atlas.png` + `atlas.json` (frame rects). The client loads the atlas, not individual files.
- **Consistency (the hard part):** all frames of one creature share a **fixed RNG seed**; per-frame pose is driven by a ControlNet pose skeleton so the frames read as the same character walking, not 8 unrelated images. See [[local-ai-dev]].
- **Placeholder art:** until the generator (sub-project D) exists, the renderer uses programmer-art directional blocks (a colored diamond with a facing wedge). Keep the placeholder path working as a fallback when an atlas is missing.

Related: [[iso-rendering]], [[local-ai-dev]], [[js-game-dev]].
```

Referenced paths to verify in Step B: `frontend/src/games/something2/src/js/managers/ImageManager.js`.

---

### Task 9: `game-netcode` skill

**Files:**
- Create: `.claude/skills/game-netcode/SKILL.md`

Run the **standard skill steps** with this content:

```markdown
---
name: game-netcode
description: Use when working on client↔server realtime — the WebSocket protocol, prediction/reconciliation, and AOI. The authority is being rebuilt in Node (Go frozen).
---

# Game netcode (something2)

Transport is WebSockets. The authoritative server is currently the (frozen) Go engine; it is being rebuilt in Node with the **same protocol**.

- **Protocol** (source of truth: `engine/README.md`): client→server `join {map_id}`, `move {x, y}`, `ping`; server→client `joined {player_id, map_id, tick}`, `state {tick, players[], mobs[]}`, `collision {with, id}`, `error`, `pong`. Coordinates are **world-pixel centers**.
- **Client:** `frontend/src/games/something2/src/js/net/EngineClient.js` connects with `?token=<jwt>` and exposes `onState` / `onCollision` callbacks and `sendMove(cx, cy)` (throttled ~20Hz).
- **Prediction/reconciliation:** the local player predicts movement each frame; on each server `state` the client reconciles in `core/Game.js` (`_reconcileSelf`): diff ≤ 20px trust local, ≤ 200px lerp (0.25), > 200px snap. Remote players are overwritten directly into `Game.remotePlayers`.
- **JWT:** HS256, shared secret with the backend. The Node rebuild keeps this.
- When building the Node authority, match this protocol exactly so `EngineClient.js` changes only its URL. See [[go-dev]] (reference), [[nodejs-dev]].

Related: [[js-game-dev]], [[nodejs-dev]], [[go-dev]].
```

Referenced paths to verify in Step B: `engine/README.md` `frontend/src/games/something2/src/js/net/EngineClient.js` `frontend/src/games/something2/src/js/core/Game.js`.

---

## Phase 2 — Isometric rendering

### Task 10: Add Vitest test runner

**Files:**
- Modify: `frontend/package.json` (scripts + devDependencies)
- Create: `frontend/vitest.config.js`
- Create: `frontend/src/games/something2/src/js/core/__tests__/smoke.test.js`

**Interfaces:**
- Produces: a working `npm run test` (Vitest) in `frontend/`, used by Tasks 11–16.

- [ ] **Step 1: Install Vitest**

Run from `frontend/`:
```bash
npm install -D vitest@^3
```
Expected: `vitest` added under devDependencies.

- [ ] **Step 2: Add the test script**

Edit `frontend/package.json` `"scripts"` to add:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create `frontend/vitest.config.js`**

```js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.js"],
  },
});
```

- [ ] **Step 4: Write a smoke test**

Create `frontend/src/games/something2/src/js/core/__tests__/smoke.test.js`:
```js
import { describe, it, expect } from "vitest";

describe("vitest smoke", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run the tests**

Run from `frontend/`: `npm run test`
Expected: 1 passed.

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vitest.config.js frontend/src/games/something2/src/js/core/__tests__/smoke.test.js
git commit -m "test: add vitest runner"
```

---

### Task 11: `iso.js` projection module + tests

**Files:**
- Create: `frontend/src/games/something2/src/js/core/iso.js`
- Create: `frontend/src/games/something2/src/js/core/__tests__/iso.test.js`

**Interfaces:**
- Consumes: `MAP_TILE_SIZE` from `constants.js` (existing, `= 100`); `ISO_TILE_W`, `ISO_TILE_H` added in Task 12 — but to keep Task 11 self-contained, `iso.js` defines `ISO_K` from literals here and Task 12 reconciles the constants. Use `ISO_TILE_W = 128`, `MAP_TILE_SIZE = 100` inline via import from constants where available.
- Produces: `worldToScreen(wx, wy) -> {x, y}`, `screenToWorld(sx, sy) -> {x, y}` (exact inverses), and `depthKey(wx, wy) -> number`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/src/js/core/__tests__/iso.test.js`:
```js
import { describe, it, expect } from "vitest";
import { worldToScreen, screenToWorld, depthKey, ISO_K } from "../iso.js";

describe("iso projection", () => {
  it("maps world origin to screen origin", () => {
    const s = worldToScreen(0, 0);
    expect(s.x).toBeCloseTo(0, 6);
    expect(s.y).toBeCloseTo(0, 6);
  });

  it("is a 2:1 diamond: +x world goes down-right, +y world goes down-left", () => {
    const sx = worldToScreen(100, 0); // one world tile along x
    expect(sx.x).toBeCloseTo(100 * ISO_K, 6);
    expect(sx.y).toBeCloseTo(50 * ISO_K, 6);
    const sy = worldToScreen(0, 100);
    expect(sy.x).toBeCloseTo(-100 * ISO_K, 6);
    expect(sy.y).toBeCloseTo(50 * ISO_K, 6);
  });

  it("screenToWorld is the exact inverse of worldToScreen", () => {
    for (const [wx, wy] of [[0, 0], [123, 456], [-789, 321], [5000, 9999]]) {
      const s = worldToScreen(wx, wy);
      const w = screenToWorld(s.x, s.y);
      expect(w.x).toBeCloseTo(wx, 4);
      expect(w.y).toBeCloseTo(wy, 4);
    }
  });

  it("depthKey increases as world x+y increases (draw order)", () => {
    expect(depthKey(10, 10)).toBeLessThan(depthKey(20, 10));
    expect(depthKey(10, 10)).toBeLessThan(depthKey(10, 20));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `frontend/`: `npm run test -- iso`
Expected: FAIL — `Failed to resolve import "../iso.js"`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/games/something2/src/js/core/iso.js`:
```js
import { MAP_TILE_SIZE, ISO_TILE_W } from "./constants.js";

// K scales world pixels to iso screen pixels. A world tile of MAP_TILE_SIZE
// projects to a diamond ISO_TILE_W wide (and ISO_TILE_W/2 tall — 2:1).
export const ISO_K = ISO_TILE_W / (2 * MAP_TILE_SIZE);

export function worldToScreen(wx, wy) {
  return {
    x: (wx - wy) * ISO_K,
    y: (wx + wy) * ISO_K / 2,
  };
}

export function screenToWorld(sx, sy) {
  // Invert the linear system above.
  const a = sx / ISO_K;       // wx - wy
  const b = (2 * sy) / ISO_K; // wx + wy
  return {
    x: (a + b) / 2,
    y: (b - a) / 2,
  };
}

// Painter's-algorithm sort key: larger = nearer the camera = drawn later.
export function depthKey(wx, wy) {
  return wx + wy;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run from `frontend/`: `npm run test -- iso`
Expected: PASS (4 tests). Note: this import depends on `ISO_TILE_W` in `constants.js`, added next task. If it errors on `ISO_TILE_W` being undefined, that is expected until Task 12 — do Task 12's Step 1 (add the constants) first, then return. To keep tasks independent, add the constants now as part of this step if absent.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/core/iso.js frontend/src/games/something2/src/js/core/__tests__/iso.test.js
git commit -m "feat: add isometric world<->screen projection with tests"
```

---

### Task 12: Isometric constants

**Files:**
- Modify: `frontend/src/games/something2/src/js/core/constants.js`

**Interfaces:**
- Produces: `ISO_TILE_W = 128`, `ISO_TILE_H = 64` exports. `MAP_TILE_SIZE` stays `100` (world logic unit). `GAME_WIDTH/HEIGHT`, `WORLD_WIDTH/HEIGHT`, `GRID_SIZE` unchanged.

- [ ] **Step 1: Add the constants**

Edit `frontend/src/games/something2/src/js/core/constants.js` to its full new content:
```js
export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;
export const GRID_SIZE = 40;
export const WORLD_WIDTH = 10000;
export const WORLD_HEIGHT = 10000;

// World logic unit — a tile is MAP_TILE_SIZE world pixels square. All movement
// and collision run in this world-pixel space. Do not change without auditing
// Player.update / Map.getTileAt.
export const MAP_TILE_SIZE = 100;

// Isometric render footprint — a world tile projects to a 2:1 diamond this size
// on screen. Rendering only; world logic never uses these.
export const ISO_TILE_W = 128;
export const ISO_TILE_H = 64;
```

- [ ] **Step 2: Verify iso tests still pass**

Run from `frontend/`: `npm run test -- iso`
Expected: PASS (4 tests) — `ISO_K` now resolves `ISO_TILE_W`.

- [ ] **Step 3: Verify lint**

Run from `frontend/`: `npm run lint`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/games/something2/src/js/core/constants.js
git commit -m "feat: add isometric tile-footprint constants"
```

---

### Task 13: Isometric camera

**Files:**
- Modify: `frontend/src/games/something2/src/js/core/Camera.js`
- Create: `frontend/src/games/something2/src/js/core/__tests__/camera.test.js`

**Interfaces:**
- Consumes: `worldToScreen` from `iso.js`; `GAME_WIDTH/HEIGHT` from `constants.js`.
- Produces: `Camera` with `update(target)` (stores the target's projected screen center in `this.screenX/screenY`), `apply(ctx)` (translates so that center is mid-canvas), `reset(ctx)`. Removes the old world-rectangle `x/y/width/height` clamp usage — but keeps `width`/`height` fields (still read by `Map.render`/`Entity.render` culling in later tasks).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/src/js/core/__tests__/camera.test.js`:
```js
import { describe, it, expect } from "vitest";
import { Camera } from "../Camera.js";
import { worldToScreen } from "../iso.js";
import { GAME_WIDTH, GAME_HEIGHT } from "../constants.js";

function fakeCtx() {
  return {
    calls: [],
    save() { this.calls.push(["save"]); },
    restore() { this.calls.push(["restore"]); },
    translate(x, y) { this.calls.push(["translate", x, y]); },
  };
}

describe("iso camera", () => {
  it("stores the projected screen center of the target", () => {
    const cam = new Camera();
    const target = { x: 5000, y: 5000, width: 64, height: 64 };
    cam.update(target);
    const expected = worldToScreen(target.x + 32, target.y + 32);
    expect(cam.screenX).toBeCloseTo(expected.x, 6);
    expect(cam.screenY).toBeCloseTo(expected.y, 6);
  });

  it("apply() translates so the target sits at canvas center", () => {
    const cam = new Camera();
    cam.update({ x: 0, y: 0, width: 0, height: 0 }); // projects to (0,0)
    const ctx = fakeCtx();
    cam.apply(ctx);
    const translate = ctx.calls.find((c) => c[0] === "translate");
    expect(translate[1]).toBeCloseTo(GAME_WIDTH / 2, 6);
    expect(translate[2]).toBeCloseTo(GAME_HEIGHT / 2, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `frontend/`: `npm run test -- camera`
Expected: FAIL — `cam.screenX` is undefined / translate mismatch.

- [ ] **Step 3: Write the implementation**

Replace `frontend/src/games/something2/src/js/core/Camera.js` full content:
```js
import { GAME_WIDTH, GAME_HEIGHT } from "./constants.js";
import { worldToScreen } from "./iso.js";

export class Camera {
  constructor() {
    // Projected screen-space center the camera is looking at.
    this.screenX = 0;
    this.screenY = 0;
    // Retained for off-screen culling in Map/Entity render (world-space extent
    // of the viewport is approximated generously by these).
    this.width = GAME_WIDTH;
    this.height = GAME_HEIGHT;
  }

  update(target) {
    const cx = target.x + target.width / 2;
    const cy = target.y + target.height / 2;
    const s = worldToScreen(cx, cy);
    this.screenX = s.x;
    this.screenY = s.y;
  }

  apply(ctx) {
    ctx.save();
    // Put the looked-at screen point at the middle of the canvas.
    ctx.translate(
      Math.floor(GAME_WIDTH / 2 - this.screenX),
      Math.floor(GAME_HEIGHT / 2 - this.screenY),
    );
  }

  reset(ctx) {
    ctx.restore();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run from `frontend/`: `npm run test -- camera`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/core/Camera.js frontend/src/games/something2/src/js/core/__tests__/camera.test.js
git commit -m "feat: isometric screen-space camera"
```

---

### Task 14: Isometric map tile rendering

**Files:**
- Modify: `frontend/src/games/something2/src/js/core/Map.js` (`render` + `renderGrid` only; logic methods untouched)

**Interfaces:**
- Consumes: `worldToScreen` from `iso.js`; `MAP_TILE_SIZE`, `ISO_TILE_W`, `ISO_TILE_H` from `constants.js`; camera provides `screenX/screenY`.
- Produces: tiles drawn as filled diamonds; grid drawn as diamond outlines. `getTileAt`, `findSafeSpawn`, `generateEntities`, `init`, `toggleGrid` unchanged.

- [ ] **Step 1: Add a tile-diamond helper (no test — visual method)**

At the top of `Map.js`, update the import line and add a helper method. Change:
```js
import { WORLD_WIDTH, WORLD_HEIGHT, MAP_TILE_SIZE } from "./constants.js";
```
to:
```js
import { WORLD_WIDTH, WORLD_HEIGHT, MAP_TILE_SIZE, ISO_TILE_W, ISO_TILE_H } from "./constants.js";
import { worldToScreen } from "./iso.js";
```

- [ ] **Step 2: Replace `render(ctx, camera)`**

Replace the existing `render` method body with an isometric version. Full method:
```js
  render(ctx, camera) {
    if (this.tiles.length === 0) return;

    // Draw tiles as diamonds. Iterate the whole grid but skip diamonds whose
    // projected center is far outside the canvas (cheap cull using camera center).
    const halfW = ISO_TILE_W / 2;
    const halfH = ISO_TILE_H / 2;
    const cullX = camera.width;   // generous screen-space margins
    const cullY = camera.height;

    for (let r = 0; r < this.rows; r++) {
      if (!this.tiles[r]) continue;
      for (let c = 0; c < this.cols; c++) {
        const tileType = this.tiles[r][c];
        if (!tileType) continue;

        // World-pixel center of this tile.
        const wx = c * this.tileSize + this.tileSize / 2;
        const wy = r * this.tileSize + this.tileSize / 2;
        const s = worldToScreen(wx, wy);

        // Cull: project relative to camera center.
        const relX = s.x - camera.screenX;
        const relY = s.y - camera.screenY;
        if (relX < -cullX || relX > cullX || relY < -cullY || relY > cullY) continue;

        const tileDef = this.mapTiles ? (this.mapTiles[tileType] || (Array.isArray(this.mapTiles) ? this.mapTiles.find(t => t.name === tileType || t.type === tileType) : null)) : null;
        ctx.fillStyle = tileDef ? tileDef.color : "#000000";

        // Diamond centered on (s.x, s.y).
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - halfH);
        ctx.lineTo(s.x + halfW, s.y);
        ctx.lineTo(s.x, s.y + halfH);
        ctx.lineTo(s.x - halfW, s.y);
        ctx.closePath();
        ctx.fill();
      }
    }

    if (this.showGrid) {
      this.renderGrid(ctx, camera);
    }

    // NOTE: entities are no longer drawn here. RenderSystem collects and
    // depth-sorts all drawables (entities + players) so iso overlap is correct.
  }
```

- [ ] **Step 3: Replace `renderGrid(...)`**

Replace `renderGrid` with a diamond-outline version (signature simplified — it no longer needs start/end rows):
```js
  renderGrid(ctx, camera) {
    const halfW = ISO_TILE_W / 2;
    const halfH = ISO_TILE_H / 2;
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.lineWidth = 1;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const wx = c * this.tileSize + this.tileSize / 2;
        const wy = r * this.tileSize + this.tileSize / 2;
        const s = worldToScreen(wx, wy);
        const relX = s.x - camera.screenX;
        const relY = s.y - camera.screenY;
        if (relX < -camera.width || relX > camera.width || relY < -camera.height || relY > camera.height) continue;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - halfH);
        ctx.lineTo(s.x + halfW, s.y);
        ctx.lineTo(s.x, s.y + halfH);
        ctx.lineTo(s.x - halfW, s.y);
        ctx.closePath();
        ctx.stroke();
      }
    }
  }
```

- [ ] **Step 4: Verify the map still exports entities for RenderSystem**

Confirm `this.entities` is still populated by `init`/`generateEntities` (unchanged). RenderSystem (Task 15) reads `map.entities`. No code change needed — just confirm by reading the file.

- [ ] **Step 5: Lint**

Run from `frontend/`: `npm run lint`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/src/js/core/Map.js
git commit -m "feat: render map tiles as isometric diamonds"
```

---

### Task 15: Isometric RenderSystem with depth sort

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js`
- Create: `frontend/src/games/something2/src/js/systems/__tests__/depthSort.test.js`

**Interfaces:**
- Consumes: `map.render(ctx, camera)` (tiles only, from Task 14); `map.entities` (array with world `x,y,width,height`); `player` (world `x,y,width,height`); `remotePlayers` (NativeMap of `user_id -> {x,y,hp}`); `depthKey`, `worldToScreen` from `iso.js`.
- Produces: `RenderSystem.render(player, camera, map, remotePlayers, localUserId)` unchanged signature; internally builds a drawable list, sorts by `depthKey`, draws back-to-front. Exposes a pure static helper `RenderSystem.buildDrawables(player, map, remotePlayers)` returning a depth-sorted array, so it is unit-testable without a canvas.

- [ ] **Step 1: Write the failing test for the depth-sort helper**

Create `frontend/src/games/something2/src/js/systems/__tests__/depthSort.test.js`:
```js
import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";

describe("RenderSystem.buildDrawables", () => {
  it("returns drawables sorted back-to-front by world x+y", () => {
    const player = { x: 100, y: 100, width: 64, height: 64 };
    const map = { entities: [
      { x: 500, y: 500, width: 40, height: 40, color: "#0f0" }, // far
      { x: 0, y: 0, width: 40, height: 40, color: "#f00" },     // near-origin
    ] };
    const remote = new Map([[7, { x: 300, y: 300, hp: 10 }]]);

    const drawables = RenderSystem.buildDrawables(player, map, remote);
    const keys = drawables.map((d) => d.depth);
    const sorted = [...keys].sort((a, b) => a - b);
    expect(keys).toEqual(sorted);
    // origin entity first, far entity last
    expect(drawables[0].kind).toBe("entity");
    expect(drawables[drawables.length - 1].depth).toBe(1000);
  });

  it("includes the local player and each remote player", () => {
    const player = { x: 100, y: 100, width: 64, height: 64 };
    const map = { entities: [] };
    const remote = new Map([[7, { x: 300, y: 300, hp: 10 }]]);
    const drawables = RenderSystem.buildDrawables(player, map, remote);
    const kinds = drawables.map((d) => d.kind).sort();
    expect(kinds).toEqual(["player", "remote"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `frontend/`: `npm run test -- depthSort`
Expected: FAIL — `RenderSystem.buildDrawables is not a function`.

- [ ] **Step 3: Rewrite `RenderSystem.js`**

Replace the full file content:
```js
import { GAME_WIDTH, GAME_HEIGHT, ISO_TILE_H } from "../core/constants.js";
import { worldToScreen, depthKey } from "../core/iso.js";

export class RenderSystem {
  constructor(canvas, imageManager) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;
    this.imageManager = imageManager;
  }

  // Pure, canvas-free: collect every world object into one list tagged with a
  // depth key, sorted back-to-front for the painter's algorithm.
  static buildDrawables(player, map, remotePlayers) {
    const out = [];
    const entities = (map && map.entities) || [];
    for (const e of entities) {
      out.push({ kind: "entity", ref: e, depth: depthKey(e.x, e.y) });
    }
    out.push({ kind: "player", ref: player, depth: depthKey(player.x, player.y) });
    if (remotePlayers) {
      for (const [userId, p] of remotePlayers) {
        out.push({ kind: "remote", ref: p, userId, depth: depthKey(p.x, p.y) });
      }
    }
    out.sort((a, b) => a.depth - b.depth);
    return out;
  }

  render(player, camera, map, remotePlayers, localUserId) {
    // Background
    this.ctx.fillStyle = "#0f3460";
    this.ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    camera.apply(this.ctx);

    // Tiles (drawn first; they underlay all sprites).
    map.render(this.ctx, camera);

    // Depth-sorted sprites (entities + local + remote players interleaved).
    const drawables = RenderSystem.buildDrawables(player, map, remotePlayers);
    for (const d of drawables) {
      if (d.kind === "player") this.drawCreature(d.ref, "player", 1);
      else if (d.kind === "remote") this.drawCreature(d.ref, "player", 0.85, d.userId);
      else this.drawEntity(d.ref);
    }

    camera.reset(this.ctx);

    this.renderHud(player, remotePlayers, localUserId);
  }

  // Draw a sprite so its feet sit on the tile center for its world (x,y).
  drawCreature(obj, imageKey, alpha = 1, tag = null) {
    const w = obj.width || 64;
    const h = obj.height || 64;
    // Anchor: project the feet (bottom-center of the world box).
    const s = worldToScreen(obj.x + w / 2, obj.y + h / 2);
    const drawX = s.x - w / 2;
    const drawY = s.y - h + ISO_TILE_H / 2; // lift so feet rest on the diamond
    const img = this.imageManager.get(imageKey);
    this.ctx.globalAlpha = alpha;
    if (img) {
      this.ctx.drawImage(img, drawX, drawY, w, h);
    } else {
      this.ctx.fillStyle = tag !== null ? "#f59e0b" : "#1a1a2e";
      this.ctx.fillRect(drawX, drawY, w, h);
      this.ctx.strokeStyle = "white";
      this.ctx.strokeRect(drawX, drawY, w, h);
    }
    this.ctx.globalAlpha = 1;
    if (tag !== null) {
      this.ctx.fillStyle = "#fff";
      this.ctx.font = "12px sans-serif";
      this.ctx.fillText(`#${tag}`, drawX, drawY - 4);
    }
  }

  drawEntity(e) {
    const w = e.displayWidth || e.width || 40;
    const h = e.displayHeight || e.height || 40;
    const s = worldToScreen(e.x + (e.width || 40) / 2, e.y + (e.height || 40) / 2);
    const drawX = s.x - w / 2;
    const drawY = s.y - h + ISO_TILE_H / 2;
    const img = e.image && this.imageManager ? this.imageManager.get(e.image) : null;
    if (img) {
      this.ctx.drawImage(img, drawX, drawY, w, h);
    } else {
      this.ctx.fillStyle = e.color || "#888";
      this.ctx.fillRect(drawX, drawY, w, h);
    }
  }

  renderHud(player, remotePlayers, localUserId) {
    const remoteCount = remotePlayers ? remotePlayers.size : 0;
    const lines = [
      `Players online: ${1 + remoteCount}`,
      `You: #${localUserId ?? "?"}  pos=(${Math.round(player.x)}, ${Math.round(player.y)})`,
    ];
    this.ctx.save();
    this.ctx.fillStyle = "rgba(0,0,0,0.55)";
    this.ctx.fillRect(10, 10, 260, 18 * lines.length + 12);
    this.ctx.fillStyle = "#e5e7eb";
    this.ctx.font = "13px monospace";
    this.ctx.textBaseline = "top";
    lines.forEach((t, i) => this.ctx.fillText(t, 18, 16 + i * 18));
    this.ctx.restore();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run from `frontend/`: `npm run test -- depthSort`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole suite + lint**

Run from `frontend/`: `npm run test && npm run lint`
Expected: all tests pass, no new lint errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/RenderSystem.js frontend/src/games/something2/src/js/systems/__tests__/depthSort.test.js
git commit -m "feat: depth-sorted isometric render system"
```

---

### Task 16: Placeholder directional sprites + Entity iso cull

**Files:**
- Modify: `frontend/src/games/something2/src/js/entities/Entity.js` (`render` becomes a no-op used only as a fallback; iso drawing now lives in RenderSystem)
- Create: `frontend/src/games/something2/src/js/systems/placeholderSprite.js`
- Create: `frontend/src/games/something2/src/js/systems/__tests__/placeholderSprite.test.js`
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js` (use placeholder directional art for creatures with no loaded image)

**Interfaces:**
- Consumes: a creature's `facing` string (one of `"N","NE","E","SE","S","SW","W","NW"`), defaulting to `"S"`.
- Produces: `facingToWedge(facing) -> {dx, dy}` a unit vector pointing in the iso screen direction of that facing, used to draw a facing indicator on placeholder blocks. `Entity.render` no longer draws (RenderSystem owns drawing) but stays as a safe fallback.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/src/js/systems/__tests__/placeholderSprite.test.js`:
```js
import { describe, it, expect } from "vitest";
import { facingToWedge } from "../placeholderSprite.js";

describe("facingToWedge", () => {
  it("returns a unit-ish vector per facing", () => {
    const s = facingToWedge("S");
    expect(Math.hypot(s.dx, s.dy)).toBeCloseTo(1, 6);
  });

  it("S and N point opposite on screen", () => {
    const s = facingToWedge("S");
    const n = facingToWedge("N");
    expect(s.dx).toBeCloseTo(-n.dx, 6);
    expect(s.dy).toBeCloseTo(-n.dy, 6);
  });

  it("defaults unknown facings to S", () => {
    expect(facingToWedge("???")).toEqual(facingToWedge("S"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `frontend/`: `npm run test -- placeholderSprite`
Expected: FAIL — cannot resolve `../placeholderSprite.js`.

- [ ] **Step 3: Implement `placeholderSprite.js`**

Create `frontend/src/games/something2/src/js/systems/placeholderSprite.js`:
```js
import { worldToScreen } from "../core/iso.js";

// Screen-space direction each world facing points, in iso projection.
// World deltas per facing (x = east, y = south in world space):
const FACING_WORLD = {
  N:  { x: -1, y: -1 },
  NE: { x:  0, y: -1 },
  E:  { x:  1, y: -1 },
  SE: { x:  1, y:  0 },
  S:  { x:  1, y:  1 },
  SW: { x:  0, y:  1 },
  W:  { x: -1, y:  1 },
  NW: { x: -1, y:  0 },
};

// Convert a facing to a normalized screen-space wedge direction.
export function facingToWedge(facing) {
  const w = FACING_WORLD[facing] || FACING_WORLD.S;
  // Project the direction through the iso transform (origin-relative).
  const s = worldToScreen(w.x, w.y);
  const len = Math.hypot(s.x, s.y) || 1;
  return { dx: s.x / len, dy: s.y / len };
}

// Draw a colored diamond block with a facing wedge. ctx is a 2D context,
// (cx, cy) is the screen center, size is the block half-extent.
export function drawPlaceholder(ctx, cx, cy, size, color, facing) {
  ctx.fillStyle = color || "#7c3aed";
  ctx.beginPath();
  ctx.arc(cx, cy, size, 0, Math.PI * 2);
  ctx.fill();
  const { dx, dy } = facingToWedge(facing || "S");
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + dx * size, cy + dy * size);
  ctx.stroke();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run from `frontend/`: `npm run test -- placeholderSprite`
Expected: PASS (3 tests).

- [ ] **Step 5: Use the placeholder in RenderSystem for creatures without art**

In `frontend/src/games/something2/src/js/systems/RenderSystem.js`, add the import at the top:
```js
import { drawPlaceholder } from "./placeholderSprite.js";
```
Then in `drawCreature`, replace the `else` fallback block (the `fillRect`/`strokeRect`) with a placeholder call. Change:
```js
    } else {
      this.ctx.fillStyle = tag !== null ? "#f59e0b" : "#1a1a2e";
      this.ctx.fillRect(drawX, drawY, w, h);
      this.ctx.strokeStyle = "white";
      this.ctx.strokeRect(drawX, drawY, w, h);
    }
```
to:
```js
    } else {
      const cx = s.x;
      const cy = s.y - h / 2 + ISO_TILE_H / 2;
      drawPlaceholder(this.ctx, cx, cy, w / 2, tag !== null ? "#f59e0b" : "#4a9eff", obj.facing);
    }
```
(`s`, `h`, and `ISO_TILE_H` are already in scope in `drawCreature`.)

- [ ] **Step 6: Simplify `Entity.render` to a fallback no-op**

Replace `frontend/src/games/something2/src/js/entities/Entity.js` `render` method (drawing is now owned by RenderSystem) with:
```js
  // Drawing is owned by RenderSystem (isometric depth sort). Kept for
  // backward compatibility if any caller still invokes entity.render.
  render() {}
```
Leave the rest of the class unchanged.

- [ ] **Step 7: Run full suite + lint**

Run from `frontend/`: `npm run test && npm run lint`
Expected: all tests pass, no new lint errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/placeholderSprite.js frontend/src/games/something2/src/js/systems/__tests__/placeholderSprite.test.js frontend/src/games/something2/src/js/systems/RenderSystem.js frontend/src/games/something2/src/js/entities/Entity.js
git commit -m "feat: directional placeholder sprites for isometric creatures"
```

---

### Task 17: Manual in-browser verification

**Files:** none (verification task).

- [ ] **Step 1: Start the dev stack**

Run: `make up` (from repo root), then open the frontend at `http://localhost:15173` and navigate to the something2 game page.

- [ ] **Step 2: Verify isometric rendering**

Confirm by eye and via the on-canvas HUD:
- The map renders as a diamond grid (not a square grid).
- The player renders as a directional placeholder (blue disc + white facing wedge) at the center of the view.
- Moving with WASD moves the player; the camera keeps the player centered; tiles scroll in iso.
- Press `g` to toggle the grid — diamond outlines appear/disappear.
- Entities (trees/stones, if present on the map) draw in correct front/back order relative to the player as you walk around them (walk "behind" one, it should overlap you; walk "in front", you overlap it).

- [ ] **Step 3: Confirm movement/collision unchanged**

Walk into a non-walkable tile / entity — the player should still be blocked exactly as before (logic is world-space and untouched).

- [ ] **Step 4: Record the result**

If all pass, note it in the commit message of a trivial doc touch or just proceed. If anything fails, treat it as a bug and use superpowers:systematic-debugging before continuing.

---

## Self-Review

**Spec coverage (against the milestone scope A+B+E):**
- A skills: js-dev (T1), react-dev (T2), nodejs-dev (T3), go-dev/paused (T4), local-ai-dev (T5). ✓
- B skills: js-game-dev (T6), iso-rendering (T7), sprite-pipeline (T8), game-netcode (T9). ✓
- E iso: iso.js+tests (T11), constants footprint (T12), Camera (T13), Map diamonds (T14), RenderSystem depth sort (T15), placeholder directional sprites (T16). Plus Vitest setup (T10) and manual verify (T17). ✓
- D and C explicitly out of scope — not present. ✓

**Type/name consistency:**
- `worldToScreen`/`screenToWorld`/`depthKey`/`ISO_K` defined in T11, consumed with those exact names in T13/T14/T15/T16. ✓
- `ISO_TILE_W`/`ISO_TILE_H`/`MAP_TILE_SIZE` defined in T12, imported in iso.js/Map.js/RenderSystem. ✓
- `RenderSystem.buildDrawables(player, map, remotePlayers)` produced in T15, tested with that signature. ✓
- `Camera.screenX/screenY/apply/reset` produced in T13, consumed in T14/T15. ✓
- `facingToWedge`/`drawPlaceholder` produced in T16, consumed in RenderSystem T16 Step 5. ✓

**Ordering note:** T11 imports `ISO_TILE_W` from constants, added in T12. T11 Step 4 flags this and instructs adding the constants if absent; cleanest execution order is T10 → T12 → T11 → T13 → T14 → T15 → T16 → T17. When executing, do **Task 12 before Task 11**.

**Known simplification:** off-screen culling in Map/RenderSystem uses a generous camera-center margin rather than exact frustum math — correct (never culls visible tiles), slightly over-draws. Acceptable for a 10000×10000 world at this stage; revisit if profiling shows tile-fill cost.
