# Biome Data Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make biomes first-class data — named regions owning a terrain palette, flora, fauna and art context — and drive world generation, decoration placement, creature placement and sprite-generation prompts from them.

**Architecture:** A `biomes` catalog table plus a per-world `worlds.biomes` name array. World generation becomes two-level: a coarse noise field picks which biome owns a cell, a finer noise field picks a terrain tile from *that biome's* list, so exclusion is structural rather than a rule to enforce. A world with an empty biome set generates byte-identically to today, which is the entire migration story for the 17 existing worlds. Client and server agree because one shared loader and one shared config builder feed both the REST `/chunk` path and the authority.

**Tech Stack:** Node 20 CommonJS backend (Express, `pg`, `node-pg-migrate`), `node:test` + `supertest`; React 18 frontend (Vite, styled-components, TanStack Query), `vitest`.

**Spec:** `docs/superpowers/specs/2026-07-28-biome-data-model-design.md` (committed on main as `3bc5273`). Read it if a task's rationale is unclear; the tasks below restate everything you need.

## Global Constraints

- **Back-compat is absolute.** A world whose `biomes` is `[]` must produce terrain **byte-identical** to the pre-change generator for the same seed. Task 3 pins this with a golden fixture captured *before* any generator edit. Never "improve" the legacy sampling path.
- **Client/server parity is load-bearing.** `GET /api/worlds/:id/chunk` and the authority (`backend/src/authority/server.js`) must resolve the same biome records in the same order and build the same generation config. Divergence causes rubber-banding — this exact class of bug was caught in `bea461c`. There must be exactly ONE biome loader and ONE generation-config builder, imported by both.
- **Order is authored, not incidental.** Biome banding order is the order of names in `worlds.biomes`. `loadBiomes(pool, names)` returns records in the caller's `names` order — NOT `ORDER BY id`.
- **Purity.** `worldConfig`, `sampleBiomeRegion`, `sampleTerrain`, `biomeTerrainNames`, `generateChunkDecorations`, `placeMapCreatures` and `composeBiomePrompt` stay pure functions of their arguments. No wall-clock, no unseeded RNG, no I/O.
- **`prompts.py` and the sprite-gen container are NOT modified.** Biome art context is composed backend-side and passed through the existing `base_prompt` field.
- **`worlds.allowed_creature_types` remains authoritative.** Biomes narrow it; they never widen it. A type absent from a world's allowlist never spawns, whatever a biome says.
- **Migration timestamp: `1714440043000`.** The highest existing migration is `1714440042000`. Do not reuse or renumber.
- **Exact seed values** for the five starter biomes are given verbatim in Task 1. Do not invent, reword, or "improve" them — Task 9 and the browser gate depend on those names.
- **Backend tests:** `cd backend && npm test` (`node --test`). **Frontend tests:** `cd frontend && npm test` (`vitest run`). Both suites must be green at every commit.
- Backend source is CommonJS (`require`/`module.exports`); frontend is ESM (`import`/`export`). Do not mix.

---

## File Structure

**Backend — created:**

| File | Responsibility |
|---|---|
| `backend/migrations/1714440043000_biomes.js` | `biomes` table, `worlds.biomes` + `worlds.biome_cell` columns, five starter biomes. Exports `STARTER_BIOMES` for test. |
| `backend/src/services/biomes.js` | `loadBiomes(pool, names)` — the ONE biome query, returned in the caller's name order. |
| `backend/src/services/worldGenConfig.js` | `buildWorldGenConfig({...})` — the ONE generation-config builder, shared by `/chunk` and the authority. |
| `backend/src/services/biomePrompt.js` | `composeBiomePrompt(basePrompt, biome)` — pure prompt composition. |

**Backend — modified:**

| File | Change |
|---|---|
| `backend/src/services/mapService.js` | `biomeNames`→`terrainNames`, `sampleBiome`→`sampleTerrain`, new `sampleBiomeRegion`/`normalizeBiomes`/`biomeCell`; biome filters in `generateChunkDecorations` and `placeMapCreatures`. |
| `backend/src/index.js` | `/chunk` uses the shared builder; `/api/biomes` CRUD; rename/delete guards; world PUT accepts `biomes`/`biome_cell` and wipes chunks on change; `startGenerationJob` accepts `biome`. |
| `backend/src/authority/server.js` | `loadWorld` loads biomes and uses the shared builder. |

**Frontend — created:** `useBiomes.js` (hooks), `biomeForm.js` (pure form helpers), `BiomesAdmin.jsx` (tab component).
**Frontend — modified:** `Something2.jsx` (new tab), `MapsAdmin.jsx` + `useMapsAdmin.js` (per-world biome set + `biome_cell`).

---

### Task 1: Migration + starter biomes

**Files:**
- Create: `backend/migrations/1714440043000_biomes.js`
- Create: `backend/tests/biomes_seed.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: the `biomes` table (`id, name, terrain_tiles, flora_types, creature_types, palette, art_style, exclusions, color, created_at, updated_at`), `worlds.biomes` (jsonb, default `'[]'`), `worlds.biome_cell` (integer, nullable), and `exports.STARTER_BIOMES` — an array of plain objects with exactly the keys `name, terrain_tiles, flora_types, creature_types, palette, art_style, exclusions, color`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/biomes_seed.test.js`. This mirrors the existing `backend/tests/decoration_types_seed.test.js` pattern (assert on the migration's exported data, not on a live DB):

```js
const test = require('node:test');
const assert = require('node:assert');
const { STARTER_BIOMES } = require('../migrations/1714440043000_biomes.js');

// Terrain tile names that exist in the catalog (migrations 1714440002000,
// 1714440027000, 1714440029000). A biome naming a tile outside this set would
// be silently filtered out by worldConfig at runtime and the biome would
// quietly fall back to global terrain — so pin the reference here.
const LIVE_TILES = new Set([
  'grass', 'highgrass', 'leafs', 'sand', 'rocks', 'earth', 'dirt',
  'snow', 'ice', 'swamp', 'water',
]);
// Decoration + creature entity types seeded by migrations 1714440042000 and
// the entity seeds.
const LIVE_FLORA = new Set(['Tree', 'Stone', 'IceRock', 'bush', 'rose_bush', 'pine_tree', 'dead_tree']);
const LIVE_CREATURES = new Set(['Slime', 'Bat', 'Skeleton', 'Wolf']);

test('seeds exactly the five named starter biomes', () => {
  assert.deepEqual(
    STARTER_BIOMES.map((b) => b.name),
    ['Meadow', 'Deep Forest', 'Arid Dunes', 'Frozen Waste', 'Mire'],
  );
});

test('every starter biome is fully populated and references live catalog names', () => {
  for (const b of STARTER_BIOMES) {
    assert.ok(b.terrain_tiles.length >= 2, `${b.name} needs at least 2 terrain tiles`);
    assert.ok(b.flora_types.length >= 1, `${b.name} needs flora`);
    assert.ok(b.creature_types.length >= 1, `${b.name} needs creatures`);
    assert.ok(b.palette.length >= 2, `${b.name} needs a palette`);
    assert.ok(b.art_style.trim().length > 0, `${b.name} needs an art style`);
    assert.ok(b.exclusions.trim().length > 0, `${b.name} needs exclusions`);
    assert.match(b.color, /^#[0-9a-f]{6}$/i, `${b.name} needs a hex color`);
    for (const t of b.terrain_tiles) assert.ok(LIVE_TILES.has(t), `${b.name}: unknown tile ${t}`);
    for (const f of b.flora_types) assert.ok(LIVE_FLORA.has(f), `${b.name}: unknown flora ${f}`);
    for (const c of b.creature_types) assert.ok(LIVE_CREATURES.has(c), `${b.name}: unknown creature ${c}`);
  }
});

test('Village Guard is never a biome creature (guards are structural)', () => {
  for (const b of STARTER_BIOMES) {
    assert.ok(!b.creature_types.includes('Village Guard'), `${b.name} must not list guards`);
  }
});

test('biomes are distinguishable: no two share an identical terrain list', () => {
  const keys = STARTER_BIOMES.map((b) => b.terrain_tiles.join('|'));
  assert.equal(new Set(keys).size, keys.length);
});

test('no seed value embeds a single quote (migrations interpolate these into SQL)', () => {
  for (const b of STARTER_BIOMES) {
    const blob = JSON.stringify(b);
    assert.ok(!blob.includes("'"), `${b.name} must not contain a single quote`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test tests/biomes_seed.test.js`
Expected: FAIL — `Cannot find module '../migrations/1714440043000_biomes.js'`.

- [ ] **Step 3: Write the migration**

Create `backend/migrations/1714440043000_biomes.js`. The `pgm.createTable` shape follows `backend/migrations/1714440002000_create_tile_types.js`; the `pgm.addColumns('worlds', …)` + `ON CONFLICT DO NOTHING` seed loop follows `backend/migrations/1714440027000_bounded_worlds.js`.

```js
exports.shorthands = undefined;

// Starter biomes over the existing catalog. terrain_tiles reference
// tile_types.name and flora/creature_types reference entity_types.name by
// convention, with no FK — the same pattern entity_types.spawn_tiles and
// worlds.allowed_creature_types already use. Values contain no single quotes:
// they are interpolated straight into SQL below (same style as the
// create_tile_types and decoration_types seeds).
//
// NOTE: no world is assigned a biome set here. worlds.biomes defaults to '[]',
// which the generator reads as "band all terrain globally, exactly as before" —
// so every existing world keeps its current terrain and its cached chunks.
const STARTER_BIOMES = [
  {
    name: 'Meadow',
    terrain_tiles: ['grass', 'highgrass', 'earth'],
    flora_types: ['bush', 'rose_bush', 'Tree', 'Stone'],
    creature_types: ['Slime', 'Wolf'],
    palette: ['spring green', 'wildflower yellow', 'warm brown'],
    art_style: 'lush hand-drawn fantasy, soft daylight',
    exclusions: 'no snow, no ice, no dead trees',
    color: '#5aa84f',
  },
  {
    name: 'Deep Forest',
    terrain_tiles: ['leafs', 'highgrass', 'earth'],
    flora_types: ['Tree', 'pine_tree', 'dead_tree', 'bush', 'Stone'],
    creature_types: ['Wolf', 'Bat', 'Skeleton'],
    palette: ['deep green', 'moss', 'bark brown'],
    art_style: 'dense hand-drawn fantasy, dappled shade',
    exclusions: 'no sand, no snow',
    color: '#2f6b3a',
  },
  {
    name: 'Arid Dunes',
    terrain_tiles: ['sand', 'rocks', 'dirt'],
    flora_types: ['dead_tree', 'Stone'],
    creature_types: ['Skeleton', 'Bat'],
    palette: ['ochre', 'gold', 'burnt sienna'],
    art_style: 'sun-bleached hand-drawn fantasy, harsh light',
    exclusions: 'no grass, no snow, no ice, no leaves',
    color: '#c9a227',
  },
  {
    name: 'Frozen Waste',
    terrain_tiles: ['snow', 'ice', 'rocks'],
    flora_types: ['IceRock', 'pine_tree'],
    creature_types: ['Bat', 'Skeleton'],
    palette: ['pale blue', 'white', 'slate grey'],
    art_style: 'cold hand-drawn fantasy, flat overcast light',
    exclusions: 'no grass, no sand, no flowers',
    color: '#8fb8d6',
  },
  {
    name: 'Mire',
    terrain_tiles: ['swamp', 'water', 'earth'],
    flora_types: ['dead_tree', 'bush', 'Stone'],
    creature_types: ['Slime', 'Bat'],
    palette: ['murky olive', 'peat brown', 'sickly green'],
    art_style: 'damp hand-drawn fantasy, low misty light',
    exclusions: 'no snow, no ice, no sand',
    color: '#4d6b41',
  },
];

exports.up = (pgm) => {
  pgm.createTable('biomes', {
    id: 'id',
    name: { type: 'varchar(200)', notNull: true, unique: true },
    terrain_tiles: { type: 'jsonb', notNull: true, default: '[]' },
    flora_types: { type: 'jsonb', notNull: true, default: '[]' },
    creature_types: { type: 'jsonb', notNull: true, default: '[]' },
    palette: { type: 'jsonb', notNull: true, default: '[]' },
    art_style: { type: 'text', notNull: true, default: '' },
    exclusions: { type: 'text', notNull: true, default: '' },
    color: { type: 'varchar(50)', notNull: true, default: '#888888' },
    created_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
  });

  // biomes: the biome NAMES this world may contain, in banding order.
  // biome_cell: noise cell size of the biome field in tiles; null = derived
  // from the world's bounds by worldConfig (see mapService.js).
  pgm.addColumns('worlds', {
    biomes: { type: 'jsonb', notNull: true, default: '[]' },
    biome_cell: { type: 'integer', notNull: false },
  });

  for (const b of STARTER_BIOMES) {
    pgm.sql(`INSERT INTO biomes
      (name, terrain_tiles, flora_types, creature_types, palette, art_style, exclusions, color)
      VALUES ('${b.name}',
        '${JSON.stringify(b.terrain_tiles)}'::jsonb,
        '${JSON.stringify(b.flora_types)}'::jsonb,
        '${JSON.stringify(b.creature_types)}'::jsonb,
        '${JSON.stringify(b.palette)}'::jsonb,
        '${b.art_style}', '${b.exclusions}', '${b.color}')
      ON CONFLICT (name) DO NOTHING`);
  }
};

exports.down = (pgm) => {
  pgm.dropColumns('worlds', ['biomes', 'biome_cell']);
  pgm.dropTable('biomes');
};

exports.STARTER_BIOMES = STARTER_BIOMES;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test tests/biomes_seed.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && npm test`
Expected: all pass. Nothing else reads the new table yet.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/1714440043000_biomes.js backend/tests/biomes_seed.test.js
git commit -m "feat(biomes): biomes table, per-world biome set, five starter biomes"
```

---

### Task 2: Shared biome loader

**Files:**
- Create: `backend/src/services/biomes.js`
- Create: `backend/tests/biomesLoader.test.js`

**Interfaces:**
- Consumes: nothing (takes a `pool`-shaped object with `.query(sql, params)`).
- Produces: `loadBiomes(pool, names) -> Promise<Array<{ id, name, terrain_tiles, flora_types, creature_types, palette, art_style, exclusions, color }>>`, ordered to match `names`, unknown names dropped, `[]` for an empty/non-array `names`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/biomesLoader.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { loadBiomes } = require('../src/services/biomes');

function poolReturning(rows) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return { rows }; },
  };
}

const MEADOW = { id: 1, name: 'Meadow', terrain_tiles: ['grass'], flora_types: [], creature_types: [], palette: [], art_style: '', exclusions: '', color: '#5aa84f' };
const DUNES = { id: 3, name: 'Arid Dunes', terrain_tiles: ['sand'], flora_types: [], creature_types: [], palette: [], art_style: '', exclusions: '', color: '#c9a227' };

test('returns records in the CALLER-supplied name order, not row order', async () => {
  // Postgres hands rows back in whatever order it likes; the world's declared
  // biome order is what decides banding, so the loader must reorder. Rows are
  // deliberately returned id-ascending while the caller asks for the reverse.
  const pool = poolReturning([MEADOW, DUNES]);
  const out = await loadBiomes(pool, ['Arid Dunes', 'Meadow']);
  assert.deepEqual(out.map((b) => b.name), ['Arid Dunes', 'Meadow']);
});

test('drops names with no matching row', async () => {
  const pool = poolReturning([MEADOW]);
  const out = await loadBiomes(pool, ['Meadow', 'Atlantis']);
  assert.deepEqual(out.map((b) => b.name), ['Meadow']);
});

test('de-duplicates repeated names', async () => {
  const pool = poolReturning([MEADOW]);
  const out = await loadBiomes(pool, ['Meadow', 'Meadow']);
  assert.deepEqual(out.map((b) => b.name), ['Meadow']);
});

test('short-circuits without querying when there are no names', async () => {
  const pool = poolReturning([MEADOW]);
  assert.deepEqual(await loadBiomes(pool, []), []);
  assert.deepEqual(await loadBiomes(pool, null), []);
  assert.deepEqual(await loadBiomes(pool, undefined), []);
  assert.equal(pool.calls.length, 0, 'must not hit the DB for an empty biome set');
});

test('parameterises the name list (no interpolation)', async () => {
  const pool = poolReturning([MEADOW]);
  await loadBiomes(pool, ['Meadow']);
  assert.equal(pool.calls.length, 1);
  assert.deepEqual(pool.calls[0].params, [['Meadow']]);
  assert.ok(!pool.calls[0].sql.includes('Meadow'), 'name must not be interpolated into SQL');
});

test('selects every column the generator and prompt composer need', async () => {
  const pool = poolReturning([MEADOW]);
  await loadBiomes(pool, ['Meadow']);
  const { sql } = pool.calls[0];
  for (const col of ['name', 'terrain_tiles', 'flora_types', 'creature_types', 'palette', 'art_style', 'exclusions', 'color']) {
    assert.match(sql, new RegExp(`\\b${col}\\b`), `SELECT must include ${col}`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test tests/biomesLoader.test.js`
Expected: FAIL — `Cannot find module '../src/services/biomes'`.

- [ ] **Step 3: Write the loader**

Create `backend/src/services/biomes.js`:

```js
// Shared biome loader. Both the REST /chunk preview (index.js) and the
// authority's world load (authority/server.js) resolve a world's biome set
// through THIS function, for the same reason services/decorationDefs.js
// exists: the two must agree exactly, or the client renders terrain the
// server doesn't have and the player rubber-bands.
//
// Ordering is the subtle part. decorationDefs sorts by id because nothing
// authors that order; here the order IS authored -- worlds.biomes is the
// banding order, so biome i owns noise band i. Postgres returns rows in
// whatever order it likes, so the rows are re-sorted into the caller's name
// order here rather than trusted as they arrive.
async function loadBiomes(pool, names) {
  if (!Array.isArray(names) || names.length === 0) return [];
  const wanted = [];
  const seen = new Set();
  for (const n of names) {
    if (typeof n === 'string' && !seen.has(n)) { seen.add(n); wanted.push(n); }
  }
  if (wanted.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT id, name, terrain_tiles, flora_types, creature_types,
            palette, art_style, exclusions, color
       FROM biomes
      WHERE name = ANY($1::text[])`,
    [wanted],
  );
  const byName = new Map(rows.map((r) => [r.name, r]));
  return wanted.map((n) => byName.get(n)).filter(Boolean);
}

