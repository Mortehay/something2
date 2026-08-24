const { test, before, after } = require('node:test');
const assert = require('node:assert');

// Set the secret before requiring the app / signing any token.
require('./helpers/auth.js');
const request = require('supertest');
const { Pool } = require('pg');

const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

// ---------------------------------------------------------------------------
// Part 1: route protection -- no database needed. Walks the REAL Express route
// stack for the isAuthGuard marker, the same idiom progression_routes.test.js
// uses for its mounted sub-router.
// ---------------------------------------------------------------------------

function characterRouteLayers() {
  const appStack = app._router && app._router.stack;
  assert.ok(appStack, 'could not locate the app router stack');
  const mountLayer = appStack.find((l) => l.name === 'router'
    && l.handle && Array.isArray(l.handle.stack)
    && l.handle.stack.some((rl) => rl.route && rl.route.path === '/classes'));
  assert.ok(mountLayer, 'could not locate the mounted characters router');
  return mountLayer.handle.stack.filter((rl) => rl.route);
}

test('every character route is behind an auth guard', () => {
  const layers = characterRouteLayers();
  // A walk that matched zero routes would pass vacuously -- assert the real
  // surface first (GET /, GET /classes, POST /, DELETE /:id).
  assert.equal(layers.length, 4, `expected exactly 4 character routes, found ${layers.length}`);
  const unguarded = layers
    .filter((l) => !l.route.stack.some((h) => h.handle && h.handle.isAuthGuard))
    .map((l) => `${Object.keys(l.route.methods).join('/').toUpperCase()} ${l.route.path}`);
  assert.deepEqual(unguarded, [], `unguarded character routes: ${unguarded.join(', ')}`);
});

test('/classes is declared before /:id so it is not captured as an id', () => {
  const layers = characterRouteLayers();
  const classesIdx = layers.findIndex((l) => l.route.path === '/classes');
  const idIdx = layers.findIndex((l) => l.route.path === '/:id');
  assert.ok(classesIdx !== -1 && idIdx !== -1, 'both routes must exist');
  assert.ok(classesIdx < idIdx,
    'GET /classes must be registered before DELETE /:id, or Express matches the id route first');
});

// ---------------------------------------------------------------------------
// Part 2: functional/security tests against a REAL database, through the real
// HTTP app. Gated on TEST_DATABASE_URL alone -- no DATABASE_URL fallback -- so
// a bare `npm test` on a machine with a working dev database can never reach
// this file. Same disposable-user fixture as progression_routes.test.js: one
// throwaway user per test, deleted unconditionally in a `finally`.
// ---------------------------------------------------------------------------

const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://user:password@localhost:15432/game_db';

function requireTestDb(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

let dbPool = null;

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  const p = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try {
    await p.query('SELECT 1');
    dbPool = p;
    __setPool(p);
  } catch {
    await p.end().catch(() => {});
  }
});

after(async () => {
  if (dbPool) await dbPool.end().catch(() => {});
});

function dbReady(t, what) {
  if (!requireTestDb(t, what)) return false;
  if (!dbPool) {
    const m = `NO DATABASE at ${DB_URL} -- ${what} is UNVERIFIED on this run`;
    if (process.env.CI) assert.fail(m);
    t.skip(m);
    return false;
  }
  return true;
}

