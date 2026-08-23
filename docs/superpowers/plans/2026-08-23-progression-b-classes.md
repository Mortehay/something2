# Six Classes, Life Cost and Charm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the six playable classes (adding Monk, Cultist, Archer and Druid alongside Warrior and Mage), the Cultist's life-instead-of-mana casting resource, and the Druid's charm — full control transfer over creatures with a summon budget, and a strictly bounded pacify against players.

**Architecture:** Three additive layers on live systems. (1) Four new `entity_types` rows plus an `entity_types.main_stat` column and `class_loadouts` rows; `Ranger` is demoted to not-playable rather than renamed, because `characters.entity_type_id` is a plain reference with no `ON DELETE` and live characters point at it. (2) A single pure module `services/lifeCost.js` consumed at the ONE place `item_types.mana_cost` is checked and spent today — `World.canAttack`/`World.attack` in `backend/src/authority/world.js`. (3) A pure `services/charm.js` for the budget arithmetic, a non-refreshing `charmed` status effect in `authority/effects.js` modelled directly on that file's shock interrupt, an in-sim charmed-creature branch in `authority/creatures.js`, and durable roster rows in `character_summons`.

**Tech Stack:** Node 20 + Express + raw `pg` (CommonJS), `node-pg-migrate`, `node:test`; React 19 + styled-components + TanStack Query for the character-select surface; plain ES modules for the canvas client; vitest for frontend tests.

**Spec:** docs/superpowers/specs/2026-08-23-progression-passive-tree-design.md
**Contract:** docs/superpowers/plans/2026-08-23-progression-shared-contract.md

---

## Global Constraints

Copied verbatim from the contract's §5:

- **Backend:** CommonJS, Express, raw `pg` queries, inline routes. See `.ai/styleguides/backend.md`.
- **Frontend admin:** React 19, styled-components, `--s2-*` tokens only, TanStack Query for data. See `.ai/styleguides/frontend.md`.
- **Game client:** plain ES modules under `frontend/src/games/something2/src/js`. Layout/maths live in testable functions separate from canvas draw calls, as `inventoryPanel.js` already does.
- **Tests:** backend `npm test` from `backend/`; frontend `npx vitest run` from `frontend/`. Any DB-touching test run MUST set both `DATABASE_URL` and `TEST_DATABASE_URL` to a per-branch scratch database, seeded with the map specs. Unset `TEST_DATABASE_URL` silently targets the SHARED DEV DATABASE.
- **Never** run a destructive statement against the shared dev database. No `DELETE FROM`, `TRUNCATE` or `DROP` outside a scratch DB.
- **No vacuous tests.** A test must not derive its expected value by calling the same function or constant the code under test uses. XP-curve, affix-roll and stat-composition expectations are hand-written literals.
- **Worktrees:** several sessions share this checkout. Every task runs in its own `git worktree`; never `checkout`, `stash` or `branch` in the shared working directory. Stage by explicit path.
- **Commits:** branch `feat/<slug>`; subject `type(scope): summary (SOMET-NNN)`; end the message with the `Co-Authored-By: Claude Opus 5 (1M context)` trailer.

### This group's migration slots

| Slot | Task | Content |
|---|---|---|
| `1714440402000` | Task 1 (T3) | `entity_types.main_stat`, four new playable rows, Ranger demotion, loadouts |
| `1714440403000` | Task 3 (T5) | `world_creatures` charm columns, `character_summons` |

Task 2 (T4) adds **no** migration. **Do not take any other timestamp**, including one that "looks free".

> **Contract defect, confirmed against the repo — read before you start.** The contract reserves `1714440400000`–`1714440430000` for this epic, but three migrations in that range are **already on `main`**: `1714440400000_biome_path_tile.js`, `1714440410000_invite_codes.js`, `1714440420000_inventory_slots.js`. The two slots assigned to *this* group (`…402000`, `…403000`) are genuinely free — verify with `ls backend/migrations | grep 1714440402000` and `… 1714440403000` before writing either file, and stop and escalate if either returns a row. Group A's `1714440400000` slot is **taken** and is not this plan's problem to fix, but it will break their run.

---

## Setup — once, before Task 1

Every DB command below names a scratch database. Do this once per worktree; nothing in this plan may run against the shared dev DB.

- [ ] **Setup 1: Create the worktree**
```bash
cd /home/markunn/worker/coding/jsgame/something2
git worktree add /tmp/wt-classes -b feat/progression-b-classes main
```

- [ ] **Setup 2: Create the scratch database and migrate it**
```bash
export SCRATCH="postgresql://postgres:postgres@localhost:15432/somet_classes"
createdb -h localhost -p 15432 -U postgres somet_classes
cd /tmp/wt-classes/backend && DATABASE_URL="$SCRATCH" npm run migrate:up
```

- [ ] **Setup 3: Seed the catalogs and BOTH map specs, `vale-region` LAST**
```bash
cd /tmp/wt-classes/backend
DATABASE_URL="$SCRATCH" node scripts/seed-catalogs.js
DATABASE_URL="$SCRATCH" SPEC=p5-descent  node scripts/seed-map.js
DATABASE_URL="$SCRATCH" SPEC=vale-region node scripts/seed-map.js
```
Order matters: `vale-region` seeds the entry world, and seeding `p5-descent` after it steals `is_entry`, which fails roughly fifteen unrelated DB tests.

- [ ] **Setup 4: Prove the scratch DB is the one the tests will use**
```bash
cd /tmp/wt-classes/backend
DATABASE_URL="$SCRATCH" TEST_DATABASE_URL="$SCRATCH" \
  npx node --test tests/playable_classes_db.test.js
```
Expected: PASS, and **not** skipped. A "no database URL" skip means neither variable reached the process and every DB assertion in this plan would be vacuous.

---

## File Structure

| File | Created / Modified | The ONE responsibility |
|---|---|---|
| `backend/migrations/1714440402000_six_classes_main_stat.js` | Create | Add `entity_types.main_stat`, insert Monk/Cultist/Archer/Druid, demote Ranger, insert their `class_loadouts` |
| `backend/migrations/1714440403000_charm_and_summons.js` | Create | Add `world_creatures.charmed_by_character_id` + `charm_expires_at`, create `character_summons` |
| `backend/seeds/data/entityTypes.js` | Modify | Class catalog data a rebuilt Postgres volume is restored from |
| `backend/scripts/seed-catalogs.js` | Modify | Write `main_stat` and `is_playable` when restoring a class row |
| `backend/src/services/characters.js` | Modify | Expose `mainStat` on the class list and `className`/`mainStat` on `ownedCharacter` |
| `backend/src/services/lifeCost.js` | Create | PURE: the mana→HP conversion and the "refused, not lethal" affordability rule |
| `backend/src/services/charm.js` | Create | PURE: charm budget arithmetic and the two player-charm durations |
| `backend/src/authority/effects.js` | Modify | The `charmed` status effect with a non-refreshing immunity window |
| `backend/src/authority/world.js` | Modify | The single attack resource gate, the pacify filter, and the charm's soft repel |
| `backend/src/authority/creatures.js` | Modify | Charmed-creature ownership fields, the charmed tick branch, and the pacify filter on the melee arc |
| `backend/src/authority/projectiles.js` | Modify | Carry the attacker's pacify state onto a shot and honour it at both hit tests |
| `backend/src/authority/server.js` | Modify | Resolve the Cultist flag at join, and own the `charm` websocket handler and its DB writes |
| `frontend/src/games/something2/classIdentity.js` | Create | The per-class main-stat label and one-line identity copy (testable, no JSX) |
| `frontend/src/games/something2/CharacterSelect.jsx` | Modify | Render all six classes with their main stat and identity line |
| `frontend/src/games/something2/src/js/core/Game.js` | Modify | Hide the mana readout for a life-cost class |
| `backend/tests/six_classes_db.test.js` | Create | The six-class catalog, the Ranger demotion, and Warrior/Mage stat immutability |
| `backend/tests/playable_classes_db.test.js` | Modify | Existing three-class expectations updated to six |
| `backend/tests/characters_service_main_stat.test.js` | Create | `listPlayableClasses`/`ownedCharacter` surface `mainStat` and `className` |
| `backend/tests/life_cost.test.js` | Create | Pure life-cost arithmetic against hand-written literals |
| `backend/tests/authority_life_cost_gate.test.js` | Create | A lethal Cultist cast is refused and costs nothing |
| `backend/tests/charm_budget.test.js` | Create | Summon totals cannot exceed the charm budget |
| `backend/tests/authority_charm_player.test.js` | Create | A charmed player is pacified, never summoned, never chain-locked |
| `backend/tests/authority_charm_creature.test.js` | Create | A charmed creature flips faction, follows its druid and fights the druid's target |
| `backend/tests/charm_summons_db.test.js` | Create | Schema + roster invariants for `character_summons` and the charm columns |
| `frontend/src/games/something2/__tests__/classIdentity.test.js` | Create | Every playable class has a main-stat label and an identity line |

---

### Task 1: Six playable classes, `main_stat`, loadouts and the character-select UI

**Files:**
- Create: `backend/migrations/1714440402000_six_classes_main_stat.js`
- Create: `backend/tests/six_classes_db.test.js`
- Create: `backend/tests/characters_service_main_stat.test.js`
- Create: `frontend/src/games/something2/classIdentity.js`
- Create: `frontend/src/games/something2/__tests__/classIdentity.test.js`
- Modify: `backend/seeds/data/entityTypes.js:234-266`
- Modify: `backend/scripts/seed-catalogs.js:361-374`
- Modify: `backend/src/services/characters.js:18-34`, `backend/src/services/characters.js:77-92`
- Modify: `backend/tests/playable_classes_db.test.js:46-50`, `:134-139`, `:172`
- Modify: `frontend/src/games/something2/CharacterSelect.jsx:1-4`, `:171-185`

**Interfaces:**
- Consumes: nothing from Group A. This task touches only the class catalog; `player_progression` is untouched, so it does not race T2.
- Produces:
  - SQL column `entity_types.main_stat text`, `NULL` or one of `'strength' | 'dexterity' | 'constitution' | 'intelligence' | 'wisdom' | 'charisma'`. T6/T7 key the passive-tree start node off this.
  - `listPlayableClasses(pool) -> Promise<Array<{ id: number, name: string, color: string, mainStat: string|null, hp: number, strength: number, dexterity: number, constitution: number, intelligence: number, wisdom: number, charisma: number }>>`
  - `ownedCharacter(pool, userId, characterId) -> Promise<{ id: number, entityTypeId: number, inventorySlots: number, className: string, mainStat: string|null } | null>` — Task 2 reads `className`.
  - `describeClass({ name, mainStat }) -> string` from `frontend/src/games/something2/classIdentity.js`.

---

- [ ] **Step 1: Write the failing DB test for the six-class catalog**

Create `backend/tests/six_classes_db.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// Every expected number below is written out by hand. Reading them from
// seeds/data/entityTypes.js (the file the seeder reads) would pass against a
// seeder that writes nothing at all -- the failure shape playable_classes_db
// already documents.
test('six playable classes', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  await t.test('exactly six classes are playable, each with its main stat', async () => {
    const r = await pool.query(
      `SELECT name, main_stat FROM entity_types
        WHERE is_playable = true ORDER BY name`);
    assert.deepEqual(
      r.rows.map((x) => `${x.name}:${x.main_stat}`),
      [
        'Archer:dexterity',
        'Cultist:constitution',
        'Druid:charisma',
        'Mage:intelligence',
        'Monk:wisdom',
        'Warrior:strength',
      ]);
  });

  await t.test('Ranger is kept, demoted, and NOT renamed', async () => {
    const r = await pool.query(
      "SELECT is_playable, main_stat, hp, dexterity FROM entity_types WHERE name = 'Ranger'");
    assert.equal(r.rows.length, 1,
      'the Ranger row must still exist: live characters.entity_type_id values point at it');
    assert.equal(r.rows[0].is_playable, false);
    assert.equal(r.rows[0].main_stat, null,
      'a not-playable row has no tree start position');
    // Unchanged from 1714440091000. A demotion must not retune the row.
    assert.equal(Number(r.rows[0].hp), 85);
    assert.equal(Number(r.rows[0].dexterity), 12);
  });

  // REQUIRED COVERAGE (d): adding four rows must not move the two that exist.
  await t.test('Warrior and Mage keep the stats they already had', async () => {
    const r = await pool.query(
      `SELECT name, strength, dexterity, constitution, intelligence, wisdom, charisma,
              hp, max_hp, mana, max_mana
         FROM entity_types WHERE name IN ('Warrior', 'Mage')`);
    const by = new Map(r.rows.map((x) => [x.name, x]));
    assert.deepEqual(
      {
        str: Number(by.get('Warrior').strength), dex: Number(by.get('Warrior').dexterity),
        con: Number(by.get('Warrior').constitution), int: Number(by.get('Warrior').intelligence),
        wis: Number(by.get('Warrior').wisdom), cha: Number(by.get('Warrior').charisma),
        hp: Number(by.get('Warrior').hp), maxHp: Number(by.get('Warrior').max_hp),
        mana: Number(by.get('Warrior').mana), maxMana: Number(by.get('Warrior').max_mana),
      },
      { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, hp: 100, maxHp: 100, mana: 50, maxMana: 50 });
    assert.deepEqual(
      {
        str: Number(by.get('Mage').strength), dex: Number(by.get('Mage').dexterity),
        con: Number(by.get('Mage').constitution), int: Number(by.get('Mage').intelligence),
        wis: Number(by.get('Mage').wisdom), cha: Number(by.get('Mage').charisma),
        hp: Number(by.get('Mage').hp), maxHp: Number(by.get('Mage').max_hp),
        mana: Number(by.get('Mage').mana), maxMana: Number(by.get('Mage').max_mana),
      },
      { str: 10, dex: 10, con: 10, int: 12, wis: 10, cha: 10, hp: 75, maxHp: 75, mana: 70, maxMana: 70 });
  });

  await t.test('the four new classes carry their own literal stats', async () => {
    const r = await pool.query(
      `SELECT name, hp, max_hp, mana, max_mana,
              strength, dexterity, constitution, intelligence, wisdom, charisma
         FROM entity_types WHERE name IN ('Monk', 'Cultist', 'Archer', 'Druid')`);
    const by = new Map(r.rows.map((x) => [x.name, x]));
    assert.deepEqual(
      { hp: Number(by.get('Monk').hp), wis: Number(by.get('Monk').wisdom), mana: Number(by.get('Monk').max_mana) },
      { hp: 90, wis: 12, mana: 60 });
    assert.deepEqual(
      { hp: Number(by.get('Cultist').hp), con: Number(by.get('Cultist').constitution) },
      { hp: 110, con: 12 });
    assert.deepEqual(
      { hp: Number(by.get('Archer').hp), dex: Number(by.get('Archer').dexterity) },
      { hp: 85, dex: 12 });
    assert.deepEqual(
      { hp: Number(by.get('Druid').hp), cha: Number(by.get('Druid').charisma), mana: Number(by.get('Druid').max_mana) },
      { hp: 90, cha: 12, mana: 55 });
  });

  await t.test('every new class has a loadout resolved to real item types', async () => {
    const r = await pool.query(
      `SELECT e.name AS class, i.name AS item, l.quantity
         FROM class_loadouts l
         JOIN entity_types e ON e.id = l.entity_type_id
         JOIN item_types  i ON i.id = l.item_type_id
        WHERE e.name IN ('Monk', 'Cultist', 'Archer', 'Druid')
        ORDER BY e.name, i.name`);
    assert.deepEqual(r.rows.map((x) => `${x.class}:${x.item}x${x.quantity}`), [
      'Archer:arrowx20',
      'Archer:bowx1',
      'Archer:leather-vestx1',
      'Cultist:apprentice staffx1',
      'Cultist:leather-vestx1',
      'Druid:clubx1',
      'Druid:leather-vestx1',
      'Monk:leather-vestx1',
      'Monk:stickx1',
    ]);
  });

  await t.test('main_stat rejects a value that is not one of the six stats', async () => {
    await assert.rejects(
      () => pool.query("UPDATE entity_types SET main_stat = 'luck' WHERE name = 'Monk'"),
      /entity_types_main_stat_check/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd /tmp/wt-classes/backend && DATABASE_URL="$SCRATCH" TEST_DATABASE_URL="$SCRATCH" \
  npx node --test tests/six_classes_db.test.js
```
Expected: FAIL with `error: column "main_stat" does not exist`.

