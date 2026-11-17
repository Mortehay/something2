# World dressing: thin walls, more flora, ruin sites

Date: 2026-11-17. Status: draft for owner approval.

## Intent

Maps feel empty. Outdoor worlds are terrain bands with a sparse scatter of 7
decoration types; nine underground biomes are fully barren; walls read as fat
cubes. This project fills the world with things to look at and some things to
do: thinner connected walls, many more trees/bushes/ground details, and ruined
buildings — some pure scenery, some small points of interest with a chest and
guards.

Success: walking any outdoor or underground world, the eye always has
something in view; walls look like walls; a player now and then stumbles on a
ruin worth fighting for.

## Goals

1. Walls render as thin (1/4 tile) connected segments at their current height.
2. ~20 new decoration types (trees, bushes, ground cover, water plants, rocks,
   logs, underground flora) wired into biomes, with art from the GPU box.
3. Ruin sites placed automatically on every world from its seed (approach A).
4. Ruin sites authorable by hand in map specs (approach B).
5. Large single-sprite structures with a multi-tile blocking footprint
   (approach C).
6. A fraction of ruin sites are points of interest: field chest + guard pack.

## Non-goals

- Thin collision. The whole wall tile still blocks (players stop ~35px short
  of the visible slab). Revisit only if it feels wrong in play.
- Roofs, interiors on separate maps, destructible structures, burning as a live
  effect (burned = art and tile choice only).
- New loot tables. POI chests use the existing field-chest loot by level.
- Changing `PATH_NAME_RE` / `detectPathTile` / terrain banding.

## Anti-goals (fails even if it "works")

- Any world where a ruin, big structure or new blocker seals the spawn, a
  portal, a doorway, a village gate or a road from the rest of the map.
- Client and server disagreeing about which tiles block (rubber-banding).
- A catalog edit silently moving ruins/chests in live worlds.
- Coloured placeholder boxes shipped on the map because art is missing.

## Constraints (from the codebase)

- Walls are tiles with `wall_height > 0`; `wallRenderer.js drawWall` extrudes a
  full diamond. `RenderSystem` collects wall drawables with access to
  `chunkedMap`, so neighbour lookup is available at draw time.
- Decorations: one pure seeded `generateChunkDecorations` feeds `/chunk`, the
  authority collision overlay, and the client. Defs load via
  `loadDecorationDefs` with `ORDER BY id` (selection is order-sensitive).
  Adding defs reshuffles WHICH type lands on a tile in every world — accepted
  (decorations are not persisted) but the authority must evict cached worlds.
- `resolveMove` is mirrored byte-for-byte client/server; this project must not
  touch it.
- Villages/houses are stamped into the tile grid in `mapService.js`
  (`stampVillage`); sealed-pocket and spawn-validity checks exist and must
  cover every new blocker (memory: features have disarmed their own guards).
- Field chests (`world_chests kind='field'`) already have guard creature,
  level, respawn timer and loot. Creature packs exist (`placeCreaturePacks`).
- Changing a world's tile grid requires clearing its `world_chunks` and
  evicting the authority (`invalidateWorld`). Never mutate the shared dev DB in
  experiments; DB tests must run against `TEST_DATABASE_URL`.
- Art: entity art via the GPU box pipeline (`make entities-generate` / entity
  editor). The renderer stretches the whole image into the display box, so
  art must be autotrimmed.

## Approaches considered

- **A. Generator-stamped sites** — chosen first. Reaches every world, ruins are
  real tiles so collision/minimap/parity are free. Cost: rewrites existing
  worlds' terrain, needs chunk invalidation and seal checks.
- **B. Spec-authored sites** — chosen second. Full control for hand-made maps;
  alone it would leave procedural worlds empty, so it layers on A.
- **C. Single big sprite with blocking footprint** — chosen third. Good for
  monuments (collapsed tower, broken statue, wrecked wagon) where walking
  inside is not the point. Implemented through the decoration overlay, not the
  collision code.

Owner picked A + B + C, in that order.

## Design

### Slice 1 — Thin connected walls (client only)

- For each wall tile, look up its 4 orthogonal neighbours (iso N/E/S/W in
  grid terms). A neighbour "connects" if it is a wall tile (any
  `wall_height > 0`) — gates/doorways connect too so rings stay closed.
- Draw a centre post (square, 1/4 tile wide) plus one arm per connected
  neighbour reaching the tile edge, each extruded to `H`. Isolated wall = post
  only. Faces keep the current texture mapping and shading; arm tops get a cap
  (slightly lighter strip).
- Depth sort stays per tile; within a tile draw back arms, post, front arms.
- See-through reveal (`wallRevealed`) unchanged.
- Gates/doorways (`wall_height 24`) use the same thin form.
- Pure geometry helper (`thinWallPieces(s, halfW, halfH, H, neighbours)`)
  unit-tested; browser screenshot check of a village ring and the map edge.

