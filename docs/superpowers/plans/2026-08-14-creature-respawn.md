# Creature Respawn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A world that players fight in refills itself, without operator action, and without a creature ever materialising on top of a player.

**Architecture:** A creature's death enqueues a row in a new `creature_respawns` table, inside the transaction that already commits the death. A sweep on its own 10-second timer drains due rows back into `world_creatures`, acting only on worlds currently loaded in the authority. A deficit backstop at world load enqueues immediately-due rows for populations lost before this shipped.

**Tech Stack:** Node/CommonJS, raw `pg`, `node-pg-migrate`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-14-creature-respawn-design.md`

**Ticket:** SOMET-309

## Global Constraints

- **Constants, exact values:** `RESPAWN_DELAY_MS = 30000`, `CREATURE_SWEEP_MS = 10000`, `RESPAWN_MIN_PLAYER_DISTANCE = 1000`.
- **Expected values in tests are written as hand-typed literals, never recomputed from the constant under test.** A test that derives its expectation from `RESPAWN_MIN_PLAYER_DISTANCE` passes for every value of `RESPAWN_MIN_PLAYER_DISTANCE` and therefore tests nothing.
- **`home_x IS NOT NULL` is the guard marker.** Village, portal and vault guards all set it; wild creatures never do. Never use `type <> 'Village Guard'` as a guard filter — a portal or vault guard can be any creature type.
- **Never run destructive DB experiments against the shared dev database.** No `DELETE FROM` against a live table to "see what happens", no re-seeding, no dropping.
- **NEVER `docker restart` these containers.** Their CMD is `tail -f /dev/null`; vite and nodemon run *inside*. A restart kills the dev server with nothing to revive it. To reload the backend, `touch backend/src/index.js`.
- **Do not seed, migrate against, or otherwise mutate the shared dev database** unless a task explicitly says to. Task 1 is the only task that runs a migration.
- **The sweep must never load a world into memory.** Nothing but a socket close handler evicts a world, so a sweep that loads one leaks it permanently. `getWorld` returns `null` for an unloaded world and the row stays due.
- **`client.release()` does not roll back.** Every `BEGIN` needs an explicit `COMMIT` or `ROLLBACK` on every path, or the connection returns to the pool holding an open transaction.

---

### Task 1: The `creature_respawns` table

**Files:**
- Create: `backend/migrations/1714440300000_creature_respawns.js`
- Test: `backend/tests/creature_respawns_migration_db.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: table `creature_respawns` with columns `id uuid`, `world_id uuid`, `type text`, `x real`, `y real`, `level integer`, `respawn_at timestamptz`, `created_at timestamptz`.

