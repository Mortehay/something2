# P1 — World Population Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A seeded world arrives populated, through one placement path shared by seeding and the admin re-roll route, with density authored per world and hordes expressed as clustered packs.

**Architecture:** A new `worldPopulation.js` service owns orchestration — read on the caller's transaction, delete non-guard creatures, resolve density, place, insert. Placement itself stays pure in `mapService.js`, where a new `placeCreaturePacks` sits beside the existing `placeMapCreatures` and both call one extracted tile-validity helper so their rules cannot drift. The unreachable per-chunk `spawnChunkCreatures` path is deleted, so exactly one algorithm places creatures.

**Tech Stack:** Node.js CommonJS, Express 4, `pg` (raw SQL, no ORM), `node-pg-migrate`, `node:test` + `node:assert`.

**Spec:** `docs/superpowers/specs/2026-08-06-p1-world-population-design.md`
**Umbrella:** `docs/superpowers/specs/2026-08-06-bestiary-program-design.md`
**Plane item:** SOMET-246

## Global Constraints

- **Reserved migration range: `1714440070000`–`1714440079000`.** Do not use a timestamp outside it. Highest migration on `main` is `1714440061000`.
- **Never mutate the shared dev database destructively.** No `DELETE FROM entity_types`, no `TRUNCATE`, no dropping worlds you did not create. A reviewer once wiped the entity catalog testing a seeder.
- **DB-gated tests must use `withEntryPreserved`** (copy the helper from `backend/tests/seed_map_db.test.js:70`) around any `applyMapSpec` call, and clean up by **name**, unconditionally, in a `finally`. Setting `is_entry` clears it on every other world, so an unguarded test steals it from the developer's real map permanently.
- **Only creature types that exist in the dev catalog may appear in test fixtures.** The live catalog is exactly: `Bat`, `Skeleton`, `Slime`, `Wolf`, `Village Guard`. Inventing a name makes a test skip its real assertions and pass vacuously.
- **`populateWorld` owns hostile creatures only.** Guards (`Village Guard`, portal guards) are never deleted or placed by it. Every delete it issues is scoped `AND type <> 'Village Guard'` — matching the existing re-roll route — so guards survive a repopulate.
- **Pixel convention:** creature `x`/`y` are tile centres in world pixels — `col * 100 + 50`. `CREATURE_TILE_PX` is 100.
- **Do not touch** `backend/src/authority/collision.js`, `frontend/src/games/something2/movement.js`, or anything in the movement/collision pair. This sub-project does not move anything at runtime.
- **P1 authors no densities or level bands.** The only edit to existing `.map.json` files is deleting the retired `creature_count` field. Do not set `density` on any world; do not touch `level_band`.
- **Commit convention:** `<type>(population): <summary> (SOMET-246)`.

## File Structure

| file | responsibility |
|---|---|
| `backend/migrations/1714440070000_world_density.js` | adds `worlds.density` + its CHECK constraint |
| `backend/src/services/densityTiers.js` | **new** — the density keyword → placement numbers table, pure |
| `backend/src/services/tileTypes.js` | **new** — `loadTileTypes(db)`, moved out of `index.js` so services can call it |
| `backend/src/services/worldPopulation.js` | **new** — `populateWorld`, the single orchestration point |
| `backend/src/services/mapService.js` | gains `placeCreaturePacks` + the extracted validity helper; loses `spawnChunkCreatures` |
| `backend/scripts/seed-map.js` | `applyMapSpec` calls `populateWorld` per world |
| `backend/src/index.js` | re-roll route delegates to `populateWorld`; `POST /api/worlds` requires width/height; imports `loadTileTypes` |
| `backend/seeds/mapSpec.js` | validates `density`, rejects the retired `creature_count` |
| `backend/src/authority/server.js` | loses the dead `!isBoundedWorld` spawn branch |

---

### Task 1: Migration — `worlds.density`

**Files:**
- Create: `backend/migrations/1714440070000_world_density.js`

**Interfaces:**
- Consumes: nothing.
- Produces: a `worlds.density` column, `text NOT NULL DEFAULT 'normal'`, constrained to exactly `dead|sparse|normal|dense|horde|swarm`.

- [ ] **Step 1: Write the migration**

```js
exports.shorthands = undefined;

// NOT NULL with a default, unlike world_creatures.defense (1714440051000)
// which was deliberately nullable. The distinction is real: a NULL defense
// means "predates level scaling, fall back to the entity type", but there is
// no sensible "no density" -- every world holds some number of creatures, and
// a nullable column would just push a `?? 'normal'` fallback into every
// reader. Existing worlds take 'normal', which on a 64x64 map resolves to
// ~12 scattered creatures against the 2-9 they were authored with.
//
// The CHECK duplicates DENSITY_TIERS' key set in services/densityTiers.js on
// purpose: `make reseed-map` clears every world BEFORE seeding, so a tier
// rejected only in JS would fail after the destruction. Same reasoning as
// worlds_level_band_check and the level_band validation in seeds/mapSpec.js.
exports.up = (pgm) => {
  pgm.addColumns('worlds', {
    density: { type: 'text', notNull: true, default: 'normal' },
  });
  pgm.addConstraint(
    'worlds',
    'worlds_density_check',
    "CHECK (density IN ('dead','sparse','normal','dense','horde','swarm'))",
  );
};

exports.down = (pgm) => {
  pgm.dropConstraint('worlds', 'worlds_density_check');
  pgm.dropColumns('worlds', ['density']);
};
```

- [ ] **Step 2: Apply it**

Run: `DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" npm run migrate:up --prefix backend`
Expected: `Migrating files: > 1714440070000_world_density` then `Migrations complete!`

If it errors with `SASL: client password must be a string`, `DATABASE_URL` is missing from your shell — pass it inline exactly as above.

- [ ] **Step 3: Verify the column and its constraint exist**

Run:
```bash
PGPASSWORD=password psql -h 127.0.0.1 -p 15432 -U user -d game_db \
  -c "SELECT density, count(*) FROM worlds GROUP BY density;" \
  -c "BEGIN; INSERT INTO worlds (name, seed, width, height, density)
      VALUES ('zzDensityProbe', 1, 64, 64, 'nope'); ROLLBACK;"
```
Expected: the first query reports every existing world as `normal`; the INSERT fails with `violates check constraint "worlds_density_check"`. The explicit `BEGIN`/`ROLLBACK` wrapper is what guarantees the shared dev database is untouched even if the constraint were somehow missing and the INSERT succeeded — never probe a live database with a bare INSERT that you are only *expecting* to fail.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/1714440070000_world_density.js
git commit -m "feat(population): add the worlds.density tier column (SOMET-246)"
```

---

### Task 2: `resolveDensity` — the density tier table

**Files:**
- Create: `backend/src/services/densityTiers.js`
- Test: `backend/tests/densityTiers.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `DENSITY_TIERS` — object keyed by tier name.
  - `DENSITY_NAMES` — `string[]`, the six tier names.
  - `DEFAULT_DENSITY` — `'normal'`.
  - `resolveDensity(tier, width, height) -> { scatterCount, packCount, packSizeMin, packSizeMax }`. Throws on an unknown non-nullish tier; treats `null`/`undefined` as `DEFAULT_DENSITY`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/densityTiers.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { resolveDensity, DENSITY_NAMES, DEFAULT_DENSITY } = require('../src/services/densityTiers');

