# Villages Slice A — Village & Safe Spawn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin can place walled, gated villages inside bounded maps; hostile creatures never spawn inside a village; a player who walks into a village binds to it and respawns there on death.

**Architecture:** Extend the merged bounded-worlds substrate. A new `villages` table drives a pure `stampVillage` overlay (interior wall box + one gate gap) applied in `generateRegion` after `stampBounds`; `placeMapCreatures` rejects village-box tiles by reading `cfg.villages`; the authority tick binds a player on entry (upserting `player_binds`) so the existing `resolveDeaths` respawns them at the village; a Maps-tab village editor drives CRUD routes.

**Tech Stack:** Node/Express backend, `node-pg-migrate` migrations, `node:test` + `supertest` tests, React + TanStack Query frontend, Postgres. WS authority in `backend/src/authority`.

## Global Constraints

- New tile kinds: `wooden_wall` (walkable = **false**), `village_gate` (walkable = **true**). Seed idempotently via `INSERT ... ON CONFLICT (name) DO NOTHING`, mirroring `1714440027000_bounded_worlds.js`.
- Village box dims: width in `[3, 8]`, height in `[3, 6]` tiles (≤ 8×6 keeps village ≤ ¼ of the fixed 1280×720 view).
- `MAP_TILE_SIZE` = `CREATURE_TILE_PX` = `100` px/tile. Player is 64×64; `PLAYER_HALF` = 32.
- Migration filename: next monotonic timestamp after `1714440028000` → **`1714440029000_villages_and_binds.js`**. Timestamps are hand-assigned, spaced by 1000, NOT real epoch millis.
- No `Math.random()` in generation code paths that must be deterministic — use the existing `makeRng(seed)` helper. (Route-level re-rolls already use `Math.random()` for the seed; that is unchanged.)
- Gate gap is a **single** tile (villages), unlike the 3-tile world doorway.
- `player_binds` holds one row per `user_id` (single cross-world home bind). Cross-world respawn (dying in world X while bound to world Y) is OUT OF SCOPE for Slice A: if `bind.world_id !== currentWorldId`, respawn falls back to the current world's spawn.
- Slice A creates only the base `villages` + `player_binds` schema. Columns for later slices (`villages.merchant_x/merchant_y`, `entity_types.faction/gold_min/gold_max`, `world_creatures.home_x/home_y`, `users.gold`) are added by Slices B/C/D, NOT here.
- Follow existing patterns: pure functions in `mapService.js` with `node:test` unit tests; routes guarded by `adminGuard` with `__setPool` mock-pool tests; frontend mutations via TanStack `useMutation` + `authHeaders()` + toast + `invalidateQueries`.

---

### Task 1: Migration — `villages` + `player_binds` tables and village tile types

**Files:**
- Create: `backend/migrations/1714440029000_villages_and_binds.js`

**Interfaces:**
- Produces: table `villages(id uuid pk, world_id uuid fk→worlds cascade, min_row int, min_col int, width int, height int, gate_edge char check N/E/S/W, spawn_x real, spawn_y real)` + index on `world_id`; table `player_binds(user_id int pk fk→users cascade, world_id uuid fk→worlds cascade, x real, y real)`; tile_types rows `wooden_wall`(walkable false), `village_gate`(walkable true).

- [ ] **Step 1: Write the migration**

```js
// backend/migrations/1714440029000_villages_and_binds.js
exports.shorthands = undefined;

const VILLAGE_TILE_TYPES = [
  { name: 'wooden_wall', color: '#6b4a2a', walkable: false, speed: 1.0 },
  { name: 'village_gate', color: '#c9a24b', walkable: true, speed: 1.0 },
];

exports.up = (pgm) => {
  pgm.createTable('villages', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    min_row: { type: 'integer', notNull: true },
    min_col: { type: 'integer', notNull: true },
    width: { type: 'integer', notNull: true },
    height: { type: 'integer', notNull: true },
    gate_edge: { type: 'char(1)', notNull: true, check: "gate_edge IN ('N','E','S','W')" },
    spawn_x: { type: 'real', notNull: true },
    spawn_y: { type: 'real', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('villages', 'world_id');

  pgm.createTable('player_binds', {
    user_id: { type: 'integer', primaryKey: true, references: 'users', onDelete: 'CASCADE' },
    world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    x: { type: 'real', notNull: true },
    y: { type: 'real', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  for (const t of VILLAGE_TILE_TYPES) {
    pgm.sql(
      `INSERT INTO tile_types (name, color, walkable, speed, image, valid_neighbors)
       VALUES ('${t.name}', '${t.color}', ${t.walkable}, ${t.speed}, '', '[]')
       ON CONFLICT (name) DO NOTHING`
    );
  }
};

exports.down = (pgm) => {
  pgm.dropTable('player_binds');
  pgm.dropTable('villages');
  pgm.sql("DELETE FROM tile_types WHERE name IN ('wooden_wall','village_gate')");
};
```

- [ ] **Step 2: Run the migration up**

Run: `cd backend && DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm run migrate:up`
Expected: migration `1714440029000_villages_and_binds` applied, no error.

- [ ] **Step 3: Verify tables and tile types exist**

Run:
```bash
docker exec something2-db-1 psql -U user -d game_db -c "\d villages" -c "\d player_binds" -c "SELECT name, walkable FROM tile_types WHERE name IN ('wooden_wall','village_gate') ORDER BY name;"
```
Expected: both tables listed; `village_gate | t` and `wooden_wall | f`.

