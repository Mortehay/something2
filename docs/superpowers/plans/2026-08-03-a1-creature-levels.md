# A1 — Creature Levels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every wild creature a level rolled from its world's level band, so map authors can declare difficulty per world and dungeon level N is just a higher band.

**Architecture:** Two new nullable-free columns on `worlds` (`level_min`/`level_max`) and one on `world_creatures` (`level`). A single pure module, `src/services/creatureLevel.js`, owns both the level roll and the stat scaling; it takes a plain 0..1 number rather than an RNG so the two existing spawn paths can each feed it from their own deterministic source. Scaled stats are computed at spawn and persisted, so the authority never rescales at runtime.

**Tech Stack:** Node 20, CommonJS, Express, `pg`, `node-pg-migrate`, `node:test` + `node:assert`. Frontend: React 18 + Vite, vitest in a **plain node environment** (no DOM, no jsdom, no React Testing Library).

## Global Constraints

- Backend tests run with `node --test` from `backend/`. Assertions use `node:assert`.
- **Frontend vitest has no DOM.** Frontend tests are pure-function or source-text only. Do not write rendering tests.
- **Never run `npm test` with `TEST_DATABASE_URL` set** unless the target is a throwaway database. Database-touching tests are gated behind that variable precisely so a bare `npm test` cannot mutate the dev database.
- **Never run `DELETE`, `TRUNCATE`, `DROP`, or an unscoped `UPDATE` against the compose Postgres**, and never run a deliberately-broken variant of application code against it. A reviewer did this on 2026-08-01 and destroyed the catalog.
- **Migration timestamps for A1 are reserved: `1714440050000`–`1714440059000`.** The highest on `main` is `1714440044000`. This repo has already had a timestamp collision (`1714440008000`); do not pick a number outside the reserved range.
- Tests assert **literal expected values**, never a recomputation of the formula under test. Every task's final step includes a mutation check.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Work is tracked as **SOMET-241**. Reference it in commits.

## Corrections to the design spec

The spec was written before the spawn code was read closely. Three things in it are wrong, and this plan supersedes it:

1. **There are two spawn paths, not one.** `spawnChunkCreatures` (`mapService.js:502`) handles unbounded worlds via a per-tile hash. `placeMapCreatures` (`mapService.js:537`) handles **bounded** worlds via `makeRng` — and every seeded adventure map is bounded, so this is the path that matters most. Both need levels.
2. **Creature damage does not come from `entity_types`.** It is the flat constant `CREATURE_DAMAGE = 5` (`creatures.js:22`), applied at `creatures.js:276`. Scaling damage therefore means persisting a per-creature damage value and reading it at the attack site, not scaling a column that already exists.
3. **Village guards are out of scope.** They are inserted separately (`villages.js:38`), are structural rather than wild spawns, and use their own already-tuned `GUARD_DAMAGE = 25`. They stay level 1. Scaling them is a balance change nobody asked for.

---

### Task 1: Migration — level band and creature level columns

**Files:**
- Create: `backend/migrations/1714440050000_creature_levels.js`
- Test: `backend/tests/creature_levels_db.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: columns `worlds.level_min`, `worlds.level_max`, `world_creatures.level`, `world_creatures.damage`; constraint `worlds_level_band_check`.

- [ ] **Step 1: Write the migration**

`backend/migrations/1714440050000_creature_levels.js`:

```js
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Difficulty is authored per world as a band; a creature rolls its level
  // inside it at spawn. Default 1/1 means every existing world keeps exactly
  // the behaviour it has today -- a band of [1,1] scales nothing.
  pgm.addColumns('worlds', {
    level_min: { type: 'integer', notNull: true, default: 1 },
    level_max: { type: 'integer', notNull: true, default: 1 },
  });
  pgm.addConstraint('worlds', 'worlds_level_band_check',
    'CHECK (level_min >= 1 AND level_max >= level_min)');

  // Level is per-INSTANCE, not per-type: the same Wolf is level 2 in a starter
  // meadow and level 14 three floors down.
  pgm.addColumns('world_creatures', {
    level: { type: 'integer', notNull: true, default: 1 },
    // Creature attack damage is currently the flat constant CREATURE_DAMAGE
    // (authority/creatures.js:22) and lives nowhere in the schema, so scaling
    // it needs somewhere to put the result. Persisted at spawn alongside hp so
    // the authority never rescales at runtime.
    damage: { type: 'real', notNull: true, default: 5 },
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('worlds', 'worlds_level_band_check');
  pgm.dropColumns('worlds', ['level_min', 'level_max']);
  pgm.dropColumns('world_creatures', ['level', 'damage']);
};
```

- [ ] **Step 2: Write the failing gated test**

`backend/tests/creature_levels_db.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

// Gated exactly like seed_catalogs_db.test.js: skip without TEST_DATABASE_URL
// and do NOT fall back to DATABASE_URL, so a bare `npm test` on a machine with
// a working dev database can never reach it. This test INSERTs and DELETEs.
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

function requireTestDb(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await pool.query('SELECT 1'); return pool; }
  catch (err) { await pool.end().catch(() => {}); return { unreachable: err.message }; }
}

test('the level band constraint rejects an inverted band', async (t) => {
  if (!requireTestDb(t, 'this test INSERTs a world row')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} -- the band constraint is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const NAME = 'zz_level_band_canary';
  try {
    await assert.rejects(
      () => pool.query(
        `INSERT INTO worlds (name, seed, level_min, level_max) VALUES ($1, 1, 9, 3)`,
        [NAME],
      ),
      /worlds_level_band_check/,
      'an inverted band must be rejected by the database, not just by app code',
    );
    // The equal case is legal: a band of [5,5] is a fixed-level world.
    await pool.query(
      `INSERT INTO worlds (name, seed, level_min, level_max) VALUES ($1, 1, 5, 5)`,
      [NAME],
    );
    const r = await pool.query('SELECT level_min, level_max FROM worlds WHERE name = $1', [NAME]);
    assert.equal(r.rows[0].level_min, 5);
    assert.equal(r.rows[0].level_max, 5);
  } finally {
    await pool.query('DELETE FROM worlds WHERE name = $1', [NAME]).catch(() => {});
    await pool.end();
  }
});