// Expected counts are written as LITERALS, never recomputed from the tier
// table. Importing DENSITY_TIERS and recomputing perThousand * area / 1000
// would assert that arithmetic works, not that the table holds the intended
// numbers -- the test would keep passing through any edit to the table.

test('normal on a 64x64 map scatters 12 with one small pack', () => {
  assert.deepEqual(resolveDensity('normal', 64, 64),
    { scatterCount: 12, packCount: 1, packSizeMin: 3, packSizeMax: 4 });
});

test('horde on a 64x64 map is roughly 75 creatures all told', () => {
  assert.deepEqual(resolveDensity('horde', 64, 64),
    { scatterCount: 49, packCount: 4, packSizeMin: 5, packSizeMax: 8 });
});

test('swarm on a 64x64 map is roughly 160 creatures all told', () => {
  assert.deepEqual(resolveDensity('swarm', 64, 64),
    { scatterCount: 98, packCount: 6, packSizeMin: 8, packSizeMax: 12 });
});

test('dead places nothing at all', () => {
  assert.deepEqual(resolveDensity('dead', 64, 64),
    { scatterCount: 0, packCount: 0, packSizeMin: 0, packSizeMax: 0 });
});

test('sparse and dense sit either side of normal', () => {
  assert.equal(resolveDensity('sparse', 64, 64).scatterCount, 6);
  assert.equal(resolveDensity('dense', 64, 64).scatterCount, 25);
});

// The whole point of scaling per 1000 tiles: a bigger map is not sparser at
// the same setting. 96x96 is 9216 tiles against 64x64's 4096.
test('scatter scales with map area, so a 96x96 world is not sparser', () => {
  assert.equal(resolveDensity('normal', 96, 96).scatterCount, 28);
  assert.equal(resolveDensity('horde', 96, 96).scatterCount, 111);
});

test('a nullish tier resolves to the default rather than throwing', () => {
  assert.deepEqual(resolveDensity(null, 64, 64), resolveDensity(DEFAULT_DENSITY, 64, 64));
  assert.deepEqual(resolveDensity(undefined, 64, 64), resolveDensity(DEFAULT_DENSITY, 64, 64));
});

// Loud, not silent: a typo'd tier is a bug in the caller, and falling back to
// 'normal' would hide it behind a plausible-looking population.
test('an unknown tier throws rather than falling back', () => {
  assert.throws(() => resolveDensity('enormous', 64, 64), /unknown density tier "enormous"/);
});

test('DENSITY_NAMES lists exactly the six tiers, ascending', () => {
  assert.deepEqual(DENSITY_NAMES, ['dead', 'sparse', 'normal', 'dense', 'horde', 'swarm']);
});

