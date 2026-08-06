# P3 — Tiles & Biomes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 30 new tile types and 27 new biomes, retrofit all 20 existing worlds onto them, and guard against a biome's impassable terrain sealing a dungeon.

**Architecture:** Almost all of this is catalog data in two seed files. Three pieces are not: the seeder's tile upsert grows four columns (preserving admin-authored values rather than stomping them), a new pure `assertNavigable` flood-fills a generated world at seed time, and `applyMapSpec` clears `world_chunks` for worlds whose terrain it changes.

**Tech Stack:** Node.js CommonJS, `pg` (raw SQL), `node:test` + `node:assert`. No migration — tile and biome catalogs are seeded, not migrated.

**Spec:** `docs/superpowers/specs/2026-08-06-p3-tiles-and-biomes-design.md`
**Umbrella:** `docs/superpowers/specs/2026-08-06-bestiary-program-design.md`
**Plane item:** SOMET-247

## Global Constraints

- **No migration.** The reserved range `1714440090000`–`1714440099000` stays unused; tile and biome catalogs are seeded by `make seed-catalogs`, not migrated. If you believe you need a migration, stop and report — it means something has been misunderstood.
- **`make seed-catalogs` must never cost an admin something they authored by hand.** That is the stated rule at the top of `backend/scripts/seed-catalogs.js` and it is load-bearing here: all eleven existing terrain tiles carry prompts in the database that do **not** appear in the seed file.
- **Never mutate the shared dev database destructively.** It holds the developer's real maps. Fixtures are `zz`-prefixed and deleted by name, unconditionally, in a `finally`.
- **Any test calling `applyMapSpec` MUST wrap it in `withEntryPreserved`** (the helper in `backend/tests/seed_map_db.test.js`). Setting `is_entry` clears it on every other world.
- **Do not touch `PATH_NAME_RE` or `detectPathTile`** (`backend/src/services/mapService.js:96,103`). Changing either shifts terrain for every existing world.
- **Biome `terrain_tiles` order is the banding order.** Never reorder an array to "tidy" it.
- **Every new biome ships `creature_types: []`.** Filling them is P4's job.
- **Do not touch** `backend/src/authority/collision.js` or `frontend/src/games/something2/movement.js`.
- **Commit convention:** `<type>(biomes): <summary> (SOMET-247)`.

## File Structure

| file | responsibility |
|---|---|
| `backend/scripts/seed-catalogs.js` | tile upsert grows `prompt`/`render_mode`/`wall_height`/`place_order`, preserving existing values |
| `backend/seeds/data/tileTypes.js` | +30 tile definitions |
| `backend/seeds/data/biomes.js` | +27 biome definitions |
| `backend/src/services/navigability.js` | **new** — `assertNavigable`, pure |
| `backend/scripts/seed-map.js` | calls `assertNavigable`; clears `world_chunks` for worlds it writes |
| `backend/seeds/maps/*.map.json` | the three specs re-pointed onto new biomes |

---

### Task 1: Seeder carries the four extra tile columns

**Files:**
- Modify: `backend/scripts/seed-catalogs.js` (the tile loop, ~line 18)
- Test: `backend/tests/seed_catalogs_db.test.js` (add cases to the existing file)

**Interfaces:**
- Consumes: nothing.
- Produces: `DEFAULT_TILE_TYPES` entries may now carry optional `prompt` (string), `render_mode` (string), `wall_height` (integer), `place_order` (integer). Omitted fields leave the database value untouched.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/seed_catalogs_db.test.js`, following that file's existing DB-gating and fixture conventions:

```js
// The seeder's stated rule is that a run must never cost an admin something
// they authored by hand. Every existing terrain tile carries a prompt in the
// database that is NOT in DEFAULT_TILE_TYPES (verified live: `grass` reads
// "lush green meadow grass"). A naive `prompt = EXCLUDED.prompt` would wipe
// all eleven on the next run.
test('seeding preserves a prompt the seed file does not specify', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await pool.query(
      `INSERT INTO tile_types (name, color, walkable, speed, prompt)
       VALUES ('zzPromptKeep', '#123456', true, 1, 'hand authored prompt')
       ON CONFLICT (name) DO UPDATE SET prompt = EXCLUDED.prompt`);
    // Re-run the seeder over a seed entry that omits `prompt` entirely.
    await seedOneTile(pool, { name: 'zzPromptKeep', color: '#123456', walkable: true, speed: 1, valid_neighbors: [] });
    const r = await pool.query(`SELECT prompt FROM tile_types WHERE name = 'zzPromptKeep'`);
    assert.equal(r.rows[0].prompt, 'hand authored prompt');
  } finally {
    await pool.query(`DELETE FROM tile_types WHERE name LIKE 'zz%'`);
    await pool.end();
  }
});

test('seeding writes a prompt the seed file does specify', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await seedOneTile(pool, {
      name: 'zzPromptWrite', color: '#123456', walkable: true, speed: 1,
      valid_neighbors: [], prompt: 'seeded prompt', wall_height: 48, place_order: 2,
    });
    const r = await pool.query(
      `SELECT prompt, wall_height, place_order FROM tile_types WHERE name = 'zzPromptWrite'`);
    assert.equal(r.rows[0].prompt, 'seeded prompt');
    assert.equal(r.rows[0].wall_height, 48);
    assert.equal(r.rows[0].place_order, 2);
  } finally {
    await pool.query(`DELETE FROM tile_types WHERE name LIKE 'zz%'`);
    await pool.end();
  }
});
```

Export a `seedOneTile(pool, tile)` helper from `seed-catalogs.js` that runs exactly the tile upsert for one entry, so these tests exercise the real statement rather than a copy of it. Add it to that file's `module.exports` beside `seedCatalogs`.

- [ ] **Step 2: Run to verify they fail**

Run: `DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" npm test --prefix backend -- --test-name-pattern="prompt"`
Expected: FAIL — `seedOneTile` is not exported.

- [ ] **Step 3: Rewrite the tile upsert**

Replace the tile loop's query in `backend/scripts/seed-catalogs.js` with:

```js
// COALESCE, not plain EXCLUDED, for the four columns below.
//
// Every existing terrain tile carries a prompt in the database that is NOT in
// DEFAULT_TILE_TYPES -- `grass` reads "lush green meadow grass", and so on for
// all eleven. Those were authored in the admin UI. Writing EXCLUDED
// unconditionally would wipe every one of them on the next `make
// seed-catalogs`, which is precisely what this file's header rule forbids.
//
// So a seed entry that OMITS a field passes NULL and COALESCE keeps whatever
// the row already holds; a seed entry that SPECIFIES one overwrites. New tiles
// (no existing row) fall to the column defaults via the same COALESCE.
async function seedOneTile(db, t) {
  await db.query(
    `INSERT INTO tile_types (name, color, walkable, speed, image, valid_neighbors,
                             prompt, render_mode, wall_height, place_order)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,
             COALESCE($7, ''), COALESCE($8, 'color'), COALESCE($9, 0), COALESCE($10, 0))
     ON CONFLICT (name) DO UPDATE
       SET color = EXCLUDED.color, walkable = EXCLUDED.walkable,
           speed = EXCLUDED.speed, valid_neighbors = EXCLUDED.valid_neighbors,
           prompt = COALESCE($7, tile_types.prompt),
           render_mode = COALESCE($8, tile_types.render_mode),
           wall_height = COALESCE($9, tile_types.wall_height),
           place_order = COALESCE($10, tile_types.place_order)`,
    [t.name, t.color, t.walkable, t.speed, t.image ?? '',
     JSON.stringify(t.valid_neighbors ?? []),
     t.prompt ?? null, t.render_mode ?? null,
     t.wall_height ?? null, t.place_order ?? null],
  );
}
```

Then make the existing loop call it: `for (const t of DEFAULT_TILE_TYPES) { await seedOneTile(pool, t); tiles += 1; }`. Export `seedOneTile`.

- [ ] **Step 4: Run the tests**

Run: `DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" npm test --prefix backend -- --test-name-pattern="prompt|seed_catalogs|catalog"`
Expected: PASS.