**Timestamp collision warning:** this repo has had two migration-timestamp collisions between parallel branches. `1714440300000` deliberately skips `…290000` to leave room. Before starting, run `ls backend/migrations/ | sort | tail -3` and confirm nothing has claimed `1714440300000`. If something has, use `1714440310000` and say so in your report.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/creature_respawns_migration_db.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('creature_respawns table has the columns the respawn queue needs', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'creature_respawns' ORDER BY column_name`,
    );
    const byName = Object.fromEntries(r.rows.map((c) => [c.column_name, c]));

    assert.equal(byName.world_id.data_type, 'uuid');
    assert.equal(byName.world_id.is_nullable, 'NO');
    assert.equal(byName.type.data_type, 'text');
    assert.equal(byName.level.data_type, 'integer');
    assert.equal(byName.respawn_at.data_type, 'timestamp with time zone');
    assert.equal(byName.respawn_at.is_nullable, 'NO');
    assert.equal(byName.x.data_type, 'real');
    assert.equal(byName.y.data_type, 'real');
  } finally {
    await pool.end();
  }
});

test('deleting a world removes its queued respawns', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(
      `SELECT confdeltype FROM pg_constraint
        WHERE conrelid = 'creature_respawns'::regclass AND contype = 'f'
          AND confrelid = 'worlds'::regclass`,
    );
    assert.equal(r.rowCount, 1);
    // 'c' = ON DELETE CASCADE. A queue row outliving its world would be a
    // permanently undeliverable respawn.
    assert.equal(r.rows[0].confdeltype, 'c');
  } finally {
    await pool.end();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && TEST_DATABASE_URL="$DATABASE_URL" node --test tests/creature_respawns_migration_db.test.js`

Expected: FAIL — `relation "creature_respawns" does not exist`.

If both tests report as *skipped* rather than failed, `TEST_DATABASE_URL` is unset and you are testing nothing. Export it from the repo-root `.env` and re-run before continuing.

- [ ] **Step 3: Write the migration**

Create `backend/migrations/1714440300000_creature_respawns.js`:

```js
exports.shorthands = undefined;

// SOMET-309: the respawn queue. A creature's death deletes its world_creatures
// row (authority/loot.js's commitCreatureDeath) and, in the SAME transaction,
// writes one row here. A sweep drains due rows back into world_creatures.
//
// WHY A SEPARATE TABLE RATHER THAN A COLUMN ON world_creatures: a pending
// respawn is not a creature. Keeping a dead creature's row around with a
// `dead_until` timestamp would put a non-entity in the table every reader
// treats as "things that exist in the world" -- the authority's chunk loader,
// the admin overview, worlds.creature_count, and populateWorld's own wipe
// predicate would each need a new exclusion, and any one of them forgetting it
// ships an invisible unkillable creature. Nothing is in both tables at once.
//
// WHY NO hp/damage/defense COLUMNS: creatureLevel.js's scaleCreature(base,
// level) derives all three from the entity_types row plus a level, which is
// exactly what placeMapCreatures already does at seeding time. Storing `type`
// and `level` is therefore sufficient, and it means a catalog rebalance
// applies to every creature that respawns after it rather than resurrecting
// pre-nerf stats forever.
exports.up = (pgm) => {
  pgm.createTable('creature_respawns', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // CASCADE matches world_creatures' own FK: a deleted world must not strand
    // queue rows that can never be delivered.
    world_id: {
      type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE',
    },
    type: { type: 'text', notNull: true },
    x: { type: 'real', notNull: true },
    y: { type: 'real', notNull: true },
    level: { type: 'integer', notNull: true },
    respawn_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // The sweep's only query is "everything due, oldest first".
  pgm.createIndex('creature_respawns', 'respawn_at', { name: 'creature_respawns_due_index' });
  // The load-time backstop counts pending rows for one world.
  pgm.createIndex('creature_respawns', 'world_id', { name: 'creature_respawns_world_id_index' });
};

exports.down = (pgm) => {
  pgm.dropTable('creature_respawns');
};
```

- [ ] **Step 4: Apply the migration and re-run the test**

Run: `cd backend && npm run migrate:up && TEST_DATABASE_URL="$DATABASE_URL" node --test tests/creature_respawns_migration_db.test.js`

Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/1714440300000_creature_respawns.js backend/tests/creature_respawns_migration_db.test.js
git commit -m "feat(respawn): add the creature_respawns queue table (SOMET-309)"
```

---

### Task 2: Player-distance placement rule

**Files:**
- Create: `backend/src/services/creatureRespawn.js`
- Modify: `backend/src/services/mapService.js` (export `CREATURE_BASE_DAMAGE`)
- Test: `backend/tests/creature_respawn.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isClearOfPlayers(x, y, players, minDistance = RESPAWN_MIN_PLAYER_DISTANCE) -> boolean` where `players` is an array of `{ x, y }`.
  - Constants `RESPAWN_DELAY_MS`, `CREATURE_SWEEP_MS`, `RESPAWN_MIN_PLAYER_DISTANCE`.
  - `CREATURE_BASE_DAMAGE` exported from `mapService.js`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/creature_respawn.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const {
  isClearOfPlayers, RESPAWN_DELAY_MS, CREATURE_SWEEP_MS, RESPAWN_MIN_PLAYER_DISTANCE,
} = require('../src/services/creatureRespawn');

test('an empty world is clear everywhere', () => {
  assert.equal(isClearOfPlayers(0, 0, []), true);
});

test('a position exactly at the minimum distance is clear', () => {
  // 1000 world px = 10 tiles at MAP_TILE_SIZE 100. Hand-typed, NOT derived
  // from RESPAWN_MIN_PLAYER_DISTANCE -- a test that reads the constant it is
  // testing passes for any value of that constant.
  assert.equal(isClearOfPlayers(1000, 0, [{ x: 0, y: 0 }]), true);
});

test('a position inside the minimum distance is not clear', () => {
  assert.equal(isClearOfPlayers(999, 0, [{ x: 0, y: 0 }]), false);
});

test('distance is measured diagonally, not per-axis', () => {
  // (700,700) is 700 away on each axis but 989.9 away in a straight line,
  // which is inside 1000. A per-axis check would wrongly call this clear.
  assert.equal(isClearOfPlayers(700, 700, [{ x: 0, y: 0 }]), false);
});

test('one nearby player is enough to reject, however many are far away', () => {
  const players = [{ x: 9000, y: 9000 }, { x: 50, y: 50 }, { x: -9000, y: 0 }];
  assert.equal(isClearOfPlayers(0, 0, players), false);
});

test('the shipped constants are the values the design settled on', () => {
  assert.equal(RESPAWN_DELAY_MS, 30000);
  assert.equal(CREATURE_SWEEP_MS, 10000);
  assert.equal(RESPAWN_MIN_PLAYER_DISTANCE, 1000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test tests/creature_respawn.test.js`

Expected: FAIL — `Cannot find module '../src/services/creatureRespawn'`.

- [ ] **Step 3: Create the module**

Create `backend/src/services/creatureRespawn.js`:

```js
// SOMET-309: creature respawn. A death enqueues a creature_respawns row (see
// authority/loot.js); this module drains due rows back into world_creatures.
//
// Deliberately NOT part of worldPopulation.js. That module is wipe-and-refill
// -- it opens by DELETEing every wild creature in a world and places a
// complete fresh set -- which is the opposite lifecycle to incremental top-up,
// and folding a hot per-death path into a seeding module would couple them for
// no gain.

// The delay between a creature dying and its replacement becoming due.
const RESPAWN_DELAY_MS = 30000;

// The sweep's own interval. NOT itemSweepMs, which is 60000: draining a
// 30-second queue on a 60-second timer would make respawns take 30-90s and
// silently undo the pacing this feature was tuned for.
const CREATURE_SWEEP_MS = 10000;

// World px. MAP_TILE_SIZE is 100, so this is 10 tiles. The viewport shows
// roughly 15x15 tiles, so this keeps a spawn off the middle of someone's
// screen without pushing it so far that a cleared area never refills.
const RESPAWN_MIN_PLAYER_DISTANCE = 1000;

// True when no player is closer than minDistance to (x, y).
//
// Compares squared distances so the hot path takes no Math.sqrt. Strictly
// less-than: a player at exactly minDistance does not block the position, so
// the boundary belongs to the spawn.
function isClearOfPlayers(x, y, players, minDistance = RESPAWN_MIN_PLAYER_DISTANCE) {
  const min2 = minDistance * minDistance;
  for (const p of players) {
    const dx = p.x - x;
    const dy = p.y - y;
    if (dx * dx + dy * dy < min2) return false;
  }
  return true;
}

module.exports = {
  isClearOfPlayers,
  RESPAWN_DELAY_MS, CREATURE_SWEEP_MS, RESPAWN_MIN_PLAYER_DISTANCE,
};
```

- [ ] **Step 4: Export `CREATURE_BASE_DAMAGE` from mapService**

In `backend/src/services/mapService.js`, find the `module.exports = {` block (around line 1305) and add `CREATURE_BASE_DAMAGE,` to it, next to `placeMapCreatures,`.

The constant already exists at line 615 (`const CREATURE_BASE_DAMAGE = 5;`) and is used at lines 711 and 768. Task 3 needs it to scale a respawned creature to the level recorded in its queue row. Do not redeclare it in the new module — a second copy that drifts from this one would give respawned creatures different damage from seeded ones of the same type and level.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && node --test tests/creature_respawn.test.js`

Expected: PASS, 6/6.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/creatureRespawn.js backend/src/services/mapService.js backend/tests/creature_respawn.test.js
git commit -m "feat(respawn): player-distance placement rule and respawn constants (SOMET-309)"
```

---

### Task 3: The sweep

**Files:**
- Modify: `backend/src/services/creatureRespawn.js`
- Test: `backend/tests/creature_respawn.test.js` (append)

**Interfaces:**
- Consumes: `isClearOfPlayers`, `RESPAWN_MIN_PLAYER_DISTANCE` from Task 2; `CREATURE_BASE_DAMAGE`, `placeMapCreatures` from `mapService.js`; `scaleCreature` from `creatureLevel.js`.
- Produces: `respawnDueCreatures(pool, { getWorld, getPlayers, onSpawn, limit }) -> Promise<number>` (count spawned).
  - `getWorld(worldId) -> worldGenConfig | null` — **must** be the `buildWorldGenConfig` shape (camelCase `levelMin`/`levelMax`, `tileTypes`, `width`, `height`), never a raw `worlds` row.
  - `getPlayers(worldId) -> Array<{x, y}>`
  - `onSpawn({ worldId, creatureId }) -> Promise<void>`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/creature_respawn.test.js`:

```js
const { respawnDueCreatures } = require('../src/services/creatureRespawn');

// A pool double. `queries` records every SQL string so a test can assert on
// what the sweep actually asked the database, and `handler` decides each
// reply. connect() hands back the same object so BEGIN/COMMIT are recorded in
// the same list as everything else.
function fakePool(handler) {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return handler(sql, params) || { rows: [], rowCount: 0 };
    },
    release() { this.released = true; },
    released: false,
  };
  return {
    queries,
    client,
    query: client.query,
    connect: async () => client,
  };
}

