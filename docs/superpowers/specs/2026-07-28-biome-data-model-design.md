# Biome Data Model — Design

**Status:** draft for review (from brainstorming, 2026-07-28)

**Sub-project A of 2.** Sub-project B (a map-link graph tab — worlds as draggable
linked circles, add/edit links from a NEW tab without touching the existing
MapsAdmin editor) is deferred until this lands, so its nodes can be tinted by
biome. This spec covers A only.

## Problem / context

The game has **no biome concept**. What the code calls a "biome" is a band of the
terrain-noise field across *every* non-structural tile name in the global tile
catalog:

```js
// mapService.js:113-119 (worldConfig)
const nonStructural = names.filter((n) => !STRUCTURAL_TILES.has(n));
const biomeSource = nonStructural.length > 0 ? nonStructural : names;
const biomeNames = pathTile && biomeSource.length > 1
  ? biomeSource.filter((n) => n !== pathTile)
  : biomeSource;
```

`names` comes from `getTileTypesMap()` — the whole catalog. So every world bands
the same 11 terrain tiles (grass, highgrass, leafs, sand, rocks, earth, dirt,
snow, ice, swamp, water), and **snow sits next to swamp next to sand in every
map**. That is the "maps are frustrating to manage" symptom: there is no data
anywhere saying *this region is a desert and deserts have no ice*.

The same gap shows up three more times:

- **Decorations** (`generateChunkDecorations`) pick from every def whose
  `spawn_tiles` match the terrain — a pine tree can grow on any leafs tile
  anywhere, because nothing scopes flora to a place.
- **Creatures** (`placeMapCreatures`) pick uniformly from
  `worlds.allowed_creature_types` — a per-world allowlist, the closest thing to
  a biome that exists today, but flat across the whole map.
- **Sprite generation** composes a prompt from the catalog row's `base_prompt`
  plus hardcoded styling in `sprite-gen/app/prompts.py`. There is nowhere to say
  "this tile, rendered for the Arid Dunes: ochre and gold, no green".

See [[chunked-world-decorations]], [[map-gen-epic]], [[connected-chunked-world-epic]].

## Goal

Introduce **biomes as first-class data**: named regions that own a terrain
palette, a flora set, a creature set, and an art context. Make the world
generator two-level (biome first, then terrain within that biome) so exclusion
is structural rather than hoped-for, and feed the same records to decoration
placement, creature placement, and sprite-generation prompts.

## Key facts (verified)

- `worldConfig(world)` (mapService.js:109-146) is the single normalizer; both
  the authority and every REST generation path go through it.
- `sampleBiome(cfg, gRow, gCol)` (mapService.js:151-155) is the only terrain
  sampler used by `generateRegion`/`generateChunk` (mapService.js:232). It
  samples `globalValueNoise(cfg.seed, gRow, gCol, cfg.cellSize)` at **absolute**
  world coordinates, which is what makes chunks seamless.
- A second, private banding loop lives inside the legacy `generateWorld`
  (mapService.js:715-727) for the dead hand-authored map system. **Out of scope
  — not touched.**
- `worlds.allowed_creature_types` is a `jsonb notNull default '[]'` array of
  entity-type **names** (migration `1714440027000_bounded_worlds.js:16`), guarded
  against renames at index.js:409. This is the precedent for per-world jsonb
  name-array config.
- Two places build a generator config and must agree field-for-field, or client
  render and server collision diverge (the rubber-banding bug fixed in
  `bea461c`): `GET /api/worlds/:id/chunk` (index.js:1692-1699) and the
  authority's `loadWorld`/`ServerMap` (authority/server.js:361,
  authority/collision.js:85).
- `startGenerationJob(req, res, …)` (index.js:926-949) is the **single** funnel
  for `/api/sprite-jobs`, `/api/entity-jobs` and `/api/tile-jobs`. It forwards
  `req.body.base_prompt` verbatim to sprite-gen, which appends its own hardcoded
  styling (`prompts.py:16-35`). Composing biome art context here reaches all
  three job kinds and requires **no change to the Python service or its image**.
