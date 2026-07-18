# Phase 6 Slice 3b-1: Combat Engine + Aiming + Projectiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded Slice-3a melee with a data-driven weapon engine: melee reach+arc hitscan and server-simulated projectiles (ranged + magic), driven by mouse 360° aim, with PvP and a minimal mana pool.

**Architecture:** A `weapon_types` catalog (data) drives two server resolution paths. `World` owns players, `CreatureSim`, and a new `ProjectileSim`. An `attack` message carries an aim vector; `World.attack` dispatches to melee-arc (hits creatures + other players in a cone) or spawns a projectile (mana-gated). Projectiles advance each tick, colliding with terrain/creatures/players. The 20 Hz `state` gains `mana`/`weaponId` per player + a `projectiles` array; new `equip` message switches weapons. Client converts cursor→world via the existing `screenToWorld`, sends aim on left-click, renders projectiles, and switches weapons with number keys.

**Tech Stack:** Node.js (CommonJS) authority, `node-pg-migrate`, `ws`, `node --test`; frontend Vite/React ESM, Vitest (env `node`, no jsdom — render layer verified by build + browser).

## Global Constraints

- Server owns all combat: weapon stats, damage, range, arc, cooldown, mana, collision, projectile motion, death, respawn. Client sends attack intent + aim vector + equip selection only — never positions, hp, mana, or damage.
- Weapons are **data** (`weapon_types`); exactly **two** resolution paths (melee arc, projectile). No per-weapon code.
- Reuse `ServerMap` for projectile terrain collision; creature removal goes through `CreatureSim.damageCreatureById` / `applyMeleeArc` (no duplicated creature bookkeeping in projectile code).
- PvP: damageable target set = creatures ∪ other players; a projectile never hits its owner.
- Distances are **center-to-center** (`x + width/2`); `arc_width` is the **full** cone angle (`|θ| <= arc_width/2`).
- Aim is client-provided, normalized server-side; a zero vector falls back to the player's `facing`.
- Mana never exceeds `maxMana`; a projectile attack below `mana_cost` is **denied without consuming cooldown**.
- 20 Hz `state` / ~5 Hz `creatures` cadences unchanged; `state` gains `mana`/`weaponId`/`projectiles`. The Slice-3a spacebar attack is replaced by left-click.
- Creatures still deal contact damage only (unchanged); no weapons for creatures this slice.
- Backend tests: `cd backend && node --test tests/<file>`. Frontend: `cd frontend && npx vitest run <file>`.

## Seeded weapons (authoritative values — used verbatim in the migration and referenced by tests)

| name | kind | damage | cooldown | reach | arc_width | range | projectile_speed | projectile_radius | pierce | mana_cost | element |
|------|------|--------|----------|-------|-----------|-------|------------------|-------------------|--------|-----------|---------|
| dagger | melee | 8 | 0.30 | 80 | 0.6 | null | null | null | null | 0 | null |
| halberd | melee | 18 | 0.90 | 190 | 1.8 | null | null | null | null | 0 | null |
| bow | projectile | 12 | 0.60 | null | null | 700 | 900 | 8 | 1 | 0 | null |
| magic-bolt | projectile | 14 | 0.70 | null | null | 600 | 700 | 12 | 1 | 15 | arcane |

Default weapon = **dagger**. Player: `PLAYER_MAX_MANA = 100`, `PLAYER_MANA_REGEN = 10` (per second).

---

### Task 1: Weapon geometry + aim helpers (`weapons.js`, pure)

**Files:**
- Create: `backend/src/authority/weapons.js`
- Test: `backend/tests/authority_weapons.test.js`

**Interfaces:**
- Produces: `normalizeAim(ax, ay, facing) -> {nx, ny}`; `inArc(ox, oy, nx, ny, tx, ty, reach, arcWidth) -> boolean`; `DEFAULT_WEAPON_NAME = 'dagger'`. (`loadWeaponTypes`/`resolveDefaultWeaponId` are added in Task 2 — same file, appended, do not remove Task 1 exports.)

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/authority_weapons.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { normalizeAim, inArc, DEFAULT_WEAPON_NAME } = require('../src/authority/weapons.js');

test('normalizeAim normalizes a non-zero vector to unit length', () => {
  const { nx, ny } = normalizeAim(3, 4, 's');
  assert.ok(Math.abs(Math.hypot(nx, ny) - 1) < 1e-9);
  assert.ok(Math.abs(nx - 0.6) < 1e-9 && Math.abs(ny - 0.8) < 1e-9);
});

test('normalizeAim falls back to the facing direction on a zero vector', () => {
  assert.deepEqual(round(normalizeAim(0, 0, 'e')), { nx: 1, ny: 0 });
  assert.deepEqual(round(normalizeAim(0, 0, 'n')), { nx: 0, ny: -1 });
  const se = normalizeAim(0, 0, 'se');
  assert.ok(Math.abs(Math.hypot(se.nx, se.ny) - 1) < 1e-9);
  assert.ok(se.nx > 0 && se.ny > 0);
  // Unknown/empty facing → default south.
  assert.deepEqual(round(normalizeAim(0, 0, null)), { nx: 0, ny: 1 });
});

test('inArc: inside reach and cone is a hit', () => {
  // aim east; target due east, close.
  assert.equal(inArc(0, 0, 1, 0, 50, 0, 80, 0.6), true);
});

test('inArc: outside reach is a miss even when dead ahead', () => {
  assert.equal(inArc(0, 0, 1, 0, 200, 0, 80, 0.6), false);
});

test('inArc: outside the angular cone is a miss even when within reach', () => {
  // aim east; target due north, within reach — angle 90° > 0.3 rad half-cone.
  assert.equal(inArc(0, 0, 1, 0, 0, -50, 80, 0.6), false);
});

test('inArc: a wide arc includes a target a narrow arc excludes', () => {
  // target 45° off-aim, within reach.
  const tx = 40, ty = -40; // 45° up-right from origin; aim east
  assert.equal(inArc(0, 0, 1, 0, tx, ty, 80, 0.6), false); // narrow (0.3 rad half)
  assert.equal(inArc(0, 0, 1, 0, tx, ty, 80, 1.8), true);  // wide (0.9 rad half)
});

test('inArc: a target exactly at the origin counts as a hit', () => {
  assert.equal(inArc(10, 10, 1, 0, 10, 10, 80, 0.6), true);
});

test('DEFAULT_WEAPON_NAME is dagger', () => {
  assert.equal(DEFAULT_WEAPON_NAME, 'dagger');
});

function round(v) { return { nx: Math.round(v.nx), ny: Math.round(v.ny) }; }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/authority_weapons.test.js`
Expected: FAIL — `Cannot find module '../src/authority/weapons.js'`.

- [ ] **Step 3: Implement `weapons.js`**

Create `backend/src/authority/weapons.js`:

```js
// Weapon geometry + aim helpers, shared by the attack resolver, the creature
// arc hit-test, and their tests. Pure (no DB); the catalog loader is appended
// in Task 2.

const DEFAULT_WEAPON_NAME = 'dagger';

// Unit vector for an 8-way facing string ('n','s','e','w' and their combos,
// e.g. 'se'). Used as the aim fallback when the client sends a zero vector.
function vectorFromFacing(facing) {
  const f = typeof facing === 'string' ? facing.toLowerCase() : '';
  let x = 0, y = 0;
  if (f.includes('n')) y -= 1;
  if (f.includes('s')) y += 1;
  if (f.includes('e')) x += 1;
  if (f.includes('w')) x -= 1;
  if (x === 0 && y === 0) return { nx: 0, ny: 1 }; // default south
  const len = Math.hypot(x, y);
  return { nx: x / len, ny: y / len };
}

// Normalize an aim vector; fall back to the facing direction if it is ~zero.
function normalizeAim(ax, ay, facing) {
  const len = Math.hypot(ax || 0, ay || 0);
  if (len > 1e-9) return { nx: ax / len, ny: ay / len };
  return vectorFromFacing(facing);
}

// True iff target center (tx,ty) is within `reach` of origin (ox,oy) AND the
// angle between the (already-normalized) aim vector (nx,ny) and the
// origin→target direction is <= arcWidth/2. A target at the origin is a hit.
function inArc(ox, oy, nx, ny, tx, ty, reach, arcWidth) {
  const dx = tx - ox, dy = ty - oy;
  const d2 = dx * dx + dy * dy;
  if (d2 > reach * reach) return false;
  if (d2 === 0) return true;
  const d = Math.sqrt(d2);
  const dot = (dx / d) * nx + (dy / d) * ny; // cos(angle between aim and target)
  return dot >= Math.cos(arcWidth / 2);
}

