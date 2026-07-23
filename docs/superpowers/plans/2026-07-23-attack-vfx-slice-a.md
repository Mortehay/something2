# Attack VFX — Slice A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a melee swing visible — a halberd swing draws a wide sweeping arc on the ground plane, a dagger swing a narrow one, driven end-to-end by a database-defined effect.

**Architecture:** A new `vfx_effects` table holds effect definitions by name; `item_types.vfx` (jsonb) binds a weapon to an effect name per moment. The server resolves the name inside `world.attack()`, stashes an attack descriptor on the world entry, and rides it out on the next `state` frame as `frame.attacks` — the same stash-and-broadcast pattern `pendingDetonations` already uses. The client keeps a short-lived effect list in a pure, canvas-free `core/vfx.js` module (mirroring `core/blasts.js`) and `RenderSystem.drawVfx()` draws it immediately after the blast rings.

**Tech Stack:** Node 20 + Express + raw `pg` + `node-pg-migrate` (backend); `node:test` + `supertest` (backend tests); React 19 + Vite (frontend); Vitest in the **`node`** environment (frontend tests — no DOM, no `localStorage`, no `performance` guarantees).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-23-attack-vfx-design.md`. This plan implements **slice A only** (Plane SOMET-158).
- **Melee only.** Projectile weapons emit no attack descriptor in this slice. Do not touch `projectiles.js`.
- **Geometry columns only.** The `particle_*` columns are slice C. Do not add them.
- **`item_types.vfx` only.** `entity_types.vfx` is slice D. Do not add it.
- **No fallback resolution.** Kind-level defaults are slice B. In this slice an unbound weapon resolves to `null` and the client draws nothing. Leave the seam (`resolveEffectName`) obvious.
- **One shape.** Only `shape = 'arc'` is drawn. The CHECK constraint admits all five names so slice B needs no migration, but `drawVfx` skips anything that is not `arc`.
- **Effect names are resolved server-side.** The client receives a name and looks it up; it must never need the weapon catalog.
- **Pure modules stay canvas-free.** `backend/src/authority/vfx.js` and `frontend/.../core/vfx.js` must not import canvas, DOM, or `pg`.
- **Element palette is untouched.** Element tinting is slice C. Slice A effects use the `color` column verbatim.
- Backend tests: `cd backend && npm test`. Frontend tests: `cd frontend && npm test`.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `backend/migrations/<ts>_vfx_effects.js` | `vfx_effects` table, `item_types.vfx` column, one seeded effect, melee bindings |
| `backend/src/authority/vfx.js` | Pure: resolve an effect name from a weapon row + moment |
| `backend/tests/migration_vfx_effects.test.js` | Migration shape, constraints, seed |
| `backend/tests/authority_vfx.test.js` | Name resolution |
| `backend/tests/vfx_effects_api.test.js` | `GET /api/vfx-effects` |
| `frontend/src/games/something2/src/js/core/vfx.js` | Pure: effect list lifetime, eased progress, iso arc angle |
| `frontend/src/games/something2/src/js/core/__tests__/vfx.test.js` | The above |

**Modified:**

| Path | Change |
|---|---|
| `backend/src/authority/items.js` | `loadItemTypes` selects and maps `vfx` |
| `backend/src/authority/creatures.js` | Extract `meleeArcTargets()`; `applyMeleeArc` iterates it |
| `backend/src/authority/world.js` | `attack()` returns `{ killedCreatureIds, attacks }` |
| `backend/src/authority/server.js` | `pushAttacks()` + `frame.attacks` on the broadcast |
| `backend/src/index.js` | `GET /api/vfx-effects` |
| `frontend/src/games/something2/useMaps.js` | `useVfxEffects()` hook |
| `frontend/src/games/something2/Something2.jsx` | Pass `vfxEffects` into `initChunked` |
| `frontend/src/games/something2/src/js/core/Game.js` | Own the effect list; consume `msg.attacks`; prune; pass to render |
| `frontend/src/games/something2/src/js/systems/RenderSystem.js` | `drawVfx()` arc pass |

---

## Task 1: Migration — `vfx_effects` table and `item_types.vfx`

**Files:**
- Create: `backend/migrations/<timestamp>_vfx_effects.js`
- Test: `backend/tests/migration_vfx_effects.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: table `vfx_effects(id, name, shape, color, width, duration_ms, ease, fade, follows_weapon, created_at)`; column `item_types.vfx jsonb NULL`; seeded row `name = 'sweep_arc'`; every `item_types` row with `kind = 'melee'` bound to `{"attack":"sweep_arc"}`. Exports `SEED_EFFECT` for the test.

**Pick the timestamp first.** Run `ls backend/migrations | tail -1`. Use the next round number above it (at the time of writing the last is `1714440033000_entity_prompts.js`, so `1714440034000`). If another branch has already claimed the number, go higher — a collision between branches has bitten this repo before.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/migration_vfx_effects.test.js`. Change the `require` path to match the timestamp you chose.

```js
const test = require('node:test');
const assert = require('node:assert');

// Records the DDL calls node-pg-migrate would make, so the migration's shape
// is asserted without a live database (same pattern as
// migration_tile_prompts.test.js).
function fakePgm() {
  const calls = { createTable: [], dropTable: [], addColumns: [], dropColumns: [], addConstraint: [], sql: [] };
  return {
    calls,
    createTable: (name, cols, opts) => calls.createTable.push({ name, cols, opts }),
    dropTable: (name) => calls.dropTable.push(name),
    addColumns: (name, cols) => calls.addColumns.push({ name, cols }),
    addColumn: (name, cols) => calls.addColumns.push({ name, cols }),
    dropColumns: (name, cols) => calls.dropColumns.push({ name, cols }),
    addConstraint: (name, cname, expr) => calls.addConstraint.push({ name, cname, expr }),
    sql: (s) => calls.sql.push(s),
    func: (x) => ({ raw: x }),
  };
}

const mig = require('../migrations/1714440034000_vfx_effects.js');

test('up creates vfx_effects with the slice A geometry columns', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const t = pgm.calls.createTable.find((c) => c.name === 'vfx_effects');
  assert.ok(t, 'vfx_effects table not created');
  const c = t.cols;
  assert.equal(c.name.type, 'text');
  assert.equal(c.name.notNull, true);
  assert.equal(c.name.unique, true);
  assert.equal(c.shape.type, 'text');
  assert.equal(c.shape.notNull, true);
  assert.equal(c.color.type, 'text');
  assert.equal(c.width.type, 'real');
  assert.equal(c.duration_ms.type, 'integer');
  assert.equal(c.ease.type, 'text');
  assert.equal(c.ease.default, 'out');
  assert.equal(c.fade.type, 'boolean');
  assert.equal(c.fade.default, true);
  assert.equal(c.follows_weapon.type, 'boolean');
  assert.equal(c.follows_weapon.default, false);
});

test('particle columns are NOT in this migration (they are slice C)', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const c = pgm.calls.createTable.find((t) => t.name === 'vfx_effects').cols;
  for (const k of Object.keys(c)) {
    assert.ok(!k.startsWith('particle_'), `${k} belongs to slice C, not slice A`);
  }
});

test('shape and ease are CHECK-constrained to the full spec vocabulary', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const shape = pgm.calls.addConstraint.find((c) => /shape/.test(c.cname));
  assert.ok(shape, 'no shape CHECK constraint');
  // All five are admitted now so slice B adds shapes without a migration,
  // even though slice A only DRAWS 'arc'.
  for (const s of ['arc', 'line', 'ring', 'burst', 'bolt']) {
    assert.match(shape.expr, new RegExp(`'${s}'`), `shape CHECK omits ${s}`);
  }
  const ease = pgm.calls.addConstraint.find((c) => /ease/.test(c.cname));
  assert.ok(ease, 'no ease CHECK constraint');
  for (const e of ['linear', 'out', 'in']) {
    assert.match(ease.expr, new RegExp(`'${e}'`), `ease CHECK omits ${e}`);
  }
});

test('up adds a nullable jsonb vfx column to item_types only', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const add = pgm.calls.addColumns.find((a) => a.name === 'item_types');
  assert.ok(add, 'item_types.vfx not added');
  assert.equal(add.cols.vfx.type, 'jsonb');
  assert.notEqual(add.cols.vfx.notNull, true, 'vfx must be nullable — an unbound weapon is legal');
  // entity_types.vfx is slice D.
  assert.ok(!pgm.calls.addColumns.some((a) => a.name === 'entity_types'),
    'entity_types.vfx belongs to slice D');
});