- [ ] **Step 5: Prove the live prompts survived**

Run:
```bash
DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" make seed-catalogs
PGPASSWORD=password psql -h 127.0.0.1 -p 15432 -U user -d game_db \
  -c "SELECT name, left(prompt, 24) FROM tile_types WHERE name IN ('grass','ice','swamp') ORDER BY id;"
```
Expected: `grass` still reads `lush green meadow grass`, `ice` `pale blue cracked ice`, `swamp` `murky green swamp mud`. Empty prompts here mean Step 3 is wrong — stop and fix before committing.

- [ ] **Step 6: Commit**

```bash
git add backend/scripts/seed-catalogs.js backend/tests/seed_catalogs_db.test.js
git commit -m "feat(biomes): seed tile prompt, render mode, wall height and place order (SOMET-247)"
```

---

### Task 2: 30 new tile types

**Files:**
- Modify: `backend/seeds/data/tileTypes.js`
- Test: `backend/tests/tile_catalog_integrity.test.js` (new)

**Interfaces:**
- Consumes: the optional `prompt`/`wall_height` fields Task 1 taught the seeder to read.
- Produces: 30 new entries in `DEFAULT_TILE_TYPES`. Later tasks reference these names in biome `terrain_tiles`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/tile_catalog_integrity.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');

// Copied deliberately, not imported: this test's whole job is to fail if the
// catalog ever drifts into the pattern, and importing the live regex would
// make the test follow a change to it rather than catch one.
const PATH_NAME_RE = /path|dirt|road|trail|earth|sand/i;
const ORIGINAL = new Set(['grass', 'highgrass', 'leafs', 'sand', 'rocks', 'earth',
  'dirt', 'snow', 'ice', 'swamp', 'water', 'map_wall', 'map_doorway',
  'wooden_wall', 'village_gate']);
const added = () => DEFAULT_TILE_TYPES.filter((t) => !ORIGINAL.has(t.name));

test('the catalog gained exactly 30 tiles', () => {
  assert.equal(added().length, 30);
  assert.equal(DEFAULT_TILE_TYPES.length, 45);
});

// detectPathTile returns the FIRST PATH_NAME_RE match in catalog id order, so
// `sand` (id 4) is the path tile for every world. A new name matching the
// pattern is harmless only because it sorts later -- one reordering away from
// moving every world's paths. Keep the catalog clean of them.
test('no new tile name matches the path-tile pattern', () => {
  const offenders = added().filter((t) => PATH_NAME_RE.test(t.name));
  assert.deepEqual(offenders.map((t) => t.name), []);
});

test('every new tile carries a non-empty sprite prompt', () => {
  const missing = added().filter((t) => !t.prompt || !t.prompt.trim());
  assert.deepEqual(missing.map((t) => t.name), []);
});

