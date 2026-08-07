# P2b — Creature Mechanics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the umbrella's top creature rungs the mechanics that distinguish them — pack-leader auras, multi-ability Apexes, knockback — and give every rung a loot baseline, so P4 can author 288 creature rows against a complete schema.

**Architecture:** `creature_behaviors` keeps *how a creature moves and thinks*; a new `creature_abilities` child table owns *what it does*, one row per attack. P2a's six attack columns migrate into slot-1 ability rows and are dropped from the parent. Auras are a radius computed fresh every tick and never persisted. Knockback reuses the existing `knockbackPosition` primitive. `behavior_drops` rolls in addition to `creature_drops`.

**Tech Stack:** Backend CommonJS, `node:test`/`node:assert`, raw `pg`, `node-pg-migrate`. Frontend ESM + vitest in a **node environment with no DOM** — components cannot be rendered in tests, so pure helpers are split out of components and those helpers are what get tested.

**Spec:** `docs/superpowers/specs/2026-08-07-p2b-creature-mechanics-design.md` (committed `ac913e8`)
**Plane item:** SOMET-253
**Branch:** `feat/creature-mechanics-p2b`, from `main` at `ac913e8`

---

## Global Constraints

Every task's requirements implicitly include this section.

### Database safety — absolute

Each of these exists because it has been violated in this project.

1. **No test may write to a real catalog row** — not by id, not by name, and not a write it merely *expects to be rejected*. A P2a task asserted an FK would refuse `DELETE FROM creature_behaviors WHERE id = <Line's id>`; the FK did not exist yet, the delete succeeded, and it destroyed the real `Line` row that every unprofiled creature falls back to.
2. **No `DELETE FROM` a catalog table, no `TRUNCATE`, no `DROP`, ever, in a test or a scratch script.** A reviewer once ran `DELETE FROM entity_types` to test a seeder and wiped the whole catalog.
3. **Test fixtures are `zz`-prefixed and deleted by name, unconditionally, in a `finally`** — never by an id captured mid-test. An id captured mid-test is not deleted when the test fails before capturing it.
4. `make seed-catalogs` must never cost an admin something they authored by hand.
5. The dev database is **shared**. Assume another session may be using it concurrently.

### The golden trace

`backend/tests/fixtures/creature_tick_golden.json` is a 120-tick simulation trace frozen by P2a before any production file moved.

- **It must never be regenerated.** Not to accommodate a signature change, not to "update it for the new shape". If it goes red, the change altered behaviour and the change is wrong.
- `git log -- backend/tests/fixtures/` must show no commit to it on this branch.
- Tasks 2 and 3 are explicitly gated on it.

### Test hygiene

- **Never derive an expected value from the same constant or seed file the implementation reads.** This is the project's single most-repeated vacuous-test shape. Write the number.
- SQL-text stubs in unit tests fail by **hanging**, not by going red. If a suite runs long instead of failing, a stub's pattern stopped matching a query you changed. Run `npm test -- --test-timeout=20000` to convert the hang into a named failure.
- Rationale comments about a SQL query must stay **outside** the template literal. A comment inside it satisfies a SELECT-completeness guard by itself.

### Which profiles are live

Verified against the dev database on 2026-08-07:

| Profile | Creature types pointing at it |
|---|---|
| `Line` | 4 |
| `Guard` | 1 |
| every other profile | **0** |

This is why the seeded content in Tasks 1 and 4 — the Apex's second ability, the Champion's aura, the Brute's knockback — is behaviour-neutral for existing creatures: nothing references those rungs until P4 assigns them. It is also why browser verification requires **temporarily** assigning a profile to a creature type that is actually in a world, and reverting afterwards.

Do not extend this reasoning to `Line` or `Guard`. A change to either alters the live game.

### Off limits

`PATH_NAME_RE`, `detectPathTile`, `backend/src/authority/collision.js`, `frontend/src/games/something2/movement.js`, and `resolveMove` in either copy.

### Conventions

- Migrations take `1714440083000` onward. P2a consumed `80000`–`82000`.
- Commits: `type(scope): summary (SOMET-253)`, ending with the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.
- Backend tests: `npm test` from `backend/`. Frontend: `npx vitest run` from `frontend/`.
- Scope test runs to what you changed; the full suite runs once at the end of a task.

---

## File Structure

**Created:**
- `backend/migrations/1714440083000_creature_abilities.js` — table + backfill from the parent's attack columns
- `backend/migrations/1714440084000_drop_behavior_attack_columns.js` — the cutover
- `backend/migrations/1714440085000_behavior_auras.js` — aura + gold columns on `creature_behaviors`
- `backend/migrations/1714440086000_behavior_drops.js` — per-rung loot
- `backend/migrations/1714440087000_item_knockback.js` — weapon knockback
- `backend/seeds/data/creatureAbilities.js` — the ability catalog
- `backend/seeds/data/behaviorDrops.js` — the per-rung drop catalog
- `backend/src/authority/knockback.js` — the extracted displacement primitive
- `frontend/src/games/something2/abilityForm.js` — pure ability form helpers
- Test files named per task

**Modified:**
- `backend/src/services/creatureBehaviors.js` — resolver returns `abilities`, aura fields
- `backend/src/authority/creatures.js` — both the loader and the tick
- `backend/src/authority/server.js` — per-chunk query; `knockbackPosition` moves out
- `backend/src/authority/projectiles.js` — knockback at the four hit sites
- `backend/src/authority/world.js` — knockback on the melee arc; shot field threading
- `backend/src/authority/loot.js` — the drop union and the gold fallback
- `backend/src/index.js` — nested ability API, validation split
- `backend/scripts/seed-catalogs.js` — abilities and behaviour drops
- `frontend/src/games/something2/behaviorForm.js`, `CreatureBehaviorsAdmin.jsx`, `useCreatureBehaviors.js`, `ItemTypesAdmin.jsx`

---

## Task 1: The `creature_abilities` table

**Files:**
- Create: `backend/migrations/1714440083000_creature_abilities.js`
- Create: `backend/seeds/data/creatureAbilities.js`
- Modify: `backend/scripts/seed-catalogs.js`
- Test: `backend/tests/creature_abilities_migration_db.test.js`

**Interfaces:**
- Consumes: `creature_behaviors` as P2a left it (twelve rows, six attack columns).
- Produces: table `creature_abilities`; `CREATURE_ABILITIES` export from the seed data file, an array of `{ behavior_name, slot, name, attack_kind, attack_range, attack_cooldown, projectile_speed, projectile_radius, element, damage_mult, knockback }`.

This task creates the table and populates it. It does **not** touch any read path — the parent's attack columns stay, and the simulation keeps reading them. Nothing changes behaviour.

- [ ] **Step 1: Write the migration**

`knockback` is included at creation rather than added later — the column costs nothing until Task 6 reads it, and a second migration to add one column is waste.

