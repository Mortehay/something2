# Villages Slice B — Gate Guards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two powerful `guard`-faction creatures stand just inside each village gate, attack the nearest hostile creature that comes near, chase it only within a leash of their post, and return to post when it dies or flees.

**Architecture:** Add a `faction` to entity types and a home anchor to `world_creatures`. `CreatureSim.tick` gains a faction branch: hostiles keep today's exact behavior (target players, leash to self); guards target the nearest *hostile creature* within aggro, clamp all movement to a leash around `home`, deal contact damage to that creature, and walk home when idle. Guard kills must route through the existing single authoritative death commit, so `tick` now returns killed creature ids and the server commits them.

**Tech Stack:** Node/Express, `node-pg-migrate`, `node:test`, Postgres. All work is in `backend/src/authority/` + one migration + two route touch-ups. No frontend work in this slice.

## Global Constraints

- Guard entity type name is EXACTLY `Village Guard`, seeded idempotently (`ON CONFLICT (name) DO NOTHING`), `is_creature = true`, `faction = 'guard'`, `hp = 300`, `defense = 10`.
- `entity_types.faction`: `text NOT NULL DEFAULT 'hostile'`, `CHECK (faction IN ('hostile','guard'))`. Every existing creature stays `hostile` by default — the hostile path must remain byte-identical.
- `world_creatures.home_x` / `home_y`: `real NULL`. NULL means "no anchor" (today's behavior, leash-from-self). Guards get their post here.
- Guard tuning constants (export them, do not inline): `GUARD_AGGRO_RADIUS = 400`, `GUARD_LEASH_RADIUS = 300` (guards hold the gate; deliberately tighter than the hostile `LEASH_RADIUS = 800`), `GUARD_DAMAGE = 25`, `GUARD_HOME_EPSILON = 24` (within this of home ⇒ idle, don't jitter).
- Migration filename: next monotonic timestamp after `1714440029000` → **`1714440030000_guard_faction_and_home.js`**.
- **Hostiles are unchanged**: they still target ONLY players and leash to self. They do NOT target guards and do not fight back. Guards are one-directional defenders in this slice. Any regression in the hostile branch is a defect.
- Guard kills MUST route through `onCreatureDeath` → `commitCreatureDeath` (loot.js). That function's comment states: "Any future kill site must route through here." A guard kill that only deletes from the in-memory sim would desync the DB.
- `MAP_TILE_SIZE` = `CREATURE_TILE_PX` = `100`. Village box math (from Slice A): box spans rows `[minRow, minRow+height-1]`, cols `[minCol, minCol+width-1]`; gate is a single tile centered on `gateEdge`.
- Do NOT add gold/`gold_min`/`gold_max` (Slice C) or merchant columns (Slice D).

---

### Task 1: Migration — `faction`, home anchor, and the guard entity type

**Files:**
- Create: `backend/migrations/1714440030000_guard_faction_and_home.js`

**Interfaces:**
- Produces: `entity_types.faction` (text NOT NULL DEFAULT 'hostile', CHECK in hostile/guard); `world_creatures.home_x`/`home_y` (real NULL); a seeded `Village Guard` entity type row.

- [ ] **Step 1: Write the migration**

```js
// backend/migrations/1714440030000_guard_faction_and_home.js
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('entity_types', {
    faction: { type: 'text', notNull: true, default: 'hostile' },
  });
  pgm.addConstraint('entity_types', 'entity_types_faction_check', {
    check: "faction IN ('hostile','guard')",
  });
  pgm.addColumns('world_creatures', {
    home_x: { type: 'real' },
    home_y: { type: 'real' },
  });
  // The village gate guard. Tough on purpose: it must survive the hostiles it
  // fights. is_creature=true so it loads through the normal creature path.
  pgm.sql(
    `INSERT INTO entity_types
       (name, color, walkable, spawn_tiles, chance, hp, max_hp, defense, resistances, is_creature, faction)
     VALUES
       ('Village Guard', '#3f6fb5', false, '[]', 0, 300, 300, 10, '{}', true, 'guard')
     ON CONFLICT (name) DO NOTHING`
  );
};

exports.down = (pgm) => {
  pgm.sql("DELETE FROM entity_types WHERE name = 'Village Guard'");
  pgm.dropColumns('world_creatures', ['home_x', 'home_y']);
  pgm.dropConstraint('entity_types', 'entity_types_faction_check');
  pgm.dropColumns('entity_types', ['faction']);
};
```

- [ ] **Step 2: Run the migration up**

Run: `cd backend && DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm run migrate:up`
Expected: `1714440030000_guard_faction_and_home` applied, no error.

- [ ] **Step 3: Verify schema + seed**

Run:
```bash
docker exec something2-db-1 psql -U user -d game_db -c "\d entity_types" -c "\d world_creatures" -c "SELECT name, faction, hp, defense, is_creature FROM entity_types WHERE name='Village Guard';" -c "SELECT faction, count(*) FROM entity_types GROUP BY faction;"
```
Expected: `faction` column on entity_types with the CHECK; `home_x`/`home_y` on world_creatures; one `Village Guard | guard | 300 | 10 | t` row; every other entity type reports `hostile`.

- [ ] **Step 4: Verify down reverses, then re-apply up**

Run: `cd backend && DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm run migrate down && DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm run migrate:up`
Expected: clean down then up. (NOTE: `package.json` has no `migrate:down` script — use `npm run migrate down`.)

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/1714440030000_guard_faction_and_home.js
git commit -m "feat(db): entity_types.faction, world_creatures home anchor, Village Guard type"
```

---

### Task 2: Load `faction` + home anchor into the sim

**Files:**
- Modify: `backend/src/authority/creatures.js` (`loadCreatureTypes` SELECT + mapping; `addCreatures` fields)
- Modify: `backend/src/authority/server.js` (the `activateChunk` creature-load SELECT)
- Test: `backend/tests/guardFactionLoad.test.js`

**Interfaces:**
- Consumes: Task 1's columns.
- Produces:
  - `loadCreatureTypes(pool)` — SELECT now includes `faction`; each `creatureTypes` entry carries `faction`.
  - `addCreatures(list)` — each sim creature carries `faction` (default `'hostile'`), `home` (`{x,y}` or `null` from `home_x`/`home_y`), and `_targetKind` (`null` initially).
  - The `activateChunk` SELECT includes `et.faction, wc.home_x, wc.home_y`.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/guardFactionLoad.test.js
const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim, loadCreatureTypes } = require('../src/authority/creatures');

const MAP = { chunkSize: 64, isWalkable: () => true, speedAt: () => 1 };

test('loadCreatureTypes selects faction and carries it onto each type', async () => {
  let sql = '';
  const pool = { query: async (q) => { sql = q; return { rows: [
    { id: 1, name: 'Slime', color: '#0f0', hp: 10, defense: 0, resistances: {}, faction: 'hostile' },
    { id: 2, name: 'Village Guard', color: '#3f6fb5', hp: 300, defense: 10, resistances: {}, faction: 'guard' },
  ] }; } };
  const { creatureTypes } = await loadCreatureTypes(pool);
  assert.match(sql, /faction/, 'SELECT must include faction — omitting it loads undefined and silently disables guards');
  assert.equal(creatureTypes.find((t) => t.name === 'Village Guard').faction, 'guard');
  assert.equal(creatureTypes.find((t) => t.name === 'Slime').faction, 'hostile');
});

test('addCreatures carries faction and home anchor, defaulting faction to hostile', () => {
  const sim = new CreatureSim(MAP, () => 0.5);
  sim.addCreatures([
    { id: 'a', type: 'Slime', x: 0, y: 0, hp: 10 },
    { id: 'g', type: 'Village Guard', x: 100, y: 100, hp: 300, faction: 'guard', home_x: 100, home_y: 100 },
  ]);
  const a = sim.creatures.get('a'), g = sim.creatures.get('g');
  assert.equal(a.faction, 'hostile');
  assert.equal(a.home, null);
  assert.equal(g.faction, 'guard');
  assert.deepEqual(g.home, { x: 100, y: 100 });
  assert.equal(g._targetKind, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/guardFactionLoad.test.js`
Expected: FAIL — `faction` not in the SELECT / not on the sim creature.

- [ ] **Step 3: Add `faction` to `loadCreatureTypes`**

In `creatures.js`, extend the SELECT and the mapping:

```js
async function loadCreatureTypes(pool) {
  const r = await pool.query(
    `SELECT id, name, color, hp, defense, resistances, faction
     FROM entity_types WHERE is_creature = true ORDER BY id ASC`,
  );
  const creatureTypes = r.rows.map((row) => ({
    name: row.name,
    hp: row.hp,
    color: row.color,
    faction: row.faction || 'hostile',
    ...creatureMitigation(row),
  }));
  const creatureTypeIds = new Map(r.rows.map((row) => [row.name, row.id]));
  return { creatureTypes, creatureTypeIds };
}
```

- [ ] **Step 4: Add `faction` / `home` / `_targetKind` to `addCreatures`**

In `CreatureSim.addCreatures`, add three fields to the object stored in `this.creatures` (leave every existing field exactly as-is):

```js
        faction: c.faction || 'hostile',
        home: (Number.isFinite(c.home_x) && Number.isFinite(c.home_y))
          ? { x: c.home_x, y: c.home_y }
          : null,
        _target: null, _targetKind: null, mode: 'roam', _attackCd: 0,
```

(The `_target: null, mode: 'roam', _attackCd: 0` line already exists — extend it with `_targetKind: null` rather than adding a duplicate key.)

- [ ] **Step 5: Add the columns to the `activateChunk` SELECT**

In `backend/src/authority/server.js` (~line 235), extend the creature-load query. The existing comment already warns that a dropped column silently disables its feature — `faction` and the home anchor are exactly that kind of column:

```js
        `SELECT wc.id, wc.type, wc.x, wc.y, wc.hp, wc.facing, wc.home_x, wc.home_y,
                et.color, et.defense, et.resistances, et.faction
         FROM world_creatures wc LEFT JOIN entity_types et ON et.name = wc.type
         WHERE wc.world_id = $1 AND wc.x >= $2 AND wc.x < $3 AND wc.y >= $4 AND wc.y < $5`,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && node --test tests/guardFactionLoad.test.js`
Expected: PASS (2 tests).

- [ ] **Step 7: Run the creature/authority regression suites**

Run: `cd backend && node --test tests/authorityCreatures.test.js tests/guardFactionLoad.test.js`
(If `authorityCreatures.test.js` is not the exact name, run every test file whose name matches creature/authority — find them with `ls tests | grep -i -E "creature|authority"` and run them all.)
Expected: PASS, no regressions.

- [ ] **Step 8: Commit**

```bash
git add backend/src/authority/creatures.js backend/src/authority/server.js backend/tests/guardFactionLoad.test.js
git commit -m "feat(authority): load creature faction + home anchor into the sim"
```

---

### Task 3: Pure guard helpers — post placement and target selection

**Files:**
- Modify: `backend/src/services/mapService.js` (add `villageGatePosts`)
- Modify: `backend/src/authority/creatures.js` (add `selectGuardTarget`, `withinLeash`)
- Test: `backend/tests/guardHelpers.test.js`

**Interfaces:**
- Consumes: Slice A's village shape `{ id, minRow, minCol, width, height, gateEdge, spawnX, spawnY }`.
- Produces:
  - `villageGatePosts(v)` (mapService, exported) → `[{x,y},{x,y}]` — pixel centers of the two **interior** tiles flanking the gate. Clamped into the interior; for a minimum-size village both entries may coincide.
  - `selectGuardTarget({ guard, creatures, aggroRadius, leashRadius })` (creatures.js, exported) → the nearest `hostile`-faction creature whose center is within `aggroRadius` of the guard AND within `leashRadius` of the guard's `home`, or `null`.
  - `withinLeash(x, y, home, radius)` (creatures.js, exported) → boolean; `true` when `home` is null (no anchor ⇒ unconstrained).

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/guardHelpers.test.js
const test = require('node:test');
const assert = require('node:assert');
const { villageGatePosts } = require('../src/services/mapService');
const { selectGuardTarget, withinLeash } = require('../src/authority/creatures');

const V = (over = {}) => ({ minRow: 5, minCol: 5, width: 8, height: 6, gateEdge: 'S', ...over });

test('villageGatePosts returns the two interior tiles flanking a S gate', () => {
  // box rows 5..10, cols 5..12; gate at row 10, col 5+floor(8/2)=9
  // interior row just inside the S wall is 9; flanking cols 8 and 10
  const posts = villageGatePosts(V());
  assert.deepEqual(posts, [
    { x: 8 * 100 + 50, y: 9 * 100 + 50 },
    { x: 10 * 100 + 50, y: 9 * 100 + 50 },
  ]);
});

test('villageGatePosts handles a W gate (flanks vertically, one col inside)', () => {
  // gate at col 5, row 5+floor(6/2)=8; interior col 6; flanking rows 7 and 9
  const posts = villageGatePosts(V({ gateEdge: 'W' }));
  assert.deepEqual(posts, [
    { x: 6 * 100 + 50, y: 7 * 100 + 50 },
    { x: 6 * 100 + 50, y: 9 * 100 + 50 },
  ]);
});

test('villageGatePosts clamps into the interior for a minimum-size village', () => {
  // 3x3 box rows 5..7 cols 5..7: interior is the single tile (6,6)
  const posts = villageGatePosts(V({ width: 3, height: 3, gateEdge: 'S' }));
  for (const p of posts) {
    assert.equal(p.x, 6 * 100 + 50);
    assert.equal(p.y, 6 * 100 + 50);
  }
});

test('withinLeash is unconstrained when there is no home anchor', () => {
  assert.equal(withinLeash(9999, 9999, null, 300), true);
  assert.equal(withinLeash(100, 100, { x: 100, y: 100 }, 300), true);
  assert.equal(withinLeash(500, 100, { x: 100, y: 100 }, 300), false);
});

test('selectGuardTarget picks the nearest hostile creature and ignores guards', () => {
  const guard = { x: 100, y: 100, width: 48, height: 48, home: { x: 100, y: 100 } };
  const creatures = [
    { id: 'far',  faction: 'hostile', x: 300, y: 100, width: 48, height: 48 },
    { id: 'near', faction: 'hostile', x: 200, y: 100, width: 48, height: 48 },
    { id: 'g2',   faction: 'guard',   x: 110, y: 100, width: 48, height: 48 },
  ];
  const t = selectGuardTarget({ guard, creatures, aggroRadius: 400, leashRadius: 300 });
  assert.equal(t.id, 'near');
});

test('selectGuardTarget ignores hostiles beyond the leash from home', () => {
  const guard = { x: 100, y: 100, width: 48, height: 48, home: { x: 100, y: 100 } };
  const creatures = [{ id: 'far', faction: 'hostile', x: 1000, y: 100, width: 48, height: 48 }];
  assert.equal(selectGuardTarget({ guard, creatures, aggroRadius: 4000, leashRadius: 300 }), null);
});

test('selectGuardTarget returns null when there are no hostiles', () => {
  const guard = { x: 100, y: 100, width: 48, height: 48, home: { x: 100, y: 100 } };
  assert.equal(selectGuardTarget({ guard, creatures: [], aggroRadius: 400, leashRadius: 300 }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/guardHelpers.test.js`
Expected: FAIL — none of the three helpers are exported.

- [ ] **Step 3: Add `villageGatePosts` to `mapService.js`**

Place it next to `villageGateCell` (it reuses the same gate math):

```js
// Pixel centers of the two INTERIOR tiles flanking a village's gate — where the
// gate guards stand. Clamped into the interior box, so a minimum-size village
// (3x3, interior = one tile) yields two identical posts rather than posts on
// the wall ring.
function villageGatePosts(v) {
  const rMax = v.minRow + v.height - 1;
  const cMax = v.minCol + v.width - 1;
  const midCol = v.minCol + Math.floor(v.width / 2);
  const midRow = v.minRow + Math.floor(v.height / 2);
  const loR = v.minRow + 1, hiR = rMax - 1;
  const loC = v.minCol + 1, hiC = cMax - 1;
  const clampR = (r) => Math.min(hiR, Math.max(loR, r));
  const clampC = (c) => Math.min(hiC, Math.max(loC, c));
  let cells;
  if (v.gateEdge === 'S')      cells = [[hiR, clampC(midCol - 1)], [hiR, clampC(midCol + 1)]];
  else if (v.gateEdge === 'N') cells = [[loR, clampC(midCol - 1)], [loR, clampC(midCol + 1)]];
  else if (v.gateEdge === 'W') cells = [[clampR(midRow - 1), loC], [clampR(midRow + 1), loC]];
  else                         cells = [[clampR(midRow - 1), hiC], [clampR(midRow + 1), hiC]];
  return cells.map(([r, c]) => ({ x: c * 100 + 50, y: r * 100 + 50 }));
}
```

Add `villageGatePosts` to `module.exports`.

- [ ] **Step 4: Add `withinLeash` + `selectGuardTarget` to `creatures.js`**

Place them next to the existing `center`/`dist2` helpers:

```js
// A guard with no home anchor is unconstrained (matches a hostile's
// leash-from-self behavior for creatures that predate the anchor column).
function withinLeash(x, y, home, radius) {
  if (!home) return true;
  return dist2(x, y, home.x, home.y) <= radius * radius;
}

// Nearest hostile-faction creature a guard may engage: within aggroRadius of
// the guard AND within leashRadius of the guard's post, so a guard never locks
// onto something it is not allowed to chase.
function selectGuardTarget({ guard, creatures, aggroRadius, leashRadius }) {
  const gc = center(guard);
  let best = null, bd2 = aggroRadius * aggroRadius;
  for (const o of creatures) {
    if (o === guard || o.faction !== 'hostile') continue;
    const oc = center(o);
    if (!withinLeash(oc.x, oc.y, guard.home, leashRadius)) continue;
    const d2 = dist2(gc.x, gc.y, oc.x, oc.y);
    if (d2 <= bd2) { bd2 = d2; best = o; }
  }
  return best;
}
```

Add `withinLeash` and `selectGuardTarget` to `module.exports`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && node --test tests/guardHelpers.test.js`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/mapService.js backend/src/authority/creatures.js backend/tests/guardHelpers.test.js
git commit -m "feat(authority): pure guard helpers — gate posts, target selection, leash"
```

---

### Task 4: Faction-aware tick — the guard branch

**Files:**
- Modify: `backend/src/authority/creatures.js` (`CreatureSim.tick`; guard constants)
- Test: `backend/tests/guardTick.test.js`

**Interfaces:**
- Consumes: Task 2's `faction`/`home`/`_targetKind`; Task 3's `selectGuardTarget`/`withinLeash`.
- Produces:
  - Exported constants `GUARD_AGGRO_RADIUS = 400`, `GUARD_LEASH_RADIUS = 300`, `GUARD_DAMAGE = 25`, `GUARD_HOME_EPSILON = 24`.
  - `CreatureSim.tick(dt, activeChunkKeys, players, now)` **returns an array of killed creature ids** (creatures killed by guard contact damage; `[]` otherwise).
  - Guard behavior: acquire/hold a hostile target, chase clamped to the leash, contact-damage it, walk home when idle, idle within `GUARD_HOME_EPSILON` of home.
  - `c.mode` for guards is `'chase'` while engaged, `'return'` while walking home, `'guard'` while idle at post.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/guardTick.test.js
const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim, GUARD_LEASH_RADIUS, GUARD_DAMAGE } = require('../src/authority/creatures');

const MAP = { chunkSize: 64, isWalkable: () => true, speedAt: () => 1 };
const KEYS = new Set(['0,0']);
function sim() { return new CreatureSim(MAP, () => 0.5); }
const HOME = { x: 100, y: 100 };

function mk(over) {
  return { id: 'x', type: 'T', x: 0, y: 0, hp: 100, ...over };
}

test('a guard chases and damages the nearest hostile, never targeting players', () => {
  const s = sim();
  s.addCreatures([
    mk({ id: 'g', type: 'Village Guard', x: 100, y: 100, hp: 300, faction: 'guard', home_x: 100, home_y: 100 }),
    mk({ id: 'h', type: 'Slime', x: 140, y: 100, hp: 100 }),
  ]);
  const players = [{ userId: 1, x: 110, y: 100, width: 64, height: 64, hp: 100, maxHp: 100 }];
  const before = s.creatures.get('h').hp;
  s.tick(0.5, KEYS, players, 1000);
  const g = s.creatures.get('g');
  assert.equal(g._targetKind, 'creature', 'guard must target a creature, not a player');
  assert.equal(g._target, 'h');
  assert.ok(s.creatures.get('h').hp < before, 'guard should have dealt contact damage');
  assert.equal(players[0].hp, 100, 'guard must never damage a player');
});

test('tick returns ids of creatures killed by a guard', () => {
  const s = sim();
  s.addCreatures([
    mk({ id: 'g', type: 'Village Guard', x: 100, y: 100, hp: 300, faction: 'guard', home_x: 100, home_y: 100 }),
    mk({ id: 'h', type: 'Slime', x: 140, y: 100, hp: 1 }),
  ]);
  const killed = s.tick(0.5, KEYS, [], 1000);
  assert.deepEqual(killed, ['h']);
  assert.equal(s.creatures.has('h'), false, 'dead creature must leave the sim');
});

test('a guard never moves beyond its leash from home', () => {
  const s = sim();
  s.addCreatures([
    mk({ id: 'g', type: 'Village Guard', x: 100, y: 100, hp: 300, faction: 'guard', home_x: 100, home_y: 100 }),
    // hostile far outside the leash: guard must not acquire it and must not drift
    mk({ id: 'h', type: 'Slime', x: 100 + GUARD_LEASH_RADIUS + 500, y: 100, hp: 100 }),
  ]);
  for (let i = 0; i < 40; i++) s.tick(0.1, KEYS, [], 1000 + i);
  const g = s.creatures.get('g');
  const d = Math.hypot(g.x - HOME.x, g.y - HOME.y);
  assert.ok(d <= GUARD_LEASH_RADIUS, `guard drifted ${d} beyond leash ${GUARD_LEASH_RADIUS}`);
  assert.equal(g._target, null, 'must not acquire an out-of-leash hostile');
});

test('a guard walks back home when its target is gone and idles at post', () => {
  const s = sim();
  s.addCreatures([mk({ id: 'g', type: 'Village Guard', x: 260, y: 100, hp: 300, faction: 'guard', home_x: 100, home_y: 100 })]);
  for (let i = 0; i < 200; i++) s.tick(0.1, KEYS, [], 1000 + i);
  const g = s.creatures.get('g');
  assert.ok(Math.hypot(g.x - HOME.x, g.y - HOME.y) < 40, `guard did not return home (at ${g.x},${g.y})`);
  assert.equal(g.mode, 'guard');
});

test('hostile behavior is unchanged: still targets the player, ignores guards', () => {
  const s = sim();
  s.addCreatures([
    mk({ id: 'h', type: 'Slime', x: 100, y: 100, hp: 100 }),
    mk({ id: 'g', type: 'Village Guard', x: 120, y: 100, hp: 300, faction: 'guard', home_x: 120, home_y: 100 }),
  ]);
  const players = [{ userId: 7, x: 160, y: 100, width: 64, height: 64, hp: 100, maxHp: 100, mit: null }];
  s.tick(0.2, KEYS, players, 1000);
  const h = s.creatures.get('h');
  assert.equal(h._target, 7, 'hostile must still target the player by userId');
  assert.equal(h.mode, 'chase');
  assert.equal(s.creatures.get('g').hp, 300, 'hostile must not damage the guard');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/guardTick.test.js`
Expected: FAIL — guards currently run the hostile path (they'd target the player) and `tick` returns undefined.

- [ ] **Step 3: Add the guard constants**

Near the existing constants in `creatures.js`:

```js
const GUARD_AGGRO_RADIUS = 400;   // px: a guard engages a hostile within this
const GUARD_LEASH_RADIUS = 300;   // px from HOME: guards hold the gate, they do not roam
const GUARD_DAMAGE = 25;
const GUARD_HOME_EPSILON = 24;    // px: close enough to the post to stand still
```

- [ ] **Step 4: Add the guard branch to `tick` and return killed ids**

In `CreatureSim.tick`, declare a `killed` array at the top and return it at the end. Insert the guard branch immediately after the `if (c._attackCd > 0) ...` line and the `const cc = center(c);` line, BEFORE the existing hostile target-resolution block, so the hostile path is untouched:

```js
  tick(dt, activeChunkKeys, players = [], now = 0) {
    const active = activeChunkKeys instanceof Set ? activeChunkKeys : new Set(activeChunkKeys);
    const byId = new Map(players.map((p) => [p.userId, p]));
    const killed = [];
    const all = [...this.creatures.values()];
    for (const c of this.creatures.values()) {
      const { cx, cy } = chunkOf(c.x, c.y, this.chunkSize);
      if (!active.has(CHUNK_KEY(cx, cy))) continue; // frozen (out of active set)
      if (c._attackCd > 0) c._attackCd = Math.max(0, c._attackCd - dt);

      const cc = center(c);

      // --- Guard faction: defend the post against hostile creatures. Guards
      // never target players and are never targeted by hostiles.
      if (c.faction === 'guard') {
        let tgt = c._target ? this.creatures.get(c._target) : null;
        if (tgt && (tgt.hp <= 0 || tgt.faction !== 'hostile'
            || !withinLeash(center(tgt).x, center(tgt).y, c.home, GUARD_LEASH_RADIUS))) {
          tgt = null;
        }
        if (!tgt) {
          tgt = selectGuardTarget({
            guard: c, creatures: all,
            aggroRadius: GUARD_AGGRO_RADIUS, leashRadius: GUARD_LEASH_RADIUS,
          });
        }
        c._target = tgt ? tgt.id : null;
        c._targetKind = tgt ? 'creature' : null;

        if (tgt) {
          c.mode = 'chase';
          const tc = center(tgt);
          const vx = tc.x - cc.x, vy = tc.y - cc.y;
          const r = resolveMove(this.map, c, vx, vy, dt);
          // Leash clamp: a step that would leave the post's radius is refused.
          if ((r.x !== c.x || r.y !== c.y)
              && withinLeash(r.x + c.width / 2, r.y + c.height / 2, c.home, GUARD_LEASH_RADIUS)) {
            c.x = r.x; c.y = r.y;
            const f = facingFor(vx, vy); if (f) c.facing = f;
            c.dirty = true;
          }
          if (c._attackCd <= 0 && canAct(c, now)
              && dist2(cc.x, cc.y, tc.x, tc.y) <= CONTACT_RANGE * CONTACT_RANGE) {
            applyDamageWithEffects(tgt, GUARD_DAMAGE, 'physical', tgt.mit || NO_MITIGATION, now);
            tgt.dirty = true;
            c._attackCd = CREATURE_ATTACK_COOLDOWN;
            if (tgt.hp <= 0) { this.creatures.delete(tgt.id); killed.push(tgt.id); }
          }
          continue;
        }

        // No target: walk back to the post, then stand still.
        if (c.home) {
          const dx = c.home.x - cc.x, dy = c.home.y - cc.y;
          if (Math.hypot(dx, dy) > GUARD_HOME_EPSILON) {
            c.mode = 'return';
            const r = resolveMove(this.map, c, dx, dy, dt);
            if (r.x !== c.x || r.y !== c.y) {
              c.x = r.x; c.y = r.y;
              const f = facingFor(dx, dy); if (f) c.facing = f;
              c.dirty = true;
            }
          } else {
            c.mode = 'guard';
          }
        } else {
          c.mode = 'guard';
        }
        continue;
      }
      // --- end guard branch; hostile path below is unchanged ---
```

Then, at the very end of the method (after the roam block closes the `for` loop), add:

```js
    return killed;
  }
```

- [ ] **Step 5: Export the guard constants**

Add `GUARD_AGGRO_RADIUS, GUARD_LEASH_RADIUS, GUARD_DAMAGE, GUARD_HOME_EPSILON` to `module.exports`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && node --test tests/guardTick.test.js`
Expected: PASS (5 tests).

- [ ] **Step 7: Run the full creature/authority regression suites**

Run: `cd backend && node --test "tests/**/*.test.js"`
Expected: all pass — in particular every existing creature/aggro/contact-damage test, which must be unaffected by the guard branch.

- [ ] **Step 8: Commit**

```bash
git add backend/src/authority/creatures.js backend/tests/guardTick.test.js
git commit -m "feat(authority): faction-aware tick — guards engage hostiles, leash to post"
```

---

### Task 5: Route guard kills through the authoritative death commit

**Files:**
- Modify: `backend/src/authority/world.js` (`tickCreatures` returns killed ids)
- Modify: `backend/src/authority/server.js` (commit them via `onCreatureDeath`)
- Test: `backend/tests/guardKillCommit.test.js`

**Interfaces:**
- Consumes: Task 4's `CreatureSim.tick` return value.
- Produces: `World.tickCreatures(dt, activeKeys)` → `{ killedCreatureIds: string[] }`; the server tick routes each id through the existing `onCreatureDeath(entry, id)`.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/guardKillCommit.test.js
const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world');

const MAP = { chunkSize: 64, isWalkable: () => true, speedAt: () => 1 };

test('World.tickCreatures surfaces guard kills as killedCreatureIds', () => {
  const w = new World(MAP, {}, null, 64);
  w.creatures.addCreatures([
    { id: 'g', type: 'Village Guard', x: 100, y: 100, hp: 300, faction: 'guard', home_x: 100, home_y: 100 },
    { id: 'h', type: 'Slime', x: 140, y: 100, hp: 1 },
  ]);
  const out = w.tickCreatures(0.5, new Set(['0,0']));
  assert.ok(out && Array.isArray(out.killedCreatureIds), 'must return { killedCreatureIds }');
  assert.deepEqual(out.killedCreatureIds, ['h']);
});

test('tickCreatures returns an empty list when nothing dies', () => {
  const w = new World(MAP, {}, null, 64);
  w.creatures.addCreatures([{ id: 'h', type: 'Slime', x: 0, y: 0, hp: 100 }]);
  const out = w.tickCreatures(0.1, new Set(['0,0']));
  assert.deepEqual(out.killedCreatureIds, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/guardKillCommit.test.js`
Expected: FAIL — `tickCreatures` returns undefined.

- [ ] **Step 3: Return the killed ids from `World.tickCreatures`**

In `backend/src/authority/world.js`:

```js
  tickCreatures(dt, activeKeys) {
    // `this.now` is threaded through so contact damage reads the same clock
    // every other damage site does — a shocked player must take +25% from a
    // creature's bite too, not only from weapons.
    const killedCreatureIds = this.creatures.tick(dt, activeKeys, [...this.players.values()], this.now);
    return { killedCreatureIds: killedCreatureIds || [] };
  }
```

- [ ] **Step 4: Commit the deaths in the server tick**

In `backend/src/authority/server.js` (~line 634), the call is currently `entry.world.tickCreatures(dt, entry.activeChunks);`. Capture and commit — guard kills must go through the same authoritative path as every other kill site:

```js
      // aggro/chase/contact damage + respawns (before state). Guard kills route
      // through onCreatureDeath like every other kill site, so the DELETE +
      // drop roll stay authoritative.
      const { killedCreatureIds: killedByGuards } = entry.world.tickCreatures(dt, entry.activeChunks);
      for (const id of new Set(killedByGuards)) onCreatureDeath(entry, id);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && node --test tests/guardKillCommit.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && node --test "tests/**/*.test.js"`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add backend/src/authority/world.js backend/src/authority/server.js backend/tests/guardKillCommit.test.js
git commit -m "feat(authority): commit guard kills through the authoritative death path"
```

---

### Task 6: Spawn guards at village gates

**Files:**
- Modify: `backend/src/index.js` (`POST /api/worlds/:id/villages` inserts guards; `POST /api/worlds/:id/creatures` re-adds guards and only re-rolls hostiles)
- Test: `backend/tests/guardSpawnRoutes.test.js`

**Interfaces:**
- Consumes: Task 3's `villageGatePosts`; Slice A's `fetchVillages`; the `Village Guard` entity type from Task 1.
- Produces:
  - Creating a village inserts 2 `Village Guard` rows into `world_creatures` at the gate posts with `home_x`/`home_y` set to the post.
  - The creature re-roll route deletes only hostile creatures, re-rolls hostiles from `allowed_creature_types` (guard types excluded), and re-inserts guards for every village.
  - Module-local helper `insertVillageGuards(worldId, villages)`.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/guardSpawnRoutes.test.js
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, __setPool } = require('../src/index.js');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];
function mockPool(handlers) {
  const calls = [];
  return { calls, query: async (sql, params) => {
    if (isUserLookup(sql)) return ADMIN_USER_ROW;
    calls.push({ sql, params });
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
    throw new Error(`unexpected query: ${sql}`);
  } };
}

test('creating a village inserts two Village Guard creatures at the gate posts', async () => {
  const pool = mockPool([
    [/SELECT id, width, height FROM worlds WHERE id = \$1/i, (p) => ({ rows: [{ id: p[0], width: 30, height: 30 }] })],
    [/SELECT min_row, min_col, width, height FROM villages WHERE world_id/i, () => ({ rows: [] })],
    [/INSERT INTO villages/i, () => ({ rows: [{ id: 'v1', min_row: 5, min_col: 5, width: 8, height: 6, gate_edge: 'S' }] })],
    [/INSERT INTO world_creatures/i, () => ({ rows: [] })],
    [/DELETE FROM world_chunks/i, () => ({ rows: [], rowCount: 0 })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/worlds/w1/villages').set(...AUTH)
    .send({ min_row: 5, min_col: 5, width: 8, height: 6, gate_edge: 'S', spawn_x: 850, spawn_y: 750 });
  assert.equal(res.status, 200);
  const guardInserts = pool.calls.filter((c) => /INSERT INTO world_creatures/i.test(c.sql));
  assert.equal(guardInserts.length, 2, 'exactly two guards per village');
  for (const g of guardInserts) {
    assert.ok(g.params.includes('Village Guard'), 'guard rows must use the Village Guard type');
  }
});

test('creature re-roll deletes only hostiles and re-adds guards', async () => {
  const pool = mockPool([
    [/SELECT \* FROM worlds WHERE id = \$1/i, (p) => ({ rows: [{ id: p[0], seed: 1, chunk_size: 64, width: 30, height: 30, creature_count: 5, allowed_creature_types: ['Slime'] }] })],
    [/FROM tile_types/i, () => ({ rows: [{ name: 'grass', walkable: true, speed: 1 }] })],
    [/FROM entity_types/i, () => ({ rows: [{ name: 'Slime', hp: 10, defense: 0, resistances: {}, faction: 'hostile' }] })],
    [/FROM map_links|FROM villages WHERE world_id/i, () => ({ rows: [] })],
    [/DELETE FROM world_creatures/i, (p) => ({ rows: [], rowCount: 0 })],
    [/INSERT INTO world_creatures/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/worlds/w1/creatures').set(...AUTH);
  assert.equal(res.status, 200);
  const del = pool.calls.find((c) => /DELETE FROM world_creatures/i.test(c.sql));
  assert.match(del.sql, /home_x IS NULL|faction|Village Guard/i,
    'the re-roll DELETE must not wipe guards — scope it to hostiles');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/guardSpawnRoutes.test.js`
Expected: FAIL — no guard inserts; the re-roll DELETE is unscoped.

- [ ] **Step 3: Add the `insertVillageGuards` helper to `index.js`**

Place it next to `validateVillageBody`. Import `villageGatePosts` from `./services/mapService` (add it to the existing destructured require):

```js
// Two guards per village, standing on the interior tiles flanking the gate.
// home_x/home_y is the post: the authority leashes a guard to it.
const GUARD_TYPE = 'Village Guard';
async function insertVillageGuards(worldId, villages) {
  for (const v of villages) {
    for (const post of villageGatePosts(v)) {
      await pool.query(
        `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [worldId, GUARD_TYPE, post.x, post.y, 300, 'S', post.x, post.y],
      );
    }
  }
}
```

`villageGatePosts` expects the camelCase village shape, so map the inserted row before calling it.

- [ ] **Step 4: Spawn guards when a village is created**

In `POST /api/worlds/:id/villages`, after the successful INSERT and before `invalidateWorld(id)`:

```js
    const row = ins.rows[0];
    await insertVillageGuards(id, [{
      minRow: row.min_row, minCol: row.min_col,
      width: row.width, height: row.height, gateEdge: row.gate_edge,
    }]);
```

- [ ] **Step 5: Scope the re-roll to hostiles and re-add guards**

In `POST /api/worlds/:id/creatures`:
- Change the delete to spare guards:
  ```js
  await pool.query(`DELETE FROM world_creatures WHERE world_id = $1 AND type <> $2`, [id, GUARD_TYPE]);
  ```
- Exclude guard-faction types from the rollable set. The route already loads entity types into `et.rows` — filter them:
  ```js
  const hostileTypes = et.rows.filter((t) => (t.faction || 'hostile') !== 'guard');
  ```
  and pass `hostileTypes` (not `et.rows`) to `placeMapCreatures`. Make sure the entity-type SELECT in this route includes `faction`.
- After inserting the rolled hostiles, refresh guards so a village always has exactly two:
  ```js
  await pool.query(`DELETE FROM world_creatures WHERE world_id = $1 AND type = $2`, [id, GUARD_TYPE]);
  await insertVillageGuards(id, villages);
  ```
  (`villages` is already fetched in this route for the no-spawn config.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && node --test tests/guardSpawnRoutes.test.js`
Expected: PASS (2 tests).

- [ ] **Step 7: Run the route regression suites**

Run: `cd backend && node --test tests/villageRoutes.test.js tests/worldsAdminRoutes.test.js tests/worldLinksRoutes.test.js`
Expected: PASS. (The village-create tests from Slice A now also see guard INSERTs — update their mock pools to handle `INSERT INTO world_creatures` if they throw "unexpected query". That is a legitimate mock update, not a weakened assertion.)

- [ ] **Step 8: Run the full backend suite and commit**

Run: `cd backend && node --test "tests/**/*.test.js"`
Expected: all pass.

```bash
git add backend/src/index.js backend/tests/
git commit -m "feat(api): spawn two gate guards per village; re-roll spares guards"
```

---

## Final runtime verification (whole-slice, after all tasks)

Bring the stack up and restart the backend node (NOT `docker restart`):
```bash
docker start something2-db-1 something2-backend-1
docker exec something2-backend-1 sh -c 'pkill -f "node src/index.js"; sleep 2'
docker exec -d something2-backend-1 sh -c 'cd /app && node src/index.js > /tmp/backend.log 2>&1'
```

Then, with an admin token:
1. Create a bounded world + a village → confirm **2 `Village Guard` rows** in `world_creatures` with `home_x`/`home_y` at the gate posts, positioned on interior tiles.
2. Re-roll creatures → guards still present (exactly 2), hostiles placed outside the village, no `Village Guard` among the rolled hostiles.
3. Join over WS and observe: guards sit at their posts (`mode: 'guard'`); spawn/lure a hostile near the gate and confirm the guard engages it (`mode: 'chase'`), damages it, and the hostile **disappears from `world_creatures`** when killed (the authoritative death commit ran) — and drops appear if that type has `creature_drops`.
4. Confirm a guard never chases beyond ~300px from its post and returns to `mode: 'guard'` afterwards.
5. Confirm hostiles still chase the player normally elsewhere on the map (no regression).

---

## Self-Review

**Spec coverage** (Slice B section of `2026-07-22-villages-economy-design.md`):
- `entity_types.faction` + `world_creatures.home_x/home_y` → Task 1. ✅
- Two guard creatures spawned at the gate posts from the village row → Tasks 3, 6. ✅
- Faction-aware `tickCreatures`: hostiles unchanged; guards target nearest hostile creature, chase within leash of home, return when it dies/flees → Task 4. ✅
- Creature-targets-creature + home anchor (the new AI capability) → Tasks 2, 3, 4. ✅
- Guards are tough and drop no gold → Task 1 (hp 300 / defense 10; gold is Slice C, nothing to do). ✅
- Guard contact damage to a creature target → Task 4, with the death routed through `commitCreatureDeath` → Task 5. ✅

**Placeholder scan:** none — every code step carries complete code.

**Type consistency:** `villageGatePosts` returns `[{x,y},{x,y}]` (Task 3) and is consumed by `insertVillageGuards` (Task 6) after mapping the DB row to the camelCase village shape. `selectGuardTarget`/`withinLeash` signatures match between Task 3 (definition) and Task 4 (use). `faction`/`home`/`_targetKind` field names are consistent across Tasks 2 and 4. `tick` → `{killedCreatureIds}` naming matches the existing `attack`/`tickProjectiles` convention consumed in server.js (Task 5).

**Known deliberate limitation (documented, not a gap):** hostiles do not fight back against guards, and players can still damage guards through the normal attack paths (no guard invulnerability or respawn). Both are out of scope for this slice; note them as fast-follows.
