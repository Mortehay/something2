# Creature Density Field (Slice A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make creature placement position-dependent — thick far from safety, in hostile biomes, and in noise peaks — instead of uniform across a world, and re-scale the density ladder so a screen holds 2–30 creatures instead of 0.7–2.7.

**Architecture:** A new pure module `creatureDensityField.js` builds a per-config weight field (`safety × biome × noise`, normalized to mean 1.0 and clamped to `[0.15, 1.5]`), cached in a WeakMap keyed on the generation config exactly as `SAFE_CTX` already is. `placeMapCreatures` and `placeCreaturePacks` gain one extra acceptance gate inside their existing rejection-sampling loops. Because both `populateWorld` (seeding, admin re-roll) and `enqueueDeficit` (respawn backstop) call `placeMapCreatures`, both inherit the field with no changes of their own.

**Tech Stack:** Node 20 CommonJS, raw `pg`, `node:test` + `node:assert`, `node-pg-migrate`.

**Spec:** `docs/superpowers/specs/2026-08-15-creature-density-and-packs-design.md`

## Global Constraints

- **The field is redistributive, never additive.** `placeMapCreatures` loops `for (i = 0; i < count; i++)`; it places `count` creatures whatever the field says. Tests assert *distribution* and an *unchanged total*. A test asserting the field changes a world's headcount is asserting a bug.
- **The field lives inside `placeMapCreatures`**, not in any caller. `worldPopulation.populateWorld` and `creatureRespawn.enqueueDeficit` both call it; putting the gate in a caller makes respawns uniform and erodes the field over hours of play.
- **Expected values in tests are hand-typed literals, never recomputed from the constant under test.** A tier test that derives its expectation from `DENSITY_TIERS` passes at any value and asserts nothing.
- **Never mutate the shared dev database.** SELECTs only. No `DELETE`, no re-roll, no `migrate:up`, no `migrate:down`, no `pgmigrations` edit. DB tests create and drop their own `zz*`-named fixtures.
- **Never `docker restart` any container.** The compose services run `tail -f /dev/null` as CMD with vite/nodemon started inside; a restart kills the dev server with nothing to revive it.
- **Do not run any script under `backend/scripts/`.** The post-merge world re-roll is a separate, user-confirmed step.
- **Safe regions stay absolute.** The weight gate is additional to `creatureTileCandidates`, never a replacement. No creature may be placed on a safe tile at any weight.
- **Determinism is preserved.** The field is derived from `cfg.seed`; the same seed and config must produce identical placement every run.
- **Migration timestamps collide across sessions.** Check `git log origin/main` for the highest `backend/migrations/` timestamp immediately before committing and pick a higher one.
- Backend tests run as `npm test` from `backend/`. DB-backed tests self-skip unless `DATABASE_URL` is set (`const describeDb = URL ? test : test.skip`).
- **`SOMET-NNN` in every commit message below is a placeholder.** The controller files the Plane work item before Task 1 and supplies the real identifier in each task's dispatch. Never commit the literal string `SOMET-NNN`.

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/services/creatureDensityField.js` | **New.** The field: the three terms, the BFS distance-to-safety pass, normalization, clamp, and the per-cfg cache. Pure; never touches a database. |
| `backend/src/services/mapService.js` | Wires the gate into `placeMapCreatures` and `placeCreaturePacks`; maps `creature_density` through `normalizeBiomes`. |
| `backend/src/services/biomes.js` | `loadBiomes`' explicit SELECT must name `creature_density`. |
| `backend/src/services/densityTiers.js` | Re-scaled `perThousand` rates. |
| `backend/migrations/<ts>_biome_creature_density.js` | **New.** Adds `biomes.creature_density`. |
| `backend/seeds/data/biomes.js` | Per-biome density values for the seeded catalog. |

`creatureDensityField.js` is a separate module rather than more code in `mapService.js` because `mapService.js` is already ~1300 lines, and the field is a self-contained pure computation with its own constants and its own tests.

---

## Task 1: Carry `creature_density` from the database to the generation config

The column has to survive four hops: migration → `loadBiomes`' explicit SELECT → `normalizeBiomes` → `cfg.biomes[i]`. Two of those hops drop unnamed fields silently, which is the exact failure that shipped twice before (SOMET-288, SOMET-309): green suite, `undefined` on the live authority, dead feature.

**Files:**
- Create: `backend/migrations/<ts>_biome_creature_density.js`
- Modify: `backend/src/services/biomes.js:22-25` (the SELECT column list)
- Modify: `backend/src/services/mapService.js:137-147` (`normalizeBiomes`)
- Modify: `backend/seeds/data/biomes.js`
- Test: `backend/tests/biomesLoader.test.js` (append), `backend/tests/mapService.test.js` (append)

**Interfaces:**
- Produces: `cfg.biomes[i].creatureDensity` — a finite number, default `1.0`. Task 2 reads it and nothing else from the biome record.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/biomesLoader.test.js`:

```js
const fs = require('node:fs');
const path = require('node:path');

// A SOURCE-TEXT test, deliberately. loadBiomes uses an explicit column list,
// so a column missing from it arrives `undefined` on the authority and on the
// /chunk route and NOWHERE ELSE -- a DB test builds its row differently and
// cannot see the difference. Same guard shape as spawn_portal_fallback.test.js.
test('loadBiomes SELECT names creature_density', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'biomes.js'), 'utf8');
  assert.match(src, /creature_density/,
    'loadBiomes must name creature_density in its explicit SELECT, or the '
    + 'column arrives undefined on the live authority with a green suite');
});
```

Append to `backend/tests/mapService.test.js`:

```js
test('normalizeBiomes carries creature_density through as creatureDensity', () => {
  const cfg = worldConfig({
    tileTypes: { grass: { walkable: true } },
    biomes: [{ name: 'swamp', creature_density: 2, creature_types: ['Wolf'] }],
  });
  assert.strictEqual(cfg.biomes[0].creatureDensity, 2);
});

test('normalizeBiomes defaults creature_density to 1 when absent or junk', () => {
  const cfg = worldConfig({
    tileTypes: { grass: { walkable: true } },
    biomes: [
      { name: 'a' },
      { name: 'b', creature_density: null },
      { name: 'c', creature_density: 'heavy' },
      { name: 'd', creature_density: -3 },
    ],
  });
  assert.strictEqual(cfg.biomes[0].creatureDensity, 1);
  assert.strictEqual(cfg.biomes[1].creatureDensity, 1);
  assert.strictEqual(cfg.biomes[2].creatureDensity, 1);
  // Negative is not a "thin" biome -- a negative weight would invert the
  // acceptance gate. Rejected to the default, never coerced to 0.
  assert.strictEqual(cfg.biomes[3].creatureDensity, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend && npm test -- tests/biomesLoader.test.js tests/mapService.test.js
```