module.exports = { DEFAULT_WEAPON_NAME, normalizeAim, inArc, vectorFromFacing };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/authority_weapons.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/weapons.js backend/tests/authority_weapons.test.js
git commit -m "feat(authority): weapon geometry + aim helpers (normalizeAim, inArc)"
```

---

### Task 2: `weapon_types` migration + catalog loader

**Files:**
- Create: `backend/migrations/1714440016000_create_weapon_types.js`
- Modify: `backend/src/authority/weapons.js` (append `loadWeaponTypes`, `resolveDefaultWeaponId`)
- Test: `backend/tests/authority_weapons_catalog.test.js`

**Interfaces:**
- Consumes: `pool.query` (the pg pool / mock).
- Produces: `loadWeaponTypes(pool) -> Promise<Map<id, weapon>>` where each `weapon = {id, name, kind, damage, cooldown, reach, arc_width, range, projectile_speed, projectile_radius, pierce, mana_cost, element}` (numbers coerced; nullable fields kept `null`). `resolveDefaultWeaponId(mapById) -> id` (the id whose `name === DEFAULT_WEAPON_NAME`, else the first id).

- [ ] **Step 1: Write the migration**

Create `backend/migrations/1714440016000_create_weapon_types.js`:

```js
exports.up = (pgm) => {
  pgm.createTable('weapon_types', {
    id: { type: 'serial', primaryKey: true },
    name: { type: 'text', notNull: true, unique: true },
    kind: { type: 'text', notNull: true }, // 'melee' | 'projectile'
    damage: { type: 'real', notNull: true },
    cooldown: { type: 'real', notNull: true },
    reach: { type: 'real' },
    arc_width: { type: 'real' },
    range: { type: 'real' },
    projectile_speed: { type: 'real' },
    projectile_radius: { type: 'real' },
    pierce: { type: 'integer' },
    mana_cost: { type: 'real', notNull: true, default: 0 },
    element: { type: 'text' },
    icon: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('weapon_types', 'weapon_types_kind_check',
    "CHECK (kind IN ('melee','projectile'))");

  // Seed the 4 representative weapons (idempotent).
  pgm.sql(`
    INSERT INTO weapon_types
      (name, kind, damage, cooldown, reach, arc_width, range, projectile_speed, projectile_radius, pierce, mana_cost, element)
    VALUES
      ('dagger',     'melee',      8, 0.30,  80, 0.6, NULL, NULL, NULL, NULL,  0, NULL),
      ('halberd',    'melee',     18, 0.90, 190, 1.8, NULL, NULL, NULL, NULL,  0, NULL),
      ('bow',        'projectile',12, 0.60, NULL, NULL, 700, 900,  8, 1,  0, NULL),
      ('magic-bolt', 'projectile',14, 0.70, NULL, NULL, 600, 700, 12, 1, 15, 'arcane')
    ON CONFLICT (name) DO NOTHING;
  `);
};

exports.down = (pgm) => pgm.dropTable('weapon_types');
```

- [ ] **Step 2: Run the migration against the dev DB**

Run: `cd backend && npm run migrate:up`
Expected: applies `1714440016000_create_weapon_types` with no error; a re-run is a no-op (seed `ON CONFLICT DO NOTHING`). If the DB is unavailable in this environment, note it and proceed — the loader test below uses a mock pool.

- [ ] **Step 3: Write the failing loader test**

Create `backend/tests/authority_weapons_catalog.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { loadWeaponTypes, resolveDefaultWeaponId } = require('../src/authority/weapons.js');

function fakePool(rows) {
  return { query: async (sql) => {
    assert.match(sql, /FROM weapon_types/i);
    return { rows };
  } };
}

const ROWS = [
  { id: 1, name: 'dagger', kind: 'melee', damage: '8', cooldown: '0.3', reach: '80', arc_width: '0.6',
    range: null, projectile_speed: null, projectile_radius: null, pierce: null, mana_cost: '0', element: null },
  { id: 3, name: 'bow', kind: 'projectile', damage: '12', cooldown: '0.6', reach: null, arc_width: null,
    range: '700', projectile_speed: '900', projectile_radius: '8', pierce: 1, mana_cost: '0', element: null },
];

test('loadWeaponTypes maps rows by id, coercing numbers and keeping nulls', async () => {
  const m = await loadWeaponTypes(fakePool(ROWS));
  assert.equal(m.size, 2);
  const dagger = m.get(1);
  assert.equal(dagger.kind, 'melee');
  assert.strictEqual(dagger.damage, 8);
  assert.strictEqual(dagger.reach, 80);
  assert.strictEqual(dagger.arc_width, 0.6);
  assert.strictEqual(dagger.range, null);
  const bow = m.get(3);
  assert.strictEqual(bow.projectile_speed, 900);
  assert.strictEqual(bow.pierce, 1);
  assert.strictEqual(bow.reach, null);
});

test('resolveDefaultWeaponId returns the dagger id, else the first', async () => {
  const m = await loadWeaponTypes(fakePool(ROWS));
  assert.equal(resolveDefaultWeaponId(m), 1);
  const noDagger = await loadWeaponTypes(fakePool([ROWS[1]]));
  assert.equal(resolveDefaultWeaponId(noDagger), 3); // first (only) id
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd backend && node --test tests/authority_weapons_catalog.test.js`
Expected: FAIL — `loadWeaponTypes is not a function`.

- [ ] **Step 5: Append the loader to `weapons.js`**

In `backend/src/authority/weapons.js`, add before `module.exports` and extend the exports:

```js
function num(v) { return v == null ? null : Number(v); }

// Load the weapon catalog into a Map keyed by id. Numbers are coerced; nullable
// melee/projectile fields are kept null.
async function loadWeaponTypes(pool) {
  const r = await pool.query(
    `SELECT id, name, kind, damage, cooldown, reach, arc_width,
            range, projectile_speed, projectile_radius, pierce, mana_cost, element
     FROM weapon_types ORDER BY id ASC`,
  );
  const m = new Map();
  for (const row of r.rows) {
    m.set(row.id, {
      id: row.id,
      name: row.name,
      kind: row.kind,
      damage: Number(row.damage),
      cooldown: Number(row.cooldown),
      reach: num(row.reach),
      arc_width: num(row.arc_width),
      range: num(row.range),
      projectile_speed: num(row.projectile_speed),
      projectile_radius: num(row.projectile_radius),
      pierce: num(row.pierce),
      mana_cost: Number(row.mana_cost),
      element: row.element ?? null,
    });
  }
  return m;
}

function resolveDefaultWeaponId(mapById) {
  for (const [id, w] of mapById) if (w.name === DEFAULT_WEAPON_NAME) return id;
  const first = mapById.keys().next();
  return first.done ? null : first.value;
}
```

Update the export line to:

```js
module.exports = { DEFAULT_WEAPON_NAME, normalizeAim, inArc, vectorFromFacing, loadWeaponTypes, resolveDefaultWeaponId };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && node --test tests/authority_weapons.test.js tests/authority_weapons_catalog.test.js`
Expected: PASS (both files).

- [ ] **Step 7: Commit**

```bash
git add backend/migrations/1714440016000_create_weapon_types.js backend/src/authority/weapons.js backend/tests/authority_weapons_catalog.test.js
git commit -m "feat(authority): weapon_types catalog table + seed + loader"
```

---

### Task 3: Creature arc + point-damage entry points (`creatures.js`)

**Files:**
- Modify: `backend/src/authority/creatures.js`
- Test: `backend/tests/authority_creatures_combat.test.js` (append)

**Interfaces:**
- Consumes: `inArc` from `weapons.js`; existing `this.creatures` Map, `center`, `dist2`.
- Produces on `CreatureSim`: `applyMeleeArc(ox, oy, nx, ny, reach, arcWidth, damage) -> string[]` (killed ids); `damageCreatureById(id, damage) -> boolean` (true if it died, removes it).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/authority_creatures_combat.test.js` (a `CreatureSim` combat test file already exists; if a helper to build a sim with creatures is present, reuse it — otherwise add the minimal one below):

```js
const { CreatureSim } = require('../src/authority/creatures.js');

// All-grass stub map so resolveMove/isWalkable never block (not used by these
// two methods, but CreatureSim's constructor needs a map with chunkSize).
function armSim() {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1 };
  const sim = new CreatureSim(map, () => 0.5);
  sim.addCreatures([
    { id: 'a', type: 'wolf', x: 100, y: 100, hp: 10, facing: 'S', color: '#f00' },
    { id: 'b', type: 'wolf', x: 300, y: 100, hp: 10, facing: 'S', color: '#f00' },
  ]);
  return sim;
}

test('applyMeleeArc damages creatures in the cone, returns the dead ids', () => {
  const sim = armSim();
  // Origin just west of 'a' (center 124,124), aim east, wide reach+arc, lethal.
  const killed = sim.applyMeleeArc(60, 124, 1, 0, 120, 1.8, 20);
  assert.deepEqual(killed, ['a']);      // 'a' in reach, dead
  assert.ok(!sim.has('a'));
  assert.ok(sim.has('b'));              // 'b' at 324,124 is out of reach 120
});

test('applyMeleeArc excludes a creature outside the angular cone', () => {
  const sim = armSim();
  // Origin south of 'a' (124,300), aim NORTH with a narrow cone: 'a' at (124,124)
  // is dead ahead within reach → hit; 'b' at (324,124) is ~37° off the aim axis,
  // beyond the 0.6 rad (±0.3 rad) cone → excluded.
  const killed = sim.applyMeleeArc(124, 300, 0, -1, 400, 0.6, 20);
  assert.deepEqual(killed, ['a']);
  assert.ok(!sim.has('a'));
  assert.ok(sim.has('b'), "'b' is outside the cone and survives");
});

test('damageCreatureById reduces hp and reports death', () => {
  const sim = armSim();
  assert.equal(sim.damageCreatureById('a', 4), false); // 10→6, alive
  assert.equal(sim.creatures.get('a').hp, 6);
  assert.equal(sim.creatures.get('a').dirty, true);
  assert.equal(sim.damageCreatureById('a', 6), true);  // 6→0, dead
  assert.ok(!sim.has('a'));
  assert.equal(sim.damageCreatureById('missing', 5), false); // no-op
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && node --test tests/authority_creatures_combat.test.js`
Expected: FAIL — `applyMeleeArc`/`damageCreatureById` are not functions.

- [ ] **Step 3: Implement the two methods**

In `backend/src/authority/creatures.js`, add the import at the top (after the existing requires):

```js
const { inArc } = require('./weapons');
```

Add these methods to the `CreatureSim` class (e.g. right after `applyAttack`):

```js
  // Melee arc: damage every creature whose center is within reach AND inside the
  // aim cone; remove + return the dead ids. (nx,ny) must be normalized.
  applyMeleeArc(ox, oy, nx, ny, reach, arcWidth, damage) {
    const killed = [];
    for (const [id, c] of this.creatures) {
      const cc = center(c);
      if (!inArc(ox, oy, nx, ny, cc.x, cc.y, reach, arcWidth)) continue;
      c.hp -= damage;
      c.dirty = true;
      if (c.hp <= 0) { this.creatures.delete(id); killed.push(id); }
    }
    return killed;
  }

  // Point damage to one creature (used by projectile collision). Returns true
  // if it died (and was removed).
  damageCreatureById(id, damage) {
    const c = this.creatures.get(id);
    if (!c) return false;
    c.hp -= damage;
    c.dirty = true;
    if (c.hp <= 0) { this.creatures.delete(id); return true; }
    return false;
  }
```

Keep `applyAttack` as-is (still referenced by existing Slice-3a tests; `World` will stop calling it in Task 5).

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && node --test tests/authority_creatures_combat.test.js`
Expected: PASS. Also run `cd backend && node --test tests/authority_creatures.test.js` — unchanged, still green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/creatures.js backend/tests/authority_creatures_combat.test.js
git commit -m "feat(authority): creature melee-arc + point-damage entry points"
```

---

### Task 4: `ProjectileSim`

**Files:**
- Create: `backend/src/authority/projectiles.js`
- Test: `backend/tests/authority_projectiles.test.js`

**Interfaces:**
- Consumes: a `creatures` object with `all()` (list of `{id,x,y,width,height}`) and `damageCreatureById(id,damage)->bool`; a `players` array of `{userId,x,y,width,height,hp}`; a `map` with `isWalkable(x,y)->bool`; a `weapon` with `{damage, range, projectile_speed, projectile_radius, pierce, element}`.
- Produces: `class ProjectileSim` with `spawn({ownerId,x,y,nx,ny,weapon}) -> id`, `step(dt, {creatures, players, map}) -> {killedCreatureIds: string[]}`, `snapshot() -> [{id,x,y,element}]`, `count() -> number`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/authority_projectiles.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { ProjectileSim } = require('../src/authority/projectiles.js');

const WALK_ALL = { isWalkable: () => true };
const BOW = { damage: 12, range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1, element: null };

// Minimal creatures stub backed by a plain array.
function creaturesStub(list) {
  const byId = new Map(list.map((c) => [c.id, c]));
  return {
    all: () => [...byId.values()],
    damageCreatureById(id, dmg) {
      const c = byId.get(id);
      if (!c) return false;
      c.hp -= dmg;
      if (c.hp <= 0) { byId.delete(id); return true; }
      return false;
    },
    _byId: byId,
  };
}

test('spawn sets velocity from aim*speed and remaining=range', () => {
  const sim = new ProjectileSim();
  const id = sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: BOW });
  assert.equal(typeof id, 'string');
  const p = sim.snapshot()[0];
  assert.equal(p.id, id);
  assert.equal(sim.count(), 1);
});

test('step advances position and decrements range, despawns at range end', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, range: 100, projectile_speed: 1000 } });
  // dt=0.05 → 50px/step. After 2 steps traveled 100 → remaining 0 → despawn.
  sim.step(0.05, { creatures: creaturesStub([]), players: [], map: WALK_ALL });
  assert.equal(sim.count(), 1);
  sim.step(0.05, { creatures: creaturesStub([]), players: [], map: WALK_ALL });
  assert.equal(sim.count(), 0);
});