test('an unbounded world resolves to no creatures', () => {
  assert.equal(resolveDensity('horde', null, null).scatterCount, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test --prefix backend -- --test-name-pattern="density"`
Expected: FAIL — `Cannot find module '../src/services/densityTiers'`

- [ ] **Step 3: Write the implementation**

Create `backend/src/services/densityTiers.js`:

```js
// The ONE table that turns an authored density keyword into placement numbers.
//
// Scaled per 1000 tiles rather than as an absolute count. An absolute count
// makes a 96x96 world (9216 tiles) meaningfully sparser than a 64x64 one
// (4096) at the same setting -- the trap `worlds.creature_count` walks into
// today, where hand-authored counts of 2-9 read very differently depending on
// the map they sit on.
//
// Keep the key set in sync with worlds_density_check (migration
// 1714440070000). The duplication is deliberate and documented there.
const DENSITY_TIERS = {
  dead:   { perThousand: 0,   packCount: 0, packSizeMin: 0, packSizeMax: 0 },
  sparse: { perThousand: 1.5, packCount: 0, packSizeMin: 0, packSizeMax: 0 },
  normal: { perThousand: 3,   packCount: 1, packSizeMin: 3, packSizeMax: 4 },
  dense:  { perThousand: 6,   packCount: 2, packSizeMin: 4, packSizeMax: 6 },
  horde:  { perThousand: 12,  packCount: 4, packSizeMin: 5, packSizeMax: 8 },
  swarm:  { perThousand: 24,  packCount: 6, packSizeMin: 8, packSizeMax: 12 },
};

const DENSITY_NAMES = Object.keys(DENSITY_TIERS);
const DEFAULT_DENSITY = 'normal';

// Pure. Never reads a database -- populateWorld does the writing, including
// persisting scatterCount back to worlds.creature_count.
function resolveDensity(tier, width, height) {
  const key = tier ?? DEFAULT_DENSITY;
  const t = DENSITY_TIERS[key];
  if (!t) throw new Error(`unknown density tier "${tier}"`);
  const area = (Number(width) || 0) * (Number(height) || 0);
  return {
    scatterCount: Math.round((t.perThousand * area) / 1000),
    packCount: t.packCount,
    packSizeMin: t.packSizeMin,
    packSizeMax: t.packSizeMax,
  };
}

module.exports = { DENSITY_TIERS, DENSITY_NAMES, DEFAULT_DENSITY, resolveDensity };
```

- [ ] **Step 4: Run the tests**

Run: `npm test --prefix backend -- --test-name-pattern="density"`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/densityTiers.js backend/tests/densityTiers.test.js
git commit -m "feat(population): resolve density tiers to area-scaled placement numbers (SOMET-246)"
```

---

### Task 3: `placeCreaturePacks` — clustered placement

**Files:**
- Modify: `backend/src/services/mapService.js` (extract the validity helper from `placeMapCreatures` at `:555`, add `placeCreaturePacks` after it, export both)
- Test: `backend/tests/placeCreaturePacks.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `placeCreaturePacks(world, packSpecs, allowedTypes, rngSeed, maxAttempts = 40) -> rows[]` where `packSpecs` is `Array<{ size: number }>` and each row has the same shape `placeMapCreatures` returns: `{ type, x, y, hp, damage, level, facing, defense, resistances }`.
  - `creatureTileCandidates(world, cfg, gRow, gCol, allowedTypes) -> types[] | null` — the extracted validity helper. Returns the creature types the local biome admits at that tile, or `null` if no creature may stand there at all.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/placeCreaturePacks.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { placeCreaturePacks, generateRegion } = require('../src/services/mapService');

const TILE_TYPES = {
  grass: { walkable: true, speed: 1 },
  water: { walkable: false, speed: 1 },
};
const boundedWorld = (over = {}) => ({
  seed: 42, chunkSize: 64, tileTypes: TILE_TYPES,
  width: 24, height: 24, doorways: new Set(['N', 'E', 'S', 'W']),
  ...over,
});

const CREATURES = [
  { name: 'goblin', hp: 12, defense: 1, resistances: {} },
  { name: 'wolf', hp: 8, defense: 0, resistances: { fire: 0.5 } },
];

// Every clustering assertion below FIRST asserts the pack is non-empty and
// full size. "every member is within radius" is vacuously true of an empty
// array, so a pack function that silently placed nothing would otherwise pass
// the entire clustering suite.

test('places one full pack of the requested size', () => {
  const rows = placeCreaturePacks(boundedWorld(), [{ size: 6 }], CREATURES, 123);
  assert.equal(rows.length, 6);
});

test('a pack is a single creature type, not a mixed bag', () => {
  const rows = placeCreaturePacks(boundedWorld(), [{ size: 8 }], CREATURES, 77);
  assert.equal(rows.length, 8);
  assert.equal(new Set(rows.map((r) => r.type)).size, 1);
});

test('pack members cluster within the size-derived radius of each other', () => {
  const rows = placeCreaturePacks(boundedWorld(), [{ size: 5 }], CREATURES, 31);
  assert.equal(rows.length, 5);
  // size 5 -> radius = clamp(ceil(sqrt(5)) + 1, 2, 4) = 4, so members sit
  // within 4 tiles of the anchor and therefore within 8 of each other.
  const cols = rows.map((r) => Math.floor(r.x / 100));
  const rowsIdx = rows.map((r) => Math.floor(r.y / 100));
  assert.ok(Math.max(...cols) - Math.min(...cols) <= 8);
  assert.ok(Math.max(...rowsIdx) - Math.min(...rowsIdx) <= 8);
});

test('two packs are placed independently, not merged into one blob', () => {
  const rows = placeCreaturePacks(boundedWorld(), [{ size: 4 }, { size: 4 }], CREATURES, 909);
  assert.equal(rows.length, 8);
});

test('every member lands strictly inside the wall ring on a walkable tile', () => {
  const world = boundedWorld();
  const rows = placeCreaturePacks(world, [{ size: 10 }], CREATURES, 5150);
  assert.equal(rows.length, 10);
  for (const c of rows) {
    const col = Math.floor(c.x / 100);
    const row = Math.floor(c.y / 100);
    assert.ok(row >= 1 && row <= 22, `row ${row} inside 1..22`);
    assert.ok(col >= 1 && col <= 22, `col ${col} inside 1..22`);
    const name = generateRegion(world, row, col, 1, 1)[0][0];
    assert.notEqual(name, 'map_wall');
    assert.notEqual(name, 'map_doorway');
    assert.notEqual(TILE_TYPES[name].walkable, false);
  }
});

test('row shape matches placeMapCreatures (pixel centre, carried stats)', () => {
  const rows = placeCreaturePacks(boundedWorld(), [{ size: 1 }], [CREATURES[0]], 3);
  assert.equal(rows.length, 1);
  const c = rows[0];
  assert.equal((c.x - 50) % 100, 0);
  assert.equal((c.y - 50) % 100, 0);
  assert.equal(c.facing, 'S');
  assert.equal(c.type, 'goblin');
  assert.equal(c.hp, 12);
  assert.equal(c.defense, 1);
  assert.deepEqual(c.resistances, {});
});

test('deterministic: same seed => identical packs', () => {
  const a = placeCreaturePacks(boundedWorld(), [{ size: 6 }], CREATURES, 555);
  const b = placeCreaturePacks(boundedWorld(), [{ size: 6 }], CREATURES, 555);
  assert.deepEqual(a, b);
});

test('different seed => different packs (very likely)', () => {
  const a = placeCreaturePacks(boundedWorld(), [{ size: 6 }], CREATURES, 1);
  const b = placeCreaturePacks(boundedWorld(), [{ size: 6 }], CREATURES, 2);
  assert.notDeepEqual(a, b);
});

// Packs must not stack on top of the scattered creatures drawn from the same
// seed. Salting the pack stream is what prevents it; a shared stream would
// make these two sets start from identical draws.
test('packs do not reuse the scatter stream draws', () => {
  const { placeMapCreatures } = require('../src/services/mapService');
  const scatter = placeMapCreatures(boundedWorld(), 6, CREATURES, 4242);
  const packed = placeCreaturePacks(boundedWorld(), [{ size: 6 }], CREATURES, 4242);
  assert.equal(scatter.length, 6);
  assert.equal(packed.length, 6);
  assert.notEqual(`${scatter[0].x},${scatter[0].y}`, `${packed[0].x},${packed[0].y}`);
});

test('returns [] for an unbounded world', () => {
  const rows = placeCreaturePacks(
    { seed: 1, chunkSize: 64, tileTypes: TILE_TYPES }, [{ size: 5 }], CREATURES, 1);
  assert.deepEqual(rows, []);
});

test('returns [] with no packs or no allowed types', () => {
  assert.deepEqual(placeCreaturePacks(boundedWorld(), [], CREATURES, 1), []);
  assert.deepEqual(placeCreaturePacks(boundedWorld(), [{ size: 5 }], [], 1), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test --prefix backend -- --test-name-pattern="pack"`
Expected: FAIL — `placeCreaturePacks is not a function`

- [ ] **Step 3: Extract the validity helper from `placeMapCreatures`**

In `backend/src/services/mapService.js`, insert this **immediately above** `function placeMapCreatures`:

```js
// The tile-validity rules every creature placement obeys, in ONE place.
//
// placeMapCreatures (scatter) and placeCreaturePacks must apply identical
// rules -- a pack must never stand somewhere scatter would refuse. Extracted
// rather than copied: two copies drift the first time either is edited, and
// this repo already carries one byte-for-byte duplicated movement routine as
// a standing hazard.
//
// Returns the creature types the local biome admits here, or null if no
// creature may stand on this tile at all. The world's allowlist stays
// authoritative -- a biome can only REMOVE candidates from it, never add one.
function creatureTileCandidates(world, cfg, gRow, gCol, allowedTypes) {
  const { wallTile, doorwayTile } = cfg.bounds;
  const name = generateRegion(world, gRow, gCol, 1, 1)[0][0];
  if (name === wallTile || name === doorwayTile) return null;
  const def = world.tileTypes && world.tileTypes[name];
  if (def && def.walkable === false) return null;
  if (villageContaining(gRow, gCol, cfg.villages)) return null;
  const region = sampleBiomeRegion(cfg, gRow, gCol);
  const candidates = region
    ? allowedTypes.filter((t) => region.creatureTypes.includes(t.name))
    : allowedTypes;
  return candidates.length ? candidates : null;
}
```

Then, inside `placeMapCreatures`, replace the block that runs from `const name = generateRegion(world, row, col, 1, 1)[0][0];` down to and including `if (candidates.length === 0) continue;` with:

```js
      const candidates = creatureTileCandidates(world, cfg, row, col, allowedTypes);
      if (!candidates) continue;
```

The `const { width, height, wallTile, doorwayTile } = cfg.bounds;` destructure at the top of `placeMapCreatures` now only needs `width` and `height` — narrow it to `const { width, height } = cfg.bounds;`. Likewise its `const villages = cfg.villages;` line is now unused; delete it.

**Do not reorder anything else.** The helper performs only the non-random checks; every `rng()` draw stays where it was, in the same order, so `placeMapCreatures`' existing determinism tests must still pass unchanged. That is the check that this extraction was behaviour-preserving.

- [ ] **Step 4: Verify the extraction changed no behaviour**

Run: `npm test --prefix backend -- --test-name-pattern="placeMapCreatures|deterministic|creature"`
Expected: PASS. In particular `deterministic: same seed => identical placement` in `placeMapCreatures.test.js` must still pass — if it fails, a draw moved and the extraction is wrong.

- [ ] **Step 5: Add `placeCreaturePacks`**

In `backend/src/services/mapService.js`, immediately after `placeMapCreatures`:

```js
// A second stream off the same seed, for the reason CREATURE_SALT and
// LEVEL_SALT exist: sharing one stream with scatter would make pack anchors
// start from draws scatter already consumed, clustering packs on top of the
// scattered creatures instead of somewhere else on the map.
const PACK_SALT = 0x9ac4;

// Tiles from the anchor a member may sit. Grows with pack size so a pack of
// 12 does not have to fit in the same footprint as a pack of 3, and is capped
// so a large pack still reads as a group rather than a thin smear.
function packRadius(size) {
  return Math.min(4, Math.max(2, Math.ceil(Math.sqrt(size)) + 1));
}

// Clustered creature placement for a BOUNDED map. Each entry in `packSpecs`
// ({ size }) becomes one group of a SINGLE type, anchored on a valid tile and
// spread within packRadius(size) of it. Same validity rules as scatter, via
// creatureTileCandidates. Pure and deterministic given `rngSeed`. Returns rows
// shaped exactly like placeMapCreatures'. Unbounded worlds return [].
//
// A pack that cannot seat every member ships SHORT rather than failing: a
// crypt whose walkable area is mostly narrow corridor holds tighter, smaller
// packs, and that is a correct outcome, not an error to report.
function placeCreaturePacks(world, packSpecs, allowedTypes, rngSeed, maxAttempts = 40) {
  const cfg = worldConfig(world);
  if (!cfg.bounds) return [];
  if (!packSpecs || packSpecs.length === 0) return [];
  if (!allowedTypes || allowedTypes.length === 0) return [];
  const { width, height } = cfg.bounds;
  const rLo = 1, rHi = height - 2, cLo = 1, cHi = width - 2;
  if (rHi < rLo || cHi < cLo) return [];
  const rng = makeRng((rngSeed ^ PACK_SALT) >>> 0);
  const out = [];

  const emit = (t, gRow, gCol) => {
    const level = rollCreatureLevel(rng(), world.levelMin, world.levelMax);
    const scaled = scaleCreature(
      { hp: t.hp || 10, damage: CREATURE_BASE_DAMAGE, defense: Number(t.defense ?? 0) || 0 },
      level,
    );
    out.push({
      type: t.name,
      x: gCol * CREATURE_TILE_PX + CREATURE_TILE_PX / 2,
      y: gRow * CREATURE_TILE_PX + CREATURE_TILE_PX / 2,
      hp: scaled.hp,
      damage: scaled.damage,
      level,
      facing: 'S',
      defense: scaled.defense,
      resistances: t.resistances || {},
    });
  };

  for (const p of packSpecs) {
    const size = Math.max(1, Math.floor(p.size) || 0);

    // Anchor: rejection-sample a valid tile, then fix the pack's ONE type
    // from what the local biome admits there.
    let anchorRow = -1, anchorCol = -1, packType = null;
    for (let a = 0; a < maxAttempts; a++) {
      const row = rLo + Math.floor(rng() * (rHi - rLo + 1));
      const col = cLo + Math.floor(rng() * (cHi - cLo + 1));
      const candidates = creatureTileCandidates(world, cfg, row, col, allowedTypes);
      if (!candidates) continue;
      anchorRow = row;
      anchorCol = col;
      packType = candidates[Math.floor(rng() * candidates.length)];
      break;
    }
    if (!packType) continue;  // nowhere legal to seat this pack at all

    emit(packType, anchorRow, anchorCol);

    const radius = packRadius(size);
    const span = 2 * radius + 1;
    for (let m = 1; m < size; m++) {
      for (let a = 0; a < maxAttempts; a++) {
        const row = anchorRow + Math.floor(rng() * span) - radius;
        const col = anchorCol + Math.floor(rng() * span) - radius;
        if (row < rLo || row > rHi || col < cLo || col > cHi) continue;
        const candidates = creatureTileCandidates(world, cfg, row, col, allowedTypes);
        // The member's OWN tile must admit the pack's type. A pack straddling
        // a biome boundary must not push a creature into a biome that forbids
        // it -- exactly the rule scatter enforces per cell.
        if (!candidates || !candidates.some((t) => t.name === packType.name)) continue;
        emit(packType, row, col);
        break;
      }
    }
  }
  return out;
}
```

- [ ] **Step 6: Export it**

In the `module.exports` block near `backend/src/services/mapService.js:975`, add `placeCreaturePacks,` and `creatureTileCandidates,` beside the existing `placeMapCreatures,`.

- [ ] **Step 7: Run the tests**

Run: `npm test --prefix backend -- --test-name-pattern="pack|placeMapCreatures"`
Expected: PASS — 11 new pack tests plus the existing `placeMapCreatures` suite unchanged.

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/mapService.js backend/tests/placeCreaturePacks.test.js
git commit -m "feat(population): place creatures in clustered packs, sharing scatter's validity rules (SOMET-246)"
```

---

### Task 4: `loadTileTypes` + `populateWorld`

**Files:**
- Create: `backend/src/services/tileTypes.js`
- Create: `backend/src/services/worldPopulation.js`
- Modify: `backend/src/index.js:253` (delete `getTileTypesMap`, import `loadTileTypes` and re-expose it under the old name)
- Test: `backend/tests/world_population_db.test.js`

**Interfaces:**
- Consumes: `resolveDensity` (Task 2); `placeCreaturePacks` (Task 3); existing `placeMapCreatures`, `isBoundedWorld`, `buildWorldGenConfig`, `loadBiomes`, `fetchVillages`, `fetchLinks`.
- Produces:
  - `loadTileTypes(db) -> Promise<Record<string, TileType>>` — identical output to the old `getTileTypesMap`, but takes its connection.
  - `populateWorld(client, worldRow, { rngSeed }) -> Promise<{ scattered, packed, total }>`.

- [ ] **Step 1: Move `getTileTypesMap` into a service**

Create `backend/src/services/tileTypes.js` containing the **exact body** of `getTileTypesMap` from `backend/src/index.js:253`, renamed and parameterised:

```js
// The ONE place a tile_types row becomes the shape the game engine expects.
//
// Lived in src/index.js as getTileTypesMap, closing over that module's `pool`,
// which made it unreachable from services without a circular import --
// worldPopulation.js needs it, and needs it on ITS caller's transaction.
// Takes `db` (a Pool or a checked-out Client) like loadBiomes, fetchVillages
// and fetchLinks already do.
async function loadTileTypes(db) {
  const result = await db.query('SELECT * FROM tile_types ORDER BY id ASC');
  const tileTypes = {};
  result.rows.forEach((row) => {
    tileTypes[row.name] = {
      id: row.id,
      color: row.color,
      walkable: row.walkable,
      speed: row.speed,
      image: row.image,
      sprite: row.sprite || null,
      render_mode: row.render_mode || 'color',
      validNeighbors: row.valid_neighbors || [],
      // Cache-busting key for the client's asset URLs. Generated keys are
      // stable (approving overwrites static.png in place) and /api/assets sends
      // max-age=300, so without this an approved regeneration keeps rendering
      // the previous texture for five minutes.
      updated_at: row.updated_at,
      wall_height: row.wall_height ?? 0,
      place_order: row.place_order ?? 0
    };
  });
  return tileTypes;
}

module.exports = { loadTileTypes };
```

That object literal is copied verbatim from `index.js:256-273`. Do not trim it — a field dropped here silently changes terrain generation for every caller, and `render_mode`/`wall_height`/`place_order` in particular feed wall rendering.

Then in `index.js`, delete the `getTileTypesMap` function and add near the other service imports:

```js
const { loadTileTypes } = require('./services/tileTypes');
const getTileTypesMap = () => loadTileTypes(pool);
```

Keeping the old name as a one-line adapter means the ~dozen existing call sites are untouched by this task.

- [ ] **Step 2: Verify nothing broke**

Run: `npm test --prefix backend`
Expected: PASS, same counts as before this task (baseline: 1129 pass / 0 fail / 55 skipped).

- [ ] **Step 3: Write the failing test**

Create `backend/tests/world_population_db.test.js`. It is DB-gated in the same style as the other `_db.test.js` files — copy the skip guard and the `withEntryPreserved` helper from `backend/tests/seed_map_db.test.js` (lines 1–90) rather than inventing new ones.

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { populateWorld } = require('../src/services/worldPopulation');

const URL = process.env.DATABASE_URL;
const describeDb = URL ? test : test.skip;

// Fixture worlds are named zzPop* and deleted by name, unconditionally, in a
// finally. Never delete by an id captured mid-test: if the test fails before
// the capture, the row leaks into the shared dev database forever.
const FIXTURES = ['zzPopHorde', 'zzPopDead'];

async function cleanup(pool) {
  await pool.query('DELETE FROM worlds WHERE name = ANY($1::text[])', [FIXTURES]);
}

// Only creature types that EXIST in the dev catalog. Inventing a name makes
// every assertion below vacuous -- the biome intersection would come back
// empty and the world would be legitimately unpopulated.
const ALLOWED = ['Skeleton', 'Bat'];

async function makeWorld(pool, name, density) {
  const r = await pool.query(
    `INSERT INTO worlds (name, seed, chunk_size, width, height, density,
                         allowed_creature_types, biomes, biome_cell, level_min, level_max)
     VALUES ($1, 4242, 32, 64, 64, $2, $3::jsonb, $4::jsonb, 16, 3, 5)
     RETURNING *`,
    [name, density, JSON.stringify(ALLOWED), JSON.stringify(['Deep Forest'])],
  );
  return r.rows[0];
}

describeDb('populateWorld fills an empty world from its density tier', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await cleanup(pool);
    const world = await makeWorld(pool, 'zzPopHorde', 'horde');
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await populateWorld(client, world, { rngSeed: 99 });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    // horde on 64x64: 49 scattered + 4 packs of 5-8. Packs may ship short on
    // a map with unwalkable terrain, so assert a floor, not an exact total --
    // but assert the SCATTER exactly, which is not subject to short packs.
    assert.equal(result.scattered, 49);
    assert.ok(result.packed >= 20, `packed ${result.packed} >= 20`);
    assert.equal(result.total, result.scattered + result.packed);

    const rows = await pool.query(
      'SELECT count(*)::int AS n FROM world_creatures WHERE world_id = $1', [world.id]);
    assert.equal(rows.rows[0].n, result.total);
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});

describeDb('populateWorld persists the resolved scatter count to creature_count', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await cleanup(pool);
    const world = await makeWorld(pool, 'zzPopHorde', 'horde');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await populateWorld(client, world, { rngSeed: 7 });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const r = await pool.query('SELECT creature_count FROM worlds WHERE id = $1', [world.id]);
    assert.equal(r.rows[0].creature_count, 49);
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});

describeDb('a repopulate converges rather than duplicating', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await cleanup(pool);
    const world = await makeWorld(pool, 'zzPopHorde', 'horde');
    const run = async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await populateWorld(client, world, { rngSeed: 55 });
        await client.query('COMMIT');
        return r;
      } finally { client.release(); }
    };
    const first = await run();
    const second = await run();
    assert.equal(first.total, second.total);
    const rows = await pool.query(
      'SELECT count(*)::int AS n FROM world_creatures WHERE world_id = $1', [world.id]);
    assert.equal(rows.rows[0].n, second.total);
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});

describeDb('guards survive a repopulate', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await cleanup(pool);
    const world = await makeWorld(pool, 'zzPopHorde', 'horde');
    await pool.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y)
       VALUES ($1, 'Village Guard', 550, 550, 30, 'S', 550, 550)`, [world.id]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await populateWorld(client, world, { rngSeed: 3 });
      await client.query('COMMIT');
    } finally { client.release(); }
    const g = await pool.query(
      `SELECT count(*)::int AS n FROM world_creatures
       WHERE world_id = $1 AND type = 'Village Guard'`, [world.id]);
    assert.equal(g.rows[0].n, 1);
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});