Expected: FAIL — `creature_density` absent from `biomes.js`; `cfg.biomes[0].creatureDensity` is `undefined`.

- [ ] **Step 3: Write the migration**

Pick the timestamp per the Global Constraints (higher than any on `origin/main`). Create `backend/migrations/<ts>_biome_creature_density.js`:

```js
// Per-biome multiplier on the creature density field (SOMET-<N>, Slice A).
//
// Biomes already gate WHICH creature types may spawn (biomes.creature_types);
// this gates HOW MANY. 1.0 is "no opinion", so every existing row keeps the
// behaviour it has today and the column can never silently thin a world that
// was authored before it existed.
//
// NOT NULL with a default rather than nullable: a null would have to be
// defaulted at three separate read sites, and one of them would eventually be
// forgotten.
exports.up = (pgm) => {
  pgm.addColumn('biomes', {
    creature_density: { type: 'real', notNull: true, default: 1.0 },
  });
};

exports.down = (pgm) => pgm.dropColumn('biomes', 'creature_density');
```

- [ ] **Step 4: Name the column in `loadBiomes`' SELECT**

In `backend/src/services/biomes.js`, extend the column list:

```js
  const { rows } = await pool.query(
    `SELECT id, name, terrain_tiles, flora_types, creature_types,
            palette, art_style, exclusions, color, creature_density
       FROM biomes
      WHERE name = ANY($1::text[])`,
    [wanted],
  );
```

- [ ] **Step 5: Map it in `normalizeBiomes`**

In `backend/src/services/mapService.js`, replace the `.map(...)` body of `normalizeBiomes`:

```js
function normalizeBiomes(rawBiomes, names) {
  if (!Array.isArray(rawBiomes)) return [];
  return rawBiomes
    .filter((b) => b && typeof b.name === 'string')
    .map((b) => ({
      name: b.name,
      terrainNames: biomeTerrainNames(b, names),
      floraTypes: Array.isArray(b.flora_types) ? b.flora_types : [],
      creatureTypes: Array.isArray(b.creature_types) ? b.creature_types : [],
      // The creature-density field's biome term (Slice A). Anything that is
      // not a positive finite number becomes 1.0 -- "no opinion" -- rather
      // than 0 or NaN: a 0 would make a biome silently uninhabitable and a
      // NaN would poison the whole normalized field through the mean.
      creatureDensity: (Number.isFinite(b.creature_density) && b.creature_density > 0)
        ? Number(b.creature_density) : 1,
    }));
}
```

- [ ] **Step 6: Give the seeded biomes their densities**

In `backend/seeds/data/biomes.js`, add a `creature_density` field to each biome record. The file holds exactly **32** biomes; every one is listed below with the value to use verbatim. Do not invent names, and do not leave a row without the field.

| biome | creature_density | | biome | creature_density |
|---|---|---|---|---|
| Meadow | 0.5 | | Frostvault | 1.8 |
| Storm Coast | 0.6 | | Deepvault | 1.8 |
| Arid Dunes | 0.8 | | Hive Warrens | 2.2 |
| Highlands | 0.9 | | Sunken Cistern | 1.8 |
| Deep Forest | 1.0 | | Umbral Warren | 2.2 |
| Frozen Waste | 1.1 | | Crystal Hollows | 1.6 |
| Sunken Ruins | 1.4 | | Blightworks | 2.0 |
| Verdant Jungle | 1.6 | | Gloomfen | 1.9 |
| Mire | 2.0 | | Sunken Foundry | 1.8 |
| Ashfields | 1.7 | | Abyssal Rift | 2.4 |
| Catacombs | 2.3 | | Infernal Gate | 2.5 |
| Ossuary | 2.4 | | Shattered Vault | 2.3 |
| Cavern | 1.9 | | Fallen Sanctum | 2.2 |
| Fungal Deep | 2.1 | | Dreaming Dark | 2.3 |
| Emberdepths | 2.2 | | Grave of Titans | 2.1 |
| | | | Pestilent Deep | 2.4 |
| | | | The Maw | 2.5 |

The shape is deliberate: the five surface biomes a new player meets (`Meadow`, `Storm Coast`, `Arid Dunes`, `Highlands`, `Deep Forest`) sit at or below 1.0, and everything underground sits above it, so descending is what makes the world crowded.

Add an assertion to the existing biome catalog test so a biome added later cannot silently arrive without a density. Append to `backend/tests/biome_catalog_integrity.test.js`:

```js
test('every seeded biome declares a creature_density in range', () => {
  for (const b of BIOMES) {
    assert.ok(Number.isFinite(b.creature_density),
      `biome ${b.name} is missing creature_density`);
    assert.ok(b.creature_density >= 0.4 && b.creature_density <= 2.5,
      `biome ${b.name} density ${b.creature_density} outside [0.4, 2.5]`);
  }
});
```

Use whatever name that file already imports the biome array under; do not rename it.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd backend && npm test -- tests/biomesLoader.test.js tests/mapService.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/migrations backend/src/services/biomes.js \
        backend/src/services/mapService.js backend/seeds/data/biomes.js \
        backend/tests/biomesLoader.test.js backend/tests/mapService.test.js