test('seeds exactly one effect and binds every melee weapon to it', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  assert.equal(mig.SEED_EFFECT.name, 'sweep_arc');
  assert.equal(mig.SEED_EFFECT.shape, 'arc');
  assert.equal(mig.SEED_EFFECT.follows_weapon, true,
    'the arc must size itself from the weapon reach/arc, or every weapon looks identical');

  const insert = pgm.calls.sql.find((s) => /INSERT INTO vfx_effects/i.test(s));
  assert.ok(insert, 'no seed insert');
  assert.match(insert, /'sweep_arc'/);

  const bind = pgm.calls.sql.find((s) => /UPDATE item_types/i.test(s));
  assert.ok(bind, 'no melee binding');
  assert.match(bind, /"attack"\s*:\s*"sweep_arc"/, 'binding must set the attack moment');
  assert.match(bind, /kind\s*=\s*'melee'/, 'only melee weapons are bound in slice A');
});

test('down reverses both the column and the table', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  assert.deepEqual(pgm.calls.dropColumns, [{ name: 'item_types', cols: ['vfx'] }]);
  assert.deepEqual(pgm.calls.dropTable, ['vfx_effects']);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd backend && node --test tests/migration_vfx_effects.test.js`
Expected: FAIL — `Cannot find module '../migrations/1714440034000_vfx_effects.js'`

- [ ] **Step 3: Write the migration**

Create `backend/migrations/1714440034000_vfx_effects.js`:

```js
exports.shorthands = undefined;

// The single slice A effect. Every melee weapon binds to it; slice B replaces
// these bindings with one authored effect per weapon.
//
// follows_weapon is what makes a halberd (reach 190, arc 1.8 rad) and a knife
// (reach 70, arc 0.5) look different while sharing one row: the renderer takes
// the wedge's radius and angular width from the ATTACK EVENT rather than from
// a fixed size on the effect.
const SEED_EFFECT = {
  name: 'sweep_arc',
  shape: 'arc',
  color: '#e8e8f0',
  width: 3,
  duration_ms: 180,
  ease: 'out',
  fade: true,
  follows_weapon: true,
};

exports.up = (pgm) => {
  // The effect LIBRARY: one row per distinct look, referenced by name.
  // Geometry columns only — the particle_* columns arrive in slice C, so this
  // slice is not blocked on settling particle semantics it cannot yet draw.
  pgm.createTable('vfx_effects', {
    id: 'id',
    name: { type: 'text', notNull: true, unique: true },
    shape: { type: 'text', notNull: true },
    color: { type: 'text', notNull: true, default: '#dddddd' },
    width: { type: 'real', notNull: true, default: 2 },
    duration_ms: { type: 'integer', notNull: true, default: 180 },
    ease: { type: 'text', notNull: true, default: 'out' },
    fade: { type: 'boolean', notNull: true, default: true },
    follows_weapon: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Enum-style CHECKs, matching how item_types.element and .category are
  // constrained. The full shape vocabulary is admitted now even though slice A
  // only draws 'arc' — so slice B adds shapes with no migration.
  pgm.addConstraint('vfx_effects', 'vfx_effects_shape_check',
    "CHECK (shape IN ('arc','line','ring','burst','bolt'))");
  pgm.addConstraint('vfx_effects', 'vfx_effects_ease_check',
    "CHECK (ease IN ('linear','out','in'))");
  // A zero/negative duration would divide by zero in effectProgress; a huge one
  // would pin an effect on screen forever.
  pgm.addConstraint('vfx_effects', 'vfx_effects_duration_check',
    'CHECK (duration_ms > 0 AND duration_ms <= 5000)');

  // Bindings: { "<moment>": "<vfx_effects.name>" }. jsonb rather than eight
  // nullable FK columns, mirroring tile_types.sprite / entity_types.sprite.
  // The accepted cost is no referential integrity — an unresolved name draws
  // nothing rather than throwing (see core/vfx.js addEffects).
  pgm.addColumn('item_types', { vfx: { type: 'jsonb' } });

  const e = SEED_EFFECT;
  pgm.sql(`
    INSERT INTO vfx_effects (name, shape, color, width, duration_ms, ease, fade, follows_weapon)
    VALUES ('${e.name}', '${e.shape}', '${e.color}', ${e.width}, ${e.duration_ms},
            '${e.ease}', ${e.fade}, ${e.follows_weapon})
  `);

  // Every melee weapon, not a hand-picked list: a weapon added to the catalog
  // before slice B lands should still swing visibly.
  pgm.sql(`UPDATE item_types SET vfx = '{"attack":"sweep_arc"}'::jsonb WHERE kind = 'melee'`);
};

exports.down = (pgm) => {
  pgm.dropColumns('item_types', ['vfx']);
  pgm.dropTable('vfx_effects');
};

// Exported so the migration test can assert the seed without a database.
exports.SEED_EFFECT = SEED_EFFECT;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test tests/migration_vfx_effects.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 5: Apply the migration against the dev database**

Run: `make shell-backend` then `npm run migrate:up` (or `docker compose exec backend npm run migrate:up`).
Expected: `Migrations complete!` naming `1714440034000_vfx_effects`.

Verify the bindings actually landed — a silent zero-row UPDATE is the failure mode that makes slice A look broken later:

```bash
docker compose exec db psql -U user -d game_db -c \
  "SELECT count(*) FILTER (WHERE vfx IS NOT NULL) AS bound, count(*) AS melee FROM item_types WHERE kind='melee';"
```
Expected: `bound` equals `melee`, and both are 12.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/1714440034000_vfx_effects.js backend/tests/migration_vfx_effects.test.js
git commit -m "feat(vfx): vfx_effects table and item_types.vfx bindings"
```

---

## Task 2: `GET /api/vfx-effects`

**Files:**
- Modify: `backend/src/index.js` (add next to the `GET /api/tile-types` route, ~line 426)
- Test: `backend/tests/vfx_effects_api.test.js`

**Interfaces:**
- Consumes: table `vfx_effects` (Task 1).
- Produces: `GET /api/vfx-effects` → `200` with an array of rows, each `{ id, name, shape, color, width, duration_ms, ease, fade, follows_weapon, created_at }`. Unauthenticated (read-only, same posture as `GET /api/tile-types`). Admin CRUD is slice E.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/vfx_effects_api.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

function mockPool(handlers) {
  return {
    query: async (sql, params) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const ROW = {
  id: 1, name: 'sweep_arc', shape: 'arc', color: '#e8e8f0', width: 3,
  duration_ms: 180, ease: 'out', fade: true, follows_weapon: true,
};

test('GET /api/vfx-effects returns the effect library', async () => {
  __setPool(mockPool([[/FROM vfx_effects/i, () => ({ rows: [ROW] })]]));
  const res = await request(app).get('/api/vfx-effects');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].name, 'sweep_arc');
  // The client indexes by name and reads geometry straight off the row, so
  // every field the renderer uses must survive the round trip.
  for (const k of ['shape', 'color', 'width', 'duration_ms', 'ease', 'fade', 'follows_weapon']) {
    assert.ok(k in res.body[0], `response drops ${k}`);
  }
});

test('the effect library is readable without a token', async () => {
  // Every player's client needs it to draw a frame; only WRITES are admin
  // (slice E). A 401 here would leave signed-out spectators with no effects.
  __setPool(mockPool([[/FROM vfx_effects/i, () => ({ rows: [ROW] })]]));
  const res = await request(app).get('/api/vfx-effects');
  assert.equal(res.status, 200);
});

test('a query failure is a 500, not a crash', async () => {
  __setPool({ query: async () => { throw new Error('boom'); } });
  const res = await request(app).get('/api/vfx-effects');
  assert.equal(res.status, 500);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd backend && node --test tests/vfx_effects_api.test.js`
Expected: FAIL — status 404, not 200.

- [ ] **Step 3: Add the route**

In `backend/src/index.js`, immediately above the `// Tile Types CRUD` comment (~line 425):

```js
// VFX effect library. Read-only and unauthenticated: every client needs it to
// draw an attack. Admin CRUD lands in slice E.
app.get('/api/vfx-effects', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vfx_effects ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vfx effects' });
  }
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test tests/vfx_effects_api.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.js backend/tests/vfx_effects_api.test.js
git commit -m "feat(vfx): GET /api/vfx-effects"
```

---

## Task 3: Weapon catalog carries `vfx`; pure name resolver

**Files:**
- Modify: `backend/src/authority/items.js:12-44`
- Create: `backend/src/authority/vfx.js`
- Test: `backend/tests/authority_vfx.test.js`
- Modify: `backend/tests/authority_items_catalog.test.js` (add `vfx` to the `ROWS` fixture and one assertion)

**Interfaces:**
- Consumes: `item_types.vfx` (Task 1).
- Produces:
  - `loadItemTypes(pool)` map entries gain `vfx: object | null`.
  - `require('./vfx.js')` exports `resolveEffectName(weapon, moment) -> string | null`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/authority_vfx.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { resolveEffectName } = require('../src/authority/vfx.js');

test('resolves the bound name for a moment', () => {
  const w = { name: 'halberd', kind: 'melee', vfx: { attack: 'sweep_arc', impact: 'spark_steel' } };
  assert.equal(resolveEffectName(w, 'attack'), 'sweep_arc');
  assert.equal(resolveEffectName(w, 'impact'), 'spark_steel');
});

test('an unbound moment resolves to null', () => {
  const w = { name: 'halberd', kind: 'melee', vfx: { attack: 'sweep_arc' } };
  assert.equal(resolveEffectName(w, 'miss'), null);
});

test('an unbound weapon resolves to null in slice A', () => {
  // Slice B replaces this with a kind-level default. Asserted explicitly so
  // that change is a deliberate edit to a failing test, not a silent drift.
  assert.equal(resolveEffectName({ name: 'club', kind: 'melee', vfx: null }, 'attack'), null);
  assert.equal(resolveEffectName({ name: 'club', kind: 'melee' }, 'attack'), null);
});

test('junk in the jsonb never escapes as a name', () => {
  // vfx has no referential integrity and is admin-editable, so every
  // non-string shape has to degrade to "draw nothing", not reach the client.
  for (const bad of [{ attack: 42 }, { attack: '' }, { attack: null }, { attack: {} }, { attack: [] }]) {
    assert.equal(resolveEffectName({ vfx: bad }, 'attack'), null, JSON.stringify(bad));
  }
  for (const bad of ['sweep_arc', 42, [], true]) {
    assert.equal(resolveEffectName({ vfx: bad }, 'attack'), null, `vfx=${JSON.stringify(bad)}`);
  }
});

test('a missing weapon resolves to null rather than throwing', () => {
  assert.equal(resolveEffectName(null, 'attack'), null);
  assert.equal(resolveEffectName(undefined, 'attack'), null);
});
```

Then, in `backend/tests/authority_items_catalog.test.js`, add `vfx` to the first entry of the `ROWS` fixture (the dagger row, ~line 33) and append this test at the end of the file:

```js
test('loadItemTypes carries the vfx bindings through to the weapon catalog', async () => {
  // world.attack() resolves the effect name off the weapon object it already
  // holds. Dropped here, every attack silently resolves to null and slice A
  // renders nothing while every other test stays green.
  const rows = [{ ...ROWS[0], vfx: { attack: 'sweep_arc' } }];
  const m = await loadItemTypes(fakePool(rows));
  assert.deepEqual(m.get(1).vfx, { attack: 'sweep_arc' });
});

test('a weapon with no bindings loads vfx as null, not undefined', async () => {
  const m = await loadItemTypes(fakePool([{ ...ROWS[0], vfx: null }]));
  assert.strictEqual(m.get(1).vfx, null);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd backend && node --test tests/authority_vfx.test.js tests/authority_items_catalog.test.js`
Expected: FAIL — `Cannot find module '../src/authority/vfx.js'`, and the catalog tests fail with `undefined` vs `{ attack: 'sweep_arc' }`.

- [ ] **Step 3: Write the resolver**

Create `backend/src/authority/vfx.js`:

```js
// Effect-name resolution. Pure (no DB, no world state).
//
// Names are resolved SERVER-SIDE and travel to the client as strings: the
// client must never need the weapon catalog or the binding rules to draw a
// frame. Everything else about an effect (shape, colour, timing) is looked up
// client-side from the vfx_effects library.

// The moment a binding key names. Only 'attack' is emitted in slice A;
// 'impact' is slice C, 'miss' slice B, 'trail' slice D.
const MOMENTS = ['attack', 'impact', 'miss', 'trail'];

// weapon.vfx is admin-editable jsonb with no FK to vfx_effects, so anything at
// all can be in there. Only a non-empty string is a name; every other shape
// degrades to null, which the client renders as nothing.
//
// SLICE B SEAM: the kind-level fallback goes here — when the binding misses,
// fall back to a default keyed on weapon.kind before returning null.
function resolveEffectName(weapon, moment) {
  if (!weapon) return null;
  const v = weapon.vfx;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const name = v[moment];
  return typeof name === 'string' && name.length > 0 ? name : null;
}

module.exports = { resolveEffectName, MOMENTS };
```

- [ ] **Step 4: Load `vfx` in the catalog**

In `backend/src/authority/items.js`, add `vfx` to the SELECT column list (line 15, after `aoe_radius`):

```js
            defense, resistances, stackable, ammo_type_id, aoe_radius, vfx
```

and to the mapped object (after the `aoe_radius` line, ~line 42):

```js
      aoe_radius: num(row.aoe_radius),
      // Effect-name bindings per moment, e.g. { attack: 'sweep_arc' }.
      // Normalized to null so `weapon.vfx` is never undefined downstream.
      vfx: row.vfx || null,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && node --test tests/authority_vfx.test.js tests/authority_items_catalog.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/authority/vfx.js backend/src/authority/items.js \
        backend/tests/authority_vfx.test.js backend/tests/authority_items_catalog.test.js
git commit -m "feat(vfx): load vfx bindings into the weapon catalog; name resolver"
```

---

## Task 4: `meleeArcTargets()` — know whether a swing connected

**Files:**
- Modify: `backend/src/authority/creatures.js:317-333`
- Test: `backend/tests/authority_creatures_combat.test.js` (append)

**Interfaces:**
- Consumes: `inArc`, `hasLineOfSight` from `./weapons.js` (already imported in `creatures.js`).
- Produces: `CreatureSim.prototype.meleeArcTargets(ox, oy, nx, ny, reach, arcWidth) -> string[]` — the ids of every live creature inside the arc with line of sight, damaging nothing.
- `applyMeleeArc`'s existing signature and array return are **unchanged**.

**Why this exists:** `frame.attacks` carries `hit: true|false` so slice B can play a whiff. `applyMeleeArc` returns only *killed* ids, so a wolf that is hit and survives would otherwise be indistinguishable from a clean miss. Extracting the target query — and having `applyMeleeArc` iterate it — keeps **one** arc rule rather than two that can drift apart.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/authority_creatures_combat.test.js`:

```js
test('meleeArcTargets lists in-arc creatures without damaging them', () => {
  const sim = new CreatureSim(stubMap(), rng);
  sim.addCreatures([creatureAt('a', 100, 108, 40)]);
  const before = sim.creatures.get('a').hp;
  const ids = sim.meleeArcTargets(60, 124, 1, 0, 120, 1.8);
  assert.deepEqual(ids, ['a']);
  assert.equal(sim.creatures.get('a').hp, before, 'the query must not deal damage');
});

test('meleeArcTargets excludes a creature outside the angular cone', () => {
  const sim = new CreatureSim(stubMap(), rng);
  // Due south of the origin, aim due north — behind the swing.
  sim.addCreatures([creatureAt('b', 100, 400, 40)]);
  assert.deepEqual(sim.meleeArcTargets(124, 300, 0, -1, 400, 0.6), []);
});

test('meleeArcTargets reports a survivor that applyMeleeArc omits', () => {
  // This is the exact case `hit` exists for: a connected swing that kills
  // nothing must still read as a hit, not a whiff.
  const sim = new CreatureSim(stubMap(), rng);
  sim.addCreatures([creatureAt('tough', 100, 108, 999)]);
  assert.deepEqual(sim.meleeArcTargets(60, 124, 1, 0, 120, 1.8), ['tough']);
  assert.deepEqual(sim.applyMeleeArc(60, 124, 1, 0, 120, 1.8, 20), [],
    'no kills — which is why killed ids cannot stand in for hits');
});

test('applyMeleeArc still returns the dead ids after the refactor', () => {
  const sim = new CreatureSim(stubMap(), rng);
  sim.addCreatures([creatureAt('c', 100, 108, 5)]);
  assert.deepEqual(sim.applyMeleeArc(60, 124, 1, 0, 120, 1.8, 20), ['c']);
  assert.equal(sim.creatures.has('c'), false, 'a killed creature is removed');
});
```

**Note:** `stubMap()`, `rng` and `creatureAt(id, x, y, hp)` are already defined at the top of this file (lines 12-16) and are what its existing `applyMeleeArc` tests use. Reuse them; do not add a new helper.

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd backend && node --test tests/authority_creatures_combat.test.js`
Expected: FAIL — `sim.meleeArcTargets is not a function`.

- [ ] **Step 3: Extract the query and rewrite `applyMeleeArc` on top of it**

Replace `applyMeleeArc` in `backend/src/authority/creatures.js` (lines 317-333) with:

```js
  // Ids of every live creature a melee swing would connect with: inside the
  // arc AND with line of sight. Damages nothing.
  //
  // Split out of applyMeleeArc so an attack can report whether it CONNECTED
  // (frame.attacks `hit`) — killed ids alone cannot answer that, since a
  // creature hit for non-lethal damage appears in neither list. applyMeleeArc
  // iterates this, so both share ONE arc rule and cannot drift apart.
  meleeArcTargets(ox, oy, nx, ny, reach, arcWidth) {
    const ids = [];
    for (const [id, c] of this.creatures) {
      const cc = center(c);
      if (!inArc(ox, oy, nx, ny, cc.x, cc.y, reach, arcWidth)) continue;
      // Terrain blocks the swing, exactly as it blocks a projectile.
      if (!hasLineOfSight(this.map, ox, oy, cc.x, cc.y)) continue;
      ids.push(id);
    }
    return ids;
  }

  applyMeleeArc(ox, oy, nx, ny, reach, arcWidth, damage, element, now = 0) {
    const killed = [];
    for (const id of this.meleeArcTargets(ox, oy, nx, ny, reach, arcWidth)) {
      const c = this.creatures.get(id);
      if (!c) continue;
      applyDamageWithEffects(c, damage, element, c.mit || NO_MITIGATION, now);
      // The element's status rider is applied wherever the element already
      // deals damage — one call adjacent to each applyDamage, never a second
      // rider table.
      applyElementEffect(c, element, now);
      c.dirty = true;
      if (c.hp <= 0) { this.creatures.delete(id); killed.push(id); }
    }
    return killed;
  }
```

- [ ] **Step 4: Run the whole creature + combat suite**

Run: `cd backend && node --test tests/authority_creatures_combat.test.js tests/authority_creatures.test.js tests/authority_world_combat.test.js`
Expected: PASS. The three pre-existing `applyMeleeArc` tests must still pass unchanged — that is the regression gate on the refactor.

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/creatures.js backend/tests/authority_creatures_combat.test.js
git commit -m "refactor(combat): extract meleeArcTargets so a swing can report a hit"
```

---

## Task 5: `world.attack()` returns attack descriptors

**Files:**
- Modify: `backend/src/authority/world.js:248-296`
- Test: `backend/tests/authority_world_combat.test.js` (append)

**Interfaces:**
- Consumes: `resolveEffectName` (Task 3), `meleeArcTargets` (Task 4), `weapon.vfx` (Task 3).
- Produces: `world.attack(userId, ax, ay)` returns `{ killedCreatureIds: string[], attacks: Attack[] }` on **every** path (early rejections return `attacks: []`), where

```js
Attack = {
  a: 'p:<userId>',   // actor
  v: string | null,  // resolved effect name
  x: number, y: number,   // origin, world px (attacker centre)
  nx: number, ny: number, // aim unit vector
  reach: number, arc: number,
  hit: boolean,
}
```

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/authority_world_combat.test.js`. Note the `TYPES` fixture at the top of that file needs `vfx` on the melee entries — add `vfx: { attack: 'sweep_arc' }` to ids **1** (dagger) and **2** (halberd), and leave id **5** (greatsword) **unbound** so the null case is covered by a real catalog entry.

```js
const { resolveEffectName } = require('../src/authority/vfx.js');

test('a melee attack returns one descriptor carrying the real weapon geometry', () => {
  const w = armWorld();
  // Inventory is addPlayer's THIRD argument (see world.js addPlayer) — the
  // rest of this file passes it the same way. Assigning p.inv afterwards
  // would work too, but stay consistent with the file.
  w.addPlayer('u1', { x: 100, y: 100 }, longReachInv());  // centre 132,132; halberd reach 190, arc 1.8
  const { attacks } = w.attack('u1', 1, 0);               // aim due east

  assert.equal(attacks.length, 1);
  const a = attacks[0];
  assert.equal(a.a, 'p:u1');
  assert.equal(a.v, 'sweep_arc');
  assert.equal(a.x, 132);
  assert.equal(a.y, 132);
  assert.equal(a.nx, 1);
  assert.equal(a.ny, 0);
  // Geometry comes from the CATALOG, not from constants in the descriptor —
  // this is what makes a halberd and a knife look different.
  assert.equal(a.reach, 190);
  assert.equal(a.arc, 1.8);
});

test('the descriptor geometry tracks the equipped weapon', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 });           // no inv override -> default dagger
  const a = w.attack('u1', 1, 0).attacks[0];
  assert.equal(a.reach, 80);
  assert.equal(a.arc, 0.6);
  assert.notEqual(a.reach, 190, 'a dagger must not report the halberd reach');
});

test('the aim vector in the descriptor is normalized', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 });
  const a = w.attack('u1', 3, 4).attacks[0];       // length 5
  assert.ok(Math.abs(Math.hypot(a.nx, a.ny) - 1) < 1e-9, 'nx/ny must be a unit vector');
  assert.ok(Math.abs(a.nx - 0.6) < 1e-9);
  assert.ok(Math.abs(a.ny - 0.8) < 1e-9);
});