- [ ] **Step 3: Write the migration**

Create `backend/migrations/1714440402000_six_classes_main_stat.js`:

```js
exports.shorthands = undefined;

// Six playable classes (SOMET-NNN), one per stat column in player_progression.
//
// RANGER IS KEPT AND DEMOTED, NEVER RENAMED INTO ARCHER. characters.entity_type_id
// is a plain reference with no ON DELETE (1714440092000), so live characters
// point straight at the Ranger row; renaming it would leave those characters
// playing a class whose stats and starting loadout are not the ones they rolled,
// silently and with nothing to notice it. The legacy 'Player' row was handled
// exactly this way by 1714440091000 -- kept, marked not-playable -- and this
// follows that precedent rather than inventing a second one.
//
// main_stat is the passive tree's start position (spec 5.2). NULL for anything
// not playable, which is every creature and both legacy rows.

const STAT_NAMES = [
  'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma',
];

// Expressed as deltas on top of the WARRIOR row, exactly as 1714440091000
// expressed Ranger and Mage as deltas on top of Player: a literal copy of the
// twelve inherited columns would be a second source of truth free to drift from
// the row it is supposed to match. Each new class raises its own main stat to 12
// and leaves the other five at the shared base, so the six are comparable at
// creation and the tree -- not the class row -- is where they diverge.
const NEW_CLASSES = [
  {
    name: 'Monk', color: '#8e6b2f', mainStat: 'wisdom',
    set: { hp: 90, max_hp: 90, wisdom: 12, mana: 60, max_mana: 60, mana_regen_rate: 1 },
  },
  {
    name: 'Cultist', color: '#7b1f3a', mainStat: 'constitution',
    // The highest hp in the game, deliberately: CON is both their survivability
    // AND their casting resource (spec 8.3), so it is spent twice over.
    set: { hp: 110, max_hp: 110, constitution: 12 },
  },
  {
    name: 'Archer', color: '#1e8449', mainStat: 'dexterity',
    set: { hp: 85, max_hp: 85, dexterity: 12 },
  },
  {
    name: 'Druid', color: '#2f7d5b', mainStat: 'charisma',
    set: { hp: 90, max_hp: 90, charisma: 12, mana: 55, max_mana: 55 },
  },
];

// class name -> [[item_types.name, quantity], ...]. Every name here is verified
// against the catalog (1714440017000 and 1714440019000): 'stick', 'club',
// 'apprentice staff', 'bow', 'arrow' and 'leather-vest' all exist. There is
// still no off_hand item in item_types, so nobody gets a shield.
const CLASS_LOADOUTS = {
  Monk:    [['stick', 1], ['leather-vest', 1]],
  Cultist: [['apprentice staff', 1], ['leather-vest', 1]],
  Archer:  [['bow', 1], ['arrow', 20], ['leather-vest', 1]],
  Druid:   [['club', 1], ['leather-vest', 1]],
};

const INHERITED_COLUMNS = [
  'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma',
  'hp', 'max_hp', 'hp_regen_rate', 'mana', 'max_mana', 'mana_regen_rate',
];

function col(name, set) {
  return Object.prototype.hasOwnProperty.call(set, name) ? String(set[name]) : `w.${name}`;
}

exports.up = (pgm) => {
  pgm.addColumns('entity_types', { main_stat: { type: 'text' } });
  pgm.addConstraint('entity_types', 'entity_types_main_stat_check',
    `CHECK (main_stat IS NULL OR main_stat IN (${STAT_NAMES.map((s) => `'${s}'`).join(', ')}))`);

  pgm.sql("UPDATE entity_types SET main_stat = 'strength'     WHERE name = 'Warrior'");
  pgm.sql("UPDATE entity_types SET main_stat = 'intelligence' WHERE name = 'Mage'");
  // The demotion. is_playable gates character CREATION only
  // (services/characters.js createCharacter), so every existing Ranger keeps
  // playing exactly as before; they simply cannot be rolled fresh.
  pgm.sql("UPDATE entity_types SET is_playable = false WHERE name = 'Ranger'");

  for (const cls of NEW_CLASSES) {
    pgm.sql(`
      INSERT INTO entity_types (
        name, color, walkable, spawn_tiles, chance, is_playable, main_stat,
        ${INHERITED_COLUMNS.join(', ')}
      )
      SELECT
        '${cls.name}', '${cls.color}', w.walkable, w.spawn_tiles, 0, true, '${cls.mainStat}',
        ${INHERITED_COLUMNS.map((c) => col(c, cls.set)).join(', ')}
      FROM entity_types w WHERE w.name = 'Warrior'
      ON CONFLICT (name) DO NOTHING
    `);
  }

  // Belt and braces, in the shape 1714440091000 already uses: a database whose
  // Warrior row is missing would make every SELECT above insert nothing, and the
  // failure would surface later as an empty class picker rather than here.
  pgm.sql(`
    DO $$
    DECLARE n integer;
    BEGIN
      SELECT count(*) INTO n FROM entity_types WHERE is_playable = true;
      IF n <> 6 THEN
        RAISE EXCEPTION 'expected exactly 6 playable classes, found %', n;
      END IF;
    END $$;
  `);

  for (const [className, rows] of Object.entries(CLASS_LOADOUTS)) {
    for (const [itemName, qty] of rows) {
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

exports.down = (pgm) => {
  pgm.sql("DELETE FROM entity_types WHERE name IN ('Monk', 'Cultist', 'Archer', 'Druid')");
  pgm.sql("UPDATE entity_types SET is_playable = true WHERE name = 'Ranger'");
  pgm.dropConstraint('entity_types', 'entity_types_main_stat_check');
  pgm.dropColumns('entity_types', ['main_stat']);
};

exports.NEW_CLASSES = NEW_CLASSES;
exports.CLASS_LOADOUTS = CLASS_LOADOUTS;
```

- [ ] **Step 4: Run the migration, then the test, to verify it passes**

Run:
```bash
cd /tmp/wt-classes/backend && DATABASE_URL="$SCRATCH" npm run migrate:up \
  && DATABASE_URL="$SCRATCH" TEST_DATABASE_URL="$SCRATCH" npx node --test tests/six_classes_db.test.js
```
Expected: PASS, 6 subtests.

- [ ] **Step 5: Commit**
```bash
cd /tmp/wt-classes
git add backend/migrations/1714440402000_six_classes_main_stat.js backend/tests/six_classes_db.test.js
git commit -m "feat(classes): add main_stat and the Monk, Cultist, Archer and Druid rows (SOMET-NNN)"
```

- [ ] **Step 6: Run the existing class test to see what the migration broke**

Run:
```bash
cd /tmp/wt-classes/backend && DATABASE_URL="$SCRATCH" TEST_DATABASE_URL="$SCRATCH" \
  npx node --test tests/playable_classes_db.test.js
```
Expected: FAIL on `exactly the three classes are playable`, with actual `[ 'Archer', 'Cultist', 'Druid', 'Mage', 'Monk', 'Warrior' ]`. This is the demotion working; the assertion is now stale.

- [ ] **Step 7: Update the three stale expectations in `backend/tests/playable_classes_db.test.js`**

At `:46-50`, replace the subtest body:

```js
  await t.test('exactly the six classes are playable', async () => {
    const r = await pool.query(
      'SELECT name FROM entity_types WHERE is_playable = true ORDER BY name');
    assert.deepEqual(r.rows.map((x) => x.name),
      ['Archer', 'Cultist', 'Druid', 'Mage', 'Monk', 'Warrior']);
  });
```

At `:134-139`, replace the two lookup tables (Ranger drops out: the query above them selects only `is_playable = true` rows, so it can never be chosen):

```js
    const expectedHp = { Warrior: 100, Mage: 75, Monk: 90, Cultist: 110, Archer: 85, Druid: 90 }[victim];
    const expectedLoadout = {
      Warrior: ['leather-vestx1', 'short swordx1'],
      Mage: ['apprentice staffx1', 'arcane-wardx1'],
      Monk: ['leather-vestx1', 'stickx1'],
      Cultist: ['apprentice staffx1', 'leather-vestx1'],
      Archer: ['arrowx20', 'bowx1', 'leather-vestx1'],
      Druid: ['clubx1', 'leather-vestx1'],
    }[victim];
```

At `:172`, the total loadout-row count becomes 16 (Warrior 2 + Ranger 3 + Mage 2 + Monk 2 + Cultist 2 + Archer 3 + Druid 2):

```js
      assert.equal(after.rows[0].n, 16, 'a repeat run must not duplicate loadout rows');
```

- [ ] **Step 8: Run it to verify it now fails only on the seeder**

Run:
```bash
cd /tmp/wt-classes/backend && DATABASE_URL="$SCRATCH" TEST_DATABASE_URL="$SCRATCH" \
  npx node --test tests/playable_classes_db.test.js
```
Expected: FAIL on `seed-catalogs rebuilds a class that has gone missing`, with `Monk must be restored by the seeder` (or whichever unused class the query picked). The seeder does not know about the four new rows yet — that is the next step, and it is the real "a rebuilt volume orphans every character" hazard this test exists for.

- [ ] **Step 9: Teach the seed data about the six classes**

In `backend/seeds/data/entityTypes.js`, replace the `PLAYABLE_CLASSES` array (`:234-250`) with:

```js
const PLAYABLE_CLASSES = [
  {
    name: 'Warrior', color: '#b03a2e', walkable: true, spawn_tiles: [], chance: 0,
    is_playable: true, main_stat: 'strength',
    strength: 10, dexterity: 10, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10,
    hp: 100, max_hp: 100, hp_regen_rate: 1, mana: 50, max_mana: 50, mana_regen_rate: 0.5,
  },
  {
    // KEPT AND NOT PLAYABLE. Restoring this row is still mandatory -- live
    // characters.entity_type_id values reference it -- but it must come back
    // demoted, or a rebuilt volume quietly re-opens a class the epic retired.
    name: 'Ranger', color: '#1e8449', walkable: true, spawn_tiles: [], chance: 0,
    is_playable: false, main_stat: null,
    strength: 10, dexterity: 12, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10,
    hp: 85, max_hp: 85, hp_regen_rate: 1, mana: 50, max_mana: 50, mana_regen_rate: 0.5,
  },
  {
    name: 'Mage', color: '#5b2c94', walkable: true, spawn_tiles: [], chance: 0,
    is_playable: true, main_stat: 'intelligence',
    strength: 10, dexterity: 10, constitution: 10, intelligence: 12, wisdom: 10, charisma: 10,
    hp: 75, max_hp: 75, hp_regen_rate: 1, mana: 70, max_mana: 70, mana_regen_rate: 0.5,
  },
  {
    name: 'Monk', color: '#8e6b2f', walkable: true, spawn_tiles: [], chance: 0,
    is_playable: true, main_stat: 'wisdom',
    strength: 10, dexterity: 10, constitution: 10, intelligence: 10, wisdom: 12, charisma: 10,
    hp: 90, max_hp: 90, hp_regen_rate: 1, mana: 60, max_mana: 60, mana_regen_rate: 1,
  },
  {
    name: 'Cultist', color: '#7b1f3a', walkable: true, spawn_tiles: [], chance: 0,
    is_playable: true, main_stat: 'constitution',
    strength: 10, dexterity: 10, constitution: 12, intelligence: 10, wisdom: 10, charisma: 10,
    hp: 110, max_hp: 110, hp_regen_rate: 1, mana: 50, max_mana: 50, mana_regen_rate: 0.5,
  },
  {
    name: 'Archer', color: '#1e8449', walkable: true, spawn_tiles: [], chance: 0,
    is_playable: true, main_stat: 'dexterity',
    strength: 10, dexterity: 12, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10,
    hp: 85, max_hp: 85, hp_regen_rate: 1, mana: 50, max_mana: 50, mana_regen_rate: 0.5,
  },
  {
    name: 'Druid', color: '#2f7d5b', walkable: true, spawn_tiles: [], chance: 0,
    is_playable: true, main_stat: 'charisma',
    strength: 10, dexterity: 10, constitution: 10, intelligence: 10, wisdom: 10, charisma: 12,
    hp: 90, max_hp: 90, hp_regen_rate: 1, mana: 55, max_mana: 55, mana_regen_rate: 0.5,
  },
];
```

Replace the `CLASS_LOADOUTS` array (`:258-266`) with:

```js
const CLASS_LOADOUTS = [
  { class: 'Warrior', item: 'short sword', quantity: 1 },
  { class: 'Warrior', item: 'leather-vest', quantity: 1 },
  { class: 'Ranger', item: 'bow', quantity: 1 },
  { class: 'Ranger', item: 'arrow', quantity: 20 },
  { class: 'Ranger', item: 'leather-vest', quantity: 1 },
  { class: 'Mage', item: 'apprentice staff', quantity: 1 },
  { class: 'Mage', item: 'arcane-ward', quantity: 1 },
  { class: 'Monk', item: 'stick', quantity: 1 },
  { class: 'Monk', item: 'leather-vest', quantity: 1 },
  { class: 'Cultist', item: 'apprentice staff', quantity: 1 },
  { class: 'Cultist', item: 'leather-vest', quantity: 1 },
  { class: 'Archer', item: 'bow', quantity: 1 },
  { class: 'Archer', item: 'arrow', quantity: 20 },
  { class: 'Archer', item: 'leather-vest', quantity: 1 },
  { class: 'Druid', item: 'club', quantity: 1 },
  { class: 'Druid', item: 'leather-vest', quantity: 1 },
];
```

