# S1 Bosses as Entities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the four world bosses and their four phase-minion types real `entity_types` rows, hydrated into the sim through one shared row→creature function, so the server hitbox matches the catalog size, the client gets `bossTier`/`element`/`name`/size on the wire, and a boss with approved art is drawn with it (procedural fallback keyed on `element`, never on name).

**Architecture:** One migration adds the boss columns; a second inserts 8 catalog rows (+ their drop rules). `creatures.js` gains `hydrateCreatureRow(row, instance)` and an `ENTITY_CATALOG_SELECT`; both `server.js` loaders and `WorldBossManager` feed `addCreatures` through it, and `addCreatures` stops dropping `bossTier`/`name`/`element`/`hitboxSize`/`auras`. `WorldBossManager` loads `boss_tier='world'` rows at startup and after every rotation and idles when there are none. `snapshotAOI` adds the boss fields to the one-time intro record; `CreatureManager` merges them; `RenderSystem.drawEntity` keys boss detection on `bossTier`.

**Tech Stack:** Node 20 CommonJS, Express, `pg`, node-pg-migrate 6, `node --test`; React 19 + Vite + vitest; Canvas 2D.

**Spec:** `docs/superpowers/specs/2026-10-10-boss-entities-auras-design.md` (S1 = §3.1, §3.8 world bosses, §4.1 world-boss part, §4.5 boss render, §5 Entities tab fields, §7 S1 tests)

**Plane:** SOMET-603 (parent SOMET-602)

## Global Constraints

- One git worktree for this slice: `WT=/home/markunn/worker/coding/jsgame/something2-wt-s1-bosses`, branch `feat/s1-bosses-as-entities`. Never `checkout`/`stash`/`branch`/`merge` in the shared checkout `/home/markunn/worker/coding/jsgame/something2`. Other sessions use it, and it holds another session's untracked sprite-batch files that you must not touch.
- One scratch DB for this branch: `S1_DB=postgres://user:password@localhost:15432/game_db_s1bosses`. Every DB test run sets BOTH `TEST_DATABASE_URL=$S1_DB DATABASE_URL=$S1_DB`. Seed it completely (catalogs, `p5-descent`, then `vale-region` LAST, then the passive tree) before you trust any number.
- Never run INSERT/UPDATE/DELETE/DDL against the shared dev DB (`game_db`). Every write in this plan goes to `game_db_s1bosses`.
- Migrations use timestamps `1714440670000` and `1714440671000`. `1714440660000` belongs to another session's untracked file. Before merging, re-check with `ls backend/migrations | grep 17144406[7-9]`.
- Commit subject `type(scope): summary (SOMET-603)`, body ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage by explicit path only. Never `git add -A` or `git add .`, because the `node_modules` symlinks are not ignored (`node_modules/` matches directories, not symlinks).
- Trust the test exit code (`...; echo "exit=$?"`), never the `# fail` line. Also grep for `^not ok` and `testTimeoutFailure`.
- `entity_types.auras` is also needed by S3. S1 adds it with `ADD COLUMN IF NOT EXISTS ... NULL`, and S3 must also use `ADD COLUMN IF NOT EXISTS`. S1's `down` does not drop `auras`.
- S1 must not add any NEW reference to `creature_behaviors.aura_*` (S3 drops those columns). The new `ENTITY_CATALOG_SELECT` deliberately omits them.
- Backend tests run from `$WT/backend` with `node --test <file>`, and frontend tests from `$WT/frontend` with `npx vitest run <file>`.
- After this merges, the dev stack's nodemon auto-runs both migrations on the shared dev DB. That is expected. Do not edit a migration file in the MAIN checkout while the stack is up.

## Review Focus

Five failure modes a user would hit that no current test covers. Each one is pinned by a test in the task that owns it:

1. **A boss row with NULL `hitbox_size`** (an admin clears the field). It must spawn at 48, not crash and not get width `NaN`/0. Pinned in Task 1 (`addCreatures` invalid/absent hitbox → 48) and Task 4 (`hydrateCreatureRow` NULL → `hitboxSize: null`).
2. **A renamed boss row** (an admin fixes a typo in the Entities tab). It must keep spawning under the new name, and the client must still find the boss creature for the HUD. Pinned in Task 6 (manager spawns the renamed row) and Task 8 (`findWorldBossCreature` matches by id/`bossTier`, never by name).
3. **No `boss_tier='world'` rows** (fresh DB before the seed, or an admin deleted or untiered all four). The manager must idle, push the next rotation and log once, and must not throw inside the tick loop. Pinned in Task 6.
4. **Art approved but the image fails to load.** `ImageManager.get` returns `null`, and the boss must fall back to the procedural body instead of a red 48px box or nothing. Pinned in Task 8.
5. **A minion row missing** (deleted or renamed `Fire Elemental Guard`). Phase 3/4 must spawn no minions, log one line, and still advance the phase. Pinned in Task 6.

Also pinned, beyond the five: a boss name in a world's `allowed_creature_types` must never wild-spawn (Task 5).

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `backend/migrations/1714440670000_boss_entity_columns.js` | Create | `boss_tier`, `element`, `hitbox_size`, `xp_reward`, `base_damage`, `auras` columns + CHECKs/FK; widen `attack_element` CHECK to include `arcane` |
| `backend/migrations/1714440671000_seed_world_boss_entities.js` | Create | 4 world-boss rows + 4 Elemental Guard rows + one elemental drop rule each |
| `backend/src/authority/creatures.js` | Modify | `hitboxOrNull`, `BOSS_TIERS`, `hydrateCreatureRow`, `ENTITY_CATALOG_SELECT`; `addCreatures` keeps boss fields; `CreatureSim#remove`; `snapshotAOI` intro fields |
| `backend/src/authority/worldBoss.js` | Modify | Catalog-driven manager: `loadWorldBossCatalog`, `bossFromRow`, `refreshCatalog`, `forceSpawn`, `forceWarning`; minions from catalog rows; `WORLD_BOSS_CATALOG` deleted |
| `backend/src/authority/server.js` | Modify | `CREATURE_JOINED_SELECT` gains 4 columns; `toSimCreature` used by both loaders; catalog refresh at boot; debug handler uses `forceSpawn`/`forceWarning`; death check on `bossTier` |
| `backend/src/services/worldPopulation.js` | Modify | Wild-spawn pool excludes `boss_tier IS NOT NULL` |
| `backend/src/index.js` | Modify | Entities POST/PUT accept + validate the 5 new columns; `attack_element` accepts `arcane` |
| `backend/tests/authority_boss_fields.test.js` | Create | `addCreatures` keeps boss fields (first RED test) |
| `backend/tests/boss_entity_columns_db.test.js` | Create | Column/constraint behaviour on a real schema |
| `backend/tests/world_boss_entities_seed_db.test.js` | Create | The 8 seeded rows, literal values |
| `backend/tests/creature_hydration.test.js` | Create | `hydrateCreatureRow` unit behaviour |
| `backend/tests/boss_joined_select_db.test.js` | Create | Real `CREATURE_JOINED_SELECT` → hydrate → sim gives width 96 |
| `backend/tests/world_population_db.test.js` | Modify | Boss never wild-spawns |
| `backend/tests/world_boss.test.js` | Rewrite | Catalog-driven manager behaviour |
| `backend/tests/world_boss_phase.test.js` | Rewrite | Phase transitions + catalog minions |
| `backend/tests/world_boss_catalog_db.test.js` | Create | Manager spawns from real DB rows |
| `backend/tests/authority_boss_snapshot.test.js` | Create | Wire intro carries boss fields once |
| `backend/tests/entityTypeFieldError.test.js` | Modify | Validation of the 5 fields + `arcane` |
| `backend/tests/entityTypes.test.js` | Modify | POST/PUT bind the new columns, PUT absent-key preserves |
| `frontend/src/games/something2/src/js/entities/CreatureManager.js` | Modify | Merge `bossTier`/`element`/`name`/`width`/`height` |
| `frontend/src/games/something2/src/js/entities/__tests__/CreatureManager.boss.test.js` | Create | Client merge of boss fields |
| `frontend/src/games/something2/src/js/systems/RenderSystem.js` | Modify | `bossTier` detection, `_drawEntityArt`, `bossPalette`, `_drawBossPlate`; name substrings removed |
| `frontend/src/games/something2/src/js/systems/__tests__/bossRender.test.js` | Create | Art-or-procedural selection |
| `frontend/src/games/something2/src/js/core/worldBossMatch.js` | Create | `findWorldBossCreature` (id / `bossTier`, never name) |
| `frontend/src/games/something2/src/js/core/__tests__/worldBossMatch.test.js` | Create | Matching rules |
| `frontend/src/games/something2/src/js/core/Game.js` | Modify | `getWorldBossStatus` uses `findWorldBossCreature` |
| `frontend/src/games/something2/WorldBossTestPanel.jsx` | Modify | Spawn buttons send `bossName` |
| `frontend/src/games/something2/bossFields.js` | Create | Pure form rules for the Entities tab boss fields + badge |
| `frontend/src/games/something2/__tests__/bossFields.test.js` | Create | Form rules |
| `frontend/src/games/something2/EntityTypesAdmin.jsx` | Modify | Boss tier / Element / Hitbox / XP / Base damage inputs, Boss badge, `arcane` attack element |

## Setup (before Task 1)

- [ ] **Create the worktree and link dependencies**

```bash
git -C /home/markunn/worker/coding/jsgame/something2 worktree add -b feat/s1-bosses-as-entities /home/markunn/worker/coding/jsgame/something2-wt-s1-bosses main
WT=/home/markunn/worker/coding/jsgame/something2-wt-s1-bosses
ln -s /home/markunn/worker/coding/jsgame/something2/backend/node_modules $WT/backend/node_modules
ln -s /home/markunn/worker/coding/jsgame/something2/frontend/node_modules $WT/frontend/node_modules
```

- [ ] **Create and seed the scratch DB** (about 2 min; this is the only DB you write to)

```bash
docker exec something2-db-1 psql -U user -d postgres -c 'CREATE DATABASE game_db_s1bosses;'
S1_DB=postgres://user:password@localhost:15432/game_db_s1bosses
cd $WT/backend
DATABASE_URL=$S1_DB npx node-pg-migrate up --ignore-pattern '(?!.*\.js$).*'
DATABASE_URL=$S1_DB node scripts/seed-catalogs.js
DATABASE_URL=$S1_DB SPEC=p5-descent node scripts/seed-map.js
DATABASE_URL=$S1_DB SPEC=vale-region node scripts/seed-map.js
DATABASE_URL=$S1_DB FORCE=1 node scripts/seed-passive-tree.js
```

- [ ] **Record a baseline** so pre-existing reds are not blamed on this slice

```bash
cd $WT/backend && TEST_DATABASE_URL=$S1_DB DATABASE_URL=$S1_DB npm test > ../../s1-baseline.log 2>&1; echo "exit=$?"
grep -E '^not ok|testTimeoutFailure' ../../s1-baseline.log
```

Keep the list of failing files. Later suite runs are "second runs" on this DB (see the Global Constraints).

---

### Task 1: `addCreatures` keeps the boss fields and the hitbox

**Files:**
- Modify: `backend/src/authority/creatures.js:26` (constants), `:1179-1265` (`addCreatures`)
- Test: `backend/tests/authority_boss_fields.test.js` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `hitboxOrNull(v: any): number|null` (module-private for now, used again in Task 4); `MAX_HITBOX_SIZE = 400`. Creature instance fields `name: string`, `bossTier: string|null`, `element: string|null`, `hitboxSize: number|null`, `auras: string[]|null`, `width`/`height = hitboxSize ?? CREATURE_SIZE`.

- [ ] **Step 1: Write the failing test.** This is the first S1 test, and it is RED today because `addCreatures` whitelists fields and forces 48.

```js
// backend/tests/authority_boss_fields.test.js
// SOMET-603 (S1). addCreatures is the one door into the sim, and it used to
// whitelist fields: a boss arrived with isWorldBoss/bossElement/name and a 96
// box, and left with none of them at 48. Everything S1 adds (hitbox, art
// size, boss render, boss audio) depends on these surviving the door.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CreatureSim } = require('../src/authority/creatures.js');

const stubMap = () => ({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 });
const rng = () => 0.05;

test('addCreatures keeps a boss instance\'s tier, element, name, auras and hitbox', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([{
    id: 'b1', type: 'zzBoss', name: 'zzBoss Display', x: 100, y: 100, hp: 5000,
    bossTier: 'world', element: 'ice', hitboxSize: 96, auras: ['zzAura'],
  }]);
  const c = s.get('b1');
  assert.equal(c.bossTier, 'world');
  assert.equal(c.element, 'ice');
  assert.equal(c.name, 'zzBoss Display');
  assert.equal(c.hitboxSize, 96);
  assert.equal(c.width, 96);
  assert.equal(c.height, 96);
  assert.deepEqual(c.auras, ['zzAura']);
});

test('an ordinary creature keeps the 48px box and null boss fields', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([{ id: 'w1', type: 'Wolf', x: 100, y: 100, hp: 10 }]);
  const c = s.get('w1');
  assert.equal(c.width, 48);
  assert.equal(c.height, 48);
  assert.equal(c.bossTier, null);
  assert.equal(c.element, null);
  assert.equal(c.hitboxSize, null);
  assert.equal(c.auras, null);
  assert.equal(c.name, 'Wolf', 'name falls back to the type');
});

// Review Focus 1: a cleared or junk hitbox must degrade to the default box,
// never to NaN/0 (Canvas and resolveMove both silently misbehave on those).
for (const bad of [null, undefined, 0, -5, 12.5, '96', Number.NaN, 401]) {
  test(`hitboxSize ${String(bad)} falls back to the 48px box`, () => {
    const s = new CreatureSim(stubMap(), rng);
    s.addCreatures([{ id: 'x', type: 'zzBoss', x: 0, y: 0, hp: 1, bossTier: 'world', hitboxSize: bad }]);
    const c = s.get('x');
    assert.equal(c.width, 48);
    assert.equal(c.height, 48);
    assert.equal(c.hitboxSize, null);
  });
}
```

- [ ] **Step 2: Run it and confirm it FAILS**

Run: `cd $WT/backend && node --test tests/authority_boss_fields.test.js; echo "exit=$?"`
Expected: FAIL on the first test with `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: undefined !== 'world'`, and `exit=1`. The hitbox-fallback tests may already pass, which is fine.

- [ ] **Step 3: Implement.** In `creatures.js` directly under `const CREATURE_SIZE = 48;` (line 26):

```js
// SOMET-603: the largest server hitbox a catalog row may ask for. Same ceiling
// as MAX_ENTITY_DISPLAY_PX in index.js (4 tiles at MAP_TILE_SIZE 100) and as
// the entity_types_hitbox_size_check constraint.
const MAX_HITBOX_SIZE = 400;

// A usable hitbox or null. Strict on purpose: a string '96' or a 12.5 is a
// fixture/admin bug, and null makes the caller fall back to CREATURE_SIZE.
function hitboxOrNull(v) {
  return Number.isInteger(v) && v > 0 && v <= MAX_HITBOX_SIZE ? v : null;
}
```

In `addCreatures`, directly after `const charmOwner = c.charmOwnerUserId ?? null;` (line 1191):

```js
      const hitbox = hitboxOrNull(c.hitboxSize);
```

Replace line 1193-1194:

```js
        id: c.id, type: c.type, x: c.x, y: c.y,
        width: CREATURE_SIZE, height: CREATURE_SIZE, speed: CREATURE_SPEED,
```

with:

```js
        id: c.id, type: c.type, x: c.x, y: c.y,
        // SOMET-603: the catalog's hitbox, not a constant. This is what makes a
        // boss's server collision/hit radius (world.js:1120, projectiles.js:507,
        // creatures.js:2243 all read width/2) match its catalog size.
        width: hitbox ?? CREATURE_SIZE, height: hitbox ?? CREATURE_SIZE, speed: CREATURE_SPEED,
        // SOMET-603: the ONE boss flag (render, audio, HUD, spawn) and its
        // element; name for the nameplate. Null for every ordinary creature.
        name: c.name ?? c.type,
        bossTier: c.bossTier ?? null,
        element: c.element ?? null,
        hitboxSize: hitbox,
        // Aura names (entity_types.auras). Carried, not interpreted, until S3.
        auras: Array.isArray(c.auras) ? c.auras : null,
```

- [ ] **Step 4: Run it and confirm it PASSES, then run the neighbours**