const DUE_ROW = {
  id: 'row-1', world_id: 'w1', type: 'Wolf', x: 500, y: 500, level: 3,
};
const WOLF_TYPE = {
  id: 7, name: 'Wolf', hp: 20, defense: 2, resistances: null,
};

test('a row whose world is not loaded stays due and spawns nothing', async () => {
  const pool = fakePool((sql) => {
    if (sql.includes('FROM creature_respawns')) return { rows: [DUE_ROW], rowCount: 1 };
    return null;
  });

  const spawned = await respawnDueCreatures(pool, {
    getWorld: () => null,
    getPlayers: () => [],
  });

  assert.equal(spawned, 0);
  // The whole point: no DELETE, so the row is retried on a later sweep.
  assert.equal(pool.queries.some((q) => q.sql.includes('DELETE FROM creature_respawns')), false);
});

test('a row whose creature type is gone from the catalog is deleted, not retried', async () => {
  const pool = fakePool((sql) => {
    if (sql.includes('FROM creature_respawns')) return { rows: [DUE_ROW], rowCount: 1 };
    if (sql.includes('FROM entity_types')) return { rows: [], rowCount: 0 };
    return null;
  });

  const spawned = await respawnDueCreatures(pool, {
    getWorld: () => ({ tileTypes: [{ name: 'grass' }], width: 96, height: 96, levelMin: 1, levelMax: 5 }),
    getPlayers: () => [],
  });

  assert.equal(spawned, 0);
  // Retrying forever would pin a permanently-failing row at the head of every
  // sweep, starving the rows behind it.
  assert.equal(pool.queries.some((q) => q.sql.includes('DELETE FROM creature_respawns')), true);
  assert.equal(pool.queries.some((q) => q.sql.includes('INSERT INTO world_creatures')), false);
});

