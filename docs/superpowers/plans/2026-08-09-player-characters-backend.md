# Player Characters — Backend Implementation Plan (SOMET-257 … 261)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every piece of per-player state off `users.id` and onto a new `characters` table, so one account can hold up to eight independent characters with their own class, position, progression, inventory and equipment.

**Architecture:** Two migrations (class catalog, then the characters table and re-key), a small `characters` service plus REST routes, and a per-character rewrite of the authority join path. The 8-slot cap is enforced by a database constraint rather than an application count, so a race cannot produce a ninth character. Gold stays on `users`.

**Tech Stack:** Node 20 CommonJS, Express, raw `pg` queries, `node-pg-migrate` v6, `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-09-player-characters-design.md`
**Companion plan:** `docs/superpowers/plans/2026-08-09-player-characters-frontend.md` (slices F–H).

## Global Constraints

- **Branch:** all work lands on one branch, `feat/player-characters`. Nothing merges to `main` until slice H (frontend plan) passes browser verification — the backend alone requires a `character_id` the current client does not send, so an intermediate merge would break the game.
- **Never run destructive experiments against the shared dev database.** No `DELETE FROM` or `TRUNCATE` against a real catalog or a real player's rows to "see what happens". Test fixtures use `zz`-prefixed names and are removed by name in a `finally` block.
- **Never edit a committed migration.** Every schema change is a new file.
- **Migration numbers are hand-incremented, not epoch timestamps.** This plan claims `1714440091000` and `1714440092000`. If another branch has claimed them by the time you start, shift both up together and keep their relative order.
- **No assertion may be derived from the same constant the code under test reads.** Expected values are written out literally. Importing `seeds/data/entityTypes.js` into a test that checks the seeder is a test that passes against a seeder writing nothing.
- **Backend style:** CommonJS, inline Express routes, raw `pg` queries with `$1` placeholders, the project's existing error shape. No ORM, no new service-layer abstraction that nothing else uses.
- **Test command:** `npm test` from `backend/` (which is `node --test`). Database-backed tests read `TEST_DATABASE_URL || DATABASE_URL` and skip when neither is set.
- **Commit convention:** `type(scope): summary (SOMET-NNN)`, ending with the `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` trailer.

## Dependency inversion from the spec

The spec listed slice A (characters) before slice B (classes). **This plan inverts the two migrations.** A's backfill has to point every backfilled character at a class, so the class rows must already exist. Creating them first removes a re-point `UPDATE` that would otherwise exist only to work around ordering. The Plane tickets keep their letters; only the arrow flips — SOMET-258 now blocks SOMET-257.

## File Structure

**Created:**

| file | responsibility |
|---|---|
| `backend/migrations/1714440091000_playable_classes.js` | `entity_types.is_playable`; the three class rows; `class_loadouts` table + its rows |
| `backend/migrations/1714440092000_characters.js` | `characters` table; re-key of the five state tables; backfill |
| `backend/src/services/characters.js` | character queries: list, create, delete, ownership check |
| `backend/tests/playable_classes_db.test.js` | class rows and loadouts, against a real database |
| `backend/tests/characters_migration.test.js` | no-DB structural test of the migration's ordering and `down` |
| `backend/tests/characters_schema_db.test.js` | slot cap, name uniqueness, cascade, backfill |
| `backend/tests/characters_service_db.test.js` | create/delete/ownership through the service |
| `backend/tests/characters_routes.test.js` | the four HTTP routes via supertest |
| `backend/tests/spawn_portal_fallback.test.js` | `chooseSpawn` portal fallback, pure, no database |

**Modified:**

| file | change |
|---|---|
| `backend/seeds/data/entityTypes.js` | add the three playable classes so `make seed-catalogs` can rebuild them |
| `backend/src/services/mapService.js:852-867` | `chooseSpawn` gains the portal-fallback step |
| `backend/src/authority/items.js:76,113-132` | `grantStartingLoadout` becomes per-character and class-driven |
| `backend/src/authority/server.js` | `join` takes `character_id`; `loadSpawn`, `persist`, `upsertBind` and the inventory/progression loads become per-character |
| `backend/src/index.js` | mount the characters router |

---

## Task 1: Playable classes migration

**Files:**
- Create: `backend/migrations/1714440091000_playable_classes.js`
- Test: `backend/tests/playable_classes_db.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `entity_types.is_playable boolean NOT NULL DEFAULT false`; entity_types rows named exactly `'Warrior'`, `'Ranger'`, `'Mage'`; table `class_loadouts(id, entity_type_id, item_type_id, quantity)`.

### Background you need

The existing `Player` entity type is seeded by `backend/migrations/1714440006000_seed_player_entity.js` with exactly these values:

```
name 'Player', color '#3B82F6', walkable true, spawn_tiles '[]', chance 0,
strength 10, dexterity 10, constitution 10, intelligence 10, wisdom 10, charisma 10,
hp 100, max_hp 100, hp_regen_rate 1, mana 50, max_mana 50, mana_regen_rate 0.5
```

**Warrior must equal Player field for field.** Every character the next migration backfills points at Warrior, so any deviation silently rebalances every existing player. Ranger and Mage deviate from Warrior, and only in the fields listed below.

The item catalog contains no off-hand item at all — there is no shield. The loadouts below use item names that actually exist (verified against migrations `1714440016000`, `1714440017000`, `1714440019000`, `1714440021000`):

| class | items |
|---|---|
| Warrior | `short sword` ×1, `leather-vest` ×1 |
| Ranger | `bow` ×1, `arrow` ×20, `leather-vest` ×1 |
| Mage | `apprentice staff` ×1, `arcane-ward` ×1 |

`player_items` has a `quantity` column, so `arrow` ×20 is one row with `quantity = 20`, not twenty rows.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/playable_classes_db.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// Every expected value below is written out literally rather than imported
// from seeds/data/entityTypes.js. A test that reads the same file the seeder
// reads passes against a seeder that writes nothing at all.
test('playable classes', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  const STAT_COLUMNS = [
    'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma',
    'hp', 'max_hp', 'hp_regen_rate', 'mana', 'max_mana', 'mana_regen_rate',
  ];

  await t.test('Warrior is an exact stat clone of Player', async () => {
    const r = await pool.query(
      `SELECT name, ${STAT_COLUMNS.join(', ')} FROM entity_types
        WHERE name IN ('Player', 'Warrior')`);
    const by = new Map(r.rows.map((x) => [x.name, x]));
    assert.ok(by.get('Player'), 'the Player entity type must still exist');
    assert.ok(by.get('Warrior'), 'Warrior must exist');
    for (const col of STAT_COLUMNS) {
      assert.equal(
        Number(by.get('Warrior')[col]), Number(by.get('Player')[col]),
        `Warrior.${col} must equal Player.${col} — a drift here rebalances every backfilled character`);
    }
  });

  await t.test('Ranger and Mage carry their own literal stats', async () => {
    const r = await pool.query(
      `SELECT name, hp, max_hp, dexterity, intelligence, mana, max_mana
         FROM entity_types WHERE name IN ('Ranger', 'Mage')`);
    const by = new Map(r.rows.map((x) => [x.name, x]));
    assert.deepEqual(
      { hp: Number(by.get('Ranger').hp), dex: Number(by.get('Ranger').dexterity) },
      { hp: 85, dex: 12 });
    assert.deepEqual(
      { hp: Number(by.get('Mage').hp), int: Number(by.get('Mage').intelligence), mana: Number(by.get('Mage').max_mana) },
      { hp: 75, int: 12, mana: 70 });
  });

  await t.test('exactly the three classes are playable', async () => {
    const r = await pool.query(
      'SELECT name FROM entity_types WHERE is_playable = true ORDER BY name');
    assert.deepEqual(r.rows.map((x) => x.name), ['Mage', 'Ranger', 'Warrior']);
  });

  await t.test('the legacy Player row is not playable', async () => {
    const r = await pool.query(
      "SELECT is_playable FROM entity_types WHERE name = 'Player'");
    assert.equal(r.rows[0].is_playable, false);
  });

  await t.test('each class has its loadout, resolved to real item types', async () => {
    const r = await pool.query(
      `SELECT e.name AS class, i.name AS item, l.quantity
         FROM class_loadouts l
         JOIN entity_types e ON e.id = l.entity_type_id
         JOIN item_types  i ON i.id = l.item_type_id
        ORDER BY e.name, i.name`);
    const got = r.rows.map((x) => `${x.class}:${x.item}x${x.quantity}`);
    assert.deepEqual(got, [
      'Mage:apprentice staffx1',
      'Mage:arcane-wardx1',
      'Ranger:arrowx20',
      'Ranger:bowx1',
      'Ranger:leather-vestx1',
      'Warrior:leather-vestx1',
      'Warrior:short swordx1',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/playable_classes_db.test.js`
Expected: FAIL — `column "is_playable" does not exist`. (If it reports `no database URL` the test skipped; export `DATABASE_URL` first, otherwise this task cannot be verified.)

- [ ] **Step 3: Write the migration**

Create `backend/migrations/1714440091000_playable_classes.js`:

```js
exports.shorthands = undefined;

// The three playable classes, plus the per-class starting loadout that
// replaces items.js's hardcoded STARTING_LOADOUT.
//
// WARRIOR IS AN EXACT STAT CLONE OF 'Player' (1714440006000). This is not a
// stylistic choice: the next migration backfills every existing player's state
// onto a Warrior character, so any deviation here silently rebalances every
// account that exists today. Warrior is therefore defined as a SELECT from the
// Player row rather than a literal copy of its numbers -- a literal copy is a
// second source of truth that can drift from the row it is supposed to match.
// Ranger and Mage deviate, and they deviate from Warrior.
//
// The legacy 'Player' row stays (other code references it) but is marked
// not-playable so it cannot be chosen at character creation.

// name -> the deltas applied on top of the Player clone. Anything absent is
// inherited unchanged.
const CLASS_DELTAS = [
  { name: 'Warrior', color: '#b03a2e', set: {} },
  { name: 'Ranger',  color: '#1e8449', set: { hp: 85, max_hp: 85, dexterity: 12 } },
  { name: 'Mage',    color: '#5b2c94', set: { hp: 75, max_hp: 75, intelligence: 12, mana: 70, max_mana: 70 } },
];

// class name -> [[item_types.name, quantity], ...]. Every item name here is
// verified to exist in the catalog: there is no shield in item_types (no
// off_hand item exists at all), so the Warrior carries a one-handed sword and
// armour rather than the sword+shield a fantasy default would suggest.
const CLASS_LOADOUTS = {
  Warrior: [['short sword', 1], ['leather-vest', 1]],
  Ranger:  [['bow', 1], ['arrow', 20], ['leather-vest', 1]],
  Mage:    [['apprentice staff', 1], ['arcane-ward', 1]],
};

exports.up = (pgm) => {
  pgm.addColumns('entity_types', {
    is_playable: { type: 'boolean', notNull: true, default: false },
  });

  for (const cls of CLASS_DELTAS) {
    const overrides = Object.entries(cls.set)
      .map(([col, val]) => `${val} AS ${col}`)
      .join(', ');
    // SELECT-from-Player, with the class's own overrides replacing the
    // inherited column where one is given. DISTINCT ON is unnecessary --
    // entity_types.name is unique.
    pgm.sql(`
      INSERT INTO entity_types (
        name, color, walkable, spawn_tiles, chance, is_playable,
        strength, dexterity, constitution, intelligence, wisdom, charisma,
        hp, max_hp, hp_regen_rate, mana, max_mana, mana_regen_rate
      )
      SELECT
        '${cls.name}', '${cls.color}', p.walkable, p.spawn_tiles, 0, true,
        ${col('strength', cls.set)}, ${col('dexterity', cls.set)}, ${col('constitution', cls.set)},
        ${col('intelligence', cls.set)}, ${col('wisdom', cls.set)}, ${col('charisma', cls.set)},
        ${col('hp', cls.set)}, ${col('max_hp', cls.set)}, ${col('hp_regen_rate', cls.set)},
        ${col('mana', cls.set)}, ${col('max_mana', cls.set)}, ${col('mana_regen_rate', cls.set)}
      FROM entity_types p WHERE p.name = 'Player'
      ON CONFLICT (name) DO NOTHING
    `);
    void overrides;
  }

  // Belt and braces: if this migration ever runs against a database whose
  // 'Player' row is missing, the SELECTs above insert nothing and the next
  // migration's backfill would fail on a missing Warrior. Fail here, loudly,
  // rather than three files later.
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM entity_types WHERE name = 'Warrior') THEN
        RAISE EXCEPTION 'Warrior was not created: the Player entity type is missing';
      END IF;
    END $$;
  `);

  pgm.createTable('class_loadouts', {
    id: 'id',
    entity_type_id: { type: 'integer', notNull: true, references: 'entity_types', onDelete: 'CASCADE' },
    item_type_id: { type: 'integer', notNull: true, references: 'item_types', onDelete: 'CASCADE' },
    quantity: { type: 'integer', notNull: true, default: 1 },
  });
  pgm.addConstraint('class_loadouts', 'class_loadouts_quantity_check', 'CHECK (quantity >= 1)');
  // One row per (class, item): a duplicate would silently double a grant.
  pgm.addConstraint('class_loadouts', 'class_loadouts_unique', { unique: ['entity_type_id', 'item_type_id'] });

  for (const [className, rows] of Object.entries(CLASS_LOADOUTS)) {
    for (const [itemName, qty] of rows) {
      // Guarded by the join: a catalog missing this item inserts nothing
      // rather than failing the whole migration on a NULL fk.
      pgm.sql(`
        INSERT INTO class_loadouts (entity_type_id, item_type_id, quantity)
        SELECT e.id, i.id, ${qty}
          FROM entity_types e, item_types i
         WHERE e.name = '${className}' AND i.name = '${itemName.replace(/'/g, "''")}'
        ON CONFLICT (entity_type_id, item_type_id) DO NOTHING
      `);
    }
  }
};

// Column expression for the SELECT-from-Player above: the class's override if
// it has one, otherwise the inherited value from the Player row.
function col(name, set) {
  return Object.prototype.hasOwnProperty.call(set, name) ? String(set[name]) : `p.${name}`;
}

exports.down = (pgm) => {
  pgm.dropTable('class_loadouts');
  pgm.sql("DELETE FROM entity_types WHERE name IN ('Warrior', 'Ranger', 'Mage')");
  pgm.dropColumns('entity_types', ['is_playable']);
};

exports.CLASS_DELTAS = CLASS_DELTAS;
exports.CLASS_LOADOUTS = CLASS_LOADOUTS;
```

Delete the stray `const overrides` / `void overrides` lines while writing — they are shown only to make the shape of the loop obvious; the real loop body is the `pgm.sql(...)` call and nothing else.

- [ ] **Step 4: Run the migration and the test**

```bash
cd backend && npm run migrate:up && node --test tests/playable_classes_db.test.js
```
Expected: migration applies; all five sub-tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/1714440091000_playable_classes.js backend/tests/playable_classes_db.test.js
git commit -m "feat(characters): playable class catalog and per-class loadouts (SOMET-258)"
```

---

## Task 2: Class rows in the checked-in seed data

**Files:**
- Modify: `backend/seeds/data/entityTypes.js`
- Test: `backend/tests/playable_classes_db.test.js` (extend)

**Interfaces:**
- Consumes: the three class names from Task 1.
- Produces: `make seed-catalogs` can rebuild the class rows on a database whose volume was wiped.

### Why this task exists

`backend/seeds/data/entityTypes.js` opens with a long header explaining the Wolf incident: an entity type that existed only in the live database, referenced by three migrations, vanished when the Postgres volume was rebuilt and took a biome reference with it. A class that only a migration can create is the same hole — `make seed-catalogs` on a fresh volume would produce a database where `characters.entity_type_id` has nothing to point at.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/playable_classes_db.test.js`, inside the existing `test(...)` block:

```js
  await t.test('seed-catalogs can rebuild the classes after a wipe', async () => {
    // Not a re-read of the seed file: this asserts the SHAPE the seeder must
    // produce, with literal values, so a seeder that writes nothing fails.
    const { execFileSync } = require('node:child_process');
    execFileSync('node', ['scripts/seed-catalogs.js'], { cwd: process.cwd(), stdio: 'pipe' });
    const r = await pool.query(
      `SELECT name, is_playable, hp FROM entity_types
        WHERE name IN ('Warrior','Ranger','Mage') ORDER BY name`);
    assert.deepEqual(r.rows.map((x) => [x.name, x.is_playable, Number(x.hp)]), [
      ['Mage', true, 75],
      ['Ranger', true, 85],
      ['Warrior', true, 100],
    ]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/playable_classes_db.test.js`
Expected: the new sub-test FAILS — the seeder does not know about the classes, so re-running it leaves `is_playable` false or the rows absent depending on how it upserts.

- [ ] **Step 3: Add the classes to the seed data**

Read `backend/seeds/data/entityTypes.js` first and follow the shape of the existing `HOSTILE_CREATURES` entries exactly — same key names, same ordering, same comment density. Add a second exported array beside it:

```js
// The playable classes (SOMET-258). Here as well as in migration
// 1714440091000 for the reason this whole file exists: an entity type the repo
// cannot rebuild disappears when the Postgres volume is rebuilt, and
// characters.entity_type_id has a foreign key pointing at these rows.
//
// Warrior's numbers are the 'Player' row's numbers (1714440006000). The
// migration derives them with a SELECT; this file has to state them, so if you
// change Player you must change Warrior here too -- playable_classes_db.test.js
// asserts the two are equal and will fail if they drift.
const PLAYABLE_CLASSES = [
  {
    name: 'Warrior', color: '#b03a2e', walkable: true, spawn_tiles: [], chance: 0,
    is_playable: true,
    strength: 10, dexterity: 10, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10,
    hp: 100, max_hp: 100, hp_regen_rate: 1, mana: 50, max_mana: 50, mana_regen_rate: 0.5,
  },
  {
    name: 'Ranger', color: '#1e8449', walkable: true, spawn_tiles: [], chance: 0,
    is_playable: true,
    strength: 10, dexterity: 12, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10,
    hp: 85, max_hp: 85, hp_regen_rate: 1, mana: 50, max_mana: 50, mana_regen_rate: 0.5,
  },
  {
    name: 'Mage', color: '#5b2c94', walkable: true, spawn_tiles: [], chance: 0,
    is_playable: true,
    strength: 10, dexterity: 10, constitution: 10, intelligence: 12, wisdom: 10, charisma: 10,
    hp: 75, max_hp: 75, hp_regen_rate: 1, mana: 70, max_mana: 70, mana_regen_rate: 0.5,
  },
];
```

Export it alongside the existing export, and update `backend/scripts/seed-catalogs.js` to upsert it. Read that script first: match how it upserts `entityTypes` today (it is an idempotent `ON CONFLICT (name) DO UPDATE`), and include `is_playable` in both the insert column list and the update set — omitting it from the update set is the failure this test catches.

- [ ] **Step 4: Run the test**

Run: `cd backend && node --test tests/playable_classes_db.test.js`
Expected: all sub-tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/seeds/data/entityTypes.js backend/scripts/seed-catalogs.js backend/tests/playable_classes_db.test.js
git commit -m "feat(characters): checked-in seed data for the playable classes (SOMET-258)"
```

---

## Task 3: The characters table, re-key and backfill

**Files:**
- Create: `backend/migrations/1714440092000_characters.js`
- Test: `backend/tests/characters_migration.test.js`

**Interfaces:**
- Consumes: `entity_types` row named `'Warrior'` (Task 1).
- Produces: table `characters(id, user_id, slot, name, entity_type_id, starting_loadout_granted_at, created_at)`; a `character_id integer NOT NULL REFERENCES characters ON DELETE CASCADE` column on `world_players`, `player_binds`, `player_progression`, `player_items`, `player_equipment`, with `user_id` dropped from all five.

### Ordering that matters

The backfill must run in this order, and the test in this task asserts the order rather than the outcome (it is a no-DB test):

1. create `characters`
2. add a **nullable** `character_id` to each of the five tables
3. insert one character per user holding any player state
4. `UPDATE` each table's `character_id` from the user → character map
5. drop the old primary keys / unique constraints, `SET NOT NULL`, add the new keys, drop `user_id`

Doing step 5 before step 4 fails on the not-null constraint. Doing step 3 before step 2 is harmless but makes the diff harder to read; the assertion below pins the order that is actually load-bearing.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/characters_migration.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

// No-DB structural test, same fakePgm idiom as migration_biomes_down.test.js.
// What it guards is ORDER: the backfill UPDATE has to run while user_id still
// exists and before character_id is made NOT NULL. Getting that wrong produces
// a migration that works on an empty database and destroys a populated one --
// exactly the case a DB test on a dev box with no players would not catch.
function fakePgm() {
  const order = [];
  const rec = (op) => (...args) => order.push({ op, args });
  return {
    order,
    sql: (s) => order.push({ op: 'sql', s }),
    createTable: rec('createTable'),
    dropTable: rec('dropTable'),
    addColumns: rec('addColumns'),
    dropColumns: rec('dropColumns'),
    addConstraint: rec('addConstraint'),
    dropConstraint: rec('dropConstraint'),
    createIndex: rec('createIndex'),
    dropIndex: rec('dropIndex'),
    func: (s) => ({ __func: s }),
  };
}

const mig = require('../migrations/1714440092000_characters.js');
const TABLES = ['world_players', 'player_binds', 'player_progression', 'player_items', 'player_equipment'];

test('up creates characters before it references them', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const createIdx = pgm.order.findIndex((c) => c.op === 'createTable' && c.args[0] === 'characters');
  assert.ok(createIdx !== -1, 'must create the characters table');
  const firstAddIdx = pgm.order.findIndex((c) => c.op === 'addColumns' && TABLES.includes(c.args[0]));
  assert.ok(createIdx < firstAddIdx, 'characters must exist before any table gains character_id');
});

test('the backfill UPDATE runs before user_id is dropped, for every table', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  for (const table of TABLES) {
    const updateIdx = pgm.order.findIndex(
      (c) => c.op === 'sql' && new RegExp(`UPDATE\\s+${table}\\b`, 'i').test(c.s) && /character_id/i.test(c.s));
    const dropIdx = pgm.order.findIndex(
      (c) => c.op === 'dropColumns' && c.args[0] === table);
    assert.ok(updateIdx !== -1, `${table} must be backfilled`);
    assert.ok(dropIdx !== -1, `${table} must drop user_id`);
    assert.ok(updateIdx < dropIdx, `${table}: the backfill reads user_id, so it must run before the drop`);
  }
});

test('character_id is only made NOT NULL after the backfill', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  for (const table of TABLES) {
    const updateIdx = pgm.order.findIndex(
      (c) => c.op === 'sql' && new RegExp(`UPDATE\\s+${table}\\b`, 'i').test(c.s) && /character_id/i.test(c.s));
    const notNullIdx = pgm.order.findIndex(
      (c) => c.op === 'sql' && new RegExp(`ALTER TABLE ${table}[\\s\\S]*SET NOT NULL`, 'i').test(c.s));
    assert.ok(notNullIdx !== -1, `${table}: character_id must end up NOT NULL`);
    assert.ok(updateIdx < notNullIdx, `${table}: NOT NULL before the backfill would reject every existing row`);
  }
});