git commit -m "feat(density): carry per-biome creature_density into the gen config (SOMET-NNN)"
```

---

## Task 2: The density field module

A pure module. Given a generation config, produce a normalized, clamped weight for any tile.

**Files:**
- Create: `backend/src/services/creatureDensityField.js`
- Test: `backend/tests/creatureDensityField.test.js`

**Interfaces:**
- Consumes: `cfg.biomes[i].creatureDensity` (Task 1); `cfg.seed`, `cfg.bounds.{width,height}`, `cfg.biomeCell`; `safeRegion.isSafeTile(ctx, gRow, gCol)`; `mapService.globalValueNoise(seed, gRow, gCol, cellSize)` and `mapService.sampleBiomeRegion(cfg, gRow, gCol)`.
- Produces:
  - `buildDensityField(cfg, safeCtx) -> { weightAt(gRow, gCol): number, max: number }` — `weightAt` returns a value in `[WEIGHT_MIN, WEIGHT_MAX]`; `max` is `WEIGHT_MAX`.
  - Constants `WEIGHT_MIN`, `WEIGHT_MAX`, `SAFETY_RAMP`, `NOISE_CELL`, `NOISE_SALT`, `safetyForDistance(d)`, `noiseWeight(seed, gRow, gCol)`.

**Circular-import note:** `safeRegion.js` deliberately imports nothing because `mapService` requires it. This module has the same constraint in reverse — `mapService` will require *it*, so it must **not** require `mapService`. `globalValueNoise` and `sampleBiomeRegion` are therefore passed **in** as arguments by `mapService`, exactly as `pathCells` is passed into `buildSafeContext`. Do not add a `require('./mapService')` here.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/creatureDensityField.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const {
  buildDensityField, safetyForDistance, noiseWeight,
  WEIGHT_MIN, WEIGHT_MAX, SAFETY_RAMP,
} = require('../src/services/creatureDensityField');

// Hand-typed literals throughout. Deriving an expectation from the constant
// under test makes the test pass at any value.
test('safetyForDistance is a rising step function over the ramp', () => {
  assert.strictEqual(safetyForDistance(0), 0);
  assert.strictEqual(safetyForDistance(1), 0.4);
  assert.strictEqual(safetyForDistance(5), 0.4);
  assert.strictEqual(safetyForDistance(6), 1);
  assert.strictEqual(safetyForDistance(12), 1);
  assert.strictEqual(safetyForDistance(13), 1.4);
  assert.strictEqual(safetyForDistance(20), 1.4);
  assert.strictEqual(safetyForDistance(21), 1.6);
  assert.strictEqual(safetyForDistance(999), 1.6);
});

test('safetyForDistance returns the far value for unreachable tiles', () => {
  // Infinity is what the BFS leaves on a map with no safe tiles at all.
  assert.strictEqual(safetyForDistance(Infinity), 1.6);
});

test('SAFETY_RAMP matches the last distance that is not yet far', () => {
  assert.strictEqual(SAFETY_RAMP, 20);
});

test('noiseWeight stays within its band across many tiles', () => {
  let lo = Infinity, hi = -Infinity;
  for (let r = 0; r < 60; r++) {
    for (let c = 0; c < 60; c++) {
      const w = noiseWeight(12345, r, c);
      lo = Math.min(lo, w); hi = Math.max(hi, w);
    }
  }
  assert.ok(lo >= 0.3, `noise floor ${lo} below 0.3`);
  assert.ok(hi <= 1.8, `noise ceiling ${hi} above 1.8`);
  // The band must actually be used, or the term is a constant in disguise.
  assert.ok(hi - lo > 0.5, `noise range ${hi - lo} too flat to matter`);
});

// --- buildDensityField -------------------------------------------------

// Minimal stand-ins. The field must not require mapService (circular import),
// so its two mapService helpers arrive as arguments.
function fakeCfg(overrides = {}) {
  return {
    seed: 777,
    bounds: { width: 60, height: 60 },
    biomes: [],
    ...overrides,
  };
}
const noSafe = { safeAt: () => false };
const deps = {
  noise: (seed, r, c, cell) => {
    // Deterministic, cheap, and genuinely varying -- a constant here would
    // make the normalization test vacuous.
    const v = Math.sin((seed % 97) + r / cell + c / (cell * 1.7));
    return (v + 1) / 2;
  },
  regionAt: () => null,
};

test('buildDensityField normalizes to mean 1 over interior non-safe tiles', () => {
  const f = buildDensityField(fakeCfg(), noSafe, deps);
  let sum = 0, n = 0;
  for (let r = 1; r <= 58; r++) {
    for (let c = 1; c <= 58; c++) { sum += f.weightAt(r, c); n++; }
  }
  const mean = sum / n;
  // Clamping perturbs the mean, so this is a band, not an equality.
  assert.ok(mean > 0.9 && mean < 1.1, `mean ${mean} not near 1`);
});

test('buildDensityField clamps every tile into [WEIGHT_MIN, WEIGHT_MAX]', () => {
  const f = buildDensityField(fakeCfg({
    biomes: [{ name: 'crypt', creatureDensity: 2.5, creatureTypes: [], terrainNames: [] }],
  }), noSafe, { ...deps, regionAt: (cfg) => cfg.biomes[0] });
  for (let r = 1; r <= 58; r++) {
    for (let c = 1; c <= 58; c++) {
      const w = f.weightAt(r, c);
      assert.ok(w >= WEIGHT_MIN && w <= WEIGHT_MAX, `weight ${w} at ${r},${c} out of band`);
    }
  }
  assert.strictEqual(f.max, WEIGHT_MAX);
});

test('buildDensityField is deterministic for the same seed', () => {
  const a = buildDensityField(fakeCfg(), noSafe, deps);
  const b = buildDensityField(fakeCfg(), noSafe, deps);
  for (let r = 1; r <= 20; r++) {
    assert.strictEqual(a.weightAt(r, r), b.weightAt(r, r));
  }
});

test('buildDensityField differs for a different seed', () => {
  const a = buildDensityField(fakeCfg({ seed: 1 }), noSafe, deps);
  const b = buildDensityField(fakeCfg({ seed: 2 }), noSafe, deps);
  let differences = 0;
  for (let r = 1; r <= 50; r++) if (a.weightAt(r, r) !== b.weightAt(r, r)) differences++;
  assert.ok(differences > 20, `only ${differences}/50 tiles differ between seeds`);
});

test('tiles near a safe region weigh less than tiles far from one', () => {
  // One safe block in the top-left corner.
  const safeCtx = { safeAt: (r, c) => r < 4 && c < 4 };
  const flat = { noise: () => 0.5, regionAt: () => null };
  const f = buildDensityField(fakeCfg(), safeCtx, flat);
  assert.ok(f.weightAt(5, 5) < f.weightAt(40, 40),
    'a tile 1-2 tiles from safety must weigh less than one far away');
});

test('a denser biome outweighs a thinner one on an otherwise flat map', () => {
  const thin = { name: 'meadow', creatureDensity: 0.5 };
  const thick = { name: 'swamp', creatureDensity: 2 };
  const flat = {
    noise: () => 0.5,
    // Left half thin, right half thick.
    regionAt: (cfg, r, c) => (c < 30 ? thin : thick),
  };
  const f = buildDensityField(fakeCfg({ biomes: [thin, thick] }), noSafe, flat);
  assert.ok(f.weightAt(20, 40) > f.weightAt(20, 10),
    'the swamp half must weigh more than the meadow half');
});

test('buildDensityField returns a flat field for an unbounded config', () => {
  const f = buildDensityField(fakeCfg({ bounds: null }), noSafe, deps);
  assert.strictEqual(f.weightAt(3, 3), 1);
  assert.strictEqual(f.weightAt(900, 900), 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend && npm test -- tests/creatureDensityField.test.js
```