```js
exports.shorthands = undefined;

// One row per attack. Slot order is PRIORITY order, and the read path's
// json_agg orders by it -- see the note in authority/creatures.js.
//
// The backfill below is what makes this migration behaviour-neutral: every
// existing behaviour gets exactly one ability carrying the values it already
// had, so a creature's attack is byte-identical before and after. The frozen
// golden trace (tests/fixtures/creature_tick_golden.json) proves that once
// Task 2 moves the read path onto this table.
exports.up = (pgm) => {
  pgm.createTable('creature_abilities', {
    id: 'id',
    behavior_id: {
      type: 'integer', notNull: true, references: 'creature_behaviors', onDelete: 'CASCADE',
    },
    slot: { type: 'integer', notNull: true },
    name: { type: 'text', notNull: true },
    attack_kind: { type: 'text', notNull: true },
    attack_range: { type: 'real', notNull: true },
    attack_cooldown: { type: 'real', notNull: true },
    projectile_speed: { type: 'real', notNull: true, default: 0 },
    projectile_radius: { type: 'real', notNull: true, default: 0 },
    // NULL means "use the creature type's attack_element". A per-ability
    // element is what lets one Apex pair a fire breath with a physical slam.
    element: { type: 'text', notNull: false },
    damage_mult: { type: 'real', notNull: true, default: 1 },
    knockback: { type: 'real', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('creature_abilities', 'creature_abilities_slot_unique',
    'UNIQUE (behavior_id, slot)');
  pgm.addConstraint('creature_abilities', 'creature_abilities_slot_check',
    'CHECK (slot >= 1)');
  pgm.addConstraint('creature_abilities', 'creature_abilities_attack_kind_check',
    "CHECK (attack_kind IN ('melee','ranged','cast'))");
  pgm.addConstraint('creature_abilities', 'creature_abilities_element_check',
    "CHECK (element IS NULL OR element IN ('physical','fire','ice','lightning'))");
  pgm.addConstraint('creature_abilities', 'creature_abilities_positive_check',
    'CHECK (attack_range > 0 AND attack_cooldown > 0)');
  pgm.addConstraint('creature_abilities', 'creature_abilities_nonneg_check',
    'CHECK (projectile_speed >= 0 AND projectile_radius >= 0 AND damage_mult >= 0 AND knockback >= 0)');
  pgm.createIndex('creature_abilities', 'behavior_id');

  // Backfill: every existing behaviour becomes its own slot-1 ability.
  // element NULL and damage_mult 1 reproduce today's semantics exactly --
  // today a creature's shot carries its type's attack_element for `cast` and
  // physical otherwise, and its damage is unscaled.
  pgm.sql(`
    INSERT INTO creature_abilities
      (behavior_id, slot, name, attack_kind, attack_range, attack_cooldown,
       projectile_speed, projectile_radius, element, damage_mult, knockback)
    SELECT b.id, 1, b.name, b.attack_kind, b.attack_range, b.attack_cooldown,
           b.projectile_speed, b.projectile_radius, NULL, 1, 0
    FROM creature_behaviors b
  `);

  // Apex is the rung the umbrella describes as having a repertoire, so it is
  // the one profile seeded with a second ability. Slot 2 is a shorter-range
  // physical slam on a faster cooldown, with the knockback that makes closing
  // on an Apex a mistake. Without at least one real multi-ability profile the
  // selection logic Task 2 builds has no live consumer and cannot be
  // browser-verified.
  pgm.sql(`
    INSERT INTO creature_abilities
      (behavior_id, slot, name, attack_kind, attack_range, attack_cooldown,
       projectile_speed, projectile_radius, element, damage_mult, knockback)
    SELECT b.id, 2, 'Slam', 'melee', 90, 1.2, 0, 0, 'physical', 1.4, 120
    FROM creature_behaviors b WHERE b.name = 'Apex'
    ON CONFLICT (behavior_id, slot) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('creature_abilities');
};
```

- [ ] **Step 2: Run the migration**

Run from `backend/`: `npm run migrate:up`
Expected: applies cleanly. Then confirm the backfill with a read-only query:

```bash
psql "$DATABASE_URL" -c "SELECT b.name, a.slot, a.attack_kind, a.attack_range, a.attack_cooldown FROM creature_abilities a JOIN creature_behaviors b ON b.id = a.behavior_id ORDER BY b.name, a.slot"
```

Expected: thirteen rows — twelve slot-1 rows whose `attack_kind`/`attack_range`/`attack_cooldown` equal their parent's, plus Apex slot 2.

- [ ] **Step 3: Write the seed data file**

`backend/seeds/data/creatureAbilities.js`. Keyed by behaviour NAME, not id — ids differ between databases (P2a's `Line` was restored with id 31 after an incident, leaving a sequence gap).

```js
// The authoritative creature_abilities catalog for `make seed-catalogs`.
//
// Mirrors what migration 1714440083000 inserts, the same arrangement
// creature_behaviors uses: migrations make a fresh database work, this file
// lets the seeder re-apply and extend.
//
// Keyed by behaviour NAME, never by id: ids are not portable between
// databases (this project's `Line` row is id 31 in dev, from a sequence gap).
//
// `element: null` means "use the creature type's attack_element", which is
// what every backfilled slot-1 ability carries and what reproduces today's
// behaviour exactly.
const CREATURE_ABILITIES = [
  { behavior_name: 'Swarm',      slot: 1, name: 'Swarm',      attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 0.7, projectile_speed: 0,   projectile_radius: 0,  element: null, damage_mult: 1, knockback: 0 },
  { behavior_name: 'Skirmisher', slot: 1, name: 'Skirmisher', attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 0.9, projectile_speed: 0,   projectile_radius: 0,  element: null, damage_mult: 1, knockback: 0 },
  { behavior_name: 'Line',       slot: 1, name: 'Line',       attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 1.0, projectile_speed: 0,   projectile_radius: 0,  element: null, damage_mult: 1, knockback: 0 },
  { behavior_name: 'Ranged',     slot: 1, name: 'Ranged',     attack_kind: 'ranged', attack_range: 340, attack_cooldown: 1.8, projectile_speed: 520, projectile_radius: 6,  element: null, damage_mult: 1, knockback: 0 },
  { behavior_name: 'Caster',     slot: 1, name: 'Caster',     attack_kind: 'cast',   attack_range: 300, attack_cooldown: 2.4, projectile_speed: 420, projectile_radius: 8,  element: null, damage_mult: 1, knockback: 0 },
  { behavior_name: 'Brute',      slot: 1, name: 'Brute',      attack_kind: 'melee',  attack_range: 70,  attack_cooldown: 1.8, projectile_speed: 0,   projectile_radius: 0,  element: null, damage_mult: 1, knockback: 140 },
  { behavior_name: 'Heavy',      slot: 1, name: 'Heavy',      attack_kind: 'melee',  attack_range: 65,  attack_cooldown: 1.5, projectile_speed: 0,   projectile_radius: 0,  element: null, damage_mult: 1, knockback: 0 },
  { behavior_name: 'Champion',   slot: 1, name: 'Champion',   attack_kind: 'melee',  attack_range: 65,  attack_cooldown: 1.1, projectile_speed: 0,   projectile_radius: 0,  element: null, damage_mult: 1, knockback: 0 },
  { behavior_name: 'Apex',       slot: 1, name: 'Apex',       attack_kind: 'cast',   attack_range: 260, attack_cooldown: 2.0, projectile_speed: 460, projectile_radius: 10, element: null, damage_mult: 1, knockback: 0 },
  { behavior_name: 'Apex',       slot: 2, name: 'Slam',       attack_kind: 'melee',  attack_range: 90,  attack_cooldown: 1.2, projectile_speed: 0,   projectile_radius: 0,  element: 'physical', damage_mult: 1.4, knockback: 120 },
  { behavior_name: 'Guard',      slot: 1, name: 'Guard',      attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 1.0, projectile_speed: 0,   projectile_radius: 0,  element: null, damage_mult: 1, knockback: 0 },
  { behavior_name: 'Sentry',     slot: 1, name: 'Sentry',     attack_kind: 'ranged', attack_range: 380, attack_cooldown: 2.0, projectile_speed: 500, projectile_radius: 6,  element: null, damage_mult: 1, knockback: 0 },
  { behavior_name: 'Lurker',     slot: 1, name: 'Lurker',     attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 0.9, projectile_speed: 0,   projectile_radius: 0,  element: null, damage_mult: 1, knockback: 0 },
];

module.exports = { CREATURE_ABILITIES };
```

**Note the Brute's 140 knockback.** The migration's backfill inserts 0 for every slot-1 row; the seed file carries the Brute's real value. That divergence is intentional and is the seeder's job to reconcile — the migration is behaviour-neutral by construction, and the Brute's shove arrives when an admin runs `make seed-catalogs` or when Task 6 lands. State this in the seeder's guard comment so a later reader does not "fix" the migration to match.

- [ ] **Step 4: Extend the seeder**

In `backend/scripts/seed-catalogs.js`, add `seedOneAbility` alongside P2a's `seedOneBehavior`.

**Use explicit `::real` casts on every numeric parameter.** P2a lost an afternoon to `COALESCE($n, 1)` making Postgres infer an integer parameter, which rejected every fractional `move_speed_mult` with `invalid input syntax for type integer: "1.2"`. `damage_mult` of 1.4 is the same shape of value.

```js
// Upsert on (behavior_id, slot), resolving behavior_id by NAME. A behaviour
// the seeder does not know about is skipped rather than failing the run --
// same posture as grantStartingLoadout skipping a missing catalog name.
//
// COALESCE preserves an admin's hand-authored value only for columns the seed
// file leaves null; every column here is authored, so this is a straight
// overwrite of catalog-owned data. That is deliberate: an ability's stats ARE
// the catalog. Admin-authored abilities on admin-authored behaviours are
// untouched because their behaviour name is not in CREATURE_ABILITIES.
async function seedOneAbility(client, a) {
  const b = await client.query(
    'SELECT id FROM creature_behaviors WHERE name = $1', [a.behavior_name]);
  if (b.rows.length === 0) return { skipped: true };
  await client.query(
    `INSERT INTO creature_abilities
       (behavior_id, slot, name, attack_kind, attack_range, attack_cooldown,
        projectile_speed, projectile_radius, element, damage_mult, knockback)
     VALUES ($1, $2::int, $3, $4, $5::real, $6::real, $7::real, $8::real, $9, $10::real, $11::real)
     ON CONFLICT (behavior_id, slot) DO UPDATE SET
       name = EXCLUDED.name,
       attack_kind = EXCLUDED.attack_kind,
       attack_range = EXCLUDED.attack_range,
       attack_cooldown = EXCLUDED.attack_cooldown,
       projectile_speed = EXCLUDED.projectile_speed,
       projectile_radius = EXCLUDED.projectile_radius,
       element = EXCLUDED.element,
       damage_mult = EXCLUDED.damage_mult,
       knockback = EXCLUDED.knockback,
       updated_at = CURRENT_TIMESTAMP`,
    [b.rows[0].id, a.slot, a.name, a.attack_kind, a.attack_range, a.attack_cooldown,
     a.projectile_speed, a.projectile_radius, a.element, a.damage_mult, a.knockback],
  );
  return { skipped: false };
}
```

Call it for every entry in `CREATURE_ABILITIES` from the same place `seedOneBehavior` is called, and include the count in the seeder's summary output.

- [ ] **Step 5: Write the tests**

`backend/tests/creature_abilities_migration_db.test.js`. A DB test — skip when `DATABASE_URL` is unset, matching the project's existing pattern.

Three tests, and **write the expected numbers literally** rather than importing them from the seed file:

```js
test('every behaviour has a slot-1 ability matching what it used to carry', async () => {
  const r = await pool.query(
    `SELECT b.name, a.attack_kind, a.attack_range, a.attack_cooldown
     FROM creature_abilities a JOIN creature_behaviors b ON b.id = a.behavior_id
     WHERE a.slot = 1 ORDER BY b.name`);
  const byName = new Map(r.rows.map((x) => [x.name, x]));
  // Literal, NOT imported from seeds/data -- a test that reads the same file
  // the seeder reads passes against a seeder that writes nothing at all.
  assert.deepEqual(pick(byName.get('Line')), { attack_kind: 'melee', attack_range: 60, attack_cooldown: 1 });
  assert.deepEqual(pick(byName.get('Ranged')), { attack_kind: 'ranged', attack_range: 340, attack_cooldown: 1.8 });
  assert.deepEqual(pick(byName.get('Guard')), { attack_kind: 'melee', attack_range: 60, attack_cooldown: 1 });
});