- Admin tabs are a flat `activeTab` switch in `Something2.jsx:647-677` /
  `844-847`; each tab is one component (`TileTypesAdmin`, `EntityTypesAdmin`,
  `ItemTypesAdmin`, `MapsAdmin`).
- `worldGen.test.js`, `worldPreview.test.js` and `biomeExcludesStructural.test.js`
  assert on `cfg.biomeNames` and import `sampleBiome`; the rename below has to
  carry them.

## Architecture

### 1. Data model

New `biomes` catalog table. Serial integer `id`, following `tile_types` /
`entity_types` (not the uuid that `worlds` uses):

| column | type | meaning |
|---|---|---|
| `id` | serial pk | stable ordering key |
| `name` | text unique not null | "Arid Dunes" |
| `terrain_tiles` | jsonb not null default `'[]'` | `tile_types.name` values, in banding order |
| `flora_types` | jsonb not null default `'[]'` | `entity_types.name` values with `is_creature = false` |
| `creature_types` | jsonb not null default `'[]'` | `entity_types.name` values with `is_creature = true` |
| `palette` | jsonb not null default `'[]'` | prompt colour words, e.g. `["ochre","gold","burnt sienna"]` |
| `art_style` | text not null default `''` | e.g. "hand-drawn fantasy, sun-bleached" |
| `exclusions` | text not null default `''` | e.g. "no trees, no grass, no snow" |
| `color` | text not null default `'#888888'` | admin/minimap/graph-node display colour |
| `created_at`, `updated_at` | timestamptz | as elsewhere |

Name arrays, not join tables — matching `spawn_tiles`, `allowed_creature_types`
and `valid_neighbors`. Referential integrity is by convention here, as it
already is for those columns.

New column on `worlds`:

| column | type | meaning |
|---|---|---|
| `biomes` | jsonb not null default `'[]'` | biome **names**, in banding order, that this world may contain |
| `biome_cell` | integer null | noise cell size of the biome field, in tiles; null = derived (§2) |

**`worlds.biomes = []` means "behave exactly as today".** That is the entire
migration story for the 17 existing worlds: the column defaults to empty, the
generator's legacy path is preserved bit-for-bit, no world regenerates, and no
cached `world_chunks` row is invalidated. A world opts in when an admin gives it
a biome set — and *that* is the moment its terrain changes, which is why
assigning biomes to a live world must clear its cached chunks (below).

### 2. Two-level generation

`worldConfig` gains:

- `terrainNames` — **renamed from `biomeNames`**, same derivation, same value.
- `biomes` — the resolved biome records for this world, in `worlds.biomes` order;
  `[]` when the world has none.
- `biomeCell` — the noise cell size of the biome field, in tiles:

  ```js
  const biomeCell = world.biomeCell
    || (world.width && world.height
        ? Math.max(8, Math.floor(Math.min(world.width, world.height) / 3))
        : 24);
  ```

  A world wants roughly `min(width, height) / 3` so each biome gets a visible
  region rather than one biome swallowing the map — so that is the derived
  default when `worlds.biome_cell` is null (the 30×30 entry world gets 10).
  Unbounded worlds have no size to derive from and get 24. An admin can override
  per world.

Sampling becomes two functions:

```js
const BIOME_FIELD_XOR = 0x6a09e667;  // decorrelates the biome field from terrain

// Which biome owns this cell? null when the world declares no biomes.
function sampleBiomeRegion(cfg, gRow, gCol) {
  if (!cfg.biomes.length) return null;
  const v = globalValueNoise((cfg.seed ^ BIOME_FIELD_XOR) >>> 0, gRow, gCol, cfg.biomeCell);
  return cfg.biomes[Math.min(cfg.biomes.length - 1, Math.floor(v * cfg.biomes.length))];
}

// Terrain tile at this cell — renamed from sampleBiome.
function sampleTerrain(cfg, gRow, gCol) {
  const region = sampleBiomeRegion(cfg, gRow, gCol);
  const names = region ? biomeTerrainNames(cfg, region) : cfg.terrainNames;
  const v = globalValueNoise(cfg.seed, gRow, gCol, cfg.cellSize);
  return names[Math.min(names.length - 1, Math.floor(v * names.length))];
}
```