Expected: FAIL — `Cannot find module '../src/services/creatureDensityField'`.

- [ ] **Step 3: Write the module**

Create `backend/src/services/creatureDensityField.js`:

```js
// WHERE creatures go, as opposed to how many of them a world gets.
//
// Placement used to rejection-sample the interior uniformly, so every screen of
// a world was statistically identical: no reason to prefer one direction over
// another, and no such thing as a dangerous place. This module supplies a
// per-tile WEIGHT that placement uses as an extra acceptance gate, so creatures
// concentrate away from safety, in hostile biomes, and in noise peaks.
//
// PURELY REDISTRIBUTIVE. placeMapCreatures loops `for (i = 0; i < count; i++)`
// and places `count` creatures whatever this says; the field decides only where
// they land. A world's total comes from its density tier and
// MAX_WORLD_CREATURES, never from here. Normalizing to mean 1.0 is therefore
// about keeping the ACCEPTANCE RATE high -- an un-normalized field would reject
// most samples, exhaust maxAttempts and under-deliver -- and not about hitting
// a target count.
//
// IMPORTS NOTHING FROM mapService, deliberately and permanently. mapService
// requires this module, so a require back would be a cycle and whichever loaded
// second would see a half-built exports object -- the same trap safeRegion.js's
// header documents. The two mapService helpers this needs (the value-noise
// function and the biome sampler) are passed IN, exactly as safeRegion takes
// pathCells as an argument rather than recomputing them.

// --- the three terms ---------------------------------------------------

// Distance from safety, in tiles, at which a region is as dangerous as it gets.
const SAFETY_RAMP = 20;

// Rising step rather than a smooth curve: a player should be able to feel the
// transition when they leave the road, and steps are exactly testable in a way
// an interpolated curve is not.
function safetyForDistance(d) {
  if (d <= 0) return 0;        // inside safety; creatureTileCandidates also refuses these
  if (d <= 5) return 0.4;
  if (d <= 12) return 1;
  if (d <= SAFETY_RAMP) return 1.4;
  return 1.6;                  // also the value for Infinity (no safe tile on the map)
}

// Noise cell size in tiles. A screen is ~225 tiles (~15x15), so 12 puts a full
// quiet-to-thick cycle at roughly two screens -- something a player walks
// THROUGH, rather than something that averages out under them.
const NOISE_CELL = 12;

// Salted away from the terrain field (cfg.seed), the biome field
// (BIOME_FIELD_XOR), the decoration field (DECO_SEED_XOR) and both placement
// streams, so creature-thick regions do not silently line up with forests.
const NOISE_SALT = 0x27d4eb2f;

const NOISE_MIN = 0.3;
const NOISE_MAX = 1.8;

// `noise` is globalValueNoise, injected. Its [0,1) output maps linearly onto
// the band.
function noiseWeight(seed, gRow, gCol, noise = defaultNoise) {
  const v = noise(((seed >>> 0) ^ NOISE_SALT) >>> 0, gRow, gCol, NOISE_CELL);
  const u = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
  return NOISE_MIN + u * (NOISE_MAX - NOISE_MIN);
}

// Only so noiseWeight is callable in a unit test without wiring mapService in.
// Production always injects globalValueNoise.
function defaultNoise(seed, gRow, gCol, cell) {
  const x = Math.sin(seed * 0.0001 + gRow / cell * 12.9898 + gCol / cell * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// --- the field ---------------------------------------------------------

// Bounds on the NORMALIZED weight. The floor keeps quiet regions quiet without
// creating dead map; the ceiling is what makes the density ladder's "peak"
// column true by construction. Deliberately tight: a true set-piece horde is
// authored (Slice C), not an accident of three multipliers peaking at once.
const WEIGHT_MIN = 0.15;
const WEIGHT_MAX = 1.5;

// Multi-source BFS from every safe tile, capped at SAFETY_RAMP + 1.
//
// safeRegion exposes isSafeTile -- a boolean, not a distance. Probing outward
// per sample would be O(r^2) inside a loop that already runs up to 40 times per
// creature; this walks the map ONCE instead. A 224x224 map is ~50k cells and
// completes in single-digit milliseconds.
//
// Capped because nothing past the ramp changes the answer: safetyForDistance is
// constant beyond it, so the frontier is dropped rather than expanded across
// the rest of the map.
function safeDistanceField(width, height, safeAt) {
  const dist = new Int32Array(width * height).fill(-1);
  let frontier = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (safeAt(r, c)) { dist[r * width + c] = 0; frontier.push(r * width + c); }
    }
  }
  let d = 0;
  while (frontier.length && d < SAFETY_RAMP + 1) {
    const next = [];
    d += 1;
    for (const idx of frontier) {
      const r = Math.floor(idx / width), c = idx % width;
      // 4-neighbour: this measures travel distance from safety, and a diagonal
      // step is not a shorter walk in a game whose movement is axis-aligned.
      if (r > 0) pushIf(dist, next, (r - 1) * width + c, d);
      if (r < height - 1) pushIf(dist, next, (r + 1) * width + c, d);
      if (c > 0) pushIf(dist, next, r * width + (c - 1), d);
      if (c < width - 1) pushIf(dist, next, r * width + (c + 1), d);
    }
    frontier = next;
  }
  return dist;   // -1 means "further than the ramp", which reads as Infinity
}

function pushIf(dist, next, idx, d) {
  if (dist[idx] !== -1) return;
  dist[idx] = d;
  next.push(idx);
}

// safeCtx is anything exposing safeAt(gRow, gCol) -> boolean. mapService passes
// an adapter over safeRegion.isSafeTile; tests pass a literal.
//
// deps: { noise, regionAt } -- globalValueNoise and sampleBiomeRegion. Injected
// rather than imported; see the header.
function buildDensityField(cfg, safeCtx, deps = {}) {
  const noise = deps.noise || defaultNoise;
  const regionAt = deps.regionAt || (() => null);

  // An unbounded config has no map to walk and no interior to normalize over.
  // A flat field is the correct answer, and it keeps every caller free of a
  // null check.
  if (!cfg || !cfg.bounds) {
    return { weightAt: () => 1, max: WEIGHT_MAX };
  }

  const { width, height } = cfg.bounds;
  const dist = safeDistanceField(width, height, (r, c) => safeCtx.safeAt(r, c));

  const raw = (gRow, gCol) => {
    const d = dist[gRow * width + gCol];
    const safety = safetyForDistance(d === -1 ? Infinity : d);
    if (safety === 0) return 0;
    const region = regionAt(cfg, gRow, gCol);
    const biome = (region && Number.isFinite(region.creatureDensity) && region.creatureDensity > 0)
      ? region.creatureDensity : 1;
    return safety * biome * noiseWeight(cfg.seed, gRow, gCol, noise);
  };

  // Mean over INTERIOR tiles only (strictly inside the wall ring), matching the
  // rLo/rHi/cLo/cHi bounds both placers sample within -- normalizing over tiles
  // no creature can occupy would bias the field.
  //
  // Safe tiles contribute 0 and are counted, deliberately: they are part of the
  // map's area, and excluding them would inflate every other tile's weight on a
  // village-heavy map.
  let sum = 0, n = 0;
  for (let r = 1; r <= height - 2; r++) {
    for (let c = 1; c <= width - 2; c++) { sum += raw(r, c); n += 1; }
  }
  // A map that is entirely safe (or 2 tiles wide) has no signal to normalize
  // against. Flat is the only defensible answer; dividing by 0 is not.
  const mean = n > 0 && sum > 0 ? sum / n : 0;
  if (mean === 0) return { weightAt: () => 1, max: WEIGHT_MAX };

  const weightAt = (gRow, gCol) => {
    const w = raw(gRow, gCol) / mean;
    return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w));
  };

  return { weightAt, max: WEIGHT_MAX };
}

module.exports = {
  buildDensityField, safetyForDistance, noiseWeight, safeDistanceField,
  WEIGHT_MIN, WEIGHT_MAX, SAFETY_RAMP, NOISE_CELL, NOISE_SALT, NOISE_MIN, NOISE_MAX,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend && npm test -- tests/creatureDensityField.test.js
```

