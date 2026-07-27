# Wall-Collision Clamping (Swept) — Design

**Status:** approved (brainstorming, 2026-07-27)

## Problem

Players report that touching a wall causes continuous "bumping" and slow movement, and that leaving a wall feels "glued." Root cause traced in code:

1. **Collision rejects the whole step** when the leading edge would enter a wall (`resolveMove` in `frontend/.../systems/movement.js` and `backend/src/authority/collision.js`). Step-rejection makes the stopping distance **depend on the timestep size**.
2. **Client and server use different timesteps.** The client predicts every animation frame (~16ms `dt`, `Game.js` `update`), but the server ticks at a fixed **50ms** (`world.js`, `tickMs=50`) and client reconciliation replays buffered inputs at their ~50ms `dt` (`reconcile.js`). A single 50ms step refuses movement up to ~10px further from a wall than three 16ms steps do.
3. **Reconciliation hard-snaps unconditionally** every server frame (~20Hz) — `Game.js` `_onWorldState` sets `this.player.x/y = out.x/y` with no threshold or smoothing.

So near a wall the frame prediction creeps forward and the 20Hz reconcile yanks it back a few px, repeatedly → visible jitter ("bumping"), stalled net progress ("slow"), and a sticky feel when leaving ("glued"). Diagonal-into-wall additionally slides at 0.707× speed, compounding the crawl.

This is **pre-existing** (step-rejection was always dt-dependent) but was **exposed by the footprint-collision change** (merged 13f1155): the body now stops at the wall face instead of the center passing through, so players contact walls far more often, right where the jitter lives. See [[movement-collision-architecture]].

## Goal

Make per-axis tile collision **dt-invariant** so client prediction and server/reconciliation compute the same position near walls — eliminating the snap-back jitter and glue — by replacing step-rejection with **swept wall-clamping** (move exactly up to the wall face).

## Design

### Algorithm

Per axis, if the full step's leading edge would enter a wall, move the box **up to the wall face** instead of not moving. Steps are always smaller than one tile (max ~10px vs 100px), so the leading face crosses at most one tile boundary — no multi-tile sweep needed.