Run: `cd $WT/backend && node --test tests/authority_boss_fields.test.js tests/authority_creatures.test.js tests/authority_creatures_combat.test.js tests/authority_charm_creature.test.js; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 5: Commit**

```bash
cd $WT && git add backend/src/authority/creatures.js backend/tests/authority_boss_fields.test.js
git commit -m "feat(authority): addCreatures keeps boss tier, element, name and hitbox (SOMET-603)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Boss columns migration

**Files:**
- Create: `backend/migrations/1714440670000_boss_entity_columns.js`
- Test: `backend/tests/boss_entity_columns_db.test.js` (create)

**Interfaces:**
- Produces columns on `entity_types`: `boss_tier text NULL` (CHECK in `world|dungeon_end|dungeon_elite`), `element text NULL` (FK → `elements(name)` ON UPDATE CASCADE ON DELETE SET NULL), `hitbox_size integer NULL` (CHECK 1..400), `xp_reward integer NULL` (CHECK ≥ 0), `base_damage real NULL` (CHECK ≥ 0), `auras jsonb NULL` (IF NOT EXISTS). `entity_types_attack_element_check` now allows `arcane`.
- `base_damage` is NOT in the spec. See Self-Review D1. Without it the per-boss damage (42/35/55/45) has nowhere to live, because `entity_types` has no damage column and ordinary creatures take damage from `world_creatures.damage`.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/boss_entity_columns_db.test.js
// SOMET-603 (S1): the boss columns and their constraints, on a real schema.
// Every write is inside a transaction that is always rolled back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

const INSERT = `INSERT INTO entity_types
  (name, color, is_creature, attack_element, boss_tier, element, hitbox_size, xp_reward, base_damage, auras)
  VALUES ($1, '#fff', true, $2, $3, $4, $5, $6, $7, $8::jsonb)`;

async function expectCode(client, params, code, label) {
  await client.query('SAVEPOINT s');
  try {
    await client.query(INSERT, params);
    assert.fail(`${label}: expected SQLSTATE ${code}, the insert succeeded`);
  } catch (err) {
    if (err.code === 'ERR_ASSERTION') throw err;
    assert.equal(err.code, code, `${label}: ${err.message}`);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT s');
  }
}

test('entity_types carries the boss columns with their constraints', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The happy path, including an arcane attack (Abyssor) and an aura list.
    await client.query(INSERT,
      ['zzBossCols ok', 'arcane', 'world', 'arcane', 96, 3500, 42.5, '["zz_aura"]']);
    const r = await client.query(
      `SELECT boss_tier, element, hitbox_size, xp_reward, base_damage, auras, attack_element
         FROM entity_types WHERE name = 'zzBossCols ok'`);
    assert.deepEqual(r.rows[0], {
      boss_tier: 'world', element: 'arcane', hitbox_size: 96, xp_reward: 3500,
      base_damage: 42.5, auras: ['zz_aura'], attack_element: 'arcane',
    });
    // NULL everywhere is an ordinary creature and must be accepted.
    await client.query(INSERT, ['zzBossCols null', 'physical', null, null, null, null, null, null]);

    await expectCode(client, ['zzBC tier', 'physical', 'raid', null, null, null, null, null], '23514', 'unknown boss_tier');
    await expectCode(client, ['zzBC elem', 'physical', null, 'plasma', null, null, null, null], '23503', 'unknown element');
    await expectCode(client, ['zzBC hb0', 'physical', null, null, 0, null, null, null], '23514', 'hitbox 0');
    await expectCode(client, ['zzBC hb401', 'physical', null, null, 401, null, null, null], '23514', 'hitbox 401');
    await expectCode(client, ['zzBC xp', 'physical', null, null, null, -1, null, null], '23514', 'negative xp');
    await expectCode(client, ['zzBC dmg', 'physical', null, null, null, null, -1, null], '23514', 'negative damage');
    await expectCode(client, ['zzBC holy', 'holy', null, null, null, null, null, null], '23514', 'unknown attack_element');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
```

- [ ] **Step 2: Run it and confirm it FAILS**

Run: `cd $WT/backend && TEST_DATABASE_URL=$S1_DB DATABASE_URL=$S1_DB node --test tests/boss_entity_columns_db.test.js; echo "exit=$?"`
Expected: FAIL with `error: column "boss_tier" of relation "entity_types" does not exist` (`42703`), `exit=1`.

- [ ] **Step 3: Implement the migration**

```js
// backend/migrations/1714440670000_boss_entity_columns.js
//
// SOMET-603 (S1, spec 2026-10-10-boss-entities-auras-design.md §3.1).
// Bosses become catalog creatures. One boss flag (boss_tier) drives render,
// audio, HUD and spawn; element feeds the procedural fallback and audio
// prompts; hitbox_size is the SERVER box (NULL -> CREATURE_SIZE 48);
// xp_reward and base_damage carry the stats the old JS WORLD_BOSS_CATALOG held.
//
// base_damage is not in the spec's column list: entity_types has no damage
// column (ordinary creatures take theirs from world_creatures.damage, scaled
// at placement), and boss instances are never persisted, so without it the
// per-boss damage would have nowhere to live.
//
// auras is ALSO created by S3 (aura library). Both use IF NOT EXISTS, and this
// migration's down does not drop it, so whichever lands first owns it.
//
// attack_element gains 'arcane': Abyssor attacks arcane today (in memory, via
// the JS catalog). damage.js ELEMENTS and the elements table already include
// it, so this only stops the CHECK from rejecting what the sim already does.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE entity_types
      ADD COLUMN boss_tier text NULL
        CONSTRAINT entity_types_boss_tier_check
        CHECK (boss_tier IN ('world', 'dungeon_end', 'dungeon_elite')),
      ADD COLUMN element text NULL
        CONSTRAINT entity_types_element_fkey
        REFERENCES elements(name) ON UPDATE CASCADE ON DELETE SET NULL,
      ADD COLUMN hitbox_size integer NULL
        CONSTRAINT entity_types_hitbox_size_check CHECK (hitbox_size BETWEEN 1 AND 400),
      ADD COLUMN xp_reward integer NULL
        CONSTRAINT entity_types_xp_reward_check CHECK (xp_reward >= 0),
      ADD COLUMN base_damage real NULL
        CONSTRAINT entity_types_base_damage_check CHECK (base_damage >= 0);
    ALTER TABLE entity_types ADD COLUMN IF NOT EXISTS auras jsonb NULL;
    ALTER TABLE entity_types DROP CONSTRAINT entity_types_attack_element_check;
    ALTER TABLE entity_types ADD CONSTRAINT entity_types_attack_element_check
      CHECK (attack_element IN ('physical', 'arcane', 'fire', 'ice', 'lightning'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE entity_types SET attack_element = 'physical' WHERE attack_element = 'arcane';
    ALTER TABLE entity_types DROP CONSTRAINT entity_types_attack_element_check;
    ALTER TABLE entity_types ADD CONSTRAINT entity_types_attack_element_check
      CHECK (attack_element IN ('physical', 'fire', 'ice', 'lightning'));
    ALTER TABLE entity_types
      DROP COLUMN base_damage, DROP COLUMN xp_reward, DROP COLUMN hitbox_size,
      DROP COLUMN element, DROP COLUMN boss_tier;
  `);
};
```

- [ ] **Step 4: Apply to the scratch DB, run the test, confirm it PASSES, run the neighbours**

```bash
cd $WT/backend && DATABASE_URL=$S1_DB npx node-pg-migrate up --ignore-pattern '(?!.*\.js$).*'
TEST_DATABASE_URL=$S1_DB DATABASE_URL=$S1_DB node --test tests/boss_entity_columns_db.test.js tests/creature_behaviors_seed_db.test.js tests/creature_behaviors_api_db.test.js; echo "exit=$?"
```
Expected: `exit=0`. `creature_behaviors_seed_db` still rejects `'holy'` with `/entity_types_attack_element_check/`, because the constraint name is unchanged.

- [ ] **Step 5: Commit**

```bash
cd $WT && git add backend/migrations/1714440670000_boss_entity_columns.js backend/tests/boss_entity_columns_db.test.js
git commit -m "feat(db): entity_types boss columns, arcane attack element (SOMET-603)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Seed the 4 world bosses and 4 Elemental Guard rows

**Files:**
- Create: `backend/migrations/1714440671000_seed_world_boss_entities.js`
- Test: `backend/tests/world_boss_entities_seed_db.test.js` (create)

**Interfaces:**
- Consumes: Task 2 columns; `creature_behaviors` row `Line` (id 3 on dev, resolved by name); items `flame staff`, `frost staff`, `archmage staff`, `storm staff`.
- Produces: 8 `entity_types` rows (names below are the contract Task 6's `MINION_TYPE_BY_ELEMENT` and the test panel rely on) + 8 `creature_drops` rows.

Why a migration and not `seeds/data/entityTypes.js`: `seed-catalogs` only inserts base columns, with `ON CONFLICT DO NOTHING`, and never deletes. No seed file names these rows, so a re-seed cannot undo or overwrite them (the "spec beats migration" trap does not apply). Every fresh DB runs migrations.

Why drop rows: `creature_drops_db.test.js:92-101` requires every hostile creature to have a `creature_drops` row. Spec §3.7 also says boss rolls come "on top of the entity's normal drop rows". The rows are inert until S10, because a boss instance has no `world_creatures` row and `commitCreatureDeath` (`loot.js:86-92`) returns `null` before rolling drops.

- [ ] **Step 1: Write the failing test.** Expected values are literals copied from the deleted JS catalog (`worldBoss.js:19-72`) and minion spawn (`worldBoss.js:309-341`), never read from the migration.

```js
// backend/tests/world_boss_entities_seed_db.test.js
// SOMET-603 (S1, spec §3.8): the world bosses and their minion types are
// catalog rows. Expected values are the ones the old JS WORLD_BOSS_CATALOG
// carried, restated here as literals -- never read back from the migration.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

const COLS = `e.name, e.boss_tier, e.element, e.attack_element, e.hp, e.max_hp, e.defense,
  e.base_damage, e.hitbox_size, e.display_width, e.display_height, e.xp_reward,
  e.gold_min, e.gold_max, e.faction, e.is_creature, b.name AS behavior`;

test('the four world bosses are boss_tier=world rows with their legacy stats', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(
      `SELECT ${COLS} FROM entity_types e LEFT JOIN creature_behaviors b ON b.id = e.behavior_id
        WHERE e.boss_tier = 'world' ORDER BY e.name`);
    const row = (name, element, hp, defense, dmg, size, xp, gold) => ({
      name, boss_tier: 'world', element, attack_element: element, hp, max_hp: hp, defense,
      base_damage: dmg, hitbox_size: size, display_width: size, display_height: size,
      xp_reward: xp, gold_min: gold, gold_max: gold, faction: 'hostile', is_creature: true,
      behavior: 'Line',
    });
    assert.deepEqual(r.rows, [
      row('Abyssor, the Voidreaver', 'arcane', 10000, 18, 55, 80, 4000, 600),
      row('Glacius, the Frost Leviathan', 'ice', 14000, 32, 35, 96, 3800, 550),
      row('Gorgon, the Thunder Titan', 'lightning', 13000, 24, 45, 96, 3600, 520),
      row('Ignis, the Magma Colossus', 'fire', 12000, 25, 42, 96, 3500, 500),
    ]);
  } finally {
    await pool.end();
  }
});

test('the four Elemental Guard minion types are ordinary (untiered) creature rows', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(
      `SELECT ${COLS} FROM entity_types e LEFT JOIN creature_behaviors b ON b.id = e.behavior_id
        WHERE e.name LIKE '% Elemental Guard' ORDER BY e.name`);
    const row = (name, element) => ({
      name, boss_tier: null, element, attack_element: element, hp: 1500, max_hp: 1500,
      defense: 15, base_damage: 25, hitbox_size: null, display_width: null, display_height: null,
      xp_reward: null, gold_min: 0, gold_max: 0, faction: 'hostile', is_creature: true,
      behavior: 'Line',
    });
    assert.deepEqual(r.rows, [
      row('Arcane Elemental Guard', 'arcane'),
      row('Fire Elemental Guard', 'fire'),
      row('Ice Elemental Guard', 'ice'),
      row('Lightning Elemental Guard', 'lightning'),
    ]);
  } finally {
    await pool.end();
  }
});
```

- [ ] **Step 2: Run it and confirm it FAILS**

Run: `cd $WT/backend && TEST_DATABASE_URL=$S1_DB DATABASE_URL=$S1_DB node --test tests/world_boss_entities_seed_db.test.js; echo "exit=$?"`
Expected: both tests FAIL with `AssertionError ... + actual - expected` showing `[]` actual, `exit=1`.

- [ ] **Step 3: Implement the migration**

```js
// backend/migrations/1714440671000_seed_world_boss_entities.js
//
// SOMET-603 (S1, spec §3.8). The four world bosses and their four phase-minion
// types move out of worldBoss.js's hardcoded WORLD_BOSS_CATALOG into
// entity_types, so the Art/Sprite/Audio tabs see them with no special casing.
// Stats are the JS catalog's, verbatim. Minions keep the old hardcoded spawn
// stats (hp 1500, defense 15, damage 25); the old "<ELEMENT> Elemental Guard"
// type string becomes a proper name.
//
// behaviour = Line, by name: Line is byte-identical to DEFAULT_BEHAVIOR
// (400/800/charge/x1), which is what the bosses resolved to before (they
// carried no behaviour at all). creature_behaviors_seed_db requires every
// creature to have one.
//
// One elemental drop rule each, same guarded cross-join posture as
// 1714440024000_elements_creature_drops.js (a missing item inserts nothing).
// INERT until S10: boss/minion instances are never written to world_creatures,
// so commitCreatureDeath never reaches the drop roll for them. They exist so
// creature_drops_db's "every hostile creature has a drop rule" holds, and
// because spec §3.7 rolls boss loot "on top of the entity's normal drop rows".
//
// ON CONFLICT DO NOTHING: an admin's later edits to these rows are never
// reverted by a re-run, and no seed file names them (so no re-seed fights it).
exports.shorthands = undefined;

const BOSSES = [
  { name: 'Ignis, the Magma Colossus', color: '#ff4757', element: 'fire', hp: 12000, defense: 25,
    base_damage: 42, size: 96, xp_reward: 3500, gold: 500,
    prompt: 'A titan forged from molten core and obsidian armor.' },
  { name: 'Glacius, the Frost Leviathan', color: '#70a1ff', element: 'ice', hp: 14000, defense: 32,
    base_damage: 35, size: 96, xp_reward: 3800, gold: 550,
    prompt: 'An ancient dread beast encased in eternal permafrost.' },
  { name: 'Abyssor, the Voidreaver', color: '#a55eea', element: 'arcane', hp: 10000, defense: 18,
    base_damage: 55, size: 80, xp_reward: 4000, gold: 600,
    prompt: 'A harbinger of the astral void who tears reality asunder.' },
  { name: 'Gorgon, the Thunder Titan', color: '#ffd166', element: 'lightning', hp: 13000, defense: 24,
    base_damage: 45, size: 96, xp_reward: 3600, gold: 520,
    prompt: 'An electrified colossus crackling with tempest storms.' },
];

const MINIONS = [
  { name: 'Fire Elemental Guard', color: '#ff4757', element: 'fire',
    prompt: 'A hulking guardian of living flame summoned to defend a world boss.' },
  { name: 'Ice Elemental Guard', color: '#70a1ff', element: 'ice',
    prompt: 'A hulking guardian of jagged ice summoned to defend a world boss.' },
  { name: 'Arcane Elemental Guard', color: '#a55eea', element: 'arcane',
    prompt: 'A hulking guardian of swirling arcane force summoned to defend a world boss.' },
  { name: 'Lightning Elemental Guard', color: '#ffd166', element: 'lightning',
    prompt: 'A hulking guardian of crackling lightning summoned to defend a world boss.' },
];

const DROP_ITEM_BY_ELEMENT = {
  fire: 'flame staff', ice: 'frost staff', arcane: 'archmage staff', lightning: 'storm staff',
};

const ROWS = [
  ...BOSSES.map((b) => ({
    name: b.name, color: b.color, element: b.element, hp: b.hp, defense: b.defense,
    base_damage: b.base_damage, boss_tier: 'world', hitbox_size: b.size, display: b.size,
    xp_reward: b.xp_reward, gold: b.gold, prompt: b.prompt,
  })),
  ...MINIONS.map((m) => ({
    name: m.name, color: m.color, element: m.element, hp: 1500, defense: 15,
    base_damage: 25, boss_tier: null, hitbox_size: null, display: null,
    xp_reward: null, gold: 0, prompt: m.prompt,
  })),
];

