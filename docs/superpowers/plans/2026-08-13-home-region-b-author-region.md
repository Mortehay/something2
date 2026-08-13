# Home Region B — Author the Starting Region (SOMET-289)

**Goal:** the entry world and its two compass neighbours read as settled territory —
villages joined by a road hostiles never spawn on, with off-road pens of skittish
level 1–2 wildlife to practise on.

**Spec:** `docs/superpowers/specs/2026-08-12-home-region-design.md` §2.
Ticket **SOMET-289**, child of epic SOMET-287. Consumes slice A (SOMET-288,
`safeRegion` + spawn exclusion) and slice C (SOMET-290, `chase_style: 'skittish'`).

---

## Decision 1 — road routing: **authored polylines** (spec §2's option b)

`collectPathCells` derives the road lattice purely from `seed` / `pathCell` /
`pathJitter`; `safe_road_radius` only widens what it already drew. The three
options the spec leaves open were measured against the real generator before
choosing (`scratchpad/roadmap.js`, output recorded below):

| option | result on the three home worlds |
|---|---|
| (a) place villages onto lattice cells | The lattice **cannot reach Old Trailhead's east doorway**. Its nearest road cell to the arrival tile (32,62) is (42,62), a Chebyshev distance of 10 — three times the largest defensible radius. A village could be moved onto a trunk, but the *doorways* cannot be moved, so "a road connecting the villages and the two doorways" stays unachievable. |
| (c) accept roads pass near by luck | Leaves the safe corridor a random blob unrelated to the villages: the player experiences "some arbitrary regions have no monsters", which is the feature failing to read. |
| **(b) authored polylines, unioned into `collectPathCells`** | **Chosen.** |

**Why (b) is cheap here and not gold-plating.** `collectPathCells` is already the
single derivation of where roads are: `generateRegion` stamps `cfg.pathTile` on
its output (so an authored road is *drawn*, in the same sand tile the lattice
uses), and `safeContextFor` feeds the same Set to `safeRegion` (so the safe
corridor follows the authored road by construction, with no second rule).
Unioning a set of authored cells into that one function therefore makes the road
visible, walkable-looking and safe in one change, and it reaches both the chunk
endpoint and the authority because both go through `buildWorldGenConfig`.

**Shape:** `roads: [ [[row,col],[row,col],…], … ]` — a list of polylines in tile
coordinates. **Every consecutive pair must be axis-aligned** (same row or same
col) and the validator rejects anything else. No interpolation, no diagonal
rasterisation, no surprises: the cells drawn are exactly the cells between the
points named. A world authoring no roads gets `[]`, and `collectPathCells`
returns byte-for-byte what it returned before — the same compatibility posture
slice A took for `safe_road_radius`.

## Decision 2 — `safe_road_radius` = **2** on all three worlds

Measured against the real generator with the authored roads unioned in
(`scratchpad/verify.js`):

| world | lattice cells | authored | union | **% of map safe at r=2** |
|---|---|---|---|---|
| Old Trailhead | 323 | 74 | 391 | **42.7 %** |
| Windwatch Pass | 369 | 127 | 491 | **52.5 %** |
| Thornbriar Reach | 347 | 65 | 409 | **41.9 %** |

