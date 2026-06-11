# Player↔Player Collision + Glow Effect — Design

**Date:** 2026-05-11
**Status:** Drafted — pending user review before writing implementation plan.

## Goal

Make players collide with each other (not pass through), and render a particle-burst "glow" on the side of each player where the collision happened. Collision behaviour is **speed-dependent and asymmetric**: each player's reaction is judged on the *impactor's* (other player's) speed — slow impactor → push, fast impactor → bounce.

## Scope

In scope:
- Player↔player collision resolution on the Go engine.
- Particle-burst visual on both colliding players, on the side facing the contact, on every client viewing the map (spectators included).
- One tunable speed threshold and one tunable bounce-kick factor in the engine.

Out of scope:
- Mob↔player and mob↔mob collision resolution (the engine grid detects them, but resolution stays a future task).
- Sprint / dash / velocity-buff mechanics (the threshold lands now and starts mattering when those exist).
- HP/damage from collisions.

## Architecture

```
[Client A]  --move-->  [Engine]
[Client B]  --move-->  [Engine]
                       │  per tick:
                       │   1. update positions
                       │   2. derive velocity (Δpos / dt) per player
                       │   3. detect overlapping pairs (existing grid.Collisions)
                       │   4. RESOLVE each pair:
                       │        - asymmetric: each player's reaction = OTHER's speed
                       │        - other.speed > threshold → bounce (impulse reflect)
                       │        - else                    → push   (split overlap)
                       │   5. broadcast `state` tick with corrected positions
                       │      + a new `collisions[]` array
                       ▼
[All clients on map] → render corrected positions, spawn particles for each
                       collision event (both A's and B's facing edges).
```

The Go engine is authoritative. The client does **no** player↔player collision logic — `Player.update`'s tree/stone collision is untouched.

Collision events ride **inside the `state` tick**, not as a separate `collision` WS message. Spectators see collisions because the state tick already broadcasts to every client on the map. The existing dedicated `collision` message and its hub plumbing are removed.

## Engine changes (Go)

**Files:** `engine/internal/game/types.go`, `world.go`, `loop.go`, `engine/internal/ws/protocol.go`, `hub.go`, `engine/internal/config/config.go`.

### 0. Fix existing unit-system mismatch (required prerequisite)

The engine today uses `defaultPlayerRadius = 0.5` and `GridCellSize` default `4`, but the client sends **pixel-space** centers (`player.x + player.width/2`, where `player.width = 64`). That means `grid.Collisions()` only ever fires when two player centers are within ~1 pixel of each other — effectively never, so player collisions don't trigger today even before this feature.

Fix as part of this work:

- `defaultPlayerRadius` → `28.0` (slightly under half the 64-px sprite, matches the existing client tree/stone hitbox shrink for foot-level overlap).
- `defaultMobRadius` → `28.0` (consistent unit). Mobs aren't moving yet so behaviour doesn't change.
- `GridCellSize` env default in `config.go` → `64.0` (one sprite width — keeps bucket count sane at pixel scales).

This is a one-time correction; once the engine standardises on pixel coordinates, no further translation is needed.

### 1. Velocity tracking

Add `Vx, Vy float64` to `Player` in `types.go`. `World.MovePlayer` computes:

```
dt = now - p.UpdatedAt
Vx = (newX - oldX) / dt
Vy = (newY - oldY) / dt
```

Stationary players naturally report velocity 0. `JoinPlayer` initialises velocity to 0.

### 2. Resolution

New method `World.ResolveCollisions(mapID) []ResolvedCollision`:

For each pair from `grid.Collisions()` where both refs are `KindPlayer`:

1. Contact normal `n = normalize(B.pos - A.pos)`; distance `d = |B - A|`; overlap `o = (A.r + B.r) - d`.
2. For **A**: impactor = B; `speed_B = hypot(B.Vx, B.Vy)`.
   - If `speed_B > BounceSpeedThreshold` → bounce: `A.pos -= n * (o/2 + BounceKickFactor * speed_B)`. Record `AKind = "bounce"`.
   - Else → push: `A.pos -= n * (o/2)`. Record `AKind = "push"`.
3. Symmetric step for **B** using `speed_A`.
4. Update both players' positions in `world` state and in the spatial grid.

Returns `[]ResolvedCollision`:

```go
type ResolvedCollision struct {
    A, B           int64    // user_ids
    AX, AY, BX, BY float64  // post-correction centers
    AKind, BKind   string   // "push" | "bounce"
    ASpeed, BSpeed float64  // each player's own speed at collision
}
```

Mob↔mob and player↔mob pairs are skipped (future work).

### 3. Loop step

In `loop.go` `step()`, between detecting collisions and broadcasting, call `world.ResolveCollisions(mapID)` so the broadcast carries corrected positions. `BroadcastTick` receives the resolved-collision list instead of raw `[]Collision`.

### 4. Wire format

In `protocol.go`:

- Extend `StatePayload` with `Collisions []StateCollision`.
- New struct:
  ```go
  type StateCollision struct {
      A      int64   `json:"a"`
      B      int64   `json:"b"`
      AX     float64 `json:"ax"`
      AY     float64 `json:"ay"`
      BX     float64 `json:"bx"`
      BY     float64 `json:"by"`
      AKind  string  `json:"a_kind"`  // "push" | "bounce"
      BKind  string  `json:"b_kind"`
      ASpeed float64 `json:"a_speed"`
      BSpeed float64 `json:"b_speed"`
  }
  ```
- Delete `MsgCollision`, `CollisionPayload`, and `buildCollisionMessages` from `hub.go`. The per-client filtered emit on `BroadcastTick` is removed.

### 5. Tuning constants

In `types.go`, top of file:

```go
const (
    BounceSpeedThreshold = 250.0  // units/sec; below = push, above = bounce
    BounceKickFactor     = 0.02   // bounce displacement bonus = factor * impactor speed
)
```

### 6. Tests

In `world_test.go` (new) or `grid_test.go`:

- Two stationary overlapping players → both pushed apart by half the overlap each; both `AKind = BKind = "push"`.
- One player moving at 400 toward a stationary one → moving player `"push"`, stationary player `"bounce"` (since impactor is the fast one).
- Both moving fast at each other → both `"bounce"`.

## Client changes (frontend)

**Files:** new `frontend/src/games/something2/src/js/systems/ParticleSystem.js`; edits to `Game.js` and `RenderSystem.js`.

### 1. `ParticleSystem.js`

Pure data + update + render. No engine coupling — it just consumes burst specs.

- Internal: a flat `Array` of `{ x, y, vx, vy, age, lifetime, hue, baseAlpha, size }`.
- `spawnBurst({ originX, originY, normalX, normalY, speed })`:
  - `count = clamp(round(8 + speed / 50), 8, 24)` — faster = more sparks.
  - Per particle: initial position = origin; initial velocity = `normal * (speed * 0.3)` with ±30° fan jitter and per-particle magnitude jitter (×0.5–×1.2).
  - `lifetime = 0.4` (seconds, ease-out alpha).
  - **Speed-based colour (option `j`):** `t = clamp(speed / 600, 0, 1)`; `hue = lerp(190, 15, t)` (cyan→red ramp); `baseAlpha = 0.4 + 0.5 * t`; `size = 2 + 2*t`.
- `update(dt)`: integrate `x += vx*dt`, `y += vy*dt`; `vx *= 0.92`, `vy *= 0.92` (drag); `age += dt`; remove particles where `age >= lifetime`.
- `render(ctx, camera)`: filled circles, `alpha = baseAlpha * pow(1 - age/lifetime, 2)`, fill `hsla(hue, 100%, 60%, alpha)`. Drawn in world space.

### 2. `Game.js` integration

- Add `this.particles = new ParticleSystem()` to the constructor.
- Remove `engine.onCollision = …` (currently at `Game.js:50`) — the wire message is gone.
- In `_onServerState(msg)`, after the player loop, iterate `msg.collisions || []` and for each event spawn two bursts:
  - **A's burst:** origin = A's center + `normal * playerRadiusPx`; normal = `(B - A)` normalised; `speed = event.b_speed` (impactor drives A's reaction).
  - **B's burst:** mirror — origin = B's center − `normal * playerRadiusPx`; normal flipped; `speed = event.a_speed`.
  - The `playerRadiusPx` value matches the engine's `defaultPlayerRadius = 28` after the unit fix in §0. World coords from the engine are in the same pixel space as the client renderer.
- In `update(dt)`, call `this.particles.update(dt)`.

### 3. `RenderSystem.render`

- Add `particles` to the `render(...)` arg list (mirroring how `remotePlayers` is threaded through from `Game.render`).
- After `this.renderPlayer(player)` and before `camera.reset(this.ctx)`, call `particles.render(this.ctx, this.camera)`.

### 4. No `Player.js` changes

Player↔player blocking is server-authoritative. Tree/stone collision logic stays as-is.

### 5. Reconciliation interaction

With `RECONCILE_SOFT_PX = 20`, most push corrections (≤ a few pixels) stay under SOFT and reconcile invisibly. Bounces (≈ `0.02 * impactor_speed` pixels — so ~5px at threshold, up to ~30px at very high speed) fall in the SOFT–HARD band and lerp smoothly via existing `_reconcileSelf`. No new client logic needed.

## Tuning summary

| Knob                       | File                          | Default | Purpose                                  |
|---                         |---                            |---      |---                                       |
| `BounceSpeedThreshold`     | `engine/internal/game/types.go` | `250.0` | push ↔ bounce dividing line              |
| `BounceKickFactor`         | `engine/internal/game/types.go` | `0.02`  | how far you get launched on bounce        |
| Particle `lifetime`        | `ParticleSystem.js`            | `0.4 s` | burst duration                           |
| Particle count formula     | `ParticleSystem.js`            | `8 + speed/50` clamped 8–24 | density scales with impact |
| Hue ramp                   | `ParticleSystem.js`            | 190° → 15° at `speed=0..600` | cyan-to-red colour temperature |

## Risks & open questions

- **Stationary-on-stationary overlap at spawn.** If both players spawn overlapping (the current hub spawns everyone at origin), the resolver will keep nudging them apart at every tick until they separate — fine, but burst particles will spam. Mitigation: skip burst emission when both speeds are 0. (Will encode in the implementation plan.)
- **3+ player pile-up.** Each pair is resolved independently per tick. Could produce small jitter in dense scrums. Acceptable for v1; revisit if it looks bad.
- **Velocity from move deltas is noisy** if clients send moves at very irregular intervals. The 20Hz client-side throttle (`DEFAULT_MOVE_INTERVAL_MS = 50`) keeps deltas predictable. Worst case: an idle player who just moved a frame ago will register some velocity; acceptable.
- **No anti-cheat on client-sent positions.** Player can spoof moves to claim huge velocities. Future work — adds a per-tick max-distance clamp in `MovePlayer`. Not addressed here.

## Success criteria

1. Two players walking into each other no longer overlap. They visibly stop / push apart.
2. A particle burst appears on each player at the contact edge, scaling colour (cyan→red) and density with the *other* player's speed.
3. A spectator (third client on the same map) sees both bursts when two other players collide.
4. With everyone at base speed (200 u/s), behaviour is "push" — no bounces yet. Bumping `BounceSpeedThreshold` to `100` (test only) produces visible bounces.
5. No client-side stutter when colliding: the local player's position correction stays under the existing soft-reconcile threshold for pushes, lerps smoothly for bounces.
6. Engine unit tests for `ResolveCollisions` pass for stationary/stationary, fast/stationary, fast/fast pairs.

## Files touched (final list)

**New:**
- `frontend/src/games/something2/src/js/systems/ParticleSystem.js`
- `engine/internal/game/world_test.go` (or addition to `grid_test.go`)
- `docs/superpowers/specs/2026-05-11-player-collision-glow-design.md` (this file)

**Modified:**
- `engine/internal/config/config.go` — bump `GridCellSize` default to `64.0`.
- `engine/internal/game/types.go` — bump `defaultPlayerRadius` / `defaultMobRadius` to `28.0`; `Vx, Vy` on `Player`; tuning constants; `ResolvedCollision` type.
- `engine/internal/game/world.go` — velocity update in `MovePlayer`; new `ResolveCollisions`.
- `engine/internal/game/loop.go` — call `ResolveCollisions` before broadcast; pass resolved list.
- `engine/internal/ws/protocol.go` — `StateCollision`; extend `StatePayload`; drop `CollisionPayload` / `MsgCollision`.
- `engine/internal/ws/hub.go` — drop `buildCollisionMessages`, drop per-client collision dispatch; pass resolved list through `BroadcastTick`.
- `frontend/src/games/something2/src/js/core/Game.js` — instantiate particle system; consume `msg.collisions`; remove `onCollision` log.
- `frontend/src/games/something2/src/js/systems/RenderSystem.js` — thread `particles` through `render(...)`; call `particles.render`.