test('one failing row does not stop later rows in the same pass', async () => {
  const rows = [
    { ...DUE_ROW, id: 'row-1' },
    { ...DUE_ROW, id: 'row-2' },
  ];
  let entityTypeCalls = 0;
  const pool = fakePool((sql) => {
    if (sql.includes('FROM creature_respawns')) return { rows, rowCount: 2 };
    if (sql.includes('FROM entity_types')) {
      entityTypeCalls += 1;
      if (entityTypeCalls === 1) throw new Error('transient DB error');
      return { rows: [WOLF_TYPE], rowCount: 1 };
    }
    if (sql.includes('DELETE FROM creature_respawns')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO world_creatures')) return { rows: [{ id: 'c-2' }], rowCount: 1 };
    return null;
  });

  const spawned = await respawnDueCreatures(pool, {
    getWorld: () => ({ tileTypes: [{ name: 'grass' }], width: 96, height: 96, levelMin: 1, levelMax: 5 }),
    getPlayers: () => [],
  });

  assert.equal(spawned, 1);
});

test('a respawn reuses the recorded position when no player is near it', async () => {
  const pool = fakePool((sql) => {
    if (sql.includes('FROM creature_respawns')) return { rows: [DUE_ROW], rowCount: 1 };
    if (sql.includes('FROM entity_types')) return { rows: [WOLF_TYPE], rowCount: 1 };
    if (sql.includes('DELETE FROM creature_respawns')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO world_creatures')) return { rows: [{ id: 'c-1' }], rowCount: 1 };
    return null;
  });

  const seen = [];
  const spawned = await respawnDueCreatures(pool, {
    getWorld: () => ({ tileTypes: [{ name: 'grass' }], width: 96, height: 96, levelMin: 1, levelMax: 5 }),
    getPlayers: () => [{ x: 9000, y: 9000 }],
    onSpawn: async (s) => { seen.push(s); },
  });

  assert.equal(spawned, 1);
  const insert = pool.queries.find((q) => q.sql.includes('INSERT INTO world_creatures'));
  // params: world_id, type, x, y, hp, facing, level, damage, defense
  assert.equal(insert.params[2], 500);
  assert.equal(insert.params[3], 500);
  assert.equal(insert.params[6], 3); // the recorded level, not a re-roll
  assert.deepEqual(seen, [{ worldId: 'w1', creatureId: 'c-1' }]);
});

test('the sweep claims each row with a gated DELETE inside a transaction', async () => {
  const pool = fakePool((sql) => {
    if (sql.includes('FROM creature_respawns')) return { rows: [DUE_ROW], rowCount: 1 };
    if (sql.includes('FROM entity_types')) return { rows: [WOLF_TYPE], rowCount: 1 };
    // rowCount 0 = another sweep already claimed this row.
    if (sql.includes('DELETE FROM creature_respawns')) return { rows: [], rowCount: 0 };
    return null;
  });

  const spawned = await respawnDueCreatures(pool, {
    getWorld: () => ({ tileTypes: [{ name: 'grass' }], width: 96, height: 96, levelMin: 1, levelMax: 5 }),
    getPlayers: () => [],
  });

  assert.equal(spawned, 0);
  // Losing the claim race must not insert a creature -- that is the
  // double-spawn this gate exists to prevent.
  assert.equal(pool.queries.some((q) => q.sql.includes('INSERT INTO world_creatures')), false);
  assert.equal(pool.queries.some((q) => q.sql === 'ROLLBACK'), true);
  assert.equal(pool.client.released, true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && node --test tests/creature_respawn.test.js`

Expected: FAIL — `respawnDueCreatures is not a function`.

- [ ] **Step 3: Implement the sweep**

Add to `backend/src/services/creatureRespawn.js`. Add these requires at the top of the file:

```js
const { placeMapCreatures, CREATURE_BASE_DAMAGE } = require('./mapService');
const { scaleCreature } = require('./creatureLevel');
```

Then append before `module.exports`:

```js
// How many candidate tiles to ask placeMapCreatures for when the recorded
// position is blocked. More than one because placeMapCreatures does not know
// about players -- it rejects on terrain, village safe zones, safe_road_radius
// and safe_rects only -- so its first answer can still land next to someone.
const FALLBACK_CANDIDATES = 5;

// Drains due creature_respawns rows back into world_creatures.
//
// Modelled on chests.js's respawnDueFieldChests, deliberately: same injected
// getWorld serving only LOADED worlds, same per-row try/catch, same onSpawn
// patch contract, same test seam on the server. Two sweep idioms for two
// respawning things would be one too many.
//
// getWorld returns null for a world that is not currently loaded, and that row
// simply stays due for a later pass. The sweep must never load a world itself:
// nothing but a socket close handler evicts one, so a background load would
// leak a permanently-loaded empty world.
async function respawnDueCreatures(pool, {
  getWorld, getPlayers, onSpawn = () => {}, limit = 200,
} = {}) {
  const due = await pool.query(
    `SELECT id, world_id, type, x, y, level FROM creature_respawns
      WHERE respawn_at <= now() ORDER BY respawn_at LIMIT $1`,
    [limit],
  );

  let spawned = 0;
  for (const row of due.rows) {
    try {
      const world = getWorld(row.world_id);
      if (!world) continue; // not loaded this pass; stays due, retried later

      // Full row: placeMapCreatures reads .hp/.defense/.resistances off each
      // allowed type, and scaleCreature needs hp/defense too. A name-only row
      // would silently respawn every creature at the 10hp/0-defense fallback.
      const et = await pool.query(
        `SELECT id, name, hp, defense, resistances FROM entity_types
          WHERE name = $1 AND is_creature = true`,
        [row.type],
      );
      if (et.rowCount === 0) {
        // The catalog no longer has this creature. Retrying forever would pin
        // a permanently-failing row at the head of every sweep; drop it.
        await pool.query('DELETE FROM creature_respawns WHERE id = $1', [row.id]);
        continue;
      }
      const t = et.rows[0];
      const players = getPlayers(row.world_id);

      // Prefer the tile it died on. Relocate rather than defer when a player
      // is standing there: deferring would mean the more someone farms one
      // spot, the less it gives them -- the opposite of this feature's point.
      let pos = null;
      if (isClearOfPlayers(row.x, row.y, players)) {
        pos = { x: row.x, y: row.y };
      } else {
        const seed = Math.floor(Math.random() * 2 ** 31);
        const candidates = placeMapCreatures(world, FALLBACK_CANDIDATES, [t], seed);
        // placeMapCreatures is used purely as a legal-tile finder here; its
        // own level roll is discarded so the respawn keeps the level it died
        // at rather than re-rolling into a different band.
        const clear = candidates.find((c) => isClearOfPlayers(c.x, c.y, players));
        if (!clear) continue; // no legal tile clear of players this pass; retry later
        pos = { x: clear.x, y: clear.y };
      }

      const scaled = scaleCreature(
        { hp: t.hp || 10, damage: CREATURE_BASE_DAMAGE, defense: Number(t.defense ?? 0) || 0 },
        row.level,
      );

      const client = await pool.connect();
      let creatureId = null;
      try {
        await client.query('BEGIN');
        // Gated exactly like commitCreatureDeath's own DELETE: rowCount === 1
        // means THIS pass claimed the row. Two concurrent sweeps seeing the
        // same due row must produce exactly one creature, and the loser must
        // insert nothing.
        const claim = await client.query('DELETE FROM creature_respawns WHERE id = $1', [row.id]);
        if (claim.rowCount !== 1) {
          await client.query('ROLLBACK');
          continue;
        }
        const ins = await client.query(
          `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage, defense)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [row.world_id, t.name, pos.x, pos.y, scaled.hp, 'S', row.level, scaled.damage, scaled.defense],
        );
        await client.query('COMMIT');
        creatureId = ins.rows[0].id;
      } catch (err) {
        // client.release() does NOT roll back -- without this the connection
        // returns to the pool holding an open transaction.
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      spawned += 1;
      // Counted above: the DB write committed, so this creature EXISTS
      // regardless of whether the caller's best-effort cache sync throws.
      // Awaited so the server's test seam observes the injection.
      await onSpawn({ worldId: row.world_id, creatureId });
    } catch (err) {
      // One bad row must not abort the pass -- every other due row still gets
      // its turn, and this one stays due for a retry.
      console.error(`respawnDueCreatures: failed to respawn row ${row.id}:`, err);
    }
  }
  return spawned;
}
```

Add `respawnDueCreatures` to `module.exports`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && node --test tests/creature_respawn.test.js`

Expected: PASS, 11/11 (6 from Task 2 plus 5 new).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/creatureRespawn.js backend/tests/creature_respawn.test.js
git commit -m "feat(respawn): drain due respawn rows back into world_creatures (SOMET-309)"
```

---

### Task 4: Enqueue on death

**Files:**
- Modify: `backend/src/authority/loot.js` (the `DELETE` at ~line 75 and the block after the `rowCount` gate)
- Test: `backend/tests/creature_respawn_db.test.js` (create)

**Interfaces:**
- Consumes: `RESPAWN_DELAY_MS` from `creatureRespawn.js`.
- Produces: every wild creature death writes one `creature_respawns` row; no guard death writes any.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/creature_respawn_db.test.js`. This test drives `commitCreatureDeath` directly against the database.

```js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { commitCreatureDeath } = require('../src/authority/loot');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// A minimal `entry`. commitCreatureDeath reaches into `entry` in four places
// and only one of them is unguarded:
//
//   entry.creatureTypeIds.get(dead.type)  -- loot.js:131, NO null guard, so
//       this field MUST be present or every test here dies with a TypeError.
//       An empty Map makes spawnDrops return at its `entityTypeId == null`
//       check (loot.js:132), so no drop rows are written and
//       entry.world.groundItems is never touched.
//   entry.behaviorDrops / entry.creatureGold / entry.behaviorGold -- all
//       guarded with `&&`, so omitting them yields no drops and zero gold.
//   entry.goldItemTypeId -- guarded with `!= null`.
//   entry.world.getPlayer -- only reached when killerUserId != null.
//
// A null killer skips the XP branch entirely, which is what keeps this test
// about the respawn queue and not about progression.
function fakeEntry(worldId) {
  return {
    worldId,
    world: { getPlayer: () => null },
    creatureTypeIds: new Map(),
  };
}

// Creates a world we own outright, so nothing here touches shared content.
// NEVER run destructive statements against existing rows in this database.
//
// `seed` is NOT NULL with no default and MUST be supplied -- terrain is a
// function of (seed, size), so a world with no seed is not merely untidy, it
// cannot generate. `name` is likewise NOT NULL and is randomised so parallel
// runs of this suite cannot collide.
async function makeWorld(pool) {
  const r = await pool.query(
    `INSERT INTO worlds (name, seed, width, height, density, chunk_size)
     VALUES ($1, 4242, 96, 96, 'normal', 32) RETURNING id`,
    [`respawn-test-${Date.now()}-${Math.random()}`],
  );
  return r.rows[0].id;
}

test('killing a wild creature queues exactly one respawn', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const worldId = await makeWorld(pool);
    const c = await pool.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage, defense)
       VALUES ($1,'Wolf',1234,5678,20,'S',4,7,2) RETURNING id`,
      [worldId],
    );

    const res = await commitCreatureDeath(pool, fakeEntry(worldId), c.rows[0].id, { killerUserId: null });
    assert.notEqual(res, null);

    const q = await pool.query(
      'SELECT type, x, y, level FROM creature_respawns WHERE world_id = $1', [worldId],
    );
    assert.equal(q.rowCount, 1);
    assert.equal(q.rows[0].type, 'Wolf');
    assert.equal(q.rows[0].x, 1234);
    assert.equal(q.rows[0].y, 5678);
    assert.equal(q.rows[0].level, 4);

    await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]); // cascades
  } finally {
    await pool.end();
  }
});

test('killing a guard queues nothing', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const worldId = await makeWorld(pool);
    // home_x/home_y set = a guard. This is the structural marker every guard
    // kind shares; a type-name filter would miss a portal or vault guard,
    // which can be any ordinary creature type (e.g. a 'Wolf' portal guard).
    const c = await pool.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage, defense, home_x, home_y)
       VALUES ($1,'Wolf',100,100,20,'S',4,7,2,100,100) RETURNING id`,
      [worldId],
    );

    await commitCreatureDeath(pool, fakeEntry(worldId), c.rows[0].id, { killerUserId: null });

    const q = await pool.query('SELECT 1 FROM creature_respawns WHERE world_id = $1', [worldId]);
    assert.equal(q.rowCount, 0);

    await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
  } finally {
    await pool.end();
  }
});

test('a queued respawn is not due immediately', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const worldId = await makeWorld(pool);
    const c = await pool.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage, defense)
       VALUES ($1,'Wolf',10,10,20,'S',1,5,0) RETURNING id`,
      [worldId],
    );
    await commitCreatureDeath(pool, fakeEntry(worldId), c.rows[0].id, { killerUserId: null });

    const due = await pool.query(
      'SELECT 1 FROM creature_respawns WHERE world_id = $1 AND respawn_at <= now()', [worldId],
    );
    // 30s in the future, so a sweep running right now must not pick it up.
    assert.equal(due.rowCount, 0);

    await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
  } finally {
    await pool.end();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && TEST_DATABASE_URL="$DATABASE_URL" node --test tests/creature_respawn_db.test.js`

Expected: FAIL — the first test finds 0 rows where it expects 1.

If the tests report as *skipped*, `TEST_DATABASE_URL` is unset. Export it and re-run; a skipped suite is not a red test.

- [ ] **Step 3: Widen the `RETURNING` clause**

In `backend/src/authority/loot.js`, change the `DELETE` inside `commitCreatureDeath`:

```js
    const r = await client.query(
      'DELETE FROM world_creatures WHERE id = $1 '
      + 'RETURNING type, x, y, level, home_x, blocks_portal_id', [creatureId],
    );
```

- [ ] **Step 4: Add the enqueue**

Still inside `commitCreatureDeath`, immediately after `const dead = r.rows[0];`, insert:

```js
    // SOMET-309: schedule the replacement inside the SAME transaction that
    // commits this death. The header comment above establishes that the
    // delete, the XP award and the drop roll stand or fall together; the
    // respawn belongs in that set for the same reason. A kill that paid XP
    // and dropped loot but failed to queue its replacement would be a silent,
    // permanent population leak -- precisely the bug this ticket exists to fix.
    //
    // Wild creatures only. home_x is the structural marker every guard kind
    // shares (village, portal and vault guards all leash to a post via
    // home_x/home_y, and populateWorld's own wipe spares them on exactly this
    // column); blocks_portal_id catches a portal guard specifically. Guards
    // have their own lifecycles -- a vault guard is respawned by the chest
    // sweep -- and queueing them here would duplicate them.
    if (dead.home_x === null && dead.blocks_portal_id === null) {
      await client.query(
        `INSERT INTO creature_respawns (world_id, type, x, y, level, respawn_at)
         VALUES ($1,$2,$3,$4,$5, now() + ($6::int * interval '1 millisecond'))`,
        [entry.worldId, dead.type, dead.x, dead.y, dead.level, RESPAWN_DELAY_MS],
      );
    }
```

Add the require at the top of `loot.js`:

```js
const { RESPAWN_DELAY_MS } = require('../services/creatureRespawn');
```

`now() + interval` is computed by Postgres rather than in JS, matching how `chestLoot.js:96` sets its own `respawn_at`, so one clock governs due-ness.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && TEST_DATABASE_URL="$DATABASE_URL" node --test tests/creature_respawn_db.test.js`

Expected: PASS, 3/3.

- [ ] **Step 6: Run the existing loot tests for regressions**

Run: `cd backend && TEST_DATABASE_URL="$DATABASE_URL" node --test tests/loot*.test.js tests/creature*.test.js`

Expected: no new failures against the baseline you recorded before starting.

- [ ] **Step 7: Commit**

```bash
git add backend/src/authority/loot.js backend/tests/creature_respawn_db.test.js
git commit -m "feat(respawn): queue a replacement when a wild creature dies (SOMET-309)"
```

---

### Task 5: Wire the sweep into the authority

**Files:**
- Modify: `backend/src/authority/server.js`

**Interfaces:**
- Consumes: `respawnDueCreatures`, `CREATURE_SWEEP_MS` from `creatureRespawn.js`; the existing `injectGuardIntoSim(entry, ids)` at `server.js:1000`.
- Produces: `_creatureRespawnSweep` on the server's returned object (a test seam matching `_chestRespawnSweep`); `opts.creatureSweepMs` override.

- [ ] **Step 1: Add the require and the interval option**

At the top of `backend/src/authority/server.js`, alongside the other service requires:

```js
const { respawnDueCreatures, CREATURE_SWEEP_MS } = require('../services/creatureRespawn');
```

Next to `const itemSweepMs = opts.itemSweepMs || 60000;` (line ~328):

```js
  // Its own interval, NOT itemSweepMs (60000): a 30-second respawn queue
  // drained on a 60-second timer would take 30-90s per creature.
  const creatureSweepMs = opts.creatureSweepMs || CREATURE_SWEEP_MS;
```

- [ ] **Step 2: Add the sweep function**

Immediately after the existing `chestRespawnSweep` function (it ends around line 2509 with its `catch`), add:

```js
  // SOMET-309. getWorld/getPlayers both read the live `worlds` Map and return
  // null/[] for an unloaded world, so the sweep never causes a world to load
  // -- nothing but a socket close handler evicts one, and a sweep-loaded world
  // would stay in memory forever.
  async function creatureRespawnSweep() {
    try {
      await respawnDueCreatures(pool, {
        // The buildWorldGenConfig shape placeMapCreatures requires -- camelCase
        // levelMin/levelMax plus tileTypes -- exactly as chestRespawnSweep
        // passes it. Handing over entry.row instead would throw
        // ('worldConfig: tileTypes is empty') before reaching a placement.
        getWorld: (worldId) => {
          const entry = worlds.get(worldId);
          return entry ? { ...entry.mapGenConfig, id: worldId } : null;
        },
        // Positions come from the live sim, never the database: the persisted
        // character position lags the sim by up to a sync interval, and a
        // stale position is exactly the input that would let a creature spawn
        // in someone's face.
        getPlayers: (worldId) => {
          const entry = worlds.get(worldId);
          if (!entry) return [];
          return [...entry.world.players.values()].map((p) => ({ x: p.x, y: p.y }));
        },
        onSpawn: async ({ worldId, creatureId }) => {
          const entry = worlds.get(worldId);
          if (!entry) return;
          // Despite the name (it predates this feature), injectGuardIntoSim is
          // generic: it re-reads the rows by id through CREATURE_JOINED_SELECT
          // and hands them to creatures.addCreatures. Without it a respawned
          // creature exists in the DB but not in the running sim until the
          // world is reloaded -- present but unkillable.
          await injectGuardIntoSim(entry, [creatureId]);
        },
      });
    } catch (err) {
      console.error('creature respawn sweep failed:', err);
    }
  }
```

- [ ] **Step 3: Start the timer**

After the existing `const itemSweepTimer = setInterval(...)` block (which ends `}, itemSweepMs);`), add:

```js
  const creatureSweepTimer = setInterval(() => {
    // Same guard the item sweep uses: with no world loaded there is nothing
    // this pass could act on, so skip the query entirely.
    if (worlds.size === 0) return;
    creatureRespawnSweep();
  }, creatureSweepMs);
```

- [ ] **Step 4: Clear the timer on shutdown**

Find where `itemSweepTimer` is passed to `clearInterval` (search `clearInterval(itemSweepTimer)`) and add `clearInterval(creatureSweepTimer);` beside it. A timer that outlives the server keeps the process alive and makes `node --test` hang — this repo already has three suites that hang, and adding a fourth would be blamed on whatever ran next.

- [ ] **Step 5: Expose the test seam**

In the returned object, next to `_chestRespawnSweep: chestRespawnSweep,`:

```js
    // Test seam, same reasoning as _chestRespawnSweep: run one creature
    // respawn pass synchronously (and await it, unlike the timer's
    // fire-and-forget call) instead of racing wall-clock creatureSweepMs.
    _creatureRespawnSweep: creatureRespawnSweep,
```

- [ ] **Step 6: Verify the server still boots and nothing regressed**

Run: `cd backend && node --test tests/authority*.test.js`

Expected: no new failures against your recorded baseline.

- [ ] **Step 7: Commit**

```bash
git add backend/src/authority/server.js
git commit -m "feat(respawn): run the respawn sweep on its own 10s timer (SOMET-309)"
```

---

### Task 6: Top-up and deficit backstop at world load

**Files:**
- Modify: `backend/src/services/creatureRespawn.js`
- Modify: `backend/src/authority/server.js` (`loadWorld`)
- Test: `backend/tests/creature_respawn_db.test.js` (append)

**Interfaces:**
- Consumes: `resolveDensity` from `densityTiers.js`; `placeMapCreatures`, `isBoundedWorld` from `mapService.js`.
- Produces: `enqueueDeficit(pool, { worldRow, world }) -> Promise<number>` (rows enqueued).

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/creature_respawn_db.test.js`:

```js
const { enqueueDeficit } = require('../src/services/creatureRespawn');

// The buildWorldGenConfig shape placeMapCreatures needs. A single grass tile
// type makes every tile legal, so placement never fails for terrain reasons
// and the test is about the arithmetic, not the sampler.
function fakeWorldConfig() {
  return {
    width: 96, height: 96, levelMin: 1, levelMax: 5,
    tileTypes: [{ name: 'grass', walkable: true }],
    villages: [], doorways: [], biomes: [],
  };
}

test('the backstop enqueues the gap between target and live population', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const worldId = await makeWorld(pool);
    await pool.query(
      `UPDATE worlds SET allowed_creature_types = ARRAY['Wolf']::text[] WHERE id = $1`, [worldId],
    );
    const row = (await pool.query('SELECT * FROM worlds WHERE id = $1', [worldId])).rows[0];

    // 96x96 at 'normal' (6 per 1000 tiles) targets 55 scattered creatures.
    // Hand-typed from the shipped tier table, NOT recomputed from
    // resolveDensity -- deriving it from the code under test would make this
    // assertion true for any tier values at all.
    const enqueued = await enqueueDeficit(pool, { worldRow: row, world: fakeWorldConfig() });
    assert.equal(enqueued, 55);

    const q = await pool.query('SELECT count(*)::int AS n FROM creature_respawns WHERE world_id = $1', [worldId]);
    assert.equal(q.rows[0].n, 55);

    await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
  } finally {
    await pool.end();
  }
});

test('the backstop enqueues nothing for a world already at target', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const worldId = await makeWorld(pool);
    await pool.query(
      `UPDATE worlds SET allowed_creature_types = ARRAY['Wolf']::text[] WHERE id = $1`, [worldId],
    );
    // 60 live wild creatures, comfortably over the 55 target.
    for (let i = 0; i < 60; i += 1) {
      await pool.query(
        `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage, defense)
         VALUES ($1,'Wolf',$2,$2,20,'S',1,5,0)`, [worldId, 100 + i],
      );
    }
    const row = (await pool.query('SELECT * FROM worlds WHERE id = $1', [worldId])).rows[0];

    assert.equal(await enqueueDeficit(pool, { worldRow: row, world: fakeWorldConfig() }), 0);

    await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
  } finally {
    await pool.end();
  }
});

test('already-pending respawns count against the deficit', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const worldId = await makeWorld(pool);
    await pool.query(
      `UPDATE worlds SET allowed_creature_types = ARRAY['Wolf']::text[] WHERE id = $1`, [worldId],
    );
    // 50 kills already in flight. Without subtracting these the world would
    // be filled to 55 now and then again as each pending row comes due.
    for (let i = 0; i < 50; i += 1) {
      await pool.query(
        `INSERT INTO creature_respawns (world_id, type, x, y, level, respawn_at)
         VALUES ($1,'Wolf',$2,$2,1, now())`, [worldId, 100 + i],
      );
    }
    const row = (await pool.query('SELECT * FROM worlds WHERE id = $1', [worldId])).rows[0];

    assert.equal(await enqueueDeficit(pool, { worldRow: row, world: fakeWorldConfig() }), 5);

    await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
  } finally {
    await pool.end();
  }
});

test('a world with no allowed creature types enqueues nothing', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const worldId = await makeWorld(pool); // allowed_creature_types left empty
    const row = (await pool.query('SELECT * FROM worlds WHERE id = $1', [worldId])).rows[0];

    // SOMET-315's empty worlds must stay empty: there is no legal creature to
    // place, and enqueueing rows that can never resolve would build a queue
    // that fails on every sweep forever.
    assert.equal(await enqueueDeficit(pool, { worldRow: row, world: fakeWorldConfig() }), 0);

    await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
  } finally {
    await pool.end();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && TEST_DATABASE_URL="$DATABASE_URL" node --test tests/creature_respawn_db.test.js`

Expected: FAIL — `enqueueDeficit is not a function`.

- [ ] **Step 3: Implement `enqueueDeficit`**

Add these requires to the top of `backend/src/services/creatureRespawn.js`:

```js
const { resolveDensity } = require('./densityTiers');
const { isBoundedWorld } = require('./mapService');
```

(extend the existing `mapService` require rather than adding a second one), then append before `module.exports`:

```js
// The load-time backstop.
//
// A per-death queue only knows about deaths that happen after it ships. The
// creatures alive when this feature landed have no queue rows, and a world
// drained before that would stay drained forever. This closes that gap and
// makes the system self-healing: a population lost to ANY cause, including
// causes not yet known, comes back the next time a player enters.
//
// Enqueues immediately-due rows rather than inserting creatures directly, so
// there is exactly one spawn path and the player-distance rule applies to
// backfilled creatures too. The cost is that placement runs twice for these
// rows (once here to pick a tile, once in the sweep) -- bounded, because this
// runs at most once per world load.
//
// Packs are deliberately excluded from the target: resolveDensity's pack
// counts are re-rolled per populate, worlds.creature_count records only the
// scattered figure, and treating packs as a floor would make this oscillate.
// The backstop restores the scatter baseline; packs are a seeding-time
// flourish that does not regenerate.
async function enqueueDeficit(pool, { worldRow, world }) {
  if (!isBoundedWorld(worldRow)) return 0;

  const allowedNames = Array.isArray(worldRow.allowed_creature_types)
    ? worldRow.allowed_creature_types : [];
  if (allowedNames.length === 0) return 0;

  const et = await pool.query(
    `SELECT name, hp, defense, resistances, faction FROM entity_types
      WHERE is_creature = true AND name = ANY($1::text[])`,
    [allowedNames],
  );
  // Same exclusion populateWorld applies: a guard-faction type rolled into the
  // wild pool would have no home_x, so withinLeash would treat it as
  // unconstrained -- a world-roaming, undroppable creature-hunter.
  const hostileTypes = et.rows.filter((t) => (t.faction || 'hostile') !== 'guard');
  if (hostileTypes.length === 0) return 0;

  const target = resolveDensity(worldRow.density, worldRow.width, worldRow.height).scatterCount;

  const live = await pool.query(
    `SELECT count(*)::int AS n FROM world_creatures
      WHERE world_id = $1 AND home_x IS NULL AND blocks_portal_id IS NULL`,
    [worldRow.id],
  );
  const pending = await pool.query(
    'SELECT count(*)::int AS n FROM creature_respawns WHERE world_id = $1', [worldRow.id],
  );

  const deficit = target - live.rows[0].n - pending.rows[0].n;
  if (deficit <= 0) return 0;

  const seed = Math.floor(Math.random() * 2 ** 31);
  const placed = placeMapCreatures(world, deficit, hostileTypes, seed);
  if (placed.length === 0) return 0;

  // One multi-row INSERT: a 55-row backfill should not be 55 round trips on
  // the path a player is waiting behind.
  const params = [];
  const tuples = placed.map((c) => {
    const b = params.length;
    params.push(worldRow.id, c.type, c.x, c.y, c.level);
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5}, now())`;
  });
  await pool.query(
    `INSERT INTO creature_respawns (world_id, type, x, y, level, respawn_at)
     VALUES ${tuples.join(',')}`,
    params,
  );

  return placed.length;
}
```

Add `enqueueDeficit` to `module.exports`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && TEST_DATABASE_URL="$DATABASE_URL" node --test tests/creature_respawn_db.test.js`

