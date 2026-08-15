---
name: map-planner
description: Use when planning a map, designing a new adventure map, or laying out branching worlds seeded from backend/seeds/maps/*.map.json — also triggered by /map-planner.
---

# Map planning (something2)

Adventure maps are checked-in specs (`backend/seeds/maps/<name>.map.json`), not hand-built in the admin UI. This skill is how to author one that the validator will accept the first time.

## The constraint, and why it exists

`map_links` declares `UNIQUE(from_world_id, edge)` over `edge IN ('N','E','S','W')` (`backend/migrations/1714440028000_create_map_links.js:7,11`). `setLink` (`backend/src/services/mapLinks.js:15-21`) inserts a link **and its mirror** (opposite edge, on the target) in one call — you only ever author one direction; the reverse is automatic.

Consequence: every world has **at most 4 neighbours**, one per compass point, and because a neighbour always sits at a fixed compass offset, an adventure map **must embed in a 2D integer grid** — no wraparound, no non-planar link graphs.

**N is `-y`.** `edgeOfDoorwayTile` (`backend/src/services/mapService.js:723-729`) treats `gRow === 0` as `'N'` — the top row. The spec format's `EDGE_DELTA` (`backend/seeds/mapSpec.js:21`) encodes the same convention: `N:[0,-1], S:[0,1], E:[1,0], W:[-1,0]`. So `world.grid` is `[x, y]` with **x = east-positive, y = south-positive** (north is negative y).

This is why the grid matters, not just as a drawing aid: the validator checks every link's edge against `EDGE_DELTA` (`backend/seeds/mapSpec.js:143-151`) — declaring edge `E` from A to B requires `B.grid === A.grid + [1,0]`, or validation fails. The same grid coordinates seed each world's `graph_x`/`graph_y` (`GRID_SPACING = 220`, `backend/scripts/seed-map.js:16-32`), which is what the World Map tab draws. A spec that validates is therefore guaranteed to *draw* consistent with its own links — draw the grid right and the rest follows.

## The workflow, as a hard sequence

1. **Draw the grid first.** Pick an integer `[x, y]` cell for every world before writing JSON — topology validation is a direct check against these coordinates.
2. **Write `backend/seeds/maps/<name>.map.json`** (`name`, `topology` — descriptive only, not validated — `worlds[]`, `links[]`).
3. **Validate:**
   ```
   cd backend && node --test tests/map_spec_fixtures.test.js
   ```
   This test iterates every `*.map.json` in `backend/seeds/maps/` (`tests/map_spec_fixtures.test.js:18,84-90`), so a new spec is covered automatically — nothing to register. It runs `validateMapSpec` against the live-shaped catalogs (biome names from `STARTER_BIOMES`, creature names from a hardcoded set matching `entity_types`) and also checks the shape rules below (escalation, hub spoke count, loop cycle). All 5 subtests must pass.
4. **Apply:** `make seed-map SPEC=<name>`. Never hand-edit the database, and never run this against a spec that hasn't just passed step 3 — `seed-map.js` re-validates before writing, but a spec that fails will abort mid-command having written nothing (it's one transaction), which is a worse debugging position than catching it at step 3.

## The three topologies

The three shipped specs in `backend/seeds/maps/` are the worked examples — their real shapes, not invented ones:

- **Spine** (`spine-descent.map.json`, 8 worlds): a linear critical path (`entry → pass → gorge → deep → end`) with **opt-in dead-end branches** off it — `cache` and `elite` both branch off `pass` (N and S), `shrine` branches off `gorge` (S). A dead end is just a world with one link back toward the spine.
- **Hub** (`hub-vale.map.json`, 5 worlds): one central world (`hub`, also the entry) with **up to four spokes**, one per compass edge — `forest` (E), `dunes` (W), `frozen` (N), `mire` (S). Enforced by `UNIQUE(from_world_id, edge)`, so a fifth spoke is structurally impossible, not just a convention (`tests/map_spec_fixtures.test.js:125-131` asserts `outgoing <= 4`).
- **Loop** (`loop-catacombs.map.json`, 7 worlds): a **cycle that closes on the grid** — `entry → eastwing → farhall → heart → deepvault → southwing → entry` (6 worlds around a loop), plus `crypt` as a dead-end spur off `entry`. `tests/map_spec_fixtures.test.js:133-136` asserts the undirected link graph actually contains a cycle (not just `links.length >= worlds.length`, which a re-stated mirror link could fake).

## Content rules

- **Difficulty escalates with distance from the entry**, and since SOMET-246 the escalation you author is `level_band`, not a creature count. The check is stricter than "bands differ" (`tests/map_spec_fixtures.test.js:131-170`):
  1. Most worlds in the spec must declare a `level_band` at all (at least 4 of them).
  2. Bucket every world by its BFS hop-distance from the entry (over the undirected link graph); the *lowest band floor* at hop `d` must be `>=` the lowest band floor at hop `d-1`. A branch that dips easier than something closer to the entry fails this even if the overall range still looks fine.
  3. The deepest tier's toughest band ceiling must clear **double** the entry's ceiling.

  How *many* creatures a world holds is no longer authored per world — see `density` below. There is no per-world count to escalate, and the old `creature_count` escalation test was removed with the field.
- **Biomes form contiguous regions**, not per-world random picks — `mapService.js:212-218` samples a low-frequency value-noise field keyed by `biome_cell` to decide which of a world's listed biomes owns a tile, so a world listing 2 biomes gets two visible regions, not a checkerboard. `biome_cell` is optional — `resolveBiomeCell` (`backend/src/services/mapService.js:144-159`) has three cases, in order: (1) an explicit `biome_cell` that floors to `>= 1` is used as-is; (2) otherwise, if the world has both `width` and `height`, the default is `Math.max(8, Math.floor(Math.min(width,height) / 3))` — note the floor of `8`, so e.g. a 20×20 world gets `8`, not `~6.67`; (3) a world with no bounds (no `width`/`height`) falls back to a flat `DEFAULT_BIOME_CELL = 24` (line 144).
- **Hub topology needs a village in the hub** — it's the bind point every spoke returns to (`tests/map_spec_fixtures.test.js:125-128` asserts `hub.village` exists). Spine topology wants one near the entry (see `spine-descent` — none is actually placed there in the shipped spec; `hub-vale` is the one with a village).

## The real limits (each verified against code)

- **Village** `width`: 3–8, `height`: 3–6 — `VILLAGE_LIMITS` in `backend/src/services/villages.js:8`, imported by both the spec validator and the admin API so they can't drift.
- **World** `width`/`height`: two tiers, don't conflate them.
  - `validateMapSpec` (`backend/seeds/mapSpec.js:69-83`) only checks that a world's `width` and `height` are present and integers — reject a spec that omits either, or that spells one as a non-integer. It deliberately does **not** check a range: that's the admin API's job, and duplicating the number here would let the two drift apart.
  - The **8–4096 tile** range (and `chunk_size` **1–256**) is enforced only by `POST /api/worlds` (`backend/src/index.js:1397-1409`) — there's no DB `CHECK` constraint on `worlds.width/height/chunk_size` either (`backend/migrations/1714440012000_create_worlds_and_chunks.js`, `1714440027000_bounded_worlds.js`). A spec with `width: 50000` still passes `node --test tests/map_spec_fixtures.test.js` and `make seed-map` will write it — stay inside 8–4096 anyway, since it's what the rest of the system (admin UI, world creation) assumes.
- **Exactly one `is_entry: true`** per spec, or validation fails with a count (`backend/seeds/mapSpec.js:112-115`).
- **Every world needs:** `key` (spec-local id for links), `name` (must be globally unique — `worlds_name_unique`, migration `1714440037000`), `grid: [x, y]` (must be unique per spec — occupying the same cell as another world is an error), `seed`, `width` and `height` (present, integer — validator-enforced, see above). Optional: `chunk_size` (defaults 64), `density` (defaults `normal` — see below), `allowed_creature_types`, `biomes`, `biome_cell`, `entry_spawn: {x, y}`, `village: {key, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y}` (`key` is REQUIRED and is the village's identity — a stable, world-local name that lets a re-seed MOVE the village instead of leaving it where it was; see below), `villages: [...]` (the plural form of the same shape — declare one or the other, never both), `level_band: [min, max]`, `allows_fast_travel`, `chest: {x, y, guard_creature_type, level}`, `safe_road_radius` (0–8; hostiles are not spawned within that many tiles of a carved road — see below), `safe_rects: [{min_row, min_col, width, height}]`.
- **Any other world key is REJECTED** (`WORLD_KEYS` in `backend/seeds/mapSpec.js`). An unread key is indistinguishable from a consumed one from the author's side: the spec validates, `make seed-map` exits 0, and the feature simply is not there. If you are authoring a field whose reader has not landed yet, the validator will say so by name — add it to `WORLD_KEYS` in the same change as its reader, not before.
- **`creature_count` is no longer a spec field, and a spec that still carries one is REJECTED.** `validateMapSpec` (`backend/seeds/mapSpec.js:122-128`) errors with `world "<key>" creature_count is no longer authored -- use "density" instead`. The `worlds.creature_count` *column* survives, but it is now derived: `populateWorld` overwrites it with how many creatures it actually scattered (SOMET-246).
- **Live catalogs** (verified with a read-only `SELECT` against the running dev DB, 2026-08-03):
  - Biomes (`biomes` table): `Meadow`, `Deep Forest`, `Arid Dunes`, `Frozen Waste`, `Mire`.
  - Creatures huntable in the overworld: `Wolf`, `Slime`, `Skeleton`, `Bat`. Don't re-derive this list by querying the database — read `HOSTILE_CREATURES` in `backend/seeds/data/entityTypes.js`, which is the source `make seed-catalogs` applies and which both `tests/biomes_seed.test.js` and `tests/map_spec_fixtures.test.js` now derive their catalogs from. (A database `SELECT` was the old advice and it misled: `Wolf` was missing from a rebuilt dev volume for a while, so the live table disagreed with the seed data that was about to be reapplied.) `Village Guard` is `is_creature = true` but is **not** on this list — it's a village gate defender spawned by `createVillage` (`backend/src/services/villages.js:51-69`) via `insertVillageGuards` (`villages.js:33-44`), never something you put in a world's `allowed_creature_types`.

## `density`

`density` is the one knob that decides **how many** creatures a world holds. It is a keyword, not a number — one of `dead`, `sparse`, `normal`, `dense`, `horde`, `swarm` — and it writes `worlds.density` (`backend/scripts/seed-map.js`). Omitting it writes `normal`, the column default. `mapSpec.js` validates the keyword (`backend/seeds/mapSpec.js:113-120`) as well as `worlds_density_check` (migration `1714440070000`), for the same reason `level_band` is double-checked: `make reseed-map` clears every world *before* seeding, so a tier caught only by the database fails after the destruction.

The tier resolves through one shared table (`backend/src/services/densityTiers.js`) that scales with **area**, so a 96×96 world is not accidentally sparser than a 64×64 one at the same setting:

| tier | scatter per 1k tiles | packs | pack size | on a 64×64 map |
|---|---|---|---|---|
| `dead` | 0 | 0 | — | nothing at all |
| `sparse` | 1.5 | 0 | — | 6 scattered |
| `normal` | 3 | 1 | 3–4 | 12 scattered + 1 pack |
| `dense` | 6 | 2 | 4–6 | 25 scattered + 2 packs |
| `horde` | 12 | 4 | 5–8 | 49 scattered + 4 packs |
| `swarm` | 24 | 6 | 8–12 | 98 scattered + 6 packs |

A *pack* is a cluster of one creature type around an anchor tile, placed under the same validity rules as the scatter (interior, walkable, not a wall or doorway tile, not inside a village, admitted by the local biome's fauna). A pack that cannot seat every member ships short — that is a correct outcome on a corridor-heavy map, not an error.

The resolved total is capped at **2000 creatures per world** (`MAX_WORLD_CREATURES`, same file), which only bites on very large maps: at `normal`, a world of 816×816 tiles or larger clamps (815×815 does not). Both seeding and the admin re-roll go through the same cap.

Escalate `density` alongside `level_band` for a spine — deeper worlds should be both tougher and busier. The three shipped example specs all sit on the `normal` default; authoring real tiers for them is deliberately left to a later content pass.

## `level_band`

`level_band: [min, max]` sets the range creature levels are rolled from when the game spawns creatures in that world — it writes `worlds.level_min`/`worlds.level_max` (`backend/scripts/seed-map.js`). Omitting it writes `[1, 1]`, the column defaults, which scales nothing. `mapSpec.js` validates the band (two integers, `min >= 1`, `max >= min`) even though `worlds` also has a database `CHECK` for the same rule — `make reseed-map` clears every world before seeding, so a band caught only by the database fails after the destruction. A spine topology should escalate its band with depth — see the worked example below.

Since SOMET-246, **`make seed-map` re-rolls creatures itself**: `applyMapSpec` calls `populateWorld` for every world in the spec, which deletes that world's non-guard creatures and re-places them from the world's current `density` and `level_band`. So editing either in the spec and re-running `make seed-map` takes effect on the ground, with no admin step. (Village guards and portal guards survive; they are placed by their own passes and the delete is scoped to spare them.) `POST /api/worlds/:id/creatures` still exists and now runs the *same* function, so it is a convenience for re-rolling one world from the admin UI, not the only route to a re-roll. The accepted side effect: killed creatures come back and survivors move on every re-seed.

## Worked example: `spine-descent`

Grid (columns = x/east, rows = y/south — north is up):

```
            x=0        x=1        x=2        x=3       x=4
y=-1:                 cache
y=0:      entry  --  pass  --  gorge  --  deep  --  end
y=1:                 elite     shrine
```

`pass` is a branch point (3 links: N, S, E); `gorge` has a fourth-quadrant branch (S) plus continuing E. Grid coordinates and the link fragment they produce (`backend/seeds/maps/spine-descent.map.json`):

```jsonc
// worlds[].grid
"entry": [0, 0]   "pass": [1, 0]   "cache": [1, -1]  "elite": [1, 1]
"gorge": [2, 0]   "shrine": [2, 1] "deep": [3, 0]    "end": [4, 0]

// links
{ "from": "entry", "edge": "E", "to": "pass" },   // [0,0] + E[1,0]  = [1,0]  == pass  ✓
{ "from": "pass",  "edge": "N", "to": "cache" },  // [1,0] + N[0,-1] = [1,-1] == cache ✓
{ "from": "pass",  "edge": "S", "to": "elite" },  // [1,0] + S[0,1]  = [1,1]  == elite ✓
{ "from": "pass",  "edge": "E", "to": "gorge" },  // [1,0] + E[1,0]  = [2,0]  == gorge ✓
{ "from": "gorge", "edge": "S", "to": "shrine" },
{ "from": "gorge", "edge": "E", "to": "deep" },
{ "from": "deep",  "edge": "E", "to": "end" }
```

`level_band` by distance from `entry`: `[1,2]` (entry) → `[2,4]` (pass) → `[3,5]`/`[4,6]`/`[4,6]` (cache/elite/gorge, all 2 hops) → `[6,9]`/`[6,9]` (shrine/deep, 3 hops) → `[9,12]` (end, 4 hops) — the floor never drops from one hop to the next, and the deepest world's ceiling (12) is well over double the entry's (2). That is exactly what the escalation test checks.

`density` would escalate over the same buckets — e.g. `sparse` (entry) → `normal` (pass) → `normal`/`dense`/`dense` → `dense`/`horde` → `horde` (end). The shipped `spine-descent.map.json` does **not** author this yet; every one of its worlds is on the `normal` default, and nothing asserts a density ramp.

## Two limitations to know before you seed

- **One spec per database.** Every spec is authored from its own grid origin `[0,0]`, and `graph_x`/`graph_y` are derived straight from that grid (`GRID_SPACING = 220`, `backend/scripts/seed-map.js:16-32`). The frontend's `seedPositions` (`frontend/src/games/something2/mapGraphLayout.js:35-116`) never recomputes a position for a world that already has stored `graph_x`/`graph_y` (line 49-51: it's kept exactly). So applying a second spec into a database that already has one leaves two unrelated worlds sitting at the same canvas coordinates, drawn on top of each other in the World Map tab. Treat "one spec per database" as the supported workflow; `make reseed-map SPEC=<name>` (clear, re-seed catalogs, apply) exists for exactly this — switching maps, not layering them.
- **Editing a spec and re-applying doesn't remove what you deleted.** `setLink` only inserts or retargets a link, never deletes one (`backend/src/services/mapLinks.js:15-21` — there's a separate `clearLink` that nothing in the seed path calls), and the applier never deletes a village either (its `merchant_stock` cascades off it, player listings included) — it reports the leftovers and leaves them. So deleting a link or a village from the spec file and running `make seed-map` again leaves the old row live. After a deletion, use `make reseed-map SPEC=<name>`.
- **Villages DO converge on `make seed-map` as of SOMET-312** — that is what the required `key` buys. Move a village's box in the spec, re-seed in place, and the row moves with its merchant post, its two gate guards and every player bind that points at its spawn, keeping its id (and therefore its merchant stock). It was previously a silent no-op: the applier skipped any world that already had a village and only warned on a COUNT difference, so a moved box drifted unreported (SOMET-308 found the player spawning on open grass 16 tiles from the village). Adding a village to a seeded world converges too. What still does not: a world whose live rows and spec entries cannot be matched by key (e.g. two pre-SOMET-312 unkeyed rows against one declaration) — the applier warns and applies nothing rather than guessing.

Related: [[nodejs-dev]].