describeDb('the dead tier leaves a world genuinely empty', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await cleanup(pool);
    const world = await makeWorld(pool, 'zzPopDead', 'dead');
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await populateWorld(client, world, { rngSeed: 11 });
      await client.query('COMMIT');
    } finally { client.release(); }
    assert.equal(result.total, 0);
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" npm test --prefix backend -- --test-name-pattern="populateWorld|repopulate|dead tier"`
Expected: FAIL — `Cannot find module '../src/services/worldPopulation'`

- [ ] **Step 5: Write `populateWorld`**

Create `backend/src/services/worldPopulation.js`:

```js
// The ONE place a world's hostile creature population is written.
//
// Before this module, placement had TWO implementations and only one was
// reachable. seed-map.js never populated at all -- it wrote creature_count
// onto the row and stopped -- so a seeded world stayed empty until someone
// clicked re-roll in the admin UI, one world at a time. The per-chunk path
// that looked like a fallback (spawnChunkCreatures) was gated on
// !isBoundedWorld, false for every world that has ever existed.
//
// Both callers -- applyMapSpec and POST /api/worlds/:id/creatures -- go
// through here and nowhere else, so seeding and re-rolling can never again
// produce different worlds from the same spec.
//
// BOUNDARY: hostile creatures only. Village guards (insertVillageGuards) and
// portal guards (insertPortalGuards) keep their own owners; the delete below
// is scoped to spare them, so a guard survives a repopulate.
const { placeMapCreatures, placeCreaturePacks, isBoundedWorld } = require('./mapService');
const { buildWorldGenConfig } = require('./worldGenConfig');
const { resolveDensity } = require('./densityTiers');
const { loadTileTypes } = require('./tileTypes');
const { loadBiomes } = require('./biomes');
const { fetchVillages } = require('./villages');
const { fetchLinks } = require('./mapLinks');

const GUARD_TYPE = 'Village Guard';

// Pack sizes are drawn from the tier's [min, max] band using the SAME seed the
// placement uses, so a repopulate at a fixed seed reproduces the same pack
// shapes as well as the same positions.
function packSpecsFor({ packCount, packSizeMin, packSizeMax }, rngSeed) {
  const specs = [];
  let s = (rngSeed ^ 0x5b17) >>> 0;
  for (let i = 0; i < packCount; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const span = packSizeMax - packSizeMin + 1;
    specs.push({ size: packSizeMin + (s % span) });
  }
  return specs;
}

async function populateWorld(client, worldRow, { rngSeed }) {
  if (!isBoundedWorld(worldRow)) {
    throw new Error(`world "${worldRow.name}" has no width/height and cannot be populated`);
  }

  // Every read is on the CALLER's client, never a fresh pool.query: this runs
  // inside the caller's transaction and must see its snapshot, and the
  // delete + inserts below must commit or fail with it (F-007 / SOMET-187 --
  // a failure between them otherwise leaves a world with zero creatures and
  // no endpoint that re-derives them).
  await client.query(
    'DELETE FROM world_creatures WHERE world_id = $1 AND type <> $2',
    [worldRow.id, GUARD_TYPE],
  );

  const allowedNames = Array.isArray(worldRow.allowed_creature_types)
    ? worldRow.allowed_creature_types : [];
  const density = resolveDensity(worldRow.density, worldRow.width, worldRow.height);

  // Persist the resolved scatter count so worlds.creature_count keeps meaning
  // "how many scattered creatures this world holds" for the admin UI and every
  // existing reader. The tier is the authored value; this column is derived.
  await client.query('UPDATE worlds SET creature_count = $1 WHERE id = $2',
    [density.scatterCount, worldRow.id]);

  if (allowedNames.length === 0) return { scattered: 0, packed: 0, total: 0 };

  const et = await client.query(
    `SELECT name, hp, defense, resistances, faction FROM entity_types
      WHERE is_creature = true AND name = ANY($1::text[])`,
    [allowedNames],
  );
  // Guards are structural, never wild spawns -- the same filter the re-roll
  // route already applied before this module existed.
  const hostileTypes = et.rows.filter((t) => (t.faction || 'hostile') !== 'guard');
  if (hostileTypes.length === 0) return { scattered: 0, packed: 0, total: 0 };

  const tileTypes = await loadTileTypes(client);
  const villages = await fetchVillages(client, worldRow.id);
  const doorways = (await fetchLinks(client, worldRow.id)).map((l) => l.edge);
  const biomes = await loadBiomes(client, worldRow.biomes);
  const cfg = buildWorldGenConfig({ row: worldRow, tileTypes, doorways, villages, biomes });

  const scatter = placeMapCreatures(cfg, density.scatterCount, hostileTypes, rngSeed);
  const packed = placeCreaturePacks(
    cfg, packSpecsFor(density, rngSeed), hostileTypes, rngSeed);

  for (const c of [...scatter, ...packed]) {
    await client.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage, defense)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [worldRow.id, c.type, c.x, c.y, c.hp, c.facing, c.level, c.damage, c.defense],
    );
  }

  return { scattered: scatter.length, packed: packed.length, total: scatter.length + packed.length };
}

module.exports = { populateWorld, packSpecsFor, GUARD_TYPE };
```