module.exports = { loadBiomes };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test tests/biomesLoader.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/biomes.js backend/tests/biomesLoader.test.js
git commit -m "feat(biomes): one shared loader, ordered by the world's declared biome order"
```

---

### Task 3: Two-level generator

**Files:**
- Modify: `backend/src/services/mapService.js` (`worldConfig` ~109-146, `sampleBiome` ~151-155, `generateRegion` ~232, `module.exports` ~820-850)
- Create: `backend/tests/fixtures/terrain-golden-preBiome.json`
- Create: `backend/tests/biomeSampler.test.js`
- Modify: `backend/tests/worldGen.test.js:50,61`, `backend/tests/worldPreview.test.js:18`, `backend/tests/biomeExcludesStructural.test.js` (all of it — the file's subject is renamed)

**Interfaces:**
- Consumes: `loadBiomes`'s row shape from Task 2 (`{ name, terrain_tiles, flora_types, creature_types, … }`) — passed in as `world.biomes`.
- Produces:
  - `worldConfig(world)` gains `terrainNames` (**renamed from `biomeNames`**, identical derivation), `biomes` (normalized records — see below), `biomeCell` (number).
  - Normalized biome record: `{ name: string, terrainNames: string[], floraTypes: string[], creatureTypes: string[] }`.
  - `sampleBiomeRegion(cfg, gRow, gCol) -> normalized biome record | null`.
  - `sampleTerrain(cfg, gRow, gCol) -> string` (**renamed from `sampleBiome`**).
  - Both are added to `module.exports`; `sampleBiome` and `cfg.biomeNames` are **removed** (no aliases — a stale alias is how the two names drift).

- [ ] **Step 1: Capture the back-compat golden fixture BEFORE touching the generator**

This must run against the *current, unmodified* `mapService.js`. If you have already edited it, `git stash` first.

```bash
cd backend && node -e "
const { generateRegion } = require('./src/services/mapService');
const world = {
  seed: 12345, chunkSize: 8, cellSize: 8,
  tileTypes: {
    grass: { walkable: true, speed: 1 },
    sand: { walkable: true, speed: 1 },
    snow: { walkable: true, speed: 1 },
    water: { walkable: false, speed: 1 },
  },
};
process.stdout.write(JSON.stringify({
  world,
  grid: generateRegion(world, 0, 0, 24, 24),
}, null, 2));
" > tests/fixtures/terrain-golden-preBiome.json
```

Then sanity-check it is non-trivial:

```bash
cd backend && node -e "
const g = require('./tests/fixtures/terrain-golden-preBiome.json').grid;
const names = new Set(g.flat());
console.log('rows', g.length, 'distinct tiles', [...names].sort().join(','));
"
```

Expected: `rows 24` and **at least two** distinct tile names. If only one name appears the fixture proves nothing — stop and report BLOCKED rather than continuing with a vacuous golden.

- [ ] **Step 2: Write the failing tests**

Create `backend/tests/biomeSampler.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const {
  worldConfig, sampleBiomeRegion, sampleTerrain, generateRegion,
} = require('../src/services/mapService');
const GOLDEN = require('./fixtures/terrain-golden-preBiome.json');

// Raw biome records in the shape services/biomes.js returns.
const DUNES = {
  name: 'Arid Dunes', terrain_tiles: ['sand', 'rocks'],
  flora_types: ['dead_tree'], creature_types: ['Skeleton'],
};
const WASTE = {
  name: 'Frozen Waste', terrain_tiles: ['snow', 'ice'],
  flora_types: ['IceRock'], creature_types: ['Bat'],
};

const TILE_TYPES = {
  grass: { walkable: true, speed: 1 },
  sand: { walkable: true, speed: 1 },
  rocks: { walkable: true, speed: 1 },
  snow: { walkable: true, speed: 1 },
  ice: { walkable: true, speed: 1 },
  map_wall: { walkable: false, speed: 1 },
};

function biomeWorld(over = {}) {
  return {
    seed: 4242, chunkSize: 16, cellSize: 8, pathTile: null,
    tileTypes: TILE_TYPES, biomes: [DUNES, WASTE], biomeCell: 12,
    ...over,
  };
}

test('BACK-COMPAT: a world with no biomes generates byte-identically to before', () => {
  // The fixture was produced by the pre-biome generator. Any change to the
  // legacy sampling path shows up here.
  const grid = generateRegion(GOLDEN.world, 0, 0, GOLDEN.grid.length, GOLDEN.grid[0].length);
  assert.deepEqual(grid, GOLDEN.grid);
});

test('worldConfig exposes terrainNames (biomeNames is gone)', () => {
  const cfg = worldConfig(biomeWorld({ biomes: [] }));
  assert.ok(Array.isArray(cfg.terrainNames));
  assert.ok(cfg.terrainNames.includes('grass'));
  assert.equal(cfg.biomeNames, undefined, 'the old name must not linger as an alias');
});

test('worldConfig normalizes biome records and filters their terrain lists', () => {
  const cfg = worldConfig(biomeWorld({
    biomes: [{ ...DUNES, terrain_tiles: ['sand', 'map_wall', 'atlantis'] }],
  }));
  assert.equal(cfg.biomes.length, 1);
  assert.deepEqual(cfg.biomes[0].terrainNames, ['sand'],
    'structural and unknown tiles are dropped');
  assert.deepEqual(cfg.biomes[0].floraTypes, ['dead_tree']);
  assert.deepEqual(cfg.biomes[0].creatureTypes, ['Skeleton']);
});

test('worldConfig drops the path tile from a biome terrain list', () => {
  const cfg = worldConfig(biomeWorld({
    pathTile: 'sand', biomes: [{ ...DUNES, terrain_tiles: ['sand', 'rocks'] }],
  }));
  assert.deepEqual(cfg.biomes[0].terrainNames, ['rocks']);
});

test('EXCLUSION: every generated tile belongs to the biome that owns its cell', () => {
  const world = biomeWorld();
  const cfg = worldConfig(world);
  const grid = generateRegion(world, 0, 0, 48, 48);
  let checked = 0;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const region = sampleBiomeRegion(cfg, r, c);
      assert.ok(region, 'a world with biomes must always resolve a region');
      assert.ok(region.terrainNames.includes(grid[r][c]),
        `tile ${grid[r][c]} at (${r},${c}) is not in ${region.name}`);
      checked++;
    }
  }
  assert.equal(checked, 48 * 48);
});

test('EXCLUSION is real: both biomes actually occur in the sampled window', () => {
  // Without this, the test above would pass trivially if one biome swallowed
  // the whole window.
  const cfg = worldConfig(biomeWorld());
  const seen = new Set();
  for (let r = 0; r < 48; r++) for (let c = 0; c < 48; c++) seen.add(sampleBiomeRegion(cfg, r, c).name);
  assert.deepEqual([...seen].sort(), ['Arid Dunes', 'Frozen Waste']);
});

test('regions are coherent, not per-tile confetti', () => {
  const cfg = worldConfig(biomeWorld());
  let same = 0, total = 0;
  for (let r = 0; r < 48; r++) {
    for (let c = 0; c < 47; c++) {
      if (sampleBiomeRegion(cfg, r, c).name === sampleBiomeRegion(cfg, r, c + 1).name) same++;
      total++;
    }
  }
  assert.ok(same / total > 0.9, `horizontal neighbours agree only ${(same / total * 100).toFixed(1)}% of the time`);
});

test('seamless: the same absolute cell samples identically from any window', () => {
  const world = biomeWorld();
  const cfg = worldConfig(world);
  // Absolute cell (20, 31), reached from two different generation windows.
  const fromA = generateRegion(world, 16, 16, 16, 16)[4][15];
  const fromB = generateRegion(world, 20, 31, 1, 1)[0][0];
  assert.equal(fromA, fromB);
  assert.equal(sampleTerrain(cfg, 20, 31), fromA);
});

test('deterministic: same seed, same output; different seed, different output', () => {
  const a = generateRegion(biomeWorld(), 0, 0, 16, 16);
  const b = generateRegion(biomeWorld(), 0, 0, 16, 16);
  assert.deepEqual(a, b);
  const c = generateRegion(biomeWorld({ seed: 999 }), 0, 0, 16, 16);
  assert.notDeepEqual(a, c);
});

