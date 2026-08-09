# B — Chests, Guards and Loot Maps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persistent guarded chests (vault: map-spec authored, never respawn; field: spawned by loot-map items, respawn on cooldown), loot tiered by the guard's A1 level band, XP through A2's existing `awardXp(..., 'chest')` seam.

**Architecture:** One `world_chests` table (`kind: 'vault'|'field'`) shared by both flavors, one open/loot/guard-check code path. A new `chest_loot` table mirrors `creature_drops` but bands by level range instead of entity type. Loot maps are a new `item_types.category = 'consumable'` item consumed through a new `use` WebSocket message handler in `authority/server.js` (this codebase's item actions are WS handlers, not REST routes — see Task 4).

**Tech Stack:** Node.js/Express backend, `node-pg-migrate` migrations, PostgreSQL, `node:test` + `node:assert` (no test framework dependency), `pg` for DB access.

## Global Constraints

- Migration timestamp range for this sub-project: `1714440150000`–`1714440152000`. **Before Task 1's first step**, re-run `ls backend/migrations | sort | tail -5` against the current `main` and confirm nothing has claimed this range yet; if it has, shift the whole range up by 10000 and update every reference in this plan.
- Follow the existing `rollDrops`/`rollGold` pattern in `backend/src/authority/loot.js` for any RNG-driven logic: pure functions taking an injectable `rng = Math.random`, never calling `Math.random()` internally.
- Every DB-touching function that must commit multiple writes atomically uses one checked-out `client` with explicit `BEGIN`/`COMMIT`/`ROLLBACK`, never the bare `pool` — mirrors `commitCreatureDeath` in `loot.js`.
- Migration tests use the no-DB `fakePgm` mock pattern (`backend/tests/migration_vfx_effects.test.js`, `backend/tests/migration_biomes_down.test.js`) — never a live database.
- Unit tests for DB-touching authority functions use the `scriptedPool` harness pattern in `backend/tests/authorityLoot.test.js` — a mock pool/client that records queries and routes them by regex, never a live database.
- This work happens entirely inside the isolated worktree at `.claude/worktrees/chests-loot-b244` on branch `feat/chests-loot-b244`. Do not touch the primary checkout at `/home/markunn/worker/coding/jsgame/something2` — another concurrent effort (player-characters epic) is actively using it.

---

### Task 1: Schema migrations — `world_chests`, `chest_loot`, loot-map item category

**Files:**
- Create: `backend/migrations/1714440150000_world_chests.js`
- Create: `backend/migrations/1714440151000_chest_loot.js`
- Create: `backend/migrations/1714440152000_loot_map_item.js`
- Test: `backend/tests/migration_world_chests.test.js`
- Test: `backend/tests/migration_chest_loot.test.js`
- Test: `backend/tests/migration_loot_map_item.test.js`

**Interfaces:**
- Produces: `world_chests(id, world_id, x, y, kind, guard_entity_type_id, guard_level, guard_creature_ids, state, opened_at, respawn_at, created_at)`, `chest_loot(id, level_min, level_max, item_type_id, chance, min_qty, max_qty)`, `item_types.category` widened to include `'consumable'`, one seeded row `item_types(name='loot_map', category='consumable')`.

- [ ] **Step 1: Write `1714440150000_world_chests.js`**

```js
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('world_chests', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    x: { type: 'real', notNull: true },
    y: { type: 'real', notNull: true },
    kind: { type: 'text', notNull: true },
    guard_entity_type_id: { type: 'integer', notNull: true, references: 'entity_types', onDelete: 'CASCADE' },
    guard_level: { type: 'integer', notNull: true },
    guard_creature_ids: { type: 'jsonb', notNull: true, default: '[]' },
    state: { type: 'text', notNull: true, default: 'locked' },
    opened_at: { type: 'timestamptz' },
    respawn_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('world_chests', 'world_chests_kind_check', "CHECK (kind IN ('vault','field'))");
  pgm.addConstraint('world_chests', 'world_chests_state_check',
    "CHECK (state IN ('locked','unlocked','opened'))");
  pgm.addConstraint('world_chests', 'world_chests_level_check', 'CHECK (guard_level >= 1)');
  pgm.createIndex('world_chests', ['world_id', 'state']);
};

exports.down = (pgm) => {
  pgm.dropTable('world_chests');
};
```

- [ ] **Step 2: Write the no-DB migration test**

```js
const test = require('node:test');
const assert = require('node:assert');

function fakePgm() {
  const calls = { createTable: [], dropTable: [], addConstraint: [], createIndex: [] };
  return {
    calls,
    createTable: (name, cols, opts) => calls.createTable.push({ name, cols, opts }),
    dropTable: (name) => calls.dropTable.push(name),
    addConstraint: (name, cname, expr) => calls.addConstraint.push({ name, cname, expr }),
    createIndex: (name, cols) => calls.createIndex.push({ name, cols }),
    func: (x) => ({ raw: x }),
  };
}

const mig = require('../migrations/1714440150000_world_chests.js');

test('up creates world_chests with the full lifecycle column set', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const t = pgm.calls.createTable.find((c) => c.name === 'world_chests');
  assert.ok(t, 'world_chests not created');
  const c = t.cols;
  assert.equal(c.world_id.references, 'worlds');
  assert.equal(c.world_id.onDelete, 'CASCADE');
  assert.equal(c.guard_entity_type_id.references, 'entity_types');
  assert.equal(c.state.default, 'locked');
  assert.equal(c.guard_creature_ids.type, 'jsonb');
  assert.equal(c.guard_creature_ids.default, '[]');
  assert.equal(c.opened_at.notNull, undefined, 'opened_at must be nullable — unopened chests have none');
  assert.equal(c.respawn_at.notNull, undefined, 'respawn_at must be nullable — vault chests never respawn');
});

test('kind and state are CHECK-constrained to exactly the spec vocabulary', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const kind = pgm.calls.addConstraint.find((c) => /kind/.test(c.cname));
  assert.match(kind.expr, /'vault'/);
  assert.match(kind.expr, /'field'/);
  const state = pgm.calls.addConstraint.find((c) => /state/.test(c.cname));
  for (const s of ['locked', 'unlocked', 'opened']) {
    assert.match(state.expr, new RegExp(`'${s}'`), `state CHECK omits ${s}`);
  }
});

test('indexes (world_id, state) for the respawn sweep and marker queries', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const idx = pgm.calls.createIndex.find((c) => c.name === 'world_chests');
  assert.deepEqual(idx.cols, ['world_id', 'state']);
});

test('down drops the table', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  assert.deepEqual(pgm.calls.dropTable, ['world_chests']);
});
```

- [ ] **Step 3: Run it**

Run: `cd backend && node --test tests/migration_world_chests.test.js`
Expected: PASS (4 tests)

- [ ] **Step 4: Write `1714440151000_chest_loot.js`**

```js
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('chest_loot', {
    id: 'id',
    level_min: { type: 'integer', notNull: true },
    level_max: { type: 'integer', notNull: true },
    item_type_id: { type: 'integer', notNull: true, references: 'item_types', onDelete: 'CASCADE' },
    chance: { type: 'numeric', notNull: true },
    min_qty: { type: 'integer', notNull: true, default: 1 },
    max_qty: { type: 'integer', notNull: true, default: 1 },
  });
  pgm.addConstraint('chest_loot', 'chest_loot_level_check', 'CHECK (level_max >= level_min AND level_min >= 1)');
  pgm.addConstraint('chest_loot', 'chest_loot_chance_check', 'CHECK (chance > 0 AND chance <= 1)');
  pgm.addConstraint('chest_loot', 'chest_loot_qty_check', 'CHECK (min_qty >= 1 AND max_qty >= min_qty)');
  pgm.createIndex('chest_loot', ['level_min', 'level_max']);
};

exports.down = (pgm) => {
  pgm.dropTable('chest_loot');
};
```

- [ ] **Step 5: Write the no-DB migration test**

```js
const test = require('node:test');
const assert = require('node:assert');

function fakePgm() {
  const calls = { createTable: [], dropTable: [], addConstraint: [], createIndex: [] };
  return {
    calls,
    createTable: (name, cols, opts) => calls.createTable.push({ name, cols, opts }),
    dropTable: (name) => calls.dropTable.push(name),
    addConstraint: (name, cname, expr) => calls.addConstraint.push({ name, cname, expr }),
    createIndex: (name, cols) => calls.createIndex.push({ name, cols }),
  };
}

const mig = require('../migrations/1714440151000_chest_loot.js');

test('up creates chest_loot with the same shape as creature_drops, banded by level', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const t = pgm.calls.createTable.find((c) => c.name === 'chest_loot');
  assert.ok(t);
  assert.equal(t.cols.item_type_id.references, 'item_types');
  assert.equal(t.cols.chance.type, 'numeric');
  assert.equal(t.cols.min_qty.default, 1);
  assert.equal(t.cols.max_qty.default, 1);
});

test('level_max >= level_min and level_min >= 1 are enforced', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const c = pgm.calls.addConstraint.find((x) => /level/.test(x.cname));
  assert.match(c.expr, /level_max >= level_min/);
  assert.match(c.expr, /level_min >= 1/);
});

test('chance and quantity constraints match creature_drops exactly', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const chance = pgm.calls.addConstraint.find((x) => /chance/.test(x.cname));
  assert.match(chance.expr, /chance > 0 AND chance <= 1/);
  const qty = pgm.calls.addConstraint.find((x) => /qty/.test(x.cname));
  assert.match(qty.expr, /min_qty >= 1 AND max_qty >= min_qty/);
});

test('indexes (level_min, level_max) for the by-level lookup', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const idx = pgm.calls.createIndex.find((c) => c.name === 'chest_loot');
  assert.deepEqual(idx.cols, ['level_min', 'level_max']);
});

test('down drops the table', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  assert.deepEqual(pgm.calls.dropTable, ['chest_loot']);
});
```

- [ ] **Step 6: Run it**

Run: `cd backend && node --test tests/migration_chest_loot.test.js`
Expected: PASS (5 tests)

- [ ] **Step 7: Find the current live `item_types_category_check` constraint**

Run: `cd backend && grep -n "item_types_category_check" migrations/*.js | tail -3`
Confirm the last-added constraint (currently `1714440031000_gold_economy.js`, `"category IN ('weapon','armor','ammo','currency')"`) is still the live one — if a migration newer than `1714440031000` has widened it further, use ITS enum list as the base for Step 8, not the one shown here.

- [ ] **Step 8: Write `1714440152000_loot_map_item.js`**

```js
exports.shorthands = undefined;

// 'consumable' is a new item_types category — a use-once item that triggers
// a server-side effect rather than being equipped. Widen the check
// constraint before seeding the loot_map row, same pattern as
// 1714440031000_gold_economy.js adding 'currency'.
exports.up = (pgm) => {
  pgm.dropConstraint('item_types', 'item_types_category_check');
  pgm.addConstraint('item_types', 'item_types_category_check', {
    check: "category IN ('weapon','armor','ammo','currency','consumable')",
  });
  pgm.sql(
    `INSERT INTO item_types (name, category, damage, cooldown, stackable)
     VALUES ('loot_map', 'consumable', 0, 0, true)
     ON CONFLICT (name) DO NOTHING`
  );
};

exports.down = (pgm) => {
  pgm.sql("DELETE FROM item_types WHERE name = 'loot_map'");
  pgm.dropConstraint('item_types', 'item_types_category_check');
  pgm.addConstraint('item_types', 'item_types_category_check', {
    check: "category IN ('weapon','armor','ammo','currency')",
  });
};
```

- [ ] **Step 9: Write the no-DB migration test**

```js
const test = require('node:test');
const assert = require('node:assert');

function fakePgm() {
  const calls = { dropConstraint: [], addConstraint: [], sql: [] };
  return {
    calls,
    dropConstraint: (name, cname) => calls.dropConstraint.push({ name, cname }),
    addConstraint: (name, cname, opts) => calls.addConstraint.push({ name, cname, opts }),
    sql: (s) => calls.sql.push(s),
  };
}

const mig = require('../migrations/1714440152000_loot_map_item.js');

test('up widens item_types_category_check to add consumable, keeping every existing category', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const add = pgm.calls.addConstraint.find((c) => c.cname === 'item_types_category_check');
  assert.ok(add);
  for (const cat of ['weapon', 'armor', 'ammo', 'currency', 'consumable']) {
    assert.match(add.opts.check, new RegExp(`'${cat}'`), `category CHECK omits ${cat}`);
  }
});

test('up seeds exactly one loot_map row, ON CONFLICT DO NOTHING', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const insert = pgm.calls.sql.find((s) => /INSERT INTO item_types/i.test(s));
  assert.ok(insert);
  assert.match(insert, /'loot_map'/);
  assert.match(insert, /'consumable'/);
  assert.match(insert, /ON CONFLICT \(name\) DO NOTHING/i);
});

test('down removes the loot_map row and reverts the constraint to pre-consumable', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  const del = pgm.calls.sql.find((s) => /DELETE FROM item_types/i.test(s));
  assert.match(del, /'loot_map'/);
  const add = pgm.calls.addConstraint.find((c) => c.cname === 'item_types_category_check');
  assert.doesNotMatch(add.opts.check, /'consumable'/);
});
```

- [ ] **Step 10: Run it**

Run: `cd backend && node --test tests/migration_loot_map_item.test.js`
Expected: PASS (3 tests)

- [ ] **Step 11: Commit**

```bash
cd /home/markunn/worker/coding/jsgame/something2/.claude/worktrees/chests-loot-b244
git add backend/migrations/1714440150000_world_chests.js backend/migrations/1714440151000_chest_loot.js backend/migrations/1714440152000_loot_map_item.js backend/tests/migration_world_chests.test.js backend/tests/migration_chest_loot.test.js backend/tests/migration_loot_map_item.test.js
git commit -m "feat(chests): schema for world_chests, chest_loot, loot-map item (SOMET-244)"
```

---

### Task 2: Pure loot-rolling and XP logic

**Files:**
- Create: `backend/src/authority/chestLoot.js`
- Test: `backend/tests/chestLoot.test.js`

**Interfaces:**
- Consumes: `rollDrops(dropRows, rng)` from `backend/src/authority/loot.js` (exact signature: `(dropRows, rng = Math.random) => item_type_id[]`). `xpForKill(creatureLevel, playerLevel)` from `backend/src/services/playerStats.js`.
- Produces: `rollChestLoot(pool, guardLevel, rng)` → `Promise<item_type_id[]>`. `xpForChest(guardLevel, playerLevel)` → `number`.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert');
const { rollChestLoot, xpForChest } = require('../src/authority/chestLoot.js');

function scriptedPool(rows) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return { rows, rowCount: rows.length }; },
  };
}