- [ ] **Step 4: Verify down migration reverses cleanly, then re-apply up**

Run: `cd backend && DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm run migrate:down && DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm run migrate:up`
Expected: down drops both tables + removes the 2 tile rows; up re-creates them. No error.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/1714440029000_villages_and_binds.js
git commit -m "feat(db): villages + player_binds tables, village tile types"
```

---

### Task 2: `stampVillage` pure overlay + `generateRegion` call site + `worldConfig.villages`

**Files:**
- Modify: `backend/src/services/mapService.js` (add `stampVillage`, `pointInVillageBox`, `villageContaining`; extend `worldConfig`; call in `generateRegion`)
- Test: `backend/tests/stampVillage.test.js`

**Interfaces:**
- Consumes: `worldConfig(world)` returns `cfg`; `generateRegion(world, rMin, cMin, rows, cols)`.
- Produces:
  - `stampVillage(grid, rMin, cMin, rows, cols, village)` — mutates + returns `grid`. `village = { minRow, minCol, width, height, gateEdge, wallTile, gateTile }`.
  - `pointInVillageBox(gRow, gCol, v)` → boolean (v has `minRow/minCol/width/height`).
  - `villageContaining(gRow, gCol, villages)` → the first village whose box contains the point, or `null`.
  - `cfg.villages` — array of `{ id, minRow, minCol, width, height, gateEdge, spawnX, spawnY, wallTile:'wooden_wall', gateTile:'village_gate' }`, or `null`.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/stampVillage.test.js
const test = require('node:test');
const assert = require('node:assert');
const { stampVillage, pointInVillageBox, villageContaining } = require('../src/services/mapService');

function fill(rows, cols, v = 'grass') {
  const g = [];
  for (let r = 0; r < rows; r++) g.push(new Array(cols).fill(v));
  return g;
}
const V = (over = {}) => ({
  minRow: 2, minCol: 2, width: 5, height: 4, gateEdge: 'S',
  wallTile: 'wooden_wall', gateTile: 'village_gate', ...over,
});

test('stampVillage walls the box perimeter and leaves the interior untouched', () => {
  const g = fill(12, 12);
  stampVillage(g, 0, 0, 12, 12, V());        // box rows 2..5, cols 2..6
  assert.equal(g[2][2], 'wooden_wall');       // top-left corner
  assert.equal(g[2][6], 'wooden_wall');       // top-right corner
  assert.equal(g[5][2], 'wooden_wall');       // bottom-left corner
  assert.equal(g[3][3], 'grass');             // interior untouched
  assert.equal(g[3][5], 'grass');             // interior untouched
  assert.equal(g[0][0], 'grass');             // outside untouched
});

test('the gate edge carves a single passable gate tile centered on that edge', () => {
  const g = fill(12, 12);
  stampVillage(g, 0, 0, 12, 12, V({ gateEdge: 'S' }));   // width 5 -> gate col = 2 + floor(5/2) = 4
  assert.equal(g[5][4], 'village_gate');
  assert.equal(g[5][3], 'wooden_wall');
  assert.equal(g[5][5], 'wooden_wall');
});

test('gate on the W edge is centered vertically', () => {
  const g = fill(12, 12);
  stampVillage(g, 0, 0, 12, 12, V({ gateEdge: 'W' }));    // height 4 -> gate row = 2 + floor(4/2) = 4
  assert.equal(g[4][2], 'village_gate');
  assert.equal(g[3][2], 'wooden_wall');
});

test('stampVillage respects the chunk window offset (rMin/cMin)', () => {
  const g = fill(6, 6);                        // chunk covering global rows 2..7, cols 2..7
  stampVillage(g, 2, 2, 6, 6, V());            // box global rows 2..5, cols 2..6
  assert.equal(g[0][0], 'wooden_wall');        // global (2,2) = box corner
  assert.equal(g[1][1], 'grass');              // global (3,3) = interior
});

test('pointInVillageBox and villageContaining', () => {
  const v = V();                               // rows 2..5, cols 2..6
  assert.equal(pointInVillageBox(3, 3, v), true);
  assert.equal(pointInVillageBox(2, 2, v), true);   // on the ring counts as inside the box
  assert.equal(pointInVillageBox(6, 3, v), false);
  const villages = [V({ id: 'a' }), V({ id: 'b', minRow: 20, minCol: 20 })];
  assert.equal(villageContaining(3, 3, villages).id, 'a');
  assert.equal(villageContaining(21, 21, villages).id, 'b');
  assert.equal(villageContaining(50, 50, villages), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/stampVillage.test.js`
Expected: FAIL — `stampVillage`/`pointInVillageBox`/`villageContaining` are not exported.

- [ ] **Step 3: Add the pure functions to `mapService.js`**

Add these functions near `stampBounds` (after the `stampBounds` definition, before `generateRegion`):

