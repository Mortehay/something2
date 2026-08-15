# World scale and creature density

**Date:** 2026-08-13
**Status:** design approved, awaiting implementation plan

## Problem

Every world in the game is 64×64 tiles (one exception: Vale Crossing at 96×96),
and the whole game holds 3,726 creatures across 86 worlds. Both numbers are too
small for multiple concurrent players.

Measurements that motivate this, taken against the live dev database and the
render constants:

- **A world is ~18 screens.** The viewport is a fixed 1280×720 with a
  translate-only camera (no `ctx.scale` anywhere on the render path — see the
  derivation in `backend/src/services/villages.js`). The isometric projection
  has area scale `K² = 0.4096`, so one screen shows `1280×720 / 0.4096 / 100²`
  ≈ 225 tiles. A 4096-tile world is therefore about 18 screenfuls.
- **Density varies 11× between worlds.** Live creatures per 1000 tiles range
  from 3.6 (Vale Crossing) to 39.6 (The Abyss, The Umbral Gate). At the top of
  that range roughly 9 creatures are on screen at once; at `normal` it is 0.7.
- **Nothing forces 64.** `POST/PUT /api/worlds` already accept width and height
  from 8 to 4096 (`backend/src/index.js:2227`), the map-spec validator checks
  every authored feature against `w.width`/`w.height` rather than a literal, and
  terrain is procedural from `seed`/`biomes`/`biome_cell`. The 64 comes from
  `WORLD_SIZE` in `backend/scripts/dungeon/gen-p5-map-content.js:19` and from
  the four checked-in map specs.

## Goal

Bigger worlds and more creatures per world, with world size derived from
progression depth so scale ramps as players descend. On-screen crowding is
explicitly not a concern: worlds should feel both larger and more populated.

## Out of scope: creature respawn

**Killed creatures are deleted permanently and never come back.**
`backend/src/authority/loot.js:75` issues `DELETE FROM world_creatures WHERE
id = $1` on death. `populateWorld` — the only code that ever creates hostile
creatures — is called from exactly two places, `backend/scripts/seed-map.js:505`
and the admin re-roll route at `backend/src/index.js:2630`. There is no timer,
no cron, and no on-join repopulation. The world's creature population is a
finite pool that only drains.

This work raises the starting pool by roughly 10×, which buys time but does not
change the shape of the problem: a determined group still empties a world and it
stays empty until an operator clicks re-roll.

Respawn was deliberately deferred to its own follow-up ticket. **File it before
this epic closes.** Nothing in this design blocks it — a respawn scheduler reads
the same `world_creatures` table and can reuse `populateWorld`'s placement — but
"enough creatures for players" is not actually true until it ships.

## Decisions

| Question | Decision |
|---|---|
| Bigger maps, denser maps, or both? | Both. Crowding is not a complaint. |
| Respawn? | Separate follow-up ticket (see above). |
| How is size chosen? | Per-map authored, with the generator deriving a default from progression depth. |
| How does density rise? | Raise `perThousand` in the existing tier table; keep the tier keywords. |

## Design

### Size ramp

`backend/scripts/dungeon/escalation.js` already derives `deriveLevelBand` and
`deriveDensity` from a world's `hopFraction` (its clamped 0–1 distance along the
dungeon's progression). A new `deriveSize(hopFraction)` joins them there, so all
three progression-scaled properties are derived in one module from one input.

| hopFraction | size | tiles | screens | at `normal` (6/1k) | at `swarm` (48/1k) |
|---|---|---|---|---|---|
| 0.0–0.2 | 96×96 | 9,216 | ~41 | 55 | 442 |
| 0.2–0.4 | 128×128 | 16,384 | ~73 | 98 | 786 |
| 0.4–0.6 | 160×160 | 25,600 | ~114 | 154 | 1,229 |
| 0.6–0.8 | 192×192 | 36,864 | ~164 | 221 | 1,769 |
| 0.8–1.0 | 224×224 | 50,176 | ~223 | 301 | 2,408 |

Every size is a multiple of `chunk_size = 32`, so a world divides into whole
chunks and no partial-chunk edge case is introduced.

`deriveSize` supplies a **default**. `width`/`height` remain explicit fields in
the map spec, and a hand-authored world that sets them keeps its own values —
this is what "per-map authored sizes" means in practice. Only the 66 generated
p5-descent worlds take the derived value.

### Density

`backend/src/services/densityTiers.js` keeps its five keywords and doubles every
rate:

| tier | before | after |
|---|---|---|
| dead | 0 | 0 |
| sparse | 1.5 | 3 |
| normal | 3 | 6 |
| dense | 6 | 12 |
| horde | 12 | 24 |
| swarm | 24 | 48 |

**No migration is required.** The `worlds_density_check` constraint pins the set
of tier *names* (`dead|sparse|normal|dense|horde|swarm`), not the rates, and no
name changes. The sync note in `densityTiers.js` about keeping the key set
aligned with migration `1714440070000` still holds and is still satisfied.