test('rollChestLoot queries chest_loot bounded by the guard level and rolls it through rollDrops', async () => {
  const row = { item_type_id: 9, chance: '1', min_qty: 1, max_qty: 1 };
  const pool = scriptedPool([row]);
  const always = () => 0;
  const out = await rollChestLoot(pool, 5, always);
  assert.deepEqual(out, [9]);
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].sql, /FROM chest_loot/i);
  assert.match(pool.calls[0].sql, /level_min <= \$1/i);
  assert.match(pool.calls[0].sql, /level_max >= \$1/i);
  assert.deepEqual(pool.calls[0].params, [5]);
});

test('rollChestLoot rolls nothing when the level band has no matching rows', async () => {
  const pool = scriptedPool([]);
  const out = await rollChestLoot(pool, 1, () => 0);
  assert.deepEqual(out, []);
});

test('xpForChest reuses xpForKill unchanged, applied to the guard level', () => {
  const { xpForKill } = require('../src/services/playerStats.js');
  assert.equal(xpForChest(10, 3), xpForKill(10, 3));
  assert.equal(xpForChest(1, 1), xpForKill(1, 1));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/chestLoot.test.js`
Expected: FAIL — `Cannot find module '../src/authority/chestLoot.js'`

- [ ] **Step 3: Write the implementation**

```js
// Chest loot rolling and XP. Deliberately thin: chest_loot rows feed
// straight into loot.js's existing rollDrops so a chest and a creature kill
// share ONE rolling algorithm, and xpForChest reuses xpForKill unchanged —
// a chest's guard already has a level on the same scale a kill's creature
// does, so this is the existing formula applied to the guard's level rather
// than a new one.
const { rollDrops } = require('./loot.js');
const { xpForKill } = require('../services/playerStats.js');

async function rollChestLoot(pool, guardLevel, rng = Math.random) {
  const r = await pool.query(
    'SELECT item_type_id, chance, min_qty, max_qty FROM chest_loot WHERE level_min <= $1 AND level_max >= $1',
    [guardLevel],
  );
  return rollDrops(r.rows, rng);
}

function xpForChest(guardLevel, playerLevel) {
  return xpForKill(guardLevel, playerLevel);
}

module.exports = { rollChestLoot, xpForChest };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/chestLoot.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/chestLoot.js backend/tests/chestLoot.test.js
git commit -m "feat(chests): loot rolling and XP, reusing rollDrops and xpForKill (SOMET-244)"
```

---

### Task 3: Vault chest map-spec support in `seed-map.js`

**Files:**
- Create: `backend/src/services/chests.js`
- Modify: `backend/scripts/seed-map.js` (add a vault-chest stamping pass, mirroring the existing village-stamping loop)
- Test: `backend/tests/chests_service.test.js`
- Test: `backend/tests/seed_map_vault_chests_db.test.js` (DB-backed, following the existing `seed_map_db.test.js` convention in this file — uses a real test transaction, same as that file already does for villages)

**Interfaces:**
- Consumes: `worldConfig(world)` from `backend/src/services/mapService.js` for `world.levelMin`/`world.levelMax`. `rollCreatureLevel(rngDraw, levelMin, levelMax)` and `scaleCreature({hp, damage, defense}, level)` from `backend/src/services/mapService.js` (same functions `placeMapCreatures` already uses).
- Produces: `insertVaultChest(client, worldId, chestSpec, rng)` → `Promise<{id, guardCreatureId}>`, where `chestSpec = {x, y, guardCreatureType, level}`. A map spec's world entry may now carry an optional `chest` field shaped `{x, y, guard_creature_type, level}` (mirrors the existing `village` field's shape).

- [ ] **Step 1: Write the failing unit test for `insertVaultChest`**

```js
const test = require('node:test');
const assert = require('node:assert');
const { insertVaultChest } = require('../src/services/chests.js');

function scriptedClient(entityTypeRow, creatureId, chestId) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM entity_types/i.test(sql)) return { rows: [entityTypeRow], rowCount: 1 };
      if (/INSERT INTO world_creatures/i.test(sql)) return { rows: [{ id: creatureId }], rowCount: 1 };
      if (/INSERT INTO world_chests/i.test(sql)) return { rows: [{ id: chestId }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('insertVaultChest spawns a leashed guard at the chest position and inserts a locked vault chest referencing it', async () => {
  const entityType = { id: 12, hp: 40, defense: 3, resistances: {} };
  const client = scriptedClient(entityType, 'creature-1', 'chest-1');
  const result = await insertVaultChest(client, 'world-1', {
    x: 500, y: 600, guardCreatureType: 'Undead Line', level: 7,
  });

  assert.equal(result.id, 'chest-1');
  assert.equal(result.guardCreatureId, 'creature-1');

  const creatureIns = client.calls.find((c) => /INSERT INTO world_creatures/i.test(c.sql));
  assert.match(creatureIns.sql, /home_x/, 'guard must be leashed to its post like a village guard');
  assert.deepEqual(creatureIns.params.slice(0, 4), ['world-1', 'Undead Line', 500, 600]);

  const chestIns = client.calls.find((c) => /INSERT INTO world_chests/i.test(c.sql));
  assert.match(chestIns.sql, /'vault'/);
  assert.deepEqual(JSON.parse(chestIns.params[chestIns.params.length - 1]), ['creature-1']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/chests_service.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// Vault chest authoring support: stamps a map-spec-declared chest and its
// guard into a world, mirroring insertVillageGuards' role for villages.
// `db` is any queryable (bare pool or a checked-out transaction client),
// same contract as insertVillageGuards.
const { scaleCreature } = require('./mapService.js');

async function insertVaultChest(db, worldId, chestSpec) {
  const { x, y, guardCreatureType, level } = chestSpec;
  const et = await db.query(
    'SELECT id, hp, defense, resistances FROM entity_types WHERE name = $1', [guardCreatureType],
  );
  if (et.rowCount === 0) {
    throw new Error(`insertVaultChest: unknown guard creature type "${guardCreatureType}"`);
  }
  const t = et.rows[0];
  const scaled = scaleCreature({ hp: t.hp || 10, damage: 0, defense: Number(t.defense ?? 0) || 0 }, level);

  const guard = await db.query(
    `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y, level, defense, resistances)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [worldId, guardCreatureType, x, y, scaled.hp, 'S', x, y, level, scaled.defense, JSON.stringify(t.resistances || {})],
  );
  const guardCreatureId = guard.rows[0].id;

  const chest = await db.query(
    `INSERT INTO world_chests (world_id, x, y, kind, guard_entity_type_id, guard_level, guard_creature_ids, state)
     VALUES ($1,$2,$3,'vault',$4,$5,$6,'locked') RETURNING id`,
    [worldId, x, y, t.id, level, JSON.stringify([guardCreatureId])],
  );
  return { id: chest.rows[0].id, guardCreatureId };
}

module.exports = { insertVaultChest };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/chests_service.test.js`
Expected: PASS

- [ ] **Step 5: Read the current village-stamping loop in `seed-map.js`**

Run: `cd backend && grep -n "for (const w of spec.worlds)" scripts/seed-map.js`
Read the village loop found there (around the existing `if (!w.village) continue;` block) to match its exact idempotency-check shape for Step 6.

- [ ] **Step 6: Add a vault-chest stamping pass to `seed-map.js`, immediately after the village loop and before the populateWorld loop**

```js
let vaultChests = 0;
for (const w of spec.worlds) {
  if (!w.chest) continue;
  const worldId = idByKey.get(w.key);
  const existing = await client.query('SELECT id FROM world_chests WHERE world_id = $1', [worldId]);
  if (existing.rowCount === 0) {   // idempotent: one authored chest per seeded world, same guard as villages above
    await insertVaultChest(client, worldId, {
      x: w.chest.x, y: w.chest.y,
      guardCreatureType: w.chest.guard_creature_type,
      level: w.chest.level,
    });
    vaultChests += 1;
  }
}
```

Add `const { insertVaultChest } = require('../src/services/chests.js');` to the top of `seed-map.js` alongside the existing `createVillage`/`fetchVillages` import. Add `vaultChests` to the summary log line the same way `villages` already appears there.

**Also add `fetchChests(pool, worldId)` to `backend/src/services/chests.js`** (parallel to `fetchVillages` in `villages.js`: `SELECT * FROM world_chests WHERE world_id = $1`, mapped to camelCase fields). This is consumed by Task 4, which loads it into the live in-memory world `entry` the same way `entry.villages` is loaded today — see Task 4 Step 0 below for exactly where.

**Placement rationale (must not be skipped):** this pass runs after villages (so a chest and a village guard both exist before `populateWorld` samples tile candidates) and before the `populateWorld` loop (so `creatureTileCandidates` — if it is later taught to avoid chest tiles — has a chest row to check against; this plan does not add that exclusion, see Task 3's Explicitly Out of Scope note below).

- [ ] **Step 7: Write the DB-backed idempotency test**

Read `backend/tests/seed_map_db.test.js`'s existing "seeding a spec with a village is idempotent" test first, and copy its exact DB setup/teardown pattern (test-only world, `zz`-prefixed name, cleanup in `after`).

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { applySpec } = require('../scripts/seed-map.js');

// Mirrors seed_map_db.test.js's DB setup exactly — see that file for the
// full pattern this test copies (pool config, cleanup, zz-prefix convention).
test('seeding a spec with a vault chest twice does not double the chest or its guard', async () => {
  const pool = new Pool();
  const spec = {
    name: 'zz-vault-chest-test',
    topology: 'spine',
    worlds: [{
      key: 'a', name: 'zz Vault Chest World', width: 10, height: 10,
      chest: { x: 500, y: 500, guard_creature_type: 'Wolf', level: 3 },
    }],
    links: [],
  };
  try {
    await applySpec(pool, spec);
    await applySpec(pool, spec); // re-apply, must be a no-op for the chest
    const world = await pool.query("SELECT id FROM worlds WHERE name = 'zz Vault Chest World'");
    const chests = await pool.query('SELECT * FROM world_chests WHERE world_id = $1', [world.rows[0].id]);
    assert.equal(chests.rowCount, 1, 're-seeding must not create a second chest');
    const guards = await pool.query(
      "SELECT * FROM world_creatures WHERE world_id = $1 AND type = 'Wolf'", [world.rows[0].id],
    );
    assert.equal(guards.rowCount, 1, 're-seeding must not spawn a second guard');
  } finally {
    await pool.query("DELETE FROM worlds WHERE name = 'zz Vault Chest World'");
    await pool.end();
  }
});
```

- [ ] **Step 8: Run it against the dev DB**

Run: `cd backend && node --test tests/seed_map_vault_chests_db.test.js`
Expected: PASS. If `applySpec` is not the actual exported name in `seed-map.js`, adjust the import to match what Step 5's read found — do not guess.

- [ ] **Step 9: Commit**

```bash
git add backend/src/services/chests.js backend/scripts/seed-map.js backend/tests/chests_service.test.js backend/tests/seed_map_vault_chests_db.test.js
git commit -m "feat(chests): vault chest map-spec authoring, mirroring village stamping (SOMET-244)"
```

**Explicitly out of scope for this task:** teaching `creatureTileCandidates` to avoid chest tiles (so a scattered hostile can't spawn on top of a chest). The design spec does not call for this, and villages' own avoidance was added when villages shipped, not retrofitted from a chest-shaped gap — track as a fast-follow if it turns out to matter after real vault chests are authored into content.

---

### Task 4: Field chest spawning + `use` WebSocket handler

Item actions in this codebase are **WebSocket message handlers in `backend/src/authority/server.js`**, not REST routes — `pickup`/`drop`/`interact`/`buy`/`sell` are all handlers in the `handlers` object there (confirmed by reading `pickup`/`drop`/`interact` at `server.js:935-983`), each keyed off the live in-memory `entry = worlds.get(ws.worldId)` populated once per world by `loadWorld` (`server.js:294-362`) and kept in sync afterward without a reload. This task follows that pattern, not a REST endpoint.

**Files:**
- Modify: `backend/src/services/chests.js` (add `spawnFieldChest`, `fetchChests` was added in Task 3)
- Modify: `backend/src/authority/server.js` (load `entry.chests` in `loadWorld`; add a `use` message handler)
- Test: `backend/tests/chests_service.test.js` (extend)
- Test: whichever existing test file already covers `server.js`'s `handlers` object (find it via `grep -rn "handlers.drop\|handlers.pickup" tests/*.js` before writing — do not create a second parallel harness for the same message-handler surface)

**Interfaces:**
- Consumes: `creatureTileCandidates` is NOT reused directly (it is `mapService.js`-internal and file-scoped to placement-during-seeding); instead reuse the same tile-legality primitive `placeMapCreatures` is built on by calling `placeMapCreatures(world, 1, allowedTypes, rngSeed)` with a one-element `allowedTypes` array naming the rolled guard type, and take its single returned placement's `x`/`y`. This avoids duplicating tile-legality logic entirely — see Step 3's comment for why.
- Produces: `spawnFieldChest(client, world, allowedGuardTypes, rngSeed)` → `Promise<{id, guardCreatureId, row} | null>` (`null` when no legal tile exists, mirroring `placeMapCreatures` returning `[]`).

- [ ] **Step 0: Locate the existing message-handler test harness**

Run: `cd backend && grep -rln "handlers.drop\|handlers.pickup\|type: 'drop'\|type: 'pickup'" tests/*.js`
Read whichever file(s) that finds in full — this establishes the mock WebSocket/`ws` shape, how `pool`/`entry` are stubbed, and how a sent frame is asserted, all of which Step 7 below depends on. If no such file exists yet, read `server.js`'s `attachAuthority` export (used to construct the `handlers` object under test) and build the harness the same way `authorityLoot.test.js`'s `scriptedPool` was built for `loot.js` — from the real exported surface, not a guess.

- [ ] **Step 1: Write the failing test for `spawnFieldChest`**

```js
test('spawnFieldChest returns null when placeMapCreatures finds no legal tile', async () => {
  const { spawnFieldChest } = require('../src/services/chests.js');
  // An unbounded world (no cfg.bounds) makes placeMapCreatures return [] —
  // same precondition placeMapCreatures itself documents.
  const world = { levelMin: 1, levelMax: 5 };
  const client = { query: async () => ({ rows: [], rowCount: 0 }) };
  const result = await spawnFieldChest(client, world, ['Wolf'], 42);
  assert.equal(result, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/chests_service.test.js`
Expected: FAIL — `spawnFieldChest is not a function`

- [ ] **Step 3: Write the implementation, appended to `backend/src/services/chests.js`**

```js
const { placeMapCreatures } = require('./mapService.js');

// Field chest: spawned only by a loot-map use, never map-spec-authored.
// Reuses placeMapCreatures for tile legality and level rolling instead of
// reimplementing creatureTileCandidates — a field chest's guard is placed
// exactly like any other scattered creature, just with a world_chests row
// riding along. Returns null when no legal tile exists (same contract as
// placeMapCreatures returning []), so the handler layer can report failure
// instead of silently doing nothing.
async function spawnFieldChest(client, world, allowedGuardTypes, rngSeed) {
  const placed = placeMapCreatures(world, 1, allowedGuardTypes, rngSeed);
  if (placed.length === 0) return null;
  const p = placed[0];

  const et = await client.query('SELECT id FROM entity_types WHERE name = $1', [p.type]);
  if (et.rowCount === 0) {
    throw new Error(`spawnFieldChest: unknown guard creature type "${p.type}"`);
  }

  const guard = await client.query(
    `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y, level, defense, resistances)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [world.id, p.type, p.x, p.y, p.hp, p.facing, p.x, p.y, p.level, p.defense, JSON.stringify(p.resistances || {})],
  );
  const guardCreatureId = guard.rows[0].id;

  const chest = await client.query(
    `INSERT INTO world_chests (world_id, x, y, kind, guard_entity_type_id, guard_level, guard_creature_ids, state)
     VALUES ($1,$2,$3,'field',$4,$5,$6,'locked') RETURNING *`,
    [world.id, p.x, p.y, et.rows[0].id, p.level, JSON.stringify([guardCreatureId])],
  );
  // `row` (the full inserted world_chests row) lets Task 4's `use` handler
  // push straight onto entry.chests without a second SELECT.
  return { id: chest.rows[0].id, guardCreatureId, row: chest.rows[0] };
}

module.exports = { insertVaultChest, spawnFieldChest };
```

Update the top `module.exports` line to include both functions (the file already has `insertVaultChest` from Task 3).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/chests_service.test.js`
Expected: PASS

- [ ] **Step 5: Load chests into the live world entry**

In `server.js`'s `loadWorld` (around line 342, right next to `const villages = await fetchVillages(pool, canonicalId);`), add:

```js
const chests = await fetchChests(pool, canonicalId);
```

Add `chests` to the `entry` object literal at line 351-359 (alongside `villages`). Add `const { insertVaultChest, spawnFieldChest, fetchChests } = require('../services/chests.js');` to `server.js`'s top-of-file requires.

- [ ] **Step 6: Write `spawnFieldChest`'s caller as a `use` message handler, next to `drop` in the `handlers` object (~line 960)**

```js
const ALLOWED_FIELD_CHEST_GUARDS = ['Wolf']; // placeholder allowlist — real content decision is out of scope (see design spec)

use(ws, msg) {
  const entry = worlds.get(ws.worldId);
  if (!entry) return;
  if (typeof msg.itemId !== 'string') return; // wire hygiene: ids are strings, matches drop's guard
  chainOp(ws, 'use', async () => {
    const item = await pool.query(
      `SELECT pi.id, it.category, it.name
         FROM player_items pi JOIN item_types it ON it.id = pi.item_type_id
        WHERE pi.id = $1 AND pi.user_id = $2`,
      [msg.itemId, ws.userId],
    );
    if (item.rowCount === 0) { send(ws, { type: 'error', message: 'you do not own that item' }); return; }
    if (item.rows[0].category !== 'consumable') {
      send(ws, { type: 'error', message: 'this item has no use action' });
      return;
    }
    if (item.rows[0].name !== 'loot_map') {
      send(ws, { type: 'error', message: 'unrecognized consumable' });
      return;
    }

    let client = null;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const spawned = await spawnFieldChest(
        client, entry.row, ALLOWED_FIELD_CHEST_GUARDS, Math.floor(Math.random() * 2 ** 31),
      );
      if (!spawned) {
        await client.query('ROLLBACK');
        send(ws, { type: 'error', message: 'no legal spot for a chest right now' });
        return;
      }
      await client.query('DELETE FROM player_items WHERE id = $1', [msg.itemId]);
      await client.query('COMMIT');
      // Keep the in-memory cache in sync, the same reason claimItem/dropItem
      // mutate entry.world.groundItems directly rather than waiting for a
      // reload — see loot.js's claimItem for the precedent.
      entry.chests.push(spawned.row);
      send(ws, { type: 'used', itemId: msg.itemId, spawnedChestId: spawned.id });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client?.release();
    }
  });
},
```

`entry.row` is the world's own DB row (already present on `entry` per the `loadWorld` object literal — confirms `spawnFieldChest`'s `world` parameter from Task 4 Step 3 should be called with `entry.row`, which carries `level_min`/`level_max` as `row.level_min`/`row.level_max`; **before writing this step for real, re-check `placeMapCreatures`' `world.levelMin`/`world.levelMax` field-name expectations against what `entry.row` actually exposes** (the raw SQL row uses snake_case per the `SELECT` at `server.js:301`) — `worldConfig()`/`placeMapCreatures` may expect camelCase `levelMin`/`levelMax` instead, based on Task 3's read of `mapService.js:564`. If they don't match, `spawnFieldChest` must map `row.level_min → levelMin` itself before calling `placeMapCreatures`, the same translation `fetchVillages` already performs for `min_row → minRow` etc. Confirm and fix before this step is considered done — do not ship a silent `undefined` level band.

`spawnFieldChest` already returns `row` (the full inserted `world_chests` row) per Task 4 Step 3, so the handler above pushes it onto `entry.chests` without a second SELECT.

- [ ] **Step 7: Write the handler test**

```js
// Locate and mirror the existing test file covering server.js's `drop`/
// `pickup` handlers (found via Step 0's grep). Minimum required assertions:
//   - use with a non-owned itemId sends an error frame, no world mutation
//   - use with a non-consumable item (e.g. a weapon) sends an error frame
//   - use with the loot_map item when no legal tile exists sends an error
//     frame and does NOT delete the player_items row
//   - use with the loot_map item successfully sends a 'used' frame, deletes
//     the player_items row, creates exactly one world_chests row, AND
//     pushes it onto entry.chests (assert entry.chests.length increased)
```

- [ ] **Step 8: Run it**

Run: `cd backend && node --test tests/<the file found in Step 0's grep>`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add backend/src/services/chests.js backend/src/authority/server.js backend/tests/chests_service.test.js backend/tests/<the handler test file>
git commit -m "feat(chests): field chest spawning via a use message handler (SOMET-244)"
```

---

### Task 5: Chest open endpoint — guard-gating, loot grant, XP

Like Task 4, this is a `server.js` message handler, not a REST route — opening a chest is a player action against their live in-memory world entry, same category as `interact` (which finds the nearest merchant by proximity rather than taking an id from the client). This task follows `interact`'s proximity pattern rather than Task 5's earlier (incorrect) `POST /api/worlds/:worldId/chests/:chestId/open` draft.

**Files:**
- Modify: `backend/src/authority/chestLoot.js` (add `openChest`)
- Modify: `backend/src/services/chests.js` (add `nearestChest`, mirroring `nearestMerchantVillage`)
- Modify: `backend/src/authority/server.js` (add an `openchest` message handler, next to `interact`)
- Test: `backend/tests/chestLoot.test.js` (extend)
- Test: the same handler-test file identified in Task 4 Step 0

**Interfaces:**
- Consumes: `rollChestLoot(pool, guardLevel, rng)`, `xpForChest(guardLevel, playerLevel)` (Task 2). `awardXp(client, userId, amount, source)` and `loadProgression(client, userId)` from `backend/src/services/progressionStore.js` (exact signatures already used in `commitCreatureDeath`).
- Produces: `openChest(pool, chestId, userId, { rng = Math.random } = {})` → `Promise<{ok: true, items, awarded, leveledUp, newLevel} | {ok: false, reason}>`.

- [ ] **Step 1: Write the failing tests**

```js
const { openChest } = require('../src/authority/chestLoot.js');

function scriptedPool(routes) {
  const calls = [];
  function route(sql, params) {
    for (const [re, result] of routes) {
      if (re.test(sql)) return typeof result === 'function' ? result(params) : result;
    }
    return { rows: [], rowCount: 0 };
  }
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return route(sql, params); },
    connect: async () => ({
      query: async (sql, params) => { calls.push({ sql, params }); return route(sql, params); },
      release: () => {},
    }),
  };
}

test('openChest refuses a chest whose guards are still alive', async () => {
  const pool = scriptedPool([
    [/SELECT .* FROM world_chests/i, { rows: [{ id: 'c1', state: 'locked', guard_creature_ids: JSON.stringify(['g1']), guard_level: 5 }], rowCount: 1 }],
    [/SELECT count\(\*\) .* FROM world_creatures/i, { rows: [{ count: '1' }], rowCount: 1 }], // one guard still alive
  ]);
  const result = await openChest(pool, 'c1', 'user1');
  assert.equal(result.ok, false);
  assert.match(result.reason, /guard/i);
});

test('openChest CAS: only the request that flips locked->opened grants loot and XP', async () => {
  const pool = scriptedPool([
    [/SELECT .* FROM world_chests/i, { rows: [{ id: 'c1', state: 'unlocked', guard_creature_ids: JSON.stringify([]), guard_level: 5 }], rowCount: 1 }],
    [/UPDATE world_chests SET state = 'opened'/i, { rows: [{ id: 'c1' }], rowCount: 1 }], // CAS wins
    [/FROM chest_loot/i, { rows: [{ item_type_id: 3, chance: '1', min_qty: 1, max_qty: 1 }], rowCount: 1 }],
    [/INSERT INTO player_items/i, { rows: [{ id: 'pi1', item_type_id: 3, quantity: 1 }], rowCount: 1 }],
    [/FROM player_progression/i, { rows: [{ level: 2, experience: 100 }], rowCount: 1 }],
    [/UPDATE player_progression/i, { rows: [{ level: 2, experience: 150 }], rowCount: 1 }],
  ]);
  const result = await openChest(pool, 'c1', 'user1', { rng: () => 0 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items, [3]);
});

test('openChest CAS: a losing request (already opened) grants nothing', async () => {
  const pool = scriptedPool([
    [/SELECT .* FROM world_chests/i, { rows: [{ id: 'c1', state: 'unlocked', guard_creature_ids: JSON.stringify([]), guard_level: 5 }], rowCount: 1 }],
    [/UPDATE world_chests SET state = 'opened'/i, { rows: [], rowCount: 0 }], // lost the CAS
  ]);
  const result = await openChest(pool, 'c1', 'user1');
  assert.equal(result.ok, false);
  assert.match(result.reason, /already/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/chestLoot.test.js`
Expected: FAIL — `openChest is not a function`

- [ ] **Step 3: Write the implementation, appended to `backend/src/authority/chestLoot.js`**

```js
const { awardXp, loadProgression } = require('../services/progressionStore.js');

// The single authoritative chest-open. The state CAS (locked/unlocked ->
// 'opened' via an UPDATE ... WHERE state='unlocked' RETURNING id) plays the
// same role commitCreatureDeath's DELETE...RETURNING plays for a kill: only
// the request whose UPDATE actually affects a row licenses the loot roll
// and XP award, so two concurrent opens of the same chest cannot
// double-grant. Everything runs inside one transaction, same posture as
// commitCreatureDeath.
async function openChest(pool, chestId, userId, { rng = Math.random } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cr = await client.query(
      'SELECT id, state, guard_creature_ids, guard_level FROM world_chests WHERE id = $1 FOR UPDATE',
      [chestId],
    );
    if (cr.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'chest not found' };
    }
    const chest = cr.rows[0];
    if (chest.state === 'opened') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'already opened' };
    }
    if (chest.state === 'locked') {
      const guardIds = chest.guard_creature_ids;
      if (guardIds.length > 0) {
        const alive = await client.query(
          'SELECT count(*)::int AS count FROM world_creatures WHERE id = ANY($1::uuid[])', [guardIds],
        );
        if (alive.rows[0].count > 0) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'guard is still alive' };
        }
      }
      await client.query("UPDATE world_chests SET state = 'unlocked' WHERE id = $1", [chestId]);
    }

    const cas = await client.query(
      "UPDATE world_chests SET state = 'opened', opened_at = now() WHERE id = $1 AND state = 'unlocked' RETURNING id",
      [chestId],
    );
    if (cas.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'already opened' };
    }

    const itemTypeIds = await rollChestLoot(client, chest.guard_level, rng);
    const items = [];
    for (const itemTypeId of itemTypeIds) {
      const ins = await client.query(
        `INSERT INTO player_items (user_id, item_type_id, quantity)
         VALUES ($1,$2,1) RETURNING id, item_type_id, quantity`,
        [userId, itemTypeId],
      );
      items.push(ins.rows[0]);
    }

    const before = await loadProgression(client, userId);
    const amount = xpForChest(chest.guard_level, before.level);
    const award = await awardXp(client, userId, amount, 'chest');

    await client.query('COMMIT');
    return {
      ok: true, items, awarded: award.awarded, leveledUp: award.leveledUp, newLevel: award.newLevel,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { rollChestLoot, xpForChest, openChest };
```

Note: `guard_creature_ids` comes back from `pg` already parsed as a JS array for a `jsonb` column — the test's `JSON.stringify(['g1'])` in the scripted row is only there because the mock pool does not perform real type coercion; do not add a `JSON.parse` in the implementation itself, since a real `pg` client would already hand back an array and parsing it again would throw.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/chestLoot.test.js`
Expected: PASS (6 tests total: 3 from Task 2, 3 new)

- [ ] **Step 5: Write `nearestChest`, appended to `backend/src/services/chests.js`**

```js
// Mirrors nearestMerchantVillage (server.js:140) exactly: nearest entry
// within radius, or null. Only chests NOT yet fully opened are candidates
// for interaction — an opened vault chest has nothing left to do.
function nearestChest(chests, cx, cy, radius) {
  let best = null, bestDist = Infinity;
  for (const c of chests) {
    if (c.state === 'opened' && c.kind === 'vault') continue; // permanently spent
    const dx = c.x - cx, dy = c.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= radius && dist < bestDist) { best = c; bestDist = dist; }
  }
  return best;
}

module.exports = { insertVaultChest, spawnFieldChest, respawnDueFieldChests, fetchChests, nearestChest };
```

- [ ] **Step 6: Add the `openchest` handler to `server.js`, next to `interact` (~line 971)**

```js
openchest(ws) {
  const entry = worlds.get(ws.worldId);
  if (!entry) return;
  chainOp(ws, 'openchest', async () => {
    const p = entry.world.getPlayer(ws.userId);
    if (!p) return;
    const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
    const chest = nearestChest(entry.chests, cx, cy, INTERACT_RADIUS);
    if (!chest) { send(ws, { type: 'error', message: 'no chest nearby' }); return; }

    const result = await openChest(pool, chest.id, ws.userId);
    if (!result.ok) { send(ws, { type: 'error', message: result.reason }); return; }

    // Keep the in-memory cache in sync with the DB write openChest just
    // committed, same reason Task 4's use handler pushes onto entry.chests.
    Object.assign(chest, { state: 'opened' });
    send(ws, {
      type: 'chestOpened', chestId: chest.id, items: result.items,
      awarded: result.awarded, leveledUp: result.leveledUp, newLevel: result.newLevel,
    });
  });
},
```

Add `const { openChest } = require('./chestLoot.js');` (adjust the relative path to match `server.js`'s actual directory — it lives in `authority/`, `chestLoot.js` is a sibling file in the same directory, so `require('./chestLoot.js')` is correct) to `server.js`'s top-of-file requires, alongside the existing `nearestChest` import from Step 5.

- [ ] **Step 7: Write the handler test**

```js
// Same harness as Task 4 Step 7. Minimum required assertions:
//   - openchest with no chest in range sends an error frame
//   - openchest against a chest with a live guard sends an error frame
//     mentioning the guard
//   - openchest against an unlocked chest in range sends a 'chestOpened'
//     frame with items + awarded XP, and entry.chests' matching row's
//     state is now 'opened'
//   - a second openchest against the same (now-opened, vault) chest sends
//     an error frame — nearestChest excludes it once state='opened'
```

- [ ] **Step 8: Run it and commit**

Run: `cd backend && node --test tests/<the handler test file>`
Expected: PASS

```bash
git add backend/src/authority/chestLoot.js backend/src/services/chests.js backend/src/authority/server.js backend/tests/chestLoot.test.js backend/tests/<the handler test file>
git commit -m "feat(chests): openchest handler with guard-gating, CAS, loot grant and XP (SOMET-244)"
```

---

### Task 6: Field chest respawn sweep

**Files:**
- Modify: `backend/src/services/chests.js` (add `respawnDueFieldChests`)
- Modify: `backend/src/authority/server.js` — find the existing tick/interval that drives world upkeep (grep for `setInterval` near where the codebase already does periodic sweeps, e.g. `world_items` expiry) and add a call there. Read that call site fully before editing; match its exact scheduling pattern rather than adding a second, independent `setInterval`.
- Test: `backend/tests/chests_service.test.js` (extend)

**Interfaces:**
- Consumes: `placeMapCreatures` (`mapService.js`, already used by Task 3/4). A named constant `FIELD_CHEST_RESPAWN_MS` (default 2 hours = `2 * 60 * 60 * 1000`), defined in `backend/src/authority/chestLoot.js` alongside the other tunables, exported for `openChest` to use when setting `respawn_at`.
- Produces: `respawnDueFieldChests(client, { getWorld })` → `Promise<number>` (count reset), where `getWorld: (worldId) => Promise<worldRow>` is injected by the caller (test or real sweep) rather than queried inline, so this stays testable against a plain mock instead of a real `worlds` row shape.

- [ ] **Step 0: Locate the existing periodic sweep**

Run: `cd backend && grep -n "setInterval" src/authority/server.js`
Read the sweep it finds (e.g. `world_items` expiry) in full — this establishes where and how often periodic upkeep already runs, and Step 6 below adds to it rather than creating a second, independent `setInterval`.

- [ ] **Step 1: Add `FIELD_CHEST_RESPAWN_MS` to `chestLoot.js` and set `respawn_at` on field-chest open**

In `openChest` (Task 5), after the CAS succeeds, branch on `kind`:

```js
// Fetch kind alongside the other chest columns in the initial SELECT (add
// `kind` to that query's column list). Field chests get a respawn timer;
// vault chests never do.
if (chest.kind === 'field') {
  await client.query(
    'UPDATE world_chests SET respawn_at = now() + ($1::int * interval \'1 millisecond\') WHERE id = $2',
    [FIELD_CHEST_RESPAWN_MS, chestId],
  );
}
```

Add `const FIELD_CHEST_RESPAWN_MS = 2 * 60 * 60 * 1000;` near the top of `chestLoot.js` and export it.

- [ ] **Step 2: Write the failing test for the sweep**

```js
test('respawnDueFieldChests resets past-due field chests to locked with a fresh guard, and leaves vault chests alone', async () => {
  const { respawnDueFieldChests } = require('../src/services/chests.js');
  const dueChest = { id: 'c1', world_id: 'w1', x: 100, y: 100, kind: 'field', guard_entity_type_id: 5 };
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT .* FROM world_chests WHERE kind = 'field'/i.test(sql)) return { rows: [dueChest], rowCount: 1 };
      if (/SELECT name FROM entity_types/i.test(sql)) return { rows: [{ name: 'Wolf' }], rowCount: 1 };
      if (/UPDATE world_chests SET state = 'locked'/i.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const worldRow = { id: 'w1', levelMin: 1, levelMax: 3 };
  const reset = await respawnDueFieldChests(client, { getWorld: async () => worldRow });
  assert.equal(reset, 1);
  assert.ok(calls.some((c) => /UPDATE world_chests SET state = 'locked'/i.test(c.sql)));
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && node --test tests/chests_service.test.js`
Expected: FAIL — `respawnDueFieldChests is not a function`

- [ ] **Step 4: Write the implementation, appended to `backend/src/services/chests.js`**

```js
// Sweeps field chests past their respawn_at back to a fresh locked state
// with a NEW guard — same row, same x/y, so a stale in-flight client
// reference to the chest id stays valid. Vault chests are excluded by the
// `kind = 'field'` filter; they never carry a respawn_at in the first
// place (Task 5 only sets it for kind='field').
async function respawnDueFieldChests(client, { getWorld }) {
  const due = await client.query(
    "SELECT id, world_id, x, y, guard_entity_type_id FROM world_chests WHERE kind = 'field' AND state = 'opened' AND respawn_at <= now()",
  );
  let reset = 0;
  for (const chest of due.rows) {
    const et = await client.query('SELECT name FROM entity_types WHERE id = $1', [chest.guard_entity_type_id]);
    if (et.rowCount === 0) continue; // guard type deleted from the catalog since; leave this chest for manual cleanup
    const world = await getWorld(chest.world_id);
    const placed = placeMapCreatures(world, 1, [et.rows[0].name], Math.floor(Math.random() * 2 ** 31));
    if (placed.length === 0) continue; // no legal tile this pass; try again next sweep
    const p = placed[0];
    const guard = await client.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y, level, defense, resistances)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [chest.world_id, p.type, chest.x, chest.y, p.hp, p.facing, chest.x, chest.y, p.level, p.defense, JSON.stringify(p.resistances || {})],
    );
    await client.query(
      `UPDATE world_chests SET state = 'locked', opened_at = NULL, respawn_at = NULL,
              guard_creature_ids = $1, guard_level = $2
       WHERE id = $3`,
      [JSON.stringify([guard.rows[0].id]), p.level, chest.id],
    );
    reset += 1;
  }
  return reset;
}

module.exports = { insertVaultChest, spawnFieldChest, respawnDueFieldChests };
```

`getWorld` is injected (not queried inline) so this stays testable with the existing `scriptedPool`/plain-object mock pattern rather than needing a real `worlds` row shape baked into the test.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && node --test tests/chests_service.test.js`
Expected: PASS

- [ ] **Step 6: Wire the sweep into the existing tick/interval**

Read the tick location found by Step 0's grep in full before editing. Add a call to `respawnDueFieldChests(pool, { getWorld: (id) => pool.query('SELECT * FROM worlds WHERE id = $1', [id]).then((r) => r.rows[0]) })` at whatever cadence that existing sweep already runs — do not introduce a second, independently-scheduled interval.

- [ ] **Step 7: Commit**

```bash
git add backend/src/authority/chestLoot.js backend/src/services/chests.js backend/src/authority/server.js backend/tests/chests_service.test.js
git commit -m "feat(chests): field chest respawn sweep (SOMET-244)"
```

---

### Task 6b: Chest markers on the minimap/AOI payload

The spec requires chest markers to surface the same way `world_creatures`/villages already do,
via the existing AOI/overview payload — this task was missing from the original draft plan
(caught in self-review) and must not be silently dropped.

**Files:**
- Modify: whichever module builds the per-player AOI broadcast and the `/overview` minimap
  payload (find both via the commands in Step 1 below — this plan does not name them from
  memory, since neither has been read yet this session).
- Test: extend whichever existing test file covers that AOI/overview payload shape.

- [ ] **Step 1: Locate the AOI broadcast and the overview endpoint**

Run: `cd backend && grep -rln "groundItems\|world_creatures" src/authority/*.js | xargs grep -ln "type: 'state'\|broadcast"` to find the AOI frame builder, and `grep -rn "app.get('/api/worlds/:id/overview'" src/index.js` for the minimap endpoint. Read both in full.

- [ ] **Step 2: Add chest markers to both, following exactly how `world_creatures`/villages are already included**

Read the existing pattern for how a village or creature is projected into each payload (field names, coordinate transform if any) and add chests the same way — same field-naming convention, same coordinate space, sourced from `entry.chests` for the live AOI broadcast and a fresh `world_chests` query for the `/overview` REST endpoint (matching however villages are currently sourced for each).

- [ ] **Step 3: Write/extend the test covering the payload shape**

Assert a chest appears in both payloads with at minimum its `id`, `x`, `y`, `kind`, and `state` (the client needs `state` to render "guarded" vs "open" differently).

- [ ] **Step 4: Run the extended test and commit**

```bash
git add <files touched in Steps 2-3>
git commit -m "feat(chests): surface chest markers on the minimap and live AOI payload (SOMET-244)"
```

---

### Task 7: Integration + browser verification

**Files:**
- Test: `backend/tests/chests_integration_db.test.js` (real DB, follows `seed_map_db.test.js`'s setup/teardown convention)
- No new source files — this task verifies Tasks 1–6 end-to-end.

- [ ] **Step 1: Write a DB-backed integration test covering the full vault-chest flow**

```js
// Full flow against a real (test-scoped, zz-prefixed) world: seed a spec
// with a vault chest -> kill the guard via commitCreatureDeath -> open the
// chest -> assert items granted, XP awarded, second open rejected.
// Follow seed_map_db.test.js's pool/cleanup pattern exactly.
```

Write this out fully at implementation time using the real DB helper conventions confirmed in Task 3 Step 7 — this plan intentionally does not fabricate the exact pool/setup boilerplate a second time; copy it from the working Task 3 test once that exists.

- [ ] **Step 2: Run it**

Run: `cd backend && node --test tests/chests_integration_db.test.js`
Expected: PASS

- [ ] **Step 3: Run the full backend suite once**

Run: `cd backend && npm test`
Expected: all tests pass except any already-known pre-existing flakes (cross-check against ones already documented in this session, e.g. `authority_server.test.js`'s token-bucket test) — re-run any failure in isolation before treating it as a regression.

- [ ] **Step 4: Browser verification**

Start the dev stack (`docker compose -f compose/docker-compose.yml --env-file .env up -d`), log in as a test user, and drive the actual flow:
- Navigate to a world with a seeded vault chest, kill its guard, confirm the chest becomes interactable and opening it grants an item + shows an XP gain.
- Acquire a `loot_map` item (grant it directly via a test/admin path since no drop table seeds it yet), use it, confirm a new guarded chest appears in the current world.
- Attempt to open a still-guarded chest; confirm a clear rejection, not a silent no-op.

- [ ] **Step 5: Commit**

```bash
git add backend/tests/chests_integration_db.test.js
git commit -m "test(chests): end-to-end integration coverage for the vault chest flow (SOMET-244)"
```

---

### Task 8: Final whole-branch review + finish branch

- [ ] Dispatch a fresh reviewer (most capable model available) against the full diff from this branch's base (`957945d`'s parent, i.e. `main` before this sub-project started) to `HEAD`, using the `requesting-code-review` template.
- [ ] Address any Critical/Important findings; re-review only the changed scope.
- [ ] Run `superpowers:finishing-a-development-branch` — this repo's convention (established across every merge this session) is push + PR, not a local merge, even from a worktree.
- [ ] Update SOMET-244 in Plane to To Review with the evidence triad (automated checks, the browser verification from Task 7 Step 4 as the "human-like exercise" leg, and a stress pass: concurrent chest-open race, using a loot map with a full inventory, opening a nonexistent chest id).