test('hit is true for a connected swing that kills nothing', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, longReachInv());
  // Same coordinates the file's proven in-arc dagger test uses (x 150, y 108
  // against a player centred 132,132 aiming east), so an arc-geometry change
  // cannot be what makes this test go red.
  w.creatures.addCreatures([{ id: 'tough', type: 'Wolf', x: 150, y: 108, hp: 9999, facing: 'S', color: '#c00' }]);
  const { killedCreatureIds, attacks } = w.attack('u1', 1, 0);
  assert.deepEqual(killedCreatureIds, [], 'nothing died');
  assert.equal(attacks[0].hit, true, 'a non-lethal connection is still a hit, not a whiff');
});

test('hit is false when the swing connects with nothing', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, longReachInv());
  assert.equal(w.attack('u1', 1, 0).attacks[0].hit, false);
});

test('hit is true when only another player is caught in the arc', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, longReachInv());  // centre 132,132
  w.addPlayer('u2', { x: 200, y: 100 }, emptyInv());      // centre 232,132 — 100px east, inside reach 190
  assert.equal(w.attack('u1', 1, 0).attacks[0].hit, true);
});

test('an unbound weapon emits a descriptor with a null name', () => {
  // The swing still happened; slice B gives it a kind-level default. It must
  // NOT be swallowed here — a missing descriptor and a null name are
  // different bugs and must stay distinguishable.
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, heavyInv());   // greatsword, no vfx binding
  const a = w.attack('u1', 1, 0).attacks[0];
  assert.equal(a.v, null);
  assert.equal(a.reach, 90);
});