const sqlString = (s) => `'${s.replace(/'/g, "''")}'`;

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO entity_types
      (name, color, walkable, spawn_tiles, chance, is_creature, hp, max_hp, defense,
       resistances, faction, gold_min, gold_max, prompt, attack_element, behavior_id,
       boss_tier, element, hitbox_size, xp_reward, base_damage, display_width, display_height)
    SELECT r.name, r.color, true, '[]'::jsonb, 0, true, r.hp, r.hp, r.defense,
           '{}'::jsonb, 'hostile', r.gold, r.gold, r.prompt, r.element,
           (SELECT id FROM creature_behaviors WHERE name = 'Line'),
           r.boss_tier, r.element, r.hitbox_size, r.xp_reward, r.base_damage, r.display, r.display
      FROM jsonb_to_recordset(${sqlString(JSON.stringify(ROWS))}::jsonb) AS r(
        name text, color text, element text, hp int, defense real, base_damage real,
        boss_tier text, hitbox_size int, display int, xp_reward int, gold int, prompt text)
    ON CONFLICT (name) DO NOTHING
  `);
  for (const r of ROWS) {
    pgm.sql(`
      INSERT INTO creature_drops (entity_type_id, item_type_id, chance, min_qty, max_qty)
      SELECT et.id, it.id, 0.2, 1, 1
        FROM entity_types et, item_types it
       WHERE et.name = ${sqlString(r.name)} AND it.name = ${sqlString(DROP_ITEM_BY_ELEMENT[r.element])}
         AND NOT EXISTS (SELECT 1 FROM creature_drops cd WHERE cd.entity_type_id = et.id AND cd.item_type_id = it.id)
    `);
  }
};

exports.down = (pgm) => {
  const names = ROWS.map((r) => sqlString(r.name)).join(', ');
  pgm.sql(`
    DELETE FROM creature_drops WHERE entity_type_id IN (SELECT id FROM entity_types WHERE name IN (${names}));
    DELETE FROM entity_types WHERE name IN (${names});
  `);
};
```

- [ ] **Step 4: Apply, run the test, confirm it PASSES, run the catalog invariants**

```bash
cd $WT/backend && DATABASE_URL=$S1_DB npx node-pg-migrate up --ignore-pattern '(?!.*\.js$).*'
TEST_DATABASE_URL=$S1_DB DATABASE_URL=$S1_DB node --test tests/world_boss_entities_seed_db.test.js tests/creature_drops_db.test.js tests/creature_behaviors_seed_db.test.js tests/authority_elements_invariants.test.js tests/seed_catalogs_db.test.js; echo "exit=$?"
```
Expected: `exit=0`. If `creature_drops_db` names one of the 8 rows as dropless, an item name above did not match. Check with `SELECT name FROM item_types WHERE name IN ('flame staff','frost staff','archmage staff','storm staff')`.

- [ ] **Step 5: Commit**

```bash
cd $WT && git add backend/migrations/1714440671000_seed_world_boss_entities.js backend/tests/world_boss_entities_seed_db.test.js
git commit -m "feat(db): seed world bosses and elemental guard minions as entity rows (SOMET-603)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: One shared row→creature hydration, used by both live loaders

**Files:**
- Modify: `backend/src/authority/creatures.js` (after `creatureMitigation`, `:151`; after `ABILITIES_LATERAL`, `:182`; exports `:2471`)
- Modify: `backend/src/authority/server.js:47` (import), `:367-387` (`CREATURE_JOINED_SELECT`), `:412-422` (add `toSimCreature` after `hydrateCharm`), `:1283`, `:1332`
- Test: `backend/tests/creature_hydration.test.js` (create), `backend/tests/boss_joined_select_db.test.js` (create)

**Interfaces:**
- Produces (exported from `creatures.js`):
  - `BOSS_TIERS: readonly ['world','dungeon_end','dungeon_elite']`
  - `hydrateCreatureRow(row: object, instance?: object): object`. This takes a raw snake_case row (a `CREATURE_JOINED_SELECT` instance row OR an `ENTITY_CATALOG_SELECT` type row) plus optional instance overrides (`id, x, y, hp, level, damage, …`). It returns the row spread with `type`, `name`, `bossTier`, `element`, `hitboxSize`, `auras` normalized, i.e. the shape `addCreatures` reads.
  - `ENTITY_CATALOG_SELECT: string`. This is the `SELECT … FROM entity_types e LEFT JOIN creature_behaviors b … ${ABILITIES_LATERAL}` with no WHERE, and callers append their own.
- Produces (server.js, module-private): `toSimCreature(row, world) = hydrateCharm(hydrateCreatureRow(row), world)`.

- [ ] **Step 1: Write the failing unit test**

```js
// backend/tests/creature_hydration.test.js
// SOMET-603 (S1, spec §4.1): ONE function turns a DB row into what
// addCreatures reads, for the chunk loader, the guard/respawn injector and the
// world boss manager alike -- so boss_tier/element/hitbox_size/auras arrive
// one way only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CreatureSim, hydrateCreatureRow } = require('../src/authority/creatures.js');

const stubMap = () => ({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 });

// Shaped like ENTITY_CATALOG_SELECT: a TYPE row, so `name`, not `type`.
const catalogRow = {
  id: 7, name: 'zzCatalog Boss', color: '#123456', hp: 9000, max_hp: 9000, defense: 20,
  resistances: {}, faction: 'hostile', attack_element: 'ice', vfx: null,
  boss_tier: 'world', element: 'ice', hitbox_size: 96, auras: ['zz_aura', 7, ''],
  behavior_name: null, abilities: null,
};

test('a catalog row plus instance fields hydrates into a boss creature', () => {
  const c = hydrateCreatureRow(catalogRow, { id: 'b1', x: 10, y: 20, level: 100, damage: 42 });
  assert.equal(c.id, 'b1');
  assert.equal(c.type, 'zzCatalog Boss', 'a type row\'s name becomes the instance type');
  assert.equal(c.name, 'zzCatalog Boss');
  assert.equal(c.bossTier, 'world');
  assert.equal(c.element, 'ice');
  assert.equal(c.hitboxSize, 96);
  assert.deepEqual(c.auras, ['zz_aura'], 'non-string and empty aura names are dropped');
  assert.equal(c.damage, 42);
  assert.equal(c.attack_element, 'ice', 'raw columns addCreatures reads stay on the object');
});

test('an instance row (CREATURE_JOINED_SELECT shape) keeps its own type as the name', () => {
  const c = hydrateCreatureRow({ id: 'u-1', type: 'Wolf', x: 0, y: 0, hp: 30, boss_tier: null,
    element: null, hitbox_size: null, auras: null });
  assert.equal(c.type, 'Wolf');
  assert.equal(c.name, 'Wolf');
  assert.equal(c.bossTier, null);
  assert.equal(c.hitboxSize, null);
  assert.equal(c.auras, null);
});

test('an unknown boss_tier or a junk hitbox hydrates to null, never passes through', () => {
  const c = hydrateCreatureRow({ ...catalogRow, boss_tier: 'raid', hitbox_size: 0, element: '' });
  assert.equal(c.bossTier, null);
  assert.equal(c.hitboxSize, null);
  assert.equal(c.element, null);
});

test('hydrated rows go through addCreatures with the catalog hitbox', () => {
  const s = new CreatureSim(stubMap(), () => 0.05);
  s.addCreatures([hydrateCreatureRow(catalogRow, { id: 'b1', x: 0, y: 0 })]);
  const c = s.get('b1');
  assert.equal(c.width, 96);
  assert.equal(c.bossTier, 'world');
  assert.equal(c.maxHp, 9000);
});
```

- [ ] **Step 2: Run it and confirm it FAILS**

Run: `cd $WT/backend && node --test tests/creature_hydration.test.js; echo "exit=$?"`
Expected: FAIL with `TypeError: hydrateCreatureRow is not a function`, `exit=1`.

- [ ] **Step 3: Implement in `creatures.js`.** Directly after `creatureMitigation` (ends line 151):

```js
// SOMET-603: the three boss tiers (entity_types_boss_tier_check). NULL = an
// ordinary creature.
const BOSS_TIERS = Object.freeze(['world', 'dungeon_end', 'dungeon_elite']);

// SOMET-603 (spec §4.1): the ONE row -> addCreatures-input mapping. Every
// path that puts a creature into a CreatureSim from the database goes through
// here: server.js's activateChunk and injectGuardIntoSim (instance rows from
// CREATURE_JOINED_SELECT) and WorldBossManager (type rows from
// ENTITY_CATALOG_SELECT plus instance overrides). Two mappings is how
// SOMET-249 nearly shipped a catalog inert; this is the third column set
// (boss fields) that would otherwise have needed adding in three places.
//
// `instance` wins over `row`, which is how a type row becomes an instance:
// the manager supplies id/x/y/hp/level/damage. A type row has `name` and no
// `type`; an instance row has `type` (wc.type) and no `name`.
function hydrateCreatureRow(row, instance = {}) {
  const merged = { ...row, ...instance };
  const type = merged.type ?? row.name;
  return {
    ...merged,
    type,
    name: instance.name ?? row.name ?? type,
    bossTier: BOSS_TIERS.includes(merged.boss_tier) ? merged.boss_tier : null,
    element: typeof merged.element === 'string' && merged.element !== '' ? merged.element : null,
    hitboxSize: merged.hitbox_size == null ? null : hitboxOrNull(Number(merged.hitbox_size)),
    auras: Array.isArray(merged.auras)
      ? merged.auras.filter((a) => typeof a === 'string' && a !== '')
      : null,
  };
}
```

Directly after `ABILITIES_LATERAL` (ends line 182):

```js
// SOMET-603: entity TYPE rows with everything hydrateCreatureRow and
// resolveBehavior read, for callers that spawn an instance with no
// world_creatures row (WorldBossManager now; S9 dungeon bosses next). Callers
// append their own WHERE/ORDER BY. b.aura_* are deliberately NOT selected:
// S3 drops those columns, and no boss uses a behaviour with an aura.
const ENTITY_CATALOG_SELECT = `SELECT e.id, e.name, e.color, e.hp, e.max_hp, e.defense, e.resistances,
         e.faction, e.gold_min, e.gold_max, e.attack_element, e.vfx, e.prompt,
         e.boss_tier, e.element, e.hitbox_size, e.auras, e.xp_reward, e.base_damage,
         e.display_width, e.display_height,
         b.name AS behavior_name, b.aggro_radius, b.leash_radius, b.chase_style, b.preferred_range,
         b.move_speed_mult, b.damage_override,
         b.gold_min AS behavior_gold_min, b.gold_max AS behavior_gold_max,
         ab.abilities
    FROM entity_types e
    LEFT JOIN creature_behaviors b ON b.id = e.behavior_id${ABILITIES_LATERAL}`;
```

In `module.exports` (line 2472), change `CreatureSim, loadCreatureTypes, creatureMitigation,` to:

```js
  CreatureSim, loadCreatureTypes, creatureMitigation,
  // SOMET-603: the shared row -> creature hydration and its catalog SELECT.
  hydrateCreatureRow, ENTITY_CATALOG_SELECT, BOSS_TIERS,
```

- [ ] **Step 4: Run the unit test, confirm it PASSES**

Run: `cd $WT/backend && node --test tests/creature_hydration.test.js; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 5: Write the failing DB test.** It exercises the REAL `CREATURE_JOINED_SELECT` text, not a substring of it.

```js
// backend/tests/boss_joined_select_db.test.js
// SOMET-603: the live per-chunk/per-id SELECT must carry the boss columns, or
// a boss-typed world_creatures row loads as an ordinary 48px creature with
// nothing failing. Read back through the EXACT CREATURE_JOINED_SELECT text,
// inside a transaction that is always rolled back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { CREATURE_JOINED_SELECT } = require('../src/authority/server.js');
const { CreatureSim, hydrateCreatureRow } = require('../src/authority/creatures.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

test('a boss-typed world_creatures row loads with its catalog hitbox, tier and element', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const w = await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('zzBossJoinedSelect', 1) RETURNING id`);
    const ins = await client.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage, defense)
       VALUES ($1, 'Ignis, the Magma Colossus', 500, 500, 12000, 'S', 100, 42, 25) RETURNING id`,
      [w.rows[0].id]);
    const q = await client.query(`${CREATURE_JOINED_SELECT} WHERE wc.id = $1`, [ins.rows[0].id]);
    assert.equal(q.rowCount, 1, 'precondition: the joined SELECT found the fixture row');

    const sim = new CreatureSim({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }, () => 0.05);
    sim.addCreatures(q.rows.map((r) => hydrateCreatureRow(r)));
    const c = sim.get(ins.rows[0].id);
    assert.equal(c.bossTier, 'world');
    assert.equal(c.element, 'fire');
    assert.equal(c.width, 96);
    assert.equal(c.height, 96);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
```

- [ ] **Step 6: Run it and confirm it FAILS**

Run: `cd $WT/backend && TEST_DATABASE_URL=$S1_DB DATABASE_URL=$S1_DB node --test tests/boss_joined_select_db.test.js; echo "exit=$?"`
Expected: FAIL with `Expected values to be strictly equal: null !== 'world'` (the SELECT does not yet carry `et.boss_tier`), `exit=1`.

- [ ] **Step 7: Implement in `server.js`**

Line 378, `et.vfx,` becomes:

```js
                et.vfx,
                et.boss_tier, et.element, et.hitbox_size, et.auras,
```

Line 23, `const { loadCreatureTypes, ABILITIES_LATERAL } = require('./creatures');` becomes `const { loadCreatureTypes, ABILITIES_LATERAL, hydrateCreatureRow } = require('./creatures');`.

Directly after `hydrateCharm` (closes around line 422), add:

```js
// SOMET-603: the one per-row conversion both live loaders apply. Hydration
// first (boss fields, hitbox -- shared with WorldBossManager), then the charm
// restore, which spreads the row and so keeps every hydrated field.
function toSimCreature(row, world) {
  return hydrateCharm(hydrateCreatureRow(row), world);
}
```

Line 1283 and line 1332, change `rows.rows.map((r) => hydrateCharm(r, entry.world))` to `rows.rows.map((r) => toSimCreature(r, entry.world))`.

- [ ] **Step 8: Run both tests and the loader neighbours, confirm they PASS**

```bash
cd $WT/backend && TEST_DATABASE_URL=$S1_DB DATABASE_URL=$S1_DB node --test tests/creature_hydration.test.js tests/boss_joined_select_db.test.js tests/guard_block_cue_db.test.js tests/charm_live_db.test.js tests/authority_creatures_integration.test.js; echo "exit=$?"
```
Expected: `exit=0`.

- [ ] **Step 9: Commit**

```bash
cd $WT && git add backend/src/authority/creatures.js backend/src/authority/server.js backend/tests/creature_hydration.test.js backend/tests/boss_joined_select_db.test.js
git commit -m "feat(authority): shared hydrateCreatureRow for every DB-to-sim path (SOMET-603)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: A boss never enters the wild-spawn pool

**Files:**
- Modify: `backend/src/services/worldPopulation.js:142-145`
- Modify test: `backend/tests/world_population_db.test.js` (`FIXTURES` list `:20-22`, append a test after `:205`)

**Interfaces:** no new names. `populateWorld` now ignores any `allowed_creature_types` entry whose row has `boss_tier` set.

Why: `mapSpecCatalogs` (`index.js:2923-2931`) accepts any `is_creature` name. Once bosses are rows, a world spec or an admin listing "Ignis…" in allowed types would scatter dozens of 12000-hp bosses as wild creatures (and their deaths would roll the inert boss drop rows).

- [ ] **Step 1: Write the failing test.** Add `'zzPopBossFilter'` to the `FIXTURES` array (line 20-22). Append:

```js
describeDb('populateWorld never places a boss-tier type as a wild spawn', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await cleanup(pool);
    // biomes: [] for the same reason as the guard-filter test above: a biome
    // intersection would exclude the boss by itself and make this vacuous.
    const world = await makeWorld(pool, 'zzPopBossFilter', 'horde',
      ['Ignis, the Magma Colossus', 'Skeleton'], []);
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await populateWorld(client, world, { rngSeed: 23 });
      await client.query('COMMIT');
    } finally { client.release(); }

    assert.ok(result.total > 0, 'fixture placed nothing -- the negative assertion below would be vacuous');
    const skeletons = await pool.query(
      `SELECT count(*)::int AS n FROM world_creatures WHERE world_id = $1 AND type = 'Skeleton'`, [world.id]);
    assert.ok(skeletons.rows[0].n > 0, 'the allowed ordinary type must actually be placed');
    const bosses = await pool.query(
      `SELECT count(*)::int AS n FROM world_creatures WHERE world_id = $1 AND type = 'Ignis, the Magma Colossus'`,
      [world.id]);
    assert.equal(bosses.rows[0].n, 0, 'a boss-tier type must never enter the wild-spawn pool');
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});
```

- [ ] **Step 2: Run it and confirm it FAILS**

Run: `cd $WT/backend && TEST_DATABASE_URL=$S1_DB DATABASE_URL=$S1_DB node --test tests/world_population_db.test.js; echo "exit=$?"`
Expected: the new test FAILS with `a boss-tier type must never enter the wild-spawn pool` (actual > 0), `exit=1`.

- [ ] **Step 3: Implement.** In `worldPopulation.js` lines 142-145, change the SELECT to:

```js
  // SOMET-603: boss-tier rows are placed by their own owners (WorldBossManager,
  // S9's map-spec `boss` block), never scattered -- same structural exclusion
  // as the guard filter below, done in SQL because boss_tier is not selected.
  const et = await client.query(
    `SELECT name, hp, defense, resistances, faction FROM entity_types
      WHERE is_creature = true AND boss_tier IS NULL AND name = ANY($1::text[])`,
    [allowedNames],
  );