Expected: PASS, all 10 tests.

Note the clamp test asserts `weightAt` never leaves the band. If the normalize-to-mean-1 test fails with a mean far from 1, the cause is the clamp biting on most tiles — check that `WEIGHT_MIN`/`WEIGHT_MAX` are `0.15`/`1.5` and that the injected noise actually varies.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/creatureDensityField.js backend/tests/creatureDensityField.test.js
git commit -m "feat(density): position-dependent creature density field (SOMET-NNN)"
```

---

## Task 3: Wire the field into both placement paths

**Files:**
- Modify: `backend/src/services/mapService.js` — a `DENSITY_FIELD` WeakMap beside `SAFE_CTX`, the gate in `placeMapCreatures`, the gate on `placeCreaturePacks`' anchor search
- Test: `backend/tests/creatureDensityField_placement.test.js`

**Interfaces:**
- Consumes: `buildDensityField(cfg, safeCtx, deps)` and `WEIGHT_MAX` from Task 2.
- Produces: `densityFieldFor(cfg)` — exported from `mapService` for tests; returns the cached field for a config.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/creatureDensityField_placement.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const {
  placeMapCreatures, placeCreaturePacks, densityFieldFor,
} = require('../src/services/mapService');

const TILE_TYPES = { grass: { walkable: true }, map_wall: { walkable: false } };
const TYPES = [{ name: 'Wolf', hp: 10, defense: 0, resistances: {} }];

function world(overrides = {}) {
  return {
    seed: 4242,
    tileTypes: TILE_TYPES,
    width: 64, height: 64,
    levelMin: 1, levelMax: 3,
    biomes: [],
    ...overrides,
  };
}

// THE headline property. The field moves creatures around; it must not change
// how many a world gets. A test asserting otherwise would be asserting a bug.
test('the field is redistributive: the placed count is unchanged', () => {
  const placed = placeMapCreatures(world(), 200, TYPES, 99);
  assert.strictEqual(placed.length, 200);
});

test('placement concentrates creatures where the field is heavy', () => {
  const w = world();
  const field = densityFieldFor(w);
  const placed = placeMapCreatures(w, 400, TYPES, 99);

  // Split the placements by the weight of the tile each landed on, then compare
  // how many creatures per tile each half received. Comparing raw counts would
  // only prove the halves are different sizes.
  let heavySum = 0, lightSum = 0, heavyTiles = 0, lightTiles = 0;
  for (let r = 1; r <= 62; r++) {
    for (let c = 1; c <= 62; c++) {
      if (field.weightAt(r, c) >= 1) heavyTiles++; else lightTiles++;
    }
  }
  for (const p of placed) {
    const r = Math.floor(p.y / 100), c = Math.floor(p.x / 100);
    if (field.weightAt(r, c) >= 1) heavySum++; else lightSum++;
  }
  const heavyRate = heavySum / heavyTiles;
  const lightRate = lightSum / lightTiles;
  assert.ok(heavyRate > lightRate * 1.5,
    `heavy tiles took ${heavyRate.toFixed(4)}/tile vs light ${lightRate.toFixed(4)}/tile `
    + '-- the field is not steering placement');
});

test('placement stays deterministic for the same seed', () => {
  const a = placeMapCreatures(world(), 50, TYPES, 7);
  const b = placeMapCreatures(world(), 50, TYPES, 7);
  assert.deepStrictEqual(a.map((c) => [c.x, c.y]), b.map((c) => [c.x, c.y]));
});

test('safe regions still refuse creatures at every weight', () => {
  const w = world({
    safeRects: [{ minRow: 10, minCol: 10, width: 12, height: 12 }],
  });
  const placed = placeMapCreatures(w, 600, TYPES, 3);
  for (const p of placed) {
    const r = Math.floor(p.y / 100), c = Math.floor(p.x / 100);
    const inside = r >= 10 && r <= 21 && c >= 10 && c <= 21;
    assert.ok(!inside, `creature placed inside the safe rect at ${r},${c}`);
  }
});

test('packs still seat every member', () => {
  const packed = placeCreaturePacks(world(), [{ size: 6 }, { size: 4 }], TYPES, 11);
  assert.strictEqual(packed.length, 10);
});

test('pack anchors prefer heavy tiles', () => {
  const w = world();
  const field = densityFieldFor(w);
  // 40 single-member packs are 40 independent anchor draws.
  const specs = Array.from({ length: 40 }, () => ({ size: 1 }));
  const packed = placeCreaturePacks(w, specs, TYPES, 21);
  let heavy = 0;
  for (const p of packed) {
    const r = Math.floor(p.y / 100), c = Math.floor(p.x / 100);
    if (field.weightAt(r, c) >= 1) heavy++;
  }
  assert.ok(heavy > packed.length * 0.55,
    `only ${heavy}/${packed.length} anchors landed on heavy tiles`);
});

test('densityFieldFor caches per config object', () => {
  const w = world();
  assert.strictEqual(densityFieldFor(w), densityFieldFor(w));
});

// THE PARITY TEST. Two call sites place wild creatures: populateWorld
// (seeding, admin re-roll) and enqueueDeficit (the respawn backstop). Both
// must go through the field, or refills are uniform and every world erodes
// back to flat over hours of play -- a regression no seeding test would catch
// and no reviewer reliably spots.
//
// A SOURCE-TEXT test, deliberately. The behavioural alternative -- run
// enqueueDeficit and measure its distribution -- needs a database, a world
// row, and a hundred placements before the signal beats the noise, and it
// would still pass if someone later inlined a uniform copy of the sampling
// loop. What actually has to stay true is structural: the backstop must place
// through placeMapCreatures rather than sampling for itself.
test('enqueueDeficit places through placeMapCreatures, inheriting the field', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'creatureRespawn.js'), 'utf8');
  assert.match(src, /placeMapCreatures\(/,
    'creatureRespawn must place through placeMapCreatures so respawns respect '
    + 'the density field; a private sampling loop here would erode the field');
  assert.doesNotMatch(src, /Math\.floor\(rng\(\)\s*\*\s*\(rHi/,
    'creatureRespawn appears to have grown its own rejection-sampling loop -- '
    + 'that is the two-loader trap; place through placeMapCreatures instead');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend && npm test -- tests/creatureDensityField_placement.test.js
```