test('a projectile attack emits no descriptor in slice A', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, { items: [{ id: 'b3', typeId: 3 }], equipment: { main_hand: 'b3' } });
  assert.deepEqual(w.attack('u1', 1, 0).attacks, [], 'projectile trails are slice D');
});

test('every refused attack still returns an attacks array', () => {
  // server.js destructures `attacks` unconditionally; an undefined on any
  // rejection path would throw inside the socket handler.
  const w = armWorld();
  assert.deepEqual(w.attack('nobody', 1, 0).attacks, []);   // unknown player
  w.addPlayer('u1', { x: 100, y: 100 });
  w.attack('u1', 1, 0);                                      // starts the cooldown
  assert.deepEqual(w.attack('u1', 1, 0).attacks, [], 'cooldown-refused');
});

test('a refused attack emits no descriptor at all', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, heavyInv());   // greatsword, stamina_cost 20
  w.getPlayer('u1').stamina = 0;
  assert.deepEqual(w.attack('u1', 1, 0).attacks, [],
    'a swing that never happened must not draw one');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd backend && node --test tests/authority_world_combat.test.js`
Expected: FAIL — `Cannot read properties of undefined (reading 'length')` on `attacks`.

- [ ] **Step 3: Emit the descriptors**

At the top of `backend/src/authority/world.js`, beside the existing `require('./weapons')` (line 3):

```js
const { resolveEffectName } = require('./vfx.js');
```

Then in `attack()`, add `attacks: []` to each of the four early returns (lines 250, 255, 257, 264), e.g.:

```js
    if (!p || p._attackCd > 0) return { killedCreatureIds: [], attacks: [] };