test('step despawns a projectile on an unwalkable tile', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: BOW });
  sim.step(0.05, { creatures: creaturesStub([]), players: [], map: { isWalkable: () => false } });
  assert.equal(sim.count(), 0);
});

test('step hits a creature in range: damages it, returns killed id, despawns (pierce 1)', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, damage: 100 } });
  const creatures = creaturesStub([{ id: 'c1', x: 30, y: -24, width: 48, height: 48, hp: 10 }]); // center 54,0
  const out = sim.step(0.1, { creatures, players: [], map: WALK_ALL }); // moves to x=90 → passes center 54
  assert.deepEqual(out.killedCreatureIds, ['c1']);
  assert.equal(sim.count(), 0);
});

test('step hits a player (not the owner), reduces hp', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, damage: 20 } });
  const target = { userId: 'u2', x: 62, y: -32, width: 64, height: 64, hp: 100 }; // center 94,0
  const owner = { userId: 'u1', x: -100, y: -32, width: 64, height: 64, hp: 100 };
  sim.step(0.12, { creatures: creaturesStub([]), players: [owner, target], map: WALK_ALL }); // x→108 passes 94
  assert.equal(target.hp, 80);
  assert.equal(owner.hp, 100); // owner never hit
});

test('pierce: a pierce-2 projectile hits two creatures before despawning', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, damage: 100, pierce: 2, range: 1000, projectile_speed: 2000 } });
  const creatures = creaturesStub([
    { id: 'c1', x: 20, y: -24, width: 48, height: 48, hp: 10 },  // center 44,0
    { id: 'c2', x: 60, y: -24, width: 48, height: 48, hp: 10 },  // center 84,0
  ]);
  const out = sim.step(0.05, { creatures, players: [], map: WALK_ALL }); // x→100, passes both
  assert.deepEqual(out.killedCreatureIds.sort(), ['c1', 'c2']);
});

