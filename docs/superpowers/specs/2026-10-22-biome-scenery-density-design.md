# Biome scenery: fuller, mostly walkable, several objects per tile

Date: 2026-10-22 · Status: draft for approval (builder-checked)

## Intent

Biomes read as a carpet of ground tiles with the odd tree. The user wants them
to feel *filled*: a forest crowded with trees, bushes, ferns, pebbles and
mushrooms; a desert with cacti and dry scrub; a crypt with bones and rubble.
Each biome gets its own scenery set.

The second half of the ask is about how scenery *behaves*: almost all of it is
walk-through decoration (~90%), it occupies only part of a tile rather than the
whole of it, and one tile can hold more than one object — or a different object
in each corner.

Agreed in conversation:

- Both readings of "walkable at 90%": ~90% of scenery objects are pure
  decoration you walk through, **and** the few blockers (trees, boulders) block
  only a small footprint at their base/trunk, so you can walk behind and under
  the crown.
- Several objects per tile, each at its own spot inside the tile.
- Per-biome scenery sets, including the biomes that are bare today.
- Reshuffling scenery in all existing worlds is acceptable (terrain does not
  change, only where decorations sit).
- New art comes from the existing Art Generation pipeline.

## Current state (verified 2026-10-22)

- `generateChunkDecorations` (`backend/src/services/mapService.js:776`) is a
  pure seeded function, shared by the `/chunk` endpoint (`index.js:5711`), the
  authority's collision (`authority/collision.js:195`) and seeding's
  navigability check (`services/navigability.js`). Nothing is stored. Output is
  at most **one** decoration per tile, at integer `row,col`, drawn centred.
- Tuning is global: `DECO_CELL=6`, `DECO_DENSITY=0.58`, `DECO_FILL=0.6`
  (`mapService.js:624`). `DECO_CELL` is also reused by the gate-corridor rules.
- Collision: a blocking decoration blocks a hard-coded centre square
  `|lx-50|<=10 && |ly-50|<=10` of a 100 px tile, mirrored in
  `ServerMap.isWalkable` (`collision.js:204`) and `ChunkedMap.isWalkable`
  (`frontend/.../core/ChunkedMap.js:76`). Only per-type input: `walkable`.
  `entity_types.hitbox_size` exists but is unused here.
- Scenery types are `entity_types` rows with `is_creature=false` and non-empty
  `spawn_tiles` (loader: `services/decorationDefs.js`, `ORDER BY id`). There are
  7: Tree, Stone, IceRock, pine_tree, dead_tree (blocking), bush, rose_bush
  (walkable). All have art.
- 32 biomes (`biomes.terrain_tiles`, `biomes.flora_types`). Most biome floors
  (jungle_floor, cobblestone, crypt_floor, cave_floor, swamp, ruin_stone,
  fungal_floor, highland_rock, bone_floor, all deep-dungeon floors…) appear in
  no type's `spawn_tiles`, so those biomes spawn almost nothing even when they
  list flora. Eight deep biomes have empty flora.
- Seeds: `backend/seeds/data/decorationTypes.js`, `backend/seeds/data/biomes.js`,
  plus the sync snapshots `backend/seeds/sync/{entities,biomes,art}.json`.
  `services/worldGen/worldGen.js:106-192` hard-codes a mirror of biome flora.
- Rendering: `RenderSystem.collectDecorations` (`RenderSystem.js:280`) pushes
  decorations into the shared drawable list sorted by `depthKey(tileCenter)`.
  Admin: `BiomesAdmin.jsx` (flora checkboxes), `EntityTypesAdmin.jsx`
  (walkable, spawn_tiles, chance, display size).

## Goals

1. **Several objects per tile at sub-tile positions.** The generator emits
   objects with a position inside the tile (not the tile centre), and a tile can
   carry more than one.
2. **Two kinds of scenery:**
   - *Features* — trees, boulders, large bushes, cacti. Roughly the current
     behaviour: clumped, at most one per tile, some block.
   - *Ground cover* — grass tufts, flowers, ferns, pebbles, mushrooms, reeds,
     bones, rubble bits. Never blocks. Scattered 0..N per tile, including on
     tiles that also have a feature.
3. **Footprint collision.** A blocking object blocks a small circle (per-type
   radius) at its own anchor point, not a fixed tile-centre square. Client and
   server compute it from the same generator output, identically.
4. **Per-biome density.** Each biome sets how dense its features and its ground
   cover are (forest dense, desert sparse, dungeon floors light).
