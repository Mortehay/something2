# P2a — Creature Attack Kinds and Aggro Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move creature combat behaviour out of hardcoded constants into a
twelve-row `creature_behaviors` catalog, and give creatures ranged and
elemental attacks plus four new chase styles — without changing how any
existing creature behaves.

**Architecture:** A name-keyed catalog table holds the behaviour profiles.
`entity_types` references one by integer FK. `loadCreatureTypes` joins it and
`CreatureSim` dispatches on `chase_style`. Creature-fired projectiles reuse the
existing `ProjectileSim` via a new `ownerKind` discriminator rather than a
parallel simulation.

**Tech Stack:** Node CommonJS backend, `node:test` + `node:assert`, raw `pg`,
`node-pg-migrate`. React ESM frontend with vitest in **node environment — there
is no DOM**, so frontend tests cover pure helpers, never rendered components.

**Spec:** `docs/superpowers/specs/2026-08-07-p2a-creature-behaviors-design.md`

## Global Constraints

- **Migration range is `1714440080000`–`1714440089000`.** Nothing outside it.
  Highest migration currently on `main` is `1714440070000`.
- **Zero observable behaviour change on existing content.** Bat, Skeleton,
  Slime and Wolf must behave exactly as they do today; Village Guard and portal
  guards likewise. Task 1 captures the baseline that proves it.
- **`Line` profile values are exactly:** attack_range 60, attack_cooldown 1.0,
  aggro_radius 400, leash_radius 800, chase_style `charge`, move_speed_mult 1.0,
  damage_override NULL.
- **`Guard` profile values are exactly:** attack_range 60, attack_cooldown 1.0,
  aggro_radius 400, leash_radius 300, chase_style `guard`, move_speed_mult 1.0,
  damage_override 25.
- **Never write a test that derives its expected value from the same constant
  or seed file the implementation reads.** Write literal numbers. This repo has
  shipped fifteen tests with that defect.
- **`make seed-catalogs` must never overwrite hand-authored data.** Omitted
  fields use `COALESCE($n, table.col)`.
- **Never run destructive SQL against the dev database.** No `DELETE FROM
  <catalog>`, no `TRUNCATE`, no `DROP`. A reviewer once wiped `entity_types`
  testing a seeder.
- **Test fixtures are `zz`-prefixed and deleted by name, unconditionally, in a
  `finally`** — never by an id captured mid-test.
- **Do not touch** `PATH_NAME_RE`, `detectPathTile`,
  `backend/src/authority/collision.js`, `frontend/src/games/something2/movement.js`.
- **Commits:** `type(scope): summary (SOMET-249)`, ending with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Use
  `git commit -F -` with a heredoc — backticks in a `-m` string get shell-substituted.
- Backend tests: `cd backend && npm test`. Frontend: `cd frontend && npx vitest run`.

---

## File Structure

**Created:**

| file | responsibility |
|---|---|
| `backend/migrations/1714440080000_creature_behaviors.js` | the catalog table + its twelve rows |
| `backend/migrations/1714440081000_entity_behavior.js` | `entity_types.behavior_id` / `attack_element` + backfill |
| `backend/seeds/data/creatureBehaviors.js` | the twelve profiles as checked-in seed data |
| `backend/src/services/creatureBehaviors.js` | pure row → behaviour normalisation, and the fallback constants |
| `backend/tests/fixtures/creature_tick_golden.json` | the pre-change behaviour baseline |
| `backend/tests/creature_behavior_golden.test.js` | asserts the sim still reproduces the baseline |
| `backend/tests/creature_behaviors_resolve.test.js` | pure resolver tests |
| `backend/tests/creature_behaviors_seed_db.test.js` | seeder + catalog integrity (DB) |
| `backend/tests/authority_creature_styles.test.js` | the four new chase styles |
| `backend/tests/authority_creature_shots.test.js` | ranged/cast firing, LOS, projectile cap |
| `backend/tests/creature_behaviors_api_db.test.js` | route CRUD + delete guard (DB) |
| `frontend/src/games/something2/CreatureBehaviorsAdmin.jsx` | the admin surface |
| `frontend/src/games/something2/useCreatureBehaviors.js` | its data hook |
| `frontend/src/games/something2/behaviorForm.js` | pure form ↔ payload helpers (the testable part) |
| `frontend/src/games/something2/__tests__/behaviorForm.test.js` | those helpers |

**Modified:** `backend/scripts/seed-catalogs.js`,
`backend/src/authority/creatures.js`, `backend/src/authority/projectiles.js`,
`backend/src/authority/world.js`, `backend/src/index.js`,
`backend/tests/catalog_seed_data.test.js`,
`backend/tests/authority_projectiles.test.js`, `frontend/src/App.jsx`,
`frontend/src/ui/MainNav.jsx`,
`frontend/src/games/something2/EntityTypesAdmin.jsx`,
`frontend/src/games/something2/__tests__/themeTokens.test.js`.

---

## The twelve profiles

Every task that needs these values takes them from this table. It is the single
source of truth for the plan.

| name | attack_kind | attack_range | attack_cooldown | projectile_speed | projectile_radius | aggro_radius | leash_radius | chase_style | preferred_range | move_speed_mult | damage_override |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Swarm | melee | 60 | 0.7 | 0 | 0 | 400 | 800 | charge | 0 | 1.2 | null |
| Skirmisher | melee | 60 | 0.9 | 0 | 0 | 450 | 800 | skirmish | 150 | 1.5 | null |
| Line | melee | 60 | 1.0 | 0 | 0 | 400 | 800 | charge | 0 | 1.0 | null |
| Ranged | ranged | 340 | 1.8 | 520 | 6 | 460 | 800 | kite | 240 | 1.0 | null |
| Caster | cast | 300 | 2.4 | 420 | 8 | 460 | 800 | kite | 220 | 0.9 | null |
| Brute | melee | 70 | 1.8 | 0 | 0 | 380 | 800 | charge | 0 | 0.7 | null |
| Heavy | melee | 65 | 1.5 | 0 | 0 | 300 | 500 | charge | 0 | 0.6 | null |
| Champion | melee | 65 | 1.1 | 0 | 0 | 480 | 900 | charge | 0 | 1.05 | null |
| Apex | cast | 260 | 2.0 | 460 | 10 | 600 | 1200 | charge | 0 | 0.95 | null |
| Guard | melee | 60 | 1.0 | 0 | 0 | 400 | 300 | guard | 0 | 1.0 | 25 |
| Sentry | ranged | 380 | 2.0 | 500 | 6 | 400 | 800 | hold | 0 | 1.0 | null |
| Lurker | melee | 60 | 0.9 | 0 | 0 | 180 | 700 | ambush | 0 | 1.6 | null |

---

### Task 1: Capture the behaviour baseline

**This task must run first and must not change any production file.** It
freezes what the creature sim does today so later tasks can prove they did not
change it. A baseline captured after the sim changes proves nothing.

This is not a novel technique here: `backend/tests/fixtures/terrain-golden-preBiome.json`
is the same device from the biomes epic, which used it to prove a two-level
generator was byte-identical to the old one for worlds with no biomes. Both
`tests/fixtures/` and `tests/helpers/` already exist. `npm test` is a bare
`node --test`, which discovers only `*.test.js`, so a plain helper module under
`tests/` is not picked up as a test — `tests/fixtures/weapon_catalog.js` is the
existing proof of that.

**Files:**
- Create: `backend/tests/helpers/creatureTrace.js`
- Create: `backend/tests/fixtures/creature_tick_golden.json`
- Create: `backend/tests/creature_behavior_golden.test.js`

**Interfaces:**
- Consumes: `CreatureSim` from `backend/src/authority/creatures.js` (unchanged).
- Produces: `runTrace()` exported from `backend/tests/helpers/creatureTrace.js`,
  and `backend/tests/fixtures/creature_tick_golden.json` — an array of per-tick
  snapshots. Tasks 6, 7 and 9 must keep this test green.

- [ ] **Step 1: Write the trace helper**

The trace generator lives in a plain module, **not** in the test file. Putting
it in the test file would mean Step 3's fixture-generation command executes the
(still failing) test as a side effect of requiring it.

Create `backend/tests/helpers/creatureTrace.js`:

```js
// Produces a deterministic trace of the creature sim, used by
// creature_behavior_golden.test.js to prove P2a changed no behaviour.
const { CreatureSim } = require('../../src/authority/creatures.js');

// Everything walkable, chunkSize 8 (chunk span 800px) -- the same stub the
// rest of the creature suite uses.
function stubMap() {
  return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 };
}

// Deterministic rng: 0.05 seeds _dir = floor(0.05*8) = 0 (east) and is >= the
// 0.02 redirect chance, so no creature ever redirects. The trace is therefore
// a pure function of the sim's movement and combat rules.
const fixedRng = () => 0.05;

// Two hostiles and one guard, exercising roam, chase, contact damage and the
// guard's post/leash/return behaviour in one run.
function buildScenario() {
  const sim = new CreatureSim(stubMap(), fixedRng);
  sim.addCreatures([
    { id: 'roamer', type: 'Wolf', x: 100, y: 100, hp: 30, facing: 'S', color: '#c0392b', damage: 5, level: 1 },
    { id: 'chaser', type: 'Skeleton', x: 300, y: 300, hp: 30, facing: 'S', color: '#dddddd', damage: 5, level: 1 },
    { id: 'sentry', type: 'Village Guard', x: 500, y: 500, hp: 60, facing: 'S', color: '#3498db',
      faction: 'guard', home_x: 500, home_y: 500, damage: 5, level: 1 },
    { id: 'raider', type: 'Bat', x: 560, y: 500, hp: 40, facing: 'S', color: '#8e44ad', damage: 5, level: 1 },
  ]);
  const player = {
    userId: 'u1', x: 380, y: 300, width: 48, height: 48, hp: 200, mit: null,
  };
  return { sim, players: [player] };
}

// One trace row per tick: every creature's position, facing, mode and hp, plus
// the player's hp so contact damage is captured too.
function runTrace(ticks = 120, dt = 0.05) {
  const { sim, players } = buildScenario();
  const active = new Set(['0,0']);
  for (let cx = 0; cx <= 1; cx++) for (let cy = 0; cy <= 1; cy++) active.add(`${cx},${cy}`);
  const trace = [];
  for (let i = 0; i < ticks; i++) {
    sim.tick(dt, active, players, i * dt);
    trace.push({
      creatures: sim.all().map((c) => ({
        id: c.id,
        x: Number(c.x.toFixed(4)),
        y: Number(c.y.toFixed(4)),
        facing: c.facing,
        mode: c.mode,
        hp: Number(Number(c.hp).toFixed(4)),
      })),
      playerHp: Number(Number(players[0].hp).toFixed(4)),
    });
  }
  return trace;
}

module.exports = { runTrace };
```

- [ ] **Step 2: Write the test and watch it fail on the missing fixture**

Create `backend/tests/creature_behavior_golden.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runTrace } = require('./helpers/creatureTrace.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'creature_tick_golden.json');

test('creature tick reproduces the frozen pre-P2a baseline', () => {
  const golden = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.deepStrictEqual(runTrace(), golden);
});
```

Run: `cd backend && npx node --test tests/creature_behavior_golden.test.js`
Expected: FAIL — `ENOENT ... creature_tick_golden.json`.

- [ ] **Step 3: Generate the fixture from the CURRENT sim**

```bash
cd backend && mkdir -p tests/fixtures && node -e "
const { runTrace } = require('./tests/helpers/creatureTrace.js');
require('node:fs').writeFileSync(
  'tests/fixtures/creature_tick_golden.json',
  JSON.stringify(runTrace(), null, 2) + '\n');
"
```

- [ ] **Step 4: Verify the fixture is not degenerate**

```bash
cd backend && node -e "
const t = require('./tests/fixtures/creature_tick_golden.json');
const ids = new Set(t.flatMap(r => r.creatures.map(c => c.id)));
const modes = new Set(t.flatMap(r => r.creatures.map(c => c.mode)));
const moved = new Set(t.flatMap(r => r.creatures.map(c => c.id + ':' + c.x + ',' + c.y))).size;
console.log('ticks', t.length, 'ids', [...ids], 'modes', [...modes]);
console.log('distinct positions', moved, 'player hp start/end', t[0].playerHp, t[t.length-1].playerHp);
"
```

