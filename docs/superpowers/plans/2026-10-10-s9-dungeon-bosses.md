# S9 Dungeon Bosses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each of the three spine dungeons in `p5-descent` (The Catacombs, The Emberhive, The Umbral Gate) has exactly one catalog boss in its `End` room and one in its `Elite` room. Each boss is placed when the world loads and comes back exactly once, `respawn_s` after it dies, through one respawn owner. Killing a dungeon boss never crashes, never queues a `creature_respawns` row, never reaches `WorldBossManager`, and leaves a documented hook for S10's loot.

**Architecture:** Six new `entity_types` rows (`boss_tier` `dungeon_end`/`dungeon_elite`) and three ally-side `aura_effects` rows ship in a migration. The same rows sit in checked-in seed data, so `seed-catalogs` restores them and `map_spec_fixtures` can check tiers offline. The map spec gains an optional per-world `boss` block. The p5 generator writes it from `content.js` (the spec is generated, never hand-patched), `validateMapSpec` checks it, `requiredTilesFor` makes `assertNavigable` prove the post is walkable, and `applyMapSpec` writes it to a new `worlds.dungeon_boss jsonb` column on every seed. On the authority, a new `DungeonBossManager` (`authority/dungeonBosses.js`) is the single owner of a dungeon boss's life. `loadWorld` calls `place(entry)`, which adds one instance through the shared `ENTITY_CATALOG_SELECT` → `hydrateCreatureRow` → `addCreatures` path with fixed id `boss:<worldId>` and a leash post. `onCreatureDeath` sends any `boss:` id to `onDeath` and returns before `commitCreatureDeath`. The existing 10 s creature sweep calls `sweep()`, which re-places due bosses. The state is in memory and keyed by world id, so it outlives world eviction, and leaving and rejoining cannot skip the timer. As defence in depth, `loot.js` and `respawnDueCreatures` both refuse boss-tier types, so a stray queue row can never turn a boss into a wild creature.

**Tech Stack:** Node 20 CommonJS, `pg`, node-pg-migrate 6, `node --test`; React 19 + vitest (one palette line); Canvas 2D.

**Spec:** `docs/superpowers/specs/2026-10-10-boss-entities-auras-design.md` (S9 = §3.5, §3.8 dungeon roster, §4.1 dungeon placement + respawn, §7 S9 tests and browser check)

**Plane:** SOMET-609 (parent SOMET-602). Follow the `plane-workflow` skill: In Progress before the first edit, To Review with evidence after Task 12.

## Global Constraints

- **Worktree:** `WT=/home/markunn/worker/coding/jsgame/something2-wt-s9-dungeon-bosses`, branch `feat/s9-dungeon-bosses`, already created at `origin/main` `a15f754a` (S1 and S3 landed). Never `checkout`/`stash`/`branch`/`merge` in the shared checkout `/home/markunn/worker/coding/jsgame/something2`. Other sessions use it, and it holds another session's untracked sprite-batch files (`1714440660000_sprite_batch_queue.js` and others) that you must not touch.
- **Scratch DB:** `game_db_s9`. Every DB command and test run sets both variables literally: `TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9`. The shorthand below is `S9_DB=postgres://user:password@localhost:15432/game_db_s9`. If you `export`, use two separate `export` lines, because `export A=.. B="$A"` leaves B empty. With `TEST_DATABASE_URL` unset, DB tests silently hit the shared dev DB.
- **Never mutate `game_db`** (the shared dev DB). No INSERT/UPDATE/DELETE/DDL there, ever, including "just to test a seeder". Read-only SELECTs are fine. Every write in this plan goes to `game_db_s9`.
- **Migrations:** `1714440700000` and `1714440701000`, inside S9's reserved range `1714440700000+`. Both are unused today (`ls backend/migrations | grep 17144407` is empty on `a15f754a` and on every local branch). Re-check before merging: `git -C /home/markunn/worker/coding/jsgame/something2 ls-tree --name-only origin/main backend/migrations/ | grep 17144407`.
- **Commits:** subject `type(scope): summary (SOMET-609)`, body ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage by explicit path only. Never `git add -A`/`git add .`, because the `node_modules` symlinks are not ignored. Never push unless the user asks.
- **Trust exit codes:** `...; echo "exit=$?"`. Never chain a test run with `;` into a reporter and read the reporter's status. Also grep for `^not ok` and `testTimeoutFailure`, because node's `# fail` counter misses subtest timeouts (AGENTS.md "Reading a test run").
- **Exclude openchest:** `tests/authority_openchest_integration.test.js` is broken and tracked separately as SOMET-615. Exclude it from every full-suite run (exact command in Setup) and do not "fix" it here.
- **Parallel slices are in flight.** S2 (boss sounds) edits `worldBoss.js` audio events and possibly `server.js`. The perf work (`perf/aura-pass`, worktree `something2-wt-perf-auras`) rewrites `creatures.js` `applyAuras`. This plan does **not edit `creatures.js` or `worldBoss.js` at all**. Every `server.js` edit is additive: a new block, a new SELECT column, or new seams. Re-indenting or reordering existing code there makes S2's merge conflict.
- **Generated spec rule:** `backend/seeds/maps/p5-descent.map.json` is the output of `scripts/dungeon/gen-p5-map-content.js`, and is byte-identical to it today. Never hand-edit the JSON. Boss data goes into `scripts/dungeon/content.js` and the generator, then you regenerate (Task 6 adds a test that pins this).
- **Seed order on the scratch DB:** catalogs, `p5-descent`, then `vale-region` LAST (it restores the real entry world, because seeding p5 steals `is_entry`), then the passive tree.
- Backend tests run from `$WT/backend` with `node --test <file>`, and frontend tests from `$WT/frontend` with `npx vitest run <file>`.
- After this merges, the dev stack's nodemon auto-runs both migrations on the shared dev DB. That is expected. Do not edit a migration file in the MAIN checkout while the stack is up (a half-written migration gets auto-applied).

## Review Focus

Five failure modes a user would hit that no current test covers. Each is pinned by a test in the task that owns it:

1. **Two respawn paths fire, or none fires** (the SOMET-609 Plane comment). A placed boss is killed: `loot.js:109-115` queues a `creature_respawns` row for any dead creature with null `home_x`/`blocks_portal_id`, and `creatureRespawn.js:133-136` has no `boss_tier` filter, so a boss could come back as a plain persisted wild creature as well as (or instead of) being re-placed. Pinned in Task 8 (`dungeon_boss_live_db`: kill a placed boss, see zero `creature_respawns` rows and zero `world_creatures` writes, then exactly one boss after the due sweep and still one after a second sweep) and Task 9 (each of the two legacy paths refuses a boss-tier type on its own).
2. **Leave-and-rejoin skips the respawn timer.** The last player leaves, `server.js:3052` evicts the world, and the next join reloads it. If boss state lived on `entry`, the boss would be back at full HP immediately. Pinned in Task 7 (manager unit) and Task 8 (live: `evictWorld` + reload while dead → no boss).
3. **A double load, or a load racing the sweep, spawns two bosses** (spec §7 "exactly one instance after double load"). Pinned in Task 7 (concurrent `place` and place-after-sweep → one instance) and Task 8 (live reload + sweep → one).
4. **A dungeon boss kill reaches the wrong owner.** `server.js:938` hands world-boss kills to `WorldBossManager` (announcement, legendary drops, Victor's Boon), and `commitCreatureDeath` runs `DELETE FROM world_creatures WHERE id = $1` (`loot.js:85-88`) against a `uuid` column (`migrations/1714440013000:3`). A `boss:…` id makes that throw `invalid input syntax for type uuid`, which gets logged as `death commit failed` (`server.js:1000`) on every kill. Pinned in Task 8 (spy: `worldBossManager.onCreatureDeath` is never called, no `death commit failed` log line, no query touches `world_creatures`).
5. **An admin renames, deletes or untiers a boss row after seeding** (Entities tab). The world's `dungeon_boss.entity` then names nothing usable, and the world must load with no boss, one log line and no throw. A malformed `dungeon_boss` jsonb degrades the same way. At seed time the validator must reject a non-boss entity (`Wolf`) or the wrong tier for the room. Pinned in Task 7 (missing/untiered row, malformed spec → null, warns once) and Task 4 (`validateMapSpec`).

Also pinned, beyond the five:
- a Druid cannot charm a boss (Task 10);
- a boss never respawns on top of a player (Task 7);
- `loadWorld`'s explicit-column SELECT names `dungeon_boss` (Task 8 source guard, the SOMET-288/309 silent-default trap);
- the checked-in p5 spec equals the generator output (Task 6);
- an unwalkable boss post fails the offline navigability oracle (Task 5).

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `backend/migrations/1714440700000_worlds_dungeon_boss.js` | Create | `worlds.dungeon_boss jsonb NULL` + object CHECK |
| `backend/migrations/1714440701000_seed_dungeon_boss_entities.js` | Create | 3 ally auras + 6 boss rows + one drop rule each (frozen literals, exported for the parity test) |
| `backend/seeds/data/dungeonBosses.js` | Create | `DUNGEON_BOSSES`: the 6 rows as checked-in seed data (fixture ground truth + reseed floor) |
| `backend/seeds/data/auraEffects.js` | Modify | `AURA_EFFECTS` gains `ossuary_dread`, `cinder_brood`, `shade_veil` |
| `backend/scripts/seed-catalogs.js` | Modify | `seedOneDungeonBoss` (boss columns, behaviour, auras, drop rule) called from `seedCatalogs` |
| `backend/seeds/mapSpec.js` | Modify | `boss` in `WORLD_KEYS`; `checkBoss`; `bossTiers` option |
| `backend/scripts/seed-map.js` | Modify | `bossTiers` catalog; `requiredTilesFor` boss tile; `dungeon_boss` INSERT/UPSERT column |
| `backend/scripts/dungeon/content.js` | Modify | `bosses` on d1/d4/d7 |
| `backend/scripts/dungeon/gen-p5-map-content.js` | Modify | `bossPlacement`; finalisation stamps `w.boss`; export `bossPlacement` |
| `backend/seeds/maps/p5-descent.map.json` | Regenerate | +6 `boss` blocks (generator output only) |
| `backend/src/authority/dungeonBosses.js` | Create | `DungeonBossManager`, `parseDungeonBoss`, `dungeonBossLevel`, `loadDungeonBossRow`, `bossCreatureId` |
| `backend/src/authority/server.js` | Modify (additive) | construct the manager; `loadWorld` SELECT + `place`; `onCreatureDeath` dungeon branch; sweep call; charm guard; seams |
| `backend/src/authority/loot.js` | Modify | respawn INSERT refuses boss-tier types |
| `backend/src/services/creatureRespawn.js` | Modify | per-row type lookup refuses boss-tier types |
| `backend/src/services/charm.js` | Modify | `canBeCharmed(c)` |
| `frontend/src/games/something2/src/js/systems/RenderSystem.js` | Modify | `bossPalette('physical')` bone palette |
| `backend/tests/worlds_dungeon_boss_column_db.test.js` | Create | column + CHECK |
| `backend/tests/dungeon_boss_entities_seed_db.test.js` | Create | 6 rows + 3 auras + drops, literal values |
| `backend/tests/dungeon_boss_data_parity.test.js` | Create | migration literals == seed data; elite/end aura rules |
| `backend/tests/seed_dungeon_bosses_db.test.js` | Create | `seedOneDungeonBoss` restores a missing boss fully |
| `backend/tests/map_spec_boss.test.js` | Create | validator rules |
| `backend/tests/map_spec_fixtures.test.js` | Modify | pass `bossTiers` |
| `backend/tests/seed_map_boss_db.test.js` | Create | `applyMapSpec` writes and re-asserts `dungeon_boss` |
| `backend/tests/required_tiles_boss.test.js` | Create | boss tile required; unwalkable post fails `assertNavigable` |
| `backend/tests/p5_gen_map_content.test.js` | Modify | 6 bosses with right tier, inside the world |
| `backend/tests/p5_spec_generated.test.js` | Create | checked-in spec == `generateSpec()` |
| `backend/tests/dungeon_boss_manager.test.js` | Create | manager unit behaviour |
| `backend/tests/dungeon_boss_row_db.test.js` | Create | real row → hydrated boss with resolved aura |
| `backend/tests/dungeon_boss_live_db.test.js` | Create | live authority: load, kill, evict, sweep; one respawn path; SELECT guard |
| `backend/tests/boss_respawn_paths_db.test.js` | Create | `loot.js` and the respawn sweep refuse boss types |
| `backend/tests/charm_boss.test.js` | Create | `canBeCharmed` + server guard |
| `frontend/src/games/something2/src/js/systems/__tests__/bossRender.test.js` | Modify | physical palette |

## Setup (before Task 1)

- [ ] **Link dependencies into the existing worktree**

```bash
WT=/home/markunn/worker/coding/jsgame/something2-wt-s9-dungeon-bosses
git -C $WT status --short && git -C $WT log --oneline -1   # expect clean, a15f754a
ln -s /home/markunn/worker/coding/jsgame/something2/backend/node_modules $WT/backend/node_modules
ln -s /home/markunn/worker/coding/jsgame/something2/frontend/node_modules $WT/frontend/node_modules
```

- [ ] **Create and seed the scratch DB** (about 2 min; this is the only DB you write to)

```bash
docker exec something2-db-1 psql -U user -d postgres -c 'CREATE DATABASE game_db_s9;'
cd $WT/backend
DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 npx node-pg-migrate up --ignore-pattern '(?!.*\.js$).*'
DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 node scripts/seed-catalogs.js
DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 SPEC=p5-descent node scripts/seed-map.js
DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 SPEC=vale-region node scripts/seed-map.js
DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 FORCE=1 node scripts/seed-passive-tree.js
```

- [ ] **Record a baseline** (openchest excluded, see the Global Constraints)

```bash
cd $WT/backend
TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 \
  node --test --test-timeout=420000 $(ls tests/*.test.js | grep -v authority_openchest_integration) > ../../s9-baseline.log 2>&1; echo "exit=$?"
grep -E '^not ok|testTimeoutFailure' ../../s9-baseline.log
```

Keep the list of failing files. Later suite runs on this DB are second runs. If a test fails on the second run but passed on the first, it is a state-dependent pair (memory: vacuous-test-patterns), not an S9 regression, until shown otherwise.

---

### Task 1: `worlds.dungeon_boss` column

**Files:**
- Create: `backend/migrations/1714440700000_worlds_dungeon_boss.js`
- Test: `backend/tests/worlds_dungeon_boss_column_db.test.js` (create)

**Interfaces:**
- Produces: `worlds.dungeon_boss jsonb NULL`, constraint `worlds_dungeon_boss_object_check`. Shape (enforced by `validateMapSpec`, not the DB): `{ entity: string, x: int px, y: int px, respawn_s: int > 0 }`.

Why a column: the runtime has no copy of the map spec. Everything `applyMapSpec` authors reaches the authority through a `worlds` column (compare `pens`, `safe_rects`, `server.js:648`). A migration cannot hold this value, because a re-seed rewrites it (memory: spec-beats-migration-on-reseed). The column is only the carrier, and the spec is the source.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/worlds_dungeon_boss_column_db.test.js
// SOMET-609 (S9). The map spec's per-world `boss` block reaches the authority
// through worlds.dungeon_boss. NULL = no boss; anything but a JSON object is a
// writer bug the column refuses (an array or a string would otherwise load as
// "no boss" silently).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { withFixtureWorld } = require('./helpers/fixtureWorld');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

test('worlds.dungeon_boss holds an object or NULL and refuses anything else', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    await withFixtureWorld(pool, async (worldId) => {
      const r0 = await pool.query('SELECT dungeon_boss FROM worlds WHERE id = $1', [worldId]);
      assert.equal(r0.rows[0].dungeon_boss, null, 'defaults to NULL');

      const boss = { entity: 'zzBoss', x: 4850, y: 5450, respawn_s: 900 };
      await pool.query('UPDATE worlds SET dungeon_boss = $2::jsonb WHERE id = $1', [worldId, JSON.stringify(boss)]);
      const r1 = await pool.query('SELECT dungeon_boss FROM worlds WHERE id = $1', [worldId]);
      assert.deepEqual(r1.rows[0].dungeon_boss, boss);

      for (const bad of ['[]', '"boss"', '42']) {
        await assert.rejects(
          pool.query('UPDATE worlds SET dungeon_boss = $2::jsonb WHERE id = $1', [worldId, bad]),
          /worlds_dungeon_boss_object_check/, `must reject ${bad}`);
      }
    }, { prefix: 'zzS9col' });
  } finally {
    await pool.end();
  }
});
```

- [ ] **Step 2: Run it and confirm it FAILS**

Run: `cd $WT/backend && TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 node --test tests/worlds_dungeon_boss_column_db.test.js; echo "exit=$?"`
Expected: FAIL with `column "dungeon_boss" does not exist`, `exit=1`.

- [ ] **Step 3: Implement the migration**

```js
// backend/migrations/1714440700000_worlds_dungeon_boss.js
//
// SOMET-609 (S9, spec §3.5). The map spec's optional per-world `boss` block
// ({ entity, x, y, respawn_s }) is written here by applyMapSpec on EVERY seed
// (re-asserted like pens/safe_rects), and read by loadWorld for
// DungeonBossManager. No backfill: the spec is the source of truth and
// `make seed-map SPEC=p5-descent` fills it.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE worlds ADD COLUMN dungeon_boss jsonb NULL;
    ALTER TABLE worlds ADD CONSTRAINT worlds_dungeon_boss_object_check
      CHECK (dungeon_boss IS NULL OR jsonb_typeof(dungeon_boss) = 'object');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE worlds DROP CONSTRAINT IF EXISTS worlds_dungeon_boss_object_check;
    ALTER TABLE worlds DROP COLUMN IF EXISTS dungeon_boss;
  `);
};
```