```

and replace the melee branch (lines 269-286) with:

```js
    if (w.kind === 'melee') {
      const f = facingFromInput(sign(nx), sign(ny));
      if (f) p.facing = f;
      if (manaCost) p.mana -= manaCost;
      if (staminaCost) p.stamina -= staminaCost;
      // Queried BEFORE applyMeleeArc, which deletes whatever it kills: after
      // the fact a one-shot kill would look like a miss.
      const creatureTargets = this.creatures.meleeArcTargets(cx, cy, nx, ny, w.reach, w.arc_width);
      const killed = this.creatures.applyMeleeArc(cx, cy, nx, ny, w.reach, w.arc_width, w.damage, w.element, this.now);
      let playerHits = 0;
      for (const other of this.players.values()) {
        if (other.userId === userId) continue;
        const ocx = other.x + other.width / 2, ocy = other.y + other.height / 2;
        if (inArc(cx, cy, nx, ny, ocx, ocy, w.reach, w.arc_width)
            && hasLineOfSight(this.map, cx, cy, ocx, ocy)) {
          applyDamageWithEffects(other, w.damage, w.element, other.mit || NO_MITIGATION, this.now);
          applyElementEffect(other, w.element, this.now, userId);
          playerHits++;
        }
      }
      p._attackCd = w.cooldown;
      // The descriptor exposes facts this method already computed — the aim
      // vector, the attacker's centre, the catalog's reach/arc. Nothing here
      // is derived, and the effect NAME is resolved on this side so the
      // client never needs the weapon catalog to draw the swing.
      return {
        killedCreatureIds: killed,
        attacks: [{
          a: `p:${userId}`,
          v: resolveEffectName(w, 'attack'),
          x: cx, y: cy,
          nx, ny,
          reach: w.reach, arc: w.arc_width,
          hit: creatureTargets.length > 0 || playerHits > 0,
        }],
      };
    }
```

Finally, the projectile branch's return (line 295):

```js
    // Projectiles already render as a moving dot; their trail effects are
    // slice D, so slice A emits no descriptor for them.
    return { killedCreatureIds: [], attacks: [] };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && node --test tests/authority_world_combat.test.js tests/authority_world.test.js tests/authority_combat_integration.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/world.js backend/tests/authority_world_combat.test.js
git commit -m "feat(vfx): world.attack emits melee attack descriptors"
```

---

## Task 6: Broadcast `frame.attacks`

**Files:**
- Modify: `backend/src/authority/server.js` — helper near `onCreatureDeath` (~line 173), the `attack` handler (lines 439 and 481), and the broadcast (lines 700-715)
- Test: `backend/tests/authority_server.test.js` (append) or a new `backend/tests/authority_attack_frames.test.js`

**Interfaces:**
- Consumes: `world.attack() -> { killedCreatureIds, attacks }` (Task 5).
- Produces: `state` frames carry `attacks: Attack[]` **only when non-empty**, matching how `detonations` behaves.

**The difference from `detonations`, and why it matters.** `pendingDetonations` is *replaced* every tick because it is produced *inside* the tick. Attacks arrive from the socket handler *between* ticks, and several can arrive before the next broadcast — so the stash must **accumulate**. Replacement would silently drop every attack but the last one in a tick. Accumulation loses the natural bound replacement gave for free, so it is capped.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/authority_attack_frames.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { __test } = require('../src/authority/server.js');

// pushAttacks / drainAttacks are exported for test through server.js's __test
// bag; the broadcast wiring itself is exercised in the browser step.
const { pushAttacks, drainAttacks, MAX_PENDING_ATTACKS } = __test;

const A = (i) => ({ a: `p:u${i}`, v: 'sweep_arc', x: i, y: i, nx: 1, ny: 0, reach: 80, arc: 0.6, hit: false });

test('attacks accumulate between ticks rather than replacing each other', () => {
  // Two players swinging inside one tick interval must BOTH be drawn. The
  // detonation stash replaces; copying that here loses every swing but one.
  const entry = {};
  pushAttacks(entry, [A(1)]);
  pushAttacks(entry, [A(2)]);
  assert.equal(entry.pendingAttacks.length, 2);
  assert.deepEqual(entry.pendingAttacks.map((a) => a.a), ['p:u1', 'p:u2']);
});

test('drain returns the batch and clears the stash in one step', () => {
  const entry = {};
  pushAttacks(entry, [A(1), A(2)]);
  assert.equal(drainAttacks(entry).length, 2);
  // Cleared BEFORE the send loop: if send() throws partway through, a stale
  // batch must not survive to be re-drawn on the next tick.
  assert.equal(drainAttacks(entry).length, 0);
});

test('an empty drain returns an empty array, never null', () => {
  assert.deepEqual(drainAttacks({}), []);
});

test('the stash is capped', () => {
  // Accumulation has no natural bound; a world whose broadcast is wedged must
  // not grow this array without limit.
  const entry = {};
  for (let i = 0; i < MAX_PENDING_ATTACKS + 20; i++) pushAttacks(entry, [A(i)]);
  assert.equal(entry.pendingAttacks.length, MAX_PENDING_ATTACKS);
});

test('pushing nothing does not allocate a stash', () => {
  const entry = {};
  pushAttacks(entry, []);
  pushAttacks(entry, null);
  pushAttacks(entry, undefined);
  assert.equal(entry.pendingAttacks, undefined, 'an idle world must pay nothing');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd backend && node --test tests/authority_attack_frames.test.js`
Expected: FAIL — `Cannot destructure property 'pushAttacks' of '__test' as it is undefined.`

- [ ] **Step 3: Add the stash helpers**

In `backend/src/authority/server.js`, next to `onCreatureDeath` (~line 173):

```js
// Cap on a single world's un-broadcast attack batch. Attacks arrive from the
// socket handler BETWEEN ticks, so unlike pendingDetonations (produced inside
// the tick and replaced wholesale) this stash must ACCUMULATE — replacing it
// would drop every swing but the last one in a tick interval. Accumulation has
// no natural bound, hence the cap; overflow drops the newest, since the oldest
// swings are the ones already on screen for other players.
const MAX_PENDING_ATTACKS = 64;

function pushAttacks(entry, attacks) {
  if (!Array.isArray(attacks) || attacks.length === 0) return;
  if (!entry.pendingAttacks) entry.pendingAttacks = [];
  for (const a of attacks) {
    if (entry.pendingAttacks.length >= MAX_PENDING_ATTACKS) return;
    entry.pendingAttacks.push(a);
  }
}

// Take this tick's batch and clear the stash in one step, so no caller can
// read it and forget to clear it.
function drainAttacks(entry) {
  const batch = entry.pendingAttacks;
  entry.pendingAttacks = null;
  return Array.isArray(batch) ? batch : [];
}
```

- [ ] **Step 4: Capture attacks at both call sites**

In the `attack` handler, line 439 (the ammo-free synchronous path):

```js
        if (gate.weapon.ammo_type_id == null) {
          const { killedCreatureIds, attacks } = entry.world.attack(ws.userId, ax, ay);
          pushAttacks(entry, attacks);
          for (const id of new Set(killedCreatureIds)) onCreatureDeath(entry, id);
          return;
        }
```

and line 481 (the ammo path — note it pushes onto `cur`, the re-read entry, not the captured `entry`):

```js
            const { killedCreatureIds, attacks } = cur.world.attack(ws.userId, ax, ay);
            pushAttacks(cur, attacks);
            for (const id of new Set(killedCreatureIds)) onCreatureDeath(cur, id);
```

- [ ] **Step 5: Put them on the frame**

In the broadcast block, beside the existing detonation drain (lines 704-713):

```js
      const dets = entry.pendingDetonations;
      entry.pendingDetonations = null;
      const hasDets = Array.isArray(dets) && dets.length > 0;
      // Same contract as detonations: this tick's batch or it is lost, cleared
      // before the send loop, and omitted entirely when empty so an idle world
      // pays nothing per frame.
      const atks = drainAttacks(entry);
      const hasAtks = atks.length > 0;
      for (const [userId, ws] of entry.sockets) {
        const p = entry.world.getPlayer(userId);
        const frame = { type: 'state', tick, ackSeq: p ? p.ackSeq : 0, players: snap.players, projectiles: snap.projectiles };
        if (hasDets) frame.detonations = dets;
        if (hasAtks) frame.attacks = atks;
        send(ws, frame);
      }
```

- [ ] **Step 6: Export the helpers for test**

Line 813 of `backend/src/authority/server.js` currently reads:

```js
module.exports = { attachAuthority, planTransition, planBind };
```

Replace it with:

```js
module.exports = {
  attachAuthority, planTransition, planBind,
  // Stash internals, exported for unit test only. Not part of the module's API.
  __test: { pushAttacks, drainAttacks, MAX_PENDING_ATTACKS },
};
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd backend && node --test tests/authority_attack_frames.test.js tests/authority_server.test.js`
Expected: PASS.

- [ ] **Step 8: Run the whole backend suite — this task touched the hot path**

Run: `cd backend && npm test`
Expected: PASS (DB-backed tests may report skips if Postgres is unreachable; nothing may **fail**).

- [ ] **Step 9: Commit**

```bash
git add backend/src/authority/server.js backend/tests/authority_attack_frames.test.js
git commit -m "feat(vfx): broadcast attack descriptors on the state frame"
```

---

## Task 7: Client effect store — `core/vfx.js`

