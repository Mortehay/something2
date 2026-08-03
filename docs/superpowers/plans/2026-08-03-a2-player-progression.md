# A2 — Player Progression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give players XP, levels, six stats that each drive a real mechanic, a gold-cost respec, a death penalty, and an in-game character sheet.

**Architecture:** A `player_progression` row per user. One pure module (`playerStats.js`) turns that row into a `{maxHp, maxMana, meleeMult, spellMult, cooldownMult, manaRegen, priceMult}` bundle; one DB module (`progressionStore.js`) owns every write. The authority attaches the bundle to the live player object on join and re-derives it only on level-up, allocation or respec. Every consumer reads the bundle — nothing else reads the raw stat columns.

**Tech Stack:** Node/Express, `node-pg-migrate`, `pg`, `node:test` (backend, CommonJS); React + styled-components, vitest in a plain node environment (frontend, ESM).

Spec: `docs/superpowers/specs/2026-08-03-progression-dungeons-loot-design.md` (§ A2). Plane: SOMET-242.

## Survey corrections to the spec

The spec's seam references were written before A1 landed and three of them are wrong. **These corrections govern; where this plan and the spec disagree, this plan is right.**

1. **Mana regen already exists.** `PLAYER_MANA_REGEN = 10` (`world.js:19`) is applied every tick at `world.js:182`. The spec's claim that "a caster currently runs permanently dry until death" is false — verified by `git log -L 175,190:backend/src/authority/world.js`, where the line predates 2026-07-20. WIS therefore **scales an existing constant** rather than introducing a new tick. This removes one of the spec's two stated hazards.
2. **Damage has three write sites, not two.** `world.js:278` (melee vs creatures) and `:285` (melee vs players) are the two the spec names; the third is the projectile path, where `projectiles.js:33` copies `weapon.damage` into the projectile at spawn and applies it at `:65`, `:82`, `:139`, `:161`. A STR/INT multiplier applied only to the melee branch would leave **every ranged and magic weapon unscaled** — and magic weapons are exactly the INT case. This is the more dangerous version of the hazard the spec flagged for DEX.
3. **Kills carry no killer today.** `commitCreatureDeath(pool, entry, creatureId, opts)` (`authority/loot.js:47`) takes no user, and all four kill sites call it fire-and-forget. Kill XP needs attribution plumbed through first — Task 5 does nothing but that.

One finding is favourable and shapes Task 4:

4. **Idempotency is already solved.** `commitCreatureDeath` is built on `DELETE FROM world_creatures WHERE id = $1 RETURNING …` with `if (r.rowCount !== 1) return;`, documented as "the single authoritative creature-death commit". Awarding XP **after** that gate satisfies AC8 by construction. Do not invent a second idempotency mechanism.
5. **The client has no HP/mana constants.** `Game.js:461,479` read `maxHp`/`maxMana` straight off the snapshot, so CON and INT reach the HUD with nothing to keep in sync. This is not another `resolveMove` two-copy situation.

## Global Constraints

- **Never mutate the shared dev database.** No `DELETE`, `TRUNCATE`, `DROP`, or unscoped `UPDATE` against the compose Postgres. Never run `make clear-maps`, `make reseed-map`, `make seed-map`, `make seed-catalogs`, or `make nuke`. Never run `npm test` with `TEST_DATABASE_URL` set.
- **Migration timestamps:** A1 consumed through `1714440051000`. This plan reserves **`1714440052000`** and uses no other.
- **Base stat value is 5, and every formula is an identity at 5.** A fresh character must reproduce today's numbers exactly: `maxHp` 100, `maxMana` 100, `manaRegen` 10/s, damage ×1.0, cooldown ×1.0, sell fraction 0.5. This is the regression-safety property of the whole slice and every task's tests must preserve it.
- **XP balance is explicitly out of scope.** Every tunable lives in `progressionConstants.js` and is documented as provisional. Do not tune.
- **Tests use literal expected values, never a recomputation of the formula under test.** This repo has shipped fifteen vacuous tests; the dominant shape is an assertion derived from the same constants as the code. `assert.equal(derive({...con: 7}).maxHp, 120)` — never `HP_BASE + HP_PER_CON * 2`.
- **Every task ends with a mutation check:** break the thing the new test guards, confirm RED, restore. Report the mutation and its result in the task report.
- Backend is CommonJS + `node:test`; frontend is ESM + vitest in a **node** environment (no DOM, no RTL). Frontend UI gets pure-function and source-text tests.
- Commit convention: `type(scope): summary (SOMET-242)`, ending with the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

## File Structure

**Create**
| File | Responsibility |
|---|---|
| `backend/migrations/1714440052000_player_progression.js` | the table, its constraints, backfill for existing users |
| `backend/src/services/progressionConstants.js` | every tunable, in one place, documented provisional |
| `backend/src/services/playerStats.js` | pure: derive stats, XP curve, kill XP, death penalty, respec refund |
| `backend/src/services/progressionStore.js` | all DB reads/writes for progression |
| `backend/src/api/progressionRoutes.js` | `GET /api/progression`, `POST /api/progression/allocate`, `POST /api/progression/respec` |
| `frontend/src/games/something2/CharacterSheet.jsx` | the in-game sheet |
| `frontend/src/games/something2/src/js/net/progressionClient.js` | fetch/allocate/respec calls |
| `backend/tests/player_stats.test.js`, `progression_store.test.js`, `progression_routes.test.js`, `progression_kill_xp.test.js`, `progression_migration.test.js` | per-task suites |
| `frontend/src/games/something2/src/js/__tests__/characterSheet.test.js` | pure + source-text tests |

**Modify**
| File | Change |
|---|---|
| `backend/src/authority/world.js` | `addPlayer` takes stats; `applyDerivedStats`; `weaponDamage`; `applyAttackCooldown`; regen reads `p.stats`; `resolveDeaths` reports deaths |
| `backend/src/authority/projectiles.js` | carry a damage override and a killer id |
| `backend/src/authority/effects.js` | `stepEffects` hands the callback the effect's `sourceId` |
| `backend/src/authority/creatures.js` | melee-arc/contact kills report their killer |
| `backend/src/authority/loot.js` | `commitCreatureDeath` takes `killerUserId`, returns the dead creature's level |
| `backend/src/authority/server.js` | load progression on join; route kills and deaths to the store; push `progression` messages |
| `backend/src/services/merchantStock.js` | `sellPriceFor(value, priceMult)` |
| `backend/src/index.js` | mount `progressionRoutes` |
| `frontend/src/games/something2/GameView.jsx` | render + toggle the sheet |
| `frontend/src/games/something2/src/js/core/Game.js` | keep `progression` from the socket |

---

### Task 1: The table, the constants, the migration

**Files:**
- Create: `backend/migrations/1714440052000_player_progression.js`
- Create: `backend/src/services/progressionConstants.js`
- Test: `backend/tests/progression_migration.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: table `player_progression`; `progressionConstants.js` exporting `BASE_STAT`, `STAT_KEYS`, `MAX_LEVEL`, `STAT_POINTS_PER_LEVEL`, `HP_BASE`, `HP_PER_CON`, `MANA_BASE`, `MANA_PER_INT`, `MELEE_PER_STR`, `SPELL_PER_INT`, `HASTE_PER_DEX`, `MIN_COOLDOWN_MULT`, `MANA_REGEN_BASE`, `MANA_REGEN_PER_WIS`, `PRICE_PER_CHA`, `SELL_FRACTION_BASE`, `SELL_FRACTION_MAX`, `XP_BASE`, `XP_KILL_BASE`, `XP_LEVEL_DIFF_SLOPE`, `XP_LEVEL_DIFF_MAX`, `DEATH_PENALTY`, `RESPEC_BASE`.

- [ ] **Step 1: Write the constants module**

`backend/src/services/progressionConstants.js`:

```js
// Every player-progression tunable, in one file.
//
// PROVISIONAL BY CONSTRUCTION. The design chose three XP sources -- kills,
// chests and dungeon clears -- and only kills exist in this slice. Tuning a
// curve against one third of its inputs guarantees retuning once B (chests)
// and C (dungeons) land, so these are first numbers, not balanced ones, and
// XP balance is explicitly out of scope for A2.
//
// The one property that is NOT provisional: every formula in playerStats.js
// is an identity at BASE_STAT. A fresh character must reproduce the game's
// pre-A2 numbers exactly -- 100 hp, 100 mana, 10 mana/s, x1.0 damage, x1.0
// cooldown, 0.5 sell fraction. Change a growth rate freely; never change a
// base such that a level-1 character's numbers move.