Apply it to the scratch DB: `cd $WT/backend && DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 npx node-pg-migrate up --ignore-pattern '(?!.*\.js$).*'`

- [ ] **Step 4: Run the test, expect PASS** (same command as Step 2, `exit=0`).

- [ ] **Step 5: Commit**

```bash
cd $WT && git add backend/migrations/1714440700000_worlds_dungeon_boss.js backend/tests/worlds_dungeon_boss_column_db.test.js
git commit -m "feat(maps): worlds.dungeon_boss carries the spec boss block (SOMET-609)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The six dungeon boss rows and three ally auras

**Files:**
- Create: `backend/seeds/data/dungeonBosses.js`
- Modify: `backend/seeds/data/auraEffects.js:5-8`
- Create: `backend/migrations/1714440701000_seed_dungeon_boss_entities.js`
- Test: `backend/tests/dungeon_boss_data_parity.test.js`, `backend/tests/dungeon_boss_entities_seed_db.test.js` (create)

**Interfaces:**
- Produces: `DUNGEON_BOSSES: Array<{ name, boss_tier, element, color, hp, defense, base_damage, size, xp_reward, gold_min, gold_max, behavior_name, auras: string[], resistances, drop_item, prompt }>` from `seeds/data/dungeonBosses.js`, consumed by Task 3 (seeder), Task 4/6 (`bossTiers` ground truth). The migration exports `ROWS` and `AURAS` (frozen literal copies) for the parity test only.
- Entity names (consumed by Task 6's `content.js`): `The Bone Regent`, `Ossuary Warden`, `The Ember Queen`, `Cinder Matriarch`, `The Umbral Gatekeeper`, `Shade Herald`.

**How the stats were set.** Rows store flat stats: a boss is hydrated from its TYPE row, never from a level-scaled `world_creatures` row, exactly like world bosses (`worldBoss.js:64-78`, `:593-599`). The numbers come from the dungeon's own Apex rung (`seeds/data/bestiaryP4.js`: hp 130, defense 13, `CREATURE_BASE_DAMAGE` 5), scaled by `scaleCreature` (`creatureLevel.js`: +15 %/level hp, +10 %/level damage, +0.5 defense/level) to the boss's level. End = 8x hp and 3x damage at the band ceiling. Elite = 4x hp and 2x damage at ceil(mid)+1. The levels come from `p5-descent.map.json`: Catacombs [1,7] → End 7 / Elite 5, Emberhive [16,26] → 26 / 22, Umbral Gate [41,50] → 50 / 47. Balance is out of scope (spec §1), and tuning is the follow-up ticket. The tests below restate the resulting numbers as literals and never re-derive them.

Behaviour: End = `Apex` (cast, 2 abilities, leash 1200). Elite = `Champion` (melee, leash 900). Both are seeded by migration `1714440080000`, so the migration works on a fresh DB. Each Elite carries exactly one aura. End rows get an explicit `[]`, so `bindDefaultAuras` (which binds only `auras IS NULL`) never touches them. Drop items are migration-seeded weapons (`1714440019000_weapon_catalog.js`), so the guarded cross-join inserts the rule on a fresh DB too. The drops are inert until S10, but `creature_drops_db` requires them.

- [ ] **Step 1: Write the seed data module**

```js
// backend/seeds/data/dungeonBosses.js
// SOMET-609 (S9, spec §3.8). The six dungeon bosses, as checked-in seed data.
// Two consumers: seed-catalogs restores any that are missing (never updates an
// existing row -- the Entities tab owns them after the first insert), and
// map_spec_fixtures/p5_gen_map_content read boss tiers from here so the map
// spec's `boss` blocks are validated offline against the same truth the DB has.
// Migration 1714440701000 holds a frozen copy; dungeon_boss_data_parity.test.js
// keeps the two equal until someone deliberately changes both.
const DUNGEON_BOSSES = [
  { name: 'The Bone Regent', boss_tier: 'dungeon_end', element: 'physical', color: '#d8d2c0',
    hp: 2000, defense: 16, base_damage: 24, size: 96, xp_reward: 300, gold_min: 20, gold_max: 40,
    behavior_name: 'Apex', auras: [], resistances: { ice: 0.5, physical: 0.3 }, drop_item: 'long sword',
    prompt: 'A crowned skeletal monarch on a throne of fused bones, ruling the deepest crypt of the Catacombs.' },
  { name: 'Ossuary Warden', boss_tier: 'dungeon_elite', element: 'physical', color: '#b8b09a',
    hp: 850, defense: 15, base_damage: 14, size: 72, xp_reward: 120, gold_min: 8, gold_max: 15,
    behavior_name: 'Champion', auras: ['ossuary_dread'], resistances: { ice: 0.4, physical: 0.2 }, drop_item: 'short sword',
    prompt: 'A towering armoured skeleton keeper wrapped in burial chains, guarding the ossuary.' },
  { name: 'The Ember Queen', boss_tier: 'dungeon_end', element: 'fire', color: '#ff6b1a',
    hp: 5000, defense: 25, base_damage: 52, size: 96, xp_reward: 1200, gold_min: 75, gold_max: 150,
    behavior_name: 'Apex', auras: [], resistances: { fire: 0.8, physical: 0.3 }, drop_item: 'flame staff',
    prompt: 'A vast molten hive queen with a glowing ember abdomen and wings of smouldering ash.' },
  { name: 'Cinder Matriarch', boss_tier: 'dungeon_elite', element: 'fire', color: '#c2410c',
    hp: 2200, defense: 23, base_damage: 31, size: 72, xp_reward: 500, gold_min: 30, gold_max: 60,
    behavior_name: 'Champion', auras: ['cinder_brood'], resistances: { fire: 0.6, physical: 0.2 }, drop_item: 'flame staff',
    prompt: 'A scorched brood mother insect trailing cinders, tending the burning hive cells.' },
  { name: 'The Umbral Gatekeeper', boss_tier: 'dungeon_end', element: 'arcane', color: '#4c1d95',
    hp: 8700, defense: 37, base_damage: 88, size: 112, xp_reward: 2500, gold_min: 175, gold_max: 350,
    behavior_name: 'Apex', auras: [], resistances: { arcane: 0.6, physical: 0.4 }, drop_item: 'archmage staff',
    prompt: 'A colossal void sentinel of living shadow, its body a doorway into starless dark.' },
  { name: 'Shade Herald', boss_tier: 'dungeon_elite', element: 'arcane', color: '#6d28d9',
    hp: 4100, defense: 36, base_damage: 56, size: 80, xp_reward: 1100, gold_min: 75, gold_max: 150,
    behavior_name: 'Champion', auras: ['shade_veil'], resistances: { arcane: 0.5, physical: 0.3 }, drop_item: 'archmage staff',
    prompt: 'A hooded wraith herald with a tattered banner of shadow, announcing the Gatekeeper.' },
];

module.exports = { DUNGEON_BOSSES };
```

- [ ] **Step 2: Add the three ally auras to the aura floor.** Replace `AURA_EFFECTS` in `seeds/data/auraEffects.js` (lines 5-8):

```js
const AURA_EFFECTS = [
  { name: 'pack_leader', target_side: 'allies', radius: 260, damage_mult: 1.25, defense_mult: 1.2,
    speed_mult: 1.1, shape: 'ring', color: '#d4a017', pulse_ms: 1200 },
  // SOMET-609 (S9): one aura per dungeon Elite boss. ALLY side only -- enemy-
  // side gameplay is S4, and aura_effects_dot_side_check forbids a DoT here.
  { name: 'ossuary_dread', target_side: 'allies', radius: 320, damage_mult: 1, defense_mult: 1.3,
    speed_mult: 1, shape: 'ring', color: '#cfc8b0', pulse_ms: 1600 },
  { name: 'cinder_brood', target_side: 'allies', radius: 300, damage_mult: 1.25, defense_mult: 1,
    speed_mult: 1.1, shape: 'ring', color: '#ff7a1a', pulse_ms: 900 },
  { name: 'shade_veil', target_side: 'allies', radius: 340, damage_mult: 1, defense_mult: 1.15,
    speed_mult: 1.25, shape: 'ring', color: '#7c3aed', pulse_ms: 1400 },
];
```

`seed-catalogs.js:557` already loops `AURA_EFFECTS` through `seedOneAura` before creatures, so no seeder change is needed for auras.

- [ ] **Step 3: Write the failing parity test** (pure, no DB)

```js
// backend/tests/dungeon_boss_data_parity.test.js
// SOMET-609 (S9). The migration carries a FROZEN copy of the boss rows (a
// migration must not require a mutable data module), and seeds/data carries
// the copy seed-catalogs and the map fixtures read. They must agree, or a fresh
// DB (migration) and a restored DB (seeder) disagree about what a boss is.
const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('../migrations/1714440701000_seed_dungeon_boss_entities.js');
const { DUNGEON_BOSSES } = require('../seeds/data/dungeonBosses.js');
const { AURA_EFFECTS } = require('../seeds/data/auraEffects.js');

test('migration boss rows equal seeds/data/dungeonBosses.js', () => {
  assert.deepEqual(migration.ROWS, DUNGEON_BOSSES);
});

test('migration aura rows equal their AURA_EFFECTS entries', () => {
  for (const a of migration.AURAS) {
    assert.deepEqual(AURA_EFFECTS.find((x) => x.name === a.name), a, a.name);
  }
});

test('three End and three Elite bosses; every Elite has exactly one aura, every End none', () => {
  const end = DUNGEON_BOSSES.filter((b) => b.boss_tier === 'dungeon_end');
  const elite = DUNGEON_BOSSES.filter((b) => b.boss_tier === 'dungeon_elite');
  assert.equal(end.length, 3);
  assert.equal(elite.length, 3);
  for (const b of end) assert.deepEqual(b.auras, [], b.name);
  for (const b of elite) assert.equal(b.auras.length, 1, b.name);
});

test('every Elite aura exists in the aura floor and is ally-side with no DoT (S4 owns enemy side)', () => {
  for (const b of DUNGEON_BOSSES) {
    for (const name of b.auras) {
      const a = AURA_EFFECTS.find((x) => x.name === name);
      assert.ok(a, `${b.name} binds unknown aura ${name}`);
      assert.equal(a.target_side, 'allies', name);
      assert.ok(!a.dot_dps, `${name} must carry no DoT`);
    }
  }
});
```

Run: `cd $WT/backend && node --test tests/dungeon_boss_data_parity.test.js; echo "exit=$?"`
Expected: FAIL with `Cannot find module '../migrations/1714440701000_seed_dungeon_boss_entities.js'`, `exit=1`.

- [ ] **Step 4: Write the migration** (literals copied from Step 1 and Step 2. Do NOT `require` the data module.)

```js
// backend/migrations/1714440701000_seed_dungeon_boss_entities.js
//
// SOMET-609 (S9, spec §3.8). Three dungeon End bosses and three Elite bosses,
// one per p5-descent spine dungeon (Catacombs, Emberhive, Umbral Gate), plus
// the three ally-side auras the Elites carry. Frozen literals: this file must
// not require seeds/data (a later data edit would silently rewrite history).
// dungeon_boss_data_parity.test.js pins these equal to seeds/data today.
//
// Stats: the dungeon's Apex rung (hp 130 / def 13 / base damage 5) scaled by
// scaleCreature to the boss level, then End x8 hp x3 damage, Elite x4 hp x2
// damage. Bosses hydrate from this TYPE row (never a world_creatures row), so
// the row's hp/defense/base_damage are what the sim gets.
//
// Behaviour by name: Apex (End), Champion (Elite), both migration-seeded by
// 1714440080000. auras: End '[]' (explicit, so bindDefaultAuras' NULL-only
// rule never binds pack_leader to them), Elite one ally aura each.
//
// One drop rule each, same guarded cross-join as 1714440671000 (a missing item
// inserts nothing). INERT until S10: a boss kill never reaches spawnDrops.
//
// ON CONFLICT DO NOTHING throughout: an admin's later edits are never reverted.
exports.shorthands = undefined;

const AURAS = [
  { name: 'ossuary_dread', target_side: 'allies', radius: 320, damage_mult: 1, defense_mult: 1.3,
    speed_mult: 1, shape: 'ring', color: '#cfc8b0', pulse_ms: 1600 },
  { name: 'cinder_brood', target_side: 'allies', radius: 300, damage_mult: 1.25, defense_mult: 1,
    speed_mult: 1.1, shape: 'ring', color: '#ff7a1a', pulse_ms: 900 },
  { name: 'shade_veil', target_side: 'allies', radius: 340, damage_mult: 1, defense_mult: 1.15,
    speed_mult: 1.25, shape: 'ring', color: '#7c3aed', pulse_ms: 1400 },
];

const ROWS = [
  // (paste the six objects from seeds/data/dungeonBosses.js Step 1 verbatim)
];

const sqlString = (s) => `'${s.replace(/'/g, "''")}'`;

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO aura_effects (name, target_side, radius, damage_mult, defense_mult, speed_mult, shape, color, pulse_ms)
    SELECT a.name, a.target_side, a.radius, a.damage_mult, a.defense_mult, a.speed_mult, a.shape, a.color, a.pulse_ms
      FROM jsonb_to_recordset(${sqlString(JSON.stringify(AURAS))}::jsonb) AS a(
        name text, target_side text, radius real, damage_mult real, defense_mult real,
        speed_mult real, shape text, color text, pulse_ms int)
    ON CONFLICT (name) DO NOTHING
  `);
  pgm.sql(`
    INSERT INTO entity_types
      (name, color, walkable, spawn_tiles, chance, is_creature, hp, max_hp, defense,
       resistances, faction, gold_min, gold_max, prompt, attack_element, behavior_id,
       boss_tier, element, hitbox_size, xp_reward, base_damage, display_width, display_height, auras)
    SELECT r.name, r.color, true, '[]'::jsonb, 0, true, r.hp, r.hp, r.defense,
           r.resistances, 'hostile', r.gold_min, r.gold_max, r.prompt, r.element,
           (SELECT id FROM creature_behaviors WHERE name = r.behavior_name),
           r.boss_tier, r.element, r.size, r.xp_reward, r.base_damage, r.size, r.size, r.auras
      FROM jsonb_to_recordset(${sqlString(JSON.stringify(ROWS))}::jsonb) AS r(
        name text, boss_tier text, element text, color text, hp int, defense real, base_damage real,
        size int, xp_reward int, gold_min int, gold_max int, behavior_name text, auras jsonb,
        resistances jsonb, drop_item text, prompt text)
    ON CONFLICT (name) DO NOTHING
  `);
  for (const r of ROWS) {
    pgm.sql(`
      INSERT INTO creature_drops (entity_type_id, item_type_id, chance, min_qty, max_qty)
      SELECT et.id, it.id, 0.2, 1, 1
        FROM entity_types et, item_types it
       WHERE et.name = ${sqlString(r.name)} AND it.name = ${sqlString(r.drop_item)}
         AND NOT EXISTS (SELECT 1 FROM creature_drops cd WHERE cd.entity_type_id = et.id AND cd.item_type_id = it.id)
    `);
  }
};

exports.down = (pgm) => {
  const names = ROWS.map((r) => sqlString(r.name)).join(', ');
  const auras = AURAS.map((a) => sqlString(a.name)).join(', ');
  pgm.sql(`
    DELETE FROM creature_drops WHERE entity_type_id IN (SELECT id FROM entity_types WHERE name IN (${names}));
    DELETE FROM entity_types WHERE name IN (${names});
    DELETE FROM aura_effects WHERE name IN (${auras});
  `);
};

// Read by dungeon_boss_data_parity.test.js only; node-pg-migrate reads up/down.
exports.ROWS = ROWS;
exports.AURAS = AURAS;
```