test('a projectile never hits the same target twice', () => {
  const sim = new ProjectileSim();
  sim.spawn({ ownerId: 'u1', x: 0, y: 0, nx: 1, ny: 0, weapon: { ...BOW, damage: 1, pierce: 5, range: 1000, projectile_speed: 200 } });
  const target = { userId: 'u2', x: 20, y: -32, width: 64, height: 64, hp: 100 }; // center 52,0
  // Multiple steps keep the projectile near the target; hp drops by exactly 1.
  for (let i = 0; i < 3; i++) sim.step(0.02, { creatures: creaturesStub([]), players: [target], map: WALK_ALL });
  assert.equal(target.hp, 99);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && node --test tests/authority_projectiles.test.js`
Expected: FAIL — `Cannot find module '../src/authority/projectiles.js'`.

- [ ] **Step 3: Implement `projectiles.js`**

Create `backend/src/authority/projectiles.js`:

```js
// Server-simulated projectiles (arrows, magic bolts, …). Transient in-memory
// only — never persisted, no randomness. Collides with terrain, creatures, and
// players (never the owner). Ranged and magic share this one path; they differ
// only by weapon data.

function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }

class ProjectileSim {
  constructor() {
    this.projectiles = [];
    this._id = 0;
  }

  spawn({ ownerId, x, y, nx, ny, weapon }) {
    const id = String(++this._id);
    this.projectiles.push({
      id,
      ownerId,
      x, y,
      vx: nx * weapon.projectile_speed,
      vy: ny * weapon.projectile_speed,
      remaining: weapon.range,
      damage: weapon.damage,
      radius: weapon.projectile_radius,
      pierceLeft: weapon.pierce,
      element: weapon.element ?? null,
      hitIds: new Set(), // 'c:<id>' / 'p:<id>' already hit by this projectile
    });
    return id;
  }

  // Advance every projectile one tick; resolve terrain, creature, and player
  // collisions. Returns the creature ids killed this step (for the caller to
  // DELETE).
  //
  // Movement is SUB-STEPPED in <=MAX_SUB px increments so a fast projectile
  // cannot tunnel through a target within a single tick: a bow (900 px/s) moves
  // ~45 px per 20 Hz tick, larger than a creature's ~32 px capture radius, so a
  // single end-of-tick position check would miss. `pierceLeft` starts at the
  // weapon's `pierce` (targets it can hit); it despawns once that reaches 0.
  step(dt, { creatures, players, map }) {
    const killedCreatureIds = [];
    const survivors = [];
    const MAX_SUB = 16; // px; must be < the smallest capture radius (radius+targetHalf)
    for (const p of this.projectiles) {
      const speed = Math.hypot(p.vx, p.vy);
      let dead = speed === 0;
      const ux = speed === 0 ? 0 : p.vx / speed;
      const uy = speed === 0 ? 0 : p.vy / speed;
      let moveLeft = speed * dt;

      while (moveLeft > 0 && !dead) {
        const stepDist = Math.min(MAX_SUB, moveLeft);
        p.x += ux * stepDist; p.y += uy * stepDist;
        p.remaining -= stepDist; moveLeft -= stepDist;

        // Terrain: walls stop projectiles.
        if (!map.isWalkable(p.x, p.y)) { dead = true; break; }

        // Creatures.
        for (const c of creatures.all()) {
          const key = `c:${c.id}`;
          if (p.hitIds.has(key)) continue;
          const half = c.width / 2;
          const cx = c.x + half, cy = c.y + c.height / 2;
          const rr = p.radius + half;
          if (dist2(p.x, p.y, cx, cy) <= rr * rr) {
            p.hitIds.add(key);
            if (creatures.damageCreatureById(c.id, p.damage)) killedCreatureIds.push(c.id);
            p.pierceLeft -= 1;
            if (p.pierceLeft <= 0) { dead = true; break; }
          }
        }
        if (dead) break;

        // Players (never the owner).
        for (const pl of players) {
          if (pl.userId === p.ownerId) continue;
          const key = `p:${pl.userId}`;
          if (p.hitIds.has(key)) continue;
          const half = pl.width / 2;
          const px = pl.x + half, py = pl.y + pl.height / 2;
          const rr = p.radius + half;
          if (dist2(p.x, p.y, px, py) <= rr * rr) {
            p.hitIds.add(key);
            pl.hp -= p.damage;
            p.pierceLeft -= 1;
            if (p.pierceLeft <= 0) { dead = true; break; }
          }
        }
        if (dead) break;

        if (p.remaining <= 0) { dead = true; break; }
      }

      if (!dead) survivors.push(p);
    }
    this.projectiles = survivors;
    return { killedCreatureIds };
  }

  snapshot() {
    return this.projectiles.map((p) => ({ id: p.id, x: p.x, y: p.y, element: p.element }));
  }

  count() { return this.projectiles.length; }
}

module.exports = { ProjectileSim };
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && node --test tests/authority_projectiles.test.js`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/projectiles.js backend/tests/authority_projectiles.test.js
git commit -m "feat(authority): ProjectileSim (terrain/creature/player collision, pierce, range)"
```

---

### Task 5: `World` — weapon dispatch, mana, projectiles, death resolution

**Files:**
- Modify: `backend/src/authority/world.js`
- Test: `backend/tests/authority_world_combat.test.js` (append) — a Slice-3a combat test file exists; reuse its helpers if present.

**Interfaces:**
- Consumes: `weapons.js` (`normalizeAim`, `inArc`); `projectiles.js` (`ProjectileSim`); `creatures.js` (`applyMeleeArc`, `damageCreatureById`).
- Produces: `new World(map, weaponsById, defaultWeaponId)`; `World.attack(userId, ax, ay) -> {killedCreatureIds}`; `World.setWeapon(userId, weaponId)`; `World.tickProjectiles(dt) -> string[]`; `World.resolveDeaths()`; player snapshot adds `mana, maxMana, weaponId`; `snapshot()` adds top-level `projectiles`. Exports add `PLAYER_MAX_MANA`, `PLAYER_MANA_REGEN`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/authority_world_combat.test.js`:

```js
const { World, PLAYER_MAX_MANA } = require('../src/authority/world.js');

// A weapon catalog Map + all-grass map for World combat tests.
function armWorld() {
  const map = {
    chunkSize: 8,
    isWalkable: () => true,
    speedAt: () => 1,
    getChunk: () => [],
  };
  const weapons = new Map([
    [1, { id: 1, name: 'dagger', kind: 'melee', damage: 8, cooldown: 0.3, reach: 80, arc_width: 0.6, mana_cost: 0, element: null }],
    [2, { id: 2, name: 'halberd', kind: 'melee', damage: 18, cooldown: 0.9, reach: 190, arc_width: 1.8, mana_cost: 0, element: null }],
    [3, { id: 3, name: 'bow', kind: 'projectile', damage: 12, cooldown: 0.6, range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1, mana_cost: 0, element: null }],
    [4, { id: 4, name: 'magic-bolt', kind: 'projectile', damage: 14, cooldown: 0.7, range: 600, projectile_speed: 700, projectile_radius: 12, pierce: 1, mana_cost: 15, element: 'arcane' }],
  ]);
  return new World(map, weapons, 1);
}

test('melee attack hits creatures AND other players in the arc', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 });          // center 132,132
  w.addPlayer('u2', { x: 150, y: 100 });          // center 182,132 — east, within halberd reach
  w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 150, y: 108, hp: 10, facing: 'S', color: '#f00' }]);
  w.setWeapon('u1', 2);                            // halberd (reach 190, wide), damage 18
  const { killedCreatureIds } = w.attack('u1', 1, 0); // aim east
  assert.deepEqual(killedCreatureIds, ['c1']);     // c1 (hp 10) in-arc, killed by 18 dmg
  assert.equal(w.getPlayer('u2').hp, w.getPlayer('u2').maxHp - 18); // u2 in-arc, took melee damage
});

test('projectile attack spawns a projectile and deducts mana', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 });
  w.setWeapon('u1', 4);                            // magic-bolt, cost 15
  const before = w.getPlayer('u1').mana;
  w.attack('u1', 1, 0);
  assert.equal(w.snapshot().projectiles.length, 1);
  assert.equal(w.getPlayer('u1').mana, before - 15);
});

test('projectile attack with insufficient mana is denied, no cooldown consumed', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 });
  const p = w.getPlayer('u1');
  p.mana = 5; p.weaponId = 4;                      // below cost 15
  const out = w.attack('u1', 1, 0);
  assert.equal(w.snapshot().projectiles.length, 0);
  assert.equal(p.mana, 5);
  assert.equal(p._attackCd, 0);                    // not on cooldown → retryable
  assert.deepEqual(out.killedCreatureIds, []);
});

test('mana regenerates in tick up to max', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 });
  const p = w.getPlayer('u1');
  p.mana = 50;
  w.tick(1.0);                                     // +PLAYER_MANA_REGEN
  assert.ok(p.mana > 50 && p.mana <= PLAYER_MAX_MANA);
  p.mana = PLAYER_MAX_MANA;
  w.tick(1.0);
  assert.equal(p.mana, PLAYER_MAX_MANA);           // no overflow
});

test('resolveDeaths respawns a player at spawn with full hp+mana', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 500, y: 500 });
  const p = w.getPlayer('u1');
  p.x = 999; p.y = 999; p.hp = 0; p.mana = 0;
  w.resolveDeaths();
  assert.equal(p.hp, p.maxHp);
  assert.equal(p.mana, p.maxMana);
  assert.equal(p.x, 500); assert.equal(p.y, 500);
});

