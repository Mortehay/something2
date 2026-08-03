# Map Seed Tooling & map-planner Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make maps and their catalogs re-seedable from checked-in spec files, and give Claude a `map-planner` skill that authors grid-consistent adventure maps and applies them.

**Architecture:** A map spec is JSON where every world carries a `grid: [x, y]`. A pure validator proves the spec's `N/E/S/W` links agree with that grid before anything is written; the same grid seeds `graph_x`/`graph_y` so the World Map tab draws the map consistently with its links. An idempotent applier upserts worlds by name inside one transaction. Catalog seed data moves out of one-shot migrations into shared modules that both the migrations and a new seeder import.

**Tech Stack:** Node 20 CommonJS, `pg`, `node:test` (`node --test`), node-pg-migrate, GNU make.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-01-map-seed-tooling-design.md`. Read it before Task 1.
- **Backend is CommonJS** (`require`/`module.exports`), not ESM. Backend tests use `node:test` + `node:assert`, run with `npm test` from `backend/`. The frontend's vitest is irrelevant here.
- Baseline before any change: `cd backend && npm test` — record the count in Task 0 and keep it green.
- **Database-backed tests must SKIP when no database is reachable, and FAIL under `CI`.** Copy the harness in `backend/tests/creature_drops_db.test.js:29-42` exactly. A skip reads like a pass in the summary; treat it as "unknown".
- **`N` is `-y`.** `edgeOfDoorwayTile` (`backend/src/services/mapService.js:724`) defines `N` as `gRow === 0`, the top row. Every grid delta in this plan follows from that.
- Migrations are immutable in behaviour: they have already run on existing databases. Moving a constant out of one is fine *only* if the data is byte-identical.
- Scripts run host-side (`node backend/scripts/…`), matching `make admin-password` (`Makefile:83-84`).
- Never `git checkout --` a file to undo a mutation test while your own work in it is uncommitted — commit first, or you will destroy it.

## Two corrections to the spec, discovered while writing this plan

Both are settled here; implement the corrected version.

1. **The spec's example village is invalid.** It shows `"width": 20, "height": 20`, but `validateVillageBody` (`backend/src/index.js:1804-1806`) enforces `width` 3–8 and `height` 3–6 tiles. Example specs must use sizes in range; the validator must enforce the same bounds.
2. **Creating a village is not one INSERT.** The `POST /api/worlds/:id/villages` route (`index.js:1872-1882`) also calls `insertVillageGuards()` and `seedBaseCatalog()` — a village without those has no gate guards and an empty merchant. `insertVillageGuards` is a private function in `index.js`, so Task 5 extracts it to a service that both the route and the applier call. Without that, seeded villages are silently broken.

---

### Task 0: Branch and baseline

- [ ] **Step 1: Confirm the branch**

The spec is already committed on `feat/map-seed-tooling`.

```bash
cd /home/markunn/worker/coding/jsgame/something2
git branch --show-current   # expect: feat/map-seed-tooling
```

- [ ] **Step 2: Record the baseline**

```bash
cd backend && npm test 2>&1 | tail -5
```

Write the pass/fail counts into your report. Every later task must keep them green.

---

### Task 1: Extract catalog seed data to shared modules

**Files:**
- Create: `backend/seeds/data/biomes.js`, `backend/seeds/data/decorationTypes.js`, `backend/seeds/data/tileTypes.js`
- Modify: `backend/migrations/1714440043000_biomes.js`, `backend/migrations/1714440042000_decoration_types.js`
- Modify: `backend/tests/biomes_seed.test.js:3` (import path only)
- Test: `backend/tests/catalog_seed_data.test.js`

**Interfaces:**
- Produces: `STARTER_BIOMES` from `seeds/data/biomes.js`; `NEW_DECORATIONS`, `SIZE_FIXES` from `seeds/data/decorationTypes.js`; `DEFAULT_TILE_TYPES` from `seeds/data/tileTypes.js` (array of `{ name, color, walkable, speed, image, valid_neighbors }`).

`biomes` and `decoration_types` already export their arrays, so they move wholesale. `tile_types` does not: its data is a `defaultTileTypes` object literal *inside* `exports.up` in `1714440002000_create_tile_types.js`, and two further migrations add tiles with raw SQL. So `tileTypes.js` is a **new consolidated file**, the three migrations stay untouched, and a test pins the relationship.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/catalog_seed_data.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
const { NEW_DECORATIONS } = require('../seeds/data/decorationTypes.js');

// Tile names inserted by the three migrations that seed tile_types:
//   1714440002000_create_tile_types.js  (the defaultTileTypes object)
//   1714440027000_bounded_worlds.js     (map_wall, map_doorway)
//   1714440029000_villages_and_binds.js (wooden_wall, village_gate)
// The seeder upserts by name and therefore becomes authoritative on a fresh
// database. If it is missing a tile the migrations create, a `make
// seed-catalogs` run would leave a gap that only shows up as an invisible
// fallback colour in a rendered world -- so pin the superset relationship.
const MIGRATION_TILE_NAMES = [
  'grass', 'highgrass', 'leafs', 'sand', 'rocks', 'earth', 'dirt',
  'snow', 'ice', 'swamp', 'water',
  'map_wall', 'map_doorway',
  'wooden_wall', 'village_gate',
];

test('the tile seed file is a superset of every migration-seeded tile', () => {
  const seeded = new Set(DEFAULT_TILE_TYPES.map((t) => t.name));
  const missing = MIGRATION_TILE_NAMES.filter((n) => !seeded.has(n));
  assert.deepEqual(missing, [], `tile seed file is missing: ${missing.join(', ')}`);
});

