# P1 — World Population: Design

**Sub-project P1 of the Bestiary Program.** Umbrella:
`docs/superpowers/specs/2026-08-06-bestiary-program-design.md`.

**Goal:** a seeded world arrives populated. One code path places creatures,
used by both seeding and the admin re-roll route, with density authored per
world and hordes expressed as clustered packs.

**Nature:** engineering only. This sub-project adds no creature types, no
biomes and no tiles — it makes population *work*, so that P3–P5's content is
observable when it lands.

---

## Problem

Two defects, one structural.

**Seeding never populates.** `applyMapSpec`
(`backend/scripts/seed-map.js:69`) writes `creature_count` and
`allowed_creature_types` onto the world row and stops. It never calls
`placeMapCreatures`. The only production caller is the admin re-roll route
`POST /api/worlds/:id/creatures` (`backend/src/index.js:1707`), so a seeded
world stays empty until a human re-rolls it by hand, one world at a time.
Live dev database: 11 of 20 worlds hold zero creatures, including every
dungeon world.

**Placement has two implementations and one is unreachable.**
`spawnChunkCreatures` (`backend/src/services/mapService.js:512`) runs per
chunk on activation, gated on `!isBoundedWorld(entry.row)`
(`backend/src/authority/server.js:553`). `isBoundedWorld` is `width &&
height`, and every world in the database is bounded, so that branch has never
run in production. It is a second spawn algorithm — different distribution,
different RNG, different level rolling — kept alive only by its tests.

**Density is not horde-scale.** Authored counts run 2–9 creatures on a 64×64
map: roughly one creature per 500 tiles. The requested "hordes" cannot be
expressed at all, because placement scatters uniformly and has no concept of
a group.

---

## Architecture

### One population path

A new module `backend/src/services/worldPopulation.js` owns orchestration:

```
populateWorld(client, worldRow, { rngSeed }) -> { scattered, packed, total }
```

It reads what it needs on the caller's transaction (`client`, never a fresh
`pool.query`, so it shares the caller's snapshot), deletes the world's
non-guard creatures, resolves density, calls placement, and inserts the rows.

Both callers use it and nothing else:

- `applyMapSpec` (`backend/scripts/seed-map.js`), per world, during seeding
- `POST /api/worlds/:id/creatures` (`backend/src/index.js:1707`), replacing
  its inline placement block

This is the point of the sub-project. Today the re-roll route could not
reproduce what a spec describes even in principle; after P1 the two are the
same code.

**Boundary: `populateWorld` owns hostile creatures only.** Guards are
structural and keep their existing owners — `insertVillageGuards`
(`backend/src/services/villages.js`) and `insertPortalGuards`
(`backend/src/services/dungeonGuards.js`). `populateWorld`'s delete is scoped
to non-guard creatures exactly as the re-roll route's already is, so a
village gate defender and a portal guard both survive a repopulate. The
re-roll route keeps its own guard re-derivation; `applyMapSpec` keeps its
portal-guard pass.

### Placement stays pure

Placement primitives stay in `mapService.js` beside `placeMapCreatures`,
which already owns the private helpers they need (`generateRegion`,
`villageContaining`, `sampleBiomeRegion`, `makeRng`). One new export:

```
placeCreaturePacks(cfg, packSpecs, allowedTypes, rng) -> rows[]
```

The split is: **`mapService` decides where creatures go, `worldPopulation`
decides how many and writes them down.** Both placement functions stay pure
and deterministic given their RNG, which is what keeps them unit-testable
without a database.

Scatter and packs must apply *identical* tile-validity rules — interior,
walkable, not wall or doorway, not inside a village, and admitted by the local
biome's fauna. That is guaranteed by extraction rather than by duplication:
the existing rules come out of `placeMapCreatures` into one shared helper that
both call. Copying the checks into the pack function would let the two drift
the first time either is edited.

### One supporting extraction

`getTileTypesMap` currently lives in `backend/src/index.js:253` and closes
over the module-level `pool`, so `populateWorld` cannot call it without a
circular import. It moves to `backend/src/services/tileTypes.js` as
`loadTileTypes(db)`, taking its connection as a parameter like every other
service here (`loadBiomes`, `fetchVillages`, `fetchLinks`). `index.js` imports
it back. This keeps one definition of what a `tile_types` row becomes, rather
than `populateWorld` growing a second, subtly different query.

---

## Density tiers

A world declares one keyword. It resolves through a single shared table.

