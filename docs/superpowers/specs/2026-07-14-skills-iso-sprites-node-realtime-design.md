# Design: Skills, Isometric Rendering, Sprite Pipeline, Node Realtime

Date: 2026-07-14
Status: Approved (brainstorming) — pending implementation planning

## Summary

This spec covers five loosely-coupled sub-projects for **something2** (a real-time
2D MMORPG), to be built in dependency order. The Go engine is **frozen as reference
and not modified or deleted** — its authoritative role is rebuilt fresh in Node.

| # | Sub-project | Outcome |
|---|-------------|---------|
| A | Dev skills authoring | Project skills: `js-dev`, `react-dev`, `nodejs-dev`, `go-dev` (paused), `local-ai-dev` |
| B | Game-dev skills authoring | `js-game-dev`, `iso-rendering`, `sprite-pipeline`, `game-netcode` |
| E | Isometric rendering | Convert the top-down canvas renderer to true isometric (built first, placeholder art) |
| D | Sprite generation tool | Separate Python container, local Stable Diffusion, directional + animated iso sprites |
| C | Node realtime authority | Replace the Go engine's authority with a Node service; Go frozen |

**Execution order:** Skills (A+B) → **E** → **D** → **C**.

Rationale for order: skills are fast and make everything else smoother; E defines the
exact sprite dimensions D must target and gives immediate visible progress; D fills the
art library; C is independent of the visual work and lands last.

## Decisions (locked during brainstorming)

- **Go → Node (C):** Keep Go untouched on disk as reference. Build realtime authority
  fresh in Node. Point the frontend `EngineClient` at the new Node service. Go is *paused*,
  not ported line-by-line, not deleted.
- **Sprite tool (D):** Separate **Python container**, local **Stable Diffusion** (`diffusers`),
  **CPU-first** with a `DEVICE=cpu|cuda` switch for a future GPU. Generation is **admin-driven,
  background jobs — never player-facing, never in the game loop.**
- **Sprite target (D):** **8 isometric facings × N walk frames** per creature (directional +
  animated). Long per-entity generation time on CPU is accepted. Frame consistency is the hard
  part and is solved with fixed seed + ControlNet pose conditioning.
- **Isometric (E):** Convert the existing top-down renderer to true isometric (2:1 diamond
  tiles). Built **first**, using placeholder programmer-art so it ships before the sprite tool.
- **Skills (A+B):** **Thin, project-specific**, committed to `.claude/skills/` (shared by
  Claude and Codex per [AGENTS.md](../../../AGENTS.md)). Not generic language tutorials.
- **Plane:** After spec approval, create a grouped task batch in Plane workspace `soomething2`,
  one group per sub-project, dependency-ordered.

## Current state (as investigated 2026-07-14)

- **Frontend** ([frontend/](../../../frontend/)): Vite 8 + React 19. In-browser canvas game under
  `frontend/src/games/something2/src/js/` (Game, Map, Camera, RenderSystem, Entity, Player,
  EngineClient). **Renders top-down / axis-aligned**, not isometric —
  [RenderSystem.js](../../../frontend/src/games/something2/src/js/systems/RenderSystem.js)
  draws sprites at raw `(x, y)` on a square grid (`GRID_SIZE`, `MAP_TILE_SIZE=100`).
  "The game is isometric" is a **goal, not current state.**
- **Backend** ([backend/](../../../backend/)): Node + Express 4 REST API (maps, tile-types,
  entity-types CRUD, WFC map generation). Has `jsonwebtoken` + `minio`. Not realtime.
- **Engine** ([engine/](../../../engine/)): Go authoritative server — JWT WebSocket hub, 60Hz
  tick loop, spatial-hash collisions, Postgres + Redis, 5-min flush. Real and fairly complete.
  **Will be frozen.**
- **Tooling:** Plane MCP (workspace `soomething2`) and chrome-devtools MCP wired in
  [.mcp.json](../../../.mcp.json). MinIO available for assets.

## Architecture overview

```
Skills (A+B)  →  Iso rendering (E)  →  Sprite tool (D)  →  Node realtime (C)
  enables         defines sprite        fills the art       replaces Go
  everything      dimensions            library             authority
```

Service changes:
- `frontend/` — renderer converted to isometric (E); consumes sprite library (D);
  `EngineClient` repointed to the Node realtime service (C).
- `backend/` — gains an admin sprite endpoint + job tracking; talks to the Python container.
- **`sprite-gen/` (new)** — separate Python container; local Stable Diffusion; generates
  directional + animated iso sprites; writes to MinIO.
- **`realtime/` (new, sub-project C)** — Node realtime authority (WS hub, tick loop, collisions,
  mob AI). `engine/` (Go) stays untouched.

## Sub-project A — Dev skills

