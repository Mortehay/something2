# P3 — Tiles & Biomes: Design

**Sub-project P3 of the Bestiary Program.** Umbrella:
`docs/superpowers/specs/2026-08-06-bestiary-program-design.md`.

**Goal:** a catalog of underground and abyssal biomes, each with its own
terrain, so a dungeon can look like a dungeon and — in P4 — hold creatures
that belong there.

**Nature:** content, plus one seeder change and one safety guard. No creature
types (P4), no map authoring beyond retrofitting existing worlds (P5).

---

## Why this is load-bearing, not decoration

`placeMapCreatures` intersects a world's `allowed_creature_types` with the
**biome's** own `creature_types` list
(`backend/src/services/mapService.js:581`). An empty intersection places
nothing. A dungeon creature therefore cannot spawn in a dungeon until a biome
admits it, and P4's bestiary is inert without this sub-project.

Today there are five biomes, all surface: Meadow, Deep Forest, Arid Dunes,
Frozen Waste, Mire. Every dungeon world declares `["Meadow"]` or
`["Meadow","Mire"]`. **The catacombs are meadows underground.**

## Four constraints discovered before designing

**A tile carries one image, shared by every biome that lists it**
(`backend/src/services/biomePrompt.js:8`). Biomes cannot be differentiated by
reusing `rocks` under a different palette — the Cavern's rocks and the Frozen
Waste's rocks are the same texture. Visual identity requires distinct tiles,
which is what sets the new-tile count at roughly one signature floor per new
biome rather than an arbitrary number.

**The seeder writes no tile `prompt`.** `backend/scripts/seed-catalogs.js`
inserts only `name, color, walkable, speed, image, valid_neighbors`. A tile's
`prompt` is the *base* that biome palette and art style get appended to, so
seeding 30 tiles as-is would leave every one of them generating from palette
alone. The seeder must also carry `render_mode`, `wall_height` and
`place_order`, all of which currently fall to column defaults.

**Impassable terrain inside a biome band already ships.** `Mire` lists
`water`, which is `walkable: false`, so it generates as impassable blobs. That
is precedent for cave walls — and equally, proof that a badly chosen band can
seal a region.

**The sand trap is live and stays undisturbed.** `PATH_NAME_RE` matches
`path|dirt|road|trail|earth|sand` and `detectPathTile` returns the first match
in catalog id order, so `sand` (id 4) is the path tile for every world. New
tiles receive higher ids, and none of the names below match the pattern, so
this holds by construction rather than by luck. `PATH_NAME_RE` and
`detectPathTile` are not touched.

The coastal tile is named `storm_shingle` for exactly this reason — the
obvious `storm_sand` matches the pattern. It would in fact have been harmless
(a higher id never wins the `find`), but a catalog where the rule holds only
because of insertion order is one reordering away from moving every world's
paths. A test asserts no new tile name matches the pattern.

**Existing tiles carry admin-authored prompts that the seed file does not.**
Verified live: `grass` reads "lush green meadow grass", `ice` reads "pale blue
cracked ice", and so on for all eleven terrain tiles — none of which appears
in `DEFAULT_TILE_TYPES`. Adding `prompt = EXCLUDED.prompt` to the seeder's
`ON CONFLICT DO UPDATE` would therefore **wipe every one of them on the next
`make seed-catalogs`**, violating that file's stated rule that a run must
never cost an admin something they authored by hand. The seeder passes NULL
for fields a seed entry omits and `COALESCE`s against the existing row, so
seed values apply only where authored.

---

## Tiles — 30 new

One signature floor per new biome, plus three impassable tiles shared by the
deep biomes. Existing `rocks`, `dirt`, `earth`, `swamp`, `ice`, `snow` are
reused as secondary band members wherever they fit.

| group | tiles |
|---|---|
| Surface (5) | `highland_rock`, `jungle_floor`, `storm_shingle`, `ruin_stone`, `ash_waste` |
| Underground (14) | `cobblestone`, `crypt_floor`, `bone_floor`, `cave_floor`, `fungal_floor`, `ember_rock`, `rime_floor`, `vault_floor`, `hive_floor`, `cistern_shallows`, `umbral_floor`, `crystal_floor`, `blight_floor`, `foundry_floor` |
| Abyssal (8) | `void_floor`, `brimstone`, `chaos_floor`, `sanctum_floor`, `dream_floor`, `titan_floor`, `plague_floor`, `maw_floor` |
| Impassable (3) | `cave_wall`, `rubble`, `chasm` |