Pack shapes (`packCount`, `packSizeMin`, `packSizeMax`) are left alone. Packs
are a placement flavour, not a population lever, and their budget is already
absorbed into the ceiling.

### The creature ceiling

`MAX_WORLD_CREATURES = 2000` currently clamps **silently** — `resolveDensity`
returns a reduced `scatterCount` and no caller can tell the difference between
"this world was authored thin" and "this world was truncated". With doubled
rates and a 224×224 deep world, `swarm` resolves to 2,408 and would be silently
cut by 17%.

Two changes:

1. Raise `MAX_WORLD_CREATURES` to 4,000, which clears the largest cell in the
   ramp table with headroom.
2. Make the clamp observable: when `resolveDensity` truncates, it must surface
   that fact (a returned `clamped` flag that `populateWorld` logs), so a
   truncated world is a visible event rather than a quiet thinning.

The ceiling still matters and still stays. Its stated purpose — bounding the
synchronous rejection-sampling and the INSERT batch inside one open write
transaction, on a process shared with the live authority — is unchanged by
raising the number. `resolveDensity(tier, 4096, 4096)` remains the case it
guards against.

### Runtime cost

Bigger worlds are close to free at tick time. Chunks activate only in the
neighbourhood of a player and are dropped when no player wants them
(`backend/src/authority/server.js:1012-1017`), and `activateChunk` loads only
the creatures whose rows fall inside that chunk. Simulation cost scales with
connected players, not world area. The minimap `/overview` endpoint is
player-centred over a fixed span and is likewise unaffected.

Three costs do scale with area and are accepted:

- **`world_chunks` rows.** Terrain is persisted per chunk. A 224×224 world is 49
  chunks against today's 4. Each row is one 32×32 tile grid as JSON.
- **The one-shot populate.** Rejection-sampling placement plus batched INSERTs,
  bounded by `MAX_WORLD_CREATURES`.
- **The admin full-world preview** (`generateWorldPreview`), which renders the
  whole world rather than a window. At 224×224 this is 12× today's work. It is
  an admin surface, not a gameplay path; if it becomes slow, that is a separate
  ticket.

#### Measured, after the fact (SOMET-311)

The prediction above holds for CPU and is wrong about nothing, but it missed a
cost. Measured against the dev stack on 2026-08-16 with one character parked in
each world's **densest** radius-1 chunk neighbourhood (9 chunks = 9,216 tiles —
the set `recomputeActive` activates and `broadcastCreatures` sends), 20–45 s
samples:

| world | size / tier | rows in world | creatures per broadcast | bytes per broadcast | per-socket | server tick rate |
|---|---|---|---|---|---|---|
| Ashfields Reach | 96, sparse | 28 | 28 | 5.3 KB | 30 KiB/s | 19.90 Hz |
| The Ossuary Depths: Entry | 128, normal | 102 | 60 | 11.5 KB | 60 KiB/s | 19.92 Hz |
| The Crystal Foundry: Entry | 192, horde | 907 | 194 | 36.2 KB | 180 KiB/s | 19.83 Hz |
| The Abyss: Hub | 224, swarm | 2,469 | 549–571 | 104–108 KB | 510–528 KiB/s | 19.95 Hz |

Reading it:

- **Tick budget is fine.** `tickMs` is 50 (20 Hz) and creature frames go out
  every 4th tick (5 Hz). The loop held 19.83–19.96 Hz in every world, and the
  backend container drew ~2–4 % of one core idle versus ~7–25 % with a player
  parked in the swarm neighbourhood. Simulation cost really does scale with
  players, not area.
- **Size is not the lever.** Every `SIZE_STEPS` entry is ≥ 3 chunks wide, so the
  9-chunk neighbourhood is saturated from the *smallest* step up; area above
  96×96 never enters a tick. The per-broadcast counts track the density tier
  alone (192@horde ≈ half of 224@swarm, the 24-vs-48 `perThousand` ratio).
  Trimming the top of the size ramp would not move per-player load at all.
- **Bandwidth is the real cost.** ~184 bytes per creature per frame at 5 Hz is
  ~920 B/s per creature per socket; `swarm` is ~4.2 Mbit/s of JSON down one
  socket, paid again for every socket in the neighbourhood. The client viewport
  is ~225 tiles against the neighbourhood's 9,216, so ~97 % of it is off-screen.
  The lever is the broadcast AOI and the wire shape (of the 184 bytes, ~62 are
  fields that never change after the first sighting: `type`, `color`, `maxHp`,
  `level`), not the size ramp and not the density table. That is its own ticket:
  it needs a client change and browser verification.

### Resizing existing worlds

Terrain caching is already correct for resizes: both `backend/scripts/seed-map.js:237`
and `backend/src/index.js:2600` `DELETE FROM world_chunks` for the world before
regenerating, so stale 64×64 terrain cannot survive.

