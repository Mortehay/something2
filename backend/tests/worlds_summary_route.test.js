// SOMET-554. GET /api/worlds/summary feeds the Maps tab's collapsed rows with
// per-world link/portal/village counts, replacing the two-XHR-per-card fan-out
// that made that tab look hung on a 100-world database.
//
// Import order matters: helpers/auth.js sets JWT_SECRET and must be required
// before ../src/index.js so the guards sign and verify with the same secret.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

function mockPool(handlers) {
  const calls = [];
  const dispatch = async (sql, params) => {
    if (isUserLookup(sql)) return ADMIN_USER_ROW;
    calls.push({ sql, params });
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
    throw new Error(`unexpected query: ${sql}`);
  };
  return { calls, query: dispatch, connect: async () => ({ query: dispatch, release: () => {} }) };
}

// node-postgres hands COUNT() back as a STRING -- int8 has no lossless JS
// number type, so it does not parse it. The fixture reproduces that faithfully
// on purpose: with real numbers here the route could drop its Number() casts
// and this file would still pass, which is exactly the kind of fixture that
// certifies a broken endpoint.
const SUMMARY_ROWS = {
  rows: [
    { id: 'w-dungeon', link_count: '3', portal_count: '2', village_count: '1' },
    { id: 'w-plain', link_count: '0', portal_count: '0', village_count: '0' },
  ],
};

test('GET /api/worlds/summary returns per-world counts as NUMBERS, not pg strings', async () => {
  __setPool(mockPool([[/FROM worlds w/i, () => SUMMARY_ROWS]]));

  const res = await request(app).get('/api/worlds/summary').set(...AUTH);
  assert.equal(res.status, 200);

  const byId = Object.fromEntries(res.body.map((r) => [r.id, r]));
  assert.deepEqual(byId['w-dungeon'],
    { id: 'w-dungeon', link_count: 3, portal_count: 2, village_count: 1 });

  // The reason the casts exist. The row renders "0 villages" correctly either
  // way, but the dungeon badge is driven by `portal_count > 0`, and the string
  // "0" is truthy -- uncast, EVERY world would claim to be a dungeon.
  const plain = byId['w-plain'];
  assert.strictEqual(plain.portal_count, 0);
  assert.ok(!plain.portal_count, 'a zero portal_count must be falsy in the client');
});

test('the summary query counts links and villages WITHOUT multiplying them together', async () => {
  // A world with 3 links and 2 villages joined naively produces 6 rows and
  // counts each side 6 times. Pin that the counts come from pre-aggregated
  // subqueries rather than one grouped join across both tables.
  const pool = mockPool([[/FROM worlds w/i, () => SUMMARY_ROWS]]);
  __setPool(pool);

  await request(app).get('/api/worlds/summary').set(...AUTH);
  const sql = pool.calls.map((c) => c.sql).join('\n');

  assert.match(sql, /LEFT JOIN\s*\(SELECT from_world_id/i,
    'map_links must be aggregated in a subquery before the join');
  assert.match(sql, /LEFT JOIN\s*\(SELECT world_id, COUNT\(\*\) AS village_count/i,
    'villages must be aggregated in a subquery before the join');
  assert.doesNotMatch(sql, /GROUP BY w\.id/i,
    'a GROUP BY on the outer query would mean both tables were joined raw');
});

test('GET /api/worlds/summary is registered ABOVE /api/worlds/:id', () => {
  // Express matches in declaration order. Below the parameterised route, the
  // literal path is swallowed as an `:id` of "summary" and answered by the uuid
  // lookup instead -- a 404 that looks like a missing world, not a routing bug.
  // Asserted against the source because both routes would need a live database
  // to distinguish at runtime.
  const src = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  const summaryAt = src.indexOf("app.get('/api/worlds/summary'");
  const byIdAt = src.indexOf("app.get('/api/worlds/:id'");

  assert.ok(summaryAt > 0, 'the summary route must exist');
  assert.ok(byIdAt > 0, 'the :id route must exist');
  assert.ok(summaryAt < byIdAt,
    `summary is declared at ${summaryAt}, after :id at ${byIdAt} -- it will never match`);
});

test('GET /api/worlds/summary rejects a caller with no token', async () => {
  __setPool(mockPool([[/FROM worlds w/i, () => SUMMARY_ROWS]]));
  const res = await request(app).get('/api/worlds/summary');
  assert.equal(res.status, 401);
});

test('GET /api/worlds/summary rejects a non-admin player', async () => {
  // Unlike GET /api/worlds there is no per-player projection on this route, so
  // a player reaching it would see every world's topology at once.
  const pool = mockPool([[/FROM worlds w/i, () => SUMMARY_ROWS]]);
  const playerPool = {
    ...pool,
    query: async (sql, params) => {
      if (isUserLookup(sql)) return { rows: [{ token_version: 1, role: 'player' }] };
      return pool.query(sql, params);
    },
  };
  __setPool(playerPool);

  const res = await request(app).get('/api/worlds/summary').set(...AUTH);
  assert.equal(res.status, 403);
});

test('a database failure answers 500 rather than leaking the driver error', async () => {
  __setPool(mockPool([[/FROM worlds w/i, () => { throw new Error('relation "villages" does not exist'); }]]));
  const res = await request(app).get('/api/worlds/summary').set(...AUTH);
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Failed to load world summary');
});