Every tile carries `name`, `color`, `walkable`, `speed`, `valid_neighbors`,
and **`prompt`**. `cave_wall` additionally carries a non-zero `wall_height`,
which is what makes it render with height rather than as a flat block.

`color` is chosen deliberately per tile, not filled in: until sprites are
generated these colours *are* the game's appearance.

## Biomes — 27 new

Each carries ordered `terrain_tiles` (**the order is the banding order**),
`palette`, `art_style`, `exclusions`, `color`, and `creature_types: []`.

**Surface (5 new):** Highlands · Verdant Jungle · Storm Coast · Sunken Ruins ·
Ashfields

**Underground (14):** Catacombs · Ossuary · Cavern · Fungal Deep ·
Emberdepths · Frostvault · Deepvault · Hive Warrens · Sunken Cistern ·
Umbral Warren · Crystal Hollows · Blightworks · Gloomfen · Sunken Foundry

**Abyssal (8):** Abyssal Rift · Infernal Gate · Shattered Vault ·
Fallen Sanctum · Dreaming Dark · Titan's Grave · Pestilent Deep · The Maw

### Fauna ships empty

`creature_types: []` on every new biome. P4 fills them as it authors each
creature line.

This is the whole reason the ordering question had an answer: the catalog
holds only Bat, Skeleton, Slime and Wolf, so authoring the intended fauna now
would leave 27 biomes carrying dangling creature references. This repo has
already paid for that once — `STARTER_BIOMES` listing `Wolf` after `Wolf` had
been lost made `make seed-catalogs` rewrite a dangling reference on every run
(`backend/seeds/data/entityTypes.js:15`).

An empty fauna list places no creatures, which is honest: these worlds have
nothing of their own to place yet.

### Impassable terrain, deep biomes only

Shallow biomes band walkable floors only. Impassable members appear in exactly
ten biomes: **Deepvault, Umbral Warren, and the eight abyssal biomes.**

That is an explicit list, not a tier rule. A rule phrased as "tier III and
below" would sweep in Crystal Hollows and Hive Warrens, which this sub-project
places at bands 4–6 — shallow worlds a player meets early, and exactly where
sealed terrain is least acceptable. The list is short enough to state, so it
is stated.

Of those, only Deepvault, Umbral Warren and Abyssal Rift reach a real world in
this sub-project, so the blast radius is three worlds, all guarded.

---

## The navigability guard

A bounded 64×64 dungeon can be **sealed**: an impassable blob over the entry
spawn, or walling a doorway or portal tile off from the rest of the map. You
would find out by walking into it.

`assertNavigable(world, cfg, requiredTiles)` — a new pure function beside the
other generation helpers — flood-fills the walkable interior and returns the
required tiles it could not reach. `applyMapSpec` calls it per world at seed
time and **fails the seed** if the returned list is non-empty.

**Required tiles** are the world's `entry_spawn` when it has one, every
doorway gap, and every portal source and arrival tile the spec declares.

**Where the fill starts** needs saying, because only the entry world has an
`entry_spawn` — every other world's is null. The fill starts from the *first*
required tile and asserts the rest are reachable from it. That is well defined
for every world (each has at least one doorway or portal, or it is
unreachable by construction and the spec's own reachability check already
rejects it), and it is the right question anyway: what matters is not that
some absolute point is walkable but that everything a player can arrive at or
leave through is mutually connected.

If the starting tile is itself impassable, that is a failure too — reported
rather than silently skipped.

4096 tiles is a trivial flood fill, generation is deterministic, and a failure
is a spec bug surfaced at author time rather than a dungeon nobody can enter.

This is the only new logic in P3. It exists because of the decision to band
impassable terrain; without that decision it would be unjustified.

---

## Retrofit — all 20 worlds change terrain

### loop-catacombs — the dungeon loop, entirely underground

| world | from | to |
|---|---|---|
| Catacomb Threshold | Meadow | Catacombs |
| Sealed Mausoleum | Meadow | Catacombs, Ossuary |
| Sunken Eastwing | Meadow, Mire | Sunken Cistern |
| Drowned Southwing | Meadow, Mire | Sunken Cistern, Blightworks |
| Farrow Hall | Mire | Hive Warrens |
| Deepvault Row | Mire | **Deepvault** |
| Frozen Ossuary Heart | Mire, Frozen Waste | Ossuary, Frostvault |