In `backend/scripts/seed-catalogs.js`, replace `seedOnePlayableClass` (`:361-374`) with:

```js
async function seedOnePlayableClass(pool, c) {
  const r = await pool.query(
    `INSERT INTO entity_types
      (name, color, walkable, spawn_tiles, chance, is_playable, main_stat,
       strength, dexterity, constitution, intelligence, wisdom, charisma,
       hp, max_hp, hp_regen_rate, mana, max_mana, mana_regen_rate)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (name) DO NOTHING`,
    [c.name, c.color, c.walkable, JSON.stringify(c.spawn_tiles), c.chance,
     // is_playable is read off the row rather than hardcoded true: the Ranger
     // entry is in this list precisely BECAUSE it must be restorable, and a
     // hardcoded true would re-open a retired class on every volume rebuild.
     c.is_playable !== false, c.main_stat || null,
     c.strength, c.dexterity, c.constitution, c.intelligence, c.wisdom, c.charisma,
     c.hp, c.max_hp, c.hp_regen_rate, c.mana, c.max_mana, c.mana_regen_rate],
  );
  return r.rowCount;
}
```

- [ ] **Step 10: Run both class tests to verify they pass**

Run:
```bash
cd /tmp/wt-classes/backend && DATABASE_URL="$SCRATCH" TEST_DATABASE_URL="$SCRATCH" \
  npx node --test tests/playable_classes_db.test.js tests/six_classes_db.test.js
```
Expected: PASS.

- [ ] **Step 11: Commit**
```bash
cd /tmp/wt-classes
git add backend/seeds/data/entityTypes.js backend/scripts/seed-catalogs.js backend/tests/playable_classes_db.test.js
git commit -m "feat(classes): seed the six classes and keep Ranger restorable but demoted (SOMET-NNN)"
```

- [ ] **Step 12: Write the failing service test for `mainStat` and `className`**

Create `backend/tests/characters_service_main_stat.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { listPlayableClasses, ownedCharacter } = require('../src/services/characters.js');

// A pool that records the SQL it was handed and replays a canned result. No
// database: these two functions are shape-mapping, and the shape is the thing
// downstream code (server.js's join path, CharacterSelect.jsx) depends on.
function fakePool(rows) {
  const seen = [];
  return {
    seen,
    query: async (sql) => { seen.push(sql); return { rows }; },
  };
}

test('listPlayableClasses carries main_stat through as mainStat', async () => {
  const pool = fakePool([
    { id: 7, name: 'Druid', color: '#2f7d5b', main_stat: 'charisma',
      hp: 90, strength: 10, dexterity: 10, constitution: 10,
      intelligence: 10, wisdom: 10, charisma: 12 },
  ]);
  const classes = await listPlayableClasses(pool);
  assert.deepEqual(classes, [{
    id: 7, name: 'Druid', color: '#2f7d5b', mainStat: 'charisma',
    hp: 90, strength: 10, dexterity: 10, constitution: 10,
    intelligence: 10, wisdom: 10, charisma: 12,
  }]);
  assert.match(pool.seen[0], /main_stat/,
    'the column has to be SELECTed, or mainStat is undefined for every class');
});

test('ownedCharacter carries the class name and main stat', async () => {
  const pool = fakePool([
    { id: 3, entity_type_id: 9, inventory_slots: 24, class_name: 'Cultist', main_stat: 'constitution' },
  ]);
  const c = await ownedCharacter(pool, 1, 3);
  assert.deepEqual(c, {
    id: 3, entityTypeId: 9, inventorySlots: 24,
    className: 'Cultist', mainStat: 'constitution',
  });
});

test('ownedCharacter still refuses a non-integer id without querying', async () => {
  const pool = fakePool([]);
  assert.equal(await ownedCharacter(pool, 1, 'nope'), null);
  assert.equal(pool.seen.length, 0);
});
```

- [ ] **Step 13: Run the test to verify it fails**

Run:
```bash
cd /tmp/wt-classes/backend && npx node --test tests/characters_service_main_stat.test.js
```
Expected: FAIL with `Expected values to be strictly deep-equal` — the returned object has no `mainStat` key.

- [ ] **Step 14: Add the two columns to `backend/src/services/characters.js`**

Replace `listPlayableClasses` (`:18-34`) with:

```js
async function listPlayableClasses(pool) {
  const r = await pool.query(
    `SELECT id, name, color, main_stat, hp,
            strength, dexterity, constitution, intelligence, wisdom, charisma
       FROM entity_types WHERE is_playable = true ORDER BY id ASC`);
  return r.rows.map((x) => ({
    id: x.id,
    name: x.name,
    color: x.color,
    // The passive tree's start position for this class (spec 5.2). The picker
    // shows it, and T7 allocates from it.
    mainStat: x.main_stat,
    hp: Number(x.hp),
    strength: Number(x.strength),
    dexterity: Number(x.dexterity),
    constitution: Number(x.constitution),
    intelligence: Number(x.intelligence),
    wisdom: Number(x.wisdom),
    charisma: Number(x.charisma),
  }));
}
```

`ORDER BY id ASC` is deliberately unchanged: `CharacterSelect.jsx:112` defaults the picker to `classes[0]`, and re-ordering here would silently change which class a player gets by pressing Create without touching the radios.

Replace the query and return in `ownedCharacter` (`:80-91`) with:

```js
  const r = await pool.query(
    `SELECT c.id, c.entity_type_id, c.inventory_slots,
            e.name AS class_name, e.main_stat
       FROM characters c
       JOIN entity_types e ON e.id = c.entity_type_id
      WHERE c.id = $1 AND c.user_id = $2`,
    [id, userId]);
  if (!r.rows.length) return null;
  // inventory_slots rides the ownership lookup rather than getting its own
  // query: the join path already needs this row, and the carry limit must be
  // in hand before the first grant path runs (see authority/items.js).
  //
  // className rides it for the same reason. The join path needs to know
  // whether this character casts with life instead of mana BEFORE addPlayer
  // builds the player object (spec 8.3), and a second round trip for one
  // string on a path that already joins entity_types is pure waste.
  return {
    id: r.rows[0].id,
    entityTypeId: r.rows[0].entity_type_id,
    inventorySlots: Number(r.rows[0].inventory_slots),
    className: r.rows[0].class_name,
    mainStat: r.rows[0].main_stat,
  };
```

- [ ] **Step 15: Run the service test plus every test that mocks this query**

Run:
```bash
cd /tmp/wt-classes/backend && DATABASE_URL="$SCRATCH" TEST_DATABASE_URL="$SCRATCH" \
  npx node --test tests/characters_service_main_stat.test.js tests/authority_items_inventory.test.js \
    tests/authority_items_loadout_db.test.js tests/authority_server.test.js
```
Expected: PASS. If a mocked pool in one of the latter three matches on `/FROM characters/` and now sees the JOIN, widen that regex rather than reverting the query.

- [ ] **Step 16: Commit**
```bash
cd /tmp/wt-classes
git add backend/src/services/characters.js backend/tests/characters_service_main_stat.test.js
git commit -m "feat(classes): expose mainStat and className from the character service (SOMET-NNN)"
```

- [ ] **Step 17: Write the failing frontend test for the class identity copy**

Create `frontend/src/games/something2/__tests__/classIdentity.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { describeClass, IDENTITY, MAIN_STAT_LABEL } from '../classIdentity.js';

// The six class names the server can send, written out by hand rather than
// imported from the module under test: importing IDENTITY's own keys to check
// IDENTITY's coverage would pass against an empty object.
const PLAYABLE = ['Warrior', 'Mage', 'Monk', 'Cultist', 'Archer', 'Druid'];

describe('classIdentity', () => {
  it('has an identity line for every playable class', () => {
    for (const name of PLAYABLE) {
      expect(typeof IDENTITY[name], `${name} needs a line`).toBe('string');
      expect(IDENTITY[name].length).toBeGreaterThan(0);
    }
  });

  it('labels all six stats', () => {
    expect(MAIN_STAT_LABEL).toEqual({
      strength: 'STR',
      dexterity: 'DEX',
      constitution: 'CON',
      intelligence: 'INT',
      wisdom: 'WIS',
      charisma: 'CHA',
    });
  });

  it('renders the main stat and the identity line together', () => {
    expect(describeClass({ name: 'Cultist', mainStat: 'constitution' }))
      .toBe('CON · Casts with life instead of mana.');
    expect(describeClass({ name: 'Druid', mainStat: 'charisma' }))
      .toBe('CHA · Charms creatures to fight alongside them.');
  });

  it('degrades visibly rather than silently on an unknown class', () => {
    expect(describeClass({ name: 'Necromancer', mainStat: null }))
      .toBe('— · No description yet.');
  });

  it('returns an empty string for a missing class object', () => {
    expect(describeClass(null)).toBe('');
    expect(describeClass({})).toBe('');
  });
});
```

- [ ] **Step 18: Run the test to verify it fails**

Run:
```bash
cd /tmp/wt-classes/frontend && npx vitest run src/games/something2/__tests__/classIdentity.test.js
```
Expected: FAIL with `Failed to resolve import "../classIdentity.js"`.

- [ ] **Step 19: Write `frontend/src/games/something2/classIdentity.js`**

```js
// Per-class copy for the character picker.
//
// A separate module rather than literals inside CharacterSelect.jsx because
// vitest runs in a node environment here and that component cannot be rendered
// in a test at all -- the same reason characterSession.js exists. Everything in
// the picker worth asserting lives in a plain module; the JSX only arranges it.

export const MAIN_STAT_LABEL = {
  strength: 'STR',
  dexterity: 'DEX',
  constitution: 'CON',
  intelligence: 'INT',
  wisdom: 'WIS',
  charisma: 'CHA',
};

// Keyed by the class NAME the server sends on /api/characters/classes. One
// line, describing what the class does differently -- not its stat spread,
// which the picker already shows.
export const IDENTITY = {
  Warrior: 'Hits hardest in melee.',
  Mage: 'Largest mana pool and the strongest spells.',
  Monk: 'Regenerates mana fastest.',
  Cultist: 'Casts with life instead of mana.',
  Archer: 'Attacks fastest.',
  Druid: 'Charms creatures to fight alongside them.',
};

// A class the client has no copy for renders as an em dash and a visible
// "No description yet." rather than an empty cell: an unknown class is a server
// the client is out of date with, and that should look wrong instead of looking
// like a class with nothing interesting about it.
export function describeClass(cls) {
  if (!cls || typeof cls.name !== 'string' || cls.name.length === 0) return '';
  const stat = MAIN_STAT_LABEL[cls.mainStat] || '—';
  return `${stat} · ${IDENTITY[cls.name] || 'No description yet.'}`;
}
```

- [ ] **Step 20: Run the test to verify it passes**

Run:
```bash
cd /tmp/wt-classes/frontend && npx vitest run src/games/something2/__tests__/classIdentity.test.js
```
Expected: PASS, 5 tests.

- [ ] **Step 21: Render all six classes in `CharacterSelect.jsx`**

Add the import after line 4:

```js
import { describeClass } from './classIdentity.js';
```

Replace the class fieldset (`:171-185`) with:

```js
          <fieldset disabled={!roomLeft}>
            <legend className="why">Class</legend>
            {(classes || []).map((cls) => (
              <label key={cls.id}>
                <input
                  type="radio"
                  name="character-class"
                  value={cls.id}
                  checked={chosenClass === cls.id}
                  onChange={() => setEntityTypeId(cls.id)}
                />
                <span>
                  {cls.name}{' '}
                  <span className="why">({cls.hp} hp) {describeClass(cls)}</span>
                </span>
              </label>
            ))}
          </fieldset>
```

Six radios no longer fit one row, so widen the fieldset in the `Form` styled-component (`:95`), replacing that line with:

```js
  fieldset { border: 0; display: grid; grid-template-columns: 1fr; gap: 0.8rem; }
```

All colours here are existing `--color-*` tokens; no new literal is introduced, so `themeTokens.test.js` stays green.

- [ ] **Step 22: Run the frontend suite and the lint gate**

Run:
```bash
cd /tmp/wt-classes/frontend && npx vitest run && npm run lint
```
Expected: PASS both.

- [ ] **Step 23: Browser-verify the picker**

Bring the dev stack up against the scratch DB, register a fresh account, and open the character gate. Confirm: six radios, one per class; each shows its hp and a `STR ·`-style main-stat line; `Ranger` does **not** appear; an existing Ranger character still lists and still plays. Capture one screenshot of the picker.

- [ ] **Step 24: Commit**
```bash
cd /tmp/wt-classes
git add frontend/src/games/something2/classIdentity.js \
        frontend/src/games/something2/__tests__/classIdentity.test.js \
        frontend/src/games/something2/CharacterSelect.jsx
git commit -m "feat(classes): show all six classes with their main stat in the picker (SOMET-NNN)"
```

---

### Task 2: The Cultist pays mana costs in life