`ROWS` must contain the six objects verbatim, with no placeholder left. The parity test fails if the array is empty.

Run the parity test again and expect PASS (`exit=0`).

- [ ] **Step 5: Write the failing DB test** (literal values, not derived from either source)

```js
// backend/tests/dungeon_boss_entities_seed_db.test.js
// SOMET-609 (S9, spec §3.8). The six dungeon bosses on a real migrated DB.
// Values are restated as literals -- never read back from the migration or
// seeds/data -- so a typo in BOTH sources still fails here.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

test('the six dungeon bosses are tiered catalog rows with their stats', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(
      `SELECT e.name, e.boss_tier, e.element, e.attack_element, e.hp, e.max_hp, e.defense,
              e.base_damage, e.hitbox_size, e.display_width, e.xp_reward, e.gold_min, e.gold_max,
              e.faction, e.auras, b.name AS behavior
         FROM entity_types e LEFT JOIN creature_behaviors b ON b.id = e.behavior_id
        WHERE e.boss_tier IN ('dungeon_end', 'dungeon_elite') ORDER BY e.name`);
    const row = (name, tier, element, hp, def, dmg, size, xp, gmin, gmax, behavior, auras) => ({
      name, boss_tier: tier, element, attack_element: element, hp, max_hp: hp, defense: def,
      base_damage: dmg, hitbox_size: size, display_width: size, xp_reward: xp,
      gold_min: gmin, gold_max: gmax, faction: 'hostile', auras, behavior,
    });
    assert.deepEqual(r.rows, [
      row('Cinder Matriarch', 'dungeon_elite', 'fire', 2200, 23, 31, 72, 500, 30, 60, 'Champion', ['cinder_brood']),
      row('Ossuary Warden', 'dungeon_elite', 'physical', 850, 15, 14, 72, 120, 8, 15, 'Champion', ['ossuary_dread']),
      row('Shade Herald', 'dungeon_elite', 'arcane', 4100, 36, 56, 80, 1100, 75, 150, 'Champion', ['shade_veil']),
      row('The Bone Regent', 'dungeon_end', 'physical', 2000, 16, 24, 96, 300, 20, 40, 'Apex', []),
      row('The Ember Queen', 'dungeon_end', 'fire', 5000, 25, 52, 96, 1200, 75, 150, 'Apex', []),
      row('The Umbral Gatekeeper', 'dungeon_end', 'arcane', 8700, 37, 88, 112, 2500, 175, 350, 'Apex', []),
    ]);
  } finally {
    await pool.end();
  }
});

test('the three Elite auras are ally-side library rows with no DoT', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(
      `SELECT name, target_side, radius, damage_mult, defense_mult, speed_mult, dot_dps
         FROM aura_effects WHERE name IN ('ossuary_dread', 'cinder_brood', 'shade_veil') ORDER BY name`);
    assert.deepEqual(r.rows, [
      { name: 'cinder_brood', target_side: 'allies', radius: 300, damage_mult: 1.25, defense_mult: 1, speed_mult: 1.1, dot_dps: 0 },
      { name: 'ossuary_dread', target_side: 'allies', radius: 320, damage_mult: 1, defense_mult: 1.3, speed_mult: 1, dot_dps: 0 },
      { name: 'shade_veil', target_side: 'allies', radius: 340, damage_mult: 1, defense_mult: 1.15, speed_mult: 1.25, dot_dps: 0 },
    ]);
  } finally {
    await pool.end();
  }
});

test('every dungeon boss has exactly its one drop rule', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(
      `SELECT e.name, it.name AS item FROM creature_drops cd
         JOIN entity_types e ON e.id = cd.entity_type_id JOIN item_types it ON it.id = cd.item_type_id
        WHERE e.boss_tier IN ('dungeon_end', 'dungeon_elite') ORDER BY e.name`);
    assert.deepEqual(r.rows, [
      { name: 'Cinder Matriarch', item: 'flame staff' },
      { name: 'Ossuary Warden', item: 'short sword' },
      { name: 'Shade Herald', item: 'archmage staff' },
      { name: 'The Bone Regent', item: 'long sword' },
      { name: 'The Ember Queen', item: 'flame staff' },
      { name: 'The Umbral Gatekeeper', item: 'archmage staff' },
    ]);
  } finally {
    await pool.end();
  }
});
```

`real` columns come back as JS numbers through `pg`, which is why `1.3`/`1.15` compare directly. If one shows up as `1.2999999523162842`, the column is `real` (float4). In that case select `round(x::numeric, 2)::float8` for the three multipliers, and do not loosen the expected literal.

- [ ] **Step 6: Run and confirm FAIL** (before migrating): `cd $WT/backend && TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 node --test tests/dungeon_boss_entities_seed_db.test.js; echo "exit=$?"`. Expected: the first test fails with `actual: []` (no rows), `exit=1`.

- [ ] **Step 7: Migrate the scratch DB and re-run, expect PASS**

```bash
cd $WT/backend && DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 npx node-pg-migrate up --ignore-pattern '(?!.*\.js$).*'
TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 node --test tests/dungeon_boss_entities_seed_db.test.js tests/creature_drops_db.test.js tests/creature_behaviors_seed_db.test.js; echo "exit=$?"
```
Expected: `exit=0`. The two invariant files prove the new rows have a drop rule and a behaviour.

- [ ] **Step 8: Commit**

```bash
cd $WT && git add backend/seeds/data/dungeonBosses.js backend/seeds/data/auraEffects.js \
  backend/migrations/1714440701000_seed_dungeon_boss_entities.js \
  backend/tests/dungeon_boss_data_parity.test.js backend/tests/dungeon_boss_entities_seed_db.test.js
git commit -m "feat(bosses): six dungeon boss entities and three Elite ally auras (SOMET-609)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `seed-catalogs` restores a missing dungeon boss

**Files:**
- Modify: `backend/scripts/seed-catalogs.js` (new `seedOneDungeonBoss` next to `seedOneCreatureType` at `:295`; call after `bindDefaultAuras` at `:567`; export at `:610-614`)
- Test: `backend/tests/seed_dungeon_bosses_db.test.js` (create)

**Interfaces:**
- Consumes: `DUNGEON_BOSSES` (Task 2).
- Produces: `seedOneDungeonBoss(db, b): Promise<number>` (1 = inserted, 0 = already present).

Why not `seedOneCreatureType`: it writes no boss columns (`seed-catalogs.js:296-305`), so a restored boss would come back untiered. That makes it an ordinary creature the wild pool may pick, and the map validator would reject it.

- [ ] **Step 1: Write the failing test.** It runs inside a rolled-back transaction, so parallel invariant readers never see a hostile creature mid-insert.

```js
// backend/tests/seed_dungeon_bosses_db.test.js
// SOMET-609 (S9). An admin who deletes a dungeon boss gets it back from
// `make seed-catalogs` -- tiered, behaved, aura-bound and with its drop rule --
// not as an untiered plain creature (what seedOneCreatureType would restore).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { seedOneDungeonBoss } = require('../scripts/seed-catalogs.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

const ZZ = {
  name: 'zzS9 Restored Warden', boss_tier: 'dungeon_elite', element: 'physical', color: '#b8b09a',
  hp: 850, defense: 15, base_damage: 14, size: 72, xp_reward: 120, gold_min: 8, gold_max: 15,
  behavior_name: 'Champion', auras: ['ossuary_dread'], resistances: { ice: 0.4 },
  drop_item: 'short sword', prompt: 'test',
};