test('DEGENERATE: a biome whose tiles are all unknown falls back to global terrain', () => {
  const world = biomeWorld({ biomes: [{ name: 'Void', terrain_tiles: ['nope', 'map_wall'], flora_types: [], creature_types: [] }] });
  const cfg = worldConfig(world);
  const grid = generateRegion(world, 0, 0, 8, 8);
  for (const row of grid) {
    for (const t of row) {
      assert.ok(typeof t === 'string' && t.length > 0, 'never undefined');
      assert.ok(cfg.terrainNames.includes(t), `${t} should come from the global fallback list`);
    }
  }
});

test('sampleBiomeRegion returns null when the world declares no biomes', () => {
  const cfg = worldConfig(biomeWorld({ biomes: [] }));
  assert.equal(sampleBiomeRegion(cfg, 3, 7), null);
});

test('biomeCell: explicit value wins', () => {
  assert.equal(worldConfig(biomeWorld({ biomeCell: 17 })).biomeCell, 17);
});

test('biomeCell: derived from bounds when null, so a small world still shows regions', () => {
  const cfg = worldConfig(biomeWorld({ biomeCell: null, width: 30, height: 30 }));
  assert.equal(cfg.biomeCell, 10); // floor(min(30,30)/3)
});

test('biomeCell: derived value never drops below 8', () => {
  const cfg = worldConfig(biomeWorld({ biomeCell: null, width: 12, height: 9 }));
  assert.equal(cfg.biomeCell, 8);
});

test('biomeCell: unbounded worlds fall back to 24', () => {
  const cfg = worldConfig(biomeWorld({ biomeCell: null }));
  assert.equal(cfg.biomeCell, 24);
});

