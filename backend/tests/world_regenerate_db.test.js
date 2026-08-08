// Real-HTTP, real-DB regression tests for POST /api/worlds/:id/regenerate
// (SOMET-252). Bootstrap modeled on creature_behaviors_api_db.test.js: a real
// pg Pool swapped into the app via __setPool, a disposable admin user created
// per test and dropped in a `finally`, gated on TEST_DATABASE_URL alone so a
// bare `npm test` on a machine with a working dev database never reaches
// here.
//
// Before this fix, the route issued its own unconditional
// `DELETE FROM world_creatures WHERE world_id = $1`, wiping village guards
// AND portal guards, then only ever re-inserted village guards -- so a
// regenerated world lost its portal guards for good (silently unblocking a
// guarded dungeon entrance, SOMET-243) and came back with zero hostile
// creatures even though populateWorld (SOMET-246) means a freshly seeded
// world is never actually empty. Both regressions are covered below against
// a real database rather than a mocked pool, because the bug was specifically
// in which rows a real DELETE spared.
//
// SAFETY: every fixture row this file creates is a `zzRegen`-prefixed world,
// torn down BY NAME, unconditionally, in a `finally`. Deleting the world row
// cascades to world_creatures, villages, and map_links (all
// `references: 'worlds', onDelete: 'CASCADE'`), so nothing else needs
// separate cleanup.

require('./helpers/auth.js'); // sets JWT_SECRET before any token is signed
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Pool } = require('pg');

const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://user:password@localhost:15432/game_db';

const FIXTURES = ['zzRegenPortal'];

let dbPool = null;

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return; // no DB configured -- every test below self-skips
  const p = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try {
    await p.query('SELECT 1');
    dbPool = p;
    __setPool(p);
  } catch (err) {
    await p.end().catch(() => {});
  }
});

after(async () => {
  if (dbPool) await dbPool.end().catch(() => {});
});

function skipMsg(what) {
  return `NO DATABASE at ${DB_URL} -- ${what} is UNVERIFIED on this run`;
}

function dbReady(t, what) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${what})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  if (!dbPool) {
    const m = skipMsg(what);
    if (process.env.CI) assert.fail(m);
    t.skip(m);
    return false;
  }
  return true;
}

async function cleanup(pool) {
  await pool.query('DELETE FROM worlds WHERE name = ANY($1::text[])', [FIXTURES]);
}

async function createTestAdmin(pool, tag) {
  const username = `world-regen-test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id, token_version`,
    [username],
  );
  return r.rows[0];
}

async function dropUser(pool, userId) {
  if (userId != null) await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
}

function authHeaderFor(user) {
  const token = signToken({
    userId: user.id, username: `admin-${user.id}`, role: 'admin', tokenVersion: user.token_version,
  });
  return { Authorization: `Bearer ${token}` };
}

// Only creature types that EXIST in the dev catalog (same fixture shape as
// world_population_db.test.js) -- an invented name would make the
// "world holds creatures afterwards" assertion vacuously true or false for
// the wrong reason.
const ALLOWED = ['Skeleton', 'Bat'];

async function makeWorld(pool, name) {
  const r = await pool.query(
    `INSERT INTO worlds (name, seed, chunk_size, width, height, density,
                         allowed_creature_types, biomes, biome_cell, level_min, level_max)
     VALUES ($1, 4242, 32, 64, 64, 'horde', $2::jsonb, $3::jsonb, 16, 3, 5)
     RETURNING *`,
    [name, JSON.stringify(ALLOWED), JSON.stringify(['Deep Forest'])],
  );
  return r.rows[0];
}

test('POST /api/worlds/:id/regenerate spares a portal guard and repopulates the world (SOMET-252)', async (t) => {
  if (!dbReady(t, 'regenerate must spare guards and repopulate')) return;
  const pool = dbPool;
  let adminUser = null;
  try {
    await cleanup(pool);
    const world = await makeWorld(pool, 'zzRegenPortal');

    // A portal guard: an ordinary hostile entity_types row ('Wolf') marked
    // structural only by blocks_portal_id, exactly like
    // world_population_db.test.js's "a portal guard survives a repopulate"
    // fixture. It guards a real map_links PORTAL row so blocks_portal_id
    // references something real.
    const link = await pool.query(
      `INSERT INTO map_links (from_world_id, edge, to_world_id, from_x, from_y, to_x, to_y)
       VALUES ($1, 'PORTAL', $1, 100, 100, 200, 200) RETURNING id`,
      [world.id],
    );
    const portalLinkId = link.rows[0].id;
    await pool.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y, blocks_portal_id)
       VALUES ($1, 'Wolf', 100, 100, 12, 'S', 100, 100, $2)`,
      [world.id, portalLinkId],
    );

    adminUser = await createTestAdmin(pool, 'portal');
    const res = await request(app)
      .post(`/api/worlds/${world.id}/regenerate`)
      .set(authHeaderFor(adminUser))
      .send({});
    assert.equal(res.status, 200, `regenerate failed: ${JSON.stringify(res.body)}`);

    // 1) The portal guard survives -- the old unconditional delete wiped it.
    const guard = await pool.query(
      `SELECT count(*)::int AS n FROM world_creatures
       WHERE world_id = $1 AND blocks_portal_id = $2`,
      [world.id, portalLinkId],
    );
    assert.equal(guard.rows[0].n, 1, 'the portal guard was deleted by regenerate');

    // 2) The world ends up populated per its density tier -- not just the
    // portal guard sitting alone in an otherwise-empty world. horde on 64x64
    // scatters 49 (world_population_db.test.js), so assert a real hostile
    // presence rather than "any row at all", which the surviving portal
    // guard alone would already satisfy.
    const hostiles = await pool.query(
      `SELECT count(*)::int AS n FROM world_creatures
       WHERE world_id = $1 AND type <> 'Village Guard' AND blocks_portal_id IS NULL`,
      [world.id],
    );
    assert.ok(hostiles.rows[0].n > 0,
      `regenerate left the world with no wild creatures (found ${hostiles.rows[0].n}) -- ` +
      'it must repopulate, not just preserve guards');

    // Sanity: the seed actually changed (terrain was regenerated).
    assert.notEqual(String(res.body.seed), '4242', 'regenerate must reseed the terrain');
  } finally {
    await dropUser(pool, adminUser?.id);
    await cleanup(pool);
  }
});