**Files:**
- Create: `frontend/src/games/something2/src/js/core/vfx.js`
- Test: `frontend/src/games/something2/src/js/core/__tests__/vfx.test.js`

**Interfaces:**
- Consumes: nothing (pure module; no imports beyond `Math`).
- Produces:
  - `indexEffects(rows) -> { [name]: def }`
  - `addEffects(list, events, nowMs, defs) -> list` (mutates and returns `list`, like `addBlasts`)
  - `pruneEffects(list, nowMs) -> newList`
  - `effectProgress(fx, nowMs) -> number` (0..1, **eased**)
  - `effectAlpha(fx, nowMs) -> number` (0..1, **linear**)
  - `ease(t, mode) -> number`
  - `isoArcAngle(nx, ny) -> number`
  - `DEFAULT_DURATION_MS`

Effect entries in `list` have shape `{ def, x, y, nx, ny, reach, arc, hit, startedAt }`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/src/js/core/__tests__/vfx.test.js`:

```js
import { describe, it, expect } from "vitest";
import {
  indexEffects, addEffects, pruneEffects, effectProgress, effectAlpha, ease,
  isoArcAngle, DEFAULT_DURATION_MS,
} from "../vfx.js";

const DEF = {
  id: 1, name: "sweep_arc", shape: "arc", color: "#e8e8f0", width: 3,
  duration_ms: 200, ease: "out", fade: true, follows_weapon: true,
};
const DEFS = indexEffects([DEF]);
const EV = (over = {}) => ({
  a: "p:1", v: "sweep_arc", x: 10, y: 20, nx: 1, ny: 0, reach: 190, arc: 1.8, hit: true, ...over,
});

describe("indexEffects", () => {
  it("keys the library by name", () => {
    expect(indexEffects([DEF]).sweep_arc.duration_ms).toBe(200);
  });
  it("survives a missing or malformed library", () => {
    expect(indexEffects(null)).toEqual({});
    expect(indexEffects([null, { shape: "arc" }])).toEqual({});  // rows without a name are unreferenceable
  });
});

describe("addEffects", () => {
  it("stamps arrival time and carries the event geometry", () => {
    const list = addEffects([], [EV()], 1000, DEFS);
    expect(list).toHaveLength(1);
    expect(list[0].startedAt).toBe(1000);
    expect(list[0].reach).toBe(190);
    expect(list[0].arc).toBe(1.8);
    expect(list[0].hit).toBe(true);
    expect(list[0].def).toBe(DEF);
  });

  it("drops an event whose effect name is not in the library", () => {
    // vfx bindings have no referential integrity — a renamed row orphans them.
    // An unresolvable name draws nothing; it must never throw.
    expect(addEffects([], [EV({ v: "renamed_away" })], 0, DEFS)).toHaveLength(0);
    expect(addEffects([], [EV({ v: null })], 0, DEFS)).toHaveLength(0);
  });

  it("drops events with non-finite coordinates", () => {
    expect(addEffects([], [EV({ x: NaN })], 0, DEFS)).toHaveLength(0);
    expect(addEffects([], [EV({ y: undefined })], 0, DEFS)).toHaveLength(0);
  });

  it("tolerates a missing or non-array batch", () => {
    expect(addEffects([], null, 0, DEFS)).toEqual([]);
    expect(addEffects([], undefined, 0, DEFS)).toEqual([]);
  });

  it("defaults a degenerate aim vector to due south rather than zero", () => {
    // A zero vector would make atan2 return 0 and point every such swing east.
    const fx = addEffects([], [EV({ nx: 0, ny: 0 })], 0, DEFS)[0];
    expect(fx.nx).toBe(0);
    expect(fx.ny).toBe(1);
  });
});

describe("pruneEffects", () => {
  it("drops effects past their own duration", () => {
    const list = addEffects([], [EV()], 0, DEFS);
    expect(pruneEffects(list, 199)).toHaveLength(1);
    expect(pruneEffects(list, 200)).toHaveLength(0);
  });

  it("returns a NEW array so an in-progress draw is never mutated", () => {
    const list = addEffects([], [EV()], 0, DEFS);
    expect(pruneEffects(list, 10)).not.toBe(list);
  });

  it("prunes on RAW time, not eased progress", () => {
    // Easing is a display curve. Pruning off it would make an 'out' effect
    // vanish early and an 'in' effect linger past its duration.
    const slow = indexEffects([{ ...DEF, ease: "out", duration_ms: 100 }]);
    const list = addEffects([], [EV()], 0, slow);
    expect(pruneEffects(list, 99)).toHaveLength(1);
  });
});

describe("effectProgress", () => {
  it("runs 0 to 1 across the lifetime and clamps outside it", () => {
    const fx = addEffects([], [EV()], 1000, indexEffects([{ ...DEF, ease: "linear" }]))[0];
    expect(effectProgress(fx, 1000)).toBe(0);
    expect(effectProgress(fx, 1100)).toBeCloseTo(0.5);
    expect(effectProgress(fx, 1200)).toBe(1);
    expect(effectProgress(fx, 5000)).toBe(1);
    expect(effectProgress(fx, 900)).toBe(0);
  });

  it("applies the effect's own easing", () => {
    const out = addEffects([], [EV()], 0, indexEffects([{ ...DEF, ease: "out" }]))[0];
    // 'out' is fast-then-slow: half the time is more than half the sweep.
    expect(effectProgress(out, 100)).toBeGreaterThan(0.5);
    const inn = addEffects([], [EV()], 0, indexEffects([{ ...DEF, ease: "in" }]))[0];
    expect(effectProgress(inn, 100)).toBeLessThan(0.5);
  });

  it("falls back to the default duration when the def carries none", () => {
    const fx = addEffects([], [EV()], 0, indexEffects([{ ...DEF, duration_ms: 0 }]))[0];
    expect(effectProgress(fx, DEFAULT_DURATION_MS)).toBe(1);
  });
});

describe("effectAlpha", () => {
  it("fades linearly when fade is set", () => {
    const fx = addEffects([], [EV()], 0, indexEffects([{ ...DEF, ease: "out" }]))[0];
    // Linear, NOT eased: an eased alpha makes a fast 'out' effect disappear
    // almost immediately and the swing reads as a flicker.
    expect(effectAlpha(fx, 100)).toBeCloseTo(0.5);
  });

  it("stays opaque when fade is off", () => {
    const fx = addEffects([], [EV()], 0, indexEffects([{ ...DEF, fade: false }]))[0];
    expect(effectAlpha(fx, 199)).toBe(1);
  });
});

describe("ease", () => {
  it("pins both endpoints for every mode", () => {
    for (const m of ["linear", "out", "in", "nonsense", undefined]) {
      expect(ease(0, m)).toBe(0);
      expect(ease(1, m)).toBe(1);
    }
  });
  it("treats an unknown mode as linear", () => {
    expect(ease(0.5, "nonsense")).toBe(0.5);
  });
});

