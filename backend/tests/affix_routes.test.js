// SOMET-480 (progression epic T12). Admin CRUD for the affix catalog.
//
// Two halves, deliberately:
//   * mocked-pool cases pin auth, validation and the SQL actually issued;
//   * one END-TO-END case runs the real router against the real database, for
//     the D1/D2/C2 reason -- a route proven only against a mock proves nothing
//     about whether the columns it names exist.
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { adminToken, isUserLookup, ADMIN_USER_ROW, withAuth } = require('./helpers/auth.js');
const { Pool } = require('pg');
const { signToken } = require('../src/auth/tokens.js');

const { app, __setPool } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];
const PLAYER_AUTH = ['Authorization', `Bearer ${signToken({
  userId: 2, username: 'player', role: 'player', tokenVersion: 1,
})}`];
// A token that CLAIMS admin for a user the database says is a player. The
// guard must believe the row, not the claim.
const FORGED_AUTH = ['Authorization', `Bearer ${signToken({
  userId: 2, username: 'player', role: 'admin', tokenVersion: 1,
})}`];

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// The guard reads the caller's role from the DATABASE, not from the token, so
// the user lookup has to answer per user id -- the shared helper's blanket
// admin row would make a player token read as an admin and every 403 case
// below would pass while proving nothing.
const PLAYER_ID = 2;
const PLAYER_USER_ROW = { rows: [{ token_version: 1, role: 'player' }] };