test('Apex has two abilities in slot order', async () => { /* slots [1, 2], kinds ['cast', 'melee'] */ });

test('the slot uniqueness constraint refuses a duplicate slot', async () => {
  // Builds its OWN zz-prefixed behaviour and inserts two abilities into slot 1.
  // MUST NOT touch a real catalog row -- see Global Constraints #1. Deletes
  // the fixture by NAME in a finally.
});
```

- [ ] **Step 6: Run the tests**

Run: `npm test -- --test-timeout=20000` from `backend/`
Expected: the new file passes; **the golden trace still passes** (nothing reads the new table yet, so this is a free check that the migration disturbed nothing).

- [ ] **Step 7: Commit**

```bash
git add backend/migrations/1714440083000_creature_abilities.js \
        backend/seeds/data/creatureAbilities.js \
        backend/scripts/seed-catalogs.js \
        backend/tests/creature_abilities_migration_db.test.js
git commit -m "feat(creatures): add the creature_abilities catalog (SOMET-253)"
```

---

## Task 2: Abilities drive the tick

**Files:**
- Modify: `backend/src/services/creatureBehaviors.js`
- Modify: `backend/src/authority/creatures.js` (loader + tick)
- Modify: `backend/src/authority/server.js:596-607` (per-chunk query)
- Test: `backend/tests/creature_abilities_resolve.test.js`
- Test: `backend/tests/authority_ability_selection.test.js`
- Test: extend the existing loader-guard tests

**Interfaces:**
- Consumes: `creature_abilities` from Task 1.
- Produces: `resolveBehavior(row)` returns `{ ...movement fields, abilities: [ability, ...] }` where each ability is `{ slot, name, attackKind, attackRange, attackCooldown, projectileSpeed, projectileRadius, element, damageMult, knockback }`. `DEFAULT_BEHAVIOR.abilities` is a single-element array. Creature instances gain `_abilityCd`, a `Map` of slot → seconds remaining.

**⚠ This task is gated on the frozen golden trace.** It is not complete until `creature_behavior_golden.test.js` passes unchanged. The trace exercises the simulation, not the read path — if the resolver emits the same primary attack from a different source, all 120 ticks are byte-identical. Do not regenerate it.

- [ ] **Step 1: Write the failing resolver test**

`backend/tests/creature_abilities_resolve.test.js`:

```js
const { resolveBehavior, DEFAULT_BEHAVIOR } = require('../src/services/creatureBehaviors');

test('a row with no abilities resolves to the default single ability', () => {
  const b = resolveBehavior({ behavior_name: 'Line', chase_style: 'charge' });
  assert.equal(b.abilities.length, 1);
  assert.equal(b.abilities[0].attackKind, 'melee');
  assert.equal(b.abilities[0].attackRange, 60);
  assert.equal(b.abilities[0].attackCooldown, 1);
});

test('abilities arrive in slot order regardless of array order', () => {
  const b = resolveBehavior({
    behavior_name: 'zzApex', chase_style: 'charge',
    abilities: [
      { slot: 2, attack_kind: 'melee', attack_range: 90, attack_cooldown: 1.2 },
      { slot: 1, attack_kind: 'cast', attack_range: 260, attack_cooldown: 2 },
    ],
  });
  assert.deepEqual(b.abilities.map((a) => a.slot), [1, 2]);
});

test('a NULL numeric column falls back to the documented default, not zero', () => {
  // Number(null) === 0 and Number.isFinite(0) is true, so a NULL cooldown
  // resolving to 0 gives UNBOUNDED rate of fire. This is the exact bug P2a
  // caught in review before the module was written.
  const b = resolveBehavior({
    behavior_name: 'zzBroken', chase_style: 'charge',
    abilities: [{ slot: 1, attack_kind: 'melee', attack_range: null, attack_cooldown: null }],
  });
  assert.equal(b.abilities[0].attackCooldown, 1);
  assert.equal(b.abilities[0].attackRange, 60);
});

