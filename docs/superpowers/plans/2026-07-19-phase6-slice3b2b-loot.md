# Phase 6 Slice 3b-2b — Loot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Killing a creature drops items on the ground that players can see, claim (by keypress or auto-loot), and drop back out of their inventory — all server-authoritative.

**Architecture:** Two new tables (`creature_drops`, `world_items`) plus a `GroundItemSim` that mirrors `CreatureSim`'s shape but has no dirty tracking (ground items never move). Creature death is funnelled through a single `commitCreatureDeath` whose `DELETE ... RETURNING` rowCount licenses the drop roll; item claiming is funnelled through a single `claimItem` whose `DELETE ... RETURNING` rowCount picks the one winner of a contested grab.

**Tech Stack:** Node/Express + `pg` (CommonJS, `node --test`, `__setPool` mock seam), `ws` 8.21.1, node-pg-migrate, Vite/React ESM frontend (Vitest, env `node`).

**Spec:** `docs/superpowers/specs/2026-07-19-phase6-slice3b2b-loot-design.md`

## Global Constraints

- **The client sends intent only.** It never sends positions, hp, mana, damage, item stats, or asserts what it received. The server owns every mutation.
- **Every inbound wire field is validated at the message boundary.** Numbers via `finiteOr` (JSON can carry `Infinity`/`NaN` — `{"ax":1e999}` parses to `Infinity`); `itemId` must be a string; booleans via strict `=== true`.
- **Every `async` WebSocket handler must be wrapped in try/catch**, and every mutating handler serialised through the existing per-socket `ws._opChain`. An unhandled rejection kills the whole authority process on Node 20.
- **Every `setInterval` added must be cleared in `close()`**, or the process will not exit.
- **All damage still routes through `damage.js applyDamage`.** This slice adds no damage source; do not add one.
- Backend is **CommonJS**, frontend is **ESM**. Do not mix.
- Types are load-bearing: `item_types.id` and `entity_types.id` are `integer`; `world_items.id` and `player_items.id` are `uuid`; `player_items.user_id` is `text`. Mock-pool tests pass regardless — live queries do not.
- Existing tests must keep passing: backend 204, frontend 106. Do not weaken an existing assertion to accommodate new fields without saying so in the report.

---

### Task 1: Migration — `creature_drops` + `world_items`

**Files:**
- Create: `backend/migrations/1714440018000_create_loot.js`

**Interfaces:**
- Produces: tables `creature_drops(id, entity_type_id, item_type_id, chance, min_qty, max_qty, created_at)` and `world_items(id uuid, world_id, item_type_id, x, y, created_at, expires_at)`.

- [ ] **Step 1: Write the migration**

```js
exports.up = (pgm) => {
  pgm.createTable('creature_drops', {
    id: 'id',
    entity_type_id: { type: 'integer', notNull: true, references: 'entity_types', onDelete: 'CASCADE' },
    item_type_id: { type: 'integer', notNull: true, references: 'item_types', onDelete: 'CASCADE' },
    chance: { type: 'numeric', notNull: true },
    min_qty: { type: 'integer', notNull: true, default: 1 },
    max_qty: { type: 'integer', notNull: true, default: 1 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('creature_drops', 'creature_drops_chance_check', 'CHECK (chance > 0 AND chance <= 1)');
  pgm.addConstraint('creature_drops', 'creature_drops_qty_check', 'CHECK (min_qty >= 1 AND max_qty >= min_qty)');
  pgm.createIndex('creature_drops', 'entity_type_id');

  pgm.createTable('world_items', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    item_type_id: { type: 'integer', notNull: true, references: 'item_types', onDelete: 'CASCADE' },
    x: { type: 'real', notNull: true },
    y: { type: 'real', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true },
  });
  pgm.createIndex('world_items', ['world_id', 'x', 'y']);
  pgm.createIndex('world_items', 'expires_at');

  // Demo drop so the feature is exercisable on a fresh DB. Guarded: if either
  // the Wolf entity type or the dagger item type is absent this inserts
  // nothing rather than failing the migration (same posture as
  // grantStartingLoadout skipping a missing catalog name).
  pgm.sql(`
    INSERT INTO creature_drops (entity_type_id, item_type_id, chance, min_qty, max_qty)
    SELECT et.id, it.id, 0.5, 1, 1
    FROM entity_types et, item_types it
    WHERE et.name = 'Wolf' AND it.name = 'dagger'
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('world_items');
  pgm.dropTable('creature_drops');
};
```

- [ ] **Step 2: Apply and verify the round trip**

The `down()` must survive a database that has rows in both tables — that is where 3b-2a's rollback broke.

Run from `backend/`:
```bash
npm run migrate:up
docker compose exec -T db psql -U postgres -d something2 -c "\d creature_drops" -c "SELECT count(*) FROM creature_drops;"
npm run migrate:down
npm run migrate:up
```
Expected: both tables exist after the first `up`; `down` succeeds with rows present; the second `up` succeeds and re-seeds.

- [ ] **Step 3: Commit**

```bash
git add backend/migrations/1714440018000_create_loot.js
git commit -m "feat(db): creature_drops + world_items tables"
```

---

### Task 2: `GroundItemSim`

**Files:**
- Create: `backend/src/authority/groundItems.js`
- Test: `backend/tests/groundItems.test.js`

**Interfaces:**
- Consumes: `chunkOf`, `CHUNK_KEY` from `./coords`.
- Produces: `GroundItemSim` class, `PICKUP_RADIUS = 80`. Methods: `add(rows)`, `remove(id)`, `get(id)`, `nearest(x,y,radius)`, `within(x,y,radius)`, `pruneInactive(activeChunkKeys)`, `removeExpired(nowMs)`, `snapshotForNeighborhood(keys)`, `count()`.
- Row shape accepted by `add`: `{id, item_type_id, x, y, expires_at}` (DB rows) — `expires_at` may be a `Date`, an ISO string, or absent.

- [ ] **Step 1: Write the failing test**

`backend/tests/groundItems.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { GroundItemSim, PICKUP_RADIUS } = require('../src/authority/groundItems');

const CHUNK = 64; // chunk_size; chunk span = 64 * 100 = 6400px

function rows(...specs) {
  return specs.map(([id, x, y, typeId = 1, expires = '2999-01-01T00:00:00Z']) =>
    ({ id, x, y, item_type_id: typeId, expires_at: expires }));
}

test('PICKUP_RADIUS matches the dagger reach', () => {
  assert.strictEqual(PICKUP_RADIUS, 80);
});

test('add dedups by id and normalizes fields', () => {
  const sim = new GroundItemSim(CHUNK);
  sim.add(rows(['a', 100, 200, 7]));
  sim.add(rows(['a', 999, 999, 9])); // same id -> ignored
  assert.strictEqual(sim.count(), 1);
  assert.deepStrictEqual(
    { ...sim.get('a'), expiresAt: undefined },
    { id: 'a', typeId: 7, x: 100, y: 200, expiresAt: undefined },
  );
});

test('nearest returns the closest within radius, null beyond it', () => {
  const sim = new GroundItemSim(CHUNK);
  sim.add(rows(['far', 100, 170], ['near', 100, 140], ['out', 100, 300]));
  assert.strictEqual(sim.nearest(100, 100, PICKUP_RADIUS).id, 'near');
  assert.strictEqual(sim.nearest(100, 100, 10), null);
});

test('within returns every item in range', () => {
  const sim = new GroundItemSim(CHUNK);
  sim.add(rows(['a', 100, 140], ['b', 100, 170], ['c', 100, 300]));
  const ids = sim.within(100, 100, PICKUP_RADIUS).map((i) => i.id).sort();
  assert.deepStrictEqual(ids, ['a', 'b']);
});

test('pruneInactive drops items outside the active chunk set', () => {
  const sim = new GroundItemSim(CHUNK);
  sim.add(rows(['keep', 100, 100], ['drop', 20000, 20000]));
  const dropped = sim.pruneInactive(new Set(['0,0']));
  assert.strictEqual(dropped, 1);
  assert.strictEqual(sim.get('keep').id, 'keep');
  assert.strictEqual(sim.get('drop'), null);
});