test('seedOneDungeonBoss inserts a complete boss once and never overwrites it', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    assert.equal(await seedOneDungeonBoss(c, ZZ), 1, 'first run inserts');
    const r = await c.query(
      `SELECT e.boss_tier, e.element, e.attack_element, e.hp, e.max_hp, e.hitbox_size, e.display_height,
              e.base_damage, e.auras, e.resistances, b.name AS behavior,
              (SELECT count(*)::int FROM creature_drops cd JOIN item_types it ON it.id = cd.item_type_id
                WHERE cd.entity_type_id = e.id AND it.name = 'short sword') AS drops
         FROM entity_types e LEFT JOIN creature_behaviors b ON b.id = e.behavior_id WHERE e.name = $1`, [ZZ.name]);
    assert.deepEqual(r.rows[0], {
      boss_tier: 'dungeon_elite', element: 'physical', attack_element: 'physical', hp: 850, max_hp: 850,
      hitbox_size: 72, display_height: 72, base_damage: 14, auras: ['ossuary_dread'],
      resistances: { ice: 0.4 }, behavior: 'Champion', drops: 1,
    });

    await c.query('UPDATE entity_types SET hp = 1 WHERE name = $1', [ZZ.name]);
    assert.equal(await seedOneDungeonBoss(c, ZZ), 0, 'second run is a no-op');
    const again = await c.query(
      `SELECT e.hp, (SELECT count(*)::int FROM creature_drops cd WHERE cd.entity_type_id = e.id) AS drops
         FROM entity_types e WHERE e.name = $1`, [ZZ.name]);
    assert.deepEqual(again.rows[0], { hp: 1, drops: 1 }, 'admin edit kept, no duplicate drop rule');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
    await pool.end();
  }
});
```

- [ ] **Step 2: Run, confirm FAIL:** `cd $WT/backend && TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 node --test tests/seed_dungeon_bosses_db.test.js; echo "exit=$?"`. Expected: `TypeError: seedOneDungeonBoss is not a function`, `exit=1`.

- [ ] **Step 3: Implement.** Add to the requires at the top of `seed-catalogs.js`:

```js
const { DUNGEON_BOSSES } = require('../seeds/data/dungeonBosses.js');
```

Below `seedOneCreatureType` (after line 330):

```js
// SOMET-609 (S9). A dungeon boss, with the boss columns seedOneCreatureType
// does not write. Insert-only (ON CONFLICT DO NOTHING): the Entities tab owns
// the row after the first insert. Behaviour resolves by name; the drop rule is
// NOT EXISTS-guarded because creature_drops has no unique constraint. Returns
// 1 when the row was inserted.
async function seedOneDungeonBoss(db, b) {
  const r = await db.query(
    `INSERT INTO entity_types
       (name, color, walkable, spawn_tiles, chance, is_creature, hp, max_hp, defense,
        resistances, faction, gold_min, gold_max, prompt, attack_element, behavior_id,
        boss_tier, element, hitbox_size, xp_reward, base_damage, display_width, display_height, auras)
     VALUES ($1,$2,true,'[]'::jsonb,0,true,$3,$3,$4,$5::jsonb,'hostile',$6,$7,$8,$9,
             (SELECT id FROM creature_behaviors WHERE name = $10),
             $11,$9,$12,$13,$14,$12,$12,$15::jsonb)
     ON CONFLICT (name) DO NOTHING`,
    [b.name, b.color, b.hp, b.defense, JSON.stringify(b.resistances), b.gold_min, b.gold_max,
     b.prompt, b.element, b.behavior_name, b.boss_tier, b.size, b.xp_reward, b.base_damage,
     JSON.stringify(b.auras)],
  );
  await db.query(
    `INSERT INTO creature_drops (entity_type_id, item_type_id, chance, min_qty, max_qty)
     SELECT et.id, it.id, 0.2, 1, 1 FROM entity_types et, item_types it
      WHERE et.name = $1 AND it.name = $2
        AND NOT EXISTS (SELECT 1 FROM creature_drops cd WHERE cd.entity_type_id = et.id AND cd.item_type_id = it.id)`,
    [b.name, b.drop_item],
  );
  return r.rowCount;
}
```

In `seedCatalogs`, directly after the `console.log(\`Bound default auras ...\`)` line (`:568`):

```js
  let dungeonBosses = 0;
  for (const b of DUNGEON_BOSSES) dungeonBosses += await seedOneDungeonBoss(pool, b);
  console.log(`Restored ${dungeonBosses} missing dungeon bosses`);
```

Add `seedOneDungeonBoss` to `module.exports`.

- [ ] **Step 4: Run, expect PASS.** Also run `node scripts/seed-catalogs.js` against the scratch DB twice and confirm the second run prints `Restored 0 missing dungeon bosses`.

- [ ] **Step 5: Commit**

```bash
cd $WT && git add backend/scripts/seed-catalogs.js backend/tests/seed_dungeon_bosses_db.test.js
git commit -m "feat(seed): seed-catalogs restores missing dungeon bosses with their boss fields (SOMET-609)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `validateMapSpec` accepts and checks the `boss` block

**Files:**
- Modify: `backend/seeds/mapSpec.js:125-135` (`WORLD_KEYS`), `:137-140` (signature), and a `checkBoss` call next to the chest block (`:635-673`)
- Modify: `backend/scripts/seed-map.js:159-168` (pass `bossTiers`)
- Modify: `backend/tests/map_spec_fixtures.test.js:9-11, 165-168` (pass `bossTiers`)
- Test: `backend/tests/map_spec_boss.test.js` (create)

**Interfaces:**
- Produces: `validateMapSpec(spec, { ..., bossTiers = null })`. `bossTiers` is `Map<entity name, boss_tier>`. `null` skips the catalog checks (the shape checks still run), exactly like `creatureTypeNames`.
- Rules (spec §3.5): object; keys ⊆ `entity, x, y, respawn_s`; `entity` a non-empty string whose tier is `dungeon_end`/`dungeon_elite`; a world named `…: End` needs `dungeon_end` and `…: Elite` needs `dungeon_elite`; `x`, `y` integers inside the world; `respawn_s` a positive integer. Walkability is NOT checked here: `validateMapSpec` is pure and offline and has no terrain. Task 5 covers it through `requiredTilesFor`.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/map_spec_boss.test.js
// SOMET-609 (S9, spec §3.5). The per-world `boss` block. Every negative case is
// the valid fixture with exactly one thing broken.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMapSpec } = require('../seeds/mapSpec.js');

const BOSS_TIERS = new Map([
  ['zzEnd Boss', 'dungeon_end'], ['zzElite Boss', 'dungeon_elite'], ['zzWorld Boss', 'world'],
]);

const valid = () => ({
  name: 'fixture', topology: 'spine',
  worlds: [
    { key: 'a', name: 'The Zz: Entry', grid: [0, 0], seed: 1, width: 64, height: 64,
      chunk_size: 32, biomes: ['Meadow'], biome_cell: 32, allowed_creature_types: ['Slime'],
      is_entry: true, entry_spawn: { x: 3250, y: 3250 } },
    { key: 'b', name: 'The Zz: End', grid: [1, 0], seed: 2, width: 64, height: 64,
      chunk_size: 32, biomes: ['Meadow'], biome_cell: 32, allowed_creature_types: ['Wolf'],
      is_entry: false, boss: { entity: 'zzEnd Boss', x: 3250, y: 3850, respawn_s: 900 } },
  ],
  links: [{ from: 'a', edge: 'E', to: 'b' }],
});
const errs = (mutate, opts = { bossTiers: BOSS_TIERS }) => {
  const s = valid(); mutate(s); return validateMapSpec(s, opts);
};
const bossOf = (s) => s.worlds[1].boss;

test('a well-formed boss block validates, with and without the catalog', () => {
  assert.deepEqual(errs(() => {}), []);
  assert.deepEqual(errs(() => {}, {}), []);
});

test('boss is an accepted world key (not reported as unknown)', () => {
  assert.ok(!errs(() => {}).some((e) => /unknown key/.test(e)));
});

for (const [label, value] of [['null', null], ['an array', []], ['a string', 'zzEnd Boss']]) {
  test(`boss that is ${label} is rejected without throwing`, () => {
    const e = errs((s) => { s.worlds[1].boss = value; });
    assert.ok(e.some((m) => /world "b" boss must be an object/.test(m)), e.join('; '));
  });
}

test('an unknown key inside boss is rejected', () => {
  const e = errs((s) => { bossOf(s).level = 7; });
  assert.ok(e.some((m) => /world "b" boss has unknown key "level"/.test(m)), e.join('; '));
});

test('a non-boss entity is rejected (ordinary creature, world boss, unknown name)', () => {
  for (const name of ['Wolf', 'zzWorld Boss', 'zzNobody']) {
    const e = errs((s) => { bossOf(s).entity = name; });
    assert.ok(e.some((m) => m.includes(`entity "${name}" is not a dungeon boss`)), `${name}: ${e.join('; ')}`);
  }
});

test('an End world must use a dungeon_end boss, an Elite world a dungeon_elite boss', () => {
  const e1 = errs((s) => { bossOf(s).entity = 'zzElite Boss'; });
  assert.ok(e1.some((m) => /is dungeon_elite, but "The Zz: End" needs dungeon_end/.test(m)), e1.join('; '));
  const e2 = errs((s) => { s.worlds[1].name = 'The Zz: Elite'; });
  assert.ok(e2.some((m) => /is dungeon_end, but "The Zz: Elite" needs dungeon_elite/.test(m)), e2.join('; '));
});

test('a world with no End/Elite suffix may hold either dungeon tier', () => {
  assert.deepEqual(errs((s) => { s.worlds[1].name = 'Zz Hall'; bossOf(s).entity = 'zzElite Boss'; }), []);
});

test('the boss point must be integer pixels inside the world', () => {
  for (const [f, v, re] of [
    ['x', 6400, /boss x 6400 is outside the world \(0\.\.6399 px\)/],
    ['y', -1, /boss y -1 is outside the world/],
    ['x', 12.5, /boss x must be an integer/],
    ['y', '3850', /boss y must be an integer/],
  ]) {
    const e = errs((s) => { bossOf(s)[f] = v; });
    assert.ok(e.some((m) => re.test(m)), `${f}=${v}: ${e.join('; ')}`);
  }
});

test('respawn_s must be a positive integer', () => {
  for (const v of [0, -5, 1.5, '600', undefined]) {
    const e = errs((s) => { bossOf(s).respawn_s = v; });
    assert.ok(e.some((m) => /boss respawn_s must be a positive integer/.test(m)), `${v}: ${e.join('; ')}`);
  }
});

test('a missing entity is rejected', () => {
  const e = errs((s) => { delete bossOf(s).entity; });
  assert.ok(e.some((m) => /boss entity must be an entity type name/.test(m)), e.join('; '));
});
```

- [ ] **Step 2: Run, confirm FAIL:** `cd $WT/backend && node --test tests/map_spec_boss.test.js; echo "exit=$?"`. Expected: the first test fails with `world "b" has unknown key(s) boss`, and most others fail. `exit=1`.

- [ ] **Step 3: Implement in `mapSpec.js`.** Add `'boss'` to `WORLD_KEYS` (after `'waypoints',`). Change the signature at `:137-140` to:

```js
function validateMapSpec(spec, {
  biomeNames = null, creatureTypeNames = null, biomeCreatureTypes = null,
  pointArtTypes = null, bossTiers = null,
} = {}) {
```

Inside `validateMapSpec`, before `if (!spec || typeof spec !== 'object')` (so it can close over `errors`):

```js
  // SOMET-609 (S9, spec §3.5). A dungeon boss placed at a fixed post. Walkability
  // is NOT checked here (this module is pure and has no terrain): requiredTilesFor
  // in seed-map.js lists the post, so assertNavigable proves it at seed time and
  // tests/p5_navigability.test.js proves it offline. The End/Elite rule keys on
  // the p5 generator's room naming ("<Dungeon>: End"); any other world may hold
  // either dungeon tier.
  const BOSS_KEYS = ['entity', 'x', 'y', 'respawn_s'];
  const DUNGEON_BOSS_TIERS = ['dungeon_end', 'dungeon_elite'];
  function checkBoss(w) {
    const label = `world "${w.key}" boss`;
    const b = w.boss;
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      errors.push(`${label} must be an object (got ${JSON.stringify(b)})`);
      return;
    }
    for (const k of Object.keys(b)) {
      if (!BOSS_KEYS.includes(k)) errors.push(`${label} has unknown key "${k}"`);
    }
    if (typeof b.entity !== 'string' || b.entity === '') {
      errors.push(`${label} entity must be an entity type name (got ${JSON.stringify(b.entity)})`);
    } else if (bossTiers) {
      const tier = bossTiers.get(b.entity) ?? null;
      const want = /: End$/.test(w.name ?? '') ? 'dungeon_end'
        : /: Elite$/.test(w.name ?? '') ? 'dungeon_elite' : null;
      if (!DUNGEON_BOSS_TIERS.includes(tier)) {
        errors.push(`${label} entity "${b.entity}" is not a dungeon boss `
          + `(boss_tier ${tier ?? 'NULL'}; needs dungeon_end or dungeon_elite)`);
      } else if (want && tier !== want) {
        errors.push(`${label} entity "${b.entity}" is ${tier}, but "${w.name}" needs ${want}`);
      }
    }
    for (const f of ['x', 'y']) {
      if (!Number.isInteger(b[f])) {
        errors.push(`${label} ${f} must be an integer in world pixels (got ${JSON.stringify(b[f])})`);
      }
    }
    const maxX = (w.width ?? 0) * SPEC_TILE_SIZE;
    const maxY = (w.height ?? 0) * SPEC_TILE_SIZE;
    if (Number.isInteger(b.x) && (b.x < 0 || b.x >= maxX)) {
      errors.push(`${label} x ${b.x} is outside the world (0..${maxX - 1} px)`);
    }
    if (Number.isInteger(b.y) && (b.y < 0 || b.y >= maxY)) {
      errors.push(`${label} y ${b.y} is outside the world (0..${maxY - 1} px)`);
    }
    if (!Number.isInteger(b.respawn_s) || b.respawn_s <= 0) {
      errors.push(`${label} respawn_s must be a positive integer (got ${JSON.stringify(b.respawn_s)})`);
    }
  }
```

Directly after the chest block closes (after `checkArt(c.art, 'chest_vault', ...)` and its two closing braces, `:673`):

```js
    if (w.boss !== undefined) checkBoss(w);
```

- [ ] **Step 4: Feed the catalog from both callers.** In `seed-map.js` `applyMapSpec`, add to the `catalogs` object (after `pointArtTypes`, `:167`):

```js
    // SOMET-609: boss tiers for the `boss` block's catalog check.
    bossTiers: new Map((await pool.query(
      'SELECT name, boss_tier FROM entity_types WHERE is_creature = true AND boss_tier IS NOT NULL',
    )).rows.map((r) => [r.name, r.boss_tier])),
```

In `tests/map_spec_fixtures.test.js`, add `const { DUNGEON_BOSSES } = require('../seeds/data/dungeonBosses.js');` beside the other catalog requires. Add `const BOSS_TIERS = new Map(DUNGEON_BOSSES.map((b) => [b.name, b.boss_tier]));` beside `POINT_ART_TYPES`, and pass `bossTiers: BOSS_TIERS,` in the `validateMapSpec` call at `:165-168`.

- [ ] **Step 5: Run, expect PASS:** `cd $WT/backend && node --test tests/map_spec_boss.test.js tests/map_spec_validate.test.js tests/map_spec_fixtures.test.js; echo "exit=$?"` → `exit=0`. The checked-in specs have no `boss` yet. Task 6 adds them and makes the fixtures loop non-vacuous.

- [ ] **Step 6: Commit**

```bash
cd $WT && git add backend/seeds/mapSpec.js backend/scripts/seed-map.js backend/tests/map_spec_boss.test.js backend/tests/map_spec_fixtures.test.js
git commit -m "feat(maps): validateMapSpec checks the per-world boss block (SOMET-609)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The boss post must be walkable, and `applyMapSpec` writes it

**Files:**
- Modify: `backend/scripts/seed-map.js:133-135` (`requiredTilesFor`), `:219-268` (worlds UPSERT)
- Test: `backend/tests/required_tiles_boss.test.js`, `backend/tests/seed_map_boss_db.test.js` (create)

**Interfaces:**
- Produces: `requiredTilesFor(...)` also returns `{ row, col, what: 'dungeon boss' }` for a well-formed `w.boss`. `worlds.dungeon_boss` = `JSON.stringify(w.boss)` or NULL, re-asserted on every seed.

- [ ] **Step 1: Write the failing unit test** (offline, the same oracle as `p5_navigability.test.js`)

```js
// backend/tests/required_tiles_boss.test.js
// SOMET-609 (S9). A boss post sits on GENERATED terrain like a vault chest:
// requiredTilesFor must list it so assertNavigable rejects a post a player can
// never reach (the same seam the chest uses, seed-map.js:133).
const test = require('node:test');
const assert = require('node:assert/strict');
const { requiredTilesFor } = require('../scripts/seed-map.js');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig.js');
const { assertNavigable } = require('../src/services/navigability.js');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');

const TILE_TYPES = Object.fromEntries(DEFAULT_TILE_TYPES.map((t) => [t.name, { walkable: t.walkable }]));
const DEEP_FOREST = STARTER_BIOMES.find((b) => b.name === 'Deep Forest');

const world = (boss) => ({
  key: 'zz', name: 'Zz', seed: 991, width: 64, height: 64, chunk_size: 32, biome_cell: 32,
  biomes: ['Deep Forest'], level_band: [1, 1], ...(boss === undefined ? {} : { boss }),
});
const rowOf = (w) => ({ seed: w.seed, chunk_size: w.chunk_size, width: w.width, height: w.height,
  entry_spawn: null, biome_cell: w.biome_cell, level_min: 1, level_max: 1 });

test('a boss block adds exactly one "dungeon boss" required tile at its post', () => {
  const w = world({ entity: 'x', x: 3250, y: 3850, respawn_s: 1 });
  const tiles = requiredTilesFor(w, { links: [] }, rowOf(w), ['W']);
  assert.deepEqual(tiles.filter((t) => t.what === 'dungeon boss'), [{ row: 38, col: 32, what: 'dungeon boss' }]);
});

test('no boss, or a malformed one, adds no tile and does not throw', () => {
  for (const boss of [undefined, null, { entity: 'x' }, { x: 'a', y: 2 }]) {
    const w = world(boss);
    assert.equal(requiredTilesFor(w, { links: [] }, rowOf(w), ['W']).filter((t) => t.what === 'dungeon boss').length, 0);
  }
});

test('a boss post on the wall ring fails assertNavigable; an interior post passes', () => {
  const run = (x, y) => {
    const w = world({ entity: 'x', x, y, respawn_s: 1 });
    const cfg = buildWorldGenConfig({ row: rowOf(w), tileTypes: TILE_TYPES, doorways: ['W'], villages: [], biomes: [DEEP_FOREST] });
    return assertNavigable(cfg, requiredTilesFor(w, { links: [] }, rowOf(w), ['W']));
  };
  assert.ok(run(50, 50).some((p) => /dungeon boss/.test(p)), 'corner (0,0) is the stamped wall ring');
  assert.deepEqual(run(3250, 3250), []);
});
```

If the interior case reports a decoration-free terrain blocker at (32,32) for seed 991 (the probe used for this plan found centre tiles walkable for this biome), move the interior post one tile and say so in a comment. The tile is fixture data, not the thing under test.

- [ ] **Step 2: Run, confirm FAIL:** `cd $WT/backend && node --test tests/required_tiles_boss.test.js; echo "exit=$?"`. Expected: the first and third tests fail (no `dungeon boss` tile, so the corner post "passes"). `exit=1`.

- [ ] **Step 3: Implement `requiredTilesFor`.** Directly after the vault-chest push (`seed-map.js:133-135`):

```js
  // SOMET-609: a dungeon boss post is generated terrain too. A boss standing in
  // a sealed pocket (or in a wall) is a boss nobody can fight; listing the post
  // makes assertNavigable prove it is walkable AND reachable from the doorways.
  if (w.boss && Number.isFinite(w.boss.x) && Number.isFinite(w.boss.y)) {
    out.push({ row: Math.floor(w.boss.y / 100), col: Math.floor(w.boss.x / 100), what: 'dungeon boss' });
  }
```

Run again and expect PASS.

- [ ] **Step 4: Write the failing seed DB test**

```js
// backend/tests/seed_map_boss_db.test.js
// SOMET-609 (S9). applyMapSpec writes the spec's boss block to
// worlds.dungeon_boss and RE-ASSERTS it: removing the key from the spec must
// clear the column (spec beats any hand edit, memory: spec-beats-migration).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { applyMapSpec } = require('../scripts/seed-map.js');
const { withEntryPreserved } = require('./helpers/entryWorld.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;
const NAME = 'zzS9 Boss Seed World';

const spec = (boss) => ({
  name: 'zz-s9-boss', topology: 'spine',
  worlds: [{
    key: 'zz', name: NAME, grid: [9, -9], seed: 991, width: 64, height: 64, chunk_size: 32,
    biomes: ['Deep Forest'], biome_cell: 32, allowed_creature_types: [], is_entry: true,
    entry_spawn: { x: 3250, y: 3250 }, ...(boss ? { boss } : {}),
  }],
  links: [],
});

test('applyMapSpec writes, then clears, worlds.dungeon_boss', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 3 });
  const read = async () => (await pool.query('SELECT dungeon_boss FROM worlds WHERE name = $1', [NAME])).rows[0].dungeon_boss;
  try {
    await pool.query('DELETE FROM worlds WHERE name = $1', [NAME]);
    await withEntryPreserved(pool, async () => {
      const boss = { entity: 'The Bone Regent', x: 3550, y: 3250, respawn_s: 900 };
      await applyMapSpec(pool, spec(boss));
      assert.deepEqual(await read(), boss);
      await applyMapSpec(pool, spec(null));
      assert.equal(await read(), null, 'a re-seed without the key must clear the column');
    });
  } finally {
    await pool.query('DELETE FROM worlds WHERE name = $1', [NAME]).catch(() => {});
    await pool.end();
  }
});
```

If `applyMapSpec` reports `world "zz" is not navigable` for the boss post (a blocking decoration on (32,35)), pick the nearest tile it accepts and note it in the fixture. The post is fixture data.

- [ ] **Step 5: Run, confirm FAIL:** `cd $WT/backend && TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 node --test tests/seed_map_boss_db.test.js; echo "exit=$?"`. Expected: `actual: null` vs the boss object, `exit=1`.

- [ ] **Step 6: Implement the UPSERT.** In `seed-map.js:219-268`, append `dungeon_boss` to the column list, add `$20::jsonb` to `VALUES`, add one line to the `ON CONFLICT ... DO UPDATE SET` list, and add one parameter. The result:

```js
        `INSERT INTO worlds (name, seed, chunk_size, width, height,
                             allowed_creature_types, entry_spawn, biomes, biome_cell,
                             graph_x, graph_y, level_min, level_max, density,
                             allows_fast_travel, safe_road_radius, safe_rects,
                             authored_roads, pens, dungeon_boss)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,
                 $18::jsonb,$19::jsonb,$20::jsonb)
         ON CONFLICT (name) DO UPDATE
           SET ...existing lines unchanged...,
               pens = EXCLUDED.pens,
               -- SOMET-609: re-asserted like every authored column; removing
               -- the key from a spec removes the boss.
               dungeon_boss = EXCLUDED.dungeon_boss
         RETURNING id`,
        [...existing 19 params unchanged...,
         w.boss ? JSON.stringify(w.boss) : null],
```

- [ ] **Step 7: Run, expect PASS.** Then run the existing seed-map tests to prove the extra column broke nothing: `... node --test tests/seed_map_db.test.js tests/safe_region_population_db.test.js tests/authored_maps_navigability.test.js tests/p5_navigability.test.js; echo "exit=$?"` → `exit=0`, or only failures that were already in the baseline.

- [ ] **Step 8: Commit**

```bash
cd $WT && git add backend/scripts/seed-map.js backend/tests/required_tiles_boss.test.js backend/tests/seed_map_boss_db.test.js
git commit -m "feat(maps): seed-map writes dungeon_boss and proves the boss post walkable (SOMET-609)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The p5 generator places the six bosses

**Files:**
- Modify: `backend/scripts/dungeon/content.js:20-24` (d1), `:35-39` (d4), `:54-62` (d7)
- Modify: `backend/scripts/dungeon/gen-p5-map-content.js` (`bossPlacement` near `portalPlacement` `:82`; stamping in `generateSpec` after the village pass `:540-545`; export `:675`)
- Regenerate: `backend/seeds/maps/p5-descent.map.json`
- Test: `backend/tests/p5_gen_map_content.test.js` (modify), `backend/tests/p5_spec_generated.test.js` (create)

**Interfaces:**
- Produces: `DUNGEONS[i].bosses?: { end: { entity, respawn_s }, elite: { entity, respawn_s } }`; `bossPlacement(world, room): { x, y }`; spec worlds `d1_end`, `d1_elite`, `d4_end`, `d4_elite`, `d7_end`, `d7_elite` gain `boss`.

**Placement rule (verified offline for this plan).** Let `c = width / 2`. An End room's centre tile holds the guarded exit portal (`(c,c)`, `p5-descent.map.json` links) and its return portal sits at `(c-3,c-3)`. The End boss stands 6 tiles south of the exit portal at tile `(row c+6, col c)`, so a player walking from the W doorway to the exit portal enters its 600 px aggro radius. Elite rooms have no portal, and their boss stands on the centre tile `(c, c)`. A probe running the same `buildWorldGenConfig` + `requiredTilesFor` + `assertNavigable` check as `tests/p5_navigability.test.js` passed all six posts: d1_end (54,48), d1_elite (48,48), d4_end (86,80), d4_elite (80,80), d7_end (118,112), d7_elite (112,112). The negative control, tile (0,0), failed as "unreachable" in every world. Pixel posts: d1_end (4850,5450), d1_elite (4850,4850), d4_end (8050,8650), d4_elite (8050,8050), d7_end (11250,11850), d7_elite (11250,11250).