test('damage_mult of 0 survives — it is a pure status-rider ability', () => {
  const b = resolveBehavior({
    behavior_name: 'zzRider', chase_style: 'charge',
    abilities: [{ slot: 1, attack_kind: 'cast', attack_range: 200, attack_cooldown: 2, damage_mult: 0 }],
  });
  assert.equal(b.abilities[0].damageMult, 0);   // NOT 1 — `||` would break this
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --test-timeout=20000 backend/tests/creature_abilities_resolve.test.js`
Expected: FAIL — `b.abilities` is undefined.

- [ ] **Step 3: Extend the resolver**

In `backend/src/services/creatureBehaviors.js`, add a `DEFAULT_ABILITY`, a `resolveAbility`, and wire them into `resolveBehavior`. Reuse the existing `num`/`oneOf` helpers unchanged.

```js
const ELEMENTS = ['physical', 'fire', 'ice', 'lightning'];

// Today's hostile attack, and the fallback for a behaviour with no ability
// rows. Must equal CONTACT_RANGE (60) and CREATURE_ATTACK_COOLDOWN (1.0) in
// authority/creatures.js, for the same reason DEFAULT_BEHAVIOR's movement
// fields must equal AGGRO_RADIUS/LEASH_RADIUS.
const DEFAULT_ABILITY = Object.freeze({
  slot: 1,
  name: 'Attack',
  attackKind: 'melee',
  attackRange: 60,
  attackCooldown: 1,
  projectileSpeed: 0,
  projectileRadius: 0,
  element: null,      // null = use the creature type's attack_element
  damageMult: 1,
  knockback: 0,
});

function resolveAbility(row) {
  return {
    slot: Math.max(1, Math.trunc(num(row.slot, 1))),
    name: typeof row.name === 'string' && row.name ? row.name : DEFAULT_ABILITY.name,
    attackKind: oneOf(row.attack_kind, ATTACK_KINDS, DEFAULT_ABILITY.attackKind),
    attackRange: num(row.attack_range, DEFAULT_ABILITY.attackRange),
    attackCooldown: num(row.attack_cooldown, DEFAULT_ABILITY.attackCooldown),
    projectileSpeed: num(row.projectile_speed, DEFAULT_ABILITY.projectileSpeed),
    projectileRadius: num(row.projectile_radius, DEFAULT_ABILITY.projectileRadius),
    // null is meaningful ("inherit the type's element"), so an absent or
    // unrecognised value resolves to null rather than to 'physical' -- a
    // hard 'physical' here would silently strip a Caster's fire.
    element: ELEMENTS.includes(row.element) ? row.element : null,
    // 0 is a real value (a pure status-rider ability) and must survive, so
    // this is num() with a default, never `|| 1`.
    damageMult: num(row.damage_mult, DEFAULT_ABILITY.damageMult),
    knockback: num(row.knockback, DEFAULT_ABILITY.knockback),
  };
}

// Sorted by slot HERE as well as by the SQL's ORDER BY: the SQL ordering
// covers the live path, this covers every hand-built fixture and any caller
// that assembles the array itself. Selection reads "lowest slot first" off
// array order, so an unsorted array silently reprioritises a creature's moves.
function resolveAbilities(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [{ ...DEFAULT_ABILITY }];
  return rows.map(resolveAbility).sort((a, b) => a.slot - b.slot);
}
```

Add `abilities: resolveAbilities(row.abilities)` to `resolveBehavior`'s return, and `abilities: [DEFAULT_ABILITY]` to `DEFAULT_BEHAVIOR`. **Remove** the six flat attack fields (`attackKind`, `attackRange`, `attackCooldown`, `projectileSpeed`, `projectileRadius`) from both — two sources of truth for the primary attack is exactly the asymmetry this refactor exists to remove. `damageOverride` stays.

Export `DEFAULT_ABILITY` and `ELEMENTS`.

- [ ] **Step 4: Run the resolver test**

Run: `npm test -- --test-timeout=20000 backend/tests/creature_abilities_resolve.test.js`
Expected: PASS.

- [ ] **Step 5: Add the lateral join to both loaders**

**There are TWO creature-loading paths and both must carry abilities.** Wiring only one is what nearly shipped P2a's whole catalog inert: `loadCreatureTypes` feeds the TYPE catalog while live INSTANCES come from a separate per-chunk query, and every test builds creatures directly so a green suite proves nothing about either.

Write this fragment once as an exported constant and use it in both queries, so they cannot drift:

```js
// authority/creatures.js
// Abilities as one JSON array per creature, rather than a second round-trip
// or a row-multiplying join. ORDER BY a.slot inside the aggregate is
// load-bearing: slot order IS priority order, and json_agg over an unordered
// subquery would make a creature's move priority depend on physical row order.
// COALESCE covers a behaviour with no ability rows (json_agg of an empty set
// is NULL, not '[]').
const ABILITIES_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT COALESCE(json_agg(
             json_build_object(
               'slot', a.slot, 'name', a.name, 'attack_kind', a.attack_kind,
               'attack_range', a.attack_range, 'attack_cooldown', a.attack_cooldown,
               'projectile_speed', a.projectile_speed, 'projectile_radius', a.projectile_radius,
               'element', a.element, 'damage_mult', a.damage_mult, 'knockback', a.knockback
             ) ORDER BY a.slot
           ), '[]'::json) AS abilities
    FROM creature_abilities a WHERE a.behavior_id = b.id
  ) ab ON true`;
```

In `loadCreatureTypes`, append `ABILITIES_LATERAL` after the existing `LEFT JOIN creature_behaviors b`, and add `ab.abilities` to the SELECT list. Keep the six parent attack columns in the SELECT for now — Task 3 removes them along with the columns themselves.

In `server.js`'s per-chunk query (around line 596), do the same. Its behaviour join is already aliased `b`, so `ABILITIES_LATERAL` drops in unchanged. Import it from `./creatures`.

- [ ] **Step 6: Extend the loader guard tests**

Both loaders have a SELECT-completeness guard that scans the live SQL text for column names. Extend both to require `abilities`, `creature_abilities`, `damage_mult` and `knockback`.

**Keep rationale comments outside the template literal.** A comment inside the string satisfies the guard by itself — P2a shipped one of these.

Watch for SQL-text stubs: several unit tests match queries with patterns like `/FROM entity_types WHERE is_creature/i`. Adding the lateral join changed one of those in P2a and a test **hung** rather than failing. If the suite runs long, that is what happened.

- [ ] **Step 7: Write the selection test**

`backend/tests/authority_ability_selection.test.js`. **Assert the loser, not just the winner** — "the ready ability fired" passes against an implementation with no cooldown logic at all.

```js
test('the lowest ready in-range slot wins', () => { /* two abilities, both ready, both in range -> slot 1 */ });

test('a slot on cooldown is skipped in favour of a higher slot', () => {
  // Fire slot 1, then tick less than its cooldown but more than slot 2's.
  // Slot 2 must fire. An implementation with one shared cooldown fires
  // NOTHING here, and one with no cooldown logic fires slot 1 again.
});

test('an out-of-range ability is skipped for one that reaches', () => {
  // Target at 200px: slot 1 is melee/90, slot 2 is cast/260. Slot 2 fires.
});

test('when nothing qualifies the creature fires nothing', () => {
  // Does NOT fall back to slot 1. Assert hp unchanged AND no shot emitted.
});

test('cooldowns are per-instance, not per-behaviour', () => {
  // Two creatures sharing one behaviour object: firing one must not put the
  // other on cooldown. A cooldown stored on the shared behaviour would.
});
```

- [ ] **Step 8: Implement selection in the tick**

In `creatures.js`:

- `addCreatures`: replace `_attackCd: 0` with `_abilityCd: new Map()`.
- `tick`: replace the single decrement with a per-slot decrement.
- Add a module-level helper:

```js
// Deterministic: no rng. Among abilities whose cooldown has elapsed AND whose
// range covers `dist`, the LOWEST slot wins. Returns null when nothing
// qualifies -- the creature then fires nothing rather than falling back to
// slot 1, which would let an out-of-range creature hit from anywhere.
//
// `abilities` is already slot-sorted by resolveAbilities, so the first match
// IS the lowest slot.
function selectAbility(c, bh, dist) {
  for (const a of bh.abilities) {
    if ((c._abilityCd.get(a.slot) || 0) > 0) continue;
    if (dist > a.attackRange) continue;
    return a;
  }
  return null;
}

// True when ANY ability is off cooldown. `skirmish` retreats while its attack
// is recovering; with one ability this is identical to today's `_attackCd > 0`
// test, which is what keeps the golden trace green.
function anyAbilityReady(c, bh) {
  return bh.abilities.some((a) => (c._abilityCd.get(a.slot) || 0) <= 0);
}
```

Then, at the three sites that read the old flat fields:

1. **The guard branch** (~line 301): replace `bh.attackRange`/`bh.attackCooldown` with a `selectAbility(c, bh, Math.hypot(...))` result. A guard's damage stays `bh.damageOverride ?? c.damage`, now multiplied by `ability.damageMult`.
2. **The `skirmish` retreat test** (~line 368): `c._attackCd > 0` becomes `!anyAbilityReady(c, bh)`.
3. **The hostile attack block** (~line 404): replace the `bh.attackRange` gate with `selectAbility`, and read `attackKind`/`projectileSpeed`/`projectileRadius`/`element` off the selected ability. Damage becomes `(bh.damageOverride ?? (c.damage ?? CREATURE_DAMAGE)) * ability.damageMult`.

The element rule moves to the ability but keeps its meaning: a `ranged` ability fires physical; a `cast` ability fires `ability.element ?? c.attackElement ?? 'physical'`.

**Do not recompute `cc`.** The pre-move centre is deliberately reused for the range gate and the shot origin; recomputing it changes the trace.

Stamp `c._abilityCd.set(ability.slot, ability.attackCooldown)` wherever `c._attackCd = bh.attackCooldown` was stamped — and, exactly as before, **not** when the attack is refused by `canAct` or by a missing line of sight.

- [ ] **Step 9: Run the gate**

Run: `npm test -- --test-timeout=20000` from `backend/`
Expected: everything passes, **including `creature_behavior_golden.test.js` unchanged**.

If the trace is red, the refactor changed behaviour. Find the difference — do not regenerate the fixture. The most likely causes, in order: `cc` was recomputed after the move; a cooldown is now stamped on a refused attack; `resolveAbilities` did not sort; the skirmish retreat condition inverted.

- [ ] **Step 10: Verify the fixture was not touched**

```bash
git log --oneline -- backend/tests/fixtures/creature_tick_golden.json
git diff --stat main -- backend/tests/fixtures/
```

Expected: no commit on this branch, empty diff.

- [ ] **Step 11: Commit**

```bash
git add -A backend/src backend/tests
git commit -m "feat(creatures): drive the tick from creature_abilities (SOMET-253)"
```

---

## Task 3: Nested ability API, admin editor, and the column cutover

**Files:**
- Create: `backend/migrations/1714440084000_drop_behavior_attack_columns.js`
- Modify: `backend/src/index.js`
- Modify: `backend/src/authority/creatures.js`, `backend/src/authority/server.js` (drop the dead columns from both SELECTs)
- Create: `frontend/src/games/something2/abilityForm.js`

**Do not edit `1714440080000_creature_behaviors.js`.** It is already applied everywhere; the new migration supersedes it.

- Modify: `frontend/src/games/something2/behaviorForm.js`, `CreatureBehaviorsAdmin.jsx`, `useCreatureBehaviors.js`
- Test: `backend/tests/creature_abilities_api_db.test.js`, `frontend/src/games/something2/__tests__/abilityForm.test.js`

**Interfaces:**
- Consumes: the resolver and loaders from Task 2.
- Produces: `GET /api/creature-behaviors` returns each row with an `abilities` array; `POST`/`PUT` accept one and replace the set transactionally. `abilityFieldError(ability)` and `behaviorAbilitiesError(body)` exported from `index.js` for tests.

Abilities are managed **nested under the behaviour**, not as their own CRUD resource. Two validation rules span both tables, and a nested write is what lets them be checked atomically instead of in a race between two requests.

- [ ] **Step 1: Write the failing API test**

`backend/tests/creature_abilities_api_db.test.js`. Every test builds its own `zz`-prefixed behaviour and deletes it **by name, in a `finally`**. No test touches a real catalog row — see Global Constraints #1.

```js
test('GET returns abilities nested in slot order', async () => { /* ... */ });

test('PUT replaces the ability set transactionally', async () => {
  // Create zzTwo with two abilities, PUT with one, assert exactly one remains.
});

test('a rejected PUT leaves the existing abilities untouched', async () => {
  // PUT a valid behaviour with an INVALID second ability. Assert 400 AND
  // that the original two abilities are still there. Without a transaction
  // the delete lands and the reinsert fails, leaving the profile with none --
  // a creature that cannot attack at all.
});

test("chase_style 'guard' requires every ability be melee", async () => {
  // Carried from P2a's behaviorFieldError, now spanning both tables: the
  // guard branch applies contact damage with no line-of-sight check, so a
  // ranged guard ability would damage through walls.
});

test("chase_style 'kite' requires preferred_range <= the longest ability range", async () => {
  // A kiter that stands farther out than ANY of its abilities can reach
  // oscillates forever and never lands a hit.
});

test('slots are renumbered from 1 with no gaps', async () => {
  // POST abilities with slots [5, 9]; assert stored slots are [1, 2].
  // The admin editor implies slot by position, so the API must not preserve
  // whatever the client happened to send.
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --test-timeout=20000 backend/tests/creature_abilities_api_db.test.js`
Expected: FAIL — no `abilities` key in the response.

- [ ] **Step 3: Split the route validation**

In `backend/src/index.js`:

- `behaviorFieldError` **keeps**: `name`, `chase_style`, `aggro_radius`, `leash_radius`, `move_speed_mult`, `preferred_range`, `damage_override`. **Loses**: everything about attacks.
- New `abilityFieldError(a)` **gains**: `attack_kind`, `attack_range`, `attack_cooldown`, `projectile_speed`, `projectile_radius`, `element`, `damage_mult`, `knockback`.

Carry P2a's hard-won rules across, unchanged in meaning:

```js
function abilityFieldError(a) {
  if (!a || typeof a !== 'object') return 'ability must be an object';
  if (!a.name) return 'ability name is required';
  if (!ATTACK_KINDS.includes(a.attack_kind)) return `ability attack_kind must be one of ${ATTACK_KINDS.join(', ')}`;
  if (a.element != null && !ELEMENTS.includes(a.element)) return `ability element must be one of ${ELEMENTS.join(', ')}`;
  // Strictly positive, not merely finite: a 0 here is a creature that never
  // attacks (attack_range) or one with unbounded rate of fire
  // (attack_cooldown). Carried from SOMET-249's fix wave.
  for (const f of ['attack_range', 'attack_cooldown']) {
    if (!(Number(a[f]) > 0)) return `ability ${f} must be greater than 0`;
  }
  // A ranged/cast ability needs a projectile that actually moves. Number(undefined)
  // is NaN, so an omitted speed is caught here too.
  if ((a.attack_kind === 'ranged' || a.attack_kind === 'cast') && !(Number(a.projectile_speed) > 0)) {
    return "ability attack_kind 'ranged'/'cast' requires projectile_speed greater than 0";
  }
  // damage_mult 0 is legitimate (a pure status-rider), so this is >= 0, not > 0.
  for (const f of ['projectile_radius', 'damage_mult', 'knockback']) {
    if (a[f] != null && !(Number(a[f]) >= 0)) return `ability ${f} must be 0 or greater`;
  }
  return null;
}

// The two rules that span both tables. Checked on every write of either side,
// which is why abilities are nested under the behaviour rather than being
// their own resource -- two separate endpoints would let a valid behaviour and
// a valid ability combine into an invalid pair.
function behaviorAbilitiesError(body) {
  const list = body.abilities;
  if (!Array.isArray(list) || list.length === 0) {
    return 'at least one ability is required';   // zero abilities = a creature that cannot attack
  }
  for (const a of list) {
    const bad = abilityFieldError(a);
    if (bad) return bad;
  }
  if (body.chase_style === 'guard' && list.some((a) => a.attack_kind !== 'melee')) {
    return "chase_style 'guard' requires every ability to be melee";
  }
  if (body.chase_style === 'kite') {
    const longest = Math.max(...list.map((a) => Number(a.attack_range) || 0));
    if (Number(body.preferred_range) > longest) {
      return "chase_style 'kite' requires preferred_range <= the longest ability range";
    }
  }
  return null;
}
```

- [ ] **Step 4: Make the writes transactional**

`POST` and `PUT` take a client from the pool, `BEGIN`, write the parent, `DELETE FROM creature_abilities WHERE behavior_id = $1`, reinsert the array with slots renumbered `1..n` by position, then `COMMIT`. `ROLLBACK` in the catch.

This `DELETE` is scoped to one behaviour's children in a route handler and is the intended way to replace a set — it is not the destructive catalog write Global Constraint #2 forbids, which is about tests and scratch scripts operating on real catalog rows.

`GET` gains the same `LEFT JOIN LATERAL` used by the loaders. Import `ABILITIES_LATERAL` rather than writing a third copy.

- [ ] **Step 5: Write the migration that drops the parent columns**

```js
exports.shorthands = undefined;

// The cutover. Task 1's backfill copied these six columns into slot-1
// ability rows and Task 2 moved every reader onto that table, so these are
// now dead. Dropping them is what makes creature_abilities the single source
// of truth for what a creature does -- leaving them would leave two, and a
// future edit to the wrong one would fail silently.
//
// `down` restores the columns AND repopulates them from slot 1, so the pair
// round-trips. A behaviour whose slot-1 ability was deleted after the up
// migration gets the Line defaults rather than a NOT NULL violation.
exports.up = (pgm) => {
  pgm.dropColumns('creature_behaviors', [
    'attack_kind', 'attack_range', 'attack_cooldown',
    'projectile_speed', 'projectile_radius',
  ]);
};

exports.down = (pgm) => {
  pgm.addColumns('creature_behaviors', {
    attack_kind: { type: 'text', notNull: true, default: 'melee' },
    attack_range: { type: 'real', notNull: true, default: 60 },
    attack_cooldown: { type: 'real', notNull: true, default: 1 },
    projectile_speed: { type: 'real', notNull: true, default: 0 },
    projectile_radius: { type: 'real', notNull: true, default: 0 },
  });
  pgm.sql(`
    UPDATE creature_behaviors b SET
      attack_kind = a.attack_kind, attack_range = a.attack_range,
      attack_cooldown = a.attack_cooldown, projectile_speed = a.projectile_speed,
      projectile_radius = a.projectile_radius
    FROM creature_abilities a
    WHERE a.behavior_id = b.id AND a.slot = 1
  `);
  pgm.addConstraint('creature_behaviors', 'creature_behaviors_attack_kind_check',
    "CHECK (attack_kind IN ('melee','ranged','cast'))");
};
```

Then remove the five dead column names from both loader SELECTs and from the `INSERT`/`UPDATE` in the behaviour routes.

- [ ] **Step 6: Verify the migration round-trips**

Run from `backend/`: `npm run migrate:up`, then `npm run migrate:down 1`, then `npm run migrate:up` again.
Expected: all three succeed, and after the final `up` the twelve behaviours still have their slot-1 abilities.

There is no `npm run migrate:down` without a count — the script requires one.

- [ ] **Step 7: Frontend — the pure helpers**

`frontend/src/games/something2/abilityForm.js`. Frontend vitest runs in a **node environment with no DOM**, so the component cannot be rendered; these pure helpers are the testable part, following `behaviorForm.js`'s existing split.

```js
export const ELEMENTS = ["physical", "fire", "ice", "lightning"];

// Defaults for a BRAND-NEW ability, mirroring the Line profile's attack
// rather than 0. P2a's final review caught an Add-Behavior modal that
// defaulted every numeric to 0, which produced a creature that never moved,
// never aggroed and never attacked -- no error, nothing logged. The same trap
// here would give attack_range 0 (never attacks) or attack_cooldown 0
// (unbounded rate of fire).
const NEW_ABILITY_DEFAULTS = {
  attack_range: 60,
  attack_cooldown: 1,
  projectile_speed: 0,
  projectile_radius: 0,
  damage_mult: 1,
  knockback: 0,
};

export function abilityToForm(row = {}) { /* same isNewRow shape as behaviorToForm */ }
export function abilityFormToPayload(form, index) {
  // slot is IMPLIED BY POSITION -- the editor reorders by drag, and the API
  // renumbers 1..n anyway. Never read a slot out of the form.
  return { slot: index + 1, /* ... */ };
}
```

`damage_mult` and `knockback` use `Number(form[k])` with an explicit `Number.isFinite` guard, **not** `Number(x) || 0` — a `damage_mult` of 0 is a legitimate pure-rider ability and `|| 0` would silently rewrite a deliberate 0 as 0 (harmless) while `|| 1` elsewhere would rewrite it as 1 (not harmless). Be explicit.

- [ ] **Step 8: Frontend — strip the attack fields from `behaviorForm.js`**

Remove `attack_range`, `attack_cooldown`, `projectile_speed`, `projectile_radius` from `NUMERIC` and `NEW_ROW_DEFAULTS`, and `attack_kind` from `behaviorToForm`. They live in `abilityForm.js` now.

- [ ] **Step 9: Frontend — the nested editor**

In `CreatureBehaviorsAdmin.jsx`, add an ability list to the edit modal: add / remove / move-up / move-down, with slot shown as position. Submit `abilities` alongside the behaviour fields. `useCreatureBehaviors.js` passes the array straight through.

Follow the existing `--s2-*` design tokens; light and dark are both live.

- [ ] **Step 10: Run both suites**

Run: `npm test -- --test-timeout=20000` from `backend/`, `npx vitest run` from `frontend/`
Expected: both green, **golden trace included**.

- [ ] **Step 11: Commit**

```bash
git commit -m "feat(creatures): manage abilities nested under the behaviour (SOMET-253)"
```

---

## Task 4: Aura schema, resolver and seed

**Files:**
- Create: `backend/migrations/1714440085000_behavior_auras.js`
- Modify: `backend/src/services/creatureBehaviors.js`, `backend/seeds/data/creatureBehaviors.js`, `backend/scripts/seed-catalogs.js`, both loader SELECTs
- Test: `backend/tests/creature_aura_resolve.test.js`

**Interfaces:**
- Produces: `resolveBehavior` gains `auraRadius`, `auraDamageMult`, `auraDefenseMult`, `auraSpeedMult`, `goldMin`, `goldMax`. `auraRadius: 0` means no aura.

- [ ] **Step 1: Write the migration**

```js
exports.up = (pgm) => {
  pgm.addColumns('creature_behaviors', {
    // 0 = not a leader. Every existing profile stays 0, so this migration is
    // behaviour-neutral and the golden trace must stay green across it.
    aura_radius: { type: 'real', notNull: true, default: 0 },
    aura_damage_mult: { type: 'real', notNull: true, default: 1 },
    aura_defense_mult: { type: 'real', notNull: true, default: 1 },
    aura_speed_mult: { type: 'real', notNull: true, default: 1 },
    // Per-rung gold, used as a FALLBACK when the entity type's own range is
    // absent or zero -- see loot.js. Lets P4 author 288 creatures with no
    // gold authoring at all.
    gold_min: { type: 'integer', notNull: true, default: 0 },
    gold_max: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addConstraint('creature_behaviors', 'creature_behaviors_aura_check',
    'CHECK (aura_radius >= 0 AND aura_damage_mult > 0 AND aura_defense_mult > 0 AND aura_speed_mult > 0)');
  pgm.addConstraint('creature_behaviors', 'creature_behaviors_gold_check',
    'CHECK (gold_min >= 0 AND gold_max >= gold_min)');

  // Champion is the rung the umbrella describes as a pack leader, so it is
  // the profile that gets a real aura. Without one, the aura code Task 5
  // builds has no live consumer and cannot be browser-verified.
  pgm.sql(`
    UPDATE creature_behaviors
    SET aura_radius = 260, aura_damage_mult = 1.25, aura_defense_mult = 1.2, aura_speed_mult = 1.1
    WHERE name = 'Champion'
  `);

  // Per-rung gold, ascending with the rung. Guard gets none: a village guard
  // is not a purse.
  pgm.sql(`
    UPDATE creature_behaviors SET gold_min = v.lo, gold_max = v.hi
    FROM (VALUES
      ('Swarm', 0, 3), ('Skirmisher', 1, 6), ('Line', 1, 5), ('Ranged', 2, 8),
      ('Caster', 3, 12), ('Brute', 4, 14), ('Heavy', 5, 18), ('Champion', 10, 30),
      ('Apex', 25, 80), ('Sentry', 2, 9), ('Lurker', 2, 7)
    ) AS v(name, lo, hi)
    WHERE creature_behaviors.name = v.name
  `);
};

exports.down = (pgm) => {
  pgm.dropColumns('creature_behaviors',
    ['aura_radius', 'aura_damage_mult', 'aura_defense_mult', 'aura_speed_mult', 'gold_min', 'gold_max']);
};
```

- [ ] **Step 2: Write the failing resolver test**

```js
test('a behaviour with no aura resolves to radius 0 and neutral multipliers', () => { /* ... */ });
test('a NULL aura multiplier falls back to 1, not 0', () => {
  // Number(null) === 0 -- and an auraDamageMult of 0 would make every buffed
  // creature deal NOTHING. Same trap as the cooldown in Task 2.
});
```

- [ ] **Step 3: Extend the resolver, the seed file, the seeder, and both SELECTs**

Add the six fields via the existing `num` helper with defaults `0, 1, 1, 1, 0, 0`. Add them to `DEFAULT_BEHAVIOR` and `GUARD_DEFAULT_BEHAVIOR`. Add them to `CREATURE_BEHAVIORS` in the seed data, to `seedOneBehavior`'s upsert with `::real`/`::int` casts, to both loader SELECTs, and to both loader guard tests.

- [ ] **Step 4: Run the suite**

Run: `npm test -- --test-timeout=20000` from `backend/`
Expected: green, **golden trace included** — nothing reads the aura yet.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(creatures): add pack-leader aura and per-rung gold columns (SOMET-253)"
```

---

## Task 5: Auras in the tick

**Files:**
- Modify: `backend/src/authority/creatures.js`
- Test: `backend/tests/authority_creature_auras.test.js`

**Interfaces:**
- Consumes: the aura fields from Task 4.
- Produces: `computeAuras(creatures)` returning `Map<creatureId, {damageMult, defenseMult, speedMult}>`; creature instances gain a transient `_buff`.

- [ ] **Step 1: Write the failing tests**

These four assertions are the load-bearing ones. Each is written specifically because a weaker version of it passes against a broken implementation.

```js
test('a leader buffs a same-faction creature in range', () => { /* baseline */ });

test('a leader does not buff itself', () => {
  // An aura is leadership, not self-empowerment. Also stops a lone Champion
  // silently becoming 25% stronger than its catalog row says.
});

test('a leader does not buff the other faction', () => {
  // A hostile Champion must not strengthen the guards fighting it.
});

test('two overlapping leaders do not stack — the strongest single value wins', () => {
  // THE load-bearing aura test. A one-leader test passes against an
  // implementation that multiplies. Two 1.25x leaders must give 1.25x,
  // not 1.5625x.
  // Assert the exact number: 1.25.
});

test('an aura never mutates the creature\'s base stats', () => {
  // Tick 30 times inside the aura, then 30 outside. Base damage and speed
  // must be exactly what they started as. An implementation that writes
  // c.damage *= 1.25 each tick reaches ~800x over 30 ticks; one that writes
  // it once still never recovers when the leader dies.
  // Assert base damage === 5 and speed === 40 literally.
});

test('the buff vanishes the tick after the leader dies', () => {
  // Kill the leader, tick once, assert the neighbour's effective damage is
  // back to base. This is what "never persisted" buys.
});

test('an out-of-range creature is unbuffed', () => { /* radius boundary */ });
```

- [ ] **Step 2: Run to confirm they fail**

Run: `npm test -- --test-timeout=20000 backend/tests/authority_creature_auras.test.js`
Expected: FAIL — `computeAuras` is not defined.

- [ ] **Step 3: Implement**

```js
// Pack-leader auras. Recomputed from scratch every tick and never persisted:
// a leader's death removes its buff on the next tick with no cleanup path,
// so the failure mode where a buff outlives its source cannot occur.
//
// NON-STACKING: the strongest single value wins per stat. Two overlapping
// Champions must not compound into a 1.5625x damage pack -- that is the
// difference between a hard fight and an unwinnable one.
//
// A leader does not buff itself.
//
// O(leaders x creatures). Leaders are rare and MAX_WORLD_CREATURES bounds the
// inner term, so this stays cheap without an index.
function computeAuras(creatures) {
  const buffs = new Map();
  const leaders = [];
  for (const c of creatures) {
    const bh = c.behavior || DEFAULT_BEHAVIOR;
    if (bh.auraRadius > 0 && c.hp > 0) leaders.push({ c, bh });
  }
  if (leaders.length === 0) return buffs;
  for (const { c: leader, bh } of leaders) {
    const lc = center(leader);
    const r2 = bh.auraRadius * bh.auraRadius;
    for (const other of creatures) {
      if (other === leader || other.hp <= 0) continue;
      if (other.faction !== leader.faction) continue;
      const oc = center(other);
      if (dist2(lc.x, lc.y, oc.x, oc.y) > r2) continue;
      const cur = buffs.get(other.id);
      if (!cur) {
        buffs.set(other.id, {
          damageMult: bh.auraDamageMult,
          defenseMult: bh.auraDefenseMult,
          speedMult: bh.auraSpeedMult,
        });
      } else {
        // Math.max, never multiplication -- this line IS the non-stacking rule.
        cur.damageMult = Math.max(cur.damageMult, bh.auraDamageMult);
        cur.defenseMult = Math.max(cur.defenseMult, bh.auraDefenseMult);
        cur.speedMult = Math.max(cur.speedMult, bh.auraSpeedMult);
      }
    }
  }
  return buffs;
}

const NO_BUFF = Object.freeze({ damageMult: 1, defenseMult: 1, speedMult: 1 });
```

In `tick`, immediately after `const all = [...this.creatures.values()]`:

```js
// Computed once per tick over the whole set, not per creature: an aura is a
// property of the field, and recomputing it inside the loop would let a
// creature that moved earlier this tick buff differently than one that has
// not moved yet.
const buffs = computeAuras(all);
```

Then, at each use site — **never by mutating the creature**, following `movedWith`'s precedent:

First, in one pass over `all` before the main loop, assign every creature `c._buff = buffs.get(c.id) || NO_BUFF`. The buff lives on the instance because it is read from outside this loop — other creatures' attacks and projectile collisions both need a target's defence buff.

Then, at each use site, read `c._buff` and **never write to `c.damage`, `c.speed` or `c.mit`**:

- Movement: `movedWith(this.map, c, vx, vy, dt, bh.moveSpeedMult * c._buff.speedMult)` at all five call sites.
- Damage dealt: multiply the resolved damage by `c._buff.damageMult`.
- Damage taken: the attacker passes `{ defense: tgt.mit.defense * tgt._buff.defenseMult, resistances: tgt.mit.resistances }` in place of `tgt.mit`. A small helper — `effectiveMit(target)` — keeps the four damage call sites from drifting.

A creature outside the active chunk set is skipped by the tick loop but must still receive `_buff` — otherwise it keeps a stale buff from whenever it was last active. Assign `_buff` for **every** creature, before the `active.has(...)` check.

- [ ] **Step 4: Run the tests, then the suite**

Expected: the new file passes; the full suite is green **including the golden trace** — no seeded profile except Champion has an aura, and the trace's fixture uses none.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(creatures): apply pack-leader auras in the tick (SOMET-253)"
```

---

## Task 6: The knockback primitive and creature-side knockback

**Files:**
- Create: `backend/src/authority/knockback.js`
- Modify: `backend/src/authority/server.js` (remove the local copy, import instead)
- Modify: `backend/src/authority/creatures.js`, `backend/src/authority/projectiles.js`, `backend/src/authority/world.js`
- Test: `backend/tests/authority_knockback.test.js`

**Interfaces:**
- Produces: `knockbackPosition({px, py, fromX, fromY, distance, map})` — the existing function, renamed parameters, same all-or-nothing semantics. `knockbackWithFallback({...})` — tries `distance`, then `distance / 2`, then `distance / 4`.

- [ ] **Step 1: Extract the primitive**

Move `knockbackPosition` from `server.js:142` into `backend/src/authority/knockback.js` **verbatim**, renaming only `portalX`/`portalY` to `fromX`/`fromY`. Its behaviour must not change: the portal bounce is not this item's business.

```js
// Extracted from authority/server.js, where it was written for SOMET-243's
// blocked-portal bounce. Unchanged apart from parameter names -- the portal
// path still calls it with the same arguments and gets the same result.
//
// All-or-nothing by design: a candidate that is not walkable yields no move
// at all, so nothing is ever displaced into geometry.
function knockbackPosition({ px, py, fromX, fromY, distance, map }) { /* verbatim */ }

// Combat knockback. Tries the full distance, then half, then a quarter,
// taking the first that lands somewhere walkable.
//
// The portal bounce deliberately does NOT use this: it fires once per bump and
// changing its feel is out of scope. Combat knockback fires constantly, and
// without the retry a target standing against a wall absorbs the shove
// entirely -- which reads as the mechanic being broken rather than as terrain
// working.
function knockbackWithFallback({ px, py, fromX, fromY, distance, map }) {
  for (const d of [distance, distance / 2, distance / 4]) {
    const r = knockbackPosition({ px, py, fromX, fromY, distance: d, map });
    if (r.x !== px || r.y !== py) return r;
  }
  return { x: px, y: py };
}

module.exports = { knockbackPosition, knockbackWithFallback };
```

In `server.js`, delete the local definition and import it. Everything else at the call site stays.

- [ ] **Step 2: Write the failing tests**

```js
test('a shove moves the target directly away from the attacker', () => {
  // Assert DIRECTION, not just "it moved" -- a target that moved on its own
  // passes the weaker version. Attacker at (0,0), target at (100,0),
  // distance 50 -> target ends at x=150, y=0.
});

test('a target against a wall is shoved the furthest distance that fits', () => {
  // Open floor for 30px then wall. distance 100 -> the full 100 fails, 50
  // fails, 25 lands. Assert the target ended 25px away and is on walkable
  // ground -- never inside geometry, and never nowhere at all.
});

test('a target boxed in on every side is not moved', () => {
  // All three distances fail. Assert the position is EXACTLY unchanged
  // rather than NaN or undefined.
});

test('the portal bounce is unchanged', () => {
  // knockbackPosition called with the portal path's arguments gives exactly
  // what it gave before: full distance or nothing, no retry ladder.
});

test('a degenerate zero-length vector does not produce NaN', () => {
  // Attacker exactly on the target. The extracted function pushes north.
});
```

- [ ] **Step 3: Apply knockback on creature melee hits**

In `creatures.js`, in both attack branches, after damage lands and when `ability.knockback > 0`, displace the target away from the creature's centre using `knockbackWithFallback`. For a player target, write `tp.x`/`tp.y` directly — this is the same server-authoritative assignment `server.js:1147` already makes. Mark creature targets `dirty`.

**Knock back only survivors.** Check `hp > 0` after damage; shoving a corpse moves something the sim is about to remove.

- [ ] **Step 4: Thread knockback through projectiles**

Add `knockback` to the shot objects `tick` pushes, to `ProjectileSim.spawn`'s accepted fields, and apply it at all **four** collision sites (`projectiles.js` lines ~106, ~129, ~185, ~212 — two discrete, two swept). `step` already receives `map` in its context object, so the wall clamp needs no new plumbing.

Missing one of the four sites is the likely defect here: the swept path handles fast projectiles and is the one a hand test is least likely to trigger. Assert all four.

- [ ] **Step 5: Run the tests, then the suite**

Expected: green including the trace.

The trace is safe for two independent reasons, and it is worth knowing both: the migration's backfill wrote `knockback = 0` into every slot-1 row, and the only non-zero seeded value (the Apex's Slam, at 120) belongs to a rung **no creature type references** — see "Which profiles are live". The Brute's 140 arrives only when an admin runs `make seed-catalogs`, and the Brute is likewise unreferenced.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(creatures): extract the knockback primitive and shove on creature hits (SOMET-253)"
```

---

## Task 7: Per-rung loot and gold

**Files:**
- Create: `backend/migrations/1714440086000_behavior_drops.js`
- Create: `backend/seeds/data/behaviorDrops.js`
- Modify: `backend/src/authority/loot.js`, `backend/src/authority/creatures.js` (load the rung gold), `backend/scripts/seed-catalogs.js`
- Test: `backend/tests/loot_behavior_drops.test.js`

**Interfaces:**
- Produces: table `behavior_drops` mirroring `creature_drops`; `entry.behaviorDrops` and `entry.behaviorGold` maps keyed by creature type name.

- [ ] **Step 1: Write the migration**

Mirror `creature_drops` exactly — same columns, same CHECK constraints, keyed on `behavior_id`. Seed a modest baseline per rung against item types that exist, guarded with `WHERE EXISTS` so a missing item type inserts nothing rather than failing the migration (the posture `1714440018000_create_loot.js` already uses).

- [ ] **Step 2: Write the failing tests**

```js
test('a creature rolls BOTH its rung drops and its type drops', async () => {
  // THE load-bearing test. A creature with only one of the two passes
  // against an implementation that returns whichever it finds first.
  // Build a zz creature type with its own drop AND a rung with a drop,
  // force rng to 0 so everything rolls, assert BOTH items landed.
});