```

- [ ] **Step 4: Run it and confirm it PASSES**

Run: `cd $WT/backend && TEST_DATABASE_URL=$S1_DB DATABASE_URL=$S1_DB node --test tests/world_population_db.test.js tests/safe_region_population_db.test.js; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 5: Commit**

```bash
cd $WT && git add backend/src/services/worldPopulation.js backend/tests/world_population_db.test.js
git commit -m "fix(population): never scatter boss-tier types as wild spawns (SOMET-603)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: WorldBossManager reads the catalog, hydrates boss and minions, idles when empty

**Files:**
- Modify: `backend/src/authority/creatures.js` (add `CreatureSim#remove` after `get`, line 1274)
- Modify: `backend/src/authority/worldBoss.js:12` (imports), `:19-72` (delete `WORLD_BOSS_CATALOG`, add catalog helpers), `:120-150` (constructor), `:153-155` (`_planNextBoss` head), `:239-255` (`getStatus`), `:307-344` (`_spawnPhaseMinions`), `:377-398` (`tick` idle branch), `:443-500` (`_spawnBoss`), `:520-534` (`_despawnBoss`), `:557` (`onCreatureDeath` guard), `:668-673` (rotation reset), `:743-753` (exports)
- Modify: `backend/src/authority/server.js:47`, `:473-478`, `:915`, `:2751-2772`, `:2840-2843`
- Modify: `frontend/src/games/something2/WorldBossTestPanel.jsx:544,552,560,568`
- Rewrite tests: `backend/tests/world_boss.test.js`, `backend/tests/world_boss_phase.test.js`
- Create test: `backend/tests/world_boss_catalog_db.test.js`

**Interfaces:**
- Consumes: `hydrateCreatureRow`, `ENTITY_CATALOG_SELECT`, `CREATURE_SIZE`, `CREATURE_SPEED`, `CREATURE_DAMAGE` from `creatures.js`.
- Produces (`worldBoss.js` exports): `loadWorldBossCatalog(pool) → Promise<{ bosses: row[], minionsByElement: Map<element,row> }>`, `bossFromRow(row) → currentBoss`, `MINION_TYPE_BY_ELEMENT`, `WORLD_BOSS_LEVEL`, `MINION_LEVEL`. `WorldBossManager` gains the constructor option `loadCatalog?: () => Promise<catalog>`, plus `refreshCatalog(): Promise<catalog>`, `forceSpawn(now, worlds, {bossName?, preferredWorldId?}, broadcastFn?) → boolean`, `forceWarning(now, worlds, {bossName?, seconds?}, broadcastFn?) → boolean`, and `getStatus().bossCreatureId`. `_planNextBoss(worlds, preferredWorldId?, bossName?) → boolean`. `WORLD_BOSS_CATALOG` is REMOVED.
- Produces (`CreatureSim`): `remove(id) → boolean`. This is silent removal with no death sfx, for despawn. `worldBoss.js:523` and `server.js` debug `slay` already call `creatures.remove`, which does not exist today (they are guarded no-ops, so a timed-out or debug-slain boss stays in the world).
- Wire: the debug message `debugWorldBoss` takes `bossName: string` in place of `bossIndex`.

- [ ] **Step 1: Write the failing tests.** Replace `backend/tests/world_boss.test.js` entirely:

```js
// backend/tests/world_boss.test.js
// SOMET-603 (S1): the world boss rotation is driven by entity_types rows
// (boss_tier = 'world'), loaded through an injectable loader. Fixture rows are
// zz-named on purpose: the manager must spawn whatever the catalog holds and
// must never know a boss by name.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WorldBossManager } = require('../src/authority/worldBoss');
const { CreatureSim } = require('../src/authority/creatures');

function bossRow(over = {}) {
  return {
    id: 901, name: 'zzMagma Boss', color: '#ff4757', hp: 12000, max_hp: 12000, defense: 25,
    resistances: {}, faction: 'hostile', gold_min: 500, gold_max: 500, attack_element: 'fire',
    vfx: null, prompt: 'zz', boss_tier: 'world', element: 'fire', hitbox_size: 96, auras: null,
    xp_reward: 3500, base_damage: 42, display_width: 96, display_height: 96,
    behavior_name: null, abilities: null, ...over,
  };
}
const catalogOf = (bosses, minions = []) =>
  async () => ({ bosses, minionsByElement: new Map(minions.map((m) => [m.element, m])) });

function worldEntry(worldId = 'w1', name = 'Emerald Grove') {
  const sim = new CreatureSim({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }, () => 0.05);
  return {
    worldId,
    row: { name, width: 32, height: 32 },
    waypoints: new Map([['0,0', { id: 'wp_1', name: 'Grove Waypoint', x: 200, y: 200 }]]),
    world: { creatures: sim },
  };
}
async function managerWith(loadCatalog) {
  const m = new WorldBossManager({ bossIntervalMs: 600000, bossWarningMs: 120000, rng: () => 0, loadCatalog });
  await m.refreshCatalog();
  return m;
}

test('transitions from idle to warning at 2 minutes remaining', async () => {
  const m = await managerWith(catalogOf([bossRow()]));
  const worlds = new Map([['w1', worldEntry('w1', 'Sunken Vale')]]);
  const now = Date.now();
  m.nextSpawnTime = now + 100000;
  const frames = [];
  m.tick(now, worlds, (f) => frames.push(f));
  assert.equal(m.state, 'warning');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, 'world_boss_warning');
  assert.ok(frames[0].text.includes('zzMagma Boss will emerge in 2 minutes'));
  assert.equal(frames[0].nearestWaypointId, 'wp_1');
});

test('spawns the catalog row into the sim at its catalog hitbox and stats', async () => {
  const m = await managerWith(catalogOf([bossRow()]));
  const entry = worldEntry('w1', 'Frozen Wastes');
  const worlds = new Map([['w1', entry]]);
  const now = Date.now();
  m.state = 'warning';
  m.nextSpawnTime = now - 1;
  const frames = [];
  m.tick(now, worlds, (f) => frames.push(f));

  assert.equal(m.state, 'active');
  const spawn = frames.find((f) => f.kind === 'world_boss_spawn');
  assert.ok(spawn.text.includes('zzMagma Boss has awakened at Frozen Wastes!'));
  const c = entry.world.creatures.get(m.bossCreatureId);
  assert.ok(c, 'the boss is in the real sim');
  assert.equal(c.bossTier, 'world');
  assert.equal(c.element, 'fire');
  assert.equal(c.name, 'zzMagma Boss');
  assert.equal(c.width, 96);
  assert.equal(c.height, 96);
  assert.equal(c.maxHp, 12000);
  assert.equal(c.damage, 42);
  assert.equal(c.level, 100);
});

// Review Focus 3.
test('idles without crashing when the catalog holds no world-tier rows', async () => {
  const m = await managerWith(catalogOf([]));
  const worlds = new Map([['w1', worldEntry()]]);
  const now = Date.now();
  m.nextSpawnTime = now + 1000;
  const frames = [];
  assert.doesNotThrow(() => m.tick(now, worlds, (f) => frames.push(f)));
  assert.equal(m.state, 'idle');
  assert.deepEqual(frames, []);
  assert.ok(m.nextSpawnTime > now + 1000, 'the empty rotation is pushed back, not retried every tick');
  assert.equal(m.forceSpawn(now, worlds, {}, () => {}), false);
  assert.equal(m.state, 'idle');
});

// Review Focus 2.
test('a renamed catalog row spawns under its new name', async () => {
  const m = await managerWith(catalogOf([bossRow({ name: 'zzRenamed Titan' })]));
  const entry = worldEntry();
  const worlds = new Map([['w1', entry]]);
  assert.equal(m.forceSpawn(Date.now(), worlds, {}, () => {}), true);
  assert.equal(m.getStatus().bossName, 'zzRenamed Titan');
  assert.equal(entry.world.creatures.get(m.bossCreatureId).name, 'zzRenamed Titan');
});

test('forceSpawn spawns the named boss, not the random pick', async () => {
  // rng () => 0 would pick the FIRST row; the name must win over it.
  const m = await managerWith(catalogOf([
    bossRow(), bossRow({ id: 902, name: 'zzFrost Boss', element: 'ice', attack_element: 'ice', hitbox_size: 80 }),
  ]));
  const entry = worldEntry();
  m.forceSpawn(Date.now(), new Map([['w1', entry]]), { bossName: 'zzFrost Boss' }, () => {});
  const c = entry.world.creatures.get(m.bossCreatureId);
  assert.equal(c.name, 'zzFrost Boss');
  assert.equal(c.width, 80);
});

test('getStatus exposes the live boss creature id', async () => {
  const m = await managerWith(catalogOf([bossRow()]));
  const entry = worldEntry();
  m.forceSpawn(Date.now(), new Map([['w1', entry]]), {}, () => {});
  const status = m.getStatus();
  assert.equal(status.bossCreatureId, m.bossCreatureId);
  assert.ok(entry.world.creatures.has(status.bossCreatureId));
});

test('a timed-out boss is removed from the sim, not left roaming untracked', async () => {
  const m = await managerWith(catalogOf([bossRow()]));
  const entry = worldEntry();
  const worlds = new Map([['w1', entry]]);
  const now = Date.now();
  m.forceSpawn(now, worlds, {}, () => {});
  const id = m.bossCreatureId;
  m.tick(now + m.bossLifetimeMs + 1, worlds, () => {});
  assert.equal(m.state, 'idle');
  assert.equal(entry.world.creatures.has(id), false);
});

test('refreshCatalog keeps the previous catalog when the loader throws', async () => {
  let fail = false;
  const m = await managerWith(async () => {
    if (fail) throw new Error('db down');
    return { bosses: [bossRow()], minionsByElement: new Map() };
  });
  fail = true;
  await m.refreshCatalog();
  assert.equal(m.catalog.bosses.length, 1);
});

test('onCreatureDeath gives guaranteed Legendary to Top 3 and Victor Boon to participants', async () => {
  const m = await managerWith(catalogOf([bossRow()]));
  const entry = worldEntry('w1', 'Molten Core');
  m.forceSpawn(Date.now(), new Map([['w1', entry]]), {}, () => {});
  const boss = {
    id: m.bossCreatureId, bossTier: 'world', name: 'zzMagma Boss', x: 500, y: 500,
    _playerDamage: new Map([['user_1', 4500], ['user_2', 3200], ['user_3', 2100], ['user_4', 1200], ['user_5', 400]]),
  };
  const drops = [];
  const frames = [];
  const result = await m.onCreatureDeath(entry, boss, 'user_1', {
    broadcastFn: (f) => frames.push(f),
    dropLegendaryFn: async (e, userId) => { drops.push(userId); },
  });
  assert.equal(result.slain, true);
  assert.deepEqual(drops, ['user_1', 'user_2', 'user_3']);
  for (const uid of ['user_1', 'user_2', 'user_3', 'user_4', 'user_5']) assert.equal(m.hasBuff(uid), true);
  assert.equal(m.hasBuff('user_999'), false);
  assert.ok(frames.find((f) => f.kind === 'world_boss_slain').text.includes('zzMagma Boss has been slain!'));
});

// The deleted constant used to be referenced by server.js without being
// imported -- every "Spawn <boss>" test-panel click threw ReferenceError.
test('nothing references the deleted WORLD_BOSS_CATALOG constant', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/authority/server.js'), 'utf8');
  assert.doesNotMatch(src, /WORLD_BOSS_CATALOG/);
});
```

Replace `backend/tests/world_boss_phase.test.js` entirely:

```js
// backend/tests/world_boss_phase.test.js
// SOMET-603 (S1): phase transitions on a catalog-spawned boss; phase minions
// hydrate from the Elemental Guard catalog row for the boss's element.
const test = require('node:test');
const assert = require('node:assert/strict');
const { WorldBossManager } = require('../src/authority/worldBoss');
const { CreatureSim } = require('../src/authority/creatures');

const bossRow = {
  id: 901, name: 'zzMagma Boss', color: '#ff4757', hp: 12000, max_hp: 12000, defense: 25,
  resistances: {}, faction: 'hostile', gold_min: 500, gold_max: 500, attack_element: 'fire',
  vfx: null, prompt: 'zz', boss_tier: 'world', element: 'fire', hitbox_size: 96, auras: null,
  xp_reward: 3500, base_damage: 42, display_width: 96, display_height: 96,
  behavior_name: null, abilities: null,
};
const minionRow = {
  ...bossRow, id: 911, name: 'zzFire Guard', hp: 1500, max_hp: 1500, defense: 15,
  boss_tier: null, hitbox_size: null, xp_reward: null, base_damage: 25, gold_min: 0, gold_max: 0,
  display_width: null, display_height: null,
};

async function spawned(minions) {
  const m = new WorldBossManager({
    bossIntervalMs: 600000, rng: () => 0,
    loadCatalog: async () => ({ bosses: [bossRow], minionsByElement: new Map(minions.map((r) => [r.element, r])) }),
  });
  await m.refreshCatalog();
  const sim = new CreatureSim({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }, () => 0.05);
  const entry = { worldId: 'w1', row: { name: 'Molten Core', width: 32, height: 32 }, waypoints: new Map(), world: { creatures: sim } };
  const worlds = new Map([['w1', entry]]);
  const now = Date.now();
  m.forceSpawn(now, worlds, {}, () => {});
  return { m, sim, worlds, now, boss: sim.get(m.bossCreatureId) };
}

test('phase 2 (Enraged) at 75% HP announces and speeds the boss up', async () => {
  const { m, worlds, now, boss } = await spawned([minionRow]);
  const before = boss.speed;
  boss.hp = 8000; // 66.6%
  const frames = [];
  m.tick(now + 1, worlds, (f) => frames.push(f));
  assert.equal(m.currentBoss.phase, 2);
  assert.equal(frames.find((f) => f.kind === 'world_boss_phase').phase, 2);
  assert.ok(boss.speed > before, `phase 2 must raise speed above ${before}, got ${boss.speed}`);
});

test('phase 3 at 50% HP spawns two minions hydrated from the element\'s catalog row', async () => {
  const { m, sim, worlds, now, boss } = await spawned([minionRow]);
  boss.hp = 6000;
  m.tick(now + 1, worlds, () => {});
  assert.equal(m.currentBoss.phase, 3);
  const minions = sim.all().filter((c) => c.type === 'zzFire Guard');
  assert.equal(minions.length, 2);
  for (const c of minions) {
    assert.equal(c.maxHp, 1500);
    assert.equal(c.bossTier, null, 'a minion is not a boss: its death must not end the event');
    assert.equal(c.width, 48);
    assert.equal(c.level, 80);
  }
});

// Review Focus 5.
test('a missing minion row spawns no minions and still advances the phase', async () => {
  const { m, sim, worlds, now, boss } = await spawned([]);
  boss.hp = 6000;
  assert.doesNotThrow(() => m.tick(now + 1, worlds, () => {}));
  assert.equal(m.currentBoss.phase, 3);
  assert.equal(sim.count(), 1, 'only the boss itself');
});
```

Create `backend/tests/world_boss_catalog_db.test.js`:

```js
// backend/tests/world_boss_catalog_db.test.js
// SOMET-603 (S1, spec §7): the manager spawns from the real entity_types rows
// the seed migration wrote, through the real hydration into a real sim.
// Read-only against the database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { WorldBossManager, loadWorldBossCatalog } = require('../src/authority/worldBoss');
const { CreatureSim } = require('../src/authority/creatures');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

test('the manager spawns world bosses from entity_types rows', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const catalog = await loadWorldBossCatalog(pool);
    assert.deepEqual(catalog.bosses.map((b) => b.name).sort(), [
      'Abyssor, the Voidreaver', 'Glacius, the Frost Leviathan',
      'Gorgon, the Thunder Titan', 'Ignis, the Magma Colossus',
    ]);
    assert.deepEqual([...catalog.minionsByElement.keys()].sort(), ['arcane', 'fire', 'ice', 'lightning']);

    const m = new WorldBossManager({ pool, rng: () => 0 });
    await m.refreshCatalog();
    const sim = new CreatureSim({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }, () => 0.05);
    const entry = { worldId: 'w1', row: { name: 'zz', width: 32, height: 32 }, waypoints: new Map(), world: { creatures: sim } };
    assert.equal(m.forceSpawn(Date.now(), new Map([['w1', entry]]), { bossName: 'Glacius, the Frost Leviathan' }), true);
    const c = sim.get(m.bossCreatureId);
    assert.equal(c.bossTier, 'world');
    assert.equal(c.element, 'ice');
    assert.equal(c.attackElement, 'ice');
    assert.equal(c.width, 96);
    assert.equal(c.maxHp, 14000);
    assert.equal(c.behavior.chaseStyle, 'charge', 'the Line profile resolved from the joined row');
  } finally {
    await pool.end();
  }
});
```

- [ ] **Step 2: Run them and confirm they FAIL**

Run: `cd $WT/backend && TEST_DATABASE_URL=$S1_DB DATABASE_URL=$S1_DB node --test tests/world_boss.test.js tests/world_boss_phase.test.js tests/world_boss_catalog_db.test.js; echo "exit=$?"`
Expected: FAIL with `TypeError: m.refreshCatalog is not a function` (and `loadWorldBossCatalog is not a function` in the DB test). The source-guard test fails on `/WORLD_BOSS_CATALOG/`. `exit=1`.

- [ ] **Step 3: Implement `CreatureSim#remove`** in `creatures.js`, right after `get(id) { … }` (line 1274):

```js
  // SOMET-603: SILENT removal (no death sfx, no kill accounting) for an
  // instance its owner retires -- a world boss that timed out or was
  // force-despawned. worldBoss.js and server.js's debug `slay` always called
  // creatures.remove(); it never existed, so those bosses stayed in the world.
  remove(id) { return this.creatures.delete(id); }
```

- [ ] **Step 4: Implement the manager in `worldBoss.js`**

Line 12, after the `rollItemInstance` import:

```js
const {
  hydrateCreatureRow, ENTITY_CATALOG_SELECT, CREATURE_SIZE, CREATURE_SPEED, CREATURE_DAMAGE,
} = require('./creatures.js');
```

Replace lines 19-72 (the whole `WORLD_BOSS_CATALOG` array) with:

```js
// SOMET-603 (S1): bosses are entity_types rows now (boss_tier = 'world');
// the JS catalog that used to live here is gone. Level and minion layout are
// event rules, not catalog data, so they stay here.
const WORLD_BOSS_LEVEL = 100;
const MINION_LEVEL = 80;
const MINION_OFFSETS = [[40, 40], [-40, -40]];
// Phase minions per boss element. Resolved BY NAME (the spec names these four
// rows); a renamed or deleted row means no minions for that element plus one
// log line per phase, never a crash.
const MINION_TYPE_BY_ELEMENT = Object.freeze({
  fire: 'Fire Elemental Guard',
  ice: 'Ice Elemental Guard',
  arcane: 'Arcane Elemental Guard',
  lightning: 'Lightning Elemental Guard',
});

async function loadWorldBossCatalog(pool) {
  const r = await pool.query(
    `${ENTITY_CATALOG_SELECT}
      WHERE e.is_creature = true AND (e.boss_tier = 'world' OR e.name = ANY($1::text[]))
      ORDER BY e.id ASC`,
    [Object.values(MINION_TYPE_BY_ELEMENT)],
  );
  const bosses = r.rows.filter((row) => row.boss_tier === 'world');
  const minionsByElement = new Map();
  for (const [element, name] of Object.entries(MINION_TYPE_BY_ELEMENT)) {
    const row = r.rows.find((x) => x.name === name && x.boss_tier !== 'world');
    if (row) minionsByElement.set(element, row);
  }
  return { bosses, minionsByElement };
}

// The event's view of one catalog row. `speed` is the sim's base speed: that is
// what the boss actually moves at (addCreatures has always forced
// CREATURE_SPEED), and the phase multipliers scale it.
function bossFromRow(row) {
  return {
    row,
    type: row.name,
    name: row.name,
    element: row.element || null,
    maxHp: Number(row.max_hp) || Number(row.hp) || 1,
    damage: Number.isFinite(Number(row.base_damage)) && row.base_damage != null
      ? Number(row.base_damage) : CREATURE_DAMAGE,
    defense: Number(row.defense) || 0,
    speed: CREATURE_SPEED,
    size: Number.isInteger(row.hitbox_size) ? row.hitbox_size : CREATURE_SIZE,
    xpReward: Number(row.xp_reward) || 0,
    goldReward: Number(row.gold_max) || 0,
    description: row.prompt || '',
  };
}
```

Constructor (lines 120-150): add `loadCatalog = null,` to the destructured options after `rng = Math.random,`, and at the end of the constructor body add:

```js
    // SOMET-603: catalog rows, refreshed at startup and after every rotation.
    // Injectable so unit tests need no database.
    this.loadCatalog = loadCatalog || (pool ? () => loadWorldBossCatalog(pool) : null);
    this.catalog = { bosses: [], minionsByElement: new Map() };
    this._warnedEmptyCatalog = false;
```

Add these methods right after the constructor:

```js
  // Never throws: a failed load keeps the previous catalog (the tick loop must
  // not lose a working rotation to one DB hiccup).
  async refreshCatalog() {
    if (!this.loadCatalog) return this.catalog;
    try {
      const next = await this.loadCatalog();
      if (next && Array.isArray(next.bosses)) {
        this.catalog = { bosses: next.bosses, minionsByElement: next.minionsByElement || new Map() };
        if (next.bosses.length > 0) this._warnedEmptyCatalog = false;
      }
    } catch (err) {
      console.error('[world boss] catalog load failed; keeping the previous catalog:', err);
    }
    return this.catalog;
  }

  _refreshInBackground() {
    if (this.loadCatalog) this.refreshCatalog();
  }

  // No world-tier rows: stay idle, try again next interval, say so once.
  _skipRotation(now) {
    this.state = 'idle';
    this.currentBoss = null;
    this.nextSpawnTime = now + this.bossIntervalMs;
    if (!this._warnedEmptyCatalog) {
      console.warn("[world boss] no entity_types rows with boss_tier = 'world'; rotation skipped");
      this._warnedEmptyCatalog = true;
    }
    this._refreshInBackground();
  }

  // Debug/test-panel spawn. Returns false (and stays idle) when the catalog is empty.
  forceSpawn(now, worlds, { bossName = null, preferredWorldId = null } = {}, broadcastFn = null) {
    if (this.state === 'active') this._despawnBoss(worlds, null, 'replaced');
    this.currentBoss = null;
    if (!this._planNextBoss(worlds, preferredWorldId, bossName)) {
      this.state = 'idle';
      return false;
    }
    this.state = 'warning';
    this.nextSpawnTime = now - 1;
    this._spawnBoss(now, worlds, broadcastFn);
    return true;
  }

  forceWarning(now, worlds, { bossName = null, seconds = 120 } = {}, broadcastFn = null) {
    if (this.state === 'active') this._despawnBoss(worlds, null, 'replaced');
    this.state = 'idle';
    this.currentBoss = null;
    this.nextSpawnTime = now + Math.max(0, Number(seconds) || 0) * 1000;
    if (!this._planNextBoss(worlds, null, bossName)) return false;
    this.tick(now, worlds, broadcastFn);
    return true;
  }
```

`_planNextBoss` (lines 153-155): replace the signature and first two lines with the following, and add `return true;` as the last statement of the method (after the closing `}` of the `if (worldEntries.length > 0) … else …` at line 229):

```js
  _planNextBoss(worlds, preferredWorldId = null, bossName = null) {
    const bosses = this.catalog.bosses;
    if (bosses.length === 0) {
      this.currentBoss = null;
      return false;
    }
    const named = bossName ? bosses.find((b) => b.name === bossName) : null;
    this.currentBoss = bossFromRow(named || bosses[Math.floor(this.rng() * bosses.length)]);
```

`getStatus` (line 241): directly after `bossName: …,` add:

```js
      bossCreatureId: this.bossCreatureId,
```

Replace `_spawnPhaseMinions` (lines 307-344) with:

```js
  _spawnPhaseMinions(creature, worldEntry) {
    if (!worldEntry || !worldEntry.world || !worldEntry.world.creatures || !worldEntry.world.creatures.addCreatures) return;
    const row = this.catalog.minionsByElement.get(this.currentBoss.element);
    if (!row) {
      console.warn(`[world boss] no minion row for element ${this.currentBoss.element}; phase minions skipped`);
      return;
    }
    const stamp = Date.now();
    const minions = MINION_OFFSETS.map(([dx, dy], i) => hydrateCreatureRow(row, {
      id: `wb_minion_${stamp}_${i + 1}`,
      x: creature.x + dx,
      y: creature.y + dy,
      level: MINION_LEVEL,
      hp: Number(row.max_hp) || Number(row.hp) || 1,
      damage: row.base_damage != null ? Number(row.base_damage) : CREATURE_DAMAGE,
    }));
    worldEntry.world.creatures.addCreatures(minions);
  }
```

`tick` idle branch (lines 380-397): replace

```js
      if (timeRemaining <= this.bossWarningMs) {
        this.state = 'warning';
        if (!this.currentBoss) this._planNextBoss(worlds);

        if (broadcastFn) {
```

with

```js
      if (timeRemaining <= this.bossWarningMs && !this.currentBoss && !this._planNextBoss(worlds)) {
        this._skipRotation(now);
      } else if (timeRemaining <= this.bossWarningMs) {
        this.state = 'warning';

        if (broadcastFn) {
```

(the rest of the block, including its closing braces, stays unchanged).

`_spawnBoss` (lines 443-444): replace

```js
  _spawnBoss(now, worlds, broadcastFn) {
    if (!this.currentBoss) this._planNextBoss(worlds);
```

with

```js
  _spawnBoss(now, worlds, broadcastFn) {
    if (!this.currentBoss && !this._planNextBoss(worlds)) {
      this._skipRotation(now);
      return;
    }
```

and replace the `bossCreature` literal (lines 477-495) with:

```js
      // SOMET-603: hydrated from the catalog row like every other creature, so
      // boss_tier/element/hitbox_size/behaviour/vfx arrive the one shared way.
      const bossCreature = hydrateCreatureRow(this.currentBoss.row, {
        id: cid,
        x: spawnX,
        y: spawnY,
        level: WORLD_BOSS_LEVEL,
        hp: this.currentBoss.maxHp,
        damage: this.currentBoss.damage,
      });
```

`_despawnBoss`: directly after `this.warningSent = false;` (line 533) add `this._refreshInBackground();`. Same in `onCreatureDeath` directly after `this.warningSent = false;` (line 673).

`onCreatureDeath` line 557: `creature.isWorldBoss` becomes `creature.bossTier === 'world'`:

```js
    if (creature && creature.bossTier !== 'world' && creature.id !== this.bossCreatureId) {
```

Exports (lines 743-753): replace `WORLD_BOSS_CATALOG,` with

```js
  loadWorldBossCatalog,
  bossFromRow,
  MINION_TYPE_BY_ELEMENT,
  WORLD_BOSS_LEVEL,
  MINION_LEVEL,
```

- [ ] **Step 5: Wire `server.js`**

Line 473-478: directly after the `new WorldBossManager({...});` statement add:

```js
  // SOMET-603: the rotation's bosses are catalog rows. Fire-and-forget:
  // refreshCatalog never rejects, and an empty catalog just idles the event.
  worldBossManager.refreshCatalog();
```

Line 915: `(deadCreature && deadCreature.isWorldBoss)` becomes `(deadCreature && deadCreature.bossTier === 'world')`.

Lines 2751-2772 (`spawn` and `warning` branches of `debugWorldBoss`): replace from `if (action === 'spawn') {` through the end of the `warning` branch (`worldBossManager.tick(now, worlds, broadcastAll);` and its closing `}`) with:

```js
      // SOMET-603: the boss is picked BY NAME from the catalog (bossIndex
      // referenced a JS constant server.js never imported -- every spawn
      // button threw ReferenceError -- and _planNextBoss overwrote the
      // choice anyway).
      const bossName = typeof msg.bossName === 'string' && msg.bossName !== '' ? msg.bossName : null;
      if (action === 'spawn') {
        if (!worldBossManager.forceSpawn(now, worlds, { bossName, preferredWorldId: ws.worldId }, broadcastAll)) {
          send(ws, { type: 'error', message: 'no world boss in the catalog' });
        }
      } else if (action === 'warning') {
        if (!worldBossManager.forceWarning(now, worlds, { bossName, seconds: Number(msg.seconds || 120) }, broadcastAll)) {
          send(ws, { type: 'error', message: 'no world boss in the catalog' });
        }
```

(the following `} else if (action === 'slay') {` stays unchanged).

Lines 2840-2843 (`teleport_to_boss`): replace

```js
        if (worldBossManager.state !== 'active' || !worldBossManager.activeWorldId) {
          worldBossManager._planNextBoss(worlds);
          worldBossManager._spawnBoss(now, worlds, broadcastAll);
        }
```

with

```js
        if (worldBossManager.state !== 'active' || !worldBossManager.activeWorldId) {
          if (!worldBossManager.forceSpawn(now, worlds, {}, broadcastAll)) {
            send(ws, { type: 'error', message: 'no world boss in the catalog' });
            return;
          }
        }
```

Line 47: run `grep -n "resolveArena" src/authority/server.js`. If line 47 is its only remaining occurrence, reduce the import to `const { WorldBossManager, dropLegendaryItemForPlayer } = require('./worldBoss');`.

- [ ] **Step 6: Update the test panel** (`WorldBossTestPanel.jsx` lines 544, 552, 560, 568):

```jsx
onClick={() => sendAction('spawn', { bossName: 'Ignis, the Magma Colossus' })}
onClick={() => sendAction('spawn', { bossName: 'Glacius, the Frost Leviathan' })}
onClick={() => sendAction('spawn', { bossName: 'Abyssor, the Voidreaver' })}
onClick={() => sendAction('spawn', { bossName: 'Gorgon, the Thunder Titan' })}
```

- [ ] **Step 7: Run the tests and the authority suite, confirm they PASS**

```bash
cd $WT/backend && TEST_DATABASE_URL=$S1_DB DATABASE_URL=$S1_DB node --test tests/world_boss.test.js tests/world_boss_phase.test.js tests/world_boss_catalog_db.test.js tests/authority_*.test.js; echo "exit=$?"
```
Expected: `exit=0`. Fake pools in `authority_*` tests now also receive the catalog SELECT at boot. A pool that throws on unknown SQL logs `[world boss] catalog load failed` but must not fail a test. If a test asserts an exact query sequence and fails on that extra query, answer it in that test's fake pool with `{ rows: [] }`. Do not remove the boot refresh.

- [ ] **Step 8: Commit**

```bash
cd $WT && git add backend/src/authority/creatures.js backend/src/authority/worldBoss.js backend/src/authority/server.js frontend/src/games/something2/WorldBossTestPanel.jsx backend/tests/world_boss.test.js backend/tests/world_boss_phase.test.js backend/tests/world_boss_catalog_db.test.js
git commit -m "feat(world-boss): catalog-driven rotation, hydrated bosses and minions (SOMET-603)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The wire carries bossTier, element, name and size, once

**Files:**
- Modify: `backend/src/authority/creatures.js:2457-2460` (`snapshotAOI` intro block)
- Modify: `frontend/src/games/something2/src/js/entities/CreatureManager.js:79-100`
- Test: `backend/tests/authority_boss_snapshot.test.js` (create), `frontend/src/games/something2/src/js/entities/__tests__/CreatureManager.boss.test.js` (create)

**Interfaces:**
- Produces (wire, intro record only): `bossTier`, `name` (only when `bossTier`), `element` (when non-null), `width`, `height` (only when ≠ 48). Ordinary creatures' records are byte-identical to today.
- Produces (client creature): `bossTier: string|null`, `element: string|null`, `name: string`, `width`, `height` (from the wire, else 48).

- [ ] **Step 1: Write the failing backend test**

```js
// backend/tests/authority_boss_snapshot.test.js
// SOMET-603: the client cannot draw a boss it is never told is a boss. Today
// the snapshot carries no width, name or tier, so the client sizes every boss
// at 48 and centres it 24px off its server box.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CreatureSim } = require('../src/authority/creatures.js');

const stubMap = () => ({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 });