`biomeTerrainNames(cfg, biome)` returns `biome.terrain_tiles` filtered to names
present in `cfg.names`, excluding `STRUCTURAL_TILES` and `cfg.pathTile`, and
**falls back to `cfg.terrainNames` if that filter empties** — a biome referencing
only deleted or structural tiles must not produce `undefined` tile names or crash
generation. Memoized per `(cfg, biome)` so the filter doesn't rerun per tile.

Consequences, stated explicitly:

- With no biomes, `sampleTerrain` samples the **same field with the same seed and
  the same name list** as today. Output is byte-identical. This is the
  back-compat guarantee and it is a test.
- Exclusion is structural: a cell in Arid Dunes can only be assigned a tile in
  Arid Dunes' list. There is no "and also please avoid ice" rule to get wrong.
- Regions are coarse and seamless for the same reason terrain is: absolute-
  coordinate global noise, no per-chunk state.
- The template's "North: connects to <neighbour biome>" no longer describes a
  whole map — a world holds several regions and its edges are world-level links,
  not biome-level. Biome adjacency is decided by the noise, not authored.

### 3. Biome-aware decorations

`generateChunkDecorations` already computes the terrain grid and walks it cell by
cell. It gains one filter: when the world has biomes, a candidate def must also
appear in `sampleBiomeRegion(cfg, gRow, gCol).flora_types`. Everything else — the
density gate, the fill roll, the seeded weighted pick, the blocking exclusions —
is unchanged.

- Empty `flora_types` means **no decorations in that biome**, which is a
  legitimate authored choice (a barren ice field), not a config error to paper
  over with a fallback.
- The function stays pure and is still the single shared source consumed by both
  `/chunk` and the authority, so parity is preserved by construction — *provided*
  both callers pass the same `biomes` (see §6).

### 4. Biome-aware creatures

`placeMapCreatures` (mapService.js:451-485) picks
`allowedTypes[floor(rng() * allowedTypes.length)]` after it has already resolved
the cell's terrain. It gains: when the world has biomes, restrict the candidate
list to `sampleBiomeRegion(cfg, row, col).creature_types ∩ allowedTypes`. If the
intersection is empty, `continue` — the existing `maxAttempts` retry loop rolls
another cell, which is exactly the right behaviour (that biome has no fauna).

`worlds.allowed_creature_types` stays and stays authoritative: biomes *narrow*
it, never widen it. A creature type absent from the world's allowlist never
spawns even if a biome lists it.

### 5. Biome art context for sprite generation

`startGenerationJob` accepts an optional `biome` (name) in the request body. When
present it loads the biome and composes:

```
<base_prompt>, <palette joined with ", "> palette, <art_style>. Avoid: <exclusions>
```

Empty parts are omitted rather than emitted as dangling commas; with no `biome`
the string is `base_prompt` unchanged. The result goes out as `base_prompt`, and
sprite-gen appends its per-kind styling exactly as today. **`prompts.py`, the
sprite-gen container, and the recipe/tier logic are untouched.**

This is the "shared tiles, biome chosen at generation time" decision: one image
per tile row, and the admin picks which biome's art context to compose when
generating it. Composition is a pure function so it is unit-testable without the
service.

### 6. Parity (the load-bearing invariant)

Same rule as the decoration defs, same failure mode if broken: `/chunk` and the
authority must resolve **the same biome records in the same order**.

- One shared loader, `backend/src/services/biomes.js` →
  `loadBiomes(pool, names)`, returning the records **ordered by the caller's
  `names` array** (the world's declared order — not by `id`, because banding
  order is authored). Unknown names are dropped. Imported by both callers; no
  ad-hoc biome query anywhere else.
- Both config builders (index.js `worldCfg`, authority/server.js's `ServerMap`
  config) gain `biomes` and `biomeCell`. A contract test asserts the two configs
  carry identical biome fields for the same world row.