Expected: 120 ticks; four ids; **`modes` must contain at least `roam`, `chase`
and `guard`**; distinct positions must be far more than 4. If every creature
sits still, or only one mode appears, the scenario is not exercising the code
and the fixture is worthless — fix the scenario before continuing. Report the
observed values in your report file.

- [ ] **Step 5: Run the test, now passing**

Run: `cd backend && npx node --test tests/creature_behavior_golden.test.js`
Expected: PASS.

- [ ] **Step 6: Run the whole backend suite**

Run: `cd backend && npm test`
Expected: no new failures. Record the pass/fail/skip counts in your report —
they are the baseline every later task compares against.

- [ ] **Step 7: Commit**

```bash
git add backend/tests/helpers/creatureTrace.js backend/tests/fixtures/creature_tick_golden.json backend/tests/creature_behavior_golden.test.js
git commit -F - <<'EOF'
test(creatures): freeze the pre-P2a creature tick baseline (SOMET-249)

P2a moves every creature behaviour constant into a catalog table. The claim
that it changes nothing observable is only worth making if it can fail, so
this captures a 120-tick trace of the CURRENT sim -- roam, chase, contact
damage, and a guard holding its post -- before anything moves.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 2: The `creature_behaviors` catalog

**Files:**
- Create: `backend/migrations/1714440080000_creature_behaviors.js`
- Create: `backend/seeds/data/creatureBehaviors.js`
- Modify: `backend/scripts/seed-catalogs.js`
- Create: `backend/tests/creature_behaviors_seed_db.test.js`
- Modify: `backend/tests/catalog_seed_data.test.js`

**Interfaces:**
- Produces: table `creature_behaviors`; `CREATURE_BEHAVIORS` (array of twelve
  objects with snake_case keys matching the columns) exported from
  `backend/seeds/data/creatureBehaviors.js`; `seedOneBehavior(db, b)` exported
  from `backend/scripts/seed-catalogs.js`.

- [ ] **Step 1: Write the migration**

Create `backend/migrations/1714440080000_creature_behaviors.js`:

```js
exports.shorthands = undefined;

// The behaviour catalog. Rows are inserted HERE as well as living in
// seeds/data/creatureBehaviors.js, matching how tile_types works: a fresh
// database gets a working catalog from migrations alone, and the seed file is
// a superset that `make seed-catalogs` can re-apply. catalog_seed_data.test.js
// pins that superset relationship.
//
// The two CHECK constraints duplicate the JS value sets in
// services/creatureBehaviors.js on purpose, for the same reason
// worlds_density_check duplicates DENSITY_TIERS: a value rejected only in JS
// is a value that reaches the database.
const BEHAVIORS = [
  // name, kind, range, cooldown, projSpeed, projRadius, aggro, leash, style, preferred, speedMult, dmgOverride
  ['Swarm',      'melee',   60, 0.7,   0,  0, 400,  800, 'charge',   0,   1.2,  null],
  ['Skirmisher', 'melee',   60, 0.9,   0,  0, 450,  800, 'skirmish', 150, 1.5,  null],
  ['Line',       'melee',   60, 1.0,   0,  0, 400,  800, 'charge',   0,   1.0,  null],
  ['Ranged',     'ranged', 340, 1.8, 520,  6, 460,  800, 'kite',     240, 1.0,  null],
  ['Caster',     'cast',   300, 2.4, 420,  8, 460,  800, 'kite',     220, 0.9,  null],
  ['Brute',      'melee',   70, 1.8,   0,  0, 380,  800, 'charge',   0,   0.7,  null],
  ['Heavy',      'melee',   65, 1.5,   0,  0, 300,  500, 'charge',   0,   0.6,  null],
  ['Champion',   'melee',   65, 1.1,   0,  0, 480,  900, 'charge',   0,   1.05, null],
  ['Apex',       'cast',   260, 2.0, 460, 10, 600, 1200, 'charge',   0,   0.95, null],
  ['Guard',      'melee',   60, 1.0,   0,  0, 400,  300, 'guard',    0,   1.0,    25],
  ['Sentry',     'ranged', 380, 2.0, 500,  6, 400,  800, 'hold',     0,   1.0,  null],
  ['Lurker',     'melee',   60, 0.9,   0,  0, 180,  700, 'ambush',   0,   1.6,  null],
];