test('removeExpired removes only expired items and returns their ids', () => {
  const sim = new GroundItemSim(CHUNK);
  sim.add(rows(['old', 100, 100, 1, '2000-01-01T00:00:00Z'], ['new', 120, 120]));
  const removed = sim.removeExpired(Date.parse('2020-01-01T00:00:00Z'));
  assert.deepStrictEqual(removed, ['old']);
  assert.strictEqual(sim.count(), 1);
});

test('snapshotForNeighborhood emits only in-neighborhood items, wire shape only', () => {
  const sim = new GroundItemSim(CHUNK);
  sim.add(rows(['in', 100, 100, 3], ['out', 20000, 20000, 3]));
  const snap = sim.snapshotForNeighborhood(['0,0']);
  assert.deepStrictEqual(snap, [{ id: 'in', typeId: 3, x: 100, y: 100 }]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run from `backend/`: `node --test tests/groundItems.test.js`
Expected: FAIL — `Cannot find module '../src/authority/groundItems'`.

- [ ] **Step 3: Implement**

`backend/src/authority/groundItems.js`:
```js
// Ground items: dropped loot lying in the world. Deliberately mirrors
// CreatureSim's surface so the two read alike — but a ground item's position
// never changes, so there is no dirty set and no confirm-before-drop. Its only
// mutable property is existence, and the database already records that.

const { chunkOf, CHUNK_KEY } = require('./coords');

const PICKUP_RADIUS = 80; // == the dagger's seeded reach: you can only loot what you could hit

class GroundItemSim {
  constructor(chunkSize) {
    this.chunkSize = chunkSize;
    this.items = new Map(); // id -> {id, typeId, x, y, expiresAt}
  }

  add(rows) {
    for (const r of rows || []) {
      if (r == null || r.id == null) continue;
      if (this.items.has(r.id)) continue; // dedup: a re-activated chunk re-SELECTs rows already held
      const expires = r.expires_at != null ? r.expires_at : r.expiresAt;
      this.items.set(r.id, {
        id: r.id,
        typeId: r.item_type_id != null ? r.item_type_id : r.typeId,
        x: Number(r.x),
        y: Number(r.y),
        expiresAt: expires != null ? new Date(expires).getTime() : Infinity,
      });
    }
  }

  remove(id) { return this.items.delete(id); }
  get(id) { return this.items.get(id) || null; }
  count() { return this.items.size; }

  within(x, y, radius) {
    const r2 = radius * radius;
    const out = [];
    for (const it of this.items.values()) {
      const dx = it.x - x, dy = it.y - y;
      if (dx * dx + dy * dy <= r2) out.push(it);
    }
    return out;
  }

  nearest(x, y, radius) {
    const r2 = radius * radius;
    let best = null, bestD = Infinity;
    for (const it of this.items.values()) {
      const dx = it.x - x, dy = it.y - y;
      const d = dx * dx + dy * dy;
      if (d <= r2 && d < bestD) { bestD = d; best = it; }
    }
    return best;
  }

  // Forget items whose chunk left the active set. Safe to drop unconditionally:
  // the DB row is untouched and a later activateChunk re-SELECTs it.
  pruneInactive(activeChunkKeys) {
    const active = activeChunkKeys instanceof Set ? activeChunkKeys : new Set(activeChunkKeys);
    let dropped = 0;
    for (const [id, it] of this.items) {
      const { cx, cy } = chunkOf(it.x, it.y, this.chunkSize);
      if (active.has(CHUNK_KEY(cx, cy))) continue;
      this.items.delete(id);
      dropped++;
    }
    return dropped;
  }

  removeExpired(nowMs) {
    const removed = [];
    for (const [id, it] of this.items) {
      if (it.expiresAt <= nowMs) { this.items.delete(id); removed.push(id); }
    }
    return removed;
  }

  snapshotForNeighborhood(keys) {
    const set = keys instanceof Set ? keys : new Set(keys);
    const out = [];
    for (const it of this.items.values()) {
      const { cx, cy } = chunkOf(it.x, it.y, this.chunkSize);
      if (set.has(CHUNK_KEY(cx, cy))) out.push({ id: it.id, typeId: it.typeId, x: it.x, y: it.y });
    }
    return out;
  }
}

module.exports = { GroundItemSim, PICKUP_RADIUS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/groundItems.test.js`
Expected: PASS, 7/7.

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/groundItems.js backend/tests/groundItems.test.js
git commit -m "feat(authority): GroundItemSim (AOI store for dropped loot)"
```

---

### Task 3: Drop roll

**Files:**
- Create: `backend/src/authority/loot.js`
- Test: `backend/tests/loot.test.js`

**Interfaces:**
- Produces: `rollDrops(dropRows, rng)` → `number[]` of `item_type_id`s, one entry per unit of quantity.
- **Note:** `loot.js` is the home for the whole loot domain, not just this function. Tasks 5, 7 and 9 add `commitCreatureDeath`, `spawnDrops`, `claimItem` and `dropItem` here. They take `pool` and an `entry`-shaped object as arguments rather than closing over `attachAuthority`'s scope, which keeps them directly unit-testable with the existing `fakePool` pattern and keeps `server.js` (already the largest file in the authority) from growing further.
- `dropRows` shape: `[{item_type_id, chance, min_qty, max_qty}]` as SELECTed from `creature_drops`. `chance` arrives from `pg` as a **string** for `numeric` columns — the implementation must `Number()` it.

- [ ] **Step 1: Write the failing test**

`backend/tests/loot.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { rollDrops } = require('../src/authority/loot');

// Deterministic rng returning a scripted sequence.
function seq(...vals) { let i = 0; return () => (i < vals.length ? vals[i++] : 0); }

test('no drop rows yields nothing', () => {
  assert.deepStrictEqual(rollDrops([], seq(0)), []);
  assert.deepStrictEqual(rollDrops(undefined, seq(0)), []);
});

test('chance 1 always drops', () => {
  const rows = [{ item_type_id: 5, chance: '1', min_qty: 1, max_qty: 1 }];
  assert.deepStrictEqual(rollDrops(rows, seq(0.999, 0)), [5]);
});

test('chance 0.5 respects the rng on both sides', () => {
  const rows = [{ item_type_id: 5, chance: '0.5', min_qty: 1, max_qty: 1 }];
  assert.deepStrictEqual(rollDrops(rows, seq(0.4, 0)), [5], 'roll under chance drops');
  assert.deepStrictEqual(rollDrops(rows, seq(0.5, 0)), [], 'roll at chance does not drop');
  assert.deepStrictEqual(rollDrops(rows, seq(0.9, 0)), [], 'roll over chance does not drop');
});

test('quantity spans min..max inclusive', () => {
  const rows = [{ item_type_id: 7, chance: '1', min_qty: 2, max_qty: 4 }];
  assert.deepStrictEqual(rollDrops(rows, seq(0, 0)), [7, 7], 'rng 0 -> min');
  assert.deepStrictEqual(rollDrops(rows, seq(0, 0.999)), [7, 7, 7, 7], 'rng ~1 -> max');
});

test('each row rolls independently', () => {
  const rows = [
    { item_type_id: 1, chance: '1', min_qty: 1, max_qty: 1 },
    { item_type_id: 2, chance: '0.1', min_qty: 1, max_qty: 1 },
    { item_type_id: 3, chance: '1', min_qty: 1, max_qty: 1 },
  ];
  // row1: drop(0) qty(0) | row2: 0.9 -> skip | row3: drop(0) qty(0)
  assert.deepStrictEqual(rollDrops(rows, seq(0, 0, 0.9, 0, 0)), [1, 3]);
});

test('malformed quantities degrade to a single drop rather than throwing', () => {
  const rows = [{ item_type_id: 9, chance: '1', min_qty: null, max_qty: null }];
  assert.deepStrictEqual(rollDrops(rows, seq(0, 0)), [9]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/loot.test.js`
Expected: FAIL — `Cannot find module '../src/authority/loot'`.

- [ ] **Step 3: Implement**

`backend/src/authority/loot.js`:
```js
// Drop-table rolling. Pure and rng-injectable so drops are deterministic under
// test; the caller supplies the rows and performs the INSERTs.

// Roll each drop row independently. Returns one item_type_id per unit of
// quantity (no stacking this slice — every drop is its own instance).
function rollDrops(dropRows, rng = Math.random) {
  const out = [];
  for (const row of dropRows || []) {
    // `chance` is a numeric column, which pg returns as a string.
    const chance = Number(row.chance);
    if (!Number.isFinite(chance) || chance <= 0) continue;
    if (rng() >= chance) continue;
    const min = Math.max(1, Number(row.min_qty) || 1);
    const max = Math.max(min, Number(row.max_qty) || min);
    const qty = min + Math.floor(rng() * (max - min + 1));
    for (let i = 0; i < qty; i++) out.push(row.item_type_id);
  }
  return out;
}

module.exports = { rollDrops };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/loot.test.js`
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/loot.js backend/tests/loot.test.js
git commit -m "feat(authority): drop-table roll (pure, rng-injectable)"
```

---

### Task 4: `World` composes ground items + auto-loot flag

**Files:**
- Modify: `backend/src/authority/world.js`
- Test: `backend/tests/world.test.js` (append)

**Interfaces:**
- Consumes: `GroundItemSim` from Task 2.
- Produces: `World` constructor gains a 4th parameter `chunkSize` (default 64); `world.groundItems` is a `GroundItemSim`; each player state gains `autoLoot: false`; `world.setAutoLoot(userId, on)`.
- The `World` constructor is currently `new World(map, weaponsById, defaultWeaponId)` and is called in `server.js` `loadWorld`. Adding a defaulted 4th parameter keeps every existing call and test valid.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/world.test.js`:
```js
test('world exposes a ground item sim sized to the chunk', () => {
  const w = new World(stubMap(), new Map(), null, 32);
  assert.strictEqual(w.groundItems.chunkSize, 32);
  assert.strictEqual(w.groundItems.count(), 0);
});

test('autoLoot defaults off and toggles strictly', () => {
  const w = new World(stubMap(), new Map(), null, 64);
  w.addPlayer('u1', { x: 0, y: 0 });
  assert.strictEqual(w.getPlayer('u1').autoLoot, false);
  w.setAutoLoot('u1', true);
  assert.strictEqual(w.getPlayer('u1').autoLoot, true);
  w.setAutoLoot('u1', 'yes'); // non-boolean -> false, never truthy-coerced
  assert.strictEqual(w.getPlayer('u1').autoLoot, false);
  w.setAutoLoot('nobody', true); // unknown player must not throw
});
```

Use whatever map stub the existing tests in this file already use; if it is inline rather than a `stubMap()` helper, follow the existing pattern instead of introducing one.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/world.test.js`
Expected: FAIL — `w.groundItems` is undefined.

- [ ] **Step 3: Implement**

In `backend/src/authority/world.js`, add the import:
```js
const { GroundItemSim } = require('./groundItems');
```

Change the constructor signature and body:
```js
  constructor(map, weaponsById = new Map(), defaultWeaponId = null, chunkSize = 64) {
    this.map = map;
    this.players = new Map(); // userId -> state
    this.creatures = new CreatureSim(map);
    this.weapons = weaponsById;
    this.defaultWeaponId = defaultWeaponId;
    this.projectiles = new ProjectileSim();
    this.groundItems = new GroundItemSim(chunkSize);
  }
```

In `addPlayer`, add `autoLoot: false,` to the player state object (put it next to `_attackCd`).

Add the setter after `setInput`:
```js
  // Strict boolean: a truthy string from the wire must not enable auto-loot.
  setAutoLoot(userId, on) {
    const p = this.players.get(userId);
    if (!p) return;
    p.autoLoot = on === true;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/world.test.js`
Expected: PASS, including the pre-existing tests in the file.

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/world.js backend/tests/world.test.js
git commit -m "feat(authority): World owns the ground item sim + per-player auto-loot flag"
```

---

### Task 5: The death-commit funnel

**Files:**
- Modify: `backend/src/authority/server.js`
- Test: `backend/tests/authorityLoot.test.js` (create)

**Interfaces:**
- Consumes: `rollDrops` (Task 3), `entry.world.groundItems` (Task 4).
- Produces: `commitCreatureDeath(entry, creatureId)` and `spawnDrops(entry, dead)` inside `attachAuthority`; `entry.creatureTypeIds` (a `Map<name, id>`); `attachAuthority` opts gain `groundItemTtlMs` (default 600000) and `rng` (default `Math.random`).

**Context:** `world_creatures.type` stores the entity type's **name**, while `creature_drops` keys on `entity_type_id`. `loadWorld` already SELECTs the creature types, so extend that query with `id` and build a name→id map — the resolution then costs no extra query.

- [ ] **Step 1: Add the opts and the name→id map**

In `attachAuthority`, next to the other opts:
```js
  const groundItemTtlMs = opts.groundItemTtlMs || 600000; // 10 min
  const itemSweepMs = opts.itemSweepMs || 60000;
  const rng = opts.rng || Math.random;
```

Add the import at the top of the file:
```js
const { rollDrops } = require('./loot');
```

In `loadWorld`, change the creature-type query and build the map:
```js
        const cr = await pool.query('SELECT id, name, color, hp FROM entity_types WHERE is_creature = true ORDER BY id ASC');
        const creatureTypes = cr.rows.map((r) => ({ name: r.name, hp: r.hp, color: r.color }));
        const creatureTypeIds = new Map(cr.rows.map((r) => [r.name, r.id]));
```
and add `creatureTypeIds,` to the `entry` object literal (next to `creatureTypes,`), and pass the chunk size to the World:
```js
          worldId, world: new World(map, itemTypes, defaultWeaponId, row.chunk_size), row, sockets: new Map(),
```

- [ ] **Step 2: Write the failing test**

`backend/tests/authorityLoot.test.js`. The scripted pool below routes by SQL and records every call; reuse it in Tasks 7 and 9 too.

```js
const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');
const { commitCreatureDeath } = require('../src/authority/loot.js');

// Routes queries by SQL pattern and records every call, so a test can assert
// that a query NEVER ran — which is the point of the rowCount guard.
function scriptedPool(routes = []) {
  const calls = [];
  return {
    calls,
    matching(re) { return calls.filter((c) => re.test(c.sql)); },
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const [re, result] of routes) {
        if (re.test(sql)) return typeof result === 'function' ? result(params) : result;
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function armEntry() {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  return {
    worldId: 'w1',
    world: new World(map, new Map(), null, 8),
    creatureTypeIds: new Map([['Wolf', 42]]),
  };
}

const DROP_ROW = { item_type_id: 7, chance: '1', min_qty: 1, max_qty: 1 };
const always = () => 0; // rng: always rolls under chance, always min qty

test('a death whose DELETE affects no row rolls NO drops', async () => {
  const entry = armEntry();
  const pool = scriptedPool([
    [/DELETE FROM world_creatures/i, { rows: [], rowCount: 0 }], // already finalized elsewhere
    [/FROM creature_drops/i, { rows: [DROP_ROW], rowCount: 1 }],
  ]);

  await commitCreatureDeath(pool, entry, 'c1', { rng: always, ttlMs: 1000 });

  assert.strictEqual(pool.matching(/FROM creature_drops/i).length, 0, 'must not even look up the drop table');
  assert.strictEqual(pool.matching(/INSERT INTO world_items/i).length, 0, 'must not spawn loot');
  assert.strictEqual(entry.world.groundItems.count(), 0);
});

test('a death whose DELETE affects one row drops loot at the corpse position', async () => {
  const entry = armEntry();
  const pool = scriptedPool([
    [/DELETE FROM world_creatures/i, { rows: [{ type: 'Wolf', x: 500, y: 600 }], rowCount: 1 }],
    [/FROM creature_drops/i, { rows: [DROP_ROW], rowCount: 1 }],
    [/INSERT INTO world_items/i, (p) => ({
      rows: [{ id: 'g1', item_type_id: p[1], x: p[2], y: p[3], expires_at: '2999-01-01T00:00:00Z' }],
      rowCount: 1,
    })],
  ]);

  await commitCreatureDeath(pool, entry, 'c1', { rng: always, ttlMs: 1000 });

  const inserts = pool.matching(/INSERT INTO world_items/i);
  assert.strictEqual(inserts.length, 1);
  assert.deepStrictEqual(inserts[0].params.slice(0, 4), ['w1', 7, 500, 600]);
  assert.strictEqual(entry.world.groundItems.count(), 1, 'lands in the sim for the next broadcast');
  assert.deepStrictEqual(entry.world.groundItems.get('g1').x, 500);
});

test('an unknown creature type drops nothing and does not throw', async () => {
  const entry = armEntry();
  const pool = scriptedPool([
    [/DELETE FROM world_creatures/i, { rows: [{ type: 'Ghost', x: 0, y: 0 }], rowCount: 1 }],
  ]);
  await commitCreatureDeath(pool, entry, 'c1', { rng: always, ttlMs: 1000 });
  assert.strictEqual(pool.matching(/INSERT INTO world_items/i).length, 0);
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node --test tests/authorityLoot.test.js`
Expected: FAIL — `commitCreatureDeath` is not exported from `loot.js`.

- [ ] **Step 4: Implement the funnel in `loot.js`**

Append to `backend/src/authority/loot.js`:
```js
// The single authoritative creature-death commit. rowCount === 1 means THIS
// call finalized the death, which is what licenses the drop roll: two damage
// sources reporting the same creature id in one tick cannot double-drop, and a
// death that fails to persist drops nothing (so the DB never disagrees with
// what players received). Any future kill site must route through here.
async function commitCreatureDeath(pool, entry, creatureId, { rng = Math.random, ttlMs = 600000 } = {}) {
  const r = await pool.query(
    'DELETE FROM world_creatures WHERE id = $1 RETURNING type, x, y', [creatureId],
  );
  if (r.rowCount !== 1) return;
  await spawnDrops(pool, entry, r.rows[0], { rng, ttlMs });
}

async function spawnDrops(pool, entry, dead, { rng = Math.random, ttlMs = 600000 } = {}) {
  // world_creatures.type stores the entity type NAME; creature_drops keys on
  // entity_type_id. entry.creatureTypeIds is built at world load, so this costs
  // no query. An unknown name yields no drops rather than throwing.
  const entityTypeId = entry.creatureTypeIds.get(dead.type);
  if (entityTypeId == null) return;
  const dr = await pool.query(
    'SELECT item_type_id, chance, min_qty, max_qty FROM creature_drops WHERE entity_type_id = $1',
    [entityTypeId],
  );
  for (const itemTypeId of rollDrops(dr.rows, rng)) {
    const ins = await pool.query(
      `INSERT INTO world_items (world_id, item_type_id, x, y, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5::int * interval '1 millisecond'))
       RETURNING id, item_type_id, x, y, expires_at`,
      [entry.worldId, itemTypeId, dead.x, dead.y, ttlMs],
    );
    // Straight into the sim so it appears in the next AOI broadcast rather than
    // waiting for a chunk reload.
    entry.world.groundItems.add(ins.rows);
  }
}

module.exports = { rollDrops, commitCreatureDeath, spawnDrops };
```
(Replace the existing `module.exports = { rollDrops };` line — do not leave two.)

- [ ] **Step 5: Route both kill sites through it**

Change the import at the top of `server.js` to:
```js
const { commitCreatureDeath } = require('./loot');
```
(`rollDrops` is no longer needed in `server.js` — `loot.js` uses it internally.)

Add one wrapper inside `attachAuthority` so the options are named once rather than at each call site:
```js
  const onCreatureDeath = (entry, id) =>
    commitCreatureDeath(pool, entry, id, { rng, ttlMs: groundItemTtlMs })
      .catch((err) => console.error('death commit failed:', err));
```

Replace the melee kill site in the `attack` handler:
```js
          for (const id of new Set(killedCreatureIds)) onCreatureDeath(entry, id);
```

Replace the projectile kill site in the tick loop:
```js
      for (const id of new Set(killedByProjectiles)) onCreatureDeath(entry, id);
```

Both keep the fire-and-forget shape (the tick must not await), but the `.catch` is now mandatory and logs — an unhandled rejection here would kill the process.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test` (whole backend suite)
Expected: PASS — the new file plus all 204 pre-existing tests.

- [ ] **Step 7: Commit**

```bash
git add backend/src/authority/server.js backend/tests/authorityLoot.test.js
git commit -m "feat(authority): single death-commit funnel; rowCount licenses the drop roll"
```

---

### Task 6: Chunk lifecycle — load, prune, sweep

**Files:**
- Modify: `backend/src/authority/server.js`

**Interfaces:**
- Consumes: `entry.world.groundItems`, `itemSweepMs` (Task 5).
- Produces: ground items loaded on chunk activation, pruned with the chunk, and swept on expiry.

- [ ] **Step 1: Load ground items in `activateChunk`**

In `activateChunk`, immediately after `entry.world.creatures.addCreatures(rows.rows);` and before `entry.loadedChunks.add(chunkKey);`:
```js
      const itemRows = await pool.query(
        `SELECT id, item_type_id, x, y, expires_at FROM world_items
         WHERE world_id = $1 AND x >= $2 AND x < $3 AND y >= $4 AND y < $5 AND expires_at > now()`,
        [entry.worldId, cx * span, cx * span + span, cy * span, cy * span + span],
      );
      entry.world.groundItems.add(itemRows.rows);
```
This sits inside the existing try/catch, so a failure leaves the chunk out of `loadedChunks` and `recomputeActive` retries it — same posture as the creature load.

- [ ] **Step 2: Prune with the chunk**

In `flushAndPrune`, after `entry.world.creatures.pruneInactive(entry.activeChunks);`:
```js
    entry.world.groundItems.pruneInactive(entry.activeChunks);
```
No confirm-before-drop is needed: unlike creatures there is no unpersisted state to lose.

- [ ] **Step 3: Add the sweep interval**

After the `heartbeatTimer` declaration:
```js
  // Expired ground items: delete from the DB and evict from every live sim.
  const itemSweepTimer = setInterval(() => {
    if (worlds.size === 0) return;
    pool.query('DELETE FROM world_items WHERE expires_at <= now() RETURNING id')
      .then((r) => {
        if (!r.rowCount) return;
        const ids = new Set(r.rows.map((row) => row.id));
        for (const entry of worlds.values()) {
          for (const id of ids) entry.world.groundItems.remove(id);
        }
      })
      .catch((err) => console.error('ground item sweep failed:', err));
  }, itemSweepMs);
```

- [ ] **Step 4: Clear it in `close()`**

In the returned `close()`, alongside the other `clearInterval` calls:
```js
      clearInterval(itemSweepTimer);
```
An uncleared interval keeps the event loop alive and hangs the test process — this is why every other timer here is cleared.

- [ ] **Step 5: Verify the suite still passes**

Run from `backend/`: `node --test`
Expected: PASS, no hang on exit. If the suite hangs, the interval is not being cleared.

- [ ] **Step 6: Commit**

```bash
git add backend/src/authority/server.js
git commit -m "feat(authority): ground items load with their chunk, prune with it, sweep on expiry"
```

---

### Task 7: The claim path + `pickup`

**Files:**
- Modify: `backend/src/authority/server.js`
- Test: `backend/tests/authorityLoot.test.js` (append)

**Interfaces:**
- Consumes: `PICKUP_RADIUS` from `./groundItems`, `entry.claiming`.
- Produces: `claimItem(entry, userId, groundItemId)` → `{id, typeId} | null`; inbound `pickup{}`; outbound `picked{item}`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/authorityLoot.test.js` (reusing `scriptedPool` and `armEntry` from Task 5):

```js
const { claimItem } = require('../src/authority/loot.js');

function armClaimEntry() {
  const entry = armEntry();
  entry.claiming = new Set();
  entry.world.addPlayer('u1', { x: 0, y: 0 }, { items: [], equipment: {} });
  entry.world.groundItems.add([{ id: 'g1', item_type_id: 7, x: 10, y: 10, expires_at: '2999-01-01T00:00:00Z' }]);
  return entry;
}

test('two claims of one item yield exactly one player_items INSERT', async () => {
  const entry = armClaimEntry();
  let deletes = 0;
  const pool = scriptedPool([
    // First DELETE wins, every later one finds the row already gone. This is
    // exactly what Postgres does when two sessions race the same row.
    [/DELETE FROM world_items/i, () => (++deletes === 1
      ? { rows: [{ item_type_id: 7 }], rowCount: 1 }
      : { rows: [], rowCount: 0 })],
    [/INSERT INTO player_items/i, { rows: [{ id: 'inst-1' }], rowCount: 1 }],
  ]);

  const first = await claimItem(pool, entry, 'u1', 'g1');
  const second = await claimItem(pool, entry, 'u1', 'g1');

  assert.deepStrictEqual(first, { id: 'inst-1', typeId: 7 });
  assert.strictEqual(second, null, 'the loser gets nothing');
  assert.strictEqual(pool.matching(/INSERT INTO player_items/i).length, 1, 'the item is granted exactly once');
  assert.strictEqual(entry.world.groundItems.get('g1'), null, 'gone from the sim either way');
});

test('a failed player_items INSERT destroys the item rather than duplicating it', async () => {
  const entry = armClaimEntry();
  const pool = scriptedPool([
    [/DELETE FROM world_items/i, { rows: [{ item_type_id: 7 }], rowCount: 1 }],
    [/INSERT INTO player_items/i, () => { throw new Error('db down'); }],
  ]);

  const got = await claimItem(pool, entry, 'u1', 'g1');

  assert.strictEqual(got, null);
  assert.strictEqual(entry.world.groundItems.get('g1'), null, 'the world row is already gone; do not resurrect it');
  assert.strictEqual(entry.world.getPlayer('u1').inv.items.length, 0, 'and the player did not get it');
});

test('a successful claim adds the instance to the in-memory inventory', async () => {
  const entry = armClaimEntry();
  const pool = scriptedPool([
    [/DELETE FROM world_items/i, { rows: [{ item_type_id: 7 }], rowCount: 1 }],
    [/INSERT INTO player_items/i, { rows: [{ id: 'inst-1' }], rowCount: 1 }],
  ]);
  await claimItem(pool, entry, 'u1', 'g1');
  assert.deepStrictEqual(entry.world.getPlayer('u1').inv.items, [{ id: 'inst-1', typeId: 7 }]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/authorityLoot.test.js`
Expected: FAIL — `claimItem` is not exported from `loot.js`.

- [ ] **Step 3: Implement the claim in `loot.js`**

Add `entry.claiming = new Set()` to the `entry` object literal in `server.js`'s `loadWorld`.

Append to `backend/src/authority/loot.js` (and add `claimItem` to its `module.exports`):
```js
// The single claim path, shared by the keypress and auto-loot. The
// DELETE ... RETURNING is the race resolution: two players grabbing the same
// item in one tick both issue it, Postgres serialises them, and exactly one
// gets rowCount 1. Correct without any in-memory lock — `claiming` only
// avoids wasted queries.
async function claimItem(pool, entry, userId, groundItemId) {
    if (entry.claiming.has(groundItemId)) return null;
    entry.claiming.add(groundItemId);
    try {
      const del = await pool.query(
        'DELETE FROM world_items WHERE id = $1 RETURNING item_type_id', [groundItemId],
      );
      if (del.rowCount !== 1) {
        entry.world.groundItems.remove(groundItemId); // stale row, evict
        return null;
      }
      const typeId = del.rows[0].item_type_id;
      // Ordering matters: the world row is already gone, so if this INSERT
      // throws the item is destroyed rather than duplicated. Losing one drop
      // is the acceptable failure; duplicating it is not.
      let instanceId = null;
      try {
        const ins = await pool.query(
          'INSERT INTO player_items (user_id, item_type_id) VALUES ($1, $2) RETURNING id',
          [userId, typeId],
        );
        instanceId = ins.rows[0].id;
      } catch (err) {
        console.error('claim lost the item (player_items insert failed):', err);
        entry.world.groundItems.remove(groundItemId);
        return null;
      }
      entry.world.groundItems.remove(groundItemId);
      const p = entry.world.getPlayer(userId);
      if (p && p.inv) p.inv.items.push({ id: instanceId, typeId }); // so a later equip validates without a reload
      return { id: instanceId, typeId };
    } finally {
      entry.claiming.delete(groundItemId);
    }
  }
```

- [ ] **Step 4: Add the `pickup` handler**

Add these imports at the top of `server.js`:
```js
const { PICKUP_RADIUS } = require('./groundItems');
```
and extend the `loot` import to `const { commitCreatureDeath, claimItem } = require('./loot');`.

In the `ws.on('message')` chain, after the `equip`/`unequip` block:
```js
      if (msg.type === 'pickup') {
        const entry = worlds.get(ws.worldId);
        if (!entry) return;
        // Same per-socket serialisation and try/catch as equip: an unhandled
        // rejection in an async ws handler kills the process on Node 20.
        ws._opChain = (ws._opChain || Promise.resolve()).then(async () => {
          try {
            const p = entry.world.getPlayer(ws.userId);
            if (!p) return;
            const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
            const target = entry.world.groundItems.nearest(cx, cy, PICKUP_RADIUS);
            if (!target) return; // nothing in range: silent no-op, not an error
            const got = await claimItem(pool, entry, ws.userId, target.id);
            if (got) send(ws, { type: 'picked', item: got });
          } catch (err) {
            console.error('pickup failed:', err);
          }
        });
        return;
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test`
Expected: PASS, all files.

- [ ] **Step 6: Commit**

```bash
git add backend/src/authority/server.js backend/tests/authorityLoot.test.js
git commit -m "feat(authority): atomic ground-item claim + pickup message"
```

---

### Task 8: Auto-loot

**Files:**
- Modify: `backend/src/authority/server.js`

**Interfaces:**
- Consumes: `world.setAutoLoot` (Task 4), `claimItem` (Task 7), `groundItems.within`.
- Produces: inbound `autoloot{on}`; auto-claiming in the tick loop.

- [ ] **Step 1: Add the message handler**

After the `pickup` block:
```js
      if (msg.type === 'autoloot') {
        const entry = worlds.get(ws.worldId);
        // Strict boolean — a truthy string from the wire must not enable it.
        if (entry) entry.world.setAutoLoot(ws.userId, msg.on === true);
        return;
      }
```

- [ ] **Step 2: Auto-claim in the tick**

In the tick loop, immediately after `entry.world.resolveDeaths();`:
```js
      // Auto-loot: fire claims off-tick. The tick is synchronous and must never
      // await; `claiming` de-dups the repeats this produces across ticks while
      // a claim is still in flight.
      for (const p of entry.world.players.values()) {
        if (!p.autoLoot) continue;
        const pcx = p.x + p.width / 2, pcy = p.y + p.height / 2;
        for (const it of entry.world.groundItems.within(pcx, pcy, PICKUP_RADIUS)) {
          const sock = entry.sockets.get(p.userId);
          claimItem(pool, entry, p.userId, it.id)
            .then((got) => { if (got && sock) send(sock, { type: 'picked', item: got }); })
            .catch((err) => console.error('auto-loot failed:', err));
        }
      }
```

Note the `claiming` guard is what makes this safe: without it, a 20Hz tick would issue a fresh DELETE for the same item every tick until the first resolved.

- [ ] **Step 3: Verify**

Run: `node --test`
Expected: PASS, 204+ tests.

- [ ] **Step 4: Commit**

```bash
git add backend/src/authority/server.js
git commit -m "feat(authority): server-side auto-loot flag + tick claiming"
```

---

### Task 9: `drop` — inventory back to the ground

**Files:**
- Modify: `backend/src/authority/server.js`
- Test: `backend/tests/authorityLoot.test.js` (append)

**Interfaces:**
- Produces: inbound `drop{itemId}`; outbound `dropped{itemId}`.

**Interfaces (revised):** `dropItem(pool, entry, userId, itemId, {ttlMs})` lives in `loot.js` and returns `{ok:true, item}` or `{ok:false, reason}`. The handler in `server.js` only does wire validation, serialisation and the reply.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/authorityLoot.test.js`:
```js
const { dropItem } = require('../src/authority/loot.js');

function armDropEntry(equipment = {}) {
  const entry = armEntry();
  entry.world.addPlayer('u1', { x: 300, y: 400 }, { items: [{ id: 'i1', typeId: 7 }], equipment });
  return entry;
}

test('dropping an equipped item is rejected and touches no table', async () => {
  const entry = armDropEntry({ main_hand: 'i1' });
  const pool = scriptedPool();

  const r = await dropItem(pool, entry, 'u1', 'i1', { ttlMs: 1000 });

  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /unequip/i);
  assert.strictEqual(pool.matching(/DELETE FROM player_items/i).length, 0, 'must not delete the instance');
  assert.strictEqual(pool.matching(/INSERT INTO world_items/i).length, 0, 'must not spawn a ground item');
  assert.strictEqual(entry.world.getPlayer('u1').inv.items.length, 1, 'still owned');
});

test("dropping another user's item deletes nothing and spawns nothing", async () => {
  const entry = armDropEntry();
  // The user_id predicate matches no row -> rowCount 0.
  const pool = scriptedPool([[/DELETE FROM player_items/i, { rows: [], rowCount: 0 }]]);

  const r = await dropItem(pool, entry, 'u1', 'not-mine', { ttlMs: 1000 });

  assert.strictEqual(r.ok, false);
  assert.strictEqual(pool.matching(/INSERT INTO world_items/i).length, 0);
});

test('a successful drop spawns a ground item at the player centre and removes the instance', async () => {
  const entry = armDropEntry();
  const pool = scriptedPool([
    [/DELETE FROM player_items/i, { rows: [{ item_type_id: 7 }], rowCount: 1 }],
    [/INSERT INTO world_items/i, (p) => ({
      rows: [{ id: 'g9', item_type_id: p[1], x: p[2], y: p[3], expires_at: '2999-01-01T00:00:00Z' }],
      rowCount: 1,
    })],
  ]);

  const r = await dropItem(pool, entry, 'u1', 'i1', { ttlMs: 1000 });

  assert.strictEqual(r.ok, true);
  const p = entry.world.getPlayer('u1');
  const ins = pool.matching(/INSERT INTO world_items/i)[0];
  assert.deepStrictEqual(ins.params.slice(0, 4), ['w1', 7, p.x + p.width / 2, p.y + p.height / 2]);
  assert.strictEqual(entry.world.groundItems.count(), 1);
  assert.strictEqual(p.inv.items.length, 0, 'no longer owned');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/authorityLoot.test.js`
Expected: FAIL — `dropItem` is not exported from `loot.js`.

- [ ] **Step 3: Implement `dropItem` in `loot.js`**

Append (and add `dropItem` to `module.exports`):
```js
async function dropItem(pool, entry, userId, itemId, { ttlMs = 600000 } = {}) {
  const p = entry.world.getPlayer(userId);
  if (!p || !p.inv) return { ok: false, reason: 'no player' };

  // Guard: dropping an equipped instance would delete the row while a
  // player_equipment row still references it, leaving a dangling paper-doll
  // entry.
  if (Object.values(p.inv.equipment).includes(itemId)) {
    return { ok: false, reason: 'unequip it first' };
  }

  // The user_id predicate IS the ownership check — a forged itemId naming
  // someone else's item deletes nothing.
  const del = await pool.query(
    'DELETE FROM player_items WHERE id = $1 AND user_id = $2 RETURNING item_type_id',
    [itemId, userId],
  );
  if (del.rowCount !== 1) return { ok: false, reason: 'you do not own that item' };

  const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
  const ins = await pool.query(
    `INSERT INTO world_items (world_id, item_type_id, x, y, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5::int * interval '1 millisecond'))
     RETURNING id, item_type_id, x, y, expires_at`,
    [entry.worldId, del.rows[0].item_type_id, cx, cy, ttlMs],
  );
  entry.world.groundItems.add(ins.rows);
  p.inv.items = p.inv.items.filter((it) => it.id !== itemId);
  return { ok: true, item: ins.rows[0] };
}
```

- [ ] **Step 4: Add the handler**

Extend the `loot` import in `server.js` with `dropItem`. After the `autoloot` block:
```js
      if (msg.type === 'drop') {
        const entry = worlds.get(ws.worldId);
        if (!entry) return;
        if (typeof msg.itemId !== 'string') return; // wire hygiene: ids are strings
        ws._opChain = (ws._opChain || Promise.resolve()).then(async () => {
          try {
            const r = await dropItem(pool, entry, ws.userId, msg.itemId, { ttlMs: groundItemTtlMs });
            if (r.ok) send(ws, { type: 'dropped', itemId: msg.itemId });
            else send(ws, { type: 'error', message: r.reason });
          } catch (err) {
            console.error('drop failed:', err);
            send(ws, { type: 'error', message: 'drop failed' });
          }
        });
        return;
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/authority/loot.js backend/src/authority/server.js backend/tests/authorityLoot.test.js
git commit -m "feat(authority): drop items from inventory to the ground"
```

---

### Task 10: `items` AOI broadcast

**Files:**
- Modify: `backend/src/authority/server.js`

**Interfaces:**
- Produces: outbound `items{items:[{id,typeId,x,y}]}` at the creature cadence (~5Hz).

- [ ] **Step 1: Add the broadcaster**

Next to `broadcastCreatures`:
```js
  function broadcastItems(entry) {
    const N = entry.row.chunk_size;
    for (const [userId, ws] of entry.sockets) {
      const p = entry.world.getPlayer(userId);
      if (!p) continue;
      const { cx, cy } = chunkOf(p.x, p.y, N);
      const keys = neighborhoodKeys(cx, cy, 1);
      send(ws, { type: 'items', items: entry.world.groundItems.snapshotForNeighborhood(keys) });
    }
  }
```

- [ ] **Step 2: Call it on the creature cadence**

In the tick loop:
```js
      if (tick % creatureBroadcastEvery === 0) {
        recomputeActive(entry);
        broadcastCreatures(entry);
        broadcastItems(entry);
      }
```
A full neighborhood snapshot each time, consistent with the spec-accepted no-delta creature snapshot.

- [ ] **Step 3: Verify**

Run: `node --test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/authority/server.js
git commit -m "feat(authority): items AOI broadcast on the creature cadence"
```

---

### Task 11: Client transport

**Files:**
- Modify: `frontend/src/games/something2/src/js/net/WorldAuthorityClient.js`

**Interfaces:**
- Consumes: existing constructor-options callback pattern (all callbacks arrive in the constructor object and default to no-ops).
- Produces: constructor options `onItems`, `onPicked`, `onDropped`; methods `sendPickup()`, `sendDrop(itemId)`, `sendAutoLoot(on)`.

- [ ] **Step 1: Add the callbacks to the constructor**

Add `onItems`, `onPicked`, `onDropped` to the destructured options with no-op defaults, matching exactly how `onCreatures` and `onKicked` are already defaulted in this file.

- [ ] **Step 2: Dispatch the new inbound types**

In the `msg.type` switch, alongside `case 'creatures':`:
```js
        case 'items': this.onItems(msg); break;
        case 'picked': this.onPicked(msg); break;
        case 'dropped': this.onDropped(msg); break;
```

- [ ] **Step 3: Add the outbound methods**

Next to `sendAttack`/`sendEquip`, following their exact one-line style:
```js
  sendPickup() { this._send({ type: 'pickup' }); }
  sendDrop(itemId) { this._send({ type: 'drop', itemId }); }
  sendAutoLoot(on) { this._send({ type: 'autoloot', on: on === true }); }
```

- [ ] **Step 4: Verify**

Run from `frontend/`: `npm test`
Expected: PASS, 106 tests (this task adds none — it is transport plumbing covered by the browser verification).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/net/WorldAuthorityClient.js
git commit -m "feat(client): loot transport (items/picked/dropped, pickup/drop/autoloot)"
```

---

### Task 12: Client stores

**Files:**
- Create: `frontend/src/games/something2/src/js/entities/GroundItemManager.js`
- Modify: `frontend/src/games/something2/src/js/core/inventory.js`
- Test: `frontend/src/games/something2/src/js/entities/__tests__/GroundItemManager.test.js` (follow the existing test file location convention in this repo — match wherever `CreatureManager`'s tests live)

**Interfaces:**
- Produces: `GroundItemManager` with `applySnapshot(list)`, `all()`, `count()`, `has(id)` — render-only, **no interpolation** (ground items never move). Item fields: `{id, typeId, x, y, width: 24, height: 24}`.
- Produces: `addItem(inv, item)` and `removeItem(inv, itemId)` exported from `core/inventory.js`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { GroundItemManager } from '../GroundItemManager.js';

describe('GroundItemManager', () => {
  it('adds items from a snapshot', () => {
    const m = new GroundItemManager();
    m.applySnapshot([{ id: 'a', typeId: 1, x: 10, y: 20 }]);
    expect(m.count()).toBe(1);
    expect(m.all()[0]).toMatchObject({ id: 'a', typeId: 1, x: 10, y: 20 });
  });

  it('removes items absent from the snapshot', () => {
    const m = new GroundItemManager();
    m.applySnapshot([{ id: 'a', typeId: 1, x: 0, y: 0 }, { id: 'b', typeId: 1, x: 0, y: 0 }]);
    m.applySnapshot([{ id: 'b', typeId: 1, x: 0, y: 0 }]);
    expect(m.has('a')).toBe(false);
    expect(m.count()).toBe(1);
  });

  it('updates position in place on re-snapshot', () => {
    const m = new GroundItemManager();
    m.applySnapshot([{ id: 'a', typeId: 1, x: 0, y: 0 }]);
    m.applySnapshot([{ id: 'a', typeId: 1, x: 5, y: 7 }]);
    expect(m.all()[0]).toMatchObject({ x: 5, y: 7 });
  });

  it('an empty snapshot clears everything', () => {
    const m = new GroundItemManager();
    m.applySnapshot([{ id: 'a', typeId: 1, x: 0, y: 0 }]);
    m.applySnapshot([]);
    expect(m.count()).toBe(0);
  });
});
```

Add to the existing inventory test file:
```js
it('addItem appends and removeItem deletes by id', () => {
  const inv = createInventory();
  addItem(inv, { id: 'i1', typeId: 3 });
  expect(inv.items).toHaveLength(1);
  addItem(inv, { id: 'i1', typeId: 3 }); // dedup: server may echo
  expect(inv.items).toHaveLength(1);
  removeItem(inv, 'i1');
  expect(inv.items).toHaveLength(0);
  removeItem(inv, 'nope'); // must not throw
});
```

- [ ] **Step 2: Run and watch them fail**

Run from `frontend/`: `npm test`
Expected: FAIL — module and exports missing.

- [ ] **Step 3: Implement `GroundItemManager`**

```js
// Render-only store for ground items. Unlike CreatureManager there is no
// interpolation: a ground item never moves, so the server position is the
// render position.

const ITEM_SIZE = 24;

export class GroundItemManager {
  constructor() {
    this.items = new Map(); // id -> {id, typeId, x, y, width, height}
  }

  has(id) { return this.items.has(id); }
  count() { return this.items.size; }
  all() { return [...this.items.values()]; }

  applySnapshot(list) {
    const seen = new Set();
    for (const it of list || []) {
      seen.add(it.id);
      const existing = this.items.get(it.id);
      if (existing) {
        existing.x = it.x;
        existing.y = it.y;
        existing.typeId = it.typeId;
      } else {
        this.items.set(it.id, {
          id: it.id, typeId: it.typeId, x: it.x, y: it.y,
          width: ITEM_SIZE, height: ITEM_SIZE,
        });
      }
    }
    for (const id of this.items.keys()) if (!seen.has(id)) this.items.delete(id);
  }
}
```

- [ ] **Step 4: Add the inventory mutators**

In `core/inventory.js`:
```js
// Append a granted instance (from a pickup). Dedup by id: the server is the
// authority and may echo an instance the store already holds.
export function addItem(inv, item) {
  if (!item || item.id == null) return;
  if (inv.items.some((it) => it.id === item.id)) return;
  inv.items.push({ id: item.id, typeId: item.typeId });
}

export function removeItem(inv, itemId) {
  inv.items = inv.items.filter((it) => it.id !== itemId);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 111 tests.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/src/js/entities/GroundItemManager.js frontend/src/games/something2/src/js/core/inventory.js frontend/src/games/something2/src/js/entities/__tests__/
git commit -m "feat(client): ground item render store + inventory add/remove"
```

---

### Task 13: `renderChunked` options object

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js`
- Modify: `frontend/src/games/something2/src/js/core/Game.js`

**Context:** `renderChunked` currently takes **13 positional parameters** (RenderSystem.js:79) and this slice would push it to 15. This refactor is a deferred item from Slice 3b-1 and is being paid down here because this slice is what makes it untenable. It is a **pure refactor** — no behaviour change, no new fields. Do it as its own commit so the loot changes that follow are reviewable in isolation.

**Interfaces:**
- Produces: `renderChunked(opts)` where `opts` is
  `{player, camera, chunkedMap, remotePlayers, localUserId, creatures = [], projectiles = [], mana = null, maxMana = null, weaponName = null, inventory = null, inventoryOpen = false, selectedItemId = null}`.

- [ ] **Step 1: Change the signature**

```js
  renderChunked({
    player, camera, chunkedMap, remotePlayers, localUserId,
    creatures = [], projectiles = [], mana = null, maxMana = null,
    weaponName = null, inventory = null, inventoryOpen = false, selectedItemId = null,
  }) {
```
The body needs no other change — every parameter keeps its exact name.

- [ ] **Step 2: Update the single call site**

In `Game.js` `render()`:
```js
        this.renderSystem.renderChunked({
            player: this.player,
            camera: this.camera,
            chunkedMap: this.chunkedMap,
            remotePlayers: this.remotePlayers,
            localUserId: this.localUserId,
            creatures: this.creatures.all(),
            projectiles: this.projectiles ? this.projectiles.all() : [],
            mana: this.localMana,
            maxMana: this.localMaxMana,
            weaponName: this._resolveWeaponName(),
            inventory: this.inventory,
            inventoryOpen: this.inventoryOpen,
            selectedItemId: this.inventorySelectedItemId,
        });
```

- [ ] **Step 3: Verify nothing else calls it**

Run from `frontend/`:
```bash
grep -rn "renderChunked" src/
```
Expected: exactly two hits — the definition and the one call site above. If there are more (including in tests), update them all.

- [ ] **Step 4: Verify build + tests**

Run: `npm test && npm run build`
Expected: both PASS. This is a pure refactor — any behaviour change is a bug.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/RenderSystem.js frontend/src/games/something2/src/js/core/Game.js
git commit -m "refactor(client): renderChunked takes an options object (13 positional params)"
```

---

### Task 14: Render ground items + panel controls

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js`

**Interfaces:**
- Consumes: `renderChunked` options object (Task 13).
- Produces: `renderChunked` accepts `groundItems = []` and `autoLoot = false`; ground items are depth-sorted with the other drawables; `renderInventory` gains Drop and Auto-loot hit areas of `kind: 'drop'` and `kind: 'autoloot'`.

- [ ] **Step 1: Accept the new options**

Add `groundItems = [], autoLoot = false,` to the destructured `renderChunked` options.

- [ ] **Step 2: Depth-sort ground items with everything else**

`buildDrawables` collects `{kind, ref, depth}` and sorts by `depthKey(x, y)`. Ground items must join that sort — drawing them after the sort would put them on top of entities they are behind. After the `buildDrawables` call in `renderChunked`, merge and re-sort:

```js
    for (const gi of groundItems) {
      drawables.push({ kind: 'grounditem', ref: gi, depth: depthKey(gi.x, gi.y) });
    }
    drawables.sort((a, b) => a.depth - b.depth);
```

Then extend the draw loop:
```js
        else if (d.kind === 'grounditem') this.drawGroundItem(d.ref, inventory, player);
```

- [ ] **Step 3: Add the draw helper**

```js
  // A small diamond, coloured by the item type's category. The name is drawn
  // only when the player is close enough to actually loot it, so a busy field
  // of drops does not become a wall of text.
  drawGroundItem(item, inventory, player) {
    // Same convention the projectile draw uses: worldToScreen (imported from
    // ../core/iso.js) then lift by half a tile so the marker sits on the
    // diamond rather than at its top corner.
    const s = worldToScreen(item.x, item.y);
    const dx = s.x, dy = s.y - ISO_TILE_H / 2;
    const type = inventory && inventory.types ? inventory.types.get(item.typeId) : null;
    const color = type && type.category === 'armor' ? '#7ec8e3' : '#e3c27e';
    const r = 9;
    this.ctx.save();
    this.ctx.fillStyle = color;
    this.ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.moveTo(dx, dy - r);
    this.ctx.lineTo(dx + r, dy);
    this.ctx.lineTo(dx, dy + r);
    this.ctx.lineTo(dx - r, dy);
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.stroke();
    if (type && player) {
      const pdx = (player.x + player.width / 2) - item.x;
      const pdy = (player.y + player.height / 2) - item.y;
      if (pdx * pdx + pdy * pdy <= PICKUP_RADIUS * PICKUP_RADIUS) {
        this.ctx.fillStyle = '#fff';
        this.ctx.font = '12px sans-serif';
        this.ctx.textAlign = 'center';
        this.ctx.fillText(type.name, dx, dy - r - 6);
      }
    }
    this.ctx.restore();
  }
```

`worldToScreen` and `ISO_TILE_H` are already imported/defined in this file — do not introduce a second conversion path. Define `const PICKUP_RADIUS = 80;` as a module constant here with a comment noting it mirrors the server value in `backend/src/authority/groundItems.js`; the two must stay in sync, or the name label appears at a different range than looting actually works.

- [ ] **Step 4: Add the panel controls**

In `renderInventory`, add an **Auto-loot** toggle near the panel title and a **Drop** button that appears only when an item is selected. Follow the existing geometry and styling conventions in this method (`itemH = 40`, the `rgba(74,158,255,0.28)` selected fill, the `#4a9eff` accent stroke). Push hit areas in the same shape the method already uses:

```js
    hitAreas.push({ x: alX, y: alY, w: alW, h: alH, kind: 'autoloot', id: null });
    if (selectedItemId) hitAreas.push({ x: dropX, y: dropY, w: dropW, h: dropH, kind: 'drop', id: selectedItemId });
```

The toggle must render its current state from the `autoLoot` option (e.g. `Auto-loot: ON` / `Auto-loot: OFF`) — it is a server-owned flag mirrored locally, not a local toggle.

`renderInventory`'s signature becomes `renderInventory(ctx, inventory, hitAreas, selectedItemId = null, autoLoot = false)`; update its call site inside `renderChunked` to pass `autoLoot`.

- [ ] **Step 5: Verify**

Run: `npm test && npm run build`
Expected: both PASS. The render layer is verified by build + browser in this project, not by unit tests.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/RenderSystem.js
git commit -m "feat(client): draw ground items depth-sorted; drop + auto-loot panel controls"
```

---

### Task 15: Wire it up in `Game`

**Files:**
- Modify: `frontend/src/games/something2/src/js/core/Game.js`

**Interfaces:**
- Consumes: `GroundItemManager` (Task 12), `addItem`/`removeItem` (Task 12), transport methods (Task 11), render options (Tasks 13-14).

- [ ] **Step 1: Construct the store and the mirrored flag**

Next to `this.inventory = createInventory();` in **both** the constructor and `initChunked` (the existing code initialises these in both places — match that):
```js
        this.groundItems = new GroundItemManager();
        this.autoLoot = false;
```
Add the import: `import { GroundItemManager } from '../entities/GroundItemManager.js';` and extend the existing inventory import with `addItem, removeItem`.

- [ ] **Step 2: Wire the callbacks**

In the `WorldAuthorityClient` constructor options inside `initChunked`, next to `onCreatures`:
```js
            onItems: (msg) => this.groundItems.applySnapshot(msg.items || []),
            onPicked: (msg) => { if (msg.item) addItem(this.inventory, msg.item); },
            onDropped: (msg) => {
                removeItem(this.inventory, msg.itemId);
                if (this.inventorySelectedItemId === msg.itemId) this.inventorySelectedItemId = null;
            },
```

- [ ] **Step 3: Bind `g` to pickup — and stop it toggling the grid in chunked mode**

`g` is **already bound**: `if(key === 'g' && this.state === 'playing'){ this.map.toggleGrid(); }`. In chunked mode `this.map` is the unused legacy `GameMap`, so today `g` is a dead key there. Replace that line with:

```js
            if (key === 'g' && this.state === 'playing') {
                // Chunked mode: g loots. Legacy single-map mode keeps the grid toggle.
                if (this.chunked) {
                    if (!e.repeat && this.authorityClient) this.authorityClient.sendPickup();
                } else {
                    this.map.toggleGrid();
                }
            }
```
`!e.repeat` makes it edge-triggered — holding `g` must not spam the server, matching how the `i` toggle already guards.

- [ ] **Step 4: Handle the new panel clicks**

In `_handleInventoryClick(cx, cy)`, alongside the existing `kind === 'item'` / `kind === 'slot'` branches:
```js
            if (hit.kind === 'autoloot') {
                this.autoLoot = !this.autoLoot;
                if (this.authorityClient) this.authorityClient.sendAutoLoot(this.autoLoot);
                return;
            }
            if (hit.kind === 'drop') {
                if (this.authorityClient) this.authorityClient.sendDrop(hit.id);
                return;
            }
```

- [ ] **Step 5: Pass the new render options**

In `render()`, add to the `renderChunked` options object:
```js
            groundItems: this.groundItems.all(),
            autoLoot: this.autoLoot,
```

- [ ] **Step 6: Verify**

Run: `npm test && npm run build`
Expected: both PASS, 111 frontend tests.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/games/something2/src/js/core/Game.js
git commit -m "feat(client): wire loot — g to pick up, drop/auto-loot controls, item snapshots"
```

---

### Task 16: Live browser verification

**Files:** none (verification only; fixes land in the files they belong to)

**Context:** This project verifies the render layer and the full server round trip in a real browser, because the frontend test env is `node` with no jsdom. Slice 3b-2a's most important bug — creature contact damage bypassing the shared mitigation path — was found here and nowhere else. **If a check cannot be performed, report it as unverified. Do not report a pass you did not observe.**

- [ ] **Step 1: Bring the stack up and apply migrations**

```bash
docker compose up -d
cd backend && npm run migrate:up
```

- [ ] **Step 2: Verify the drop path**

Enter a chunked world, find a Wolf, kill it. Expected: roughly half the kills leave a diamond on the ground at the corpse position (seeded `chance 0.5`); its name appears when you stand within 80px. Confirm with a DB query that a `world_items` row exists at the corpse coordinates.

- [ ] **Step 3: Verify pickup and persistence**

Press `g` near the drop. Expected: the item vanishes from the ground, appears in the inventory panel (`i`), and `world_items` loses the row while `player_items` gains one. Reload the page and confirm the item is still in the inventory.

- [ ] **Step 4: Verify auto-loot**

Open the panel, toggle Auto-loot ON, kill another Wolf and walk over the drop. Expected: it is claimed without a keypress. Toggle OFF and confirm walking over a drop no longer claims it.

- [ ] **Step 5: Verify drop round trip**

Select an unequipped item, press Drop. Expected: it leaves the inventory and appears on the ground at your feet, and can be picked back up. Then equip an item and try to drop it. Expected: rejected with `unequip it first`, and it stays in the inventory.

- [ ] **Step 6: Verify the claim race — this is the one that matters**

Two browser tabs signed in as **different** users, both standing on the same single ground item. Press `g` in both as close to simultaneously as you can manage. Expected: **exactly one** receives the item; the other silently gets nothing; the item disappears from both screens. Repeat several times. Confirm in the DB that exactly one `player_items` row was created.

- [ ] **Step 7: Verify chunk lifecycle**

Drop an item, walk far enough away that its chunk leaves your 3×3 neighborhood, then walk back. Expected: the item is still there (it was pruned from memory and re-loaded from the DB, not lost). Restart the backend and confirm it survives that too.

- [ ] **Step 8: Check the console and the wire**

Expected: no errors in the browser console; `items` frames arrive at ~5Hz alongside `creatures`; no `state` frame carries item data.

- [ ] **Step 9: Report**

Write up each step with what you actually observed. Any step you could not complete is reported as unverified, with the reason.

---

## Notes for the executing controller

- Tasks 5-10 all modify `server.js`. Run them **strictly in order** — do not parallelise implementers across them.
- Task 5 changes `loadWorld`'s `entry` shape and the `World` constructor arity; Tasks 6-10 depend on both.
- The `authorityLoot.test.js` mock-pool tests (Tasks 5, 7, 9) are the invariant tests for this slice. If one of them can be made to pass with the `rowCount` guard removed, it is not testing the right thing — say so rather than accepting it.