test('the biome field is decorrelated from the terrain field', () => {
  // If both fields used the same seed, region borders would sit exactly on
  // terrain-band borders and the two-level sampler would collapse to one level.
  const cfg = worldConfig(biomeWorld({ biomeCell: 8 })); // same cell size as terrain
  let agree = 0, total = 0;
  for (let r = 0; r < 40; r++) {
    for (let c = 0; c < 40; c++) {
      const regionIdx = cfg.biomes.indexOf(sampleBiomeRegion(cfg, r, c));
      const tile = sampleTerrain(cfg, r, c);
      const tileIdx = cfg.biomes[regionIdx].terrainNames.indexOf(tile);
      if (regionIdx === tileIdx) agree++;
      total++;
    }
  }
  assert.ok(agree / total < 0.95, 'biome and terrain fields look like the same field');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && node --test tests/biomeSampler.test.js`
Expected: FAIL — `sampleBiomeRegion is not a function` (and the back-compat test PASSES, since the generator is still unmodified — that is the point of capturing the golden first).

- [ ] **Step 4: Rewrite `worldConfig` in `backend/src/services/mapService.js`**

Replace the existing `worldConfig` function (currently at ~line 109) with:

```js
// A biome's terrain list, reduced to tiles this world can actually place:
// present in the catalog, not a structural overlay tile, not the path tile.
// A biome that filters down to nothing (references only deleted or structural
// tiles) must not yield `undefined` tile names, so callers fall back to the
// global list — see sampleTerrain.
function biomeTerrainNames(biome, names, pathTile) {
  return (biome.terrain_tiles || []).filter(
    (n) => names.includes(n) && !STRUCTURAL_TILES.has(n) && n !== pathTile,
  );
}

// Normalize raw biome rows (services/biomes.js shape) into the compact records
// the samplers use. Done once per worldConfig call rather than per tile.
function normalizeBiomes(rawBiomes, names, pathTile) {
  if (!Array.isArray(rawBiomes)) return [];
  return rawBiomes
    .filter((b) => b && typeof b.name === 'string')
    .map((b) => ({
      name: b.name,
      terrainNames: biomeTerrainNames(b, names, pathTile),
      floraTypes: Array.isArray(b.flora_types) ? b.flora_types : [],
      creatureTypes: Array.isArray(b.creature_types) ? b.creature_types : [],
    }));
}

// Biome-field noise cell size, in tiles. A world wants roughly
// min(width, height) / 3 so each biome gets a visible region instead of one
// biome swallowing the map; that is the derived default when the world does
// not pin `biomeCell`. Unbounded worlds have no size to derive from.
const DEFAULT_BIOME_CELL = 24;
function resolveBiomeCell(world) {
  if (Number.isFinite(world.biomeCell) && world.biomeCell > 0) return Math.floor(world.biomeCell);
  if (world.width && world.height) {
    return Math.max(8, Math.floor(Math.min(world.width, world.height) / 3));
  }
  return DEFAULT_BIOME_CELL;
}

// Normalize a world config, applying defaults and deriving name lists. Throws
// on empty tileTypes (a world must have at least one tile).
function worldConfig(world = {}) {
  const tileTypes = world.tileTypes || {};
  const names = Object.keys(tileTypes);
  if (names.length === 0) throw new Error('worldConfig: tileTypes is empty');
  const pathTile = world.pathTile !== undefined
    ? world.pathTile
    : detectPathTile(names);
  const nonStructural = names.filter((n) => !STRUCTURAL_TILES.has(n));
  const biomeSource = nonStructural.length > 0 ? nonStructural : names;
  const terrainNames = pathTile && biomeSource.length > 1
    ? biomeSource.filter((n) => n !== pathTile)
    : biomeSource;
  return {
    seed: world.seed || 0,
    chunkSize: world.chunkSize || 64,
    cellSize: world.cellSize || 8,
    pathCell: world.pathCell || 24,
    pathJitter: world.pathJitter || 6,
    pathTile,
    names,
    terrainNames,
    biomes: normalizeBiomes(world.biomes, names, pathTile),
    biomeCell: resolveBiomeCell(world),
    bounds: (world.width && world.height) ? {
      width: world.width,
      height: world.height,
      wallTile: world.wallTile || 'map_wall',
      doorwayTile: world.doorwayTile || 'map_doorway',
      doorways: world.doorways instanceof Set ? world.doorways : new Set(world.doorways || []),
    } : null,
    villages: Array.isArray(world.villages) && world.villages.length
      ? world.villages.map((v) => ({
          id: v.id,
          minRow: v.minRow, minCol: v.minCol,
          width: v.width, height: v.height,
          gateEdge: v.gateEdge,
          spawnX: v.spawnX, spawnY: v.spawnY,
          wallTile: 'wooden_wall', gateTile: 'village_gate',
        }))
      : null,
  };
}
```

- [ ] **Step 5: Replace `sampleBiome` with the two-level samplers**

Replace the existing `sampleBiome` function (currently at ~line 151, including its comment) with:

```js
// Decorrelates the biome field from the terrain field. Sharing a seed would
// put every region border exactly on a terrain-band border and collapse the
// two-level sampler back into one level.
const BIOME_FIELD_XOR = 0x6a09e667;

// Which biome owns this absolute cell, or null when the world declares none.
// Coarse global noise (biomeCell >> cellSize), so regions read as places and
// stay continuous across chunk borders for the same reason terrain does.
function sampleBiomeRegion(cfg, gRow, gCol) {
  if (cfg.biomes.length === 0) return null;
  const v = globalValueNoise((cfg.seed ^ BIOME_FIELD_XOR) >>> 0, gRow, gCol, cfg.biomeCell);
  return cfg.biomes[Math.min(cfg.biomes.length - 1, Math.floor(v * cfg.biomes.length))];
}

// Terrain tile name at absolute world coords: band the global terrain noise
// across the names available AT THIS CELL -- the owning biome's list when the
// world has biomes, else every non-structural tile (the pre-biome behaviour,
// preserved bit-for-bit: same seed, same field, same name list). A biome whose
// list filtered down to nothing falls back to the global list rather than
// producing undefined tiles. The path tile is excluded from both lists --
// paths are stamped separately.
function sampleTerrain(cfg, gRow, gCol) {
  const region = sampleBiomeRegion(cfg, gRow, gCol);
  const names = (region && region.terrainNames.length) ? region.terrainNames : cfg.terrainNames;
  const v = globalValueNoise(cfg.seed, gRow, gCol, cfg.cellSize);
  return names[Math.min(names.length - 1, Math.floor(v * names.length))];
}
```

- [ ] **Step 6: Update the single call site and the exports**

In `generateRegion` (~line 232) change `: sampleBiome(cfg, gRow, gCol);` to `: sampleTerrain(cfg, gRow, gCol);`.

In `module.exports` (~line 834) replace `sampleBiome,` with:

```js
    sampleTerrain,
    sampleBiomeRegion,
    biomeTerrainNames,
```

Leave the private banding loop inside the legacy `generateWorld` (~lines 715-727) completely alone — it serves the dead hand-authored map system and its `biomeNames` is a local variable, not the config field.

- [ ] **Step 7: Carry the rename through the three existing tests**

- `backend/tests/worldGen.test.js:50` — change the imported `sampleBiome` to `sampleTerrain` and update every use in that file.
- `backend/tests/worldGen.test.js:61` — `cfg.biomeNames.sort()` becomes `cfg.terrainNames.sort()`.
- `backend/tests/worldPreview.test.js:18` — `[...cfg.biomeNames, cfg.pathTile]` becomes `[...cfg.terrainNames, cfg.pathTile]`.
- `backend/tests/biomeExcludesStructural.test.js` — rename every `biomeNames` reference to `terrainNames`, including in the test titles and assertion messages (e.g. `'worldConfig.terrainNames excludes structural overlay tiles'`). The file's subject is unchanged; only the field name moved.

Do not rename the test *files*; their subject is still correct.

- [ ] **Step 8: Run the tests**

Run: `cd backend && node --test tests/biomeSampler.test.js tests/worldGen.test.js tests/worldPreview.test.js tests/biomeExcludesStructural.test.js`
Expected: all PASS. The back-compat golden test passing after the rewrite is the point of this task — if it fails, the legacy path changed and the implementation is wrong.

- [ ] **Step 9: Run the full backend suite**

Run: `cd backend && npm test`
Expected: all pass. Any other file still importing `sampleBiome` or reading `cfg.biomeNames` fails here — fix those call sites, do not add a compatibility alias.

- [ ] **Step 10: Commit**

```bash
git add backend/src/services/mapService.js backend/tests/
git commit -m "feat(biomes): two-level terrain sampler (region then tile), byte-identical without biomes"
```

---

### Task 4: Shared generation-config builder

**Files:**
- Create: `backend/src/services/worldGenConfig.js`
- Create: `backend/tests/worldGenConfig.test.js`
- Modify: `backend/src/index.js:1692-1699` (the `/chunk` handler's `worldCfg`)
- Modify: `backend/src/authority/server.js:221`, `:251-256` (`loadWorld`)

**Interfaces:**
- Consumes: `loadBiomes(pool, names)` (Task 2); `worldConfig`'s expectations (Task 3) that `world.biomes` holds raw biome rows and `world.biomeCell` is a number or null.
- Produces: `buildWorldGenConfig({ row, tileTypes, doorways, villages, biomes }) -> { seed, chunkSize, tileTypes, width, height, doorways, villages, entry_spawn, biomes, biomeCell }`, where `row` is a `worlds` table row.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/worldGenConfig.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig');
const { worldConfig, generateRegion } = require('../src/services/mapService');

const ROW = {
  id: 'w1', seed: '777', chunk_size: 16, width: 30, height: 30,
  entry_spawn: { x: 1500, y: 1500 }, biome_cell: null,
};
const TILE_TYPES = {
  grass: { walkable: true, speed: 1 },
  sand: { walkable: true, speed: 1 },
  snow: { walkable: true, speed: 1 },
};
const BIOMES = [
  { name: 'Meadow', terrain_tiles: ['grass'], flora_types: ['bush'], creature_types: ['Slime'] },
  { name: 'Frozen Waste', terrain_tiles: ['snow'], flora_types: [], creature_types: ['Bat'] },
];

function cfgArgs(over = {}) {
  return { row: ROW, tileTypes: TILE_TYPES, doorways: [], villages: [], biomes: BIOMES, ...over };
}

test('coerces the seed to a number (the column is bigint -> string)', () => {
  const c = buildWorldGenConfig(cfgArgs());
  assert.strictEqual(c.seed, 777);
});

test('carries every field the generator reads', () => {
  const c = buildWorldGenConfig(cfgArgs());
  assert.deepEqual(Object.keys(c).sort(), [
    'biomeCell', 'biomes', 'chunkSize', 'doorways', 'entry_spawn',
    'height', 'seed', 'tileTypes', 'villages', 'width',
  ]);
  assert.equal(c.chunkSize, 16);
  assert.equal(c.width, 30);
  assert.equal(c.height, 30);
  assert.deepEqual(c.entry_spawn, { x: 1500, y: 1500 });
  assert.deepEqual(c.biomes, BIOMES);
});

test('a null biome_cell reaches worldConfig as null so it derives from bounds', () => {
  const c = buildWorldGenConfig(cfgArgs());
  assert.equal(c.biomeCell, null);
  assert.equal(worldConfig(c).biomeCell, 10); // floor(min(30,30)/3)
});

test('an explicit biome_cell is passed through', () => {
  const c = buildWorldGenConfig(cfgArgs({ row: { ...ROW, biome_cell: 15 } }));
  assert.equal(c.biomeCell, 15);
  assert.equal(worldConfig(c).biomeCell, 15);
});

test('the built config generates real biome-restricted terrain', () => {
  const c = buildWorldGenConfig(cfgArgs());
  const grid = generateRegion(c, 2, 2, 20, 20);
  const seen = new Set(grid.flat());
  assert.ok(!seen.has('sand'), 'sand belongs to no biome here and must not appear');
  assert.ok(seen.has('grass') || seen.has('snow'));
});

test('a world with no biomes builds an empty biome list, not undefined', () => {
  const c = buildWorldGenConfig(cfgArgs({ biomes: [] }));
  assert.deepEqual(c.biomes, []);
  assert.deepEqual(worldConfig(c).biomes, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test tests/worldGenConfig.test.js`
Expected: FAIL — `Cannot find module '../src/services/worldGenConfig'`.

- [ ] **Step 3: Write the builder**

Create `backend/src/services/worldGenConfig.js`:

```js
// The ONE place a `worlds` row becomes a generation config.
//
// Two callers must agree exactly: GET /api/worlds/:id/chunk (what the client
// renders and collides against) and the authority's loadWorld (what the server
// collides against). They used to hand-build near-identical object literals
// several hundred lines apart in different files; every field added to one and
// forgotten in the other is a silent client/server divergence -- terrain the
// client draws that the server doesn't have, and rubber-banding. Adding a
// field HERE reaches both by construction.
//
// `biomes` is the resolved record list from services/biomes.js (already in the
// world's declared banding order), not the raw name array off the row.
function buildWorldGenConfig({ row, tileTypes, doorways, villages, biomes }) {
  return {
    seed: Number(row.seed),
    chunkSize: row.chunk_size,
    tileTypes,
    width: row.width,
    height: row.height,
    doorways: doorways || [],
    villages: villages || [],
    entry_spawn: row.entry_spawn,
    biomes: biomes || [],
    // null (not undefined) so worldConfig's derive-from-bounds branch runs.
    biomeCell: Number.isFinite(row.biome_cell) ? row.biome_cell : null,
  };
}

module.exports = { buildWorldGenConfig };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test tests/worldGenConfig.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire the `/chunk` handler**

In `backend/src/index.js`, add near the other service requires at the top of the file:

```js
const { loadBiomes } = require('./services/biomes');
const { buildWorldGenConfig } = require('./services/worldGenConfig');
```

In the `/api/worlds/:id/chunk` handler (~line 1685), replace the `Promise.all` block and the `worldCfg` literal with:

```js
    const [tileTypes, decorationDefs, linkRows, villages, biomes] = await Promise.all([
      getTileTypesMap(),
      loadDecorationDefs(pool),
      fetchLinks(pool, world.id),
      fetchVillages(pool, world.id),
      loadBiomes(pool, world.biomes),
    ]);
    const worldCfg = buildWorldGenConfig({
      row: world, tileTypes, doorways: linkRows.map((l) => l.edge), villages, biomes,
    });
```

Update the comment above that block: the config is now built by
`services/worldGenConfig.js` and shared with the authority, so it can no longer
drift field-for-field.

- [ ] **Step 6: Wire the authority**

In `backend/src/authority/server.js`, add to the requires near line 14:

```js
const { loadBiomes } = require('../services/biomes');
const { buildWorldGenConfig } = require('../services/worldGenConfig');
```

At line 221, add `biomes, biome_cell` to the world SELECT:

```js
        const wr = await pool.query('SELECT id, seed, chunk_size, width, height, is_entry, entry_spawn, biomes, biome_cell FROM worlds WHERE id = $1', [worldId]);
```

Then replace the `ServerMap` construction (~line 251-256) with:

```js
        const decorationDefs = await loadDecorationDefs(pool);
        const biomes = await loadBiomes(pool, row.biomes);
        const map = new ServerMap({
          ...buildWorldGenConfig({
            row, tileTypes, doorways: [...links.keys()], villages, biomes,
          }),
          decorationDefs,
        });
```

- [ ] **Step 7: Run the affected tests**

Run: `cd backend && node --test tests/worldGenConfig.test.js tests/chunk_decorations_api.test.js tests/authority_server.test.js tests/authority_world.test.js`
Expected: all PASS.

Two notes on `chunk_decorations_api.test.js`:
- Add `biomes: []` to its `WORLD_ROW`. `loadBiomes` short-circuits on an empty list **without querying**, so no `FROM biomes` handler is needed — if you find yourself adding one, the loader is querying when it shouldn't.
- Replace its hand-written `expectedWorldCfg()` literal with a `buildWorldGenConfig({ row: world, tileTypes: { grass: { walkable: true, speed: 1 } }, doorways: [], villages: [], biomes: [] })` call, so the test compares against the same builder the handler uses instead of a second copy that can drift.

Do **not** weaken any mock's throw-on-unexpected-query behaviour; that guard is what proves a handler queries what it claims to.

- [ ] **Step 8: Run the full backend suite**

Run: `cd backend && npm test`
Expected: all pass. Authority tests whose fake world rows lack `biomes` stay green (undefined short-circuits the same way); only a test that actually sets a biome list needs a `FROM biomes` handler in its mock pool.

- [ ] **Step 9: Commit**

```bash
git add backend/src/services/worldGenConfig.js backend/src/index.js backend/src/authority/server.js backend/tests/
git commit -m "feat(biomes): one shared world-gen config builder, used by /chunk and the authority"
```

---

### Task 5: Biome-aware decorations

**Files:**
- Modify: `backend/src/services/mapService.js` — `generateChunkDecorations` (~line 285-325)
- Create: `backend/tests/biomeDecorations.test.js`

**Interfaces:**
- Consumes: `sampleBiomeRegion(cfg, gRow, gCol)` and the normalized record's `floraTypes` (Task 3).
- Produces: no signature change. `generateChunkDecorations(world, cx, cy, tiles, decorationDefs)` still returns `[{ name, row, col, blocking }]`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/biomeDecorations.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { generateChunk, generateChunkDecorations } = require('../src/services/mapService');

// Two defs that both match 'grass', so the ONLY thing that can separate them
// is the biome flora filter.
const BUSH = { id: 1, name: 'bush', walkable: true, spawn_tiles: ['grass'], chance: 1 };
const PINE = { id: 2, name: 'pine_tree', walkable: false, spawn_tiles: ['grass'], chance: 1 };
const DEFS = [BUSH, PINE];

function world(biomes) {
  return {
    seed: 12345, chunkSize: 16, width: 16, height: 16,
    tileTypes: { grass: { walkable: true, speed: 1 } },
    biomes, biomeCell: 24,
  };
}

function place(biomes) {
  const w = world(biomes);
  return generateChunkDecorations(w, 0, 0, generateChunk(w, 0, 0), DEFS);
}

test('without biomes both types can be placed (unchanged behaviour)', () => {
  const out = place([]);
  assert.ok(out.length > 0, 'fixture must place decorations');
  assert.deepEqual([...new Set(out.map((d) => d.name))].sort(), ['bush', 'pine_tree']);
});

test('a biome restricts placement to its own flora', () => {
  const out = place([{ name: 'Meadow', terrain_tiles: ['grass'], flora_types: ['bush'], creature_types: [] }]);
  assert.ok(out.length > 0, 'a biome with matching flora still places decorations');
  assert.deepEqual([...new Set(out.map((d) => d.name))], ['bush']);
});

test('MUTATION GUARD: the filter is what removes pine_tree, not the fixture', () => {
  // The same world with pine_tree as the only flora must place pine_tree and
  // no bush -- if either direction failed, the filter would be inert or the
  // fixture would be rigged.
  const out = place([{ name: 'Grove', terrain_tiles: ['grass'], flora_types: ['pine_tree'], creature_types: [] }]);
  assert.ok(out.length > 0);
  assert.deepEqual([...new Set(out.map((d) => d.name))], ['pine_tree']);
});

test('a biome with empty flora_types places nothing', () => {
  assert.deepEqual(place([{ name: 'Barrens', terrain_tiles: ['grass'], flora_types: [], creature_types: [] }]), []);
});

test('the same tiles are still eligible: the filter changes WHICH type, not WHERE', () => {
  // Density and fill gates run before the flora filter and are biome-blind, so
  // a single-flora biome decorates a subset of the biome-less placement.
  const all = new Set(place([]).map((d) => `${d.row},${d.col}`));
  for (const d of place([{ name: 'Meadow', terrain_tiles: ['grass'], flora_types: ['bush'], creature_types: [] }])) {
    assert.ok(all.has(`${d.row},${d.col}`), `unexpected new cell ${d.row},${d.col}`);
  }
});

test('blocking flag still comes from the def, not the biome', () => {
  const out = place([{ name: 'Grove', terrain_tiles: ['grass'], flora_types: ['pine_tree'], creature_types: [] }]);
  for (const d of out) assert.equal(d.blocking, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test tests/biomeDecorations.test.js`
Expected: FAIL — the "restricts placement to its own flora" test finds `pine_tree` in the output.

- [ ] **Step 3: Add the flora filter**

In `generateChunkDecorations`, inside the per-cell loop, immediately after the fill-roll `continue` and before the `let totalW = 0;` line, insert:

```js
      // WHICH types are eligible here at all: when the world has biomes, only
      // the flora the owning biome lists. Empty flora_types is a legitimate
      // authored choice ("this biome is barren"), not a config error -- there
      // is deliberately no fallback to the global def list.
      const region = sampleBiomeRegion(cfg, gRow, gCol);
      const flora = region ? region.floraTypes : null;
```

Then change the match loop's condition to also honour `flora`:

```js
      let totalW = 0;
      const matches = [];
      for (const def of decorationDefs) {
        if (flora && !flora.includes(def.name)) continue;
        const spawnTiles = def.spawn_tiles || def.spawnTiles;
        if (spawnTiles && spawnTiles.includes(terrain)) { matches.push(def); totalW += (def.chance || 0); }
      }
```

Everything else in the function — the density gate, the fill roll, the seeded weighted pick, the blocking exclusions — is unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test tests/biomeDecorations.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the decoration regression tests**

Run: `cd backend && node --test tests/biomeDecorations.test.js tests/decorationDefs.test.js tests/chunk_decorations_api.test.js`
Expected: all PASS. `decorationDefs.test.js`'s fixtures have no biomes, so the weighted-pick and def-order contracts must be untouched.

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/mapService.js backend/tests/biomeDecorations.test.js
git commit -m "feat(biomes): decorations restricted to the owning biome's flora"
```

---

### Task 6: Biome-aware creatures

**Files:**
- Modify: `backend/src/services/mapService.js` — `placeMapCreatures` (~line 451-485)
- Create: `backend/tests/biomeCreatures.test.js`

**Interfaces:**
- Consumes: `sampleBiomeRegion` and `creatureTypes` on the normalized record (Task 3).
- Produces: no signature change. `placeMapCreatures(world, count, allowedTypes, rngSeed, maxAttempts = 40)` still returns `[{ type, x, y, hp, facing, defense, resistances }]`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/biomeCreatures.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { placeMapCreatures, worldConfig, sampleBiomeRegion } = require('../src/services/mapService');

const SLIME = { name: 'Slime', hp: 10, defense: 0, resistances: {} };
const BAT = { name: 'Bat', hp: 8, defense: 0, resistances: {} };
const ALLOWED = [SLIME, BAT];

const MEADOW = { name: 'Meadow', terrain_tiles: ['grass'], flora_types: [], creature_types: ['Slime'] };
const WASTE = { name: 'Frozen Waste', terrain_tiles: ['snow'], flora_types: [], creature_types: ['Bat'] };

function world(biomes) {
  return {
    seed: 4242, chunkSize: 16, width: 40, height: 40, pathTile: null,
    tileTypes: {
      grass: { walkable: true, speed: 1 },
      snow: { walkable: true, speed: 1 },
      map_wall: { walkable: false, speed: 1 },
      map_doorway: { walkable: true, speed: 1 },
    },
    biomes, biomeCell: 12,
  };
}

test('without biomes both allowed types are used (unchanged behaviour)', () => {
  const out = placeMapCreatures(world([]), 60, ALLOWED, 7);
  assert.ok(out.length > 0);
  assert.deepEqual([...new Set(out.map((c) => c.type))].sort(), ['Bat', 'Slime']);
});

test('each placement uses a type its own biome lists', () => {
  const w = world([MEADOW, WASTE]);
  const cfg = worldConfig(w);
  const out = placeMapCreatures(w, 60, ALLOWED, 7);
  assert.ok(out.length > 0, 'fixture must place creatures');
  for (const c of out) {
    const row = Math.floor(c.y / 100), col = Math.floor(c.x / 100);
    const region = sampleBiomeRegion(cfg, row, col);
    assert.ok(region.creatureTypes.includes(c.type),
      `${c.type} at (${row},${col}) is not native to ${region.name}`);
  }
});

test('BOTH biomes are actually exercised (the test above is not vacuous)', () => {
  const out = placeMapCreatures(world([MEADOW, WASTE]), 60, ALLOWED, 7);
  assert.deepEqual([...new Set(out.map((c) => c.type))].sort(), ['Bat', 'Slime']);
});

test('the world allowlist still wins: a biome cannot widen it', () => {
  const out = placeMapCreatures(world([MEADOW, WASTE]), 60, [SLIME], 7);
  assert.ok(out.length > 0, 'Meadow cells can still host Slimes');
  assert.deepEqual([...new Set(out.map((c) => c.type))], ['Slime']);
});

test('a world whose biomes list no allowed creature places nothing', () => {
  const barren = { name: 'Barren', terrain_tiles: ['grass'], flora_types: [], creature_types: [] };
  assert.deepEqual(placeMapCreatures(world([barren]), 20, ALLOWED, 7), []);
});

test('placements stay deterministic for a given rng seed', () => {
  const a = placeMapCreatures(world([MEADOW, WASTE]), 30, ALLOWED, 99);
  const b = placeMapCreatures(world([MEADOW, WASTE]), 30, ALLOWED, 99);
  assert.deepEqual(a, b);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test tests/biomeCreatures.test.js`
Expected: FAIL — placements land on types their biome does not list.

- [ ] **Step 3: Add the fauna filter**

In `placeMapCreatures`, replace the single type-pick line with a biome-narrowed pick. The body of the attempt loop becomes:

```js
    for (let a = 0; a < maxAttempts; a++) {
      const row = rLo + Math.floor(rng() * (rHi - rLo + 1));
      const col = cLo + Math.floor(rng() * (cHi - cLo + 1));
      const name = generateRegion(world, row, col, 1, 1)[0][0];
      if (name === wallTile || name === doorwayTile) continue;
      const def = world.tileTypes && world.tileTypes[name];
      if (def && def.walkable === false) continue;
      if (villageContaining(row, col, villages)) continue;
      // Narrow to the fauna native to the biome that owns this cell. The
      // world's allowlist stays authoritative -- a biome can only remove
      // candidates from it, never add one. An empty intersection means this
      // biome has no fauna the world permits, so roll another cell rather
      // than forcing a foreign creature into it.
      const region = sampleBiomeRegion(cfg, row, col);
      const candidates = region
        ? allowedTypes.filter((t) => region.creatureTypes.includes(t.name))
        : allowedTypes;
      if (candidates.length === 0) continue;
      const t = candidates[Math.floor(rng() * candidates.length)];
      out.push({
        type: t.name,
        x: col * CREATURE_TILE_PX + CREATURE_TILE_PX / 2,
        y: row * CREATURE_TILE_PX + CREATURE_TILE_PX / 2,
        hp: t.hp || 10,
        facing: 'S',
        defense: Number(t.defense ?? 0) || 0,
        resistances: t.resistances || {},
      });
      break;
    }
```

`cfg` is already in scope (the function opens with `const cfg = worldConfig(world);`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test tests/biomeCreatures.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && npm test`
Expected: all pass. Existing creature-placement tests use biome-less worlds, so the `region === null` branch must keep them green.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/mapService.js backend/tests/biomeCreatures.test.js
git commit -m "feat(biomes): creature placement narrowed to the owning biome's fauna"
```

---

### Task 7: Biome art context in generation prompts

**Files:**
- Create: `backend/src/services/biomePrompt.js`
- Create: `backend/tests/biomePrompt.test.js`
- Modify: `backend/src/index.js:926-949` (`startGenerationJob`)
- Create: `backend/tests/biomePromptRoute.test.js`

**Interfaces:**
- Consumes: `loadBiomes(pool, names)` (Task 2).
- Produces: `composeBiomePrompt(basePrompt, biome) -> string`, where `biome` is a raw biome row (`{ palette, art_style, exclusions }`) or null/undefined.

- [ ] **Step 1: Write the failing unit test**

Create `backend/tests/biomePrompt.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { composeBiomePrompt } = require('../src/services/biomePrompt');

const DUNES = {
  name: 'Arid Dunes',
  palette: ['ochre', 'gold', 'burnt sienna'],
  art_style: 'sun-bleached hand-drawn fantasy, harsh light',
  exclusions: 'no grass, no snow',
};

test('no biome leaves the base prompt untouched', () => {
  assert.equal(composeBiomePrompt('a mossy boulder', null), 'a mossy boulder');
  assert.equal(composeBiomePrompt('a mossy boulder', undefined), 'a mossy boulder');
});

test('a full biome appends palette, style and exclusions', () => {
  assert.equal(
    composeBiomePrompt('a mossy boulder', DUNES),
    'a mossy boulder, ochre, gold, burnt sienna palette, sun-bleached hand-drawn fantasy, harsh light. Avoid: no grass, no snow',
  );
});

test('an empty palette produces no dangling comma', () => {
  assert.equal(
    composeBiomePrompt('a boulder', { ...DUNES, palette: [] }),
    'a boulder, sun-bleached hand-drawn fantasy, harsh light. Avoid: no grass, no snow',
  );
});

test('an empty art_style produces no dangling comma', () => {
  assert.equal(
    composeBiomePrompt('a boulder', { ...DUNES, art_style: '   ' }),
    'a boulder, ochre, gold, burnt sienna palette. Avoid: no grass, no snow',
  );
});

test('empty exclusions produce no trailing "Avoid:"', () => {
  assert.equal(
    composeBiomePrompt('a boulder', { ...DUNES, exclusions: '' }),
    'a boulder, ochre, gold, burnt sienna palette, sun-bleached hand-drawn fantasy, harsh light',
  );
});

test('a fully empty biome is a no-op', () => {
  assert.equal(
    composeBiomePrompt('a boulder', { name: 'Blank', palette: [], art_style: '', exclusions: '' }),
    'a boulder',
  );
});

test('an empty base prompt still yields a usable string', () => {
  assert.equal(
    composeBiomePrompt('', DUNES),
    'ochre, gold, burnt sienna palette, sun-bleached hand-drawn fantasy, harsh light. Avoid: no grass, no snow',
  );
  assert.equal(composeBiomePrompt(undefined, null), '');
});

test('falsy palette entries are dropped', () => {
  assert.equal(
    composeBiomePrompt('a boulder', { palette: ['ochre', '', null, 'gold'], art_style: '', exclusions: '' }),
    'a boulder, ochre, gold palette',
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test tests/biomePrompt.test.js`
Expected: FAIL — `Cannot find module '../src/services/biomePrompt'`.

- [ ] **Step 3: Write the composer**

Create `backend/src/services/biomePrompt.js`:

```js
// Compose a biome's art context into a generation prompt.
//
// The sprite-gen service appends its own per-kind styling (seamless tile /
// isolated object / directional sprite) to whatever `base_prompt` it receives
// -- see sprite-gen/app/prompts.py. Biome context therefore belongs HERE, in
// the base prompt, and the Python service stays untouched.
//
// Tiles are shared across biomes and have one image each (spec S5): the admin
// picks which biome's context to compose at generation time.
function composeBiomePrompt(basePrompt, biome) {
  const base = String(basePrompt || '').trim();
  if (!biome) return base;

  const parts = [];
  const palette = (Array.isArray(biome.palette) ? biome.palette : [])
    .filter((c) => typeof c === 'string' && c.trim())
    .map((c) => c.trim());
  if (palette.length) parts.push(`${palette.join(', ')} palette`);
  const style = String(biome.art_style || '').trim();
  if (style) parts.push(style);

  const head = [base, ...parts].filter(Boolean).join(', ');
  const excl = String(biome.exclusions || '').trim();
  if (!excl) return head;
  return head ? `${head}. Avoid: ${excl}` : `Avoid: ${excl}`;
}

module.exports = { composeBiomePrompt };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test tests/biomePrompt.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Write the failing route test**

Create `backend/tests/biomePromptRoute.test.js`, using the same harness as `backend/tests/entity_jobs_api.test.js`: `tests/helpers/auth.js` for the admin token, `__setSpriteGen` to capture the outgoing payload, `__setPool` for the DB.

```js
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
// helpers/auth.js MUST be required before ../src/index.js — it sets JWT_SECRET
// before the guards read it.
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool, __setSpriteGen } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

const BIOME_ROW = {
  id: 3, name: 'Arid Dunes',
  terrain_tiles: ['sand'], flora_types: [], creature_types: [],
  palette: ['ochre', 'gold'], art_style: 'sun-bleached', exclusions: 'no grass',
  color: '#c9a227',
};

function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      calls.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const INSERT_JOB = [/INSERT INTO sprite_sets/i, (p) => ({ rows: [{ id: 1, job_id: p[4] }] })];

// Capture the payload the route forwards to sprite-gen.
function captureGenerate() {
  const seen = [];
  __setSpriteGen({
    postGenerate: async (body) => { seen.push(body); return { job_id: 'job-1', recipe: { backend: 'stub', frames: 1 } }; },
    getCapability: async () => ({ tier: 'cpu' }),
  });
  return seen;
}

test('a biome name composes its art context into base_prompt', async () => {
  const seen = captureGenerate();
  __setPool(mockPool([[/FROM biomes/i, () => ({ rows: [BIOME_ROW] })], INSERT_JOB]));

  const res = await request(app).post('/api/tile-jobs').set(...AUTH)
    .send({ tile_type: 'sand', base_prompt: 'desert sand', biome: 'Arid Dunes' });

  assert.equal(res.status, 201);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].base_prompt, 'desert sand, ochre, gold palette, sun-bleached. Avoid: no grass');
  // The rest of the payload is untouched by biome composition.
  assert.equal(seen[0].kind, 'tile');
  assert.equal(seen[0].creature, 'sand');
});