test('every tile seed row is fully formed', () => {
  assert.ok(DEFAULT_TILE_TYPES.length > 0, 'no tiles — this test would assert nothing');
  for (const t of DEFAULT_TILE_TYPES) {
    assert.ok(t.name, 'tile has no name');
    assert.match(t.color, /^#[0-9a-fA-F]{6}$/, `${t.name} colour is not a 6-digit hex`);
    assert.equal(typeof t.walkable, 'boolean', `${t.name} walkable must be boolean`);
    assert.equal(typeof t.speed, 'number', `${t.name} speed must be a number`);
    assert.ok(Array.isArray(t.valid_neighbors), `${t.name} valid_neighbors must be an array`);
  }
});

test('the moved catalog arrays are still intact', () => {
  assert.equal(STARTER_BIOMES.length, 5);
  assert.ok(NEW_DECORATIONS.length > 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && node --test tests/catalog_seed_data.test.js`
Expected: FAIL — `Cannot find module '../seeds/data/tileTypes.js'`

- [ ] **Step 3: Create the tile seed file**

Create `backend/seeds/data/tileTypes.js`. Copy each tile's `color`, `walkable`, `speed`, `image` and `validNeighbors` **verbatim** from the `defaultTileTypes` object in `backend/migrations/1714440002000_create_tile_types.js`, and the four extra tiles from `MAP_TILE_TYPES` in `1714440027000_bounded_worlds.js` and `VILLAGE_TILE_TYPES` in `1714440029000_villages_and_binds.js`. Read all three files first; do not invent values.

```js
// The authoritative tile_types catalog for `make seed-catalogs`.
//
// Unlike biomes and decoration_types, this data could not simply be moved out
// of its migration: it lives as an object literal INSIDE
// 1714440002000_create_tile_types.js's `up`, and two later migrations
// (1714440027000_bounded_worlds, 1714440029000_villages_and_binds) add more
// tiles with raw SQL. Consolidating them here and leaving those migrations
// untouched keeps migration behaviour identical on existing databases while
// giving the seeder one place to read. catalog_seed_data.test.js pins this
// file as a superset of what those migrations insert.
const DEFAULT_TILE_TYPES = [
  { name: 'grass', color: '#...', walkable: true, speed: 1.0, image: '', valid_neighbors: [...] },
  // ... every tile, values copied verbatim from the three migrations ...
];

module.exports = { DEFAULT_TILE_TYPES };
```

- [ ] **Step 4: Move the biome and decoration arrays**

Create `backend/seeds/data/biomes.js` holding `STARTER_BIOMES` moved verbatim (including its explanatory comment) from `1714440043000_biomes.js`, and `backend/seeds/data/decorationTypes.js` holding `NEW_DECORATIONS` and `SIZE_FIXES` moved from `1714440042000_decoration_types.js`.

Then in each migration, replace the moved literal with a require and keep the existing re-export so nothing downstream breaks:

```js
// Data moved to backend/seeds/data/biomes.js so `make seed-catalogs` and this
// migration cannot drift apart. Re-exported because biomes_seed.test.js and
// the seeder both read it. Migration behaviour is unchanged: the array is
// byte-identical and migrations only ever run once.
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
```

Keep `exports.STARTER_BIOMES = STARTER_BIOMES;` at the bottom of the migration.

- [ ] **Step 5: Repoint the existing biome test**

In `backend/tests/biomes_seed.test.js` line 3, change the import from the migration to `../seeds/data/biomes.js`. Change nothing else in that file — its assertions must still pass unmodified, which is the proof the move was faithful.

- [ ] **Step 6: Run the full suite**

Run: `cd backend && npm test 2>&1 | tail -5`
Expected: baseline count + 3 new tests, all passing. `biomes_seed.test.js` must pass **without any assertion changed**.

- [ ] **Step 7: Commit**

```bash
git add backend/seeds/data backend/migrations/1714440042000_decoration_types.js \
        backend/migrations/1714440043000_biomes.js \
        backend/tests/biomes_seed.test.js backend/tests/catalog_seed_data.test.js
git commit -m "refactor(seeds): lift catalog seed data out of one-shot migrations"
```

---

### Task 2: Catalog seeder and `make seed-catalogs`

**Files:**
- Create: `backend/scripts/seed-catalogs.js`
- Modify: `Makefile`
- Test: `backend/tests/seed_catalogs_db.test.js`

**Interfaces:**
- Consumes: `DEFAULT_TILE_TYPES`, `STARTER_BIOMES`, `NEW_DECORATIONS` (Task 1).
- Produces: `seedCatalogs(pool) => { tiles: n, biomes: n, decorations: n }`, exported from the script for testing.

Upsert by name; **never delete**. A tile or biome an admin added through the UI must survive.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/seed_catalogs_db.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { seedCatalogs } = require('../scripts/seed-catalogs.js');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');

// Skips without a database, FAILS under CI — same posture as
// creature_drops_db.test.js. A skip reads like a pass; treat it as unknown.
const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await pool.query('SELECT 1'); return pool; }
  catch (err) { await pool.end().catch(() => {}); return { unreachable: err.message }; }
}

test('seeding catalogs twice is a no-op the second time', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — catalog seeding is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await seedCatalogs(pool);
    const after1 = await pool.query('SELECT name, color, walkable, speed FROM tile_types ORDER BY name');
    await seedCatalogs(pool);
    const after2 = await pool.query('SELECT name, color, walkable, speed FROM tile_types ORDER BY name');

    assert.deepEqual(after2.rows, after1.rows, 'second seed changed tile_types');
    assert.ok(after1.rowCount >= DEFAULT_TILE_TYPES.length,
      'fewer tiles than the seed file defines — the upsert did not apply');
  } finally { await pool.end(); }
});

test('seeding does not delete a hand-added tile type', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — hand-added-tile survival is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const CANARY = 'zz_seed_canary_tile';
  try {
    await pool.query(
      `INSERT INTO tile_types (name, color, walkable, speed, image, valid_neighbors)
       VALUES ($1, '#123456', true, 1.0, '', '[]') ON CONFLICT (name) DO NOTHING`, [CANARY]);
    await seedCatalogs(pool);
    const r = await pool.query('SELECT 1 FROM tile_types WHERE name = $1', [CANARY]);
    assert.equal(r.rowCount, 1, 'seeding deleted a tile type it did not create');
  } finally {
    await pool.query('DELETE FROM tile_types WHERE name = $1', [CANARY]).catch(() => {});
    await pool.end();
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && node --test tests/seed_catalogs_db.test.js`
Expected: FAIL — `Cannot find module '../scripts/seed-catalogs.js'`

- [ ] **Step 3: Write the seeder**

Create `backend/scripts/seed-catalogs.js`:

```js
#!/usr/bin/env node
// Upsert the tile / biome / decoration catalogs. Run via `make seed-catalogs`.
//
// UPSERT BY NAME, NEVER DELETE. The admin UI is the intended way to author
// catalog entries; the seed files are a floor, not a replacement. A run of this
// script must never cost an admin a tile they added by hand.
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
const { NEW_DECORATIONS } = require('../seeds/data/decorationTypes.js');

async function seedCatalogs(pool) {
  let tiles = 0;
  for (const t of DEFAULT_TILE_TYPES) {
    await pool.query(
      `INSERT INTO tile_types (name, color, walkable, speed, image, valid_neighbors)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (name) DO UPDATE
         SET color = EXCLUDED.color, walkable = EXCLUDED.walkable,
             speed = EXCLUDED.speed, valid_neighbors = EXCLUDED.valid_neighbors`,
      [t.name, t.color, t.walkable, t.speed, t.image ?? '', JSON.stringify(t.valid_neighbors ?? [])],
    );
    tiles += 1;
  }

  let biomes = 0;
  for (const b of STARTER_BIOMES) {
    await pool.query(
      `INSERT INTO biomes (name, terrain_tiles, flora_types, creature_types, palette, art_style, exclusions, color)
       VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8)
       ON CONFLICT (name) DO UPDATE
         SET terrain_tiles = EXCLUDED.terrain_tiles, flora_types = EXCLUDED.flora_types,
             creature_types = EXCLUDED.creature_types, palette = EXCLUDED.palette,
             art_style = EXCLUDED.art_style, exclusions = EXCLUDED.exclusions,
             color = EXCLUDED.color`,
      [b.name, JSON.stringify(b.terrain_tiles), JSON.stringify(b.flora_types),
       JSON.stringify(b.creature_types), JSON.stringify(b.palette),
       b.art_style, b.exclusions, b.color],
    );
    biomes += 1;
  }

  let decorations = 0;
  for (const d of NEW_DECORATIONS) {
    // Column list must match 1714440042000_decoration_types.js — read it and
    // mirror its INSERT exactly rather than guessing field names.
    decorations += 1;
  }

  return { tiles, biomes, decorations };
}

module.exports = { seedCatalogs };

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set in .env'); process.exit(1); }
  const pool = new Pool({ connectionString: url });
  seedCatalogs(pool)
    .then((n) => { console.log(`seeded ${n.tiles} tiles, ${n.biomes} biomes, ${n.decorations} decorations`); })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
```

**Before writing the decoration branch**, open `backend/migrations/1714440042000_decoration_types.js` and mirror its INSERT's exact column list and value shapes. Do not guess.

- [ ] **Step 4: Verify the test passes**

Run: `cd backend && node --test tests/seed_catalogs_db.test.js`
Expected: PASS (or SKIP with a clear "NO DATABASE" message if Postgres is not up — if it skips, start the stack with `make up` and re-run; a skip proves nothing).

- [ ] **Step 5: Add the make target**

In `Makefile`, add `seed-catalogs` to the `.PHONY` list and append:

```make
# Upsert the tile / biome / decoration catalogs. Idempotent and NON-destructive:
# it never deletes, so a tile or biome added by hand in the admin UI survives.
seed-catalogs:
	node backend/scripts/seed-catalogs.js
```

- [ ] **Step 6: Run it for real**

Run: `make seed-catalogs`
Expected: a count line, exit 0. Run it a second time and confirm the same output and no error.

- [ ] **Step 7: Commit**

```bash
git add backend/scripts/seed-catalogs.js backend/tests/seed_catalogs_db.test.js Makefile
git commit -m "feat(seeds): add an idempotent catalog seeder"
```

---

### Task 3: The map spec validator

**Files:**
- Create: `backend/seeds/mapSpec.js`
- Test: `backend/tests/map_spec_validate.test.js`

**Interfaces:**
- Produces:
  - `EDGE_DELTA = { N: [0,-1], S: [0,1], E: [1,0], W: [-1,0] }`
  - `validateMapSpec(spec, { biomeNames, creatureTypeNames }) => string[]` — human-readable errors, empty array means valid. When `biomeNames` / `creatureTypeNames` are `null` or omitted, the catalog cross-checks are skipped so the function stays testable without a database.

This is the safety net for the whole feature. It runs before any write.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/map_spec_validate.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { validateMapSpec, EDGE_DELTA } = require('../seeds/mapSpec.js');

// A minimal two-world spec that is VALID: `b` sits one cell east of `a`,
// and the link from a to b is edge E. Every negative case below is this
// object with exactly one thing broken, so a failure names one cause.
const valid = () => ({
  name: 'fixture',
  topology: 'spine',
  worlds: [
    { key: 'a', name: 'Alpha', grid: [0, 0], seed: 1, width: 64, height: 64,
      chunk_size: 64, biomes: ['Meadow'], biome_cell: 32, creature_count: 1,
      allowed_creature_types: ['Slime'], is_entry: true,
      entry_spawn: { x: 32, y: 32 } },
    { key: 'b', name: 'Beta', grid: [1, 0], seed: 2, width: 64, height: 64,
      chunk_size: 64, biomes: ['Meadow'], biome_cell: 32, creature_count: 3,
      allowed_creature_types: ['Wolf'], is_entry: false },
  ],
  links: [{ from: 'a', edge: 'E', to: 'b' }],
});

const errorsFor = (mutate) => {
  const spec = valid();
  mutate(spec);
  return validateMapSpec(spec);
};

test('N is -y and S is +y, matching edgeOfDoorwayTile', () => {
  // mapService.js:724 defines N as gRow === 0, the TOP row. If this ever
  // flips, every generated map arrives through the wrong doorway.
  assert.deepEqual(EDGE_DELTA.N, [0, -1]);
  assert.deepEqual(EDGE_DELTA.S, [0, 1]);
  assert.deepEqual(EDGE_DELTA.E, [1, 0]);
  assert.deepEqual(EDGE_DELTA.W, [-1, 0]);
});

test('accepts a well-formed spec', () => {
  assert.deepEqual(validateMapSpec(valid()), []);
});

test('rejects an edge that contradicts the grid', () => {
  // b is EAST of a, so claiming the link is N must fail.
  const errs = errorsFor((s) => { s.links[0].edge = 'N'; });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /edge N.*grid/i);
});

test('rejects a link between non-adjacent cells', () => {
  const errs = errorsFor((s) => { s.worlds[1].grid = [5, 0]; });
  assert.ok(errs.some((e) => /adjacent/i.test(e)), errs.join('; '));
});

test('rejects two worlds in the same grid cell', () => {
  const errs = errorsFor((s) => { s.worlds[1].grid = [0, 0]; });
  assert.ok(errs.some((e) => /same grid cell|occupied/i.test(e)), errs.join('; '));
});

test('rejects two links leaving one world by the same edge', () => {
  const errs = errorsFor((s) => {
    s.worlds.push({ key: 'c', name: 'Gamma', grid: [0, 1], seed: 3, width: 64, height: 64,
      chunk_size: 64, biomes: ['Meadow'], biome_cell: 32, creature_count: 1,
      allowed_creature_types: ['Slime'], is_entry: false });
    s.links.push({ from: 'a', edge: 'E', to: 'c' });   // E is already taken
  });
  assert.ok(errs.some((e) => /already has a link on edge E|duplicate edge/i.test(e)), errs.join('; '));
});

test('rejects a five-spoke hub, because UNIQUE(from_world_id, edge) allows four', () => {
  const spec = valid();
  spec.worlds = [spec.worlds[0]];
  spec.links = [];
  const cells = [[1, 0], [-1, 0], [0, -1], [0, 1], [2, 0]];
  const edges = ['E', 'W', 'N', 'S', 'E'];
  cells.forEach(([x, y], i) => {
    spec.worlds.push({ key: `s${i}`, name: `Spoke ${i}`, grid: [x, y], seed: 10 + i,
      width: 64, height: 64, chunk_size: 64, biomes: ['Meadow'], biome_cell: 32,
      creature_count: 1, allowed_creature_types: ['Slime'], is_entry: false });
    spec.links.push({ from: 'a', edge: edges[i], to: `s${i}` });
  });
  assert.ok(validateMapSpec(spec).length > 0, 'a 5th spoke must be rejected');
});

test('rejects zero entries and more than one entry', () => {
  assert.ok(errorsFor((s) => { s.worlds[0].is_entry = false; })
    .some((e) => /exactly one .*is_entry/i.test(e)));
  assert.ok(errorsFor((s) => { s.worlds[1].is_entry = true; })
    .some((e) => /exactly one .*is_entry/i.test(e)));
});

test('rejects duplicate keys and duplicate names', () => {
  assert.ok(errorsFor((s) => { s.worlds[1].key = 'a'; }).some((e) => /duplicate key/i.test(e)));
  assert.ok(errorsFor((s) => { s.worlds[1].name = 'Alpha'; }).some((e) => /duplicate name/i.test(e)));
});

test('rejects a link referencing an unknown key', () => {
  assert.ok(errorsFor((s) => { s.links[0].to = 'nope'; }).some((e) => /unknown/i.test(e)));
});

test('rejects a world unreachable from the entry', () => {
  const errs = errorsFor((s) => { s.links = []; });
  assert.ok(errs.some((e) => /unreachable|not reachable/i.test(e)), errs.join('; '));
});

test('rejects a village outside the size limits the API enforces', () => {
  // index.js validateVillageBody: width 3-8, height 3-6.
  const errs = errorsFor((s) => {
    s.worlds[0].village = { min_row: 4, min_col: 4, width: 20, height: 20,
      gate_edge: 'S', spawn_x: 500, spawn_y: 600 };
  });
  assert.ok(errs.some((e) => /width must be between 3 and 8/i.test(e)), errs.join('; '));
});

test('cross-checks catalog names only when catalogs are supplied', () => {
  const spec = valid();
  assert.deepEqual(validateMapSpec(spec), [], 'no catalogs supplied -> no catalog errors');
  const errs = validateMapSpec(spec, {
    biomeNames: new Set(['Mire']), creatureTypeNames: new Set(['Slime', 'Wolf']),
  });
  assert.ok(errs.some((e) => /Meadow/.test(e)), errs.join('; '));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && node --test tests/map_spec_validate.test.js`
Expected: FAIL — `Cannot find module '../seeds/mapSpec.js'`

- [ ] **Step 3: Write the validator**

Create `backend/seeds/mapSpec.js`:

```js
// Validation for map specs. Pure: no database, no I/O, so the whole rule set is
// unit-testable. The applier refuses to write anything when this returns a
// non-empty array.
//
// WHY THE GRID EXISTS: map_links declares UNIQUE(from_world_id, edge) over
// edge IN ('N','E','S','W'), and setLink writes the mirror edge automatically.
// So a world has at most four neighbours and an adventure map must embed in a
// 2D grid. Checking every link against that grid here is what makes a seeded
// map geometrically consistent -- and it is the same grid that seeds
// graph_x/graph_y, so the World Map tab cannot draw it contradicting its links.
//
// N is -y: edgeOfDoorwayTile (services/mapService.js:724) defines N as
// gRow === 0, the top row.
const EDGE_DELTA = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };

// Mirrors validateVillageBody in src/index.js. Duplicated deliberately: this
// runs with no database and no request, and a spec that passes here must not
// then be rejected by the API's own rules.
const VILLAGE_LIMITS = { minW: 3, maxW: 8, minH: 3, maxH: 6 };

function validateMapSpec(spec, { biomeNames = null, creatureTypeNames = null } = {}) {
  const errors = [];
  if (!spec || typeof spec !== 'object') return ['spec is not an object'];
  const worlds = Array.isArray(spec.worlds) ? spec.worlds : [];
  const links = Array.isArray(spec.links) ? spec.links : [];
  if (worlds.length === 0) return ['spec has no worlds'];

  const byKey = new Map();
  const seenNames = new Set();
  const cells = new Map();

  for (const w of worlds) {
    if (byKey.has(w.key)) errors.push(`duplicate key "${w.key}"`);
    byKey.set(w.key, w);
    if (seenNames.has(w.name)) errors.push(`duplicate name "${w.name}"`);
    seenNames.add(w.name);

    if (!Array.isArray(w.grid) || w.grid.length !== 2
        || !Number.isInteger(w.grid[0]) || !Number.isInteger(w.grid[1])) {
      errors.push(`world "${w.key}" grid must be two integers`);
      continue;
    }
    const cell = `${w.grid[0]},${w.grid[1]}`;
    if (cells.has(cell)) {
      errors.push(`worlds "${cells.get(cell)}" and "${w.key}" occupy the same grid cell ${cell}`);
    }
    cells.set(cell, w.key);

    if (w.village) {
      const v = w.village;
      if (!(v.width >= VILLAGE_LIMITS.minW && v.width <= VILLAGE_LIMITS.maxW)) {
        errors.push(`world "${w.key}" village width must be between 3 and 8 tiles`);
      }
      if (!(v.height >= VILLAGE_LIMITS.minH && v.height <= VILLAGE_LIMITS.maxH)) {
        errors.push(`world "${w.key}" village height must be between 3 and 6 tiles`);
      }
      if (!['N', 'E', 'S', 'W'].includes(v.gate_edge)) {
        errors.push(`world "${w.key}" village gate_edge must be one of N,E,S,W`);
      }
    }

    if (biomeNames) {
      for (const b of w.biomes ?? []) {
        if (!biomeNames.has(b)) errors.push(`world "${w.key}" references unknown biome "${b}"`);
      }
    }
    if (creatureTypeNames) {
      for (const c of w.allowed_creature_types ?? []) {
        if (!creatureTypeNames.has(c)) {
          errors.push(`world "${w.key}" references unknown creature type "${c}"`);
        }
      }
    }
  }

  const entries = worlds.filter((w) => w.is_entry === true);
  if (entries.length !== 1) {
    errors.push(`spec must have exactly one world with is_entry: true (found ${entries.length})`);
  }

  const usedEdges = new Set();
  const adjacency = new Map(worlds.map((w) => [w.key, []]));
  for (const l of links) {
    const from = byKey.get(l.from);
    const to = byKey.get(l.to);
    if (!from) { errors.push(`link references unknown world "${l.from}"`); continue; }
    if (!to) { errors.push(`link references unknown world "${l.to}"`); continue; }
    if (!EDGE_DELTA[l.edge]) { errors.push(`link ${l.from}->${l.to} has invalid edge "${l.edge}"`); continue; }

    const slot = `${l.from}:${l.edge}`;
    if (usedEdges.has(slot)) {
      errors.push(`world "${l.from}" already has a link on edge ${l.edge} — UNIQUE(from_world_id, edge) allows one`);
    }
    usedEdges.add(slot);

    const [dx, dy] = EDGE_DELTA[l.edge];
    const wantX = from.grid[0] + dx;
    const wantY = from.grid[1] + dy;
    if (to.grid[0] !== wantX || to.grid[1] !== wantY) {
      const adjacent = Math.abs(to.grid[0] - from.grid[0]) + Math.abs(to.grid[1] - from.grid[1]) === 1;
      errors.push(adjacent
        ? `link ${l.from}->${l.to} declares edge ${l.edge} but the grid puts "${l.to}" elsewhere`
        : `link ${l.from}->${l.to} declares edge ${l.edge} but the cells are not adjacent`);
    }

    adjacency.get(l.from).push(l.to);
    adjacency.get(l.to).push(l.from);   // links are bidirectional (setLink mirrors)
  }

  if (entries.length === 1) {
    const seen = new Set([entries[0].key]);
    const queue = [entries[0].key];
    while (queue.length) {
      for (const next of adjacency.get(queue.shift()) ?? []) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    for (const w of worlds) {
      if (!seen.has(w.key)) errors.push(`world "${w.key}" is unreachable from the entry`);
    }
  }

  return errors;
}

module.exports = { validateMapSpec, EDGE_DELTA };
```

- [ ] **Step 4: Verify it passes**

Run: `cd backend && node --test tests/map_spec_validate.test.js`
Expected: PASS (13 tests).

- [ ] **Step 5: Prove the validator is load-bearing**

Break `EDGE_DELTA.N` to `[0, 1]` and re-run — the axis test AND the contradicting-edge test must fail. Revert with an editor, **not** `git checkout --` (your work here is uncommitted). Record both results in your report.

- [ ] **Step 6: Commit**

```bash
git add backend/seeds/mapSpec.js backend/tests/map_spec_validate.test.js
git commit -m "feat(seeds): validate map specs against their grid embedding"
```

---

### Task 4: Three example topology specs

**Files:**
- Create: `backend/seeds/maps/spine-descent.map.json`, `backend/seeds/maps/hub-vale.map.json`, `backend/seeds/maps/loop-catacombs.map.json`
- Test: `backend/tests/map_spec_fixtures.test.js`

**Interfaces:**
- Consumes: `validateMapSpec` (Task 3).

Design each on paper first: draw the grid, then write the links. Difficulty escalates with distance from the entry (`creature_count` and tougher `allowed_creature_types`). Biomes form contiguous regions.

Use only biomes that exist: `Meadow`, `Deep Forest`, `Arid Dunes`, `Frozen Waste`, `Mire`. Use only creatures that exist: `Slime`, `Wolf`, `Skeleton`, `Bat`. Village boxes must be 3–8 wide and 3–6 tall.

`hub-vale` must have a village in the hub (it is the bind point) and **at most four spokes**. `loop-catacombs` must contain at least one cycle that closes on the grid.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/map_spec_fixtures.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { validateMapSpec } = require('../seeds/mapSpec.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');

const MAPS_DIR = path.join(__dirname, '..', 'seeds', 'maps');
const BIOMES = new Set(STARTER_BIOMES.map((b) => b.name));
const CREATURES = new Set(['Slime', 'Wolf', 'Skeleton', 'Bat']);

const specFiles = () => fs.readdirSync(MAPS_DIR).filter((f) => f.endsWith('.map.json'));

test('all three example topologies ship', () => {
  assert.deepEqual(specFiles().sort(),
    ['hub-vale.map.json', 'loop-catacombs.map.json', 'spine-descent.map.json']);
});

test('every shipped spec validates against the live catalogs', () => {
  for (const f of specFiles()) {
    const spec = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, f), 'utf8'));
    const errs = validateMapSpec(spec, { biomeNames: BIOMES, creatureTypeNames: CREATURES });
    assert.deepEqual(errs, [], `${f}: ${errs.join('; ')}`);
  }
});

test('difficulty escalates with distance from the entry', () => {
  // An adventure map whose creature counts are flat is not an adventure. This
  // asserts the shape of the content, not just its syntax.
  for (const f of specFiles()) {
    const spec = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, f), 'utf8'));
    const entry = spec.worlds.find((w) => w.is_entry);
    const counts = spec.worlds.map((w) => w.creature_count);
    assert.ok(Math.max(...counts) > Math.min(...counts), `${f}: every world has the same creature_count`);
    assert.equal(entry.creature_count, Math.min(...counts),
      `${f}: the entry world should be the safest`);
  }
});

test('hub-vale has a village in its hub and at most four spokes', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, 'hub-vale.map.json'), 'utf8'));
  const hub = spec.worlds.find((w) => w.is_entry);
  assert.ok(hub.village, 'the hub is the bind point and needs a village');
  const outgoing = spec.links.filter((l) => l.from === hub.key).length;
  assert.ok(outgoing <= 4, `hub has ${outgoing} spokes; UNIQUE(from_world_id, edge) allows 4`);
});

test('loop-catacombs actually contains a cycle', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, 'loop-catacombs.map.json'), 'utf8'));
  // A connected undirected graph has a cycle iff edges >= nodes.
  assert.ok(spec.links.length >= spec.worlds.length,
    'no cycle: a loop topology needs at least as many links as worlds');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && node --test tests/map_spec_fixtures.test.js`
Expected: FAIL — the maps directory does not exist.

- [ ] **Step 3: Author the three specs**

Follow the format in the spec document's *Spec format* section. Every world needs `key`, `name`, `grid`, `seed`, `width`, `height`, `chunk_size`, `biomes`, `biome_cell`, `creature_count`, `allowed_creature_types`, `is_entry`; the entry also needs `entry_spawn`.

`spine-descent` — critical path with opt-in dead ends:

```
        [cache]
           |
[entry]-[pass]-[gorge]-[deep]-[END]
           |             |
        [elite]       [shrine]
```

Lay this out on the grid so every link is one cell in a compass direction, then write `links` to match. Run the validator after each file — it will tell you precisely which edge disagrees with which cell.

- [ ] **Step 4: Verify all fixtures pass**

Run: `cd backend && node --test tests/map_spec_fixtures.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/seeds/maps backend/tests/map_spec_fixtures.test.js
git commit -m "feat(seeds): add spine, hub and loop example map specs"
```

---

### Task 5: Extract village creation into a service

**Files:**
- Create: `backend/src/services/villages.js`
- Modify: `backend/src/index.js` (the `POST /api/worlds/:id/villages` handler around lines 1790 and 1865-1885)
- Test: `backend/tests/villages_service.test.js`

**Interfaces:**
- Produces: `createVillage(client, worldId, village) => villageRow`, where `village` is `{ min_row, min_col, width, height, gate_edge, spawn_x, spawn_y }`. It inserts the row, then the gate guards, then the merchant base catalog — the same three steps the route does today.
- Also exports `insertVillageGuards(db, worldId, villages)`, moved out of `index.js`.

**Why:** a village is not one INSERT. `index.js:1872-1882` inserts the row, calls `insertVillageGuards()` (gate defenders) and `seedBaseCatalog()` (merchant stock). `insertVillageGuards` is a private function in `index.js`, so the seed applier cannot reach it. If Task 6 re-implemented the INSERT alone, every seeded village would ship with no guards and an empty merchant, and nothing would fail loudly.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/villages_service.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

test('the villages service exposes the full creation sequence', () => {
  const svc = require('../src/services/villages.js');
  assert.equal(typeof svc.createVillage, 'function');
  assert.equal(typeof svc.insertVillageGuards, 'function');
});

test('createVillage inserts the row, then guards, then merchant stock', async () => {
  // A fake client records the order of the statements. A seeded village that
  // skips guards or merchant stock looks fine in the database and only shows
  // up in play as an undefended gate and an empty shop -- so assert the
  // SEQUENCE, not merely that a row was written.
  const svc = require('../src/services/villages.js');
  const seen = [];
  const client = {
    query: async (sql, params) => {
      seen.push(String(sql).replace(/\s+/g, ' ').trim().slice(0, 40));
      if (/INSERT INTO villages/i.test(sql)) {
        return { rows: [{ id: 'v1', world_id: params[0], min_row: params[1], min_col: params[2],
                           width: params[3], height: params[4], gate_edge: params[5] }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const row = await svc.createVillage(client, 'w1', {
    min_row: 4, min_col: 4, width: 5, height: 4,
    gate_edge: 'S', spawn_x: 450, spawn_y: 500,
  });

  assert.equal(row.id, 'v1');
  assert.match(seen[0], /INSERT INTO villages/i);
  assert.ok(seen.some((s) => /INSERT INTO world_creatures/i.test(s)),
    'no gate guards were inserted');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && node --test tests/villages_service.test.js`
Expected: FAIL — `Cannot find module '../src/services/villages.js'`

- [ ] **Step 3: Create the service**

Move `insertVillageGuards` (currently `index.js:1790-1801`) and the merchant-position/`villageGatePosts` helpers it depends on into `backend/src/services/villages.js`. Read `index.js` around lines 1780-1890 first and take the real implementations — do not reconstruct them from memory. `createVillage` performs the same three steps in the same order as the route, using the `client` it is given so the caller owns the transaction.

- [ ] **Step 4: Rewire the route**

Replace the inline INSERT + `insertVillageGuards` + `seedBaseCatalog` block in the `POST /api/worlds/:id/villages` handler with a single `createVillage(client, id, req.body)` call. Leave `validateVillageBody` and the surrounding `BEGIN`/`COMMIT`/`ROLLBACK` exactly where they are — the route still owns the transaction and the error mapping.

- [ ] **Step 5: Run the full suite**

Run: `cd backend && npm test 2>&1 | tail -5`
Expected: baseline + the new tests, all green. Any existing village test that breaks means the extraction changed behaviour — fix the extraction, not the test.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/villages.js backend/src/index.js backend/tests/villages_service.test.js
git commit -m "refactor(villages): extract village creation so the seeder can reuse it"
```

---

### Task 6: The map applier and `make seed-map`

**Files:**
- Create: `backend/scripts/seed-map.js`
- Modify: `Makefile`
- Test: `backend/tests/seed_map_db.test.js`

**Interfaces:**
- Consumes: `validateMapSpec` (Task 3), `createVillage` (Task 5), `setLink` from `backend/src/services/mapLinks.js`.
- Produces: `applyMapSpec(pool, spec) => { worlds: n, links: n, villages: n }`.

**Rules:**
- Validate first. A non-empty error array aborts before any write.
- One transaction for the whole apply.
- Upsert worlds by `name` (`worlds_name_unique`, migration `1714440037000`).
- `graph_x = grid[0] * 220`, `graph_y = grid[1] * 220` — a fixed spacing so the World Map tab lays the map out exactly as the grid describes.
- Apply links **after** all worlds exist, through `setLink`, which writes the mirror edge itself. Do not insert into `map_links` directly.
- Set `is_entry` **last**: `index.js:1542` clears the flag on every other world, so setting it mid-apply would fight itself.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/seed_map_db.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { applyMapSpec } = require('../scripts/seed-map.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await pool.query('SELECT 1'); return pool; }
  catch (err) { await pool.end().catch(() => {}); return { unreachable: err.message }; }
}

// A throwaway spec whose world names are unlikely to collide with real data.
const spec = () => ({
  name: 'zz-test-fixture',
  topology: 'spine',
  worlds: [
    { key: 'a', name: 'zzTestAlpha', grid: [0, 0], seed: 991, width: 64, height: 64,
      chunk_size: 64, biomes: [], biome_cell: 32, creature_count: 0,
      allowed_creature_types: [], is_entry: false, entry_spawn: { x: 32, y: 32 } },
    { key: 'b', name: 'zzTestBeta', grid: [1, 0], seed: 992, width: 64, height: 64,
      chunk_size: 64, biomes: [], biome_cell: 32, creature_count: 2,
      allowed_creature_types: [], is_entry: false },
  ],
  links: [{ from: 'a', edge: 'E', to: 'b' }],
});

async function cleanup(pool) {
  await pool.query("DELETE FROM worlds WHERE name IN ('zzTestAlpha','zzTestBeta')").catch(() => {});
}

test('applying a spec twice produces identical rows', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — map applier is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await cleanup(pool);
    const s = spec();
    // is_entry is deliberately false in this fixture: flipping it would clear
    // is_entry on the developer's real entry world.
    await applyMapSpec(pool, s);
    const q = `SELECT name, seed, width, height, graph_x, graph_y FROM worlds
               WHERE name LIKE 'zzTest%' ORDER BY name`;
    const first = await pool.query(q);
    const firstLinks = await pool.query(
      `SELECT ml.edge, wf.name AS from_name, wt.name AS to_name FROM map_links ml
         JOIN worlds wf ON wf.id = ml.from_world_id
         JOIN worlds wt ON wt.id = ml.to_world_id
        WHERE wf.name LIKE 'zzTest%' ORDER BY wf.name, ml.edge`);

    await applyMapSpec(pool, s);
    const second = await pool.query(q);
    const secondLinks = await pool.query(
      `SELECT ml.edge, wf.name AS from_name, wt.name AS to_name FROM map_links ml
         JOIN worlds wf ON wf.id = ml.from_world_id
         JOIN worlds wt ON wt.id = ml.to_world_id
        WHERE wf.name LIKE 'zzTest%' ORDER BY wf.name, ml.edge`);

    assert.equal(first.rowCount, 2, 'both worlds should exist after the first apply');
    assert.deepEqual(second.rows, first.rows, 'second apply changed the world rows');
    assert.deepEqual(secondLinks.rows, firstLinks.rows, 'second apply duplicated links');
    // setLink mirrors, so one spec link becomes two rows.
    assert.equal(firstLinks.rowCount, 2, 'the mirror edge was not written');
  } finally { await cleanup(pool); await pool.end(); }
});

test('a spec that fails validation writes nothing', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — validation-abort is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await cleanup(pool);
    const bad = spec();
    bad.links[0].edge = 'N';   // contradicts the grid
    await assert.rejects(() => applyMapSpec(pool, bad), /edge N|invalid spec/i);
    const r = await pool.query("SELECT 1 FROM worlds WHERE name LIKE 'zzTest%'");
    assert.equal(r.rowCount, 0, 'an invalid spec wrote worlds anyway');
  } finally { await cleanup(pool); await pool.end(); }
});

test('every shipped spec applies cleanly', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — shipped specs are UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const dir = path.join(__dirname, '..', 'seeds', 'maps');
  try {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.map.json'))) {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      await applyMapSpec(pool, s);          // must not throw
      await applyMapSpec(pool, s);          // idempotent
    }
  } finally { await pool.end(); }
});
```

Note the third test leaves the shipped maps in the database — that is intended; it doubles as the seeding step for the browser check in Task 9.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && node --test tests/seed_map_db.test.js`
Expected: FAIL — `Cannot find module '../scripts/seed-map.js'`

- [ ] **Step 3: Write the applier**

Create `backend/scripts/seed-map.js`:

```js
#!/usr/bin/env node
// Apply a map spec. Run via `make seed-map SPEC=<name>`.
//
// Idempotent by worlds.name (worlds_name_unique, migration 1714440037000):
// re-applying an unchanged spec is a no-op. The whole apply is one transaction
// -- a spec that fails halfway must not leave a half-built map that the World
// Map tab then renders as a broken graph.
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const { validateMapSpec } = require('../seeds/mapSpec.js');
const { setLink } = require('../src/services/mapLinks.js');
const { createVillage } = require('../src/services/villages.js');

// Pixels per grid cell for the World Map tab's canvas coordinates. Deriving
// graph_x/graph_y from the same grid the links were validated against is what
// guarantees the drawn diagram agrees with the links.
const GRID_SPACING = 220;

async function applyMapSpec(pool, spec) {
  const catalogs = {
    biomeNames: new Set((await pool.query('SELECT name FROM biomes')).rows.map((r) => r.name)),
    creatureTypeNames: new Set(
      (await pool.query('SELECT name FROM entity_types WHERE is_creature = true')).rows.map((r) => r.name)),
  };
  const errors = validateMapSpec(spec, catalogs);
  if (errors.length) {
    throw new Error(`invalid spec "${spec.name}":\n  - ${errors.join('\n  - ')}`);
  }

  const client = await pool.connect();
  const idByKey = new Map();
  try {
    await client.query('BEGIN');

    for (const w of spec.worlds) {
      const r = await client.query(
        `INSERT INTO worlds (name, seed, chunk_size, width, height, creature_count,
                             allowed_creature_types, entry_spawn, biomes, biome_cell,
                             graph_x, graph_y)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12)
         ON CONFLICT (name) DO UPDATE
           SET seed = EXCLUDED.seed, chunk_size = EXCLUDED.chunk_size,
               width = EXCLUDED.width, height = EXCLUDED.height,
               creature_count = EXCLUDED.creature_count,
               allowed_creature_types = EXCLUDED.allowed_creature_types,
               entry_spawn = EXCLUDED.entry_spawn, biomes = EXCLUDED.biomes,
               biome_cell = EXCLUDED.biome_cell,
               graph_x = EXCLUDED.graph_x, graph_y = EXCLUDED.graph_y
         RETURNING id`,
        [w.name, w.seed, w.chunk_size ?? 64, w.width, w.height, w.creature_count ?? 0,
         JSON.stringify(w.allowed_creature_types ?? []),
         w.entry_spawn ? JSON.stringify(w.entry_spawn) : null,
         JSON.stringify(w.biomes ?? []), w.biome_cell ?? null,
         w.grid[0] * GRID_SPACING, w.grid[1] * GRID_SPACING],
      );
      idByKey.set(w.key, r.rows[0].id);
    }

    // After every world exists, so a link can never reference a missing target.
    // setLink writes the mirror edge itself -- never INSERT into map_links here.
    for (const l of spec.links) {
      await setLink(client, idByKey.get(l.from), l.edge, idByKey.get(l.to));
    }

    let villages = 0;
    for (const w of spec.worlds) {
      if (!w.village) continue;
      const worldId = idByKey.get(w.key);
      const existing = await client.query('SELECT id FROM villages WHERE world_id = $1', [worldId]);
      if (existing.rowCount === 0) {          // idempotent: one village per seeded world
        await createVillage(client, worldId, w.village);
        villages += 1;
      }
    }

    // LAST: setting is_entry clears it on every other world (index.js:1542),
    // so doing this mid-apply would fight itself as later worlds are written.
    const entry = spec.worlds.find((w) => w.is_entry);
    if (entry) {
      await client.query('UPDATE worlds SET is_entry = false WHERE is_entry = true AND id <> $1',
        [idByKey.get(entry.key)]);
      await client.query('UPDATE worlds SET is_entry = true WHERE id = $1', [idByKey.get(entry.key)]);
    }

    await client.query('COMMIT');
    return { worlds: spec.worlds.length, links: spec.links.length, villages };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { applyMapSpec, GRID_SPACING };

if (require.main === module) {
  const name = process.env.SPEC;
  if (!name) { console.error('SPEC is required, e.g. make seed-map SPEC=hub-vale'); process.exit(1); }
  const file = path.resolve(__dirname, '../seeds/maps', `${name}.map.json`);
  if (!fs.existsSync(file)) { console.error(`no such spec: ${file}`); process.exit(1); }
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set in .env'); process.exit(1); }
  const pool = new Pool({ connectionString: url });
  applyMapSpec(pool, JSON.parse(fs.readFileSync(file, 'utf8')))
    .then((n) => console.log(`applied ${name}: ${n.worlds} worlds, ${n.links} links, ${n.villages} villages`))
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
```

`setLink` and `createVillage` are called with the transaction `client`, not the pool. Confirm `setLink`'s signature accepts anything with `.query` — it does; it only calls `pool.query`.

- [ ] **Step 4: Verify the tests pass**

Run: `cd backend && node --test tests/seed_map_db.test.js`
Expected: PASS. If it SKIPs, run `make up`, wait for Postgres, and re-run — a skip proves nothing.

- [ ] **Step 5: Add the make target**

Add `seed-map` to `.PHONY` and append to the `Makefile`:

```make
# Apply one map spec from backend/seeds/maps/<SPEC>.map.json. Idempotent:
# re-running an unchanged spec is a no-op. Validates before writing anything.
seed-map:
	@[ -n "$(SPEC)" ] || (echo "usage: make seed-map SPEC=<name>  (see: make list-maps)"; exit 1)
	SPEC=$(SPEC) node backend/scripts/seed-map.js
```

- [ ] **Step 6: Run it for real, twice**

```bash
make seed-map SPEC=hub-vale
make seed-map SPEC=hub-vale
```

Expected: the same summary line both times, exit 0 both times. Then confirm `make seed-map` with no `SPEC` prints the usage message and exits non-zero.

- [ ] **Step 7: Commit**

```bash
git add backend/scripts/seed-map.js backend/tests/seed_map_db.test.js Makefile
git commit -m "feat(seeds): apply map specs idempotently in one transaction"
```

---

### Task 7: `clear-maps`, `reseed-map`, `list-maps`

**Files:**
- Create: `backend/scripts/clear-maps.js`, `backend/scripts/list-maps.js`
- Modify: `Makefile`

**Interfaces:**
- Produces: `clearMaps(pool) => { worlds: n }`.

`DELETE FROM worlds` cascades to `world_chunks`, `world_creatures`, `world_players`, `world_items`, `map_links`, `villages` (and `merchant_stock` through it) and **`player_binds`**. Catalogs, accounts, `player_items` and `player_equipment` are untouched.

- [ ] **Step 1: Write the clear script**

Create `backend/scripts/clear-maps.js`:

```js
#!/usr/bin/env node
// Delete every world. Run via `make clear-maps`.
//
// The confirmation names player_binds on purpose. Deleting a world cascades
// much further than "maps": a developer reading "clear maps" will not expect
// every player to lose their respawn bind, and there is no undo.
const path = require('path');
const readline = require('readline');
const dotenv = require('dotenv');
const { Pool } = require('pg');

const CASCADES = [
  'world_chunks', 'world_creatures', 'world_players', 'world_items',
  'map_links', 'villages', 'merchant_stock', 'player_binds (every player\'s respawn point)',
];

async function clearMaps(pool) {
  const r = await pool.query('DELETE FROM worlds');
  return { worlds: r.rowCount };
}

module.exports = { clearMaps, CASCADES };

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set in .env'); process.exit(1); }
  const pool = new Pool({ connectionString: url });

  (async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM worlds');
    console.log(`This deletes ALL ${rows[0].n} worlds and, by cascade:`);
    for (const t of CASCADES) console.log(`  - ${t}`);
    console.log('Kept: user accounts, inventory, equipment, and every catalog.');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((res) => rl.question("Type 'yes' to confirm: ", res));
    rl.close();
    if (answer.trim() !== 'yes') { console.log('Aborted.'); return; }

    const n = await clearMaps(pool);
    console.log(`deleted ${n.worlds} worlds`);
  })()
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
```

- [ ] **Step 2: Write the list script**

Create `backend/scripts/list-maps.js`, printing the available spec files with their topology and world count, then the worlds currently in the database with their `is_entry` flag. Read `backend/seeds/maps/*.map.json` for the first half and `SELECT name, is_entry FROM worlds ORDER BY name` for the second. Handle an unreachable database by printing the specs and a warning rather than crashing — listing specs is useful without Postgres.

- [ ] **Step 3: Add the make targets**

Add all three to `.PHONY` and append:

```make
# Destructive. Deletes every world and everything cascading from it -- including
# player_binds, every player's respawn point. Catalogs and inventory survive.
clear-maps:
	node backend/scripts/clear-maps.js

# What specs exist, and what is currently in the database.
list-maps:
	node backend/scripts/list-maps.js

# Full reset to one spec: clear, re-seed the catalogs, apply the map.
reseed-map: clear-maps seed-catalogs seed-map
```

`reseed-map` depends on `seed-map`, which already fails fast when `SPEC` is unset — so `make reseed-map` with no argument stops before clearing anything. **Verify that ordering explicitly in step 4**; if make runs `clear-maps` first, the guard has to move.

- [ ] **Step 4: Verify by hand**

```bash
make list-maps                 # specs + current worlds
make reseed-map                # MUST fail on the missing SPEC without deleting anything
make list-maps                 # confirm the worlds are still there
```

Then, on a database you are willing to wipe: `make clear-maps`, answer `no`, confirm nothing was deleted; answer `yes`, confirm the worlds are gone and `tile_types` still has rows. Record the outputs in your report.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/clear-maps.js backend/scripts/list-maps.js Makefile
git commit -m "feat(seeds): add clear-maps, list-maps and reseed-map"
```

---

### Task 8: The map-planner skill

**Files:**
- Create: `.claude/skills/map-planner/SKILL.md`

Follow the frontmatter and structure of the existing skills in `.claude/skills/` — read `.claude/skills/react-dev/SKILL.md` first and match its shape and tone. It needs `name` and `description` frontmatter; the description is what routes to it, so it must name the triggers: planning a map, a new adventure map, branching worlds.

Content it must carry:

- **The constraint, with its reason.** `UNIQUE(from_world_id, edge)` over `N/E/S/W`, and `setLink` mirroring every link. Four neighbours maximum; the map must embed in a 2D grid; `N` is `-y`.
- **The workflow, as a hard sequence.** Draw the grid → write `backend/seeds/maps/<name>.map.json` → `cd backend && node --test tests/map_spec_fixtures.test.js` → `make seed-map SPEC=<name>`. Never hand-edit the database. Never apply a spec that has not validated.
- **The three topologies**, with their shapes and limits: spine + dead-end branches; hub + at most four spokes; loop, where a cycle must close on the grid.
- **Content rules.** Difficulty escalates with distance from the entry — `creature_count` and tougher `allowed_creature_types`. Biomes form contiguous regions rather than per-world picks. Hub topology needs a village in the hub because it is the bind point; spine topology wants one near the entry.
- **The real limits**, so a plan is not invented and then rejected: village `width` 3–8, `height` 3–6; world `width`/`height` 8–4096; `chunk_size` 1–256; exactly one `is_entry`; biomes must exist in the `biomes` table and creatures in `entity_types`.
- **A worked example**: the `spine-descent` grid and the spec fragment it produces.

- [ ] **Step 1: Write the skill**

- [ ] **Step 2: Verify it against reality**

Every path, command and numeric limit in the skill must be correct. Check each one against the file it claims to describe. A skill that misstates a limit will produce specs the validator rejects, which is worse than no skill.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/map-planner/SKILL.md
git commit -m "docs(skill): add the map-planner skill"
```

---

### Task 9: Full verification

- [ ] **Step 1: Full backend suite**

Run: `cd backend && npm test 2>&1 | tail -6`
Expected: green, with a higher count than the Task 0 baseline. **Zero skips** — if any database test skipped, bring the stack up with `make up` and re-run. Report the counts.

- [ ] **Step 2: Seed all three maps from clean**

```bash
make clear-maps        # answer yes
make seed-catalogs
make seed-map SPEC=spine-descent
make seed-map SPEC=hub-vale
make seed-map SPEC=loop-catacombs
make list-maps
```

Note: applying all three puts three separate adventures in one database, and only the last `is_entry` survives (it is exclusive). That is expected — confirm exactly one world has `is_entry = true` at the end.

- [ ] **Step 3: Browser verification**

The suite cannot prove the map looks right. With the stack up, sign in as admin and:

1. Open `/game/world-map`. Confirm **zero consistency warnings** for the seeded worlds — this is the payoff of the grid design. Any "links N to X but is drawn E" warning means `GRID_SPACING`/`graph_x`/`graph_y` disagree with the validator's axes.
2. Confirm the seeded worlds are laid out in the shape the spec describes, not stacked or scattered.
3. Confirm the hub world shows a village.
4. Enter the entry world, walk to a doorway on a linked edge, cross it, and confirm you arrive in the world the spec links to — and on the correct side. This is the one check that proves the `N` = `-y` convention end to end.
5. Collect console errors and failed requests; report every one.

- [ ] **Step 4: Report and push**

Report the results, then:

```bash
git push -u origin feat/map-seed-tooling
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Grid embedding, `EDGE_DELTA`, `N` = `-y` | 3 |
| `graph_x`/`graph_y` from the grid | 6 |
| Spec format | 4, 6 |
| Validation rules (all nine) | 3 |
| Application: idempotent, transactional, `is_entry` last | 6 |
| `make clear-maps` + the `player_binds` warning | 7 |
| `make seed-catalogs`, upsert-never-delete | 2 |
| `make seed-map`, `reseed-map`, `list-maps` | 6, 7 |
| Three example topology specs | 4 |
| Catalog extraction, shared modules, no drift | 1 |
| `tile_types` superset test | 1 |
| The `map-planner` skill | 8 |
| Validator tests, applier idempotency, rollback | 3, 6 |
| Browser verification | 9 |
| Village creation needs guards + merchant stock | 5 |

Two spec corrections are recorded at the top of this plan and implemented: the invalid example village size, and village creation being three steps rather than one.

**Naming consistency:** `validateMapSpec`, `EDGE_DELTA`, `applyMapSpec`, `GRID_SPACING`, `seedCatalogs`, `clearMaps`, `createVillage`, `insertVillageGuards`, `DEFAULT_TILE_TYPES`, `STARTER_BIOMES`, `NEW_DECORATIONS` are each defined once and spelled identically everywhere they appear.

**Known gap:** `make list-maps` and the `map-planner` skill have no automated tests. Both are human-facing output; Tasks 7 and 8 verify them by hand instead, and the plan says so rather than pretending otherwise.