```js
function pointInVillageBox(gRow, gCol, v) {
  return gRow >= v.minRow && gRow <= v.minRow + v.height - 1 &&
         gCol >= v.minCol && gCol <= v.minCol + v.width - 1;
}

function villageContaining(gRow, gCol, villages) {
  if (!villages) return null;
  for (const v of villages) {
    if (pointInVillageBox(gRow, gCol, v)) return v;
  }
  return null;
}

function villageGateCell(gRow, gCol, v) {
  const midCol = v.minCol + Math.floor(v.width / 2);
  const midRow = v.minRow + Math.floor(v.height / 2);
  const rMax = v.minRow + v.height - 1;
  const cMax = v.minCol + v.width - 1;
  if (v.gateEdge === 'N' && gRow === v.minRow && gCol === midCol) return true;
  if (v.gateEdge === 'S' && gRow === rMax && gCol === midCol) return true;
  if (v.gateEdge === 'W' && gCol === v.minCol && gRow === midRow) return true;
  if (v.gateEdge === 'E' && gCol === cMax && gRow === midRow) return true;
  return false;
}

function stampVillage(grid, rMin, cMin, rows, cols, village) {
  const { minRow, minCol, width, height, wallTile, gateTile } = village;
  const rMax = minRow + height - 1;
  const cMax = minCol + width - 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gRow = rMin + r, gCol = cMin + c;
      if (gRow < minRow || gRow > rMax || gCol < minCol || gCol > cMax) continue;
      const onRing = gRow === minRow || gRow === rMax || gCol === minCol || gCol === cMax;
      if (!onRing) continue;
      grid[r][c] = villageGateCell(gRow, gCol, village) ? gateTile : wallTile;
    }
  }
  return grid;
}
```

- [ ] **Step 4: Extend `worldConfig` to carry `villages`**

In `worldConfig(world)`, add a `villages` field to the returned config object (alongside the existing `bounds` field):

```js
    villages: Array.isArray(world.villages) && world.villages.length
      ? world.villages.map((v) => ({
          id: v.id,
          minRow: v.minRow, minCol: v.minCol,
          width: v.width, height: v.height,
          gateEdge: v.gateEdge,
          spawnX: v.spawnX, spawnY: v.spawnY,
          wallTile: 'wooden_wall', gateTile: 'village_gate',
        }))
      : null,
```

- [ ] **Step 5: Call `stampVillage` in `generateRegion`**

In `generateRegion`, immediately after the existing `if (cfg.bounds) stampBounds(...)` line and before `return grid;`:

```js
  if (cfg.villages) {
    for (const v of cfg.villages) stampVillage(grid, rMin, cMin, rows, cols, v);
  }
```

- [ ] **Step 6: Export the new pure functions**

Add `stampVillage`, `pointInVillageBox`, `villageContaining` to `module.exports` in `mapService.js`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd backend && node --test tests/stampVillage.test.js`
Expected: PASS (5 tests).

- [ ] **Step 8: Run the full mapService-adjacent suite to check for regressions**

Run: `cd backend && node --test tests/stampBounds.test.js tests/generateRegion_bounds.test.js`
Expected: PASS (no regression in bounds generation).

- [ ] **Step 9: Commit**

```bash
git add backend/src/services/mapService.js backend/tests/stampVillage.test.js
git commit -m "feat(mapgen): stampVillage interior wall/gate overlay + village helpers"
```

---

### Task 3: `placeMapCreatures` rejects village-box tiles

**Files:**
- Modify: `backend/src/services/mapService.js` (`placeMapCreatures`)
- Test: `backend/tests/placeMapCreatures_village.test.js`

**Interfaces:**
- Consumes: `cfg.villages` from Task 2; `villageContaining` from Task 2.
- Produces: `placeMapCreatures(world, count, allowedTypes, rngSeed, maxAttempts)` unchanged signature, but rejects any candidate tile inside a village box (read from `cfg.villages`). Callers that want the no-spawn behavior pass `villages` on the `world` config object.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/placeMapCreatures_village.test.js
const test = require('node:test');
const assert = require('node:assert');
const { placeMapCreatures } = require('../src/services/mapService');

const TILE = 100;
const allowed = [{ name: 'goblin', hp: 10, defense: 0, resistances: {} }];

function bounded(extra = {}) {
  return {
    seed: 7, chunkSize: 32,
    tileTypes: { grass: { walkable: true }, wooden_wall: { walkable: false }, village_gate: { walkable: true } },
    width: 30, height: 30,
    ...extra,
  };
}

test('placeMapCreatures never places a creature inside a village box', () => {
  const world = bounded({
    villages: [{ id: 'v', minRow: 5, minCol: 5, width: 8, height: 6, gateEdge: 'S', spawnX: 0, spawnY: 0 }],
  });
  const placed = placeMapCreatures(world, 40, allowed, 123, 200);
  for (const c of placed) {
    const gCol = Math.floor(c.x / TILE), gRow = Math.floor(c.y / TILE);
    const inBox = gRow >= 5 && gRow <= 10 && gCol >= 5 && gCol <= 12;
    assert.equal(inBox, false, `creature at (${gRow},${gCol}) is inside the village box`);
  }
  assert.ok(placed.length > 0, 'should still place creatures outside the village');
});

test('with no villages, placement is unchanged (regression)', () => {
  const placed = placeMapCreatures(bounded(), 10, allowed, 123, 200);
  assert.ok(placed.length > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/placeMapCreatures_village.test.js`
Expected: FAIL — first test finds a creature inside the box (no-spawn not implemented).

- [ ] **Step 3: Add the village rejection to `placeMapCreatures`**

In `placeMapCreatures`, after computing `cfg` and before the placement loop, capture villages:

```js
  const villages = cfg.villages;
```

Inside the attempt loop, after the existing `if (name === wallTile || name === doorwayTile) continue;` and walkable checks, add the village-box rejection (before selecting a type):

```js
      if (villageContaining(row, col, villages)) continue;
```

`villageContaining` is already defined and exported in this module (Task 2); reference it directly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/placeMapCreatures_village.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the existing placeMapCreatures suite for regressions**

Run: `cd backend && node --test tests/placeMapCreatures.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/mapService.js backend/tests/placeMapCreatures_village.test.js
git commit -m "feat(mapgen): placeMapCreatures skips village-box tiles"
```

---

### Task 4: `fetchVillages` DB helper + thread villages into authority + creature re-roll route

**Files:**
- Create: `backend/src/services/villages.js`
- Modify: `backend/src/authority/server.js` (`loadWorld`: fetch villages, add to ServerMap config + `entry.villages`)
- Modify: `backend/src/index.js` (`POST /api/worlds/:id/creatures`: pass villages to `placeMapCreatures`)
- Test: `backend/tests/villagesService.test.js`

**Interfaces:**
- Consumes: `pool` (pg pool); Task 2's `cfg.villages` shape (camelCase).
- Produces:
  - `fetchVillages(pool, worldId)` → `Promise<Array<{ id, minRow, minCol, width, height, gateEdge, spawnX, spawnY }>>` (camelCase, mapped from snake_case columns).
  - `loadWorld` ServerMap config gains `villages: <fetchVillages result>`; `entry.villages` = same array.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/villagesService.test.js
const test = require('node:test');
const assert = require('node:assert');
const { fetchVillages } = require('../src/services/villages');