test('a boss is introduced with its tier, element, name and size, then never again', () => {
  const s = new CreatureSim(stubMap(), () => 0.05);
  s.addCreatures([{ id: 'b', type: 'zzBoss', name: 'zzBoss', x: 100, y: 100, hp: 9000,
    bossTier: 'world', element: 'fire', hitboxSize: 96 }]);
  const known = new Set();
  const first = s.snapshotAOI(new Set(['0,0']), 0, 100, 100, 2400, known)[0];
  assert.equal(first.bossTier, 'world');
  assert.equal(first.element, 'fire');
  assert.equal(first.name, 'zzBoss');
  assert.equal(first.width, 96);
  assert.equal(first.height, 96);
  const second = s.snapshotAOI(new Set(['0,0']), 0, 100, 100, 2400, known)[0];
  for (const f of ['bossTier', 'element', 'name', 'width', 'height']) {
    assert.ok(!(f in second), `"${f}" is immutable and must not be re-sent every frame`);
  }
});

test('an ordinary creature\'s intro carries none of the boss fields', () => {
  const s = new CreatureSim(stubMap(), () => 0.05);
  s.addCreatures([{ id: 'w', type: 'Wolf', x: 100, y: 100, hp: 10, color: '#c0392b' }]);
  const first = s.snapshotAOI(new Set(['0,0']), 0, 100, 100, 2400, new Set())[0];
  for (const f of ['bossTier', 'element', 'name', 'width', 'height']) {
    assert.ok(!(f in first), `"${f}" must not cost bytes on every ordinary creature`);
  }
});
```

- [ ] **Step 2: Run it and confirm it FAILS**

Run: `cd $WT/backend && node --test tests/authority_boss_snapshot.test.js; echo "exit=$?"`
Expected: FAIL with `undefined !== 'world'`, `exit=1`.

- [ ] **Step 3: Implement.** In `snapshotAOI`, replace lines 2457-2460:

```js
      if (!known.has(c.id)) {
        row.type = c.type; row.color = c.color;
        row.maxHp = c.maxHp; row.level = c.level;
        // SOMET-603: immutable too, and sent only when they say something, so
        // an ordinary creature's intro is byte-identical to before.
        if (c.bossTier) { row.bossTier = c.bossTier; row.name = c.name; }
        if (c.element) row.element = c.element;
        if (c.width !== CREATURE_SIZE) { row.width = c.width; row.height = c.height; }
      }
```

- [ ] **Step 4: Run it, confirm it PASSES**

Run: `cd $WT/backend && node --test tests/authority_boss_snapshot.test.js tests/authority_creatures.test.js; echo "exit=$?"`
Expected: `exit=0` (the existing "second frame keys" test is unaffected because the new fields are intro-only).

- [ ] **Step 5: Write the failing frontend test**

```js
// frontend/src/games/something2/src/js/entities/__tests__/CreatureManager.boss.test.js
import { describe, it, expect } from "vitest";
import { CreatureManager } from "../CreatureManager.js";

describe("CreatureManager boss fields (SOMET-603)", () => {
  it("keeps tier, element, name and the server box size from the intro record", () => {
    const cm = new CreatureManager(null);
    cm.applySnapshot([{ id: "b", type: "zzBoss", name: "zzBoss", x: 0, y: 0, hp: 9, maxHp: 9,
      bossTier: "world", element: "ice", width: 96, height: 96 }]);
    const c = cm.all()[0];
    expect(c.bossTier).toBe("world");
    expect(c.element).toBe("ice");
    expect(c.name).toBe("zzBoss");
    expect(c.width).toBe(96);
    expect(c.height).toBe(96);
  });

  it("holds them on later frames that omit them", () => {
    const cm = new CreatureManager(null);
    cm.applySnapshot([{ id: "b", type: "zzBoss", name: "zzBoss", x: 0, y: 0, hp: 9, maxHp: 9,
      bossTier: "world", element: "ice", width: 96, height: 96 }]);
    cm.applySnapshot([{ id: "b", x: 5, y: 5, hp: 8, facing: "S", mode: "chase" }]);
    const c = cm.all()[0];
    expect(c.bossTier).toBe("world");
    expect(c.width).toBe(96);
  });

  it("an ordinary creature defaults to a 48 box, no tier, name = type", () => {
    const cm = new CreatureManager(null);
    cm.applySnapshot([{ id: "w", type: "Wolf", x: 0, y: 0, hp: 5, maxHp: 5 }]);
    const c = cm.all()[0];
    expect(c.width).toBe(48);
    expect(c.bossTier).toBe(null);
    expect(c.element).toBe(null);
    expect(c.name).toBe("Wolf");
  });
});
```

- [ ] **Step 6: Run it and confirm it FAILS**

Run: `cd $WT/frontend && npx vitest run src/games/something2/src/js/entities/__tests__/CreatureManager.boss.test.js; echo "exit=$?"`
Expected: FAIL with `expected undefined to be 'world'`, `exit=1`.

- [ ] **Step 7: Implement in `CreatureManager.js`.** In the `if (ex)` branch, after `if (c.color) ex.color = c.color;` (line 84):

```js
        // SOMET-603: boss fields are immutable intro fields too.
        if (c.bossTier !== undefined) ex.bossTier = c.bossTier;
        if (c.element !== undefined) ex.element = c.element;
        if (c.name !== undefined) ex.name = c.name;
        if (c.width !== undefined) { ex.width = c.width; ex.height = c.height; }
```

In the new-creature literal, replace `width: CREATURE_SIZE, height: CREATURE_SIZE,` (line 89) with:

```js
          // SOMET-603: the server box when it differs from the default (a
          // boss); drawEntity centres on x + width/2, so a wrong width puts
          // the sprite off its hitbox.
          width: c.width ?? CREATURE_SIZE, height: c.height ?? CREATURE_SIZE,
          name: c.name ?? c.type,
          bossTier: c.bossTier ?? null,
          element: c.element ?? null,
```

- [ ] **Step 8: Run all CreatureManager tests, confirm they PASS**

Run: `cd $WT/frontend && npx vitest run src/games/something2/src/js/entities; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 9: Commit**

```bash
cd $WT && git add backend/src/authority/creatures.js backend/tests/authority_boss_snapshot.test.js frontend/src/games/something2/src/js/entities/CreatureManager.js frontend/src/games/something2/src/js/entities/__tests__/CreatureManager.boss.test.js
git commit -m "feat(net): creature snapshot introduces boss tier, element, name and size (SOMET-603)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Render: art at boss size or procedural by element; no name matching anywhere

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js:3206-3336` (`_drawWorldBoss`), `:3338-3383` (`drawEntity` head and art branch)
- Create: `frontend/src/games/something2/src/js/core/worldBossMatch.js`
- Modify: `frontend/src/games/something2/src/js/core/Game.js:3493-3500`
- Test: `frontend/src/games/something2/src/js/systems/__tests__/bossRender.test.js` (create), `frontend/src/games/something2/src/js/core/__tests__/worldBossMatch.test.js` (create)

**Interfaces:**
- Produces: `RenderSystem.bossPalette(element) → {baseColor, glowColor, darkColor, eyeColor}` (static); `_drawEntityArt(e, drawX, drawY, w, h) → boolean`; `_drawBossPlate(e, drawX, drawY, w, s)`; `findWorldBossCreature(creatures: object[], status: object) → object|null`.
- Consumes: `status.bossCreatureId` (Task 6), creature `bossTier`/`element`/`name`/`width` (Task 7), entity-def `image`/`sprite`/`render_mode`/`displayWidth` (unchanged `_applyTypeVisuals`).

- [ ] **Step 1: Write the failing render test**

```js
// frontend/src/games/something2/src/js/systems/__tests__/bossRender.test.js
import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";

// Records drawImage/fillRect/fillText; implements only what drawEntity's boss
// and ordinary paths touch. _drawWorldBoss (the procedural body) is replaced
// per test with a recorder: what is under test is WHICH path runs.
function setup(images = {}) {
  const calls = [];
  const ctx = {
    imageSmoothingEnabled: true, globalAlpha: 1, fillStyle: "", strokeStyle: "", lineWidth: 1,
    font: "", textAlign: "", shadowColor: "", shadowBlur: 0,
    drawImage: (...args) => calls.push({ op: "drawImage", args }),
    fillRect: (...args) => calls.push({ op: "fillRect", args }),
    fillText: (text) => calls.push({ op: "fillText", text }),
    strokeText() {}, save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {},
    lineTo() {}, arc() {}, ellipse() {}, fill() {}, stroke() {},
  };
  const rs = new RenderSystem({ getContext: () => ctx }, { get: (k) => images[k] || null });
  const procedural = [];
  rs._drawWorldBoss = (e) => procedural.push(e.element);
  return { rs, calls, procedural };
}

const boss = (over = {}) => ({
  id: "b", type: "zzBoss", name: "zzBoss", bossTier: "world", element: "fire",
  x: 0, y: 0, width: 96, height: 96, hp: 10, maxHp: 10, ...over,
});

describe("boss rendering (SOMET-603)", () => {
  it("a boss with no art draws the procedural body, keyed on its element", () => {
    const { rs, procedural, calls } = setup();
    rs.drawEntity(boss({ element: "ice" }));
    expect(procedural).toEqual(["ice"]);
    expect(calls.some((c) => c.op === "fillText" && c.text.includes("[WORLD BOSS] zzBoss"))).toBe(true);
  });

  it("a boss with approved, loaded art draws it at display size and skips the procedural body", () => {
    const { rs, procedural, calls } = setup({ "img/boss.png": { width: 192, height: 192 } });
    rs.drawEntity(boss({ render_mode: "static", image: "img/boss.png", displayWidth: 160, displayHeight: 160 }));
    expect(procedural).toEqual([]);
    const img = calls.find((c) => c.op === "drawImage");
    expect(img).toBeTruthy();
    const [, , , dw, dh] = img.args;
    expect(dw).toBe(160);
    expect(dh).toBe(160);
    expect(calls.some((c) => c.op === "fillText" && c.text.includes("[WORLD BOSS] zzBoss"))).toBe(true);
  });

  // Review Focus 4.
  it("art approved but the image failed to load falls back to the procedural body", () => {
    const { rs, procedural, calls } = setup({}); // ImageManager.get -> null
    rs.drawEntity(boss({ render_mode: "static", image: "img/missing.png", displayWidth: 160, displayHeight: 160 }));
    expect(procedural).toEqual(["fire"]);
    expect(calls.some((c) => c.op === "drawImage")).toBe(false);
  });

  it("a dungeon-tier boss gets the generic boss plate", () => {
    const { rs, calls } = setup();
    rs.drawEntity(boss({ bossTier: "dungeon_end", name: "zzEnd Boss" }));
    expect(calls.some((c) => c.op === "fillText" && c.text.includes("[BOSS] zzEnd Boss"))).toBe(true);
  });

  it("an untiered creature whose name sounds like a boss is NOT drawn as one", () => {
    const { rs, procedural } = setup();
    rs.drawEntity({ id: "t", type: "Gorgon, the Thunder Titan", name: "Gorgon, the Thunder Titan",
      x: 0, y: 0, width: 48, height: 48, color: "#888" });
    expect(procedural).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it FAILS**

Run: `cd $WT/frontend && npx vitest run src/games/something2/src/js/systems/__tests__/bossRender.test.js; echo "exit=$?"`
Expected: FAIL. The first test gets `expected [] to deeply equal [ 'ice' ]` (today `isBoss` needs `isWorldBoss` or a name substring). The last test gets `expected [ undefined ] to deeply equal []` (today "Titan" triggers the boss path). `exit=1`.

- [ ] **Step 3: Implement in `RenderSystem.js`**

Add a static palette helper next to `resolveRenderMode` (after line 186):

```js
  // SOMET-603: the procedural boss colours, keyed on the catalog element --
  // never guessed from the name. Unknown/absent element = the fire palette
  // (the old default branch).
  static bossPalette(element) {
    if (element === "ice") return { baseColor: "#70a1ff", glowColor: "#e0f2fe", darkColor: "#1e293b", eyeColor: "#67e8f9" };
    if (element === "arcane" || element === "void") return { baseColor: "#a55eea", glowColor: "#f3e8ff", darkColor: "#180a24", eyeColor: "#f472b6" };
    if (element === "lightning") return { baseColor: "#ffd166", glowColor: "#ffffff", darkColor: "#261e0b", eyeColor: "#67e8f9" };
    return { baseColor: "#ff4757", glowColor: "#ffa502", darkColor: "#2f3542", eyeColor: "#ffeaa7" };
  }
```

In `_drawWorldBoss`, replace lines 3209-3231 (the `const elem = …` name-guess line and the four `let …Color` declarations with their `if/else` chain) with:

```js
    const { baseColor, glowColor, darkColor, eyeColor } = RenderSystem.bossPalette(e.element);
```

Delete steps 7 and 8 at the end of `_drawWorldBoss` (lines 3323-3335, from `// 7. Boss Skull Nameplate Tag` through the `_drawHpBar` call). They move into `_drawBossPlate`, so `_drawWorldBoss` now ends right after the `ctx.restore();` at line 3321. Add directly after `_drawWorldBoss`:

```js
  // SOMET-603: nameplate + always-on HP bar, drawn for EVERY boss whether its
  // body came from approved art or from the procedural fallback.
  _drawBossPlate(e, drawX, drawY, w, s) {
    const ctx = this.ctx;
    const { baseColor } = RenderSystem.bossPalette(e.element);
    const tag = e.bossTier === "world" ? "[WORLD BOSS]" : "[BOSS]";
    ctx.save();
    ctx.font = "bold 14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = baseColor;
    ctx.shadowBlur = 10;
    ctx.fillText(`☠️ ${tag} ${e.name || e.type || "Boss"}`, s.x, drawY - 24);
    ctx.restore();
    const maxHp = e.maxHp || 1;
    this._drawHpBar(drawX, drawY - 6, w, e.hp != null ? e.hp : maxHp, maxHp);
  }

  // The sprite-or-image half of drawEntity, shared by bosses and everything
  // else. Returns true when it drew, false when the caller must supply its own
  // fallback (a rectangle, or a boss's procedural body).
  _drawEntityArt(e, drawX, drawY, w, h) {
    const mode = RenderSystem.resolveRenderMode(e, this.renderModeOverride);
    // Preferred sprite path: crop a frame out of the generated atlas.
    const sprite = RenderSystem.resolveSprite(e, this.imageManager, mode, this.nowMs);
    if (sprite) {
      const [sx, sy, sw, sh] = sprite.crop;
      // SOMET-569: the FRAME's dimensions decide the fit, not the atlas's.
      const r = fitSpriteRect(sw, sh, drawX, drawY, w, h);
      this.ctx.drawImage(sprite.img, sx, sy, sw, sh, r.dx, r.dy, r.dw, r.dh);
      return true;
    }
    // Legacy single-image fallback (whole image) still honored in sprite modes.
    const img = mode !== "rect" && e.image && this.imageManager
      ? this.imageManager.get(e.image)
      : null;
    if (!img) return false;
    // SOMET-569: fit, do not stretch.
    const r = fitSpriteRect(img.width, img.height, drawX, drawY, w, h);
    this.ctx.drawImage(img, r.dx, r.dy, r.dw, r.dh);
    return true;
  }
```

Replace `drawEntity` lines 3338-3383 (from `drawEntity(e) {` through the closing `}` of the `if (sprite) … else …` block, i.e. everything before `// HP bar for damaged actors.`) with:

```js
  drawEntity(e) {
    // SOMET-603: `bossTier` is the ONE boss flag. The old test also matched
    // name substrings ('Colossus', 'Titan', ...), which a renamed boss would
    // fail and any ordinary creature with such a name would trip.
    const isBoss = Boolean(e.bossTier);
    const fallback = isBoss ? 96 : 40;
    // Display size first (approved art is drawn at display_width/height),
    // then the server box, then the default.
    const w = e.displayWidth || e.width || fallback;
    const h = e.displayHeight || e.height || fallback;
    const s = worldToScreen(e.x + (e.width || w) / 2, e.y + (e.height || h) / 2);
    const drawX = s.x - w / 2;
    const drawY = s.y - h;

    // Creatures render through this path in renderChunked (buildDrawables'
    // "entity" kind), so their status rings belong here too. Map decorations
    // never carry `effects`, so this is a no-op for them.
    this._drawEffectRings(s.x, drawY + h, w, e.effects);

    if (isBoss) {
      if (!this._drawEntityArt(e, drawX, drawY, w, h)) this._drawWorldBoss(e, drawX, drawY, w, h, s);
      this._drawBossPlate(e, drawX, drawY, w, s);
      this._drawEffectPips(drawX, drawY, e.effects);
      return;
    }

    if (!this._drawEntityArt(e, drawX, drawY, w, h)) {
      // Degrade to a rectangle so a missing asset never leaves a hole.
      this.ctx.fillStyle = e.color || "#c0392b";
      this.ctx.fillRect(drawX, drawY, w, h);
    }
```