Expected: PASS, 7/7 (3 from Task 4 plus 4 new).

If the first new test reports 55 vs some other number, do **not** change the assertion to match the code. Read `backend/src/services/densityTiers.js`: `normal` is 6 per 1000 tiles and 96×96 is 9216 tiles, and `resolveDensity` uses `Math.round`, so `round(9216 × 6 / 1000) = round(55.296) = 55`. If the code disagrees with that arithmetic, the code is wrong.

- [ ] **Step 5: Wire it into `loadWorld`**

In `backend/src/authority/server.js`, inside `loadWorld`, immediately after `worlds.set(canonicalId, entry);` and before `return entry;`:

```js
        // SOMET-309: a player entering a drained world should find it
        // populated, not watch it fill in around them over the next minute.
        // Backfill first (this is what recovers populations lost before the
        // respawn queue existed), then drain everything now due for it.
        //
        // Deliberately awaited: the alternative is the first tick broadcast
        // racing the spawn, so the player sees an empty world for a beat and
        // then a burst of creatures appearing. Failure here must not prevent
        // the join -- an unpopulated world is playable, a failed join is not.
        try {
          await enqueueDeficit(pool, { worldRow: row, world: entry.mapGenConfig });
          await creatureRespawnSweep();
        } catch (err) {
          console.error('world load top-up failed:', canonicalId, err);
        }
```