test('a creature type with no drops of its own still gets its rung drop', async () => {
  // This is the case P4 depends on for all 288 rows.
});

test('the type gold range wins when it is set', async () => { /* ... */ });

test('the rung gold range is used when the type has none', async () => {
  // Type gold_min/gold_max both 0 -> falls back to the behaviour's.
});

test('a type gold range of zero with no rung fallback drops no gold', async () => {
  // Neither set -> 0, not NaN, not a coin pile of 0.
});
```

- [ ] **Step 3: Implement**

In `loot.js`'s `spawnDrops`, query `behavior_drops` alongside `creature_drops` and roll both through the existing `rollDrops`. Two queries rather than a `UNION`: the rung lookup keys on `behavior_id`, which `entry` already knows per type name, and keeping them separate makes the union explicit at the call site rather than hidden in SQL.

For gold, `rollGold` takes the type's range; change the caller to `typeRange.max > 0 ? typeRange : rungRange`. **`max > 0`, not truthiness on the object** — the range object always exists.

Extend `loadCreatureTypes` to build `behaviorGold` (name → `{min, max}` from the behaviour) alongside the existing `creatureGold`, and thread it onto `entry` the same way.

- [ ] **Step 4: Extend the seeder** with `seedOneBehaviorDrop`, guarded by `NOT EXISTS` like `seedOneCreatureDrop` (`behavior_drops` has no unique constraint to conflict on).

- [ ] **Step 5: Run the tests, then the suite.** Expected: green.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(loot): roll per-rung drops and gold alongside type drops (SOMET-253)"
```