test('the backfill inserts characters pointing at Warrior', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const insert = pgm.order.find((c) => c.op === 'sql' && /INSERT INTO characters/i.test(c.s));
  assert.ok(insert, 'must insert backfilled characters');
  assert.match(insert.s, /'Warrior'/, 'backfilled characters must be Warriors, not the legacy Player type');
  assert.match(insert.s, /slot/i);
});

test('the slot cap is a database constraint, not a comment', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const check = pgm.order.find(
    (c) => c.op === 'addConstraint' && c.args[0] === 'characters' && /slot/i.test(JSON.stringify(c.args)));
  assert.ok(check, 'characters must carry a slot CHECK constraint');
  assert.match(JSON.stringify(check.args), /BETWEEN 1 AND 8/i);
  const unique = pgm.order.find(
    (c) => c.op === 'addConstraint' && c.args[0] === 'characters'
        && JSON.stringify(c.args).includes('user_id') && JSON.stringify(c.args).includes('slot'));
  assert.ok(unique, 'characters must carry a UNIQUE(user_id, slot) — the CHECK alone does not cap the count');
});

test('down re-keys the lowest slot back before dropping characters', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  const dropIdx = pgm.order.findIndex((c) => c.op === 'dropTable' && c.args[0] === 'characters');
  assert.ok(dropIdx !== -1, 'down must drop the characters table');
  for (const table of TABLES) {
    const restoreIdx = pgm.order.findIndex(
      (c) => c.op === 'sql' && new RegExp(`UPDATE\\s+${table}\\b`, 'i').test(c.s) && /user_id/i.test(c.s));
    assert.ok(restoreIdx !== -1, `${table} must be re-keyed back to user_id`);
    assert.ok(restoreIdx < dropIdx, `${table}: the restore reads characters, so it must run before the drop`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/characters_migration.test.js`
Expected: FAIL — `Cannot find module '../migrations/1714440092000_characters.js'`.

- [ ] **Step 3: Write the migration**

Create `backend/migrations/1714440092000_characters.js`:

```js
exports.shorthands = undefined;

// Characters (SOMET-257). Until now one account was one player: position,
// respawn bind, progression, inventory and equipment all hung off users.id, so
// an account had exactly one playthrough. This migration introduces the
// characters table and re-keys all five of those tables onto it.
//
// THE 8-SLOT CAP IS A SCHEMA INVARIANT, NOT AN APPLICATION COUNT. A COUNT(*)
// check is racy -- two concurrent creates on the last slot both read 7 and both
// insert. `slot smallint CHECK (slot BETWEEN 1 AND 8)` plus
// UNIQUE(user_id, slot) makes a ninth character unrepresentable, so the loser
// of a race gets a constraint violation the API turns into a 409.
//
// characters.name is GLOBALLY unique, not per-account: other players see it
// in-world, so two characters called "Gorm" would be ambiguous. citext matches
// how users.username is declared (1714440025000).
//
// THE BACKFILL IS NON-DESTRUCTIVE. 1714440025000 truncated three of these
// tables because they held anonymous test detritus; this data is real player
// state and must survive. Characters are inserted, rows are repointed, and only
// then is user_id dropped.

const STATE_TABLES = [
  { table: 'world_players',      pk: ['world_id', 'user_id'], newPk: ['world_id', 'character_id'] },
  { table: 'player_binds',       pk: ['user_id'],             newPk: ['character_id'] },
  { table: 'player_progression', pk: ['user_id'],             newPk: ['character_id'] },
  { table: 'player_equipment',   pk: ['user_id', 'slot'],     newPk: ['character_id', 'slot'] },
  { table: 'player_items',       pk: null,                    newPk: null }, // id stays the PK
];

exports.up = (pgm) => {
  pgm.createExtension('citext', { ifNotExists: true });

  pgm.createTable('characters', {
    id: 'id',
    user_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    slot: { type: 'smallint', notNull: true },
    name: { type: 'citext', notNull: true },
    entity_type_id: { type: 'integer', notNull: true, references: 'entity_types' },
    starting_loadout_granted_at: { type: 'timestamptz', notNull: false, default: null },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('characters', 'characters_slot_check', 'CHECK (slot BETWEEN 1 AND 8)');
  pgm.addConstraint('characters', 'characters_user_slot_unique', { unique: ['user_id', 'slot'] });
  pgm.addConstraint('characters', 'characters_name_unique', { unique: ['name'] });
  pgm.createIndex('characters', 'user_id');

  // 1. Nullable column on every state table.
  for (const { table } of STATE_TABLES) {
    pgm.addColumns(table, {
      character_id: { type: 'integer', notNull: false, default: null },
    });
  }

  // 2. One slot-1 Warrior per user that holds ANY player state. Name collision
  //    is impossible by construction: characters.name and users.username are
  //    both globally unique citext, and every backfilled name IS a username.
  //    A user with no state gets no character and will create one on first login.
  pgm.sql(`
    INSERT INTO characters (user_id, slot, name, entity_type_id, starting_loadout_granted_at)
    SELECT u.id, 1, u.username,
           (SELECT id FROM entity_types WHERE name = 'Warrior'),
           u.starting_loadout_granted_at
      FROM users u
     WHERE EXISTS (SELECT 1 FROM world_players      WHERE user_id = u.id)
        OR EXISTS (SELECT 1 FROM player_binds       WHERE user_id = u.id)
        OR EXISTS (SELECT 1 FROM player_progression WHERE user_id = u.id)
        OR EXISTS (SELECT 1 FROM player_items       WHERE user_id = u.id)
        OR EXISTS (SELECT 1 FROM player_equipment   WHERE user_id = u.id)
  `);

  // 3. Repoint. Still reading user_id, which still exists.
  for (const { table } of STATE_TABLES) {
    pgm.sql(`
      UPDATE ${table} t SET character_id = c.id
        FROM characters c
       WHERE c.user_id = t.user_id AND c.slot = 1
    `);
  }

  // 4. Swap the keys, then drop user_id. Any row whose user_id no longer
  //    resolves to a character is orphaned state for a deleted account; delete
  //    it rather than failing the migration on the NOT NULL.
  for (const { table, pk, newPk } of STATE_TABLES) {
    pgm.sql(`DELETE FROM ${table} WHERE character_id IS NULL`);
    pgm.sql(`ALTER TABLE ${table} ALTER COLUMN character_id SET NOT NULL`);
    pgm.addConstraint(table, `${table}_character_fk`, {
      foreignKeys: { columns: 'character_id', references: 'characters(id)', onDelete: 'CASCADE' },
    });
    if (pk) {
      pgm.dropConstraint(table, `${table}_pkey`);
      pgm.addConstraint(table, `${table}_pkey`, { primaryKey: newPk });
    }
    pgm.dropColumns(table, ['user_id']);
  }
  pgm.createIndex('player_items', 'character_id');

  // 5. starting_loadout_granted_at is now a fact about a character, not an
  //    account: the loadout is class-dependent, so a second character must get
  //    its own. The column was carried onto every backfilled character above.
  pgm.dropColumns('users', ['starting_loadout_granted_at']);
};

exports.down = (pgm) => {
  // LOSSY BY DESIGN, FOR ACCOUNTS WITH MORE THAN ONE CHARACTER. There is only
  // one user_id to restore to, so the lowest-slot character's state is kept and
  // slots 2-8 are dropped along with the table. This is acceptable only because
  // `down` exists to unwind a bad deploy on a database that has not yet grown
  // multi-character accounts; it is NOT a general-purpose rollback.
  pgm.addColumns('users', {
    starting_loadout_granted_at: { type: 'timestamptz', notNull: false, default: null },
  });
  pgm.sql(`
    UPDATE users u SET starting_loadout_granted_at = c.starting_loadout_granted_at
      FROM characters c
     WHERE c.user_id = u.id AND c.slot = (SELECT MIN(slot) FROM characters WHERE user_id = u.id)
  `);

  for (const { table, pk, newPk } of [...STATE_TABLES].reverse()) {
    pgm.addColumns(table, { user_id: { type: 'integer', notNull: false, default: null } });
    pgm.sql(`
      UPDATE ${table} t SET user_id = c.user_id
        FROM characters c
       WHERE c.id = t.character_id
         AND c.slot = (SELECT MIN(slot) FROM characters WHERE user_id = c.user_id)
    `);
    pgm.sql(`DELETE FROM ${table} WHERE user_id IS NULL`);
    pgm.sql(`ALTER TABLE ${table} ALTER COLUMN user_id SET NOT NULL`);
    pgm.addConstraint(table, `${table}_user_fk`, {
      foreignKeys: { columns: 'user_id', references: 'users(id)', onDelete: 'CASCADE' },
    });
    if (pk) {
      pgm.dropConstraint(table, `${table}_pkey`);
      pgm.addConstraint(table, `${table}_pkey`, { primaryKey: pk });
    }
    pgm.dropConstraint(table, `${table}_character_fk`);
    pgm.dropColumns(table, ['character_id']);
    void newPk;
  }

  pgm.dropTable('characters');
};

exports.STATE_TABLES = STATE_TABLES;
```

Remove the `void newPk;` line when writing — `newPk` is unused in `down` and should simply not be destructured there.

- [ ] **Step 4: Run the structural test**

Run: `cd backend && node --test tests/characters_migration.test.js`
Expected: all six tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/1714440092000_characters.js backend/tests/characters_migration.test.js
git commit -m "feat(characters): characters table, re-key of player state, backfill (SOMET-257)"
```

---

## Task 4: Verify the migration against a real database

**Files:**
- Create: `backend/tests/characters_schema_db.test.js`

**Interfaces:**
- Consumes: the schema from Task 3.
- Produces: nothing new; this task is the evidence that Task 3 is correct.

### Before you start

Run the migration against your dev database and **confirm existing player state survived** before writing anything:

```bash
cd backend && npm run migrate:up
psql "$DATABASE_URL" -c "SELECT c.name, c.slot, wp.x, wp.y FROM characters c LEFT JOIN world_players wp ON wp.character_id = c.id;"
```

Every account that had a `world_players` row before must still have one, reachable through a character named after the username. If that query comes back empty on a database that had players, stop and fix the migration — do not proceed.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/characters_schema_db.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// Every fixture below is zz-prefixed and removed by name in a finally block.
// Nothing in this file touches a real account, a real character, or a catalog
// row -- a reviewer once wiped entity_types with an unscoped DELETE while
// "testing" a seeder.
test('characters schema', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  const warrior = (await pool.query("SELECT id FROM entity_types WHERE name = 'Warrior'")).rows[0].id;

  async function withUser(username, fn) {
    await pool.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') ON CONFLICT (username) DO NOTHING",
      [username]);
    const id = (await pool.query('SELECT id FROM users WHERE username = $1', [username])).rows[0].id;
    try { return await fn(id); }
    finally { await pool.query('DELETE FROM users WHERE username = $1', [username]); }
  }

  await t.test('a ninth character is refused by the database', async () => {
    await withUser('zzSlotCap', async (userId) => {
      for (let slot = 1; slot <= 8; slot += 1) {
        await pool.query(
          'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, $2, $3, $4)',
          [userId, slot, `zzSlotCap${slot}`, warrior]);
      }
      await assert.rejects(
        () => pool.query(
          'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 9, $2, $3)',
          [userId, 'zzSlotCap9', warrior]),
        /characters_slot_check/);
      // And re-using an occupied slot is refused too -- the CHECK alone would
      // let an application bug write slot 1 nine times.
      await assert.rejects(
        () => pool.query(
          'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 1, $2, $3)',
          [userId, 'zzSlotCapDupe', warrior]),
        /characters_user_slot_unique/);
      const n = await pool.query('SELECT count(*)::int AS n FROM characters WHERE user_id = $1', [userId]);
      assert.equal(n.rows[0].n, 8);
    });
  });

  await t.test('character names are globally unique and case-insensitive', async () => {
    await withUser('zzNameA', async (a) => {
      await withUser('zzNameB', async (b) => {
        await pool.query(
          'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 1, $2, $3)',
          [a, 'zzGorm', warrior]);
        await assert.rejects(
          () => pool.query(
            'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 1, $2, $3)',
            [b, 'ZZGORM', warrior]),
          /characters_name_unique/);
      });
    });
  });

  await t.test('deleting a character cascades all five state tables', async () => {
    await withUser('zzCascade', async (userId) => {
      const charId = (await pool.query(
        'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 1, $2, $3) RETURNING id',
        [userId, 'zzCascadeChar', warrior])).rows[0].id;
      const worldId = (await pool.query('SELECT id FROM worlds LIMIT 1')).rows[0].id;
      await pool.query(
        'INSERT INTO world_players (world_id, character_id, x, y) VALUES ($1, $2, 10, 20)',
        [worldId, charId]);
      await pool.query(
        'INSERT INTO player_progression (character_id) VALUES ($1)', [charId]);

      await pool.query('DELETE FROM characters WHERE id = $1', [charId]);

      for (const table of ['world_players', 'player_progression']) {
        const r = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE character_id = $1`, [charId]);
        assert.equal(r.rows[0].n, 0, `${table} should have cascaded away`);
      }
    });
  });

  await t.test('deleting the slot frees it for reuse', async () => {
    await withUser('zzReuse', async (userId) => {
      const first = (await pool.query(
        'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 3, $2, $3) RETURNING id',
        [userId, 'zzReuseA', warrior])).rows[0].id;
      await pool.query('DELETE FROM characters WHERE id = $1', [first]);
      await pool.query(
        'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 3, $2, $3)',
        [userId, 'zzReuseB', warrior]);
      const r = await pool.query('SELECT slot FROM characters WHERE user_id = $1', [userId]);
      assert.deepEqual(r.rows.map((x) => x.slot), [3]);
    });
  });

  await t.test('users no longer carries starting_loadout_granted_at', async () => {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'starting_loadout_granted_at'`);
    assert.equal(r.rows.length, 0, 'the column moved to characters');
  });

  await t.test('no state table still carries user_id', async () => {
    const r = await pool.query(
      `SELECT table_name FROM information_schema.columns
        WHERE column_name = 'user_id'
          AND table_name IN ('world_players','player_binds','player_progression','player_items','player_equipment')
        ORDER BY table_name`);
    assert.deepEqual(r.rows.map((x) => x.table_name), []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes for the right reason**

Run: `cd backend && node --test tests/characters_schema_db.test.js`
Expected: PASS if Task 3's migration is correct. **A failure here is a real defect in Task 3, not a test to relax** — fix the migration (as a new migration if `1714440092000` is already committed and applied elsewhere; on this branch it is not, so amend it).

- [ ] **Step 3: Commit**

```bash
git add backend/tests/characters_schema_db.test.js
git commit -m "test(characters): database-level guards for the slot cap, uniqueness and cascade (SOMET-257)"
```

---

## Task 5: The characters service

**Files:**
- Create: `backend/src/services/characters.js`
- Test: `backend/tests/characters_service_db.test.js`

**Interfaces:**
- Consumes: the schema from Task 3.
- Produces:
  - `listCharacters(pool, userId) -> Promise<Array<{id, slot, name, className, entityTypeId, level, lastWorldName}>>`
  - `listPlayableClasses(pool) -> Promise<Array<{id, name, color, hp, strength, dexterity, constitution, intelligence, wisdom, charisma}>>`
  - `createCharacter(pool, userId, name, entityTypeId) -> Promise<{id, slot, name}>` — throws `CharacterError` with `.code` one of `'name_taken' | 'no_free_slot' | 'not_playable' | 'bad_name'`
  - `deleteCharacter(pool, userId, characterId) -> Promise<boolean>` — false when the character does not exist or is not owned
  - `ownedCharacter(pool, userId, characterId) -> Promise<{id, entityTypeId} | null>`
  - `class CharacterError extends Error` with a `code` property
  - `MAX_CHARACTERS = 8`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/characters_service_db.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const {
  listCharacters, listPlayableClasses, createCharacter, deleteCharacter, ownedCharacter,
  CharacterError, MAX_CHARACTERS,
} = require('../src/services/characters');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('characters service', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  const classes = await listPlayableClasses(pool);
  const warrior = classes.find((c) => c.name === 'Warrior');
  const mage = classes.find((c) => c.name === 'Mage');
  const playerType = (await pool.query("SELECT id FROM entity_types WHERE name = 'Player'")).rows[0].id;

  async function withUser(username, fn) {
    await pool.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') ON CONFLICT (username) DO NOTHING",
      [username]);
    const id = (await pool.query('SELECT id FROM users WHERE username = $1', [username])).rows[0].id;
    try { return await fn(id); }
    finally { await pool.query('DELETE FROM users WHERE username = $1', [username]); }
  }

  await t.test('exposes exactly the three playable classes', () => {
    assert.deepEqual(classes.map((c) => c.name).sort(), ['Mage', 'Ranger', 'Warrior']);
  });

  await t.test('creates into the lowest free slot', async () => {
    await withUser('zzSvcSlots', async (userId) => {
      const a = await createCharacter(pool, userId, 'zzSvcA', warrior.id);
      const b = await createCharacter(pool, userId, 'zzSvcB', mage.id);
      assert.deepEqual([a.slot, b.slot], [1, 2]);
      await deleteCharacter(pool, userId, a.id);
      const c = await createCharacter(pool, userId, 'zzSvcC', warrior.id);
      assert.equal(c.slot, 1, 'the freed slot is reused before slot 3');
    });
  });

  await t.test('refuses a ninth character', async () => {
    await withUser('zzSvcCap', async (userId) => {
      for (let i = 1; i <= MAX_CHARACTERS; i += 1) {
        await createCharacter(pool, userId, `zzSvcCap${i}`, warrior.id);
      }
      await assert.rejects(
        () => createCharacter(pool, userId, 'zzSvcCap9', warrior.id),
        (err) => err instanceof CharacterError && err.code === 'no_free_slot');
      const list = await listCharacters(pool, userId);
      assert.equal(list.length, 8);
    });
  });

  await t.test('refuses a duplicate name across accounts', async () => {
    await withUser('zzSvcNameA', async (a) => {
      await withUser('zzSvcNameB', async (b) => {
        await createCharacter(pool, a, 'zzSvcShared', warrior.id);
        await assert.rejects(
          () => createCharacter(pool, b, 'ZZSVCSHARED', warrior.id),
          (err) => err instanceof CharacterError && err.code === 'name_taken');
      });
    });
  });

  await t.test('refuses a non-playable entity type', async () => {
    await withUser('zzSvcClass', async (userId) => {
      await assert.rejects(
        () => createCharacter(pool, userId, 'zzSvcBadClass', playerType),
        (err) => err instanceof CharacterError && err.code === 'not_playable');
    });
  });

  await t.test('refuses a blank or overlong name', async () => {
    await withUser('zzSvcName', async (userId) => {
      for (const bad of ['', '   ', 'z'.repeat(33)]) {
        await assert.rejects(
          () => createCharacter(pool, userId, bad, warrior.id),
          (err) => err instanceof CharacterError && err.code === 'bad_name');
      }
    });
  });

  await t.test('a character is not owned by another account', async () => {
    await withUser('zzSvcOwnA', async (a) => {
      await withUser('zzSvcOwnB', async (b) => {
        const mine = await createCharacter(pool, a, 'zzSvcOwned', warrior.id);
        assert.ok(await ownedCharacter(pool, a, mine.id));
        assert.equal(await ownedCharacter(pool, b, mine.id), null);
        assert.equal(await deleteCharacter(pool, b, mine.id), false);
        assert.ok(await ownedCharacter(pool, a, mine.id), 'the row must survive the foreign delete');
      });
    });
  });

  await t.test('the list carries level and class name', async () => {
    await withUser('zzSvcList', async (userId) => {
      const c = await createCharacter(pool, userId, 'zzSvcListed', mage.id);
      await pool.query(
        'INSERT INTO player_progression (character_id, level) VALUES ($1, 4)', [c.id]);
      const [row] = await listCharacters(pool, userId);
      assert.equal(row.name, 'zzSvcListed');
      assert.equal(row.className, 'Mage');
      assert.equal(row.level, 4);
    });
  });

  await t.test('a character with no progression row still lists at level 1', async () => {
    await withUser('zzSvcFresh', async (userId) => {
      await createCharacter(pool, userId, 'zzSvcFreshChar', warrior.id);
      const [row] = await listCharacters(pool, userId);
      assert.equal(row.level, 1);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/characters_service_db.test.js`
Expected: FAIL — `Cannot find module '../src/services/characters'`.

- [ ] **Step 3: Write the service**

Create `backend/src/services/characters.js`:

```js
// Character queries. Kept out of index.js's inline routes because the slot
// allocation below is the one piece here with real logic worth testing on its
// own, and because the authority (which has no Express request) needs
// ownedCharacter too.

const MAX_CHARACTERS = 8;
const MAX_NAME_LENGTH = 32;

class CharacterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CharacterError';
    this.code = code;
  }
}

async function listPlayableClasses(pool) {
  const r = await pool.query(
    `SELECT id, name, color, hp, strength, dexterity, constitution, intelligence, wisdom, charisma
       FROM entity_types WHERE is_playable = true ORDER BY id ASC`);
  return r.rows.map((x) => ({
    id: x.id, name: x.name, color: x.color,
    hp: Number(x.hp),
    strength: Number(x.strength), dexterity: Number(x.dexterity),
    constitution: Number(x.constitution), intelligence: Number(x.intelligence),
    wisdom: Number(x.wisdom), charisma: Number(x.charisma),
  }));
}

async function listCharacters(pool, userId) {
  // LEFT JOINs throughout: a freshly created character has no progression row
  // and has never been in a world, and must still list.
  const r = await pool.query(
    `SELECT c.id, c.slot, c.name, c.entity_type_id,
            e.name AS class_name,
            COALESCE(pr.level, 1) AS level,
            w.name AS last_world_name
       FROM characters c
       JOIN entity_types e ON e.id = c.entity_type_id
       LEFT JOIN player_progression pr ON pr.character_id = c.id
       LEFT JOIN LATERAL (
         SELECT world_id FROM world_players
          WHERE character_id = c.id ORDER BY updated_at DESC LIMIT 1
       ) lw ON true
       LEFT JOIN worlds w ON w.id = lw.world_id
      WHERE c.user_id = $1
      ORDER BY c.slot ASC`,
    [userId]);
  return r.rows.map((x) => ({
    id: x.id,
    slot: x.slot,
    name: x.name,
    className: x.class_name,
    entityTypeId: x.entity_type_id,
    level: Number(x.level),
    lastWorldName: x.last_world_name,
  }));
}

async function ownedCharacter(pool, userId, characterId) {
  const id = Number(characterId);
  if (!Number.isInteger(id)) return null;
  const r = await pool.query(
    'SELECT id, entity_type_id FROM characters WHERE id = $1 AND user_id = $2',
    [id, userId]);
  if (!r.rows.length) return null;
  return { id: r.rows[0].id, entityTypeId: r.rows[0].entity_type_id };
}

// Allocation and insert are ONE statement. A read-then-write ("SELECT the free
// slots, then INSERT into the lowest") leaves a window in which two concurrent
// creates both pick the same slot; here the loser hits
// characters_user_slot_unique and is translated to no_free_slot below.
async function createCharacter(pool, userId, name, entityTypeId) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) {
    throw new CharacterError('bad_name', `name must be 1-${MAX_NAME_LENGTH} characters`);
  }
  const typeId = Number(entityTypeId);
  if (!Number.isInteger(typeId)) throw new CharacterError('not_playable', 'unknown class');

  const cls = await pool.query(
    'SELECT id FROM entity_types WHERE id = $1 AND is_playable = true', [typeId]);
  if (!cls.rows.length) throw new CharacterError('not_playable', 'unknown class');

  try {
    const r = await pool.query(
      `INSERT INTO characters (user_id, slot, name, entity_type_id)
       SELECT $1, s.slot, $2, $3
         FROM generate_series(1, ${MAX_CHARACTERS}) AS s(slot)
        WHERE NOT EXISTS (SELECT 1 FROM characters WHERE user_id = $1 AND slot = s.slot)
        ORDER BY s.slot ASC
        LIMIT 1
       RETURNING id, slot, name`,
      [userId, trimmed, typeId]);
    if (!r.rows.length) throw new CharacterError('no_free_slot', 'all character slots are used');
    return { id: r.rows[0].id, slot: r.rows[0].slot, name: r.rows[0].name };
  } catch (err) {
    if (err instanceof CharacterError) throw err;
    if (err && err.constraint === 'characters_name_unique') {
      throw new CharacterError('name_taken', 'that name is taken');
    }
    if (err && err.constraint === 'characters_user_slot_unique') {
      // Lost a race for the last free slot.
      throw new CharacterError('no_free_slot', 'all character slots are used');
    }
    throw err;
  }
}

async function deleteCharacter(pool, userId, characterId) {
  const id = Number(characterId);
  if (!Number.isInteger(id)) return false;
  const r = await pool.query(
    'DELETE FROM characters WHERE id = $1 AND user_id = $2', [id, userId]);
  return r.rowCount > 0;
}

module.exports = {
  MAX_CHARACTERS, MAX_NAME_LENGTH, CharacterError,
  listCharacters, listPlayableClasses, createCharacter, deleteCharacter, ownedCharacter,
};
```

- [ ] **Step 4: Run the test**

Run: `cd backend && node --test tests/characters_service_db.test.js`
Expected: all nine sub-tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/characters.js backend/tests/characters_service_db.test.js
git commit -m "feat(characters): characters service with slot allocation and ownership (SOMET-259)"
```

---

## Task 6: The characters HTTP routes

**Files:**
- Modify: `backend/src/index.js`
- Test: `backend/tests/characters_routes.test.js`

**Interfaces:**
- Consumes: `backend/src/services/characters.js` (Task 5); `requireAuth` from `backend/src/auth/middleware.js`.
- Produces: `GET /api/characters`, `GET /api/characters/classes`, `POST /api/characters`, `DELETE /api/characters/:id`.

### Route contract

| route | success | failures |
|---|---|---|
| `GET /api/characters` | 200 `{ characters: [...], maxCharacters: 8 }` | 401 unauthenticated |
| `GET /api/characters/classes` | 200 `{ classes: [...] }` | 401 |
| `POST /api/characters` | 201 `{ id, slot, name }` | 400 `bad_name` / 400 `not_playable` / 409 `name_taken` / 409 `no_free_slot` |
| `DELETE /api/characters/:id` | 204 no body | 403 when not owned or absent |

`DELETE` returns 403 for both "not yours" and "does not exist" deliberately: distinguishing them tells an attacker which character ids are real.

Register `classes` **before** any `/:id` route so the literal path is not captured as an id.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/characters_routes.test.js`. Read an existing supertest-based route test first — `backend/tests/progression_routes.test.js` — and copy its app-construction and auth-header idiom exactly rather than inventing one. The assertions to write:

```js
// Sketch of the cases; use the surrounding file's own app/auth helpers.
//
//  - GET  /api/characters            unauthenticated            -> 401
//  - GET  /api/characters            authed, none created       -> 200, characters: [], maxCharacters: 8
//  - GET  /api/characters/classes    authed                     -> 200, three names, sorted stable
//  - POST /api/characters            {name:'zzR1', class Warrior} -> 201, slot 1
//  - POST /api/characters            same name, other account   -> 409, error 'name_taken'
//  - POST /api/characters            name: '   '                -> 400, error 'bad_name'
//  - POST /api/characters            entity_type_id of 'Player' -> 400, error 'not_playable'
//  - POST /api/characters            ninth                      -> 409, error 'no_free_slot'
//  - DELETE /api/characters/:id      owner                      -> 204, then GET shows one fewer
//  - DELETE /api/characters/:id      other account              -> 403, and the row still exists
//  - DELETE /api/characters/999999   authed                     -> 403 (not 404 — do not leak which ids exist)
//  - GET  /api/characters/classes    must not be captured by a /:id route (asserts 200, not 403)
```

Write each of these out as a real assertion — the list above is the checklist, not the test.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/characters_routes.test.js`
Expected: FAIL — 404 on every route.

- [ ] **Step 3: Add the routes**

In `backend/src/index.js`, alongside the existing inline routes and following their style (raw `pg`, the project's error shape, `authGuard`/`requireAuth` as the surrounding routes use it):

```js
const {
  listCharacters, listPlayableClasses, createCharacter, deleteCharacter,
  CharacterError, MAX_CHARACTERS,
} = require('./services/characters');

// Character slots. Ownership is checked inside the service for every route
// that names a character; a client-supplied id is never trusted.
app.get('/api/characters', authGuard, async (req, res) => {
  try {
    const characters = await listCharacters(pool, req.user.id);
    res.json({ characters, maxCharacters: MAX_CHARACTERS });
  } catch (err) {
    console.error('list characters failed:', err);
    res.status(500).json({ error: 'failed to list characters' });
  }
});

// Registered BEFORE any /:id route so 'classes' is not captured as an id.
app.get('/api/characters/classes', authGuard, async (req, res) => {
  try {
    res.json({ classes: await listPlayableClasses(pool) });
  } catch (err) {
    console.error('list classes failed:', err);
    res.status(500).json({ error: 'failed to list classes' });
  }
});

const CHARACTER_ERROR_STATUS = {
  bad_name: 400,
  not_playable: 400,
  name_taken: 409,
  no_free_slot: 409,
};

app.post('/api/characters', authGuard, async (req, res) => {
  try {
    const created = await createCharacter(
      pool, req.user.id, req.body && req.body.name, req.body && req.body.entity_type_id);
    res.status(201).json(created);
  } catch (err) {
    if (err instanceof CharacterError) {
      return res.status(CHARACTER_ERROR_STATUS[err.code] || 400).json({ error: err.code });
    }
    console.error('create character failed:', err);
    res.status(500).json({ error: 'failed to create character' });
  }
});

// 403 for both "not yours" and "does not exist": a 404 would tell a caller
// which character ids are real.
app.delete('/api/characters/:id', authGuard, async (req, res) => {
  try {
    const ok = await deleteCharacter(pool, req.user.id, req.params.id);
    if (!ok) return res.status(403).json({ error: 'forbidden' });
    res.status(204).end();
  } catch (err) {
    console.error('delete character failed:', err);
    res.status(500).json({ error: 'failed to delete character' });
  }
});
```

Check the surrounding file for the exact name of the auth middleware instance — `index.js:102` builds `adminGuard`; find or build the equivalent `requireAuth(guardPool)` instance and use that name rather than the literal `authGuard` above.

- [ ] **Step 4: Run the test**

Run: `cd backend && node --test tests/characters_routes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.js backend/tests/characters_routes.test.js
git commit -m "feat(characters): REST routes for listing, creating and deleting characters (SOMET-259)"
```

---

## Task 7: Nearest-portal spawn fallback

**Files:**
- Modify: `backend/src/services/mapService.js:850-867`
- Test: `backend/tests/spawn_portal_fallback.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks — this is independent and could ship alone.
- Produces: `chooseSpawn({ pending, persisted, worldRow, chunkSize, portals, isWalkable })`. `portals` is `Array<{x, y}>` in world pixels (defaults to `[]`); `isWalkable` is `(worldX, worldY) => boolean` or `null` (defaults to `null`, meaning "do not tile-check"). The returned object keeps its existing `{x, y, viaDoorway}` shape and gains `viaPortalFallback: boolean`.

### Current behaviour

`chooseSpawn` at `mapService.js:852` today ends at "bounded interior centre" or "chunk centre". A player who logged out in a world that was later resized, or on a tile that later became a wall, is dropped somewhere arbitrary — potentially inside geometry.

Existing tests in `backend/tests/edgeHelpers.test.js` (lines 31, 37, 43, 49, 55) cover the current five branches and **must keep passing unchanged**. They call `chooseSpawn` without `portals` or `isWalkable`, which is why both are optional with inert defaults.

### The validity rule

The player is 64px square positioned by its top-left corner (`PLAYER_HALF = 32` at `mapService.js:820`). A saved position is valid when:

1. If the world is bounded (`isBoundedWorld(worldRow)`, `mapService.js:727`): the whole 64px box lies within `[0, width*100]` × `[0, height*100]`.
2. If `isWalkable` was supplied: all four corners of the box, inset by 1px, are walkable.

`isWalkable` is `ServerMap.isWalkable(worldX, worldY)` from `backend/src/authority/collision.js:151` — the same predicate `resolveMove` uses. **Do not write a second walkability check**; `resolveMove` already exists as two byte-for-byte copies front and back, and a third would be worse.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/spawn_portal_fallback.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { chooseSpawn } = require('../src/services/mapService');

// Pure: no database, no ServerMap. isWalkable is injected, so the whole
// fallback is testable as a function of (position, bounds, tiles, portals).
const TILE = 100;
const bounded = { width: 10, height: 10 };            // 1000 x 1000 px
const unbounded = { width: null, height: null };

// Blocks the single tile at column 4, row 4 (i.e. x 400-500, y 400-500).
const blocksTile44 = (x, y) => !(Math.floor(x / TILE) === 4 && Math.floor(y / TILE) === 4);
const allWalkable = () => true;

test('a valid saved position is used unchanged', () => {
  const s = chooseSpawn({
    persisted: { x: 250, y: 250 }, worldRow: bounded, chunkSize: 64,
    portals: [{ x: 0, y: 0 }], isWalkable: allWalkable,
  });
  assert.deepEqual({ x: s.x, y: s.y }, { x: 250, y: 250 });
  assert.equal(s.viaPortalFallback, false);
});

test('a saved position outside the shrunken world falls back to the nearest portal', () => {
  const s = chooseSpawn({
    persisted: { x: 5000, y: 5000 }, worldRow: bounded, chunkSize: 64,
    portals: [{ x: 900, y: 900 }, { x: 100, y: 100 }], isWalkable: allWalkable,
  });
  // (5000,5000) is out of bounds, so the position is invalid; of the two
  // portals, (900,900) is nearer to the clamped-in-world reading of it.
  assert.deepEqual({ x: s.x, y: s.y }, { x: 900, y: 900 });
  assert.equal(s.viaPortalFallback, true);
});

test('a saved position on a now-blocked tile falls back to the nearest portal', () => {
  const s = chooseSpawn({
    persisted: { x: 420, y: 420 }, worldRow: bounded, chunkSize: 64,
    portals: [{ x: 800, y: 800 }, { x: 500, y: 500 }], isWalkable: blocksTile44,
  });
  assert.deepEqual({ x: s.x, y: s.y }, { x: 500, y: 500 });
  assert.equal(s.viaPortalFallback, true);
});

test('the NEAREST portal wins, by hand-computed distance', () => {
  // Distances from (420,420): (500,500) -> sqrt(80^2+80^2) ~ 113.1
  //                           (300,420) -> 120
  //                           (420,700) -> 280
  const s = chooseSpawn({
    persisted: { x: 420, y: 420 }, worldRow: bounded, chunkSize: 64,
    portals: [{ x: 420, y: 700 }, { x: 300, y: 420 }, { x: 500, y: 500 }],
    isWalkable: blocksTile44,
  });
  assert.deepEqual({ x: s.x, y: s.y }, { x: 500, y: 500 });
});

test('an invalid position in a world with no portals falls through to the old behaviour', () => {
  const s = chooseSpawn({
    persisted: { x: 420, y: 420 }, worldRow: bounded, chunkSize: 64,
    portals: [], isWalkable: blocksTile44,
  });
  // Bounded interior centre: col 5, row 5 -> 5*100 + 50 - 32.
  assert.deepEqual({ x: s.x, y: s.y }, { x: 518, y: 518 });
  assert.equal(s.viaPortalFallback, false);
});

test('a pending doorway arrival still beats everything', () => {
  const s = chooseSpawn({
    pending: { x: 10, y: 20 }, persisted: { x: 420, y: 420 },
    worldRow: bounded, chunkSize: 64,
    portals: [{ x: 500, y: 500 }], isWalkable: blocksTile44,
  });
  assert.deepEqual({ x: s.x, y: s.y, viaDoorway: s.viaDoorway }, { x: 10, y: 20, viaDoorway: true });
});

test('with no isWalkable supplied, an in-bounds position is trusted', () => {
  const s = chooseSpawn({
    persisted: { x: 420, y: 420 }, worldRow: bounded, chunkSize: 64,
    portals: [{ x: 500, y: 500 }],
  });
  assert.deepEqual({ x: s.x, y: s.y }, { x: 420, y: 420 });
});

test('an unbounded world only tile-checks', () => {
  const far = chooseSpawn({
    persisted: { x: 99999, y: 99999 }, worldRow: unbounded, chunkSize: 64,
    portals: [{ x: 1, y: 1 }], isWalkable: allWalkable,
  });
  assert.deepEqual({ x: far.x, y: far.y }, { x: 99999, y: 99999 },
    'an unbounded world has no bounds to violate');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/spawn_portal_fallback.test.js`
Expected: FAIL — `viaPortalFallback` is undefined and the invalid-position cases return the saved position.

- [ ] **Step 3: Implement the fallback**

Replace `chooseSpawn` at `backend/src/services/mapService.js:850-867` with:

```js
const PLAYER_SIZE = PLAYER_HALF * 2;
const FOOT_EPS = 1; // inset so a position flush against a wall edge is not read as inside it

// Is the player's whole 64px box inside the world and standing on walkable
// ground? isWalkable is ServerMap.isWalkable (authority/collision.js) injected
// by the caller, so this stays a pure function and the walkability rule is not
// duplicated a third time.
function spawnIsValid(x, y, worldRow, isWalkable) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (isBoundedWorld(worldRow)) {
    const maxX = worldRow.width * CREATURE_TILE_PX - PLAYER_SIZE;
    const maxY = worldRow.height * CREATURE_TILE_PX - PLAYER_SIZE;
    if (x < 0 || y < 0 || x > maxX || y > maxY) return false;
  }
  if (typeof isWalkable !== 'function') return true;
  const corners = [
    [x + FOOT_EPS, y + FOOT_EPS],
    [x + PLAYER_SIZE - FOOT_EPS, y + FOOT_EPS],
    [x + FOOT_EPS, y + PLAYER_SIZE - FOOT_EPS],
    [x + PLAYER_SIZE - FOOT_EPS, y + PLAYER_SIZE - FOOT_EPS],
  ];
  return corners.every(([cx, cy]) => isWalkable(cx, cy));
}

function nearestPortal(portals, x, y) {
  let best = null;
  let bestD2 = Infinity;
  for (const p of portals || []) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const d2 = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = p; }
  }
  return best;
}

// Decide a join spawn. Priority: doorway arrival > persisted position (if it is
// still valid) > nearest portal > entry_spawn (entry world, first join) >
// bounded interior center > chunk center.
//
// The nearest-portal step is SOMET-261. Before it, an invalid persisted
// position fell all the way through to "world centre", which after a world
// resize or a regeneration can be inside geometry -- the player loaded stuck.
// A portal is a tile the map author guaranteed is reachable, which makes it the
// right last resort. `portals` and `isWalkable` are optional so the five
// pre-existing branches (and edgeHelpers.test.js) behave exactly as before when
// a caller does not supply them.
function chooseSpawn({ pending, persisted, worldRow, chunkSize, portals = [], isWalkable = null }) {
  if (pending) return { x: pending.x, y: pending.y, viaDoorway: true, viaPortalFallback: false };
  if (persisted) {
    if (spawnIsValid(persisted.x, persisted.y, worldRow, isWalkable)) {
      return { x: persisted.x, y: persisted.y, viaDoorway: false, viaPortalFallback: false };
    }
    const near = nearestPortal(portals, persisted.x, persisted.y);
    if (near) return { x: near.x, y: near.y, viaDoorway: false, viaPortalFallback: true };
  }
  if (worldRow && worldRow.is_entry && worldRow.entry_spawn &&
      Number.isFinite(worldRow.entry_spawn.x) && Number.isFinite(worldRow.entry_spawn.y)) {
    return { x: worldRow.entry_spawn.x, y: worldRow.entry_spawn.y, viaDoorway: false, viaPortalFallback: false };
  }
  if (isBoundedWorld(worldRow)) {
    const col = Math.floor(worldRow.width / 2);
    const row = Math.floor(worldRow.height / 2);
    return { x: col * CREATURE_TILE_PX + (CREATURE_TILE_PX / 2) - PLAYER_HALF,
             y: row * CREATURE_TILE_PX + (CREATURE_TILE_PX / 2) - PLAYER_HALF,
             viaDoorway: false, viaPortalFallback: false };
  }
  const center = (chunkSize * CREATURE_TILE_PX) / 2;
  return { x: center, y: center, viaDoorway: false, viaPortalFallback: false };
}
```

- [ ] **Step 4: Run the new test and the existing one**

```bash
cd backend && node --test tests/spawn_portal_fallback.test.js tests/edgeHelpers.test.js
```
Expected: both PASS. `edgeHelpers.test.js` must pass **unchanged** — if you had to edit it, the defaults are not inert and the change is not backwards compatible.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/mapService.js backend/tests/spawn_portal_fallback.test.js
git commit -m "feat(spawn): fall back to the nearest portal when a saved position is invalid (SOMET-261)"
```

---

## Task 8: Wire the portal list and walkability into loadSpawn

**Files:**
- Modify: `backend/src/authority/server.js:373-390`
- Test: `backend/tests/spawn_portal_fallback.test.js` (extend)

**Interfaces:**
- Consumes: `chooseSpawn` from Task 7.
- Produces: `loadSpawn` supplies `portals` and `isWalkable` from the loaded world.

### What is already available

`server.js:332-338` builds `entry.portalLinks`, a Map keyed `` `${row},${col}` `` of portal source tiles for the loaded world. The values carry the source pixel coordinates. `entry.world` holds the `ServerMap` used by `resolveMove`.

Read `loadWorld` (around `server.js:293-345`) before editing to confirm the exact property names for the portal rows and the map instance — the plan cannot state them from outside, and guessing here produces a silently empty portal list, which would make the fallback inert without failing any test.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/spawn_portal_fallback.test.js` a test that reads the source text, guarding against exactly the inertness above:

```js
const fs = require('node:fs');
const path = require('node:path');

test('loadSpawn actually supplies portals and isWalkable', () => {
  // A source-text guard, deliberately. The failure this catches is inertness:
  // chooseSpawn gained two optional parameters with inert defaults, so a
  // loadSpawn that forgets to pass them keeps compiling, keeps passing every
  // other test, and silently never uses the fallback in real play.
  const src = fs.readFileSync(
    path.join(__dirname, '../src/authority/server.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function loadSpawn('));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(body, /chooseSpawn\(\{[\s\S]*portals/, 'loadSpawn must pass portals to chooseSpawn');
  assert.match(body, /chooseSpawn\(\{[\s\S]*isWalkable/, 'loadSpawn must pass isWalkable to chooseSpawn');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/spawn_portal_fallback.test.js`
Expected: the new test FAILS.

- [ ] **Step 3: Wire it up**

In `backend/src/authority/server.js`, change `loadSpawn` to take the world entry and pass both new arguments. Keep everything else byte-identical:

```js
  async function loadSpawn(worldId, characterId, chunkSize, worldRow, entry) {
    const pend = pendingArrivals.get(characterId);
    const pending = (pend && pend.worldId === worldId) ? { x: pend.x, y: pend.y } : null;
    if (pending) pendingArrivals.delete(characterId);
    let persisted = null;
    const r = await pool.query(
      'SELECT x, y FROM world_players WHERE world_id = $1 AND character_id = $2',
      [worldId, characterId]
    );
    if (r.rows.length) persisted = { x: r.rows[0].x, y: r.rows[0].y };
    // SOMET-261: a persisted position that is now out of bounds or inside
    // geometry falls back to the nearest portal rather than to the world
    // centre. Both arguments come from the already-loaded world, so this costs
    // no extra query.
    const portals = [...entry.portalLinks.values()]
      .map((l) => ({ x: l.from_x, y: l.from_y }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    const map = entry.world.map;
    const isWalkable = map ? (x, y) => map.isWalkable(x, y) : null;
    const spawn = chooseSpawn({ pending, persisted, worldRow, chunkSize, portals, isWalkable });
    const b = await pool.query(
      'SELECT x, y FROM player_binds WHERE character_id = $1 AND world_id = $2',
      [characterId, worldId],
    );
    spawn.respawn = b.rows.length ? { x: b.rows[0].x, y: b.rows[0].y } : { x: spawn.x, y: spawn.y };
    return spawn;
  }
```

Adjust `entry.portalLinks` value field names and `entry.world.map` to whatever `loadWorld` actually produces — verify by reading it, and if the shape differs, keep the intent (a list of `{x, y}` portal sources, and the `ServerMap`).

The `characterId` rename in the signature is Task 9's change arriving early; keep it, and Task 9 will update the call site.

- [ ] **Step 4: Run the test**

Run: `cd backend && node --test tests/spawn_portal_fallback.test.js`
Expected: PASS. The authority will not boot until Task 9 updates the call site — that is expected at this commit.

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/server.js backend/tests/spawn_portal_fallback.test.js
git commit -m "feat(spawn): supply the world's portals and walkability to chooseSpawn (SOMET-261)"
```

---

## Task 9: Authority joins by character

**Files:**
- Modify: `backend/src/authority/server.js` (`join` handler ~749-850, `persist` ~490, `upsertBind` ~499, the bind tick ~1164, the close handler ~1081, the flush timer ~1267)
- Modify: `backend/src/authority/items.js` (`loadInventory`)
- Test: `backend/tests/characters_authority.test.js`

**Interfaces:**
- Consumes: `ownedCharacter` from `backend/src/services/characters.js` (Task 5).
- Produces: the `join` frame requires `character_id`; every per-player query in the authority is keyed by character; `gold` stays keyed by user.

### The rules that must not change

- One live session per **account**, not per character: `sessionsByUser` stays keyed by `ws.userId`, and the "newest join wins" kick is unchanged.
- A second `join` on the same socket is still refused.
- The post-await re-check at `server.js:802` (has a newer session for this account overtaken us?) stays keyed on `ws.userId`.
- `gold` is read from `users`, not from the character.

### What changes

- `ws.characterId` is set alongside `ws.userId`, but only inside `join` — the WS upgrade has no character yet.
- `pendingArrivals` is keyed by **character id**, not user id, so a transition targets the character that walked through the door.
- `entry.sockets` stays keyed by `ws.userId` (one session per account), so no change.
- `loadInventory`, `loadProgression`, `persist`, `upsertBind`, and the bind tick all take a character id.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/characters_authority.test.js`. Read `backend/tests/authority_server.test.js` first and copy its harness — how it starts the authority against a pool, mints a token, and opens a socket. The cases:

```js
//  - join with no character_id                       -> error frame, no player added
//  - join with a character_id owned by another user  -> error frame, no player added
//  - join with a non-numeric character_id            -> error frame
//  - join with an owned character_id                 -> 'joined' frame carrying that character_id
//  - two characters on one account have independent world_players rows
//  - gold is read from users and is the same for both characters on the account
//  - a second join on the same socket is still refused (regression)
//  - a join by the same user on a new socket still kicks the old session (regression)
```

The ownership cases are the important ones: assert that **no player was added to the world**, not merely that an error frame came back. An implementation that sends an error and then joins anyway would pass a frame-only assertion.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/characters_authority.test.js`
Expected: FAIL — joins succeed without a `character_id`.

- [ ] **Step 3: Rewrite the join path**

In `backend/src/authority/server.js`:

```js
// At the top, alongside the other service requires:
const { ownedCharacter } = require('../services/characters');
```

Replace the opening of the `join` handler (keeping every existing comment block intact — they document real incidents and must survive):

```js
    async join(ws, msg) {
      if (ws.worldId != null) { send(ws, { type: 'error', message: 'already joined' }); return; }

      // A client-supplied character id is never trusted: it is checked against
      // the token's user before anything is loaded. There is deliberately NO
      // "default to the account's first character" fallback -- a silent default
      // would make a client bug (or a forged frame) look like a successful join
      // as somebody else's character.
      const character = await ownedCharacter(pool, Number(ws.userId), msg.character_id).catch(() => null);
      if (!character) { send(ws, { type: 'error', message: 'unknown character' }); return; }

      const entry = await loadWorld(msg.world_id).catch(() => null);
      if (!entry) { send(ws, { type: 'error', message: 'unknown world' }); return; }

      try {
        const spawn = await loadSpawn(entry.worldId, character.id, entry.row.chunk_size, entry.row, entry);
        if (ws.readyState !== ws.OPEN) return;
        // ... the existing session-kick block, UNCHANGED and still keyed on
        //     ws.userId: one live session per ACCOUNT, not per character.
```

Then, in the body below the kick block:

- `let inv = await loadInventory(pool, character.id);`
- `const granted = await grantStartingLoadout(pool, character, entry.world.weapons);` (Task 10 changes the signature; write the call now and let Task 10 land the implementation — this task's tests do not exercise the loadout)
- `const gr = await pool.query('SELECT gold FROM users WHERE id = $1', [ws.userId]);` — **unchanged**, gold is account-wide
- `const progression = await loadProgression(pool, character.id);`
- `ws.characterId = character.id;` immediately after `ws.worldId = entry.worldId;`
- the `joined` frame gains `character_id: character.id` alongside the existing `user_id`

Then update every remaining per-player query:

```js
  async function persist(worldId, characterId, p) {
    await pool.query(
      `INSERT INTO world_players (world_id, character_id, x, y, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (world_id, character_id) DO UPDATE SET x = $3, y = $4, updated_at = now()`,
      [worldId, characterId, p.x, p.y]
    );
  }

  async function upsertBind(characterId, worldId, x, y) {
    await pool.query(
      `INSERT INTO player_binds (character_id, world_id, x, y, updated_at)
         VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (character_id) DO UPDATE SET world_id = $2, x = $3, y = $4, updated_at = now()`,
      [characterId, worldId, x, y],
    );
  }
```

Then fix every call site of `persist` and `upsertBind` to pass `ws.characterId` (the close handler around line 1081, the flush timer around 1267, the bind tick around 1164). Change `pendingArrivals` to be keyed by character id at every set and get. In `backend/src/authority/items.js`, rename the `userId` parameter of `loadInventory` to `characterId` and change both queries' `WHERE user_id = $1` to `WHERE character_id = $1`.

**Grep for every remaining `user_id` in these two files before you finish.** Anything left that is not the `users.gold` read or the session bookkeeping is a bug.

- [ ] **Step 4: Run the test and the existing authority suite**

```bash
cd backend && node --test tests/characters_authority.test.js tests/authority_server.test.js tests/authority_items_inventory.test.js tests/authority_items_loadout_db.test.js
```
Expected: the new tests PASS; the existing three need their fixtures updated to create a character — update the fixtures, not the assertions.

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/server.js backend/src/authority/items.js backend/tests/characters_authority.test.js
git commit -m "feat(characters): authority joins by character, per-character state (SOMET-260)"
```

---

## Task 10: Per-class starting loadout

**Files:**
- Modify: `backend/src/authority/items.js:76,113-132`
- Test: `backend/tests/class_loadout_db.test.js`

**Interfaces:**
- Consumes: `class_loadouts` (Task 1); `characters.starting_loadout_granted_at` (Task 3); the `character` object from Task 9's join handler.
- Produces: `grantStartingLoadout(pool, character, itemTypes) -> Promise<boolean>` where `character` is `{ id, entityTypeId }`.

### The guarantee that must survive

`1714440035000_starting_loadout_granted.js` exists because the grant used to be gated on "this account currently owns zero items" — a state a player can walk back into by selling the starter gear and reconnecting, which was confirmed live as free gold. The gate is a **single conditional UPDATE … WHERE … IS NULL RETURNING**, deliberately one statement so two concurrent joins cannot both read "not granted yet". Keep that shape exactly; only the table and the item source change.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/class_loadout_db.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { loadItemTypes, grantStartingLoadout, loadInventory } = require('../src/authority/items');
const { createCharacter, listPlayableClasses } = require('../src/services/characters');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('per-class starting loadout', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  const itemTypes = await loadItemTypes(pool);
  const classes = await listPlayableClasses(pool);
  const nameOf = new Map([...itemTypes.values()].map((x) => [x.id, x.name]));

  async function withCharacter(username, className, fn) {
    await pool.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') ON CONFLICT (username) DO NOTHING",
      [username]);
    const userId = (await pool.query('SELECT id FROM users WHERE username = $1', [username])).rows[0].id;
    const cls = classes.find((c) => c.name === className);
    const created = await createCharacter(pool, userId, `${username}Char`, cls.id);
    try { return await fn({ id: created.id, entityTypeId: cls.id }); }
    finally { await pool.query('DELETE FROM users WHERE username = $1', [username]); }
  }

  async function itemNames(characterId) {
    const inv = await loadInventory(pool, characterId);
    return inv.items
      .map((i) => `${nameOf.get(i.typeId)}x${i.quantity}`)
      .sort();
  }

  await t.test('a Mage gets the staff loadout', async () => {
    await withCharacter('zzLoadMage', 'Mage', async (character) => {
      assert.equal(await grantStartingLoadout(pool, character, itemTypes), true);
      assert.deepEqual(await itemNames(character.id), ['apprentice staffx1', 'arcane-wardx1']);
    });
  });

  await t.test('a Warrior gets the sword loadout from the same code path', async () => {
    await withCharacter('zzLoadWar', 'Warrior', async (character) => {
      assert.equal(await grantStartingLoadout(pool, character, itemTypes), true);
      assert.deepEqual(await itemNames(character.id), ['leather-vestx1', 'short swordx1']);
    });
  });

  await t.test('a Ranger gets a stack of twenty arrows, not twenty rows', async () => {
    await withCharacter('zzLoadRng', 'Ranger', async (character) => {
      await grantStartingLoadout(pool, character, itemTypes);
      const inv = await loadInventory(pool, character.id);
      assert.equal(inv.items.length, 3);
      const arrows = inv.items.find((i) => nameOf.get(i.typeId) === 'arrow');
      assert.equal(arrows.quantity, 20);
    });
  });

  await t.test('the grant is once per character, even after selling everything', async () => {
    await withCharacter('zzLoadOnce', 'Warrior', async (character) => {
      assert.equal(await grantStartingLoadout(pool, character, itemTypes), true);
      // Simulate selling/dropping the lot -- the exploit F-013 fixed.
      await pool.query('DELETE FROM player_items WHERE character_id = $1', [character.id]);
      assert.equal(await grantStartingLoadout(pool, character, itemTypes), false);
      assert.deepEqual(await itemNames(character.id), []);
    });
  });

  await t.test('two characters on one account each get their own loadout', async () => {
    await pool.query(
      "INSERT INTO users (username, password_hash, role) VALUES ('zzLoadTwo', 'x', 'player') ON CONFLICT (username) DO NOTHING");
    const userId = (await pool.query("SELECT id FROM users WHERE username = 'zzLoadTwo'")).rows[0].id;
    try {
      const warrior = classes.find((c) => c.name === 'Warrior');
      const mage = classes.find((c) => c.name === 'Mage');
      const a = await createCharacter(pool, userId, 'zzLoadTwoA', warrior.id);
      const b = await createCharacter(pool, userId, 'zzLoadTwoB', mage.id);
      await grantStartingLoadout(pool, { id: a.id, entityTypeId: warrior.id }, itemTypes);
      await grantStartingLoadout(pool, { id: b.id, entityTypeId: mage.id }, itemTypes);
      assert.deepEqual(await itemNames(a.id), ['leather-vestx1', 'short swordx1']);
      assert.deepEqual(await itemNames(b.id), ['apprentice staffx1', 'arcane-wardx1']);
    } finally {
      await pool.query("DELETE FROM users WHERE username = 'zzLoadTwo'");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/class_loadout_db.test.js`
Expected: FAIL — the grant still writes the hardcoded dagger + vest and gates on `users`.

- [ ] **Step 3: Rewrite the grant**

In `backend/src/authority/items.js`, delete the `STARTING_LOADOUT` constant at line 76 and replace `grantStartingLoadout`:

```js
// Grant the starter set, once per CHARACTER, ever.
//
// F-013 (P0): this used to be gated on "the account currently owns zero items"
// (a SELECT against player_items), which a player can re-enter at will by
// selling or dropping the starter items and reconnecting -- the join handler
// saw an empty inventory and granted a fresh set every time. Confirmed live,
// twice: sell the dagger+vest to a merchant and reconnect for free gold
// (0 -> 21 -> 42), or drop them and reconnect for a free duplicate pair.
//
// The gate is still a SINGLE conditional UPDATE ... WHERE ... IS NULL
// RETURNING, for the same reason as before: two concurrent joins on the same
// fresh character cannot both read "not granted yet". Postgres takes the row
// lock on the first UPDATE that reaches it, the second blocks, then
// re-evaluates the WHERE against the committed row and affects zero rows.
//
// What changed for SOMET-258 is only WHERE the flag lives and WHAT is granted:
// the flag moved from users to characters (the loadout is class-dependent, so a
// second character must get its own), and the item list moved from a hardcoded
// STARTING_LOADOUT array to the class_loadouts table keyed by the character's
// entity_type_id.
async function grantStartingLoadout(pool, character, itemTypes) {
  const claim = await pool.query(
    `UPDATE characters SET starting_loadout_granted_at = now()
      WHERE id = $1 AND starting_loadout_granted_at IS NULL
      RETURNING id`,
    [character.id],
  );
  if (claim.rowCount === 0) return false;
  const rows = await pool.query(
    'SELECT item_type_id, quantity FROM class_loadouts WHERE entity_type_id = $1 ORDER BY id ASC',
    [character.entityTypeId],
  );
  for (const row of rows.rows) {
    // A catalog missing this type would already have failed the fk on
    // class_loadouts, but keep the guard: itemTypes is the in-memory catalog
    // the world was built from, and a world loaded before a catalog change
    // could legitimately be missing an id.
    if (!itemTypes.has(row.item_type_id)) continue;
    await pool.query(
      'INSERT INTO player_items (character_id, item_type_id, quantity) VALUES ($1, $2, $3)',
      [character.id, row.item_type_id, row.quantity],
    );
  }
  return true;
}
```

Remove `STARTING_LOADOUT` from the `module.exports` list at line 223 and fix any test that imported it (grep for it first).

In `server.js`'s join handler, the grant is now unconditional rather than gated on an empty inventory — the `if (inv.items.length === 0)` wrapper was only ever a cheap pre-filter and it is wrong for a character whose account already has items:

```js
        let inv = await loadInventory(pool, character.id);
        const granted = await grantStartingLoadout(pool, character, entry.world.weapons);
        if (granted) inv = await loadInventory(pool, character.id);
```

- [ ] **Step 4: Run the test**

Run: `cd backend && node --test tests/class_loadout_db.test.js`
Expected: all five sub-tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/items.js backend/src/authority/server.js backend/tests/class_loadout_db.test.js
git commit -m "feat(characters): starting loadout is per-character and class-driven (SOMET-258)"
```

---

## Task 11: Full backend suite green

**Files:**
- Modify: whatever the suite reveals.

**Interfaces:**
- Consumes: everything above.
- Produces: a green `npm test` from `backend/`, which is the entry condition for the frontend plan.

- [ ] **Step 1: Run the whole suite**

Run: `cd backend && npm test 2>&1 | tail -40`
Expected: failures in tests whose fixtures still write `user_id` into a re-keyed table.

- [ ] **Step 2: Fix the fixtures, not the assertions**

For each failure, the fix is to create a character in the fixture and key the state row by it. **Do not weaken an assertion to make it pass.** If an assertion is genuinely wrong now (for instance, one that asserted account-wide inventory), change it deliberately and say so in the commit message.

Likely candidates from the DB-hitting list: `authority_items_inventory`, `authority_items_equip`, `authority_items_loadout_db`, `progression_store`, `progression_routes`, `progression_kill_xp`, `progression_death`, `villageBind`, `authority_server`, `migration_world_players`.

- [ ] **Step 3: Re-run until green**

Run: `cd backend && npm test 2>&1 | tail -20`
Expected: 0 failures. Record the actual pass/fail counts — do not claim green without the output.

- [ ] **Step 4: Commit**

```bash
git add -A backend/tests
git commit -m "test(characters): re-key fixtures onto characters across the backend suite (SOMET-257)"
```

---

## Self-review notes

Checked against the spec:

- §1.1 characters table — Task 3. §1.2 re-key — Task 3. §1.3 backfill — Tasks 3 and 4. §1.4 down — Tasks 3 (order) and 4 (schema).
- §2 classes — Tasks 1 and 2. §2.1 class loadouts — Tasks 1 and 10.
- §3 API — Tasks 5 and 6.
- §4 authority — Task 9.
- §5 spawn fallback — Tasks 7 and 8.
- §6 §7 §8 §9 — the frontend plan.
- §10 backend tests — spread across every task; the whole-suite gate is Task 11.

**Ordering inversion:** the spec's slice A→B dependency is reversed here, deliberately, and stated at the top. SOMET-257 and SOMET-258 need their "depends on" lines updated to match.

**Signature consistency:** `grantStartingLoadout(pool, character, itemTypes)` takes `{id, entityTypeId}` in Tasks 9 and 10 — the same shape `ownedCharacter` returns. `chooseSpawn`'s two new parameters are named `portals` and `isWalkable` in Tasks 7 and 8. `loadSpawn(worldId, characterId, chunkSize, worldRow, entry)` is introduced in Task 8 and called with that arity in Task 9.

**Known gap, deliberate:** Task 6's route test is specified as a checklist of cases rather than finished code, because the supertest harness idiom must be copied from `progression_routes.test.js` and reproducing it here from a summary risks a subtly wrong app construction. Every case is enumerated; none is left to judgement. Same for Task 9's authority harness.