test('existing creatures default to level 1 and damage 5', async (t) => {
  if (!requireTestDb(t, 'this test reads world_creatures defaults')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  try {
    const r = await pool.query(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = 'world_creatures' AND column_name IN ('level','damage')
        ORDER BY column_name`,
    );
    assert.equal(r.rowCount, 2, 'both columns must exist');
    assert.match(r.rows[0].column_default, /5/);  // damage
    assert.match(r.rows[1].column_default, /1/);  // level
  } finally { await pool.end(); }
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd backend && node --test tests/creature_levels_db.test.js
```

Expected: both tests SKIP (no `TEST_DATABASE_URL`). That is the correct pass state for a bare run — it proves the gate works. To actually exercise them you need a throwaway database; do not point `TEST_DATABASE_URL` at the dev database.

- [ ] **Step 4: Apply the migration**

```bash
cd backend && npm run migrate:up
```

Expected: `1714440050000_creature_levels` applied.

- [ ] **Step 5: Verify the columns landed**

```bash
docker exec -i something2-db-1 psql -U user -d game_db \
  -c "\d worlds" | grep level_
docker exec -i something2-db-1 psql -U user -d game_db \
  -c "\d world_creatures" | grep -E "level|damage"
```

Expected: `level_min`/`level_max` on `worlds` with default 1, `level` (default 1) and `damage` (default 5) on `world_creatures`.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/1714440050000_creature_levels.js backend/tests/creature_levels_db.test.js
git commit -m "feat(levels): add per-world level bands and per-creature level (SOMET-241)

Level is per-instance, not per-type: the same Wolf is level 2 in a starter
meadow and level 14 three floors down. Bands default to [1,1] so every
existing world keeps exactly today's behaviour.

world_creatures.damage exists because creature attack damage is currently
the flat constant CREATURE_DAMAGE (authority/creatures.js:22) and lives
nowhere in the schema, so a scaled value had nowhere to go.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The pure level module

**Files:**
- Create: `backend/src/services/creatureLevel.js`
- Test: `backend/tests/creature_level.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `rollCreatureLevel(unit, levelMin, levelMax) -> integer` — `unit` is a number in `[0, 1)`, supplied by the caller's own deterministic source.
  - `scaleCreature({ hp, damage, defense }, level) -> { hp, damage, defense }`
  - Constants `LEVEL_HP_GROWTH`, `LEVEL_DAMAGE_GROWTH`, `LEVEL_DEFENSE_PER_LEVEL`.

- [ ] **Step 1: Write the failing test**

`backend/tests/creature_level.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const {
  rollCreatureLevel, scaleCreature,
} = require('../src/services/creatureLevel.js');

// EVERY expected value below is a hand-computed literal, never a
// recomputation of the formula under test. This repo has twice shipped tests
// whose assertions were derived from the same source as the code and
// therefore passed no matter what the code did -- most recently
// biomes_seed.test.js, which checked biome creature references against a
// hand-typed list containing the very name that was dangling.

test('rollCreatureLevel maps the unit interval across the band inclusively', () => {
  // Band [3, 6] is 4 levels wide. u=0 must give the floor, u just under 1
  // must give the ceiling, and nothing may fall outside.
  assert.equal(rollCreatureLevel(0, 3, 6), 3);
  assert.equal(rollCreatureLevel(0.999999, 3, 6), 6);
  assert.equal(rollCreatureLevel(0.25, 3, 6), 4);
  assert.equal(rollCreatureLevel(0.5, 3, 6), 5);
  assert.equal(rollCreatureLevel(0.75, 3, 6), 6);
});

test('a fixed band always returns that level', () => {
  assert.equal(rollCreatureLevel(0, 5, 5), 5);
  assert.equal(rollCreatureLevel(0.5, 5, 5), 5);
  assert.equal(rollCreatureLevel(0.999999, 5, 5), 5);
});

test('rollCreatureLevel clamps a defensive out-of-range unit', () => {
  // hash2/makeRng both return [0,1), but a caller passing 1.0 or a negative
  // must never produce a level outside the band -- that would write a row the
  // worlds_level_band_check would have rejected.
  assert.equal(rollCreatureLevel(1, 2, 4), 4);
  assert.equal(rollCreatureLevel(1.5, 2, 4), 4);
  assert.equal(rollCreatureLevel(-0.2, 2, 4), 2);
});

test('an inverted or missing band degrades to level 1 rather than throwing', () => {
  // Spawn runs inside a transaction that also writes the world_chunks
  // once-only flag (server.js:341). A throw here would roll that back and the
  // chunk would retry forever.
  assert.equal(rollCreatureLevel(0.5, 9, 3), 1);
  assert.equal(rollCreatureLevel(0.5, undefined, undefined), 1);
  assert.equal(rollCreatureLevel(0.5, null, 7), 1);
});

test('level 1 scales nothing at all', () => {
  const base = { hp: 12, damage: 5, defense: 2 };
  assert.deepEqual(scaleCreature(base, 1), { hp: 12, damage: 5, defense: 2 });
});

test('scaleCreature grows hp, damage and defense by hand-computed amounts', () => {
  // Level 5 => 4 levels of growth over the base.
  //   hp      = round(12 * (1 + 0.15*4)) = round(12 * 1.60) = round(19.2) = 19
  //   damage  = round2(5 * (1 + 0.10*4)) = round2(5 * 1.40) = 7
  //   defense = 2 + 0.5*4 = 4
  assert.deepEqual(scaleCreature({ hp: 12, damage: 5, defense: 2 }, 5),
    { hp: 19, damage: 7, defense: 4 });

  // Level 10 => 9 levels of growth.
  //   hp      = round(18 * (1 + 0.15*9)) = round(18 * 2.35) = round(42.3) = 42
  //   damage  = round2(5 * (1 + 0.10*9)) = round2(5 * 1.90) = 9.5
  //   defense = 0 + 0.5*9 = 4.5
  assert.deepEqual(scaleCreature({ hp: 18, damage: 5, defense: 0 }, 10),
    { hp: 42, damage: 9.5, defense: 4.5 });
});

test('hp never scales below 1 even from a degenerate base', () => {
  assert.equal(scaleCreature({ hp: 0, damage: 5, defense: 0 }, 3).hp, 1);
});

test('scaleCreature does not mutate its input', () => {
  const base = { hp: 12, damage: 5, defense: 2 };
  scaleCreature(base, 9);
  assert.deepEqual(base, { hp: 12, damage: 5, defense: 2 });
});

test('scaleCreature never touches resistances', () => {
  // Deliberate: scaling a 0.6 fire resistance by level reaches effective
  // immunity within a few levels. Resistances are a matchup, not a stat.
  const out = scaleCreature({ hp: 10, damage: 5, defense: 0, resistances: { fire: 0.6 } }, 12);
  assert.equal(out.resistances, undefined,
    'scaleCreature returns only the three scaled stats; the caller carries resistances through untouched');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && node --test tests/creature_level.test.js
```

Expected: FAIL — `Cannot find module '../src/services/creatureLevel.js'`.

- [ ] **Step 3: Write the implementation**

`backend/src/services/creatureLevel.js`:

```js
// Creature level: the roll, and what a level does to a creature's stats.
//
// This module is PURE and takes a plain number in [0,1) rather than an RNG,
// because the two spawn paths have different deterministic sources and
// neither may be replaced:
//   - spawnChunkCreatures (mapService.js:502) hashes per tile via hash2
//   - placeMapCreatures  (mapService.js:537) draws from makeRng(rngSeed)
// Handing this module the draw instead of the generator keeps both callers
// deterministic on their own terms and keeps this file trivially testable.
//
// Server-side only. The repo already carries a two-copy resolveMove between
// frontend movement.js and backend authority/collision.js and must not grow a
// second such pair -- the client is told a creature's already-scaled hp and
// level, and never recomputes either.

// Growth per level beyond 1. Provisional: these are the first numbers, not
// tuned ones, and the A2 XP curve will want them revisited once player
// progression exists to measure them against.
const LEVEL_HP_GROWTH = 0.15;          // +15% of base hp per level
const LEVEL_DAMAGE_GROWTH = 0.10;      // +10% of base damage per level
const LEVEL_DEFENSE_PER_LEVEL = 0.5;   // flat, because defense is subtractive

// Map a [0,1) draw onto [levelMin, levelMax] inclusive.
//
// Returns 1 for a missing or inverted band rather than throwing: spawning runs
// inside the transaction that also writes the world_chunks once-only flag
// (server.js:341-348), so a throw would roll that flag back and the chunk
// would retry spawning forever.
function rollCreatureLevel(unit, levelMin, levelMax) {
  const lo = Number.isInteger(levelMin) ? levelMin : null;
  const hi = Number.isInteger(levelMax) ? levelMax : null;
  if (lo === null || hi === null || lo < 1 || hi < lo) return 1;
  const u = Number.isFinite(unit) ? Math.min(0.999999999, Math.max(0, unit)) : 0;
  return lo + Math.floor(u * (hi - lo + 1));
}

// Round to 2dp without floating-point noise (5 * 1.9 is 9.500000000000002).
function round2(n) { return Math.round(n * 100) / 100; }

// Scale the three stats a level affects. Returns ONLY those three -- callers
// carry `resistances` through untouched by design.
function scaleCreature(base, level) {
  const lv = Number.isInteger(level) && level >= 1 ? level : 1;
  const steps = lv - 1;
  const baseHp = Number(base.hp) || 0;
  const baseDamage = Number(base.damage) || 0;
  const baseDefense = Number(base.defense) || 0;
  return {
    // Math.max(1, ...) so a creature type mis-authored with hp 0 still spawns
    // killable rather than dead-on-arrival.
    hp: Math.max(1, Math.round(baseHp * (1 + LEVEL_HP_GROWTH * steps))),
    damage: round2(baseDamage * (1 + LEVEL_DAMAGE_GROWTH * steps)),
    defense: round2(baseDefense + LEVEL_DEFENSE_PER_LEVEL * steps),
  };
}

module.exports = {
  rollCreatureLevel, scaleCreature,
  LEVEL_HP_GROWTH, LEVEL_DAMAGE_GROWTH, LEVEL_DEFENSE_PER_LEVEL,
};
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend && node --test tests/creature_level.test.js
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Mutation check — prove the tests have teeth**

Make each of these edits one at a time, run the test file, confirm it goes RED, then **revert by re-editing** (`creatureLevel.js` is untracked until the commit below — `git checkout` will not restore it):

1. `LEVEL_HP_GROWTH = 0.15` → `0.2` — expect the level-5/level-10 test to fail.
2. `return lo + Math.floor(...)` → `return lo + Math.round(...)` — expect the band test to fail (it would exceed `levelMax`).
3. `if (lo === null || hi === null || lo < 1 || hi < lo) return 1;` → `return 1` deleted for the inverted case — expect the degrade test to fail.

If any edit leaves the suite green, the test is not testing what it claims; fix the test before continuing.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/creatureLevel.js backend/tests/creature_level.test.js
git commit -m "feat(levels): pure creature level roll and stat scaling (SOMET-241)

Takes a [0,1) draw rather than an RNG, because the two spawn paths have
different deterministic sources -- spawnChunkCreatures hashes per tile,
placeMapCreatures draws from makeRng -- and neither may be replaced.

Degrades to level 1 on a missing or inverted band rather than throwing:
spawning runs inside the transaction that writes the world_chunks
once-only flag, so a throw would roll that flag back and the chunk would
retry spawning forever.

Resistances are deliberately not scaled -- a 0.6 fire resistance reaches
effective immunity within a few levels.

Growth constants are provisional and will be revisited against A2's XP
curve. Tests assert hand-computed literals, and each guard was mutation-
checked.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Roll levels in both spawn paths

**Files:**
- Modify: `backend/src/services/mapService.js:502-530` (`spawnChunkCreatures`), `:537-581` (`placeMapCreatures`)
- Test: `backend/tests/creature_spawn_levels.test.js`

**Interfaces:**
- Consumes: `rollCreatureLevel`, `scaleCreature` from Task 2.
- Produces: both spawn functions now emit rows shaped
  `{ type, x, y, hp, damage, level, facing, defense, resistances }`.
  `world.levelMin` / `world.levelMax` are read off the world config object passed in.

- [ ] **Step 1: Write the failing test**

`backend/tests/creature_spawn_levels.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { spawnChunkCreatures, placeMapCreatures } = require('../src/services/mapService.js');

const TYPES = [
  { name: 'Wolf', hp: 12, defense: 0, resistances: {} },
  { name: 'Bat', hp: 8, defense: 0, resistances: { lightning: 0.5 } },
];

const UNBOUNDED = { seed: 12345, chunkSize: 16, tileTypes: {} };

test('unbounded spawn assigns every creature a level inside the band', () => {
  const world = { ...UNBOUNDED, levelMin: 4, levelMax: 7 };
  const out = spawnChunkCreatures(world, 0, 0, TYPES);
  assert.ok(out.length > 0, 'fixture produced no creatures — this test would assert nothing');
  for (const c of out) {
    assert.ok(Number.isInteger(c.level), `${c.type} level must be an integer`);
    assert.ok(c.level >= 4 && c.level <= 7, `level ${c.level} escaped the band [4,7]`);
  }
});

test('unbounded spawn is deterministic: the same chunk re-rolls identical levels', () => {
  // world_chunks is CACHED. A creature whose level changed on chunk reload
  // would harden or soften as a player walked away and came back.
  const world = { ...UNBOUNDED, levelMin: 2, levelMax: 9 };
  const a = spawnChunkCreatures(world, 3, 5, TYPES);
  const b = spawnChunkCreatures(world, 3, 5, TYPES);
  assert.deepEqual(a.map((c) => [c.type, c.x, c.y, c.level]),
                   b.map((c) => [c.type, c.x, c.y, c.level]));
});

test('the level roll is independent of the type roll', () => {
  // If level reused the type hash, every Wolf in a chunk would share one level
  // and the band would collapse to as many distinct values as there are types.
  const world = { ...UNBOUNDED, levelMin: 1, levelMax: 20 };
  const out = spawnChunkCreatures(world, 0, 0, TYPES);
  const byType = new Map();
  for (const c of out) {
    if (!byType.has(c.type)) byType.set(c.type, new Set());
    byType.get(c.type).add(c.level);
  }
  const widest = Math.max(...[...byType.values()].map((s) => s.size));
  assert.ok(widest > 1,
    'every creature of a type got the same level — the level roll is reusing the type hash');
});

test('unbounded spawn scales hp with level and leaves resistances alone', () => {
  const world = { ...UNBOUNDED, levelMin: 6, levelMax: 6 };
  const out = spawnChunkCreatures(world, 0, 0, TYPES);
  assert.ok(out.length > 0);
  for (const c of out) {
    assert.equal(c.level, 6);
    // Level 6 = 5 steps. Wolf: round(12 * (1 + 0.15*5)) = round(21) = 21.
    //                    Bat: round(8 * 1.75) = 14.
    assert.equal(c.hp, c.type === 'Wolf' ? 21 : 14);
    // Damage from the CREATURE_DAMAGE baseline of 5: round2(5 * 1.5) = 7.5
    assert.equal(c.damage, 7.5);
  }
  const bat = out.find((c) => c.type === 'Bat');
  if (bat) assert.deepEqual(bat.resistances, { lightning: 0.5 }, 'resistances must pass through unscaled');
});

test('a world with no band spawns everything at level 1 with unscaled hp', () => {
  const out = spawnChunkCreatures({ ...UNBOUNDED }, 0, 0, TYPES);
  assert.ok(out.length > 0);
  for (const c of out) {
    assert.equal(c.level, 1);
    assert.equal(c.hp, c.type === 'Wolf' ? 12 : 8);
    assert.equal(c.damage, 5);
  }
});

const BOUNDED = {
  seed: 999, chunkSize: 16, width: 40, height: 40,
  tileTypes: { grass: { walkable: true } },
};

test('bounded placement assigns levels inside the band and is deterministic', () => {
  const world = { ...BOUNDED, levelMin: 3, levelMax: 5 };
  const a = placeMapCreatures(world, 8, TYPES, 4242);
  const b = placeMapCreatures(world, 8, TYPES, 4242);
  assert.ok(a.length > 0, 'fixture placed no creatures — this test would assert nothing');
  assert.deepEqual(a.map((c) => [c.type, c.x, c.y, c.level]),
                   b.map((c) => [c.type, c.x, c.y, c.level]));
  for (const c of a) {
    assert.ok(c.level >= 3 && c.level <= 5, `level ${c.level} escaped the band [3,5]`);
    assert.ok(Number.isFinite(c.damage) && c.damage > 0, 'damage must be carried');
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && node --test tests/creature_spawn_levels.test.js
```

Expected: FAIL — `c.level` is `undefined`.

- [ ] **Step 3: Modify `spawnChunkCreatures`**

In `backend/src/services/mapService.js`, add near the other requires at the top of the file:

```js
const { rollCreatureLevel, scaleCreature } = require('./creatureLevel');
```

Add beside `CREATURE_SALT` (around line 495):

```js
// A THIRD salt, distinct from both the spawn roll and the type pick. Reusing
// either would tie a creature's level to its type or its existence, so every
// Wolf in a chunk would share one level and the band would collapse.
const LEVEL_SALT = 0x1e7e1;
// The baseline a creature's damage scales from. Creature attack damage is
// otherwise the flat CREATURE_DAMAGE constant in authority/creatures.js; this
// mirrors it so an unscaled level-1 creature is byte-identical to today.
const CREATURE_BASE_DAMAGE = 5;
```

Replace the body of the inner loop in `spawnChunkCreatures` (lines 511-526) with:

```js
      const roll = hash2(cfg.seed ^ CREATURE_SALT, gCol, gRow);
      if (roll >= CREATURE_SPAWN_CHANCE) continue;
      // pick a type deterministically from a second hash
      const pick = hash2((cfg.seed ^ CREATURE_SALT) >>> 1, gCol, gRow);
      const t = creatureTypes[Math.min(creatureTypes.length - 1, Math.floor(pick * creatureTypes.length))];
      const levelDraw = hash2(cfg.seed ^ LEVEL_SALT, gCol, gRow);
      const level = rollCreatureLevel(levelDraw, world.levelMin, world.levelMax);
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
        // Carried from the entity type so a spawned creature arrives with the
        // data CreatureSim builds its `mit` from.
        defense: scaled.defense,
        resistances: t.resistances || {},
      });
```

- [ ] **Step 4: Modify `placeMapCreatures`**

Replace lines 567-576 (the type pick and `out.push`) with:

```js
      const t = candidates[Math.floor(rng() * candidates.length)];
      // Drawn from the same stream, immediately after the type pick, so the
      // roll stays deterministic given rngSeed. NOTE: this consumes one extra
      // draw per placed creature, which shifts the stream for everything after
      // it. Creatures are persisted to world_creatures once at world creation,
      // so already-seeded worlds are unaffected; a NEWLY seeded or re-rolled
      // world will lay its creatures out differently than it would have before
      // this change. That is expected and acceptable -- it is not a bug report.
      const level = rollCreatureLevel(rng(), world.levelMin, world.levelMax);
      const scaled = scaleCreature(
        { hp: t.hp || 10, damage: CREATURE_BASE_DAMAGE, defense: Number(t.defense ?? 0) || 0 },
        level,
      );
      out.push({
        type: t.name,
        x: col * CREATURE_TILE_PX + CREATURE_TILE_PX / 2,
        y: row * CREATURE_TILE_PX + CREATURE_TILE_PX / 2,
        hp: scaled.hp,
        damage: scaled.damage,
        level,
        facing: 'S',
        defense: scaled.defense,
        resistances: t.resistances || {},
      });
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd backend && node --test tests/creature_spawn_levels.test.js
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Run the full suite for regressions**

```bash
cd backend && npm test 2>&1 | tail -8
```

Expected: 0 failures. `placeMapCreatures`'s extra `rng()` draw changes the stream, so any existing test asserting exact creature coordinates from a fixed seed will now fail. If one does, that is a **real** expected-value change, not a bug: update the literal, and add a comment saying why it moved.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/mapService.js backend/tests/creature_spawn_levels.test.js
git commit -m "feat(levels): roll a level in both creature spawn paths (SOMET-241)

Both paths, not one: spawnChunkCreatures serves unbounded worlds via a
per-tile hash, placeMapCreatures serves BOUNDED worlds via makeRng -- and
every seeded adventure map is bounded, so that is the path that matters
most for authored difficulty.

The level roll uses a third salt, distinct from the spawn roll and the
type pick. Reusing either would tie level to type, collapsing a whole
chunk's band to one value per creature type; a test asserts the two rolls
are independent.

placeMapCreatures consumes one extra draw per placed creature, shifting
the stream. Creatures persist at world creation, so seeded worlds are
unaffected; newly seeded worlds lay out differently by design.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Persist and load the level

**Files:**
- Modify: `backend/src/authority/server.js:363-374` (chunk spawn insert), `:390-395` (creature SELECT)
- Modify: `backend/src/index.js:1726-1735` (admin re-roll insert)
- Modify: `backend/src/authority/creatures.js:120-137` (`addCreatures`), `:276` (attack damage)
- Test: `backend/tests/creature_level_persistence.test.js`

**Interfaces:**
- Consumes: spawn rows carrying `level` and `damage` from Task 3.
- Produces: sim creatures carry `level` and `damage`; `CreatureSim` attacks for `c.damage`.

- [ ] **Step 1: Write the failing test**

`backend/tests/creature_level_persistence.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim, CREATURE_DAMAGE } = require('../src/authority/creatures.js');

function simWith(rows) {
  const s = new CreatureSim({ chunkSize: 16 });
  s.addCreatures(rows);
  return s;
}

test('addCreatures carries level and damage from the database row', () => {
  const s = simWith([{ id: 'a', type: 'Wolf', x: 10, y: 10, hp: 21, level: 6, damage: 7.5, color: '#c00' }]);
  const c = s.all()[0];
  assert.equal(c.level, 6);
  assert.equal(c.damage, 7.5);
  assert.equal(c.maxHp, 21, 'maxHp must come from the persisted, already-scaled hp');
});

test('a creature row with no damage falls back to the flat constant', () => {
  // Rows written before this migration have damage defaulted at the column
  // level, but a unit-test row or an older cached entry may omit it entirely.
  const s = simWith([{ id: 'b', type: 'Wolf', x: 0, y: 0, hp: 10, color: '#c00' }]);
  assert.equal(s.all()[0].damage, CREATURE_DAMAGE);
  assert.equal(s.all()[0].level, 1, 'a row with no level reads as level 1');
});

test('the snapshot sent to clients includes level', () => {
  const s = simWith([{ id: 'c', type: 'Wolf', x: 10, y: 20, hp: 21, level: 6, damage: 7.5, color: '#c00' }]);
  const snap = s.snapshotForNeighborhood(['0,0']);
  assert.equal(snap.length, 1);
  assert.equal(snap[0].level, 6, 'the client cannot draw a level it was never sent');
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && node --test tests/creature_level_persistence.test.js
```

Expected: FAIL — `level` and `damage` are `undefined`.

- [ ] **Step 3: Carry level and damage through `CreatureSim`**

In `backend/src/authority/creatures.js`, inside `addCreatures` (line 124), add two fields to the object literal, after `mit: creatureMitigation(c),`:

```js
        // Persisted per instance (world_creatures.level/.damage), already
        // scaled at spawn -- the sim never rescales. The `??` fallbacks cover
        // rows written before the level migration and unit-test fixtures.
        level: Number.isInteger(c.level) ? c.level : 1,
        damage: Number.isFinite(c.damage) ? Number(c.damage) : CREATURE_DAMAGE,
```

In `snapshotForNeighborhood` (line 413), add `level` to the row:

```js
        const row = { id: c.id, type: c.type, x: c.x, y: c.y, facing: c.facing, hp: c.hp, maxHp: c.maxHp, mode: c.mode, color: c.color, level: c.level };
```

At line 276, replace the flat constant with the per-creature value:

```js
          applyDamageWithEffects(tp, c.damage ?? CREATURE_DAMAGE, 'physical', tp.mit || NO_MITIGATION, now);
```

Leave line 201 (`GUARD_DAMAGE`) alone — guards are structural and out of scope.

- [ ] **Step 4: Persist level at both insert sites**

In `backend/src/authority/server.js`, replace the insert at line 369-372:

```js
            await client.query(
              `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [entry.worldId, c.type, c.x, c.y, c.hp, c.facing, c.level, c.damage],
            );
```

Replace the SELECT at line 390-393 — the existing comment there already warns that a column dropped from this list loads as `undefined` and silently disables the feature it feeds, which is exactly what would happen to level:

```js
        `SELECT wc.id, wc.type, wc.x, wc.y, wc.hp, wc.facing, wc.home_x, wc.home_y,
                wc.level, wc.damage,
                et.color, et.defense, et.resistances, et.faction
         FROM world_creatures wc LEFT JOIN entity_types et ON et.name = wc.type
         WHERE wc.world_id = $1 AND wc.x >= $2 AND wc.x < $3 AND wc.y >= $4 AND wc.y < $5`,
```

In `backend/src/index.js`, replace the admin re-roll insert at line 1732:

```js
              `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
```

and extend its parameter array with `r.level, r.damage` (match the existing variable name at that call site — it is the loop variable over `placeMapCreatures`'s rows).

- [ ] **Step 5: Verify the world row supplies the band**

`spawnChunkCreatures` reads `world.levelMin`/`world.levelMax`. The call at `server.js:364` builds its world object inline from `entry.row`, so add the two fields:

```js
          const spawned = spawnChunkCreatures(
            {
              seed: Number(entry.row.seed), chunkSize: N, tileTypes: entry.tileTypes,
              levelMin: entry.row.level_min, levelMax: entry.row.level_max,
            },
            cx, cy, entry.hostileCreatureTypes,
          );
```

Then confirm `entry.row` actually selects the new columns:

```bash
cd backend && grep -n "SELECT .* FROM worlds" src/authority/server.js | head -5
```

If the world load uses an explicit column list rather than `SELECT *`, add `level_min, level_max` to it. If it uses `SELECT *`, nothing to change. Do the same check for `src/index.js:1726`'s re-roll route, which builds its own world object for `placeMapCreatures`.

- [ ] **Step 6: Run the tests**

```bash
cd backend && node --test tests/creature_level_persistence.test.js && npm test 2>&1 | tail -8
```

Expected: the new file PASSES (3 tests); full suite 0 failures.

- [ ] **Step 7: Mutation check**

Revert each edit one at a time with `git diff`-guided hand edits, confirm RED, restore:

1. Drop `wc.level` from the `server.js` SELECT — the persistence test will not catch this (it does not touch the database), so instead confirm by hand that a spawned creature reports `level: 1` in the browser. **If nothing goes red, note it: this SELECT has no automated guard.** That is worth stating in the commit rather than pretending it is covered.
2. Change `c.damage ?? CREATURE_DAMAGE` back to `CREATURE_DAMAGE` — expect no test failure either, since the damage path is only exercised in combat integration tests. Add a targeted test if one does not already cover it.

- [ ] **Step 8: Commit**

```bash
git add backend/src/authority/server.js backend/src/index.js backend/src/authority/creatures.js backend/tests/creature_level_persistence.test.js
git commit -m "feat(levels): persist and load creature level and scaled damage (SOMET-241)

Level and damage are written at both insert sites -- the chunk spawn in
authority/server.js and the admin re-roll in index.js -- and read back in
the neighbourhood SELECT. That SELECT already carries a comment warning
that a dropped column loads as undefined and silently disables the feature
it feeds; level is exactly that kind of column.

Creature attack damage now reads the per-creature value instead of the
flat CREATURE_DAMAGE constant, falling back to it for rows written before
the migration. GUARD_DAMAGE is untouched: guards are structural, not wild
spawns, and scaling them is a balance change nobody asked for.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Show the level on the creature nameplate

**Files:**
- Modify: `frontend/src/games/something2/src/js/entities/CreatureManager.js:50`, `:61`
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js:619-625`
- Test: `frontend/src/games/something2/src/js/entities/__tests__/CreatureManager.level.test.js`

**Interfaces:**
- Consumes: snapshot rows carrying `level` from Task 4.
- Produces: creature entities carry `level`; `RenderSystem._drawEntity` draws it.

- [ ] **Step 1: Write the failing test**

`frontend/src/games/something2/src/js/entities/__tests__/CreatureManager.level.test.js`:

```js
import { describe, it, expect } from "vitest";
import { CreatureManager } from "../CreatureManager.js";

// vitest runs in a plain node environment here -- no DOM. These are
// pure-function tests over the snapshot mapping, not rendering tests.
describe("creature level", () => {
  it("carries level from the snapshot onto a newly seen creature", () => {
    const m = new CreatureManager({});
    m.applySnapshot([{ id: "a", type: "Wolf", x: 10, y: 10, facing: "S", hp: 21, maxHp: 21, level: 6, color: "#c00" }]);
    expect(m.creatures.get("a").level).toBe(6);
  });

  it("updates level on an already-known creature", () => {
    // Levels do not change in A1, but the update path must not silently drop
    // the field -- a creature re-sent after a chunk reload would lose its
    // label while keeping its scaled hp, which reads as a rendering bug.
    const m = new CreatureManager({});
    m.applySnapshot([{ id: "a", type: "Wolf", x: 10, y: 10, facing: "S", hp: 21, maxHp: 21, level: 6, color: "#c00" }]);
    m.applySnapshot([{ id: "a", type: "Wolf", x: 12, y: 10, facing: "E", hp: 18, maxHp: 21, level: 6, color: "#c00" }]);
    expect(m.creatures.get("a").level).toBe(6);
  });

  it("leaves level undefined when the server does not send one", () => {
    const m = new CreatureManager({});
    m.applySnapshot([{ id: "b", type: "Wolf", x: 0, y: 0, facing: "S", hp: 10, maxHp: 10, color: "#c00" }]);
    expect(m.creatures.get("b").level).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd frontend && npx vitest run src/games/something2/src/js/entities/__tests__/CreatureManager.level.test.js
```

Expected: FAIL — `level` is `undefined` in the first two cases.

- [ ] **Step 3: Map level through `CreatureManager`**

In `frontend/src/games/something2/src/js/entities/CreatureManager.js`, line 50 (the update branch), append:

```js
        ex.facing = c.facing; ex.hp = c.hp; ex.maxHp = c.maxHp; ex.mode = c.mode; ex.level = c.level;
```

Line 61 (the create branch), add `level: c.level,` to the object literal:

```js
          facing: c.facing || 'S', hp: c.hp, maxHp: c.maxHp, mode: c.mode, color: c.color,
          level: c.level,
```

- [ ] **Step 4: Draw the level in `RenderSystem`**

In `frontend/src/games/something2/src/js/systems/RenderSystem.js`, in `_drawEntity`, replace lines 619-625 with:

```js
    // HP bar for damaged actors. Map decorations never carry hp/maxHp, so
    // this only fires for creatures (which are rendered through this path
    // in renderChunked — see buildDrawables' "entity" kind).
    if (e.maxHp && e.hp != null && e.hp < e.maxHp) {
      this._drawHpBar(drawX, drawY, w, e.hp, e.maxHp);
    }
    // Level tag, above the sprite. Drawn for creatures only (decorations have
    // no level) and only above 1, so a starter world stays visually quiet.
    // Stroke-then-fill because the label sits over arbitrary terrain colours
    // and plain white text vanishes on snow.
    if (e.level > 1) {
      this.ctx.save();
      this.ctx.font = "bold 10px monospace";
      this.ctx.textAlign = "center";
      this.ctx.lineWidth = 3;
      this.ctx.strokeStyle = "rgba(0,0,0,0.85)";
      this.ctx.fillStyle = "#ffd166";
      const label = `L${e.level}`;
      const lx = drawX + w / 2;
      const ly = drawY - 4;
      this.ctx.strokeText(label, lx, ly);
      this.ctx.fillText(label, lx, ly);
      this.ctx.restore();
    }
    this._drawEffectPips(drawX, drawY, e.effects);
```

`save()`/`restore()` matter here: this repo has already shipped a canvas bug where a transform replaced rather than composed, and leaving `font`/`textAlign` set would leak into every later draw call in the frame.

- [ ] **Step 5: Run the tests**

```bash
cd frontend && npx vitest run src/games/something2/src/js/entities/ 2>&1 | tail -12
```

Expected: PASS, including the pre-existing `CreatureManager` tests.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/src/js/entities/CreatureManager.js frontend/src/games/something2/src/js/systems/RenderSystem.js frontend/src/games/something2/src/js/entities/__tests__/CreatureManager.level.test.js
git commit -m "feat(levels): show creature level on the nameplate (SOMET-241)

Only above level 1, so a starter world stays visually quiet. Stroked then
filled because the label sits over arbitrary terrain and plain text
vanishes on snow, and wrapped in save/restore so font and textAlign do not
leak into later draws this frame.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Author level bands in map specs

**Files:**
- Modify: `backend/seeds/mapSpec.js` (validation)
- Modify: `backend/scripts/seed-map.js:63-75` (the `worlds` upsert)
- Modify: `backend/seeds/maps/spine-descent.map.json` (demonstrate escalation)
- Modify: `.claude/skills/map-planner/SKILL.md`
- Test: `backend/tests/map_spec_validate.test.js` (extend), `backend/tests/map_spec_fixtures.test.js` (extend)

**Interfaces:**
- Consumes: `worlds.level_min`/`level_max` from Task 1.
- Produces: optional per-world `level_band: [min, max]` in the spec format.

- [ ] **Step 1: Write the failing validation tests**

Append to `backend/tests/map_spec_validate.test.js`:

```js
test('level_band must be a two-element array of integers', () => {
  const spec = specWith({ level_band: [3] });
  const errs = validateMapSpec(spec, CATALOG);
  assert.ok(errs.some((e) => /level_band/i.test(e)), errs.join('; '));
});

test('level_band rejects an inverted band', () => {
  // The database CHECK would also catch this, but only after clear-maps has
  // already destroyed every world -- reseed-map runs the clear first. Failing
  // in the validator means the spec is rejected before anything is deleted.
  const errs = validateMapSpec(specWith({ level_band: [9, 3] }), CATALOG);
  assert.ok(errs.some((e) => /level_band/i.test(e)), errs.join('; '));
});

test('level_band rejects a minimum below 1', () => {
  const errs = validateMapSpec(specWith({ level_band: [0, 4] }), CATALOG);
  assert.ok(errs.some((e) => /level_band/i.test(e)), errs.join('; '));
});

test('level_band accepts a valid band and a fixed band', () => {
  assert.deepEqual(validateMapSpec(specWith({ level_band: [2, 6] }), CATALOG), []);
  assert.deepEqual(validateMapSpec(specWith({ level_band: [4, 4] }), CATALOG), []);
});

test('level_band is optional', () => {
  assert.deepEqual(validateMapSpec(specWith({}), CATALOG), []);
});
```

Use the file's existing fixture helper for `specWith`/`CATALOG`. Read the top of `map_spec_validate.test.js` first and match its established shape rather than inventing a new one — if it has no `specWith`, build the minimal valid spec inline the way the neighbouring tests do.

- [ ] **Step 2: Run to verify they fail**

```bash
cd backend && node --test tests/map_spec_validate.test.js
```

Expected: FAIL — no `level_band` errors are produced.

- [ ] **Step 3: Add the validation**

In `backend/seeds/mapSpec.js`, inside the per-world loop (beside the `width`/`height` checks around line 78), add:

```js
    // Optional. Validated here as well as by worlds_level_band_check because
    // `make reseed-map` clears every world BEFORE seeding: a band rejected
    // only by the database would fail after the destruction, leaving the
    // developer with no maps at all.
    if (w.level_band !== undefined) {
      const b = w.level_band;
      if (!Array.isArray(b) || b.length !== 2
          || !Number.isInteger(b[0]) || !Number.isInteger(b[1])) {
        errors.push(`world "${w.key}" level_band must be [min, max] with integer values`);
      } else if (b[0] < 1) {
        errors.push(`world "${w.key}" level_band minimum must be at least 1`);
      } else if (b[1] < b[0]) {
        errors.push(`world "${w.key}" level_band maximum must be >= its minimum`);
      }
    }
```

- [ ] **Step 4: Apply the band in the seeder**

In `backend/scripts/seed-map.js`, extend the `worlds` upsert (lines 63-75) to carry the two columns. Add `level_min, level_max` to the column list, `$13,$14` to `VALUES`, and to the `DO UPDATE SET` clause:

```js
               level_min = EXCLUDED.level_min, level_max = EXCLUDED.level_max,
```

and append to the parameter array:

```js
         w.level_band ? w.level_band[0] : 1,
         w.level_band ? w.level_band[1] : 1,
```

- [ ] **Step 5: Give `spine-descent` real escalation**

`spine-descent` is the linear map, so it is the honest place to demonstrate a band. Edit `backend/seeds/maps/spine-descent.map.json` and add a `level_band` to each world that rises with depth — the entry world gets `[1, 2]`, and each subsequent world along the spine steps up, ending around `[9, 12]`. Leave `hub-vale` and `loop-catacombs` unbanded so the default path stays covered by the fixtures test.

- [ ] **Step 6: Assert the escalation in the fixtures test**

Append to `backend/tests/map_spec_fixtures.test.js`:

```js
test('spine-descent escalates its level bands with depth', () => {
  // The point of a spine is a difficulty ramp. Without this, a spec could
  // declare bands that wander or flatten and every other test would still be
  // green -- the same shape of hole that let a dangling creature reference
  // survive in biomes_seed.test.js.
  const spec = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, 'spine-descent.map.json'), 'utf8'));
  const banded = spec.worlds.filter((w) => w.level_band);
  assert.ok(banded.length >= 4, 'spine-descent should band most of its worlds');

  const dist = bfsDistances(spec);
  const sorted = [...banded].sort((a, b) => dist.get(a.key) - dist.get(b.key));
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i].level_band[0] >= sorted[i - 1].level_band[0],
      `${sorted[i].key} is deeper than ${sorted[i - 1].key} but its band starts lower`,
    );
  }
  assert.ok(sorted[sorted.length - 1].level_band[1] > sorted[0].level_band[1] * 2,
    'the deepest world should be meaningfully harder than the entry, not marginally');
});
```

`bfsDistances` already exists in that file — reuse it, do not write a second copy.

- [ ] **Step 7: Run all affected tests**

```bash
cd backend && node --test tests/map_spec_validate.test.js tests/map_spec_fixtures.test.js && npm test 2>&1 | tail -8
```

Expected: all PASS, full suite 0 failures.

- [ ] **Step 8: Document the band in the map-planner skill**

In `.claude/skills/map-planner/SKILL.md`, add `level_band` to the optional-fields list in the "Every world needs" bullet, and add a short subsection explaining that the band sets creature difficulty, that `[1,1]` (the default) scales nothing, and that a spine should escalate it with depth. Keep the existing tone — the file states facts about the format, not advice.

- [ ] **Step 9: Commit**

```bash
git add backend/seeds/mapSpec.js backend/scripts/seed-map.js backend/seeds/maps/spine-descent.map.json backend/tests/map_spec_validate.test.js backend/tests/map_spec_fixtures.test.js .claude/skills/map-planner/SKILL.md
git commit -m "feat(levels): author level bands in map specs (SOMET-241)

level_band is validated in mapSpec.js as well as by the database CHECK
because \`make reseed-map\` clears every world BEFORE seeding: a band
caught only by the database would fail after the destruction, leaving the
developer with no maps at all.

spine-descent now escalates with depth, and a test asserts the ramp is
monotonic and meaningful rather than wandering -- the same shape of hole
that let a dangling creature reference survive in biomes_seed.test.js.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end verification in the browser

**Files:** none — this task produces evidence, not code.

**Interfaces:**
- Consumes: everything from Tasks 1-6.

- [ ] **Step 1: Reseed with the banded spec**

```bash
cd /home/markunn/worker/coding/jsgame/something2
make list-maps
make reseed-map SPEC=spine-descent
```

Expected: the clear prompt names `spine-descent`, then catalogs and the map apply. Answer `yes` only if you intend to replace the current worlds.

- [ ] **Step 2: Confirm levels landed with a read-only query**

```bash
docker exec -i something2-db-1 psql -U user -d game_db -c \
  "SELECT w.name, w.level_min, w.level_max, count(wc.*) AS creatures,
          min(wc.level) AS min_lv, max(wc.level) AS max_lv, max(wc.damage) AS max_dmg
     FROM worlds w LEFT JOIN world_creatures wc ON wc.world_id = w.id
    GROUP BY w.name, w.level_min, w.level_max ORDER BY w.level_min;"
```

Expected: bands rise across the spine; every `min_lv`/`max_lv` sits inside its world's band; `max_dmg` exceeds 5 in the deeper worlds.

- [ ] **Step 3: Start the app and verify in the browser**

```bash
make dev && sleep 8 && make dev-status
```

Both must report `HTTP 200`. Then open `http://localhost:15173` in an isolated browser context, register or log in as a **non-admin** player (they auto-join the entry world), and confirm:

1. Creatures in the entry world show either no tag or `L2` — the entry band is `[1,2]`.
2. Walk to a deeper world through a doorway. Creatures there carry visibly higher tags.
3. The tag renders legibly over both grass and any pale terrain.
4. Attack a deep-world creature and take a hit: it should hurt more than an entry-world creature, and its HP bar should take proportionally longer to deplete.

- [ ] **Step 4: Confirm determinism across a chunk reload**

Walk far enough away that the creature's chunk unloads, then return. **The creature's level must be unchanged.** This is the single most important manual check in the plan: `world_chunks` is cached, and a level that re-rolls on reload would make creatures harden and soften as the player moves.

- [ ] **Step 5: Record the evidence on SOMET-241**

Post a comment on the work item with: the query output from Step 2, the `make dev-status` result, screenshots of an entry-world and a deep-world creature showing their tags, and the result of the Step 4 reload check. Then move it to review.

---

## Self-Review

**Spec coverage.** A1's five acceptance criteria from SOMET-241 map to: deterministic per-world-band roll → Task 3 (both paths, with a determinism test); single pure `scaleCreature`, server-side only → Task 2; resistances stay flat → Task 2 (asserted); level on the nameplate → Task 5; `validateMapSpec` rejects an inverted band → Task 6.

**Three spec corrections are folded in** and called out at the top: two spawn paths rather than one, creature damage being a constant rather than a column, and guards being out of scope.

**Known gap, stated rather than hidden.** Task 4 Step 7 establishes that the `server.js` creature SELECT and the per-creature damage read have **no automated regression guard** — both are only exercised end-to-end. Task 7 Steps 3-4 are the compensating control. This is a real weakness in the plan, not an oversight; closing it properly needs a database-backed authority test, which this repo does not currently have a pattern for.

**Type consistency.** `rollCreatureLevel(unit, levelMin, levelMax)` and `scaleCreature({hp, damage, defense}, level)` are used with those exact signatures in Tasks 3 and 4. Spawn rows carry `{type, x, y, hp, damage, level, facing, defense, resistances}` in Task 3 and are consumed under those names in Task 4. The world config reads `world.levelMin`/`world.levelMax` (camelCase, matching `worldConfig`'s existing style) while the database columns are `level_min`/`level_max` — Task 4 Step 5 is where the two meet, and it is explicit about the mapping.