const BASE_STAT = 5;
const STAT_KEYS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
const MAX_LEVEL = 50;
const STAT_POINTS_PER_LEVEL = 3;

// CON -> max hp. Base matches PLAYER_MAX_HP (authority/world.js:17).
const HP_BASE = 100;
const HP_PER_CON = 10;

// INT -> max mana. Base matches PLAYER_MAX_MANA (authority/world.js:18).
const MANA_BASE = 100;
const MANA_PER_INT = 10;

// STR -> physical damage, INT -> every other element. The split is the
// weapon's existing `element` column; no new field.
const MELEE_PER_STR = 0.05;
const SPELL_PER_INT = 0.05;

// DEX -> attack speed, as a cooldown MULTIPLIER (lower is faster). The floor
// exists because the multiplier is 1/(1+k*n): without it a high enough DEX
// approaches a zero cooldown, i.e. an unbounded attack rate.
const HASTE_PER_DEX = 0.03;
const MIN_COOLDOWN_MULT = 0.4;

// WIS -> mana regen. Base matches PLAYER_MANA_REGEN (authority/world.js:19).
// Contrary to the design doc, mana regen ALREADY EXISTS -- WIS scales a live
// constant here, it does not introduce a new tick.
const MANA_REGEN_BASE = 10;
const MANA_REGEN_PER_WIS = 0.5;

// CHA -> merchant sell price. SELL_FRACTION_BASE matches merchantStock.js's
// existing SELL_FRACTION.
//
// SELL_FRACTION_MAX is a SAFETY bound, not a balance knob. The village base
// catalog sells items at `value` and buys them back at `value * fraction`.
// A fraction >= 1.0 makes buy-then-sell a money printer against an infinite,
// never-expiring catalog. Keep this strictly below 1.0 forever.
const PRICE_PER_CHA = 0.02;
const SELL_FRACTION_BASE = 0.5;
const SELL_FRACTION_MAX = 0.9;

// XP curve. xpToNext(level) = XP_BASE * level, so the cumulative floor is
// XP_BASE * (level-1) * level / 2: 0, 100, 300, 600, 1000, ...
const XP_BASE = 100;

// Kill XP scales with the creature's A1 level RELATIVE to the player's, so
// farming trivial creatures decays to literally zero (diff <= -5).
const XP_KILL_BASE = 10;
const XP_LEVEL_DIFF_SLOPE = 0.2;
const XP_LEVEL_DIFF_MAX = 2;

// Death costs a quarter of the progress made INTO the current level, so a
// player can lose a level's worth of grinding but never a level.
const DEATH_PENALTY = 0.25;

// Respec cost in gold: RESPEC_BASE * level.
const RESPEC_BASE = 50;

module.exports = {
  BASE_STAT, STAT_KEYS, MAX_LEVEL, STAT_POINTS_PER_LEVEL,
  HP_BASE, HP_PER_CON, MANA_BASE, MANA_PER_INT,
  MELEE_PER_STR, SPELL_PER_INT, HASTE_PER_DEX, MIN_COOLDOWN_MULT,
  MANA_REGEN_BASE, MANA_REGEN_PER_WIS,
  PRICE_PER_CHA, SELL_FRACTION_BASE, SELL_FRACTION_MAX,
  XP_BASE, XP_KILL_BASE, XP_LEVEL_DIFF_SLOPE, XP_LEVEL_DIFF_MAX,
  DEATH_PENALTY, RESPEC_BASE,
};
```

- [ ] **Step 2: Write the migration**

`backend/migrations/1714440052000_player_progression.js`:

```js
exports.shorthands = undefined;

