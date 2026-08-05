# Dungeons and Catacombs (C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dungeon entrances (sometimes guard-blocked) leading down through hand-authored, branching, shared-instance dungeon levels, reachable via a new `PORTAL` link kind on the existing `map_links` table.

**Architecture:** `map_links` gains a `PORTAL` edge value with explicit tile coordinates instead of a compass direction, guarded by two partial unique indexes (compass edges keep their existing singleton-per-world guarantee; portals get a singleton-per-source-tile guarantee, which is what makes branching safe). Dungeon levels are ordinary spec-seeded `worlds` rows that skip grid embedding. Guarded entrances reuse the village-guard structural-spawn mechanism, extended with an explicit `blocks_portal_id` FK so the authority's tick loop can gate a portal's trigger on guard liveness without touching the shared collision/movement code.

**Tech Stack:** Node/Express backend (CommonJS, `node:test`, raw `pg`, `node-pg-migrate`), React frontend (ESM, vitest in a plain node environment).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-05-c-dungeons-catacombs-design.md`. Where this plan and the spec disagree on an implementation detail the spec left open, this plan's resolution governs — it was derived from reading the actual code the spec's author only summarized.
- Reserved migration timestamp range: `1714440060000`–`1714440069000`.
- Portal coordinates (`from_x`, `from_y`, `to_x`, `to_y` on `map_links`) are **pixel positions**, matching every other `x`/`y` column in this schema (`world_creatures.x/y`, `world_creatures.home_x/home_y`, `villageGatePosts`' `col*100+50` convention) — never tile-grid row/col. `MAP_TILE_SIZE = 100` (`backend/src/authority/server.js:23`).
- Blocking gates the portal's **trigger**, never tile walkability. Nothing in this plan touches `backend/src/authority/collision.js` or `frontend/.../movement.js` — the two-copy `resolveMove` pair this repo has already been burned by duplicating.
- Knockback is a direct server-authoritative position reassignment (the same mechanism `spawn`/respawn already uses), never a push through `resolveMove`.
- Dungeon levels are shared instances, exactly like every other world today. No per-player state, no instancing infrastructure.
- Definition of done per task: backend `npm test` from `backend/` and frontend `npx vitest run` from `frontend/` both green. Task 9 (World Map rendering) touches a UI surface and needs a browser verification pass before being marked complete.
- Test hygiene: literal expected values, never recomputations of the formula under test — this repo's dominant shipped-defect shape is assertions derived from the same constants as the code.

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/migrations/1714440060000_map_link_portals.js` | `map_links`: `PORTAL` edge, coordinate columns, partial unique indexes |
| `backend/migrations/1714440061000_creature_blocks_portal.js` | `world_creatures.blocks_portal_id` FK |
| `backend/src/services/mapLinks.js` (modify) | `fetchLinks` widened; `setPortalLink`/`clearPortalLink` added |
| `backend/seeds/mapSpec.js` (modify) | `validateMapSpec` accepts portal links, grid becomes optional for portal-only worlds |
| `backend/src/services/dungeonGuards.js` (create) | `insertPortalGuards` — structural guard spawn tied to a specific portal |
| `backend/scripts/seed-map.js` (modify) | `applyMapSpec` writes portal links and portal guards |
| `backend/src/authority/creatures.js` (modify) | in-memory creatures carry `blocksPortalId` |
| `backend/src/authority/server.js` (modify) | `planPortalTransition`, world-load wiring, tick-loop blocking + knockback |
| `backend/src/index.js` (modify) | `GET /api/world-graph` selects the new columns |
| `frontend/src/games/something2/mapGraphLayout.js` (modify) | off-grid portal-cluster placement pass |

---

### Task 1: Migration — `map_links` gets a `PORTAL` edge and coordinates

**Files:**
- Create: `backend/migrations/1714440060000_map_link_portals.js`
- Test: `backend/tests/map_link_portals_migration.test.js`

**Interfaces:**
- Produces: `map_links` columns `from_x`, `from_y`, `to_x`, `to_y` (all nullable integer); `edge` CHECK widened to include `'PORTAL'`; a `CHECK` tying coordinate presence to `edge = 'PORTAL'`; indexes `map_links_compass_unique` and `map_links_portal_source_unique` replacing `map_links_from_edge_unique`.

- [ ] **Step 1: Write the failing migration test**

```js
// backend/tests/map_link_portals_migration.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

function requireTestDb(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await pool.query('SELECT 1'); return pool; }
  catch (err) { await pool.end().catch(() => {}); return { unreachable: err.message }; }
}

test('map_links has PORTAL coordinate columns and the widened edge check', async (t) => {
  if (!requireTestDb(t, 'reads map_links column metadata')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  try {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'map_links'
          AND column_name IN ('from_x','from_y','to_x','to_y')`);
    assert.equal(rows.length, 4, 'expected all four coordinate columns');
    for (const r of rows) {
      assert.equal(r.data_type, 'integer');
      assert.equal(r.is_nullable, 'YES', `${r.column_name} must stay nullable for compass rows`);
    }
  } finally {
    await pool.end();
  }
});