r=1 leaves the corridor barely a creature wide; r=3 on top of the authored roads
would push Windwatch past 60 %. Windwatch is the high one because it has four
doorways and therefore two authored highways (a full N–S and E–W cross); at
`density: normal` on 64×64 it asks for only 12 scattered + 1 pack, so the 47.5 %
that stays wild is ample. **Watch for slice A's `populateWorld: scatter
under-delivered` warning while seeding** — it is the only feedback loop on this
number.

## Decision 3 — pens keep their creatures alive, and actually get any

Two independent traps, two independent answers.

**`populateWorld`'s opening DELETE** spares `type = 'Village Guard'`, a non-null
`blocks_portal_id`, or a non-null `home_x`. A penned creature is given
`home_x`/`home_y` at its own spawn tile. That is **not** a marker bolted on to
dodge the delete — it is the leash anchor slice C's flee clamp needs
(`withinLeash(x, y, c.home, bh.leashRadius)` treats a null home as
unconstrained), so the anchor and the containment are the same fact. The seeder
inserts pen creatures **before** `populateWorld` runs, inside the same
transaction, exactly as the vault-chest pass does, so the sparing is proven on
the live path rather than assumed.

**The placement chokepoint refuses by TILE, not by faction.**
`creatureTileCandidates` returns null for *any* creature type on a safe tile, so
routing pen creatures through `placeMapCreatures` would silently produce an empty
pen for any pen inside the road corridor. Pens therefore get **their own placer**
(`services/pens.js`) which deliberately does not consult `isSafeTile`. It still
refuses the structurally impossible — the wall ring, a doorway cell, an
unwalkable tile, a village footprint — because those are geometry, not policy.
`creatureTileCandidates` is left alone: teaching it a faction distinction would
change hostile placement in all 86 worlds to serve four pens.

All four pens are nevertheless authored genuinely **off-road** (verified: 0 of 30
tiles inside the radius-2 corridor for every pen). The bypass exists so the
feature cannot fail silently if a later author moves one, not to paper over this
one's placement.

## Decision 4 — what is authored where

Three worlds, **three villages** (one each), **four pens**. Every world is
64×64, `chunk_size` 32. Verified: navigable with villages stamped, no village
box touches a doorway or arrival tile, every pen fully walkable and clear of
every village.

**All three worlds are reachable by ordinary compass links** — Old Trailhead is
the entry world, the other two are one hop from it — and **no `map_links` row
into or out of any of them carries a `blocks_portal_id` guard** (verified by
query, 12 links, 0 guards). Their level bands are [1,2], [2,4] and [1,1]. So
slice G's death-bind travel primitive opens no gate here: binding to one of these
villages grants a respawn into a world the player could already walk to, at the
lowest bands in the game.

### Old Trailhead (entry, seed 1001, doorways W/E, band [1,2])

- **Village — unchanged.** Rows 31–34, cols 30–35, gate S, spawn (3150,3250).
  Left exactly where migration `1714440175000` put it: the authored road can bend
  around a village, so there is no reason to move one and re-derive its spawn,
  merchant and two guard posts.
- **Roads.** Highway `[[32,1],[32,27],[37,27],[37,39],[32,39],[32,62]]` — enters
  at the west arrival tile, detours south around the village box, and leaves at
  the east arrival tile. Gate spur `[[35,33],[37,33]]` joins the gate (34,33) to
  the detour.
- **Pens.** Beast Swarm ×5 at rows 24–28 / cols 33–38 (three tiles north of the
  village wall); Woodland Swarm ×5 at rows 36–40 / cols 15–20 (two tiles south of
  the corridor edge, beside the westward road).

### Windwatch Pass (seed 1002, doorways N/S/E/W, band [2,4])

- **Village — new.** Rows 24–27, cols 38–43, gate S. Gate (27,41); interior rows
  25–26, cols 39–42. Spawn tile (25,39) = (3950,2550) — interior, and clear of
  the merchant post (25,41) and both guard posts (26,40)/(26,42).
- **Roads.** `[[32,1],[32,62]]` and `[[1,32],[62,32]]` — a full cross joining all
  four doorway arrival tiles. Gate spur `[[28,41],[32,41]]`.
- **Pen.** Beast Swarm ×5 at rows 12–16 / cols 36–41, eight tiles north of the
  village, just east of the N–S highway.

### Thornbriar Reach (seed 2002, doorways W/E, band [1,1])

- **Village — new.** Rows 25–28, cols 28–33, gate S. Gate (28,31); interior rows
  26–27, cols 29–32. Spawn tile (26,29) = (2950,2650) — clear of the merchant
  (26,31) and guards (27,30)/(27,32).
- **Roads.** `[[32,1],[32,62]]`, gate spur `[[29,31],[32,31]]`.
- **Pen.** Woodland Swarm ×5 at rows 36–40 / cols 14–19.

**Creature choice.** Woodland Swarm and Beast Swarm only. All three types slice C
flagged carry the Skittish profile, but rung is not level band —
`deriveLevelBand` mixes the line's tier in, and Highland Swarm is **levels 8–10**
(Highlands, tier II) against Woodland's and Beast's 1–2. A level 8–10 skittish
creature is legitimate content; it is not starting-zone content.

**Two specs, not one.** Old Trailhead and Windwatch Pass live in
`spine-descent.map.json`; Thornbriar Reach lives in `hub-vale.map.json`. The
Old Trailhead ↔ Thornbriar link that makes them neighbours exists only in the
live database — it is in no checked-in spec. Both files are edited.

---

## Scope

**In:** `worlds.authored_roads` and `worlds.pens`; the union in
`collectPathCells`; `roads` and `pens` in the map spec + validator + applier; a
pen placer; the two spec files; a migration moving the live rows; tests.

**Out:** the roam leash clamp (slice C follow-up `fix/home-region-c-followups`
owns it — see Dependencies); teaching `creatureTileCandidates` about factions;
`safe_rects` over the pens (pens are deliberately wild pockets — the road is
where the safety is).

## File structure

| File | Responsibility |
|---|---|
| `backend/migrations/1714440200000_world_authored_roads_and_pens.js` | **new.** The two columns. |
| `backend/src/services/mapService.js` | **modify.** `worldConfig` normalizes `authoredRoads`; `collectPathCells` unions them. |
| `backend/src/services/worldGenConfig.js` | **modify.** Map `authored_roads` onto the config. |
| `backend/src/services/pens.js` | **new.** Pen geometry + the placer that bypasses `isSafeTile`. |
| `backend/seeds/mapSpec.js` | **modify.** `roads`, `pens`, and both keys in `WORLD_KEYS`. |
| `backend/scripts/seed-map.js` | **modify.** Persist the columns; a pen pass before `populateWorld`. |
| `backend/seeds/maps/spine-descent.map.json` | **modify.** Old Trailhead + Windwatch Pass. |
| `backend/seeds/maps/hub-vale.map.json` | **modify.** Thornbriar Reach. |
| `backend/migrations/1714440201000_home_region_content.js` | **new.** Move the live rows. |
| `backend/tests/authored_roads.test.js` | **new.** The union, and that `[]` changes nothing. |
| `backend/tests/pens.test.js` | **new.** A pen contains its creatures, including inside a corridor. |
| `backend/tests/map_spec_validate.test.js` | **modify.** `roads` / `pens` validation cases. |
| `backend/tests/home_region_db.test.js` | **new.** Live rows match the checked-in specs. |

## Tasks

1. **Plan doc**, committed before any implementation.
2. **Columns + generator threading.** Migration `1714440200000`;
   `buildWorldGenConfig` → `authoredRoads`; `worldConfig` normalizes;
   `collectPathCells` unions authored cells clipped to its window. Test: an
   authored polyline appears in the returned Set and in `generateRegion`'s tiles;
   a world with `[]` returns a Set identical to today's.
3. **Spec fields.** `roads` and `pens` validated in `mapSpec.js`; **`'pens'` and
   `'roads'` added to `WORLD_KEYS` one entry per line** (slice E adds
   `'waypoints'` to the same set — keep the merge trivial).
4. **The pen placer.** `services/pens.js`; wired into `applyMapSpec` after
   villages and **before** `populateWorld`, idempotent per world.
5. **The two spec files**, with the content from Decision 4.
6. **The content migration** `1714440201000`: columns, `createVillage` for the
   two new villages, hostiles inside the new footprints deleted, pen creatures
   inserted through the same placer, `entry_spawn` read **FROM** the entry
   village's `spawn_x`/`spawn_y`, `world_chunks` dropped for the three worlds.
7. **Tests + full suite** against the recorded baseline.

## Dependencies on the parallel C follow-up

`fix/home-region-c-followups` (SOMET-290 follow-ups) is clamping roam to the
leash and extending the knockback clamp beyond guards. **This slice depends on
that landing for pen containment to be true**, and on nothing else from it:

- A pen creature is anchored at `home_x`/`home_y` and the `Skittish` profile's
  `leash_radius` is 500 px = 5 tiles. Today roam is not leash-clamped at all
  (measured 959 px from a 200 px leash in 45 s), so a penned creature strolls
  out; knockback only clamps guards, so it can also be shoved out.
- **Honest limit even after that fix:** the leash is per *behaviour*, not per
  creature (`world_creatures` has no leash column), so 500 px from each
  creature's own anchor is the containment, not the pen rectangle. A 6×5 pen and
  a 5-tile leash are the same order of magnitude, so creatures stay in the
  neighbourhood of their pen; they are not fenced into it. That is consistent
  with the spec's "no walls and no gates on a pen".

## Testing

- `authored_roads.test.js` — union, clipping, axis-alignment, and the
  `[]`-changes-nothing guarantee.
- `pens.test.js` — a pen yields exactly `count` creatures, all inside the box,
  every one carrying a home anchor; **and the same pen placed on top of a road
  corridor still fills** (the hazard-4 regression, which is the failure this
  whole placer exists to prevent).
- `map_spec_validate.test.js` — non-axis-aligned segment, out-of-bounds point,
  pen overlapping a village, unknown pen creature type, count exceeding the pen
  area.
- `map_spec_fixtures.test.js` — automatic; both edited specs must keep validating.
- `home_region_db.test.js` — for each of the three worlds, the live
  `safe_road_radius` / `authored_roads` / `pens` equal the checked-in spec's; the
  live village box equals the spec's; `entry_spawn` equals the entry village's
  `spawn_x`/`spawn_y`; every pen holds ≥1 creature of its authored type carrying
  a home anchor; no non-guard creature stands inside any village footprint.
- Pen survival through `populateWorld` is asserted in `home_region_db.test.js`
  against a fixture world, not the live rows.
- Full backend suite vs the recorded baseline (2052 tests, 2034 pass, 14
  pre-existing failures).

## Definition of done

Offline navigability passes for all three worlds with villages stamped; no
village box overlaps a doorway or arrival tile; `entry_spawn` read from the entry
village; no hostile inside any village footprint; the DB test green; the full
suite at baseline. **Browser verification is required for this slice and carries
slices A and C as well** — the script is in the report.