(The remainder of `drawEntity`, from `// HP bar for damaged actors.` through `this._drawEffectPips(...)`, is unchanged.)

- [ ] **Step 4: Run it, confirm it PASSES, run the other render tests**

Run: `cd $WT/frontend && npx vitest run src/games/something2/src/js/systems; echo "exit=$?"`
Expected: `exit=0` (`spriteAnchor`, `decorationRender`, `pointArtRender`, `renderMode` unchanged in behaviour).

- [ ] **Step 5: Write the failing HUD-matching test**

```js
// frontend/src/games/something2/src/js/core/__tests__/worldBossMatch.test.js
import { describe, it, expect } from "vitest";
import { findWorldBossCreature } from "../worldBossMatch.js";

describe("findWorldBossCreature (SOMET-603)", () => {
  // Review Focus 2: a renamed row must still be found.
  it("matches by the server's bossCreatureId even when the name changed", () => {
    const all = [{ id: "x", name: "Old Name" }, { id: "wb_1", name: "zzRenamed", bossTier: "world" }];
    expect(findWorldBossCreature(all, { bossCreatureId: "wb_1", bossName: "Old Name" }).id).toBe("wb_1");
  });

  it("falls back to the one world-tier creature when the id is absent", () => {
    const all = [{ id: "a" }, { id: "b", bossTier: "world" }];
    expect(findWorldBossCreature(all, { bossName: "whatever" }).id).toBe("b");
  });

  it("never matches by name", () => {
    const all = [{ id: "a", name: "Ignis, the Magma Colossus", type: "Ignis, the Magma Colossus" }];
    expect(findWorldBossCreature(all, { bossName: "Ignis, the Magma Colossus" })).toBe(null);
  });

  it("a dungeon boss is not the world boss", () => {
    expect(findWorldBossCreature([{ id: "d", bossTier: "dungeon_end" }], {})).toBe(null);
  });
});
```

- [ ] **Step 6: Run it and confirm it FAILS**

Run: `cd $WT/frontend && npx vitest run src/games/something2/src/js/core/__tests__/worldBossMatch.test.js; echo "exit=$?"`
Expected: FAIL with `Failed to resolve import "../worldBossMatch.js"`, `exit=1`.

- [ ] **Step 7: Implement.** Create `frontend/src/games/something2/src/js/core/worldBossMatch.js`:

```js
// SOMET-603: which rendered creature is the active world boss. By the
// server's creature id first, then by tier -- never by name: an admin can
// rename the catalog row, and an ordinary creature can share a word with it.
export function findWorldBossCreature(creatures, status) {
  if (!status || !Array.isArray(creatures)) return null;
  if (status.bossCreatureId) {
    const byId = creatures.find((c) => c.id === status.bossCreatureId);
    if (byId) return byId;
  }
  return creatures.find((c) => c.bossTier === "world") || null;
}
```

In `Game.js`, add `import { findWorldBossCreature } from "./worldBossMatch.js";` next to the other `./` imports at the top of the file. Replace lines 3496-3500:

```js
            const all = this.creatures.all();
            const bossCreature = all.find(
                (c) => c.isWorldBoss ||
                       c.id === this.worldBossStatus.bossCreatureId ||
                       (this.worldBossStatus.bossName && (c.name === this.worldBossStatus.bossName || c.type === this.worldBossStatus.bossName))
            );
```

with

```js
            const bossCreature = findWorldBossCreature(this.creatures.all(), this.worldBossStatus);
```

- [ ] **Step 8: Run both tests and the whole game dir, confirm they PASS**

Run: `cd $WT/frontend && npx vitest run src/games/something2/src/js; echo "exit=$?"`
Expected: `exit=0`. Also `grep -rn "Colossus\|Leviathan\|Voidreaver\|isWorldBoss" $WT/frontend/src/games/something2/src/js --include=*.js | grep -v __tests__` must print nothing.

- [ ] **Step 9: Commit**

```bash
cd $WT && git add frontend/src/games/something2/src/js/systems/RenderSystem.js frontend/src/games/something2/src/js/systems/__tests__/bossRender.test.js frontend/src/games/something2/src/js/core/worldBossMatch.js frontend/src/games/something2/src/js/core/__tests__/worldBossMatch.test.js frontend/src/games/something2/src/js/core/Game.js
git commit -m "feat(render): boss art at display size or procedural by element, no name matching (SOMET-603)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Entities tab: Boss tier, Element, Hitbox, XP reward, Base damage, Boss badge

**Files:**
- Modify: `backend/src/index.js:33` (import), `:751-790` (`entityTypeFieldError`), `:803-863` (POST), `:865-1071` (PUT)
- Modify tests: `backend/tests/entityTypeFieldError.test.js` (append), `backend/tests/entityTypes.test.js` (append)
- Create: `frontend/src/games/something2/bossFields.js`, `frontend/src/games/something2/__tests__/bossFields.test.js`
- Modify: `frontend/src/games/something2/EntityTypesAdmin.jsx:886`, `:964-969`, `:1009-1011`, `:1043-1045`, `:1075`, `:1089-1095`, `:1197-1200`, `:1402`

**Interfaces:**
- Produces (API): POST/PUT `/api/entity-types` accept `boss_tier`, `element`, `hitbox_size`, `xp_reward`, `base_damage`. On PUT, an ABSENT key leaves the column alone and an explicit `null` clears it (the `point_kind` CASE pattern). `attack_element` accepts `arcane`.
- Produces (frontend): `BOSS_TIERS`, `BOSS_TIER_LABELS`, `ENTITY_ELEMENTS`, `BOSS_FORM_DEFAULTS`, `bossFieldsFromEntity(entity)`, `bossFieldsPayload(formData)`, `bossFieldError(formData) → string|null`, `bossBadgeLabel(entity) → string|null`.
- Auras multi-select (spec §5) is S3's. S1 does not show `auras`.

- [ ] **Step 1: Write the failing backend tests.** Append to `tests/entityTypeFieldError.test.js`:

```js
// SOMET-603: the boss fields.
test('boss fields: null and valid values pass, arcane attack passes', () => {
  assert.equal(entityTypeFieldError({ ...VALID, boss_tier: null, element: null, hitbox_size: null, xp_reward: null, base_damage: null }), null);
  assert.equal(entityTypeFieldError({ ...VALID, boss_tier: 'world', element: 'arcane', hitbox_size: 96, xp_reward: 0, base_damage: 42.5 }), null);
  assert.equal(entityTypeFieldError({ ...VALID, boss_tier: 'dungeon_elite' }), null);
  assert.equal(entityTypeFieldError({ ...VALID, attack_element: 'arcane' }), null);
});

for (const [field, bad] of [
  ['boss_tier', 'raid'], ['element', 'plasma'],
  ['hitbox_size', 0], ['hitbox_size', 401], ['hitbox_size', 12.5], ['hitbox_size', '96'],
  ['xp_reward', -1], ['xp_reward', 1.5], ['base_damage', -1], ['base_damage', 'x'],
]) {
  test(`rejects ${field} = ${JSON.stringify(bad)}`, () => {
    assert.match(entityTypeFieldError({ ...VALID, [field]: bad }) || '', new RegExp(field));
  });
}
```

Append to `tests/entityTypes.test.js`:

```js
// SOMET-603: the boss columns travel on POST and PUT; an absent key on PUT
// must leave the stored value alone (same rule as point_kind / behavior_id).
function flagFor(sql, params, column) {
  const m = new RegExp(`\\b${column}\\s*=\\s*CASE WHEN \\$(\\d+)::boolean`, 'i').exec(sql);
  assert.ok(m, `UPDATE does not guard '${column}' with a was-it-sent flag`);
  return params[Number(m[1]) - 1];
}

test('POST /api/entity-types binds the boss columns', async () => {
  let params = null, sql = null;
  __setPool({ query: withAuth(async (s, p) => { sql = s; params = p; return { rows: [{ id: 1 }] }; }) });
  const res = await request(app).post('/api/entity-types').set(...AUTH).send({
    name: 'zzBossPost', color: '#f00', is_creature: true,
    boss_tier: 'world', element: 'fire', hitbox_size: 96, xp_reward: 3500, base_damage: 42,
  });
  assert.equal(res.status, 201);
  assert.equal(paramFor(sql, params, 'boss_tier'), 'world');
  assert.equal(paramFor(sql, params, 'element'), 'fire');
  assert.equal(paramFor(sql, params, 'hitbox_size'), 96);
  assert.equal(paramFor(sql, params, 'xp_reward'), 3500);
  assert.equal(paramFor(sql, params, 'base_damage'), 42);
});