### Slice 2 — Decoration catalog

**Updated 2026-11-17 (owner):** 60 types, not ~20 — ~20 kinds with variants of the common ones plus biome-specific and underground/abyssal set pieces. Fuller maps come from a separate never-blocking **ground layer** (`entity_types.deco_layer = 'ground'`) with its own density pass on tiles the main pass left empty, drawn under actors — so coverage rises without more obstacles. Exact list: `docs/superpowers/plans/2026-11-17-world-dressing-slice2-decorations.md`.

New `entity_types` rows via `seeds/data/decorationTypes.js` (seed-catalogs
upserts; a migration only if existing pattern requires it). Builder's call on
exact sizes/weights; proposed set:

| Group | Types | Walkable | Spawn tiles (examples) |
|---|---|---|---|
| Trees | birch, oak, willow, palm, burnt_tree, fallen_tree | no | grass/leafs/swamp/sand/ash_waste/earth |
| Bushes | berry_bush, fern, dry_scrub, snow_shrub | yes | grass/leafs/highgrass/dirt/sand/snow |
| Ground cover | grass_tuft, flower_patch, clover_patch | yes | grass/highgrass/earth |
| Water plants | reeds, lily_pads, cattails | yes on swamp; on water tiles they are visual only | water/swamp/cistern_shallows |
| Rocks/logs | rock_small, rock_large, mossy_rock, log, stump | small/stump/log yes; large/mossy no | rocks/earth/dirt/grass/highland_rock |
| Underground | mushroom_cluster, glowcap, crystal_cluster, bone_pile, stalagmite, hive_lump, rusted_scrap | stalagmite/crystal no, rest yes | the nine barren biomes' floor tiles |

- Each biome's `flora_types` is extended with the fitting new names (the nine
  barren biomes get their underground set). Biome order fields untouched.
- Ground cover renders flat-ish (small display height) and must not occlude
  actors badly; builder may give it a lower draw order.
- Density: keep `DECO_DENSITY`/`DECO_FILL`; ground cover gets higher weights so
  coverage rises without more blockers. Builder may tune, with a measured
  before/after coverage number.
- Art: prompts via `styleEntityPrompt`; generate on the GPU box, autotrim,
  approve. A type with no approved art must not be eligible for placement
  (avoid placeholder boxes) — gate in `loadDecorationDefs` or seed with
  `chance 0` until art exists. Builder's call which; must be one place.
- After seeding: evict authority worlds so client and server use the same defs.

### Slice 3 — Ruin sites, generator-stamped (A)

- New catalog `structure_types` (seeded from `seeds/data/structureTypes.js`):
  `name, kind ('ruin'|'monument'), width, height, wall_tile, floor_tile|null,
  gap_pattern (seeded: N gaps, min 2), wall_keep (0..1 fraction of ring kept),
  props (decoration names placed inside/around), biomes (names), poi_chance,
  sprite (monument only), footprint (monument only)`.
- New wall tiles: `ruined_wall` (stone, wall_height 32), `burnt_wall` (charred
  timber, 32), `sandworn_wall` (24), `mossy_wall` (32), plus floor
  `rubble_floor`, `charred_floor`. Art via the tile pipeline.
- Per-biome styles (proposal): Meadow/Verdant Jungle overgrown hut (mossy);
  Deep Forest burned cabin (burnt); Highlands broken watchtower (ruined);
  Arid Dunes/Storm Coast sand-buried walls (sandworn); Ashfields charred ruin
  (burnt); Frozen Waste snowed-in hut (ruined + snow floor); Sunken Ruins more
  ruined; Mire rotted stilt hut (burnt variant); underground: collapsed mine
  supports / crypt wall fragments; abyssal + infernal: none.
- **Persistence:** sites are generated ONCE per world (on seed-map / world
  create / explicit regenerate) into a new `world_structures` table
  `(id, world_id, structure_type_id, min_row, min_col, rotation, gaps jsonb,
  source 'auto'|'spec', poi bool, chest_id null)`. Stamping reads rows, never
  re-derives — so a catalog edit never moves a live ruin. A "Regenerate ruins"
  admin action (or seed command) re-rolls deliberately and invalidates.
- **Placement rules** (all hard): bounded worlds only; inside the world minus a
  2-tile margin from the edge; not on carved paths/roads; not within N tiles
  (builder: ≥4) of village footprints, portals/doorways, waypoints, entry
  spawn, authored chests; whole footprint on walkable terrain of the owning
  biome; not overlapping another site. Count = world area × density
  (builder: ~1 site per 400 tiles, capped).
- **Seal check:** after stamping, run the existing reachability check
  (spawn ↔ every doorway/portal/village gate/waypoint). Reject and re-roll a
  site that breaks it; a world whose sites cannot be placed safely gets fewer
  sites, never a sealed map. Gaps guarantee each ruin interior is reachable.