describe("isoArcAngle", () => {
  it("maps a world direction to the iso ellipse's PARAMETRIC angle", () => {
    // worldToScreen sends (R·cosθ, R·sinθ) to
    //   (R·√2·ISO_K·cos(θ+π/4), R·√2·ISO_K/2·sin(θ+π/4))
    // and canvas ellipse() draws (x + rx·cos φ, y + ry·sin φ) — so φ = θ+π/4.
    // Passing the raw world angle instead points every swing 45° off.
    expect(isoArcAngle(1, 0)).toBeCloseTo(Math.PI / 4);
    expect(isoArcAngle(0, 1)).toBeCloseTo(Math.PI / 2 + Math.PI / 4);
    expect(isoArcAngle(-1, 0)).toBeCloseTo(Math.PI + Math.PI / 4);
  });

  it("agrees with the screen position of the aim point", () => {
    // The strongest check available without a canvas: for a unit aim vector,
    // (cos φ, sin φ/2) must be parallel to the screen-space offset the iso
    // projection produces, which for (nx,ny) is ((nx-ny), (nx+ny)/2) up to a
    // positive scale.
    for (const [nx, ny] of [[1, 0], [0, 1], [-1, 0], [0, -1], [0.6, 0.8]]) {
      const phi = isoArcAngle(nx, ny);
      const ex = Math.cos(phi), ey = Math.sin(phi) / 2;
      const sx = (nx - ny) / Math.SQRT2, sy = (nx + ny) / (2 * Math.SQRT2);
      expect(ex).toBeCloseTo(sx, 6);
      expect(ey).toBeCloseTo(sy, 6);
    }
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/vfx.test.js`
Expected: FAIL — `Failed to resolve import "../vfx.js"`.

- [ ] **Step 3: Write the module**

Create `frontend/src/games/something2/src/js/core/vfx.js`:

```js
// Attack-VFX render store. Pure and canvas-free — mirrors core/blasts.js — so
// the lifetime, easing and iso projection maths are unit-testable under
// vitest's `node` environment, with RenderSystem as a thin consumer.
//
// The server emits attacks on a single tick's `state` frame and never repeats
// them, so the client keeps its own short-lived list and animates each entry
// off its ARRIVAL time.

// Used when an effect row carries no usable duration. Matches the column
// default in the vfx_effects migration.
export const DEFAULT_DURATION_MS = 180;

// The effect library, keyed by the name the server sends. Rows without a name
// are unreferenceable, so they are dropped rather than indexed under
// `undefined`.
export function indexEffects(rows) {
  const out = {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (r && typeof r.name === "string" && r.name) out[r.name] = r;
  }
  return out;
}

function duration(def) {
  const d = def && Number(def.duration_ms);
  return Number.isFinite(d) && d > 0 ? d : DEFAULT_DURATION_MS;
}

// Append this tick's attacks. Each is stamped with its ARRIVAL time (not a
// server timestamp): arrival is the only clock both ends agree on without
// clock sync, the same reasoning addBlasts documents.
//
// An event whose name is not in the library is DROPPED, not drawn blank:
// vfx bindings are jsonb with no FK, so renaming a vfx_effects row orphans
// every binding pointing at it. That has to degrade to nothing rather than
// throw inside the socket handler.
export function addEffects(list, events, nowMs, defs) {
  if (!Array.isArray(events)) return list;
  for (const e of events) {
    if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
    const def = e.v && defs ? defs[e.v] : null;
    if (!def) continue;
    let nx = Number.isFinite(e.nx) ? e.nx : 0;
    let ny = Number.isFinite(e.ny) ? e.ny : 0;
    // A zero vector would make atan2 return 0 and point the swing due east.
    // Due south is the same fallback the server's vectorFromFacing uses.
    if (nx === 0 && ny === 0) { nx = 0; ny = 1; }
    list.push({
      def,
      x: e.x, y: e.y,
      nx, ny,
      reach: Number.isFinite(e.reach) ? e.reach : 0,
      arc: Number.isFinite(e.arc) ? e.arc : 0,
      hit: e.hit === true,
      startedAt: nowMs,
    });
  }
  return list;
}

// Drop finished effects. Returns a NEW array (callers reassign) so an effect
// can never be mutated out from under an in-progress draw loop. Compares RAW
// elapsed time, never eased progress — easing is a display curve, and pruning
// off it would make an 'out' effect vanish early.
export function pruneEffects(list, nowMs) {
  if (!Array.isArray(list) || list.length === 0) return list || [];
  return list.filter((fx) => nowMs - fx.startedAt < duration(fx.def));
}

export function ease(t, mode) {
  if (mode === "out") return 1 - (1 - t) * (1 - t);
  if (mode === "in") return t * t;
  return t;                                    // 'linear' and anything unknown
}

// 0 at spawn -> 1 at expiry, clamped, then eased by the effect's own curve.
// This is what the geometry animates along (a wedge sweeping open).
export function effectProgress(fx, nowMs) {
  if (!fx) return 1;
  const d = duration(fx.def);
  const t = (nowMs - fx.startedAt) / d;
  return ease(t < 0 ? 0 : t > 1 ? 1 : t, fx.def && fx.def.ease);
}

// Opacity, on RAW time. Deliberately NOT eased: an eased alpha on a fast 'out'
// effect drops to near-zero almost immediately and the swing reads as a
// flicker rather than a sweep.
export function effectAlpha(fx, nowMs) {
  if (!fx || !fx.def || fx.def.fade === false) return 1;
  const t = (nowMs - fx.startedAt) / duration(fx.def);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 - c;
}

// A world direction (nx, ny) as the PARAMETRIC angle of the iso ground-plane
// ellipse.
//
// worldToScreen sends a world circle (R·cosθ, R·sinθ) to
//     x = X0 + R·√2·ISO_K·cos(θ + π/4)
//     y = Y0 + R·√2·ISO_K/2·sin(θ + π/4)
// (the same derivation blastScreenRadiusX documents), and canvas ellipse()
// draws (x + rx·cos φ, y + ry·sin φ). So φ = θ + π/4.
//
// Passing the raw world angle to ellipse() instead points every swing 45° off
// the direction the player aimed.
export function isoArcAngle(nx, ny) {
  return Math.atan2(ny, nx) + Math.PI / 4;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/vfx.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/core/vfx.js \
        frontend/src/games/something2/src/js/core/__tests__/vfx.test.js
git commit -m "feat(vfx): pure client effect store with iso arc projection"
```

---

## Task 8: Load the effect library into the client

**Files:**
- Modify: `frontend/src/games/something2/useMaps.js` (append beside `useMapConfig`, ~line 205)
- Modify: `frontend/src/games/something2/Something2.jsx:387` and `:520-527`
- Modify: `frontend/src/games/something2/src/js/core/Game.js:234`, `:83`, `:277`

**Interfaces:**
- Consumes: `GET /api/vfx-effects` (Task 2), `indexEffects` (Task 7).
- Produces:
  - `useVfxEffects()` → `{ vfxEffects }` (array of rows, or `undefined` while loading)
  - `Game.initChunked({ ..., vfxEffects })` — sets `this.vfxDefs` (name → def) and `this.vfx = []`.

- [ ] **Step 1: Add the hook**

In `frontend/src/games/something2/useMaps.js`, directly after `useMapConfig` (line 205):

```js
// The VFX effect library. Fetched once and cached: rows only change when an
// admin edits them (slice E), and every attack frame looks up a name in it.
export function useVfxEffects() {
  const { data: vfxEffects } = useQuery({
    queryKey: ['vfxEffects'],
    staleTime: 60_000,
    queryFn: async () => {
      const res = await apiFetch(`${API_URL}/api/vfx-effects`);
      if (!res.ok) throw new Error('Failed to fetch vfx effects');
      return res.json();
    }
  });
  return { vfxEffects };
}
```

- [ ] **Step 2: Pass it through the component**

In `frontend/src/games/something2/Something2.jsx`, extend the import on line 8:

```js
import { useMapTiles, useMapConfig, useVfxEffects } from "./useMaps.js";
```

add beside `useMapConfig()` (line 387):

```js
  const { vfxEffects } = useVfxEffects();
```

and add to the `initChunked` call (after the `entityTypes` line, ~line 524):

```js
        entityTypes: mapConfig?.entityTypes || null,
        vfxEffects: vfxEffects || null,
```

- [ ] **Step 3: Accept and index it in `Game`**

In `frontend/src/games/something2/src/js/core/Game.js`, extend the `blasts.js` import (line 21):

```js
import { addBlasts, pruneBlasts } from "./blasts.js";
import { indexEffects, addEffects, pruneEffects } from "./vfx.js";
```

change the `initChunked` signature (line 234):

```js
    async initChunked({ worldId, chunkSize, tileTypes, entityTypes = null, vfxEffects = null, spawnX = 0, spawnY = 0 }) {
```

and beside each `this.blasts = [];` (lines 83 and 277) add:

```js
        this.blasts = [];
        // Live attack effects, and the library their names resolve against.
        // Cleared on re-entry alongside the blasts for the same reason: a
        // rejoin must not inherit the previous world's half-played swings.
        this.vfx = [];
```

At line 83 (the constructor) also initialise the library so a render before `initChunked` cannot read `undefined`:

```js
        this.vfxDefs = {};
```

and inside `initChunked`, beside `this._preloadTileAssets(tileTypes)` (line 259):

```js
        // Names arrive on the wire already resolved; this is the only lookup
        // the client does. Empty until the fetch lands — effects then simply
        // do not draw, rather than throwing.
        this.vfxDefs = indexEffects(vfxEffects);
```

- [ ] **Step 4: Verify the library actually reaches the client**

Run the dev stack and load the game page. In the browser console:

```js
await (await fetch(`${location.origin.replace(/:\d+$/, ':13101')}/api/vfx-effects`)).json()
```

Expected: an array of one row — `{ name: "sweep_arc", shape: "arc", duration_ms: 180, follows_weapon: true, … }`.

Then join a world and confirm in DevTools → Network that `GET /api/vfx-effects` fired once and returned `200`. If it never fires, the hook is not mounted; if it fires on every render, `staleTime` is missing.

- [ ] **Step 5: Run the frontend suite**

Run: `cd frontend && npm test`
Expected: PASS — nothing here is covered by an existing test, but this catches an import typo before the render work.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/useMaps.js \
        frontend/src/games/something2/Something2.jsx \
        frontend/src/games/something2/src/js/core/Game.js
git commit -m "feat(vfx): load the effect library into the game client"
```

---

## Task 9: Consume `frame.attacks` and draw the arc

**Files:**
- Modify: `frontend/src/games/something2/src/js/core/Game.js:502-508`, `:564-565`, `:586`
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js:8`, `:102`, `:170`, and a new `drawVfx` after `drawBlasts` (line 212)

**Interfaces:**
- Consumes: `frame.attacks` (Task 6), `this.vfxDefs` / `this.vfx` (Task 8), `addEffects`/`pruneEffects`/`effectProgress`/`effectAlpha`/`isoArcAngle` (Task 7), `blastScreenRadiusX` (already imported in `RenderSystem`).
- Produces: `renderChunked({ ..., vfx })`; `RenderSystem.prototype.drawVfx(effects)`.

- [ ] **Step 1: Take the attacks off the state frame**

In `Game.js` `_applyState`, beside the detonation handling (lines 503-508):

```js
        if (msg.detonations && msg.detonations.length) {
            addBlasts(this.blasts, msg.detonations, performance.now());
        }
        // Attacks are present only on the tick they happened (the server
        // clears its stash after this broadcast), so they must be taken off
        // THIS frame — there is no snapshot to re-read them from later.
        if (msg.attacks && msg.attacks.length) {
            addEffects(this.vfx, msg.attacks, performance.now(), this.vfxDefs);
        }
```

- [ ] **Step 2: Prune and pass to the renderer**

Beside the blast prune (line 565):

```js
            this.blasts = pruneBlasts(this.blasts, nowMs);
            this.vfx = pruneEffects(this.vfx, nowMs);
```

and beside `blasts: this.blasts,` in the `renderChunked` argument object (line 586):

```js
                blasts: this.blasts,
                vfx: this.vfx,
```

- [ ] **Step 3: Accept the list in `renderChunked`**

In `RenderSystem.js`, extend the destructured params (line 102):

```js
    blasts = [], ammo = null, noAmmoFlash = false, effects = null, vfx = [],
```

and call the new pass immediately after the blasts (line 170) — inside the camera transform, so effects sit above the world and below the HUD:

```js
    this.drawBlasts(blasts);
    this.drawVfx(vfx);
```

Extend the imports (line 8):

```js
import { blastProgress, blastScreenRadiusX, elementColor } from "../core/blasts.js";
import { effectProgress, effectAlpha, isoArcAngle } from "../core/vfx.js";
```

- [ ] **Step 4: Write the arc renderer**

Add after `drawBlasts` (line 212) in `RenderSystem.js`:

```js
  // Attack effects. Slice A draws one shape — `arc`, the melee swing: a wedge
  // on the iso ground plane that sweeps open from one edge of the weapon's
  // cone to the other and fades out. Radius and angular width come from the
  // EVENT (the weapon's real reach/arc_width), which is what makes a halberd
  // and a knife look different while sharing one effect row.
  //
  // Anything that is not an arc is skipped rather than drawn wrong: the other
  // four shapes are constrained in the schema now but implemented in slice B.
  drawVfx(effects) {
    if (!effects || effects.length === 0) return;
    const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
    this.ctx.save();
    for (const fx of effects) {
      if (!fx.def || fx.def.shape !== "arc") continue;
      const t = effectProgress(fx, now);
      // Same conversion as drawBlasts above — worldToScreen gives the tile
      // diamond's CENTRE, and the ISO_TILE_H/2 lift puts the swing at chest
      // height rather than flat on the ground. Do not add a further offset.
      const s = worldToScreen(fx.x, fx.y);
      const cy = s.y - ISO_TILE_H / 2;
      // A world circle projects to a 2:1 ellipse, not a circle — the same
      // ground-plane projection the blast ring uses, reused rather than
      // re-derived so the two can never disagree.
      const rx = blastScreenRadiusX(fx.reach);
      if (rx <= 0) continue;
      const half = (fx.arc || 0) / 2;
      // PARAMETRIC angle, not the world angle: see isoArcAngle.
      const phi = isoArcAngle(fx.nx, fx.ny);
      const from = phi - half;
      const to = from + (fx.arc || 0) * t;      // the sweep opens over the lifetime

      this.ctx.globalAlpha = effectAlpha(fx, now);
      this.ctx.strokeStyle = fx.def.color || "#dddddd";
      this.ctx.lineWidth = Number(fx.def.width) || 2;
      this.ctx.beginPath();
      this.ctx.ellipse(s.x, cy, rx, rx / 2, 0, from, to);
      this.ctx.stroke();
      // The two radial edges. Without them a narrow swing (a dagger: 0.6 rad
      // at reach 80) is a short stub of arc that barely reads as an attack.
      this.ctx.beginPath();
      this.ctx.moveTo(s.x, cy);
      this.ctx.lineTo(s.x + rx * Math.cos(to), cy + (rx / 2) * Math.sin(to));
      this.ctx.stroke();
    }
    this.ctx.restore();
  }
```

- [ ] **Step 5: Run the frontend suite**

Run: `cd frontend && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/src/js/core/Game.js \
        frontend/src/games/something2/src/js/systems/RenderSystem.js
git commit -m "feat(vfx): draw melee swing arcs from server attack events"
```

---

## Task 10: Verify in a real world

**Files:** none — this task produces a verification record, not code.

**Why this is a task and not a footnote:** a fully green suite has twice hidden a real defect in this repo that only appeared in the running app. Neither the wire format nor the iso projection is covered by any test that draws a pixel. Do not mark slice A done without this.

- [ ] **Step 1: Bring the stack up on current code**

```bash
docker compose up -d
docker compose exec backend npm run migrate:up
```
Then start the dev server the usual way (`make shell-backend`, `npm run dev`) and the Vite dev server.

**Rebuild the frontend bundle if you are testing against a built asset** — a stale `frontend/dist` bundle silently serving the previous build is exactly the trap that fakes a clean pass here.

- [ ] **Step 2: Confirm the wire format before looking at pixels**

Join a world, open DevTools → Network → the authority WebSocket → Messages. Swing with a melee weapon equipped.
Expected: a `state` frame containing

```json
"attacks":[{"a":"p:1","v":"sweep_arc","x":…,"y":…,"nx":…,"ny":…,"reach":80,"arc":0.6,"hit":false}]
```

If `v` is `null`, the migration's melee binding did not apply (re-check Task 1 Step 5). If there is no `attacks` key at all, the stash is not reaching the broadcast (Task 6).

- [ ] **Step 3: Verify the arc points where you aimed**

Swing in each of the four cardinal directions.
Expected: the wedge opens in the direction the character is facing, on the ground plane, in all four. A wedge consistently 45° off the aim means `isoArcAngle` was bypassed and the raw world angle reached `ctx.ellipse`.

- [ ] **Step 4: Verify weapons look different — the slice's stated done-when**

Equip a **dagger** (reach 80, arc 0.6) and swing. Then equip a **halberd** (reach 190, arc 1.8) and swing.
Expected: the halberd sweeps a visibly wider and roughly 2.4× longer wedge. If the two look identical, `follows_weapon` geometry is not reaching the renderer — check that `reach`/`arc` survive `addEffects`.

- [ ] **Step 5: Verify the effect expires**

Swing once and stop.
Expected: the wedge fades and disappears within ~0.2s, leaving no residue. A wedge that persists means `pruneEffects` is not running in the frame loop (Task 9 Step 2).

- [ ] **Step 6: Verify a second player sees it**

Open a second browser session, sign in as a different user, join the same world, and swing with the first.
Expected: the observer sees the first player's swing. This is decision 4 — server-driven, every actor — and is the one thing local prediction would have silently passed.

- [ ] **Step 7: Confirm the console is clean**

Expected: no errors or warnings from `vfx.js`, `RenderSystem.js`, or the state handler across all of the above.

- [ ] **Step 8: Run both suites one final time**

```bash
cd backend && npm test
cd ../frontend && npm test
```
Expected: PASS, no failures. Record any skips (DB-unreachable) explicitly — a skip is not a pass.

- [ ] **Step 9: Commit the verification record**

Add a short "Slice A verified" note to the Plane issue SOMET-158 listing what was checked in steps 2-7 and the two suite results. No code commit is needed if steps 1-8 required no fixes; if they did, commit those fixes with `fix(vfx): …` messages before closing.

---

## Not in this slice

Deferred deliberately — do not add them while implementing:

| | Slice |
|---|---|
| `line` / `ring` / `burst` / `bolt` shapes | B (SOMET-159) |
| Per-weapon authored effects; all 22 weapons bound | B |
| Miss/whiff feedback (the `hit` field is emitted but not drawn) | B |
| Kind-level fallback for unbound weapons | B |
| `frame.impacts`, particles, element tinting | C (SOMET-160) |
| Projectile trails; creature attacks; `entity_types.vfx` | D (SOMET-161) |
| Admin CRUD and binding dropdowns | E (SOMET-162) |