test('fetchVillages maps snake_case columns to camelCase', async () => {
  const pool = {
    query: async (sql, params) => {
      assert.match(sql, /FROM villages WHERE world_id = \$1/i);
      assert.deepEqual(params, ['w1']);
      return { rows: [{
        id: 'v1', min_row: 5, min_col: 6, width: 8, height: 6,
        gate_edge: 'S', spawn_x: 650, spawn_y: 550,
      }] };
    },
  };
  const out = await fetchVillages(pool, 'w1');
  assert.deepEqual(out, [{
    id: 'v1', minRow: 5, minCol: 6, width: 8, height: 6,
    gateEdge: 'S', spawnX: 650, spawnY: 550,
  }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/villagesService.test.js`
Expected: FAIL — module `../src/services/villages` not found.

- [ ] **Step 3: Create `backend/src/services/villages.js`**

```js
async function fetchVillages(pool, worldId) {
  const r = await pool.query(
    `SELECT id, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y
       FROM villages WHERE world_id = $1 ORDER BY created_at ASC`,
    [worldId],
  );
  return r.rows.map((v) => ({
    id: v.id,
    minRow: v.min_row, minCol: v.min_col,
    width: v.width, height: v.height,
    gateEdge: v.gate_edge,
    spawnX: v.spawn_x, spawnY: v.spawn_y,
  }));
}

module.exports = { fetchVillages };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/villagesService.test.js`
Expected: PASS.

- [ ] **Step 5: Thread villages into `loadWorld` (authority)**

In `backend/src/authority/server.js`, add the import near the top (with the other service imports, e.g. next to `fetchLinks`):

```js
const { fetchVillages } = require('../services/villages');
```

In `loadWorld`, after the `linkRows`/`links` lines and before `const map = new ServerMap({...})`, fetch villages:

```js
      const villages = await fetchVillages(pool, worldId);
```

Add `villages` to the `ServerMap` config object:

```js
      const map = new ServerMap({
        seed: Number(row.seed), chunkSize: row.chunk_size, tileTypes,
        width: row.width, height: row.height, doorways: [...links.keys()],
        villages,
      });
```

And add `villages` to the `entry` object (alongside `links`):

```js
        tileTypes, creatureTypes, creatureTypeIds, links, villages,
```

- [ ] **Step 6: Pass villages to `placeMapCreatures` in the creatures re-roll route**

In `backend/src/index.js`, add the import near the `fetchLinks` import:

```js
const { fetchVillages } = require('./services/villages');
```

In `POST /api/worlds/:id/creatures`, update the config object passed to `placeMapCreatures` to include villages (fetch them just before the call):

```js
    const villages = await fetchVillages(pool, world.id);
    const rows = placeMapCreatures(
      { seed: Number(world.seed), chunkSize: world.chunk_size, tileTypes,
        width: world.width, height: world.height,
        doorways: (await fetchLinks(pool, world.id)).map((l) => l.edge),
        villages },
      count, et.rows, Math.floor(Math.random() * 2 ** 31),
    );
```

- [ ] **Step 7: Run the authority + route suites to confirm nothing broke**

Run: `cd backend && node --test tests/villagesService.test.js tests/placeMapCreatures.test.js`
Expected: PASS. (Authority `loadWorld` has no direct unit test; it is exercised in browser verification at the end of the slice.)

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/villages.js backend/src/authority/server.js backend/src/index.js backend/tests/villagesService.test.js
git commit -m "feat(authority): load villages into ServerMap config + creature no-spawn"
```

---

### Task 5: Bind-on-enter in the tick + `player_binds` persistence + respawn seeding

**Files:**
- Modify: `backend/src/authority/world.js` (`addPlayer` gains an optional `respawn` anchor)
- Modify: `backend/src/authority/server.js` (bind-detection in the tick; `loadSpawn` reads `player_binds`; join passes respawn to `addPlayer`; `upsertBind` helper)
- Test: `backend/tests/villageBind.test.js`

**Interfaces:**
- Consumes: `entry.villages` (Task 4); `villageContaining`, `pointInVillageBox` (Task 2); `MAP_TILE_SIZE` (from `./collision`).
- Produces:
  - `addPlayer(userId, spawn, inv = {...}, respawn = spawn)` — sets `spawn: { x: respawn.x, y: respawn.y }`; join position stays `spawn.x/spawn.y`.
  - `planBind({ villages, gRow, gCol, boundVillageId })` (pure, exported from server.js) → the village to bind to, or `null` (returns null when already bound to the village covering the point, or when not inside any village).
  - `loadSpawn` return value gains `respawn: { x, y }` when a `player_binds` row exists for `(userId, worldId)`; else `respawn` equals the chosen spawn.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/villageBind.test.js
const test = require('node:test');
const assert = require('node:assert');
const { planBind } = require('../src/authority/server');

const villages = [{ id: 'v1', minRow: 5, minCol: 5, width: 8, height: 6, gateEdge: 'S', spawnX: 650, spawnY: 550 }];

test('planBind returns the village when the player enters an unbound village', () => {
  const v = planBind({ villages, gRow: 7, gCol: 7, boundVillageId: null });
  assert.equal(v && v.id, 'v1');
});

test('planBind returns null when already bound to the village at that point', () => {
  assert.equal(planBind({ villages, gRow: 7, gCol: 7, boundVillageId: 'v1' }), null);
});

test('planBind returns null when the player is outside every village', () => {
  assert.equal(planBind({ villages, gRow: 50, gCol: 50, boundVillageId: null }), null);
});

test('planBind rebinds when entering a different village than the current bind', () => {
  const two = [...villages, { id: 'v2', minRow: 20, minCol: 20, width: 5, height: 5, gateEdge: 'N', spawnX: 2200, spawnY: 2200 }];
  const v = planBind({ villages: two, gRow: 21, gCol: 21, boundVillageId: 'v1' });
  assert.equal(v && v.id, 'v2');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/villageBind.test.js`
Expected: FAIL — `planBind` not exported.

- [ ] **Step 3: Add `planBind` to `server.js` and export it**

Add near `planTransition` in `backend/src/authority/server.js`:

```js
const { villageContaining } = require('../services/mapService');

function planBind({ villages, gRow, gCol, boundVillageId }) {
  const v = villageContaining(gRow, gCol, villages);
  if (!v) return null;
  if (v.id === boundVillageId) return null;
  return v;
}
```

Update the export line to include it:

```js
module.exports = { attachAuthority, planTransition, planBind };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/villageBind.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the `respawn` param to `addPlayer`**

In `backend/src/authority/world.js`, change the `addPlayer` signature and the `spawn` field:

```js
  addPlayer(userId, spawn, inv = { items: [], equipment: {} }, respawn = spawn) {
    this.players.set(userId, {
      // ... unchanged fields ...
      spawn: { x: respawn.x, y: respawn.y },
      // ... rest unchanged ...
    });
  }
```

(Only the signature and the `spawn:` line change; leave every other field exactly as-is. `x: spawn.x` / `y: spawn.y` remain the JOIN position.)

- [ ] **Step 6: Add `upsertBind` and wire bind-detection into the tick**

In `server.js`, add a module-level helper near the other DB helpers:

```js
async function upsertBind(userId, worldId, x, y) {
  await pool.query(
    `INSERT INTO player_binds (user_id, world_id, x, y, updated_at)
       VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id) DO UPDATE SET world_id = $2, x = $3, y = $4, updated_at = now()`,
    [userId, worldId, x, y],
  );
}
```

In the per-tick loop, add a bind pass modeled on the existing doorway pass. Place it right after the doorway-transition block (`if (entry.links && entry.links.size > 0) { ... }`):

```js
      if (entry.villages && entry.villages.length) {
        for (const p of entry.world.players.values()) {
          const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
          const gRow = Math.floor(cy / MAP_TILE_SIZE), gCol = Math.floor(cx / MAP_TILE_SIZE);
          const v = planBind({ villages: entry.villages, gRow, gCol, boundVillageId: p._boundVillageId });
          if (v) {
            p._boundVillageId = v.id;
            p.spawn = { x: v.spawnX, y: v.spawnY };
            upsertBind(p.userId, entry.worldId, v.spawnX, v.spawnY).catch((e) => console.error('upsertBind', e));
          }
        }
      }
```

(`MAP_TILE_SIZE` is already imported in server.js from `./collision`. `p._boundVillageId` starts `undefined`, which is falsy and never equals a real village id — the first entry always binds.)

- [ ] **Step 7: Seed `respawn` from `player_binds` in `loadSpawn` and pass it to `addPlayer`**

In `loadSpawn`, after computing the chosen spawn, look up a same-world bind and attach it as `respawn`:

```js
async function loadSpawn(worldId, userId, chunkSize, worldRow) {
  const pend = pendingArrivals.get(userId);
  const pending = (pend && pend.worldId === worldId) ? { x: pend.x, y: pend.y } : null;
  if (pending) pendingArrivals.delete(userId);
  let persisted = null;
  const r = await pool.query(
    'SELECT x, y FROM world_players WHERE world_id = $1 AND user_id = $2',
    [worldId, userId],
  );
  if (r.rows.length) persisted = { x: r.rows[0].x, y: r.rows[0].y };
  const spawn = chooseSpawn({ pending, persisted, worldRow, chunkSize });
  const b = await pool.query(
    'SELECT x, y FROM player_binds WHERE user_id = $1 AND world_id = $2',
    [userId, worldId],
  );
  spawn.respawn = b.rows.length ? { x: b.rows[0].x, y: b.rows[0].y } : { x: spawn.x, y: spawn.y };
  return spawn;
}
```

In the join handler, pass the respawn anchor to `addPlayer`:

```js
      entry.world.addPlayer(ws.userId, spawn, inv, spawn.respawn);
```

(Find the existing `entry.world.addPlayer(ws.userId, spawn, inv)` call and add the fourth argument. If a bound player reconnects, they appear at their persisted/arrival position but respawn at their bound village. `resolveDeaths` is unchanged — it already reads `p.spawn`.)

- [ ] **Step 8: Run the bind test + a broad authority sanity check**

Run: `cd backend && node --test tests/villageBind.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/src/authority/world.js backend/src/authority/server.js backend/tests/villageBind.test.js
git commit -m "feat(authority): bind player to village on entry + respawn at bind"
```

---

### Task 6: Village CRUD routes

**Files:**
- Modify: `backend/src/index.js` (add `GET/POST/DELETE /api/worlds/:id/villages`; add `validateVillageBody` helper)
- Test: `backend/tests/villageRoutes.test.js`

**Interfaces:**
- Consumes: `adminGuard`, `pool`, `invalidateWorld`, `isBoundedWorld` (all already in index.js); `fetchVillages` (Task 4).
- Produces:
  - `GET /api/worlds/:id/villages` → `[{ id, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y }]` (raw rows).
  - `POST /api/worlds/:id/villages` (adminGuard) → validates + inserts, invalidates world, returns the new row.
  - `DELETE /api/worlds/:id/villages/:villageId` (adminGuard) → deletes, invalidates world, 204.
  - `validateVillageBody(body, worldRow, existing)` (module-local pure fn) → error string or `null`.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/villageRoutes.test.js
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
const WORLD = (over = {}) => ({ id: 'w1', width: 30, height: 30, ...over });

test('POST village inserts a valid village and invalidates the world', async () => {
  const pool = mockPool([
    [/SELECT id, width, height FROM worlds WHERE id = \$1/i, (p) => ({ rows: [WORLD({ id: p[0] })] })],
    [/SELECT .* FROM villages WHERE world_id = \$1/i, () => ({ rows: [] })],
    [/INSERT INTO villages/i, (p) => ({ rows: [{ id: 'v1', min_row: p[1], min_col: p[2] }] })],
    [/DELETE FROM world_chunks/i, () => ({ rows: [], rowCount: 0 })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/worlds/w1/villages').set(...AUTH)
    .send({ min_row: 5, min_col: 5, width: 8, height: 6, gate_edge: 'S', spawn_x: 650, spawn_y: 550 });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, 'v1');
  assert.equal(pool.calls.filter((c) => /INSERT INTO villages/i.test(c.sql)).length, 1);
  assert.equal(pool.calls.filter((c) => /DELETE FROM world_chunks/i.test(c.sql)).length, 1);
});

test('POST village rejects out-of-range dimensions', async () => {
  const pool = mockPool([
    [/SELECT id, width, height FROM worlds WHERE id = \$1/i, (p) => ({ rows: [WORLD({ id: p[0] })] })],
    [/SELECT .* FROM villages WHERE world_id = \$1/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/worlds/w1/villages').set(...AUTH)
    .send({ min_row: 5, min_col: 5, width: 20, height: 6, gate_edge: 'S', spawn_x: 650, spawn_y: 550 });
  assert.equal(res.status, 400);
  assert.equal(pool.calls.filter((c) => /INSERT INTO villages/i.test(c.sql)).length, 0);
});

test('POST village rejects a box that does not fit in world bounds', async () => {
  const pool = mockPool([
    [/SELECT id, width, height FROM worlds WHERE id = \$1/i, (p) => ({ rows: [WORLD({ id: p[0], width: 10, height: 10 })] })],
    [/SELECT .* FROM villages WHERE world_id = \$1/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/worlds/w1/villages').set(...AUTH)
    .send({ min_row: 8, min_col: 8, width: 8, height: 6, gate_edge: 'S', spawn_x: 850, spawn_y: 850 });
  assert.equal(res.status, 400);
});

test('DELETE village removes the row and invalidates the world', async () => {
  const pool = mockPool([
    [/DELETE FROM villages WHERE id = \$1/i, () => ({ rows: [], rowCount: 1 })],
    [/DELETE FROM world_chunks/i, () => ({ rows: [], rowCount: 0 })],
  ]);
  __setPool(pool);
  const res = await request(app).delete('/api/worlds/w1/villages/v1').set(...AUTH);
  assert.equal(res.status, 204);
  assert.equal(pool.calls.filter((c) => /DELETE FROM villages/i.test(c.sql)).length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/villageRoutes.test.js`
Expected: FAIL — routes 404 / not defined.

- [ ] **Step 3: Add `validateVillageBody` and the three routes to `index.js`**

Add the validator near the other route helpers (e.g. below `invalidateWorld`):

```js
function validateVillageBody(body, worldRow, existing) {
  const { min_row, min_col, width, height, gate_edge, spawn_x, spawn_y } = body || {};
  const ints = [min_row, min_col, width, height].every((n) => Number.isInteger(n));
  if (!ints) return 'min_row, min_col, width, height must be integers';
  if (width < 3 || width > 8) return 'width must be between 3 and 8 tiles';
  if (height < 3 || height > 6) return 'height must be between 3 and 6 tiles';
  if (!['N', 'E', 'S', 'W'].includes(gate_edge)) return 'gate_edge must be one of N,E,S,W';
  if (!Number.isFinite(spawn_x) || !Number.isFinite(spawn_y)) return 'spawn_x and spawn_y are required';
  if (min_row < 0 || min_col < 0) return 'min_row and min_col must be >= 0';
  if (worldRow.width && (min_col + width > worldRow.width || min_row + height > worldRow.height)) {
    return 'village box must fit inside the world bounds';
  }
  // spawn must land on an interior tile of the box
  const sCol = Math.floor(spawn_x / 100), sRow = Math.floor(spawn_y / 100);
  const inInterior = sRow > min_row && sRow < min_row + height - 1 && sCol > min_col && sCol < min_col + width - 1;
  if (!inInterior) return 'spawn point must be inside the village interior';
  // no overlap with an existing village box
  for (const v of existing) {
    const overlap = min_col <= v.min_col + v.width - 1 && min_col + width - 1 >= v.min_col &&
                    min_row <= v.min_row + v.height - 1 && min_row + height - 1 >= v.min_row;
    if (overlap) return 'village overlaps an existing village';
  }
  return null;
}

app.get('/api/worlds/:id/villages', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y
         FROM villages WHERE world_id = $1 ORDER BY created_at ASC`,
      [req.params.id],
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list villages' });
  }
});

app.post('/api/worlds/:id/villages', adminGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const wr = await pool.query('SELECT id, width, height FROM worlds WHERE id = $1', [id]);
    if (wr.rows.length === 0) return res.status(404).json({ error: 'world not found' });
    const existing = (await pool.query(
      'SELECT min_row, min_col, width, height FROM villages WHERE world_id = $1', [id],
    )).rows;
    const err = validateVillageBody(req.body, wr.rows[0], existing);
    if (err) return res.status(400).json({ error: err });
    const { min_row, min_col, width, height, gate_edge, spawn_x, spawn_y } = req.body;
    const ins = await pool.query(
      `INSERT INTO villages (world_id, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y],
    );
    await invalidateWorld(id);
    res.json(ins.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create village' });
  }
});

app.delete('/api/worlds/:id/villages/:villageId', adminGuard, async (req, res) => {
  try {
    const { id, villageId } = req.params;
    await pool.query('DELETE FROM villages WHERE id = $1 AND world_id = $2', [villageId, id]);
    await invalidateWorld(id);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete village' });
  }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/villageRoutes.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the sibling route suites for regressions**

Run: `cd backend && node --test tests/worldLinksRoutes.test.js tests/worldsAdminRoutes.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/index.js backend/tests/villageRoutes.test.js
git commit -m "feat(api): village CRUD routes with validation + world invalidation"
```

---

### Task 7: MapsAdmin village editor + hooks

**Files:**
- Modify: `frontend/src/games/something2/useMapsAdmin.js` (add `useWorldVillages`, `useAddVillage`, `useDeleteVillage`)
- Modify: `frontend/src/games/something2/MapsAdmin.jsx` (village editor UI in `MapCard`)
- Test: manual/browser (frontend has no component test harness yet — see Global Constraints)

**Interfaces:**
- Consumes: `API_URL`, `authHeaders`, TanStack `useMutation`/`useQuery`/`useQueryClient`, `toast` — all already imported in `useMapsAdmin.js`.
- Produces:
  - `useWorldVillages(worldId)` → `villages || []` (query key `["worldVillages", worldId]`).
  - `useAddVillage()` → mutation `{ id, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y }`.
  - `useDeleteVillage()` → mutation `{ id, villageId }`.

- [ ] **Step 1: Add the hooks to `useMapsAdmin.js`**

Mirror the `useWorldLinks`/`useSetLink`/`useClearLink` pattern exactly:

```js
export function useWorldVillages(worldId) {
  const { data } = useQuery({
    queryKey: ["worldVillages", worldId],
    enabled: !!worldId,
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/worlds/${worldId}/villages`, { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to load villages");
      return res.json();
    },
  });
  return data || [];
}

export function useAddVillage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }) => {
      const res = await fetch(`${API_URL}/api/worlds/${id}/villages`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to add village");
      return res.json();
    },
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ["worldVillages", v.id] }); toast.success("Village added"); },
    onError: (err) => toast.error(err.message),
  });
}

export function useDeleteVillage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, villageId }) => {
      const res = await fetch(`${API_URL}/api/worlds/${id}/villages/${villageId}`, {
        method: "DELETE", headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to delete village");
    },
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ["worldVillages", v.id] }); toast.success("Village deleted"); },
    onError: (err) => toast.error(err.message),
  });
}
```

- [ ] **Step 2: Add the village editor to `MapCard` in `MapsAdmin.jsx`**

Import the new hooks at the top of the file (add to the existing `useMapsAdmin` import). Inside `MapCard`, wire the hooks and local add-form state:

```js
  const villages = useWorldVillages(world.id);
  const addVillage = useAddVillage();
  const delVillage = useDeleteVillage();
  const [vMinRow, setVMinRow] = useState(1);
  const [vMinCol, setVMinCol] = useState(1);
  const [vW, setVW] = useState(6);
  const [vH, setVH] = useState(5);
  const [vGate, setVGate] = useState('S');