### spine-descent — a descent, so it transitions surface → underground

| world | band | from | to |
|---|---|---|---|
| Old Trailhead | 1–2 | Meadow | Meadow *(entry stays surface)* |
| Windwatch Pass | 2–4 | Meadow, Deep Forest | Meadow, Highlands |
| Hollow Cache | 3–5 | Deep Forest | Cavern |
| Ashfang Den | 4–6 | Deep Forest | Emberdepths |
| Shrikewind Gorge | 4–6 | Deep Forest, Frozen Waste | Cavern, Crystal Hollows |
| Frostbound Shrine | 6–9 | Frozen Waste | Frostvault |
| The Deep Cut | 6–9 | Frozen Waste | **Umbral Warren**, Deepvault |
| Glacier's End | 9–12 | Frozen Waste | Frostvault, **Abyssal Rift** |

### hub-vale — the surface hub keeps its identity, gains variety

Each world keeps its existing biome **first** (so its established banding and
character lead) and gains one new surface biome:

| world | to |
|---|---|
| Vale Crossing *(village)* | Meadow, Highlands |
| Thornbriar Reach | Deep Forest, Verdant Jungle |
| Sunscar Flats | Arid Dunes, Ashfields |
| Rimehollow | Frozen Waste, Sunken Ruins |
| Blackfen Sinks | Mire, Storm Coast |

**Bold** entries are the three worlds receiving impassable terrain.

### 10 biomes ship without a home

Fungal Deep, Gloomfen, Sunken Foundry, and the seven remaining abyssal biomes
reach no world here.

The seven abyssal ones have nowhere to go by construction: their tier sits at
bands 32–50 and the deepest existing world is Glacier's End at 9–12. Fungal
Deep, Gloomfen and Sunken Foundry are shallower but simply have no world among
the current three specs whose character suits them. P5 authors the dungeons
that use all ten. They ship complete and unused, which is the correct state
for a catalog.

## Chunk invalidation

Changing a world's `biomes` changes its terrain, and `world_chunks` caches
generated terrain. `applyMapSpec` currently updates the world row without
touching that cache, so a retrofitted world would serve stale terrain from
88 cached chunks.

`applyMapSpec` therefore deletes `world_chunks` for every world it writes, in
the same transaction. This is safe now in a way it was not before P1: the
`world_chunks` INSERT used to be `activateChunk`'s once-only creature-spawn
flag, and P1 deleted the block it gated, so the table is purely a
deterministic terrain cache. Deleting a row costs a regeneration, nothing
more.

---

## Testing

**Pure unit tests.** `assertNavigable` against a deliberately sealed fixture
(must fail) and an open one (must pass). Biome banding across a new tile set,
asserting the ordered `terrain_tiles` produce bands in that order.

**Catalog integrity, as real tests rather than review discipline:**
- Every biome's `terrain_tiles` name exists in the tile catalog. Dangling
  terrain references are the failure this repo has had before.
- Every biome's `creature_types` is empty — a guard that P3's boundary held,
  and one P4 will delete when it fills them.
- Every new tile has a non-empty `prompt`, so none ships un-generatable.
- No new tile name matches `PATH_NAME_RE`.

**DB-gated.** `make seed-catalogs` is idempotent over the new catalog and does
not disturb existing rows. Seeding each retrofitted spec leaves every world
navigable and its chunks cleared.

**Vacuity to refuse.** A navigability test that passes because the fixture
generated no impassable tiles at all asserts nothing. Every such test must
first assert the generated terrain actually contains the impassable tile.

## Out of scope

- **Creature types and biome fauna** — P4.
- **New worlds and dungeon authoring** — P5. P3 only re-points existing worlds.
- **Sprite generation.** Coding agents cannot generate images. 30 tiles is
  roughly 35 minutes of local generation, and until it runs each new tile
  renders as its chosen flat colour.
- **The tile-job overwrite hazard (SOMET-235)** — generation overwrites a live
  MinIO asset before approval. It bites regeneration of an *existing* texture;
  a brand-new tile has none to destroy. Verify its status before generating
  over anything you care about.