test('no biome forwards the base prompt unchanged and never queries biomes', async () => {
  const seen = captureGenerate();
  const pool = mockPool([INSERT_JOB]);
  __setPool(pool);

  const res = await request(app).post('/api/tile-jobs').set(...AUTH)
    .send({ tile_type: 'sand', base_prompt: 'desert sand' });

  assert.equal(res.status, 201);
  assert.equal(seen[0].base_prompt, 'desert sand');
  assert.ok(!pool.calls.some((c) => /FROM biomes/i.test(c.sql)));
});

test('an unknown biome name degrades to the plain base prompt rather than failing', async () => {
  const seen = captureGenerate();
  __setPool(mockPool([[/FROM biomes/i, () => ({ rows: [] })], INSERT_JOB]));

  const res = await request(app).post('/api/tile-jobs').set(...AUTH)
    .send({ tile_type: 'sand', base_prompt: 'desert sand', biome: 'Atlantis' });

  assert.equal(res.status, 201);
  assert.equal(seen[0].base_prompt, 'desert sand');
});

test('entity jobs get biome context too (all three kinds share the funnel)', async () => {
  const seen = captureGenerate();
  __setPool(mockPool([[/FROM biomes/i, () => ({ rows: [BIOME_ROW] })], INSERT_JOB]));

  const res = await request(app).post('/api/entity-jobs').set(...AUTH)
    .send({ entity_type: 'dead_tree', base_prompt: 'a bleached dead tree', biome: 'Arid Dunes' });

  assert.equal(res.status, 201);
  assert.equal(seen[0].base_prompt, 'a bleached dead tree, ochre, gold palette, sun-bleached. Avoid: no grass');
  assert.equal(seen[0].kind, 'object');
});
```

Do not weaken `adminGuard` to make these pass.

- [ ] **Step 6: Run the route test to verify it fails**

Run: `cd backend && node --test tests/biomePromptRoute.test.js`
Expected: FAIL — `base_prompt` is forwarded verbatim, without the biome context.

- [ ] **Step 7: Wire `startGenerationJob`**

In `backend/src/index.js`, add near the other service requires:

```js
const { composeBiomePrompt } = require('./services/biomePrompt');
```

(`loadBiomes` is already required from Task 4.) Then in `startGenerationJob`:

```js
async function startGenerationJob(req, res, { subject, kind, defaultFrames, failureMessage }) {
  try {
    const { base_prompt, biome, backend, frames, seed = 0, tier } = req.body;
    // Biome art context (palette / style / exclusions) is composed into the
    // base prompt HERE so all three job kinds get it and sprite-gen's
    // prompts.py stays untouched. An unknown biome name degrades to the plain
    // base prompt rather than failing the job.
    const [biomeRow] = biome ? await loadBiomes(pool, [biome]) : [];
    const prompt = composeBiomePrompt(base_prompt, biomeRow || null);
    let effectiveTier = tier;
    if (!effectiveTier && !backend) {
      try { effectiveTier = (await spriteGen.getCapability()).tier; } catch (_) { /* ignore */ }
    }
    const gen = await spriteGen.postGenerate({
      creature: subject, base_prompt: prompt, kind, backend, frames, seed, tier: effectiveTier,
    });
```

The rest of the function is unchanged.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd backend && node --test tests/biomePrompt.test.js tests/biomePromptRoute.test.js tests/entity_jobs_api.test.js`
Expected: all PASS.

- [ ] **Step 9: Run the full backend suite**

Run: `cd backend && npm test`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add backend/src/services/biomePrompt.js backend/src/index.js backend/tests/biomePrompt.test.js backend/tests/biomePromptRoute.test.js
git commit -m "feat(biomes): compose biome art context into sprite-gen prompts backend-side"
```

---

### Task 8: Biome CRUD API, reference guards, chunk invalidation

**Files:**
- Modify: `backend/src/index.js` — new `/api/biomes` routes (place them immediately after the `/api/tile-types` routes, ~line 710); entity-type rename guard ~line 405-420; tile-type PUT ~line 666; world PUT ~line 1222-1330
- Create: `backend/tests/biomesApi.test.js`

**Interfaces:**
- Consumes: `loadBiomes` (Task 2).
- Produces:
  - `GET /api/biomes` (public read, like `/api/tile-types`) → all biomes `ORDER BY id ASC`.
  - `POST /api/biomes` (adminGuard) → 201 with the row.
  - `PUT /api/biomes/:id` (adminGuard) → 200 with the row; 409 if renaming a biome a world still lists.
  - `DELETE /api/biomes/:id` (adminGuard) → `{ success: true, id }`; 409 if a world still lists it.
  - `PUT /api/worlds/:id` additionally accepts `biomes` (array of names) and `biome_cell` (integer or null), and deletes that world's `world_chunks` + caches when either changes.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/biomesApi.test.js`, using the same harness as `backend/tests/entity_jobs_api.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
// helpers/auth.js MUST be required before ../src/index.js — it sets JWT_SECRET
// before the guards read it.
const { authHeaders, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

const ADMIN_HEADERS = authHeaders();

function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      calls.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const BIOME = {
  id: 1, name: 'Meadow', terrain_tiles: ['grass'], flora_types: ['bush'],
  creature_types: ['Slime'], palette: ['spring green'], art_style: 'lush',
  exclusions: 'no snow', color: '#5aa84f',
};

test('GET /api/biomes lists biomes ordered by id', async () => {
  const pool = mockPool([[/FROM biomes/i, () => ({ rows: [BIOME] })]]);
  __setPool(pool);
  const res = await request(app).get('/api/biomes');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [BIOME]);
  assert.match(pool.calls[0].sql, /ORDER BY id/i);
});

test('POST /api/biomes rejects a missing name', async () => {
  __setPool(mockPool([]));
  const res = await request(app).post('/api/biomes').set(ADMIN_HEADERS).send({ terrain_tiles: ['grass'] });
  assert.equal(res.status, 400);
});

test('POST /api/biomes creates a biome', async () => {
  const pool = mockPool([[/INSERT INTO biomes/i, () => ({ rows: [BIOME] })]]);
  __setPool(pool);
  const res = await request(app).post('/api/biomes').set(ADMIN_HEADERS).send({
    name: 'Meadow', terrain_tiles: ['grass'], flora_types: ['bush'],
    creature_types: ['Slime'], palette: ['spring green'],
    art_style: 'lush', exclusions: 'no snow', color: '#5aa84f',
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, BIOME);
});

test('PUT /api/biomes/:id refuses a rename while a world still lists the old name', async () => {
  const pool = mockPool([
    [/SELECT name FROM biomes WHERE id/i, () => ({ rows: [{ name: 'Meadow' }] })],
    [/FROM worlds WHERE biomes/i, () => ({ rows: [{ id: 'w1', name: 'Entry' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/biomes/1').set(ADMIN_HEADERS).send({ ...BIOME, name: 'Pasture' });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.referencing_worlds, [{ id: 'w1', name: 'Entry' }]);
});

test('DELETE /api/biomes/:id refuses while a world still lists it', async () => {
  const pool = mockPool([
    [/SELECT name FROM biomes WHERE id/i, () => ({ rows: [{ name: 'Meadow' }] })],
    [/FROM worlds WHERE biomes/i, () => ({ rows: [{ id: 'w1', name: 'Entry' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).delete('/api/biomes/1').set(ADMIN_HEADERS);
  assert.equal(res.status, 409);
});

test('DELETE /api/biomes/:id succeeds when unreferenced', async () => {
  __setPool(mockPool([
    [/SELECT name FROM biomes WHERE id/i, () => ({ rows: [{ name: 'Meadow' }] })],
    [/FROM worlds WHERE biomes/i, () => ({ rows: [] })],
    [/DELETE FROM biomes/i, () => ({ rows: [{ id: 1 }] })],
  ]));
  const res = await request(app).delete('/api/biomes/1').set(ADMIN_HEADERS);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true, id: 1 });
});

test('renaming a tile type is refused while a biome still lists it', async () => {
  __setPool(mockPool([
    [/SELECT name FROM tile_types WHERE id/i, () => ({ rows: [{ name: 'grass' }] })],
    [/FROM entity_types WHERE spawn_tiles/i, () => ({ rows: [] })],
    [/FROM biomes WHERE terrain_tiles/i, () => ({ rows: [{ id: 1, name: 'Meadow' }] })],
  ]));
  const res = await request(app).put('/api/tile-types/1').set(ADMIN_HEADERS).send({ name: 'lawn', color: '#0f0' });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.referencing_biomes, [{ id: 1, name: 'Meadow' }]);
});

test('renaming an entity type is refused while a biome still lists it', async () => {
  __setPool(mockPool([
    [/SELECT name FROM entity_types WHERE id/i, () => ({ rows: [{ name: 'bush' }] })],
    [/FROM worlds WHERE allowed_creature_types/i, () => ({ rows: [] })],
    [/FROM world_creatures WHERE type/i, () => ({ rows: [] })],
    [/FROM biomes WHERE/i, () => ({ rows: [{ id: 1, name: 'Meadow' }] })],
  ]));
  const res = await request(app).put('/api/entity-types/1').set(ADMIN_HEADERS).send({ name: 'shrub' });
  assert.equal(res.status, 409);
});

test('PUT /api/worlds/:id changing the biome set wipes that world\'s cached chunks', async () => {
  const pool = mockPool([
    [/SELECT id, width, height, biomes, biome_cell FROM worlds WHERE id/i,
      () => ({ rows: [{ id: 'w1', width: 30, height: 30, biomes: [], biome_cell: null }] })],
    [/DELETE FROM world_chunks/i, () => ({ rows: [] })],
    [/UPDATE worlds SET/i, () => ({ rows: [{ id: 'w1', name: 'Entry', biomes: ['Meadow'] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(ADMIN_HEADERS).send({
    name: 'Entry', biomes: ['Meadow'],
  });
  assert.equal(res.status, 200);
  assert.ok(pool.calls.some((c) => /DELETE FROM world_chunks/i.test(c.sql)),
    'changing the biome set changes terrain, so cached chunks must be invalidated');
});

test('PUT /api/worlds/:id with an unchanged biome set does NOT wipe chunks', async () => {
  const pool = mockPool([
    [/SELECT id, width, height, biomes, biome_cell FROM worlds WHERE id/i,
      () => ({ rows: [{ id: 'w1', width: 30, height: 30, biomes: ['Meadow'], biome_cell: null }] })],
    [/UPDATE worlds SET/i, () => ({ rows: [{ id: 'w1', name: 'Entry' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(ADMIN_HEADERS).send({
    name: 'Entry', biomes: ['Meadow'],
  });
  assert.equal(res.status, 200);
  assert.ok(!pool.calls.some((c) => /DELETE FROM world_chunks/i.test(c.sql)));
});

test('PUT /api/worlds/:id omitting biomes leaves the stored set alone', async () => {
  // Same trap as width/height: an unrelated PUT (toggling is_entry) must not
  // silently clear a world's biome set and regenerate its terrain.
  const pool = mockPool([
    [/SELECT id, width, height, biomes, biome_cell FROM worlds WHERE id/i,
      () => ({ rows: [{ id: 'w1', width: 30, height: 30, biomes: ['Meadow'], biome_cell: null }] })],
    // biomes is $8 in the UPDATE below -> params[7]; biome_cell is $9 -> params[8].
    [/UPDATE worlds SET/i, (params) => {
      assert.equal(params[7], JSON.stringify(['Meadow']), 'an omitted biomes field must preserve the stored set');
      return { rows: [{ id: 'w1' }] };
    }],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(ADMIN_HEADERS).send({ name: 'Entry', is_entry: true });
  assert.equal(res.status, 200);
  assert.ok(!pool.calls.some((c) => /DELETE FROM world_chunks/i.test(c.sql)));
});
```

The `is_entry: true` case also issues `UPDATE worlds SET is_entry = false WHERE is_entry = true AND id <> $1` before the main update — that regex matches `/UPDATE worlds SET/i` too, so either give it its own earlier handler or assert on the *last* matching call. Whichever you choose, keep the assertion pinned to the biome parameter; the point of the test is that an unrelated PUT cannot silently clear a world's biome set.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test tests/biomesApi.test.js`
Expected: FAIL — the `/api/biomes` routes 404.

- [ ] **Step 3: Add the biome CRUD routes**

In `backend/src/index.js`, immediately after `app.delete('/api/tile-types/:id', …)` (~line 710), add:

```js
// --- Biomes ---------------------------------------------------------------
// A biome owns a terrain palette, its flora and fauna, and its art context.
// Read is public (the admin UI and the maps editor both need it); writes are
// admin-only, matching the tile-types routes above.

// jsonb name arrays, normalized the same way everywhere: strings only.
function nameArray(v) {
  return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : [];
}

// Worlds that still list `name` in their biome set. worlds.biomes is a jsonb
// array of names with no FK (same as allowed_creature_types), so a rename or
// delete here would silently orphan the reference and quietly revert those
// worlds to global terrain banding on their next chunk generation.
async function worldsReferencingBiome(name) {
  const { rows } = await pool.query(
    'SELECT id, name FROM worlds WHERE biomes @> $1::jsonb', [JSON.stringify([name])],
  );
  return rows;
}

app.get('/api/biomes', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM biomes ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch biomes' });
  }
});

app.post('/api/biomes', adminGuard, async (req, res) => {
  try {
    const { name, terrain_tiles, flora_types, creature_types, palette, art_style, exclusions, color } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (catalogNameTooLong(name)) {
      return res.status(400).json({ error: `name must be ${MAX_CATALOG_NAME_LEN} characters or fewer` });
    }
    const result = await pool.query(
      `INSERT INTO biomes (name, terrain_tiles, flora_types, creature_types, palette, art_style, exclusions, color)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8) RETURNING *`,
      [
        name.trim(),
        JSON.stringify(nameArray(terrain_tiles)), JSON.stringify(nameArray(flora_types)),
        JSON.stringify(nameArray(creature_types)), JSON.stringify(nameArray(palette)),
        art_style || '', exclusions || '', color || '#888888',
      ],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: 'a biome with that name already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create biome' });
  }
});

app.put('/api/biomes/:id', adminGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, terrain_tiles, flora_types, creature_types, palette, art_style, exclusions, color } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (catalogNameTooLong(name)) {
      return res.status(400).json({ error: `name must be ${MAX_CATALOG_NAME_LEN} characters or fewer` });
    }
    const cur = await pool.query('SELECT name FROM biomes WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Biome not found' });
    const oldName = cur.rows[0].name;
    if (oldName !== name.trim()) {
      const refs = await worldsReferencingBiome(oldName);
      if (refs.length > 0) {
        return res.status(409).json({
          error: `Cannot rename '${oldName}': still listed by one or more worlds`,
          referencing_worlds: refs.map((w) => ({ id: w.id, name: w.name })),
        });
      }
    }
    const result = await pool.query(
      `UPDATE biomes SET name = $1, terrain_tiles = $2::jsonb, flora_types = $3::jsonb,
         creature_types = $4::jsonb, palette = $5::jsonb, art_style = $6, exclusions = $7,
         color = $8, updated_at = CURRENT_TIMESTAMP
       WHERE id = $9 RETURNING *`,
      [
        name.trim(),
        JSON.stringify(nameArray(terrain_tiles)), JSON.stringify(nameArray(flora_types)),
        JSON.stringify(nameArray(creature_types)), JSON.stringify(nameArray(palette)),
        art_style || '', exclusions || '', color || '#888888', id,
      ],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Biome not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: 'a biome with that name already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to update biome' });
  }
});

app.delete('/api/biomes/:id', adminGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const cur = await pool.query('SELECT name FROM biomes WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Biome not found' });
    const refs = await worldsReferencingBiome(cur.rows[0].name);
    if (refs.length > 0) {
      return res.status(409).json({
        error: `Cannot delete '${cur.rows[0].name}': still listed by one or more worlds`,
        referencing_worlds: refs.map((w) => ({ id: w.id, name: w.name })),
      });
    }
    const result = await pool.query('DELETE FROM biomes WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Biome not found' });
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete biome' });
  }
});
```

If `isUniqueViolation` is defined below this point in the file, move these routes after its definition or hoist the helper — do not duplicate it.

- [ ] **Step 4: Extend the entity-type rename guard**

In the `PUT /api/entity-types/:id` guard (~line 405), add a third reference query:

```js
        const [worldsRef, creaturesRef, biomesRef] = await Promise.all([
          pool.query('SELECT id, name FROM worlds WHERE allowed_creature_types @> $1::jsonb', [JSON.stringify([oldName])]),
          pool.query('SELECT 1 FROM world_creatures WHERE type = $1 LIMIT 1', [oldName]),
          // biomes.flora_types / creature_types reference entity_types by name
          // with no FK, exactly like allowed_creature_types above. A rename
          // that orphans them silently strips that biome's flora or fauna.
          pool.query(
            `SELECT id, name FROM biomes
              WHERE flora_types @> $1::jsonb OR creature_types @> $1::jsonb`,
            [JSON.stringify([oldName])],
          ),
        ]);
        if (worldsRef.rows.length > 0 || creaturesRef.rows.length > 0 || biomesRef.rows.length > 0) {
          return res.status(409).json({
            error: `Cannot rename '${oldName}': still referenced by allowed_creature_types, placed creatures, or a biome`,
            referencing_worlds: worldsRef.rows.map((w) => ({ id: w.id, name: w.name })),
            referencing_biomes: biomesRef.rows.map((b) => ({ id: b.id, name: b.name })),
            has_placed_creatures: creaturesRef.rows.length > 0,
          });
        }
```

- [ ] **Step 5: Add a rename guard to tile types**

`PUT /api/tile-types/:id` (~line 666) has no rename guard today. Add one before the `UPDATE`, mirroring the entity-type guard:

```js
    // tile_types.name is referenced by entity_types.spawn_tiles and
    // biomes.terrain_tiles, both jsonb name arrays with no FK (F-027 /
    // SOMET-207). A free rename orphans them silently: the entity stops
    // spawning and the biome quietly loses that terrain.
    if (name != null) {
      const cur = await pool.query('SELECT name FROM tile_types WHERE id = $1', [id]);
      if (cur.rows.length === 0) return res.status(404).json({ error: 'Tile type not found' });
      const oldName = cur.rows[0].name;
      if (oldName !== name) {
        const [entityRef, biomeRef] = await Promise.all([
          pool.query('SELECT id, name FROM entity_types WHERE spawn_tiles @> $1::jsonb', [JSON.stringify([oldName])]),
          pool.query('SELECT id, name FROM biomes WHERE terrain_tiles @> $1::jsonb', [JSON.stringify([oldName])]),
        ]);
        if (entityRef.rows.length > 0 || biomeRef.rows.length > 0) {
          return res.status(409).json({
            error: `Cannot rename '${oldName}': still referenced by an entity type's spawn tiles or a biome`,
            referencing_entity_types: entityRef.rows.map((e) => ({ id: e.id, name: e.name })),
            referencing_biomes: biomeRef.rows.map((b) => ({ id: b.id, name: b.name })),
          });
        }
      }
    }