- [ ] **Step 1: Write the failing tests.** Append to `tests/p5_gen_map_content.test.js`. It already requires `generateSpec` at the top, so add the two requires below if they are missing:

```js
const { DUNGEON_BOSSES } = require('../seeds/data/dungeonBosses.js');

// SOMET-609 (S9): each spine dungeon's End and Elite rooms hold exactly one
// boss of the right tier, at the documented post, inside the world.
test('the six End/Elite rooms each declare one dungeon boss of the right tier', () => {
  const spec = generateSpec();
  const tierOf = new Map(DUNGEON_BOSSES.map((b) => [b.name, b.boss_tier]));
  const bossed = spec.worlds.filter((w) => w.boss);
  assert.deepEqual(bossed.map((w) => w.key).sort(),
    ['d1_elite', 'd1_end', 'd4_elite', 'd4_end', 'd7_elite', 'd7_end']);
  for (const w of bossed) {
    const want = w.key.endsWith('_end') ? 'dungeon_end' : 'dungeon_elite';
    assert.equal(tierOf.get(w.boss.entity), want, `${w.key} boss ${w.boss.entity}`);
    assert.ok(w.boss.x >= 0 && w.boss.x < w.width * 100 && w.boss.y >= 0 && w.boss.y < w.height * 100, w.key);
  }
  const posts = Object.fromEntries(bossed.map((w) => [w.key, [w.boss.entity, w.boss.x, w.boss.y, w.boss.respawn_s]]));
  assert.deepEqual(posts, {
    d1_end: ['The Bone Regent', 4850, 5450, 900], d1_elite: ['Ossuary Warden', 4850, 4850, 600],
    d4_end: ['The Ember Queen', 8050, 8650, 900], d4_elite: ['Cinder Matriarch', 8050, 8050, 600],
    d7_end: ['The Umbral Gatekeeper', 11250, 11850, 900], d7_elite: ['Shade Herald', 11250, 11250, 600],
  });
});

test('no non-End/Elite world declares a boss', () => {
  for (const w of generateSpec().worlds) {
    if (!/: (End|Elite)$/.test(w.name)) assert.equal(w.boss, undefined, w.key);
  }
});
```

Create `tests/p5_spec_generated.test.js`:

```js
// backend/tests/p5_spec_generated.test.js
// SOMET-609 (S9). p5-descent.map.json is GENERATED. Hand-patched values have
// been silently dropped on regeneration twice (allows_fast_travel, SOMET-306;
// village keys, SOMET-451). This pins the checked-in file to the generator so
// a hand-added `boss` block (or any other patch) fails here, not months later.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generateSpec } = require('../scripts/dungeon/gen-p5-map-content.js');

test('the checked-in p5-descent spec is exactly the generator output', () => {
  const expected = JSON.stringify(generateSpec(), null, 2) + '\n';
  const actual = fs.readFileSync(path.join(__dirname, '../seeds/maps/p5-descent.map.json'), 'utf8');
  assert.ok(actual === expected,
    'p5-descent.map.json differs from generateSpec(): edit scripts/dungeon/content.js or '
    + 'gen-p5-map-content.js and run `node scripts/dungeon/gen-p5-map-content.js`; never hand-edit the JSON');
});
```

- [ ] **Step 2: Run, confirm FAIL** (`p5_spec_generated` PASSES today, which is fine because it guards Step 5):
`cd $WT/backend && node --test tests/p5_gen_map_content.test.js tests/p5_spec_generated.test.js; echo "exit=$?"`. Expected: `the six End/Elite rooms...` fails with `actual: []`, `exit=1`.

- [ ] **Step 3: Implement `content.js`.** Add a `bosses` key to the d1, d4 and d7 objects (after `guardCreature`):

```js
    // SOMET-609 (S9, spec §3.8): entity_types rows from seeds/data/dungeonBosses.js.
    bosses: {
      end: { entity: 'The Bone Regent', respawn_s: 900 },
      elite: { entity: 'Ossuary Warden', respawn_s: 600 },
    },
```

d4: `The Ember Queen` / `Cinder Matriarch`. d7: `The Umbral Gatekeeper` / `Shade Herald`. Same respawn values. Extend the header comment with one line: `bosses names the dungeon's End/Elite boss rows (spine dungeons only: only the spine skeleton has End/Elite rooms).`

- [ ] **Step 4: Implement the generator.** Below `returnPortalPlacement` (`:105`):

```js
// SOMET-609 (S9). Where a dungeon boss stands. End: 6 tiles SOUTH of the
// centre-tile exit portal, so the walk from the W doorway to that portal passes
// through its aggro radius without stacking it on the portal guard. Elite: the
// centre tile (Elite rooms have no portal). Every post was checked with the
// navigability oracle (tests/p5_navigability.test.js runs it on every build),
// and requiredTilesFor lists the post, so a re-roll that seals it fails loudly.
function bossPlacement(world, room) {
  const c = world.width / 2;
  const row = room === 'end' ? c + 6 : c;
  return { x: c * 100 + 50, y: row * 100 + 50 };
}
```

In `generateSpec`, directly after the village-stamping loop (`:540-545`):

```js
  // SOMET-609: dungeon bosses, from content.js. Stamped after sizing because
  // the post depends on the room's final size. A typo'd room key throws rather
  // than silently producing a dungeon with no boss.
  for (const { dungeon } of dungeonBuilds) {
    for (const [room, b] of Object.entries(dungeon.bosses || {})) {
      const w = sizedByKey.get(`${dungeon.key}_${room}`);
      if (!w) throw new Error(`${dungeon.key}.bosses.${room}: no world ${dungeon.key}_${room}`);
      w.boss = { entity: b.entity, ...bossPlacement(w, room), respawn_s: b.respawn_s };
    }
  }
```

Export it: `module.exports = { generateSpec, portalCenterPx, entryVillageBox, villageKeyFor, bossPlacement };`

- [ ] **Step 5: Regenerate and inspect the diff**

```bash
cd $WT/backend && node scripts/dungeon/gen-p5-map-content.js
git -C $WT diff --stat -- backend/seeds/maps/p5-descent.map.json   # expect only insertions (6 blocks x 6 lines + 6 commas)
git -C $WT diff -- backend/seeds/maps/p5-descent.map.json | grep '^-' | grep -v '^---'   # expect only the 6 '"density": "…"' lines that gain a trailing comma
node scripts/dungeon/gen-p5-map-content.js && git -C $WT diff --stat -- backend/seeds/maps/p5-descent.map.json   # regenerating twice is byte-identical
```

- [ ] **Step 6: Run, expect PASS** (this is where the fixtures loop and the navigability oracle start covering real boss blocks):
`cd $WT/backend && node --test tests/p5_gen_map_content.test.js tests/p5_spec_generated.test.js tests/p5_navigability.test.js tests/map_spec_fixtures.test.js tests/authored_maps_navigability.test.js tests/dungeon_guard_invariants.test.js; echo "exit=$?"` → `exit=0`.

RED check for the fixtures loop: temporarily change d1's End entity in `content.js` to `'Ossuary Warden'`, regenerate, and confirm `map_spec_fixtures` fails with `is dungeon_elite, but "The Catacombs: End" needs dungeon_end`. Then revert `content.js` and regenerate (`git diff` empty for both files). This proves the loop is armed.

- [ ] **Step 7: Seed the scratch DB with the new spec, vale-region last**

```bash
cd $WT/backend
DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 SPEC=p5-descent node scripts/seed-map.js; echo "exit=$?"
DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 SPEC=vale-region node scripts/seed-map.js; echo "exit=$?"
docker exec something2-db-1 psql -U user -d game_db_s9 -Atc "SELECT name, dungeon_boss->>'entity', dungeon_boss->>'x', dungeon_boss->>'y' FROM worlds WHERE dungeon_boss IS NOT NULL ORDER BY name"
```
Expected: both `exit=0` (this runs `assertNavigable` with decorations, which is stricter than the offline oracle), and exactly six rows that match the table above.

- [ ] **Step 8: Commit**

```bash
cd $WT && git add backend/scripts/dungeon/content.js backend/scripts/dungeon/gen-p5-map-content.js \
  backend/seeds/maps/p5-descent.map.json backend/tests/p5_gen_map_content.test.js backend/tests/p5_spec_generated.test.js
git commit -m "feat(maps): p5 generator places End and Elite bosses in the three spine dungeons (SOMET-609)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `DungeonBossManager`, the single owner of a dungeon boss's life

**Files:**
- Create: `backend/src/authority/dungeonBosses.js`
- Test: `backend/tests/dungeon_boss_manager.test.js`, `backend/tests/dungeon_boss_row_db.test.js` (create)

**Interfaces:**
- Consumes: `hydrateCreatureRow`, `ENTITY_CATALOG_SELECT` (`creatures.js:191, 252`, S1/S3); `isClearOfPlayers`, `RESPAWN_MIN_PLAYER_DISTANCE` (`creatureRespawn.js:33`).
- Produces:
  - `bossCreatureId(worldId) → 'boss:<worldId>'`. The spec says `boss:<worldKey>`, but `worlds` has no spec-key column. The authority's world key is the world id (`worlds` Map, `server.js:626`).
  - `parseDungeonBoss(raw) → { entity, x, y, respawnS } | null`.
  - `dungeonBossLevel(tier, levelMin, levelMax) → int`. End = `levelMax`. Elite = `min(levelMax, ceil((min+max)/2) + 1)` (spec "midpoint+").
  - `loadDungeonBossRow(pool, name) → row | null` (`ENTITY_CATALOG_SELECT` filtered to the dungeon tiers).
  - `class DungeonBossManager({ pool, loadRow, clock, onKilled, log })` with:
    - `isBoss(worldId, id): boolean`, a pure id test;
    - `place(entry): Promise<creature|null>`;
    - `onDeath(entry, id, killerUserId): kill|null`;
    - `sweep(worlds, getPlayers): Promise<number>`.
  - **S10 hook:** `onKilled(kill)` gets `kill = { entry, worldId, creatureId, killerUserId, entityName, entityTypeId, bossTier, level, x, y }`. It is called once per death, fire-and-forget, and its errors are caught and logged.

State lives in memory, keyed by world id, and outlives `entry`. That is what makes leaving and rejoining unable to skip the timer (Review Focus 2). A process restart resets it, consistent with "boss instances are not persisted" (spec §1/§4.1).

- [ ] **Step 1: Write the failing unit test**

```js
// backend/tests/dungeon_boss_manager.test.js
// SOMET-609 (S9, spec §4.1). One owner places a dungeon boss, notes its death
// and brings it back exactly once after respawn_s -- across double loads,
// eviction/reload and repeated sweeps.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CreatureSim } = require('../src/authority/creatures.js');
const {
  DungeonBossManager, parseDungeonBoss, dungeonBossLevel, bossCreatureId,
} = require('../src/authority/dungeonBosses.js');

const stubMap = () => ({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 });
const ROW = {
  id: 77, name: 'zzElite', hp: 4100, max_hp: 4100, defense: 36, faction: 'hostile',
  boss_tier: 'dungeon_elite', element: 'arcane', hitbox_size: 80, base_damage: 56,
  aura_names: null, aura_defs: null,
};
const SPEC = { entity: 'zzElite', x: 1150, y: 1250, respawn_s: 600 };

function harness({ row = ROW, spec = SPEC, levelMin = 41, levelMax = 50 } = {}) {
  let now = 1_000_000;
  const warnings = [];
  const kills = [];
  const loads = [];
  const mgr = new DungeonBossManager({
    loadRow: async (name) => { loads.push(name); return name === row?.name ? row : null; },
    clock: () => now,
    onKilled: (k) => kills.push(k),
    log: { warn: (m) => warnings.push(m), error: (m) => warnings.push(m) },
  });
  const newEntry = () => ({
    worldId: 'w-1',
    row: { dungeon_boss: spec, level_min: levelMin, level_max: levelMax },
    world: { creatures: new CreatureSim(stubMap(), () => 0.05) },
  });
  return { mgr, newEntry, warnings, kills, loads, advance: (ms) => { now += ms; } };
}
const bosses = (entry) => entry.world.creatures.all().filter((c) => c.bossTier);
const kill = (entry, id) => entry.world.creatures._removeKilled(entry.world.creatures.get(id));

test('place adds one boss with fixed id, tier, level, full hp and a leash post', async () => {
  const h = harness();
  const e = h.newEntry();
  const c = await h.mgr.place(e);
  assert.equal(c.id, 'boss:w-1');
  assert.equal(bossCreatureId('w-1'), 'boss:w-1');
  assert.equal(c.bossTier, 'dungeon_elite');
  assert.equal(c.level, 47, 'Elite at [41,50] = ceil(45.5)+1');
  assert.equal(c.hp, 4100);
  assert.equal(c.width, 80);
  assert.deepEqual(c.home, { x: 1150, y: 1250 });
  assert.equal(bosses(e).length, 1);
});

test('a double place, and concurrent places, leave exactly one instance', async () => {
  const h = harness();
  const e = h.newEntry();
  await Promise.all([h.mgr.place(e), h.mgr.place(e)]);
  await h.mgr.place(e);
  assert.equal(bosses(e).length, 1);
});

test('a kill is noted once, fires onKilled once, and the boss stays dead until due', async () => {
  const h = harness();
  const e = h.newEntry();
  await h.mgr.place(e);
  const before = e.world.creatures.get('boss:w-1');
  before.x = 1300; // moved before dying: the kill record carries the LAST position
  kill(e, 'boss:w-1');
  const k = h.mgr.onDeath(e, 'boss:w-1', 'u9');
  assert.deepEqual(
    { ...k, entry: undefined },
    { entry: undefined, worldId: 'w-1', creatureId: 'boss:w-1', killerUserId: 'u9', entityName: 'zzElite',
      entityTypeId: 77, bossTier: 'dungeon_elite', level: 47, x: 1300, y: 1250 });
  assert.equal(h.mgr.onDeath(e, 'boss:w-1', 'u9'), null, 'a duplicate death report is ignored');
  assert.equal(h.kills.length, 1);

  h.advance(599_999);
  assert.equal(await h.mgr.place(e), null, 'a reload before due places nothing');
  assert.equal(await h.mgr.sweep(new Map([['w-1', e]])), 0);
  assert.equal(bosses(e).length, 0);
});

test('eviction + reload while dead does not bring the boss back early (no leave/rejoin farming)', async () => {
  const h = harness();
  const e1 = h.newEntry();
  await h.mgr.place(e1);
  kill(e1, 'boss:w-1');
  h.mgr.onDeath(e1, 'boss:w-1', null);
  h.advance(60_000);
  const e2 = h.newEntry(); // a brand-new entry: what loadWorld builds after evictWorld
  assert.equal(await h.mgr.place(e2), null);
  assert.equal(bosses(e2).length, 0);
});

test('after respawn_s the sweep places it exactly once; a second sweep adds nothing', async () => {
  const h = harness();
  const e = h.newEntry();
  await h.mgr.place(e);
  kill(e, 'boss:w-1');
  h.mgr.onDeath(e, 'boss:w-1', null);
  h.advance(600_000);
  const worlds = new Map([['w-1', e]]);
  assert.equal(await h.mgr.sweep(worlds), 1);
  assert.equal(await h.mgr.sweep(worlds), 0);
  assert.equal(bosses(e).length, 1);
  assert.equal(e.world.creatures.get('boss:w-1').hp, 4100, 'respawns at full hp');
});

test('a due boss is NOT respawned while a player stands within 1000px of its post', async () => {
  const h = harness();
  const e = h.newEntry();
  await h.mgr.place(e);
  kill(e, 'boss:w-1');
  h.mgr.onDeath(e, 'boss:w-1', null);
  h.advance(600_000);
  const worlds = new Map([['w-1', e]]);
  assert.equal(await h.mgr.sweep(worlds, () => [{ x: 1150 + 999, y: 1250 }]), 0);
  assert.equal(await h.mgr.sweep(worlds, () => [{ x: 1150 + 1000, y: 1250 }]), 1, 'exactly 1000px is clear');
});

test('a due boss in an unloaded world waits; the next load places it', async () => {
  const h = harness();
  const e1 = h.newEntry();
  await h.mgr.place(e1);
  kill(e1, 'boss:w-1');
  h.mgr.onDeath(e1, 'boss:w-1', null);
  h.advance(700_000);
  assert.equal(await h.mgr.sweep(new Map()), 0);
  const e2 = h.newEntry();
  assert.ok(await h.mgr.place(e2));
  assert.equal(bosses(e2).length, 1);
});