test('tickProjectiles returns killed creature ids', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 });
  // Player at (0,0) → center (32,32); a bow projectile spawns there and flies
  // east at y=32, so place the creature ON that line (center y=32).
  w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 40, y: 8, hp: 1, facing: 'S', color: '#f00' }]); // center 64,32
  w.setWeapon('u1', 3);                            // bow
  w.attack('u1', 1, 0);                            // aim east from center (32,32)
  // Advance until the fast projectile reaches the creature.
  let killed = [];
  for (let i = 0; i < 20 && killed.length === 0; i++) killed = w.tickProjectiles(0.02);
  assert.deepEqual(killed, ['c1']);
});

test('snapshot includes mana/maxMana/weaponId per player and a projectiles array', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 });
  const snap = w.snapshot();
  const pl = snap.players[0];
  assert.equal(pl.mana, PLAYER_MAX_MANA);
  assert.equal(pl.maxMana, PLAYER_MAX_MANA);
  assert.equal(pl.weaponId, 1);                    // default (dagger)
  assert.ok(Array.isArray(snap.projectiles));
});

test('setWeapon ignores an unknown id', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 });
  w.setWeapon('u1', 999);
  assert.equal(w.getPlayer('u1').weaponId, 1);     // unchanged
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && node --test tests/authority_world_combat.test.js`
Expected: FAIL — `World` constructor ignores the weapon args / `attack` arity + `setWeapon`/`tickProjectiles`/`resolveDeaths` missing / snapshot lacks mana.

- [ ] **Step 3: Edit `world.js`**

Apply these changes to `backend/src/authority/world.js`:

Add requires + constants at the top (after the existing requires and `PLAYER_*` block):

```js
const { normalizeAim, inArc } = require('./weapons');
const { ProjectileSim } = require('./projectiles');
```
```js
const PLAYER_MAX_MANA = 100;
const PLAYER_MANA_REGEN = 10; // per second
```

Constructor — accept the catalog and own a `ProjectileSim`:

```js
  constructor(map, weaponsById = new Map(), defaultWeaponId = null) {
    this.map = map;
    this.players = new Map();
    this.creatures = new CreatureSim(map);
    this.weapons = weaponsById;
    this.defaultWeaponId = defaultWeaponId;
    this.projectiles = new ProjectileSim();
  }
```

`addPlayer` — add mana + weapon fields:

```js
      hp: PLAYER_MAX_HP,
      maxHp: PLAYER_MAX_HP,
      mana: PLAYER_MAX_MANA,
      maxMana: PLAYER_MAX_MANA,
      weaponId: this.defaultWeaponId,
      spawn: { x: spawn.x, y: spawn.y },
      _attackCd: 0,
```

`tick(dt)` — regenerate mana alongside the cooldown decay (inside the players loop, before or after the existing body):

```js
      if (p._attackCd > 0) p._attackCd = Math.max(0, p._attackCd - dt);
      if (p.mana < p.maxMana) p.mana = Math.min(p.maxMana, p.mana + PLAYER_MANA_REGEN * dt);
```

`tickCreatures(dt, activeKeys)` — remove the respawn loop (respawn now lives in `resolveDeaths`); it becomes just:

```js
  tickCreatures(dt, activeKeys) {
    this.creatures.tick(dt, activeKeys, [...this.players.values()]);
  }
```

Add `setWeapon`, replace `attack`, add `tickProjectiles` + `resolveDeaths`:

```js
  setWeapon(userId, weaponId) {
    const p = this.players.get(userId);
    if (p && this.weapons.has(weaponId)) p.weaponId = weaponId;
  }

  // Attack in the aim direction with the equipped weapon. Melee resolves an arc
  // hit against creatures + other players; projectile spawns a mana-gated
  // projectile. Returns killed creature ids for the caller to DELETE.
  attack(userId, ax, ay) {
    const p = this.players.get(userId);
    if (!p || p._attackCd > 0) return { killedCreatureIds: [] };
    const w = this.weapons.get(p.weaponId) || this.weapons.get(this.defaultWeaponId);
    if (!w) return { killedCreatureIds: [] };

    const { nx, ny } = normalizeAim(ax, ay, p.facing);
    const f = facingFromInput(sign(nx), sign(ny));
    if (f) p.facing = f;
    const cx = p.x + p.width / 2, cy = p.y + p.height / 2;

    if (w.kind === 'melee') {
      const killed = this.creatures.applyMeleeArc(cx, cy, nx, ny, w.reach, w.arc_width, w.damage);
      for (const other of this.players.values()) {
        if (other.userId === userId) continue;
        const ocx = other.x + other.width / 2, ocy = other.y + other.height / 2;
        if (inArc(cx, cy, nx, ny, ocx, ocy, w.reach, w.arc_width)) other.hp -= w.damage;
      }
      p._attackCd = w.cooldown;
      return { killedCreatureIds: killed };
    }

    // projectile
    if (p.mana < w.mana_cost) return { killedCreatureIds: [] }; // denied, no cooldown
    p.mana -= w.mana_cost;
    this.projectiles.spawn({ ownerId: userId, x: cx, y: cy, nx, ny, weapon: w });
    p._attackCd = w.cooldown;
    return { killedCreatureIds: [] };
  }

  tickProjectiles(dt) {
    return this.projectiles.step(dt, {
      creatures: this.creatures,
      players: [...this.players.values()],
      map: this.map,
    }).killedCreatureIds;
  }

  // Respawn any player at <=0 hp (single place, after all damage sources).
  resolveDeaths() {
    for (const p of this.players.values()) {
      if (p.hp <= 0) {
        p.x = p.spawn.x; p.y = p.spawn.y;
        p.hp = p.maxHp; p.mana = p.maxMana;
      }
    }
  }
```

Add a `sign` helper near `clamp` (a coarse sign with a deadzone so a mostly-horizontal aim doesn't register a vertical facing component):

```js
function sign(v) { return v > 0.3 ? 1 : v < -0.3 ? -1 : 0; }
```

`snapshot()` — per player add mana/maxMana/weaponId; add top-level projectiles:

```js
  snapshot() {
    return {
      players: [...this.players.values()].map((p) => ({
        id: p.userId, x: p.x, y: p.y, facing: p.facing,
        hp: p.hp, maxHp: p.maxHp, mana: p.mana, maxMana: p.maxMana, weaponId: p.weaponId,
      })),
      projectiles: this.projectiles.snapshot(),
    };
  }
```

Update `module.exports` to add `PLAYER_MAX_MANA, PLAYER_MANA_REGEN`.

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && node --test tests/authority_world_combat.test.js tests/authority_world.test.js`
Expected: PASS. `authority_world.test.js` (Slice-1/3a) still green — note `snapshot().players[i]` now carries extra fields; if a Slice-3a test used a strict key-list assertion it must be widened for the additive `mana`/`maxMana`/`weaponId` (mirror the Slice-3a precedent where such assertions were widened for `hp`/`maxHp`). Widen (do not weaken) any such assertion; do not remove coverage.

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/world.js backend/tests/authority_world_combat.test.js
git commit -m "feat(authority): weapon dispatch, mana, projectiles, centralized death resolution in World"
```

---

### Task 6: `server.js` wiring (catalog load, tick order, attack aim, equip, projectiles broadcast)

**Files:**
- Modify: `backend/src/authority/server.js`
- Test: `backend/tests/authority_server.test.js` (append) — reuse the file's `boot`/`connect`/`nextMsg` helpers.

**Interfaces:**
- Consumes: `weapons.js` (`loadWeaponTypes`, `resolveDefaultWeaponId`); `World(map, weaponsById, defaultId)`; `World.attack(userId, ax, ay)`, `setWeapon`, `tickProjectiles`, `resolveDeaths`; `snapshot().projectiles`.
- Produces: `state` message gains `projectiles`; `joined` gains `weapons`; new inbound `attack{ax,ay}` + `equip{weaponId}`.

- [ ] **Step 1: Write the failing tests**

The existing `fakePool` in `authority_server.test.js` must answer the new `weapon_types` query. Extend it (in the shared `fakePool`) to return the seeded rows for `/FROM weapon_types/i`:

```js
// add inside fakePool()'s query switch, before the final `return { rows: [] }`:
if (/FROM weapon_types/i.test(sql)) {
  return { rows: [
    { id: 1, name: 'dagger', kind: 'melee', damage: 8, cooldown: 0.3, reach: 80, arc_width: 0.6,
      range: null, projectile_speed: null, projectile_radius: null, pierce: null, mana_cost: 0, element: null },
    { id: 3, name: 'bow', kind: 'projectile', damage: 12, cooldown: 0.05, reach: null, arc_width: null,
      range: 2000, projectile_speed: 4000, projectile_radius: 40, pierce: 1, mana_cost: 0, element: null },
  ] };
}
```

(The bow here is tuned fast/large so the integration test lands a hit within a few ticks.) Then append:

```js
test('equip switches the weapon; a later state reflects weaponId', async () => {
  const { url, handle, server } = await boot();
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  const joined = await nextMsg(ws, 'joined');
  assert.ok(Array.isArray(joined.weapons) && joined.weapons.length >= 1, 'joined lists weapons');
  ws.send(JSON.stringify({ type: 'equip', weaponId: 3 }));
  let got = null;
  for (let i = 0; i < 20 && got == null; i++) {
    const s = await nextMsg(ws, 'state');
    const me = s.players.find((p) => p.id === '1');
    if (me && me.weaponId === 3) got = me;
  }
  assert.ok(got, 'weaponId updates to 3 after equip');
  ws.close(); handle.close(); server.close();
});