Introduce a shared constant `WALL_EPS = 0.01` (world px), identical in both files, used two ways: clamp the face to `boundary − ε` (stay strictly inside the walkable tile), and inset the two perpendicular corner samples by ε (so a box edge sitting exactly on a tile line isn't misread as inside the next tile — this also removes the flush-contact "can't slide" boundary bug the footprint review flagged as conservative).

The exact `resolveMove` body (identical in both files except the `export ` prefix; the frontend adds `import { MAP_TILE_SIZE } from "../core/constants.js";`, the backend already declares `const MAP_TILE_SIZE = 100`):

```js
function resolveMove(map, actor, dirX, dirY, dt) {
  if (dirX === 0 && dirY === 0) return { x: actor.x, y: actor.y, moved: false };

  const len = Math.hypot(dirX, dirY);
  const nx = dirX / len;
  const ny = dirY / len;

  const hw = actor.width / 2;
  const hh = actor.height / 2;
  const cx = actor.x + hw;
  const cy = actor.y + hh;

  const tileSpeed = map.speedAt(cx, cy);
  const stepX = nx * actor.speed * dt * tileSpeed;
  const stepY = ny * actor.speed * dt * tileSpeed;

  let x = actor.x;
  let y = actor.y;
  let moved = false;

  // Swept clamp per axis. The leading face is the box edge in the travel
  // direction; a sub-tile step crosses at most one boundary. If the
  // destination corners are blocked, clamp the face to WALL_EPS shy of the
  // wall boundary and move only that far (dt-invariant: any timestep lands on
  // the same face). Perpendicular corners are inset by WALL_EPS so an edge
  // exactly on a tile line is not read as inside the next tile.
  if (stepX !== 0) {
    const dir = stepX > 0 ? 1 : -1;
    const face = dir > 0 ? actor.x + actor.width : actor.x;
    const destFace = face + stepX;
    const top = cy - hh + WALL_EPS;
    const bot = cy + hh - WALL_EPS;
    if (map.isWalkable(destFace, top) && map.isWalkable(destFace, bot)) {
      x += stepX;
      moved = true;
    } else {
      const boundary = dir > 0
        ? Math.floor(destFace / MAP_TILE_SIZE) * MAP_TILE_SIZE
        : Math.ceil(destFace / MAP_TILE_SIZE) * MAP_TILE_SIZE;
      const move = (boundary - dir * WALL_EPS) - face;
      if (move * dir > 0) {
        x += move;
        moved = true;
      }
    }
  }
  if (stepY !== 0) {
    const dir = stepY > 0 ? 1 : -1;
    const face = dir > 0 ? actor.y + actor.height : actor.y;
    const destFace = face + stepY;
    const left = cx - hw + WALL_EPS;
    const right = cx + hw - WALL_EPS;
    if (map.isWalkable(left, destFace) && map.isWalkable(right, destFace)) {
      y += stepY;
      moved = true;
    } else {
      const boundary = dir > 0
        ? Math.floor(destFace / MAP_TILE_SIZE) * MAP_TILE_SIZE
        : Math.ceil(destFace / MAP_TILE_SIZE) * MAP_TILE_SIZE;
      const move = (boundary - dir * WALL_EPS) - face;
      if (move * dir > 0) {
        y += move;
        moved = true;
      }
    }
  }

  return { x, y, moved };
}
```

`WALL_EPS` is declared once per file (module scope) as `const WALL_EPS = 0.01;` — outside the function body so the byte-for-byte body-parity check still passes.

### Unchanged invariants

Center anchor (`cx,cy`), `speedAt` sampled at center, per-axis independence, purity (`actor` never mutated, returns `{x,y,moved}`), and **byte-for-byte parity** between the two `resolveMove` bodies. `MAP_TILE_SIZE = 100` matches the tile size both maps already use for `isWalkable`.

### Behavior changes (verified numerically)

- **Clamp to face:** approaching a wall now stops the box flush (`WALL_EPS` shy), not up to a step short. Example: 64×64 box at x=0 stepping east `speed=40, dt=1` toward a wall at column 1 → `{x: 35.99, y: 0, moved: true}` (was `{x: 0, moved: false}`).
- **dt-invariance:** ten `dt=0.05` steps and thirty `dt=0.05/3` steps into a wall (speed 200) both end at `x = 35.99` (equal to 1e-9). This is the property that removes client/server divergence.
- **Full-speed parallel slide when flush:** once clamped against an east wall, a south move proceeds the full `10` px (the ε-inset corners no longer read the flush edge as blocked).
- Escape (moving away from an overlapped wall), gate-threading, and the two-corner guard vector are **unchanged**.

## Testing

Golden-vector battery stays replicated identically across `backend/tests/authority_collision.test.js` (`node:test`) and `frontend/.../__tests__/movement.test.js` (`vitest`). Float results use tolerance (`toBeCloseTo(_, 5)` / `Math.abs(...) < 1e-6`), not exact equality.

- **Update** the existing "block-front" vector: now `{x: ~35.99, moved: true}` (clamped), not `{x:0, moved:false}`.
- **Add dt-invariance:** one `dt=0.05` step equals three `dt=0.05/3` steps composed, approaching a wall (`|Δ| < 1e-9`). Directly encodes the fix's purpose.
- **Add flush-then-slide:** clamp against a wall, then a parallel move advances the full step (guards the ε boundary fix).
- **Keep** escape, gate-thread, and the two-corner `wallTile` guard vectors (values unchanged).

## Non-goals

- **Diagonal-into-wall slides at 0.707×** (normalized free-axis component). Standard; holding a straight parallel direction gives full speed. Re-normalizing to full-speed wall-slide is a separate feel tweak, out of scope.
- **No reconciliation smoothing.** Clamping removes the near-wall divergence at the source, so the existing hard-snap is fine; free movement has no divergence.
- The ~half-tile **visual feet offset** and the **depth-sort top-left/center inconsistency** stay as-is (out of scope, see [[movement-collision-architecture]]).

## Verification

Automated suites (backend + frontend) are the gate. Because this changes movement feel, browser-check on the live dev stack ([[dev-run-browser-verify]]): walk straight into a wall (smooth stop flush, no bumping), hold into a wall then release and move away (no glue), and slide along a wall (smooth, no stutter).