test('a missing, renamed or untiered boss row places nothing and warns once', async () => {
  for (const row of [null, { ...ROW, boss_tier: null }, { ...ROW, boss_tier: 'world' }]) {
    const h = harness({ row: row ?? { ...ROW, name: 'zzOther' } });
    const e = h.newEntry();
    assert.equal(await h.mgr.place(e), null);
    assert.equal(await h.mgr.place(e), null);
    assert.equal(bosses(e).length, 0);
    assert.equal(h.warnings.length, 1, JSON.stringify(h.warnings));
  }
});

test('a malformed dungeon_boss places nothing, warns once, never queries the catalog', async () => {
  for (const spec of [[], 'x', { entity: '', x: 1, y: 1, respawn_s: 1 }, { entity: 'zzElite', x: 1, y: 1, respawn_s: 0 }]) {
    const h = harness({ spec });
    const e = h.newEntry();
    assert.equal(await h.mgr.place(e), null);
    await h.mgr.place(e);
    assert.equal(h.warnings.length, 1);
    assert.deepEqual(h.loads, []);
  }
  const h = harness({ spec: null });
  assert.equal(await h.mgr.place(h.newEntry()), null);
  assert.equal(h.warnings.length, 0, 'no boss is the normal case, not a warning');
});

test('isBoss is an id test: only boss:<thisWorld>', () => {
  const { mgr } = harness();
  assert.equal(mgr.isBoss('w-1', 'boss:w-1'), true);
  assert.equal(mgr.isBoss('w-2', 'boss:w-1'), false);
  assert.equal(mgr.isBoss('w-1', 'wb_123_4'), false);
  assert.equal(mgr.isBoss('w-1', '6f1c...uuid'), false);
});

test('an onKilled that throws or rejects is logged, never propagated', async () => {
  for (const onKilled of [() => { throw new Error('boom'); }, async () => { throw new Error('later'); }]) {
    const h = harness();
    h.mgr.onKilled = onKilled;
    const e = h.newEntry();
    await h.mgr.place(e);
    kill(e, 'boss:w-1');
    assert.doesNotThrow(() => h.mgr.onDeath(e, 'boss:w-1', null));
    await new Promise((r) => setImmediate(r));
    assert.ok(h.warnings.some((m) => /onKilled failed/.test(String(m))));
  }
});

test('levels: End = band ceiling, Elite = ceil(mid)+1 capped at the ceiling', () => {
  assert.equal(dungeonBossLevel('dungeon_end', 1, 7), 7);
  assert.equal(dungeonBossLevel('dungeon_elite', 1, 7), 5);
  assert.equal(dungeonBossLevel('dungeon_elite', 16, 26), 22);
  assert.equal(dungeonBossLevel('dungeon_elite', 41, 50), 47);
  assert.equal(dungeonBossLevel('dungeon_elite', 1, 1), 1);
  assert.equal(dungeonBossLevel('dungeon_end', null, undefined), 1);
});

test('parseDungeonBoss keeps the four fields and rejects junk', () => {
  assert.deepEqual(parseDungeonBoss({ entity: 'A', x: 1, y: 2, respawn_s: 3 }), { entity: 'A', x: 1, y: 2, respawnS: 3 });
  for (const bad of [null, [], { entity: 'A', x: -1, y: 2, respawn_s: 3 }, { entity: 'A', x: 1, y: 2, respawn_s: 1.5 }]) {
    assert.equal(parseDungeonBoss(bad), null, JSON.stringify(bad));
  }
});
```

- [ ] **Step 2: Run, confirm FAIL:** `cd $WT/backend && node --test tests/dungeon_boss_manager.test.js; echo "exit=$?"` → `Cannot find module '../src/authority/dungeonBosses.js'`, `exit=1`.

- [ ] **Step 3: Implement**

```js
// backend/src/authority/dungeonBosses.js
// SOMET-609 (S9, spec §4.1). Dungeon End/Elite bosses: placed when their world
// loads, brought back once after respawn_s. THE single owner of a dungeon
// boss's life -- the creature_respawns queue never sees one (a boss has no
// world_creatures row, and loot.js / respawnDueCreatures refuse boss-tier
// types as a backstop), and server.js's onCreatureDeath routes every `boss:`
// id here BEFORE commitCreatureDeath or WorldBossManager.
//
// State is in memory, keyed by world id, and outlives the world entry: a world
// evicted while its boss is dead and reloaded before due stays bossless. A
// process restart resets it -- boss instances are not persisted (spec §1).
const { hydrateCreatureRow, ENTITY_CATALOG_SELECT } = require('./creatures.js');
const { isClearOfPlayers, RESPAWN_MIN_PLAYER_DISTANCE } = require('../services/creatureRespawn.js');

const DUNGEON_BOSS_TIERS = Object.freeze(['dungeon_end', 'dungeon_elite']);
const ID_PREFIX = 'boss:';

function bossCreatureId(worldId) {
  return `${ID_PREFIX}${worldId}`;
}

// worlds.dungeon_boss -> a placement, or null when absent or malformed.
function parseDungeonBoss(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { entity, x, y, respawn_s: respawnS } = raw;
  if (typeof entity !== 'string' || entity === '') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return null;
  if (!Number.isInteger(respawnS) || respawnS <= 0) return null;
  return { entity, x, y, respawnS };
}

// Spec §3.8: End = the room's level_band ceiling, Elite = "midpoint+". Derived
// from the LIVE world row, so a re-banded room re-levels its boss on next load.
function dungeonBossLevel(tier, levelMin, levelMax) {
  const lo = Number.isInteger(levelMin) && levelMin >= 1 ? levelMin : 1;
  const hi = Number.isInteger(levelMax) && levelMax >= lo ? levelMax : lo;
  if (tier === 'dungeon_end') return hi;
  return Math.min(hi, Math.ceil((lo + hi) / 2) + 1);
}

// The boss TYPE row through the shared catalog SELECT (S1/S3), so behaviour,
// abilities, vfx, auras and the boss fields arrive exactly as for a world boss.
async function loadDungeonBossRow(pool, name) {
  const r = await pool.query(
    `${ENTITY_CATALOG_SELECT}
      WHERE et.name = $1 AND et.is_creature = true AND et.boss_tier = ANY($2::text[])`,
    [name, DUNGEON_BOSS_TIERS],
  );
  return r.rows[0] || null;
}

class DungeonBossManager {
  constructor({ pool = null, loadRow = null, clock = () => Date.now(), onKilled = null, log = console } = {}) {
    this.loadRow = loadRow || (pool ? (name) => loadDungeonBossRow(pool, name) : async () => null);
    this.clock = clock;
    // S10 (boss loot) hooks here. S9 awards nothing: there is no world_creatures
    // row for commitCreatureDeath to commit.
    this.onKilled = onKilled;
    this.log = log;
    this.records = new Map(); // worldId -> { creatureId, deadUntil, creature, row, spec }
    this._warned = new Set();
  }

  // Pure id test, so a boss kill is routed here even when the record is gone
  // (it must never fall through to commitCreatureDeath's uuid DELETE).
  isBoss(worldId, creatureId) {
    return typeof creatureId === 'string' && creatureId === bossCreatureId(worldId);
  }

  _warnOnce(key, msg) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    this.log.warn(msg);
  }

  _deadNow(worldId) {
    const rec = this.records.get(worldId);
    return !!rec && rec.deadUntil != null && this.clock() < rec.deadUntil;
  }

  // Place this world's boss unless it is dead and not yet due. Idempotent:
  // addCreatures skips a known id, so a double load, or a load racing the
  // sweep, still leaves one instance. Never throws for bad data.
  async place(entry) {
    const raw = entry && entry.row ? entry.row.dungeon_boss : null;
    if (raw == null) return null;
    const worldId = entry.worldId;
    const spec = parseDungeonBoss(raw);
    if (!spec) {
      this._warnOnce(`spec:${worldId}`,
        `dungeon boss: world ${worldId} has a malformed dungeon_boss ${JSON.stringify(raw)}; no boss placed`);
      return null;
    }
    if (this._deadNow(worldId)) return null;
    const sim = entry.world && entry.world.creatures;
    if (!sim) return null;
    const id = bossCreatureId(worldId);
    const existing = sim.get(id);
    if (existing) return existing;

    const row = await this.loadRow(spec.entity);
    if (!row || !DUNGEON_BOSS_TIERS.includes(row.boss_tier)) {
      this._warnOnce(`row:${worldId}:${spec.entity}`,
        `dungeon boss: "${spec.entity}" (world ${worldId}) is not a dungeon_end/dungeon_elite creature; no boss placed`);
      return null;
    }
    // Re-check after the await: the boss may have been placed AND killed by a
    // concurrent caller while this one waited on the catalog.
    if (this._deadNow(worldId)) return null;

    const maxHp = Number(row.max_hp) || Number(row.hp) || 1;
    sim.addCreatures([hydrateCreatureRow(row, {
      id, x: spec.x, y: spec.y, hp: maxHp,
      level: dungeonBossLevel(row.boss_tier, entry.row.level_min, entry.row.level_max),
      // In-memory leash post (never persisted): the boss holds its room
      // instead of roaming the whole world after a player.
      home_x: spec.x, home_y: spec.y,
    })]);
    const creature = sim.get(id) || null;
    this.records.set(worldId, { creatureId: id, deadUntil: null, creature, row, spec });
    return creature;
  }

  // The boss died (it is already out of the sim, creatures.js:1249). Start the
  // respawn timer and hand S10 the kill. Returns the kill record, or null for a
  // duplicate report / unknown id.
  onDeath(entry, creatureId, killerUserId = null) {
    const worldId = entry && entry.worldId;
    const rec = this.records.get(worldId);
    if (!rec || rec.creatureId !== creatureId || rec.deadUntil != null) return null;
    rec.deadUntil = this.clock() + rec.spec.respawnS * 1000;
    const c = rec.creature || {};
    const kill = {
      entry, worldId, creatureId, killerUserId: killerUserId ?? null,
      entityName: rec.row.name, entityTypeId: rec.row.id ?? null, bossTier: rec.row.boss_tier,
      level: c.level ?? 1, x: c.x ?? rec.spec.x, y: c.y ?? rec.spec.y,
    };
    if (this.onKilled) {
      try {
        Promise.resolve(this.onKilled(kill)).catch((err) => this.log.error(`dungeon boss onKilled failed: ${err && err.message}`));
      } catch (err) {
        this.log.error(`dungeon boss onKilled failed: ${err && err.message}`);
      }
    }
    return kill;
  }

  // Re-place every due boss in a LOADED world whose post is clear of players
  // (the same 1000px rule as creature respawn). An unloaded world stays due and
  // its next load places the boss. Returns how many were placed.
  async sweep(worlds, getPlayers = () => []) {
    let placed = 0;
    const now = this.clock();
    for (const [worldId, rec] of this.records) {
      if (rec.deadUntil == null || now < rec.deadUntil) continue;
      const entry = worlds.get(worldId);
      if (!entry) continue;
      if (!isClearOfPlayers(rec.spec.x, rec.spec.y, getPlayers(worldId) || [], RESPAWN_MIN_PLAYER_DISTANCE)) continue;
      // Count real placements only: place() returns an already-present boss too.
      const sim = entry.world && entry.world.creatures;
      const had = sim ? sim.get(bossCreatureId(worldId)) : null;
      const c = await this.place(entry);
      if (c && !had) placed += 1;
    }
    return placed;
  }
}

module.exports = {
  DungeonBossManager, parseDungeonBoss, dungeonBossLevel, loadDungeonBossRow, bossCreatureId,
  DUNGEON_BOSS_TIERS,
};
```

- [ ] **Step 4: Run, expect PASS** (`exit=0`). For the RED proof of Review Focus 2, temporarily move `records` onto `entry` (`entry._bossRecord`) and confirm `eviction + reload while dead` fails. Then revert.

- [ ] **Step 5: Write the DB test** for the real catalog path (the SELECT carries the aura, so the Elite aura is live)

```js
// backend/tests/dungeon_boss_row_db.test.js
// SOMET-609 (S9). A real seeded Elite boss loads through ENTITY_CATALOG_SELECT
// and hydrates with its tier, size and RESOLVED ally aura -- the aura is inert
// if this path ever drops AURAS_LATERAL. An ordinary creature is refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { CreatureSim } = require('../src/authority/creatures.js');
const { DungeonBossManager, loadDungeonBossRow } = require('../src/authority/dungeonBosses.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

test('Ossuary Warden hydrates as a dungeon_elite boss carrying ossuary_dread', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    assert.equal(await loadDungeonBossRow(pool, 'Wolf'), null, 'an ordinary creature is not a dungeon boss');
    const mgr = new DungeonBossManager({ pool });
    const entry = {
      worldId: 'zz-s9-row',
      row: { dungeon_boss: { entity: 'Ossuary Warden', x: 4850, y: 4850, respawn_s: 600 }, level_min: 1, level_max: 7 },
      world: { creatures: new CreatureSim({ isWalkable: () => true, speedAt: () => 1, chunkSize: 32 }, () => 0.05) },
    };
    const c = await mgr.place(entry);
    assert.ok(c, 'placed');
    assert.equal(c.bossTier, 'dungeon_elite');
    assert.equal(c.level, 5);
    assert.equal(c.width, 72);
    assert.equal(c.damage, 14, 'base_damage reaches the sim through hydrateCreatureRow');
    const aura = (c.auras || []).find((a) => a.name === 'ossuary_dread');
    assert.ok(aura, `ossuary_dread resolved (got ${JSON.stringify(c.auras)})`);
    assert.equal(aura.targetSide, 'allies');
    assert.equal(aura.defenseMult, 1.3);
  } finally {
    await pool.end();
  }
});
```

If `defenseMult` reads `1.2999999523162842` (float4), compare with `Math.round(aura.defenseMult * 100) / 100`, and do not change the literal.

Run with both env vars. Expect PASS. It is RED if Task 2's migration is not applied (`placed` fails).

- [ ] **Step 6: Commit**

```bash
cd $WT && git add backend/src/authority/dungeonBosses.js backend/tests/dungeon_boss_manager.test.js backend/tests/dungeon_boss_row_db.test.js
git commit -m "feat(bosses): DungeonBossManager owns dungeon boss placement and respawn (SOMET-609)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Wire the manager into the authority (additive `server.js` edits)

**Files:**
- Modify: `backend/src/authority/server.js`:
  - require (near `:48`);
  - construct after `worldBossManager.refreshCatalog()` (`:501`);
  - `loadWorld` SELECT (`:648`) and placement after the `enqueueDeficit` try (`:787-791`);
  - `onCreatureDeath` first lines (`:934`);
  - `creatureRespawnSweep` (`:3535-3573`);
  - seams beside `_worldBossManager` (`:3727`).
- Test: `backend/tests/dungeon_boss_live_db.test.js` (create)

**Interfaces:**
- Consumes: `DungeonBossManager` (Task 7), `worlds.dungeon_boss` (Task 1).
- Produces: `attachAuthority` opts `dungeonBossClock?: () => number`, `onDungeonBossKilled?: (kill) => void` (S10's hook). Seams: `_dungeonBosses`, `_onCreatureDeath`, `_loadWorld`.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/dungeon_boss_live_db.test.js
// SOMET-609 (S9). The live authority on a real DB: a world with dungeon_boss
// loads with exactly one boss; killing it fires exactly ONE respawn path (the
// manager) -- no creature_respawns row, no world_creatures write, no
// WorldBossManager, no "death commit failed" -- and it comes back once after
// respawn_s, not before, not on reload, not twice.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Pool } = require('pg');
const { attachAuthority } = require('../src/authority/server.js');
const { withFixtureWorld } = require('./helpers/fixtureWorld');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

test('loadWorld selects dungeon_boss (explicit-column SELECT, SOMET-288/309 trap)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/authority/server.js'), 'utf8');
  const start = src.indexOf('async function loadWorld(');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  const m = /pool\.query\('SELECT ([^']+) FROM worlds WHERE id = \$1'/.exec(body);
  assert.ok(m, 'could not locate the worlds SELECT inside loadWorld');
  assert.ok(m[1].split(',').map((c) => c.trim()).includes('dungeon_boss'));
});