Location: `.claude/skills/`. Each skill is a short `SKILL.md` capturing *this project's*
conventions with pointers to real files. Not generic tutorials.

| Skill | Core content |
|---|---|
| `js-dev` | JS conventions shared front/back |
| `react-dev` | styled-components + TanStack Query + react-router patterns → [.ai/styleguides/frontend.md](../../../.ai/styleguides/frontend.md) |
| `nodejs-dev` | Express + pg patterns → [.ai/styleguides/backend.md](../../../.ai/styleguides/backend.md) |
| `go-dev` | **PAUSED** banner; `engine/` reference only, no new Go work |
| `local-ai-dev` | Python SD container; **CPU-first, `DEVICE` switch to CUDA**; model/seed/ControlNet notes |

## Sub-project B — Game-dev skills

| Skill | Core content |
|---|---|
| `js-game-dev` | game loop, entity model, canvas patterns in `games/something2/src/js/` |
| `iso-rendering` | 2:1 diamond math, screen↔world transforms, depth sort |
| `sprite-pipeline` | directional + animated frame spec, naming, MinIO layout, consistency tricks |
| `game-netcode` | WS protocol, client prediction, AOI, Node realtime conventions |

## Sub-project E — Isometric rendering (built FIRST)

- **Projection:** 2:1 diamond. New `iso.js` helper with `worldToScreen(x, y)` and
  `screenToWorld(sx, sy)` (inverse of each other).
- **Tiles:** replace square `MAP_TILE_SIZE=100` with an iso tile footprint. Proposed **128×64**.
  `constants.js` updated.
- **Depth sorting:** entities drawn back-to-front by `(x + y)` so overlap is correct; sprites
  drawn taller than the tile with a defined anchor (feet at tile center).
- **Camera:** `Camera.js` follows the player in screen space after projection.
- **Placeholder sprites:** colored diamonds/blocks with a facing indicator so E ships and is
  testable *before* D exists.
- **Files touched:** `RenderSystem.js`, `Map.js`, `Camera.js`, `constants.js`; new `iso.js`.

## Sub-project D — Sprite generation tool

- **Container `sprite-gen/`:** Python + `diffusers`; `DEVICE=cpu|cuda` env; added to
  [compose/docker-compose.yml](../../../compose/docker-compose.yml). Small HTTP API:
  `POST /generate`, `GET /jobs/:id`.
- **Output per creature:** **8 iso facings × N walk frames.** Consistency via **fixed seed +
  ControlNet pose conditioning** — a shared pose skeleton per frame guarantees frames match.
  Cheap non-AI post-steps: background removal, crop to iso footprint, atlas packing.
- **Storage:** frames → **MinIO**, keyed `sprites/<creature>/<dir>/<frame>.png` plus a packed
  atlas. Metadata row in Postgres.
- **Admin flow:** admin UI (extends
  [EntityTypesAdmin.jsx](../../../frontend/src/games/something2/EntityTypesAdmin.jsx)) → backend
  enqueues a job → Python worker generates (minutes on CPU) → admin notified → review → approve →
  committed to the library. **Background jobs, never player-facing, never in the game loop.**

## Sub-project C — Node realtime authority

- New `realtime/` Node service: WS hub, tick loop, spatial-hash collision, mob pathfinding /
  aggression, Redis live state + 5-min Postgres flush. **Same JSON protocol** as
  [engine/README.md](../../../engine/README.md) so the client barely changes.
- JWT HS256, same shared secret as backend.
- Frontend
  [EngineClient.js](../../../frontend/src/games/something2/src/js/net/EngineClient.js)
  repointed from the Go port (`:18080`) to the Node service.
- `engine/` (Go) untouched; `go-dev` skill marks it paused.

## Plane task batch

- Workspace `soomething2`. One group (module/cycle/label — exact mechanism confirmed at
  creation time) **per sub-project** A–E, tasks underneath, dependency-ordered.
- Skills group first, then E → D → C.
- Created after the user approves this spec, alongside the implementation plan.

## Testing / verification

- **Iso math:** unit tests for `worldToScreen`/`screenToWorld` round-trips and depth-sort order.
- **Sprite tool:** smoke test generating one creature at low steps on CPU; verify frame count,
  transparency, and atlas packing.
- **Node realtime:** parity tests against the documented protocol; two-client multiplayer
  move/collision test.
- **Skills:** each `SKILL.md` loads and its file pointers resolve.

## Out of scope / deferred

- Player-facing live sprite generation (revisit once CUDA GPU is available).
- Line-by-line port of Go engine logic (rebuild fresh instead).
- CUDA-specific tuning (design leaves a `DEVICE` switch; no GPU work now).
- Any deletion or modification of the Go `engine/`.