### 7. Admin

- **New "Biomes" tab** in `Something2.jsx` (admin-gated, alongside
  TILE_TYPES/Entity/Items/Maps), component `BiomesAdmin.jsx`: list + create +
  edit + delete, with multi-selects for `terrain_tiles` (from tile types),
  `flora_types` (entity types where `is_creature = false`), `creature_types`
  (entity types where `is_creature = true`), plus palette/art-style/exclusions/
  colour fields. Backed by REST `/api/biomes` CRUD behind `adminGuard`, mirroring
  the tile-types routes.
- **MapsAdmin** gains a per-world biome-set multi-select (writing `worlds.biomes`)
  and a `biome_cell` number input, next to the existing creature-type controls.
- **Saving a world's biome set or `biome_cell` deletes that world's
  `world_chunks` rows and its cached preview**, because terrain for that world
  has just changed. Without this, cached chunks keep serving pre-biome terrain
  while the authority regenerates the new terrain — the exact client/server
  divergence §6 exists to prevent.
- **Rename guard:** renaming a tile or entity type must refuse when a biome still
  references it, extending the check at index.js:409 to `biomes.terrain_tiles` /
  `flora_types` / `creature_types`. Deleting a biome that a world still lists is
  likewise refused.

### 8. Seed data

The migration seeds five starter biomes over the existing catalog (terrain tiles:
grass, highgrass, leafs, sand, rocks, earth, dirt, snow, ice, swamp, water;
decorations: `Tree`, `Stone`, `IceRock`, `bush`, `rose_bush`, `pine_tree`,
`dead_tree`; creatures: `Slime`, `Bat`, `Skeleton`, `Wolf`) so the feature is
usable immediately and the admin has worked examples:

| name | terrain_tiles | flora_types | creature_types | palette | art_style | exclusions | color |
|---|---|---|---|---|---|---|---|
| Meadow | grass, highgrass, earth | bush, rose_bush, Tree, Stone | Slime, Wolf | spring green, wildflower yellow, warm brown | lush hand-drawn fantasy, soft daylight | no snow, no ice, no dead trees | `#5aa84f` |
| Deep Forest | leafs, highgrass, earth | Tree, pine_tree, dead_tree, bush, Stone | Wolf, Bat, Skeleton | deep green, moss, bark brown | dense hand-drawn fantasy, dappled shade | no sand, no snow | `#2f6b3a` |
| Arid Dunes | sand, rocks, dirt | dead_tree, Stone | Skeleton, Bat | ochre, gold, burnt sienna | sun-bleached hand-drawn fantasy, harsh light | no grass, no snow, no ice, no leaves | `#c9a227` |
| Frozen Waste | snow, ice, rocks | IceRock, pine_tree | Bat, Skeleton | pale blue, white, slate grey | cold hand-drawn fantasy, flat overcast light | no grass, no sand, no flowers | `#8fb8d6` |
| Mire | swamp, water, earth | dead_tree, bush, Stone | Slime, Bat | murky olive, peat brown, sickly green | damp hand-drawn fantasy, low misty light | no snow, no ice, no sand | `#4d6b41` |

`Village Guard` is deliberately absent from every biome — guards are structural
(§ Open items 3). **No world is assigned a biome set by the migration** — opting
in is an admin action, per §1.

## Data flow

```
biomes table ──┐
worlds.biomes ─┴─► loadBiomes(pool, names)   [ONE shared loader, world order]
                        │
        ┌───────────────┴────────────────┐
        ▼                                ▼
  authority loadWorld              GET /chunk worldCfg
        │                                │
        └────────────┬───────────────────┘
                     ▼
              worldConfig(world) → { terrainNames, biomes, biomeCell, … }
                     │
     ┌───────────────┼────────────────┬─────────────────────┐
     ▼               ▼                ▼                     ▼
sampleBiomeRegion  sampleTerrain  generateChunkDecorations  placeMapCreatures
 (which biome)     (tile within   (flora ∩ biome)          (fauna ∩ biome
                    biome)                                  ∩ allowlist)

biomes table ──► startGenerationJob(biome) ──► composed base_prompt ──► sprite-gen
```

