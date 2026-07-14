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