---

## Task 8: Aura and per-rung gold in the admin

**Files:**
- Modify: `frontend/src/games/something2/behaviorForm.js`, `CreatureBehaviorsAdmin.jsx`
- Modify: `backend/src/index.js` (`behaviorFieldError` gains the aura and gold fields)
- Test: `frontend/src/games/something2/__tests__/behaviorForm.test.js`

**`behavior_drops` gets no admin editor**, and that is deliberate rather than an omission: `creature_drops` has none either (verified — nothing in `frontend/src/` references it), so building one for the rung table alone would make per-rung loot editable while per-type loot stays seed-managed. Both stay seed- and migration-managed. If drop editing is wanted later it should cover both tables at once, as its own item.

- [ ] **Step 1: Write the failing tests**

```js
it("defaults a new profile's aura multipliers to 1, never 0", () => {
  // An auraDamageMult of 0 makes every buffed creature deal NOTHING. This is
  // the same silent-inertness trap P2a's final review caught in the
  // Add-Behavior modal, which defaulted every numeric to 0.
});

it("round-trips an existing profile's genuine 0 aura_radius", () => {
  // 0 means "not a leader" and is the correct value for eleven of twelve
  // profiles. It must not be overwritten by the new-row default.
});

it('rejects gold_max below gold_min', () => { /* mirrors the CHECK constraint */ });
```