- Stamping: `stampStructures(grid, ...)` in the same pipeline as
  `stampVillage`, before decorations (so decorations never land on ruin walls;
  props placed inside are explicit, not scattered).
- Apply to existing worlds via a migration/command that generates rows and
  invalidates chunks for listed worlds; must not run against prod data without
  the usual seed flow.

### Slice 4 — Ruin points of interest

- On generation, `poi = rand < structure_types.poi_chance` (biome-tuned,
  ~25%). A POI site gets a `world_chests` row (`kind 'field'`, level = world
  level, guard type = a pack type from the biome's creature list) at its
  interior centre, and a creature pack anchored on it via the existing pack
  placement (same validity rules).
- Respawn/loot via the existing field-chest machinery; no new loot tables.
- Minimap: POI ruins get a marker (reuse chest marker).

### Slice 5 — Spec-authored sites (B)

- `worlds[].structures: [{ type, x, y, rotation?, poi?, guard?, level? }]` in
  map specs, validated in `mapSpec.js` (known type, in-bounds, not overlapping
  links/villages/chest; tile coords). `worlds[].structures_auto: false`
  suppresses auto sites for that world.
- seed-map writes `world_structures` rows with `source 'spec'`; export
  (`mapSpecExport.js`) round-trips them; `/map-planner` skill documents it.

### Slice 6 — Monuments (C)

- `structure_types.kind='monument'`: one sprite entity type (big, autotrimmed)
  + `footprint` (list of relative blocked cells).
- Placed by the same site placer (A) and spec (B). Delivered through the
  decoration list for the chunk: one drawn anchor entry plus hidden blocking
  entries for the other footprint cells (`hidden: true`), so the authority
  overlay and client walkability get them with no `resolveMove` change. A
  footprint crossing a chunk seam emits its cells in whichever chunk owns each.
- Seed set: collapsed tower, broken statue, wrecked wagon, toppled obelisk,
  giant skull (underground).

## Decisions settled after builder check (designer's calls)

- **Row lifecycle.** Auto generation runs only for a world with no `source
  'auto'` rows. When a world's seed/size/biomes change (seed-map upsert or
  admin PUT), every row is re-validated against the new terrain: invalid
  `auto` rows are dropped and re-rolled; an invalid `spec` row is a seed-map
  validation error (the spec is wrong). `mapSpecExport` exports `spec` rows
  only; auto rows re-roll wherever the spec is seeded.
- **Pack respawn.** The whole pack respawns with the chest (small extension of
  `respawnDueFieldChests`: guard_creature_ids already holds a list). Accepted
  as the one new mechanism.
- **Chest level** rolls within the world's `level_min..level_max` (seeded).
- **Guard type** comes from the world's `allowed_creature_types` ∩ the
  biome's list (the existing authority rule); empty intersection ⇒ the site is
  not a POI.
- **Seal check.** Ruin walls and monument footprints are persisted, so they go
  in the TERRAIN pass of `assertNavigable` (also checked by offline fixtures).
  POI chest tiles and each ruin's interior become required-reachable tiles.
- **Monument POI.** Allowed; the chest sits on the first walkable tile in front
  (south side) of the footprint.
- **Rollout (owner decided).** Auto sites go to ALL bounded worlds, outdoor and
  underground, except boss arenas and village hub worlds. Rides the normal
  seed flow (`make seed-map` / a `make seed-structures` command that generates
  missing auto rows and invalidates touched worlds); Orange Pi gets it through
  its own deploy, not ours. The placer excludes tiles holding persisted
  `world_creatures`, pens, chests, waypoints and saved character positions
  (offline characters landing on a new wall fall back via `spawnIsValid`).
- **Art (owner decided).** The agent generates art on the GPU box, inspects
  every image, approves and seeds it; a slice is Done only once its art is
  approved and visible in the browser. If a live box leg is blocked by the
  permission system, stop and ask — never fake it.
- **Art gate covers tiles too.** A structure type is eligible for placement only
  when its wall/floor tiles and (monument) sprite have approved art, same gate
  as decorations. No colour diamonds ship.

## Verification (every slice)

- Unit tests at public seams (geometry helper, placer, validator).
- Golden check: no world in the seeded specs ends sealed (automated test over
  all spec worlds + a sample of seeds).
- Client/server blocking parity test for structures and monuments.
- Browser verification with screenshots on the dev stack (`--mute-audio`),
  per memory recipes, before a slice is called done.

## Left to the builder

Exact sizes, weights, densities, colours, prompts; placement radius numbers
within the stated minimums; whether art gating lives in the loader or seed
weights; admin UI for structure types (minimal list/edit is enough, may be
deferred to a follow-up ticket).

## Tracking

One Plane epic "World dressing" with six child items in slice order;
each driven Backlog → In Progress → To Review → Done via plane-workflow.