Expected: FAIL — `densityFieldFor is not a function`.

- [ ] **Step 3: Add the cached accessor to `mapService.js`**

First add the require at the **top of the file**, beside the existing `require('./safeRegion')` on line 8 — not inline further down:

```js
const { buildDensityField } = require('./creatureDensityField');
```

Then, immediately after `safeContextFor` (around line 653), add:

```js
// One density field per generation config, cached exactly as SAFE_CTX is and
// for the same reason: worldConfig() returns a fresh object per call, both
// placers call it once at the top of a run, and building the field walks the
// whole map. A WeakMap so nothing observable is mutated and the entry dies with
// the config.
//
// NOTE the argument order trap: this takes the ALREADY-NORMALIZED cfg that
// worldConfig returns, never a raw world row. worldConfig is not idempotent --
// it deliberately omits tileTypes, so worldConfig(worldConfig(x)) throws
// 'tileTypes is empty'.
const DENSITY_FIELD = new WeakMap();

function densityFieldFor(world) {
  const cfg = worldConfig(world);
  return densityFieldForConfig(cfg);
}

function densityFieldForConfig(cfg) {
  const hit = DENSITY_FIELD.get(cfg);
  if (hit) return hit;
  const safeCtx = safeContextFor(cfg);
  const field = buildDensityField(cfg, {
    safeAt: (r, c) => isSafeTile(safeCtx, r, c),
  }, {
    noise: globalValueNoise,
    regionAt: sampleBiomeRegion,
  });
  DENSITY_FIELD.set(cfg, field);
  return field;
}
```

`densityFieldFor` takes a raw world (for tests, which hold world literals); `densityFieldForConfig` takes the normalized config (for the placers, which have already called `worldConfig`). Both must exist — collapsing them into one would either re-normalize inside the placers (throwing on `tileTypes is empty`) or force tests to normalize by hand.

- [ ] **Step 4: Add the gate to `placeMapCreatures`**

In `placeMapCreatures`, after `const rng = makeRng(rngSeed >>> 0);` add:

```js
  const field = densityFieldForConfig(cfg);
```

and inside the attempt loop, immediately **after** the `if (!candidates) continue;` line and **before** the type pick:

```js
      // The density gate (Slice A). AFTER creatureTileCandidates, never
      // before: safe regions, walls and biome type-gating are absolute, and
      // this only redistributes among tiles that already passed them.
      //
      // Drawn from the same rng stream so placement stays deterministic. This
      // consumes one extra draw per ATTEMPT (not per placement), which shifts
      // the stream for everything after it -- newly seeded and re-rolled worlds
      // lay out differently than they did before this change. Creatures are
      // persisted at world creation, so existing worlds are untouched until
      // re-rolled. Expected, not a bug report.
      if (rng() * field.max > field.weightAt(row, col)) continue;
```

- [ ] **Step 5: Add the gate to `placeCreaturePacks`' anchor search**

In `placeCreaturePacks`, after `const rng = makeRng((rngSeed ^ PACK_SALT) >>> 0);` add:

```js
  const field = densityFieldForConfig(cfg);
```

and inside the **anchor** attempt loop only, after `if (!candidates) continue;`:

```js
      // Anchors obey the field; MEMBERS do not. A pack straddling a density
      // boundary must stay a pack -- gating members would shred it into the
      // heavy half and defeat the point of placing a group.
      if (rng() * field.max > field.weightAt(row, col)) continue;
```

Do **not** add this to the member-spread loop further down.

- [ ] **Step 6: Export `densityFieldFor`**