// Its own table rather than nine more columns on `users`. users.gold sets a
// precedent for game state on the auth row, but XP + level + points + six
// stats is a different order of magnitude, and the authority already joins
// per-user rows on join for equipment.
exports.up = (pgm) => {
  pgm.createTable('player_progression', {
    user_id: {
      type: 'integer',
      primaryKey: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    experience: { type: 'bigint', notNull: true, default: 0 },
    level: { type: 'integer', notNull: true, default: 1 },
    stat_points: { type: 'integer', notNull: true, default: 0 },
    strength: { type: 'integer', notNull: true, default: 5 },
    dexterity: { type: 'integer', notNull: true, default: 5 },
    constitution: { type: 'integer', notNull: true, default: 5 },
    intelligence: { type: 'integer', notNull: true, default: 5 },
    wisdom: { type: 'integer', notNull: true, default: 5 },
    charisma: { type: 'integer', notNull: true, default: 5 },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Database-level floors. The service layer enforces these too, but a
  // constraint is what makes a bad UPDATE fail loudly instead of leaving a
  // character with negative XP or -3 strength that every later read trusts.
  pgm.addConstraint('player_progression', 'player_progression_experience_check',
    'CHECK (experience >= 0)');
  pgm.addConstraint('player_progression', 'player_progression_level_check',
    'CHECK (level >= 1 AND level <= 50)');
  pgm.addConstraint('player_progression', 'player_progression_points_check',
    'CHECK (stat_points >= 0)');
  // Stats can never drop below the base -- a respec resets TO the base, and
  // nothing else lowers them.
  pgm.addConstraint('player_progression', 'player_progression_stats_check',
    `CHECK (strength >= 5 AND dexterity >= 5 AND constitution >= 5
            AND intelligence >= 5 AND wisdom >= 5 AND charisma >= 5)`);

  // Backfill: every existing account gets a level-1 row, so no code path has
  // to distinguish "old account" from "new account". Accounts created after
  // this migration are covered by progressionStore.loadProgression's
  // ON CONFLICT DO NOTHING insert, not by the registration route -- one lazy
  // path serves every way a user can come into existence.
  pgm.sql(`INSERT INTO player_progression (user_id)
           SELECT id FROM users
           ON CONFLICT (user_id) DO NOTHING`);
};

exports.down = (pgm) => {
  pgm.dropTable('player_progression');
};
```

- [ ] **Step 3: Write the failing schema test**

`backend/tests/progression_migration.test.js`. This is a **real-database** test — the vacuous-test note in `backend/tests/catalog_seed_data.test.js` and the project memory both record that a schema invariant checked against a hand-typed fixture defends the fixture, not the schema. Follow the skip-if-unreachable pattern already used by the other DB-backed suites in this directory (read one before writing this, and copy its connection + skip idiom exactly).

```js
const test = require('node:test');
const assert = require('node:assert');
// ... connection + skipIfUnreachable idiom copied from the sibling DB suite ...

test('player_progression columns have the documented types and defaults', async (t) => {
  const { rows } = await client.query(
    `SELECT column_name, data_type, column_default, is_nullable
       FROM information_schema.columns
      WHERE table_name = 'player_progression'`,
  );
  const by = new Map(rows.map((r) => [r.column_name, r]));

  // Exact equality, never a regex. `assert.match(column_default, /1/)` also
  // matches 15, 100 and 1000 -- that exact hole shipped in A1's task 1.
  assert.equal(by.get('experience').data_type, 'bigint');
  assert.equal(by.get('experience').column_default, '0');
  assert.equal(by.get('level').column_default, '1');
  assert.equal(by.get('stat_points').column_default, '0');
  for (const s of ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']) {
    assert.equal(by.get(s).data_type, 'integer', `${s} must be integer`);
    assert.equal(by.get(s).column_default, '5', `${s} must default to the base stat`);
    assert.equal(by.get(s).is_nullable, 'NO', `${s} must be NOT NULL`);
  }
});

test('the CHECK constraints actually reject bad rows', async (t) => {
  // A constraint test that only reads information_schema proves the
  // constraint EXISTS, not that it BITES. Insert into a rolled-back
  // transaction and require the failure.
  for (const [label, sql] of [
    ['negative experience', 'UPDATE player_progression SET experience = -1 WHERE user_id = $1'],
    ['level 0',            'UPDATE player_progression SET level = 0 WHERE user_id = $1'],
    ['level 51',           'UPDATE player_progression SET level = 51 WHERE user_id = $1'],
    ['negative points',    'UPDATE player_progression SET stat_points = -1 WHERE user_id = $1'],
    ['sub-base strength',  'UPDATE player_progression SET strength = 4 WHERE user_id = $1'],
  ]) {
    await client.query('BEGIN');
    await assert.rejects(() => client.query(sql, [testUserId]), `${label} must be rejected`);
    await client.query('ROLLBACK');
  }
});

test('every existing user was backfilled', async () => {
  const { rows } = await client.query(
    `SELECT count(*)::int AS missing
       FROM users u LEFT JOIN player_progression p ON p.user_id = u.id
      WHERE p.user_id IS NULL`,
  );
  assert.equal(rows[0].missing, 0);
});
```

The test user must be created **inside a transaction that is rolled back**, or borrowed read-only from existing rows. Do not insert or delete rows that outlive the test.

- [ ] **Step 4: Run the migration and the test**

```bash
cd backend && npm run migrate:up && npx node --test tests/progression_migration.test.js
```
Expected: migration applies; tests pass.

- [ ] **Step 5: Verify the down migration**

```bash
cd backend && npm run migrate:down && npm run migrate:up
```
Expected: both directions clean. A1's review found a plan that never exercised `down`; this step is not optional.

- [ ] **Step 6: Mutation check**

Temporarily change the `strength` default to `4` in the migration, re-run down+up, confirm the column-default test goes RED. Restore, re-run, confirm GREEN. Report both.

- [ ] **Step 7: Commit**

```bash
git add backend/migrations/1714440052000_player_progression.js backend/src/services/progressionConstants.js backend/tests/progression_migration.test.js
git commit -m "feat(progression): add player_progression and the tunables module (SOMET-242)"
```

---

### Task 2: `playerStats.js` — the pure maths

**Files:**
- Create: `backend/src/services/playerStats.js`
- Test: `backend/tests/player_stats.test.js`

**Interfaces:**
- Consumes: `progressionConstants.js` (Task 1).
- Produces:
  - `derivePlayerStats(progression) -> {maxHp, maxMana, meleeMult, spellMult, cooldownMult, manaRegen, priceMult}`
  - `xpFloor(level) -> number` — cumulative XP at which `level` begins
  - `xpToNext(level) -> number` — XP needed to go from `level` to `level+1`
  - `levelForXp(experience) -> number`
  - `xpForKill(creatureLevel, playerLevel) -> number`
  - `applyDeathPenalty(experience, level) -> {experience, lost}`
  - `refundedPoints(progression) -> number`
  - `DEFAULT_PROGRESSION` — a frozen level-1 row, so callers never hand-build one

- [ ] **Step 1: Write the failing tests, with literal expectations only**

`backend/tests/player_stats.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const {
  derivePlayerStats, xpFloor, xpToNext, levelForXp, xpForKill,
  applyDeathPenalty, refundedPoints, DEFAULT_PROGRESSION,
} = require('../src/services/playerStats.js');

const at = (over) => ({ ...DEFAULT_PROGRESSION, ...over });

// THE regression-safety test for the whole slice: a fresh character must
// reproduce the game's pre-A2 numbers exactly. Every number below is the
// literal the pre-A2 code used -- 100 from PLAYER_MAX_HP, 100 from
// PLAYER_MAX_MANA, 10 from PLAYER_MANA_REGEN, 0.5 from SELL_FRACTION.
test('a base character reproduces the pre-A2 numbers exactly', () => {
  const s = derivePlayerStats(DEFAULT_PROGRESSION);
  assert.equal(s.maxHp, 100);
  assert.equal(s.maxMana, 100);
  assert.equal(s.meleeMult, 1);
  assert.equal(s.spellMult, 1);
  assert.equal(s.cooldownMult, 1);
  assert.equal(s.manaRegen, 10);
  assert.equal(s.priceMult, 0.5);
});

test('each stat moves its own output and nothing else', () => {
  assert.equal(derivePlayerStats(at({ constitution: 7 })).maxHp, 120);
  assert.equal(derivePlayerStats(at({ constitution: 7 })).maxMana, 100);
  assert.equal(derivePlayerStats(at({ intelligence: 8 })).maxMana, 130);
  assert.equal(derivePlayerStats(at({ strength: 15 })).meleeMult, 1.5);
  assert.equal(derivePlayerStats(at({ strength: 15 })).spellMult, 1);
  assert.equal(derivePlayerStats(at({ intelligence: 15 })).spellMult, 1.5);
  assert.equal(derivePlayerStats(at({ wisdom: 25 })).manaRegen, 20);
  assert.equal(derivePlayerStats(at({ charisma: 15 })).priceMult, 0.7);
});

test('DEX shortens the cooldown and can never reach zero', () => {
  // 1 / (1 + 0.03 * 5) = 0.8695652... -> 0.8696 at 4dp
  assert.equal(derivePlayerStats(at({ dexterity: 10 })).cooldownMult, 0.8696);
  // The floor: an absurd DEX still cannot exceed the clamp.
  assert.equal(derivePlayerStats(at({ dexterity: 999 })).cooldownMult, 0.4);
});

// The money-printer guard. The village base catalog sells at `value` and buys
// back at `value * priceMult`; a priceMult >= 1 turns that into infinite gold.
test('the sell fraction is capped strictly below 1.0 at any charisma', () => {
  assert.equal(derivePlayerStats(at({ charisma: 999 })).priceMult, 0.9);
  assert.ok(derivePlayerStats(at({ charisma: 999 })).priceMult < 1,
    'a sell fraction of 1.0 or more is a buy-low-sell-high money printer');
});

test('a malformed progression falls back to base rather than NaN', () => {
  const s = derivePlayerStats({});
  assert.equal(s.maxHp, 100);
  assert.equal(s.priceMult, 0.5);
  assert.equal(derivePlayerStats(null).maxHp, 100);
  assert.equal(derivePlayerStats({ constitution: 'seven' }).maxHp, 100);
});

test('the XP curve has the documented floors', () => {
  assert.equal(xpFloor(1), 0);
  assert.equal(xpFloor(2), 100);
  assert.equal(xpFloor(3), 300);
  assert.equal(xpFloor(4), 600);
  assert.equal(xpFloor(5), 1000);
  assert.equal(xpToNext(1), 100);
  assert.equal(xpToNext(4), 400);
});

test('levelForXp inverts the curve exactly at the boundaries', () => {
  assert.equal(levelForXp(0), 1);
  assert.equal(levelForXp(99), 1);
  assert.equal(levelForXp(100), 2);   // exactly on the boundary
  assert.equal(levelForXp(299), 2);
  assert.equal(levelForXp(300), 3);
  assert.equal(levelForXp(999999999), 50); // clamped at MAX_LEVEL
});

test('kill XP rewards a harder creature and decays to zero on a trivial one', () => {
  assert.equal(xpForKill(1, 1), 10);
  assert.equal(xpForKill(5, 1), 90);
  assert.equal(xpForKill(12, 1), 240);  // clamped at XP_LEVEL_DIFF_MAX
  assert.equal(xpForKill(1, 6), 0);     // diff -5: exactly zero
  assert.equal(xpForKill(1, 10), 0);    // never negative
});

test('death costs progress into the level and never de-levels', () => {
  assert.deepEqual(applyDeathPenalty(500, 3), { experience: 450, lost: 50 });
  // Exactly at the floor there is nothing to lose.
  assert.deepEqual(applyDeathPenalty(300, 3), { experience: 300, lost: 0 });
  // The invariant, stated directly: for every level and every XP inside it,
  // the result never falls below the level's floor.
  for (let level = 1; level <= 50; level++) {
    for (const offset of [0, 1, 7, 50, 999]) {
      const xp = xpFloor(level) + offset;
      const out = applyDeathPenalty(xp, level);
      assert.ok(out.experience >= xpFloor(level),
        `level ${level} +${offset} de-levelled: ${out.experience} < ${xpFloor(level)}`);
    }
  }
});

test('refundedPoints returns every point ever spent', () => {
  assert.equal(refundedPoints(DEFAULT_PROGRESSION), 0);
  assert.equal(refundedPoints(at({ strength: 10, wisdom: 8 })), 8);
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd backend && npx node --test tests/player_stats.test.js
```
Expected: FAIL — `Cannot find module '../src/services/playerStats.js'`.

- [ ] **Step 3: Implement**

`backend/src/services/playerStats.js`:

```js
// Player progression maths. PURE -- no database, no clock, no randomness.
//
// Every consumer of progression reads derivePlayerStats' bundle. Nothing
// outside this module and progressionStore.js reads the raw stat columns;
// that is what keeps six stats from becoming six scattered formulas.

const C = require('./progressionConstants.js');

const DEFAULT_PROGRESSION = Object.freeze({
  experience: 0,
  level: 1,
  stat_points: 0,
  strength: C.BASE_STAT,
  dexterity: C.BASE_STAT,
  constitution: C.BASE_STAT,
  intelligence: C.BASE_STAT,
  wisdom: C.BASE_STAT,
  charisma: C.BASE_STAT,
});

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Round to 4dp without floating-point noise. cooldownMult is a reciprocal and
// 1/(1+0.03*5) is 0.8695652173913044 -- an unrounded multiplier would make
// every cooldown assertion a float-tolerance argument.
function round4(n) { return Math.round(n * 10000) / 10000; }

// A stat column that is missing, null, or not a finite number falls back to
// the base rather than poisoning every derived value with NaN. Progression
// rows come from the database, and a NaN maxHp is an unkillable or
// instantly-dead player -- fail soft, in the direction of "as if level 1".
function stat(progression, key) {
  const v = progression == null ? undefined : progression[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= C.BASE_STAT ? n : C.BASE_STAT;
}

// The single source of every number a stat affects.
function derivePlayerStats(progression) {
  const above = (key) => stat(progression, key) - C.BASE_STAT;
  return {
    maxHp: C.HP_BASE + C.HP_PER_CON * above('constitution'),
    maxMana: C.MANA_BASE + C.MANA_PER_INT * above('intelligence'),
    meleeMult: round4(1 + C.MELEE_PER_STR * above('strength')),
    spellMult: round4(1 + C.SPELL_PER_INT * above('intelligence')),
    // Lower is faster. Floored so attack rate stays bounded.
    cooldownMult: Math.max(
      C.MIN_COOLDOWN_MULT,
      round4(1 / (1 + C.HASTE_PER_DEX * above('dexterity'))),
    ),
    manaRegen: round4(C.MANA_REGEN_BASE + C.MANA_REGEN_PER_WIS * above('wisdom')),
    // The fraction of an item's value a merchant pays. Capped strictly below
    // 1.0: see SELL_FRACTION_MAX in progressionConstants.js -- this is a
    // safety bound against an infinite-gold loop, not a balance knob.
    priceMult: Math.min(
      C.SELL_FRACTION_MAX,
      round4(C.SELL_FRACTION_BASE + C.PRICE_PER_CHA * above('charisma')),
    ),
  };
}

// Cumulative XP at which `level` begins. xpToNext is XP_BASE * level, so the
// floor is the triangular sum XP_BASE * (level-1) * level / 2.
function xpFloor(level) {
  const l = clamp(Math.floor(Number(level) || 1), 1, C.MAX_LEVEL);
  return (C.XP_BASE * (l - 1) * l) / 2;
}

function xpToNext(level) {
  const l = clamp(Math.floor(Number(level) || 1), 1, C.MAX_LEVEL);
  return l >= C.MAX_LEVEL ? Infinity : C.XP_BASE * l;
}

// Inverted by stepping, not by the quadratic formula. The closed form needs a
// sqrt, and a float sqrt lands on the wrong side of an exact boundary (xp
// 300 must be level 3, not level 2). MAX_LEVEL bounds this at 50 iterations.
function levelForXp(experience) {
  const xp = Math.max(0, Number(experience) || 0);
  let level = 1;
  while (level < C.MAX_LEVEL && xp >= xpFloor(level + 1)) level++;
  return level;
}

// XP for a kill, scaled by the creature's A1 level relative to the player's.
// The clamp's lower bound is 0, so a high-level player farming level-1 slimes
// earns literally nothing rather than a token trickle.
function xpForKill(creatureLevel, playerLevel) {
  const cl = Math.max(1, Math.floor(Number(creatureLevel) || 1));
  const pl = Math.max(1, Math.floor(Number(playerLevel) || 1));
  const factor = clamp(1 + C.XP_LEVEL_DIFF_SLOPE * (cl - pl), 0, C.XP_LEVEL_DIFF_MAX);
  return Math.max(0, Math.round(C.XP_KILL_BASE * cl * factor));
}

// Lose a fraction of the progress made INTO the current level. Because the
// loss is computed from the progress above the floor, it can never cross it:
// a player loses a level's worth of grinding but never a level.
function applyDeathPenalty(experience, level) {
  const floor = xpFloor(level);
  const xp = Math.max(floor, Number(experience) || 0);
  const lost = Math.floor(C.DEATH_PENALTY * (xp - floor));
  return { experience: xp - lost, lost };
}

// Every point ever spent above the base, across all six stats.
function refundedPoints(progression) {
  return C.STAT_KEYS.reduce((sum, k) => sum + (stat(progression, k) - C.BASE_STAT), 0);
}

module.exports = {
  derivePlayerStats, xpFloor, xpToNext, levelForXp, xpForKill,
  applyDeathPenalty, refundedPoints, DEFAULT_PROGRESSION,
};
```

- [ ] **Step 4: Run the tests**

```bash
cd backend && npx node --test tests/player_stats.test.js
```
Expected: PASS.

- [ ] **Step 5: Mutation check**

Run all four and report each:
1. Delete the `Math.min(C.SELL_FRACTION_MAX, …)` wrapper → the money-printer test must go RED.
2. Change `levelForXp`'s `xp >= xpFloor(level + 1)` to `>` → the `levelForXp(100) === 2` boundary case must go RED.
3. Change `applyDeathPenalty`'s `xp - floor` to `xp` → the de-level invariant must go RED.
4. Change `xpForKill`'s clamp lower bound from `0` to `0.1` → the `xpForKill(1, 10) === 0` case must go RED.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/playerStats.js backend/tests/player_stats.test.js
git commit -m "feat(progression): pure stat, XP and death-penalty maths (SOMET-242)"
```

---

### Task 3: `progressionStore.js` — every write, transactional

**Files:**
- Create: `backend/src/services/progressionStore.js`
- Test: `backend/tests/progression_store.test.js`

**Interfaces:**
- Consumes: `playerStats.js`, `progressionConstants.js`.
- Produces:
  - `loadProgression(db, userId) -> row` (creates the row if absent)
  - `awardXp(db, userId, amount, source) -> {progression, leveledUp, newLevel, pointsGained, awarded}`
  - `allocateStat(pool, userId, statKey, count) -> {ok, reason?, progression?}`
  - `respec(pool, userId) -> {ok, reason?, progression?, gold?, cost?}`
  - `applyDeath(pool, userId) -> {progression, lost}`
  - `XP_SOURCES = ['kill', 'chest', 'dungeon_clear']`

**Notes for the implementer:**
- `db` is either the pool or a checked-out client — `awardXp` must be callable **inside** the caller's transaction (the kill path in Task 6 runs inside one). `allocateStat` and `respec` open their own transaction and therefore take the pool.
- `chest` and `dungeon_clear` are accepted and unused. They are the seam B and C plug into; an unknown source is rejected so a typo cannot silently award XP under a bogus label.

- [ ] **Step 1: Write the failing tests**

`backend/tests/progression_store.test.js`, real-database, same skip-if-unreachable idiom as Task 1. **Every test creates its user inside a transaction it rolls back.** Do not touch rows belonging to real accounts.

Required cases:

```js
test('loadProgression creates a base row on first call and is idempotent', ...);
//   two calls -> identical row, exactly one row in the table

test('awardXp levels up and grants the documented points', async () => {
  // from level 1 / 0 xp, +250 xp -> level 2 (floor 100), not level 3 (floor 300)
  const r = await awardXp(client, userId, 250, 'kill');
  assert.equal(r.leveledUp, true);
  assert.equal(r.newLevel, 2);
  assert.equal(r.pointsGained, 3);
  // A NUMBER, not a string: experience is bigint and node-postgres returns
  // bigint as a string, but mapRow normalises it once at the boundary so no
  // caller can accidentally compute "0" + 10 === "010".
  assert.equal(r.progression.experience, 250);
});

test('awardXp can cross more than one level at once', async () => {
  // +600 from scratch -> level 4, 9 points (3 levels x 3)
});

test('awardXp rejects an unknown source and writes nothing', async () => {
  const before = await loadProgression(client, userId);
  const r = await awardXp(client, userId, 100, 'nonsense');
  assert.equal(r.awarded, 0);
  const after = await loadProgression(client, userId);
  assert.equal(after.experience, before.experience);
});

test('awardXp ignores a non-positive amount', ...);

test('allocateStat spends points atomically', async () => {
  // give 3 points, then fire TWO allocations of 2 CONCURRENTLY (Promise.all
  // on two separate clients -- NOT awaited one after the other; a sequential
  // pair passes even with no atomicity at all, which is vacuous-test shape #1
  // in this repo's history).
  const [a, b] = await Promise.all([
    allocateStat(pool, userId, 'strength', 2),
    allocateStat(pool, userId, 'strength', 2),
  ]);
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1, 'exactly one must win');
  const after = await loadProgression(pool, userId);
  assert.equal(after.stat_points, 1);
  assert.equal(after.strength, 7);
});

test('allocateStat refuses an unknown stat key', ...);   // must not be SQL-interpolated
test('allocateStat refuses a non-positive or non-integer count', ...);

// Setup for both respec tests: a level-4 character (9 points granted) who has
// spent 5 of them into strength, leaving stat_points 4 and strength 10.
// Cost is RESPEC_BASE * 4 = 200.
test('respec moves the gold and resets the stats in one transaction', async () => {
  // ...seed level 4, strength 10, stat_points 4, gold 250...
  const r = await respec(pool, userId);
  assert.equal(r.ok, true);
  assert.equal(r.cost, 200);
  assert.equal(r.gold, 50);
  assert.equal(r.progression.strength, 5);
  assert.equal(r.progression.stat_points, 9);  // the 4 unspent plus the 5 refunded
});

test('respec with insufficient gold changes nothing at all', async () => {
  // ...same character, but 199 gold against a cost of 200...
  const r = await respec(pool, userId);
  assert.equal(r.ok, false);
  const after = await loadProgression(pool, userId);
  assert.equal(after.strength, 10, 'a failed payment must not yield a free respec');
  assert.equal(after.stat_points, 4, 'the points must not be refunded either');
  const g = await pool.query('SELECT gold FROM users WHERE id = $1', [userId]);
  assert.equal(Number(g.rows[0].gold), 199, 'gold must not move');
});

test('applyDeath never de-levels and persists the loss', ...);
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd backend && npx node --test tests/progression_store.test.js
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`backend/src/services/progressionStore.js`:

```js
// Every read and write of player_progression. Nothing outside this file and
// playerStats.js touches the raw stat columns.

const {
  levelForXp, applyDeathPenalty, refundedPoints, DEFAULT_PROGRESSION,
} = require('./playerStats.js');
const C = require('./progressionConstants.js');

const XP_SOURCES = ['kill', 'chest', 'dungeon_clear'];
const COLUMNS = `user_id, experience, level, stat_points,
                 strength, dexterity, constitution, intelligence, wisdom, charisma`;

// experience is bigint, which node-postgres returns as a STRING to avoid
// silent precision loss past 2^53. Normalise once, here, so no caller has to
// remember -- a forgotten Number() turns `xp + 10` into "0" + 10 === "010".
function mapRow(r) {
  return {
    user_id: r.user_id,
    experience: Number(r.experience) || 0,
    level: Number(r.level) || 1,
    stat_points: Number(r.stat_points) || 0,
    strength: Number(r.strength),
    dexterity: Number(r.dexterity),
    constitution: Number(r.constitution),
    intelligence: Number(r.intelligence),
    wisdom: Number(r.wisdom),
    charisma: Number(r.charisma),
  };
}

// Lazily creates the row. Registration does NOT create it: users arrive by
// several routes (the register endpoint, the admin seeder, the migration
// backfill) and one lazy insert here covers all of them, where a hook on one
// route would cover only that route.
async function loadProgression(db, userId) {
  await db.query(
    'INSERT INTO player_progression (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
    [userId],
  );
  const r = await db.query(
    `SELECT ${COLUMNS} FROM player_progression WHERE user_id = $1`, [userId],
  );
  return r.rows.length ? mapRow(r.rows[0]) : { ...DEFAULT_PROGRESSION, user_id: userId };
}

// Takes `db`, not `pool`: the kill path calls this INSIDE its own transaction
// so the XP award and the creature-death commit stand or fall together.
async function awardXp(db, userId, amount, source) {
  const before = await loadProgression(db, userId);
  const amt = Math.floor(Number(amount) || 0);
  // An unrecognised source is refused rather than defaulted. `chest` and
  // `dungeon_clear` are accepted today and unused -- they are the seam B and
  // C plug into, and accepting them now means neither has to touch this file.
  if (amt <= 0 || !XP_SOURCES.includes(source)) {
    return { progression: before, leveledUp: false, newLevel: before.level, pointsGained: 0, awarded: 0 };
  }
  const experience = before.experience + amt;
  const newLevel = levelForXp(experience);
  const pointsGained = Math.max(0, newLevel - before.level) * C.STAT_POINTS_PER_LEVEL;
  const r = await db.query(
    `UPDATE player_progression
        SET experience = $2, level = $3, stat_points = stat_points + $4, updated_at = now()
      WHERE user_id = $1
      RETURNING ${COLUMNS}`,
    [userId, experience, newLevel, pointsGained],
  );
  return {
    progression: mapRow(r.rows[0]),
    leveledUp: newLevel > before.level,
    newLevel,
    pointsGained,
    awarded: amt,
  };
}

async function allocateStat(pool, userId, statKey, count) {
  // Whitelist, not interpolation. statKey reaches this from an HTTP body.
  if (!C.STAT_KEYS.includes(statKey)) return { ok: false, reason: 'unknown stat' };
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) return { ok: false, reason: 'invalid count' };

  await loadProgression(pool, userId);
  // The guard is in the WHERE clause, not in a read-then-write pair: two
  // concurrent requests both pass a read-first check and both spend the same
  // points. Postgres serialises the UPDATE, so exactly one matches.
  const r = await pool.query(
    `UPDATE player_progression
        SET ${statKey} = ${statKey} + $2, stat_points = stat_points - $2, updated_at = now()
      WHERE user_id = $1 AND stat_points >= $2
      RETURNING ${COLUMNS}`,
    [userId, n],
  );
  if (r.rowCount !== 1) return { ok: false, reason: 'not enough points' };
  return { ok: true, progression: mapRow(r.rows[0]) };
}

async function respec(pool, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await loadProgression(client, userId);
    const cost = C.RESPEC_BASE * before.level;
    // Gold moves first, guarded in its own WHERE. If it does not move, the
    // whole transaction rolls back -- a failed payment must never yield a
    // free respec.
    const g = await client.query(
      'UPDATE users SET gold = gold - $2 WHERE id = $1 AND gold >= $2 RETURNING gold',
      [userId, cost],
    );
    if (g.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not enough gold', cost };
    }
    const refund = refundedPoints(before);
    const r = await client.query(
      `UPDATE player_progression
          SET strength = $2, dexterity = $2, constitution = $2,
              intelligence = $2, wisdom = $2, charisma = $2,
              stat_points = stat_points + $3, updated_at = now()
        WHERE user_id = $1
        RETURNING ${COLUMNS}`,
      [userId, C.BASE_STAT, refund],
    );
    await client.query('COMMIT');
    return { ok: true, progression: mapRow(r.rows[0]), gold: Number(g.rows[0].gold) || 0, cost };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function applyDeath(pool, userId) {
  const before = await loadProgression(pool, userId);
  const { experience, lost } = applyDeathPenalty(before.experience, before.level);
  if (lost <= 0) return { progression: before, lost: 0 };
  const r = await pool.query(
    `UPDATE player_progression SET experience = $2, updated_at = now()
      WHERE user_id = $1 RETURNING ${COLUMNS}`,
    [userId, experience],
  );
  return { progression: mapRow(r.rows[0]), lost };
}

module.exports = {
  loadProgression, awardXp, allocateStat, respec, applyDeath, XP_SOURCES,
};
```

- [ ] **Step 4: Run the tests**

```bash
cd backend && npx node --test tests/progression_store.test.js
```
Expected: PASS.

- [ ] **Step 5: Mutation check**

1. Drop `AND stat_points >= $2` from `allocateStat` → the concurrent-allocation test must go RED.
2. Move the gold `UPDATE` in `respec` to *after* the stat reset and remove the rollback → the insufficient-gold test must go RED.
3. Replace `!XP_SOURCES.includes(source)` with `false` → the unknown-source test must go RED.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/progressionStore.js backend/tests/progression_store.test.js
git commit -m "feat(progression): transactional XP, allocation and respec store (SOMET-242)"
```

---

### Task 4: Wire derived stats into the live sim

**Files:**
- Modify: `backend/src/authority/world.js`
- Modify: `backend/src/authority/projectiles.js`
- Modify: `backend/src/authority/server.js` (join path only)
- Test: `backend/tests/authority_player_stats.test.js` (create)

**Interfaces:**
- Consumes: `derivePlayerStats`, `DEFAULT_PROGRESSION` (Task 2); `loadProgression` (Task 3).
- Produces on `World`:
  - `addPlayer(userId, spawn, inv, respawn, gold, stats)` — `stats` defaults to `derivePlayerStats(DEFAULT_PROGRESSION)`
  - `applyDerivedStats(userId, stats) -> {hpDelta, manaDelta}`
  - module-level `weaponDamage(p, w)` and `applyAttackCooldown(p, w)`
  - every player object carries `p.stats`

**This is the task the spec's hazards live in. Read the three points below before writing code.**

- **All three damage sites.** `world.js:278` (melee vs creatures), `world.js:285` (melee vs players), and the projectile. Melee sites pass `weaponDamage(p, w)` in place of `w.damage`. The projectile is different: `spawn()` copies `weapon.damage` into the projectile once, at `projectiles.js:33`. Pass an explicit `damage` alongside `weapon` and have `spawn` prefer it (`damage: damage ?? weapon.damage`). Snapshotting at spawn is deliberate — a projectile already in flight must not change damage because its owner respecced.
- **Both cooldown sites.** `world.js:290` (melee) and `world.js:314` (projectile) both do `p._attackCd = w.cooldown`. Both become `applyAttackCooldown(p, w)`. The plan requires one call, not two edits: a source-text test below asserts `w.cooldown` appears nowhere else in the file.
- **`p.stats` is never optional.** `addPlayer` defaults it, so no consumer needs `p.stats?.` or a `|| PLAYER_MANA_REGEN` fallback. A fallback scattered at each read is how a missed site stays green.

- [ ] **Step 1: Write the failing tests**

`backend/tests/authority_player_stats.test.js`. No database — construct a `World` directly, as the sibling authority suites do (read one first for the harness idiom).

```js
test('a player joining with no progression behaves exactly as before A2', () => {
  // addPlayer with no stats argument -> hp/maxHp 100, mana/maxMana 100
});

test('CON raises max hp and the player joins at full', () => {
  // stats from { constitution: 10 } -> maxHp 150, hp 150
});

test('STR scales melee damage against creatures AND against players', () => {
  // Two separate assertions. The player-vs-player branch at world.js:285 is a
  // second, easily-missed site -- assert the damage a hit creature took and
  // the damage a hit player took, independently.
});

test('INT scales a magic weapon, STR does not', () => {
  // element 'fire' with high STR and base INT -> unchanged damage
  // element 'fire' with base STR and high INT -> scaled
  // element 'physical' -> the mirror image
});

test('a projectile carries its owner-scaled damage', () => {
  // spawn a projectile from a high-INT player with a fire bow, step it into a
  // creature, assert the CREATURE's hp loss -- not the projectile's `damage`
  // field. Asserting the field would pass even if nothing read it.
});

test('a projectile keeps the damage it launched with when its owner is re-derived', () => {
  // spawn, then applyDerivedStats to base, then step into the target:
  // the in-flight projectile still hits for the boosted amount
});

test('DEX shortens the cooldown on BOTH the melee and the projectile path', () => {
  // Two assertions, one per branch. This is the spec's named hazard.
});

test('WIS scales the mana regen tick', () => {
  // tick(1) from empty with base WIS restores 10; with wisdom 25 restores 20
});

test('applyDerivedStats raises current hp by the delta and never heals to full', () => {
  // maxHp 100, hp 30, new maxHp 150 -> hp 80. NOT 150.
  // This is AC6: healing to max makes levelling mid-fight a free full heal.
});

test('applyDerivedStats lowering maxHp cannot kill the player', () => {
  // maxHp 200, hp 5, respec back to maxHp 100 -> hp clamped to >= 1
});

// Source-text guard. The two cooldown sites are the spec's named hazard, and
// a behavioural test only proves the paths it exercises. This proves there is
// no THIRD site: `w.cooldown` must appear exactly once in the file, inside
// applyAttackCooldown.
test('the weapon cooldown is read in exactly one place', () => {
  const src = fs.readFileSync(require.resolve('../src/authority/world.js'), 'utf8');
  const hits = src.match(/w\.cooldown/g) || [];
  assert.equal(hits.length, 1, `w.cooldown read at ${hits.length} sites; route them all through applyAttackCooldown`);
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd backend && npx node --test tests/authority_player_stats.test.js
```

- [ ] **Step 3: Implement in `world.js`**

Add near the top, after the constants:

```js
const { derivePlayerStats, DEFAULT_PROGRESSION } = require('../services/playerStats.js');

const BASE_STATS = derivePlayerStats(DEFAULT_PROGRESSION);

// STR scales physical weapons, INT scales every other element. The split is
// the weapon catalog's existing `element` column -- no new field, and it
// gives the element system weight it currently lacks.
//
// Called at all THREE damage sites: melee-vs-creature, melee-vs-player, and
// projectile spawn. The projectile takes its value once, at launch, so a
// respec mid-flight cannot change a shot already in the air.
function weaponDamage(p, w) {
  const mult = (w.element && w.element !== 'physical') ? p.stats.spellMult : p.stats.meleeMult;
  return w.damage * mult;
}

// The ONLY place w.cooldown is read. Both attack branches call this; a test
// asserts the source contains exactly one `w.cooldown`.
function applyAttackCooldown(p, w) {
  p._attackCd = w.cooldown * p.stats.cooldownMult;
}
```

`addPlayer` gains a `stats` parameter and uses it for the pools:

```js
  addPlayer(userId, spawn, inv = { items: [], equipment: {} }, respawn = spawn, gold = 0, stats = BASE_STATS) {
    // ...
      hp: stats.maxHp,
      maxHp: stats.maxHp,
      mana: stats.maxMana,
      maxMana: stats.maxMana,
    // ... (stamina unchanged)
      stats,
```

Add the mid-session re-derive:

```js
  // Applies a NEW derived bundle to a live player. Deliberately distinct from
  // addPlayer, which joins at full: here the current pools move by the DELTA.
  //
  // AC6 -- level-up must not heal to full. Raising max hp by D raises current
  // hp by D. Healing to max would make levelling mid-fight a free full heal,
  // and the optimal play would become hoarding a nearly-dead creature for
  // emergencies.
  applyDerivedStats(userId, stats) {
    const p = this.players.get(userId);
    if (!p) return { hpDelta: 0, manaDelta: 0 };
    const hpDelta = stats.maxHp - p.maxHp;
    const manaDelta = stats.maxMana - p.maxMana;
    p.maxHp = stats.maxHp;
    p.maxMana = stats.maxMana;
    // Lower bound 1, not 0: a respec that shrinks CON must not kill the
    // player it is being applied to.
    p.hp = clamp(p.hp + hpDelta, 1, p.maxHp);
    p.mana = clamp(p.mana + manaDelta, 0, p.maxMana);
    p.stats = stats;
    return { hpDelta, manaDelta };
  }
```

Then the three edits: `w.damage` → `weaponDamage(p, w)` at the two melee sites; `p._attackCd = w.cooldown` → `applyAttackCooldown(p, w)` at both sites; `PLAYER_MANA_REGEN * dt` → `p.stats.manaRegen * dt` at `world.js:182`. Export `weaponDamage` and `applyAttackCooldown`.

`PLAYER_MANA_REGEN` stays exported (other modules and tests reference it) and remains the value `MANA_REGEN_BASE` matches.

- [ ] **Step 4: Implement in `projectiles.js`**

`spawn({ ownerId, x, y, nx, ny, weapon, damage })` and `damage: damage ?? weapon.damage`. Nothing else in the file changes — the four apply sites already read `p.damage`.

In `world.js`'s projectile branch, pass it: `this.projectiles.spawn({ ownerId: userId, x: cx, y: cy, nx, ny, weapon: w, damage: weaponDamage(p, w) })`.

- [ ] **Step 5: Load progression on join in `server.js`**

At the join path (`server.js:593-611`), alongside the existing gold read:

```js
        const progression = await loadProgression(pool, ws.userId);
        const stats = derivePlayerStats(progression);
        entry.world.addPlayer(ws.userId, spawn, inv, spawn.respawn, gold, stats);
```

and include `progression` in the join payload sent at `server.js:626` so the character sheet has data the moment it opens.

- [ ] **Step 6: Run the new suite and the whole backend suite**

```bash
cd backend && npx node --test tests/authority_player_stats.test.js && npm test
```
Expected: new suite PASS; **no pre-existing test regresses**. Note in the report: `authority_ratelimit`'s token-bucket burst test is a known pre-existing wall-clock flake (fails roughly 1 in 3 under load, passes 40/40 in isolation) — if it fails, re-run it alone before reporting it as a regression.

- [ ] **Step 7: Mutation check**

1. Revert `world.js:285` (player-vs-player melee) to `w.damage` → the STR-vs-players assertion must go RED.
2. Revert the projectile spawn to `weapon.damage` → the projectile-damage test must go RED.
3. Revert the projectile cooldown site to `p._attackCd = w.cooldown` → both the DEX projectile assertion and the source-text guard must go RED.

- [ ] **Step 8: Commit**

```bash
git add backend/src/authority/world.js backend/src/authority/projectiles.js backend/src/authority/server.js backend/tests/authority_player_stats.test.js
git commit -m "feat(progression): drive hp, mana, damage, cooldown and regen from stats (SOMET-242)"
```

---

### Task 5: Attribute kills to a killer

**Files:**
- Modify: `backend/src/authority/world.js`, `creatures.js`, `projectiles.js`, `effects.js`, `loot.js`, `server.js`
- Test: `backend/tests/authority_kill_attribution.test.js` (create)

**Pure plumbing — no XP in this task.** It exists on its own so a reviewer can reject the refactor independently of the reward it enables.

**Interfaces:**
- Produces: every kill channel returns `kills: Array<{ id, killerUserId }>` instead of `killedCreatureIds: Array<number>`. `killerUserId` is `null` when no player is responsible (a village guard's kill).
  - `World.attack()` → `{ kills, attacks }`
  - `World.tick()` → `{ kills }`
  - `World.tickCreatures()` → `{ kills }`
  - `World.tickProjectiles()` → `{ kills, detonations }`
  - `commitCreatureDeath(pool, entry, creatureId, { rng, ttlMs, killerUserId })`

**Notes for the implementer:**
- Sources of the killer at each channel: `attack()` already knows `userId`. Projectiles carry `p.ownerId` at all four apply sites. Burn ticks carry the effect's `sourceId` (`effects.js:126,190`) — `stepEffects`'s callback currently receives `(target, magnitude)`; extend it to `(target, magnitude, sourceId)` and thread it through. Creature contact kills in `creatures.js` have no player killer → `null`.
- **Rename rather than add.** Do not keep `killedCreatureIds` alongside `kills`. Two parallel channels is how one of them goes stale.
- Update the existing authority tests that destructure `killedCreatureIds`. Find them with `grep -rn killedCreatureIds backend/`.

- [ ] **Step 1: Write the failing tests**

```js
test('a melee kill is credited to the attacker', ...);
test('a projectile kill is credited to the projectile owner, not the last attacker', () => {
  // Player A fires; player B swings and misses. The kill belongs to A.
});
test('a burn-tick kill is credited to whoever applied the burn', () => {
  // Apply a fire hit, walk the attacker away, tick until the DOT kills.
});
test('a guard kill reports killerUserId null rather than a stray id', ...);
test('every kill channel reports the same shape', () => {
  // Each of the four returns objects with `id` and `killerUserId` keys.
});
```

- [ ] **Step 2: Run and watch them fail; Step 3: implement; Step 4: run the full backend suite**

```bash
cd backend && npm test
```
Expected: PASS, including every previously-existing authority test after the rename.

- [ ] **Step 5: Mutation check**

Change the projectile channel to report `killerUserId: null` → the projectile-credit test must go RED.

- [ ] **Step 6: Commit**

```bash
git commit -m "refactor(authority): carry the killer through every creature-kill channel (SOMET-242)"
```

---

### Task 6: Award XP on kill

**Files:**
- Modify: `backend/src/authority/loot.js`, `backend/src/authority/server.js`
- Test: `backend/tests/progression_kill_xp.test.js` (create)

**Interfaces:**
- Consumes: `awardXp` (Task 3), `kills` with `killerUserId` (Task 5), `derivePlayerStats`/`applyDerivedStats` (Tasks 2, 4).
- Produces: `commitCreatureDeath` returns `{ awarded, leveledUp, newLevel, progression, killerUserId } | null`; server pushes a `{ type: 'progression', ... }` message.

**Notes for the implementer:**
- **Do not build a new idempotency mechanism.** `commitCreatureDeath`'s `DELETE … RETURNING` with `if (r.rowCount !== 1) return;` is already documented as the single authoritative death commit — two damage sources reporting the same creature in one tick cannot both pass it. Add `level` to that `RETURNING` and award XP *after* the gate. That is AC8, satisfied by an invariant that already exists and is already tested.
- The XP award and the death commit must share one transaction: check out a client, `BEGIN`, do the `DELETE`, `awardXp(client, …)`, `spawnDrops(client, …)`, `COMMIT`.
- On level-up, the live player's pools must move: `entry.world.applyDerivedStats(killerUserId, derivePlayerStats(progression))`. Without this a level-up raises max HP in the database and nothing in the session — green tests, no effect in the game, which is precisely the class of defect A1's review caught.
- `onCreatureDeath` stays fire-and-forget with its mandatory `.catch` — the tick loop must not await it.

- [ ] **Step 1: Write the failing tests**

```js
test('a kill awards XP scaled by the creature level', ...);
test('a kill by nobody (guard) awards nothing and still drops loot', ...);
test('a second commit of the same creature id awards nothing', async () => {
  // Call commitCreatureDeath twice for one id. The second must return null
  // and leave experience untouched -- the rowCount gate, exercised directly.
});
test('a level-up raises the live player maxHp without healing to full', ...);
test('a failed XP award rolls back the creature deletion', async () => {
  // Force awardXp to throw; assert the creature row still exists.
  // The DB must never disagree with what players received.
});
```

- [ ] **Steps 2-4: fail → implement → `cd backend && npm test`**

- [ ] **Step 5: Mutation check**

Move the `awardXp` call *above* the `rowCount !== 1` gate → the double-commit test must go RED.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(progression): award kill XP inside the death commit (SOMET-242)"
```

---

### Task 7: The death penalty

**Files:**
- Modify: `backend/src/authority/world.js` (`resolveDeaths`), `backend/src/authority/server.js`
- Test: extend `backend/tests/progression_kill_xp.test.js` or create `progression_death.test.js`

**Notes for the implementer:**
- `resolveDeaths()` (`world.js:333`) is synchronous, inside the sim, with no pool access. It must not become async — it runs on the tick path. Have it **return** the ids of players who died this tick; `server.js` then calls `applyDeath(pool, userId)` fire-and-forget with a `.catch`, exactly as `onCreatureDeath` does.
- Respawn keeps healing to full — that is the existing, intended behaviour for death and is unrelated to AC6, which is about *levelling*.
- After `applyDeath`, push the updated progression to the client so the sheet's XP bar reflects the loss.

- [ ] **Step 1: Write the failing tests**

```js
test('resolveDeaths reports who died', ...);
test('dying costs the documented fraction of progress into the level', ...);
test('dying at a level floor costs nothing and never de-levels', ...);
test('dying does not change the allocated stats or spent points', ...);
```

- [ ] **Steps 2-4: fail → implement → `cd backend && npm test`**

- [ ] **Step 5: Mutation check**

Change `applyDeath` to write `experience - lost` without the floor clamp → the never-de-level test must go RED.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(progression): apply the death XP penalty on respawn (SOMET-242)"
```

---

### Task 8: CHA and merchant prices

**Files:**
- Modify: `backend/src/services/merchantStock.js`, `backend/src/authority/server.js` (the sell handler at `server.js:802`)
- Test: `backend/tests/merchant_price_charisma.test.js` (create)

**Interfaces:**
- `sellPriceFor(value, priceMult = SELL_FRACTION)` — the default preserves every existing caller's behaviour exactly.

**Notes for the implementer:**
- The sell handler must pass the seller's `priceMult` from `p.stats`.
- **The cap is load-bearing.** The village base catalog sells at `value` and never expires; buyback pays `value * fraction`. A fraction at or above 1.0 is an infinite-gold loop. `derivePlayerStats` clamps at `SELL_FRACTION_MAX`, and this task adds a second assertion at the boundary where money is actually created.

- [ ] **Step 1: Write the failing tests**

```js
test('sellPriceFor is unchanged for every existing caller', () => {
  assert.equal(sellPriceFor(100), 50);   // the pre-A2 literal
});

test('charisma raises what a merchant pays', () => {
  assert.equal(sellPriceFor(100, derivePlayerStats(at({ charisma: 15 })).priceMult), 70);
});

// The exploit test, asserted at the money seam and not only in playerStats.
test('no charisma makes an item sell for at least what it costs to buy', () => {
  for (const cha of [5, 10, 50, 500, 9999]) {
    const mult = derivePlayerStats(at({ charisma: cha })).priceMult;
    assert.ok(sellPriceFor(100, mult) < 100,
      `charisma ${cha} sells a 100-gold item for ${sellPriceFor(100, mult)} -- an infinite-gold loop`);
  }
});
```

- [ ] **Steps 2-4: fail → implement → `cd backend && npm test`**

- [ ] **Step 5: Mutation check**

Remove the `Math.min(C.SELL_FRACTION_MAX, …)` clamp in `playerStats.js` → the exploit test in *this* file must go RED (proving it guards the seam independently of Task 2's test).

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(progression): charisma raises merchant sell prices, capped below cost (SOMET-242)"
```

---

### Task 9: The HTTP API

**Files:**
- Create: `backend/src/api/progressionRoutes.js`
- Modify: `backend/src/index.js`
- Test: `backend/tests/progression_routes.test.js` (create)

**Interfaces:**
- `GET /api/progression` → `{ progression, stats, xpFloor, xpToNext, respecCost }`
- `POST /api/progression/allocate` `{ stat, count }` → `{ progression, stats }` | 400
- `POST /api/progression/respec` → `{ progression, stats, gold }` | 402

All three sit behind `requireAuth(pool)` from `backend/src/auth/middleware.js` and act on `req.user.id` — **never on a user id from the request body or path.** These are the first non-admin authenticated routes in the app; `requireAuth` exists and is currently unused. Mount with `app.use('/api/progression', progressionRoutes(pool))`, following `authRouter`'s shape at `index.js:315`.

- [ ] **Step 1: Write the failing tests**

```js
test('every progression route is behind an auth guard', () => {
  // Walk the Express route stack for the isAuthGuard marker, the way the
  // existing route-protection test does. middleware.js:54-57 documents this
  // marker as existing precisely so a test finds guards by marker, not by
  // counting handlers.
});
test('allocate acts on the authenticated user, not a body-supplied id', async () => {
  // POST { stat: 'strength', count: 1, userId: <someone else> }
  // -> the OTHER user's progression is untouched
});
test('allocate rejects an unknown stat with 400', ...);
test('allocate with more points than held returns 400 and changes nothing', ...);
test('respec without the gold returns 402 and changes nothing', ...);
test('GET returns the derived bundle alongside the raw row', ...);
```

- [ ] **Steps 2-4: fail → implement → `cd backend && npm test`**

- [ ] **Step 5: Mutation check**

Change `allocate` to read `req.body.userId || req.user.id` → the cross-account test must go RED.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(progression): authenticated character-sheet API (SOMET-242)"
```

---

### Task 10: The character sheet

**Files:**
- Create: `frontend/src/games/something2/CharacterSheet.jsx`
- Create: `frontend/src/games/something2/src/js/net/progressionClient.js`
- Modify: `frontend/src/games/something2/GameView.jsx`, `src/js/core/Game.js`
- Test: `frontend/src/games/something2/src/js/__tests__/characterSheet.test.js` (create)

**Follow `Minimap.jsx` as the pattern** — it is the proven in-game HUD panel in this repo: a `styled.div` overlay rendered from `GameView` when `isPlaying`, a keyboard toggle, and its visibility persisted to `localStorage`. Use **C** as the toggle key (M is the minimap). Confirm C is unbound before wiring it.

**Contents:** level and XP progress bar (`experience - xpFloor(level)` of `xpToNext(level)`), the six stats with a `+` control each, the unspent-point count, and a respec button showing its gold cost and disabled when the player cannot afford it.

**Testing reality:** frontend vitest runs in a plain **node** environment — no DOM, no jsdom, no RTL. Test the pure helpers directly (an `xpProgress(progression)` helper exported from the sheet, and `progressionClient.js` against a stubbed `fetch`), plus source-text assertions for the wiring that cannot be executed. Say plainly in the report which assertions are source-text rather than behavioural.

- [ ] **Step 1: Write the failing tests**

```js
test('xpProgress reports the position inside the current level', () => {
  // level 3 (floor 300), experience 450, xpToNext(3) = 300 -> { into: 150, need: 300, pct: 50 }
  // Literal values, not a recomputation.
});
test('xpProgress at max level does not divide by Infinity', ...);
test('the allocate client posts the stat and count and returns the new bundle', ...);
test('the respec button is disabled below the cost', ...);   // pure predicate, extracted
test('the sheet is toggled by C, not by M', ...);            // source-text
```

- [ ] **Steps 2-4: fail → implement → `cd frontend && npx vitest run`**

- [ ] **Step 5: Browser verification — this task is not done without it**

The project's definition of done requires browser verification for any change with a UI surface, and this repo's history is explicit that a green suite has repeatedly missed defects a browser caught (stamina inertness, unfireable ammo, wall sides rendering flat). Bring up the dev stack per the `make dev` target, log in, and confirm **by observation, not by inference**:

1. The sheet opens with C and shows level 1, 0 XP, six stats at 5.
2. Kill a creature → the XP bar moves. Read the actual number, not just "it changed".
3. Allocate a point into CON → the **HUD's HP bar maximum** changes in the same session, without a reload.
4. Allocate into DEX → attacks visibly come faster.
5. Die → the XP bar drops and the level does not.
6. Respec → gold drops by the cost, stats return to 5, points are refunded.
7. Sell an item at a merchant at base CHA → price unchanged from before this branch.

Capture a screenshot per step. **Where a claim is about pixels — bar lengths, text legibility, overlap — read the canvas and verify against pixel values.** A1's review found a level label that analytic review passed and a screenshot glance missed; only reading the pixels caught that a 3px stroke had closed every glyph counter.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(progression): in-game character sheet (SOMET-242)"
```

---

## Final review

After Task 10, dispatch the whole-branch review on the most capable model. Point it at:

- this plan's Global Constraints and the Survey corrections section,
- the deferred-minor list accumulated in the ledger,
- and these four questions specifically:
  1. Does **every** consumer read `derivePlayerStats`' bundle, or did a raw stat column leak into a formula somewhere? (`grep -rn "strength\|dexterity\|constitution\|intelligence\|wisdom\|charisma" backend/src/` — hits outside `playerStats.js`, `progressionStore.js`, `progressionConstants.js` and the routes are suspects.)
  2. Is there any damage or cooldown site left unscaled? All three damage sites and both cooldown sites, re-checked from the current source, not from this plan's line numbers.
  3. Can any test in this branch pass against a deliberately broken implementation? Pick the three most load-bearing and mutate them.
  4. Does a level-1 character produce byte-identical behaviour to `main`? This is the branch's regression-safety claim and it should be checkable directly.

## Known follow-ups (not blocking)

- The creature damage baseline `5` is duplicated across `mapService.js`, `authority/creatures.js` and migration `1714440050000` — inherited from A1, still unresolved.
- `authority_creatures_integration.test.js`'s socket cleanup lacks `try/finally`.
- `authority_ratelimit`'s token-bucket burst test is a pre-existing wall-clock flake.
