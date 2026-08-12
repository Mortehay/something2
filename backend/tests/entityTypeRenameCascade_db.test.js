// SOMET-228: real-HTTP, real-DB, real-schema proof that PUT
// /api/entity-types/:id cascades a rename into worlds.allowed_creature_types,
// world_creatures.type and biomes.flora_types/creature_types instead of
// refusing it (SOMET-185's old 409). entityTypes.test.js and
// entityTypeRenameCascadeAtomicity.test.js already cover the route's SQL
// shape and transaction atomicity with in-memory mocks; this file is the
// end-to-end check against the ACTUAL table schemas (real NOT NULL/jsonb
// column types, real defaults), not a hand-rolled mock of them. Bootstrap
// modeled on tests/creature_behaviors_api_db.test.js, gated on
// TEST_DATABASE_URL alone so a bare `npm test` never reaches here.
//
// SAFETY: every fixture row is `zz`-prefixed and torn down BY NAME,
// unconditionally, in a `finally`. Entity-type fixtures use is_creature =
// false so they stay invisible to other test files' catalog-wide invariants.
require('./helpers/auth.js'); // sets JWT_SECRET before any token is signed
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Pool } = require('pg');

const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://user:password@localhost:15432/game_db';

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

function dbReady(t, what) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${what})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  if (!dbPool) {
    const m = `NO DATABASE at ${DB_URL} -- ${what} is UNVERIFIED on this run`;
    if (process.env.CI) assert.fail(m);
    t.skip(m);
    return false;
  }
  return true;
}

async function createTestAdmin(pool, tag) {
  const username = `entity-type-rename-cascade-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id, token_version`,
    [username],
  );
  return r.rows[0];
}

function authHeaderFor(user) {
  const token = signToken({
    userId: user.id, username: `admin-${user.id}`, role: 'admin', tokenVersion: user.token_version,
  });
  return { Authorization: `Bearer ${token}` };
}

test('a rename referenced in worlds, world_creatures AND biomes cascades correctly end-to-end (real schema)', async (t) => {
  if (!dbReady(t, 'entity-type rename cascade')) return;

  const OLD = 'zzCascadeBeastOld';
  const NEW = 'zzCascadeBeastNew';
  const UNRELATED = 'zzCascadeUnrelatedGoblin';
  let admin = null;
  let entityTypeId = null;
  let worldId = null;
  let creatureId = null;
  let biomeId = null;

  try {
    admin = await createTestAdmin(dbPool, 'a');

    const entityRes = await dbPool.query(
      `INSERT INTO entity_types (name, color, is_creature) VALUES ($1, '#fff', true) RETURNING id`,
      [OLD],
    );
    entityTypeId = entityRes.rows[0].id;

    // worlds row whose allowed_creature_types has OLD plus an UNRELATED name
    // -- the cascade must rewrite only the matching element.
    const worldRes = await dbPool.query(
      `INSERT INTO worlds (name, seed, allowed_creature_types) VALUES ($1, 1, $2::jsonb) RETURNING id`,
      [`zz-cascade-world-${Date.now()}`, JSON.stringify([OLD, UNRELATED])],
    );
    worldId = worldRes.rows[0].id;

    // A placed creature of type OLD on that world.
    const creatureRes = await dbPool.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing) VALUES ($1, $2, 5, 5, 10, 'down') RETURNING id`,
      [worldId, OLD],
    );
    creatureId = creatureRes.rows[0].id;

    // A biome referencing OLD in flora_types, with an unrelated creature_types
    // entry that must survive untouched.
    const biomeRes = await dbPool.query(
      `INSERT INTO biomes (name, flora_types, creature_types) VALUES ($1, $2::jsonb, $3::jsonb) RETURNING id`,
      [`zz-cascade-biome-${Date.now()}`, JSON.stringify([OLD]), JSON.stringify(['zzCascadeSlime'])],
    );
    biomeId = biomeRes.rows[0].id;

    const res = await request(app)
      .put(`/api/entity-types/${entityTypeId}`)
      .set(authHeaderFor(admin))
      .send({ name: NEW, color: '#fff', is_creature: true, walkable: false, spawn_tiles: [], chance: 0.1 });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.name, NEW);
    assert.deepEqual(res.body.renamedReferences, { worlds: 1, biomes: 1, hadPlacedCreatures: true });

    const worldRow = (await dbPool.query('SELECT allowed_creature_types FROM worlds WHERE id = $1', [worldId])).rows[0];
    assert.deepEqual(worldRow.allowed_creature_types, [NEW, UNRELATED], 'the matching element renamed, the unrelated one untouched, order preserved');

    const creatureRow = (await dbPool.query('SELECT type FROM world_creatures WHERE id = $1', [creatureId])).rows[0];
    assert.equal(creatureRow.type, NEW);

    const biomeRow = (await dbPool.query('SELECT flora_types, creature_types FROM biomes WHERE id = $1', [biomeId])).rows[0];
    assert.deepEqual(biomeRow.flora_types, [NEW]);
    assert.deepEqual(biomeRow.creature_types, ['zzCascadeSlime'], 'the unrelated creature_types array on the same row must be untouched, not collapsed to null');

    const entityRow = (await dbPool.query('SELECT name FROM entity_types WHERE id = $1', [entityTypeId])).rows[0];
    assert.equal(entityRow.name, NEW);
  } finally {
    if (creatureId != null) await dbPool.query('DELETE FROM world_creatures WHERE id = $1', [creatureId]).catch(() => {});
    if (worldId != null) await dbPool.query('DELETE FROM worlds WHERE id = $1', [worldId]).catch(() => {});
    if (biomeId != null) await dbPool.query('DELETE FROM biomes WHERE id = $1', [biomeId]).catch(() => {});
    if (entityTypeId != null) await dbPool.query('DELETE FROM entity_types WHERE id = $1', [entityTypeId]).catch(() => {});
    if (admin) await dbPool.query('DELETE FROM users WHERE id = $1', [admin.id]).catch(() => {});
  }
});