Add `densityFieldFor` to `mapService.js`'s `module.exports`.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd backend && npm test -- tests/creatureDensityField_placement.test.js
```

Expected: PASS, all 7 tests.

- [ ] **Step 8: Run the whole backend suite and fix position-asserting fallout**

```bash
cd backend && npm test
```

The extra RNG draws move where creatures land. Any test asserting a creature *position* or an exact placement count on a seeded world will fail. Expected casualties: `mapService.test.js`, `safe_region_population_db.test.js`, `world_population_clamp_warning.test.js`, `map_spec_fixtures`.

For each failure, decide and record which it is:
- **Asserts a position** → update the literal to the new value. This is expected churn.
- **Asserts a safety or correctness invariant** ("no creature in a village", "count equals request") → **do not update the expectation.** A real regression; fix the code.

- [ ] **Step 9: Commit**

```bash
git add backend/src/services/mapService.js backend/tests
git commit -m "feat(density): gate both placement paths on the density field (SOMET-NNN)"
```

---

## Task 4: Re-scale the density ladder

**Files:**
- Modify: `backend/src/services/densityTiers.js:11-18`
- Test: `backend/tests/densityTiers.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks. Independent of Tasks 1–3 and safe to review on its own.
- Produces: `DENSITY_TIERS[tier].perThousand` at the new rates.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/densityTiers.test.js`:

```js
// Hand-typed literals. Deriving these from DENSITY_TIERS would make the test
// pass at any value and assert nothing at all.
//
// The per-screen column is the reason these numbers were chosen: the canvas is
// a fixed 1280x720 with no zoom and a tile projects to a 128x64 iso diamond
// (4096 px^2), so one screen shows ~225 tiles. perThousand * 0.225 = per screen.
test('density tiers deliver the intended per-screen counts', () => {
  const perScreen = (tier) => DENSITY_TIERS[tier].perThousand * 0.225;
  assert.strictEqual(DENSITY_TIERS.dead.perThousand, 0);
  assert.strictEqual(DENSITY_TIERS.sparse.perThousand, 9);
  assert.strictEqual(DENSITY_TIERS.normal.perThousand, 18);
  assert.strictEqual(DENSITY_TIERS.dense.perThousand, 36);
  assert.strictEqual(DENSITY_TIERS.horde.perThousand, 62);
  assert.strictEqual(DENSITY_TIERS.swarm.perThousand, 89);

  assert.ok(Math.abs(perScreen('sparse') - 2) < 0.3, 'sparse should average ~2/screen');
  assert.ok(Math.abs(perScreen('swarm') - 20) < 0.5, 'swarm should average ~20/screen');
});

test('the ladder rises monotonically', () => {
  const order = ['dead', 'sparse', 'normal', 'dense', 'horde', 'swarm'];
  for (let i = 1; i < order.length; i++) {
    assert.ok(
      DENSITY_TIERS[order[i]].perThousand > DENSITY_TIERS[order[i - 1]].perThousand,
      `${order[i]} must exceed ${order[i - 1]}`,
    );
  }
});

test('swarm on the largest shipped world clamps rather than overrunning the cap', () => {
  const r = resolveDensity('swarm', 224, 224);
  assert.strictEqual(r.clamped, true);
  assert.ok(r.scatterCount <= MAX_WORLD_CREATURES);
});
```

Make sure `resolveDensity` and `MAX_WORLD_CREATURES` are in the file's existing `require`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && npm test -- tests/densityTiers.test.js
```

Expected: FAIL — `sparse.perThousand` is 3, not 9.

- [ ] **Step 3: Re-scale the table**

In `backend/src/services/densityTiers.js`, replace the `DENSITY_TIERS` literal:

```js
// Rates are per 1000 tiles, and they are the world's MEAN -- creatureDensityField
// redistributes around them, so a `normal` world holds quiet stretches and thick
// pockets while averaging this number.
//
// The per-screen column is what these were tuned against. The canvas is a fixed
// 1280x720 with no zoom and a tile projects to a 128x64 iso diamond (4096 px^2),
// so ONE SCREEN IS ~225 TILES and perThousand * 0.225 is creatures per screen.
// Before this table was re-scaled the game shipped 0.7-2.7 per screen -- and
// since every checked-in map spec uses only sparse/normal/dense, the top two
// tiers were theoretical.
//
//   tier     per1000   quiet(x0.15)   mean/screen   peak(x1.5)
//   sparse         9            0.3             2            3
//   normal        18            0.6             4            6
//   dense         36            1.2             8           12
//   horde         62            2.1            14           21
//   swarm         89            3.0            20           30
//
// packCount/packSize are untouched here; Slice B scales them by area.
const DENSITY_TIERS = {
  dead:   { perThousand: 0,  packCount: 0, packSizeMin: 0, packSizeMax: 0 },
  sparse: { perThousand: 9,  packCount: 0, packSizeMin: 0, packSizeMax: 0 },
  normal: { perThousand: 18, packCount: 1, packSizeMin: 3, packSizeMax: 4 },
  dense:  { perThousand: 36, packCount: 2, packSizeMin: 4, packSizeMax: 6 },
  horde:  { perThousand: 62, packCount: 4, packSizeMin: 5, packSizeMax: 8 },
  swarm:  { perThousand: 89, packCount: 6, packSizeMin: 8, packSizeMax: 12 },
};
```

Tier *keys* are unchanged, so `worlds_density_check` (migration 1714440070000) needs no migration.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend && npm test -- tests/densityTiers.test.js
```

Expected: PASS.

- [ ] **Step 5: Run the whole suite**

```bash
cd backend && npm test
```

`world_population_clamp_warning.test.js` asserts clamp behaviour and will likely need its world size or expected count updated — `swarm` now clamps at a smaller map than it used to. Update the literal; do not weaken the assertion.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/densityTiers.js backend/tests
git commit -m "feat(density): re-scale the tier ladder to 2-20 creatures per screen (SOMET-NNN)"
```

---

## Task 5: Measure the authority tick, then decide the cap

The spec defers one number to a measurement: whether `MAX_WORLD_CREATURES` rises above 4,000. `swarm` on a 224² world now resolves to ~4,470 and clamps.

**Measure the right half of the tick.** `CreatureSim.tick` (`authority/creatures.js:1122`) has two layers with very different costs, and the obvious reading of it is wrong:

- The main behaviour loop is **chunk-scoped** — `if (!active.has(CHUNK_KEY(cx, cy))) continue;` skips every creature outside `activeChunkKeys`. The expensive AI is paid only near players.
- Three passes are **not** scoped and run over the whole population every tick: `[...this.creatures.values()]`, `computeAuras(all)`, and the `c._buff` assignment loop.

`computeAuras` is **O(leaders × all)**. A benchmark with zero leaders measures the cheap half and reports a false all-clear, so the sweep below varies the leader count deliberately. `Champion` is the only behaviour in the catalog with `aura_radius > 0`, and it is exactly what Slice B's pack masters become — so this measurement also sets the budget Slice B has to design against.

**Both cap outcomes are acceptable. Shipping an unmeasured raise is not.**

**Files:**
- Create: `backend/tests/creature_tick_cost.test.js`
- Modify: `backend/src/services/densityTiers.js` (only if the measurement supports it)

**Interfaces:**
- Consumes: `DENSITY_TIERS`, `MAX_WORLD_CREATURES` from Task 4.
- Produces: a documented measurement, and either a raised cap or a comment recording why it stayed. Also produces the leader-count budget that Slice B's plan consumes.

