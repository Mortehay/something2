// Real-HTTP, real-DB tests for /api/creature-behaviors and the
// behavior_id/attack_element fields on /api/entity-types. Bootstrap modeled
// on tests/progression_routes.test.js: a real pg Pool swapped into the app
// via __setPool, a disposable admin user created per test and dropped in a
// `finally`, gated on TEST_DATABASE_URL alone so a bare `npm test` on a
// machine with a working dev database never reaches here.
//
// SAFETY: every fixture row this file creates is a `zz`-prefixed
// creature_behaviors/entity_types row, torn down BY NAME, unconditionally,
// in a `finally`. This file never asserts a rejection against a REAL catalog
// row (e.g. 'Line') -- Task 3 destroyed the real Line row doing exactly that
// before the FK/CHECK that would have protected it existed. Entity-type
// fixtures are created with is_creature = false so they stay invisible to
// other test files' catalog-wide creature invariants while they briefly
// exist.

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

function skipMsg(what) {
  return `NO DATABASE at ${DB_URL} -- ${what} is UNVERIFIED on this run`;
}

// True only once both TEST_DATABASE_URL is set AND the connection actually
// opened -- same idiom as progression_routes.test.js's dbReady.
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

async function createTestAdmin(pool, tag) {
  const username = `creature-behaviors-api-test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

const FIXTURE_BODY = {
  name: 'zzApiBehaviorProfile',
  attack_kind: 'melee',
  attack_range: 55,
  attack_cooldown: 1.2,
  aggro_radius: 300,
  leash_radius: 500,
  chase_style: 'charge',
};

async function deleteBehaviorByName(pool, name) {
  await pool.query('DELETE FROM creature_behaviors WHERE name = $1', [name]).catch(() => {});
}

async function deleteEntityTypeByName(pool, name) {
  await pool.query('DELETE FROM entity_types WHERE name = $1', [name]).catch(() => {});
}

test('GET /api/creature-behaviors returns the seeded profiles, Line among them', async (t) => {
  if (!dbReady(t, 'reads the live creature_behaviors catalog')) return;

  const res = await request(app).get('/api/creature-behaviors');

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  // At least the twelve migration-seeded profiles -- "at least" (not
  // "exactly") because other DB test files transiently insert/delete their
  // own zz-prefixed rows and node:test may run files concurrently.
  assert.ok(res.body.length >= 12, `expected at least 12 profiles, got ${res.body.length}`);
  const line = res.body.find((b) => b.name === 'Line');
  assert.ok(line, 'Line must be among the seeded profiles');
  assert.equal(line.attack_kind, 'melee');
  assert.equal(Number(line.attack_range), 60);
  assert.equal(line.chase_style, 'charge');
});

test('POST /api/creature-behaviors rejects an unknown chase_style with 400, not a 500', async (t) => {
  if (!dbReady(t, 'posts an invalid chase_style and confirms it is caught before the CHECK constraint')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'post-badstyle');

    const res = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiBadStyle',
      chase_style: 'teleport',
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /chase_style/);

    const row = await dbPool.query('SELECT 1 FROM creature_behaviors WHERE name = $1', ['zzApiBadStyle']);
    assert.equal(row.rowCount, 0, 'a rejected POST must not create a row');
  } finally {
    await deleteBehaviorByName(dbPool, 'zzApiBadStyle');
    await dropUser(dbPool, admin && admin.id);
  }
});

test('POST /api/creature-behaviors rejects ranged/cast with a non-positive projectile_speed', async (t) => {
  if (!dbReady(t, 'posts a ranged profile with projectile_speed 0 and confirms the carried validation catches it')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'post-badprojectile');

    const res = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiBadProjectile',
      attack_kind: 'ranged',
      chase_style: 'kite',
      projectile_speed: 0,
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /projectile_speed/);

    const row = await dbPool.query('SELECT 1 FROM creature_behaviors WHERE name = $1', ['zzApiBadProjectile']);
    assert.equal(row.rowCount, 0, 'a rejected POST must not create a row');
  } finally {
    await deleteBehaviorByName(dbPool, 'zzApiBadProjectile');
    await dropUser(dbPool, admin && admin.id);
  }
});

test('POST /api/creature-behaviors rejects a non-melee guard', async (t) => {
  if (!dbReady(t, 'posts a guard/ranged combo and confirms the carried validation catches it')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'post-badguard');

    const res = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiBadGuard',
      attack_kind: 'ranged',
      chase_style: 'guard',
      projectile_speed: 400,
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /guard/);

    const row = await dbPool.query('SELECT 1 FROM creature_behaviors WHERE name = $1', ['zzApiBadGuard']);
    assert.equal(row.rowCount, 0, 'a rejected POST must not create a row');
  } finally {
    await deleteBehaviorByName(dbPool, 'zzApiBadGuard');
    await dropUser(dbPool, admin && admin.id);
  }
});

test('PUT /api/creature-behaviors/:id updates a profile\'s numbers', async (t) => {
  if (!dbReady(t, 'creates a zz fixture profile and PUTs new numbers onto it')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'put-updates');

    const created = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiPutTarget',
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    const res = await request(app).put(`/api/creature-behaviors/${id}`).set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiPutTarget',
      attack_range: 77,
      attack_cooldown: 2.5,
      aggro_radius: 333,
      leash_radius: 666,
      chase_style: 'kite',
      damage_override: 0, // real value, meaning "hits for nothing" -- must survive
    });

    assert.equal(res.status, 200);
    assert.equal(Number(res.body.attack_range), 77);
    assert.equal(Number(res.body.attack_cooldown), 2.5);
    assert.equal(Number(res.body.aggro_radius), 333);
    assert.equal(Number(res.body.leash_radius), 666);
    assert.equal(res.body.chase_style, 'kite');
    assert.equal(Number(res.body.damage_override), 0, 'damage_override 0 must survive, not fall back to null');

    const row = await dbPool.query('SELECT * FROM creature_behaviors WHERE id = $1', [id]);
    assert.equal(Number(row.rows[0].attack_range), 77, 'the row in the database must reflect the update');
    assert.equal(Number(row.rows[0].damage_override), 0);
  } finally {
    await deleteBehaviorByName(dbPool, 'zzApiPutTarget');
    await dropUser(dbPool, admin && admin.id);
  }
});

test('DELETE of a profile referenced by an entity type returns 409, names the referencing type, and leaves the row in place', async (t) => {
  if (!dbReady(t, 'builds its own zz profile + zz entity-type fixture pair and attempts to delete the referenced profile')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'delete-referenced');

    const created = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiInUseProfile',
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    // is_creature = false: the FK does not care, and false keeps this
    // fixture invisible to other test files' creature-only catalog
    // invariants while it briefly exists.
    await dbPool.query(
      `INSERT INTO entity_types (name, color, is_creature, behavior_id)
       VALUES ('zzApiInUseCreature', '#fff', false, $1)`,
      [id],
    );

    const res = await request(app).delete(`/api/creature-behaviors/${id}`).set(authHeaderFor(admin));

    assert.equal(res.status, 409);
    assert.ok(Array.isArray(res.body.referencing_entity_types));
    assert.ok(
      res.body.referencing_entity_types.some((e) => e.name === 'zzApiInUseCreature'),
      'the 409 body must name the referencing entity type',
    );

    const row = await dbPool.query('SELECT id FROM creature_behaviors WHERE id = $1', [id]);
    assert.equal(row.rowCount, 1, 'the row must still be present after a refused delete');
  } finally {
    // Entity type first (it holds the FK), then the profile. Both by name,
    // unconditionally.
    await deleteEntityTypeByName(dbPool, 'zzApiInUseCreature');
    await deleteBehaviorByName(dbPool, 'zzApiInUseProfile');
    await dropUser(dbPool, admin && admin.id);
  }
});

test('DELETE of an unreferenced profile returns 204 and removes the row', async (t) => {
  if (!dbReady(t, 'creates a zz fixture profile with no references and deletes it')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'delete-unreferenced');

    const created = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiFreeProfile',
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    const res = await request(app).delete(`/api/creature-behaviors/${id}`).set(authHeaderFor(admin));

    assert.equal(res.status, 204);
    assert.equal(res.body && Object.keys(res.body).length, 0);

    const row = await dbPool.query('SELECT 1 FROM creature_behaviors WHERE id = $1', [id]);
    assert.equal(row.rowCount, 0, 'the row must be gone');
  } finally {
    await deleteBehaviorByName(dbPool, 'zzApiFreeProfile');
    await dropUser(dbPool, admin && admin.id);
  }
});

// --- entity-types behavior_id / attack_element ------------------------------

test('POST /api/entity-types accepts behavior_id and attack_element', async (t) => {
  if (!dbReady(t, 'creates a zz profile then a zz entity type pointing at it with a non-physical element')) return;
  let admin;
  let behaviorId;
  try {
    admin = await createTestAdmin(dbPool, 'entitytype-post');

    const behavior = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiEntityTypeBehavior',
    });
    assert.equal(behavior.status, 201);
    behaviorId = behavior.body.id;

    const res = await request(app).post('/api/entity-types').set(authHeaderFor(admin)).send({
      name: 'zzApiEntityTypeWithBehavior',
      color: '#abc',
      is_creature: false,
      behavior_id: behaviorId,
      attack_element: 'fire',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.behavior_id, behaviorId);
    assert.equal(res.body.attack_element, 'fire');

    const row = await dbPool.query('SELECT behavior_id, attack_element FROM entity_types WHERE name = $1', ['zzApiEntityTypeWithBehavior']);
    assert.equal(row.rows[0].behavior_id, behaviorId);
    assert.equal(row.rows[0].attack_element, 'fire');
  } finally {
    await deleteEntityTypeByName(dbPool, 'zzApiEntityTypeWithBehavior');
    await deleteBehaviorByName(dbPool, 'zzApiEntityTypeBehavior');
    await dropUser(dbPool, admin && admin.id);
  }
});

test('PUT /api/entity-types/:id updates behavior_id and attack_element', async (t) => {
  if (!dbReady(t, 'creates a zz entity type then PUTs a new behavior_id and attack_element onto it')) return;
  let admin;
  let behaviorId;
  try {
    admin = await createTestAdmin(dbPool, 'entitytype-put');

    const behavior = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiEntityTypeBehavior2',
    });
    assert.equal(behavior.status, 201);
    behaviorId = behavior.body.id;

    const created = await request(app).post('/api/entity-types').set(authHeaderFor(admin)).send({
      name: 'zzApiEntityTypeForPut',
      color: '#abc',
      is_creature: false,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.attack_element, 'physical', 'attack_element must default to physical when omitted');
    const entityId = created.body.id;

    const res = await request(app).put(`/api/entity-types/${entityId}`).set(authHeaderFor(admin)).send({
      name: 'zzApiEntityTypeForPut',
      color: '#abc',
      walkable: false,
      spawn_tiles: [],
      chance: 0.1,
      is_creature: false,
      behavior_id: behaviorId,
      attack_element: 'ice',
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.behavior_id, behaviorId);
    assert.equal(res.body.attack_element, 'ice');

    const row = await dbPool.query('SELECT behavior_id, attack_element FROM entity_types WHERE id = $1', [entityId]);
    assert.equal(row.rows[0].behavior_id, behaviorId);
    assert.equal(row.rows[0].attack_element, 'ice');
  } finally {
    await deleteEntityTypeByName(dbPool, 'zzApiEntityTypeForPut');
    await deleteBehaviorByName(dbPool, 'zzApiEntityTypeBehavior2');
    await dropUser(dbPool, admin && admin.id);
  }
});
