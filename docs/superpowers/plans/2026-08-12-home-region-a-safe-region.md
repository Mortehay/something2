# Home Region A — Safe Region and Hostile Spawn Exclusion (SOMET-288)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hostile creatures are never generated inside a village, on a road, or inside an authored safe rectangle — so the starting region (SOMET-289) has somewhere safe to be.

**Architecture:** One new pure module, `backend/src/services/safeRegion.js`, answers "is this tile safe?". It is wired into `creatureTileCandidates` in `mapService.js` — the single chokepoint both `placeMapCreatures` and `placeCreaturePacks` already pass through, and the place that today refuses village tiles. Two new authored columns (`worlds.safe_road_radius`, `worlds.safe_rects`) reach that code through `buildWorldGenConfig`, the one place a `worlds` row becomes a generation config. Roads are not re-derived: the module is handed `collectPathCells`' own output, so the safe corridor is exactly the road the player sees drawn.

**Tech Stack:** Node.js (CommonJS), Express, raw `pg`, `node-pg-migrate`, `node --test`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-12-home-region-design.md` §1. Ticket: **SOMET-288**, child of epic SOMET-287.
- **Safety is a SPAWN-TIME rule only.** Nothing on the movement or tick path may consult `safeRegion.js`. A hostile already chasing a player must still be able to follow them onto the road and through the gate — that is SOMET-291's rescue.
- **Defaults must reproduce today's behaviour byte-for-byte.** `safe_road_radius` defaults to 0 and `safe_rects` to `[]`; nothing is backfilled. A world that opts out must place the identical creatures it placed before this change.
- **Never mutate the shared dev database destructively.** No `DELETE FROM entity_types`, no truncation, no destructive experiments. DB tests use `zzSafe*`-prefixed fixture worlds and delete **by name** in a `finally`, never by an id captured mid-test.
- **CommonJS**, `require`/`module.exports`. Match the surrounding comment density: this repo explains *why* in comments, not *what*.
- Branch `feat/home-region-safe-region`. Commit subjects `type(scope): summary (SOMET-288)`, ending with the `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` trailer.
- Run backend tests from `backend/` with `npm test -- tests/<file>` for a single file. **`TEST_DATABASE_URL` / `DATABASE_URL` must be set** or 47 DB test files silently skip.

## Scope

**In:** the `safeRegion` module, the two columns, the config threading, the placement exclusion, plural `villages` in the map spec, and `safe_road_radius` / `safe_rects` in the map spec + seed applier.

**Out (deliberately):** `pens` — authored creature pockets are only consumed by SOMET-289, which has to touch `mapSpec.js` for placement anyway. Validating a field with no consumer here would be a schema nobody reads. Authoring actual home-region content is SOMET-289. Damage/PvP/projectile rules are not part of "safe" at all.

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/services/safeRegion.js` | **new.** Pure predicate: is (row, col) safe? Knows nothing about the DB or about how roads are computed. |
| `backend/tests/safe_region.test.js` | **new.** Unit tests for the predicate. |
| `backend/migrations/1714440180000_world_safe_region.js` | **new.** `worlds.safe_road_radius`, `worlds.safe_rects`. |
| `backend/src/services/worldGenConfig.js` | **modify.** Map the two columns onto the config both the chunk endpoint and the authority read. |
| `backend/src/services/mapService.js` | **modify.** `worldConfig` normalizes the two fields; `creatureTileCandidates` refuses a safe tile. |
| `backend/tests/safe_region_placement.test.js` | **new.** Placement-level tests, no DB. |
| `backend/seeds/mapSpec.js` | **modify.** Plural `villages`, `safe_road_radius`, `safe_rects`. |
| `backend/scripts/seed-map.js` | **modify.** Persist the new columns; create every village, not just the first. |
| `backend/tests/map_spec_validate.test.js` | **modify.** Validation cases. |
| `backend/tests/safe_region_population_db.test.js` | **new.** `populateWorld` places nothing on a safe tile. |

---

### Task 1: The `safeRegion` predicate

**Files:**
- Create: `backend/src/services/safeRegion.js`
- Test: `backend/tests/safe_region.test.js`

**Interfaces:**
- Consumes: nothing. This module deliberately imports nothing — see the cycle note below.
- Produces:
  - `buildSafeContext({ villages, pathCells, safeRoadRadius, safeRects }) -> ctx`
    - `villages`, `safeRects`: arrays of `{ minRow, minCol, width, height }` (extra keys ignored — this is the shape `cfg.villages` already uses)
    - `pathCells`: a `Set` of `"row,col"` strings, exactly what `collectPathCells` returns
    - `safeRoadRadius`: integer; `0` means roads are not safe at all
  - `isSafeTile(ctx, gRow, gCol) -> boolean`

- [ ] **Step 1: Create the branch**

```bash
cd /home/markunn/worker/coding/jsgame/something2
git checkout main && git pull --ff-only
git checkout -b feat/home-region-safe-region
```

- [ ] **Step 2: Write the failing test**