Add `enqueueDeficit` to the `creatureRespawn` require at the top of `server.js`.

**Ordering note:** `creatureRespawnSweep` is declared with `async function`, so it is hoisted and callable from `loadWorld` even though its definition appears later in the file. Do not move either one.

- [ ] **Step 6: Verify no regression in the authority suites**

Run: `cd backend && TEST_DATABASE_URL="$DATABASE_URL" node --test tests/authority*.test.js tests/world_population_db.test.js`

Expected: no new failures against your recorded baseline.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/creatureRespawn.js backend/src/authority/server.js backend/tests/creature_respawn_db.test.js
git commit -m "feat(respawn): backfill and drain the queue when a world loads (SOMET-309)"
```

---

### Task 7: Browser verification

**Files:** none — this task produces evidence, not code.

A green suite has missed live defects on this project repeatedly: a stamina bar that was inert, ammo that could not be fired, wall sides rendering as flat background. Respawn is exactly the kind of feature that can pass every unit test and still never fire in the running game, because the failure mode is a wiring gap between the sweep and the sim.

**Setup:** the compose stack hot-reloads from the main checkout (vite on :15173, nodemon on :13101). **Never `docker restart` these containers** — their CMD is `tail -f /dev/null` and a restart kills the dev server with nothing to revive it. To reload the backend after your changes are in place, `touch backend/src/index.js`, then confirm with `make dev-status`.

- [ ] **Step 1: Confirm the backend picked up the change**

Run: `make dev-status` and confirm the backend answers on :13101. Then check the logs for a clean boot with no `creature respawn sweep failed` lines.

- [ ] **Step 2: Verify a kill queues a respawn**

Log in, enter a bounded world with creatures, and kill one. Immediately query:

```bash
docker exec something2-db-1 psql -U user -d game_db -c \
  "SELECT type, x, y, level, respawn_at - now() AS due_in FROM creature_respawns ORDER BY created_at DESC LIMIT 5;"