```

- [ ] **Step 6: Accept `biomes` / `biome_cell` on the world PUT**

In `PUT /api/worlds/:id` (~line 1222):

1. Destructure the two new fields:
```js
    const { name, width, height, creature_count, allowed_creature_types, is_entry, entry_spawn, biomes, biome_cell } = req.body;
```

2. Extend the existing `cur` SELECT so the before-state is available:
```js
    const cur = await pool.query('SELECT id, width, height, biomes, biome_cell FROM worlds WHERE id = $1', [id]);
```

3. After the `boundsChanged` computation, add the same omitted-field discipline the bounds already use:
```js
    // Same trap as width/height above: an unrelated PUT (e.g. toggling
    // is_entry) omits these entirely, and defaulting them to empty/null would
    // silently strip a world's biome set and regenerate its terrain.
    const biomesProvided = biomes !== undefined;
    const nextBiomes = biomesProvided
      ? (Array.isArray(biomes) ? biomes.filter((b) => typeof b === 'string' && b.trim()).map((b) => b.trim()) : [])
      : (before.biomes || []);
    const cellProvided = biome_cell !== undefined;
    const nextCell = cellProvided
      ? (Number.isFinite(biome_cell) && biome_cell > 0 ? Math.floor(biome_cell) : null)
      : (before.biome_cell ?? null);
    // Both inputs decide which tile each cell gets, so a change to either
    // invalidates every materialized chunk of this world -- otherwise the
    // cached grid the client renders and the terrain the authority regenerates
    // disagree, which is client/server divergence and rubber-banding.
    const biomesChanged =
      JSON.stringify(before.biomes || []) !== JSON.stringify(nextBiomes)
      || (before.biome_cell ?? null) !== nextCell;