Note: `doorways` is built from compass links only. `fetchLinks` returns portal rows too now (SOMET-243); if any row has `edge === 'PORTAL'`, filter it out before mapping — a `PORTAL` string reaching `doorways` would be treated as an unknown edge by `isDoorwayCell` and silently ignored, but leaving it in invites confusion. Use:

```js
  const doorways = (await fetchLinks(client, worldRow.id))
    .filter((l) => l.edge !== 'PORTAL').map((l) => l.edge);
```

- [ ] **Step 6: Run the tests**

Run: `DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" npm test --prefix backend -- --test-name-pattern="populateWorld|repopulate|guards survive|dead tier"`
Expected: PASS, 5 tests.

- [ ] **Step 7: Confirm the fixtures are gone**

Run:
```bash
PGPASSWORD=password psql -h 127.0.0.1 -p 15432 -U user -d game_db \
  -c "SELECT name FROM worlds WHERE name LIKE 'zzPop%';"
```
Expected: `(0 rows)`. If any remain, the cleanup is not in a `finally` — fix it before committing.

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/tileTypes.js backend/src/services/worldPopulation.js \
        backend/src/index.js backend/tests/world_population_db.test.js
git commit -m "feat(population): add populateWorld, the single creature-population path (SOMET-246)"
```

---

### Task 5: Map spec — `density` in, `creature_count` out

**Files:**
- Modify: `backend/seeds/mapSpec.js` (world loop, around `:99`)
- Modify: `backend/seeds/maps/hub-vale.map.json`, `loop-catacombs.map.json`, `spine-descent.map.json`
- Test: `backend/tests/mapSpec.test.js` (add cases to the existing file)

**Interfaces:**
- Consumes: `DENSITY_NAMES` from `backend/src/services/densityTiers.js` (Task 2).
- Produces: `validateMapSpec` accepts an optional `density` string per world and rejects `creature_count`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/mapSpec.test.js`. Build the fixture with whatever valid-spec helper that file already uses; if it constructs specs inline, follow that style.