test('a projectile attack makes a projectile appear in a later state', async () => {
  const { url, handle, server } = await boot();
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');
  ws.send(JSON.stringify({ type: 'equip', weaponId: 3 })); // bow (fast)
  ws.send(JSON.stringify({ type: 'attack', ax: 1, ay: 0 }));
  let sawProjectile = false;
  for (let i = 0; i < 10 && !sawProjectile; i++) {
    const s = await nextMsg(ws, 'state');
    if (Array.isArray(s.projectiles) && s.projectiles.length > 0) sawProjectile = true;
  }
  assert.ok(sawProjectile, 'state includes an active projectile after a projectile attack');
  ws.close(); handle.close(); server.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && node --test tests/authority_server.test.js`
Expected: FAIL — `joined.weapons` undefined and `state.projectiles` never populated (equip/attack-aim/projectile wiring absent).

- [ ] **Step 3: Wire `server.js`**

Add the require near the top:

```js
const { loadWeaponTypes, resolveDefaultWeaponId } = require('./weapons');
```

In `loadWorld`, after loading `creatureTypes` and before constructing the entry, load the catalog and pass it to `World`:

```js
        const weaponsById = await loadWeaponTypes(pool);
        const defaultWeaponId = resolveDefaultWeaponId(weaponsById);
        const map = new ServerMap({ seed: Number(row.seed), chunkSize: row.chunk_size, tileTypes });
        const entry = {
          worldId, world: new World(map, weaponsById, defaultWeaponId), row, sockets: new Map(),
          tileTypes, creatureTypes,
          activeChunks: new Set(),
          chunkLoads: new Set(),
          loadedChunks: new Set(),
        };
```

In the `join` handler, include the catalog in `joined`:

```js
        send(ws, {
          type: 'joined', user_id: ws.userId, spawn, tickRate: 1000 / tickMs,
          weapons: [...entry.world.weapons.values()].map((w) => ({ id: w.id, name: w.name, kind: w.kind, element: w.element })),
        });
```

Replace the `attack` handler to pass the aim, and add an `equip` handler (next to it):

```js
      if (msg.type === 'attack') {
        const entry = worlds.get(ws.worldId);
        if (entry) {
          const { killedCreatureIds } = entry.world.attack(ws.userId, msg.ax, msg.ay);
          for (const id of new Set(killedCreatureIds)) {
            pool.query('DELETE FROM world_creatures WHERE id = $1', [id]).catch(() => {});
          }
        }
        return;
      }

      if (msg.type === 'equip') {
        const entry = worlds.get(ws.worldId);
        if (entry) entry.world.setWeapon(ws.userId, msg.weaponId);
        return;
      }
```

In the tick loop, after `tickCreatures`, advance projectiles, delete kills, resolve deaths, and include projectiles in the broadcast. Replace the current body inside `for (const entry of worlds.values())`:

```js
      if (entry.world.isEmpty()) continue;
      entry.world.tick(dt);
      entry.world.tickCreatures(dt, entry.activeChunks);
      const killedByProjectiles = entry.world.tickProjectiles(dt);
      for (const id of new Set(killedByProjectiles)) {
        pool.query('DELETE FROM world_creatures WHERE id = $1', [id]).catch(() => {});
      }
      entry.world.resolveDeaths();
      const snap = entry.world.snapshot();
      for (const [userId, ws] of entry.sockets) {
        const p = entry.world.getPlayer(userId);
        send(ws, { type: 'state', tick, ackSeq: p ? p.ackSeq : 0, players: snap.players, projectiles: snap.projectiles });
      }
      if (tick % creatureBroadcastEvery === 0) {
        recomputeActive(entry);
        broadcastCreatures(entry);
      }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && node --test tests/authority_server.test.js`
Expected: PASS (all existing + 2 new). Then the full authority suite: `cd backend && node --test tests/authority_*.test.js` — all green (widen any additive-field assertions per Task 5).

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/server.js backend/tests/authority_server.test.js
git commit -m "feat(authority): wire weapon catalog, aim, equip, projectile tick + broadcast"
```

---

### Task 7: Client `WorldAuthorityClient` — aimed attack + equip + state fields

**Files:**
- Modify: `frontend/src/games/something2/src/js/net/WorldAuthorityClient.js`
- Test: `frontend/src/games/something2/src/js/net/__tests__/WorldAuthorityClient.test.js` (append; create if absent, mirroring existing net tests that stub `WebSocket`)

**Interfaces:**
- Produces: `sendAttack(ax, ay)` → `{type:'attack', ax, ay}`; `sendEquip(weaponId)` → `{type:'equip', weaponId}`. `onState` continues to receive the full `state` (now with `projectiles`/`mana`/`weaponId`) — no dispatch change needed.

- [ ] **Step 1: Write the failing tests**

Append (or create) `frontend/src/games/something2/src/js/net/__tests__/WorldAuthorityClient.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorldAuthorityClient } from '../WorldAuthorityClient.js';

// Minimal fake WebSocket capturing sent frames.
class FakeWS {
  constructor() { this.sent = []; this.readyState = 1; FakeWS.last = this; this._l = {}; }
  addEventListener(t, cb) { this._l[t] = cb; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() {}
}
FakeWS.OPEN = 1;

beforeEach(() => { global.WebSocket = FakeWS; FakeWS.last = null; });

function armClient() {
  const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't' });
  c.connect('w1');
  FakeWS.last._l.open();     // marks connected, sends join
  return c;
}

it('sendAttack sends an aim vector', () => {
  const c = armClient();
  c.sendAttack(0.6, -0.8);
  const f = FakeWS.last.sent.find((m) => m.type === 'attack');
  expect(f).toEqual({ type: 'attack', ax: 0.6, ay: -0.8 });
});

it('sendEquip sends the weaponId', () => {
  const c = armClient();
  c.sendEquip(3);
  const f = FakeWS.last.sent.find((m) => m.type === 'equip');
  expect(f).toEqual({ type: 'equip', weaponId: 3 });
});

it('onState receives projectiles from a state frame', () => {
  const states = [];
  const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't', onState: (m) => states.push(m) });
  c.connect('w1');
  FakeWS.last._l.open();
  FakeWS.last._l.message({ data: JSON.stringify({ type: 'state', players: [], projectiles: [{ id: '1', x: 1, y: 2, element: 'arcane' }] }) });
  expect(states[0].projectiles).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/games/something2/src/js/net/__tests__/WorldAuthorityClient.test.js`
Expected: FAIL — `sendAttack` sends no `ax`/`ay` (current signature is arg-less); `sendEquip` undefined.

- [ ] **Step 3: Edit `WorldAuthorityClient.js`**

Replace `sendAttack()` and add `sendEquip`:

```js
  sendAttack(ax, ay) { this._send({ type: 'attack', ax, ay }); }

  sendEquip(weaponId) { this._send({ type: 'equip', weaponId }); }
```

(No change to the `message` switch — `state` already flows through `onState` with its full payload.)

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/games/something2/src/js/net/__tests__/WorldAuthorityClient.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/net/WorldAuthorityClient.js frontend/src/games/something2/src/js/net/__tests__/WorldAuthorityClient.test.js
git commit -m "feat(client): aimed attack + equip on WorldAuthorityClient"
```

---

### Task 8: Client aim util (`core/aim.js`) — cursor → world aim vector

**Files:**
- Create: `frontend/src/games/something2/src/js/core/aim.js`
- Test: `frontend/src/games/something2/src/js/core/__tests__/aim.test.js`

**Interfaces:**
- Consumes: `screenToWorld` from `core/iso.js`; `GAME_WIDTH`, `GAME_HEIGHT` from `core/constants.js`; the camera's `screenX`/`screenY`.
- Produces: `cursorToWorld(canvasX, canvasY, camera) -> {x, y}`; `aimVector(canvasX, canvasY, camera, pcx, pcy) -> {nx, ny}` (unit vector from player center to cursor in world space; `{nx:0,ny:0}` if the cursor is exactly on the center).

Rationale: `Camera.apply` translates the context by `(GAME_WIDTH/2 - screenX, GAME_HEIGHT/2 - screenY)`, so a canvas pixel `(cx,cy)` is at iso-screen `(cx - GAME_WIDTH/2 + camera.screenX, cy - GAME_HEIGHT/2 + camera.screenY)`, which `screenToWorld` inverts to world coords. Aim is the normalized world-space delta from the player center to that world point.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/games/something2/src/js/core/__tests__/aim.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { cursorToWorld, aimVector } from '../aim.js';
import { worldToScreen } from '../iso.js';
import { GAME_WIDTH, GAME_HEIGHT } from '../constants.js';

// Build a camera centered on a known world point, and the canvas pixel that a
// second world point projects to, then assert the inverse recovers it.
function cameraAt(wx, wy) {
  const s = worldToScreen(wx, wy);
  return { screenX: s.x, screenY: s.y, width: GAME_WIDTH, height: GAME_HEIGHT };
}
function canvasPixelOf(wx, wy, camera) {
  const s = worldToScreen(wx, wy);
  return { cx: s.x - camera.screenX + GAME_WIDTH / 2, cy: s.y - camera.screenY + GAME_HEIGHT / 2 };
}

it('cursorToWorld inverts the camera + iso projection', () => {
  const camera = cameraAt(1000, 1000);
  const target = { x: 1300, y: 900 };
  const { cx, cy } = canvasPixelOf(target.x, target.y, camera);
  const w = cursorToWorld(cx, cy, camera);
  expect(w.x).toBeCloseTo(target.x, 3);
  expect(w.y).toBeCloseTo(target.y, 3);
});

it('aimVector returns a unit vector pointing from player center to cursor', () => {
  const camera = cameraAt(1000, 1000);
  const pcx = 1000, pcy = 1000;
  const target = { x: 1200, y: 1000 }; // due +x in world space
  const { cx, cy } = canvasPixelOf(target.x, target.y, camera);
  const { nx, ny } = aimVector(cx, cy, camera, pcx, pcy);
  expect(Math.hypot(nx, ny)).toBeCloseTo(1, 6);
  expect(nx).toBeCloseTo(1, 6);
  expect(ny).toBeCloseTo(0, 6);
});

it('aimVector returns {0,0} when the cursor is on the player center', () => {
  const camera = cameraAt(1000, 1000);
  const { cx, cy } = canvasPixelOf(1000, 1000, camera);
  expect(aimVector(cx, cy, camera, 1000, 1000)).toEqual({ nx: 0, ny: 0 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/aim.test.js`
Expected: FAIL — `Cannot find module '../aim.js'`.

- [ ] **Step 3: Implement `core/aim.js`**

Create `frontend/src/games/something2/src/js/core/aim.js`:

```js
import { screenToWorld } from "./iso.js";
import { GAME_WIDTH, GAME_HEIGHT } from "./constants.js";

// Convert a canvas pixel (0..GAME_WIDTH, 0..GAME_HEIGHT) to a world position,
// inverting Camera.apply's translation and the iso projection.
export function cursorToWorld(canvasX, canvasY, camera) {
  const sx = canvasX - GAME_WIDTH / 2 + camera.screenX;
  const sy = canvasY - GAME_HEIGHT / 2 + camera.screenY;
  return screenToWorld(sx, sy);
}

// Unit aim vector in world space from the player center (pcx,pcy) to the cursor.
// Returns {nx:0, ny:0} when the cursor is exactly on the center.
export function aimVector(canvasX, canvasY, camera, pcx, pcy) {
  const w = cursorToWorld(canvasX, canvasY, camera);
  const dx = w.x - pcx, dy = w.y - pcy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { nx: 0, ny: 0 };
  return { nx: dx / len, ny: dy / len };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/aim.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/core/aim.js frontend/src/games/something2/src/js/core/__tests__/aim.test.js
git commit -m "feat(client): cursor→world aim vector util"
```

---

### Task 9: Client `ProjectileManager` (render store)

**Files:**
- Create: `frontend/src/games/something2/src/js/entities/ProjectileManager.js`
- Test: `frontend/src/games/something2/src/js/entities/__tests__/ProjectileManager.test.js`

**Interfaces:**
- Produces: `class ProjectileManager` with `applySnapshot(list)` (upsert by id, drop absent, store `prevX/prevY` for interpolation), `interpolate(dt)` (advance render position toward the latest snapshot), `all() -> [{id,x,y,element}]`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/games/something2/src/js/entities/__tests__/ProjectileManager.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { ProjectileManager } from '../ProjectileManager.js';

it('applySnapshot adds, updates, and drops projectiles by id', () => {
  const m = new ProjectileManager();
  m.applySnapshot([{ id: '1', x: 0, y: 0, element: null }, { id: '2', x: 5, y: 5, element: 'arcane' }]);
  expect(m.all().map((p) => p.id).sort()).toEqual(['1', '2']);
  m.applySnapshot([{ id: '2', x: 9, y: 9, element: 'arcane' }]); // 1 gone, 2 moved
  const ids = m.all().map((p) => p.id);
  expect(ids).toEqual(['2']);
});

it('interpolate moves the render position toward the latest target', () => {
  const m = new ProjectileManager();
  m.applySnapshot([{ id: '1', x: 0, y: 0, element: null }]);
  m.applySnapshot([{ id: '1', x: 100, y: 0, element: null }]); // new target
  m.interpolate(1); // advance
  const p = m.all()[0];
  expect(p.x).toBeGreaterThan(0);
  expect(p.x).toBeLessThanOrEqual(100);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/games/something2/src/js/entities/__tests__/ProjectileManager.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ProjectileManager.js`**

Create `frontend/src/games/something2/src/js/entities/ProjectileManager.js` (mirrors `CreatureManager`'s reconcile+interpolate shape):

```js
// Render-only store for server projectiles. The server owns motion/collision;
// this smooths the ~20Hz snapshots between frames.
const LERP = 12; // higher = snappier follow

export class ProjectileManager {
  constructor() { this.projectiles = new Map(); } // id -> {id,x,y,tx,ty,element}

  applySnapshot(list) {
    const seen = new Set();
    for (const s of list || []) {
      seen.add(s.id);
      const p = this.projectiles.get(s.id);
      if (p) { p.tx = s.x; p.ty = s.y; p.element = s.element; }
      else this.projectiles.set(s.id, { id: s.id, x: s.x, y: s.y, tx: s.x, ty: s.y, element: s.element });
    }
    for (const id of this.projectiles.keys()) if (!seen.has(id)) this.projectiles.delete(id);
  }

  interpolate(dt) {
    const a = Math.min(1, LERP * dt);
    for (const p of this.projectiles.values()) {
      p.x += (p.tx - p.x) * a;
      p.y += (p.ty - p.y) * a;
    }
  }

  all() { return [...this.projectiles.values()].map((p) => ({ id: p.id, x: p.x, y: p.y, element: p.element })); }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/games/something2/src/js/entities/__tests__/ProjectileManager.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/entities/ProjectileManager.js frontend/src/games/something2/src/js/entities/__tests__/ProjectileManager.test.js
git commit -m "feat(client): ProjectileManager render store"
```

---

### Task 10: Wire the client — mouse aim, click attack, weapon switch, projectile + HUD render

**Files:**
- Modify: `frontend/src/games/something2/src/js/core/Game.js`
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js`

**Interfaces:**
- Consumes: `aimVector` (Task 8), `ProjectileManager` (Task 9), `WorldAuthorityClient.sendAttack/sendEquip` (Task 7), `state.projectiles`/`mana`/`weaponId` (Task 6), `joined.weapons` (Task 6).

No unit tests (DOM + canvas render layer, consistent with the project's untested render policy). Verified by `npm run build` (frontend) + the live browser check in Step 7.

- [ ] **Step 1: Store the weapon catalog + projectiles + mana on join/state**

In `Game.js` `initChunked`, construct a `ProjectileManager` alongside `this.creatures`:

```js
this.projectiles = new ProjectileManager();
```
Import it at the top: `import { ProjectileManager } from "../entities/ProjectileManager.js";`
Import the aim util: `import { aimVector } from "./aim.js";`

In the `WorldAuthorityClient` options, capture the catalog from `joined` and default weapon:

```js
onJoined: (msg) => {
  this.weaponCatalog = msg.weapons || [];   // [{id,name,kind,element}]
  this._onJoined(msg);                       // existing joined handling (spawn etc.)
},
```
(If there is no existing `_onJoined`, fold the catalog capture into the current inline `onJoined` body, keeping the existing spawn/joined logic intact.)

In `_onWorldState(msg)`, store local mana/weapon and the projectile snapshot:

```js
// after existing remote/local player handling:
const me = msg.players.find((p) => p.id === this.localUserId);
if (me) { this.localMana = me.mana; this.localMaxMana = me.maxMana; this.localWeaponId = me.weaponId; }
if (this.projectiles) this.projectiles.applySnapshot(msg.projectiles || []);
```

In the chunked update loop (where `this.creatures.interpolate(dt)` runs), add:

```js
if (this.projectiles) this.projectiles.interpolate(dt);
```

- [ ] **Step 2: Replace the spacebar attack with mouse aim + left-click**

In the `_keydownHandler`, remove the spacebar attack block (Slice-3a):

```js
// DELETE this block:
// if (key === ' ' && this.state === 'playing' && this.chunked && this.authorityClient && !e.repeat) { ... sendAttack(); }
```

Add mouse handlers (register them where the keydown/keyup handlers are added, and remove them in `destroy` alongside the others). Track the latest cursor canvas-pixel position; on left mousedown, compute the aim and send it:

```js
this._mouseMoveHandler = (e) => {
  const rect = this.canvas.getBoundingClientRect();
  this._cursorX = (e.clientX - rect.left) * (this.canvas.width / rect.width);
  this._cursorY = (e.clientY - rect.top) * (this.canvas.height / rect.height);
};
this._mouseDownHandler = (e) => {
  if (e.button !== 0) return;
  if (this.state !== 'playing' || !this.chunked || !this.authorityClient) return;
  const pcx = this.player.x + this.player.width / 2;
  const pcy = this.player.y + this.player.height / 2;
  const { nx, ny } = aimVector(this._cursorX ?? this.canvas.width / 2, this._cursorY ?? this.canvas.height / 2, this.camera, pcx, pcy);
  this.authorityClient.sendAttack(nx, ny);
};
this.canvas.addEventListener('mousemove', this._mouseMoveHandler);
this.canvas.addEventListener('mousedown', this._mouseDownHandler);
```

In `destroy`/teardown, remove them:

```js
if (this._mouseMoveHandler) this.canvas.removeEventListener('mousemove', this._mouseMoveHandler);
if (this._mouseDownHandler) this.canvas.removeEventListener('mousedown', this._mouseDownHandler);
```

- [ ] **Step 3: Weapon switch on number keys 1–4**

In the `_keydownHandler`, when playing+chunked, map digit keys to `weaponCatalog` entries and equip:

```js
if (this.state === 'playing' && this.chunked && this.authorityClient && this.weaponCatalog && /^[1-9]$/.test(key)) {
  const w = this.weaponCatalog[Number(key) - 1];
  if (w) this.authorityClient.sendEquip(w.id);
}
```

- [ ] **Step 4: Render projectiles + mana bar + weapon name (`RenderSystem.js`)**

In `renderChunked`, after drawing creatures, draw projectiles depth-sorted (or simply on top — projectiles are small and fast; on-top is acceptable). Add a `projectiles = []` param to `renderChunked` and pass `this.projectiles.all()` from `Game`'s render call. For each projectile, project to screen and draw a small tinted circle:

```js
// inside renderChunked, after creature draw loop; `projectiles` is the new param
for (const pr of projectiles) {
  const s = worldToScreen(pr.x, pr.y);
  this.ctx.beginPath();
  this.ctx.arc(s.x, s.y - ISO_TILE_H / 2, 6, 0, Math.PI * 2);
  this.ctx.fillStyle = pr.element === 'arcane' ? '#9b5de5' : '#f4d35e';
  this.ctx.fill();
}
```

Update `Game`'s render call site:

```js
this.renderSystem.renderChunked(this.player, this.camera, this.chunkedMap, this.remotePlayers, this.localUserId, this.creatures.all(), this.projectiles ? this.projectiles.all() : []);
```
And the `renderChunked` signature: `renderChunked(player, camera, chunkedMap, remotePlayers, localUserId, creatures = [], projectiles = [])`.

In the HUD (where the HP line is drawn), add a mana bar/line and the current weapon name below it, reading `game.localMana`/`localMaxMana` and resolving the weapon name from `weaponCatalog.find(w => w.id === localWeaponId)`. Keep it minimal and consistent with the existing HUD style. (HUD is drawn from `Game` or `RenderSystem` — follow the existing HP-line pattern; if the HP HUD lives in `Game`, add the mana line there and pass `weaponCatalog`/`localWeaponId` through.)

- [ ] **Step 5: Build the frontend**

Run: `cd frontend && npm run build`
Expected: build succeeds (no import/type errors). Fix any until green.

- [ ] **Step 6: Run the full frontend test suite (regression)**

Run: `cd frontend && npx vitest run`
Expected: PASS — new util/manager/client tests green; no existing tests broken.

- [ ] **Step 7: Live browser verification (manual)**

With the stack running (`docker-compose up` or the usual dev servers) and two browser tabs logged in to the same world:
- Mouse-aim + left-click with the **dagger** (default): a nearby creature takes damage / dies; the swing faces the cursor.
- Press **2** (halberd): a wider, longer sweep hits multiple creatures.
- Press **3** (bow): left-click spawns a projectile that travels to the cursor and damages the first creature/player it reaches; it stops at walls.
- Press **4** (magic-bolt): the mana bar drops on each shot; when mana is too low the shot doesn't fire and regenerates over time; projectile is tinted.
- **PvP:** in tab A, aim at tab B's player and attack (melee in range, or a projectile) — B's HP drops; on death B respawns at spawn with full HP+mana. A projectile never damages its owner.
- Console clean; two-tab state consistent.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/games/something2/src/js/core/Game.js frontend/src/games/something2/src/js/systems/RenderSystem.js
git commit -m "feat(client): mouse aim + click attack, weapon switch, projectile + mana HUD render"
```

---

## Self-Review

**Spec coverage:**
- `weapon_types` catalog + 4 seeded weapons → Task 2 (migration + seed table matches the spec values). ✓
- Two resolution paths: melee reach+arc (Tasks 1,3,5), projectiles (Task 4,5). ✓
- Mouse 360° aim + left-click → Tasks 8,10; server normalizes aim → Task 1,5. ✓
- PvP (creatures ∪ other players; owner-excluded projectiles) → Task 4 (owner exclusion), Task 5 (melee hits other players). ✓
- Minimal mana (pool+regen+cost, gated magic) → Task 5 (regen, cost, denial without cooldown). ✓
- Number-key weapon switch stand-in → Task 6 (`equip` + `joined.weapons`), Task 10 (keys). ✓
- Protocol: `attack{ax,ay}`, `equip`, `state`+`projectiles`/`mana`/`weaponId`, `joined.weapons` → Tasks 6,7. ✓
- Projectile sim: terrain/creature/player collision, pierce, range, snapshot → Task 4. ✓
- Centralized death resolution (respawn out of `tickCreatures`) → Task 5. ✓
- Client render: projectiles + mana bar + weapon name → Task 10 (browser-verified). ✓
- Reuse `ServerMap`/`screenToWorld`; creature removal via `damageCreatureById`/`applyMeleeArc` → Tasks 3,4,8. ✓

**Placeholder scan:** No TBD/TODO. Every code step shows complete code. Task 10 is intentionally build+browser-verified (render layer) per the project's untested-render policy — its steps still show the exact code to add, not vague directions.

**Type consistency:** `attack(userId, ax, ay)` arity consistent across Tasks 5,6 and the client `sendAttack(ax,ay)` (Task 7). Weapon fields (`arc_width`, `projectile_speed`, `projectile_radius`, `mana_cost`, `pierce`) named identically in the migration (Task 2), loader (Task 2), `ProjectileSim` (Task 4), and `World.attack` (Task 5). `killedCreatureIds` returned by `attack`/`tickProjectiles` and consumed by the server DELETE loop (Task 6). `resolveDefaultWeaponId` produced in Task 2, consumed in Task 6. `weaponCatalog` from `joined.weapons` (Task 6) consumed in Task 10. `renderChunked` gains a trailing `projectiles` param consistently at the call site and signature (Task 10).