```

4. Change the chunk-wipe condition from `if (boundsChanged)` to `if (boundsChanged || biomesChanged)` for the `DELETE FROM world_chunks` / `worldPreviewCache.delete(id)` / `clearOverviewCache(id)` block. Leave the *player-clamping* block gated on `boundsChanged` alone — a biome change does not move the wall ring.

5. Add both columns to the `UPDATE`, appending `biomes = $8::jsonb, biome_cell = $9` and renumbering `id` to `$10`, with `JSON.stringify(nextBiomes)` and `nextCell` in the params.

6. Extend the live-world warning: `const liveWarning = (boundsChanged || biomesChanged) ? evictOrWarn(id) : undefined;`

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd backend && node --test tests/biomesApi.test.js`
Expected: PASS (11 tests).

- [ ] **Step 8: Run the full backend suite**

Run: `cd backend && npm test`
Expected: all pass. Existing world-PUT tests must stay green — the omitted-field defaults are what keeps them so.

- [ ] **Step 9: Commit**

```bash
git add backend/src/index.js backend/tests/biomesApi.test.js
git commit -m "feat(biomes): CRUD API, tile/entity rename guards, chunk invalidation on biome change"
```

---

### Task 9: Biomes admin tab + per-world biome set

**Files:**
- Create: `frontend/src/games/something2/biomeForm.js`
- Create: `frontend/src/games/something2/useBiomes.js`
- Create: `frontend/src/games/something2/BiomesAdmin.jsx`
- Create: `frontend/src/games/something2/__tests__/biomeForm.test.js`
- Create: `frontend/src/games/something2/__tests__/BiomesAdmin.smoke.test.js`
- Modify: `frontend/src/games/something2/Something2.jsx` (imports ~line 14-19, tab bar ~line 662, render ~line 847)
- Modify: `frontend/src/games/something2/MapsAdmin.jsx` (MapCard)
- Modify: `frontend/src/games/something2/useMapsAdmin.js` (no signature change needed — `useUpdateWorld` already spreads the body)

**Interfaces:**
- Consumes: the Task 8 endpoints (`GET/POST/PUT/DELETE /api/biomes`, `PUT /api/worlds/:id` with `biomes` + `biome_cell`).
- Produces: `emptyBiomeForm()`, `biomeToForm(row)`, `biomeFormToPayload(form)` from `biomeForm.js`; `useBiomes()`, `useCreateBiome()`, `useUpdateBiome()`, `useDeleteBiome()` from `useBiomes.js`; default-exported `BiomesAdmin` component.

- [ ] **Step 1: Write the failing form-helper test**

Create `frontend/src/games/something2/__tests__/biomeForm.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { emptyBiomeForm, biomeToForm, biomeFormToPayload } from '../biomeForm.js';

const ROW = {
  id: 1, name: 'Meadow', terrain_tiles: ['grass', 'earth'], flora_types: ['bush'],
  creature_types: ['Slime'], palette: ['spring green', 'warm brown'],
  art_style: 'lush', exclusions: 'no snow', color: '#5aa84f',
};

describe('biomeForm', () => {
  it('an empty form has every field and no undefined', () => {
    const f = emptyBiomeForm();
    expect(Object.keys(f).sort()).toEqual([
      'art_style', 'color', 'creature_types', 'exclusions', 'flora_types',
      'name', 'palette', 'terrain_tiles',
    ]);
    for (const v of Object.values(f)) expect(v).toBeDefined();
  });

  it('round-trips a row through form and back to payload', () => {
    const payload = biomeFormToPayload(biomeToForm(ROW));
    expect(payload).toEqual({
      name: 'Meadow', terrain_tiles: ['grass', 'earth'], flora_types: ['bush'],
      creature_types: ['Slime'], palette: ['spring green', 'warm brown'],
      art_style: 'lush', exclusions: 'no snow', color: '#5aa84f',
    });
  });

  it('palette is edited as comma-separated text and split on save', () => {
    const f = { ...biomeToForm(ROW), palette: ' ochre , gold ,, burnt sienna ' };
    expect(biomeFormToPayload(f).palette).toEqual(['ochre', 'gold', 'burnt sienna']);
  });

  it('a row with null jsonb columns yields empty arrays, not crashes', () => {
    const f = biomeToForm({ name: 'X', terrain_tiles: null, flora_types: null, creature_types: null, palette: null });
    expect(biomeFormToPayload(f)).toEqual({
      name: 'X', terrain_tiles: [], flora_types: [], creature_types: [],
      palette: [], art_style: '', exclusions: '', color: '#888888',
    });
  });

  it('trims the name and drops blank multi-select entries', () => {
    const f = { ...emptyBiomeForm(), name: '  Mire  ', terrain_tiles: ['swamp', '', 'water'] };
    const p = biomeFormToPayload(f);
    expect(p.name).toBe('Mire');
    expect(p.terrain_tiles).toEqual(['swamp', 'water']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/biomeForm.test.js`
Expected: FAIL — cannot resolve `../biomeForm.js`.

- [ ] **Step 3: Write the form helpers**

Create `frontend/src/games/something2/biomeForm.js` (this file is the testable half of BiomesAdmin, following the `itemTypeForm.js` precedent):

```js
// Pure form <-> payload helpers for the Biomes admin tab. The component keeps
// the JSX; everything with a rule in it lives here so it can be unit-tested.
// Palette is edited as one comma-separated text field (it is prose fed to the
// image generator, not a checklist of catalog names).

const DEFAULT_COLOR = '#888888';

function names(v) {
  return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : [];
}

export function emptyBiomeForm() {
  return {
    name: '', terrain_tiles: [], flora_types: [], creature_types: [],
    palette: '', art_style: '', exclusions: '', color: DEFAULT_COLOR,
  };
}

export function biomeToForm(row) {
  return {
    name: row?.name || '',
    terrain_tiles: names(row?.terrain_tiles),
    flora_types: names(row?.flora_types),
    creature_types: names(row?.creature_types),
    palette: names(row?.palette).join(', '),
    art_style: row?.art_style || '',
    exclusions: row?.exclusions || '',
    color: row?.color || DEFAULT_COLOR,
  };
}

export function biomeFormToPayload(form) {
  return {
    name: (form.name || '').trim(),
    terrain_tiles: names(form.terrain_tiles),
    flora_types: names(form.flora_types),
    creature_types: names(form.creature_types),
    palette: names((form.palette || '').split(',')),
    art_style: form.art_style || '',
    exclusions: form.exclusions || '',
    color: form.color || DEFAULT_COLOR,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/biomeForm.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the query hooks**

Create `frontend/src/games/something2/useBiomes.js`, copying the exact shape of `useMaps.js`'s tile-type hooks (same `apiFetch`, `authHeaders`, toast and invalidation conventions):

```js
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders, apiFetch } from "./src/js/net/auth.js";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:13101";