**Files:**
- Create: `backend/src/services/lifeCost.js`
- Create: `backend/tests/life_cost.test.js`
- Create: `backend/tests/authority_life_cost_gate.test.js`
- Modify: `backend/src/authority/world.js:1-16` (require), `:51-62` (new helpers), `:158-205` (addPlayer), `:394-406` (canAttack), `:412-428` (attack's gate), `:442-443` and `:624-625` (the two spends)
- Modify: `backend/src/authority/server.js:1431-1459` (derive the flag, pass it to addPlayer), `:1515-1537` (the `joined` frame)
- Modify: `frontend/src/games/something2/src/js/core/Game.js:422-433` (onJoined), `:873-874` (the HUD call)

**Interfaces:**
- Consumes: `ownedCharacter(...) -> { …, className }` from Task 1 Step 14.
- Produces (contract §2, exactly):
```js
// backend/src/services/lifeCost.js  — PURE
const LIFE_COST_RATIO = 0.6;
function lifeCostFor(manaCost, lifeCostMultiplier = 1) // -> integer >= 0
function canPayLife(currentHp, cost)                   // -> boolean
module.exports = { LIFE_COST_RATIO, lifeCostFor, canPayLife };
```
  Plus, inside `world.js` (not exported): `resourceRefusal(p, w) -> null | 'stamina' | 'mana' | 'life'` and `spendResources(p, w) -> void`; and on the player object, `usesLifeCost: boolean` and `lifeCostMultiplier: number` (T7's `Blood Pact` keystone is the only thing that will ever write the latter).
  On the wire: the `joined` frame gains `usesLifeCost: boolean`.

---

- [ ] **Step 1: Write the failing pure test**

Create `backend/tests/life_cost.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { LIFE_COST_RATIO, lifeCostFor, canPayLife } = require('../src/services/lifeCost.js');

// Every expectation below is a hand-computed literal. Writing
// `Math.ceil(cost * LIFE_COST_RATIO)` here would assert that the module equals
// itself -- the dominant vacuous-test shape in this repo.
test('LIFE_COST_RATIO is the specced 0.6', () => {
  assert.equal(LIFE_COST_RATIO, 0.6);
});

test('lifeCostFor rounds up, so a cheap spell is never free', () => {
  assert.equal(lifeCostFor(1), 1);
  assert.equal(lifeCostFor(5), 3);
  assert.equal(lifeCostFor(8), 5);    // the apprentice staff
  assert.equal(lifeCostFor(10), 6);
  assert.equal(lifeCostFor(15), 9);
  assert.equal(lifeCostFor(16), 10);  // the frost staff
  assert.equal(lifeCostFor(18), 11);  // the flame staff
  assert.equal(lifeCostFor(24), 15);  // the storm staff
  assert.equal(lifeCostFor(32), 20);  // the archmage staff
});

test('a zero or absent mana cost costs no life', () => {
  assert.equal(lifeCostFor(0), 0);
  assert.equal(lifeCostFor(undefined), 0);
  assert.equal(lifeCostFor(null), 0);
  assert.equal(lifeCostFor(-4), 0);
});

test('the tree multiplier scales the cost and still rounds up', () => {
  assert.equal(lifeCostFor(8, 0.75), 4);
  assert.equal(lifeCostFor(24, 0.75), 11);
  // A missing, zero or nonsense multiplier means "no discount", never "free".
  assert.equal(lifeCostFor(8, 0), 5);
  assert.equal(lifeCostFor(8, NaN), 5);
});

test('a cast that would leave the caster below 1 hp cannot be paid', () => {
  assert.equal(canPayLife(6, 5), true);   // lands on exactly 1
  assert.equal(canPayLife(5, 5), false);  // would land on 0
  assert.equal(canPayLife(4, 5), false);  // would land below 0
  assert.equal(canPayLife(100, 24), true);
  assert.equal(canPayLife(1, 0), true);   // a free cast at 1 hp is fine
});

test('a non-finite pool or cost refuses rather than casting', () => {
  assert.equal(canPayLife(NaN, 5), false);
  assert.equal(canPayLife(10, NaN), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd /tmp/wt-classes/backend && npx node --test tests/life_cost.test.js
```
Expected: FAIL with `Cannot find module '../src/services/lifeCost.js'`.

- [ ] **Step 3: Write `backend/src/services/lifeCost.js`**

```js
// The Cultist's resource substitution (spec 8.3). PURE -- no database, no
// clock, no randomness -- for the same reason playerStats.js is: the caller
// owns the state, this module owns the arithmetic.
//
// SCOPE. This module decides HOW MUCH life a cast costs and WHETHER it can be
// paid. It deliberately does not decide WHO pays in life: that is one flag on
// the player object, resolved once at join, and read at the single cost gate in
// authority/world.js. Two gates is exactly what spec 8.3 forbids.

const LIFE_COST_RATIO = 0.6;

// Rounded UP, never down. A 1-mana spell rounding to 0 would make the whole
// cheap end of the catalog free for exactly one class, and free casting is not
// a discount, it is a different game.
//
// `lifeCostMultiplier` is lowered by the CON keystone "Blood Pact" in the
// passive tree (group C, T7). Anything non-finite or non-positive resolves to
// 1: a NULL arriving from a future DB-backed modifier must mean "no discount",
// never "no cost".
function lifeCostFor(manaCost, lifeCostMultiplier = 1) {
  const cost = Number(manaCost);
  if (!Number.isFinite(cost) || cost <= 0) return 0;
  const raw = Number(lifeCostMultiplier);
  const mult = Number.isFinite(raw) && raw > 0 ? raw : 1;
  return Math.ceil(cost * LIFE_COST_RATIO * mult);
}

// A cast that would leave the cultist below 1 HP is REFUSED, not lethal
// (spec 8.3).
//
// The bound is `>= 1`, not `> 0`, and that is not a rounding preference: hp is
// a float on the live path (resistances, shock's +25% vulnerability and AoE
// falloff all produce fractions), so `> 0` would happily leave a caster on
// 0.4 hp -- alive by the comparison, dead to the next burn tick, and killed by
// their own spell either way.
//
// A non-finite input refuses. A NaN hp pool means something upstream is already
// broken, and casting into that state would turn a visible bug into a dead
// character.
function canPayLife(currentHp, cost) {
  const hp = Number(currentHp);
  const c = Number(cost);
  if (!Number.isFinite(hp) || !Number.isFinite(c)) return false;
  return hp - c >= 1;
}

module.exports = { LIFE_COST_RATIO, lifeCostFor, canPayLife };
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd /tmp/wt-classes/backend && npx node --test tests/life_cost.test.js
```
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**
```bash
cd /tmp/wt-classes
git add backend/src/services/lifeCost.js backend/tests/life_cost.test.js
git commit -m "feat(classes): pure life-cost arithmetic for the Cultist (SOMET-NNN)"
```

- [ ] **Step 6: Write the failing authority test — REQUIRED COVERAGE (a)**

Create `backend/tests/authority_life_cost_gate.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');

function stubMap() {
  return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8, getChunk: () => [] };
}

// The apprentice staff, as 1714440019000 authored it. mana_cost 8, so a
// Cultist pays ceil(8 * 0.6) = 5 hp -- written out here rather than computed,
// so this file cannot agree with a broken lifeCostFor.
const STAFF = {
  id: 1, name: 'apprentice staff', category: 'weapon', kind: 'projectile',
  damage: 10, cooldown: 0.55, range: 500, projectile_speed: 650,
  projectile_radius: 10, pierce: 1, mana_cost: 8, stamina_cost: 0, element: 'arcane',
};
const TYPES = new Map([[1, STAFF]]);
const INV = { items: [{ id: 'i1', typeId: 1 }], equipment: { main_hand: 'i1' } };

function armed(usesLifeCost, hp) {
  const w = new World(stubMap(), TYPES, 1);
  w.addPlayer('u1', { x: 100, y: 100 }, INV, { x: 100, y: 100 }, 0, undefined, 1, null, usesLifeCost);
  const p = w.getPlayer('u1');
  p.hp = hp;
  return { w, p };
}

test('a cultist cast that would be lethal is refused AND costs nothing', () => {
  // 5 hp against a 5 hp cost: the cast would land them on 0, which spec 8.3
  // refuses rather than allowing.
  const { w, p } = armed(true, 5);
  const before = { hp: p.hp, mana: p.mana, stamina: p.stamina, cd: p._attackCd };

  assert.equal(w.canAttack('u1').ok, false, 'the pre-check must refuse it too, or ammo is spent on it');
  const r = w.attack('u1', 1, 0);

  assert.deepEqual(r.kills, []);
  assert.equal(w.projectiles.count(), 0, 'a refused cast must not put a projectile in the air');
  assert.deepEqual(
    { hp: p.hp, mana: p.mana, stamina: p.stamina, cd: p._attackCd }, before,
    'a refused cast costs nothing: not life, not mana, not stamina, not the cooldown');
});

test('a cultist cast they can just afford is paid in life, never in mana', () => {
  const { w, p } = armed(true, 6);   // 6 - 5 = 1, the floor exactly
  const manaBefore = p.mana;
  w.attack('u1', 1, 0);
  assert.equal(p.hp, 1);
  assert.equal(p.mana, manaBefore, 'a cultist never spends mana');
  assert.equal(w.projectiles.count(), 1);
});

test('the identical cast on a non-cultist is paid in mana, never in life', () => {
  const { w, p } = armed(false, 100);
  const maxMana = p.maxMana;
  w.attack('u1', 1, 0);
  assert.equal(p.hp, 100, 'a mana caster must not lose hp to their own spell');
  assert.equal(p.mana, maxMana - 8);
  assert.equal(w.projectiles.count(), 1);
});

test('a cultist with plenty of life casts repeatedly, paying 5 each time', () => {
  const { w, p } = armed(true, 100);
  w.attack('u1', 1, 0);
  assert.equal(p.hp, 95);
  p._attackCd = 0;               // skip the cooldown; this test is about cost
  w.attack('u1', 1, 0);
  assert.equal(p.hp, 90);
});

test('a free weapon is unaffected for either class', () => {
  const FREE = new Map([[2, {
    id: 2, name: 'club', category: 'weapon', kind: 'melee',
    damage: 10, cooldown: 0.45, reach: 85, arc_width: 0.8, mana_cost: 0, stamina_cost: 2, element: null,
  }]]);
  const w = new World(stubMap(), FREE, 2);
  w.addPlayer('u1', { x: 100, y: 100 }, { items: [], equipment: {} }, { x: 100, y: 100 },
    0, undefined, 1, null, true);
  const p = w.getPlayer('u1');
  p.hp = 3;                      // below any life cost, but there is none
  w.attack('u1', 1, 0);
  assert.equal(p.hp, 3);
  assert.equal(p.stamina, p.maxStamina - 2);
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run:
```bash
cd /tmp/wt-classes/backend && npx node --test tests/authority_life_cost_gate.test.js
```
Expected: FAIL on the first test with `expected false to equal ... ok: true` — `addPlayer` ignores the ninth argument today, so the cultist is treated as a mana caster and the cast is allowed.

- [ ] **Step 8: Add the one resource gate to `backend/src/authority/world.js`**

Add the require after line 15:

```js
const { lifeCostFor, canPayLife } = require('../services/lifeCost.js');
```

Insert after `applyAttackCooldown` (`:62`):

```js
// THE ONE ATTACK RESOURCE GATE (spec 8.3: "the check lives in the same place
// the mana check does today, so there is one cost gate, not two").
//
// Both canAttack -- the pre-check server.js runs BEFORE it spends ammo -- and
// attack itself call this. Two hand-written copies of the rule is exactly how a
// class could end up unable to fire but still losing an arrow.
//
// Returns null when the attack is affordable, or the name of the resource that
// refused it. A refusal costs NOTHING: no resource is touched, no cooldown is
// stamped. That has always been mana's rule here and it now covers life too.
function resourceRefusal(p, w) {
  if (p.stamina < (w.stamina_cost || 0)) return 'stamina';
  const manaCost = w.mana_cost || 0;
  if (manaCost <= 0) return null;
  if (p.usesLifeCost) {
    return canPayLife(p.hp, lifeCostFor(manaCost, p.lifeCostMultiplier)) ? null : 'life';
  }
  return p.mana < manaCost ? 'mana' : null;
}

// The matching spend. Called ONLY after resourceRefusal returned null, and
// deliberately adjacent to it: a spend that could pick a different pool from
// the check is a way to cast for free.
function spendResources(p, w) {
  const staminaCost = w.stamina_cost || 0;
  if (staminaCost) p.stamina -= staminaCost;
  const manaCost = w.mana_cost || 0;
  if (!manaCost) return;
  if (p.usesLifeCost) p.hp -= lifeCostFor(manaCost, p.lifeCostMultiplier);
  else p.mana -= manaCost;
}
```

Change the `addPlayer` signature (`:158`) to:

```js
  addPlayer(userId, spawn, inv = { items: [], equipment: {} }, respawn = spawn, gold = 0, stats = BASE_STATS, characterId = null, bind = null, usesLifeCost = false) {
```

and add two fields to the object it sets, immediately after `stats,` (`:203`):

```js
      // Spec 8.3 -- the Cultist pays every item_types.mana_cost in HP instead.
      // Resolved once at join from the character's class name (server.js) and
      // read ONLY by resourceRefusal/spendResources above, so no other site in
      // the sim branches on class. Defaults false, so every existing caller --
      // and every test that builds a player -- behaves exactly as before.
      usesLifeCost: usesLifeCost === true,
      // Lowered by the CON keystone "Blood Pact" (group C, T7). 1 until then;
      // lifeCostFor treats anything non-positive as 1, so a bad write here
      // cannot make casting free.
      lifeCostMultiplier: 1,
```

Replace the mana/stamina check in `canAttack` (`:402-404`) with:

```js
    if (resourceRefusal(p, w)) return { ok: false, weapon: w };
```

Replace the cost block in `attack` (`:423-428`) with:

```js
    // Both resources are checked BEFORE either is spent, and a denied attack
    // does NOT consume the cooldown. resourceRefusal is the same call
    // canAttack makes, so the pre-check and the real check cannot disagree.
    if (resourceRefusal(p, w)) return { kills: [], attacks: [], impacts: [], stoneHit: null };
```

Replace the melee spend (`:442-443`) with:

```js
      spendResources(p, w);
```

Replace the projectile spend (`:624-625`) with:

```js
    spendResources(p, w);
```

- [ ] **Step 9: Run the gate test and every existing combat test to verify they pass**

Run:
```bash
cd /tmp/wt-classes/backend && npx node --test tests/authority_life_cost_gate.test.js \
  tests/authority_world_combat.test.js tests/authority_combat_integration.test.js \
  tests/authority_ammo.test.js tests/authority_player_stats.test.js
```
Expected: PASS. The pre-existing files must be green unchanged — `usesLifeCost` defaults to `false`, so nothing without a Cultist changes behaviour.

- [ ] **Step 10: Commit**
```bash
cd /tmp/wt-classes
git add backend/src/authority/world.js backend/tests/authority_life_cost_gate.test.js
git commit -m "feat(classes): pay mana costs in life at the single attack gate (SOMET-NNN)"
```

- [ ] **Step 11: Wire the flag through the join path in `backend/src/authority/server.js`**

Insert immediately after the `stats` line (`:1438`):

```js
        // Spec 8.3. ONE derivation, read twice below -- once for the sim and
        // once for the wire -- so the server and the client can never disagree
        // about which bar to spend and which bar to draw.
        //
        // Keyed on the class NAME rather than on main_stat: main_stat is the
        // passive tree's start position and two classes could legitimately
        // share one, while the life-cost substitution is a fact about the
        // Cultist specifically.
        const usesLifeCost = character.className === 'Cultist';
```

Replace the `addPlayer` call (`:1459`) with:

```js
        entry.world.addPlayer(ws.userId, spawn, inv, spawn.respawn, gold, stats, character.id, spawn.bind, usesLifeCost);
```

Add one key to the `joined` frame, immediately after `progression,` (`:1537`):

```js
          // Presentation only: the client hides the MP readout for a life-cost
          // class. The rule that actually spends the pool runs server-side, in
          // world.js's resourceRefusal/spendResources.
          usesLifeCost,
```

- [ ] **Step 12: Hide the mana readout for a life-cost class in `frontend/src/games/something2/src/js/core/Game.js`**

In `onJoined` (`:422-433`), add after `this.progression = msg.progression || null;`:

```js
                    // Spec 8.3 -- a Cultist has a mana pool the server never
                    // spends, so drawing it would be an inert bar the player
                    // learns to ignore. Server-supplied, never inferred from
                    // the class name here: the client has no class catalog.
                    this.usesLifeCost = msg.usesLifeCost === true;
```

In the `renderChunked` call (`:873-874`), replace the two lines with:

```js
                mana: this.usesLifeCost ? null : this.localMana,
                maxMana: this.usesLifeCost ? null : this.localMaxMana,
```

`RenderSystem.renderHud` already omits the `MP:` line when `mana` is `null` (`RenderSystem.js:1163`), so no renderer change is needed and no other HUD row moves.

- [ ] **Step 13: Run the frontend suite and lint**

Run:
```bash
cd /tmp/wt-classes/frontend && npx vitest run && npm run lint
```
Expected: PASS.

- [ ] **Step 14: Browser-verify the Cultist**

Create a Cultist, join a world, equip the starting apprentice staff and fire it. Confirm: the HUD shows **no** `MP:` row; each shot drops `HP:` by exactly 5; at 5 hp or below the staff stops firing entirely (no projectile, no cooldown flash) instead of killing the character. Then create a Mage and confirm the `MP:` row is back and hp does not move when casting.

- [ ] **Step 15: Commit**
```bash
cd /tmp/wt-classes
git add backend/src/authority/server.js frontend/src/games/something2/src/js/core/Game.js
git commit -m "feat(classes): send usesLifeCost on join and hide the Cultist mana bar (SOMET-NNN)"
```

---

### Task 3: Druid charm — creature control transfer, summon budget, player pacify

**Files:**
- Create: `backend/migrations/1714440403000_charm_and_summons.js`
- Create: `backend/src/services/charm.js`
- Create: `backend/tests/charm_budget.test.js`
- Create: `backend/tests/authority_charm_player.test.js`
- Create: `backend/tests/authority_charm_creature.test.js`
- Create: `backend/tests/charm_summons_db.test.js`
- Modify: `backend/src/authority/effects.js:52-58` (the new key), `:105` onward (the new section), `:309-334` (exports)
- Modify: `backend/src/authority/creatures.js:461-463` (the pacify predicate), `:1125-1182` (addCreatures), `:1198-1250` (the charmed branch), `:1986-1996` and `:2018-2044` (the melee arc)
- Modify: `backend/src/authority/world.js:299-309` (the soft repel), `:412-430` (resolve the pacify once), `:451-453` and `:493-499` (pass it to the arc), `:524-528` (the player sweep), `:626-638` (pass it to the shot)
- Modify: `backend/src/authority/projectiles.js:54-59` and `:131-135` (the two hit tests), `:182-185` (spawn)
- Modify: `backend/src/authority/server.js:1878-1893` (a new `charm` handler beside `autoloot`)

**Interfaces:**
- Consumes: `ownedCharacter(...) -> { …, className }` (Task 1); `World.attack`'s `pacifiedFrom` resolution shares the shape Task 2 established for a per-attack constant.
- Produces (contract §2, exactly):
```js
// backend/src/services/charm.js — PURE
function charmBudget(effectiveCharisma, treeCharmBonus) // -> Math.floor(cha / 2) + bonus
function canSummon(activeSummonLevels, candidateLevel, budget) // -> { ok, reason }
const PLAYER_CHARM_MS = 4000;
const PLAYER_CHARM_IMMUNITY_MS = 8000;
module.exports = { charmBudget, canSummon, PLAYER_CHARM_MS, PLAYER_CHARM_IMMUNITY_MS };
```
  Plus, from `authority/effects.js`: `CHARMED = 'charmed'`, `applyCharm(target, charmerUserId, now) -> boolean`, `charmerOf(target, now) -> userId | null`.
  On creature instances: `charmOwnerUserId: number|null`, `charmedByCharacterId: number|null`, `charmExpiresAt: number` (world-clock ms), `baseFaction: string`.
  On the player object: `_charmTargetId: string|null` — the creature id this player last landed a hit on, which is what their summons attack.
  SQL: `world_creatures.charmed_by_character_id`, `world_creatures.charm_expires_at`, table `character_summons`.
  Websocket inbound: `{ type: 'charm', creature_id }`.

---

- [ ] **Step 1: Write the failing budget test — REQUIRED COVERAGE (b)**

Create `backend/tests/charm_budget.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const {
  charmBudget, canSummon, PLAYER_CHARM_MS, PLAYER_CHARM_IMMUNITY_MS,
} = require('../src/services/charm.js');

// Hand-written literals throughout. `Math.floor(cha / 2) + bonus` recomputed in
// the assertion would prove only that the expression parses.
test('charmBudget is half of effective charisma, floored, plus the tree bonus', () => {
  assert.equal(charmBudget(10, 0), 5);
  assert.equal(charmBudget(11, 0), 5);   // floored, not rounded
  assert.equal(charmBudget(40, 0), 20);  // spec 8.2's worked example
  assert.equal(charmBudget(40, 3), 23);
  assert.equal(charmBudget(1, 0), 0);    // below 2 CHA you hold nothing
  assert.equal(charmBudget(0, 0), 0);
});

test('a nonsense charisma or bonus degrades to zero rather than to NaN', () => {
  assert.equal(charmBudget(NaN, 0), 0);
  assert.equal(charmBudget(-5, 0), 0);
  assert.equal(charmBudget(10, NaN), 5);
  assert.equal(charmBudget(10, undefined), 5);
});

test('the SUM of active summon levels is what the budget bounds', () => {
  // Spec 8.2: a level-40 druid (budget 20) holds one level-20 creature...
  assert.deepEqual(canSummon([], 20, 20), { ok: true, reason: null });
  assert.deepEqual(canSummon([20], 1, 20), { ok: false, reason: 'over_budget' });
  // ...or four level-5 ones, and not a fifth.
  assert.deepEqual(canSummon([5, 5, 5], 5, 20), { ok: true, reason: null });
  assert.deepEqual(canSummon([5, 5, 5, 5], 1, 20), { ok: false, reason: 'over_budget' });
});

test('a swarm of level-1 creatures is bounded too', () => {
  // The whole point of summing rather than counting: 20 level-1 creatures fill
  // a budget of 20 exactly, and the 21st is refused.
  const twenty = new Array(20).fill(1);
  assert.deepEqual(canSummon(twenty, 1, 20), { ok: false, reason: 'over_budget' });
  assert.deepEqual(canSummon(twenty.slice(0, 19), 1, 20), { ok: true, reason: null });
});

test('a level below 1 is refused before the budget is consulted', () => {
  assert.deepEqual(canSummon([], 0, 20), { ok: false, reason: 'bad_level' });
  assert.deepEqual(canSummon([], -3, 20), { ok: false, reason: 'bad_level' });
  assert.deepEqual(canSummon([], NaN, 20), { ok: false, reason: 'bad_level' });
});

test('the player charm is short and its immunity window is longer than it', () => {
  assert.equal(PLAYER_CHARM_MS, 4000);
  assert.equal(PLAYER_CHARM_IMMUNITY_MS, 8000);
  assert.ok(PLAYER_CHARM_IMMUNITY_MS > PLAYER_CHARM_MS,
    'an immunity window no longer than the effect would let a second charm land the instant the first expired -- a chain-lock with extra steps');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd /tmp/wt-classes/backend && npx node --test tests/charm_budget.test.js
```
Expected: FAIL with `Cannot find module '../src/services/charm.js'`.

- [ ] **Step 3: Write `backend/src/services/charm.js`**

```js
// The Druid's charm rules (spec 8.2). PURE -- no database, no clock, no
// randomness -- matching charm's siblings (playerStats.js, lifeCost.js).

// A creature costs its LEVEL against the budget, and the budget bounds the SUM
// of what is held rather than the count: "a level-40 druid can hold one
// level-20 creature or four level-5 ones" (spec 8.2). Halved charisma, floored,
// so an odd CHA never buys a fractional creature.
function charmBudget(effectiveCharisma, treeCharmBonus = 0) {
  const cha = Number(effectiveCharisma);
  const base = Number.isFinite(cha) && cha > 0 ? Math.floor(cha / 2) : 0;
  const bonus = Number(treeCharmBonus);
  return base + (Number.isFinite(bonus) ? Math.trunc(bonus) : 0);
}

// `activeSummonLevels` is the level of every summon the druid is ALREADY
// holding; `candidateLevel` is the one being added.
//
// The comparison is on the TOTAL, deliberately. A per-creature check ("is this
// one within budget?") would pass for every level-1 creature forever, and the
// budget's whole purpose is to stop an unbounded swarm -- the failure mode a
// count-based or per-item rule ships green.
function canSummon(activeSummonLevels, candidateLevel, budget) {
  const cand = Number(candidateLevel);
  if (!Number.isFinite(cand) || cand < 1) return { ok: false, reason: 'bad_level' };
  const levels = Array.isArray(activeSummonLevels) ? activeSummonLevels : [];
  let held = 0;
  for (const l of levels) {
    const n = Number(l);
    if (Number.isFinite(n) && n > 0) held += n;
  }
  const cap = Number(budget);
  if (!Number.isFinite(cap) || held + cand > cap) return { ok: false, reason: 'over_budget' };
  return { ok: true, reason: null };
}

// The PLAYER pacify (spec 8.2), and the window that follows it.
//
// PLAYER_CHARM_IMMUNITY_MS MUST exceed PLAYER_CHARM_MS. It is what guarantees
// the pacified player 4 seconds of freedom per charm no matter how many druids
// are aiming at them, and it is also what makes it safe to store the charm in
// effects.js's refresh-semantics Map at all: a second charm can never reach
// applyEffect while the first is still live. See applyCharm's comment in
// authority/effects.js, which spells out the shock-interrupt precedent this
// follows.
const PLAYER_CHARM_MS = 4000;
const PLAYER_CHARM_IMMUNITY_MS = 8000;

module.exports = { charmBudget, canSummon, PLAYER_CHARM_MS, PLAYER_CHARM_IMMUNITY_MS };
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd /tmp/wt-classes/backend && npx node --test tests/charm_budget.test.js
```
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**
```bash
cd /tmp/wt-classes
git add backend/src/services/charm.js backend/tests/charm_budget.test.js
git commit -m "feat(classes): pure charm budget and player-charm durations (SOMET-NNN)"
```

- [ ] **Step 6: Write the failing player-charm test — REQUIRED COVERAGE (c)**

Create `backend/tests/authority_charm_player.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');
const {
  CHARMED, applyCharm, charmerOf, activeEffectKeys,
} = require('../src/authority/effects.js');

function stubMap() {
  return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8, getChunk: () => [] };
}

const HALBERD = {
  id: 2, name: 'halberd', category: 'weapon', kind: 'melee', damage: 18,
  cooldown: 0.9, reach: 190, arc_width: 1.8, mana_cost: 0, stamina_cost: 0,
  element: null, knockback: 0, vfx: { attack: 'sweep_arc' },
};
const TYPES = new Map([[2, HALBERD]]);
const INV = { items: [{ id: 'i2', typeId: 2 }], equipment: { main_hand: 'i2' } };

test('a charmed player cannot be chain-locked by repeated charms', () => {
  const victim = {};
  // The first charm lands.
  assert.equal(applyCharm(victim, 'druid', 0), true);
  assert.equal(charmerOf(victim, 0), 'druid');
  // Nine more charms across the whole 4s duration all bounce off the window,
  // and NONE of them extends anything.
  for (let t = 100; t <= 3900; t += 400) {
    assert.equal(applyCharm(victim, 'druid', t), false, `a charm at ${t}ms must not land`);
  }
  // At 4000ms the charm is over even though it was hammered throughout.
  assert.equal(charmerOf(victim, 4000), null);
  // And it stays over until the immunity window itself lapses at 8000ms.
  assert.equal(applyCharm(victim, 'druid', 7999), false);
  assert.equal(charmerOf(victim, 7999), null);
  // Only then may a second charm land.
  assert.equal(applyCharm(victim, 'druid', 8001), true);
  assert.equal(charmerOf(victim, 8001), 'druid');
});

test('a second druid cannot land a charm inside the first druid\'s window either', () => {
  const victim = {};
  assert.equal(applyCharm(victim, 'druidA', 0), true);
  assert.equal(applyCharm(victim, 'druidB', 10), false,
    'the window is per-TARGET, not per-caster: per-caster windows are two druids taking turns forever');
  assert.equal(charmerOf(victim, 10), 'druidA');
});

test('the charm is broadcast as an ordinary effect key', () => {
  const victim = {};
  applyCharm(victim, 'druid', 0);
  assert.deepEqual(activeEffectKeys(victim, 1000), [CHARMED]);
  assert.equal(activeEffectKeys(victim, 5000), null);
});

test('a charmed player cannot damage the druid who charmed them', () => {
  const w = new World(stubMap(), TYPES, 2);
  // The druid at (100,100) and their victim at (160,100): well inside a
  // halberd's 190px reach, aiming due east from the victim would be backwards,
  // so the VICTIM stands west and swings east into the druid.
  w.addPlayer('druid', { x: 260, y: 100 });
  w.addPlayer('victim', { x: 100, y: 100 }, INV);
  const druid = w.getPlayer('druid');
  const victim = w.getPlayer('victim');
  applyCharm(victim, 'druid', w.now);

  const hpBefore = druid.hp;
  const r = w.attack('victim', 1, 0);
  assert.equal(druid.hp, hpBefore, 'the charmer takes nothing from a pacified swing');
  assert.deepEqual(r.impacts, [], 'and gets no hit feedback for a blow that never landed');
});

test('a charmed player still damages everyone who is NOT their charmer', () => {
  const w = new World(stubMap(), TYPES, 2);
  w.addPlayer('druid', { x: 260, y: 100 });
  w.addPlayer('bystander', { x: 260, y: 160 });
  w.addPlayer('victim', { x: 100, y: 100 }, INV);
  const victim = w.getPlayer('victim');
  const bystander = w.getPlayer('bystander');
  applyCharm(victim, 'druid', w.now);

  const hpBefore = bystander.hp;
  w.attack('victim', 1, 0);
  assert.ok(bystander.hp < hpBefore,
    'a pacify protects the charmer, not the whole world: this is not a stun');
});

test('a charmed player keeps their own movement input', () => {
  const w = new World(stubMap(), TYPES, 2);
  w.addPlayer('druid', { x: 100, y: 100 });
  w.addPlayer('victim', { x: 1000, y: 1000 }, INV);
  const victim = w.getPlayer('victim');
  applyCharm(victim, 'druid', w.now);

  w.setInput('victim', 1, 1, 0);   // walking east, away from the druid
  const xBefore = victim.x;
  w.tick(0.05);
  assert.ok(victim.x > xBefore,
    'no control transfer: the charm never suppresses the target\'s own input');
});

test('a charmed player is softly repelled from the druid', () => {
  const w = new World(stubMap(), TYPES, 2);
  w.addPlayer('druid', { x: 500, y: 500 });
  w.addPlayer('victim', { x: 560, y: 500 }, INV);
  const victim = w.getPlayer('victim');
  applyCharm(victim, 'druid', w.now);

  w.setInput('victim', 1, 0, 0);   // standing still
  const xBefore = victim.x;
  w.tick(0.05);
  assert.ok(victim.x > xBefore, 'the repel pushes AWAY from the charmer, not toward');
});

test('a charmed player never becomes a summon', () => {
  const w = new World(stubMap(), TYPES, 2);
  w.addPlayer('druid', { x: 500, y: 500 });
  w.addPlayer('victim', { x: 560, y: 500 }, INV);
  const victim = w.getPlayer('victim');
  applyCharm(victim, 'druid', w.now);
  w.tick(0.05);

  // The summon roster is a CREATURE concept and nothing about a charmed player
  // may leak into it. These are the exact fields CreatureSim reads to decide
  // that something is a pet.
  assert.equal(victim.charmOwnerUserId, undefined);
  assert.equal(victim.charmedByCharacterId, undefined);
  assert.equal(w.creatures.count(), 0,
    'a pacified PLAYER must never appear in the creature sim');
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run:
```bash
cd /tmp/wt-classes/backend && npx node --test tests/authority_charm_player.test.js
```
Expected: FAIL with `TypeError: applyCharm is not a function`.

- [ ] **Step 8: Add the charm effect to `backend/src/authority/effects.js`**

Add the require at the top of the file, above `const BURN = 'burn';`:

```js
const { PLAYER_CHARM_MS, PLAYER_CHARM_IMMUNITY_MS } = require('../services/charm.js');
```

Add the key beside the other three (`:52-54`):

```js
const CHARMED = 'charmed';
```

Insert this block immediately after `clearInterrupt` (`:264`):

```js
// THE SECOND EXCEPTION TO THE REFRESH RULE: the Druid's charm on a PLAYER.
//
// This is the shock interrupt's rule applied to a second control-affecting
// effect, and for precisely the reason the shock note at the top of this file
// gives at length: under sustained application, a REFRESHED effect is a
// PERMANENT effect. A druid re-charming every second would hold a player
// pacified forever, and every test in this file would stay green while it
// happened -- refresh semantics working exactly as specified.
//
// So applyCharm returns EARLY inside the immunity window and stamps NOTHING:
// not the effect entry, not the window. The window runs to completion from the
// moment the charm landed, so the target is guaranteed
// (PLAYER_CHARM_IMMUNITY_MS - PLAYER_CHARM_MS) = 4 seconds of freedom per
// charm no matter how many druids are aiming at them. Re-stamping either field
// here -- the natural "refresh like everything else" edit -- restores the
// chain-lock.
//
// The window is per-TARGET, never per-caster. A per-caster window is two druids
// taking turns, forever.
//
// Because the immunity (8000ms) is strictly longer than the duration (4000ms),
// a second charm can never reach applyEffect while the first is still live --
// which is what makes it safe to keep the charm in the effects Map at all, with
// its refresh semantics intact, rather than inventing a third storage rule.
//
// If you are reading this because the early return looks like a bug: it is not.
// `a charmed player cannot be chain-locked by repeated charms` in
// authority_charm_player.test.js fails if you "fix" it.
//
// `charmerUserId` is the DRUID's userId, matching the sourceId convention every
// other apply site in this file uses (applyElementEffect threads a userId, not
// a tag). Nothing here transfers control: the pacify's whole content is "your
// damage cannot reach this player", enforced by the callers, plus a soft repel.
function applyCharm(target, charmerUserId, now) {
  if (target._charmImmuneUntil > now) return false;   // undefined > now is false
  applyEffect(target, CHARMED, {
    durationMs: PLAYER_CHARM_MS, magnitude: 0, sourceId: charmerUserId, now,
  });
  target._charmImmuneUntil = now + PLAYER_CHARM_IMMUNITY_MS;
  return true;
}

// The userId of whoever currently has `target` charmed, or null.
//
// The ONE reader of the charm entry. world.js's attack sweep, creatures.js's
// melee arc and projectiles.js's two hit tests all resolve their pacify state
// through this, so no damage path can hold a different opinion about who is
// protected. Allocation-free, and safe on a target that has never been charmed.
function charmerOf(target, now) {
  const e = target && target.effects && target.effects.get(CHARMED);
  return e && e.until > now ? e.sourceId : null;
}
```

Add to the exports object (`:309-334`): `CHARMED,`, `applyCharm,`, `charmerOf,`.

`CHARMED` has no `TICK_INTERVAL_MS` entry, so `tickEffects` treats it as purely passive and evicts it on expiry exactly as it does `CHILL`, and `activeEffectKeys` broadcasts it to the client for free.

- [ ] **Step 9: Add the pacify filter and the soft repel to `backend/src/authority/world.js`**

Extend the `./effects` require (`:9-12`) to also pull in `applyCharm` and `charmerOf`:

```js
const {
  tickEffects, effectMagnitude, applyElementEffect, canAct, clearInterrupt, activeEffectKeys,
  applyCharm, charmerOf,
  BURN, CHILL, SHOCK, SHOCK_MANA_DRAIN,
} = require('./effects');
```

Add a constant beside `PLAYER_STAMINA_REGEN` (`:32`):

```js
// How fast the charm pushes a pacified player away from their charmer, in world
// px per second. Small on purpose: spec 8.2 calls it a SOFT repel, and this
// runs every tick for four seconds. Roughly a quarter of PLAYER_SPEED, so a
// player walking toward the druid still closes -- slowly.
const CHARM_REPEL_SPEED = 50;
```

In `tick`, immediately after the player movement loop closes (`:309`, before `return { kills };`), add:

```js
    // The charm's soft repel (spec 8.2). Applied AFTER each player's own
    // movement step, deliberately: this NUDGES, it does not steer. The target's
    // input has already moved them exactly as it always did, which is what
    // "keeps their own movement input -- no control transfer" means.
    //
    // shoveAwayFrom is the same wall-aware primitive knockback and the portal
    // bounce use, so a repel can never push anyone into terrain.
    for (const p of this.players.values()) {
      const charmerId = charmerOf(p, this.now);
      if (charmerId == null) continue;
      const src = this.players.get(charmerId);
      // The charmer left the world (or was never in it). The pacify itself
      // stays -- it is a timed effect, not a tether -- but there is nothing to
      // be repelled from.
      if (!src || src === p) continue;
      shoveAwayFrom(this.map, src.x + src.width / 2, src.y + src.height / 2, p, CHARM_REPEL_SPEED * dt);
    }
```

In `attack`, immediately after `const originLift = attackLift(w, p.height);` (`:437`), add:

```js
    // The charm pacify (spec 8.2). Resolved ONCE per attack, exactly like
    // originLift above, so the melee arc, the player sweep and the spawned
    // projectile all consult one value rather than three copies of the lookup.
    // null for everyone who is not currently charmed, i.e. every attack in the
    // game today.
    const pacifiedFrom = charmerOf(p, this.now);
```

Pass it to the arc scan (`:451-453`):

```js
      const {
        hit: creatureTargets, blocked: blockedTargets,
      } = this.creatures.meleeArcScan(cx, cy, nx, ny, w.reach, w.arc_width, pacifiedFrom);
```

and to the arc itself (`:493-499`), appending one argument:

```js
      const killed = this.creatures.applyMeleeArc(
        cx, cy, nx, ny, w.reach, w.arc_width, weaponDamage(p, w), w.element, this.now, userId,
        w.augment || null,
        pacifiedFrom,
      );
```

In the player sweep, immediately after `if (other.userId === userId) continue;` (`:525`), add:

```js
        // Pacified: this swing cannot reach the player who charmed them.
        // `continue`, not a zero-damage hit, so the impact list, the knockback
        // and the client's hit cue all fall away together -- a swing that
        // sparks off a target it did no damage to reads as a bug.
        if (pacifiedFrom != null && other.userId === pacifiedFrom) continue;
```

And carry it onto the shot in the projectile branch (`:626-638`), adding one key to the `spawn` bag:

```js
      // The pacify travels WITH the shot rather than being re-read on impact:
      // the charm can lapse mid-flight, and an arrow loosed while pacified must
      // not become lethal to the charmer because it took 300ms to arrive.
      pacifiedFrom,
```

- [ ] **Step 10: Add the pacify filter to the creature melee arc in `backend/src/authority/creatures.js`**

Insert after `immuneToPlayerDamage` (`:463`):

```js
// The creature half of the Druid's player pacify (spec 8.2). A charmed player's
// damage cannot reach the creatures their charmer holds.
//
// Same shape as immuneToPlayerDamage above and applied at the same two places
// (meleeArcScan here, projectileHitsCreature in projectiles.js), so damage,
// element riders, knockback and the client's block cue fall away together
// rather than one of them being missed.
//
// `pacifiedFrom` is the charmer's userId, or null for every attacker who is not
// charmed -- which is the overwhelmingly common case, and the reason the null
// test comes first.
function pacifiedAgainst(creature, pacifiedFrom) {
  return pacifiedFrom != null && creature.charmOwnerUserId === pacifiedFrom;
}
```

Replace `meleeArcTargets` and `meleeArcScan` (`:1969-1996`) with:

```js
  meleeArcTargets(ox, oy, nx, ny, reach, arcWidth, pacifiedFrom = null) {
    return this.meleeArcScan(ox, oy, nx, ny, reach, arcWidth, pacifiedFrom).hit;
  }

  meleeArcScan(ox, oy, nx, ny, reach, arcWidth, pacifiedFrom = null) {
    const hit = [], blocked = [];
    for (const [id, c] of this.creatures) {
      const cc = center(c);
      if (!inArc(ox, oy, nx, ny, cc.x, cc.y, reach, arcWidth)) continue;
      // Terrain blocks the swing, exactly as it blocks a projectile.
      if (!hasLineOfSight(this.map, ox, oy, cc.x, cc.y)) continue;
      // A pacified swing at the charmer's pet is reported as BLOCKED, not as a
      // miss: it is a rule refusing a blow the arc physically reached, which is
      // exactly what the guard cue already means, and the player deserves to
      // see why nothing happened.
      const refused = immuneToPlayerDamage(c) || pacifiedAgainst(c, pacifiedFrom);
      (refused ? blocked : hit).push(id);
    }
    return { hit, blocked };
  }
```

Change `applyMeleeArc`'s signature and its one traversal (`:2018-2020`):

```js
  applyMeleeArc(ox, oy, nx, ny, reach, arcWidth, damage, element, now = 0, sourceId = null, augment = null, pacifiedFrom = null) {
    const killed = [];
    for (const id of this.meleeArcTargets(ox, oy, nx, ny, reach, arcWidth, pacifiedFrom)) {
```

- [ ] **Step 11: Add the pacify filter to both projectile hit tests in `backend/src/authority/projectiles.js`**

Replace `projectileHitsCreature` (`:54-59`):

```js
function projectileHitsCreature(p, creature) {
  if (p.ownerKind !== 'creature') {
    // The Druid's player pacify (spec 8.2) -- the charmer's pets are off this
    // shot's target list, snapshotted at launch (see world.js's spawn call).
    if (p.pacifiedFrom != null && creature.charmOwnerUserId === p.pacifiedFrom) return false;
    return !immuneToPlayerDamage(creature);
  }
  if (p.ownerId === creature.id) return false;        // never its own shooter
  const targetFaction = creature.faction || 'hostile';
  return p.ownerFaction !== targetFaction;            // never same faction
}
```

Replace `projectileHitsPlayer` (`:131-135`):

```js
function projectileHitsPlayer(p, player) {
  if (p.ownerKind !== 'creature') {
    // Same rule, other target kind: a pacified shooter cannot hit their charmer.
    if (p.pacifiedFrom != null && player.userId === p.pacifiedFrom) return false;
    return player.userId !== p.ownerId;
  }
  // A guard's arrow must never hit the player it is defending.
  return p.ownerFaction === 'hostile';
}
```

Add the field to `spawn`'s destructured bag (`:182-185`):

```js
  spawn({
    ownerId, ownerKind = 'player', ownerFaction = null, x, y, nx, ny, weapon, damage,
    originLift, ammo = null, pacifiedFrom = null,
  }) {
```

and carry it onto the projectile record, beside `originLift`, in the object `spawn` pushes:

```js
      // Snapshotted at launch for the same reason `damage` is: the charm can
      // lapse mid-flight, and a shot loosed while pacified must not become
      // lethal to the charmer because it took 300ms to arrive.
      pacifiedFrom,
```

- [ ] **Step 12: Run the player-charm test to verify it passes**

Run:
```bash
cd /tmp/wt-classes/backend && npx node --test tests/authority_charm_player.test.js \
  tests/authority_effects.test.js tests/authority_projectiles.test.js \
  tests/authority_world_combat.test.js tests/authority_guard_knockback.test.js
```
Expected: PASS. The four pre-existing files must be green unchanged: every new parameter defaults to `null`, so an uncharmed attacker takes the identical path.

- [ ] **Step 13: Commit**
```bash
cd /tmp/wt-classes
git add backend/src/authority/effects.js backend/src/authority/world.js \
        backend/src/authority/creatures.js backend/src/authority/projectiles.js \
        backend/tests/authority_charm_player.test.js
git commit -m "feat(classes): pacify a charmed player without transferring control (SOMET-NNN)"
```

- [ ] **Step 14: Write the failing creature-charm test**

Create `backend/tests/authority_charm_creature.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');

function stubMap() {
  return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8, getChunk: () => [] };
}

function armed() {
  const w = new World(stubMap(), new Map(), null);
  w.addPlayer('druid', { x: 500, y: 500 });
  return w;
}

const ACTIVE = ['0,0', '0,1', '1,0', '1,1', '-1,0', '0,-1', '-1,-1', '1,-1', '-1,1'];

test('charming a creature flips its faction and records its owner', () => {
  const w = armed();
  w.creatures.addCreatures([
    { id: 'pet', type: 'Wolf', x: 560, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00' },
  ]);
  assert.equal(w.creatures.get('pet').faction, 'hostile');

  const ok = w.creatures.charm('pet', { userId: 'druid', characterId: 3, expiresAt: 60000 });
  assert.equal(ok, true);

  const pet = w.creatures.get('pet');
  assert.equal(pet.faction, 'charmed');
  assert.equal(pet.baseFaction, 'hostile', 'the original faction is remembered so release can restore it');
  assert.equal(pet.charmOwnerUserId, 'druid');
  assert.equal(pet.charmedByCharacterId, 3);
  assert.equal(pet.charmExpiresAt, 60000);
});

test('a charmed creature stops targeting players and follows its druid', () => {
  const w = armed();
  // 400px east of the druid: further than the 120px follow range, so it closes.
  w.creatures.addCreatures([
    { id: 'pet', type: 'Wolf', x: 900, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00' },
  ]);
  w.creatures.charm('pet', { userId: 'druid', characterId: 3, expiresAt: 60000 });

  const before = w.creatures.get('pet').x;
  w.creatures.tick(0.2, ACTIVE, [w.getPlayer('druid')], w.now);
  const pet = w.creatures.get('pet');

  assert.ok(pet.x < before, 'a pet walks toward its druid, not away from them');
  assert.equal(pet._target, null, 'and never acquires a player as a target');
  assert.equal(pet.mode, 'follow');
});

test('a charmed creature attacks the druid\'s target', () => {
  const w = armed();
  w.creatures.addCreatures([
    { id: 'pet', type: 'Wolf', x: 540, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00', damage: 7 },
    { id: 'foe', type: 'Wolf', x: 560, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00' },
  ]);
  w.creatures.charm('pet', { userId: 'druid', characterId: 3, expiresAt: 60000 });
  // What the druid last landed a hit on. World.attack stamps this; set it here
  // directly so this test exercises the sim, not the attack resolver.
  w.getPlayer('druid')._charmTargetId = 'foe';

  const hpBefore = w.creatures.get('foe').hp;
  w.creatures.tick(0.2, ACTIVE, [w.getPlayer('druid')], w.now);

  assert.equal(w.creatures.get('pet')._target, 'foe');
  assert.ok(w.creatures.get('foe').hp < hpBefore, 'a pet actually fights the target it was pointed at');
});

test('a charmed creature never attacks its own druid, even if pointed at them', () => {
  const w = armed();
  w.creatures.addCreatures([
    { id: 'pet', type: 'Wolf', x: 540, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00', damage: 7 },
  ]);
  w.creatures.charm('pet', { userId: 'druid', characterId: 3, expiresAt: 60000 });

  const druid = w.getPlayer('druid');
  const hpBefore = druid.hp;
  for (let i = 0; i < 10; i++) w.creatures.tick(0.2, ACTIVE, [druid], w.now + i * 200);
  assert.equal(druid.hp, hpBefore);
});

test('an expired charm releases the creature back to hostile', () => {
  const w = armed();
  w.creatures.addCreatures([
    { id: 'pet', type: 'Wolf', x: 540, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00' },
  ]);
  w.creatures.charm('pet', { userId: 'druid', characterId: 3, expiresAt: 1000 });

  w.creatures.tick(0.2, ACTIVE, [w.getPlayer('druid')], 1001);
  const pet = w.creatures.get('pet');
  assert.equal(pet.faction, 'hostile');
  assert.equal(pet.charmOwnerUserId, null);
  assert.equal(pet.charmedByCharacterId, null);
});

test('a charm whose druid has left the world is released', () => {
  const w = armed();
  w.creatures.addCreatures([
    { id: 'pet', type: 'Wolf', x: 540, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00' },
  ]);
  w.creatures.charm('pet', { userId: 'druid', characterId: 3, expiresAt: 60000 });
  // No players at all -- the druid disconnected, or walked into another world.
  w.creatures.tick(0.2, ACTIVE, [], w.now);
  assert.equal(w.creatures.get('pet').faction, 'hostile');
});

test('charm refuses a creature id the sim does not hold', () => {
  const w = armed();
  assert.equal(w.creatures.charm('ghost', { userId: 'druid', characterId: 3, expiresAt: 60000 }), false);
});
```

- [ ] **Step 15: Run the test to verify it fails**

Run:
```bash
cd /tmp/wt-classes/backend && npx node --test tests/authority_charm_creature.test.js
```
Expected: FAIL with `TypeError: w.creatures.charm is not a function`.

- [ ] **Step 16: Add the charm fields, the `charm`/`releaseCharm` methods, and the charmed tick branch to `backend/src/authority/creatures.js`**

Add four fields to the object `addCreatures` builds, immediately after `faction: c.faction || 'hostile',` (`:1140`):

```js
        // The faction to restore when the charm ends. Captured at load, never
        // recomputed: `faction` itself is overwritten while charmed, so it is
        // no longer able to answer "what was this creature before?".
        baseFaction: c.faction || 'hostile',
        // The Druid's charm (spec 8.2). All three are null for every creature
        // in the world until a druid charms one, and are cleared together by
        // releaseCharm -- a half-cleared charm is a pet with no owner, which
        // the tick would follow to (undefined, undefined).
        charmOwnerUserId: c.charmOwnerUserId ?? null,
        charmedByCharacterId: c.charmed_by_character_id ?? null,
        // World-clock ms, not a Date: this module never reads a clock, so the
        // caller converts the persisted timestamptz once at load.
        charmExpiresAt: Number.isFinite(c.charmExpiresAt) ? c.charmExpiresAt : 0,
```

Add these constants beside the other creature constants near the top of the file (next to `GUARD_LEASH_RADIUS`):

```js
// How close a pet keeps to its druid when it has nothing to fight. Just outside
// a player's own 64px box plus a creature's 48, so a following pet stands
// beside its owner rather than inside them.
const CHARM_FOLLOW_RANGE = 120;
// How far a pet may be dragged from its druid before the charm simply ends. A
// pet that has fallen this far behind is one a portal, a knockback or a
// teleport separated from its owner, and a tether with no upper bound is a
// creature walking across the map forever.
const CHARM_LEASH_RADIUS = 1200;
```

Add two methods to `CreatureSim`, immediately after `get(id)` (`:1193`):

```js
  // Take control of a creature. Returns false for an id this sim does not hold,
  // so the caller can tell "charmed" from "that creature is gone" without a
  // second lookup.
  //
  // The faction FLIP is what removes the pet from every hostile interaction in
  // the sim at once: selectGuardTarget admits only `faction === 'hostile'`
  // candidates, and projectiles.js's projectileHitsCreature refuses a
  // same-faction shot. Setting it here, in one place, is why no consumer needs
  // its own "is this a pet?" test.
  charm(id, { userId, characterId, expiresAt }) {
    const c = this.creatures.get(id);
    if (!c) return false;
    c.faction = 'charmed';
    c.charmOwnerUserId = userId;
    c.charmedByCharacterId = characterId;
    c.charmExpiresAt = expiresAt;
    // A pet abandons whatever it was chasing. Without this it keeps the player
    // it had acquired and spends its first charmed tick attacking them.
    c._target = null;
    c._targetKind = null;
    c.dirty = true;
    return true;
  }

  // Hand a creature back. Restores the faction captured at load rather than
  // hardcoding 'hostile': a guard-faction creature that was somehow charmed
  // must not come back as a wild hostile inside its own village.
  releaseCharm(c) {
    c.faction = c.baseFaction || 'hostile';
    c.charmOwnerUserId = null;
    c.charmedByCharacterId = null;
    c.charmExpiresAt = 0;
    c._target = null;
    c._targetKind = null;
    c.mode = 'roam';
    c.dirty = true;
  }
```

Insert the charmed branch in `tick`, immediately after `const cc = center(c);` (`:1245`) and BEFORE the guard branch — a pet outranks whatever it used to be:

```js
      // --- Charmed creatures: the Druid's pets (spec 8.2).
      //
      // Placed ahead of the guard branch deliberately: charm is a state imposed
      // on top of whatever the creature already was, and a charmed guard must
      // follow its druid rather than resume defending a post.
      //
      // The charm ends HERE, in the tick, and nowhere else: three conditions
      // (the clock, the owner's presence, the leash) resolve in one place, so
      // there is exactly one way for a pet to stop being one.
      if (c.charmOwnerUserId != null) {
        const owner = byId.get(c.charmOwnerUserId);
        const ownerC = owner ? center(owner) : null;
        const tooFar = ownerC
          ? dist2(cc.x, cc.y, ownerC.x, ownerC.y) > CHARM_LEASH_RADIUS * CHARM_LEASH_RADIUS
          : true;
        if (now >= c.charmExpiresAt || !owner || tooFar) {
          this.releaseCharm(c);
          // Falls through to the ordinary paths below on the NEXT tick, not
          // this one: releasing and then immediately acquiring a target in the
          // same tick would let a lapsing pet bite its own druid on the way out.
          continue;
        }

        // What the druid last landed a hit on (world.js's attack stamps
        // `_charmTargetId`). Re-validated every tick rather than cached on the
        // creature: the target can die, be charmed by the same druid, or be the
        // pet itself, and a pet attacking its sibling is the shape this check
        // exists to refuse.
        let tgt = owner._charmTargetId ? this.creatures.get(owner._charmTargetId) : null;
        if (tgt && (tgt.hp <= 0 || tgt.id === c.id || tgt.charmOwnerUserId === c.charmOwnerUserId)) {
          tgt = null;
        }
        c._target = null;
        c._targetKind = tgt ? 'creature' : null;

        if (tgt) {
          c.mode = 'chase';
          c._target = tgt.id;
          const tc = center(tgt);
          const vx = tc.x - cc.x, vy = tc.y - cc.y;
          const r = movedWith(this.map, c, vx, vy, dt, bh.moveSpeedMult * c._buff.speedMult);
          if (r.x !== c.x || r.y !== c.y) {
            c.x = r.x; c.y = r.y;
            const f = facingFor(vx, vy); if (f) c.facing = f;
            c.dirty = true;
          }
          // Attack, gated by canAct exactly as the guard and hostile branches
          // are: a shocked pet misses its strike like anything else.
          const dist = Math.hypot(tc.x - center(c).x, tc.y - center(c).y);
          const ability = canAct(c, now) ? selectAbility(c, bh, dist) : null;
          if (ability) {
            c._abilityCd.set(ability.slot, ability.attackCooldown);
            const dmg = (bh.damageOverride == null ? c.damage : bh.damageOverride)
              * ability.damageMult * c._buff.damageMult;
            applyDamageWithEffects(tgt, dmg, ability.element || c.attackElement,
              effectiveMit(tgt), now, creatureKey(c.id));
            stampCreatureAttack(attacks, impacts, c, tgt, center(c), tc);
            tgt.dirty = true;
            if (tgt.hp <= 0) {
              this.creatures.delete(tgt.id);
              // Credited to the DRUID, not to the pet: the kill is the player's
              // doing, and commitCreatureDeath's XP and loot branches key on a
              // real userId. A creature id here would be a bogus killerUserId,
              // the exact trap killerUserIdFor exists to avoid in projectiles.js.
              killed.push({ id: tgt.id, killerUserId: c.charmOwnerUserId });
            }
          }
        } else {
          // Nothing to fight: heel. Beyond CHARM_FOLLOW_RANGE it closes; inside
          // it, it stands still rather than jittering against its owner's box.
          c.mode = 'follow';
          const vx = ownerC.x - cc.x, vy = ownerC.y - cc.y;
          if (Math.hypot(vx, vy) > CHARM_FOLLOW_RANGE) {
            const r = movedWith(this.map, c, vx, vy, dt, bh.moveSpeedMult * c._buff.speedMult);
            if (r.x !== c.x || r.y !== c.y) {
              c.x = r.x; c.y = r.y;
              const f = facingFor(vx, vy); if (f) c.facing = f;
              c.dirty = true;
            }
          }
        }
        continue;
      }
```

Finally, stamp the druid's target in `world.js`'s `attack`. In the melee branch, immediately after `const killed = this.creatures.applyMeleeArc(...)` (`:499`), add:

```js
      // What this player's summons will attack (spec 8.2: "attacks the druid's
      // target"). The FIRST creature this swing reached, kept even if the swing
      // killed it -- the sim re-validates it every tick and drops a dead one, so
      // a stale id costs one tick of nothing rather than needing a second write
      // site here.
      if (creatureTargets.length > 0) p._charmTargetId = creatureTargets[0];
```

Initialise it in `addPlayer`, beside `_attackCd` (`:190`):

```js
      // The creature this player's summons follow them onto. Written only by
      // attack(), read only by CreatureSim's charmed branch.
      _charmTargetId: null,
```

- [ ] **Step 17: Run the creature test to verify it passes**

Run:
```bash
cd /tmp/wt-classes/backend && npx node --test tests/authority_charm_creature.test.js \
  tests/authority_creatures.test.js tests/authority_creature_styles.test.js \
  tests/authority_creatures_combat.test.js tests/creature_behavior_golden.test.js
```
Expected: PASS. The four pre-existing files must be green: `charmOwnerUserId` is `null` for every creature they build, so the new branch is skipped entirely.

- [ ] **Step 18: Commit**
```bash
cd /tmp/wt-classes
git add backend/src/authority/creatures.js backend/src/authority/world.js \
        backend/tests/authority_charm_creature.test.js
git commit -m "feat(classes): charmed creatures flip faction, follow the druid and fight the druid's target (SOMET-NNN)"
```

- [ ] **Step 19: Write the failing DB test for the charm schema and the summon roster**

Create `backend/tests/charm_summons_db.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('charm columns and the summon roster', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  // A throwaway user + character to hang rows off. Cleaned up in t.after by id,
  // so nothing pre-existing is touched -- this file never issues an unscoped
  // DELETE.
  const u = await pool.query(
    `INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`charmtest_${Date.now()}`]);
  const userId = u.rows[0].id;
  const ch = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, id FROM entity_types WHERE name = 'Druid' RETURNING id`,
    [userId, `charmtest_${Date.now()}`]);
  const characterId = ch.rows[0].id;
  t.after(() => pool.query('DELETE FROM users WHERE id = $1', [userId]));

  await t.test('the charm columns exist and must be set as a pair', async () => {
    const w = await pool.query('SELECT id FROM world_creatures LIMIT 1');
    if (!w.rows.length) { t.diagnostic('no world_creatures rows on this database'); return; }
    const id = w.rows[0].id;
    await assert.rejects(
      () => pool.query(
        'UPDATE world_creatures SET charmed_by_character_id = $1 WHERE id = $2',
        [characterId, id]),
      /world_creatures_charm_pair_check/,
      'an owner with no expiry is a permanent pet');
  });

  await t.test('deleting a character releases its pets rather than deleting them', async () => {
    const w = await pool.query('SELECT id FROM world_creatures LIMIT 1');
    if (!w.rows.length) { t.diagnostic('no world_creatures rows on this database'); return; }
    const creatureId = w.rows[0].id;
    const tmp = await pool.query(
      `INSERT INTO characters (user_id, slot, name, entity_type_id)
       SELECT $1, 2, $2, id FROM entity_types WHERE name = 'Druid' RETURNING id`,
      [userId, `charmtest2_${Date.now()}`]);
    await pool.query(
      `UPDATE world_creatures SET charmed_by_character_id = $1, charm_expires_at = now() + interval '1 minute'
        WHERE id = $2`, [tmp.rows[0].id, creatureId]);
    await pool.query('DELETE FROM characters WHERE id = $1', [tmp.rows[0].id]);
    const after = await pool.query(
      'SELECT charmed_by_character_id FROM world_creatures WHERE id = $1', [creatureId]);
    assert.equal(after.rows.length, 1, 'the creature must survive its charmer');
    assert.equal(after.rows[0].charmed_by_character_id, null);
    await pool.query(
      'UPDATE world_creatures SET charm_expires_at = NULL WHERE id = $1', [creatureId]);
  });

  await t.test('the roster is a set, so re-charming the same creature adds no row', async () => {
    await pool.query(
      `INSERT INTO character_summons (character_id, creature_type, level) VALUES ($1, 'Wolf', 6)
       ON CONFLICT (character_id, creature_type, level) DO NOTHING`, [characterId]);
    await pool.query(
      `INSERT INTO character_summons (character_id, creature_type, level) VALUES ($1, 'Wolf', 6)
       ON CONFLICT (character_id, creature_type, level) DO NOTHING`, [characterId]);
    const r = await pool.query(
      'SELECT count(*)::int AS n FROM character_summons WHERE character_id = $1', [characterId]);
    assert.equal(r.rows[0].n, 1);
  });

  await t.test('a level below 1 is unrepresentable in the roster', async () => {
    await assert.rejects(
      () => pool.query(
        `INSERT INTO character_summons (character_id, creature_type, level) VALUES ($1, 'Wolf', 0)`,
        [characterId]),
      /character_summons_level_check/);
  });

  await t.test('deleting the character takes its roster with it', async () => {
    const before = await pool.query(
      'SELECT count(*)::int AS n FROM character_summons WHERE character_id = $1', [characterId]);
    assert.equal(before.rows[0].n, 1);
    await pool.query('DELETE FROM characters WHERE id = $1', [characterId]);
    const after = await pool.query(
      'SELECT count(*)::int AS n FROM character_summons WHERE character_id = $1', [characterId]);
    assert.equal(after.rows[0].n, 0);
  });
});
```

- [ ] **Step 20: Run the test to verify it fails**

Run:
```bash
cd /tmp/wt-classes/backend && DATABASE_URL="$SCRATCH" TEST_DATABASE_URL="$SCRATCH" \
  npx node --test tests/charm_summons_db.test.js
```
Expected: FAIL with `error: column "charmed_by_character_id" of relation "world_creatures" does not exist`.

- [ ] **Step 21: Write the migration**

Create `backend/migrations/1714440403000_charm_and_summons.js`:

```js
exports.shorthands = undefined;

// The Druid's charm (spec 8.2).
//
// charmed_by_character_id is ON DELETE SET NULL, never CASCADE. Deleting a
// character must RELEASE its pets, not delete the creatures out of the world:
// a CASCADE here would let a player wipe a pack off the map by deleting their
// own druid, and world_creatures rows are shared world state, not per-character
// state.
//
// charm_expires_at is the only expiry authority for a persisted charm. Nothing
// clears these columns on a timer -- every read filters `charm_expires_at >
// now()` -- so a crash mid-charm cannot leave a permanent pet behind, and the
// in-memory release in CreatureSim.tick and the durable rule cannot disagree
// about when a charm ended.

exports.up = (pgm) => {
  pgm.addColumns('world_creatures', {
    charmed_by_character_id: {
      type: 'integer', references: 'characters', onDelete: 'SET NULL',
    },
    charm_expires_at: { type: 'timestamptz' },
  });

  // Both or neither. An owner with no expiry is a permanent pet, and an expiry
  // with no owner is a column nothing reads -- either half alone is a bug that
  // would only surface in play.
  pgm.addConstraint('world_creatures', 'world_creatures_charm_pair_check',
    'CHECK ((charmed_by_character_id IS NULL) = (charm_expires_at IS NULL))');

  // Partial: the overwhelming majority of world_creatures rows are never
  // charmed, and the only query is "this character's live pets".
  pgm.createIndex('world_creatures', ['charmed_by_character_id'], {
    name: 'world_creatures_charmed_by_idx',
    where: 'charmed_by_character_id IS NOT NULL',
  });

  pgm.createTable('character_summons', {
    id: 'id',
    character_id: { type: 'integer', notNull: true, references: 'characters', onDelete: 'CASCADE' },
    creature_type: { type: 'text', notNull: true },
    level: { type: 'integer', notNull: true },
    charmed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('character_summons', 'character_summons_level_check', 'CHECK (level >= 1)');
  // The roster is a SET of (character, type, level) -- "every creature ever
  // charmed" (spec 8.2) -- not a log of every charm EVENT. Without this a druid
  // who re-charms the same wolf twenty times gets twenty identical roster rows
  // and the re-summon list becomes unusable.
  pgm.addConstraint('character_summons', 'character_summons_unique',
    { unique: ['character_id', 'creature_type', 'level'] });
  pgm.createIndex('character_summons', 'character_id');
};

exports.down = (pgm) => {
  pgm.dropTable('character_summons');
  pgm.dropIndex('world_creatures', ['charmed_by_character_id'],
    { name: 'world_creatures_charmed_by_idx' });
  pgm.dropConstraint('world_creatures', 'world_creatures_charm_pair_check');
  pgm.dropColumns('world_creatures', ['charmed_by_character_id', 'charm_expires_at']);
};
```

- [ ] **Step 22: Run the migration, then the test, to verify it passes**

Run:
```bash
cd /tmp/wt-classes/backend && DATABASE_URL="$SCRATCH" npm run migrate:up \
  && DATABASE_URL="$SCRATCH" TEST_DATABASE_URL="$SCRATCH" npx node --test tests/charm_summons_db.test.js
```
Expected: PASS, 5 subtests.

- [ ] **Step 23: Commit**
```bash
cd /tmp/wt-classes
git add backend/migrations/1714440403000_charm_and_summons.js backend/tests/charm_summons_db.test.js
git commit -m "feat(classes): charm columns on world_creatures and the character_summons roster (SOMET-NNN)"
```

- [ ] **Step 24: Add the `charm` websocket handler to `backend/src/authority/server.js`**

Insert this handler into the `messageHandlers` object, immediately after `autoloot` (`:1882`):

```js
    // The Druid's charm (spec 8.2). One message, three refusals, in this order:
    // not a Druid, over budget, or nothing charmable in range. Each is silent
    // except the budget one, which the player needs to understand.
    //
    // The budget is read from the DATABASE every time rather than cached on the
    // player: charisma is about to become a composed number (T7's tree), and a
    // budget cached at join would be wrong the moment a point is allocated.
    charm(ws, msg) {
      const entry = worlds.get(ws.worldId);
      if (!entry) return;
      if (typeof msg.creature_id !== 'string') return; // wire hygiene: ids are strings
      chainOp(ws, 'charm', async () => {
        const p = entry.world.getPlayer(ws.userId);
        if (!p) return;
        const character = await ownedCharacter(pool, Number(ws.userId), ws.characterId);
        if (!character || character.className !== 'Druid') {
          return send(ws, { type: 'error', message: 'Only a Druid can charm' });
        }

        const c = entry.world.creatures.get(msg.creature_id);
        if (!c) return; // gone: silent, like pickup with nothing in range
        const pc = { x: p.x + p.width / 2, y: p.y + p.height / 2 };
        const cc = { x: c.x + c.width / 2, y: c.y + c.height / 2 };
        if (Math.hypot(cc.x - pc.x, cc.y - pc.y) > CHARM_RANGE) return;
        if (c.charmOwnerUserId != null) return; // already someone's pet

        const progression = await loadProgression(pool, character.id);
        // treeCharmBonus is 0 until the CHA keystone "Beast Bond" exists
        // (group C, T7). Passed explicitly rather than defaulted so the wiring
        // point is visible when that task lands.
        const budget = charmBudget(Number(progression.charisma) || 0, 0);
        const held = entry.world.creatures.all()
          .filter((x) => x.charmedByCharacterId === character.id)
          .map((x) => x.level);
        const verdict = canSummon(held, c.level, budget);
        if (!verdict.ok) {
          return send(ws, { type: 'error', message: `Charm refused: ${verdict.reason}` });
        }

        const expiresAt = entry.world.now + CHARM_DURATION_MS;
        entry.world.creatures.charm(msg.creature_id, {
          userId: ws.userId, characterId: character.id, expiresAt,
        });
        // Durable, in one statement each, and AFTER the in-memory charm: a
        // failed write leaves a pet that lapses on its own timer, while a
        // failed charm followed by a successful write would leave a durable
        // pet the sim knows nothing about.
        await pool.query(
          `UPDATE world_creatures
              SET charmed_by_character_id = $1,
                  charm_expires_at = now() + ($2::int * interval '1 millisecond')
            WHERE id = $3`,
          [character.id, CHARM_DURATION_MS, msg.creature_id]);
        // "Every creature ever charmed is recorded" (spec 8.2). ON CONFLICT DO
        // NOTHING because the roster is a set, not a log -- see the migration.
        await pool.query(
          `INSERT INTO character_summons (character_id, creature_type, level)
           VALUES ($1, $2, $3)
           ON CONFLICT (character_id, creature_type, level) DO NOTHING`,
          [character.id, c.type, c.level]);
        send(ws, { type: 'charmed', creatureId: msg.creature_id, expiresAt });
      });
    },
```

Add the imports at the top of the file, beside the existing `ownedCharacter` require (`:12`):

```js
const { charmBudget, canSummon } = require('../services/charm.js');
```

and the two module constants beside the other tuning constants near `PICKUP_RADIUS`:

```js
// How close a druid must be to charm. Matches the interact radius family rather
// than a weapon reach: charming is an interaction, not an attack.
const CHARM_RANGE = 200;
// How long a creature charm holds before the sim releases it. Long enough to
// walk a pack somewhere with, short enough that a druid must keep re-charming.
const CHARM_DURATION_MS = 120000;
```

- [ ] **Step 25: Run the whole backend suite against the scratch database**

Run:
```bash
cd /tmp/wt-classes/backend && DATABASE_URL="$SCRATCH" TEST_DATABASE_URL="$SCRATCH" npm test
```
Expected: PASS. This is the one full-suite run this plan calls for; scope everything before it to the files named in each step.

- [ ] **Step 26: Browser-verify the Druid and the pacify**

Create a Druid, join a world with hostile creatures, and send `{"type":"charm","creature_id":"<id>"}` from the devtools console over the live socket. Confirm: the creature stops chasing you, walks after you when you move away, and attacks the next creature you hit. Confirm a second charm past the budget returns `Charm refused: over_budget`. Then charm a second player from a second browser session and confirm they still move under their own input, drift away from you, and cannot damage you for four seconds — and that a second charm during those four seconds does nothing.

- [ ] **Step 27: Commit**
```bash
cd /tmp/wt-classes
git add backend/src/authority/server.js
git commit -m "feat(classes): charm websocket handler with budget enforcement and the summon roster (SOMET-NNN)"
```

---

## Self-review — spec requirement to task

| Spec requirement | Where |
|---|---|
| §8.1 Warrior and Mage stay playable | Task 1 Step 3 (migration touches only `main_stat` on those two rows); asserted Task 1 Step 1, "Warrior and Mage keep the stats they already had" |
| §8.1 Monk, Cultist, Archer, Druid as four new `entity_types` rows | Task 1 Step 3 `NEW_CLASSES`; Step 9 restores them from seed data |
| §8.1 `Ranger` kept and marked not-playable, never renamed | Task 1 Step 3 (`UPDATE … SET is_playable = false`), Step 9 (`is_playable: false` in the seed row); asserted Task 1 Step 1, "Ranger is kept, demoted, and NOT renamed" |
| §3.2 `entity_types.main_stat` | Task 1 Step 3 (column + CHECK), Step 14 (surfaced by the service) |
| §8.1 per-class `class_loadouts` | Task 1 Step 3 (migration inserts), Step 9 (seeder restores) |
| §10.4 CharacterSelect shows all six with their main stat | Task 1 Steps 19 and 21; asserted Step 17 |
| §8.3 every `mana_cost` paid as HP at 0.6× | Task 2 Step 3 `lifeCostFor`, Step 8 `spendResources` |
| §8.3 a lethal cast is REFUSED, not fatal | Task 2 Step 3 `canPayLife`, Step 8 `resourceRefusal`; asserted Step 6, "a cultist cast that would be lethal is refused AND costs nothing" |
| §8.3 one cost gate, not two | Task 2 Step 8 — `resourceRefusal` is called by both `canAttack` and `attack`, and `spendResources` replaces both former spend sites |
| §8.3 the Cultist's mana bar is hidden client-side | Task 2 Steps 11–12 (`usesLifeCost` on the `joined` frame, `mana: null` into the HUD) |
| §8.3 contract module `backend/src/services/lifeCost.js` | Task 2 Step 3, exports exactly `LIFE_COST_RATIO`, `lifeCostFor`, `canPayLife` |
| §8.2 creature charm sets `charmed_by_character_id` + `charm_expires_at` | Task 3 Step 21 (columns), Step 24 (the write) |
| §8.2 faction flip | Task 3 Step 16 `CreatureSim.charm`; asserted Step 14 |
| §8.2 the pet follows the druid | Task 3 Step 16, the `follow` branch; asserted Step 14 |
| §8.2 the pet attacks the druid's target | Task 3 Step 16, the `chase` branch plus `p._charmTargetId`; asserted Step 14 |
| §8.2 every creature ever charmed recorded in `character_summons` | Task 3 Step 21 (table), Step 24 (the `ON CONFLICT DO NOTHING` insert); asserted Step 19 |
| §8.2 budget `floor(cha / 2) + treeCharmBonus`, summed over active summons | Task 3 Step 3 `charmBudget`/`canSummon`, Step 24 (the enforcement); asserted Step 1 |
| §8.2 player charm is a 4s pacify | Task 3 Step 3 `PLAYER_CHARM_MS`, Step 8 `applyCharm` |
| §8.2 the target cannot damage the druid or the druid's summons | Task 3 Steps 9–11 (world melee sweep, creature arc, both projectile hit tests); asserted Step 6 |
| §8.2 soft repel | Task 3 Step 9, the `CHARM_REPEL_SPEED` block in `World.tick`; asserted Step 6 |
| §8.2 keeps their own movement input, no control transfer | Task 3 Step 9 — the repel runs AFTER `resolveMove` and nothing touches `p.input`; asserted Step 6 |
| §8.2 can never become a summon | Task 3 Step 8 — the pacify lives entirely in `effects.js` and writes no creature field; asserted Step 6 |
| §8.2 non-refreshing immunity window modelled on the shock interrupt | Task 3 Step 8 `applyCharm`'s early return, with the precedent named in the comment; asserted Step 6, "a charmed player cannot be chain-locked by repeated charms" |
| §11.8 charm budget and chain-lock coverage | Task 3 Step 1 and Step 6 |
| §11.7 lethal cultist cast coverage | Task 2 Step 6 |