async function createTestUser(pool, tag) {
  const username = `characters-routes-test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id",
    [username]);
  return r.rows[0].id;
}

async function dropUser(pool, userId) {
  if (userId != null) await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
}

function tokenFor(userId) {
  return signToken({ userId, username: `u${userId}`, role: 'player', tokenVersion: 1 });
}

function auth(userId) {
  return { Authorization: `Bearer ${tokenFor(userId)}` };
}

async function warriorId(pool) {
  return (await pool.query("SELECT id FROM entity_types WHERE name = 'Warrior'")).rows[0].id;
}

// A name unique to this process/run, so parallel runs cannot collide on the
// global characters_name_unique constraint.
let nameSeq = 0;
function uniqueName(tag) {
  nameSeq += 1;
  return `zzRt${tag}${process.pid}x${nameSeq}`;
}

test('GET /api/characters is 401 without a token', async (t) => {
  if (!dbReady(t, 'unauthenticated rejection')) return;
  const res = await request(app).get('/api/characters');
  assert.equal(res.status, 401);
});

test('GET /api/characters returns an empty list and the cap for a fresh account', async (t) => {
  if (!dbReady(t, 'empty list')) return;
  let userId;
  try {
    userId = await createTestUser(dbPool, 'empty');
    const res = await request(app).get('/api/characters').set(auth(userId));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.characters, []);
    assert.equal(res.body.maxCharacters, 8);
  } finally {
    await dropUser(dbPool, userId);
  }
});

test('GET /api/characters/classes lists the six playable classes', async (t) => {
  if (!dbReady(t, 'class catalog')) return;
  let userId;
  try {
    userId = await createTestUser(dbPool, 'classes');
    const res = await request(app).get('/api/characters/classes').set(auth(userId));
    assert.equal(res.status, 200, 'must not be captured by the /:id route');
    assert.deepEqual(res.body.classes.map((c) => c.name).sort(),
      ['Archer', 'Cultist', 'Druid', 'Mage', 'Monk', 'Warrior']);
    // SOMET-486: the pools have to survive the HTTP boundary, because
    // CharacterSelect.jsx renders `{cls.hp} hp / {cls.mana} mana` straight off
    // this body. class_pools_db.test.js proves these numbers match what a
    // character actually joins with; this proves the screen is given them at
    // all -- a route that dropped `mana` would render "85 hp / undefined mana"
    // with every other test still green.
    const byName = Object.fromEntries(res.body.classes.map((c) => [c.name, c]));
    assert.deepEqual(
      ['Warrior', 'Mage', 'Monk', 'Cultist', 'Archer', 'Druid']
        .map((n) => [n, byName[n].hp, byName[n].mana]),
      [['Warrior', 100, 100], ['Mage', 75, 150], ['Monk', 90, 110],
        ['Cultist', 110, 90], ['Archer', 85, 115], ['Druid', 90, 135]],
      'the advertised pools must reach the client, as numbers');
    // SOMET-471: mainStat crosses the same boundary. CharacterSelect.jsx maps
    // it to a STR/DEX/CON label, so a route that dropped it would render every
    // class with the unknown-stat em dash and stay green everywhere else.
    assert.deepEqual(
      ['Warrior', 'Mage', 'Monk', 'Cultist', 'Archer', 'Druid'].map((n) => byName[n].mainStat),
      ['strength', 'intelligence', 'wisdom', 'constitution', 'dexterity', 'charisma']);
  } finally {
    await dropUser(dbPool, userId);
  }
});

test('POST /api/characters creates into slot 1', async (t) => {
  if (!dbReady(t, 'create')) return;
  let userId;
  try {
    userId = await createTestUser(dbPool, 'create');
    const res = await request(app).post('/api/characters').set(auth(userId))
      .send({ name: uniqueName('Create'), entity_type_id: await warriorId(dbPool) });
    assert.equal(res.status, 201);
    assert.equal(res.body.slot, 1);
  } finally {
    await dropUser(dbPool, userId);
  }
});

test('POST /api/characters rejects a duplicate name from another account with 409', async (t) => {
  if (!dbReady(t, 'duplicate name')) return;
  let a; let b;
  try {
    a = await createTestUser(dbPool, 'dupA');
    b = await createTestUser(dbPool, 'dupB');
    const warrior = await warriorId(dbPool);
    const shared = uniqueName('Dup');
    const first = await request(app).post('/api/characters').set(auth(a))
      .send({ name: shared, entity_type_id: warrior });
    assert.equal(first.status, 201);
    const second = await request(app).post('/api/characters').set(auth(b))
      .send({ name: shared.toUpperCase(), entity_type_id: warrior });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'name_taken');
  } finally {
    await dropUser(dbPool, a);
    await dropUser(dbPool, b);
  }
});

test('POST /api/characters rejects a blank name with 400', async (t) => {
  if (!dbReady(t, 'blank name')) return;
  let userId;
  try {
    userId = await createTestUser(dbPool, 'blank');
    const res = await request(app).post('/api/characters').set(auth(userId))
      .send({ name: '   ', entity_type_id: await warriorId(dbPool) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'bad_name');
  } finally {
    await dropUser(dbPool, userId);
  }
});

test('POST /api/characters rejects the non-playable legacy Player type with 400', async (t) => {
  if (!dbReady(t, 'non-playable class')) return;
  let userId;
  try {
    userId = await createTestUser(dbPool, 'notplayable');
    const player = (await dbPool.query("SELECT id FROM entity_types WHERE name = 'Player'")).rows[0].id;
    const res = await request(app).post('/api/characters').set(auth(userId))
      .send({ name: uniqueName('NotPlayable'), entity_type_id: player });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'not_playable');
  } finally {
    await dropUser(dbPool, userId);
  }
});

test('POST /api/characters rejects a ninth character with 409', async (t) => {
  if (!dbReady(t, 'slot cap')) return;
  let userId;
  try {
    userId = await createTestUser(dbPool, 'cap');
    const warrior = await warriorId(dbPool);
    for (let i = 0; i < 8; i += 1) {
      const r = await request(app).post('/api/characters').set(auth(userId))
        .send({ name: uniqueName(`Cap${i}`), entity_type_id: warrior });
      assert.equal(r.status, 201, `character ${i + 1} should have been created`);
    }
    const ninth = await request(app).post('/api/characters').set(auth(userId))
      .send({ name: uniqueName('Cap9'), entity_type_id: warrior });
    assert.equal(ninth.status, 409);
    assert.equal(ninth.body.error, 'no_free_slot');
    const list = await request(app).get('/api/characters').set(auth(userId));
    assert.equal(list.body.characters.length, 8);
  } finally {
    await dropUser(dbPool, userId);
  }
});

test('DELETE /api/characters/:id removes the owner\'s character and frees the slot', async (t) => {
  if (!dbReady(t, 'delete')) return;
  let userId;
  try {
    userId = await createTestUser(dbPool, 'del');
    const warrior = await warriorId(dbPool);
    const created = await request(app).post('/api/characters').set(auth(userId))
      .send({ name: uniqueName('Del'), entity_type_id: warrior });
    const del = await request(app).delete(`/api/characters/${created.body.id}`).set(auth(userId));
    assert.equal(del.status, 204);
    const list = await request(app).get('/api/characters').set(auth(userId));
    assert.deepEqual(list.body.characters, []);
    const again = await request(app).post('/api/characters').set(auth(userId))
      .send({ name: uniqueName('DelAgain'), entity_type_id: warrior });
    assert.equal(again.status, 201);
    assert.equal(again.body.slot, 1, 'the freed slot is reusable');
  } finally {
    await dropUser(dbPool, userId);
  }
});

test('DELETE /api/characters/:id is 403 for another account, and the row survives', async (t) => {
  if (!dbReady(t, 'cross-account delete')) return;
  let a; let b;
  try {
    a = await createTestUser(dbPool, 'ownA');
    b = await createTestUser(dbPool, 'ownB');
    const created = await request(app).post('/api/characters').set(auth(a))
      .send({ name: uniqueName('Own'), entity_type_id: await warriorId(dbPool) });
    const del = await request(app).delete(`/api/characters/${created.body.id}`).set(auth(b));
    assert.equal(del.status, 403);
    // The row surviving is the assertion that matters: a 403 response with the
    // delete already performed would pass a status-only check.
    const still = await dbPool.query('SELECT count(*)::int AS n FROM characters WHERE id = $1',
      [created.body.id]);
    assert.equal(still.rows[0].n, 1);
  } finally {
    await dropUser(dbPool, a);
    await dropUser(dbPool, b);
  }
});

test('DELETE /api/characters/:id is 403 (not 404) for an id that does not exist', async (t) => {
  if (!dbReady(t, 'unknown id')) return;
  let userId;
  try {
    userId = await createTestUser(dbPool, 'unknown');
    // 403 rather than 404 deliberately: a 404 would tell a caller which
    // character ids are real.
    const res = await request(app).delete('/api/characters/999999999').set(auth(userId));
    assert.equal(res.status, 403);
  } finally {
    await dropUser(dbPool, userId);
  }
});