export function useBiomes() {
  const { data, isLoading } = useQuery({
    queryKey: ["biomes"],
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/biomes`);
      if (!res.ok) throw new Error("Failed to fetch biomes");
      return res.json();
    },
  });
  return { biomes: data || [], isLoadingBiomes: isLoading };
}

function biomeMutation({ method, url, successMessage, failMessage }) {
  return function useBiomeMutation() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: async (arg) => {
        const res = await apiFetch(url(arg), {
          method,
          headers: authHeaders(),
          body: method === "DELETE" ? undefined : JSON.stringify(arg.body ?? arg),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || failMessage);
        return res.status === 204 ? true : res.json();
      },
      onSuccess: () => { qc.invalidateQueries({ queryKey: ["biomes"] }); toast.success(successMessage); },
      onError: (err) => toast.error(err.message),
    });
  };
}

export const useCreateBiome = biomeMutation({
  method: "POST", url: () => `${API_URL}/api/biomes`,
  successMessage: "Biome created", failMessage: "Failed to create biome",
});
export const useUpdateBiome = biomeMutation({
  method: "PUT", url: (a) => `${API_URL}/api/biomes/${a.id}`,
  successMessage: "Biome saved", failMessage: "Failed to update biome",
});
export const useDeleteBiome = biomeMutation({
  method: "DELETE", url: (a) => `${API_URL}/api/biomes/${a.id}`,
  successMessage: "Biome deleted", failMessage: "Failed to delete biome",
});
```

Call `useUpdateBiome()` with `{ id, body: payload }` and `useDeleteBiome()` with `{ id }`.

- [ ] **Step 6: Write the BiomesAdmin component**

Create `frontend/src/games/something2/BiomesAdmin.jsx`. The styled-component vocabulary is copied from `MapsAdmin.jsx`, which is how each admin tab in this codebase defines its own:

```jsx
import { useState } from 'react';
import styled from 'styled-components';
import { HiOutlinePlus, HiOutlineTrash } from 'react-icons/hi2';
import { useTileTypes, useEntityTypes } from './useMaps.js';
import { useBiomes, useCreateBiome, useUpdateBiome, useDeleteBiome } from './useBiomes.js';
import { emptyBiomeForm, biomeToForm, biomeFormToPayload } from './biomeForm.js';

const AdminContainer = styled.div`
  padding: 2rem; color: #eee; max-width: 1200px; margin: 0 auto;
  height: 100%; overflow-y: auto; background-color: #1a1a2e;
`;
const Header = styled.div`display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;`;
const Button = styled.button`
  background: ${p => p.$bg || '#4a9eff'}; color: white; border: none; border-radius: 6px;
  padding: 0.5rem 1rem; font-weight: bold; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  &:disabled { opacity: 0.5; cursor: default; }
`;
const Card = styled.div`
  background: #23233f; border: 1px solid #333; border-radius: 8px; padding: 1rem; margin-bottom: 1rem;
`;
const Row = styled.div`display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin: 0.4rem 0;`;
const Input = styled.input`background: #12121f; color: #eee; border: 1px solid #333; border-radius: 4px; padding: 0.4rem;`;
const CheckGrid = styled.div`display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 0.4rem 0;`;
const Label = styled.span`color: #aaa; min-width: 90px;`;

const Swatch = styled.span`
  display: inline-block; width: 14px; height: 14px; border-radius: 3px;
  border: 1px solid #555; background: ${p => p.$color};
`;

// One checkbox row bound to a string-array field of the form.
function NameChecks({ options, selected, onToggle }) {
  return (
    <CheckGrid>
      {options.map(name => (
        <label key={name} style={{ color: '#ccc' }}>
          <input type="checkbox" checked={selected.includes(name)} onChange={() => onToggle(name)} /> {name}
        </label>
      ))}
    </CheckGrid>
  );
}

function BiomeCard({ biome, tileNames, floraNames, creatureNames }) {
  const [form, setForm] = useState(() => (biome ? biomeToForm(biome) : emptyBiomeForm()));
  const create = useCreateBiome();
  const update = useUpdateBiome();
  const del = useDeleteBiome();
  const isNew = !biome;

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const toggle = (k) => (name) => setForm(f => ({
    ...f,
    [k]: f[k].includes(name) ? f[k].filter(n => n !== name) : [...f[k], name],
  }));

  const save = () => {
    const payload = biomeFormToPayload(form);
    if (isNew) create.mutate(payload, { onSuccess: () => setForm(emptyBiomeForm()) });
    else update.mutate({ id: biome.id, body: payload });
  };

  return (
    <Card>
      <Row>
        <Swatch $color={form.color} />
        <Input placeholder="Biome name" value={form.name} onChange={e => set('name', e.target.value)} />
        <input type="color" value={form.color} onChange={e => set('color', e.target.value)}
          title="Display colour (admin lists and map markers)" />
        {!isNew && (
          <HiOutlineTrash style={{ color: '#ef4444', cursor: 'pointer', marginLeft: 'auto' }}
            title="Delete biome"
            onClick={() => window.confirm(`Delete biome "${biome.name}"?`) && del.mutate({ id: biome.id })} />
        )}
      </Row>

      <Row><Label>Terrain</Label></Row>
      <NameChecks options={tileNames} selected={form.terrain_tiles} onToggle={toggle('terrain_tiles')} />

      <Row><Label>Flora</Label></Row>
      <NameChecks options={floraNames} selected={form.flora_types} onToggle={toggle('flora_types')} />

      <Row><Label>Creatures</Label></Row>
      <NameChecks options={creatureNames} selected={form.creature_types} onToggle={toggle('creature_types')} />

      <Row>
        <Label>Palette</Label>
        <Input style={{ flex: 1, minWidth: 260 }} placeholder="ochre, gold, burnt sienna"
          value={form.palette} onChange={e => set('palette', e.target.value)} />
      </Row>
      <Row>
        <Label>Art style</Label>
        <Input style={{ flex: 1, minWidth: 260 }} placeholder="sun-bleached hand-drawn fantasy, harsh light"
          value={form.art_style} onChange={e => set('art_style', e.target.value)} />
      </Row>
      <Row>
        <Label>Exclusions</Label>
        <Input style={{ flex: 1, minWidth: 260 }} placeholder="no grass, no snow"
          value={form.exclusions} onChange={e => set('exclusions', e.target.value)} />
      </Row>
      <Row>
        <Button onClick={save} disabled={create.isPending || update.isPending}>
          {isNew ? <><HiOutlinePlus /> Create biome</> : 'Save'}
        </Button>
        <span style={{ color: '#888', fontSize: '0.85em' }}>
          Palette, art style and exclusions are composed into image-generation prompts.
        </span>
      </Row>
    </Card>
  );
}

function BiomesAdmin() {
  const { biomes, isLoadingBiomes } = useBiomes();
  const { tileTypes } = useTileTypes();
  const { entityTypes } = useEntityTypes();

  const tileNames = (tileTypes || []).map(t => t.name);
  const floraNames = (entityTypes || []).filter(e => !e.is_creature).map(e => e.name);
  const creatureNames = (entityTypes || []).filter(e => e.is_creature).map(e => e.name);
  const lists = { tileNames, floraNames, creatureNames };

  if (isLoadingBiomes) return <AdminContainer>Loading biomes…</AdminContainer>;

  return (
    <AdminContainer>
      <Header><h2>Biomes</h2></Header>
      <BiomeCard biome={null} {...lists} />
      {biomes.length === 0 && <p style={{ color: '#888' }}>No biomes yet. Create one above.</p>}
      {biomes.map(b => <BiomeCard key={b.id} biome={b} {...lists} />)}
    </AdminContainer>
  );
}

export default BiomesAdmin;
```

(`useTileTypes()` returns `{ tileTypes, isLoadingTileTypes }` and `useEntityTypes()` returns `{ entityTypes, isLoadingEntityTypes }` — both may be `undefined` on first render, hence the `|| []` guards.)

- [ ] **Step 7: Write the component smoke test**

Create `frontend/src/games/something2/__tests__/BiomesAdmin.smoke.test.js`, matching `MapsAdmin.smoke.test.js`:

```js
import { describe, it, expect } from 'vitest';
import BiomesAdmin from '../BiomesAdmin.jsx';

describe('BiomesAdmin', () => {
  it('is a component export', () => {
    expect(typeof BiomesAdmin).toBe('function');
  });
});
```

- [ ] **Step 8: Add the tab**

In `frontend/src/games/something2/Something2.jsx`:

1. Add `HiOutlineGlobeAlt` to the `react-icons/hi2` import on line 4.
2. Add `import BiomesAdmin from "./BiomesAdmin";` beside the other admin imports (~line 17).
3. After the Maps `TabButton` (~line 662-664), add:
```jsx
            <TabButton $active={activeTab === 'biomes'} $adminType="maps" onClick={() => setActiveTab('biomes')}>
              <HiOutlineGlobeAlt /> Biomes
            </TabButton>
```
4. After the `MapsAdmin` render line (~line 847), add:
```jsx
        {isAdmin && activeTab === 'biomes' && <BiomesAdmin />}
```

- [ ] **Step 9: Add the per-world biome set to MapsAdmin**

In `frontend/src/games/something2/MapsAdmin.jsx`:

1. Import the biome hook: `import { useBiomes } from './useBiomes.js';`
2. In `MapsAdmin()`, call `const { biomes } = useBiomes();` and pass `biomes={biomes}` down to each `<MapCard>`.
3. In `MapCard({ world, creatureTypes, allMaps, biomes })`, add state beside the existing `allowed` state:
```jsx
  const [worldBiomes, setWorldBiomes] = useState(new Set(world.biomes || []));
  const [biomeCell, setBiomeCell] = useState(world.biome_cell ?? '');
  const toggleBiome = (n) => setWorldBiomes(prev => {
    const next = new Set(prev); next.has(n) ? next.delete(n) : next.add(n); return next;
  });
```
4. Extend `save()` to send both fields:
```jsx
  const save = () => update.mutate({
    id: world.id, name, width: world.width, height: world.height,
    creature_count: Number(count), allowed_creature_types: [...allowed],
    is_entry: isEntry, entry_spawn: isEntry ? { x: Number(spawnX), y: Number(spawnY) } : null,
    biomes: [...worldBiomes],
    biome_cell: biomeCell === '' ? null : Number(biomeCell),
  });
```
5. Add a row above the existing Links row:
```jsx
      <Row>
        <span style={{ color: '#aaa' }}>Biomes:</span>
        {(biomes || []).map(b => (
          <label key={b.id} style={{ color: '#ccc' }}>
            <input type="checkbox" checked={worldBiomes.has(b.name)} onChange={() => toggleBiome(b.name)} />
            <span style={{ display: 'inline-block', width: 10, height: 10, background: b.color, marginLeft: 4, marginRight: 3 }} />
            {b.name}
          </label>
        ))}
        <span style={{ color: '#888' }}>region size</span>
        <Input type="number" min="8" placeholder="auto" value={biomeCell} style={{ width: 80 }}
          onChange={e => setBiomeCell(e.target.value)} />
      </Row>
      <Row>
        <span style={{ color: '#f59e0b', fontSize: '0.85em' }}>
          Changing biomes or region size regenerates this map's terrain and clears its cached chunks.
        </span>
      </Row>
```

- [ ] **Step 10: Run the frontend suite**

Run: `cd frontend && npm test`
Expected: all pass, including the two new files.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/games/something2/
git commit -m "feat(biomes): Biomes admin tab + per-world biome set in the maps editor"
```

---

### Task 10: Browser verification

**Files:** none (verification only; any defect found is fixed in the file that owns it).

**Interfaces:**
- Consumes: everything from Tasks 1-9.
- Produces: a written verification result appended to this task's report.

This gate exists because a green suite has repeatedly missed defects that were obvious in the browser (see the `browser-verification-lessons` memory). Do not skip it and do not substitute a unit test for it.

- [ ] **Step 1: Bring the stack up and apply the migration**

```bash
docker compose --env-file .env up -d
docker compose exec backend npm run migrate:up
```

Confirm `1714440043000_biomes` is listed as applied. If the backend container's CMD is a stub in this compose file, run the migration from the host against the same DB instead.

- [ ] **Step 2: Confirm the seed landed**

```bash
curl -s http://localhost:13101/api/biomes | head -c 800
```
Expected: five biomes — Meadow, Deep Forest, Arid Dunes, Frozen Waste, Mire — with populated `terrain_tiles`, `palette`, `art_style`, `exclusions`.

- [ ] **Step 3: Confirm back-compat on a live world**

Pick an existing world id from `curl -s http://localhost:13101/api/worlds`, then:

```bash
curl -s "http://localhost:13101/api/worlds/<ID>/chunk?cx=0&cy=0" > /tmp/chunk-before.json
```

Compare it against the same request captured from `main` (check out `main` in a second worktree, run the backend there, or capture this file *before* deploying the branch). The grids must be identical — the world has no biome set, so nothing may change.

- [ ] **Step 4: Assign biomes to a test world**

In the browser at `http://localhost:15173`, sign in as admin, open the **Biomes** tab and confirm all five biomes render with their colour swatches, tile/flora/creature checklists, palette, art style and exclusions. Edit one field, save, reload — the change persists.

Then open **Maps**, pick a bounded test world (not the entry world), tick **Arid Dunes** and **Frozen Waste**, leave region size blank (auto), and Save.

- [ ] **Step 5: Walk the world**

Enter that world and walk across it. Verify:
- Terrain reads as two distinct regions — a sand/rocks/dirt zone and a snow/ice/rocks zone — not an even mix of all eleven tiles.
- **No excluded tile leaks:** no grass, no swamp, no water anywhere in either region.
- The border between regions is a continuous line, not a checkerboard, and shows no seam at chunk boundaries.
- Decorations match their region (dead trees and stones in the dunes; ice rocks and pines in the waste) and none of the other biome's flora appears.
- Movement is smooth at region borders — **no rubber-banding**, which would mean the client and the authority disagree about terrain or blocked tiles.

- [ ] **Step 6: Confirm the cache invalidation actually fired**

Change that world's biome set again (drop one biome), save, re-enter, and confirm the terrain changes immediately rather than serving the previous layout. Then check the backend log for the live-world warning.

- [ ] **Step 7: Confirm the guards**

- In **TILE_TYPES Admin**, try renaming `sand` → expect a refusal mentioning the biome that lists it.
- In **Entity Admin**, try renaming `dead_tree` → expect a refusal.
- In **Biomes**, try deleting **Arid Dunes** while the test world still lists it → expect a refusal naming that world. Untick it in Maps, save, then delete succeeds.

- [ ] **Step 8: Confirm biome-composed generation**

Trigger a tile generation for `sand` with **Arid Dunes** selected and check the backend log / sprite-gen job payload: the forwarded `base_prompt` must contain `ochre, gold, burnt sienna palette`, `sun-bleached hand-drawn fantasy, harsh light` and `Avoid: no grass, no snow, no ice, no leaves`. (The image itself takes ~66s on CPU and does not need to finish for this check.)

- [ ] **Step 9: Run both suites one final time**

```bash
cd backend && npm test
cd ../frontend && npm test
```
Expected: both green.

- [ ] **Step 10: Record the result**

Write what you observed for each step above into the task report — including anything that did NOT work. A step you could not perform must be reported as not performed, never as passed.

---

## Notes for the executor

- **If the back-compat golden test in Task 3 fails after your edit, the edit is wrong.** Do not regenerate the fixture to make it pass; that deletes the only evidence the legacy path is intact.
- **Do not add a `sampleBiome` or `cfg.biomeNames` compatibility alias.** The whole point of the rename is that "biome" now means one thing.
- **When a mock pool in an existing test throws `unexpected query: SELECT … FROM biomes`,** add a handler returning `{ rows: [] }`. Never relax the mock's throw-on-unknown behaviour — it is what proves a handler queries what it claims.
- **New decoration types have no sprites yet** (`bush`, `rose_bush`, `pine_tree`, `dead_tree` render as coloured placeholder boxes until the user generates images locally). That is expected and is not a defect to fix.