test('a placed dungeon boss: one instance, one respawn path, one respawn', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 4 });
  const server = http.createServer();
  let now = Date.now();
  const srv = attachAuthority(server, pool, {
    jwtSecret: 'test-secret', creatureSweepMs: 1e9, itemSweepMs: 1e9, heartbeatMs: 1e9,
    flushMs: 1e9, dungeonBossClock: () => now,
  });
  const errors = [];
  const origError = console.error;
  console.error = (...a) => { errors.push(a.map(String).join(' ')); origError(...a); };
  try {
    await withFixtureWorld(pool, async (worldId) => {
      await pool.query(
        `UPDATE worlds SET biomes = '["Deep Forest"]'::jsonb, level_min = 41, level_max = 50,
                dungeon_boss = $2::jsonb WHERE id = $1`,
        [worldId, JSON.stringify({ entity: 'Shade Herald', x: 4850, y: 4850, respawn_s: 600 })]);
      const id = `boss:${worldId}`;
      const bossesIn = (e) => e.world.creatures.all().filter((c) => c.bossTier);

      let entry = await srv._loadWorld(worldId);
      assert.equal(bossesIn(entry).length, 1, 'placed on load');
      const c = entry.world.creatures.get(id);
      assert.equal(c.type, 'Shade Herald');
      assert.equal(c.level, 47);
      await srv._dungeonBosses.place(entry); // a second placement attempt
      assert.equal(bossesIn(entry).length, 1, 'double placement is a no-op');

      let worldBossCalls = 0;
      const wbm = srv._worldBossManager;
      const origWb = wbm.onCreatureDeath.bind(wbm);
      wbm.onCreatureDeath = async (...a) => { worldBossCalls += 1; return origWb(...a); };
      const queries = [];
      const origQuery = pool.query.bind(pool);
      pool.query = (sql, ...rest) => { queries.push(String(sql)); return origQuery(sql, ...rest); };

      entry.world.creatures._removeKilled(c); // what every kill site does first (creatures.js:1249)
      await srv._onCreatureDeath(entry, id, null);
      await new Promise((r) => setTimeout(r, 50));
      pool.query = origQuery;

      assert.equal(worldBossCalls, 0, 'a dungeon boss is not a world boss');
      assert.ok(!queries.some((q) => /world_creatures|creature_respawns/.test(q)), queries.join('\n'));
      assert.ok(!errors.some((e) => /death commit failed/.test(e)), errors.join('\n'));
      const queued = await pool.query('SELECT count(*)::int AS n FROM creature_respawns WHERE world_id = $1', [worldId]);
      assert.equal(queued.rows[0].n, 0, 'the creature_respawns path never fires for a boss');

      // Leave + rejoin before due: the world is evicted and reloaded.
      now += 300_000;
      assert.equal(srv.evictWorld(worldId), true);
      entry = await srv._loadWorld(worldId);
      assert.equal(bossesIn(entry).length, 0, 'reload while dead places nothing');
      await srv._creatureRespawnSweep();
      assert.equal(bossesIn(entry).length, 0, 'the sweep before due places nothing');

      now += 300_000; // 600 s after death
      await srv._creatureRespawnSweep();
      assert.equal(bossesIn(entry).length, 1, 'exactly one respawn after respawn_s');
      await srv._creatureRespawnSweep();
      assert.equal(bossesIn(entry).length, 1, 'a second sweep adds nothing');
      const rows = await pool.query('SELECT count(*)::int AS n FROM world_creatures WHERE world_id = $1 AND type = $2', [worldId, 'Shade Herald']);
      assert.equal(rows.rows[0].n, 0, 'the boss is never persisted');
      srv.evictWorld(worldId);
    }, { prefix: 'zzS9live' });
  } finally {
    console.error = origError;
    srv.close();
    await pool.end();
  }
});
```

If `attachAuthority`'s `close()` is async in this codebase, `await` it. Check `server.js:3824`.

- [ ] **Step 2: Run, confirm FAIL:** `cd $WT/backend && TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 node --test tests/dungeon_boss_live_db.test.js; echo "exit=$?"`. Expected: the SELECT guard fails (`dungeon_boss` not selected), and the live test fails with `srv._loadWorld is not a function`. `exit=1`.

- [ ] **Step 3: Implement (additive only).** Require, next to the `WorldBossManager` require at `:48`:

```js
const { DungeonBossManager } = require('./dungeonBosses');
```

After `worldBossManager.refreshCatalog();` (`:501`):

```js
  // SOMET-609 (S9): dungeon End/Elite bosses. The single owner of their life:
  // placed in loadWorld, killed via onCreatureDeath (before commitCreatureDeath
  // and WorldBossManager), re-placed by creatureRespawnSweep. S10 passes
  // onDungeonBossKilled to roll boss loot; S9 awards nothing.
  const dungeonBosses = new DungeonBossManager({
    pool,
    clock: opts.dungeonBossClock || (() => Date.now()),
    onKilled: opts.onDungeonBossKilled || null,
  });
```

`loadWorld` SELECT (`:648`): append `, dungeon_boss` to the column list, and append to the comment above it: `// dungeon_boss (SOMET-609): read by DungeonBossManager.place below; omitting it would silently place no boss anywhere.`

After the `enqueueDeficit` try/catch (`:787-791`), before `return entry;`:

```js
        // SOMET-609: this world's dungeon boss, if its spec authored one. Never
        // fatal -- a bossless room is playable, a failed join is not.
        try {
          await dungeonBosses.place(entry);
        } catch (err) {
          console.error('dungeon boss placement failed:', canonicalId, err);
        }
```

First statement inside `onCreatureDeath` (`:934`, before `const deadCreature = ...`):

```js
    // SOMET-609: a dungeon boss has ONE respawn owner. It has no
    // world_creatures row (commitCreatureDeath's uuid DELETE would throw on a
    // `boss:` id) and is not a world boss, so it never reaches either path.
    if (dungeonBosses.isBoss(entry.worldId, id)) {
      dungeonBosses.onDeath(entry, id, killerUserId);
      return Promise.resolve(null);
    }
```

In `creatureRespawnSweep`, after the existing `try { await respawnDueCreatures(...) } catch ...` block closes, and still inside the function:

```js
    // SOMET-609: dungeon bosses ride the same 10 s timer but not its queue.
    try {
      await dungeonBosses.sweep(worlds, (worldId) => {
        const entry = worlds.get(worldId);
        return entry ? [...entry.world.players.values()].map((p) => ({ x: p.x, y: p.y })) : [];
      });
    } catch (err) {
      console.error('dungeon boss sweep failed:', err);
    }
```

Seams, directly after `_worldBossManager: worldBossManager,` (`:3727`):

```js
    // SOMET-609 test seams: the manager, the kill entry point every kill site
    // uses, and loadWorld (a world can be loaded without a socket).
    _dungeonBosses: dungeonBosses,
    _onCreatureDeath: onCreatureDeath,
    _loadWorld: loadWorld,
```

If `loadWorld`/`onCreatureDeath` are declared after the returned object is built, they are still hoisted function declarations or consts in scope. Confirm with the test, not by assumption.

- [ ] **Step 4: Run, expect PASS** (`exit=0`). RED proof for Review Focus 1/4: comment out the `isBoss` early return, re-run, and confirm the test fails on `death commit failed` / the `world_creatures` query assertion. Then restore it.

- [ ] **Step 5: Run the neighbouring suites** that drive `onCreatureDeath`/`loadWorld`: `... node --test tests/creature_respawn_db.test.js tests/creature_respawn.test.js tests/world_boss.test.js tests/world_boss_catalog_db.test.js tests/authority_creatures_integration.test.js tests/charm_live_db.test.js tests/progression_kill_xp.test.js; echo "exit=$?"` → `exit=0`. Fake-pool fixtures answer `FROM worlds WHERE id` with rows that lack `dungeon_boss`, which is `undefined`, so `place` returns null without querying. That is why they need no change.

- [ ] **Step 6: Commit**

```bash
cd $WT && git add backend/src/authority/server.js backend/tests/dungeon_boss_live_db.test.js
git commit -m "feat(authority): place dungeon bosses on world load; kills route to their one respawn owner (SOMET-609)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The legacy respawn paths refuse boss-tier types (defence in depth)

**Files:**
- Modify: `backend/src/authority/loot.js:109-115`
- Modify: `backend/src/services/creatureRespawn.js:133-136`
- Test: `backend/tests/boss_respawn_paths_db.test.js` (create)

**Interfaces:** no signature changes.

This closes the hazard from the Plane comment for any `world_creatures` row whose type is boss-tier. That happens when an admin tiers an existing creature type in the Entities tab while instances of it are alive. Both paths then decline: `loot.js` queues nothing, and the sweep deletes any stray queued row instead of inserting a plain creature. The existing source guard in `creature_respawn_db.test.js:287-311` (INSERT through `client`, between BEGIN and COMMIT) must stay green.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/boss_respawn_paths_db.test.js
// SOMET-609 (S9). Neither legacy respawn path may turn a boss-tier type into a
// plain persisted wild creature: commitCreatureDeath queues nothing for one,
// and respawnDueCreatures drops a stray queued row instead of inserting it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { commitCreatureDeath } = require('../src/authority/loot');
const { respawnDueCreatures } = require('../src/services/creatureRespawn');
const { withFixtureWorld } = require('./helpers/fixtureWorld');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;
const WORLD_CFG = { tileTypes: [{ name: 'grass' }], width: 96, height: 96, levelMin: 1, levelMax: 5 };

test('commitCreatureDeath queues no respawn for a boss-tier type, still queues for a wild one', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 3 });
  try {
    await withFixtureWorld(pool, async (worldId) => {
      const ins = async (type) => (await pool.query(
        `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage, defense)
         VALUES ($1,$2,500,500,10,'S',7,5,0) RETURNING id`, [worldId, type])).rows[0].id;
      const entry = { worldId, world: { getPlayer: () => null }, creatureTypeIds: new Map() };
      await commitCreatureDeath(pool, entry, await ins('The Bone Regent'), { killerUserId: null });
      await commitCreatureDeath(pool, entry, await ins('Wolf'), { killerUserId: null });
      const q = await pool.query('SELECT type FROM creature_respawns WHERE world_id = $1 ORDER BY type', [worldId]);
      assert.deepEqual(q.rows.map((r) => r.type), ['Wolf']);
    }, { prefix: 'zzS9loot' });
  } finally {
    await pool.end();
  }
});

test('respawnDueCreatures drops a queued boss-tier row and inserts no creature', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 3 });
  try {
    await withFixtureWorld(pool, async (worldId) => {
      await pool.query(
        `INSERT INTO creature_respawns (world_id, type, x, y, level, respawn_at)
         VALUES ($1,'The Bone Regent',500,500,7, now() - interval '1 second')`, [worldId]);
      const n = await respawnDueCreatures(pool, {
        loadedWorldIds: [worldId], getWorld: () => WORLD_CFG, getPlayers: () => [],
      });
      assert.equal(n, 0);
      const wc = await pool.query('SELECT count(*)::int AS n FROM world_creatures WHERE world_id = $1', [worldId]);
      assert.equal(wc.rows[0].n, 0, 'no plain persisted boss');
      const cr = await pool.query('SELECT count(*)::int AS n FROM creature_respawns WHERE world_id = $1', [worldId]);
      assert.equal(cr.rows[0].n, 0, 'the stray row is dropped, not retried forever');
    }, { prefix: 'zzS9sweep' });
  } finally {
    await pool.end();
  }
});
```

- [ ] **Step 2: Run, confirm FAIL:** both tests fail. The first gets `['The Bone Regent', 'Wolf']`, and the second gets `n = 1` with a persisted Bone Regent. `exit=1`.

- [ ] **Step 3: Implement `loot.js`** (replace the INSERT at `:110-114`, keeping the 6 parameters):

```js
      // SOMET-609: never for a boss-tier type. Dungeon and world bosses have
      // their own respawn owners and no world_creatures row; this guard covers
      // the admin who tiers a type while instances of it are alive.
      await client.query(
        `INSERT INTO creature_respawns (world_id, type, x, y, level, respawn_at)
         SELECT $1::uuid, $2::text, $3::real, $4::real, $5::int,
                now() + ($6::int * interval '1 millisecond')
          WHERE NOT EXISTS (SELECT 1 FROM entity_types WHERE name = $2::text AND boss_tier IS NOT NULL)`,
        [entry.worldId, dead.type, dead.x, dead.y, dead.level, RESPAWN_DELAY_MS],
      );
```

Check the column types before trusting the casts: `\d creature_respawns` on the scratch DB. `x`/`y` are `real` and `level` is `integer` in `1714440330000_creature_respawns.js`. If they differ, cast to the real types.

`creatureRespawn.js:133-136`, the per-row lookup:

```js
        // SOMET-609: boss-tier types are never respawned here (dungeon bosses
        // have DungeonBossManager, world bosses WorldBossManager). Such a row
        // takes the "catalog no longer has this creature" branch below and is
        // dropped instead of becoming a plain persisted wild creature.
        const et = await pool.query(
          `SELECT id, name, hp, defense, resistances FROM entity_types
            WHERE name = $1 AND is_creature = true AND boss_tier IS NULL`,
          [row.type],
        );
```

- [ ] **Step 4: Run, expect PASS,** together with the existing guards: `... node --test tests/boss_respawn_paths_db.test.js tests/creature_respawn_db.test.js tests/creature_respawn.test.js tests/loot_db.test.js; echo "exit=$?"` → `exit=0`. If `loot_db.test.js` does not exist, drop it from the list, and use `ls tests | grep -i loot` to find the commitCreatureDeath tests.

- [ ] **Step 5: Commit**

```bash
cd $WT && git add backend/src/authority/loot.js backend/src/services/creatureRespawn.js backend/tests/boss_respawn_paths_db.test.js
git commit -m "fix(respawn): creature_respawns never queues or respawns a boss-tier type (SOMET-609)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: A Druid cannot charm a boss

**Files:**
- Modify: `backend/src/services/charm.js:62` (+ `canBeCharmed`)
- Modify: `backend/src/authority/server.js:14` (require), `:2335` (one added guard line)
- Test: `backend/tests/charm_boss.test.js` (create)

**Interfaces:** `canBeCharmed(creature): boolean`. It is false for any `bossTier`.

The hazard: the charm handler (`server.js:2331-2378`) checks range, ownership and budget, but never boss-ness. A level-5 Ossuary Warden fits a modest charm budget. The in-memory charm would succeed, and then `UPDATE world_creatures ... WHERE id = $3` would throw on the `boss:` id, after the boss had already turned into a pet. World bosses have the same pre-existing hole, and this guard closes both.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/charm_boss.test.js
// SOMET-609 (S9). A boss is never a pet. Without this a Druid could charm a
// low-level dungeon Elite: the in-memory charm lands, then the persistence
// UPDATE throws on the non-uuid `boss:` id -- a boss pet nothing can undo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { canBeCharmed } = require('../src/services/charm.js');

test('canBeCharmed refuses every boss tier and accepts an ordinary creature', () => {
  for (const bossTier of ['world', 'dungeon_end', 'dungeon_elite']) {
    assert.equal(canBeCharmed({ type: 'X', bossTier }), false, bossTier);
  }
  assert.equal(canBeCharmed({ type: 'Wolf', bossTier: null }), true);
  assert.equal(canBeCharmed(null), false);
});

test('the charm handler consults canBeCharmed before the budget read', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/authority/server.js'), 'utf8');
  const pet = src.indexOf("already someone's pet");
  const guard = src.indexOf('canBeCharmed(c)', pet);
  const budget = src.indexOf('charmBudget(', pet);
  assert.ok(pet !== -1 && guard !== -1 && budget !== -1, 'markers present');
  assert.ok(guard < budget, 'boss check must precede the budget/DB work');
});
```

- [ ] **Step 2: Run, confirm FAIL** (`canBeCharmed is not a function`), `exit=1`.

- [ ] **Step 3: Implement.** In `charm.js`, above `module.exports`:

```js
// SOMET-609: bosses are never charmable -- not persisted (no row for the charm
// UPDATE), and a boss pet would walk a dungeon's End out of its room.
function canBeCharmed(creature) {
  return !!creature && !creature.bossTier;
}
```

Add `canBeCharmed` to `module.exports` and to the `server.js:14` require. In the charm handler, add one line directly after `if (c.charmOwnerUserId != null) return; // already someone's pet` (`:2335`):

```js
        if (!canBeCharmed(c)) return send(ws, { type: 'error', message: 'Charm refused: bosses cannot be charmed' });
```

- [ ] **Step 4: Run, expect PASS,** plus `tests/charm_live_db.test.js` (both env vars) → `exit=0`.

- [ ] **Step 5: Commit**

```bash
cd $WT && git add backend/src/services/charm.js backend/src/authority/server.js backend/tests/charm_boss.test.js
git commit -m "fix(charm): bosses cannot be charmed (SOMET-609)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: A physical-element boss is drawn as bone, not fire

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js:190-195`
- Test: `frontend/src/games/something2/src/js/systems/__tests__/bossRender.test.js` (add one `it`)