exports.up = (pgm) => {
  pgm.createTable('creature_behaviors', {
    id: 'id',
    name: { type: 'text', notNull: true, unique: true },
    attack_kind: { type: 'text', notNull: true },
    attack_range: { type: 'real', notNull: true },
    attack_cooldown: { type: 'real', notNull: true },
    projectile_speed: { type: 'real', notNull: true, default: 0 },
    projectile_radius: { type: 'real', notNull: true, default: 0 },
    aggro_radius: { type: 'real', notNull: true },
    leash_radius: { type: 'real', notNull: true },
    chase_style: { type: 'text', notNull: true },
    preferred_range: { type: 'real', notNull: true, default: 0 },
    move_speed_mult: { type: 'real', notNull: true, default: 1 },
    damage_override: { type: 'real', notNull: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('creature_behaviors', 'creature_behaviors_attack_kind_check',
    "CHECK (attack_kind IN ('melee','ranged','cast'))");
  pgm.addConstraint('creature_behaviors', 'creature_behaviors_chase_style_check',
    "CHECK (chase_style IN ('charge','kite','skirmish','hold','ambush','guard'))");

  const values = BEHAVIORS
    .map((b) => `(${[
      `'${b[0]}'`, `'${b[1]}'`, b[2], b[3], b[4], b[5], b[6], b[7], `'${b[8]}'`, b[9], b[10],
      b[11] === null ? 'NULL' : b[11],
    ].join(',')})`)
    .join(',');

  pgm.sql(`
    INSERT INTO creature_behaviors
      (name, attack_kind, attack_range, attack_cooldown, projectile_speed,
       projectile_radius, aggro_radius, leash_radius, chase_style,
       preferred_range, move_speed_mult, damage_override)
    VALUES ${values}
    ON CONFLICT (name) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('creature_behaviors');
};
```

- [ ] **Step 2: Write the seed data file**

Create `backend/seeds/data/creatureBehaviors.js`:

```js
// The authoritative creature_behaviors catalog for `make seed-catalogs`.
//
// These twelve rows are ALSO inserted by migration
// 1714440080000_creature_behaviors.js, the same arrangement tile_types uses:
// migrations make a fresh database work, this file lets the seeder re-apply
// and extend the catalog. catalog_seed_data.test.js pins this file as a
// superset of what the migration inserts.
//
// Nine rungs come from the Bestiary Program umbrella
// (docs/superpowers/specs/2026-08-06-bestiary-program-design.md). Three do not:
//
//   Guard  -- today's hardcoded guard constants, moved into data. Its
//             damage_override of 25 is GUARD_DAMAGE; without that column the
//             Guard profile could not reproduce current behaviour, which is
//             this sub-project's load-bearing invariant.
//   Sentry -- gives the `hold` style a consumer. An immobile ranged turret.
//   Lurker -- gives the `ambush` style a consumer. Dormant, then a fast charge.
//
// `Line` is the fallback every creature without a profile resolves to, and its
// values are today's hostile constants exactly: CONTACT_RANGE 60,
// CREATURE_ATTACK_COOLDOWN 1.0, AGGRO_RADIUS 400, LEASH_RADIUS 800,
// CREATURE_SPEED x 1. Changing them changes the whole game.
const CREATURE_BEHAVIORS = [
  { name: 'Swarm',      attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 0.7, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 400, leash_radius: 800,  chase_style: 'charge',   preferred_range: 0,   move_speed_mult: 1.2 },
  { name: 'Skirmisher', attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 0.9, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 450, leash_radius: 800,  chase_style: 'skirmish', preferred_range: 150, move_speed_mult: 1.5 },
  { name: 'Line',       attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 1.0, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 400, leash_radius: 800,  chase_style: 'charge',   preferred_range: 0,   move_speed_mult: 1.0 },
  { name: 'Ranged',     attack_kind: 'ranged', attack_range: 340, attack_cooldown: 1.8, projectile_speed: 520, projectile_radius: 6,  aggro_radius: 460, leash_radius: 800,  chase_style: 'kite',     preferred_range: 240, move_speed_mult: 1.0 },
  { name: 'Caster',     attack_kind: 'cast',   attack_range: 300, attack_cooldown: 2.4, projectile_speed: 420, projectile_radius: 8,  aggro_radius: 460, leash_radius: 800,  chase_style: 'kite',     preferred_range: 220, move_speed_mult: 0.9 },
  { name: 'Brute',      attack_kind: 'melee',  attack_range: 70,  attack_cooldown: 1.8, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 380, leash_radius: 800,  chase_style: 'charge',   preferred_range: 0,   move_speed_mult: 0.7 },
  { name: 'Heavy',      attack_kind: 'melee',  attack_range: 65,  attack_cooldown: 1.5, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 300, leash_radius: 500,  chase_style: 'charge',   preferred_range: 0,   move_speed_mult: 0.6 },
  { name: 'Champion',   attack_kind: 'melee',  attack_range: 65,  attack_cooldown: 1.1, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 480, leash_radius: 900,  chase_style: 'charge',   preferred_range: 0,   move_speed_mult: 1.05 },
  { name: 'Apex',       attack_kind: 'cast',   attack_range: 260, attack_cooldown: 2.0, projectile_speed: 460, projectile_radius: 10, aggro_radius: 600, leash_radius: 1200, chase_style: 'charge',   preferred_range: 0,   move_speed_mult: 0.95 },
  { name: 'Guard',      attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 1.0, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 400, leash_radius: 300,  chase_style: 'guard',    preferred_range: 0,   move_speed_mult: 1.0, damage_override: 25 },
  { name: 'Sentry',     attack_kind: 'ranged', attack_range: 380, attack_cooldown: 2.0, projectile_speed: 500, projectile_radius: 6,  aggro_radius: 400, leash_radius: 800,  chase_style: 'hold',     preferred_range: 0,   move_speed_mult: 1.0 },
  { name: 'Lurker',     attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 0.9, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 180, leash_radius: 700,  chase_style: 'ambush',   preferred_range: 0,   move_speed_mult: 1.6 },
];

module.exports = { CREATURE_BEHAVIORS };
```

- [ ] **Step 3: Write the failing DB test**

Create `backend/tests/creature_behaviors_seed_db.test.js`. Note the `zz`
fixture discipline and that expected numbers are **literals**, not imports:

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { seedOneBehavior } = require('../scripts/seed-catalogs.js');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('creature_behaviors seeding', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  await t.test('Line carries today\'s hostile constants exactly', async () => {
    const r = await pool.query('SELECT * FROM creature_behaviors WHERE name = $1', ['Line']);
    assert.equal(r.rowCount, 1);
    const b = r.rows[0];
    // Literals, deliberately: importing these from the seed file would make
    // the assertion compare the data to itself.
    assert.equal(b.attack_kind, 'melee');
    assert.equal(b.attack_range, 60);
    assert.equal(b.attack_cooldown, 1);
    assert.equal(b.aggro_radius, 400);
    assert.equal(b.leash_radius, 800);
    assert.equal(b.chase_style, 'charge');
    assert.equal(b.move_speed_mult, 1);
    assert.equal(b.damage_override, null);
  });

  await t.test('Guard carries today\'s guard constants exactly', async () => {
    const r = await pool.query('SELECT * FROM creature_behaviors WHERE name = $1', ['Guard']);
    assert.equal(r.rowCount, 1);
    const b = r.rows[0];
    assert.equal(b.aggro_radius, 400);
    assert.equal(b.leash_radius, 300);
    assert.equal(b.damage_override, 25);
    assert.equal(b.chase_style, 'guard');
  });

  await t.test('every chase style value has at least one profile using it', async () => {
    const r = await pool.query('SELECT DISTINCT chase_style FROM creature_behaviors');
    const styles = r.rows.map((x) => x.chase_style).sort();
    assert.deepEqual(styles, ['ambush', 'charge', 'guard', 'hold', 'kite', 'skirmish']);
  });

  await t.test('the chase_style CHECK rejects an unknown value', async () => {
    await assert.rejects(
      () => pool.query(
        `INSERT INTO creature_behaviors
           (name, attack_kind, attack_range, attack_cooldown, aggro_radius, leash_radius, chase_style)
         VALUES ('zzbadstyle','melee',60,1,400,800,'teleport')`),
      /creature_behaviors_chase_style_check/,
    );
  });

  await t.test('re-seeding preserves a hand-tuned field the seed entry omits', async () => {
    try {
      await pool.query(
        `INSERT INTO creature_behaviors
           (name, attack_kind, attack_range, attack_cooldown, aggro_radius, leash_radius,
            chase_style, damage_override)
         VALUES ('zzTuned','melee',60,1,400,800,'charge',99)`);
      // The seed entry has no damage_override, so the hand-set 99 must survive.
      await seedOneBehavior(pool, {
        name: 'zzTuned', attack_kind: 'melee', attack_range: 61, attack_cooldown: 1,
        aggro_radius: 400, leash_radius: 800, chase_style: 'charge',
      });
      const r = await pool.query('SELECT * FROM creature_behaviors WHERE name = $1', ['zzTuned']);
      assert.equal(r.rows[0].damage_override, 99, 'omitted field must be preserved');
      assert.equal(r.rows[0].attack_range, 61, 'specified field must be overwritten');
    } finally {
      // By name, unconditionally.
      await pool.query('DELETE FROM creature_behaviors WHERE name = $1', ['zzTuned']);
      await pool.query('DELETE FROM creature_behaviors WHERE name = $1', ['zzbadstyle']);
    }
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `cd backend && npx node --test tests/creature_behaviors_seed_db.test.js`
Expected: FAIL — `seedOneBehavior is not a function`, and the table does not exist.

- [ ] **Step 5: Add `seedOneBehavior` to the seeder**

In `backend/scripts/seed-catalogs.js`, add the import beside the others:

```js
const { CREATURE_BEHAVIORS } = require('../seeds/data/creatureBehaviors.js');
```

Add the function next to `seedOneBiome`:

```js
// COALESCE for every optional field, same rule as seedOneTile: a seed entry
// that OMITS a field must not clobber what an admin tuned in the UI. The
// non-optional five (name, attack_kind, attack_range, attack_cooldown,
// chase_style) are the profile's identity and are always written.
async function seedOneBehavior(db, b) {
  await db.query(
    `INSERT INTO creature_behaviors
       (name, attack_kind, attack_range, attack_cooldown, projectile_speed,
        projectile_radius, aggro_radius, leash_radius, chase_style,
        preferred_range, move_speed_mult, damage_override)
     VALUES ($1,$2,$3,$4,
             COALESCE($5,0), COALESCE($6,0), COALESCE($7,400), COALESCE($8,800),
             $9, COALESCE($10,0), COALESCE($11,1), $12)
     ON CONFLICT (name) DO UPDATE
       SET attack_kind = EXCLUDED.attack_kind,
           attack_range = EXCLUDED.attack_range,
           attack_cooldown = EXCLUDED.attack_cooldown,
           chase_style = EXCLUDED.chase_style,
           projectile_speed = COALESCE($5, creature_behaviors.projectile_speed),
           projectile_radius = COALESCE($6, creature_behaviors.projectile_radius),
           aggro_radius = COALESCE($7, creature_behaviors.aggro_radius),
           leash_radius = COALESCE($8, creature_behaviors.leash_radius),
           preferred_range = COALESCE($10, creature_behaviors.preferred_range),
           move_speed_mult = COALESCE($11, creature_behaviors.move_speed_mult),
           damage_override = COALESCE($12, creature_behaviors.damage_override),
           updated_at = now()`,
    [b.name, b.attack_kind, b.attack_range, b.attack_cooldown,
     b.projectile_speed ?? null, b.projectile_radius ?? null,
     b.aggro_radius ?? null, b.leash_radius ?? null, b.chase_style,
     b.preferred_range ?? null, b.move_speed_mult ?? null,
     b.damage_override ?? null],
  );
}
```

Inside `seedCatalogs`, after the biome loop, add:

```js
  for (const b of CREATURE_BEHAVIORS) {
    await seedOneBehavior(pool, b);
  }
  console.log(`Seeded ${CREATURE_BEHAVIORS.length} creature behaviors`);
```

And extend the export at the bottom:

```js
module.exports = { seedCatalogs, seedOneTile, seedOneBiome, seedOneBehavior };
```

- [ ] **Step 6: Run the migration, then the test**

```bash
cd backend && npm run migrate:up && npx node --test tests/creature_behaviors_seed_db.test.js
```
Expected: PASS.

- [ ] **Step 7: Extend the catalog-superset test**

In `backend/tests/catalog_seed_data.test.js`, add a case asserting the seed
file is a superset of the migration's rows and that the profile set is
complete. Read the file first and follow its existing style; the assertion to
add is:

```js
test('CREATURE_BEHAVIORS covers every profile the migration inserts', () => {
  const { CREATURE_BEHAVIORS } = require('../seeds/data/creatureBehaviors.js');
  const names = CREATURE_BEHAVIORS.map((b) => b.name);
  // Literal list: this is the contract, not a restatement of the data.
  for (const n of ['Swarm', 'Skirmisher', 'Line', 'Ranged', 'Caster', 'Brute',
                   'Heavy', 'Champion', 'Apex', 'Guard', 'Sentry', 'Lurker']) {
    assert.ok(names.includes(n), `missing behaviour profile ${n}`);
  }
  assert.equal(new Set(names).size, names.length, 'duplicate profile name');
});
```

- [ ] **Step 8: Run the full backend suite**

Run: `cd backend && npm test`
Expected: no new failures versus Task 1's recorded baseline. If a test fails,
determine whether it is genuinely pre-existing by checking out `main` and
running that test there — do not label anything "pre-existing" without that check.

- [ ] **Step 9: Commit**

```bash
git add backend/migrations/1714440080000_creature_behaviors.js backend/seeds/data/creatureBehaviors.js backend/scripts/seed-catalogs.js backend/tests/creature_behaviors_seed_db.test.js backend/tests/catalog_seed_data.test.js
git commit -F - <<'EOF'
feat(creatures): add the creature_behaviors catalog (SOMET-249)

Twelve name-keyed profiles: the umbrella's nine rungs, plus Guard (today's
hardcoded guard constants moved into data, including GUARD_DAMAGE as
damage_override), plus Sentry and Lurker so the hold and ambush styles have
consumers rather than shipping as dead code.

Line's values are today's hostile constants exactly, because it is the
fallback every creature without a profile resolves to.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Wire `entity_types` to the catalog

**Files:**
- Create: `backend/migrations/1714440081000_entity_behavior.js`
- Modify: `backend/tests/creature_behaviors_seed_db.test.js` (add a case)

**Interfaces:**
- Consumes: table `creature_behaviors` from Task 2.
- Produces: `entity_types.behavior_id` (integer, nullable, FK) and
  `entity_types.attack_element` (text, NOT NULL, default `'physical'`).

- [ ] **Step 1: Write the migration**

Create `backend/migrations/1714440081000_entity_behavior.js`:

```js
exports.shorthands = undefined;

// An integer FK, deliberately NOT a name reference.
//
// biomes.creature_types and biomes.flora_types reference entity_types by NAME
// with no FK, which is exactly why index.js has to guard entity-type renames
// with a 409. P4 will author 288 creatures against these profiles; a profile
// rename must not be able to orphan all of them. The default ON DELETE
// (RESTRICT) is also wanted: a profile still in use cannot be deleted out from
// under its creatures.
//
// behavior_id is NULLABLE and the backfill below is deliberately narrow. A
// creature type with no profile resolves to the Line fallback in
// services/creatureBehaviors.js, so a hand-authored creature keeps working.
exports.up = (pgm) => {
  pgm.addColumns('entity_types', {
    behavior_id: {
      type: 'integer',
      notNull: false,
      references: 'creature_behaviors',
    },
    attack_element: { type: 'text', notNull: true, default: 'physical' },
  });

  pgm.addConstraint('entity_types', 'entity_types_attack_element_check',
    "CHECK (attack_element IN ('physical','fire','ice','lightning'))");

  pgm.createIndex('entity_types', 'behavior_id');

  // Guard-faction creatures take Guard; every other creature takes Line. Both
  // profiles reproduce today's constants, so this backfill changes nothing.
  pgm.sql(`
    UPDATE entity_types SET behavior_id = (SELECT id FROM creature_behaviors WHERE name = 'Guard')
    WHERE is_creature = true AND faction = 'guard'
  `);
  pgm.sql(`
    UPDATE entity_types SET behavior_id = (SELECT id FROM creature_behaviors WHERE name = 'Line')
    WHERE is_creature = true AND faction <> 'guard'
  `);
};

exports.down = (pgm) => {
  pgm.dropIndex('entity_types', 'behavior_id');
  pgm.dropConstraint('entity_types', 'entity_types_attack_element_check');
  pgm.dropColumns('entity_types', ['behavior_id', 'attack_element']);
};
```

- [ ] **Step 2: Write the failing test**

Append to `backend/tests/creature_behaviors_seed_db.test.js`, inside the same
outer `test(...)` block:

```js
  await t.test('every existing creature type is backfilled to a behaviour', async () => {
    const r = await pool.query(`
      SELECT e.name, e.faction, b.name AS behavior
      FROM entity_types e LEFT JOIN creature_behaviors b ON b.id = e.behavior_id
      WHERE e.is_creature = true
    `);
    assert.ok(r.rowCount > 0, 'no creature types found');
    for (const row of r.rows) {
      assert.ok(row.behavior, `${row.name} has no behaviour profile`);
      assert.equal(row.behavior, row.faction === 'guard' ? 'Guard' : 'Line',
        `${row.name} (faction ${row.faction}) got the wrong profile`);
    }
  });

  await t.test('a profile still in use cannot be deleted', async () => {
    const inUse = await pool.query(
      'SELECT id FROM creature_behaviors WHERE name = $1', ['Line']);
    await assert.rejects(
      () => pool.query('DELETE FROM creature_behaviors WHERE id = $1', [inUse.rows[0].id]),
      /foreign key|violates/i,
    );
  });

  await t.test('attack_element defaults to physical and rejects an unknown element', async () => {
    try {
      await pool.query(
        `INSERT INTO entity_types (name, color, is_creature) VALUES ('zzElem','#fff',true)`);
      const r = await pool.query('SELECT attack_element FROM entity_types WHERE name = $1', ['zzElem']);
      assert.equal(r.rows[0].attack_element, 'physical');
      await assert.rejects(
        () => pool.query(`UPDATE entity_types SET attack_element = 'holy' WHERE name = 'zzElem'`),
        /entity_types_attack_element_check/,
      );
    } finally {
      await pool.query('DELETE FROM entity_types WHERE name = $1', ['zzElem']);
    }
  });
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd backend && npx node --test tests/creature_behaviors_seed_db.test.js`
Expected: FAIL — `column e.behavior_id does not exist`.

- [ ] **Step 4: Migrate and re-run**

```bash
cd backend && npm run migrate:up && npx node --test tests/creature_behaviors_seed_db.test.js
```
Expected: PASS.

- [ ] **Step 5: Verify the backfill on the real dev data (read-only)**

```bash
docker exec something2-db-1 psql -U user -d game_db -c \
  "SELECT e.name, e.faction, b.name AS behavior, e.attack_element
   FROM entity_types e LEFT JOIN creature_behaviors b ON b.id = e.behavior_id
   WHERE e.is_creature = true ORDER BY e.id;"
```
Expected: Bat, Skeleton, Slime, Wolf → `Line`; Village Guard → `Guard`; every
`attack_element` → `physical`. Paste the output into your report file.

- [ ] **Step 6: Run the full backend suite, then commit**

```bash
cd backend && npm test
```

```bash
git add backend/migrations/1714440081000_entity_behavior.js backend/tests/creature_behaviors_seed_db.test.js
git commit -F - <<'EOF'
feat(creatures): point entity_types at a behaviour profile (SOMET-249)

An integer FK rather than a name reference: biomes reference entity types by
name with no FK, which is why index.js has to guard renames, and P4 will hang
288 creatures off these profiles.

Backfill is narrow and behaviour-neutral -- guards take Guard, everything else
takes Line, and both reproduce today's constants exactly.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 4: The pure behaviour resolver

**Files:**
- Create: `backend/src/services/creatureBehaviors.js`
- Create: `backend/tests/creature_behaviors_resolve.test.js`

**Interfaces:**
- Produces:
  - `DEFAULT_BEHAVIOR` — a frozen object, the Line constants.
  - `ATTACK_KINDS = ['melee','ranged','cast']`, `CHASE_STYLES = ['charge','kite','skirmish','hold','ambush','guard']`.
  - `resolveBehavior(row)` — takes a joined DB row (or `null`/`undefined`) and
    returns a complete camelCase behaviour object. Never returns undefined,
    never returns a partial object.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/creature_behaviors_resolve.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const {
  resolveBehavior, DEFAULT_BEHAVIOR, ATTACK_KINDS, CHASE_STYLES,
} = require('../src/services/creatureBehaviors.js');

test('a null row resolves to the Line fallback', () => {
  const b = resolveBehavior(null);
  // Literals: comparing against DEFAULT_BEHAVIOR would compare the code to
  // itself and pass for any value at all.
  assert.equal(b.attackKind, 'melee');
  assert.equal(b.attackRange, 60);
  assert.equal(b.attackCooldown, 1);
  assert.equal(b.aggroRadius, 400);
  assert.equal(b.leashRadius, 800);
  assert.equal(b.chaseStyle, 'charge');
  assert.equal(b.moveSpeedMult, 1);
  assert.equal(b.damageOverride, null);
});

test('a complete row is carried through verbatim', () => {
  const b = resolveBehavior({
    behavior_name: 'Ranged', attack_kind: 'ranged', attack_range: 340,
    attack_cooldown: 1.8, projectile_speed: 520, projectile_radius: 6,
    aggro_radius: 460, leash_radius: 800, chase_style: 'kite',
    preferred_range: 240, move_speed_mult: 1, damage_override: null,
  });
  assert.equal(b.name, 'Ranged');
  assert.equal(b.attackKind, 'ranged');
  assert.equal(b.attackRange, 340);
  assert.equal(b.projectileSpeed, 520);
  assert.equal(b.preferredRange, 240);
  assert.equal(b.chaseStyle, 'kite');
});

test('an unknown attack_kind or chase_style falls back rather than reaching the sim', () => {
  const b = resolveBehavior({
    behavior_name: 'Broken', attack_kind: 'psychic', chase_style: 'teleport',
    attack_range: 60, attack_cooldown: 1, aggro_radius: 400, leash_radius: 800,
  });
  assert.equal(b.attackKind, 'melee', 'unknown kind must fall back');
  assert.equal(b.chaseStyle, 'charge', 'unknown style must fall back');
});

test('non-finite numbers fall back instead of poisoning the tick', () => {
  const b = resolveBehavior({
    behavior_name: 'Bad', attack_kind: 'melee', chase_style: 'charge',
    attack_range: NaN, attack_cooldown: null, aggro_radius: 'abc',
    leash_radius: undefined, move_speed_mult: Infinity,
  });
  assert.equal(b.attackRange, 60);
  assert.equal(b.attackCooldown, 1);
  assert.equal(b.aggroRadius, 400);
  assert.equal(b.leashRadius, 800);
  assert.equal(b.moveSpeedMult, 1);
});

test('damage_override of 0 is preserved, not treated as absent', () => {
  const b = resolveBehavior({
    behavior_name: 'Pacifist', attack_kind: 'melee', chase_style: 'charge',
    attack_range: 60, attack_cooldown: 1, aggro_radius: 400, leash_radius: 800,
    damage_override: 0,
  });
  assert.equal(b.damageOverride, 0);
});

test('DEFAULT_BEHAVIOR is frozen so a caller cannot mutate every creature at once', () => {
  assert.ok(Object.isFrozen(DEFAULT_BEHAVIOR));
});

test('the value sets match the database CHECK constraints', () => {
  assert.deepEqual(ATTACK_KINDS, ['melee', 'ranged', 'cast']);
  assert.deepEqual(CHASE_STYLES, ['charge', 'kite', 'skirmish', 'hold', 'ambush', 'guard']);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd backend && npx node --test tests/creature_behaviors_resolve.test.js`
Expected: FAIL — `Cannot find module '../src/services/creatureBehaviors.js'`.

- [ ] **Step 3: Write the resolver**

Create `backend/src/services/creatureBehaviors.js`:

```js
// Pure normalisation of a creature_behaviors row into the object the sim
// consumes. No database, no clock, no randomness.
//
// The point of this module is that CreatureSim never sees a partial or
// malformed behaviour. A missing column, a NULL, a value that predates a CHECK
// constraint -- all of them resolve to the Line fallback rather than reaching
// the tick loop as NaN and freezing a creature in place.

// These duplicate the CHECK constraints in migration
// 1714440080000_creature_behaviors.js. Deliberate, and documented there:
// a value rejected only in JS is a value that reaches the database, and a
// value rejected only in SQL is a value that reaches the sim from a row
// written before the constraint existed.
const ATTACK_KINDS = ['melee', 'ranged', 'cast'];
const CHASE_STYLES = ['charge', 'kite', 'skirmish', 'hold', 'ambush', 'guard'];

// Today's hostile constants, and the fallback for a creature with no profile.
// These MUST equal CONTACT_RANGE (60), CREATURE_ATTACK_COOLDOWN (1.0),
// AGGRO_RADIUS (400) and LEASH_RADIUS (800) in authority/creatures.js -- that
// equality is what makes P2a behaviour-neutral, and
// creature_behavior_golden.test.js is what proves it.
const DEFAULT_BEHAVIOR = Object.freeze({
  name: 'Line',
  attackKind: 'melee',
  attackRange: 60,
  attackCooldown: 1,
  projectileSpeed: 0,
  projectileRadius: 0,
  aggroRadius: 400,
  leashRadius: 800,
  chaseStyle: 'charge',
  preferredRange: 0,
  moveSpeedMult: 1,
  damageOverride: null,
});

// A finite number, or the fallback. `pg` hands back `real` columns as numbers
// and `numeric` as strings, so Number() is applied either way.
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function oneOf(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

// `row` is a joined row from loadCreatureTypes, whose behaviour columns are
// aliased with a `behavior_` prefix for `name` only (the rest do not collide
// with entity_types). A null/undefined row is the no-profile case.
function resolveBehavior(row) {
  if (!row) return { ...DEFAULT_BEHAVIOR };
  return {
    name: typeof row.behavior_name === 'string' && row.behavior_name
      ? row.behavior_name : DEFAULT_BEHAVIOR.name,
    attackKind: oneOf(row.attack_kind, ATTACK_KINDS, DEFAULT_BEHAVIOR.attackKind),
    attackRange: num(row.attack_range, DEFAULT_BEHAVIOR.attackRange),
    attackCooldown: num(row.attack_cooldown, DEFAULT_BEHAVIOR.attackCooldown),
    projectileSpeed: num(row.projectile_speed, DEFAULT_BEHAVIOR.projectileSpeed),
    projectileRadius: num(row.projectile_radius, DEFAULT_BEHAVIOR.projectileRadius),
    aggroRadius: num(row.aggro_radius, DEFAULT_BEHAVIOR.aggroRadius),
    leashRadius: num(row.leash_radius, DEFAULT_BEHAVIOR.leashRadius),
    chaseStyle: oneOf(row.chase_style, CHASE_STYLES, DEFAULT_BEHAVIOR.chaseStyle),
    preferredRange: num(row.preferred_range, DEFAULT_BEHAVIOR.preferredRange),
    moveSpeedMult: num(row.move_speed_mult, DEFAULT_BEHAVIOR.moveSpeedMult),
    // null means "use the creature's own instance damage". 0 is a real value
    // and must survive, so this is an explicit null check, not `??` on a
    // falsy test.
    damageOverride: row.damage_override == null
      ? null : num(row.damage_override, null),
  };
}

module.exports = { resolveBehavior, DEFAULT_BEHAVIOR, ATTACK_KINDS, CHASE_STYLES };
```

- [ ] **Step 4: Run the test**

Run: `cd backend && npx node --test tests/creature_behaviors_resolve.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/creatureBehaviors.js backend/tests/creature_behaviors_resolve.test.js
git commit -F - <<'EOF'
feat(creatures): add the pure behaviour resolver (SOMET-249)

Guarantees CreatureSim never sees a partial or malformed behaviour: a missing
column, a NULL, or a value predating a CHECK constraint all resolve to the
Line fallback rather than reaching the tick loop as NaN and freezing a
creature in place.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Join the catalog in `loadCreatureTypes`

**Files:**
- Modify: `backend/src/authority/creatures.js:46-71`
- Modify: whichever test pins `loadCreatureTypes`' SELECT — find it with
  `grep -rn "loadCreatureTypes" backend/tests/`

**Interfaces:**
- Consumes: `resolveBehavior` from Task 4.
- Produces: each entry of `creatureTypes` gains a `behavior` property (the
  resolved object) and an `attackElement` string. Task 6 consumes both.

- [ ] **Step 1: Find and read the existing guard test**

```bash
cd backend && grep -rn "loadCreatureTypes" tests/ src/
```

Read every hit before editing. One of these tests asserts the SELECT names
every column the mapping consumes — that test is the reason this function is a
named export, and it must be extended, not replaced.

- [ ] **Step 2: Write the failing assertion**

Add to that same test file:

```js
test('loadCreatureTypes SELECTs every behaviour column its mapping reads', async () => {
  let sql = '';
  const fakePool = { query: async (q) => { sql = q; return { rows: [] }; } };
  await loadCreatureTypes(fakePool);
  // A column the mapping consumes but the SELECT omits loads as undefined and
  // SILENTLY disables the feature it feeds. That is the single most likely way
  // this sub-project ships inert, which is why it is asserted textually.
  for (const col of ['attack_kind', 'attack_range', 'attack_cooldown',
                     'projectile_speed', 'projectile_radius', 'aggro_radius',
                     'leash_radius', 'chase_style', 'preferred_range',
                     'move_speed_mult', 'damage_override', 'attack_element']) {
    assert.ok(sql.includes(col), `SELECT is missing ${col}`);
  }
  assert.ok(/LEFT JOIN\s+creature_behaviors/i.test(sql), 'must LEFT JOIN, not INNER JOIN');
});

test('loadCreatureTypes attaches a resolved behaviour, including for a null profile', async () => {
  const fakePool = { query: async () => ({ rows: [
    { id: 1, name: 'zzNoProfile', color: '#fff', hp: 10, defense: 0, resistances: {},
      faction: 'hostile', gold_min: 0, gold_max: 0, attack_element: 'physical',
      behavior_name: null, attack_kind: null, chase_style: null },
    { id: 2, name: 'zzArcher', color: '#fff', hp: 10, defense: 0, resistances: {},
      faction: 'hostile', gold_min: 0, gold_max: 0, attack_element: 'fire',
      behavior_name: 'Ranged', attack_kind: 'ranged', attack_range: 340,
      attack_cooldown: 1.8, projectile_speed: 520, projectile_radius: 6,
      aggro_radius: 460, leash_radius: 800, chase_style: 'kite',
      preferred_range: 240, move_speed_mult: 1, damage_override: null },
  ] }) };
  const { creatureTypes } = await loadCreatureTypes(fakePool);
  const byName = new Map(creatureTypes.map((c) => [c.name, c]));
  assert.equal(byName.get('zzNoProfile').behavior.chaseStyle, 'charge');
  assert.equal(byName.get('zzNoProfile').behavior.attackRange, 60);
  assert.equal(byName.get('zzArcher').behavior.chaseStyle, 'kite');
  assert.equal(byName.get('zzArcher').behavior.projectileSpeed, 520);
  assert.equal(byName.get('zzArcher').attackElement, 'fire');
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `cd backend && npx node --test tests/<that file>`
Expected: FAIL — the SELECT lacks the columns and `behavior` is undefined.

- [ ] **Step 4: Rewrite `loadCreatureTypes`**

In `backend/src/authority/creatures.js`, add the import at the top:

```js
const { resolveBehavior } = require('../services/creatureBehaviors');
```

Replace the query and mapping (currently lines 46-57) with:

```js
async function loadCreatureTypes(pool) {
  // LEFT JOIN, not INNER: entity_types.behavior_id is nullable and a creature
  // without a profile must still load, resolving to the Line fallback. An
  // INNER JOIN would make a creature vanish from the catalog entirely, which
  // fails silently -- it would simply never spawn.
  const r = await pool.query(
    `SELECT e.id, e.name, e.color, e.hp, e.defense, e.resistances, e.faction,
            e.gold_min, e.gold_max, e.attack_element,
            b.name AS behavior_name, b.attack_kind, b.attack_range,
            b.attack_cooldown, b.projectile_speed, b.projectile_radius,
            b.aggro_radius, b.leash_radius, b.chase_style, b.preferred_range,
            b.move_speed_mult, b.damage_override
     FROM entity_types e
     LEFT JOIN creature_behaviors b ON b.id = e.behavior_id
     WHERE e.is_creature = true ORDER BY e.id ASC`,
  );
  const creatureTypes = r.rows.map((row) => ({
    name: row.name,
    hp: row.hp,
    color: row.color,
    faction: row.faction || 'hostile',
    attackElement: row.attack_element || 'physical',
    behavior: resolveBehavior(row),
    ...creatureMitigation(row),
  }));
```

Leave the rest of the function (`creatureTypeIds`, `creatureGold`, the return)
untouched.

- [ ] **Step 5: Run that test file, then the full suite**

```bash
cd backend && npx node --test tests/<that file> && npm test
```
Expected: PASS, and no new failures versus Task 1's baseline. **The golden test
from Task 1 must still pass** — this task changes loading, not ticking.

- [ ] **Step 6: Commit**

```bash
git add backend/src/authority/creatures.js backend/tests/
git commit -F - <<'EOF'
feat(creatures): load each creature type's behaviour profile (SOMET-249)

LEFT JOIN, not INNER: behavior_id is nullable, and an INNER JOIN would make a
profile-less creature vanish from the catalog entirely -- a failure that shows
up only as "it never spawns".

The SELECT-completeness guard extends to all twelve new columns. That guard is
why this function is a named export: a column the mapping reads but the SELECT
omits loads as undefined and silently disables its feature.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 6: Drive `charge` and `guard` from the profile

**The highest-risk task in the plan.** It rewires the live combat tick to read
data instead of constants while changing nothing observable. Task 1's golden
test is the gate.

**Files:**
- Modify: `backend/src/authority/creatures.js` (the `tick` method and `addCreatures`)
- Modify: `backend/src/authority/world.js:266-272`

**Interfaces:**
- Consumes: `creatureTypes[].behavior` from Task 5.
- Produces: `CreatureSim.tick(...)` returns **`{ killed, shots }`** where
  `killed` is the array of ids it returned before and `shots` is `[]` in this
  task. Every creature instance gains `behavior` (a resolved object) and
  `attackElement`. Task 7 adds styles; Task 9 fills `shots`.

- [ ] **Step 1: Write the failing test for the new return shape**

Add to `backend/tests/authority_creatures.test.js`:

```js
test('tick returns { killed, shots }', () => {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([{ id: 'a', type: 'Wolf', x: 100, y: 100, hp: 10 }]);
  const out = s.tick(0.1, new Set(['0,0']));
  assert.ok(out && typeof out === 'object' && !Array.isArray(out),
    'tick must return an object, not a bare array');
  assert.ok(Array.isArray(out.killed));
  assert.ok(Array.isArray(out.shots));
});

test('a creature carries a resolved behaviour even with none supplied', () => {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([{ id: 'a', type: 'Wolf', x: 100, y: 100, hp: 10 }]);
  const c = s.all()[0];
  assert.equal(c.behavior.chaseStyle, 'charge');
  assert.equal(c.behavior.aggroRadius, 400);
  assert.equal(c.attackElement, 'physical');
});

test('a supplied behaviour overrides the module constants', () => {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([{
    id: 'a', type: 'Wolf', x: 100, y: 100, hp: 10,
    behavior: { name: 'Tight', attackKind: 'melee', attackRange: 60, attackCooldown: 1,
      projectileSpeed: 0, projectileRadius: 0, aggroRadius: 10, leashRadius: 20,
      chaseStyle: 'charge', preferredRange: 0, moveSpeedMult: 1, damageOverride: null },
  }]);
  // A player 200px away is far outside the 10px aggro radius, so the creature
  // must stay in roam. With the old hardcoded 400 it would chase.
  const player = { userId: 'u1', x: 300, y: 100, width: 48, height: 48, hp: 100 };
  s.tick(0.1, new Set(['0,0']), [player], 0);
  assert.equal(s.all()[0].mode, 'roam');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd backend && npx node --test tests/authority_creatures.test.js`
Expected: FAIL — `tick` returns an array; `c.behavior` is undefined.

- [ ] **Step 3: Attach the behaviour in `addCreatures`**

In the object literal inside `addCreatures`, add two properties beside `mit`:

```js
        // Resolved at load time by loadCreatureTypes and carried onto the
        // instance the same way `mit`, `level` and `damage` are: a raw value
        // attached once, never recomputed inside the tick.
        behavior: c.behavior || { ...DEFAULT_BEHAVIOR },
        attackElement: c.attackElement || 'physical',
```

Add the import at the top of the file:

```js
const { DEFAULT_BEHAVIOR } = require('../services/creatureBehaviors');
```

- [ ] **Step 4: Replace the constants inside `tick` with behaviour reads**

Inside the per-creature loop in `tick`, immediately after the frozen-chunk
`continue`, add:

```js
      const bh = c.behavior || DEFAULT_BEHAVIOR;
```

Then make these exact substitutions **inside the loop only**:

| was | becomes |
|---|---|
| `GUARD_AGGRO_RADIUS` (in `selectGuardTarget` call) | `bh.aggroRadius` |
| `GUARD_LEASH_RADIUS` (all four uses in the guard branch) | `bh.leashRadius` |
| `GUARD_DAMAGE` | `bh.damageOverride ?? (c.damage ?? CREATURE_DAMAGE)` |
| `AGGRO_RADIUS * AGGRO_RADIUS` | `bh.aggroRadius * bh.aggroRadius` |
| `LEASH_RADIUS * LEASH_RADIUS` | `bh.leashRadius * bh.leashRadius` |
| `CONTACT_RANGE * CONTACT_RANGE` (both uses) | `bh.attackRange * bh.attackRange` |
| `CREATURE_ATTACK_COOLDOWN` (both assignments) | `bh.attackCooldown` |
| `c.damage ?? CREATURE_DAMAGE` (hostile contact damage) | `bh.damageOverride ?? (c.damage ?? CREATURE_DAMAGE)` |

Route the guard branch on `bh.chaseStyle === 'guard'` rather than
`c.faction === 'guard'`:

```js
      if (bh.chaseStyle === 'guard') {
```

**Do not delete the module-level constants** — they remain exported and are
still the fallback values inside `DEFAULT_BEHAVIOR`'s documentation. Other
modules and tests import them.

Apply `moveSpeedMult` by passing a scaled creature to `resolveMove`. `resolveMove`
reads `c.speed`, so scale at the call site rather than mutating the instance:

```js
// Applied at the call site, not by mutating c.speed: a persisted speed would
// compound every tick.
function movedWith(map, c, vx, vy, dt, mult) {
  if (mult === 1) return resolveMove(map, c, vx, vy, dt);
  return resolveMove(map, { ...c, speed: c.speed * mult }, vx, vy, dt);
}
```

Use `movedWith(this.map, c, vx, vy, dt, bh.moveSpeedMult)` at each of the four
`resolveMove` call sites in `tick`.

- [ ] **Step 5: Change the return and update `world.js`**

At the end of `tick`, replace `return killed;` with:

```js
    return { killed, shots };
```

and declare `const shots = [];` beside `const killed = [];` at the top.

In `backend/src/authority/world.js`, `tickCreatures` currently reads:

```js
    const killedIds = this.creatures.tick(dt, activeKeys, [...this.players.values()], this.now) || [];
```

Change it to:

```js
    const { killed: killedIds } = this.creatures.tick(
      dt, activeKeys, [...this.players.values()], this.now) || { killed: [] };
```

- [ ] **Step 6: Find and fix every other caller**

```bash
cd backend && grep -rn "\.tick(" src/ tests/ | grep -i creature
```

Every call site that treated the result as an array must be updated. Run this
grep and fix all of them before continuing — a missed one fails as
`killed.length is not a function` or, worse, silently iterates nothing.

- [ ] **Step 7: Run the golden test — the gate for this task**

Run: `cd backend && npx node --test tests/creature_behavior_golden.test.js`
Expected: **PASS.** If it fails, the diff is not behaviour-neutral. Read the
first differing tick and fix the substitution that caused it. Do **not**
regenerate the fixture — regenerating it destroys the only evidence that this
task is safe. If you believe the fixture itself is wrong, stop and report
BLOCKED rather than overwriting it.

- [ ] **Step 8: Run the full backend suite**

Run: `cd backend && npm test`
Expected: no new failures versus Task 1's baseline.

- [ ] **Step 9: Commit**

```bash
git add backend/src/authority/creatures.js backend/src/authority/world.js backend/tests/authority_creatures.test.js
git commit -F - <<'EOF'
refactor(creatures): drive charge and guard from the behaviour profile (SOMET-249)

Every aggro, leash, contact-range, cooldown and damage constant inside the
tick now comes from the creature's profile. The guard branch routes on
chase_style rather than faction, so guard behaviour is data too.

Nothing observable changes: the golden 120-tick trace captured before any of
this moved still matches exactly.

tick() now returns { killed, shots }. shots is empty until creatures can fire.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 7: The four new chase styles

**Files:**
- Modify: `backend/src/authority/creatures.js` (`tick`)
- Create: `backend/tests/authority_creature_styles.test.js`

**Interfaces:**
- Consumes: `c.behavior.chaseStyle` from Task 6.
- Produces: `kite`, `skirmish`, `hold` and `ambush` movement. No new exports.

- [ ] **Step 1: Write the failing tests — asserting direction, not motion**

Create `backend/tests/authority_creature_styles.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim } = require('../src/authority/creatures.js');

function stubMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }
const noRedirect = () => 0.05;

function behavior(over = {}) {
  return {
    name: 'T', attackKind: 'melee', attackRange: 60, attackCooldown: 1,
    projectileSpeed: 0, projectileRadius: 0, aggroRadius: 400, leashRadius: 800,
    chaseStyle: 'charge', preferredRange: 0, moveSpeedMult: 1, damageOverride: null,
    ...over,
  };
}

// Creature at (100,100); player placed relative to it on the x axis.
function scenario(bh, playerX) {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([{ id: 'c', type: 'T', x: 100, y: 100, hp: 100, behavior: bh, damage: 5 }]);
  const player = { userId: 'u1', x: playerX, y: 100, width: 48, height: 48, hp: 500 };
  return { s, player, active: new Set(['0,0', '0,1', '1,0', '1,1']) };
}

test('kite RETREATS from a target inside preferred range', () => {
  const { s, player, active } = scenario(
    behavior({ chaseStyle: 'kite', attackKind: 'ranged', attackRange: 340, preferredRange: 240 }), 200);
  s.tick(0.1, active, [player], 0);
  // Player is to the EAST (x 200 > 100) and only 100px away, inside the 240
  // preferred range. The creature must move WEST -- away.
  assert.ok(s.all()[0].x < 100, `expected retreat west, got x=${s.all()[0].x}`);
});

test('kite APPROACHES a target beyond attack range', () => {
  const { s, player, active } = scenario(
    behavior({ chaseStyle: 'kite', attackKind: 'ranged', attackRange: 340, preferredRange: 240 }), 600);
  s.tick(0.1, active, [player], 0);
  assert.ok(s.all()[0].x > 100, `expected approach east, got x=${s.all()[0].x}`);
});

test('kite HOLDS between preferred range and attack range', () => {
  const { s, player, active } = scenario(
    behavior({ chaseStyle: 'kite', attackKind: 'ranged', attackRange: 340, preferredRange: 240 }), 380);
  s.tick(0.1, active, [player], 0);
  assert.equal(s.all()[0].x, 100, 'must not move inside the comfortable band');
});

test('hold never moves, even with a target in range', () => {
  const { s, player, active } = scenario(
    behavior({ chaseStyle: 'hold', attackKind: 'ranged', attackRange: 380 }), 300);
  const before = { ...s.all()[0] };
  for (let i = 0; i < 20; i++) s.tick(0.05, active, [player], i * 0.05);
  const after = s.all()[0];
  assert.equal(after.x, before.x);
  assert.equal(after.y, before.y);
});

test('hold does not roam when there is no target either', () => {
  const { s, active } = scenario(behavior({ chaseStyle: 'hold' }), 0);
  const before = { ...s.all()[0] };
  for (let i = 0; i < 20; i++) s.tick(0.05, active, [], i * 0.05);
  assert.equal(s.all()[0].x, before.x);
  assert.equal(s.all()[0].y, before.y);
});

test('ambush stays still until a target enters aggro radius, then closes', () => {
  const bh = behavior({ chaseStyle: 'ambush', aggroRadius: 180, moveSpeedMult: 1.6 });
  const { s, active } = scenario(bh, 0);
  const far = { userId: 'u1', x: 500, y: 100, width: 48, height: 48, hp: 500 };
  for (let i = 0; i < 10; i++) s.tick(0.05, active, [far], i * 0.05);
  assert.equal(s.all()[0].x, 100, 'must not roam while dormant');
  assert.equal(s.all()[0].mode, 'roam');

  const near = { userId: 'u1', x: 220, y: 100, width: 48, height: 48, hp: 500 };
  s.tick(0.05, active, [near], 1);
  assert.ok(s.all()[0].x > 100, 'must close once aggroed');
  assert.equal(s.all()[0].mode, 'chase');
});

test('skirmish retreats after it lands a hit, then closes again', () => {
  const bh = behavior({ chaseStyle: 'skirmish', attackRange: 60, preferredRange: 150, attackCooldown: 1 });
  const { s, active } = scenario(bh, 140);
  const player = { userId: 'u1', x: 140, y: 100, width: 48, height: 48, hp: 500, mit: null };
  // Close until it attacks: the hit is what flips it to retreat.
  let attacked = false;
  for (let i = 0; i < 40 && !attacked; i++) {
    s.tick(0.05, active, [player], i * 0.05);
    if (player.hp < 500) attacked = true;
  }
  assert.ok(attacked, 'skirmisher never landed a hit');
  const xAtHit = s.all()[0].x;
  s.tick(0.05, active, [player], 5);
  assert.ok(s.all()[0].x < xAtHit, 'must retreat immediately after striking');
});

test('an ambusher that never sees anyone still never moves', () => {
  const { s, active } = scenario(behavior({ chaseStyle: 'ambush', aggroRadius: 180 }), 0);
  for (let i = 0; i < 50; i++) s.tick(0.05, active, [], i * 0.05);
  assert.equal(s.all()[0].x, 100);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd backend && npx node --test tests/authority_creature_styles.test.js`
Expected: FAIL — every style currently behaves as `charge`.

- [ ] **Step 3: Implement the styles**

In `tick`, the hostile path currently computes `c.mode` then does one of two
things: chase (walk straight at the target) or roam. Restructure it so the
chase movement and the roam decision both consult `bh.chaseStyle`.

Replace the roam block's entry condition so `hold` and a dormant `ambush` never
roam:

```js
      // Roam. `hold` never moves at all, and `ambush` lies dormant until
      // something enters its aggro radius -- for both, "no target" means
      // "stand still", not "wander".
      if (bh.chaseStyle === 'hold' || bh.chaseStyle === 'ambush') continue;
```

Replace the chase movement with a style-dependent vector. `vx,vy` currently
points at the target; compute a desired vector instead:

```js
        const dist = Math.hypot(tc.x - cc.x, tc.y - cc.y);
        let vx = tc.x - cc.x, vy = tc.y - cc.y;
        let move = true;

        if (bh.chaseStyle === 'hold') {
          // Never moves. It still attacks below if the target is in range.
          move = false;
        } else if (bh.chaseStyle === 'kite') {
          // Three bands: too close -> back away; too far -> close; in between
          // -> stand and shoot. Without the middle band a kiter oscillates
          // one step per tick and never fires.
          if (dist < bh.preferredRange) { vx = -vx; vy = -vy; }
          else if (dist <= bh.attackRange) { move = false; }
        } else if (bh.chaseStyle === 'skirmish') {
          // Retreat while the attack is on cooldown, close while it is ready.
          // Reading _attackCd is what makes this hit-and-run rather than a
          // timer that ignores whether the strike actually landed.
          if (c._attackCd > 0 && dist < bh.preferredRange) { vx = -vx; vy = -vy; }
        }
        // 'charge' and 'ambush' fall through with the straight-at-target
        // vector -- an aggroed ambusher IS a charger, it just started asleep.

        if (move) {
          const r = movedWith(this.map, c, vx, vy, dt, bh.moveSpeedMult);
          if (r.x !== c.x || r.y !== c.y) {
            c.x = r.x; c.y = r.y;
            const f = facingFor(vx, vy); if (f) c.facing = f;
            c.dirty = true;
          }
        }
```

The contact-damage block below is unchanged and still gated on
`dist2(...) <= bh.attackRange * bh.attackRange`.

- [ ] **Step 4: Run the style tests**

Run: `cd backend && npx node --test tests/authority_creature_styles.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Run the golden test and the full suite**

```bash
cd backend && npx node --test tests/creature_behavior_golden.test.js && npm test
```
Expected: golden PASSES (no existing creature uses a new style), no new failures.

- [ ] **Step 6: Commit**

```bash
git add backend/src/authority/creatures.js backend/tests/authority_creature_styles.test.js
git commit -F - <<'EOF'
feat(creatures): add the kite, skirmish, hold and ambush chase styles (SOMET-249)

kite uses three bands rather than two -- without a middle band where it holds
station, a kiter oscillates one step per tick and never fires. skirmish reads
_attackCd so retreat follows a strike that actually landed, rather than a
timer. hold and ambush suppress roaming, which is what makes a dormant
ambusher stay put instead of wandering out of its ambush.

Tests assert DIRECTION, not that the creature moved -- "it moved" passes for a
kiter that charges.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 8: Creature-owned projectiles

**Files:**
- Modify: `backend/src/authority/projectiles.js`
- Modify: `backend/tests/authority_projectiles.test.js`

**Interfaces:**
- Produces: `ProjectileSim.spawn({ ownerKind, ownerFaction, ... })` where
  `ownerKind` defaults to `'player'` and `ownerFaction` is `'hostile'` or
  `'guard'` (ignored for player-owned shots). Task 9 spawns with these.

- [ ] **Step 1: Write the failing 3 × 3 targeting test**

Add to `backend/tests/authority_projectiles.test.js`. Read the file first and
reuse its existing map stub and creature-sim fake:

```js
// The full targeting matrix. Half these cells assert NO damage, and that half
// is the point: a test checking only the damaging cells passes against an
// implementation with no faction logic at all.
test('projectile targeting matrix by owner kind and faction', () => {
  const cases = [
    // ownerKind, ownerFaction, target faction/kind, expect damage
    ['player',   null,      'creature:hostile', true],
    ['player',   null,      'creature:guard',   true],
    ['player',   null,      'player:other',     true],
    ['player',   null,      'player:self',      false],
    ['creature', 'hostile', 'player:other',     true],
    ['creature', 'hostile', 'creature:guard',   true],
    ['creature', 'hostile', 'creature:hostile', false],
    ['creature', 'guard',   'creature:hostile', true],
    ['creature', 'guard',   'creature:guard',   false],
    ['creature', 'guard',   'player:other',     false],
  ];
  for (const [ownerKind, ownerFaction, target, expected] of cases) {
    const hit = runOneShot({ ownerKind, ownerFaction, target });
    assert.equal(hit, expected,
      `${ownerKind}/${ownerFaction} vs ${target}: expected ${expected}, got ${hit}`);
  }
});

test('spawn defaults to player ownership so existing call sites are unchanged', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0,
    weapon: { projectile_speed: 100, range: 100, damage: 5, projectile_radius: 4, pierce: 1 } });
  assert.equal(sim.projectiles[0].ownerKind, 'player');
});
```

Write `runOneShot({ ownerKind, ownerFaction, target })` as a helper in that
file: it builds a one-creature or one-player target directly in the
projectile's path, steps the sim once, and returns whether the target took
damage. Model it on the file's existing single-hit tests.

- [ ] **Step 2: Run and watch it fail**

Run: `cd backend && npx node --test tests/authority_projectiles.test.js`
Expected: FAIL — `ownerKind` is undefined and creature shots hit everything.

- [ ] **Step 3: Add ownership to `spawn`**

In `ProjectileSim.spawn`, add to the destructured parameters and the pushed
object:

```js
  spawn({
    ownerId, ownerKind = 'player', ownerFaction = null, x, y, nx, ny, weapon, damage,
  }) {
```

```js
      ownerId,
      // 'player' by default so every existing call site is byte-identical.
      // A creature-owned shot carries its shooter's faction, which is what
      // the targeting rules below key on.
      ownerKind,
      ownerFaction,
```

- [ ] **Step 4: Add the targeting predicates**

Above the class, add:

```js
// Who a projectile may damage. These mirror the targeting rules CreatureSim
// already enforces -- guards engage only hostiles, hostiles never target
// guards, and neither targets its own faction -- rather than inventing a
// second rule set that could drift from them.
//
// The owner exclusion is folded in here as the same rule generalised: a
// projectile never damages its own shooter, whoever that is.
function projectileHitsCreature(p, creature) {
  if (p.ownerKind !== 'creature') return true;        // player shots hit any creature
  if (p.ownerId === creature.id) return false;        // never its own shooter
  const targetFaction = creature.faction || 'hostile';
  return p.ownerFaction !== targetFaction;            // never same faction
}

function projectileHitsPlayer(p, player) {
  if (p.ownerKind !== 'creature') return player.userId !== p.ownerId;
  // A guard's arrow must never hit the player it is defending.
  return p.ownerFaction === 'hostile';
}
```

- [ ] **Step 5: Apply them at all four collision sites**

In `step`, the creature loop's guard becomes:

```js
        for (const c of creatureList) {
          if (!projectileHitsCreature(p, c)) continue;
          const key = `c:${c.id}`;
```

and the player loop's:

```js
        for (const pl of players) {
          if (!projectileHitsPlayer(p, pl)) continue;
          const key = `p:${pl.userId}`;
```

In `_detonate`, apply the same two predicates to its creature and player loops,
replacing the existing `if (pl.userId === p.ownerId) continue;`.

- [ ] **Step 6: Run the projectile tests, then the full suite**

```bash
cd backend && npx node --test tests/authority_projectiles.test.js && npm test
```
Expected: PASS, no new failures.

- [ ] **Step 7: Commit**

```bash
git add backend/src/authority/projectiles.js backend/tests/authority_projectiles.test.js
git commit -F - <<'EOF'
feat(projectiles): let a projectile be creature-owned (SOMET-249)

ownerKind defaults to 'player', so every existing call site is byte-identical.
Targeting mirrors the rules CreatureSim already enforces -- guards engage only
hostiles, hostiles never target guards, nothing hits its own faction -- rather
than a second rule set that could drift from the first. A hostile pack of
archers therefore cannot shred itself, and a guard's arrow cannot hit the
player it is defending.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 9: Creatures fire

**Files:**
- Modify: `backend/src/authority/creatures.js` (`tick`)
- Modify: `backend/src/authority/world.js` (`tickCreatures`)
- Create: `backend/tests/authority_creature_shots.test.js`

**Interfaces:**
- Consumes: `spawn({ ownerKind, ownerFaction, ... })` from Task 8.
- Produces: `tick` fills `shots` with
  `{ ownerId, ownerFaction, x, y, nx, ny, damage, element, speed, radius, range }`.
  `World.tickCreatures` spawns them, bounded by `MAX_CREATURE_PROJECTILES`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/authority_creature_shots.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim } = require('../src/authority/creatures.js');

function openMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }
function walledMap() { return { isWalkable: () => false, speedAt: () => 1, chunkSize: 8 }; }
const noRedirect = () => 0.05;

function ranged(over = {}) {
  return {
    name: 'R', attackKind: 'ranged', attackRange: 340, attackCooldown: 1.8,
    projectileSpeed: 520, projectileRadius: 6, aggroRadius: 460, leashRadius: 800,
    chaseStyle: 'kite', preferredRange: 240, moveSpeedMult: 1, damageOverride: null,
    ...over,
  };
}

function sim(bh, mapFn = openMap, element = 'physical') {
  const s = new CreatureSim(mapFn(), noRedirect);
  s.addCreatures([{ id: 'c', type: 'R', x: 100, y: 100, hp: 100,
    behavior: bh, attackElement: element, damage: 7 }]);
  return s;
}
const active = new Set(['0,0', '0,1', '1,0', '1,1']);

test('a ranged creature emits a shot at a target in range', () => {
  const s = sim(ranged());
  const player = { userId: 'u1', x: 380, y: 100, width: 48, height: 48, hp: 500 };
  const { shots } = s.tick(0.1, active, [player], 0);
  assert.equal(shots.length, 1);
  const shot = shots[0];
  assert.equal(shot.ownerId, 'c');
  assert.equal(shot.ownerFaction, 'hostile');
  assert.equal(shot.element, 'physical');
  assert.equal(shot.damage, 7);
  assert.equal(shot.speed, 520);
  // Aimed east, at the player.
  assert.ok(shot.nx > 0.9, `expected an eastward aim, got nx=${shot.nx}`);
  assert.ok(Math.abs(Math.hypot(shot.nx, shot.ny) - 1) < 1e-9, 'aim must be normalized');
});

test('a melee creature never emits a shot', () => {
  const s = sim(ranged({ attackKind: 'melee', attackRange: 400 }));
  const player = { userId: 'u1', x: 200, y: 100, width: 48, height: 48, hp: 500, mit: null };
  const { shots } = s.tick(0.1, active, [player], 0);
  assert.equal(shots.length, 0);
});

test('no shot without line of sight', () => {
  const s = sim(ranged(), walledMap);
  const player = { userId: 'u1', x: 380, y: 100, width: 48, height: 48, hp: 500 };
  const { shots } = s.tick(0.1, active, [player], 0);
  assert.equal(shots.length, 0, 'must not shoot through a wall');
});

test('no shot at a target beyond attack range', () => {
  const s = sim(ranged({ attackRange: 100, aggroRadius: 460 }));
  const player = { userId: 'u1', x: 400, y: 100, width: 48, height: 48, hp: 500 };
  const { shots } = s.tick(0.1, active, [player], 0);
  assert.equal(shots.length, 0);
});

test('the cooldown gates the rate of fire', () => {
  const s = sim(ranged({ attackCooldown: 1.0 }));
  const player = { userId: 'u1', x: 380, y: 100, width: 48, height: 48, hp: 500 };
  let total = 0;
  // 1.0s of ticks at 0.1s: one shot at t=0, and the cooldown is not yet clear
  // by the tenth tick.
  for (let i = 0; i < 10; i++) total += s.tick(0.1, active, [player], i * 0.1).shots.length;
  assert.equal(total, 1, `expected exactly one shot in 1.0s, got ${total}`);
});

test('a cast creature fires its own element, a ranged one always physical', () => {
  const cast = sim(ranged({ attackKind: 'cast' }), openMap, 'fire');
  const player = { userId: 'u1', x: 380, y: 100, width: 48, height: 48, hp: 500 };
  assert.equal(cast.tick(0.1, active, [player], 0).shots[0].element, 'fire');

  const arrow = sim(ranged({ attackKind: 'ranged' }), openMap, 'fire');
  assert.equal(arrow.tick(0.1, active, [player], 0).shots[0].element, 'physical',
    'a ranged rung fires physical even when the line has an element');
});

test('a hold creature fires without moving', () => {
  const s = sim(ranged({ chaseStyle: 'hold', attackRange: 380 }));
  const player = { userId: 'u1', x: 380, y: 100, width: 48, height: 48, hp: 500 };
  const { shots } = s.tick(0.1, active, [player], 0);
  assert.equal(shots.length, 1);
  assert.equal(s.all()[0].x, 100, 'hold must not move');
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd backend && npx node --test tests/authority_creature_shots.test.js`
Expected: FAIL — `shots` is always empty.

- [ ] **Step 3: Emit shots from `tick`**

In the hostile chase branch, replace the single contact-damage block with a
kind-dependent one:

```js
        // Attack. Same cooldown gate for every kind, so a ranged creature
        // cannot fire faster than its profile allows and a shocked creature
        // misses its shot exactly as it misses its bite (canAct).
        if (c._attackCd <= 0 && canAct(c, now)
            && dist2(cc.x, cc.y, tc.x, tc.y) <= bh.attackRange * bh.attackRange) {
          const dmg = bh.damageOverride ?? (c.damage ?? CREATURE_DAMAGE);
          if (bh.attackKind === 'melee') {
            applyDamageWithEffects(tp, dmg, 'physical', tp.mit || NO_MITIGATION, now);
            c._attackCd = bh.attackCooldown;
          } else if (hasLineOfSight(this.map, cc.x, cc.y, tc.x, tc.y)) {
            // Terrain blocks a shot exactly as it blocks the melee arc.
            // Without this a ranged creature burns its cooldowns firing into
            // a wall, which reads as a broken enemy rather than a blocked one.
            const d = Math.hypot(tc.x - cc.x, tc.y - cc.y) || 1;
            shots.push({
              ownerId: c.id,
              ownerFaction: c.faction || 'hostile',
              x: cc.x, y: cc.y,
              nx: (tc.x - cc.x) / d, ny: (tc.y - cc.y) / d,
              damage: dmg,
              // A `ranged` rung fires physical; only `cast` carries the line's
              // element and therefore its status rider.
              element: bh.attackKind === 'cast' ? (c.attackElement || 'physical') : 'physical',
              speed: bh.projectileSpeed,
              radius: bh.projectileRadius,
              range: bh.attackRange,
            });
            c._attackCd = bh.attackCooldown;
          }
          // No line of sight: the cooldown is NOT stamped, so the creature
          // fires the moment it has a clear shot rather than also serving a
          // cooldown for the shot it never took. Same treatment canAct gets.
        }
```

The `hold` branch needs the same attack block. Rather than duplicating it,
ensure `hold` falls through to this shared attack code with `move = false` — it
already does, given Task 7's structure.

- [ ] **Step 4: Spawn the shots in `world.js`**

At the top of `backend/src/authority/world.js`:

```js
// Bounds concurrent creature-owned projectiles per world. A swarm-density
// world can hold 12-creature packs; twelve Ranged creatures on a 1.8s cooldown
// sustain roughly seven shots per second, and ProjectileSim.step is
// O(projectiles x creatures) per sub-step. Excess shots are DROPPED, not
// queued -- a queued shot arrives after its target has moved and reads worse
// than no shot at all.
const MAX_CREATURE_PROJECTILES = 120;
```

In `tickCreatures`:

```js
    const { killed: killedIds, shots } = this.creatures.tick(
      dt, activeKeys, [...this.players.values()], this.now) || { killed: [], shots: [] };

    for (const s of shots) {
      if (this.projectiles.count() >= MAX_CREATURE_PROJECTILES) break;
      this.projectiles.spawn({
        ownerId: s.ownerId,
        ownerKind: 'creature',
        ownerFaction: s.ownerFaction,
        x: s.x, y: s.y, nx: s.nx, ny: s.ny,
        damage: s.damage,
        // ProjectileSim reads its flight parameters off a weapon-shaped
        // object; a creature's profile supplies the same four fields.
        weapon: {
          projectile_speed: s.speed,
          projectile_radius: s.radius,
          range: s.range,
          pierce: 1,
          aoe_radius: 0,
          element: s.element,
          damage: s.damage,
        },
      });
    }
```

Export the constant so a test can assert the cap:

```js
module.exports = { /* existing exports */, MAX_CREATURE_PROJECTILES };
```

- [ ] **Step 5: Run the shot tests, the golden test, and the full suite**

```bash
cd backend && npx node --test tests/authority_creature_shots.test.js \
  && npx node --test tests/creature_behavior_golden.test.js && npm test
```
Expected: all PASS. The golden test still holds because every existing creature
is `melee`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/authority/creatures.js backend/src/authority/world.js backend/tests/authority_creature_shots.test.js
git commit -F - <<'EOF'
feat(creatures): give ranged and cast creatures a real projectile (SOMET-249)

A shot is emitted as data from the tick and spawned by World, so CreatureSim
never depends on ProjectileSim. Line of sight gates firing -- and a blocked
shot deliberately does NOT stamp the cooldown, so the creature fires the moment
it has a clear line rather than also serving a cooldown for a shot it never
took, matching how canAct already refuses an attack.

Only `cast` carries the creature's element and therefore its status rider; a
`ranged` rung fires physical. MAX_CREATURE_PROJECTILES bounds the per-world
cost, since ProjectileSim.step is O(projectiles x creatures) per sub-step.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 10: API routes

**Files:**
- Modify: `backend/src/index.js`
- Create: `backend/tests/creature_behaviors_api_db.test.js`

**Interfaces:**
- Produces: `GET /api/creature-behaviors` (unauthenticated read, like
  `/api/vfx-effects`), and admin-guarded `POST`, `PUT /:id`, `DELETE /:id`.
  `POST`/`PUT /api/entity-types` accept `behavior_id` and `attack_element`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/creature_behaviors_api_db.test.js`. Model its server
bootstrap on an existing route test — find one with
`grep -rln "api/tile-types" backend/tests/`. Assert:

```js
// 1. GET returns the twelve seeded profiles, Line among them.
// 2. POST rejects an unknown chase_style with 400 (not a 500 from the CHECK).
// 3. PUT updates a profile's numbers.
// 4. DELETE of a profile referenced by an entity type returns 409, names the
//    referencing types, and leaves the row in place.
// 5. DELETE of an unreferenced profile returns 204.
```

Every fixture profile is named `zz…` and removed by name in a `finally`.

- [ ] **Step 2: Run and watch it fail**

Run: `cd backend && npx node --test tests/creature_behaviors_api_db.test.js`
Expected: FAIL — 404 on every route.

- [ ] **Step 3: Add the routes**

In `backend/src/index.js`, beside the tile-type routes:

```js
// Creature Behaviors CRUD. Read is unauthenticated for the same reason
// /api/vfx-effects is: it is catalog data with nothing private in it.
app.get('/api/creature-behaviors', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM creature_behaviors ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch creature behaviors' });
  }
});
```

Validate the two enumerated fields in JS before they reach the CHECK
constraints, so a bad value is a 400 with a readable message rather than a 500:

```js
const { ATTACK_KINDS, CHASE_STYLES } = require('./services/creatureBehaviors');

function behaviorFieldError(body) {
  if (!body.name) return 'name is required';
  if (catalogNameTooLong(body.name)) return `name must be ${MAX_CATALOG_NAME_LEN} characters or fewer`;
  if (!ATTACK_KINDS.includes(body.attack_kind)) return `attack_kind must be one of ${ATTACK_KINDS.join(', ')}`;
  if (!CHASE_STYLES.includes(body.chase_style)) return `chase_style must be one of ${CHASE_STYLES.join(', ')}`;
  return null;
}
```

Write `POST` and `PUT /:id` using that helper and the same column list as
`seedOneBehavior`. Then `DELETE` with the reference guard:

```js
app.delete('/api/creature-behaviors/:id', adminGuard, async (req, res) => {
  try {
    const { id } = req.params;
    // entity_types.behavior_id is a real FK, so the database would refuse this
    // anyway -- with an unreadable 500. Checking first turns it into a 409
    // that names what is in the way. SOMET-238 records that /api/tile-types
    // and /api/entity-types still lack guards like this one; that gap is not
    // fixed here, but it is not repeated in new code either.
    const refs = await pool.query(
      'SELECT id, name FROM entity_types WHERE behavior_id = $1', [id]);
    if (refs.rows.length > 0) {
      return res.status(409).json({
        error: 'Cannot delete: still referenced by a creature type',
        referencing_entity_types: refs.rows,
      });
    }
    const result = await pool.query(
      'DELETE FROM creature_behaviors WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Behavior not found' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete creature behavior' });
  }
});
```

- [ ] **Step 4: Accept the two new fields on entity types**

Find the entity-type `INSERT` (`backend/src/index.js:395`) and `UPDATE`
(`:464`). Add `behavior_id` and `attack_element` to both — destructured from
`req.body`, added to the column list, and passed as parameters. Use
`attack_element || 'physical'` and `behavior_id ?? null`.

- [ ] **Step 5: Run the API test and the full suite**

```bash
cd backend && npx node --test tests/creature_behaviors_api_db.test.js && npm test
```
Expected: PASS, no new failures.

- [ ] **Step 6: Commit**

```bash
git add backend/src/index.js backend/tests/creature_behaviors_api_db.test.js
git commit -F - <<'EOF'
feat(api): expose the creature behaviour catalog (SOMET-249)

Read is unauthenticated like /api/vfx-effects; writes are admin-guarded.
attack_kind and chase_style are validated in JS before they reach the CHECK
constraints, so a bad value is a readable 400 rather than a 500.

DELETE carries a reference guard. SOMET-238 records that the tile-type and
entity-type deletes still lack one; that is not fixed here, but it is not
repeated in new code either.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 11: The admin surface

Frontend vitest runs in **node environment with no DOM**, so the tests here
cover the pure form helpers. The component itself is verified in the browser
pass, not by a unit test.

**Files:**
- Create: `frontend/src/games/something2/behaviorForm.js`
- Create: `frontend/src/games/something2/__tests__/behaviorForm.test.js`
- Create: `frontend/src/games/something2/useCreatureBehaviors.js`
- Create: `frontend/src/games/something2/CreatureBehaviorsAdmin.jsx`
- Modify: `frontend/src/App.jsx`, `frontend/src/ui/MainNav.jsx`,
  `frontend/src/games/something2/EntityTypesAdmin.jsx`,
  `frontend/src/games/something2/__tests__/themeTokens.test.js`

**Interfaces:**
- Consumes: `GET/POST/PUT/DELETE /api/creature-behaviors` from Task 10.
- Produces: `behaviorToForm(row)` and `behaviorFormToPayload(form)`;
  `useCreatureBehaviors()` returning `{ behaviors, isLoadingBehaviors }`.

- [ ] **Step 1: Write the failing helper test**

Create `frontend/src/games/something2/__tests__/behaviorForm.test.js`:

```js
import { describe, it, expect } from "vitest";
import { behaviorToForm, behaviorFormToPayload, ATTACK_KINDS, CHASE_STYLES }
  from "../behaviorForm.js";

describe("behaviorForm", () => {
  it("round-trips a profile without drifting a value", () => {
    const row = {
      id: 3, name: "Ranged", attack_kind: "ranged", attack_range: 340,
      attack_cooldown: 1.8, projectile_speed: 520, projectile_radius: 6,
      aggro_radius: 460, leash_radius: 800, chase_style: "kite",
      preferred_range: 240, move_speed_mult: 1, damage_override: null,
    };
    const back = behaviorFormToPayload(behaviorToForm(row));
    expect(back.attack_range).toBe(340);
    expect(back.chase_style).toBe("kite");
    expect(back.preferred_range).toBe(240);
    expect(back.damage_override).toBe(null);
  });

  it("keeps a damage_override of 0 rather than dropping it to null", () => {
    const form = behaviorToForm({ name: "Z", attack_kind: "melee", chase_style: "charge",
      damage_override: 0 });
    expect(behaviorFormToPayload(form).damage_override).toBe(0);
  });

  it("turns a blank damage_override field into null, not 0", () => {
    const form = { ...behaviorToForm({ name: "Z", attack_kind: "melee", chase_style: "charge" }),
      damage_override: "" };
    expect(behaviorFormToPayload(form).damage_override).toBe(null);
  });

  it("coerces numeric text fields to numbers", () => {
    const form = { ...behaviorToForm({ name: "Z", attack_kind: "melee", chase_style: "charge" }),
      attack_range: "72", move_speed_mult: "1.25" };
    const p = behaviorFormToPayload(form);
    expect(p.attack_range).toBe(72);
    expect(p.move_speed_mult).toBe(1.25);
  });

  it("exposes the same value sets the backend enforces", () => {
    expect(ATTACK_KINDS).toEqual(["melee", "ranged", "cast"]);
    expect(CHASE_STYLES).toEqual(["charge", "kite", "skirmish", "hold", "ambush", "guard"]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/behaviorForm.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helpers**

Create `frontend/src/games/something2/behaviorForm.js`:

```js
// Pure form <-> payload helpers for CreatureBehaviorsAdmin. Split out of the
// component because frontend vitest runs in a node environment with no DOM:
// this is the part that can actually be tested.

// Mirrors ATTACK_KINDS / CHASE_STYLES in
// backend/src/services/creatureBehaviors.js and the CHECK constraints in
// migration 1714440080000. Three copies is deliberate -- see the note in the
// backend module.
export const ATTACK_KINDS = ["melee", "ranged", "cast"];
export const CHASE_STYLES = ["charge", "kite", "skirmish", "hold", "ambush", "guard"];

const NUMERIC = [
  "attack_range", "attack_cooldown", "projectile_speed", "projectile_radius",
  "aggro_radius", "leash_radius", "preferred_range", "move_speed_mult",
];

export function behaviorToForm(row = {}) {
  const form = {
    id: row.id ?? null,
    name: row.name ?? "",
    attack_kind: row.attack_kind ?? "melee",
    chase_style: row.chase_style ?? "charge",
    // null means "use the creature's own damage". 0 is a real override and
    // must survive the round trip, so this is an explicit null check.
    damage_override: row.damage_override == null ? "" : row.damage_override,
  };
  for (const k of NUMERIC) form[k] = row[k] ?? 0;
  return form;
}

export function behaviorFormToPayload(form) {
  const payload = {
    name: form.name,
    attack_kind: form.attack_kind,
    chase_style: form.chase_style,
    damage_override: form.damage_override === "" || form.damage_override == null
      ? null : Number(form.damage_override),
  };
  for (const k of NUMERIC) payload[k] = Number(form[k]) || 0;
  return payload;
}
```

- [ ] **Step 4: Run the helper test**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/behaviorForm.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the hook**

Create `frontend/src/games/something2/useCreatureBehaviors.js`, modelled
directly on `useBiomes.js` — same `API_URL`, `apiFetch`, `authHeaders`,
TanStack query key `["creature-behaviors"]`, and the same mutation factory
shape. Creature behaviours are cached by the authority at `loadWorld`, so a
`liveWarning` on PUT is **not** surfaced here; do not copy that part.

- [ ] **Step 6: Write the admin component**

Create `frontend/src/games/something2/CreatureBehaviorsAdmin.jsx`, modelled on
`TileTypesAdmin.jsx`: a table of profiles, a create/edit modal, delete with
confirmation. `attack_kind` and `chase_style` are `<select>` elements populated
from `ATTACK_KINDS` / `CHASE_STYLES`. Every colour must come from a `--s2-*`
token — `themeTokens.test.js` reads component source text and will fail on a
hardcoded hex.

- [ ] **Step 7: Register the route and nav entry**

In `frontend/src/App.jsx`, import the component and add inside the
`RequireAdmin` block, after the `biomes` route:

```jsx
                      <Route path="creature-behaviors" element={<CreatureBehaviorsAdmin />} />
```

In `frontend/src/ui/MainNav.jsx`, add an item to the admin section beside
Biomes, with `path: '/game/creature-behaviors'`. Follow the shape of the
existing entries exactly (`id`, `label`, `path`, `Icon`, `adminType`).

In `frontend/src/games/something2/__tests__/themeTokens.test.js`, add
`'CreatureBehaviorsAdmin.jsx'` to the list of gated components.

- [ ] **Step 8: Add the two dropdowns to the entity form**

In `EntityTypesAdmin.jsx`, add a behaviour `<select>` (populated from
`useCreatureBehaviors()`, submitting `behavior_id`) and an attack-element
`<select>` with options `physical`, `fire`, `ice`, `lightning`. Both appear
only when `is_creature` is checked.

- [ ] **Step 9: Run the frontend suite**

Run: `cd frontend && npx vitest run`
Expected: all PASS. Record the count.

- [ ] **Step 10: Commit**

```bash
git add frontend/src
git commit -F - <<'EOF'
feat(admin): add the Creature Behaviors catalog surface (SOMET-249)

Follows the tile-type and biome pattern: sidebar route, table, create/edit
modal, delete with confirmation. The form <-> payload helpers are split into a
pure module because frontend vitest runs in a node environment with no DOM, so
that split is what makes any of this testable.

A damage_override of 0 is a real value meaning "hits for nothing" and survives
the round trip; a blank field becomes null, meaning "use the creature's own
damage".

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

## Verification before the branch is finished

Run after every task is complete, and record the results.

- [ ] `cd backend && npm test` — compare against Task 1's recorded baseline.
- [ ] `cd frontend && npx vitest run`.
- [ ] `cd backend && npm run migrate:up` on a clean database, then
      `npm run migrate:down` twice and `migrate:up` twice, to prove both new
      migrations are reversible and re-runnable.
- [ ] `make seed-catalogs` twice in a row; confirm the second run changes
      nothing and no hand-authored field is lost.
- [ ] **Browser pass.** Start the stack (`docker compose up -d`, then
      `docker compose exec -d backend npm run dev` — the container's CMD is a
      stub and does not start Node). Load the game, confirm zero console
      errors, and confirm existing creatures still roam and chase.
- [ ] **Exercise a new style.** In the Entity Types admin, temporarily set one
      creature type's behaviour to `Ranged` and its element to `fire`, watch it
      kite and shoot in the running game, then **set it back to `Line`**. This
      is a write to the shared dev database and must be reverted. Screenshot
      both the shooting and the reverted state.

---

## Plan self-review

**Spec coverage.** `creature_behaviors` table → Task 2. `entity_types` columns
→ Task 3. Three attack kinds → Tasks 2 and 9. Six chase styles → Tasks 6 and 7.
Twelve seeded profiles → Task 2. Behaviour preservation → Tasks 1 and 6.
`loadCreatureTypes` join and guard test → Task 5. `{ killed, shots }` → Task 6.
Line of sight before firing → Task 9. `MAX_CREATURE_PROJECTILES` → Task 9.
`ownerKind` and the faction matrix → Task 8. API with delete guard → Task 10.
Admin route, seed file, entity form → Tasks 2 and 11. Every spec section maps
to a task.

**Type consistency.** `resolveBehavior` returns camelCase (`attackKind`,
`chaseStyle`, `moveSpeedMult`, `damageOverride`); database columns and API
payloads stay snake_case; the boundary is Task 5's mapping and Task 11's
`behaviorFormToPayload`. `tick` returns `{ killed, shots }` in Task 6 and every
later task uses that shape. A shot object's fields are fixed in Task 9 and
consumed only there.

**Known deliberate duplication.** The `ATTACK_KINDS` / `CHASE_STYLES` value
sets exist in three places: the migration's CHECK constraints, the backend
service, and the frontend form module. Each is load-bearing — a value rejected
only in JS reaches the database, and a value rejected only in SQL reaches the
sim as a 500. Task 4's test and Task 11's test both pin the sets against
literals so the copies cannot drift silently.