Create `backend/tests/safe_region.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { buildSafeContext, isSafeTile } = require('../src/services/safeRegion.js');

// A 6x4 village at rows 10..13, cols 20..25 -- the shape mapService's
// cfg.villages carries.
const VILLAGE = { minRow: 10, minCol: 20, width: 6, height: 4 };

test('a tile inside a village box is safe, including its wall ring', () => {
  const ctx = buildSafeContext({ villages: [VILLAGE] });
  assert.equal(isSafeTile(ctx, 12, 22), true, 'interior');
  assert.equal(isSafeTile(ctx, 10, 20), true, 'north-west corner of the wall ring');
  assert.equal(isSafeTile(ctx, 13, 25), true, 'south-east corner of the wall ring');
  assert.equal(isSafeTile(ctx, 9, 22), false, 'one row north of the box');
  assert.equal(isSafeTile(ctx, 14, 22), false, 'one row south of the box');
  assert.equal(isSafeTile(ctx, 12, 26), false, 'one col east of the box');
});

test('radius 0 means roads are NOT safe -- not even the road tile itself', () => {
  // This is what keeps every world that has not opted in placing exactly the
  // creatures it placed before this feature existed.
  const ctx = buildSafeContext({
    pathCells: new Set(['5,5']), safeRoadRadius: 0,
  });
  assert.equal(isSafeTile(ctx, 5, 5), false);
});

test('a road makes a Chebyshev square of radius N safe, and nothing beyond it', () => {
  const ctx = buildSafeContext({
    pathCells: new Set(['5,5']), safeRoadRadius: 2,
  });
  assert.equal(isSafeTile(ctx, 5, 5), true, 'the road cell itself');
  assert.equal(isSafeTile(ctx, 3, 3), true, 'the diagonal corner at exactly radius 2');
  assert.equal(isSafeTile(ctx, 7, 7), true, 'the opposite diagonal corner');
  assert.equal(isSafeTile(ctx, 5, 8), false, 'radius 3 along a row');
  assert.equal(isSafeTile(ctx, 2, 5), false, 'radius 3 along a column');
  assert.equal(isSafeTile(ctx, 8, 8), false, 'radius 3 diagonally');
});

test('an authored safe rectangle is safe independently of villages and roads', () => {
  const ctx = buildSafeContext({
    safeRects: [{ minRow: 40, minCol: 40, width: 3, height: 3 }],
  });
  assert.equal(isSafeTile(ctx, 41, 41), true);
  assert.equal(isSafeTile(ctx, 42, 42), true, 'inclusive far corner');
  assert.equal(isSafeTile(ctx, 43, 41), false, 'one row past the rectangle');
});

test('an empty context makes nothing safe', () => {
  const ctx = buildSafeContext();
  assert.equal(isSafeTile(ctx, 0, 0), false);
  assert.equal(isSafeTile(ctx, 500, 500), false);
});

test('a junk radius degrades to 0 rather than to NaN', () => {
  // Every comparison against NaN is false, so a NaN radius would disable the
  // road leg silently -- the failure mode this normalization exists to make
  // impossible. Asserted for each way a hand-edited spec gets it wrong.
  for (const junk of ['2', 2.5, -1, null, undefined, NaN, {}]) {
    const ctx = buildSafeContext({ pathCells: new Set(['5,5']), safeRoadRadius: junk });
    assert.equal(ctx.safeRoadRadius, 0, `radius ${JSON.stringify(junk)} must normalize to 0`);
    assert.equal(isSafeTile(ctx, 5, 5), false);
  }
});

test('a non-Set pathCells degrades to empty rather than throwing', () => {
  const ctx = buildSafeContext({ pathCells: ['5,5'], safeRoadRadius: 2 });
  assert.equal(isSafeTile(ctx, 5, 5), false);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd backend && npm test -- tests/safe_region.test.js
```

Expected: FAIL — `Cannot find module '../src/services/safeRegion.js'`.

- [ ] **Step 4: Write the implementation**

Create `backend/src/services/safeRegion.js`:

```js
// Is this tile inside safe territory? (SOMET-288, Home Region slice A.)
//
// ONE question, asked at SPAWN TIME ONLY. mapService's creatureTileCandidates
// refuses any tile this module calls safe, so no hostile is ever GENERATED in a
// village, on a road, or inside an authored safe rectangle -- and because that
// function is the single chokepoint placeMapCreatures and placeCreaturePacks
// both pass through, seeding and the admin re-roll route inherit the rule
// without either of them naming it.
//
// NOTHING ON THE MOVEMENT OR TICK PATH MAY CALL THIS. A hostile that is already
// chasing a player MUST be able to follow them onto the road and through the
// village gate -- that is the moment the gate guards exist for (SOMET-291), and
// a barrier here would turn the rescue into an invisible wall. Safety in this
// game is earned, not enforced.
//
// Deliberately imports NOTHING. mapService requires this module, so a require
// back into mapService would be a cycle, and whichever of the two loaded second
// would see a half-built exports object. The road cells are therefore passed IN
// -- as collectPathCells' own Set of "row,col" keys -- rather than recomputed
// here. That is also the SOMET-282 / VILLAGE_LIMITS reason: one derivation of
// where the roads are, shared, instead of two that can drift.

// Inclusive box test in tile coordinates. Shared by villages and authored
// rectangles because they are the same shape and the same question; a village's
// WALL RING counts as inside, which is what we want -- a hostile spawned on a
// wall tile would be stuck inside geometry.
function inBox(gRow, gCol, b) {
  return gRow >= b.minRow && gRow <= b.minRow + b.height - 1
      && gCol >= b.minCol && gCol <= b.minCol + b.width - 1;
}

// Normalize once, so isSafeTile can be a hot-path predicate that trusts its
// context. A radius that is not a positive integer becomes 0 -- never NaN:
// every comparison against NaN is false, so a junk radius would silently
// disable the road leg in a way no assertion would notice.
function buildSafeContext({ villages, pathCells, safeRoadRadius, safeRects } = {}) {
  const r = Number(safeRoadRadius);
  return {
    villages: Array.isArray(villages) ? villages : [],
    pathCells: pathCells instanceof Set ? pathCells : new Set(),
    safeRoadRadius: Number.isInteger(r) && r > 0 ? r : 0,
    safeRects: Array.isArray(safeRects) ? safeRects : [],
  };
}

// CHEBYSHEV distance, not Euclidean and not Manhattan: a radius-N road is a
// (2N+1)-tile ribbon with square corners. "Within N tiles" has three defensible
// readings, so the one in force is stated here and pinned by the tests.
//
// Radius 0 means roads are not safe AT ALL -- not even the carved cell itself.
// That is the property that keeps every world which has not opted in placing
// byte-for-byte the creatures it placed before this module existed.
//
// Scanned rather than pre-dilated: authored radii are small (single digits), so
// this is at most a few dozen Set lookups, and it keeps the context free of any
// allocation policy that would have to be tuned per map size.
function nearPathCell(ctx, gRow, gCol) {
  const r = ctx.safeRoadRadius;
  if (r <= 0 || ctx.pathCells.size === 0) return false;
  for (let dr = -r; dr <= r; dr++) {
    for (let dc = -r; dc <= r; dc++) {
      if (ctx.pathCells.has(`${gRow + dr},${gCol + dc}`)) return true;
    }
  }
  return false;
}

// Villages first, rectangles second, roads last: the first two are O(count) with
// counts in the single digits, the third is the only one that scans.
function isSafeTile(ctx, gRow, gCol) {
  for (const v of ctx.villages) if (inBox(gRow, gCol, v)) return true;
  for (const s of ctx.safeRects) if (inBox(gRow, gCol, s)) return true;
  return nearPathCell(ctx, gRow, gCol);
}

module.exports = { buildSafeContext, isSafeTile };
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd backend && npm test -- tests/safe_region.test.js
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/safeRegion.js backend/tests/safe_region.test.js
git commit -m "$(cat <<'EOF'
feat(safe-region): add the safe-tile predicate (SOMET-288)

One pure module answering one question: is this tile inside a village, near a
road, or in an authored safe rectangle. Imports nothing -- mapService will
require it, and the road cells are passed in as collectPathCells' own Set so
there is exactly one derivation of where the roads are.

Radius 0 means roads are not safe at all, including the carved cell itself.
That is deliberately the default: it is what keeps every world which has not
opted in placing byte-for-byte the creatures it placed before.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The two authored columns, and threading them to the generator

**Files:**
- Create: `backend/migrations/1714440180000_world_safe_region.js`
- Modify: `backend/src/services/worldGenConfig.js`
- Modify: `backend/src/services/mapService.js` (the `worldConfig` return object only)
- Test: `backend/tests/worldGenConfig.test.js` (append)

**Interfaces:**
- Consumes: nothing from Task 1 yet.
- Produces:
  - `worlds.safe_road_radius` — `integer NOT NULL DEFAULT 0`
  - `worlds.safe_rects` — `jsonb NOT NULL DEFAULT '[]'`, an array of `{ min_row, min_col, width, height }` (snake_case in the DB and the spec; camelCase everywhere in JS)
  - `buildWorldGenConfig` output gains `safeRoadRadius: number` and `safeRects: Array<{minRow,minCol,width,height}>`
  - `worldConfig(world)` output gains the same two fields, normalized

- [ ] **Step 1: Confirm the migration timestamp is free**

```bash
cd backend && ls migrations | sort | tail -3
```

Expected: the highest is `1714440176000_village_guards_are_level_150.js`, so `1714440180000` is free. **If anything at or above `1714440180000` exists, pick `<highest>+1000` instead** — a duplicate timestamp across two branches has stalled `migrate:up` in this repo before.

- [ ] **Step 2: Write the failing test**

Append to `backend/tests/worldGenConfig.test.js`:

```js
test('safe-region columns reach the generator config, converted to camelCase', () => {
  const cfg = buildWorldGenConfig({
    row: {
      ...ROW,
      safe_road_radius: 2,
      safe_rects: [{ min_row: 4, min_col: 5, width: 3, height: 2 }],
    },
    tileTypes: TILE_TYPES, doorways: [], villages: [], biomes: BIOMES,
  });
  assert.equal(cfg.safeRoadRadius, 2);
  assert.deepEqual(cfg.safeRects, [{ minRow: 4, minCol: 5, width: 3, height: 2 }]);
});

test('a row with no safe-region columns yields the opted-out config', () => {
  // Every world that existed before this feature. The generator must see 0 and
  // [], not undefined -- worldConfig would normalize undefined the same way,
  // but a missing mapping here is exactly the silent client/server divergence
  // buildWorldGenConfig's header warns about.
  const cfg = buildWorldGenConfig({
    row: ROW, tileTypes: TILE_TYPES, doorways: [], villages: [], biomes: BIOMES,
  });
  assert.equal(cfg.safeRoadRadius, 0);
  assert.deepEqual(cfg.safeRects, []);
});