test('every new tile has a colour, since that is its appearance until sprites exist', () => {
  const bad = added().filter((t) => !/^#[0-9a-f]{6}$/i.test(t.color || ''));
  assert.deepEqual(bad.map((t) => t.name), []);
});

test('tile names are unique across the whole catalog', () => {
  const names = DEFAULT_TILE_TYPES.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});

test('exactly three new tiles are impassable, and cave_wall has wall height', () => {
  const blocked = added().filter((t) => t.walkable === false).map((t) => t.name).sort();
  assert.deepEqual(blocked, ['cave_wall', 'chasm', 'rubble']);
  assert.equal(DEFAULT_TILE_TYPES.find((t) => t.name === 'cave_wall').wall_height, 48);
});

test("every tile's valid_neighbors reference tiles that exist", () => {
  const names = new Set(DEFAULT_TILE_TYPES.map((t) => t.name));
  const dangling = [];
  for (const t of DEFAULT_TILE_TYPES) {
    for (const n of t.valid_neighbors ?? []) if (!names.has(n)) dangling.push(`${t.name}->${n}`);
  }
  assert.deepEqual(dangling, []);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test --prefix backend -- --test-name-pattern="catalog gained|path-tile pattern"`
Expected: FAIL — `added().length` is 0, not 30.

- [ ] **Step 3: Append the tiles**

Append to `DEFAULT_TILE_TYPES` in `backend/seeds/data/tileTypes.js`, above the closing `];`:

```js
  // --- P3 (SOMET-247): biome signature floors -----------------------------
  //
  // One signature floor per new biome. A tile carries ONE image shared by
  // every biome that lists it (services/biomePrompt.js), so biomes cannot be
  // told apart by reusing `rocks` under a different palette -- distinct
  // identity requires distinct tiles.
  //
  // `color` is not filler: until sprites are generated locally, these colours
  // ARE the game's appearance.
  //
  // No name here matches PATH_NAME_RE (/path|dirt|road|trail|earth|sand/i).
  // The coastal tile is `storm_shingle`, not the obvious `storm_sand`, for
  // exactly that reason -- see tile_catalog_integrity.test.js.

  // Surface
  { name: 'highland_rock', color: '#7d8471', walkable: true, speed: 0.8, image: '', valid_neighbors: ['highland_rock', 'rocks', 'snow', 'grass'], prompt: 'windswept grey-green highland stone' },
  { name: 'jungle_floor', color: '#1f6b2e', walkable: true, speed: 0.7, image: '', valid_neighbors: ['jungle_floor', 'highgrass', 'leafs', 'swamp'], prompt: 'dense jungle undergrowth and vines' },
  { name: 'storm_shingle', color: '#6b7280', walkable: true, speed: 0.6, image: '', valid_neighbors: ['storm_shingle', 'sand', 'water', 'rocks'], prompt: 'dark wet storm-beaten shore shingle' },
  { name: 'ruin_stone', color: '#8a8577', walkable: true, speed: 0.9, image: '', valid_neighbors: ['ruin_stone', 'rocks', 'earth', 'cobblestone'], prompt: 'cracked weathered ruin flagstones' },
  { name: 'ash_waste', color: '#4a4038', walkable: true, speed: 0.7, image: '', valid_neighbors: ['ash_waste', 'ember_rock', 'rocks', 'dirt'], prompt: 'grey volcanic ash drift' },

  // Underground
  { name: 'cobblestone', color: '#6e6a63', walkable: true, speed: 0.9, image: '', valid_neighbors: ['cobblestone', 'crypt_floor', 'ruin_stone', 'rocks'], prompt: 'worn grey cobblestone paving' },
  { name: 'crypt_floor', color: '#55504a', walkable: true, speed: 0.9, image: '', valid_neighbors: ['crypt_floor', 'cobblestone', 'bone_floor', 'rocks'], prompt: 'cold crypt flagstone floor' },
  { name: 'bone_floor', color: '#c9c2ad', walkable: true, speed: 0.8, image: '', valid_neighbors: ['bone_floor', 'crypt_floor', 'cobblestone'], prompt: 'floor of packed bone fragments' },
  { name: 'cave_floor', color: '#5a5148', walkable: true, speed: 0.9, image: '', valid_neighbors: ['cave_floor', 'rocks', 'dirt', 'cave_wall'], prompt: 'damp brown cave floor stone' },
  { name: 'fungal_floor', color: '#6b7f3a', walkable: true, speed: 0.7, image: '', valid_neighbors: ['fungal_floor', 'swamp', 'dirt', 'blight_floor'], prompt: 'spongy fungal mat floor' },
  { name: 'ember_rock', color: '#7a3b22', walkable: true, speed: 0.8, image: '', valid_neighbors: ['ember_rock', 'ash_waste', 'rocks', 'brimstone'], prompt: 'cracked rock veined with glowing embers' },
  { name: 'rime_floor', color: '#a8c6d6', walkable: true, speed: 0.5, image: '', valid_neighbors: ['rime_floor', 'ice', 'snow', 'rocks'], prompt: 'frost-rimed pale stone floor' },
  { name: 'vault_floor', color: '#4f5560', walkable: true, speed: 1.0, image: '', valid_neighbors: ['vault_floor', 'cobblestone', 'foundry_floor', 'rocks'], prompt: 'riveted iron vault plating' },
  { name: 'hive_floor', color: '#8a6a2f', walkable: true, speed: 0.8, image: '', valid_neighbors: ['hive_floor', 'dirt', 'cave_floor'], prompt: 'waxy amber hive comb floor' },
  { name: 'cistern_shallows', color: '#3f5a63', walkable: true, speed: 0.4, image: '', valid_neighbors: ['cistern_shallows', 'water', 'cobblestone', 'swamp'], prompt: 'shallow standing water over stone' },
  { name: 'umbral_floor', color: '#2e2a35', walkable: true, speed: 0.9, image: '', valid_neighbors: ['umbral_floor', 'cave_floor', 'void_floor', 'rocks'], prompt: 'lightless violet-black stone' },
  { name: 'crystal_floor', color: '#6fa8c9', walkable: true, speed: 0.8, image: '', valid_neighbors: ['crystal_floor', 'ice', 'rocks', 'cave_floor'], prompt: 'pale blue crystal shard floor' },
  { name: 'blight_floor', color: '#5e6b3a', walkable: true, speed: 0.7, image: '', valid_neighbors: ['blight_floor', 'fungal_floor', 'swamp', 'dirt'], prompt: 'sickly blighted crusted ground' },
  { name: 'foundry_floor', color: '#6a5a48', walkable: true, speed: 0.9, image: '', valid_neighbors: ['foundry_floor', 'vault_floor', 'ember_rock', 'rocks'], prompt: 'soot-stained foundry stone' },

  // Abyssal
  { name: 'void_floor', color: '#1c1a24', walkable: true, speed: 0.9, image: '', valid_neighbors: ['void_floor', 'umbral_floor', 'chaos_floor'], prompt: 'starless void-black surface' },
  { name: 'brimstone', color: '#8c3a1e', walkable: true, speed: 0.8, image: '', valid_neighbors: ['brimstone', 'ember_rock', 'ash_waste'], prompt: 'sulphurous brimstone crust' },
  { name: 'chaos_floor', color: '#6b2f6b', walkable: true, speed: 0.9, image: '', valid_neighbors: ['chaos_floor', 'void_floor', 'crystal_floor'], prompt: 'shifting iridescent chaos stone' },
  { name: 'sanctum_floor', color: '#b8a97a', walkable: true, speed: 1.0, image: '', valid_neighbors: ['sanctum_floor', 'cobblestone', 'ruin_stone'], prompt: 'gilded fallen sanctum marble' },
  { name: 'dream_floor', color: '#4a3f6b', walkable: true, speed: 0.9, image: '', valid_neighbors: ['dream_floor', 'void_floor', 'umbral_floor'], prompt: 'hazy indigo dreamlike ground' },
  { name: 'titan_floor', color: '#7a7266', walkable: true, speed: 1.0, image: '', valid_neighbors: ['titan_floor', 'ruin_stone', 'rocks'], prompt: 'colossal weathered titan masonry' },
  { name: 'plague_floor', color: '#6b6b33', walkable: true, speed: 0.7, image: '', valid_neighbors: ['plague_floor', 'blight_floor', 'fungal_floor'], prompt: 'festering plague-slick ground' },
  { name: 'maw_floor', color: '#3d1f22', walkable: true, speed: 0.8, image: '', valid_neighbors: ['maw_floor', 'void_floor', 'brimstone'], prompt: 'raw pulsing flesh-like ground' },

  // Impassable. Banded ONLY by the ten deep biomes (see seeds/data/biomes.js).
  // cave_wall carries wall_height 48 to match map_wall/wooden_wall, which is
  // what makes it render with height rather than as a flat block.
  { name: 'cave_wall', color: '#3a352e', walkable: false, speed: 1.0, image: '', valid_neighbors: ['cave_wall', 'cave_floor', 'rocks'], prompt: 'solid rough cave rock wall', wall_height: 48 },
  { name: 'rubble', color: '#57524a', walkable: false, speed: 1.0, image: '', valid_neighbors: ['rubble', 'cave_floor', 'cobblestone', 'rocks'], prompt: 'impassable heap of collapsed rubble' },
  { name: 'chasm', color: '#14121a', walkable: false, speed: 0, image: '', valid_neighbors: ['chasm', 'cave_floor', 'void_floor'], prompt: 'a black bottomless chasm' },
```

- [ ] **Step 4: Run the tests**

Run: `npm test --prefix backend -- --test-name-pattern="catalog|tile"`
Expected: PASS, including the pre-existing `catalog_seed_data.test.js` which pins this file as a superset of the migrations' tiles.

- [ ] **Step 5: Seed and verify**

Run:
```bash
DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" make seed-catalogs
PGPASSWORD=password psql -h 127.0.0.1 -p 15432 -U user -d game_db \
  -c "SELECT count(*) FROM tile_types;" \
  -c "SELECT name, wall_height FROM tile_types WHERE walkable = false ORDER BY id;"
```
Expected: 45 tiles; the impassable list is `water`, `map_wall`, `wooden_wall`, `cave_wall` (48), `rubble`, `chasm`.

- [ ] **Step 6: Commit**

```bash
git add backend/seeds/data/tileTypes.js backend/tests/tile_catalog_integrity.test.js
git commit -m "feat(biomes): add 30 signature tile types for the new biomes (SOMET-247)"
```

---

### Task 3: `assertNavigable`

**Files:**
- Create: `backend/src/services/navigability.js`
- Test: `backend/tests/navigability.test.js` (new)

**Interfaces:**
- Consumes: `generateRegion(world, rMin, cMin, rows, cols)` and `worldConfig(world)` from `backend/src/services/mapService.js` (both already exported).
- Produces: `assertNavigable(world, requiredTiles) -> string[]` — returns human-readable descriptions of required tiles that could not be reached, empty array when everything is connected. `requiredTiles` is `Array<{ row, col, what }>` where `what` is a label like `'entry spawn'` or `'doorway N'`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/navigability.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { assertNavigable } = require('../src/services/navigability');

const TILE_TYPES = {
  floor: { walkable: true, speed: 1 },
  wall: { walkable: false, speed: 1 },
};
// A 12x12 bounded world whose interior is entirely `floor`.
//
// `biomes` entries are RAW catalog rows -- snake_case `terrain_tiles` /
// `flora_types` / `creature_types` -- exactly what services/biomes.js
// loadBiomes returns. worldConfig's normalizeBiomes is what converts them to
// the camelCase `terrainNames`/`creatureTypes` the generator uses, so a
// fixture written in the camelCase shape would silently band nothing.
const openWorld = () => ({
  seed: 7, chunkSize: 32, tileTypes: TILE_TYPES,
  width: 12, height: 12, doorways: new Set(['N']),
  biomes: [{ name: 'Open', terrain_tiles: ['floor'], flora_types: [], creature_types: [] }],
  biomeCell: 8,
});
// Same, but the biome bands only `wall`, so the interior is solid.
const sealedWorld = () => ({
  ...openWorld(),
  biomes: [{ name: 'Sealed', terrain_tiles: ['wall'], flora_types: [], creature_types: [] }],
});

const REQUIRED = [
  { row: 2, col: 2, what: 'entry spawn' },
  { row: 9, col: 9, what: 'portal source' },
];

test('an open world reports nothing unreachable', () => {
  assert.deepEqual(assertNavigable(openWorld(), REQUIRED), []);
});

// This test must FIRST prove the fixture actually generated impassable
// terrain. "nothing is unreachable" is vacuously true of a world with no
// walls, so a sealed-world test that silently generated an open map would
// pass while asserting nothing.
test('a sealed world reports its required tiles unreachable', () => {
  const { generateRegion } = require('../src/services/mapService');
  const grid = generateRegion(sealedWorld(), 1, 1, 10, 10);
  const names = new Set(grid.flat());
  assert.ok(names.has('wall'), `fixture must generate walls, got ${[...names]}`);

  const unreachable = assertNavigable(sealedWorld(), REQUIRED);
  assert.equal(unreachable.length, 2);
  assert.ok(unreachable.some((m) => m.includes('entry spawn')));
  assert.ok(unreachable.some((m) => m.includes('portal source')));
});

test('a required tile outside the map bounds is reported, not crashed on', () => {
  const out = assertNavigable(openWorld(), [{ row: 99, col: 99, what: 'stray portal' }]);
  assert.equal(out.length, 1);
  assert.ok(out[0].includes('stray portal'));
});

test('no required tiles means nothing to check', () => {
  assert.deepEqual(assertNavigable(openWorld(), []), []);
});

test('an unbounded world is skipped rather than flood-filled', () => {
  const unbounded = { seed: 1, chunkSize: 32, tileTypes: TILE_TYPES };
  assert.deepEqual(assertNavigable(unbounded, REQUIRED), []);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test --prefix backend -- --test-name-pattern="navigab|unreachable|sealed"`
Expected: FAIL — `Cannot find module '../src/services/navigability'`

- [ ] **Step 3: Implement**

Create `backend/src/services/navigability.js`:

```js
// Can a player actually reach everything this world requires?
//
// P3 lets ten deep biomes band impassable terrain (cave_wall / rubble /
// chasm). That makes a new failure possible: a blob over the entry spawn, or
// a doorway walled off from the rest of the interior, produces a dungeon
// nobody can enter -- and the only way to notice is to walk into it.
//
// So seeding checks. Generation is deterministic, and a 64x64 interior is
// ~4000 cells, so this is cheap enough to run per world on every seed.
//
// WHERE THE FILL STARTS. Only the entry world has an `entry_spawn`; every
// other world's is null. So the fill starts from the FIRST required tile and
// asks whether the rest are reachable from it. That is well defined for every
// world, and it is the right question anyway: what matters is not that some
// absolute point is walkable, but that everything a player can arrive at or
// leave through is mutually connected.
const { worldConfig, generateRegion } = require('./mapService');

function assertNavigable(world, requiredTiles) {
  if (!requiredTiles || requiredTiles.length === 0) return [];
  const cfg = worldConfig(world);
  // Unbounded worlds have no interior to seal. P1 made these unreachable via
  // the API, but the check stays total rather than assuming that holds.
  if (!cfg.bounds) return [];
  const { width, height } = cfg.bounds;

  const grid = generateRegion(world, 0, 0, height, width);
  const walkable = (r, c) => {
    if (r < 0 || r >= height || c < 0 || c >= width) return false;
    const def = world.tileTypes && world.tileTypes[grid[r][c]];
    return !(def && def.walkable === false);
  };

  const inBounds = (t) => t.row >= 0 && t.row < height && t.col >= 0 && t.col < width;
  const outside = requiredTiles.filter((t) => !inBounds(t));
  const inside = requiredTiles.filter(inBounds);
  const problems = outside.map((t) => `${t.what} at (${t.row},${t.col}) is outside the map`);
  if (inside.length === 0) return problems;

  // The start must itself be walkable -- reported, never silently skipped,
  // because a spawn buried in rock is the exact failure this guards.
  const start = inside[0];
  if (!walkable(start.row, start.col)) {
    return [...problems, ...inside.map((t) => `${t.what} at (${t.row},${t.col}) is unreachable`)];
  }

  const seen = new Set([`${start.row},${start.col}`]);
  const queue = [[start.row, start.col]];
  while (queue.length) {
    const [r, c] = queue.pop();
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr, nc = c + dc;
      const key = `${nr},${nc}`;
      if (seen.has(key) || !walkable(nr, nc)) continue;
      seen.add(key);
      queue.push([nr, nc]);
    }
  }

  for (const t of inside) {
    if (!seen.has(`${t.row},${t.col}`)) {
      problems.push(`${t.what} at (${t.row},${t.col}) is unreachable`);
    }
  }
  return problems;
}

module.exports = { assertNavigable };
```

- [ ] **Step 4: Run the tests**

Run: `npm test --prefix backend -- --test-name-pattern="navigab|unreachable|sealed|required tile"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/navigability.js backend/tests/navigability.test.js
git commit -m "feat(biomes): add assertNavigable, a seed-time reachability guard (SOMET-247)"
```

---

### Task 4: 27 new biomes

**Files:**
- Modify: `backend/seeds/data/biomes.js`
- Test: `backend/tests/biome_catalog_integrity.test.js` (new)

**Interfaces:**
- Consumes: the tile names added in Task 2.
- Produces: 27 new entries in `STARTER_BIOMES`, each with `creature_types: []`. Task 6 references these biome names from map specs.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/biome_catalog_integrity.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');

const ORIGINAL = new Set(['Meadow', 'Deep Forest', 'Arid Dunes', 'Frozen Waste', 'Mire']);
const added = () => STARTER_BIOMES.filter((b) => !ORIGINAL.has(b.name));

test('the catalog gained exactly 27 biomes', () => {
  assert.equal(added().length, 27);
  assert.equal(STARTER_BIOMES.length, 32);
});

// The failure this repo has already had: STARTER_BIOMES listing a creature
// that no longer existed made `make seed-catalogs` rewrite a dangling
// reference on every run. The same shape applies to terrain.
test("every biome's terrain_tiles exist in the tile catalog", () => {
  const tiles = new Set(DEFAULT_TILE_TYPES.map((t) => t.name));
  const dangling = [];
  for (const b of STARTER_BIOMES) {
    for (const t of b.terrain_tiles) if (!tiles.has(t)) dangling.push(`${b.name}->${t}`);
  }
  assert.deepEqual(dangling, []);
});

// P3's boundary with P4, asserted rather than trusted. P4 deletes this test
// when it fills the lists.
test('every new biome ships with empty fauna for P4 to fill', () => {
  const populated = added().filter((b) => (b.creature_types ?? []).length > 0);
  assert.deepEqual(populated.map((b) => b.name), []);
});

test('every new biome carries palette, art_style, exclusions and a colour', () => {
  for (const b of added()) {
    assert.ok(Array.isArray(b.palette) && b.palette.length >= 2, `${b.name} palette`);
    assert.ok(b.art_style && b.art_style.trim(), `${b.name} art_style`);
    assert.ok(b.exclusions && b.exclusions.trim(), `${b.name} exclusions`);
    assert.ok(/^#[0-9a-f]{6}$/i.test(b.color || ''), `${b.name} color`);
  }
});

test('biome names are unique', () => {
  const names = STARTER_BIOMES.map((b) => b.name);
  assert.equal(new Set(names).size, names.length);
});

// The spec fixes this as an explicit list, deliberately NOT a tier rule: a
// tier rule would sweep in Crystal Hollows and Hive Warrens, which sit at
// bands 4-6 where sealed terrain is least acceptable.
test('exactly ten named biomes band impassable terrain', () => {
  const blocked = new Set(DEFAULT_TILE_TYPES.filter((t) => t.walkable === false).map((t) => t.name));
  const withBlocked = STARTER_BIOMES
    .filter((b) => b.terrain_tiles.some((t) => blocked.has(t)))
    .map((b) => b.name).sort();
  assert.deepEqual(withBlocked, [
    'Abyssal Rift', 'Deepvault', 'Dreaming Dark', 'Fallen Sanctum', 'Infernal Gate',
    'Mire', 'Pestilent Deep', 'Shattered Vault', 'Grave of Titans', 'The Maw',
    'Umbral Warren',
  ].sort());
});
```

Note the assertion includes `Mire` — it bands `water` and always has. That is the pre-existing precedent, not a new biome, and listing it keeps the test honest about what the catalog actually contains.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test --prefix backend -- --test-name-pattern="biome"`
Expected: FAIL — `added().length` is 0, not 27.

- [ ] **Step 3: Append the biomes**

Append to `STARTER_BIOMES` in `backend/seeds/data/biomes.js`, above the closing `];`:

```js
  // --- P3 (SOMET-247): underground, abyssal and new surface biomes --------
  //
  // terrain_tiles ORDER IS THE BANDING ORDER (names[floor(v*len)]). Never
  // reorder one to tidy it -- that rewrites the terrain of every world
  // listing the biome.
  //
  // creature_types is [] on every entry. The catalog holds only Bat,
  // Skeleton, Slime and Wolf, so authoring the intended fauna now would leave
  // 27 biomes carrying dangling creature references -- a failure this repo
  // has already paid for (see seeds/data/entityTypes.js's header). P4 fills
  // them as it authors each creature line.
  //
  // Impassable terrain (cave_wall / rubble / chasm) appears in exactly ten
  // biomes: Deepvault, Umbral Warren and the eight abyssal ones. That is an
  // explicit list, not a tier rule -- a tier rule would sweep in Crystal
  // Hollows and Hive Warrens, which sit at bands 4-6.

  // Surface
  { name: 'Highlands', terrain_tiles: ['highland_rock', 'rocks', 'grass'], flora_types: ['Stone', 'pine_tree'], creature_types: [], palette: ['slate grey', 'moss green', 'pale sky'], art_style: 'windswept highland fantasy, cold clear light', exclusions: 'no sand, no jungle, no lava', color: '#7d8471' },
  { name: 'Verdant Jungle', terrain_tiles: ['jungle_floor', 'highgrass', 'leafs'], flora_types: ['Tree', 'bush', 'rose_bush'], creature_types: [], palette: ['emerald', 'deep jade', 'wet bark'], art_style: 'lush overgrown jungle fantasy, humid filtered light', exclusions: 'no snow, no ice, no sand', color: '#1f6b2e' },
  { name: 'Storm Coast', terrain_tiles: ['storm_shingle', 'sand', 'water'], flora_types: ['Stone', 'dead_tree'], creature_types: [], palette: ['storm grey', 'sea foam', 'wet slate'], art_style: 'wind-lashed coastal fantasy, overcast squall light', exclusions: 'no lava, no jungle, no snow', color: '#6b7280' },
  { name: 'Sunken Ruins', terrain_tiles: ['ruin_stone', 'cobblestone', 'earth'], flora_types: ['Stone', 'dead_tree', 'bush'], creature_types: [], palette: ['weathered limestone', 'lichen green', 'pale dust'], art_style: 'crumbling overgrown ruins, flat ancient light', exclusions: 'no lava, no snow, no jungle', color: '#8a8577' },
  { name: 'Ashfields', terrain_tiles: ['ash_waste', 'ember_rock', 'rocks'], flora_types: ['dead_tree', 'Stone'], creature_types: [], palette: ['ash grey', 'ember orange', 'charcoal'], art_style: 'volcanic ashfall fantasy, dim red-lit haze', exclusions: 'no grass, no water, no snow', color: '#4a4038' },

  // Underground
  { name: 'Catacombs', terrain_tiles: ['cobblestone', 'crypt_floor', 'rocks'], flora_types: ['Stone'], creature_types: [], palette: ['cold stone grey', 'candle amber', 'deep shadow'], art_style: 'claustrophobic catacomb fantasy, torchlit gloom', exclusions: 'no sky, no grass, no daylight', color: '#55504a' },
  { name: 'Ossuary', terrain_tiles: ['bone_floor', 'crypt_floor', 'cobblestone'], flora_types: ['Stone'], creature_types: [], palette: ['bone ivory', 'dried blood', 'ash grey'], art_style: 'bone-stacked ossuary fantasy, cold dim light', exclusions: 'no grass, no daylight, no water', color: '#c9c2ad' },
  { name: 'Cavern', terrain_tiles: ['cave_floor', 'rocks', 'dirt'], flora_types: ['Stone'], creature_types: [], palette: ['damp brown', 'wet grey', 'faint blue glow'], art_style: 'natural cave fantasy, damp echoing dark', exclusions: 'no sky, no grass, no built stone', color: '#5a5148' },
  { name: 'Fungal Deep', terrain_tiles: ['fungal_floor', 'swamp', 'dirt'], flora_types: ['bush', 'Stone'], creature_types: [], palette: ['spore green', 'bruised purple', 'damp umber'], art_style: 'fungal cavern fantasy, bioluminescent murk', exclusions: 'no sky, no fire, no snow', color: '#6b7f3a' },
  { name: 'Emberdepths', terrain_tiles: ['ember_rock', 'ash_waste', 'rocks'], flora_types: ['Stone'], creature_types: [], palette: ['ember orange', 'basalt black', 'smoke'], art_style: 'volcanic underdepth fantasy, glowing molten light', exclusions: 'no water, no ice, no grass', color: '#7a3b22' },
  { name: 'Frostvault', terrain_tiles: ['rime_floor', 'ice', 'snow'], flora_types: ['IceRock'], creature_types: [], palette: ['frost white', 'pale cyan', 'deep blue shadow'], art_style: 'frozen vault fantasy, cold blue underlight', exclusions: 'no fire, no grass, no sand', color: '#a8c6d6' },
  { name: 'Deepvault', terrain_tiles: ['vault_floor', 'cobblestone', 'rubble'], flora_types: ['Stone'], creature_types: [], palette: ['iron grey', 'rust', 'lantern amber'], art_style: 'buried iron vault fantasy, dead still air', exclusions: 'no grass, no sky, no plants', color: '#4f5560' },
  { name: 'Hive Warrens', terrain_tiles: ['hive_floor', 'dirt', 'cave_floor'], flora_types: ['Stone'], creature_types: [], palette: ['amber wax', 'chitin brown', 'sickly gold'], art_style: 'insect hive fantasy, close humming dark', exclusions: 'no sky, no snow, no built stone', color: '#8a6a2f' },
  { name: 'Sunken Cistern', terrain_tiles: ['cistern_shallows', 'cobblestone', 'water'], flora_types: ['Stone'], creature_types: [], palette: ['stagnant green', 'wet stone', 'dim teal'], art_style: 'flooded cistern fantasy, rippling reflected light', exclusions: 'no fire, no grass, no sand', color: '#3f5a63' },
  { name: 'Umbral Warren', terrain_tiles: ['umbral_floor', 'cave_floor', 'cave_wall'], flora_types: ['Stone'], creature_types: [], palette: ['void violet', 'pitch black', 'faint silver'], art_style: 'lightless umbral warren, near-total dark', exclusions: 'no daylight, no grass, no fire', color: '#2e2a35' },
  { name: 'Crystal Hollows', terrain_tiles: ['crystal_floor', 'ice', 'rocks'], flora_types: ['IceRock', 'Stone'], creature_types: [], palette: ['crystal blue', 'prismatic white', 'deep indigo'], art_style: 'crystal cavern fantasy, refracted glow', exclusions: 'no fire, no grass, no mud', color: '#6fa8c9' },
  { name: 'Blightworks', terrain_tiles: ['blight_floor', 'fungal_floor', 'dirt'], flora_types: ['dead_tree', 'Stone'], creature_types: [], palette: ['sickly ochre', 'rot brown', 'pale green'], art_style: 'blighted underworks fantasy, diseased haze', exclusions: 'no clean water, no snow, no daylight', color: '#5e6b3a' },
  { name: 'Gloomfen', terrain_tiles: ['swamp', 'fungal_floor', 'cistern_shallows'], flora_types: ['dead_tree', 'bush'], creature_types: [], palette: ['fen grey', 'drowned green', 'mist white'], art_style: 'subterranean fen fantasy, low drifting mist', exclusions: 'no fire, no sand, no daylight', color: '#4a5a4a' },
  { name: 'Sunken Foundry', terrain_tiles: ['foundry_floor', 'vault_floor', 'ember_rock'], flora_types: ['Stone'], creature_types: [], palette: ['soot black', 'forge orange', 'tarnished bronze'], art_style: 'abandoned deep foundry fantasy, cooling forge light', exclusions: 'no grass, no daylight, no snow', color: '#6a5a48' },

  // Abyssal
  { name: 'Abyssal Rift', terrain_tiles: ['void_floor', 'umbral_floor', 'chasm'], flora_types: [], creature_types: [], palette: ['void black', 'rift violet', 'cold starlight'], art_style: 'abyssal rift fantasy, vertiginous emptiness', exclusions: 'no daylight, no plants, no warmth', color: '#1c1a24' },
  { name: 'Infernal Gate', terrain_tiles: ['brimstone', 'ember_rock', 'chasm'], flora_types: [], creature_types: [], palette: ['hellfire red', 'brimstone yellow', 'charred black'], art_style: 'infernal gateway fantasy, roaring furnace light', exclusions: 'no water, no ice, no plants', color: '#8c3a1e' },
  { name: 'Shattered Vault', terrain_tiles: ['chaos_floor', 'vault_floor', 'rubble'], flora_types: [], creature_types: [], palette: ['fractured violet', 'broken steel', 'arcane sheen'], art_style: 'shattered arcane vault, unstable geometry', exclusions: 'no plants, no daylight, no calm', color: '#6b2f6b' },
  { name: 'Fallen Sanctum', terrain_tiles: ['sanctum_floor', 'cobblestone', 'rubble'], flora_types: [], creature_types: [], palette: ['tarnished gold', 'marble white', 'deep crimson'], art_style: 'defiled holy sanctum, guttering sacred light', exclusions: 'no plants, no daylight, no snow', color: '#b8a97a' },
  { name: 'Dreaming Dark', terrain_tiles: ['dream_floor', 'umbral_floor', 'chasm'], flora_types: [], creature_types: [], palette: ['indigo haze', 'dream silver', 'deep violet'], art_style: 'oneiric dark fantasy, softly impossible space', exclusions: 'no daylight, no hard edges, no fire', color: '#4a3f6b' },
  { name: 'Grave of Titans', terrain_tiles: ['titan_floor', 'ruin_stone', 'rubble'], flora_types: ['Stone'], creature_types: [], palette: ['weathered granite', 'bone grey', 'dust gold'], art_style: 'colossal buried ruin, monumental scale', exclusions: 'no plants, no daylight, no water', color: '#7a7266' },
  { name: 'Pestilent Deep', terrain_tiles: ['plague_floor', 'blight_floor', 'chasm'], flora_types: [], creature_types: [], palette: ['pestilent yellow', 'rot green', 'bile'], art_style: 'plague-choked deep, thick miasmic air', exclusions: 'no clean water, no daylight, no snow', color: '#6b6b33' },
  { name: 'The Maw', terrain_tiles: ['maw_floor', 'void_floor', 'chasm'], flora_types: [], creature_types: [], palette: ['visceral red', 'black bile', 'wet crimson'], art_style: 'living devouring maw, organic horror', exclusions: 'no stone, no daylight, no plants', color: '#3d1f22' },
```

- [ ] **Step 4: Run the tests**

Run: `npm test --prefix backend -- --test-name-pattern="biome"`
Expected: PASS.

- [ ] **Step 5: Seed and verify**

Run:
```bash
DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" make seed-catalogs
PGPASSWORD=password psql -h 127.0.0.1 -p 15432 -U user -d game_db \
  -c "SELECT count(*) FROM biomes;" \
  -c "SELECT name FROM biomes WHERE jsonb_array_length(creature_types) > 0 ORDER BY name;"
```
Expected: 32 biomes; the second query lists only the five original biomes (which keep their fauna) and no new one.

- [ ] **Step 6: Commit**

```bash
git add backend/seeds/data/biomes.js backend/tests/biome_catalog_integrity.test.js
git commit -m "feat(biomes): add 27 underground, abyssal and surface biomes (SOMET-247)"
```

---

### Task 5: Seeding checks navigability and clears stale chunks

**Files:**
- Modify: `backend/scripts/seed-map.js` (`applyMapSpec`)
- Test: `backend/tests/seed_map_db.test.js` (add cases to the existing file)

**Interfaces:**
- Consumes: `assertNavigable(world, requiredTiles) -> string[]` (Task 3); `buildWorldGenConfig({ row, tileTypes, doorways, villages, biomes })` from `backend/src/services/worldGenConfig.js`; `loadTileTypes(db)` from `backend/src/services/tileTypes.js`; `loadBiomes(db, names)` from `backend/src/services/biomes.js`.
- Produces: `applyMapSpec` throws on an unnavigable world and clears `world_chunks` for every world it writes.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/seed_map_db.test.js`:

```js
// Retrofitting a world's biomes changes its terrain, and world_chunks caches
// generated terrain. Without this, a re-pointed world serves stale chunks.
describeDb('seeding clears cached chunks for worlds it writes', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await cleanup(pool);
    await withEntryPreserved(pool, () => applyMapSpec(pool, populationSpec()));
    const ids = await pool.query(
      'SELECT id FROM worlds WHERE name = ANY($1::text[])',
      [populationSpec().worlds.map((w) => w.name)]);
    // Plant a chunk, then re-seed and confirm it is gone.
    await pool.query(
      `INSERT INTO world_chunks (world_id, cx, cy, data) VALUES ($1, 0, 0, '[]'::jsonb)
       ON CONFLICT (world_id, cx, cy) DO NOTHING`, [ids.rows[0].id]);
    const before = await pool.query(
      'SELECT count(*)::int AS n FROM world_chunks WHERE world_id = $1', [ids.rows[0].id]);
    assert.equal(before.rows[0].n, 1, 'fixture must have planted a chunk');

    await withEntryPreserved(pool, () => applyMapSpec(pool, populationSpec()));
    const after = await pool.query(
      'SELECT count(*)::int AS n FROM world_chunks WHERE world_id = $1', [ids.rows[0].id]);
    assert.equal(after.rows[0].n, 0);
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});

// A world whose biome bands nothing but impassable terrain must fail the seed
// rather than ship a dungeon nobody can enter.
describeDb('seeding refuses a world sealed by its own terrain', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await cleanup(pool);
    await pool.query(
      `INSERT INTO biomes (name, terrain_tiles, flora_types, creature_types, palette, art_style, exclusions, color)
       VALUES ('zzSealed', '["cave_wall"]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '', '', '#000000')
       ON CONFLICT (name) DO UPDATE SET terrain_tiles = EXCLUDED.terrain_tiles`);
    const spec = populationSpec();
    spec.worlds.forEach((w) => { w.biomes = ['zzSealed']; });
    await assert.rejects(
      () => withEntryPreserved(pool, () => applyMapSpec(pool, spec)),
      /unreachable|outside the map/,
    );
  } finally {
    await cleanup(pool);
    await pool.query(`DELETE FROM biomes WHERE name = 'zzSealed'`);
    await pool.end();
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" npm test --prefix backend -- --test-name-pattern="clears cached chunks|sealed by its own terrain"`
Expected: FAIL — chunks survive, and the sealed spec seeds without complaint.

- [ ] **Step 3: Wire both into `applyMapSpec`**

Add the imports beside the others in `backend/scripts/seed-map.js`:

```js
const { assertNavigable } = require('../src/services/navigability.js');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig.js');
const { loadTileTypes } = require('../src/services/tileTypes.js');
const { loadBiomes } = require('../src/services/biomes.js');
```

Inside the worlds loop, immediately after the world's `INSERT ... RETURNING id`, clear its chunk cache:

```js
      // Terrain is derived from `biomes`/`seed`/`biome_cell`, and world_chunks
      // caches generated terrain. Re-pointing a world at a new biome without
      // clearing this makes it serve stale chunks forever.
      //
      // Safe to delete unconditionally only since P1 (SOMET-246): that INSERT
      // used to double as activateChunk's once-only creature-spawn flag, and
      // P1 deleted the block it gated. The table is now purely a deterministic
      // cache -- a deleted row costs a regeneration, nothing more.
      await client.query('DELETE FROM world_chunks WHERE world_id = $1', [r.rows[0].id]);
```

Then add a navigability pass **after** the villages loop and **before** the `is_entry` step — villages stamp walls, so checking earlier would miss a village sealing a doorway:

```js
    // Ten biomes band impassable terrain (cave_wall / rubble / chasm). A blob
    // over a spawn, or a doorway walled off from the interior, produces a
    // dungeon nobody can enter -- and walking into it is the only other way to
    // find out. Generation is deterministic, so checking here is exact.
    const tileTypes = await loadTileTypes(client);
    for (const w of spec.worlds) {
      const worldId = idByKey.get(w.key);
      const wr = await client.query('SELECT * FROM worlds WHERE id = $1', [worldId]);
      const row = wr.rows[0];
      const doorways = (await fetchLinks(client, worldId))
        .filter((l) => l.edge !== 'PORTAL').map((l) => l.edge);
      const biomes = await loadBiomes(client, row.biomes);
      const villages = await fetchVillages(client, worldId);
      const cfg = buildWorldGenConfig({ row, tileTypes, doorways, villages, biomes });

      const required = requiredTilesFor(w, spec, row);
      const problems = assertNavigable(cfg, required);
      if (problems.length) {
        throw new Error(
          `world "${w.key}" is not navigable:\n  - ${problems.join('\n  - ')}`);
      }
    }
```

Add the helper above `applyMapSpec`:

```js
// The tiles a world must keep connected: where a player starts, and every way
// in or out. Tile coordinates, not pixels -- CREATURE_TILE_PX is 100.
function requiredTilesFor(w, spec, row) {
  const out = [];
  if (row.entry_spawn && Number.isFinite(row.entry_spawn.x)) {
    out.push({
      row: Math.floor(row.entry_spawn.y / 100),
      col: Math.floor(row.entry_spawn.x / 100),
      what: 'entry spawn',
    });
  }
  // DOORWAY_TILES is 3 and the gap is centred, spanning midCol-1..midCol+1,
  // so the centre column is always inside it.
  const midCol = Math.floor(row.width / 2);
  const midRow = Math.floor(row.height / 2);
  const edges = new Set((spec.links || [])
    .filter((l) => l.kind !== 'portal' && l.from === w.key).map((l) => l.edge));
  for (const e of edges) {
    if (e === 'N') out.push({ row: 0, col: midCol, what: 'doorway N' });
    if (e === 'S') out.push({ row: row.height - 1, col: midCol, what: 'doorway S' });
    if (e === 'W') out.push({ row: midRow, col: 0, what: 'doorway W' });
    if (e === 'E') out.push({ row: midRow, col: row.width - 1, what: 'doorway E' });
  }
  for (const l of (spec.links || [])) {
    if (l.kind !== 'portal') continue;
    if (l.from === w.key) {
      out.push({ row: Math.floor(l.from_y / 100), col: Math.floor(l.from_x / 100), what: `portal source to ${l.to}` });
    }
    if (l.to === w.key) {
      out.push({ row: Math.floor(l.to_y / 100), col: Math.floor(l.to_x / 100), what: `portal arrival from ${l.from}` });
    }
  }
  // A doorway tile is walkable by construction (stampBounds stamps
  // map_doorway on the ring), so it always anchors the fill safely. Ordering
  // matters: assertNavigable starts from the FIRST entry.
  out.sort((a, b) => (a.what.startsWith('doorway') ? -1 : 0) - (b.what.startsWith('doorway') ? -1 : 0));
  return out;
}
```

Note the sort at the end: `assertNavigable` starts its flood fill from the **first** required tile, and a doorway tile is walkable by construction because `stampBounds` stamps `map_doorway` on the ring. Anchoring on a doorway rather than on a spawn that might have generated inside rock is what keeps the guard reporting the real problem instead of failing everything at once.

- [ ] **Step 4: Run the tests**

Run: `DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" npm test --prefix backend -- --test-name-pattern="seed_map|clears cached chunks|sealed"`
Expected: PASS.

- [ ] **Step 5: Re-seed the real specs and confirm nothing breaks yet**

Run:
```bash
for s in hub-vale loop-catacombs spine-descent; do make seed-map SPEC=$s; done
```
Expected: all three succeed. The specs still use the original biomes at this point, so no world can be sealed — this confirms the guard does not produce false positives before Task 6 re-points them.

- [ ] **Step 6: Commit**

```bash
git add backend/scripts/seed-map.js backend/tests/seed_map_db.test.js
git commit -m "feat(biomes): check navigability and clear stale chunks when seeding (SOMET-247)"
```

---

### Task 6: Retrofit the three map specs

**Files:**
- Modify: `backend/seeds/maps/loop-catacombs.map.json`, `spine-descent.map.json`, `hub-vale.map.json`
- Test: `backend/tests/map_spec_fixtures.test.js` (add a case)

**Interfaces:**
- Consumes: the biome names from Task 4; the navigability guard from Task 5.
- Produces: no code interface. All 20 worlds point at new biomes.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/map_spec_fixtures.test.js`:

```js
// P3's whole point: the catacombs were meadows. Every dungeon world must now
// name an underground biome, and no shipped spec may still reference the
// surface biomes underground.
test('every loop-catacombs world uses an underground biome', () => {
  const spec = readSpec('loop-catacombs');
  const surface = new Set(['Meadow', 'Deep Forest', 'Arid Dunes', 'Frozen Waste', 'Mire']);
  const offenders = spec.worlds.filter((w) => (w.biomes || []).some((b) => surface.has(b)));
  assert.deepEqual(offenders.map((w) => w.key), []);
});

test('spine-descent goes underground as it descends', () => {
  const spec = readSpec('spine-descent');
  const byKey = Object.fromEntries(spec.worlds.map((w) => [w.key, w.biomes]));
  assert.deepEqual(byKey.entry, ['Meadow']);            // entry stays surface
  assert.deepEqual(byKey.cache, ['Cavern']);            // underground by band 3-5
  assert.deepEqual(byKey.end, ['Frostvault', 'Abyssal Rift']);
});

// Each hub world keeps its established biome FIRST so its character leads;
// banding order is terrain_tiles order within a biome, but biome order across
// a world's list matters too.
test('hub-vale keeps its original biome first and gains one new surface biome', () => {
  const spec = readSpec('hub-vale');
  const expected = {
    hub: ['Meadow', 'Highlands'],
    forest: ['Deep Forest', 'Verdant Jungle'],
    dunes: ['Arid Dunes', 'Ashfields'],
    frozen: ['Frozen Waste', 'Sunken Ruins'],
    mire: ['Mire', 'Storm Coast'],
  };
  for (const w of spec.worlds) assert.deepEqual(w.biomes, expected[w.key], w.key);
});
```

That file has **no** `readSpec` helper — it reads specs with `fs`/`path` against a `MAPS_DIR` constant it already defines. Add this loader beside its existing helpers and use it:

```js
const readSpec = (name) =>
  JSON.parse(fs.readFileSync(path.join(MAPS_DIR, `${name}.map.json`), 'utf8'));
```

`fs`, `path` and `MAPS_DIR` are all already in scope at the top of that file — do not re-require them.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --prefix backend -- --test-name-pattern="underground biome|descends|hub-vale keeps"`
Expected: FAIL — the specs still name Meadow and Mire.

- [ ] **Step 3: Re-point `loop-catacombs.map.json`**

| key | `biomes` becomes |
|---|---|
| `entry` | `["Catacombs"]` |
| `crypt` | `["Catacombs", "Ossuary"]` |
| `eastwing` | `["Sunken Cistern"]` |
| `southwing` | `["Sunken Cistern", "Blightworks"]` |
| `farhall` | `["Hive Warrens"]` |
| `deepvault` | `["Deepvault"]` |
| `heart` | `["Ossuary", "Frostvault"]` |

- [ ] **Step 4: Re-point `spine-descent.map.json`**

| key | `biomes` becomes |
|---|---|
| `entry` | `["Meadow"]` *(unchanged — the entry stays surface)* |
| `pass` | `["Meadow", "Highlands"]` |
| `cache` | `["Cavern"]` |
| `elite` | `["Emberdepths"]` |
| `gorge` | `["Cavern", "Crystal Hollows"]` |
| `shrine` | `["Frostvault"]` |
| `deep` | `["Umbral Warren", "Deepvault"]` |
| `end` | `["Frostvault", "Abyssal Rift"]` |

- [ ] **Step 5: Re-point `hub-vale.map.json`**

| key | `biomes` becomes |
|---|---|
| `hub` | `["Meadow", "Highlands"]` |
| `forest` | `["Deep Forest", "Verdant Jungle"]` |
| `dunes` | `["Arid Dunes", "Ashfields"]` |
| `frozen` | `["Frozen Waste", "Sunken Ruins"]` |
| `mire` | `["Mire", "Storm Coast"]` |

- [ ] **Step 6: Run the tests**

Run: `npm test --prefix backend -- --test-name-pattern="map_spec|underground|descends|hub-vale"`
Expected: PASS.

- [ ] **Step 7: Seed all three for real — this is where the guard earns its place**

Run:
```bash
for s in hub-vale loop-catacombs spine-descent; do make seed-map SPEC=$s; done
```
Expected: all three succeed. `deep` (Umbral Warren, `cave_wall`), `deepvault` (Deepvault, `rubble`) and `end` (Abyssal Rift, `chasm`) are the three worlds with impassable terrain — if any is sealed, the seed **fails with a named unreachable tile**, which is the guard working. Report the exact failure and adjust that world's biome list rather than weakening the guard.

- [ ] **Step 8: Verify terrain actually changed**

Run:
```bash
PGPASSWORD=password psql -h 127.0.0.1 -p 15432 -U user -d game_db -c "
SELECT w.name, w.biomes, count(wc.id) AS chunks, count(c.id) AS creatures
FROM worlds w
LEFT JOIN world_chunks wc ON wc.world_id = w.id
LEFT JOIN world_creatures c ON c.world_id = w.id
GROUP BY w.id ORDER BY w.name;"
```
Expected: every world names its new biomes, chunk counts are 0 (cleared, regenerating on demand), and creature counts are non-zero — P1's re-seed convergence repopulated them onto the new ground.

- [ ] **Step 9: Commit**

```bash
git add backend/seeds/maps/ backend/tests/map_spec_fixtures.test.js
git commit -m "feat(biomes): re-point all 20 worlds onto the new biomes (SOMET-247)"
```

---

## Verification

```bash
DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" npm test --prefix backend
npm test --prefix frontend
```

Then look at it. Load a dungeon world in the browser and confirm the catacombs read as stone rather than grass — the new tiles render as their chosen flat colours until sprites are generated, so the check is that the *palette* changed, not that it looks finished. `authority_server.test.js`'s "burst beyond the token bucket capacity" test is a known pre-existing timing flake; re-run rather than investigate.

**Sprite queue for the user:** 30 local generations, roughly 35 minutes. Until then every new tile is a flat colour block.