```

Render a Villages section below the Links row. Default the spawn to the box interior center (`(min_col + width/2) * 100`, `(min_row + height/2) * 100`):

```jsx
<Row style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
  <span style={{ color: '#aaa' }}>Villages:</span>
  {villages.map((v) => (
    <div key={v.id} style={{ color: '#ccc', display: 'flex', gap: 8, alignItems: 'center' }}>
      <span>({v.min_row},{v.min_col}) {v.width}×{v.height} gate {v.gate_edge}</span>
      <button onClick={() => delVillage.mutate({ id: world.id, villageId: v.id })}>Delete</button>
    </div>
  ))}
  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
    row <input type="number" value={vMinRow} onChange={(e) => setVMinRow(+e.target.value)} style={{ width: 52 }} />
    col <input type="number" value={vMinCol} onChange={(e) => setVMinCol(+e.target.value)} style={{ width: 52 }} />
    w <input type="number" min={3} max={8} value={vW} onChange={(e) => setVW(+e.target.value)} style={{ width: 44 }} />
    h <input type="number" min={3} max={6} value={vH} onChange={(e) => setVH(+e.target.value)} style={{ width: 44 }} />
    gate <select value={vGate} onChange={(e) => setVGate(e.target.value)}>
      {['N', 'E', 'S', 'W'].map((x) => <option key={x} value={x}>{x}</option>)}
    </select>
    <button onClick={() => addVillage.mutate({
      id: world.id, min_row: vMinRow, min_col: vMinCol, width: vW, height: vH, gate_edge: vGate,
      spawn_x: (vMinCol + vW / 2) * 100, spawn_y: (vMinRow + vH / 2) * 100,
    })}>Add village</button>
  </div>