test('worldConfig normalizes the safe-region fields it is handed', () => {
  const cfg = worldConfig({
    seed: 1, width: 20, height: 20, tileTypes: TILE_TYPES,
    safeRoadRadius: 3, safeRects: [{ minRow: 1, minCol: 1, width: 2, height: 2 }],
  });
  assert.equal(cfg.safeRoadRadius, 3);
  assert.deepEqual(cfg.safeRects, [{ minRow: 1, minCol: 1, width: 2, height: 2 }]);

  const bare = worldConfig({ seed: 1, width: 20, height: 20, tileTypes: TILE_TYPES });
  assert.equal(bare.safeRoadRadius, 0);
  assert.deepEqual(bare.safeRects, []);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd backend && npm test -- tests/worldGenConfig.test.js
```

Expected: FAIL — `cfg.safeRoadRadius` is `undefined`.

- [ ] **Step 4: Write the migration**

Create `backend/migrations/1714440180000_world_safe_region.js`:

```js
exports.shorthands = undefined;

// Safe territory, authored per world (SOMET-288).
//
// A hostile is never GENERATED inside a village, within safe_road_radius tiles
// of a carved road, or inside one of safe_rects. Consumed by
// services/safeRegion.js through creatureTileCandidates; nothing on the
// movement path reads either column.
//
// DEFAULT 0 / '[]' IS THE COMPATIBILITY PROPERTY, not a convenience, and
// deliberately NOT backfilled -- exactly the posture allows_fast_travel took in
// 1714440163000. 86 worlds exist; with radius 0 the road leg of the predicate
// is dead and every one of them places byte-for-byte the creatures it placed
// before this migration. A world becomes safe only when a map spec says so, in
// a diff somebody reviewed.
exports.up = (pgm) => {
  pgm.addColumns('worlds', {
    safe_road_radius: { type: 'integer', notNull: true, default: 0 },
    safe_rects: { type: 'jsonb', notNull: true, default: '[]' },
  });
  // A negative radius is meaningless and a huge one swallows the map; 8 is
  // wider than any village and still leaves a 64-tile world mostly wild. The
  // map spec validator rejects the same range with a readable message -- this
  // is the backstop for anything that writes the column directly.
  pgm.addConstraint('worlds', 'worlds_safe_road_radius_check',
    'CHECK (safe_road_radius >= 0 AND safe_road_radius <= 8)');
};

exports.down = (pgm) => {
  pgm.dropConstraint('worlds', 'worlds_safe_road_radius_check');
  pgm.dropColumns('worlds', ['safe_road_radius', 'safe_rects']);
};
```

- [ ] **Step 5: Run the migration**

```bash
cd backend && npm run migrate:up
```

Expected: `### MIGRATION 1714440180000_world_safe_region (UP) ###` and no error.

- [ ] **Step 6: Thread the columns through `buildWorldGenConfig`**

In `backend/src/services/worldGenConfig.js`, add to the returned object, immediately after the `levelMin`/`levelMax` pair:

```js
    // Safe territory (SOMET-288). Read by creatureTileCandidates via
    // safeRegion.js, so a hostile is never generated on a road or in a
    // village. snake_case in the DB and the map spec, camelCase from here on,
    // converted in ONE place so no consumer has to know both spellings.
    //
    // Defaults matter: a row read before migration 1714440180000 ran (or a
    // hand-built row in a test) must come out opted OUT, never undefined --
    // undefined would reach worldConfig and normalize to the same thing, but
    // a missing mapping here is precisely the silent divergence this module's
    // header exists to prevent.
    safeRoadRadius: Number(row.safe_road_radius) || 0,
    safeRects: Array.isArray(row.safe_rects)
      ? row.safe_rects.map((s) => ({
          minRow: s.min_row, minCol: s.min_col, width: s.width, height: s.height,
        }))
      : [],
```

- [ ] **Step 7: Normalize them in `worldConfig`**

In `backend/src/services/mapService.js`, inside the object `worldConfig` returns, add after the `villages:` entry:

```js
    // SOMET-288. safeRegion.buildSafeContext does the real normalization (a
    // junk radius becomes 0, never NaN); these are coerced here as well so a
    // hand-built test world and a world that came through buildWorldGenConfig
    // present the same shape, and so `cfg.safeRoadRadius` is always a number
    // for the `radius > 0` short-circuit in safeContextFor.
    safeRoadRadius: Number(world.safeRoadRadius) || 0,
    safeRects: Array.isArray(world.safeRects) ? world.safeRects : [],
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
cd backend && npm test -- tests/worldGenConfig.test.js
```

Expected: PASS, including the three new tests.

- [ ] **Step 9: Commit**

```bash
git add backend/migrations/1714440180000_world_safe_region.js \
        backend/src/services/worldGenConfig.js \
        backend/src/services/mapService.js \
        backend/tests/worldGenConfig.test.js
git commit -m "$(cat <<'EOF'
feat(safe-region): author safe territory per world (SOMET-288)

worlds.safe_road_radius and worlds.safe_rects, threaded to the generator
through buildWorldGenConfig -- the one place a worlds row becomes a config, so
both the chunk endpoint and the authority get them by construction.

Not backfilled, and defaulted to 0/[]: with radius 0 the road leg of the
predicate is dead, so all 86 existing worlds place byte-for-byte the creatures
they placed before. A world becomes safe only when a spec says so.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Refuse a safe tile at the placement chokepoint

**Files:**
- Modify: `backend/src/services/mapService.js` (`creatureTileCandidates`, plus one new helper)
- Test: `backend/tests/safe_region_placement.test.js`

**Interfaces:**
- Consumes: `buildSafeContext`, `isSafeTile` from Task 1; `cfg.safeRoadRadius`, `cfg.safeRects` from Task 2.
- Produces: no new exports. `placeMapCreatures` and `placeCreaturePacks` keep their current signatures and now skip safe tiles.

**Why here:** `creatureTileCandidates` is already the one function both placers call, and already the one that refuses village tiles (`if (villageContaining(...)) return null`). The village check is *subsumed* by `isSafeTile` — replace it rather than stacking a second check next to it.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/safe_region_placement.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const {
  placeMapCreatures, placeCreaturePacks, worldConfig, collectPathCells,
  CREATURE_TILE_PX,
} = require('../src/services/mapService.js');

const TYPES = [
  { name: 'Wolf', hp: 12, defense: 0, resistances: {} },
  { name: 'Bat', hp: 8, defense: 0, resistances: {} },
];

// `dirt` matters: PATH_NAME_RE in mapService.js auto-detects a tile named
// path/dirt/road/trail/earth/sand as THE path tile. A fixture whose only tile
// is `grass` has cfg.pathTile === null, collectPathCells returns an empty Set,
// and every road assertion below would pass vacuously.
const WORLD = {
  seed: 999, chunkSize: 16, width: 48, height: 48,
  levelMin: 1, levelMax: 2,
  tileTypes: { grass: { walkable: true }, dirt: { walkable: true } },
};

const tileOf = (c) => [
  Math.floor(c.y / CREATURE_TILE_PX),
  Math.floor(c.x / CREATURE_TILE_PX),
];

function roadCells(world) {
  const cfg = worldConfig(world);
  return collectPathCells(cfg, 0, 0, world.height, world.width);
}

test('the fixture actually has roads — otherwise every road test below is vacuous', () => {
  assert.ok(roadCells(WORLD).size > 0, 'no carved path cells in the fixture');
});

test('with radius 0, placement is byte-for-byte what it was before safe regions', () => {
  // The compatibility guarantee for all 86 existing worlds, stated as a test:
  // an opted-out world must not merely "avoid roads less" -- it must produce
  // the identical list, because the placement RNG stream is shared and every
  // extra rejection shifts everything after it.
  const before = placeMapCreatures({ ...WORLD }, 40, TYPES, 4242);
  const after = placeMapCreatures({ ...WORLD, safeRoadRadius: 0 }, 40, TYPES, 4242);
  assert.ok(before.length > 0, 'fixture placed nothing — this test would assert nothing');
  assert.deepEqual(after.map(tileOf), before.map(tileOf));
});

test('no scattered creature lands within the safe road corridor', () => {
  const world = { ...WORLD, safeRoadRadius: 2 };
  const roads = roadCells(world);
  const placed = placeMapCreatures(world, 60, TYPES, 4242);
  assert.ok(placed.length > 0, 'fixture placed nothing — this test would assert nothing');
  for (const c of placed) {
    const [row, col] = tileOf(c);
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        assert.ok(!roads.has(`${row + dr},${col + dc}`),
          `creature at (${row},${col}) is within 2 tiles of road cell (${row + dr},${col + dc})`);
      }
    }
  }
});

test('no packed creature lands within the safe road corridor either', () => {
  // placeCreaturePacks is the SECOND caller of creatureTileCandidates. A fix
  // applied to the scatter path alone would leave packs spawning on roads --
  // the two-write-paths failure this repo has shipped before (SOMET-153).
  const world = { ...WORLD, safeRoadRadius: 2 };
  const roads = roadCells(world);
  const placed = placeCreaturePacks(world, [{ size: 6 }, { size: 6 }], TYPES, 4242);
  assert.ok(placed.length > 0, 'fixture placed nothing — this test would assert nothing');
  for (const c of placed) {
    const [row, col] = tileOf(c);
    assert.ok(!roads.has(`${row},${col}`), `packed creature on road cell (${row},${col})`);
  }
});

test('no creature lands inside an authored safe rectangle', () => {
  const rect = { minRow: 20, minCol: 20, width: 8, height: 8 };
  const world = { ...WORLD, safeRects: [rect] };
  const placed = placeMapCreatures(world, 80, TYPES, 4242);
  assert.ok(placed.length > 0, 'fixture placed nothing — this test would assert nothing');
  for (const c of placed) {
    const [row, col] = tileOf(c);
    const inside = row >= rect.minRow && row <= rect.minRow + rect.height - 1
                && col >= rect.minCol && col <= rect.minCol + rect.width - 1;
    assert.ok(!inside, `creature at (${row},${col}) is inside the safe rectangle`);
  }
});

test('the village exclusion that existed before still holds', () => {
  // isSafeTile subsumes villageContaining; this pins that the replacement did
  // not quietly drop the older rule.
  const village = { minRow: 10, minCol: 10, width: 6, height: 4 };
  const world = { ...WORLD, villages: [village] };
  const placed = placeMapCreatures(world, 80, TYPES, 4242);
  assert.ok(placed.length > 0, 'fixture placed nothing — this test would assert nothing');
  for (const c of placed) {
    const [row, col] = tileOf(c);
    const inside = row >= village.minRow && row <= village.minRow + village.height - 1
                && col >= village.minCol && col <= village.minCol + village.width - 1;
    assert.ok(!inside, `creature at (${row},${col}) is inside the village`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && npm test -- tests/safe_region_placement.test.js
```

Expected: FAIL — the road-corridor and safe-rectangle tests report creatures inside safe territory. The radius-0 and village tests should already PASS.

- [ ] **Step 3: Add the memoized safe context**

In `backend/src/services/mapService.js`, add the require at the top alongside the other service requires:

```js
const { buildSafeContext, isSafeTile } = require('./safeRegion');
```

Then, immediately above `function creatureTileCandidates(...)`, add:

```js
// One safe context per generation config (SOMET-288).
//
// Keyed on the cfg OBJECT, not on a world id: worldConfig() returns a fresh
// object per call and both placers call it exactly once at the top of a run, so
// this computes the whole map's road cells ONCE per placement run rather than
// once per rejection-sampling attempt -- of which there are up to 40 per
// creature. A WeakMap rather than a field on cfg so nothing observable is
// mutated and the entry dies with the config.
//
// The pathCells sweep is skipped entirely at radius 0, which is every world
// that has not opted in: an opted-out world must not pay for a feature it does
// not use, and collectPathCells over a whole map is not free.
const SAFE_CTX = new WeakMap();

function safeContextFor(cfg) {
  const hit = SAFE_CTX.get(cfg);
  if (hit) return hit;
  const radius = Number(cfg.safeRoadRadius) || 0;
  const ctx = buildSafeContext({
    villages: cfg.villages,
    pathCells: radius > 0 && cfg.bounds
      ? collectPathCells(cfg, 0, 0, cfg.bounds.height, cfg.bounds.width)
      : new Set(),
    safeRoadRadius: radius,
    safeRects: cfg.safeRects,
  });
  SAFE_CTX.set(cfg, ctx);
  return ctx;
}
```

- [ ] **Step 4: Replace the village check with the safe-tile check**

In `creatureTileCandidates`, replace this line:

```js
  if (villageContaining(gRow, gCol, cfg.villages)) return null;
```

with:

```js
  // SOMET-288. Subsumes the village check that used to stand here: a village
  // box is one of the three things isSafeTile calls safe, alongside the road
  // corridor and any authored rectangle. THIS is the single chokepoint --
  // placeMapCreatures, placeCreaturePacks, seeding via applyMapSpec and the
  // admin re-roll route all reach hostile placement through this function and
  // nowhere else, so the rule cannot be half-applied the way SOMET-153's
  // village geometry rule was.
  if (isSafeTile(safeContextFor(cfg), gRow, gCol)) return null;
```

Leave `villageContaining` exported and in place — `stampVillage` and the overview markers still use it.

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd backend && npm test -- tests/safe_region_placement.test.js
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Run the neighbouring suites for regressions**

```bash
cd backend && npm test -- tests/mapService.test.js tests/creature_spawn_levels.test.js tests/worldGen.test.js tests/worldGenConfig.test.js
```

Expected: PASS. If a placement test fails on changed coordinates, **stop** — that means an opted-out world's layout moved, which the radius-0 guarantee forbids. Do not update the expected coordinates; find why the safe context is non-empty at radius 0.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/mapService.js backend/tests/safe_region_placement.test.js
git commit -m "$(cat <<'EOF'
feat(safe-region): keep hostiles out of villages, roads and safe rectangles (SOMET-288)

Wired into creatureTileCandidates, the single function placeMapCreatures and
placeCreaturePacks both already pass through -- and the one that already
refused village tiles, a rule isSafeTile now subsumes. Seeding and the admin
re-roll route inherit it without naming it.

The road-cell sweep is memoized per generation config and skipped entirely at
radius 0, so an opted-out world neither changes its layout nor pays for the
feature.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Author safe regions and multiple villages in a map spec

**Files:**
- Modify: `backend/seeds/mapSpec.js` (`validateMapSpec`)
- Modify: `backend/scripts/seed-map.js` (world upsert + village loop)
- Test: `backend/tests/map_spec_validate.test.js` (append)

**Interfaces:**
- Consumes: `worlds.safe_road_radius` / `worlds.safe_rects` from Task 2.
- Produces:
  - Spec world keys: `villages: [ {min_row,min_col,width,height,gate_edge,spawn_x,spawn_y}, ... ]`, `safe_road_radius: <int 0..8>`, `safe_rects: [ {min_row,min_col,width,height}, ... ]`
  - `villagesOf(w) -> array` exported from `backend/seeds/mapSpec.js`, so the validator and the applier read the singular/plural forms identically.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/map_spec_validate.test.js`, reusing the two helpers already at the top of that file: `valid()` returns a minimal two-world spec (`a` is 64×64 and `is_entry`), and `errorsFor(mutate)` applies one mutation to it and returns the errors.

**Village coordinates are world pixels at `MAP_TILE_SIZE` 100, and `spawn_x` is the COLUMN while `spawn_y` is the ROW.** A 6×4 box at `min_row 10 / min_col 10` has interior rows 11–12 and cols 11–14, so `spawn_x: 1150, spawn_y: 1150` is legal and `spawn_y: 1050` would land on the north wall ring. Get this wrong and every case below fails on the SOMET-153 spawn rule instead of the rule it is testing.

```js
// A legal 6x4 village whose spawn is genuinely interior. Cloned per case so a
// mutation in one test cannot leak into another.
const VILLAGE_A = () => ({
  min_row: 10, min_col: 10, width: 6, height: 4, gate_edge: 'S',
  spawn_x: 1150, spawn_y: 1150,
});
const VILLAGE_B = () => ({
  min_row: 30, min_col: 30, width: 6, height: 4, gate_edge: 'S',
  spawn_x: 3150, spawn_y: 3150,
});

test('a world may declare several villages', () => {
  assert.deepEqual(errorsFor((s) => { s.worlds[0].villages = [VILLAGE_A(), VILLAGE_B()]; }), []);
});

test('the singular village key still validates unchanged', () => {
  // 20+ checked-in specs use it. This feature must not require touching any
  // of them.
  assert.deepEqual(errorsFor((s) => { s.worlds[0].village = VILLAGE_A(); }), []);
});

test('declaring both village and villages is rejected', () => {
  const errs = errorsFor((s) => {
    s.worlds[0].village = VILLAGE_A();
    s.worlds[0].villages = [VILLAGE_B()];
  });
  assert.ok(errs.some((e) => /both "village" and "villages"/.test(e)), errs.join('\n'));
});

test('every village in the array passes the same geometry rules as a lone one', () => {
  // 6+5 = 11 breaks the SOMET-282 screen budget. The SECOND entry must be
  // checked, not just the first -- a rule applied to element 0 of a list is
  // the same half-applied rule in a new costume.
  const errs = errorsFor((s) => {
    s.worlds[0].villages = [VILLAGE_A(), { ...VILLAGE_B(), height: 5 }];
  });
  assert.ok(errs.some((e) => /width \+ height must be at most/.test(e)), errs.join('\n'));
});

test('two villages in one world may not overlap', () => {
  const errs = errorsFor((s) => {
    s.worlds[0].villages = [
      VILLAGE_A(),
      { min_row: 12, min_col: 12, width: 6, height: 4, gate_edge: 'S',
        spawn_x: 1350, spawn_y: 1350 },
    ];
  });
  assert.ok(errs.some((e) => /villages overlap/.test(e)), errs.join('\n'));
});

test('safe_road_radius must be an integer in 0..8', () => {
  for (const bad of [-1, 9, 2.5, '2', true]) {
    const errs = errorsFor((s) => { s.worlds[0].safe_road_radius = bad; });
    assert.ok(errs.some((e) => /safe_road_radius/.test(e)),
      `radius ${JSON.stringify(bad)} was accepted`);
  }
  assert.deepEqual(errorsFor((s) => { s.worlds[0].safe_road_radius = 3; }), []);
});

test('a safe rectangle must be positive and inside the map bounds', () => {
  const errs = errorsFor((s) => {
    s.worlds[0].safe_rects = [{ min_row: 60, min_col: 60, width: 20, height: 20 }];
  });
  assert.ok(errs.some((e) => /safe_rects/.test(e)), errs.join('\n'));

  assert.deepEqual(errorsFor((s) => {
    s.worlds[0].safe_rects = [{ min_row: 10, min_col: 10, width: 4, height: 4 }];
  }), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && npm test -- tests/map_spec_validate.test.js
```

Expected: FAIL on the plural, overlap, radius and rectangle cases.

- [ ] **Step 3: Implement the validation**

In `backend/seeds/mapSpec.js`, above `validateMapSpec`, add:

```js
// The singular `village` key and the plural `villages` array read as one list.
// Both the validator and scripts/seed-map.js call THIS -- the same
// cannot-drift-apart reason VILLAGE_LIMITS is shared rather than restated. 20+
// checked-in specs use the singular form and none of them should have to change
// for a world elsewhere to want three villages.
function villagesOf(w) {
  if (Array.isArray(w.villages)) return w.villages;
  return w.village ? [w.village] : [];
}

function boxesOverlap(a, b) {
  return a.min_row <= b.min_row + b.height - 1
      && b.min_row <= a.min_row + a.height - 1
      && a.min_col <= b.min_col + b.width - 1
      && b.min_col <= a.min_col + a.width - 1;
}

// Widest safe corridor a spec may ask for. A radius wider than a village is
// already generous, and at 8 a 64-tile world is mostly road; the DB carries the
// same range as a CHECK constraint for anything that writes the column
// directly.
const MAX_SAFE_ROAD_RADIUS = 8;
```

Then, inside the per-world loop, replace the whole `if (w.village) { ... }` block with:

```js
    if (w.village && Array.isArray(w.villages)) {
      errors.push(`world "${w.key}" declares both "village" and "villages" — use one`);
    }
    const villages = villagesOf(w);
    for (const v of villages) {
      if (!(v.width >= VILLAGE_LIMITS.minW && v.width <= VILLAGE_LIMITS.maxW)) {
        errors.push(`world "${w.key}" village width must be between 3 and 8 tiles`);
      }
      if (!(v.height >= VILLAGE_LIMITS.minH && v.height <= VILLAGE_LIMITS.maxH)) {
        errors.push(`world "${w.key}" village height must be between 3 and 6 tiles`);
      }
      if (!['N', 'E', 'S', 'W'].includes(v.gate_edge)) {
        errors.push(`world "${w.key}" village gate_edge must be one of N,E,S,W`);
      }
      // The geometry rules the HTTP API enforces (validateVillageBody in
      // src/index.js), imported rather than restated: the SOMET-282 on-screen
      // size budget (width + height <= VILLAGE_LIMITS.maxSum, which the
      // per-axis checks above cannot express) and the SOMET-153 interior-spawn
      // rule. seed-map.js calls createVillage directly and so never passed
      // through that route: three seeded hubs shipped with a spawn on the
      // SOUTH wall ring, and respawn-at-village dropped the player inside the
      // wall. Same function object as index.js calls, so the two call sites
      // cannot drift. Applied to EVERY entry, not just the first -- a rule
      // that checks one element of a list is the same half-applied rule in a
      // new costume.
      const geomErr = villageGeometryError(v);
      if (geomErr) errors.push(`world "${w.key}" village ${geomErr}`);
    }
    // Overlapping boxes would stamp two wall rings through each other, leaving
    // a village with a hole in it and a gate that opens into another village's
    // wall. Cheap O(n^2) -- a world has single-digit villages.
    for (let i = 0; i < villages.length; i++) {
      for (let j = i + 1; j < villages.length; j++) {
        if (boxesOverlap(villages[i], villages[j])) {
          errors.push(`world "${w.key}" villages overlap `
            + `(rows ${villages[i].min_row} and ${villages[j].min_row})`);
        }
      }
    }

    // SOMET-288 safe territory. Rejected rather than coerced, for the reason
    // allows_fast_travel states above: "3" and true are how a hand-edited spec
    // gets this wrong, and coercing either would widen or silently disable a
    // safe corridor on the strength of a typo.
    if (w.safe_road_radius !== undefined) {
      const r = w.safe_road_radius;
      if (!Number.isInteger(r) || r < 0 || r > MAX_SAFE_ROAD_RADIUS) {
        errors.push(`world "${w.key}" safe_road_radius must be an integer `
          + `between 0 and ${MAX_SAFE_ROAD_RADIUS} (got ${JSON.stringify(r)})`);
      }
    }
    for (const s of w.safe_rects ?? []) {
      const bad = !Number.isInteger(s.min_row) || !Number.isInteger(s.min_col)
        || !Number.isInteger(s.width) || !Number.isInteger(s.height)
        || s.width < 1 || s.height < 1
        || s.min_row < 0 || s.min_col < 0
        || s.min_row + s.height > w.height || s.min_col + s.width > w.width;
      if (bad) {
        errors.push(`world "${w.key}" safe_rects entry must be a positive box `
          + `inside the ${w.width}x${w.height} map (got ${JSON.stringify(s)})`);
      }
    }
```

Export `villagesOf` from the module's `module.exports`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend && npm test -- tests/map_spec_validate.test.js tests/map_spec_fixtures.test.js
```

Expected: PASS. `map_spec_fixtures.test.js` validates every checked-in spec and must stay green — that is the proof the singular form still works.

- [ ] **Step 5: Persist the new columns in the applier**

In `backend/scripts/seed-map.js`, add `safe_road_radius` and `safe_rects` to the world upsert. In the column list and `VALUES` list add the two columns (they become `$16` and `$17`), in the `ON CONFLICT DO UPDATE SET` block add:

```sql
               -- Re-asserted on every seed, like allows_fast_travel above and
               -- for the same reason: the spec is the source of truth, so
               -- deleting the key from a spec must take the safety back OFF
               -- rather than leave a world permanently safe because it once was.
               safe_road_radius = EXCLUDED.safe_road_radius,
               safe_rects = EXCLUDED.safe_rects
```

and in the parameter array, after `w.allows_fast_travel === true`:

```js
         w.safe_road_radius ?? 0,
         JSON.stringify(w.safe_rects ?? []),
```

Cast the new jsonb parameter in the `VALUES` clause as `$17::jsonb`, matching how `biomes` and `entry_spawn` are cast.

- [ ] **Step 6: Create every village, not just the first**

In `backend/scripts/seed-map.js`, require `villagesOf` from `../seeds/mapSpec.js` and replace the village loop body:

```js
    let villages = 0;
    for (const w of spec.worlds) {
      const specVillages = villagesOf(w);
      if (specVillages.length === 0) continue;
      const worldId = idByKey.get(w.key);
      const existing = await client.query('SELECT id FROM villages WHERE world_id = $1', [worldId]);
      // Idempotent, and all-or-nothing per world: a world that already has any
      // village is left exactly as it is. Creating "the ones that are missing"
      // would need an identity for a village beyond its box, which the spec
      // does not carry -- and a partial re-create would double a village's
      // guards and re-seed its merchant.
      if (existing.rowCount === 0) {
        for (const v of specVillages) {
          await createVillage(client, worldId, v);
          villages += 1;
        }
      }
    }
```

- [ ] **Step 7: Verify the applier still seeds a real spec**

The applier reads the spec name from the `SPEC` environment variable, and the Makefile target is the documented entry point:

```bash
make list-maps                    # which spec is seeded in THIS database
make seed-map SPEC=<that-name>    # re-apply it; the upsert is idempotent
```

Expected: `applied <name>: N worlds, N links, N villages, ...` with the same village count as before this change, and no error.

**Do not** apply a spec other than the one already seeded here — this repo allows one spec per database, and `make reseed-map` would clear the maps first. There is no dry-run mode.

- [ ] **Step 8: Run the seed suites**

```bash
cd backend && npm test -- tests/seed_map_db.test.js tests/map_spec_validate.test.js tests/map_spec_fixtures.test.js tests/map_spec_portals.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/seeds/mapSpec.js backend/scripts/seed-map.js backend/tests/map_spec_validate.test.js
git commit -m "$(cat <<'EOF'
feat(safe-region): author several villages and safe territory in a map spec (SOMET-288)

A world may now declare `villages: [...]`; the singular `village` key stays a
one-element alias so none of the 20+ checked-in specs change. The stamper
already looped cfg.villages plural, so this is a spec and applier change only.

Every entry passes the same geometry gate a lone village did -- a rule that
checks one element of a list is the same half-applied rule SOMET-153 shipped,
in a new costume -- and overlapping boxes are rejected outright.

safe_road_radius and safe_rects are re-asserted on every seed, so removing the
key from a spec takes the safety back off.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Prove it end to end through `populateWorld`

**Files:**
- Test: `backend/tests/safe_region_population_db.test.js`

**Interfaces:**
- Consumes: everything above. Adds no production code — if this task needs a production change, the earlier tasks were wrong and that is what it exists to reveal.

- [ ] **Step 1: Write the test**

Create `backend/tests/safe_region_population_db.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { populateWorld } = require('../src/services/worldPopulation');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig');
const { worldConfig, collectPathCells, CREATURE_TILE_PX } = require('../src/services/mapService');
const { loadTileTypes } = require('../src/services/tileTypes');

const URL = process.env.DATABASE_URL;
const describeDb = URL ? test : test.skip;

// Fixture worlds are named zzSafe* and deleted BY NAME, unconditionally, in a
// finally. Never delete by an id captured mid-test: if the test fails before
// the capture, the row leaks into the shared dev database forever.
const FIXTURES = ['zzSafeRoads'];

async function cleanup(pool) {
  await pool.query('DELETE FROM worlds WHERE name = ANY($1::text[])', [FIXTURES]);
}

// Only creature types that EXIST in the dev catalog — inventing a name makes
// every assertion vacuous, because the world would be legitimately unpopulated.
const ALLOWED = ['Skeleton', 'Bat'];

describeDb('populateWorld places no hostile inside the safe road corridor', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await cleanup(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const w = await client.query(
        `INSERT INTO worlds (name, seed, chunk_size, width, height, density,
                             allowed_creature_types, biomes, biome_cell,
                             level_min, level_max, safe_road_radius)
         VALUES ('zzSafeRoads', 4242, 32, 64, 64, 'horde',
                 $1::jsonb, '[]'::jsonb, 16, 1, 2, 2)
         RETURNING *`,
        [JSON.stringify(ALLOWED)],
      );
      const row = w.rows[0];

      const result = await populateWorld(client, row, { rngSeed: 4242 });
      assert.ok(result.total > 0, 'populated nothing — this test would assert nothing');

      const tileTypes = await loadTileTypes(client);
      const cfg = worldConfig(buildWorldGenConfig({
        row, tileTypes, doorways: [], villages: [], biomes: [],
      }));
      const roads = collectPathCells(cfg, 0, 0, row.height, row.width);
      assert.ok(roads.size > 0, 'no carved roads — this test would assert nothing');

      const placed = await client.query(
        'SELECT x, y FROM world_creatures WHERE world_id = $1', [row.id]);
      for (const c of placed.rows) {
        const rr = Math.floor(Number(c.y) / CREATURE_TILE_PX);
        const cc = Math.floor(Number(c.x) / CREATURE_TILE_PX);
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            assert.ok(!roads.has(`${rr + dr},${cc + dc}`),
              `creature at tile (${rr},${cc}) is inside the radius-2 road corridor`);
          }
        }
      }
      // Rolled back: this test proves placement, it does not need to leave a
      // world behind. NOTE that client.release() does NOT roll back on its own
      // in this codebase — the explicit ROLLBACK is the thing that works.
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});
```

- [ ] **Step 2: Run it**

```bash
cd backend && DATABASE_URL="$DATABASE_URL" npm test -- tests/safe_region_population_db.test.js
```

Expected: PASS. If it reports `skip`, `DATABASE_URL` is unset — export it and re-run; a skipped DB test proves nothing.

- [ ] **Step 3: Run the whole backend suite once**

```bash
cd backend && npm test
```

Expected: PASS. This is the one full-suite run for this slice — do not run it after each task.

**If the entry world's data looks wrong afterwards**, the full suite has previously wiped it: check `is_entry` still exists on exactly one world and use `restore-entry.js` if not.

- [ ] **Step 4: Commit**

```bash
git add backend/tests/safe_region_population_db.test.js
git commit -m "$(cat <<'EOF'
test(safe-region): prove the exclusion end to end through populateWorld (SOMET-288)

The unit and placement tests exercise mapService directly; this one goes
through the path the seeder and the admin re-roll route actually use, against a
real worlds row with safe_road_radius set, and asserts every persisted creature
is outside the corridor.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Definition of done

- `backend/npm test` green from `backend/` with `DATABASE_URL` set.
- No browser verification for this slice: it changes no player-visible surface. SOMET-289 is where a player can see safe roads, and it carries the browser step.
- SOMET-288 moves to **To Review** with a comment naming the commits and the test output.

## Deviations from the ticket

`pens` is **not** part of this slice. The ticket listed it among the spec fields, but nothing consumes a pen until SOMET-289 places creatures in one, and SOMET-289 has to modify `mapSpec.js` regardless. Validating a field with no reader here would be schema nobody reads. Update SOMET-288 and SOMET-289 to reflect the move.
