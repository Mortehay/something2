# D — Magic Stones and Sockets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert baked-in weapon magic (fixed `item_types.element`/`mana_cost` per weapon type) into a socket system — a stone is its own item, socketable into a weapon (spell stones, replacing the weapon's attack entirely) or weapon/armor (buff stones, overlaying a stat bonus), removable with a destroy risk, carrying its own XP pool. Existing magic weapons are converted via a reversible migration modeled on `1714440092000_characters.js`.

**Architecture:** One `stone_instances` table (1:1 with a stone's own `player_items` row) tracks XP/level and what host it's socketed into, DB-enforced to one stone per host via a partial unique index. Combat resolves the socketed stone from an in-memory cache kept on each player's inventory record (never a DB hit in the attack hot path), mirroring how `entry.chests`/`entry.world.groundItems` already stay in-memory-consistent elsewhere in this codebase.

**Tech Stack:** Node.js/Express backend, `node-pg-migrate` migrations, PostgreSQL, `node:test` + `node:assert`, `pg`, WebSocket message handlers in `authority/server.js` (this codebase's item/player-action surface — confirmed via `equip`/`unequip`/`use`/`openchest`, not REST routes).

## Global Constraints

- Migration timestamp range: **not pre-committed.** Before Task 1's first step, run `ls backend/migrations | sort | tail -5` against the current worktree (already forked from latest `main`) and pick a range starting after the highest existing timestamp. This repo has hit real cross-branch timestamp collisions twice this epic already.
- `player_items`/`player_progression`/`player_equipment` are character-keyed (`character_id`, no `user_id` column) as of the merged player-characters epic (SOMET-256/257/259/260) and the chests post-merge repair (`b1621cb`). Every query in this plan targets `character_id`.
- The `World` class's in-memory player registry (`this.players`, a `Map`) is keyed by an opaque session identifier still *named* `userId` throughout `world.js` (legacy naming predating characters) — this is NOT a database foreign key. The real DB-facing identifier is `p.characterId`, a field on the player object set at join time. Every DB query in this plan uses `p.characterId`, never the `world.js` player-map key.
- RNG-driven logic (the destroy-chance roll) takes an injectable `rng = Math.random`, never calls `Math.random()` internally — matches `rollDrops`/`rollGold` in `loot.js`.
- Every DB-touching function committing multiple writes atomically uses one checked-out client with explicit `BEGIN`/`COMMIT`/`ROLLBACK`.
- Migration tests use the no-DB `fakePgm` mock pattern for schema-only migrations; the conversion migration additionally needs a DB-backed round-trip test (`zz`-prefix + cascade-cleanup, established throughout the chests sub-project).
- Work happens entirely inside the isolated worktree `.claude/worktrees/magic-stones-d245`, branch `feat/magic-stones-d245`. Before starting, re-confirm the primary checkout at `/home/markunn/worker/coding/jsgame/something2` is not mid-edit by a concurrent session (`git status --short` there) — if it is, do not touch it; this worktree is already isolated from it.

---

### Task 1: Schema migrations — `item_types` widening, `stone_instances`

**Files:**
- Create: `backend/migrations/<TS1>_stone_item_type.js`
- Create: `backend/migrations/<TS2>_stone_instances.js`
- Test: `backend/tests/migration_stone_item_type.test.js`
- Test: `backend/tests/migration_stone_instances.test.js`

**Interfaces:**
- Produces: `item_types.category` widened to include `'stone'`; new nullable `item_types.stat_bonus_stat` (text), `item_types.stat_bonus_amount` (integer); `stone_instances(player_item_id, xp, level, socketed_into_id, created_at)`.

- [ ] **Step 0: Pick the timestamp range**

Run: `cd backend && ls migrations | sort | tail -5`
Pick `<TS1>` = (highest existing timestamp) + 1000, `<TS2>` = `<TS1>` + 1000. Use these exact values everywhere below instead of the placeholders.

- [ ] **Step 1: Write `<TS1>_stone_item_type.js`**

```js
exports.shorthands = undefined;

// 'stone' is a new item_types category; widen the check constraint before
// adding the buff-stone columns. Same drop-and-recreate pattern
// 1714440152000_loot_map_item.js used to add 'consumable'.
exports.up = (pgm) => {
  pgm.dropConstraint('item_types', 'item_types_category_check');
  pgm.addConstraint('item_types', 'item_types_category_check', {
    check: "category IN ('weapon','armor','ammo','currency','consumable','stone')",
  });

  pgm.addColumns('item_types', {
    stat_bonus_stat: { type: 'text', notNull: false },
    stat_bonus_amount: { type: 'integer', notNull: false },
  });

  // A stone is exactly one kind: a spell stone (element set, no stat bonus)
  // XOR a buff stone (no element, stat bonus set). Non-stone rows are
  // unconstrained by this check.
  pgm.addConstraint('item_types', 'item_types_stone_kind_check', {
    check: `category <> 'stone' OR (
      (element IS NOT NULL AND stat_bonus_stat IS NULL)
      OR (element IS NULL AND stat_bonus_stat IS NOT NULL AND stat_bonus_amount IS NOT NULL)
    )`,
  });
  pgm.addConstraint('item_types', 'item_types_stat_bonus_stat_check', {
    check: `stat_bonus_stat IS NULL OR stat_bonus_stat IN
      ('strength','dexterity','constitution','intelligence','wisdom','charisma')`,
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('item_types', 'item_types_stat_bonus_stat_check');
  pgm.dropConstraint('item_types', 'item_types_stone_kind_check');
  pgm.dropColumns('item_types', ['stat_bonus_stat', 'stat_bonus_amount']);
  pgm.dropConstraint('item_types', 'item_types_category_check');
  pgm.addConstraint('item_types', 'item_types_category_check', {
    check: "category IN ('weapon','armor','ammo','currency','consumable')",
  });
};
```

- [ ] **Step 2: Write the no-DB migration test**

```js
const test = require('node:test');
const assert = require('node:assert');

function fakePgm() {
  const calls = { dropConstraint: [], addConstraint: [], addColumns: [], dropColumns: [] };
  return {
    calls,
    dropConstraint: (name, cname) => calls.dropConstraint.push({ name, cname }),
    addConstraint: (name, cname, opts) => calls.addConstraint.push({ name, cname, opts }),
    addColumns: (name, cols) => calls.addColumns.push({ name, cols }),
    dropColumns: (name, cols) => calls.dropColumns.push({ name, cols }),
  };
}

const mig = require('../migrations/<TS1>_stone_item_type.js');

test('up widens item_types_category_check to add stone, keeping every existing category', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const add = pgm.calls.addConstraint.find((c) => c.cname === 'item_types_category_check');
  for (const cat of ['weapon', 'armor', 'ammo', 'currency', 'consumable', 'stone']) {
    assert.match(add.opts.check, new RegExp(`'${cat}'`), `category CHECK omits ${cat}`);
  }
});

test('up adds nullable stat_bonus_stat/stat_bonus_amount', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const add = pgm.calls.addColumns.find((c) => c.name === 'item_types');
  assert.equal(add.cols.stat_bonus_stat.type, 'text');
  assert.notEqual(add.cols.stat_bonus_stat.notNull, true);
  assert.equal(add.cols.stat_bonus_amount.type, 'integer');
  assert.notEqual(add.cols.stat_bonus_amount.notNull, true);
});

test('stone_kind_check enforces spell XOR buff for stone rows only', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const c = pgm.calls.addConstraint.find((x) => x.cname === 'item_types_stone_kind_check');
  assert.match(c.opts.check, /category <> 'stone'/);
  assert.match(c.opts.check, /element IS NOT NULL AND stat_bonus_stat IS NULL/);
  assert.match(c.opts.check, /element IS NULL AND stat_bonus_stat IS NOT NULL AND stat_bonus_amount IS NOT NULL/);
});

test('stat_bonus_stat_check only accepts the six base stats', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const c = pgm.calls.addConstraint.find((x) => x.cname === 'item_types_stat_bonus_stat_check');
  for (const stat of ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']) {
    assert.match(c.opts.check, new RegExp(stat));
  }
});

test('down reverses columns and constraint back to pre-stone', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  assert.deepEqual(pgm.calls.dropColumns, [{ name: 'item_types', cols: ['stat_bonus_stat', 'stat_bonus_amount'] }]);
  const add = pgm.calls.addConstraint.find((c) => c.cname === 'item_types_category_check');
  assert.doesNotMatch(add.opts.check, /'stone'/);
});
```

- [ ] **Step 3: Run it**

Run: `cd backend && node --test tests/migration_stone_item_type.test.js`
Expected: PASS (5 tests)

- [ ] **Step 4: Write `<TS2>_stone_instances.js`**

```js
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('stone_instances', {
    player_item_id: { type: 'uuid', primaryKey: true, references: 'player_items', onDelete: 'CASCADE' },
    xp: { type: 'bigint', notNull: true, default: 0 },
    level: { type: 'integer', notNull: true, default: 1 },
    socketed_into_id: { type: 'uuid', notNull: false, references: 'player_items', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('stone_instances', 'stone_instances_xp_check', 'CHECK (xp >= 0)');
  pgm.addConstraint('stone_instances', 'stone_instances_level_check', 'CHECK (level >= 1)');
  // Partial unique index: at most one stone per host. NULLs (unsocketed
  // stones) are excluded by Postgres from a partial unique index's
  // uniqueness check by construction, so many loose stones can coexist.
  pgm.createIndex('stone_instances', 'socketed_into_id', {
    unique: true,
    where: 'socketed_into_id IS NOT NULL',
    name: 'stone_instances_socketed_into_unique',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('stone_instances');
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
    createIndex: (name, col, opts) => calls.createIndex.push({ name, col, opts }),
    func: (x) => ({ raw: x }),
  };
}

const mig = require('../migrations/<TS2>_stone_instances.js');

test('up creates stone_instances with player_item_id as the primary key', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const t = pgm.calls.createTable.find((c) => c.name === 'stone_instances');
  assert.ok(t);
  assert.equal(t.cols.player_item_id.primaryKey, true);
  assert.equal(t.cols.player_item_id.references, 'player_items');
  assert.equal(t.cols.player_item_id.onDelete, 'CASCADE');
  assert.equal(t.cols.socketed_into_id.onDelete, 'SET NULL');
  assert.equal(t.cols.socketed_into_id.notNull, false);
});

test('xp and level are CHECK-constrained', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const xp = pgm.calls.addConstraint.find((c) => /xp/.test(c.cname));
  assert.match(xp.expr, /xp >= 0/);
  const lvl = pgm.calls.addConstraint.find((c) => /level/.test(c.cname));
  assert.match(lvl.expr, /level >= 1/);
});

test('socketed_into_id has a partial unique index excluding NULLs', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const idx = pgm.calls.createIndex.find((c) => c.name === 'stone_instances');
  assert.equal(idx.col, 'socketed_into_id');
  assert.equal(idx.opts.unique, true);
  assert.match(idx.opts.where, /IS NOT NULL/);
});

test('down drops the table', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  assert.deepEqual(pgm.calls.dropTable, ['stone_instances']);
});
```

- [ ] **Step 6: Run it**

Run: `cd backend && node --test tests/migration_stone_instances.test.js`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add backend/migrations/<TS1>_stone_item_type.js backend/migrations/<TS2>_stone_instances.js backend/tests/migration_stone_item_type.test.js backend/tests/migration_stone_instances.test.js
git commit -m "feat(stones): schema for stone item type and stone_instances (SOMET-245)"
```

---

### Task 2: Conversion migration — existing magic weapons

**Files:**
- Create: `backend/migrations/<TS3>_convert_magic_weapons_to_stones.js`
- Test: `backend/tests/migration_convert_magic_weapons_db.test.js` (DB-backed, `zz`-prefix)

**Interfaces:**
- Consumes: `stone_instances` (Task 1). `characters`/`player_items` shape from `1714440092000_characters.js`.
- Produces: nothing consumed by later tasks (this is a one-time data migration) — but its `up()` must be idempotent-safe against `ON CONFLICT DO NOTHING` where it creates catalog rows, since migrations can theoretically be re-run in a repair scenario.

- [ ] **Step 1: Read the exact weapon-attack fields this migration must copy**

Run: `cd backend && sed -n '1,60p' src/authority/world.js | grep -n "w\.element\|w\.mana_cost\|w\.damage\|weaponDamage"`
Confirm exactly which `item_types` columns `weaponDamage`/the attack path read off a weapon (`element`, `mana_cost`, and whatever damage-relevant column(s) — read the full `weaponDamage` function body, not just the grep hits, to get the complete list). Use that exact column list in Step 2 below — do not guess.

- [ ] **Step 2: Write `<TS3>_convert_magic_weapons_to_stones.js`**

```js
exports.shorthands = undefined;

// Existing magic weapons predate the socket system: their spell was baked
// directly into item_types.element/mana_cost. This migration converts
// every such weapon TYPE into a corresponding stone type, then gives every
// player who owns one of those weapons a matching stone instance,
// pre-socketed into their weapon. Modeled on 1714440092000_characters.js:
// a real, reversible rewrite of data players already own.
//
// The weapon's own element/mana_cost columns are left untouched -- once
// combat integration (a later task) ships, they become vestigial (combat
// reads the socketed stone instead), but leaving them intact means down()
// needs no data reconstruction on the weapon-type side.
exports.up = (pgm) => {
  // 1. One stone item_type per distinct magic weapon type. Named
  // deterministically from the weapon so a repair-run ON CONFLICT is safe.
  pgm.sql(`
    INSERT INTO item_types (name, category, element, mana_cost, damage, cooldown, stackable)
    SELECT 'stone_of_' || wt.name, 'stone', wt.element, wt.mana_cost, wt.damage, 0, false
      FROM item_types wt
     WHERE wt.category = 'weapon' AND wt.element IS NOT NULL AND wt.element <> 'physical'
    ON CONFLICT (name) DO NOTHING
  `);

  // 2. One stone player_items row + stone_instances row, pre-socketed, for
  // every player_items row of a converted weapon type.
  pgm.sql(`
    INSERT INTO player_items (id, character_id, item_type_id, quantity)
    SELECT gen_random_uuid(), pi.character_id, st.id, 1
      FROM player_items pi
      JOIN item_types wt ON wt.id = pi.item_type_id
      JOIN item_types st ON st.name = 'stone_of_' || wt.name
     WHERE wt.category = 'weapon' AND wt.element IS NOT NULL AND wt.element <> 'physical'
    RETURNING id
  `);

  // 3. Socket each newly-created stone into the weapon instance it came
  // from. Correlated via character_id + weapon type, matched back to the
  // exact player_items row created in step 2 by re-deriving the join --
  // there is no earlier temp table to carry ids through, so this re-joins
  // on (character_id, item_type_id=stone type) which is safe here ONLY
  // because step 2 guarantees exactly one new stone row per (character,
  // weapon instance) pair and this correlates each stone to its own
  // weapon instance by character_id + creation order. Verify this
  // assumption holds by reading the actual row counts in the DB-backed
  // test (Step 4) rather than trusting this comment -- if a character can
  // own MULTIPLE instances of the same magic weapon type, this join must
  // be tightened (e.g. via a temp table pairing weapon player_items.id to
  // stone player_items.id 1:1) before this ships.
  pgm.sql(`
    INSERT INTO stone_instances (player_item_id, socketed_into_id)
    SELECT stone_pi.id, weapon_pi.id
      FROM player_items weapon_pi
      JOIN item_types wt ON wt.id = weapon_pi.item_type_id
      JOIN item_types st ON st.name = 'stone_of_' || wt.name
      JOIN player_items stone_pi
        ON stone_pi.character_id = weapon_pi.character_id AND stone_pi.item_type_id = st.id
     WHERE wt.category = 'weapon' AND wt.element IS NOT NULL AND wt.element <> 'physical'
    ON CONFLICT (player_item_id) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM player_items
     WHERE item_type_id IN (
       SELECT id FROM item_types WHERE category = 'stone' AND name LIKE 'stone_of_%'
     )
  `);
  pgm.sql(`DELETE FROM item_types WHERE category = 'stone' AND name LIKE 'stone_of_%'`);
};
```

**STOP before finalizing this step:** the multi-instance-ownership risk flagged in the SQL comment above is a real correctness question this plan cannot resolve without querying the actual data — a character owning two swords of the same magic type would break the join's 1:1 assumption. Task implementer: query the live/test DB for `SELECT character_id, item_type_id, count(*) FROM player_items GROUP BY 1,2 HAVING count(*) > 1` joined against magic weapon types, before writing the final version of Step 2's SQL. If duplicates exist, use a temp table or a window-function row-pairing approach instead of the plain join above, and document the change here.

- [ ] **Step 3: Write the DB-backed round-trip test**

Read `backend/tests/seed_map_vault_chests_db.test.js` first for the exact `zz`-prefix/cleanup pattern to copy.

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

test('converting existing magic weapons to stones round-trips cleanly through down()', async () => {
  const pool = new Pool();
  try {
    // Set up: a zz-prefixed test user, character, a magic weapon item_type
    // (element != 'physical'), and a player_items row owning one, using
    // whatever helper this repo's other character-scoped DB tests already
    // use to create a test character (find it via grep -rn "INSERT INTO characters" tests/).
    // ... (full setup using the real helper, not invented here)

    // Snapshot player_items/player_equipment state for this character BEFORE up().
    const before = await pool.query(
      'SELECT id, item_type_id, quantity FROM player_items WHERE character_id = $1 ORDER BY id',
      [testCharacterId],
    );

    // Run up() via the actual migration module (require it directly and
    // call .up(realPgmInstance) against a real transaction, OR shell out
    // to `npx node-pg-migrate up` scoped to this one migration -- check
    // how seed_map_vault_chests_db.test.js or an equivalent DB-migration
    // test in this repo actually invokes a migration against a live DB,
    // and match that exact mechanism).

    // Assert: a new stone player_items row exists for this character,
    // socketed into the original weapon's player_items.id.
    const stone = await pool.query(
      `SELECT si.* FROM stone_instances si
         JOIN player_items pi ON pi.id = si.player_item_id
        WHERE pi.character_id = $1`,
      [testCharacterId],
    );
    assert.equal(stone.rowCount, 1);
    assert.equal(stone.rows[0].socketed_into_id, weaponPlayerItemId);

    // Run down(). Assert player_items for this character is BYTE-IDENTICAL
    // to the `before` snapshot (same ids, same item_type_id, same quantity)
    // -- this is the "verified rollback, not just written" bar the spec sets.
    const after = await pool.query(
      'SELECT id, item_type_id, quantity FROM player_items WHERE character_id = $1 ORDER BY id',
      [testCharacterId],
    );
    assert.deepEqual(after.rows, before.rows);
  } finally {
    // Clean up the zz-prefixed test user/character (cascades handle the rest).
    await pool.end();
  }
});
```

- [ ] **Step 4: Run it against the dev DB**

Run: `cd backend && node --test tests/migration_convert_magic_weapons_db.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/<TS3>_convert_magic_weapons_to_stones.js backend/tests/migration_convert_magic_weapons_db.test.js
git commit -m "feat(stones): reversible conversion of existing magic weapons to stones (SOMET-245)"
```

---

### Task 3: Pure logic — compatibility check, destroy-chance roll

**Files:**
- Create: `backend/src/services/stones.js`
- Test: `backend/tests/stones.test.js`

**Interfaces:**
- Produces: `isCompatible(stoneKind, hostCategory)` → `boolean`, where `stoneKind` is `'spell'|'buff'` (derived from whether the stone's `item_types` row has `element` or `stat_bonus_stat` set — see Step 3). `rollDestroy(rng)` → `boolean` (true = destroyed). `STONE_DESTROY_CHANCE` — named constant, `0.10`.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert');
const { isCompatible, rollDestroy, stoneKind, STONE_DESTROY_CHANCE } = require('../src/services/stones.js');

test('stoneKind reads spell vs buff off the item_types row shape', () => {
  assert.equal(stoneKind({ element: 'fire', stat_bonus_stat: null }), 'spell');
  assert.equal(stoneKind({ element: null, stat_bonus_stat: 'strength' }), 'buff');
});

test('spell stones are weapon-only; buff stones fit weapon or armor', () => {
  assert.equal(isCompatible('spell', 'weapon'), true);
  assert.equal(isCompatible('spell', 'armor'), false);
  assert.equal(isCompatible('buff', 'weapon'), true);
  assert.equal(isCompatible('buff', 'armor'), true);
});

test('rollDestroy is deterministic under an injected rng, at the exact 10% boundary', () => {
  assert.equal(STONE_DESTROY_CHANCE, 0.10);
  assert.equal(rollDestroy(() => 0.05), true, 'below the threshold destroys');
  assert.equal(rollDestroy(() => 0.10), false, 'exactly at the threshold survives (chance is a strict <)');
  assert.equal(rollDestroy(() => 0.99), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/stones.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// Pure stone logic: kind classification, socket compatibility, and the
// destroy-on-removal roll. No DB access -- callers own all persistence.
const STONE_DESTROY_CHANCE = 0.10;

function stoneKind(itemTypeRow) {
  return itemTypeRow.element != null ? 'spell' : 'buff';
}

function isCompatible(kind, hostCategory) {
  if (kind === 'spell') return hostCategory === 'weapon';
  return hostCategory === 'weapon' || hostCategory === 'armor';
}

function rollDestroy(rng = Math.random) {
  return rng() < STONE_DESTROY_CHANCE;
}

module.exports = { STONE_DESTROY_CHANCE, stoneKind, isCompatible, rollDestroy };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/stones.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/stones.js backend/tests/stones.test.js
git commit -m "feat(stones): pure compatibility and destroy-roll logic (SOMET-245)"
```

---

### Task 4: Socket / unsocket WebSocket handlers + in-memory sync

**Files:**
- Modify: `backend/src/authority/items.js` (add `socketStone`, `unsocketStone` — DB-touching, mirroring `equip`/`unequip`'s shape in the same file)
- Modify: `backend/src/authority/server.js` (add `socket`/`unsocket` message handlers, next to `equip`/`unequip` in `messageHandlers`)
- Test: `backend/tests/stones_service.test.js`
- Test: whichever handler-test file the chests sub-project used for `server.js` message handlers (find via `grep -rln "handlers.drop\|handlers.pickup\|handlers.use" tests/*.js` — reuse that exact harness)

**Interfaces:**
- Consumes: `isCompatible`, `stoneKind`, `rollDestroy`, `STONE_DESTROY_CHANCE` (Task 3). `findItem(inv, itemId)` from `items.js` (`inv.items.find((it) => it.id === itemId)`).
- Produces: `socketStone(pool, characterId, inv, stonePlayerItemId, hostPlayerItemId, itemTypes)` → `Promise<{ok: true} | {ok: false, reason}>`. `unsocketStone(pool, characterId, inv, stonePlayerItemId, { confirm, rng })` → `Promise<{ok: true, destroyed: boolean} | {ok: false, reason}>`.

- [ ] **Step 0: Read `equip`/`unequip` in `items.js` in full**

Run: `cd backend && grep -n "^async function equip\|^async function unequip" -A 40 src/authority/items.js`
Match their exact transaction shape (single checked-out client, `BEGIN`/`COMMIT`/`ROLLBACK`), ownership-check pattern, and how they mutate the in-memory `inv` object on success (so a later action in the same session sees the change without a reload) — `socketStone`/`unsocketStone` must follow the identical shape.

- [ ] **Step 1: Write the failing tests for `socketStone`**

```js
const test = require('node:test');
const assert = require('node:assert');
const { socketStone, unsocketStone } = require('../src/authority/items.js');

// Follow items.js's own existing test file's scriptedPool/client mock
// convention -- find it via grep -rln "equip(" tests/*.js and copy its
// exact mock shape before writing these.

test('socketStone rejects a spell stone targeting armor', async () => {
  // stone item_types row: element set (spell); host item_types row:
  // category='armor'. Expect { ok: false, reason: /compatib/i }, no DB writes.
});

test('socketStone rejects a host that already has an occupant', async () => {
  // Mock the pre-check query returning an existing stone_instances row for
  // the host id. Expect { ok: false, reason: /occupied|already/i }.
});

test('socketStone succeeds: writes stone_instances.socketed_into_id and updates inv in place', async () => {
  // Expect the mock UPDATE to run, and the passed-in `inv` object (or its
  // relevant item record) to reflect the socketing afterward -- read
  // Task 5's caching decision (below) before writing this assertion, since
  // it determines exactly WHAT gets mutated on `inv`.
});

test('unsocketStone without confirm=true is rejected before any roll or DB write', async () => {
  const calls = [];
  const pool = { connect: async () => ({ query: async (sql) => { calls.push(sql); return { rows: [], rowCount: 0 }; }, release: () => {} }) };
  const result = await unsocketStone(pool, 1, { items: [] }, 'stone-1', { confirm: false });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0, 'no DB call before the confirm gate');
});

test('unsocketStone: destroy roll below threshold deletes the stone and its instance row', async () => {
  // rng always returns 0 -> rollDestroy true. Assert the mock DELETE FROM
  // player_items runs for the stone's own id, and the result is
  // { ok: true, destroyed: true }.
});

test('unsocketStone: destroy roll at/above threshold clears socketed_into_id and preserves xp/level', async () => {
  // rng always returns 0.99 -> rollDestroy false. Assert socketed_into_id
  // is set NULL (not the row deleted), and the result is
  // { ok: true, destroyed: false }.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/stones_service.test.js`
Expected: FAIL — module exports not found

- [ ] **Step 3: Write `socketStone`/`unsocketStone`, appended to `backend/src/authority/items.js`**

```js
const { isCompatible, stoneKind, rollDestroy } = require('../services/stones.js');

// Socket a stone into a host item. Ownership of BOTH instances is checked
// against characterId (never trust a client-supplied pair blindly). The
// partial unique index on stone_instances.socketed_into_id is the DB-level
// backstop; this also checks explicitly first for a clean error message
// rather than surfacing a raw constraint violation to the caller.
async function socketStone(pool, characterId, inv, stonePlayerItemId, hostPlayerItemId, itemTypes) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stoneRow = await client.query(
      `SELECT pi.id, pi.item_type_id, si.socketed_into_id
         FROM player_items pi JOIN stone_instances si ON si.player_item_id = pi.id
        WHERE pi.id = $1 AND pi.character_id = $2 FOR UPDATE`,
      [stonePlayerItemId, characterId],
    );
    if (stoneRow.rowCount === 0) { await client.query('ROLLBACK'); return { ok: false, reason: 'stone not found' }; }
    if (stoneRow.rows[0].socketed_into_id != null) {
      await client.query('ROLLBACK'); return { ok: false, reason: 'stone is already socketed' };
    }

    const hostRow = await client.query(
      'SELECT id, item_type_id FROM player_items WHERE id = $1 AND character_id = $2 FOR UPDATE',
      [hostPlayerItemId, characterId],
    );
    if (hostRow.rowCount === 0) { await client.query('ROLLBACK'); return { ok: false, reason: 'host item not found' }; }

    const occupant = await client.query(
      'SELECT 1 FROM stone_instances WHERE socketed_into_id = $1', [hostPlayerItemId],
    );
    if (occupant.rowCount > 0) { await client.query('ROLLBACK'); return { ok: false, reason: 'host already has a socketed stone' }; }

    const stoneType = itemTypes.get(stoneRow.rows[0].item_type_id);
    const hostType = itemTypes.get(hostRow.rows[0].item_type_id);
    if (!isCompatible(stoneKind(stoneType), hostType.category)) {
      await client.query('ROLLBACK'); return { ok: false, reason: 'stone is not compatible with this item' };
    }

    await client.query('UPDATE stone_instances SET socketed_into_id = $1 WHERE player_item_id = $2',
      [hostPlayerItemId, stonePlayerItemId]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Unsocket. Requires an explicit confirm flag -- checked BEFORE any query,
// so a client that forgot it costs nothing. On a destroy roll, deletes the
// stone's player_items row (stone_instances cascades). On success, clears
// socketed_into_id and the stone's xp/level survive untouched.
async function unsocketStone(pool, characterId, inv, stonePlayerItemId, { confirm, rng = Math.random } = {}) {
  if (!confirm) return { ok: false, reason: 'unsocketing requires explicit confirmation' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stoneRow = await client.query(
      `SELECT pi.id FROM player_items pi
         JOIN stone_instances si ON si.player_item_id = pi.id
        WHERE pi.id = $1 AND pi.character_id = $2 AND si.socketed_into_id IS NOT NULL FOR UPDATE`,
      [stonePlayerItemId, characterId],
    );
    if (stoneRow.rowCount === 0) { await client.query('ROLLBACK'); return { ok: false, reason: 'stone not found or not socketed' }; }

    const destroyed = rollDestroy(rng);
    if (destroyed) {
      await client.query('DELETE FROM player_items WHERE id = $1', [stonePlayerItemId]);
    } else {
      await client.query('UPDATE stone_instances SET socketed_into_id = NULL WHERE player_item_id = $1', [stonePlayerItemId]);
    }
    await client.query('COMMIT');
    return { ok: true, destroyed };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { /* ...existing exports..., */ socketStone, unsocketStone };
```

**Before finalizing:** add `socketStone`/`unsocketStone` to `items.js`'s existing `module.exports` line rather than replacing it — read the current export statement first.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/stones_service.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Add `socket`/`unsocket` handlers to `server.js`'s `messageHandlers`, next to `equipOrUnequip`**

```js
const { socketStone, unsocketStone } = require('./items.js');

socket(ws, msg) {
  const entry = worlds.get(ws.worldId);
  if (!entry) return;
  chainOp(ws, 'socket', async () => {
    const p = entry.world.players.get(ws.userId);
    if (!p) return;
    const r = await socketStone(pool, p.characterId, p.inv, msg.stoneId, msg.hostId, entry.itemTypes);
    if (!r.ok) { send(ws, { type: 'error', message: r.reason }); return; }
    send(ws, { type: 'socketed', stoneId: msg.stoneId, hostId: msg.hostId });
  });
},

unsocket(ws, msg) {
  const entry = worlds.get(ws.worldId);
  if (!entry) return;
  chainOp(ws, 'unsocket', async () => {
    const p = entry.world.players.get(ws.userId);
    if (!p) return;
    const r = await unsocketStone(pool, p.characterId, p.inv, msg.stoneId, { confirm: msg.confirm === true });
    if (!r.ok) { send(ws, { type: 'error', message: r.reason }); return; }
    send(ws, { type: 'unsocketed', stoneId: msg.stoneId, destroyed: r.destroyed });
  });
},
```

**Verify before shipping this step:** `entry.itemTypes` (used above for `socketStone`'s `itemTypes` map) — confirm this is the actual field name on `entry` that holds the loaded item-type catalog (`loadWorld`'s object literal, read in Task 3 of the chests plan, had `creatureTypes` but you must re-check for an item-types equivalent — grep `entry\.\w*[Ii]tem[Tt]ype` across `server.js`). If no such map exists on `entry` yet, `loadItemTypes(pool)` (referenced in `loadWorld`) is the loader to call once at world-load time and thread through — do not requery it per socket/unsocket call.

- [ ] **Step 6: Locate the message-handler test harness and write the handler tests**

Run: `cd backend && grep -rln "handlers.drop\|handlers.pickup\|handlers.use" tests/*.js`
Read whichever file(s) that finds and mirror its harness. Minimum required assertions: `socket` with an incompatible stone/host pair sends an error frame; `unsocket` without `confirm:true` sends an error frame and makes no DB call; a successful `socket` sends a `socketed` frame; `unsocket` sends `unsocketed` with the correct `destroyed` flag under both a forced-destroy and forced-survive `rng`.

- [ ] **Step 7: Run it and commit**

```bash
git add backend/src/authority/items.js backend/src/authority/server.js backend/tests/stones_service.test.js backend/tests/<handler test file>
git commit -m "feat(stones): socket/unsocket handlers with compatibility and destroy-roll guards (SOMET-245)"
```

---

### Task 4b: Eject a socketed stone when its host item is deleted

The spec calls this out explicitly and it was missing from the original task list (caught in self-review): `ON DELETE SET NULL` on `stone_instances.socketed_into_id` fires when the stone's OWN `player_items` row is deleted, not when the HOST it's socketed into is deleted. Dropping, selling, or otherwise deleting a host item while a stone is socketed into it must eject the stone (clear `socketed_into_id`) rather than leave it pointing at a nonexistent row.

**Files:**
- Create: `backend/src/services/stoneEject.js`
- Modify: `backend/src/authority/loot.js` (`dropItem`) and `backend/src/authority/trade.js` (`sellItem`) — every existing site that deletes a `player_items` row a player owns.
- Test: `backend/tests/stoneEject.test.js`, extend `backend/tests/dropItem` and `sellItem`'s existing test coverage (find their test files via `grep -rln "dropItem\|sellItem" tests/*.js`).

**Interfaces:**
- Produces: `ejectSocketedStone(client, hostPlayerItemId)` → `Promise<void>` — clears `socketed_into_id` for any stone pointing at this host, no-op if none. Takes a checked-out transaction client (the caller's own — this must run inside the SAME transaction as the host's deletion, never after, or a crash between the two leaves the same dangling state this task exists to prevent).

- [ ] **Step 1: Enumerate every deletion site**

Run: `cd backend && grep -rln "DELETE FROM player_items" src/`
Read each result in full. The plan assumes `dropItem` (`loot.js`) and `sellItem` (`trade.js`) are the only two — confirm this is still true against the current worktree; if a third site exists, it needs the same treatment as Steps 3-4 below.

- [ ] **Step 2: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert');
const { ejectSocketedStone } = require('../src/services/stoneEject.js');

test('ejectSocketedStone clears socketed_into_id for a stone pointing at the given host', async () => {
  const calls = [];
  const client = { query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1 }; } };
  await ejectSocketedStone(client, 'host-1');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /UPDATE stone_instances SET socketed_into_id = NULL/i);
  assert.deepEqual(calls[0].params, ['host-1']);
});

test('ejectSocketedStone is a no-op (still one clean UPDATE, no error) when nothing is socketed into the host', async () => {
  const client = { query: async () => ({ rowCount: 0 }) };
  await assert.doesNotReject(() => ejectSocketedStone(client, 'host-with-nothing-socketed'));
});
```

- [ ] **Step 3: Run test to verify it fails, then implement**

```js
async function ejectSocketedStone(client, hostPlayerItemId) {
  await client.query('UPDATE stone_instances SET socketed_into_id = NULL WHERE socketed_into_id = $1', [hostPlayerItemId]);
}

module.exports = { ejectSocketedStone };
```

Run: `cd backend && node --test tests/stoneEject.test.js` — Expected: PASS (2 tests) after implementing.

- [ ] **Step 4: Wire into `dropItem` (`loot.js`) and `sellItem` (`trade.js`)**

Read each function in full first. Both already run inside a transaction with a checked-out client (confirm this before editing — if either does NOT currently use a transaction client for its `player_items` DELETE, that is itself a pre-existing gap outside this task's scope; report it rather than silently wrapping one in a new transaction). Add `await ejectSocketedStone(client, itemId)` immediately before (or as part of the same statement sequence as) the `DELETE FROM player_items` in each — same transaction, so a crash between the two is impossible, not just unlikely.

- [ ] **Step 5: Extend `dropItem`'s and `sellItem`'s existing tests**

Add a case to each: drop/sell a host item that has a stone socketed into it; assert the stone (found via a separate `player_items`/`stone_instances` row, untouched by the drop/sell) now has `socketed_into_id = NULL` rather than pointing at the deleted host.

- [ ] **Step 6: Run touched tests and commit**

```bash
cd backend && node --test tests/stoneEject.test.js tests/<dropItem test file> tests/<sellItem test file>
git add backend/src/services/stoneEject.js backend/src/authority/loot.js backend/src/authority/trade.js backend/tests/stoneEject.test.js
git commit -m "feat(stones): eject a socketed stone when its host item is dropped or sold (SOMET-245)"
```

---

### Task 5: Combat integration — replace semantics, in-memory socket cache

**Files:**
- Modify: `backend/src/authority/items.js` (`activeWeaponType` — resolve the socketed stone's type instead of the weapon's own, when one is socketed)
- Modify: `backend/src/authority/world.js` (`weaponDamage`, `attack`, `canAttack` — read from the resolved type, unchanged otherwise)
- Modify: `backend/src/authority/items.js`'s `socketStone`/`unsocketStone` (Task 4) — mutate the in-memory cache described below on success
- Test: `backend/tests/items_socket_cache.test.js`, extend `backend/tests/stones_service.test.js`

**Interfaces:**
- Consumes: `findItem(inv, itemId)`, `activeWeaponType(inv, itemTypes, defaultWeaponId)` (existing, `items.js:192-200`).
- Produces: `activeWeaponType` now checks a per-instance socket cache before falling back to the weapon's own `item_types` row. Cache shape: each element of `inv.items` (the `{id, typeId, quantity}` records `p.inv.items` already holds — see `loot.js`'s `claimItem`) gains an optional `socketedStoneTypeId` field, set/cleared by `socketStone`/`unsocketStone`.

**Why an in-memory cache, not a DB read per attack:** `attack()`/`canAttack()` run on the hot path (every player swing). A DB query there is a real performance regression this plan will not introduce. `entry.chests`/`entry.world.groundItems` already establish the precedent of an in-memory cache kept consistent by every write path in this codebase (chests sub-project, Tasks 4-6) — this task follows the same shape, scoped to `inv.items` instead of `entry`.

- [ ] **Step 1: Write the failing test for the cache + resolution**

```js
const test = require('node:test');
const assert = require('node:assert');
const { activeWeaponType } = require('../src/authority/items.js');

test('activeWeaponType returns the socketed stone type when the equipped weapon has one', () => {
  const stoneType = { id: 99, category: 'stone', element: 'fire', mana_cost: 5 };
  const weaponType = { id: 5, category: 'weapon', element: 'physical', mana_cost: 0 };
  const itemTypes = new Map([[5, weaponType], [99, stoneType]]);
  const inv = {
    equipment: { main_hand: 'weapon-instance-1' },
    items: [{ id: 'weapon-instance-1', typeId: 5, quantity: 1, socketedStoneTypeId: 99 }],
  };
  const resolved = activeWeaponType(inv, itemTypes, 5);
  assert.equal(resolved.element, 'fire', 'must resolve to the STONE\'s element, not the weapon\'s own');
  assert.equal(resolved.mana_cost, 5);
});

test('activeWeaponType falls back to the weapon\'s own type when nothing is socketed', () => {
  const weaponType = { id: 5, category: 'weapon', element: 'physical', mana_cost: 0 };
  const itemTypes = new Map([[5, weaponType]]);
  const inv = {
    equipment: { main_hand: 'weapon-instance-1' },
    items: [{ id: 'weapon-instance-1', typeId: 5, quantity: 1 }], // no socketedStoneTypeId
  };
  const resolved = activeWeaponType(inv, itemTypes, 5);
  assert.equal(resolved.element, 'physical');
});

test('activeWeaponType ignores a socketed BUFF stone for attack resolution (buff stones do not touch attacks)', () => {
  const buffStoneType = { id: 77, category: 'stone', element: null, stat_bonus_stat: 'strength', stat_bonus_amount: 3 };
  const weaponType = { id: 5, category: 'weapon', element: 'physical', mana_cost: 0 };
  const itemTypes = new Map([[5, weaponType], [77, buffStoneType]]);
  const inv = {
    equipment: { main_hand: 'weapon-instance-1' },
    items: [{ id: 'weapon-instance-1', typeId: 5, quantity: 1, socketedStoneTypeId: 77 }],
  };
  const resolved = activeWeaponType(inv, itemTypes, 5);
  assert.equal(resolved.element, 'physical', 'a buff stone must not override the weapon attack');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/items_socket_cache.test.js`
Expected: FAIL — `activeWeaponType` ignores `socketedStoneTypeId`

- [ ] **Step 3: Modify `activeWeaponType` in `backend/src/authority/items.js`**

Read the current function (`items.js:192-200`) first; modify it to:

```js
function activeWeaponType(inv, itemTypes, defaultWeaponId) {
  const itemId = inv.equipment.main_hand;
  if (itemId) {
    const item = findItem(inv, itemId);
    const type = item ? itemTypes.get(item.typeId) : null;
    if (type && type.category === 'weapon') {
      if (item.socketedStoneTypeId != null) {
        const stoneType = itemTypes.get(item.socketedStoneTypeId);
        // Only a SPELL stone (element set) overrides the attack -- a buff
        // stone socketed here (weapon sockets accept both kinds) has no
        // attack-relevant fields and must fall through to the weapon itself.
        if (stoneType && stoneType.element != null) return stoneType;
      }
      return type;
    }
  }
  return itemTypes.get(defaultWeaponId) || null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/items_socket_cache.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire the cache writes into `socketStone`/`unsocketStone` (Task 4)**

In `socketStone`, after the `COMMIT` succeeds, mutate the in-memory item record:

```js
const hostItem = findItem(inv, hostPlayerItemId);
if (hostItem) hostItem.socketedStoneTypeId = stoneRow.rows[0].item_type_id;
```

In `unsocketStone`, after the `COMMIT` succeeds, find whichever `inv.items` element currently has `socketedStoneTypeId` pointing at this stone's type and clear it — the handler only has the stone's id, not the host's, so this requires a lookup: extend `unsocketStone`'s pre-commit `SELECT` (the one that already fetches the stone row) to also return `socketed_into_id`, and use that to find and clear the host's cache entry, same pattern as `socketStone`'s write above.

- [ ] **Step 6: Extend `stones_service.test.js` to assert the cache updates**

Add assertions to Task 4's `socketStone succeeds` and both `unsocketStone` destroy-branch tests confirming the passed-in `inv` object's relevant item record's `socketedStoneTypeId` is set (on socket) or cleared (on unsocket, both destroy and survive branches — a destroyed stone must also clear the HOST's cache entry, not just delete the stone's own record).

- [ ] **Step 7: Run all touched tests and commit**

```bash
cd backend && node --test tests/items_socket_cache.test.js tests/stones_service.test.js
git add backend/src/authority/items.js backend/tests/items_socket_cache.test.js backend/tests/stones_service.test.js
git commit -m "feat(stones): combat reads the socketed spell stone, in-memory cache kept in sync (SOMET-245)"
```

---

### Task 6: Buff-stone stat overlay into `derivePlayerStats`

**Files:**
- Create: `backend/src/services/stoneBonuses.js`
- Modify: `backend/src/authority/server.js:531,1383,1894` (the three existing `applyDerivedStats(uid, derivePlayerStats(progression))` call sites) and the `socket`/`unsocket` handlers (Task 4) — trigger an immediate re-derive so a buff stone's effect (or its removal) applies right away, not just at the next level-up/kill.
- Test: `backend/tests/stoneBonuses.test.js`, extend the handler test file from Task 4.

**Interfaces:**
- Consumes: `derivePlayerStats(progression)` from `backend/src/services/playerStats.js` (reads `progression.strength` etc., unchanged).
- Produces: `withStoneBonuses(progression, buffStones)` → a shallow-copied progression-shaped object with each buff stone's `stat_bonus_amount` added to the matching stat. `buffStones` is `Array<{stat_bonus_stat, stat_bonus_amount}>`. Also produces `socketedBuffStones(inv, itemTypes)` — deliberately a DIFFERENT name from `withStoneBonuses`'s parameter, since both live in the same module and a shared name would shadow.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert');
const { withStoneBonuses } = require('../src/services/stoneBonuses.js');

test('withStoneBonuses adds each buff stone\'s amount to the matching stat, without mutating the input', () => {
  const progression = { strength: 10, dexterity: 5, level: 3 };
  const buffs = [{ stat_bonus_stat: 'strength', stat_bonus_amount: 4 }];
  const result = withStoneBonuses(progression, buffs);
  assert.equal(result.strength, 14);
  assert.equal(result.dexterity, 5);
  assert.equal(progression.strength, 10, 'must not mutate the original progression object');
});

test('withStoneBonuses sums multiple buffs on the same stat', () => {
  const progression = { intelligence: 5 };
  const buffs = [
    { stat_bonus_stat: 'intelligence', stat_bonus_amount: 2 },
    { stat_bonus_stat: 'intelligence', stat_bonus_amount: 3 },
  ];
  assert.equal(withStoneBonuses(progression, buffs).intelligence, 10);
});

test('withStoneBonuses with no buffs returns the same values as the input', () => {
  const progression = { strength: 10, level: 3 };
  assert.deepEqual(withStoneBonuses(progression, []), progression);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/stoneBonuses.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// Overlays socketed buff-stone bonuses onto a progression-shaped object
// before derivePlayerStats runs. Never touches the persisted
// player_progression row -- this is a runtime overlay, recomputed on every
// derive, not a permanent stat change.
function withStoneBonuses(progression, buffStones = []) {
  const result = { ...progression };
  for (const b of buffStones) {
    result[b.stat_bonus_stat] = (result[b.stat_bonus_stat] || 0) + b.stat_bonus_amount;
  }
  return result;
}

module.exports = { withStoneBonuses };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/stoneBonuses.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Add a helper to collect a player's currently-socketed buff stones from `p.inv`**

Appended to `backend/src/services/stoneBonuses.js`:

```js
// Reads socketed buff stones off the SAME in-memory inv.items cache Task 5
// wrote (socketedStoneTypeId on each item record) -- no DB query. A buff
// stone is any socketed stone whose type has stat_bonus_stat set (the
// complement of Task 5's spell-stone check).
function socketedBuffStones(inv, itemTypes) {
  const out = [];
  for (const item of inv.items) {
    if (item.socketedStoneTypeId == null) continue;
    const stoneType = itemTypes.get(item.socketedStoneTypeId);
    if (stoneType && stoneType.stat_bonus_stat != null) {
      out.push({ stat_bonus_stat: stoneType.stat_bonus_stat, stat_bonus_amount: stoneType.stat_bonus_amount });
    }
  }
  return out;
}

module.exports = { withStoneBonuses, socketedBuffStones };
```

- [ ] **Step 6: Update the three existing `applyDerivedStats` call sites in `server.js`**

Read each of `server.js:531`, `:1383`, `:1894` in full (their surrounding function, not just the matched line) before editing — confirm each has access to a `p` (player object, carrying `p.inv`) and `entry.itemTypes` (or equivalent, per Task 4 Step 5's verification) in scope at that point. Change each from:

```js
entry.world.applyDerivedStats(uid, derivePlayerStats(progression));
```

to:

```js
const buffs = socketedBuffStones(p.inv, entry.itemTypes);
entry.world.applyDerivedStats(uid, derivePlayerStats(withStoneBonuses(progression, buffs)));
```

adjusting variable names (`uid`/`p`/`progression`) to match whatever each specific call site actually names them — do not copy-paste blindly across all three without checking.

- [ ] **Step 7: Trigger an immediate re-derive from `socket`/`unsocket` (Task 4's handlers)**

After a successful `socket` or `unsocket` in `server.js`, if the affected stone is a buff stone (check `stat_bonus_stat != null` on its type), call `entry.world.applyDerivedStats(ws.userId, derivePlayerStats(withStoneBonuses(currentProgression, socketedBuffStones(p.inv, entry.itemTypes))))` — this requires the current `progression` for this player, which the handler does not currently load; fetch it via `loadProgression(pool, p.characterId)` from `progressionStore.js` (same function `openChest` already uses) immediately before this call. Send the resulting `progression` frame the same way the three existing call sites do (read one of them, Task 6 Step 6, for the exact frame shape — `{type:'progression', progression, leveledUp, newLevel, awarded}`, with `leveledUp:false, awarded:0` here since no XP was actually awarded, only a re-derive triggered).

- [ ] **Step 8: Write/extend tests**

Extend the Task 4 handler test file: after a successful `socket` of a buff stone, assert a `progression` frame is sent reflecting the boosted stat (e.g. `maxHp` changes if the buff targets `constitution`). After `unsocket`, assert the frame reflects the bonus removed.

- [ ] **Step 9: Run touched tests and commit**

```bash
cd backend && node --test tests/stoneBonuses.test.js tests/<handler test file>
git add backend/src/services/stoneBonuses.js backend/src/authority/server.js backend/tests/stoneBonuses.test.js backend/tests/<handler test file>
git commit -m "feat(stones): buff-stone stat overlay into derivePlayerStats, live re-derive on socket/unsocket (SOMET-245)"
```

---

### Task 7: Stone XP on a landed spell-stone hit

**Files:**
- Create: `backend/src/authority/stoneXp.js`
- Modify: `backend/src/authority/world.js` (the weapon-hit call site(s) inside `attack()`)
- Test: `backend/tests/stoneXp.test.js`

**Interfaces:**
- Consumes: `weaponDamage(p, w)`, the melee/projectile hit-application code in `world.js` (read in full — Task 2's Step 1 already located the relevant lines).
- Produces: `awardStoneXp(pool, stonePlayerItemId, amount)` → `Promise<{level, xp, leveledUp}>` — independent of `awardXp` (A2's player-scoped function), touches only `stone_instances`.

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert');
const { awardStoneXp } = require('../src/authority/stoneXp.js');

function scriptedPool(row) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/UPDATE stone_instances/i.test(sql)) return { rows: [row], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('awardStoneXp adds xp and reports leveledUp when the level column actually changed', async () => {
  const pool = scriptedPool({ xp: 150, level: 2 });
  const result = await awardStoneXp(pool, 'stone-1', 50);
  assert.equal(result.leveledUp, true);
  assert.equal(result.level, 2);
  const upd = pool.calls.find((c) => /UPDATE stone_instances/i.test(c.sql));
  assert.match(upd.sql, /xp = xp \+ \$/i, 'must increment in SQL, not read-then-write in JS (race-safe)');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/stoneXp.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```js
// Stone XP, independent of A2's player-scoped awardXp -- a stone's XP/level
// live entirely in stone_instances, never touching player_progression.
// Level formula: read progressionConstants.js's existing xpToNext-style
// curve if one is reusable here (check XP_LEVEL_* constants in
// services/progressionConstants.js before inventing a second curve) --
// otherwise a simple fixed threshold is acceptable for this slice; do not
// invent a bespoke curve without checking for a reusable one first.
const LEVEL_XP_THRESHOLD = 100; // XP per stone level, flat -- see comment above before changing.

async function awardStoneXp(pool, stonePlayerItemId, amount) {
  const before = await pool.query('SELECT level FROM stone_instances WHERE player_item_id = $1', [stonePlayerItemId]);
  const beforeLevel = before.rows[0] ? Number(before.rows[0].level) : 1;

  const r = await pool.query(
    `UPDATE stone_instances SET xp = xp + $1,
            level = GREATEST(level, 1 + floor((xp + $1) / $2)::int)
      WHERE player_item_id = $3
      RETURNING xp, level`,
    [amount, LEVEL_XP_THRESHOLD, stonePlayerItemId],
  );
  if (r.rowCount === 0) return null;
  const { xp, level } = r.rows[0];
  return { xp: Number(xp), level: Number(level), leveledUp: Number(level) > beforeLevel };
}

module.exports = { awardStoneXp, LEVEL_XP_THRESHOLD };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/stoneXp.test.js`
Expected: PASS

- [ ] **Step 5: Wire `awardStoneXp` into the weapon-hit call site in `world.js`**

Read `world.js`'s `attack()` method in full (the melee-hit and projectile-hit branches Task 2 Step 1 already located, around the `applyDamageWithEffects`/`applyElementEffect` calls). At the point where a hit is confirmed to land using the resolved weapon type `w` (from `activeWeaponType`, now possibly a stone type per Task 5): if `w.category === 'stone'` (i.e., a spell stone is active), call `awardStoneXp(pool, <the socketed stone's player_items id>, <an amount>)`. **Getting the stone's `player_items.id` here needs the caller to know which instance is socketed, not just its resolved type** — extend `activeWeaponType`'s return (or add a sibling lookup) to also expose the stone's own `player_items.id` alongside its type, since `attack()` currently only has the type. Do not guess the XP amount formula — check whether a per-hit constant, or something derived from the hit's damage, fits this codebase's existing balance-tuning conventions (`progressionConstants.js`) before picking one; a flat per-hit constant is an acceptable default if no existing convention applies.

- [ ] **Step 6: Write the integration test**

Extend `world.js`'s existing attack-path test file (find it via `grep -rln "function attack\|\.attack(" tests/*.js`) with a case: a player with a spell stone socketed lands a hit; assert `awardStoneXp` was invoked for that stone's `player_items.id` (mock `stoneXp.js`'s export, or assert against a scripted pool if `world.js`'s tests already use one).

- [ ] **Step 7: Run touched tests and commit**

```bash
cd backend && node --test tests/stoneXp.test.js tests/<world attack test file>
git add backend/src/authority/stoneXp.js backend/src/authority/world.js backend/tests/stoneXp.test.js backend/tests/<world attack test file>
git commit -m "feat(stones): award stone XP on a landed spell-stone hit (SOMET-245)"
```

---

### Task 8: Integration, stress tests, and verification

**Files:**
- Test: `backend/tests/stones_integration_db.test.js` (real DB, `zz`-prefix + cascade cleanup)

- [ ] **Step 1: Write the DB-backed end-to-end test**

Cover, against a real test character: create a spell stone and a weapon, socket it, confirm combat resolution picks up the stone (via a focused call into whatever `world.js` exposes for testing attack resolution, not a full live-server round trip), land a hit and confirm stone XP increases, unsocket with a forced-survive `rng` and confirm the stone is back in loose inventory with XP intact, unsocket again with a forced-destroy `rng` and confirm the stone and its `stone_instances` row are both gone. Separately: create a buff stone, socket it into armor, confirm a `derivePlayerStats` call incorporating `withStoneBonuses` reflects the bonus.

- [ ] **Step 2: Stress cases**

Socketing into an already-occupied host (two concurrent-looking `socketStone` calls for the same host — assert only one succeeds, backstopped by the partial unique index). Unsocketing without `confirm`. Socketing a spell stone into armor. Socketing a stone that is not owned by the requesting character. Attacking with a weapon whose socketed stone was removed mid-session (cache must reflect the removal — covered by Task 5's cache-sync tests, re-confirm here at the integration level).

- [ ] **Step 3: Run the full backend suite once**

Run: `cd backend && npm test`
Expected: all pass except any already-known pre-existing failures on this branch (check `git log` / the current worktree's state for any documented pre-existing gaps the same way the chests sub-project tracked its known 8-9 — re-verify by name, don't assume the same list still applies since main has moved since then).

- [ ] **Step 4: API/CLI-level exercise (no frontend exists for this feature, same posture as the chests sub-project's Task 7)**

Drive a standalone instance of this worktree's backend via a real WebSocket script (adapt `backend/scripts/manual-verify-chests.js` from the chests sub-project as a template, same safety constraints: don't touch the primary checkout or its running docker stack, use a port other than the live one, zz-prefixed test data): socket a spell stone into a weapon, attack, confirm the hit reads the stone's element; socket a buff stone into armor, confirm a stat bonus is reflected in a `progression` frame; unsocket both ways (survive and destroy) and confirm the frames/inventory match.

- [ ] **Step 5: Commit**

```bash
git add backend/tests/stones_integration_db.test.js
git commit -m "test(stones): end-to-end integration and stress coverage (SOMET-245)"
```

---

### Task 9: Final whole-branch review + finish branch

- [ ] Dispatch a fresh reviewer (most capable model available) against the full diff from this branch's base (the commit this worktree was forked from) to `HEAD`, using the `requesting-code-review` template.
- [ ] Give the reviewer explicit extra scrutiny on: the conversion migration's multi-instance-ownership assumption (Task 2), the in-memory socket cache staying consistent across every write path (Task 5, mirroring the exact class of bug the chests final review caught), and the three `applyDerivedStats` call sites actually all being updated correctly (Task 6) rather than one silently missed.
- [ ] Address any Critical/Important findings in ONE fix wave; one scoped re-review; adjudicate any residuals per the SDD breaker rule (park with rulings, no second fix wave).
- [ ] Run `superpowers:finishing-a-development-branch` — push + PR, matching this repo's established convention.
- [ ] Update SOMET-245 in Plane with the evidence triad, same disclosure posture as SOMET-244: this session implemented AND reviewed it via dispatched fresh-context subagents throughout.