| tier | scatter per 1k tiles | packs | pack size |
|---|---|---|---|
| `dead` | 0 | 0 | — |
| `sparse` | 1.5 | 0 | — |
| `normal` | 3 | 1 | 3–4 |
| `dense` | 6 | 2 | 4–6 |
| `horde` | 12 | 4 | 5–8 |
| `swarm` | 24 | 6 | 8–12 |

```
resolveDensity(tier, width, height)
  -> { scatterCount, packCount, packSizeMin, packSizeMax }
```

Pure, no database, unit-tested directly. `scatterCount` is
`round(perThousand * width * height / 1000)`.

On a 64×64 map (4096 tiles): `normal` gives ~12 scattered plus one pack of
3–4; `horde` gives ~49 scattered plus four packs of 5–8, about 75 creatures;
`swarm` gives ~98 scattered plus six packs of 8–12, about 160. Today's worlds
hold 2–9.

Scaling by area rather than a flat count means a 96×96 world is not
accidentally sparser than a 64×64 one at the same tier — a trap the current
absolute `creature_count` walks straight into.

### Relationship to `creature_count`

The `worlds.creature_count` **column** stays. `populateWorld` writes the
resolved scatter count into it as part of its transaction, so the column keeps
meaning "how many scattered creatures this world holds" for the admin UI and
any existing reader. (`resolveDensity` itself remains pure and touches no
database; only `populateWorld` writes.) The density tier is the authored
value, and `creature_count` becomes derived from it.

The `creature_count` **map-spec field** is retired, so there are not two
authored sources for the same number. `validateMapSpec` rejects it inside a
world block with a message pointing at `density`, and P1 removes the field
from the three existing spec files. That is a mechanical deletion, not a
density authoring decision — every world still lands on the `normal` default
until P5 authors real tiers.

---

## Packs

A pack is one type, clustered.

1. **Anchor.** Rejection-sample an interior tile using the same validity rules
   as scatter: strictly inside the wall ring, walkable, not the wall or
   doorway tile, not inside a village, and with a non-empty intersection
   between the world's allowed types and the local biome's fauna.
2. **Type.** Pick one type from the anchor's candidates. Every member is that
   type, so a pack reads as *a pack of ghouls* rather than a mixed bag.
3. **Members.** Place `size - 1` more within a radius of the anchor, same
   validity rules, and additionally requiring the member tile's own biome to
   admit the pack's type — otherwise a pack straddling a biome boundary would
   place a creature the local biome forbids, which is the exact rule scatter
   already enforces per cell.
4. **Radius.** `clamp(ceil(sqrt(size)) + 1, 2, 4)` tiles, so a pack of 12 sits
   in roughly a 5×5 tile footprint and reads as a group on screen rather than
   a thin smear.
5. **Levels.** Each member rolls its own level from the world band via
   `rollCreatureLevel`, exactly as scatter does.

**A short pack is not an error.** If a member cannot be placed within
`maxAttempts`, the pack ships smaller. A crypt whose walkable area is mostly
corridor will hold tighter, smaller packs, and that is a correct outcome
rather than a failure to report.

### Determinism

Population is reproducible from `rngSeed`: same seed, world and catalog gives
the same creatures in the same places.

Scatter and packs draw from **separate streams off that one seed** —
`makeRng(rngSeed)` for scatter, `makeRng(rngSeed ^ PACK_SALT)` for packs.
A single shared stream would be the obvious choice, but pack anchors would
then start from the same draws scatter already consumed and cluster on top of
scattered creatures. Salting a second stream is how this codebase already
separates correlated rolls — `CREATURE_SALT`, `LEVEL_SALT` and
`pathSegmentCells`' direction salts all exist for the same reason.

This mirrors a caution already documented in `placeMapCreatures`: the level
roll consumes an extra draw per creature and shifts the stream for everything
after it. Adding packs shifts it again. Worlds already seeded are unaffected
(creatures persist in `world_creatures`), but a newly seeded or re-rolled
world lays out differently than before P1. That is expected, and is not a
regression to report.

---

## Data model

One migration, in P1's reserved range `1714440070000`–`1714440079000`:

```
ALTER TABLE worlds
  ADD COLUMN density text NOT NULL DEFAULT 'normal'
  CHECK (density IN ('dead','sparse','normal','dense','horde','swarm'));
```

Existing worlds take `normal`. Storing the tier on the row — rather than
resolving it only at seed time — is what lets the admin re-roll route
reproduce the same world the spec describes.

### Map spec