- [ ] **Step 1: Write the benchmark**

Create `backend/tests/creature_tick_cost.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim } = require('../src/authority/creatures');

// A BUDGET measurement, gated behind an env var because it is slow and
// machine-sensitive:  MEASURE_TICK=1 npm test -- tests/creature_tick_cost.test.js
//
// Benchmarks CreatureSim directly rather than World, because CreatureSim is
// where the per-creature loops live and World would need weapons, projectiles,
// ground items and a player set to construct.
const RUN = process.env.MEASURE_TICK ? test : test.skip;

const CHUNK = 64;
const TILE = 100;

// A 224x224 world is 4 chunks of 64 tiles per side (224/64 = 3.5 -> 4).
// `active` is what a single player's neighbourhood covers: a 3x3 block of
// chunks. Everything outside it is frozen by the chunk gate.
function activeKeys() {
  const keys = new Set();
  for (let cy = 0; cy < 3; cy++) for (let cx = 0; cx < 3; cx++) keys.add(`${cx},${cy}`);
  return keys;
}

// `leaders` of the population get the Champion behaviour (aura_radius 260),
// the ONLY aura-carrying behaviour in the catalog and exactly what Slice B
// promotes pack masters into.
function buildSim(n, leaders) {
  const sim = new CreatureSim({ chunkSize: CHUNK, width: 224, height: 224 }, () => 0.5);
  const list = [];
  for (let i = 0; i < n; i++) {
    list.push({
      id: `c${i}`, type: 'Wolf',
      x: (i % 224) * TILE, y: Math.floor(i / 224) * TILE,
      hp: 10, level: 1, damage: 5, facing: 'S', faction: 'hostile',
      behavior_name: i < leaders ? 'Champion' : 'Line',
    });
  }
  sim.addCreatures(list);
  return sim;
}

RUN('tick cost across population and leader count', () => {
  const active = activeKeys();
  const players = [{ userId: 'u1', x: 3200, y: 3200, width: 64, height: 64, hp: 100 }];
  const results = [];

  for (const [n, leaders] of [[2400, 6], [4500, 6], [4500, 50], [4500, 200]]) {
    const sim = buildSim(n, leaders);
    // Warm up so the JIT is not part of the measurement.
    for (let i = 0; i < 20; i++) sim.tick(1 / 60, active, players, i * 16);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 120; i++) sim.tick(1 / 60, active, players, i * 16);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 120;
    results.push({ n, leaders, ms });
    console.log(`[tick] ${n} creatures / ${leaders} leaders: ${ms.toFixed(3)} ms/tick`);
  }

  // The frame budget is 16ms and the creature sim is only one part of a tick,
  // so 8ms is the half-budget this asserts against. The 200-leader row is
  // EXPECTED to be the expensive one -- it is measured to inform Slice B, and
  // is deliberately not asserted on.
  for (const r of results.filter((x) => x.leaders <= 50)) {
    assert.ok(r.ms < 8,
      `${r.n} creatures / ${r.leaders} leaders cost ${r.ms.toFixed(3)} ms/tick, over the 8ms half-budget`);
  }
});
```

If `addCreatures` rejects `behavior_name` (check how `resolveInstanceBehavior` reads a behaviour — it may want a resolved object rather than a name), adapt the fixture to the real shape. Do not change `creatures.js` to suit the benchmark.

- [ ] **Step 2: Run the measurement**

```bash
cd backend && MEASURE_TICK=1 npm test -- tests/creature_tick_cost.test.js
```

Record all four printed `ms/tick` figures.

- [ ] **Step 3: Decide the cap, and write the decision down**

**If `4500 / 6 leaders` costs under 8 ms/tick:** raise the cap in `densityTiers.js`:

```js
const MAX_WORLD_CREATURES = 5000;
```

**Otherwise:** leave it at 4000.

Either way, append the real measurements to the `MAX_WORLD_CREATURES` comment — every `<...>` below must be replaced with a measured number before committing:

```js
// Measured <date> on <cpu>, CreatureSim.tick with a 3x3 active chunk block:
//   2400 creatures /   6 leaders: <a> ms/tick
//   4500 creatures /   6 leaders: <b> ms/tick
//   4500 creatures /  50 leaders: <c> ms/tick
//   4500 creatures / 200 leaders: <d> ms/tick
// computeAuras is O(leaders x all) and runs over the WHOLE population every
// tick, outside the chunk gate -- so the leader count, not the headcount, is
// what bends this curve. Slice B (pack masters use the Champion behaviour,
// the only one with aura_radius > 0) must budget against the last two rows.
```

- [ ] **Step 4: Commit**

```bash
git add backend/tests/creature_tick_cost.test.js backend/src/services/densityTiers.js
git commit -m "test(density): measure authority tick cost and settle MAX_WORLD_CREATURES (SOMET-NNN)"
```

---

## Task 6: Full-suite verification

**Files:** none — this task changes nothing unless it finds a defect.

- [ ] **Step 1: Run the full backend suite with the database**

```bash
cd backend && DATABASE_URL="$DATABASE_URL" npm test 2>&1 | tail -40
```

A bare `npm test` self-skips the DB-backed files (`const describeDb = URL ? test : test.skip`), which hides roughly 47 test files. The count of *executed* tests, not just the pass/fail line, is the evidence — record it.

- [ ] **Step 2: Confirm no fixture worlds leaked**

```bash
psql "$DATABASE_URL" -c "SELECT name FROM worlds WHERE name LIKE 'zz%' ORDER BY name;"
```

Expected: no rows. A leaked `zz*` world means a DB test failed before its `finally` — report it; do not delete rows from the shared database as part of this plan.

- [ ] **Step 3: Report**

Record: tests executed, tests passed, any position-literal updates made in Task 3 Step 8 and Task 4 Step 5 with the reason each was classified as churn rather than regression, and the two tick-cost figures from Task 5.

---

## Out of scope for this plan

- **Packs and masters** — cohesive pack levels, elite masters, `entity_types.family`/`role_rank`, `world_creatures.pack_id`/`is_master`, area-scaled pack counts, and the `enqueueDeficit` target fix. That is Slice B, and it gets its own plan.
- **Authored hotspots** — Slice C, optional, to be decided after A and B are live.
- **The post-merge world re-roll** — an explicit, user-confirmed step run after this merges. No implementer runs it.