```

Expected: a row for the creature you killed, `due_in` a little under 30 seconds.

- [ ] **Step 3: Verify the replacement appears**

Move at least 10 tiles away from the kill site and wait. Within roughly 40 seconds a creature of the same type should appear. **Screenshot it.** Confirm it is attackable — kill it too, and confirm a fresh queue row appears. A creature that renders but cannot be hit means `injectGuardIntoSim` did not run, and the DB and the sim disagree.

- [ ] **Step 4: Verify the player-distance rule**

Kill a creature and **stay standing on the exact spot**. Within roughly 40 seconds the replacement should appear elsewhere on the map, never on top of your character. **Screenshot it.** Confirm the queue row is gone:

```bash
docker exec something2-db-1 psql -U user -d game_db -c "SELECT count(*) FROM creature_respawns;"
```

- [ ] **Step 5: Verify the load-time backfill**

Pick a world, note its wild population, log out, and log back into it:

```bash
docker exec something2-db-1 psql -U user -d game_db -c \
  "SELECT w.name, w.width, w.density, count(c.id) AS wild
     FROM worlds w LEFT JOIN world_creatures c
       ON c.world_id = w.id AND c.home_x IS NULL AND c.blocks_portal_id IS NULL
    WHERE w.name = '<the world you entered>' GROUP BY w.id;"
```

Expected: the count is at or above the tier target for that world's size and density, and it did not change on a second login (the backstop is idempotent, not a ratchet).

- [ ] **Step 6: Record the evidence**

Write the screenshots and query output into your report. If any step fails, report it as a defect with steps/expected/actual rather than adjusting the plan to match the behaviour.

---

## Notes for the executor

**Record your test baseline before Task 1.** Three suites hang on `main` and have for some time — `migration_convert_magic_weapons_db`, `progression_kill_xp`, `stones_integration_db`. They are not yours. Run the backend suite once at the start, write down what fails, and report every later run against that baseline rather than against zero.

**`npm test` without `TEST_DATABASE_URL` silently skips 47 DB test files.** A "green" run that skipped every test in Tasks 1, 4 and 6 proves nothing. Export it from the repo-root `.env`.

**Do not re-seed or re-roll any world.** The backstop is designed to be exercised through a normal login. If you believe you need a drained world to test against, create your own world row as the DB tests do — never drain a shared one.