`density` becomes an optional per-world string in
`backend/seeds/maps/*.map.json`, defaulting to `normal` when absent.
`validateMapSpec` (`backend/seeds/mapSpec.js`) rejects any value outside the
six tiers, with the same error shape as its existing checks.

```json
{
  "key": "ossuary",
  "name": "Frozen Ossuary Heart",
  "biomes": ["Meadow"],
  "density": "horde",
  "allowed_creature_types": ["Skeleton", "Bat"],
  "level_min": 9, "level_max": 12
}
```

`applyMapSpec`'s world upsert carries `density` through alongside the columns
it already writes.

**This sub-project does not author densities or level bands.** Choosing which
world is a horde is content work and belongs with P5, which authors map
content against the real bestiary. P1's only edit to the three existing spec
files is deleting the retired `creature_count` field. Every world therefore
lands on the `normal` default — which, unlike today, at least means it gets
creatures.

---

## Re-seed semantics

`make seed-map` **converges a world to its spec**: non-guard creatures are
deleted and re-placed, exactly as the admin re-roll route already does.

The spec stays the single source of truth, so editing a density tier and
re-seeding takes effect. The alternative — populate only when empty — makes a
spec edit silently do nothing, which is a worse trap than the side effect it
avoids.

Side effect, accepted: killed creatures return and survivors move on re-seed.
`seed-map` is a development seeding tool, and `make reseed-map` already wipes
far more than this.

**Transaction shape.** The delete and the re-insert are two dependent writes
and must commit or fail together, on the caller's transaction — the same
requirement the re-roll route already documents (F-007 / SOMET-187). A
failure between them would otherwise leave a world with zero creatures and no
path back except another re-roll.

---

## Retiring the dead spawn path

`spawnChunkCreatures` and its call site are removed, so exactly one algorithm
places creatures.

**Removed:** the function and its export in `mapService.js`; the import and
the `!isBoundedWorld` branch in `authority/server.js:553`; and its tests in
`worldGen.test.js`, `creature_spawn_levels.test.js` and
`authority_creatures_combat.test.js:234`. `guardSpawnPool.test.js` references
it in a comment and needs review for whether its subject survives.
`isBoundedWorld` itself stays — `placeMapCreatures` uses it.

**The guard this requires.** Retiring the fallback means an unbounded world
would hold no creatures, forever, with nothing to notice. That is reachable
today: `POST /api/worlds` (`backend/src/index.js:1428`) rejects width and
height only when one is given without the other, so **both null is currently
accepted**. P1 changes that route to require both. `validateMapSpec` already
requires integer `width` and `height` on every world, so specs are unaffected.

This is a deliberate narrowing of the admin API, and it is what makes the
retirement safe rather than merely tidy.

---

## Testing

**Pure unit tests, no database.** `resolveDensity` for every tier and for
area scaling; `placeCreaturePacks` for clustering (members within radius),
single-type packs, biome-boundary refusal, short-pack tolerance, and
determinism under a fixed seed. These follow `placeMapCreatures.test.js`,
which already establishes the fixture shape.

**Database-gated tests** (the existing `_db.test.js` convention) for
`populateWorld`: a world goes from empty to populated; a repopulate converges
rather than duplicating; guards survive a repopulate; the whole thing rolls
back as one unit on a mid-flight failure.

**Seeding end-to-end:** applying a spec leaves every world with a population
matching its tier. Existing seed tests must keep using `withEntryPreserved`
and name-keyed cleanup — the shared dev database is not to be mutated
destructively, a rule this repo has already been burned by.

### Two vacuous-test shapes to refuse

This repo has a documented history of tests that pass while asserting
nothing. Two are specifically likely here:

- **A pack test that passes because no pack was placed.** Asserting "every
  member is within radius" over an empty array is vacuously true. Every pack
  test must first assert the pack is non-empty and of the expected size.
- **A density test whose expected value is computed from the same constant
  the code reads.** Importing the tier table into the test and recomputing
  `perThousand * area / 1000` asserts arithmetic, not behaviour. Expected
  counts are written as literals.

---

## Out of scope

- **Creature types, biomes and tiles** — P3 and P4.
- **Creature abilities, ranged attacks, aggro behaviour and pack-leader
  buffs** — P2. P1's packs are a *placement* concept only: members are placed
  together and have no runtime relationship whatsoever.
- **Re-authoring existing map specs' densities and level bands** — P5.
- **XP curve retuning.** Populating 20 worlds will move effective XP rates
  sharply. `progressionConstants.js` is explicitly provisional already;
  retuning wants its own pass once content lands.