test('PUT /api/entity-types/:id writes sent boss fields and leaves absent ones alone', async () => {
  let sql = null, params = null;
  __setPool(putMock('zzBossPut', async (s, p) => { sql = s; params = p; return { rows: [{ id: 5 }] }; }));
  const res = await request(app).put('/api/entity-types/5').set(...AUTH).send({
    name: 'zzBossPut', color: '#f00', boss_tier: 'world', hitbox_size: null,
  });
  assert.equal(res.status, 200);
  assert.equal(flagFor(sql, params, 'boss_tier'), true);
  assert.equal(paramFor(sql, params, 'boss_tier'), 'world');
  assert.equal(flagFor(sql, params, 'hitbox_size'), true, 'an explicit null is a clear, not an omission');
  assert.equal(paramFor(sql, params, 'hitbox_size'), null);
  for (const col of ['element', 'xp_reward', 'base_damage']) {
    assert.equal(flagFor(sql, params, col), false, `${col} was not sent and must be left alone`);
  }
  assert.equal(params[params.length - 1], '5', 'id stays the last param');
});
```

- [ ] **Step 2: Run them and confirm they FAIL**

Run: `cd $WT/backend && node --test tests/entityTypeFieldError.test.js tests/entityTypes.test.js; echo "exit=$?"`
Expected: FAIL. `rejects boss_tier = "raid"` fails with `The input did not match the regular expression /boss_tier/. Input: ''`. The arcane test fails with `'attack_element must be one of physical, fire, ice, lightning' !== null`. The POST test fails with `INSERT has no column 'boss_tier'`. `exit=1`.

- [ ] **Step 3: Implement the backend**

`index.js` line 33 becomes `const { ABILITIES_LATERAL, BOSS_TIERS } = require('./authority/creatures');`.

Directly above `function entityTypeFieldError(body) {` (line 751) add:

```js
// SOMET-603: entity_types_attack_element_check now includes 'arcane'
// (Abyssor). creature_abilities' own CHECK does not, which is why this is a
// separate list rather than an edit to creatureBehaviors.ELEMENTS.
const ENTITY_ATTACK_ELEMENTS = [...ELEMENTS, 'arcane'];
```

Replace lines 759-761 (the `attack_element` check) with:

```js
  if (body.attack_element != null && !ENTITY_ATTACK_ELEMENTS.includes(body.attack_element)) {
    return `attack_element must be one of ${ENTITY_ATTACK_ELEMENTS.join(', ')}`;
  }
  // SOMET-603: the boss fields. Each mirrors its DB constraint so a bad value
  // is a readable 400 naming the field, never a raw 500.
  if (body.boss_tier != null && !BOSS_TIERS.includes(body.boss_tier)) {
    return `boss_tier must be one of ${BOSS_TIERS.join(', ')} or null`;
  }
  if (body.element != null && !ITEM_ELEMENTS.includes(body.element)) {
    return `element must be one of ${ITEM_ELEMENTS.join(', ')} or null`;
  }
  if (body.hitbox_size != null && (!Number.isInteger(body.hitbox_size)
      || body.hitbox_size < 1 || body.hitbox_size > MAX_ENTITY_DISPLAY_PX)) {
    return `hitbox_size must be an integer between 1 and ${MAX_ENTITY_DISPLAY_PX}`;
  }
  if (body.xp_reward != null && (!Number.isInteger(body.xp_reward) || body.xp_reward < 0)) {
    return 'xp_reward must be a non-negative integer';
  }
  if (body.base_damage != null && (typeof body.base_damage !== 'number'
      || !Number.isFinite(body.base_damage) || body.base_damage < 0)) {
    return 'base_damage must be a non-negative number';
  }
```

(`ITEM_ELEMENTS` is a module-level `let` declared at line 1160. It is read at call time, after the module has fully loaded, so this is safe.)

POST (lines 805-853): add `, boss_tier, element, hitbox_size, xp_reward, base_damage` to the destructuring after `point_kind`. Extend the INSERT column list `…, ai_provider_id, point_kind` to `…, ai_provider_id, point_kind, boss_tier, element, hitbox_size, xp_reward, base_damage`. Extend VALUES with `, $30, $31, $32, $33, $34`. Append to the params array after `point_kind ?? null`:

```js
        boss_tier ?? null, element ?? null, hitbox_size ?? null, xp_reward ?? null, base_damage ?? null
```

PUT (lines 867-1069): add the same five names to the destructuring. In the UPDATE SQL, replace

```sql
        point_kind = CASE WHEN $31::boolean THEN $32 ELSE entity_types.point_kind END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $33 RETURNING *`,
```

with

```sql
        point_kind = CASE WHEN $31::boolean THEN $32 ELSE entity_types.point_kind END,
        boss_tier = CASE WHEN $33::boolean THEN $34::text ELSE entity_types.boss_tier END,
        element = CASE WHEN $35::boolean THEN $36::text ELSE entity_types.element END,
        hitbox_size = CASE WHEN $37::boolean THEN $38::integer ELSE entity_types.hitbox_size END,
        xp_reward = CASE WHEN $39::boolean THEN $40::integer ELSE entity_types.xp_reward END,
        base_damage = CASE WHEN $41::boolean THEN $42::real ELSE entity_types.base_damage END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $43 RETURNING *`,
```

and change the last params line `behaviorIdProvided, pinSent, pin.mode, pin.id, pointKindProvided, point_kind ?? null, id` to:

```js
        behaviorIdProvided, pinSent, pin.mode, pin.id, pointKindProvided, point_kind ?? null,
        // SOMET-603: present-in-body flags, same reason as pointKindProvided:
        // the form clears a field by sending null, which a COALESCE would eat.
        'boss_tier' in req.body, boss_tier ?? null,
        'element' in req.body, element ?? null,
        'hitbox_size' in req.body, hitbox_size ?? null,
        'xp_reward' in req.body, xp_reward ?? null,
        'base_damage' in req.body, base_damage ?? null,
        id
```

- [ ] **Step 4: Run the backend tests, confirm they PASS**

Run: `cd $WT/backend && TEST_DATABASE_URL=$S1_DB DATABASE_URL=$S1_DB node --test tests/entityTypeFieldError.test.js tests/entityTypes.test.js tests/creature_behaviors_api_db.test.js tests/entityTypeRenameCascade_db.test.js; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 5: Write the failing frontend test**

```js
// frontend/src/games/something2/__tests__/bossFields.test.js
import { describe, it, expect } from "vitest";
import {
  bossFieldsFromEntity, bossFieldsPayload, bossFieldError, bossBadgeLabel,
} from "../bossFields.js";

describe("boss fields form rules (SOMET-603)", () => {
  it("an entity with no boss data loads as empty inputs, not 0 or 'null'", () => {
    expect(bossFieldsFromEntity({ boss_tier: null, element: null, hitbox_size: null, xp_reward: null, base_damage: null }))
      .toEqual({ boss_tier: "", element: "", hitbox_size: "", xp_reward: "", base_damage: "" });
  });

  it("empty inputs travel as explicit nulls (a clear), every key always sent", () => {
    expect(bossFieldsPayload({ boss_tier: "", element: "", hitbox_size: "", xp_reward: Number.NaN, base_damage: "" }))
      .toEqual({ boss_tier: null, element: null, hitbox_size: null, xp_reward: null, base_damage: null });
  });

  it("filled inputs travel as values", () => {
    expect(bossFieldsPayload({ boss_tier: "world", element: "ice", hitbox_size: 96, xp_reward: 3800, base_damage: 35 }))
      .toEqual({ boss_tier: "world", element: "ice", hitbox_size: 96, xp_reward: 3800, base_damage: 35 });
  });

  it("rejects an out-of-range hitbox, a negative xp and a negative damage", () => {
    expect(bossFieldError({ hitbox_size: 0 })).toMatch(/Hitbox/);
    expect(bossFieldError({ hitbox_size: 401 })).toMatch(/Hitbox/);
    expect(bossFieldError({ xp_reward: -1 })).toMatch(/XP/);
    expect(bossFieldError({ base_damage: -2 })).toMatch(/Damage/);
    expect(bossFieldError({ hitbox_size: "", xp_reward: "", base_damage: "" })).toBe(null);
  });

  it("badges a boss row by tier and nothing else", () => {
    expect(bossBadgeLabel({ boss_tier: "world" })).toBe("World boss");
    expect(bossBadgeLabel({ boss_tier: "dungeon_elite" })).toBe("Dungeon mini-boss (Elite)");
    expect(bossBadgeLabel({ boss_tier: null, name: "Ignis, the Magma Colossus" })).toBe(null);
  });
});
```

- [ ] **Step 6: Run it and confirm it FAILS**

Run: `cd $WT/frontend && npx vitest run src/games/something2/__tests__/bossFields.test.js; echo "exit=$?"`
Expected: FAIL with `Failed to resolve import "../bossFields.js"`, `exit=1`.

- [ ] **Step 7: Implement `bossFields.js`**

```js
// SOMET-603: pure rules behind the entity editor's boss fields, kept out of
// EntityTypesAdmin.jsx so a test can reach them (that suite has no DOM).
// The server re-validates every one of these (index.js entityTypeFieldError).
export const BOSS_TIERS = ["world", "dungeon_end", "dungeon_elite"];
export const BOSS_TIER_LABELS = {
  world: "World boss",
  dungeon_end: "Dungeon boss (End)",
  dungeon_elite: "Dungeon mini-boss (Elite)",
};
// The seeded `elements` table. The server validates against the live table.
export const ENTITY_ELEMENTS = ["physical", "arcane", "fire", "ice", "lightning"];
export const BOSS_FORM_DEFAULTS = Object.freeze({
  boss_tier: "", element: "", hitbox_size: "", xp_reward: "", base_damage: "",
});

const blankToNull = (v) => (v === "" || v == null || Number.isNaN(v) ? null : v);

export function bossFieldsFromEntity(entity) {
  return {
    boss_tier: entity?.boss_tier ?? "",
    element: entity?.element ?? "",
    hitbox_size: entity?.hitbox_size ?? "",
    xp_reward: entity?.xp_reward ?? "",
    base_damage: entity?.base_damage ?? "",
  };
}

// Every key, always: the PUT treats an absent key as "leave alone" and null
// as "clear", and an emptied input means clear.
export function bossFieldsPayload(f) {
  return {
    boss_tier: blankToNull(f.boss_tier),
    element: blankToNull(f.element),
    hitbox_size: blankToNull(f.hitbox_size),
    xp_reward: blankToNull(f.xp_reward),
    base_damage: blankToNull(f.base_damage),
  };
}

export function bossFieldError(f) {
  const hb = blankToNull(f.hitbox_size);
  if (hb != null && (!Number.isInteger(hb) || hb < 1 || hb > 400)) return "Hitbox Size must be an integer between 1 and 400";
  const xp = blankToNull(f.xp_reward);
  if (xp != null && (!Number.isInteger(xp) || xp < 0)) return "XP Reward must be a non-negative integer";
  const dmg = blankToNull(f.base_damage);
  if (dmg != null && (!Number.isFinite(dmg) || dmg < 0)) return "Base Damage must be a non-negative number";
  return null;
}

export function bossBadgeLabel(entity) {
  return (entity && BOSS_TIER_LABELS[entity.boss_tier]) || null;
}
```

- [ ] **Step 8: Wire `EntityTypesAdmin.jsx`**

Add `import { BOSS_TIERS, BOSS_TIER_LABELS, ENTITY_ELEMENTS, BOSS_FORM_DEFAULTS, bossFieldsFromEntity, bossFieldsPayload, bossFieldError, bossBadgeLabel } from './bossFields.js';` with the other local imports.

Line 886: `const ATTACK_ELEMENTS = ['physical', 'arcane', 'fire', 'ice', 'lightning'];` (update the comment above it to "migration 1714440670000").

Initial state (after `point_kind: null` at line 969), new-entity branch (after `point_kind: null,` at line 1044): add `...BOSS_FORM_DEFAULTS,`. Edit branch (after `point_kind: editingEntity.point_kind ?? null,` at line 1011): add `...bossFieldsFromEntity(editingEntity),`.

`handleSubmit` line 1075: `const problem = validateEntityType(formData) || bossFieldError(formData);`. In `body` (lines 1089-1095), add `...bossFieldsPayload(formData),` after `display_height: optionalPx(rest.display_height),`.

Badge, after the `point_kind` span (line 1200):

```jsx
                {bossBadgeLabel(entity) ? (
                  <span style={{ fontSize: '1.1rem', opacity: 0.8 }}>{` · ${bossBadgeLabel(entity)}`}</span>
                ) : null}
```

Fields: inside the `{formData.is_creature && (…)}` block, directly after the Behavior/Attack Element `</div>` (line 1402), add:

```jsx
              {formData.is_creature && (
                <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
                  <FormGroup style={{ flex: 1 }}>
                    <label>Boss Tier</label>
                    <select value={formData.boss_tier} onChange={e => setFormData({ ...formData, boss_tier: e.target.value })}>
                      <option value="">— not a boss —</option>
                      {BOSS_TIERS.map(t => <option key={t} value={t}>{BOSS_TIER_LABELS[t]}</option>)}
                    </select>
                  </FormGroup>
                  <FormGroup style={{ flex: 1 }}>
                    <label>Element</label>
                    <select value={formData.element} onChange={e => setFormData({ ...formData, element: e.target.value })}>
                      <option value="">— none —</option>
                      {ENTITY_ELEMENTS.map(el => <option key={el} value={el}>{el}</option>)}
                    </select>
                  </FormGroup>
                  <FormGroup>
                    <label>Hitbox Size</label>
                    <input type="number" placeholder="48 (default)" value={formData.hitbox_size}
                      onChange={e => setFormData({ ...formData, hitbox_size: e.target.value === '' ? '' : parseInt(e.target.value, 10) })} />
                  </FormGroup>
                  <FormGroup>
                    <label>XP Reward</label>
                    <input type="number" placeholder="none" value={formData.xp_reward}
                      onChange={e => setFormData({ ...formData, xp_reward: e.target.value === '' ? '' : parseInt(e.target.value, 10) })} />
                  </FormGroup>
                  <FormGroup>
                    <label>Base Damage</label>
                    <input type="number" step="0.5" placeholder="default" value={formData.base_damage}
                      onChange={e => setFormData({ ...formData, base_damage: e.target.value === '' ? '' : parseFloat(e.target.value) })} />
                  </FormGroup>
                </div>
              )}
```

- [ ] **Step 9: Run the frontend tests, confirm they PASS**

Run: `cd $WT/frontend && npx vitest run src/games/something2/__tests__; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 10: Commit**

```bash
cd $WT && git add backend/src/index.js backend/tests/entityTypeFieldError.test.js backend/tests/entityTypes.test.js frontend/src/games/something2/bossFields.js frontend/src/games/something2/__tests__/bossFields.test.js frontend/src/games/something2/EntityTypesAdmin.jsx
git commit -m "feat(admin): Entities tab boss tier, element, hitbox, XP, damage fields and badge (SOMET-603)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Full suites + browser verification on an isolated second instance

**Files:**
- Create (NOT committed, delete after): `frontend/vite.verify.config.mjs`
- No source changes. A defect found here goes back to its owning task as a RED test first.

**Interfaces:** consumes everything above.

- [ ] **Step 1: Full backend suite on the scratch DB.** Compare against `s1-baseline.log`.

```bash
cd $WT/backend && TEST_DATABASE_URL=$S1_DB DATABASE_URL=$S1_DB npm test > ../../s1-final.log 2>&1; echo "exit=$?"
grep -E '^not ok|testTimeoutFailure' ../../s1-final.log
```
Expected: no `not ok` line that is not also in the baseline. If `exit` ≠ 0, every failing file must be in the baseline list, or it is this slice's defect. Watch `describe_audio_slots_db`, `audio_subjects_sfx_db` and `audio_prompt_context_db` in particular, because they enumerate `is_creature` rows and now see 8 more.

- [ ] **Step 2: Full frontend suite**

```bash
cd $WT/frontend && npx vitest run; echo "exit=$?"
```
Expected: `exit=0`.

- [ ] **Step 3: Start the isolated backend** (own port, scratch DB, kill by PID file only)

```bash
cd $WT/backend
set -a; . /home/markunn/worker/coding/jsgame/something2/.env; set +a
export PORT=13201 DATABASE_URL=$S1_DB
export REDIS_URL=$(echo "$REDIS_URL" | sed 's/redis:6379/localhost:16379/')
nohup node src/index.js > ../../s1-backend.log 2>&1 & echo $! > ../../s1-backend.pid
sleep 5; curl -s localhost:13201/api/health
```

Admin account on the scratch DB (applies `.env`'s ADMIN_USERNAME/ADMIN_PASSWORD to the scratch DB only. Never run `admin-password-rotate`):

```bash
cd /home/markunn/worker/coding/jsgame/something2/backend && DATABASE_URL=$S1_DB node scripts/set-admin-password.js
```

Read the password with `node -e "console.log(require('dotenv').parse(require('fs').readFileSync('/home/markunn/worker/coding/jsgame/something2/.env')).ADMIN_PASSWORD)"`. It is single-quoted in `.env`, so do not use `cut`.

- [ ] **Step 4: Start the isolated frontend.** Create `$WT/frontend/vite.verify.config.mjs` (do not commit):

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  cacheDir: '/tmp/s1-bosses-vite-cache',
  server: {
    port: 15273, strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:13201', changeOrigin: true },
      '/authority': { target: 'http://localhost:13201', ws: true, changeOrigin: true },
    },
  },
});
```

```bash
cd $WT/frontend && nohup node node_modules/.bin/vite --config vite.verify.config.mjs > ../../s1-vite.log 2>&1 & echo $! > ../../s1-vite.pid
```

- [ ] **Step 5: Confirm the browser gets a fresh bundle** before looking at anything

```bash
curl -s http://localhost:15273/src/games/something2/src/js/systems/RenderSystem.js | grep -c "_drawBossPlate"   # expect >= 1
curl -s http://localhost:15273/src/games/something2/src/js/systems/RenderSystem.js | grep -c "includes('Colossus')"  # expect 0
```

- [ ] **Step 6: Drive it in Chrome DevTools MCP** (`isolatedContext`, `http://127.0.0.1:15273/game-something2`), log in as the admin, and pick `Vale Crossing` (it has an arena, `worldBoss.js:76-81`). Then:
  1. Click Play, then run `evaluate_script` `await document.exitFullscreen().catch(() => {})`. The game auto-enters fullscreen and hides windowed-layout defects.
  2. Open the World Boss test panel, click **Spawn Ignis (Fire)**, then **Teleport to boss**.
  3. Check the procedural fallback with `evaluate_script`: find the boss in `window`'s game instance creatures (or read the HUD) and confirm `bossTier === 'world'`, `element === 'fire'` and `width === 96`. Screenshot: the fire-palette titan with a `☠️ [WORLD BOSS] Ignis, the Magma Colossus` plate at 96px, not a red 48px box.
  4. Check the server hitbox: stand just outside 48/2 + reach but inside 96/2 + reach of the boss centre, swing, and confirm the HP bar drops (a hit that would miss a 48 box).
  5. Check the art path: in the Entities admin tab confirm the Ignis row shows the **World boss** badge and the Boss tier / Element / Hitbox / XP / Base damage fields with its values. If an approved image exists for any boss (Art tab), spawn that boss and confirm the image is drawn at its Display Width (screenshot). If none exists, record "art path verified by unit test only (no approved boss art yet; S8 generates it)".
  6. Check minions: **Damage 3000** twice (≤ 50 %) and confirm two `Fire Elemental Guard` creatures appear next to the boss.
  7. Check slay/despawn: **Slay** and confirm the boss disappears from the world (it used to linger because `creatures.remove` did not exist), plus the victory chest/announcement. **Spawn Abyssor**, then **Despawn**, and confirm it is gone.
  8. Check the console: `list_console_messages` has no `ReferenceError`.

- [ ] **Step 7: Tear down** (by PID file. Never `pkill -f "node src/index.js"`)

```bash
kill $(cat ../../s1-backend.pid) $(cat ../../s1-vite.pid); rm -f $WT/frontend/vite.verify.config.mjs
cd $WT && git status --short   # must show no stray files (no vite.verify config, no node_modules symlink staged)
```

- [ ] **Step 8: Record evidence.** Put the backend/frontend exit codes, the baseline diff, the screenshots and the Step 6 results in the SOMET-603 Plane comment (To Review). Re-check migration collisions on current main: `git -C /home/markunn/worker/coding/jsgame/something2 ls-tree --name-only main backend/migrations/ | grep 17144406[7-9]` must list only this slice's two files.

---

## Self-Review

**Spec coverage (S1):**

| Spec item | Where |
|---|---|
| §3.1 `boss_tier` CHECK, `element` (item_types vocabulary), `auras` jsonb NULL, `hitbox_size` (NULL → 48), `xp_reward` | Task 2 (columns), Task 1/4 (NULL → 48) |
| §3.1 display size = `display_width/height`, gold = `gold_min/max`, description → `prompt` | Task 3 seed, Task 6 `bossFromRow` (`goldReward = gold_max`), Task 8 render at display size |
| §3.8 4 world bosses + 4 Elemental Guard rows | Task 3 |
| §4.1 one hydration function shared by chunk loader, bounded spawn path, WorldBossManager | Task 4 (`hydrateCreatureRow`; bounded worlds load through the same `CREATURE_JOINED_SELECT`, `server.js:1181-1186`, plus `injectGuardIntoSim` for respawns), Task 6 (manager) |
| §4.1 `addCreatures` keeps `bossTier`, `name`, `element`, `hitboxSize`, `auras` | Task 1 |
| §4.1 manager loads `boss_tier='world'` rows at startup and each rotation; arena logic unchanged; minions from Elemental Guard rows | Task 6 |
| §4.5 art at `display_width/height`, else procedural keyed on `element`; name-substring detection removed | Task 8 (also `Game.js` HUD matching) |
| §5 Entities tab: Boss tier, Element, Hitbox size, XP reward, Boss badge | Task 9 (Auras multi-select deferred to S3, "placed by" hint deferred to S9) |
| §7 S1: hydrate a boss row → fields present in CreatureSim, RED on today's code; manager spawns from DB rows | Task 1 (RED first), Task 4, Task 6 `world_boss_catalog_db` |
| §7 browser: exit fullscreen, fresh bundle, trigger via test panel, art at boss size | Task 10 |

**Decisions the spec did not make (flag for the spec owner):**

- **D1 `base_damage` column (not in §3.1).** `entity_types` has no damage column. Ordinary creatures get damage from `world_creatures.damage`, scaled from `CREATURE_BASE_DAMAGE = 5` (`mapService.js:999`, `creatureLevel.js:43-55`), and boss instances are never persisted. Without a column, the per-boss 42/35/55/45 would be lost. S9 dungeon bosses need the same column.
- **D2 Boss speed.** The JS catalog's `speed` (60/50/85/65) never reached the sim, because `addCreatures` always forced `CREATURE_SPEED = 40` (`creatures.js:1194`). Only the phase code read it (`worldBoss.js:277,285`). S1 keeps the live base speed of 40 and derives phase speeds from it (phase 2 = 48, where it was 72). That is a visible balance change in phases 2/4. Spec §1 puts balance out of scope, but say so in the PR.
- **D3 `attack_element` CHECK widened to `arcane`.** Abyssor attacks arcane in memory today. The `entity_types` CHECK (4 elements), `creatureBehaviors.ELEMENTS` and the frontend `ATTACK_ELEMENTS` all lacked it.
- **D4 Minions are resolved by name** (`MINION_TYPE_BY_ELEMENT`). A rename makes minions stop, with a log line (Review Focus 5).
- **D5 Drop rules for the 8 rows** are required by `creature_drops_db` and inert until S10.
- **D6 `xp_reward` is stored but not awarded.** It never was: a boss kill's `commitCreatureDeath` finds no `world_creatures` row and returns `null` (`loot.js:86-92`), so no XP and no normal drops. Awarding belongs to S10 or a follow-up.

**Placeholder scan:** no TBD/TODO, no "similar to Task N", and every code step carries real code. **Type consistency:** `hitboxOrNull` (Task 1) is reused by `hydrateCreatureRow` (Task 4). `bossCreatureId` is produced in Task 6 and consumed in Task 8. Wire fields from Task 7 are consumed in Task 8. `BOSS_TIERS` from Task 4 is consumed in Task 9.