```js
test('density accepts every tier name', () => {
  for (const d of ['dead', 'sparse', 'normal', 'dense', 'horde', 'swarm']) {
    const spec = validSpec();
    spec.worlds[0].density = d;
    assert.deepEqual(validateMapSpec(spec), []);
  }
});

test('density is optional', () => {
  const spec = validSpec();
  delete spec.worlds[0].density;
  assert.deepEqual(validateMapSpec(spec), []);
});

test('an unknown density is rejected by name', () => {
  const spec = validSpec();
  spec.worlds[0].density = 'enormous';
  const errors = validateMapSpec(spec);
  assert.ok(errors.some((e) => e.includes('density') && e.includes('enormous')),
    `expected a density error, got ${JSON.stringify(errors)}`);
});

// creature_count is now DERIVED from density by populateWorld. Leaving it
// authorable would give one number two sources of truth, and the spec's copy
// would silently lose.
test('the retired creature_count field is rejected, pointing at density', () => {
  const spec = validSpec();
  spec.worlds[0].creature_count = 7;
  const errors = validateMapSpec(spec);
  assert.ok(errors.some((e) => e.includes('creature_count') && e.includes('density')),
    `expected a creature_count error mentioning density, got ${JSON.stringify(errors)}`);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test --prefix backend -- --test-name-pattern="density|creature_count"`
Expected: FAIL — the unknown density and the retired field are both currently accepted.

- [ ] **Step 3: Add the validation**

At the top of `backend/seeds/mapSpec.js`, beside the other requires:

```js
const { DENSITY_NAMES } = require('../src/services/densityTiers.js');
```

Inside the `for (const w of worlds)` loop, immediately after the `level_band` block (`mapSpec.js:109`):

```js
    // Optional. Validated here as well as by worlds_density_check for the
    // same reason level_band is: `make reseed-map` clears every world BEFORE
    // seeding, so a tier rejected only by the database would fail after the
    // destruction, leaving the developer with no maps at all.
    if (w.density !== undefined && !DENSITY_NAMES.includes(w.density)) {
      errors.push(
        `world "${w.key}" density must be one of ${DENSITY_NAMES.join(', ')} (got "${w.density}")`);
    }

    // Retired: creature_count is now derived from `density` by populateWorld
    // and written back to the column. Accepting both would give one number two
    // authored sources, and the spec's would silently lose on every populate.
    if (w.creature_count !== undefined) {
      errors.push(
        `world "${w.key}" creature_count is no longer authored -- use "density" instead`);
    }
```