function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      if (isUserLookup(sql)) {
        return Number(params && params[0]) === PLAYER_ID ? PLAYER_USER_ROW : ADMIN_USER_ROW;
      }
      calls.push({ sql, params });
      for (const [re, fn] of handlers) {
        if (re.test(sql)) return fn(params);
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const VALID = {
  key: 'of_probe',
  label: 'of Probe',
  kind: 'buff',
  effect: { type: 'stat', stat: 'wisdom' },
  min_value: 1,
  max_value: 4,
};

test('GET /api/affix-types requires an admin', async () => {
  // A player token must be refused by the guard, NOT by a missing route: a 404
  // here would mean the block was never mounted and every other case below is
  // testing nothing.
  __setPool(mockPool([[/FROM affix_types/i, () => ({ rows: [] })]]));
  assert.strictEqual((await request(app).get('/api/affix-types')).status, 401);
  assert.strictEqual((await request(app).get('/api/affix-types').set(...PLAYER_AUTH)).status, 403);
  // A self-declared admin claim in the token is not enough -- the guard reads
  // the users row.
  assert.strictEqual((await request(app).get('/api/affix-types').set(...FORGED_AUTH)).status, 403);
  assert.strictEqual((await request(app).get('/api/affix-types').set(...AUTH)).status, 200);
});

test('every affix-types route is admin-guarded, and there are exactly four', async () => {
  const paths = app._router.stack
    .filter((l) => l.route && /^\/api\/affix-types/.test(l.route.path))
    .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`)
    .sort();
  assert.deepStrictEqual(paths, [
    'DELETE /api/affix-types/:id',
    'GET /api/affix-types',
    'POST /api/affix-types',
    'PUT /api/affix-types/:id',
  ]);
  // Every one of them must refuse a player. Asserted by walking the mounted
  // routes rather than by four hand-written requests, so a fifth route added
  // later without a guard fails here.
  __setPool(mockPool([[/affix_types|player_item_affixes/i, () => ({ rows: [], rowCount: 0 })]]));
  for (const method of ['get', 'post', 'put', 'delete']) {
    const path = method === 'get' || method === 'post' ? '/api/affix-types' : '/api/affix-types/1';
    const res = await request(app)[method](path).set(...PLAYER_AUTH).send(VALID);
    assert.strictEqual(res.status, 403, `${method.toUpperCase()} ${path} is not admin-guarded`);
  }
});

test('POST /api/affix-types validates BEFORE it queries', async () => {
  const pool = mockPool([[/affix_types/i, () => { throw new Error('must not query on an invalid body'); }]]);
  __setPool(pool);

  const cases = [
    [{ ...VALID, min_value: 10, max_value: 1 }, /max_value/],
    [{ ...VALID, kind: 'sideways' }, /kind/],
    [{ ...VALID, key: '   ' }, /key/],
    [{ ...VALID, label: '' }, /label/],
    [{ ...VALID, effect: { type: 'nonsense' } }, /effect\.type/],
    // A stat affix naming a stat nobody has is inert, not merely odd.
    [{ ...VALID, effect: { type: 'stat', stat: 'luck' } }, /effect\.stat/],
    [{ ...VALID, weight: 0 }, /weight/],
    [{ ...VALID, min_rarity: 'white' }, /min_rarity/],
    [{ ...VALID, allowed_slots: ['pocket'] }, /slot/],
    [{ ...VALID, min_item_level: 0 }, /min_item_level/],
    [{ ...VALID, min_item_level: 20, max_item_level: 5 }, /max_item_level/],
    // Spec 6.1: a debuff is foxy-only, carries a status, and that status must
    // be one effects.js can hold under refresh-not-stack semantics.
    [{ ...VALID, kind: 'debuff', effect: { type: 'status', status: 'chill' }, min_rarity: 'yellow' }, /foxy/],
    [{ ...VALID, kind: 'debuff', min_rarity: 'foxy', effect: { type: 'stat', stat: 'wisdom' } }, /status/],
    [{ ...VALID, kind: 'debuff', min_rarity: 'foxy', effect: { type: 'status', status: 'shock' } }, /effect\.status/],
  ];
  for (const [body, re] of cases) {
    const res = await request(app).post('/api/affix-types').set(...AUTH).send(body);
    assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.match(res.body.error, re);
  }
  assert.strictEqual(pool.calls.length, 0, 'no query may be issued for an invalid body');
});

test('POST /api/affix-types inserts the authored values, not defaults', async () => {
  const pool = mockPool([
    [/INSERT INTO affix_types/i, (p) => ({ rows: [{ id: 99, key: p[0] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/affix-types').set(...AUTH).send({
    ...VALID,
    min_item_level: 20,
    max_item_level: 60,
    allowed_slots: ['head', 'chest'],
    min_rarity: 'yellow',
    weight: 45,
  });
  assert.strictEqual(res.status, 201);
  const call = pool.calls.find((c) => /INSERT INTO affix_types/i.test(c.sql));
  assert.deepStrictEqual(call.params, [
    'of_probe', 'of Probe', 'buff', '{"type":"stat","stat":"wisdom"}',
    1, 4, 20, 60, ['head', 'chest'], 'yellow', 45,
  ]);
});

test('a duplicate key is a 409, not a 500', async () => {
  __setPool(mockPool([
    [/INSERT INTO affix_types/i, () => { const e = new Error('dup'); e.code = '23505'; throw e; }],
  ]));
  const res = await request(app).post('/api/affix-types').set(...AUTH).send(VALID);
  assert.strictEqual(res.status, 409);
  assert.match(res.body.error, /already exists/);
});

test('PUT /api/affix-types/:id reports a missing row as 404', async () => {
  __setPool(mockPool([[/UPDATE affix_types/i, () => ({ rows: [] })]]));
  const res = await request(app).put('/api/affix-types/4242').set(...AUTH).send(VALID);
  assert.strictEqual(res.status, 404);
});

// The point of ON DELETE RESTRICT: removing a catalog affix must never silently
// strip a stat off gear a player is wearing.
test('DELETE refuses an affix that is rolled on a live instance', async () => {
  const pool = mockPool([
    [/FROM player_item_affixes/i, () => ({ rows: [{ '?column?': 1 }], rowCount: 1 })],
    [/DELETE FROM affix_types/i, () => { throw new Error('must not reach the DELETE'); }],
  ]);
  __setPool(pool);
  const res = await request(app).delete('/api/affix-types/7').set(...AUTH);
  assert.strictEqual(res.status, 409);
  assert.match(res.body.error, /players own/);
  assert.strictEqual(pool.calls.filter((c) => /DELETE FROM affix_types/i.test(c.sql)).length, 0);
});

// SOMET-501. The second probe. world_items carries a denormalised `affixes`
// jsonb with a bare affixTypeId and NO foreign key, so a ground item is
// invisible to both the probe above and the RESTRICT behind it -- the delete
// used to succeed and every pickup of that item then failed on 23503.
//
// Asserted on the SQL and the bound parameter, not just the status: the probe
// has to be a CONTAINMENT match on the array element, and a probe that looked
// for the id anywhere in the row (or matched nothing at all) would still
// return "no rows" here and read as a pass.
test('DELETE refuses an affix that a GROUND item carries', async () => {
  const pool = mockPool([
    [/FROM player_item_affixes/i, () => ({ rows: [], rowCount: 0 })],
    [/FROM world_items/i, () => ({ rows: [{ '?column?': 1 }], rowCount: 1 })],
    [/DELETE FROM affix_types/i, () => { throw new Error('must not reach the DELETE'); }],
  ]);
  __setPool(pool);
  const res = await request(app).delete('/api/affix-types/7').set(...AUTH);
  assert.strictEqual(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error, /ground/i);
  assert.strictEqual(pool.calls.filter((c) => /DELETE FROM affix_types/i.test(c.sql)).length, 0);

  const probe = pool.calls.find((c) => /FROM world_items/i.test(c.sql));
  assert.match(probe.sql, /affixes @>/i, 'the ground probe must be a jsonb containment match');
  assert.deepStrictEqual(JSON.parse(probe.params[0]), [{ affixTypeId: 7 }],
    'the probe must look for the affix id as an ARRAY ELEMENT of the snapshot');
});

// The pre-check can lose a race; the FK is the real enforcement, and its error
// must not surface as a 500.
test('DELETE maps a lost race on the FK to the same 409', async () => {
  __setPool(mockPool([
    [/FROM player_item_affixes/i, () => ({ rows: [], rowCount: 0 })],
    [/FROM world_items/i, () => ({ rows: [], rowCount: 0 })],
    [/DELETE FROM affix_types/i, () => { const e = new Error('fk'); e.code = '23503'; throw e; }],
  ]));
  const res = await request(app).delete('/api/affix-types/7').set(...AUTH);
  assert.strictEqual(res.status, 409);
});

test('DELETE reports a missing row as 404', async () => {
  __setPool(mockPool([
    [/FROM player_item_affixes/i, () => ({ rows: [], rowCount: 0 })],
    [/FROM world_items/i, () => ({ rows: [], rowCount: 0 })],
    [/DELETE FROM affix_types/i, () => ({ rows: [], rowCount: 0 })],
  ]));
  assert.strictEqual((await request(app).delete('/api/affix-types/4242').set(...AUTH)).status, 404);
});

// --- END TO END -----------------------------------------------------------
// Against the REAL database. A route proven only against a mock cannot tell
// you whether the columns it names exist -- which is precisely how D1 and D2
// each shipped an inert feature with a green suite.
test('the routes work against the real schema, end to end', async (t) => {
  if (!DB_URL) { t.skip('no TEST_DATABASE_URL / DATABASE_URL'); return; }
  const real = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try { await real.query('SELECT 1'); } catch (err) {
    await real.end().catch(() => {});
    t.skip(`NO DATABASE at ${DB_URL} (${err.message})`);
    return;
  }
  // withAuth answers the guard's own user lookup with an admin row, so this
  // needs no seeded admin account; every other query hits the real database.
  let createdId = null;
  __setPool({ query: withAuth((sql, params) => real.query(sql, params)) });
  t.after(async () => {
    if (createdId != null) await real.query('DELETE FROM affix_types WHERE id = $1', [createdId]).catch(() => {});
    await real.end().catch(() => {});
  });

  const list = await request(app).get('/api/affix-types').set(...AUTH);
  assert.strictEqual(list.status, 200);
  assert.ok(list.body.some((a) => a.key === 'of_might'), 'the seeded catalog must be listed');
  const seeded = list.body.find((a) => a.key === 'of_might');
  // The row must arrive with every field the roller reads, or the admin UI is
  // editing a shape the roller does not consume.
  for (const f of ['kind', 'effect', 'min_value', 'max_value', 'min_item_level',
    'max_item_level', 'allowed_slots', 'min_rarity', 'weight']) {
    assert.ok(f in seeded, `the listed row is missing ${f}`);
  }

  const key = `probe-${process.pid}-${Date.now()}`;
  const created = await request(app).post('/api/affix-types').set(...AUTH)
    .send({ ...VALID, key, allowed_slots: ['head'], min_rarity: 'yellow', weight: 45 });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  createdId = created.body.id;
  assert.deepStrictEqual(created.body.allowed_slots, ['head']);
  assert.strictEqual(created.body.min_rarity, 'yellow');
  assert.strictEqual(created.body.weight, 45);

  const updated = await request(app).put(`/api/affix-types/${createdId}`).set(...AUTH)
    .send({ ...VALID, key, label: 'of Probe II', weight: 7, allowed_slots: [] });
  assert.strictEqual(updated.status, 200, JSON.stringify(updated.body));
  assert.strictEqual(updated.body.label, 'of Probe II');
  assert.strictEqual(updated.body.weight, 7);

  // A creating admin who re-uses a seeded key gets a 409 off the real unique
  // index, not a 500.
  const dup = await request(app).post('/api/affix-types').set(...AUTH).send({ ...VALID, key: 'of_might' });
  assert.strictEqual(dup.status, 409, JSON.stringify(dup.body));

  const del = await request(app).delete(`/api/affix-types/${createdId}`).set(...AUTH);
  assert.strictEqual(del.status, 200, JSON.stringify(del.body));
  createdId = null;
  const gone = await real.query('SELECT 1 FROM affix_types WHERE key = $1', [key]);
  assert.strictEqual(gone.rowCount, 0);
});