5. **Every biome has a scenery set** whose types actually spawn on that biome's
   floors — including the eight bare deep biomes.
6. **Mostly walkable, as an overall feel (user's decision).** Across the game,
   roughly nine in ten placed objects are walk-through. This is not a strict
   per-biome rule: a forest may be tree-heavy and a crypt pillar-heavy when
   that serves the biome's look. The look wins over the ratio.
7. **Correct depth within a tile.** Each *feature* sorts by its own world
   position against actors and other features. Ground cover lies flat on the
   ground and always draws beneath every feature and actor (see Rendering).

## Non-goals

- Harvesting, chopping, interacting with or destroying scenery.
- Wind sway / animation for scenery (static images only; existing `sprite`
  render mode keeps working but nothing new depends on it).
- Persisting decorations in the database. They stay a pure function of
  (world seed, terrain, defs).
- Changing terrain generation, biome banding, roads or villages.
- Hand-placed scenery in the map editor.

## Anti-goals (failure even if it "works")

- **Client/server collision disagreement.** Any mismatch shows as rubber-banding
  or walking through a tree on one side. Both sides must consume identical
  generator output and the identical point-vs-footprint test.
- **Sealed worlds.** A portal, doorway, spawn, village gate or road blocked, or
  a pocket the player cannot leave. The existing exclusions (spawn radius,
  portals, villages, gate corridors, carved paths) must still hold, and every
  shipped world must pass the navigability check after the change.
- **Frame-rate drop.** Several times more drawables per screen must not tank
  rendering. Ground cover must be cheap.
- **Visual mud.** So much clutter that creatures, items and players get lost in
  it. Ground cover is small and draws beneath features and actors in its own
  tile band.
- **Floating or misplaced sprites.** Objects anchored at their base point,
  not the image centre.
- **Bare tiles where art is missing.** A new type with no image yet must not
  draw as a broken box in game. Types without art are skipped by the
  generator, or drawn with an acceptable placeholder (see "Left to the builder").

## Design decisions

### Data model (entity_types / biomes)

New columns on `entity_types` (scenery rows only use them):

- `scenery_layer` — `'feature' | 'cover'`, default `'feature'` (all 7 existing
  types stay features).
- `block_radius` — integer px, the blocking circle radius around the anchor.
  `0` or null means walk-through. For existing blockers the default reproduces
  today's footprint size (~10–12 px); trees block at the trunk only.
  `walkable` stays the source of truth for *whether* a type blocks (existing UI,
  seeds and checks keep working); `block_radius` says *how much*.
- `max_per_tile` — cover only: upper bound on copies of this type in one tile
  (default 2).

New columns on `biomes`:

- `feature_density` — replaces the global `DECO_DENSITY`/`DECO_FILL` pair for
  that biome (null = today's global values).
- `cover_density` — expected ground-cover objects per eligible tile (0 = none).

Exact column names and defaults are the builder's, but they must live in a
migration plus the seed files (`seeds/data/*.js` and the sync snapshots), since
seeds rebuild the catalogue.

**Rollout to existing databases (my call):** the migration adds the columns,
inserts the new scenery types (idempotent, by name), widens existing types'
`spawn_tiles`, and **appends** the new type names to each biome's
`flora_types`. It only adds, never removes or reorders, so flora choices
already made in the admin pages survive. Dev and staging then show the new
scenery without a forced re-seed. The seed files carry the same end state, so
a fresh seed and a migrated DB agree.

### Generator output

`generateChunkDecorations` returns objects shaped like
`{ name, row, col, ox, oy, blocking, radius, layer }` where `ox,oy` are the
anchor's offset inside the tile in tile pixels (0..100). It stays pure and
deterministic, keyed off the world seed with new XOR salts for the cover pass
and for offsets.

- **Feature pass:** the current clump logic, with per-biome density, one
  feature per tile, now with a jittered offset. Blocking features are jittered
  only within a window that keeps their whole blocking circle inside the tile.
  That keeps collision lookup to a single tile and preserves every
  per-tile exclusion rule.
- **Cover pass:** independent of clumps (a light scatter everywhere, thicker
  inside clumps is acceptable). Per tile, draw a count from `cover_density`,
  pick types weighted by `chance` from the biome's flora list filtered to
  cover types whose `spawn_tiles` include the terrain, place each at a jittered
  offset. Cover skips carved paths and roads (so trails stay readable), but
  ignores spawn/portal exclusions since it never blocks.
- Output ordering must be deterministic (row, col, then emission order) so
  client and server iterate identically.

### Collision

`blockedDecorationsFor(cx, cy)` on both sides changes from a `Set` of tile keys
to a `Map<tileKey, Array<{x, y, r}>>` of circles in tile-local pixels.
`isWalkable` tests the point against the circles in its tile only (valid
because blocking circles never cross a tile edge). The client and server
implementations stay line-for-line mirrors, with a shared test fixture that
asserts both return the same answer on a grid of sample points for several
worlds.

### Rendering

Each feature draws anchored at its own world point
(`tileOrigin + (ox, oy)`) in the shared sorted drawable list, with `depthKey`
computed from that point, so features sort correctly against each other and
against actors.

**Ground cover draws in its own pass, after the ground tiles and before the
sorted drawable list** (my call, settling a contradiction in the first draft).
Cover is flat ground clutter. Depth-sorting it would put a fern over a player's
feet, the "visual mud" anti-goal. A separate unsorted pass is also the cheap
path for the frame-rate goal. Cover art prompts therefore ask for low, flat
objects (tufts, pebbles, leaves, bones lying down), not upright ones. Keep
per-object cost minimal (pre-resolved image, no per-frame allocation). `inspect.js` and the minimap should be checked
for assumptions about one decoration per tile.

### Scenery catalogue (my call, adjustable in admin)

New types to add (all walk-through unless marked ■ blocking). Names indicative.

| Biome group | Features | Ground cover |
|---|---|---|
| Meadow, Highlands | Tree ■, Stone ■, bush, rose_bush, boulder ■ | grass_tuft, wildflowers, pebbles, clover |
| Deep Forest, Verdant Jungle | Tree ■, pine_tree ■, jungle_palm ■, fern_large, bush | fern, mushrooms, fallen_leaves, twigs, moss_rock |
| Arid Dunes, Storm Coast | cactus ■, dead_tree ■, dry_shrub | pebbles, sand_ripple_rock, bleached_bones, driftwood (coast) |
| Frozen Waste, Frostvault, Crystal Hollows | IceRock ■, pine_tree ■, crystal_cluster ■ | snow_tuft, ice_shards, frost_pebbles, small_crystals |
| Mire, Gloomfen, Fungal Deep, Blightworks | dead_tree ■, giant_mushroom ■, bush | reeds, lily_moss, glowcaps, bog_bubbles_rock |
| Ashfields, Emberdepths, Infernal Gate, Sunken Foundry | charred_stump ■, ember_rock_spire ■ | ash_pile, ember_pebbles, slag_bits |
| Catacombs, Ossuary, Deepvault, Fallen Sanctum, Grave of Titans, Sunken Ruins, Sunken Cistern | broken_pillar ■, rubble_heap ■, Stone ■ | bones, skull, rubble_bits, candle_stub, cracked_tile |
| Cavern, Umbral Warren, Hive Warrens | stalagmite ■, Stone ■ | cave_pebbles, glowworm_moss, small_stalagmite |
| Abyssal Rift, Dreaming Dark, The Maw, Pestilent Deep, Shattered Vault | void_crystal ■ | void_motes_rock, chaos_shards, plague_pustule, dream_wisp_stone |

**Plus ten more per biome group (user's request, raised from five).** Mostly walk-through, so
the overall feel stays mostly walkable. ■ = blocking; all others walk-through.

| Biome group | +10 |
|---|---|
| Meadow, Highlands | dandelions, tall_grass_clump, lavender_patch, mole_hill, berry_bush, daisies, buttercups, mushroom_ring, fallen_branch, hay_tuft |
| Deep Forest, Verdant Jungle | tree_stump, fallen_log ■, vines_patch, pinecones, jungle_flowers, bamboo_cluster ■, bluebells, acorns, exposed_roots, orchid_patch |
| Arid Dunes, Storm Coast | sandstone_rock ■, tumbleweed, desert_flower, seashells, beach_grass, desert_succulent, animal_skull, cracked_earth_patch, washed_up_seaweed, crab_shell |
| Frozen Waste, Frostvault, Crystal Hollows | frozen_shrub, icicle_cluster, snowdrift, frozen_bones, blue_crystal_shards, mammoth_tusk ■, pine_sapling, frozen_puddle, snow_rock, frost_flowers |
| Mire, Gloomfen, Fungal Deep, Blightworks | swamp_log ■, mossy_stump, cattails, toadstools, bog_lily, gnarled_roots, lily_pads, swamp_skull, glowing_spores, wisp_stone |
| Ashfields, Emberdepths, Infernal Gate, Sunken Foundry | burnt_shrub, scorched_bones, lava_crack, obsidian_shard, sulfur_vent, magma_rock ■, ash_skeleton, ember_flowers, charcoal_chunks, cinder_tuft |
| Catacombs, Ossuary, Deepvault, Fallen Sanctum, Grave of Titans, Sunken Ruins, Sunken Cistern | tombstone ■, fallen_statue_head, broken_urn, cobwebs, rusty_chains, coffin_lid ■, bone_pile, candle_cluster, scattered_scrolls, offering_bowl |
| Cavern, Umbral Warren, Hive Warrens | crystal_vein_rock ■, cave_mushrooms, dripping_puddle, hive_resin, small_loose_rocks, rock_column ■, cave_bones, glowing_fungus, drip_stones, spider_webs |
| Abyssal Rift, Dreaming Dark, The Maw, Pestilent Deep, Shattered Vault | floating_rune_stone, void_tendrils, shattered_glass, rotting_spores, dream_lilies, obelisk_fragment ■, void_pool_rock, star_shards, eye_stalks, corrupted_bones |

Totals: each biome group gains 14–17 new types (roughly 16–21 scenery kinds per
biome including existing ones). That is about **138 new types**, so about 138
pictures to generate. 11 of the 90 extra types block. Within a group, a type spawns only where its
`spawn_tiles` meet that biome's floors (seashells and driftwood on the coast,
not the dunes), so biomes in one group still differ.

Every new type's `spawn_tiles` lists the floors of the biomes that use it, so
the "listed but never spawns" gap closes. Existing types gain the missing floors
where they fit (e.g. Stone on cave_floor and cobblestone).

**`services/worldGen/worldGen.js` is NOT changed** (my call). It is a
byte-parity port of the GPU box's Python world-spec generator (pinned by
`backend/tests/world_gen_parity.test.js` and golden fixtures), and its flora
table feeds generation choices such as `FLORA_OPTIONAL`, `enrichFlora` and
`THIN_FLORA_BELOW`. Editing it would break parity or force a cross-repo change
to the box. The DB/seed catalogue drives what actually spawns in game. The two
lists drifting is accepted and recorded as a follow-up, not fixed here.

Ratio: a measurement script reports, per biome, the counts of placed features,
cover and blockers over a fixed set of chunks, plus the overall blocking share.
It is a **report, not a failing test** (user's decision). Tune densities and
`chance` weights against it until the overall share is roughly 10% and no biome
looks like a wall of blockers. The script is part of the work, not a guess.

### Art

Each new type gets an `entity_types.prompt` and is generated through the
existing Art Generation tab (subject kind `entity`, generationKind `object`),
which already trims cut-outs and writes `image`. Cover types are small
(display ~16–32 px); prompts ask for a single small object on a transparent
background. Art generation runs on the GPU box and is the user's batch to
kick off. Code and catalogue must ship without blocking on it.

### Verification

- Unit: generator determinism (same output twice; same output from authority
  and `/chunk`), per-tile counts, blocking circles inside tile bounds, cover
  never blocking, exclusions still honoured, blocking ratio per biome.
- Mirror test: client `ChunkedMap.isWalkable` vs server `ServerMap.isWalkable`
  over sample points for several worlds.
- Navigability: run the seeding navigability check over every shipped world
  spec. Zero regressions.
- Browser: walk a forest, a desert and a crypt in the running game. Confirm
  several objects per tile, correct front/behind ordering, walking through
  cover and behind tree crowns, blocked at trunks, no rubber-banding, and frame
  rate comparable to before.
- Use a scratch database for any DB-backed tests. Never mutate the shared dev
  DB in experiments (project rule).

## Left to the builder

- Exact column names, migration timestamps, defaults.
- Jitter distribution and minimum spacing between cover objects in one tile.
- Whether cover counts thicken inside feature clumps.
- Placeholder behaviour for types with no art yet: skip vs simple shape.
- `/chunk` payload format for cover. Cover never affects collision, so the
  authority does not need it. Keep the response compact: thousands of cover
  objects per 64x64 chunk is the expected scale.
- How projectiles, knockback and guard pathfinding react to off-centre
  footprints (they all go through `isWalkable`), and whether the navigability
  flood keeps treating a blocking tile as wholly blocked (conservative and
  acceptable).
- Whether `worldGen.js`'s flora mirror is updated by hand or derived.
- Performance tactics for drawing many cover objects (batching, culling).
- Admin UI exposure of the new fields (layer, block radius, max per tile on
  Entities; feature/cover density on Biomes). Expected, but layout is open.
- Slicing into tickets.