</Row>
```

(Use the existing `Row`, `Input`/`button` styling primitives already in the file — match whatever the Links row uses. If `Input` is a styled component, use it in place of raw `<input>` to match.)

- [ ] **Step 3: Build the frontend to verify no syntax/import errors**

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Run the frontend unit suite (regression)**

Run: `cd frontend && npm test`
Expected: PASS (existing 179 tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/useMapsAdmin.js frontend/src/games/something2/MapsAdmin.jsx
git commit -m "feat(client): MapsAdmin village editor (add/list/delete)"
```

---

## Final browser verification (whole-slice, after all tasks)

Restart the manually-started backend node (NOT `docker restart`):
```bash
docker exec -d something2-backend-1 sh -c 'cd /app && node src/index.js > /tmp/backend.log 2>&1'
```

Then, as admin in the Maps tab:
1. Add a village (e.g. 6×5, gate S) to a bounded map → **walls + a single gate tile render**; player blocked by walls, passes through the gate.
2. Re-roll creatures → **no creature spawns inside the village box** (all outside).
3. Walk the player into the village, then die (let a creature kill you or via a test hook) → **respawn at the village spawn point**.
4. Reconnect after binding → still respawn at the village on death.
5. Delete the village → walls/gate gone after chunk invalidation.

Confirm the browser console is clean throughout.

