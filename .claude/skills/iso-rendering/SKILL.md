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