- [ ] **Step 4: Carry `density` through the seeder's INSERT**

In `backend/scripts/seed-map.js`, the worlds `INSERT` at `:69`: add `density` to the column list, `$15` to the `VALUES` list, `density = EXCLUDED.density` to the `DO UPDATE SET`, and `w.density ?? 'normal'` as the final parameter. Remove `creature_count` from the column list, the `VALUES` list, the `DO UPDATE SET` and the parameter array — `populateWorld` owns that column now.

- [ ] **Step 5: Delete `creature_count` from the three shipped specs**

Remove every `"creature_count": N,` line from `backend/seeds/maps/hub-vale.map.json`, `loop-catacombs.map.json` and `spine-descent.map.json`. **Add no `density` field to any world** — they all take the `normal` default. Authoring real tiers is P5's job.

- [ ] **Step 6: Run the tests**

Run: `npm test --prefix backend -- --test-name-pattern="mapSpec|density|creature_count"`
Expected: PASS, including the existing spec-validation suite.

- [ ] **Step 7: Commit**

```bash
git add backend/seeds/mapSpec.js backend/scripts/seed-map.js backend/seeds/maps/
git commit -m "feat(population): author density per world and retire the creature_count spec field (SOMET-246)"
```

---

### Task 6: Seeding populates

**Files:**
- Modify: `backend/scripts/seed-map.js` (`applyMapSpec`)
- Test: `backend/tests/seed_map_db.test.js` (add a case to the existing file)