- [ ] **Step 2: Implement.** Add the six fields to `NUMERIC`/`NEW_ROW_DEFAULTS` with defaults `0, 1, 1, 1, 0, 0`, add the inputs to the modal, and extend `behaviorFieldError` with the matching server-side rules (multipliers `> 0`, `aura_radius >= 0`, `gold_max >= gold_min`).

- [ ] **Step 3: Run both suites.** Expected: green.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(admin): edit auras and per-rung gold on the behaviour form (SOMET-253)"
```

---

## Task 9: Weapon knockback

**Files:**
- Create: `backend/migrations/1714440087000_item_knockback.js`
- Modify: `backend/src/authority/world.js`, `backend/src/index.js`, `frontend/src/games/something2/ItemTypesAdmin.jsx`
- Test: `backend/tests/world_weapon_knockback.test.js`

This is the widest surface in the branch — it reaches `item_types`, the weapon admin and the player attack path — so it lands last, on a branch that is already stable.

- [ ] **Step 1: Migration.** Add `item_types.knockback`, `real`, `notNull`, default 0, `CHECK (knockback >= 0)`. Give the existing melee weapons a modest value so the mechanic has a live consumer.

- [ ] **Step 2: Write the failing tests**

```js
test('a melee swing shoves surviving creatures away from the player', () => {
  // Direction, not just displacement.
});