---

## Self-Review

**Spec coverage** (against `2026-07-22-villages-economy-design.md` Slice A):
- `wooden_wall`/`village_gate` tiles → Task 1. ✅
- `villages` table + `stampVillage` interior overlay in `generateRegion` → Tasks 1, 2. ✅
- `placeMapCreatures` no-spawn in village boxes → Task 3. ✅
- Villages loaded alongside bounds in `loadWorld` (`fetchVillages`) → Task 4. ✅
- Bind-on-enter sets `p.spawn` + persists (`player_binds`); `resolveDeaths` respawns for free → Task 5. ✅
- Village CRUD routes with adminGuard + `invalidateWorld` → Task 6. ✅
- Maps tab village editor → Task 7. ✅
- `player_binds` single cross-world bind (decision 1); cross-world respawn deferred → Global Constraints + Task 5. ✅
- Entry seam (`entry_spawn` from a village): the admin already sets `entry_spawn` via the existing PUT route (Slice 2); a village's spawn coords can be typed into that field. A convenience "use village spawn as entry" button is **out of scope** for Slice A (no new requirement lost — the seam already works via entry_spawn). Noted, not a gap.

**Placeholder scan:** none — every code step carries complete code.

**Type consistency:** `villageContaining`/`pointInVillageBox`/`stampVillage` signatures match across Tasks 2/3/5; `cfg.villages` camelCase shape is consistent (Task 2 defines, Tasks 3/5 consume); `fetchVillages` returns camelCase (Task 4) feeding `worldConfig` (Task 2); `player_binds` columns match between migration (Task 1), `upsertBind`/`loadSpawn` (Task 5), routes never touch it. Route SQL regexes in tests match the emitted SQL (Task 6).
