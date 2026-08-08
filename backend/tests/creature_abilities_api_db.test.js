// Real-HTTP, real-DB tests for the `abilities` array nested under
// /api/creature-behaviors (SOMET-253 Task 3). Bootstrap modeled directly on
// tests/creature_behaviors_api_db.test.js: a real pg Pool swapped into the
// app via __setPool, a disposable admin user created per test and dropped in
// a `finally`, gated on TEST_DATABASE_URL alone so a bare `npm test` on a
// machine with a working dev database never reaches here.
//
// SAFETY: every fixture row this file creates is a `zz`-prefixed
// creature_behaviors row (and the creature_abilities rows that cascade with
// it), torn down BY NAME, unconditionally, in a `finally`. This file never
// asserts a rejection against a REAL catalog row -- see the Global
// Constraints in the task brief: an earlier task's test destroyed the real
// 'Line' row doing exactly that before the FK/CHECK that would have
// protected it existed.

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
  const username = `creature-abilities-api-test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

async function deleteBehaviorByName(pool, name) {
  // creature_abilities cascades away with its behaviour (ON DELETE CASCADE),
  // so deleting the parent fixture is enough.
  await pool.query('DELETE FROM creature_behaviors WHERE name = $1', [name]).catch(() => {});
}

// One valid ability, with overrides. Mirrors NEW_ABILITY_DEFAULTS in
// frontend/src/games/something2/abilityForm.js: attack_range 60,
// attack_cooldown 1 -- a 0 in either is a creature that never attacks or
// fires at an unbounded rate.
function abilityFixture(overrides = {}) {
  return {
    name: 'Attack',
    attack_kind: 'melee',
    attack_range: 60,
    attack_cooldown: 1,
    projectile_speed: 0,
    projectile_radius: 0,
    element: null,
    damage_mult: 1,
    knockback: 0,
    ...overrides,
  };
}

const FIXTURE_BODY = {
  name: 'zzApiAbilityBehavior',
  aggro_radius: 300,
  leash_radius: 500,
  chase_style: 'charge',
  move_speed_mult: 1,
  abilities: [abilityFixture()],
};

test('GET returns abilities nested in slot order', async (t) => {
  if (!dbReady(t, 'creates a zz behaviour with two abilities and reads them back nested')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'get-nested');

    const created = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiNested',
      abilities: [
        abilityFixture({ name: 'First', attack_range: 60 }),
        abilityFixture({ name: 'Second', attack_range: 90, knockback: 10 }),
      ],
    });
    assert.equal(created.status, 201);

    const res = await request(app).get('/api/creature-behaviors');
    assert.equal(res.status, 200);
    const row = res.body.find((b) => b.name === 'zzApiNested');
    assert.ok(row, 'fixture behaviour must be in the GET response');
    assert.ok(Array.isArray(row.abilities));
    assert.deepEqual(row.abilities.map((a) => a.slot), [1, 2]);
    assert.equal(row.abilities[0].name, 'First');
    assert.equal(row.abilities[1].name, 'Second');
    assert.equal(Number(row.abilities[1].knockback), 10);
  } finally {
    await deleteBehaviorByName(dbPool, 'zzApiNested');
    await dropUser(dbPool, admin && admin.id);
  }
});

test('PUT replaces the ability set transactionally', async (t) => {
  if (!dbReady(t, 'creates zzTwo with two abilities, PUTs one, and confirms exactly one remains')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'put-replace');

    const created = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzTwo',
      abilities: [
        abilityFixture({ name: 'One' }),
        abilityFixture({ name: 'Two', attack_range: 80 }),
      ],
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.abilities.length, 2);
    const id = created.body.id;

    const res = await request(app).put(`/api/creature-behaviors/${id}`).set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzTwo',
      abilities: [abilityFixture({ name: 'Solo' })],
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.abilities.length, 1);
    assert.equal(res.body.abilities[0].name, 'Solo');
    assert.equal(res.body.abilities[0].slot, 1);

    const row = await dbPool.query('SELECT COUNT(*) FROM creature_abilities WHERE behavior_id = $1', [id]);
    assert.equal(Number(row.rows[0].count), 1, 'exactly one ability row must remain');
  } finally {
    await deleteBehaviorByName(dbPool, 'zzTwo');
    await dropUser(dbPool, admin && admin.id);
  }
});

test('a rejected PUT leaves the existing abilities untouched', async (t) => {
  if (!dbReady(t, 'PUTs an invalid second ability onto a zz behaviour with two valid abilities')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'put-rejected');

    const created = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzRejected',
      abilities: [
        abilityFixture({ name: 'One' }),
        abilityFixture({ name: 'Two', attack_range: 80 }),
      ],
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    const res = await request(app).put(`/api/creature-behaviors/${id}`).set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzRejected',
      // attack_range 0: strictly positive is required by abilityFieldError.
      abilities: [abilityFixture({ name: 'Valid' }), abilityFixture({ name: 'Invalid', attack_range: 0 })],
    });

    assert.equal(res.status, 400);

    const row = await dbPool.query(
      'SELECT name FROM creature_abilities WHERE behavior_id = $1 ORDER BY slot', [id],
    );
    assert.deepEqual(
      row.rows.map((r) => r.name), ['One', 'Two'],
      'a rejected PUT must not touch the abilities that were already there -- without a transaction '
      + 'the delete lands and the reinsert fails, leaving the profile unable to attack at all',
    );
  } finally {
    await deleteBehaviorByName(dbPool, 'zzRejected');
    await dropUser(dbPool, admin && admin.id);
  }
});

test("chase_style 'guard' requires every ability be melee", async (t) => {
  if (!dbReady(t, 'posts a guard profile with a ranged ability and confirms the spanning validation catches it')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'post-guard-ranged');

    const res = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzGuardRanged',
      chase_style: 'guard',
      abilities: [abilityFixture({ attack_kind: 'ranged', projectile_speed: 400 })],
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /guard/);
    assert.match(res.body.error, /melee/);

    const row = await dbPool.query('SELECT 1 FROM creature_behaviors WHERE name = $1', ['zzGuardRanged']);
    assert.equal(row.rowCount, 0, 'a rejected POST must not create a row');
  } finally {
    await deleteBehaviorByName(dbPool, 'zzGuardRanged');
    await dropUser(dbPool, admin && admin.id);
  }
});

test("chase_style 'kite' requires preferred_range <= the longest ability range", async (t) => {
  if (!dbReady(t, 'posts a kite profile whose preferred_range exceeds its only ability\'s range')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'post-kite-range');

    const res = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzKiteFar',
      chase_style: 'kite',
      preferred_range: 340,
      abilities: [abilityFixture({ attack_kind: 'ranged', attack_range: 300, projectile_speed: 400 })],
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /kite/);
    assert.match(res.body.error, /preferred_range/);

    const row = await dbPool.query('SELECT 1 FROM creature_behaviors WHERE name = $1', ['zzKiteFar']);
    assert.equal(row.rowCount, 0, 'a rejected POST must not create a row');
  } finally {
    await deleteBehaviorByName(dbPool, 'zzKiteFar');
    await dropUser(dbPool, admin && admin.id);
  }
});

test('slots are renumbered from 1 with no gaps', async (t) => {
  if (!dbReady(t, 'posts abilities with slots [5, 9] and confirms the stored slots are [1, 2]')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'post-slot-renumber');

    const res = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzSlotGap',
      // slot is implied by array position -- the admin editor reorders by
      // drag, so the API must not preserve whatever the client happened to
      // send.
      abilities: [
        abilityFixture({ name: 'First', slot: 5 }),
        abilityFixture({ name: 'Second', slot: 9, attack_range: 90 }),
      ],
    });

    assert.equal(res.status, 201);
    assert.deepEqual(res.body.abilities.map((a) => a.slot), [1, 2]);

    const row = await dbPool.query(
      'SELECT slot FROM creature_abilities WHERE behavior_id = $1 ORDER BY slot', [res.body.id],
    );
    assert.deepEqual(row.rows.map((r) => r.slot), [1, 2]);
  } finally {
    await deleteBehaviorByName(dbPool, 'zzSlotGap');
    await dropUser(dbPool, admin && admin.id);
  }
});