test('a creature killed by the swing is not shoved', () => {
  // applyMeleeArc deletes what it kills. meleeArcTargets is captured BEFORE
  // the swing, so survivors = targets minus killed. Shoving a corpse moves
  // something already removed from the sim.
});

test('a weapon with knockback 0 moves nothing', () => {
  // Guards against an implementation that always applies a default shove.
});

test('a player hit by another player\'s swing is shoved', () => { /* PvP path */ });
```

- [ ] **Step 3: Implement** in `world.attack`'s melee branch: compute survivors as `creatureTargets` minus `killed`, and shove each with `knockbackWithFallback` when `w.knockback > 0`. Do the same in the player-vs-player loop, which already has the other player in hand.

- [ ] **Step 4: Add `knockback` to the item-type routes and the weapon admin form**, defaulting a new weapon to 0 (a weapon with no shove is the correct default; unlike a cooldown, 0 here is inert in the harmless direction).

- [ ] **Step 5: Run both suites.** Expected: green including the trace.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(combat): give weapons knockback (SOMET-253)"
```

---

## Task 10: Live-wiring sweep

**Files:**
- Test: `backend/tests/creature_mechanics_wiring.test.js`
- Modify: whatever the sweep finds

Every mechanic in this branch can be fully implemented, fully tested and completely unreachable in the running game. That is not hypothetical: P2a's catalog was inert in production with a green suite, because tests build creatures directly and never go through the loader that real creatures come from. The same failure recurred one layer up in the same sub-project, where every test stopped at `CreatureSim.tick` and left the shot→`spawn` field mapping uncovered.

This task exists to check the seams no per-task review sees.

- [ ] **Step 1: Trace each mechanic from the database to the tick, by hand**

For each of aura, multi-ability, creature knockback, weapon knockback, rung drops and rung gold, answer in writing:

1. Which query reads the column? Is that query on the **live** path, or only the type-catalog path?
2. Does the value survive `resolveBehavior`/`resolveAbility`, or is it dropped in the mapping?
3. Is it attached to the instance in `addCreatures`, or only to the type?
4. Does the tick read it, or read a stale copy?

Record the answers in the task report.

- [ ] **Step 2: Write the wiring tests**

One per mechanic, each starting from a **row shaped exactly like the live loader's output** — including the `abilities` JSON array as `pg` would return it — not from a hand-built behaviour object. A test that constructs `{ behavior: {...} }` directly bypasses the entire read path and is exactly why the P2a defect survived.

- [ ] **Step 3: Fix whatever the sweep finds.** Report each defect in the task report with the seam it fell through.

- [ ] **Step 4: Full suite, both sides**

Run: `npm test -- --test-timeout=20000` from `backend/`, `npx vitest run` from `frontend/`
Expected: green, golden trace included.

- [ ] **Step 5: Confirm the fixture is still untouched**

```bash
git diff --stat main -- backend/tests/fixtures/
```

Expected: empty.

- [ ] **Step 6: Commit**

```bash
git commit -m "test(creatures): prove every P2b mechanic reaches the live tick (SOMET-253)"
```

---

## Verification checklist

Run after the final whole-branch review, before merging.

- [ ] `npm test -- --test-timeout=20000` from `backend/` — 0 failures
- [ ] `npx vitest run` from `frontend/` — 0 failures
- [ ] `git diff --stat main -- backend/tests/fixtures/` — empty
- [ ] `npm run migrate:up` then `npm run migrate:down 5` then `npm run migrate:up` — clean round trip
- [ ] `make seed-catalogs` twice in a row — second run reports no changes, and no hand-authored row is lost
- [ ] Browser: a Champion-profile creature visibly buffs neighbours; the buff vanishes when it dies
- [ ] Browser: an Apex fires both abilities, with different elements and cadences
- [ ] Browser: a player is shoved by a creature hit; a creature is shoved by a weapon swing
- [ ] Browser: a creature whose type has no drops still drops its rung's loot and gold
- [ ] Every temporary catalog edit reverted, and the revert verified by query
- [ ] No `zz` rows left in any table