test('a compass edge still allows at most one per world (unchanged guarantee)', async (t) => {
  if (!requireTestDb(t, 'exercises the split unique indexes')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-a', 's') RETURNING id`)).rows[0].id;
    const b = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-b', 's') RETURNING id`)).rows[0].id;
    const c = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-c', 's') RETURNING id`)).rows[0].id;

    await client.query(
      `INSERT INTO map_links (from_world_id, edge, to_world_id) VALUES ($1,'N',$2)`, [a, b]);
    await assert.rejects(
      client.query(`INSERT INTO map_links (from_world_id, edge, to_world_id) VALUES ($1,'N',$2)`, [a, c]),
      /duplicate key|unique constraint/i,
      'a second N edge from the same world must still be rejected',
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

test('two PORTAL rows from the same world at different tiles are both allowed (branching)', async (t) => {
  if (!requireTestDb(t, 'exercises the portal partial unique index')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-branch-a', 's') RETURNING id`)).rows[0].id;
    const b = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-branch-b', 's') RETURNING id`)).rows[0].id;
    const c = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-branch-c', 's') RETURNING id`)).rows[0].id;

    await client.query(
      `INSERT INTO map_links (from_world_id, edge, to_world_id, from_x, from_y, to_x, to_y)
       VALUES ($1,'PORTAL',$2,100,100,50,50)`, [a, b]);
    await client.query(
      `INSERT INTO map_links (from_world_id, edge, to_world_id, from_x, from_y, to_x, to_y)
       VALUES ($1,'PORTAL',$2,300,300,50,50)`, [a, c]);
    const { rows } = await client.query(
      `SELECT to_world_id FROM map_links WHERE from_world_id = $1 AND edge = 'PORTAL' ORDER BY from_x`, [a]);
    assert.deepStrictEqual(rows.map((r) => r.to_world_id), [b, c],
      'branching requires two portal rows from the same world to coexist');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

test('two PORTAL rows from the same world at the SAME tile are rejected', async (t) => {
  if (!requireTestDb(t, 'exercises the portal partial unique index')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-collide-a', 's') RETURNING id`)).rows[0].id;
    const b = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-collide-b', 's') RETURNING id`)).rows[0].id;
    const c = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-collide-c', 's') RETURNING id`)).rows[0].id;

    await client.query(
      `INSERT INTO map_links (from_world_id, edge, to_world_id, from_x, from_y, to_x, to_y)
       VALUES ($1,'PORTAL',$2,100,100,50,50)`, [a, b]);
    await assert.rejects(
      client.query(
        `INSERT INTO map_links (from_world_id, edge, to_world_id, from_x, from_y, to_x, to_y)
         VALUES ($1,'PORTAL',$2,100,100,60,60)`, [a, c]),
      /duplicate key|unique constraint/i,
      'two destinations wired to the identical source tile must be rejected',
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

test('a PORTAL row without all four coordinates is rejected', async (t) => {
  if (!requireTestDb(t, 'exercises the coordinate-presence check')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-nocoord-a', 's') RETURNING id`)).rows[0].id;
    const b = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-nocoord-b', 's') RETURNING id`)).rows[0].id;
    await assert.rejects(
      client.query(
        `INSERT INTO map_links (from_world_id, edge, to_world_id, from_x) VALUES ($1,'PORTAL',$2,100)`,
        [a, b]),
      /check constraint|violates/i,
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

test('a compass row is rejected if it carries coordinates', async (t) => {
  if (!requireTestDb(t, 'exercises the coordinate-absence check for compass rows')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-badcompass-a', 's') RETURNING id`)).rows[0].id;
    const b = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-badcompass-b', 's') RETURNING id`)).rows[0].id;
    await assert.rejects(
      client.query(
        `INSERT INTO map_links (from_world_id, edge, to_world_id, from_x, from_y, to_x, to_y)
         VALUES ($1,'N',$2,100,100,50,50)`, [a, b]),
      /check constraint|violates/i,
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && TEST_DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" node --test tests/map_link_portals_migration.test.js`
Expected: FAIL — `from_x` etc. do not exist yet, `'PORTAL'` is rejected by the current CHECK.

- [ ] **Step 3: Write the migration**

```js
// backend/migrations/1714440060000_map_link_portals.js
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('map_links', {
    from_x: { type: 'integer' },
    from_y: { type: 'integer' },
    to_x: { type: 'integer' },
    to_y: { type: 'integer' },
  });

  // Widen the edge check to admit PORTAL alongside the four compass values.
  pgm.dropConstraint('map_links', 'map_links_edge_check');
  pgm.addConstraint('map_links', 'map_links_edge_check',
    "CHECK (edge IN ('N','E','S','W','PORTAL'))");

  // Compass rows keep from_x/from_y/to_x/to_y NULL; portal rows require all
  // four. This is what stops a portal from silently missing its arrival
  // point, and stops a compass row from silently carrying meaningless
  // coordinates that some future reader might mistake for real data.
  pgm.addConstraint('map_links', 'map_links_portal_coords_check', `
    (edge = 'PORTAL' AND from_x IS NOT NULL AND from_y IS NOT NULL
                     AND to_x   IS NOT NULL AND to_y   IS NOT NULL)
    OR
    (edge != 'PORTAL' AND from_x IS NULL AND from_y IS NULL
                      AND to_x   IS NULL AND to_y   IS NULL)
  `);

  // UNIQUE(from_world_id, edge) cannot survive branching -- one world can now
  // have many outgoing PORTAL rows. Split into two partial indexes instead
  // of reshaping the constraint: the compass one is byte-for-byte the
  // guarantee that existed before (at most one N/E/S/W per world), untouched
  // by anything portal-related. The portal one is the analogous guarantee at
  // tile granularity: at most one destination wired to any given source
  // tile -- you cannot wire two rooms to the same staircase.
  pgm.dropConstraint('map_links', 'map_links_from_edge_unique');
  pgm.createIndex('map_links', ['from_world_id', 'edge'], {
    name: 'map_links_compass_unique', unique: true, where: "edge != 'PORTAL'",
  });
  pgm.createIndex('map_links', ['from_world_id', 'from_x', 'from_y'], {
    name: 'map_links_portal_source_unique', unique: true, where: "edge = 'PORTAL'",
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('map_links', ['from_world_id', 'from_x', 'from_y'],
    { name: 'map_links_portal_source_unique' });
  pgm.dropIndex('map_links', ['from_world_id', 'edge'], { name: 'map_links_compass_unique' });
  pgm.addConstraint('map_links', 'map_links_from_edge_unique', { unique: ['from_world_id', 'edge'] });
  pgm.dropConstraint('map_links', 'map_links_portal_coords_check');
  pgm.dropConstraint('map_links', 'map_links_edge_check');
  pgm.addConstraint('map_links', 'map_links_edge_check', "CHECK (edge IN ('N','E','S','W'))");
  pgm.dropColumns('map_links', ['from_x', 'from_y', 'to_x', 'to_y']);
};
```

- [ ] **Step 4: Apply the migration and run the tests**

Run: `cd backend && npm run migrate:up` (or the project's equivalent — check `package.json` scripts; do not invoke `make seed-map`/`make reseed-map`/`make nuke` at any point in this plan)
Then: `TEST_DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" node --test tests/map_link_portals_migration.test.js`
Expected: PASS, all 6 subtests.

- [ ] **Step 5: Mutation check**

Temporarily change `map_links_portal_coords_check`'s SQL to drop the `from_x IS NOT NULL` clause on the portal branch, re-run migration up (on a scratch DB, or re-verify the check via `\d map_links` and a manual `psql` insert), confirm the "without all four coordinates" test goes red, then restore.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/1714440060000_map_link_portals.js backend/tests/map_link_portals_migration.test.js
git commit -m "feat(dungeons): add PORTAL edge and coordinates to map_links (SOMET-243)"
```

---

### Task 2: Migration — `world_creatures.blocks_portal_id`

**Files:**
- Create: `backend/migrations/1714440061000_creature_blocks_portal.js`
- Test: `backend/tests/creature_blocks_portal_migration.test.js`

**Interfaces:**
- Consumes: `map_links.id` (Task 1).
- Produces: `world_creatures.blocks_portal_id` (nullable uuid, FK to `map_links(id)` `ON DELETE SET NULL`).

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/creature_blocks_portal_migration.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

function requireTestDb(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await pool.query('SELECT 1'); return pool; }
  catch (err) { await pool.end().catch(() => {}); return { unreachable: err.message }; }
}

test('world_creatures.blocks_portal_id is a nullable FK to map_links', async (t) => {
  if (!requireTestDb(t, 'reads world_creatures column metadata')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  try {
    const { rows } = await pool.query(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_name = 'world_creatures' AND column_name = 'blocks_portal_id'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].is_nullable, 'YES');
    assert.equal(rows[0].data_type, 'uuid');
  } finally {
    await pool.end();
  }
});

test('deleting the linked map_links row sets blocks_portal_id to NULL, not delete the creature', async (t) => {
  if (!requireTestDb(t, 'exercises ON DELETE SET NULL')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('blocks-portal-test-a', 's') RETURNING id`)).rows[0].id;
    const b = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('blocks-portal-test-b', 's') RETURNING id`)).rows[0].id;
    const link = (await client.query(
      `INSERT INTO map_links (from_world_id, edge, to_world_id, from_x, from_y, to_x, to_y)
       VALUES ($1,'PORTAL',$2,100,100,50,50) RETURNING id`, [a, b])).rows[0].id;
    const creature = (await client.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, blocks_portal_id)
       VALUES ($1,'Orc',100,100,50,'S',$2) RETURNING id`, [a, link])).rows[0].id;

    await client.query('DELETE FROM map_links WHERE id = $1', [link]);

    const { rows } = await client.query(
      'SELECT blocks_portal_id FROM world_creatures WHERE id = $1', [creature]);
    assert.strictEqual(rows[0].blocks_portal_id, null);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && TEST_DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" node --test tests/creature_blocks_portal_migration.test.js`
Expected: FAIL — column does not exist.

- [ ] **Step 3: Write the migration**

```js
// backend/migrations/1714440061000_creature_blocks_portal.js
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Nullable: only a structural guard defending a specific portal sets this,
  // mirroring how home_x/home_y (1714440030000) is only meaningful for
  // guard-faction creatures. ON DELETE SET NULL, not CASCADE -- deleting the
  // portal link (e.g. an admin re-links a dungeon) must not delete the
  // guard, only stop it blocking anything.
  pgm.addColumns('world_creatures', {
    blocks_portal_id: {
      type: 'uuid',
      references: 'map_links',
      onDelete: 'SET NULL',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('world_creatures', ['blocks_portal_id']);
};
```

- [ ] **Step 4: Apply and run**

Run: `cd backend && npm run migrate:up`
Then: `TEST_DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" node --test tests/creature_blocks_portal_migration.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/1714440061000_creature_blocks_portal.js backend/tests/creature_blocks_portal_migration.test.js
git commit -m "feat(dungeons): add world_creatures.blocks_portal_id (SOMET-243)"
```

---

### Task 3: `mapLinks.js` — `setPortalLink`, `clearPortalLink`, widened `fetchLinks`

**Files:**
- Modify: `backend/src/services/mapLinks.js`
- Test: `backend/tests/map_links_portals.test.js`

**Interfaces:**
- Consumes: Task 1's schema.
- Produces:
  - `fetchLinks(pool, worldId)` — now returns rows shaped
    `{ id, edge, to_world_id, to_width, to_height, from_x, from_y, to_x, to_y }`
    (unchanged for existing compass-row callers, which never read the new fields).
  - `setPortalLink(pool, fromId, fromX, fromY, toId, toX, toY) -> { id }` — the id of the
    `from`-side row (the one a guard's `blocks_portal_id` should reference).
  - `clearPortalLink(pool, fromId, fromX, fromY)` — deletes a specific portal and its mirror.

- [ ] **Step 1: Write the failing tests**

```js
// backend/tests/map_links_portals.test.js
const test = require('node:test');
const assert = require('node:assert');
const { setPortalLink, clearPortalLink, fetchLinks } = require('../src/services/mapLinks.js');

// A fake pool whose query() just records calls and returns canned rows --
// same style as this repo's other service-level tests (route() dispatch on
// a regex against the SQL text). No live DB needed for these.
function fakePool() {
  const calls = [];
  const links = []; // { from_world_id, edge, to_world_id, from_x, from_y, to_x, to_y }
  return {
    calls,
    links,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^\s*INSERT INTO map_links/i.test(sql)) {
        const [fromId, edge, toId, fromX, fromY, toX, toY] = params;
        const id = `link-${links.length}`;
        links.push({ id, from_world_id: fromId, edge, to_world_id: toId,
          from_x: fromX, from_y: fromY, to_x: toX, to_y: toY });
        return { rows: [{ id }] };
      }
      if (/^\s*DELETE FROM map_links/i.test(sql)) {
        const [fromId, fromX, fromY] = params;
        const idx = links.findIndex((l) =>
          l.from_world_id === fromId && l.from_x === fromX && l.from_y === fromY);
        const removed = idx >= 0 ? links.splice(idx, 1) : [];
        return { rows: removed };
      }
      if (/^\s*SELECT ml\.id, ml\.edge/i.test(sql)) {
        const [worldId] = params;
        return { rows: links.filter((l) => l.from_world_id === worldId).map((l) => ({
          id: l.id, edge: l.edge, to_world_id: l.to_world_id,
          to_width: 10, to_height: 10,
          from_x: l.from_x, from_y: l.from_y, to_x: l.to_x, to_y: l.to_y,
        })) };
      }
      return { rows: [] };
    },
  };
}

test('setPortalLink writes both directions with swapped coordinates', async () => {
  const pool = fakePool();
  const { id } = await setPortalLink(pool, 'world-a', 100, 100, 'world-b', 50, 50);
  assert.equal(pool.links.length, 2, 'a two-way portal is two rows');
  const forward = pool.links.find((l) => l.id === id);
  assert.deepStrictEqual(
    { from: forward.from_world_id, fx: forward.from_x, fy: forward.from_y,
      to: forward.to_world_id, tx: forward.to_x, ty: forward.to_y },
    { from: 'world-a', fx: 100, fy: 100, to: 'world-b', tx: 50, ty: 50 });
  const mirror = pool.links.find((l) => l.id !== id);
  assert.deepStrictEqual(
    { from: mirror.from_world_id, fx: mirror.from_x, fy: mirror.from_y,
      to: mirror.to_world_id, tx: mirror.to_x, ty: mirror.to_y },
    { from: 'world-b', fx: 50, fy: 50, to: 'world-a', tx: 100, ty: 100 },
    'the mirror row swaps from and to entirely, giving two-way travel from one call');
  assert.ok(pool.links.every((l) => l.edge === 'PORTAL'));
});

test('clearPortalLink removes both the row and its mirror', async () => {
  const pool = fakePool();
  await setPortalLink(pool, 'world-a', 100, 100, 'world-b', 50, 50);
  await clearPortalLink(pool, 'world-a', 100, 100);
  assert.equal(pool.links.length, 0);
});

test('clearPortalLink on an unknown tile removes nothing', async () => {
  const pool = fakePool();
  await setPortalLink(pool, 'world-a', 100, 100, 'world-b', 50, 50);
  await clearPortalLink(pool, 'world-a', 999, 999);
  assert.equal(pool.links.length, 2, 'the wrong coordinates must not delete an unrelated portal');
});

test('fetchLinks returns coordinate fields for portal rows', async () => {
  const pool = fakePool();
  await setPortalLink(pool, 'world-a', 100, 100, 'world-b', 50, 50);
  const rows = await fetchLinks(pool, 'world-a');
  assert.equal(rows.length, 1);
  assert.deepStrictEqual(
    { edge: rows[0].edge, from_x: rows[0].from_x, from_y: rows[0].from_y,
      to_x: rows[0].to_x, to_y: rows[0].to_y },
    { edge: 'PORTAL', from_x: 100, from_y: 100, to_x: 50, to_y: 50 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && node --test tests/map_links_portals.test.js`
Expected: FAIL — `setPortalLink`/`clearPortalLink` are not exported yet.

- [ ] **Step 3: Implement**

```js
// backend/src/services/mapLinks.js — full replacement
const { oppositeEdge } = require('./mapService');

// This world's outgoing links, joined to each target's bounds (for compass
// arrival geometry -- portal rows carry their own to_x/to_y and ignore
// to_width/to_height entirely).
async function fetchLinks(pool, worldId) {
  const r = await pool.query(
    `SELECT ml.id, ml.edge, ml.to_world_id, w.width AS to_width, w.height AS to_height,
            ml.from_x, ml.from_y, ml.to_x, ml.to_y
     FROM map_links ml JOIN worlds w ON w.id = ml.to_world_id
     WHERE ml.from_world_id = $1`,
    [worldId],
  );
  return r.rows;
}

// Bidirectional upsert: (from,edge,to) and its mirror (to,opposite,from).
async function setLink(pool, fromId, edge, toId) {
  const insert = `INSERT INTO map_links (from_world_id, edge, to_world_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (from_world_id, edge) DO UPDATE SET to_world_id = EXCLUDED.to_world_id`;
  await pool.query(insert, [fromId, edge, toId]);
  await pool.query(insert, [toId, oppositeEdge(edge), fromId]);
}

// Bidirectional delete: (from,edge) and its mirror (to,opposite).
async function clearLink(pool, fromId, edge) {
  const cur = await pool.query(
    'SELECT to_world_id FROM map_links WHERE from_world_id = $1 AND edge = $2',
    [fromId, edge],
  );
  await pool.query('DELETE FROM map_links WHERE from_world_id = $1 AND edge = $2', [fromId, edge]);
  if (cur.rows[0]) {
    await pool.query('DELETE FROM map_links WHERE from_world_id = $1 AND edge = $2',
      [cur.rows[0].to_world_id, oppositeEdge(edge)]);
  }
}

// A portal has no "opposite edge" to compute the way a compass link does --
// there is no rotation that turns (from_x,from_y)->(to_x,to_y) into its
// return trip. The mirror is instead a second PORTAL row with from/to
// (and their coordinates) swapped outright. Returns the id of the FORWARD
// row (from -> to), which is what a guard's blocks_portal_id should
// reference: guards defend the departure side of a specific staircase.
async function setPortalLink(pool, fromId, fromX, fromY, toId, toX, toY) {
  const insert = `INSERT INTO map_links (from_world_id, edge, to_world_id, from_x, from_y, to_x, to_y)
     VALUES ($1, 'PORTAL', $2, $3, $4, $5, $6)
     ON CONFLICT (from_world_id, from_x, from_y)
       WHERE edge = 'PORTAL'
       DO UPDATE SET to_world_id = EXCLUDED.to_world_id, to_x = EXCLUDED.to_x, to_y = EXCLUDED.to_y
     RETURNING id`;
  const forward = await pool.query(insert, [fromId, toId, fromX, fromY, toX, toY]);
  await pool.query(insert, [toId, fromId, toX, toY, fromX, fromY]);
  return { id: forward.rows[0].id };
}

// Bidirectional delete, keyed by the exact source tile rather than an edge
// name -- a world can have many PORTAL rows, so "delete the portal FROM
// this world" is ambiguous without a tile.
async function clearPortalLink(pool, fromId, fromX, fromY) {
  const cur = await pool.query(
    `SELECT to_world_id, to_x, to_y FROM map_links
      WHERE from_world_id = $1 AND edge = 'PORTAL' AND from_x = $2 AND from_y = $3`,
    [fromId, fromX, fromY],
  );
  await pool.query(
    `DELETE FROM map_links WHERE from_world_id = $1 AND edge = 'PORTAL' AND from_x = $2 AND from_y = $3`,
    [fromId, fromX, fromY],
  );
  if (cur.rows[0]) {
    const { to_world_id, to_x, to_y } = cur.rows[0];
    await pool.query(
      `DELETE FROM map_links WHERE from_world_id = $1 AND edge = 'PORTAL' AND from_x = $2 AND from_y = $3`,
      [to_world_id, to_x, to_y],
    );
  }
}

module.exports = { fetchLinks, setLink, clearLink, setPortalLink, clearPortalLink };
```

Note on the `fakePool` in the test: it dispatches `INSERT`/`DELETE`/`SELECT` by regex the same way this repo's other service tests do — the real Postgres `ON CONFLICT ... WHERE edge = 'PORTAL'` partial-index target isn't parsed by the fake, only the effect (write/overwrite by from_world_id+from_x+from_y) is emulated. The live behavior of that exact SQL is what Task 1's migration tests already verify against real Postgres.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && node --test tests/map_links_portals.test.js`
Expected: PASS, 4/4.

- [ ] **Step 5: Run the full backend suite** (this file is imported by `server.js` and `seed-map.js`)

Run: `cd backend && npm test`
Expected: all existing tests still pass — `fetchLinks`'s widened SELECT must not break any consumer that only reads `edge`/`to_world_id`/`to_width`/`to_height`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/mapLinks.js backend/tests/map_links_portals.test.js
git commit -m "feat(dungeons): add setPortalLink/clearPortalLink to mapLinks.js (SOMET-243)"
```

---

### Task 4: `mapSpec.js` — validate portal links and grid-less dungeon worlds

**Files:**
- Modify: `backend/seeds/mapSpec.js`
- Test: `backend/tests/map_spec_portals.test.js`

**Interfaces:**
- Produces: `validateMapSpec(spec, opts)` (signature unchanged) now accepts:
  - A world entry with no `grid` field, **provided** it is an endpoint of at least one `{ kind: 'portal', ... }` link.
  - A link entry `{ kind: 'portal', from, from_x, from_y, to, to_x, to_y, guard?: { creature_type, count } }`.

- [ ] **Step 1: Write the failing tests**

```js
// backend/tests/map_spec_portals.test.js
const test = require('node:test');
const assert = require('node:assert');
const { validateMapSpec } = require('../seeds/mapSpec.js');

function baseSpec() {
  return {
    worlds: [
      { key: 'surface', name: 'Surface', grid: [0, 0], width: 20, height: 20, is_entry: true },
    ],
    links: [],
  };
}

test('a world with no grid is rejected unless it is a portal endpoint', () => {
  const spec = baseSpec();
  spec.worlds.push({ key: 'dungeon-1', name: 'Dungeon Level 1', width: 20, height: 20 });
  const errors = validateMapSpec(spec);
  assert.ok(errors.some((e) => /dungeon-1.*grid/.test(e)),
    'a grid-less world with no portal link must still fail, same as today');
});

test('a portal-connected world may omit grid entirely', () => {
  const spec = baseSpec();
  spec.worlds.push({ key: 'dungeon-1', name: 'Dungeon Level 1', width: 20, height: 20 });
  spec.links.push({
    kind: 'portal', from: 'surface', from_x: 1050, from_y: 1050,
    to: 'dungeon-1', to_x: 550, to_y: 550,
  });
  const errors = validateMapSpec(spec);
  assert.deepStrictEqual(errors, []);
});

test('a portal link requires all four integer coordinates', () => {
  const spec = baseSpec();
  spec.worlds.push({ key: 'dungeon-1', name: 'Dungeon Level 1', width: 20, height: 20 });
  spec.links.push({ kind: 'portal', from: 'surface', from_x: 1050, to: 'dungeon-1', to_x: 550, to_y: 550 });
  const errors = validateMapSpec(spec);
  assert.ok(errors.some((e) => /portal.*from_y/.test(e)));
});

test('branching: one world may have two outgoing portals', () => {
  const spec = baseSpec();
  spec.worlds.push(
    { key: 'dungeon-1', name: 'Dungeon Level 1', width: 20, height: 20 },
    { key: 'dungeon-1b', name: 'Dungeon Level 1 Alt', width: 20, height: 20 },
  );
  spec.links.push(
    { kind: 'portal', from: 'surface', from_x: 1050, from_y: 1050, to: 'dungeon-1', to_x: 550, to_y: 550 },
    { kind: 'portal', from: 'surface', from_x: 1950, from_y: 1050, to: 'dungeon-1b', to_x: 550, to_y: 550 },
  );
  const errors = validateMapSpec(spec);
  assert.deepStrictEqual(errors, []);
});

test('two portals from the same world at the same tile is rejected', () => {
  const spec = baseSpec();
  spec.worlds.push(
    { key: 'dungeon-1', name: 'Dungeon Level 1', width: 20, height: 20 },
    { key: 'dungeon-1b', name: 'Dungeon Level 1 Alt', width: 20, height: 20 },
  );
  spec.links.push(
    { kind: 'portal', from: 'surface', from_x: 1050, from_y: 1050, to: 'dungeon-1', to_x: 550, to_y: 550 },
    { kind: 'portal', from: 'surface', from_x: 1050, from_y: 1050, to: 'dungeon-1b', to_x: 550, to_y: 550 },
  );
  const errors = validateMapSpec(spec);
  assert.ok(errors.some((e) => /already has a portal/.test(e)));
});

test('a dungeon level unreachable from the entry (no portal, no grid link) is still rejected', () => {
  const spec = baseSpec();
  spec.worlds.push({ key: 'dungeon-orphan', name: 'Orphan', width: 20, height: 20 });
  // Note: no link at all references dungeon-orphan.
  const errors = validateMapSpec(spec);
  assert.ok(errors.some((e) => /dungeon-orphan.*unreachable/.test(e)));
});

test('reachability BFS walks portal links, not just compass links', () => {
  const spec = baseSpec();
  spec.worlds.push(
    { key: 'dungeon-1', name: 'Dungeon Level 1', width: 20, height: 20 },
    { key: 'dungeon-2', name: 'Dungeon Level 2', width: 20, height: 20 },
  );
  spec.links.push(
    { kind: 'portal', from: 'surface', from_x: 1050, from_y: 1050, to: 'dungeon-1', to_x: 550, to_y: 550 },
    { kind: 'portal', from: 'dungeon-1', from_x: 1050, from_y: 1050, to: 'dungeon-2', to_x: 550, to_y: 550 },
  );
  const errors = validateMapSpec(spec);
  assert.deepStrictEqual(errors, [],
    'dungeon-2 is reachable transitively through two portal hops, not directly from the entry');
});

test('a guard config on a portal is validated: positive integer count', () => {
  const spec = baseSpec();
  spec.worlds.push({ key: 'dungeon-1', name: 'Dungeon Level 1', width: 20, height: 20 });
  spec.links.push({
    kind: 'portal', from: 'surface', from_x: 1050, from_y: 1050,
    to: 'dungeon-1', to_x: 550, to_y: 550,
    guard: { creature_type: 'Orc', count: 0 },
  });
  const errors = validateMapSpec(spec);
  assert.ok(errors.some((e) => /guard.*count/.test(e)));
});

test('a guard config referencing an unknown creature type is rejected when a catalog is supplied', () => {
  const spec = baseSpec();
  spec.worlds.push({ key: 'dungeon-1', name: 'Dungeon Level 1', width: 20, height: 20 });
  spec.links.push({
    kind: 'portal', from: 'surface', from_x: 1050, from_y: 1050,
    to: 'dungeon-1', to_x: 550, to_y: 550,
    guard: { creature_type: 'Nonexistent Beast', count: 2 },
  });
  const errors = validateMapSpec(spec, { creatureTypeNames: new Set(['Orc']) });
  assert.ok(errors.some((e) => /unknown creature type "Nonexistent Beast"/.test(e)));
});

test('a compass-only spec with no portals validates exactly as before (no regression)', () => {
  const spec = baseSpec();
  spec.worlds.push({ key: 'east', name: 'East', grid: [1, 0], width: 20, height: 20 });
  spec.links.push({ from: 'surface', to: 'east', edge: 'E' });
  const errors = validateMapSpec(spec);
  assert.deepStrictEqual(errors, []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && node --test tests/map_spec_portals.test.js`
Expected: FAIL — every grid-less world currently errors unconditionally, and no `kind: 'portal'` handling exists.

- [ ] **Step 3: Implement**

```js
// backend/seeds/mapSpec.js — modify validateMapSpec (full function body)
function hasValidGrid(w) {
  return Array.isArray(w.grid) && w.grid.length === 2
      && Number.isInteger(w.grid[0]) && Number.isInteger(w.grid[1]);
}

function validateMapSpec(spec, { biomeNames = null, creatureTypeNames = null } = {}) {
  const errors = [];
  if (!spec || typeof spec !== 'object') return ['spec is not an object'];
  const worlds = Array.isArray(spec.worlds) ? spec.worlds : [];
  const links = Array.isArray(spec.links) ? spec.links : [];
  if (worlds.length === 0) return ['spec has no worlds'];

  const byKey = new Map();
  const seenNames = new Set();
  const cells = new Map();

  // A world reachable only through a PORTAL link never embeds in the
  // overworld's 2D grid, so it must not be required to declare one. This
  // scan runs before the per-world loop so that loop can consult it.
  const portalConnectedKeys = new Set();
  for (const l of links) {
    if (l.kind === 'portal') { portalConnectedKeys.add(l.from); portalConnectedKeys.add(l.to); }
  }

  for (const w of worlds) {
    if (byKey.has(w.key)) errors.push(`duplicate key "${w.key}"`);
    byKey.set(w.key, w);
    if (seenNames.has(w.name)) errors.push(`duplicate name "${w.name}"`);
    seenNames.add(w.name);

    const gridRequired = !portalConnectedKeys.has(w.key);
    if (!hasValidGrid(w)) {
      if (gridRequired) errors.push(`world "${w.key}" grid must be two integers`);
      // else: portal-only world, grid legitimately absent -- no cell-collision
      // check for it either, there is no cell to collide in.
    } else {
      const cell = `${w.grid[0]},${w.grid[1]}`;
      if (cells.has(cell)) {
        errors.push(`worlds "${cells.get(cell)}" and "${w.key}" occupy the same grid cell ${cell}`);
      }
      cells.set(cell, w.key);
    }

    if (!Number.isInteger(w.width)) {
      errors.push(`world "${w.key}" width must be an integer`);
    }
    if (!Number.isInteger(w.height)) {
      errors.push(`world "${w.key}" height must be an integer`);
    }

    if (w.level_band !== undefined) {
      const b = w.level_band;
      if (!Array.isArray(b) || b.length !== 2
          || !Number.isInteger(b[0]) || !Number.isInteger(b[1])) {
        errors.push(`world "${w.key}" level_band must be [min, max] with integer values`);
      } else if (b[0] < 1) {
        errors.push(`world "${w.key}" level_band minimum must be at least 1`);
      } else if (b[1] < b[0]) {
        errors.push(`world "${w.key}" level_band maximum must be >= its minimum`);
      }
    }

    if (w.village) {
      const v = w.village;
      if (!(v.width >= VILLAGE_LIMITS.minW && v.width <= VILLAGE_LIMITS.maxW)) {
        errors.push(`world "${w.key}" village width must be between 3 and 8 tiles`);
      }
      if (!(v.height >= VILLAGE_LIMITS.minH && v.height <= VILLAGE_LIMITS.maxH)) {
        errors.push(`world "${w.key}" village height must be between 3 and 6 tiles`);
      }
      if (!['N', 'E', 'S', 'W'].includes(v.gate_edge)) {
        errors.push(`world "${w.key}" village gate_edge must be one of N,E,S,W`);
      }
    }

    if (biomeNames) {
      for (const b of w.biomes ?? []) {
        if (!biomeNames.has(b)) errors.push(`world "${w.key}" references unknown biome "${b}"`);
      }
    }
    if (creatureTypeNames) {
      for (const c of w.allowed_creature_types ?? []) {
        if (!creatureTypeNames.has(c)) {
          errors.push(`world "${w.key}" references unknown creature type "${c}"`);
        }
      }
    }
  }

  const entries = worlds.filter((w) => w.is_entry === true);
  if (entries.length !== 1) {
    errors.push(`spec must have exactly one world with is_entry: true (found ${entries.length})`);
  }

  const usedEdges = new Set();
  const usedPortalSources = new Set();
  const adjacency = new Map(worlds.map((w) => [w.key, []]));
  for (const l of links) {
    const from = byKey.get(l.from);
    const to = byKey.get(l.to);
    if (!from) { errors.push(`link references unknown world "${l.from}"`); continue; }
    if (!to) { errors.push(`link references unknown world "${l.to}"`); continue; }

    if (l.kind === 'portal') {
      const coordFields = ['from_x', 'from_y', 'to_x', 'to_y'];
      const badField = coordFields.find((f) => !Number.isInteger(l[f]));
      if (badField) {
        errors.push(`portal link ${l.from}->${l.to} ${badField} must be an integer`);
        adjacency.get(l.from).push(l.to);
        adjacency.get(l.to).push(l.from);
        continue;
      }
      const slot = `${l.from}:${l.from_x},${l.from_y}`;
      if (usedPortalSources.has(slot)) {
        errors.push(`world "${l.from}" already has a portal from tile (${l.from_x},${l.from_y})`);
      }
      usedPortalSources.add(slot);

      if (l.guard) {
        if (!Number.isInteger(l.guard.count) || l.guard.count < 1) {
          errors.push(`portal link ${l.from}->${l.to} guard count must be a positive integer`);
        }
        if (creatureTypeNames && !creatureTypeNames.has(l.guard.creature_type)) {
          errors.push(`portal link ${l.from}->${l.to} references unknown creature type "${l.guard.creature_type}"`);
        }
      }

      adjacency.get(l.from).push(l.to);
      adjacency.get(l.to).push(l.from);
      continue;
    }

    if (!EDGE_DELTA[l.edge]) { errors.push(`link ${l.from}->${l.to} has invalid edge "${l.edge}"`); continue; }

    const slot = `${l.from}:${l.edge}`;
    if (usedEdges.has(slot)) {
      errors.push(`world "${l.from}" already has a link on edge ${l.edge} — UNIQUE(from_world_id, edge) allows one`);
    }
    usedEdges.add(slot);

    if (!hasValidGrid(from) || !hasValidGrid(to)) {
      adjacency.get(l.from).push(l.to);
      adjacency.get(l.to).push(l.from);
      continue;
    }

    const [dx, dy] = EDGE_DELTA[l.edge];
    const wantX = from.grid[0] + dx;
    const wantY = from.grid[1] + dy;
    if (to.grid[0] !== wantX || to.grid[1] !== wantY) {
      const adjacent = Math.abs(to.grid[0] - from.grid[0]) + Math.abs(to.grid[1] - from.grid[1]) === 1;
      errors.push(adjacent
        ? `link ${l.from}->${l.to} declares edge ${l.edge} but the grid puts "${l.to}" elsewhere`
        : `link ${l.from}->${l.to} declares edge ${l.edge} but the cells are not adjacent`);
    }

    adjacency.get(l.from).push(l.to);
    adjacency.get(l.to).push(l.from);   // links are bidirectional (setLink mirrors)
  }

  if (entries.length === 1) {
    const seen = new Set([entries[0].key]);
    const queue = [entries[0].key];
    while (queue.length) {
      for (const next of adjacency.get(queue.shift()) ?? []) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    for (const w of worlds) {
      if (!seen.has(w.key)) errors.push(`world "${w.key}" is unreachable from the entry`);
    }
  }

  return errors;
}

module.exports = { validateMapSpec, EDGE_DELTA };
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && node --test tests/map_spec_portals.test.js`
Expected: PASS, 10/10.

- [ ] **Step 5: Run the existing mapSpec tests to confirm no regression**

Run: `cd backend && node --test tests/*.test.js 2>&1 | grep -i "mapspec\|map_spec\|seed_map"` (or run the full suite)
Then: `cd backend && npm test`
Expected: no new failures.

- [ ] **Step 6: Commit**

```bash
git add backend/seeds/mapSpec.js backend/tests/map_spec_portals.test.js
git commit -m "feat(dungeons): validate portal links and grid-less dungeon worlds (SOMET-243)"
```

---

### Task 5: `dungeonGuards.js` — structural guard spawn tied to a portal

**Files:**
- Create: `backend/src/services/dungeonGuards.js`
- Test: `backend/tests/dungeon_guards.test.js`

**Interfaces:**
- Consumes: Task 2's `world_creatures.blocks_portal_id`.
- Produces: `insertPortalGuards(db, worldId, portalLinkId, x, y, creatureType, count)` — inserts `count` guards near `(x, y)`, each with `home_x`/`home_y` set to that point (so they leash to the portal, exactly like a village guard leashes to its gate post) and `blocks_portal_id` set to `portalLinkId`.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/dungeon_guards.test.js
const test = require('node:test');
const assert = require('node:assert');
const { insertPortalGuards } = require('../src/services/dungeonGuards.js');

function fakeDb() {
  const inserted = [];
  return {
    inserted,
    async query(sql, params) {
      if (/^\s*INSERT INTO world_creatures/i.test(sql)) {
        const [worldId, type, x, y, hp, facing, homeX, homeY, blocksPortalId] = params;
        inserted.push({ worldId, type, x, y, hp, facing, homeX, homeY, blocksPortalId });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

test('inserts exactly `count` guards, each anchored to the portal tile', async () => {
  const db = fakeDb();
  await insertPortalGuards(db, 'world-1', 'link-1', 1050, 1050, 'Orc', 3);
  assert.equal(db.inserted.length, 3);
  for (const row of db.inserted) {
    assert.equal(row.worldId, 'world-1');
    assert.equal(row.type, 'Orc');
    assert.equal(row.homeX, 1050);
    assert.equal(row.homeY, 1050);
    assert.equal(row.blocksPortalId, 'link-1');
  }
});

test('a single guard is placed exactly on the portal tile', async () => {
  const db = fakeDb();
  await insertPortalGuards(db, 'world-1', 'link-1', 1050, 1050, 'Orc', 1);
  assert.equal(db.inserted.length, 1);
  assert.equal(db.inserted[0].x, 1050);
  assert.equal(db.inserted[0].y, 1050);
});

test('a pack of guards is spread around the portal tile, not stacked on it', async () => {
  const db = fakeDb();
  await insertPortalGuards(db, 'world-1', 'link-1', 1050, 1050, 'Orc', 3);
  const positions = new Set(db.inserted.map((r) => `${r.x},${r.y}`));
  assert.equal(positions.size, 3, 'a pack must not spawn stacked on the identical tile');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && node --test tests/dungeon_guards.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```js
// backend/src/services/dungeonGuards.js
// A portal's guard pack. Same structural-spawn shape villages.js already
// uses for its gate guards (a direct INSERT, faction resolved later via
// entity_types, never a random roll) -- extended with blocks_portal_id so
// the authority's portal-trigger check can gate on this specific pack's
// liveness. home_x/home_y is set to the same tile the guard is placed near,
// exactly like a village guard leashes to its post, so a displaced guard
// (knocked around, chasing) still recovers back to defending the portal.
//
// A pack of more than one guard is spread in a small ring around the portal
// tile rather than stacked on the identical pixel, matching how creature
// placement elsewhere in this codebase avoids exact-overlap spawns.
const RING_OFFSETS = [
  [0, 0], [60, 0], [-60, 0], [0, 60], [0, -60], [45, 45], [-45, 45], [45, -45],
];

async function insertPortalGuards(db, worldId, portalLinkId, x, y, creatureType, count) {
  for (let i = 0; i < count; i++) {
    const [dx, dy] = RING_OFFSETS[i % RING_OFFSETS.length];
    await db.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y, blocks_portal_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [worldId, creatureType, x + dx, y + dy, 300, 'S', x, y, portalLinkId],
    );
  }
}

module.exports = { insertPortalGuards };
```

Note: `hp: 300` mirrors `villages.js`'s `GUARD_TYPE`/`insertVillageGuards` literal — kept as a plain constant here rather than imported, because a dungeon guard's `hp` comes from `creatureType`'s `entity_types` row via the same load path every other creature uses (Task 6 loads `hp` from `entity_types`, not from this literal at spawn time for anything except the placeholder row value; confirm against `entity_types.hp` for the chosen `creatureType` when authoring a real spec — this mirrors exactly how `Village Guard`'s `hp: 300` in `villages.js:40` is itself only the placeholder written to `world_creatures.hp` at INSERT time, later interpreted by the same load path as every other creature).

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && node --test tests/dungeon_guards.test.js`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/dungeonGuards.js backend/tests/dungeon_guards.test.js
git commit -m "feat(dungeons): add insertPortalGuards structural spawn (SOMET-243)"
```

---

### Task 6: `seed-map.js` — apply portal links, grid-less worlds, and guards

**Files:**
- Modify: `backend/scripts/seed-map.js`
- Test: `backend/tests/seed_map_portals.test.js`

**Interfaces:**
- Consumes: `setPortalLink` (Task 3), `validateMapSpec` (Task 4), `insertPortalGuards` (Task 5).
- Produces: `applyMapSpec(pool, spec)` (signature unchanged) now also writes portal links and portal guards; return value gains a `portalGuards` count alongside the existing `{ worlds, links, villages }`.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/seed_map_portals.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { applyMapSpec } = require('../scripts/seed-map.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

function requireTestDb(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await pool.query('SELECT 1'); return pool; }
  catch (err) { await pool.end().catch(() => {}); return { unreachable: err.message }; }
}

// Every world/village name in this spec is uuid-suffixed so a failed run
// never collides with a real seeded map, and every row this test creates is
// deleted in `finally` regardless of outcome.
function uniqueSpec(suffix) {
  return {
    name: `portal-seed-test-${suffix}`,
    worlds: [
      { key: 'surface', name: `Portal Test Surface ${suffix}`, grid: [0, 0],
        width: 20, height: 20, seed: 's', is_entry: true },
      { key: 'dungeon-1', name: `Portal Test Dungeon 1 ${suffix}`,
        width: 20, height: 20, seed: 's', level_band: [3, 5] },
    ],
    links: [
      { kind: 'portal', from: 'surface', from_x: 1050, from_y: 1050,
        to: 'dungeon-1', to_x: 550, to_y: 550,
        guard: { creature_type: 'Orc', count: 2 } },
    ],
  };
}

test('applyMapSpec writes a grid-less dungeon world, its portal link, and its guards', async (t) => {
  if (!requireTestDb(t, 'writes a real spec through applyMapSpec')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const suffix = 'a1';
  const spec = uniqueSpec(suffix);
  let worldIds = [];
  try {
    const orcRow = await pool.query(`SELECT 1 FROM entity_types WHERE name = 'Orc' AND is_creature = true`);
    if (orcRow.rowCount === 0) { t.skip('no "Orc" creature type in this database — cannot exercise guard insertion'); return; }

    const result = await applyMapSpec(pool, spec);
    assert.equal(result.worlds, 2);
    assert.equal(result.links, 1);
    assert.equal(result.portalGuards, 2);

    const worldRows = await pool.query(
      `SELECT id, name, width, height, level_min, level_max, graph_x, graph_y FROM worlds WHERE name = ANY($1)`,
      [spec.worlds.map((w) => w.name)]);
    worldIds = worldRows.rows.map((r) => r.id);
    assert.equal(worldRows.rowCount, 2);
    const dungeon = worldRows.rows.find((r) => r.name === spec.worlds[1].name);
    assert.equal(dungeon.level_min, 3);
    assert.equal(dungeon.level_max, 5);
    assert.strictEqual(dungeon.graph_x, null, 'a grid-less world must not get a graph position');
    assert.strictEqual(dungeon.graph_y, null);

    const surface = worldRows.rows.find((r) => r.name === spec.worlds[0].name);
    const linkRows = await pool.query(
      `SELECT id, edge, to_world_id, from_x, from_y, to_x, to_y
         FROM map_links WHERE from_world_id = $1 AND edge = 'PORTAL'`, [surface.id]);
    assert.equal(linkRows.rowCount, 1);
    assert.equal(linkRows.rows[0].to_world_id, dungeon.id);

    const guardRows = await pool.query(
      `SELECT type, blocks_portal_id, home_x, home_y FROM world_creatures WHERE world_id = $1`, [surface.id]);
    assert.equal(guardRows.rowCount, 2);
    for (const g of guardRows.rows) {
      assert.equal(g.type, 'Orc');
      assert.equal(g.blocks_portal_id, linkRows.rows[0].id);
      assert.equal(g.home_x, 1050);
      assert.equal(g.home_y, 1050);
    }
  } finally {
    if (worldIds.length) {
      await pool.query('DELETE FROM worlds WHERE id = ANY($1)', [worldIds]); // CASCADEs links/creatures
    }
    await pool.end();
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && TEST_DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" node --test tests/seed_map_portals.test.js`
Expected: FAIL — `applyMapSpec` doesn't handle `kind: 'portal'` links yet, and `graphPosition(undefined)` throws or produces `NaN`.

- [ ] **Step 3: Implement**

```js
// backend/scripts/seed-map.js — modify applyMapSpec (relevant sections)
const { validateMapSpec } = require('../seeds/mapSpec.js');
const { setLink, setPortalLink } = require('../src/services/mapLinks.js');
const { createVillage } = require('../src/services/villages.js');
const { insertPortalGuards } = require('../src/services/dungeonGuards.js');

// ... graphPosition, GRID_SPACING unchanged ...

async function applyMapSpec(pool, spec) {
  const catalogs = {
    biomeNames: new Set((await pool.query('SELECT name FROM biomes')).rows.map((r) => r.name)),
    creatureTypeNames: new Set(
      (await pool.query('SELECT name FROM entity_types WHERE is_creature = true')).rows.map((r) => r.name)),
  };
  const errors = validateMapSpec(spec, catalogs);
  if (errors.length) {
    throw new Error(`invalid spec "${spec.name}":\n  - ${errors.join('\n  - ')}`);
  }

  const client = await pool.connect();
  const idByKey = new Map();
  try {
    await client.query('BEGIN');

    let worldsWritten = 0;
    let linksWritten = 0;
    let portalGuardsWritten = 0;

    for (const w of spec.worlds) {
      // A grid-less (portal-only) world has nothing to derive a World Map
      // position from -- graph_x/graph_y stay NULL, exactly the same NULL
      // the frontend already treats as "no stored position, use the layout
      // fallback" for any world an admin hasn't dragged yet.
      const pos = w.grid ? graphPosition(w.grid) : { x: null, y: null };
      const r = await client.query(
        `INSERT INTO worlds (name, seed, chunk_size, width, height, creature_count,
                             allowed_creature_types, entry_spawn, biomes, biome_cell,
                             graph_x, graph_y, level_min, level_max)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14)
         ON CONFLICT (name) DO UPDATE
           SET seed = EXCLUDED.seed, chunk_size = EXCLUDED.chunk_size,
               width = EXCLUDED.width, height = EXCLUDED.height,
               creature_count = EXCLUDED.creature_count,
               allowed_creature_types = EXCLUDED.allowed_creature_types,
               entry_spawn = EXCLUDED.entry_spawn, biomes = EXCLUDED.biomes,
               biome_cell = EXCLUDED.biome_cell,
               graph_x = EXCLUDED.graph_x, graph_y = EXCLUDED.graph_y,
               level_min = EXCLUDED.level_min, level_max = EXCLUDED.level_max
         RETURNING id`,
        [w.name, w.seed, w.chunk_size ?? 64, w.width, w.height, w.creature_count ?? 0,
         JSON.stringify(w.allowed_creature_types ?? []),
         w.entry_spawn ? JSON.stringify(w.entry_spawn) : null,
         JSON.stringify(w.biomes ?? []), w.biome_cell ?? null,
         pos.x, pos.y,
         w.level_band ? w.level_band[0] : 1,
         w.level_band ? w.level_band[1] : 1],
      );
      idByKey.set(w.key, r.rows[0].id);
      worldsWritten += 1;
    }

    // After every world exists, so a link can never reference a missing
    // target. setLink/setPortalLink write the mirror row themselves -- never
    // INSERT into map_links here. portalLinkIds records the FORWARD row's id
    // per source tile, for the guard-insertion pass below.
    const portalLinkIds = new Map(); // `${fromKey}:${from_x},${from_y}` -> link id
    for (const l of spec.links) {
      if (l.kind === 'portal') {
        const { id } = await setPortalLink(
          client, idByKey.get(l.from), l.from_x, l.from_y, idByKey.get(l.to), l.to_x, l.to_y);
        portalLinkIds.set(`${l.from}:${l.from_x},${l.from_y}`, id);
      } else {
        await setLink(client, idByKey.get(l.from), l.edge, idByKey.get(l.to));
      }
      linksWritten += 1;
    }

    for (const l of spec.links) {
      if (l.kind !== 'portal' || !l.guard) continue;
      const linkId = portalLinkIds.get(`${l.from}:${l.from_x},${l.from_y}`);
      await insertPortalGuards(
        client, idByKey.get(l.from), linkId, l.from_x, l.from_y, l.guard.creature_type, l.guard.count);
      portalGuardsWritten += l.guard.count;
    }

    let villages = 0;
    for (const w of spec.worlds) {
      if (!w.village) continue;
      const worldId = idByKey.get(w.key);
      const existing = await client.query('SELECT id FROM villages WHERE world_id = $1', [worldId]);
      if (existing.rowCount === 0) {
        await createVillage(client, worldId, w.village);
        villages += 1;
      }
    }

    const entry = spec.worlds.find((w) => w.is_entry);
    if (entry) {
      await client.query('UPDATE worlds SET is_entry = false WHERE is_entry = true AND id <> $1',
        [idByKey.get(entry.key)]);
      await client.query('UPDATE worlds SET is_entry = true WHERE id = $1', [idByKey.get(entry.key)]);
    }

    await client.query('COMMIT');
    return { worlds: worldsWritten, links: linksWritten, villages, portalGuards: portalGuardsWritten };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { applyMapSpec, GRID_SPACING, graphPosition };

if (require.main === module) {
  // ... unchanged, except the logged line gains portalGuards ...
  applyMapSpec(pool, JSON.parse(fs.readFileSync(file, 'utf8')))
    .then((n) => console.log(
      `applied ${name}: ${n.worlds} worlds, ${n.links} links, ${n.villages} villages, ${n.portalGuards} portal guards`))
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
```

**Note on idempotency:** re-applying the same spec re-runs `setPortalLink`'s `ON CONFLICT ... DO UPDATE`, which is idempotent for the link row itself, but `insertPortalGuards` is a bare `INSERT` with no conflict handling — re-applying a spec with a portal guard would duplicate guards on every re-run. This matches `createVillage`'s own guard insertion, which has the identical property and is guarded at the call site (`if (existing.rowCount === 0)`) rather than inside `insertVillageGuards` itself. Task 6 must add the same call-site guard for portal guards — **this is a real gap in the Step 3 code above and must be fixed before commit**: check `SELECT 1 FROM world_creatures WHERE blocks_portal_id = $1 LIMIT 1` before calling `insertPortalGuards`, skip if any row already exists for that link.

- [ ] **Step 3b: Fix the idempotency gap found in Step 3**

```js
    for (const l of spec.links) {
      if (l.kind !== 'portal' || !l.guard) continue;
      const linkId = portalLinkIds.get(`${l.from}:${l.from_x},${l.from_y}`);
      const existingGuards = await client.query(
        'SELECT 1 FROM world_creatures WHERE blocks_portal_id = $1 LIMIT 1', [linkId]);
      if (existingGuards.rowCount === 0) {
        await insertPortalGuards(
          client, idByKey.get(l.from), linkId, l.from_x, l.from_y, l.guard.creature_type, l.guard.count);
        portalGuardsWritten += l.guard.count;
      }
    }
```

- [ ] **Step 4: Add a re-apply idempotency test, then run all seed_map_portals tests**

```js
// append to backend/tests/seed_map_portals.test.js
test('re-applying the same spec does not duplicate the portal guard pack', async (t) => {
  if (!requireTestDb(t, 'writes a real spec through applyMapSpec twice')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const suffix = 'idempotent1';
  const spec = uniqueSpec(suffix);
  let worldIds = [];
  try {
    const orcRow = await pool.query(`SELECT 1 FROM entity_types WHERE name = 'Orc' AND is_creature = true`);
    if (orcRow.rowCount === 0) { t.skip('no "Orc" creature type — cannot exercise guard insertion'); return; }

    await applyMapSpec(pool, spec);
    await applyMapSpec(pool, spec); // second application, same spec

    const worldRows = await pool.query(`SELECT id FROM worlds WHERE name = ANY($1)`,
      [spec.worlds.map((w) => w.name)]);
    worldIds = worldRows.rows.map((r) => r.id);
    const surfaceId = worldRows.rows[0].id; // either order works: both are cleaned up below

    const guardCount = await pool.query(
      `SELECT count(*) FROM world_creatures WHERE world_id = ANY($1) AND type = 'Orc'`, [worldIds]);
    assert.equal(Number(guardCount.rows[0].count), 2, 'guards must not double up on re-apply');
  } finally {
    if (worldIds.length) await pool.query('DELETE FROM worlds WHERE id = ANY($1)', [worldIds]);
    await pool.end();
  }
});
```

Run: `cd backend && TEST_DATABASE_URL="postgres://user:password@127.0.0.1:15432/game_db" node --test tests/seed_map_portals.test.js`
Expected: PASS, all subtests including the idempotency one.

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && npm test`
Expected: no regressions — `applyMapSpec`'s return-shape gained a field (`portalGuards`), never removed one.

- [ ] **Step 6: Commit**

```bash
git add backend/scripts/seed-map.js backend/tests/seed_map_portals.test.js
git commit -m "feat(dungeons): applyMapSpec writes portal links and idempotent guard packs (SOMET-243)"
```

---

### Task 7: `creatures.js` — carry `blocksPortalId` on in-memory creatures

**Files:**
- Modify: `backend/src/authority/creatures.js`
- Modify: `backend/src/authority/server.js:499-507` (the chunk-activation SELECT)
- Test: `backend/tests/creature_blocks_portal_load.test.js`

**Interfaces:**
- Consumes: `world_creatures.blocks_portal_id` (Task 2).
- Produces: every creature object in `CreatureSim.creatures` carries `blocksPortalId` (string id or `null`), loaded the same way `home` already is.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/creature_blocks_portal_load.test.js
const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim } = require('../src/authority/creatures.js');

function stubMap() { return { chunkSize: 8 }; }

test('addCreatures carries blocks_portal_id through as blocksPortalId', () => {
  const sim = new CreatureSim(stubMap());
  sim.addCreatures([
    { id: 'c1', type: 'Orc', x: 100, y: 100, hp: 50, faction: 'guard', blocks_portal_id: 'link-1' },
    { id: 'c2', type: 'Slime', x: 200, y: 200, hp: 20, faction: 'hostile' }, // no column at all
  ]);
  assert.equal(sim.creatures.get('c1').blocksPortalId, 'link-1');
  assert.strictEqual(sim.creatures.get('c2').blocksPortalId, null,
    'a creature with no blocks_portal_id must not silently inherit a stale value or crash');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && node --test tests/creature_blocks_portal_load.test.js`
Expected: FAIL — `blocksPortalId` is `undefined`, and `CreatureSim` may not even be exported by name (check the existing `module.exports` at the bottom of `creatures.js`; if it exports differently, adjust the test's `require` to match — do not change the export shape itself for this task, only add the field inside `addCreatures`).

- [ ] **Step 3: Implement**

```js
// backend/src/authority/creatures.js — inside CreatureSim.addCreatures, extend the object literal
      this.creatures.set(c.id, {
        id: c.id, type: c.type, x: c.x, y: c.y,
        width: CREATURE_SIZE, height: CREATURE_SIZE, speed: CREATURE_SPEED,
        facing: c.facing || 'S', hp: c.hp, maxHp: c.hp, color: c.color,
        mit: creatureMitigation(c),
        level: Number.isInteger(c.level) ? c.level : 1,
        damage: Number.isFinite(c.damage) ? Number(c.damage) : CREATURE_DAMAGE,
        _dir: dirIdx, dirty: false,
        faction: c.faction || 'hostile',
        home: (Number.isFinite(c.home_x) && Number.isFinite(c.home_y))
          ? { x: c.home_x, y: c.home_y }
          : null,
        // Which portal (map_links.id) this creature gates, or null for every
        // ordinary creature. Loaded the same way `home` is above -- a raw DB
        // column carried straight onto the in-memory object at load time,
        // never recomputed.
        blocksPortalId: c.blocks_portal_id || null,
        _target: null, _targetKind: null, mode: 'roam', _attackCd: 0,
      });
```

```js
// backend/src/authority/server.js:499-507 — extend the chunk-activation SELECT
      // et.resistances feeds CreatureSim's `mit`; dropping it from this
      // SELECT loads it as undefined and silently makes every creature
      // resistance inert. et.faction/wc.home_x/wc.home_y are the same kind
      // of column: drop them and guards silently revert to ordinary
      // roaming hostiles with no anchor. wc.level/wc.damage are that kind
      // of column too now: drop either and a spawned creature's level and
      // per-instance damage silently fall back to 1 / CREATURE_DAMAGE.
      // wc.blocks_portal_id is the newest of this family: drop it and a
      // guarded dungeon portal silently stops being guarded -- the block
      // check in server.js reads this field off the in-memory creature, not
      // the database, so a missing column here is invisible until someone
      // notices a portal that should be blocked is not.
      //
      // ... (defense/COALESCE comment unchanged) ...
      const rows = await pool.query(
        `SELECT wc.id, wc.type, wc.x, wc.y, wc.hp, wc.facing, wc.home_x, wc.home_y,
                wc.level, wc.damage, wc.blocks_portal_id,
                COALESCE(wc.defense, et.defense) AS defense,
                et.color, et.resistances, et.faction
         FROM world_creatures wc LEFT JOIN entity_types et ON et.name = wc.type
         WHERE wc.world_id = $1 AND wc.x >= $2 AND wc.x < $3 AND wc.y >= $4 AND wc.y < $5`,
        [entry.worldId, cx * span, cx * span + span, cy * span, cy * span + span],
      );
      entry.world.creatures.addCreatures(rows.rows);
```

**Important:** re-read the comment immediately preceding the real SELECT in `server.js` before editing — it says this exact query is guarded by a substring test in `authority_creatures_integration.test.js` that scans the live SQL text for each column name, and that rationale comments must stay *outside* the template literal for that reason. Add `wc.blocks_portal_id` to the actual SQL string (not just the comment), and check whether that substring-guard test needs a matching addition (`assert.match` for `blocks_portal_id`) — if it does, add it there too as part of this task, not as an afterthought.

- [ ] **Step 4: Extend the substring guard test**

`backend/tests/authority_creatures_integration.test.js:176-179` already loops a column-presence check over the SELECT text:

```js
  for (const col of ['resistances', 'level', 'damage']) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(sel),
      `the world_creatures load must SELECT ${col} — without it every creature's mit/level/damage is wrong`);
  }
```

Add `'blocks_portal_id'` to that array:

```js
  for (const col of ['resistances', 'level', 'damage', 'blocks_portal_id']) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(sel),
      `the world_creatures load must SELECT ${col} — without it a guarded dungeon portal silently stops being guarded`);
  }
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd backend && node --test tests/creature_blocks_portal_load.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && npm test`
Expected: no regressions, including `authority_creatures_integration.test.js` if it was extended in Step 4.

- [ ] **Step 7: Commit**

```bash
git add backend/src/authority/creatures.js backend/src/authority/server.js backend/tests/creature_blocks_portal_load.test.js backend/tests/authority_creatures_integration.test.js
git commit -m "feat(dungeons): load blocks_portal_id onto in-memory creatures (SOMET-243)"
```

---

### Task 8: `server.js` — `planPortalTransition`, blocking, and knockback

This is the task the spec flags as the highest-risk one: the first blocking mechanic in this codebase. Keep the gating check as its own isolated, directly-testable pure function — do not fold it into `planTransition` or the tick loop's existing compass-link branch.

**Files:**
- Modify: `backend/src/authority/server.js`
- Test: `backend/tests/plan_portal_transition.test.js` (pure function)
- Test: `backend/tests/portal_blocking_live.test.js` (live `attachAuthority` integration)

**Interfaces:**
- Consumes: `entry.links` construction pattern (existing), `fetchLinks` (Task 3, widened), `blocksPortalId` on creatures (Task 7), `map.isWalkable` (`collision.js`, existing).
- Produces:
  - `planPortalTransition({ gRow, gCol, portalLinks, now, cdUntil, creatures })` → `null` (no portal here, or cooldown active) | `{ blocked: true, linkId }` (portal here, guard alive) | `{ toWorldId, arriveX, arriveY }` (portal here, clear).
  - `isPortalBlocked(creatures, linkId)` → boolean.
  - `knockbackPosition({ px, py, portalX, portalY, distance, map })` → `{ x, y }`.

- [ ] **Step 1: Write the failing pure-function tests**

```js
// backend/tests/plan_portal_transition.test.js
const test = require('node:test');
const assert = require('node:assert');
const { planPortalTransition, isPortalBlocked, knockbackPosition } = require('../src/authority/server.js');

function portalLinksWith(entries) {
  // Keyed exactly as the real world-load code keys it: "gRow,gCol" of the
  // portal's own from_x/from_y, tile-floored.
  return new Map(entries.map((e) => [`${e.gRow},${e.gCol}`, e]));
}

test('no portal at this tile returns null', () => {
  const links = portalLinksWith([{ gRow: 5, gCol: 5, id: 'link-1', toWorldId: 'w2', toX: 50, toY: 50 }]);
  const result = planPortalTransition({
    gRow: 1, gCol: 1, portalLinks: links, now: 1000, cdUntil: 0, creatures: [],
  });
  assert.strictEqual(result, null);
});

test('a portal on cooldown returns null even though the tile matches', () => {
  const links = portalLinksWith([{ gRow: 5, gCol: 5, id: 'link-1', toWorldId: 'w2', toX: 50, toY: 50 }]);
  const result = planPortalTransition({
    gRow: 5, gCol: 5, portalLinks: links, now: 1000, cdUntil: 2000, creatures: [],
  });
  assert.strictEqual(result, null);
});

test('an unblocked portal returns the transition', () => {
  const links = portalLinksWith([{ gRow: 5, gCol: 5, id: 'link-1', toWorldId: 'w2', toX: 50, toY: 50 }]);
  const result = planPortalTransition({
    gRow: 5, gCol: 5, portalLinks: links, now: 1000, cdUntil: 0, creatures: [],
  });
  assert.deepStrictEqual(result, { toWorldId: 'w2', arriveX: 50, arriveY: 50 });
});

test('a portal with a living blocking guard returns blocked, not a transition', () => {
  const links = portalLinksWith([{ gRow: 5, gCol: 5, id: 'link-1', toWorldId: 'w2', toX: 50, toY: 50 }]);
  const creatures = [{ id: 'g1', hp: 50, blocksPortalId: 'link-1' }];
  const result = planPortalTransition({
    gRow: 5, gCol: 5, portalLinks: links, now: 1000, cdUntil: 0, creatures,
  });
  assert.deepStrictEqual(result, { blocked: true, linkId: 'link-1' });
});

test('a portal whose guard already died returns the transition (unblocks the instant hp hits 0)', () => {
  const links = portalLinksWith([{ gRow: 5, gCol: 5, id: 'link-1', toWorldId: 'w2', toX: 50, toY: 50 }]);
  const creatures = [{ id: 'g1', hp: 0, blocksPortalId: 'link-1' }];
  const result = planPortalTransition({
    gRow: 5, gCol: 5, portalLinks: links, now: 1000, cdUntil: 0, creatures,
  });
  assert.deepStrictEqual(result, { toWorldId: 'w2', arriveX: 50, arriveY: 50 });
});

test('a living guard blocking a DIFFERENT portal does not block this one', () => {
  const links = portalLinksWith([{ gRow: 5, gCol: 5, id: 'link-1', toWorldId: 'w2', toX: 50, toY: 50 }]);
  const creatures = [{ id: 'g1', hp: 50, blocksPortalId: 'link-999' }];
  const result = planPortalTransition({
    gRow: 5, gCol: 5, portalLinks: links, now: 1000, cdUntil: 0, creatures,
  });
  assert.deepStrictEqual(result, { toWorldId: 'w2', arriveX: 50, arriveY: 50 },
    'this proves the linkage is the FK, not proximity -- an unrelated live guard must not block an unrelated portal');
});

test('isPortalBlocked is true only for a living creature referencing that exact link', () => {
  assert.equal(isPortalBlocked([{ hp: 50, blocksPortalId: 'a' }], 'a'), true);
  assert.equal(isPortalBlocked([{ hp: 0, blocksPortalId: 'a' }], 'a'), false, 'dead guard does not block');
  assert.equal(isPortalBlocked([{ hp: 50, blocksPortalId: 'b' }], 'a'), false, 'wrong link does not block');
  assert.equal(isPortalBlocked([], 'a'), false);
  assert.equal(isPortalBlocked([{ hp: 50, blocksPortalId: null }], 'a'), false);
});

test('a pack blocks until every member is dead', () => {
  const creatures = [
    { id: 'g1', hp: 0, blocksPortalId: 'link-1' },
    { id: 'g2', hp: 30, blocksPortalId: 'link-1' },
  ];
  assert.equal(isPortalBlocked(creatures, 'link-1'), true, 'one survivor still blocks');
  creatures[1].hp = 0;
  assert.equal(isPortalBlocked(creatures, 'link-1'), false, 'the last one dying unblocks it');
});

test('knockbackPosition pushes away from the portal along the approach line', () => {
  const map = { isWalkable: () => true };
  const result = knockbackPosition({ px: 1000, py: 1000, portalX: 1050, portalY: 1050, distance: 60, map });
  // The player approached from the -x,-y direction relative to the portal;
  // knockback continues that same direction, away from the portal.
  assert.ok(result.x < 1000, `expected knockback further in -x, got ${result.x}`);
  assert.ok(result.y < 1000, `expected knockback further in -y, got ${result.y}`);
});

test('knockbackPosition never lands on an unwalkable tile -- falls back to no movement', () => {
  const map = { isWalkable: () => false };
  const result = knockbackPosition({ px: 1000, py: 1000, portalX: 1050, portalY: 1050, distance: 60, map });
  assert.deepStrictEqual(result, { x: 1000, y: 1000 },
    'if the candidate tile is not walkable, do not move the player rather than shove them into a wall');
});

test('knockbackPosition with player and portal at the identical point still returns a finite position', () => {
  const map = { isWalkable: () => true };
  const result = knockbackPosition({ px: 1050, py: 1050, portalX: 1050, portalY: 1050, distance: 60, map });
  assert.ok(Number.isFinite(result.x) && Number.isFinite(result.y),
    'a zero-length approach vector must not produce NaN from a divide-by-zero normalize');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && node --test tests/plan_portal_transition.test.js`
Expected: FAIL — none of these three functions exist yet.

- [ ] **Step 3: Implement the three pure functions**

```js
// backend/src/authority/server.js — add near planTransition/planBind (around line 47)

// Pure: does any LIVE creature reference this exact portal link? A pack
// blocks until its last member dies -- there is no separate "pack cleared"
// flag, it falls straight out of this scan every time it is asked.
function isPortalBlocked(creatures, linkId) {
  for (const c of creatures) {
    if (c.blocksPortalId === linkId && c.hp > 0) return true;
  }
  return false;
}

// Pure: given a player's current tile + this world's portal links, decide
// whether to teleport, block, or do nothing. Mirrors planTransition's
// shape and cooldown convention but keys off tile-coordinate equality
// (portalLinks is keyed "gRow,gCol") rather than edge-doorway membership --
// a portal has no compass edge, it is a specific interior point.
function planPortalTransition({ gRow, gCol, portalLinks, now, cdUntil, creatures }) {
  if (now < cdUntil) return null;
  const link = portalLinks.get(`${gRow},${gCol}`);
  if (!link) return null;
  if (isPortalBlocked(creatures, link.id)) return { blocked: true, linkId: link.id };
  return { toWorldId: link.toWorldId, arriveX: link.toX, arriveY: link.toY };
}

// Pure: the server-authoritative "just set the position" move respawn
// already makes, applied to a blocked-portal bounce instead of a death.
// Pushes the player further along the same line they approached the portal
// on (portal -> player, extended), so it reads as "bounced off the door"
// rather than a random shove. Falls back to leaving the player exactly
// where they are if the candidate tile is not walkable -- never teleports
// someone into a wall.
function knockbackPosition({ px, py, portalX, portalY, distance, map }) {
  let dx = px - portalX;
  let dy = py - portalY;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) { dx = 0; dy = -1; } // degenerate: player exactly on the portal, push north arbitrarily
  else { dx /= len; dy /= len; }
  const candidateX = px + dx * distance;
  const candidateY = py + dy * distance;
  if (!map.isWalkable(candidateX, candidateY)) return { x: px, y: py };
  return { x: candidateX, y: candidateY };
}
```

- [ ] **Step 4: Export the three functions**

```js
// backend/src/authority/server.js — extend the existing module.exports
module.exports = {
  attachAuthority, planTransition, planBind, nearestMerchantVillage, INTERACT_RADIUS,
  planPortalTransition, isPortalBlocked, knockbackPosition,
};
```

- [ ] **Step 5: Run to verify the pure tests pass**

Run: `cd backend && node --test tests/plan_portal_transition.test.js`
Expected: PASS, 11/11.

- [ ] **Step 6: Wire world-load — split compass and portal links, build `portalLinks`**

```js
// backend/src/authority/server.js — around line 253, replace the single links line
const linkRows = await fetchLinks(pool, canonicalId);
const compassRows = linkRows.filter((l) => l.edge !== 'PORTAL');
const portalRows = linkRows.filter((l) => l.edge === 'PORTAL');
const links = new Map(compassRows.map((l) => [l.edge, { toWorldId: l.to_world_id, toWidth: l.to_width, toHeight: l.to_height }]));
// Keyed by the portal's OWN tile, floored to grid cells -- matches how
// planPortalTransition looks players up (gRow/gCol from Math.floor(y|x /
// MAP_TILE_SIZE)), the same granularity planTransition already uses for
// doorway tiles.
const portalLinks = new Map(portalRows.map((l) => [
  `${Math.floor(l.from_y / MAP_TILE_SIZE)},${Math.floor(l.from_x / MAP_TILE_SIZE)}`,
  { id: l.id, toWorldId: l.to_world_id, toX: l.to_x, toY: l.to_y, fromX: l.from_x, fromY: l.from_y },
]));
```

Only `[...links.keys()]` (compass edges) feeds `doorways` a few lines below — leave that line untouched. Portal tiles are ordinary walkable floor, not wall-ring gaps; they must never influence `buildWorldGenConfig`'s doorway placement.

```js
// backend/src/authority/server.js — extend the entry object a few lines further down
const entry = {
  worldId: canonicalId, world: new World(map, itemTypes, defaultWeaponId, row.chunk_size), row, sockets: new Map(),
  tileTypes, creatureTypes, creatureTypeIds, hostileCreatureTypes, creatureGold, goldItemTypeId, links, portalLinks, villages,
  activeChunks: new Set(),
  chunkLoads: new Set(),
  loadedChunks: new Set(),
  claiming: new Set(),
};
```

- [ ] **Step 7: Wire the tick loop — blocking, transition, knockback+message**

```js
// backend/src/authority/server.js — the tick loop, alongside the existing
// compass-link transition block (around line 980-994). Add a sibling block,
// not a branch inside the existing one.
      if (entry.portalLinks && entry.portalLinks.size > 0) {
        const now = Date.now();
        const liveCreatures = entry.world.creatures.all();
        for (const p of entry.world.players.values()) {
          const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
          const gRow = Math.floor(cy / MAP_TILE_SIZE), gCol = Math.floor(cx / MAP_TILE_SIZE);
          const t = planPortalTransition({
            gRow, gCol, portalLinks: entry.portalLinks, now, cdUntil: p._portalCdUntil, creatures: liveCreatures,
          });
          if (!t) continue;
          if (t.blocked) {
            p._portalCdUntil = now + 800; // shorter than the doorway cooldown: a blocked bump should feel snappy, not sticky
            const link = [...entry.portalLinks.values()].find((l) => l.id === t.linkId);
            const pushed = knockbackPosition({
              px: cx, py: cy, portalX: link.fromX, portalY: link.fromY, distance: 60, map: entry.world.map,
            });
            p.x = pushed.x - p.width / 2;
            p.y = pushed.y - p.height / 2;
            const ws = entry.sockets.get(p.userId);
            if (ws) send(ws, { type: 'portalBlocked', message: 'Guards block the way.' });
            continue;
          }
          p._portalCdUntil = now + 1500;
          pendingArrivals.set(p.userId, { worldId: t.toWorldId, x: t.arriveX, y: t.arriveY });
          const ws = entry.sockets.get(p.userId);
          if (ws) send(ws, { type: 'transition', toWorldId: t.toWorldId, arriveX: t.arriveX, arriveY: t.arriveY });
        }
      }
```

`liveCreatures` is computed once per tick outside the per-player loop (matches the existing `all` snapshot pattern already used inside `CreatureSim.tick` for the identical reason: avoid re-materializing the creature list once per player when one snapshot per tick suffices).

- [ ] **Step 8: Write the live-authority integration test**

```js
// backend/tests/portal_blocking_live.test.js
// Same harness shape as progression_death.test.js: a real attachAuthority
// server, a fake pool with a stateful route(), a real WebSocket client.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

const SECRET = 'test-secret-portal-blocking';
function token(u) { return jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' }); }

const openResources = [];
test.afterEach(() => {
  while (openResources.length) {
    const r = openResources.pop();
    try { r.close(); } catch { /* already closed */ }
  }
});

function bootWith(pool, opts = {}) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, pool, {
      jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 10000, ...opts,
    });
    openResources.push({ close() { handle.close(); if (server.listening) server.close(); } });
    server.listen(0, () => resolve({ url: `ws://127.0.0.1:${server.address().port}/authority`, handle, server }));
  });
}
function connect(url, uid) {
  const ws = new WebSocket(`${url}?token=${encodeURIComponent(token(uid))}`);
  openResources.push({ close() { ws.terminate(); } });
  return ws;
}
function nextMsg(ws, type) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout ${type}`)), 3000);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (!type || m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}
function collectMsgs(ws, type, ms) {
  return new Promise((resolve) => {
    const out = [];
    function onMsg(data) { const m = JSON.parse(data); if (m.type === type) out.push(m); }
    ws.on('message', onMsg);
    setTimeout(() => { ws.off('message', onMsg); resolve(out); }, ms);
  });
}

// One world (w1), a single guard at (1050,1050) blocking a portal that
// starts right there too -- so a freshly-joined player standing at spawn
// (1000,1000) can walk one tile east to trigger it.
function fakePortalPool() {
  const GUARD_ID = 'guard-1';
  let guardHp = 50;
  function route(sql, params) {
    if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
    if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
    if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
    if (/FROM world_players WHERE/i.test(sql)) return { rows: [] };
    if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
    if (/FROM player_binds WHERE/i.test(sql)) return { rows: [] };
    if (/FROM item_types/i.test(sql)) {
      return { rows: [
        { id: 1, name: 'dagger', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'melee',
          damage: 8, cooldown: 0.3, reach: 80, arc_width: 6.3, range: null, projectile_speed: null,
          projectile_radius: null, pierce: null, mana_cost: 0, element: null, defense: null, resistances: null },
      ] };
    }
    if (/FROM player_items/i.test(sql)) return { rows: [{ id: 'i1', item_type_id: 1 }] };
    if (/FROM player_equipment/i.test(sql)) return { rows: [] };
    if (/SELECT gold FROM users/i.test(sql)) return { rows: [{ gold: 0 }] };
    if (/^\s*INSERT INTO player_progression/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM player_progression/i.test(sql)) {
      return { rows: [{ user_id: '1', experience: '0', level: 1, stat_points: 0,
        strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5 }] };
    }
    if (/FROM map_links ml JOIN worlds/i.test(sql)) {
      return { rows: [{
        id: 'link-1', edge: 'PORTAL', to_world_id: 'w2', to_width: 20, to_height: 20,
        from_x: 1050, from_y: 1050, to_x: 550, to_y: 550,
      }] };
    }
    if (/FROM villages WHERE/i.test(sql)) return { rows: [] };
    if (/FROM world_creatures wc/i.test(sql)) {
      return { rows: [{
        id: GUARD_ID, type: 'Orc', x: 1050, y: 1050, hp: guardHp, facing: 'S',
        home_x: 1050, home_y: 1050, level: 3, damage: 10, blocks_portal_id: 'link-1',
        defense: 2, color: '#a33', resistances: {}, faction: 'guard',
      }] };
    }
    if (/FROM world_items/i.test(sql)) return { rows: [] };
    return { rows: [] };
  }
  const calls = [];
  const pool = {
    calls, guardId: GUARD_ID,
    killGuard() { guardHp = 0; },
    matching(re) { return calls.filter((c) => re.test(c.sql)); },
    query: async (sql, params) => { calls.push({ sql, params }); return route(sql, params); },
  };
  pool.clients = [];
  pool.connect = async () => {
    const clientCalls = [];
    const client = {
      calls: clientCalls, released: 0,
      query: async (sql, params) => { clientCalls.push({ sql, params }); return route(sql, params); },
      release() { client.released += 1; },
    };
    pool.clients.push(client);
    return client;
  };
  return pool;
}

test('a guard-blocked portal refuses transfer and knocks the player back', async () => {
  const pool = fakePortalPool();
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  const joined = await nextMsg(ws, 'joined');
  assert.ok(joined.spawn, 'joined message must include a spawn point to walk from');

  // Walk the player directly onto the portal tile (1050,1050) via a raw
  // world-state mutation -- movement input itself is covered elsewhere;
  // this test is about what happens once a player IS on the tile.
  const world = handle.worlds.get('w1').world;
  const p = world.getPlayer('1');
  p.x = 1050 - p.width / 2; p.y = 1050 - p.height / 2;

  const blocked = await nextMsg(ws, 'portalBlocked');
  assert.equal(blocked.message, 'Guards block the way.');

  await new Promise((r) => setTimeout(r, 60)); // let the same tick's knockback land
  assert.ok(Math.abs((p.x + p.width / 2) - 1050) > 1 || Math.abs((p.y + p.height / 2) - 1050) > 1,
    'the player must have been pushed off the exact portal tile');

  const transitions = await collectMsgs(ws, 'transition', 150);
  assert.deepStrictEqual(transitions, [], 'a blocked portal must never send a transition message');

  ws.close(); handle.close(); server.close();
});

test('killing the guard unblocks the portal on the very next approach', async () => {
  const pool = fakePortalPool();
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  pool.killGuard();
  // Force a chunk reload isn't necessary: the guard's hp lives on the
  // in-memory creature object once loaded, so killing it here means the
  // NEXT world load would see hp 0 -- for this same live session, kill the
  // in-memory creature directly, mirroring how progression_death.test.js's
  // `kill()` helper kills a live player by mutating hp in place.
  const world = handle.worlds.get('w1').world;
  const guard = world.creatures.creatures.get(pool.guardId);
  if (guard) guard.hp = 0;

  const p = world.getPlayer('1');
  p.x = 1050 - p.width / 2; p.y = 1050 - p.height / 2;

  const t = await nextMsg(ws, 'transition');
  assert.deepStrictEqual(
    { toWorldId: t.toWorldId, arriveX: t.arriveX, arriveY: t.arriveY },
    { toWorldId: 'w2', arriveX: 550, arriveY: 550 });

  ws.close(); handle.close(); server.close();
});
```

- [ ] **Step 9: Run to verify both new test files pass**

Run: `cd backend && node --test tests/plan_portal_transition.test.js tests/portal_blocking_live.test.js`
Expected: PASS, all subtests. If the live test's fake pool routing doesn't match the real query shapes exactly (this is the single likeliest source of friction in this task — the routing regexes must match the actual SQL this codebase's join/chunk-activation code emits), adjust the regex patterns to match, not the production code.

- [ ] **Step 10: Mutation checks**

1. Comment out the `isPortalBlocked` check inside `planPortalTransition` (always fall through to the transition branch) — confirm `portal_blocking_live.test.js`'s first test goes red (a transition would be sent despite the guard being alive), then restore.
2. Change `knockbackPosition`'s walkability check to always return the candidate regardless of `map.isWalkable` — confirm the "never lands on an unwalkable tile" pure test goes red, then restore.
3. Change the tick loop's portal block to reuse `entry.links` instead of `entry.portalLinks` — confirm the full backend suite still passes (this is the check that the two maps are genuinely independent: nothing should accidentally work if they were swapped, and if the suite passes anyway that's a sign the portal block was never exercised — treat that as a real finding, not a pass, and re-examine Step 8's fixture) — then restore.

- [ ] **Step 11: Run the full backend suite**

Run: `cd backend && npm test`
Expected: no regressions.

- [ ] **Step 12: Commit**

```bash
git add backend/src/authority/server.js backend/tests/plan_portal_transition.test.js backend/tests/portal_blocking_live.test.js
git commit -m "feat(dungeons): gate portal transfer on guard liveness, add knockback (SOMET-243)"
```

---

### Task 9: World Map — surface portal columns and render off-grid clusters

**Files:**
- Modify: `backend/src/index.js:1657-1671`
- Modify: `frontend/src/games/something2/mapGraphLayout.js`
- Test: `frontend/src/games/something2/__tests__/mapGraphLayoutPortals.test.js`

**Interfaces:**
- Consumes: `map_links` coordinate columns (Task 1).
- Produces: `GET /api/world-graph`'s `links` rows gain `from_x, from_y, to_x, to_y`. `seedPositions(worlds, links, opts)` (signature unchanged) now places portal-only worlds as a small vertical cluster near their entrance rather than as an arbitrary disconnected root.

- [ ] **Step 1: Extend the backend route (small, no test needed beyond the existing route test if one exists — check for `world_graph` in `backend/tests/`)**

```js
// backend/src/index.js:1657-1671
app.get('/api/world-graph', async (req, res) => {
  try {
    const [worldsRes, linksRes] = await Promise.all([
      pool.query(
        `SELECT id, name, width, height, is_entry, biomes, graph_x, graph_y
           FROM worlds ORDER BY created_at DESC`),
      pool.query(
        `SELECT from_world_id, edge, to_world_id, from_x, from_y, to_x, to_y
           FROM map_links ORDER BY from_world_id, edge`),
    ]);
    res.json({ worlds: worldsRes.rows, links: linksRes.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load world graph' });
  }
});
```

- [ ] **Step 2: Confirm the existing route test needs no change**

`backend/tests/worldGraphRoute.test.js` mocks the pool and asserts `res.body.links` via `deepEqual` against whatever the fake pool returns (`poolFor`'s `LINKS` fixture) — it never inspects the real SELECT's column list, so widening the query in Step 1 does not require touching this file. Run it once to confirm:

```bash
cd backend && node --test tests/worldGraphRoute.test.js
```

Expected: PASS, unchanged.

- [ ] **Step 3: Write the failing frontend layout test**

```js
// frontend/src/games/something2/__tests__/mapGraphLayoutPortals.test.js
import { describe, it, expect } from 'vitest';
import { seedPositions } from '../mapGraphLayout.js';

describe('portal-linked worlds get an off-grid cluster near their entrance', () => {
  it('places a single dungeon level directly below its entrance world', () => {
    const worlds = [
      { id: 'surface', graph_x: 0, graph_y: 0, is_entry: true },
      { id: 'dungeon-1', graph_x: null, graph_y: null, is_entry: false },
    ];
    const links = [
      { from_world_id: 'surface', edge: 'PORTAL', to_world_id: 'dungeon-1' },
    ];
    const positions = seedPositions(worlds, links);
    expect(positions.surface).toEqual({ x: 0, y: 0 });
    expect(positions['dungeon-1'].x).toBeCloseTo(0, 5);
    expect(positions['dungeon-1'].y).toBeGreaterThan(0);
  });

  it('a chain of dungeon levels stacks further down at each hop', () => {
    const worlds = [
      { id: 'surface', graph_x: 0, graph_y: 0, is_entry: true },
      { id: 'dungeon-1', graph_x: null, graph_y: null, is_entry: false },
      { id: 'dungeon-2', graph_x: null, graph_y: null, is_entry: false },
    ];
    const links = [
      { from_world_id: 'surface', edge: 'PORTAL', to_world_id: 'dungeon-1' },
      { from_world_id: 'dungeon-1', edge: 'PORTAL', to_world_id: 'dungeon-2' },
    ];
    const positions = seedPositions(worlds, links);
    expect(positions['dungeon-2'].y).toBeGreaterThan(positions['dungeon-1'].y);
  });

  it('branching levels spread horizontally instead of colliding', () => {
    const worlds = [
      { id: 'surface', graph_x: 0, graph_y: 0, is_entry: true },
      { id: 'dungeon-1a', graph_x: null, graph_y: null, is_entry: false },
      { id: 'dungeon-1b', graph_x: null, graph_y: null, is_entry: false },
    ];
    const links = [
      { from_world_id: 'surface', edge: 'PORTAL', to_world_id: 'dungeon-1a' },
      { from_world_id: 'surface', edge: 'PORTAL', to_world_id: 'dungeon-1b' },
    ];
    const positions = seedPositions(worlds, links);
    expect(positions['dungeon-1a'].x).not.toEqual(positions['dungeon-1b'].x);
    expect(positions['dungeon-1a'].y).toEqual(positions['dungeon-1b'].y);
  });

  it('a dungeon cluster never lands on a cell an existing compass-grid world already occupies', () => {
    const worlds = [
      { id: 'surface', graph_x: 0, graph_y: 0, is_entry: true },
      { id: 'south', graph_x: 0, graph_y: 220, is_entry: false }, // directly below surface already
      { id: 'dungeon-1', graph_x: null, graph_y: null, is_entry: false },
    ];
    const links = [
      { from_world_id: 'surface', edge: 'S', to_world_id: 'south' },
      { from_world_id: 'surface', edge: 'PORTAL', to_world_id: 'dungeon-1' },
    ];
    const positions = seedPositions(worlds, links);
    const southKey = `${Math.round(positions.south.x / 220)},${Math.round(positions.south.y / 220)}`;
    const dungeonKey = `${Math.round(positions['dungeon-1'].x / 220)},${Math.round(positions['dungeon-1'].y / 220)}`;
    expect(dungeonKey).not.toEqual(southKey);
  });

  it('a spec with no portals at all lays out exactly as before (no regression)', () => {
    const worlds = [
      { id: 'surface', graph_x: 0, graph_y: 0, is_entry: true },
      { id: 'east', graph_x: null, graph_y: null, is_entry: false },
    ];
    const links = [{ from_world_id: 'surface', edge: 'E', to_world_id: 'east' }];
    const positions = seedPositions(worlds, links);
    expect(positions.east).toEqual({ x: 220, y: 0 });
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/mapGraphLayoutPortals.test.js`
Expected: FAIL — portal-only worlds currently fall through to the generic disconnected-root placement (list order, own fresh row), which does not guarantee "directly below the entrance" or "stacks deeper per hop."

- [ ] **Step 5: Implement — a portal-cluster pass inserted between the anchored walk and the disconnected-root loop**

```js
// frontend/src/games/something2/mapGraphLayout.js — full replacement

export const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };
const STEP = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };

export function compassFromDelta(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'E' : 'W';
  return dy >= 0 ? 'S' : 'N';
}

// Places every dungeon reachable via PORTAL links from any world that
// already has a cell, one row deeper per hop, siblings spread across
// columns so branches never collide. Runs AFTER the compass walk (so
// entrance worlds already have their real positions) and BEFORE the
// disconnected-root loop (so a dungeon is never mistaken for an unrelated
// orphan cluster and dumped in list order far from its actual entrance).
// Mutates cellOf/taken in place, matching the imperative style the rest of
// this file already uses for the same reason (one shared occupancy set).
function placePortalClusters(cellOf, taken, portalAdjacency) {
  // Every world that already has a position AND has outgoing portals is a
  // potential cluster root -- iterate a snapshot since cellOf grows as we go.
  const roots = [...cellOf.keys()].filter((id) => portalAdjacency.has(id));
  for (const rootId of roots) {
    const queue = [rootId];
    while (queue.length) {
      const id = queue.shift();
      const [col, row] = cellOf.get(id);
      const children = portalAdjacency.get(id) || [];
      let col0 = col - Math.floor((children.length - 1) / 2);
      for (const childId of children) {
        if (cellOf.has(childId)) continue;
        let c = col0;
        while (taken.has(`${c},${row + 1}`)) c += 1;
        cellOf.set(childId, [c, row + 1]);
        taken.add(`${c},${row + 1}`);
        queue.push(childId);
        col0 = c + 1;
      }
    }
  }
}

export function seedPositions(worlds, links, { cell = 220 } = {}) {
  const list = Array.isArray(worlds) ? worlds : [];
  const out = {};
  const stored = new Set();
  const taken = new Set();
  const cellOf = new Map();
  for (const w of list) {
    if (Number.isFinite(w.graph_x) && Number.isFinite(w.graph_y)) {
      out[w.id] = { x: w.graph_x, y: w.graph_y };
      stored.add(w.id);
      const col = Math.round(w.graph_x / cell);
      const row = Math.round(w.graph_y / cell);
      taken.add(`${col},${row}`);
      cellOf.set(w.id, [col, row]);
    }
  }

  const known = new Set(list.map((w) => w.id));
  const adjacency = new Map();
  const portalAdjacency = new Map();
  for (const l of Array.isArray(links) ? links : []) {
    if (!known.has(l.from_world_id) || !known.has(l.to_world_id)) continue;
    if (l.edge === 'PORTAL') {
      if (!portalAdjacency.has(l.from_world_id)) portalAdjacency.set(l.from_world_id, []);
      portalAdjacency.get(l.from_world_id).push(l.to_world_id);
      continue;
    }
    if (!STEP[l.edge]) continue;
    if (!adjacency.has(l.from_world_id)) adjacency.set(l.from_world_id, []);
    adjacency.get(l.from_world_id).push(l);
  }

  const queue = [...cellOf.keys()];
  const walk = () => {
    while (queue.length > 0) {
      const id = queue.shift();
      const [col, row] = cellOf.get(id);
      for (const l of adjacency.get(id) || []) {
        const target = l.to_world_id;
        if (cellOf.has(target)) continue;
        const [dc, dr] = STEP[l.edge];
        const key = `${col + dc},${row + dr}`;
        if (taken.has(key)) continue;
        cellOf.set(target, [col + dc, row + dr]);
        taken.add(key);
        queue.push(target);
      }
    }
  };
  walk();

  placePortalClusters(cellOf, taken, portalAdjacency);

  const deepestRow = () => {
    let deepest = -Infinity;
    for (const [, [, row]] of cellOf) deepest = Math.max(deepest, row);
    return deepest;
  };
  const roots = [...list].sort((a, b) => (b.is_entry ? 1 : 0) - (a.is_entry ? 1 : 0));
  let nextRow = cellOf.size > 0 ? deepestRow() + 2 : 0;
  for (const w of roots) {
    if (cellOf.has(w.id)) continue;
    let col = 0;
    while (taken.has(`${col},${nextRow}`)) col += 1;
    cellOf.set(w.id, [col, nextRow]);
    taken.add(`${col},${nextRow}`);
    queue.push(w.id);
    walk();
    placePortalClusters(cellOf, taken, portalAdjacency);
    const deepest = deepestRow();
    if (deepest >= nextRow + 1) nextRow = deepest + 2;
  }

  for (const [id, [col, row]] of cellOf) {
    if (stored.has(id)) continue;
    out[id] = { x: col * cell, y: row * cell };
  }
  return out;
}
```

Note: `placePortalClusters` is called again inside the disconnected-roots loop (after each fresh root's own compass `walk()`), so a dungeon hanging off a compass-disconnected cluster's entrance still gets placed relative to that cluster, not swept into a third, unrelated pass.

- [ ] **Step 6: Run to verify it passes**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/mapGraphLayoutPortals.test.js`
Expected: PASS, 5/5.

- [ ] **Step 7: Run the existing mapGraphLayout tests to confirm no regression**

Run: `cd frontend && npx vitest run` (full suite — `seedPositions` is exercised by `MapGraphAdmin`-adjacent tests too)
Expected: no new failures.

- [ ] **Step 8: Browser verification**

This is a UI surface. Start the dev stack (`make dev`, per this project's existing convention), open the World Map tab, and confirm: an entrance world with a portal-linked dungeon renders the dungeon level(s) visually clustered below it, not scattered to an arbitrary far corner. If no dungeon spec exists yet to verify against live data, this step can use a temporary spec applied via `applyMapSpec` in a throwaway script against the dev database (never `make seed-map`/`make reseed-map` against shared seed files) and reverted afterward, or can be deferred to the first real dungeon spec's own verification — record which in the completion evidence, do not silently skip it.

- [ ] **Step 9: Commit**

```bash
git add backend/src/index.js frontend/src/games/something2/mapGraphLayout.js frontend/src/games/something2/__tests__/mapGraphLayoutPortals.test.js
git commit -m "feat(dungeons): render portal-linked worlds as off-grid clusters on the World Map (SOMET-243)"
```

---

## Self-Review Notes (for the plan author, not a task)

**Spec coverage:** every spec section maps to a task — data model → Tasks 1-2; authoring/spec-format → Task 4; guarding → Task 5; blocking/knockback → Task 8; World Map → Task 9; seed-apply wiring (implied by "hand-authored" but not explicitly a spec section) → Task 6; creature-loading plumbing (implied by the blocking mechanism, not separately called out in the spec) → Task 7.

**Placeholder scan:** none found — every step carries real code or a real shell command.

**Type/name consistency checked across tasks:** `setPortalLink`/`clearPortalLink` (Task 3) signatures match their Task 6 call sites exactly. `insertPortalGuards`'s parameter order (Task 5) matches its Task 6 call site. `blocksPortalId` (camelCase, in-memory, Task 7) vs `blocks_portal_id` (snake_case, DB column, Tasks 2/5/6) is deliberate and consistent with this codebase's existing `home_x`/`home` split. `planPortalTransition`'s three-shape return (`null` / `{blocked, linkId}` / `{toWorldId,arriveX,arriveY}`) is used identically in its Task 8 pure tests and its Task 8 tick-loop call site. `portalLinks` (Map, Task 8's world-load wiring) vs `portalAdjacency` (Map, Task 9's frontend layout) are two different data structures in two different languages/files — named similarly because they play the same conceptual role, not because they share code.

**A gap found and fixed during this review, not left for the implementer to discover:** Task 6's first draft of the guard-insertion loop had no idempotency guard, which would have silently duplicated a portal's guard pack on every `make seed-map` re-apply of an unchanged spec — the exact same failure mode `createVillage`'s own call-site guard exists to prevent. Fixed inline as Step 3b rather than left as a Task 8 review finding.