**Interfaces:** `RenderSystem.bossPalette('physical')` returns a bone palette. Every other element is unchanged.

`bossPalette` falls back to fire for anything unknown (`RenderSystem.js:189-195`). The Bone Regent and the Ossuary Warden are `physical`, so until S8 art lands they would be drawn as red fire titans.

- [ ] **Step 1: Write the failing test.** Add inside the existing `describe("boss rendering (SOMET-603)", ...)`:

```js
  it("bossPalette gives physical bosses a bone palette, not the fire fallback (SOMET-609)", () => {
    const physical = RenderSystem.bossPalette("physical");
    expect(physical.baseColor).toBe("#d8d2c0");
    expect(physical.baseColor).not.toBe(RenderSystem.bossPalette(undefined).baseColor);
    expect(RenderSystem.bossPalette("fire").baseColor).toBe("#ff4757");
  });
```

- [ ] **Step 2: Run, confirm FAIL:** `cd $WT/frontend && npx vitest run src/games/something2/src/js/systems/__tests__/bossRender.test.js; echo "exit=$?"` → expected `"#ff4757"` vs `"#d8d2c0"`, `exit=1`.

- [ ] **Step 3: Implement.** Add one line inside `bossPalette`, before the final fire `return`:

```js
    if (element === "physical") return { baseColor: "#d8d2c0", glowColor: "#f5f0e1", darkColor: "#2b2620", eyeColor: "#7dd3fc" };
```

- [ ] **Step 4: Run, expect PASS** (`exit=0`).

- [ ] **Step 5: Commit**

```bash
cd $WT && git add frontend/src/games/something2/src/js/systems/RenderSystem.js frontend/src/games/something2/src/js/systems/__tests__/bossRender.test.js
git commit -m "feat(render): bone palette for physical-element bosses (SOMET-609)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Full suites + browser verification on an isolated instance (backend :13105)

**Files:**
- Create (NOT committed, delete after): `frontend/vite.verify.config.mjs`
- No source changes. A defect found here goes back to its owning task as a RED test first.

**Interfaces:** consumes everything above.

- [ ] **Step 1: Full backend suite on the scratch DB** (openchest excluded). Compare against `s9-baseline.log`.

```bash
cd $WT/backend
TEST_DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 \
  node --test --test-timeout=420000 $(ls tests/*.test.js | grep -v authority_openchest_integration) > ../../s9-final.log 2>&1; echo "exit=$?"
grep -E '^not ok|testTimeoutFailure' ../../s9-final.log
```

Expected: no `not ok` line that is not also in the baseline. Watch `describe_audio_slots_db`, `audio_subjects_sfx_db`, `audio_prompt_context_db` and `creature_drops_db`, because they enumerate `is_creature` rows and now see 6 more. Watch `seed_map_db` and `map_spec_*` for the new `boss` key.

- [ ] **Step 2: Full frontend suite:** `cd $WT/frontend && npx vitest run; echo "exit=$?"` → `exit=0`.

- [ ] **Step 3: Make the bosses killable and fast on the SCRATCH DB only.** This is verification setup, never shipped, never run against `game_db`:

```bash
docker exec something2-db-1 psql -U user -d game_db_s9 -c "UPDATE entity_types SET hp = 60, max_hp = 60, defense = 0, base_damage = 1 WHERE boss_tier IN ('dungeon_end','dungeon_elite');"
docker exec something2-db-1 psql -U user -d game_db_s9 -c "UPDATE worlds SET dungeon_boss = jsonb_set(dungeon_boss, '{respawn_s}', '30') WHERE dungeon_boss IS NOT NULL;"
docker exec something2-db-1 psql -U user -d game_db_s9 -Atc "SELECT current_database()"   # must print game_db_s9
```

- [ ] **Step 4: Start the isolated backend on port 13105** (scratch DB; kill by PID file only)

```bash
cd $WT/backend
set -a; . /home/markunn/worker/coding/jsgame/something2/.env; set +a
export PORT=13105
export DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9
export REDIS_URL=$(echo "$REDIS_URL" | sed 's/redis:6379/localhost:16379/')
nohup node src/index.js > ../../s9-backend.log 2>&1 & echo $! > ../../s9-backend.pid
sleep 5; curl -s localhost:13105/api/health
cd /home/markunn/worker/coding/jsgame/something2/backend && DATABASE_URL=postgres://user:password@localhost:15432/game_db_s9 node scripts/set-admin-password.js
```

Read the admin password with `node -e "console.log(require('dotenv').parse(require('fs').readFileSync('/home/markunn/worker/coding/jsgame/something2/.env')).ADMIN_PASSWORD)"`. It is single-quoted in `.env`, so do not use `cut`. Never run `admin-password-rotate`.

- [ ] **Step 5: Start the isolated frontend.** Create `$WT/frontend/vite.verify.config.mjs` (do not commit):

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  cacheDir: '/tmp/s9-dungeon-bosses-vite-cache',
  server: {
    port: 15277, strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:13105', changeOrigin: true },
      '/authority': { target: 'http://localhost:13105', ws: true, changeOrigin: true },
    },
  },
});
```

```bash
cd $WT/frontend && nohup node node_modules/.bin/vite --config vite.verify.config.mjs > ../../s9-vite.log 2>&1 & echo $! > ../../s9-vite.pid
curl -s http://localhost:15277/src/games/something2/src/js/systems/RenderSystem.js | grep -c '"physical"'   # expect >= 1 (fresh bundle)
```

- [ ] **Step 6: Drive it in Chrome DevTools MCP** (`isolatedContext`, `http://127.0.0.1:15277/game-something2`). Log in as the admin and click Play, then run `evaluate_script` `await document.exitFullscreen().catch(() => {})`, because the game auto-enters fullscreen. For **each** of the six rooms (`The Catacombs: Elite`, `The Catacombs: End`, `The Emberhive: Elite`, `The Emberhive: End`, `The Umbral Gate: Elite`, `The Umbral Gate: End`):
  1. Travel with the World Boss test panel's dungeon teleport (`teleport_to_world`, `server.js:2896`, which arrives at the world centre). An Elite boss stands on the centre tile. An End boss stands 6 tiles south of the centre (the centre holds the exit portal). If arriving on the End centre tile pulls you through the exit portal, walk back from `d*_deep`'s E doorway, and record that teleport behaviour as pre-existing.
  2. **See exactly one boss:** `evaluate_script` over the game's creature map, counting entries with `bossTier` set. Expect `1`, with the right `name` and `bossTier` (`dungeon_elite` / `dungeon_end`) and `width` (72/72/80 for the Elites, 96/96/112 for the End bosses). Screenshot the `☠️ [BOSS] <name>` plate at boss size. Catacombs bosses use the bone palette, Emberhive fire, Umbral purple.
  3. **Kill it** (60 hp after Step 3). Confirm it disappears and that no world-boss announcement or Victor's Boon appears. In `s9-backend.log`, `grep -c 'death commit failed'` stays `0`.
  4. **See it respawn exactly once:** walk more than 10 tiles (1000 px) from the post and wait 40 s (respawn_s 30 plus one 10 s sweep). Come back and confirm the boss count is `1` again, still `1` after another 20 s, and the HP bar is full. Also confirm the scratch DB has no persisted copy: `docker exec something2-db-1 psql -U user -d game_db_s9 -Atc "SELECT count(*) FROM world_creatures WHERE type IN (SELECT name FROM entity_types WHERE boss_tier LIKE 'dungeon_%')"` → `0`, and the same check on `creature_respawns` → `0`.
  5. For one Elite, stand next to the boss and confirm in `evaluate_script` that the boss carries its aura name (`ossuary_dread`/`cinder_brood`/`shade_veil`) in its creature record. If the snapshot does not expose it, record "aura binding verified by `dungeon_boss_row_db` only". Drawing auras is S5.
  6. Console: `list_console_messages` has no `ReferenceError`/`TypeError`.

- [ ] **Step 7: Tear down** (by PID file. Never `pkill -f "node src/index.js"`, which would kill other sessions' backends.)

```bash
kill $(cat ../../s9-backend.pid) $(cat ../../s9-vite.pid); rm -f $WT/frontend/vite.verify.config.mjs ../../s9-backend.pid ../../s9-vite.pid
cd $WT && git status --short   # must show no stray files
```

- [ ] **Step 8: Record evidence** in the SOMET-609 Plane comment (To Review): backend/frontend exit codes, the baseline diff, the six screenshots, the per-room results from Step 6, and the `death commit failed` count. Re-check migration collisions on current main: `git -C /home/markunn/worker/coding/jsgame/something2 ls-tree --name-only origin/main backend/migrations/ | grep 17144407` must list only this slice's two files. Do not push or merge without the user's go-ahead.

---

## Self-Review

**Spec coverage (S9):**

| Spec item | Where |
|---|---|
| §3.5 `boss: { entity, x, y, respawn_s }` per world | Task 4 (validator), Task 5 (column write), Task 6 (generator) |
| §3.5 `entity` names a `dungeon_end`/`dungeon_elite` row; End → `dungeon_end`, Elite → `dungeon_elite` | Task 4 (`bossTiers` from DB in seed-map, from `seeds/data` in fixtures) |
| §3.5 point inside the world | Task 4 |
| §3.5 point walkable | Task 5 (`requiredTilesFor` → `assertNavigable` at seed time, and offline in `p5_navigability`). Not in `validateMapSpec`, see G4 |
| §3.5 `respawn_s > 0` | Task 4 (positive integer) |
| §3.8 three End + three Elite bosses, levels from `level_band` | Task 2 (rows), Task 7 (`dungeonBossLevel` from the live world row) |
| §3.8 Elite bosses carry one aura | Task 2 (ally-side `ossuary_dread`/`cinder_brood`/`shade_veil`), Task 7 DB test (resolved onto the instance) |
| §3.8 Elite 1-2 skills at `power_scale` ≤ 0.6 | **Not in S9.** Creature skills are S6/S7 (G9) |
| §4.1 one hydration function | Task 7 (`ENTITY_CATALOG_SELECT` → `hydrateCreatureRow` → `addCreatures`, no new mapping) |
| §4.1 fixed id, re-load is a no-op | Task 7/8 (`boss:<worldId>`, G3; double place / reload → one) |
| §4.1 respawn after `respawn_s` | Task 7 (manager), Task 8 (sweep timer), Task 9 (legacy paths refuse bosses) |
| §4.1 not persisted | Task 8 (asserts zero `world_creatures` rows) |
| §4.1 never wild-spawn | Already S1 (`worldPopulation.js:147`, `creatureRespawn.js:280`); Task 9 adds the per-row respawn lookup |
| §4.1 boss kill awards nothing until S10 | Task 7 `onKilled` hook + Task 8 `onDungeonBossKilled` opt; S9 awards nothing and logs nothing |
| §7 S9: validator rejects a non-boss entity / unwalkable point, run over real specs via `map_spec_fixtures` | Task 4, Task 5, Task 6 (fixture loop armed, RED-checked) |
| §7 S9: exactly one instance after double load | Task 7, Task 8 |
| §7 browser: one boss, kill, respawn | Task 12 |
| Plane SOMET-609 comment: exactly one respawn path fires | Task 8 (live), Task 9 (each legacy path) |

**Spec gaps (flag for the spec owner):**

- **G1 Respawn mechanism contradicts the spec.** §4.1 says "respawn after `respawn_s` via the existing respawn sweep (SOMET-309)". That sweep only drains `creature_respawns` into persisted `world_creatures` uuid rows (`creatureRespawn.js:83-87, 184-187`). That contradicts the same section's "fixed id `boss:<worldKey>`" and "Boss instances are not persisted". The plan reuses the sweep's **timer** (`server.js:3684-3689`) but not its queue, and keeps the boss in a dedicated in-memory owner.
- **G2 "`commitCreatureDeath` returns null" for a boss kill is wrong** (§4.1, S1 plan D6). For a non-uuid id, `DELETE FROM world_creatures WHERE id = $1` (`loot.js:85-88`) against a `uuid` column (`migrations/1714440013000_create_world_creatures.js:3`) **throws** `invalid input syntax for type uuid`, which is logged as `death commit failed` (`server.js:1000`). That happens on every world-boss kill today, and would on every dungeon-boss kill. Task 8 routes dungeon bosses away from it. The world-boss half is untouched (S1/S10 territory), so S10 must not "hook into the null return".
- **G3 `boss:<worldKey>`: `worlds` has no spec-key column.** Its columns are `id … pens`, with no `key`, and the authority keys worlds by id (`server.js:626-660`). The plan uses `boss:<worldId>`.
- **G4 "walkable" cannot be checked in `validateMapSpec`.** It is pure and offline (`mapSpec.js:137-140`, no terrain). Walkability goes through `requiredTilesFor` (`seed-map.js:133-135` pattern) into `assertNavigable` (`seed-map.js:794`) and the offline oracle `p5_navigability.test.js`.
- **G5 The runtime needs a carrier the spec does not name.** The map spec never reaches the authority, so the plan adds `worlds.dungeon_boss` and names it in `loadWorld`'s explicit SELECT (`server.js:648`).
- **G6 Recognising End/Elite worlds is name-keyed.** The only signal is the generator's naming `"<Dungeon>: End"` (`gen-p5-map-content.js:233`), which is the same blind-to-hand-authored-names shape memory warns about (`map_spec_fixtures` dungeon check). The validator applies the tier rule only to such names, and Task 6 asserts presence on the six generated rooms.
- **G7 "Each p5-descent dungeon has exactly one boss in its End room and one mini-boss in its Elite room"** (§1). Only the **3 spine dungeons** have End/Elite rooms (`skeletons.js:17-27`). The 5 hub/loop dungeons (Underdeep, Ossuary Depths, Frozen Vaults, Crystal Foundry, Abyss) and the vale-region dungeons have none. The roster (§3.8) matches the 3, but the success criterion reads as 8.
- **G8 "midpoint+" (§3.8) is undefined.** The plan uses `min(levelMax, ceil((min+max)/2)+1)`. Levels are derived from the live world row, because the dev DB's bands already differ from the spec (dev `The Catacombs: End` is 1-8, spec 1-7).
- **G9 Elite skills (§3.8) depend on S6/S7**, which are not built. S9 ships auras only.
- **G10 A dead creature is out of the sim before `onCreatureDeath` runs** (`creatures.js:1242-1253`). So S1's `deadCreature.bossTier === 'world'` (`server.js:935-938`) is almost always `null`, and boss routing must be by id (as `isBoss` is).
- **G11 Bosses are charmable** (`server.js:2331-2378` has no boss check, and the charm UPDATE throws on a non-uuid id after the in-memory charm lands). This applies to world bosses too. Task 10 closes it.
- **G12 No palette for `physical`.** `RenderSystem.js:189-195` falls back to fire, so the undead Catacombs bosses would render as fire titans. Task 11 adds a bone palette. The spec's "undead"/"void" themes map to `physical`/`arcane`, because the element vocabulary has no such values.
- **G13 "placed by" hint in the Entities tab** (§5, deferred to S9 by the S1 plan's self-review) is **not in this plan**. §6's S9 row does not list it. Ticket it, or fold it into S10's Entities tab work.
- **G14 Respawn placement near players is unspecified.** The plan defers the respawn while any player is within 1000 px of the post (same rule as SOMET-309). A player camping the post therefore holds it empty, so there is no spawn-on-top. A boss evicted alive comes back at full HP on reload.

**Decisions taken:**

- **D1** Both the migration and `seeds/data`: migration so dev/staging get the rows via nodemon, `seeds/data` for the offline fixture tiers and the reseed floor. They are pinned equal by a parity test.
- **D2** End = `Apex` and Elite = `Champion` behaviours, plus an in-memory leash post (`home_x/home_y`), so the boss holds its room.
- **D3** Stats are flat in the row (8x/3x and 4x/2x of the dungeon's Apex at the boss level). Balance is the follow-up ticket.
- **D4** `respawn_s` End 900 / Elite 600.

**Placeholder scan:** the only intentional instruction to paste is Task 2 Step 4's `ROWS` array. Its literal content is Task 2 Step 1, and the parity test fails if it is left empty. There is no TBD/TODO, and every code step carries real code. **Type consistency:** `DUNGEON_BOSSES` (Task 2) is consumed by Tasks 3, 4 and 6. `worlds.dungeon_boss` (Task 1) is written by Task 5 and read by Tasks 7/8. `bossCreatureId`/`isBoss` (Task 7) are consumed by Task 8. The `onKilled` kill record (Task 7) is S10's documented input. **Shared-file discipline:** no edits to `creatures.js` or `worldBoss.js`, and `server.js` edits are additive blocks, one SELECT column, one guard line and three seams.