What is *not* automatic is hand-authored content. Villages, roads, pens,
waypoints and `entry_spawn` are absolute tile / world-pixel coordinates. Growing
a world leaves them clustered in the old top-left 64×64 corner, and a road
authored edge-to-edge (`[[32,1] … [32,62]]` in spine-descent) now stops halfway
across the map.

The blast radius is small — of 86 worlds, only 3 have roads, 3 have pens, 7 have
villages and 3 have waypoints:

| spec | worlds | roads | pens | villages | waypoints |
|---|---|---|---|---|---|
| hub-vale | 5 | 1 | 1 | 2 | 1 |
| loop-catacombs | 7 | 0 | 0 | 0 | 0 |
| spine-descent | 8 | 2 | 2 | 2 | 2 |
| p5-descent | 66 | 0 | 0 | 3 | 0 |

Those features are re-authored by hand for their new bounds. The generated
p5-descent worlds need no coordinate work beyond `PORTAL_TILE_PX`, described
below.

### Constants that hide the old size

`gen-p5-map-content.js` carries `PORTAL_TILE_PX = 3250`, commented as "world-pixel
center of a 64×64 world". It is a hand-computed derivative of `WORLD_SIZE`, not
an independent choice. Once size varies per world it must be computed from that
world's own size rather than read from a module constant. Any other constant
derived by hand from 64 gets the same treatment; finding them is the explicit
job of Slice 1.

## Slices

**Slice 1 — make the pipeline size-agnostic.**
Turn `WORLD_SIZE` into a per-world parameter, derive `PORTAL_TILE_PX` from each
world's size, raise and instrument `MAX_WORLD_CREATURES`, and hunt the remaining
hand-derived-from-64 constants. Prove one non-64 world end to end: seed it, walk
it in a browser, cross a portal, confirm the minimap and the village behave.
This slice exists to buy information about hidden 64-assumptions before any
content depends on the answer.

**Slice 2 — the depth ramp.**
Add `deriveSize(hopFraction)` to `escalation.js`, wire it into the generator,
regenerate `p5-descent.map.json`.

**Slice 3 — density.**
Double the rates in `densityTiers.js`. One file, no migration.

**Slice 4 — re-author and re-seed.**
Set new `width`/`height` on the 20 hand-authored worlds in `hub-vale`,
`loop-catacombs` and `spine-descent` — `deriveSize` does not reach them, so a
world whose spec still says 64 stays 64 — then re-place that world's roads,
pens, villages, waypoints and `entry_spawn` for the new bounds. Re-seed all 86
worlds; verify in a browser.

Expected outcome: total creature population across all worlds rises from 3,726
today to roughly 35,000–50,000, depending on where each world lands on the ramp.

## Testing

Unit coverage per slice, in the style already used here:

- `deriveSize` is a pure function of `hopFraction` — table-driven tests over the
  boundaries (0, 0.2, 0.4, 0.6, 0.8, 1.0), plus the invariant that every
  returned size is a multiple of 32 and monotonically non-decreasing in depth.
- `resolveDensity` at the new rates, including the case that trips the ceiling,
  asserting both the clamped count and that the `clamped` flag is set.
- The map-spec validator against a deliberately oversized world: features that
  fall outside the new bounds must be rejected with the bounds in the message.
- A guard test that no world in any checked-in spec places an authored feature
  outside its own `width`/`height` — this is what catches a forgotten road when
  Slice 4 re-authors by hand.

Two hazards this project has been bitten by before and which apply directly:

- **Assertions derived from the same constants as the code.** A test that
  imports `DENSITY_TIERS` and asserts `resolveDensity` matches it proves
  nothing. The density tests must assert literal expected counts.
- **A green suite over an inert change.** Browser verification is mandatory for
  Slices 1 and 4: a resized world that still generates 64×64 terrain, or a road
  that now dead-ends, both pass a unit suite happily.

Per `AGENTS.md`: backend `npm test` from `backend/`, frontend `npx vitest run`
from `frontend/`, plus browser verification for anything with a UI surface.

## Risks

- **Traversal time.** A 224×224 world is 12× the area of today's, and the game
  allows one waypoint per world (migration `1714440270000_one_waypoint_per_world`).
  Corner-to-corner walking may become tedious at the deep end. Not addressed
  here; flagged for playtest after Slice 4, and the ramp's top step can be
  lowered without touching any other decision if it reads badly.
- **Hidden 64-assumptions.** The known ones are listed above; the unknown ones
  are what Slice 1 is for. If Slice 1 turns up something structural, the ramp
  numbers are the cheapest thing to reduce.
- **Re-seeding is destructive to creature state.** Re-seeding deletes and
  re-places non-guard creatures. It must never be run against a database anyone
  is mid-session on, and never as a casual experiment.