**Interfaces:**
- Consumes: `populateWorld(client, worldRow, { rngSeed })` (Task 4).
- Produces: `applyMapSpec` returns `{ worlds, links, villages, portalGuards, creatures }` — one new key.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/seed_map_db.test.js`, following that file's existing fixture and `withEntryPreserved` conventions:

```js
// The defect this whole sub-project exists to fix: before P1, applyMapSpec
// wrote creature_count onto the row and placed nothing, so every seeded world
// arrived empty. Assert creatures ON THE GROUND, not the returned count --
// a return value can be right while the INSERT never happened.
describeDb('seeding populates every world with creatures', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await cleanup(pool);
    const result = await withEntryPreserved(pool, () => applyMapSpec(pool, TEST_SPEC));
    assert.ok(result.creatures > 0, `expected creatures, got ${result.creatures}`);

    const rows = await pool.query(
      `SELECT w.name, count(wc.id)::int AS n
         FROM worlds w LEFT JOIN world_creatures wc ON wc.world_id = w.id
        WHERE w.name = ANY($1::text[])
        GROUP BY w.name`,
      [TEST_SPEC.worlds.map((w) => w.name)],
    );
    assert.equal(rows.rows.length, TEST_SPEC.worlds.length);
    for (const r of rows.rows) {
      assert.ok(r.n > 0, `world ${r.name} is empty`);
    }
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" npm test --prefix backend -- --test-name-pattern="seeding populates"`
Expected: FAIL — `expected creatures, got undefined`

- [ ] **Step 3: Wire it in**

In `backend/scripts/seed-map.js`, add the import beside the others:

```js
const { populateWorld } = require('../src/services/worldPopulation.js');
```

Add a counter beside `portalGuardsWritten`:

```js
    let creaturesWritten = 0;
```

Then, **after** the portal-guard pass and **before** the villages loop, add a population pass:

```js
    // After links exist (populateWorld reads them for doorway tiles) and after
    // portal guards (its delete spares guards but the guards must already be
    // there to be spared). Before villages is fine either way -- village
    // guards are inserted by createVillage below and are likewise spared.
    //
    // Seeded worlds CONVERGE to their spec: populateWorld deletes non-guard
    // creatures and re-places them, so editing a density tier and re-seeding
    // takes effect. The alternative -- populate only when empty -- makes a
    // spec edit silently do nothing, a worse trap than the killed creatures
    // coming back that this costs.
    for (const w of spec.worlds) {
      const worldId = idByKey.get(w.key);
      const wr = await client.query('SELECT * FROM worlds WHERE id = $1', [worldId]);
      const n = await populateWorld(client, wr.rows[0], { rngSeed: w.seed });
      creaturesWritten += n.total;
    }
```

Using `w.seed` as `rngSeed` — the world's own authored seed — is what makes a re-seed of an unchanged spec reproduce the same population, rather than reshuffling every world on every run.

Finally add `creatures: creaturesWritten` to the returned object, and extend the CLI's console line:

```js
    .then((n) => console.log(
      `applied ${name}: ${n.worlds} worlds, ${n.links} links, ${n.villages} villages, `
      + `${n.portalGuards} portal guards, ${n.creatures} creatures`))
```

- [ ] **Step 4: Run the tests**

Run: `DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" npm test --prefix backend -- --test-name-pattern="seed_map|seeding populates"`
Expected: PASS.

- [ ] **Step 5: Populate the real maps and verify by query**

Run:
```bash
for s in hub-vale loop-catacombs spine-descent; do make seed-map SPEC=$s; done
PGPASSWORD=password psql -h 127.0.0.1 -p 15432 -U user -d game_db -c "
SELECT w.name, w.density, count(wc.id) AS creatures
FROM worlds w LEFT JOIN world_creatures wc ON wc.world_id = w.id
GROUP BY w.id ORDER BY creatures;"
```
Expected: **no world reports 0 creatures.** Every world should show `normal` density and roughly 12–20 creatures (12 scattered plus one pack of 3–4, packs possibly short). Before this task, 11 of 20 reported 0.

- [ ] **Step 6: Commit**

```bash
git add backend/scripts/seed-map.js backend/tests/seed_map_db.test.js
git commit -m "fix(population): populate creatures when a map spec is seeded (SOMET-246)"
```

---

### Task 7: Re-roll route delegates

**Files:**
- Modify: `backend/src/index.js:1707-1790` (the `POST /api/worlds/:id/creatures` handler)

**Interfaces:**
- Consumes: `populateWorld` (Task 4).
- Produces: unchanged response shape — `{ placed }` or `{ placed, liveWarning }`.

- [ ] **Step 1: Replace the inline placement block**

In the handler, keep the surrounding structure — the 404, the `isBoundedWorld` 400, the `client = await pool.connect()`, the `BEGIN`/`COMMIT`/`ROLLBACK`/`release`, the guard re-derivation, `evictOrWarn` and the response. Replace only the body between `await client.query('BEGIN');` and the guard re-derivation with:

```js
    let placed = 0;
    try {
      // Delegates to the SAME function seeding uses, so re-rolling can never
      // produce a world the spec would not. It owns the non-guard delete, the
      // density resolution, both placement passes and the creature_count
      // write-back; this route owns only the guard re-derivation below.
      const n = await populateWorld(client, world, {
        rngSeed: Math.floor(Math.random() * 2 ** 31),
      });
      placed = n.total;

      await client.query(`DELETE FROM world_creatures WHERE world_id = $1 AND type = $2`,
        [id, GUARD_TYPE]);
      await insertVillageGuards(client, id, await fetchVillages(client, world.id));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
```

Add the import beside the other service requires:

```js
const { populateWorld } = require('./services/worldPopulation');
```

Then delete whatever is now unused in `index.js`: the `placeMapCreatures` import if no other call site remains, and the `count`/`allowed` locals this handler no longer reads. Check with `grep -n "placeMapCreatures\|buildWorldGenConfig" backend/src/index.js` before removing an import — other routes may still use them.

- [ ] **Step 2: Verify the route by exercising it**

The `docker compose` dev stack hot-reloads the backend via nodemon on `:13101`. With it running and an admin token in `$TOKEN`:

```bash
WID=$(PGPASSWORD=password psql -h 127.0.0.1 -p 15432 -U user -d game_db -tAc \
  "SELECT id FROM worlds WHERE name = 'Old Trailhead'")
curl -s -X POST "http://localhost:13101/api/worlds/$WID/creatures" \
  -H "Authorization: Bearer $TOKEN"
PGPASSWORD=password psql -h 127.0.0.1 -p 15432 -U user -d game_db -c "
SELECT type, count(*) FROM world_creatures WHERE world_id = '$WID' GROUP BY type;"
```
Expected: the response reports `{"placed": N}` with N ≥ 12, and the query shows both hostile creatures and the world's `Village Guard` rows — guards must NOT have been wiped.

- [ ] **Step 3: Run the full suite**

Run: `DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" npm test --prefix backend`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/index.js
git commit -m "refactor(population): route the admin creature re-roll through populateWorld (SOMET-246)"
```

---

### Task 8: Retire the dead spawn path

**Files:**
- Modify: `backend/src/services/mapService.js` (delete `spawnChunkCreatures` + its export)
- Modify: `backend/src/authority/server.js:553` (delete the `!isBoundedWorld` branch and the import)
- Modify: `backend/src/index.js:1428` (require width/height on `POST /api/worlds`)
- Delete/trim tests: `backend/tests/worldGen.test.js`, `backend/tests/creature_spawn_levels.test.js`, `backend/tests/authority_creatures_combat.test.js:234`, and review `backend/tests/guardSpawnPool.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `spawnChunkCreatures` no longer exists. `isBoundedWorld` **stays** — `placeMapCreatures` and the re-roll route both use it.

- [ ] **Step 1: Require width and height on world creation**

In `backend/src/index.js` around `:1425`, replace the paired-null tolerance:

```js
    const w = Number.isFinite(width) ? Math.floor(width) : null;
    const h = Number.isFinite(height) ? Math.floor(height) : null;
    // Both required, not merely paired. Creature population only ever runs
    // for bounded worlds, and the per-chunk fallback that used to cover
    // unbounded ones is gone (SOMET-246) -- so an unbounded world would sit
    // empty forever with nothing to notice. seeds/mapSpec.js already requires
    // both, so map specs are unaffected by this narrowing.
    if (w === null || h === null) {
      return res.status(400).json({ error: 'width and height are required' });
    }
```

Keep the existing 8–4096 range check that follows.

- [ ] **Step 2: Delete the authority's dead branch**

In `backend/src/authority/server.js`, remove `spawnChunkCreatures` from the import on line 12, and delete the whole `if (rowCount > 0 && entry.hostileCreatureTypes.length && !isBoundedWorld(entry.row)) { ... }` block at `:553`, including its explanatory comment.

The surrounding transaction stays exactly as it is — the `world_chunks` INSERT is still this function's once-only materialisation flag, and the `BEGIN`/`COMMIT`/`ROLLBACK` shape must not be simplified just because the block inside it shrank.

Check whether `entry.hostileCreatureTypes` still has any reader (`grep -n "hostileCreatureTypes" backend/src/authority/server.js`). If the deleted block was its only one, remove the field and the query that populates it too.

- [ ] **Step 3: Delete the function**

In `backend/src/services/mapService.js`, delete `function spawnChunkCreatures` (`:512`–~`:548`) and its entry in `module.exports`. Also delete `CREATURE_SPAWN_CHANCE` and `CREATURE_SALT` if nothing else reads them (`grep -n "CREATURE_SALT\|CREATURE_SPAWN_CHANCE" backend/src/services/mapService.js`). **Keep** `LEVEL_SALT`, `CREATURE_BASE_DAMAGE` and `CREATURE_TILE_PX` — `placeMapCreatures` and `placeCreaturePacks` use them.

- [ ] **Step 4: Remove its tests**

- `backend/tests/worldGen.test.js`: delete the `spawnChunkCreatures` require at `:194` and the four tests at `:198`–`:233`.
- `backend/tests/creature_spawn_levels.test.js`: delete every `spawnChunkCreatures` test. If the file is left with only `placeMapCreatures` cases, keep it; if it is left empty, delete the file.
- `backend/tests/authority_creatures_combat.test.js`: delete the test at `:234` and the require at `:7`.
- `backend/tests/guardSpawnPool.test.js`: read it. Its comment describes unbounded worlds handing their whole creature list to `spawnChunkCreatures`. If its assertions only ever exercised the unbounded path, delete it; if it also covers the bounded guard-filtering that `populateWorld` now performs, keep it and update the comment to name `populateWorld` instead.

Do not delete a test merely because it fails to compile after the removal — read each one and confirm its subject is genuinely gone.

- [ ] **Step 5: Run the full suite**

Run: `DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" npm test --prefix backend`
Expected: PASS. Total count will be lower than the 1129 baseline by exactly the number of deleted tests — note the new number in your report so the reviewer can check it against what you removed.

- [ ] **Step 6: Prove there is exactly one spawn path left**

Run: `grep -rn "spawnChunkCreatures" backend/ --include=*.js | grep -v node_modules`
Expected: only comment references in `creatureLevel.js:6` and the two migrations, which are historical notes about code that used to exist. Update `creatureLevel.js:6` to name `placeMapCreatures`/`placeCreaturePacks`; leave the migrations alone — a migration's comments describe the world at the time it ran and must not be rewritten.

- [ ] **Step 7: Verify an unbounded world can no longer be created**

```bash
curl -s -X POST http://localhost:13101/api/worlds \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"zzUnbounded","seed":1,"chunk_size":64}'
```
Expected: `{"error":"width and height are required"}` with HTTP 400, and no `zzUnbounded` row in `worlds`.

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/mapService.js backend/src/authority/server.js \
        backend/src/index.js backend/src/services/creatureLevel.js backend/tests/
git commit -m "refactor(population): retire the unreachable per-chunk spawn path (SOMET-246)"
```

---

## Verification

After Task 8, the whole sub-project is exercised end to end:

```bash
for s in hub-vale loop-catacombs spine-descent; do make seed-map SPEC=$s; done
PGPASSWORD=password psql -h 127.0.0.1 -p 15432 -U user -d game_db -c "
SELECT w.name, w.density, w.creature_count, count(wc.id) AS on_ground
FROM worlds w LEFT JOIN world_creatures wc ON wc.world_id = w.id
GROUP BY w.id ORDER BY on_ground;"
```

Every world holds creatures. `creature_count` shows the derived scatter count (12 for a 64×64 at `normal`), and `on_ground` exceeds it by that world's pack members.

Then confirm in a browser that creatures actually render and are fightable in a world that was empty before — `Catacomb Threshold` is a good choice, since it was one of the 11. A green suite has repeatedly missed defects here that a browser pass caught immediately.