## Testing

- **Back-compat (highest value):** a world with `biomes: []` produces terrain
  byte-identical to the pre-change generator for a fixed seed — pinned by a
  golden grid captured before the change.
- **Two-level sampler:** deterministic (same seed → same output); a cell's tile
  is always in its biome's `terrain_tiles` (property test over a seeded world —
  this is the exclusion guarantee); regions are coherent, not per-tile confetti
  (adjacent cells usually share a biome); seamless across a chunk boundary (the
  tile at the last column of chunk 0 matches the same absolute coordinate fetched
  as chunk 1's first column).
- **Degenerate biome:** `terrain_tiles` listing only structural/unknown tiles
  falls back to `cfg.terrainNames` and never yields `undefined`.
- **Decorations:** only flora in the cell's biome is placed; a biome with empty
  `flora_types` places nothing; the density/fill/weighted-pick behaviour for a
  biome-less world is unchanged.
- **Creatures:** placements only use types in the cell biome's list ∩ the world
  allowlist; a biome listing a type absent from the allowlist never spawns it.
- **Config parity:** the `/chunk` config and the authority config carry identical
  `biomes` and `biomeCell` for the same world row.
- **Loader:** `loadBiomes` returns records in the requested-name order and drops
  unknown names.
- **Prompt composition:** pure function — with a biome, with no biome, and with
  empty palette/art_style/exclusions (no dangling commas).
- **Admin/API:** biome CRUD round-trips; rename of a referenced tile/entity type
  is refused; deleting a biome a world lists is refused; saving a world's biome
  set clears that world's `world_chunks` rows.
- **Browser (required gate):** assign 2-3 biomes to a test world, walk across a
  region border, confirm terrain reads as distinct places with no excluded tiles
  leaking, decorations match the region, and no rubber-banding at borders.

## Non-goals

- **Biome transitions / adjacency rules** — borders are wherever the noise puts
  them. No blend bands, no "desert may not touch tundra" constraint.
- **Per-biome tile art variants** — one image per tile row (the decision in §5).
- **Auto-assigning biomes to the 17 existing worlds** — opt-in per world.
- **Biome-driven weather, music, lighting, or difficulty.**
- **Reworking the legacy `generateWorld` sampler** (mapService.js:715-727) — that
  system is dead.
- **The map-link graph tab** — sub-project B, its own spec after this lands.

## Open items (confirm during planning)

1. **Preview + minimap colouring.** `biomes.color` exists for sub-project B;
   whether `/preview` and the minimap tint by biome now or later. Proposed:
   later — this spec ships colour as data only.
2. **Plan split.** The nine slices below are one coherent feature but a large
   plan. If it reads as too much for one plan, the natural cut is A–F (data +
   generator, headless and fully testable) and G–I (API + admin + browser).
3. **Guard creatures.** `insertVillageGuards` places `GUARD_TYPE` independently of
   `allowed_creature_types`; confirm guards stay biome-exempt (proposed: yes,
   they are structural, like village walls).

## Suggested slicing (for the plan)

- **A. Schema + loader** — migration (table, `worlds.biomes`, `worlds.biome_cell`,
  seed data) + `services/biomes.js` `loadBiomes` + tests.
- **B. Two-level generator** — rename `biomeNames`→`terrainNames` and
  `sampleBiome`→`sampleTerrain` (carrying the three test files), add
  `sampleBiomeRegion`, `biomeTerrainNames`, back-compat golden test.
- **C. Config wiring + parity** — `biomes`/`biomeCell` into both config builders,
  contract test.
- **D. Biome-aware decorations.**
- **E. Biome-aware creatures.**
- **F. Sprite-gen prompt composition** — optional `biome` on `startGenerationJob`.
- **G. Biome CRUD API + rename/delete guards + chunk-cache invalidation.**
- **H. BiomesAdmin tab + MapsAdmin biome-set control.**
- **I. Browser verification.**
