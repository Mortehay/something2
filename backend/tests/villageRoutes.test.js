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
    [/FROM villages WHERE world_id = \$1/i, () => ({ rows: [] })],
    [/INSERT INTO villages/i, (p) => ({ rows: [{
      id: 'v1', min_row: p[1], min_col: p[2], width: p[3], height: p[4], gate_edge: p[5],
    }] })],
    [/INSERT INTO world_creatures/i, () => ({ rows: [] })],
    [/DELETE FROM world_chunks/i, () => ({ rows: [], rowCount: 0 })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/worlds/w1/villages').set(...AUTH)
    .send({ min_row: 5, min_col: 5, width: 8, height: 6, gate_edge: 'S', spawn_x: 650, spawn_y: 650 });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, 'v1');
  const villageInserts = pool.calls.filter((c) => /INSERT INTO villages/i.test(c.sql));
  assert.equal(villageInserts.length, 1);
  // merchant post for this box/gate: S gate, minRow 5 minCol 5 width 8 height 6
  // -> rMax 10, midCol 9, merchant row rMax-2=8, col midCol=9
  assert.equal(villageInserts[0].params[8], 9 * 100 + 50, 'merchant_x stored from villageMerchantPost');
  assert.equal(villageInserts[0].params[9], 8 * 100 + 50, 'merchant_y stored from villageMerchantPost');
  assert.equal(pool.calls.filter((c) => /DELETE FROM world_chunks/i.test(c.sql)).length, 1);
  const guardInserts = pool.calls.filter((c) => /INSERT INTO world_creatures/i.test(c.sql));
  assert.equal(guardInserts.length, 2, 'village creation spawns exactly two guards');
});

test('POST village rejects out-of-range dimensions', async () => {
  const pool = mockPool([
    [/SELECT id, width, height FROM worlds WHERE id = \$1/i, (p) => ({ rows: [WORLD({ id: p[0] })] })],
    [/FROM villages WHERE world_id = \$1/i, () => ({ rows: [] })],
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
    [/FROM villages WHERE world_id = \$1/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/worlds/w1/villages').set(...AUTH)
    .send({ min_row: 8, min_col: 8, width: 8, height: 6, gate_edge: 'S', spawn_x: 850, spawn_y: 850 });
  assert.equal(res.status, 400);
});

test('POST village rejects creation on an unbounded world', async () => {
  const pool = mockPool([
    [/SELECT id, width, height FROM worlds WHERE id = \$1/i, (p) => ({ rows: [{ id: p[0], width: null, height: null }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/worlds/w1/villages').set(...AUTH)
    .send({ min_row: 5, min_col: 5, width: 8, height: 6, gate_edge: 'S', spawn_x: 650, spawn_y: 650 });
  assert.equal(res.status, 400);
  assert.equal(pool.calls.filter((c) => /INSERT INTO villages/i.test(c.sql)).length, 0);
});

test('DELETE village removes the row, re-derives guards, and invalidates the world', async () => {
  const pool = mockPool([
    [/DELETE FROM villages WHERE id = \$1/i, () => ({ rows: [], rowCount: 1 })],
    [/DELETE FROM world_creatures WHERE world_id = \$1 AND type = \$2/i, () => ({ rows: [], rowCount: 2 })],
    [/FROM villages WHERE world_id = \$1/i, () => ({ rows: [{
      id: 'v2', min_row: 10, min_col: 10, width: 8, height: 6, gate_edge: 'S', spawn_x: 1150, spawn_y: 1050,
    }] })],
    [/INSERT INTO world_creatures/i, () => ({ rows: [] })],
    [/DELETE FROM world_chunks/i, () => ({ rows: [], rowCount: 0 })],
  ]);
  __setPool(pool);
  const res = await request(app).delete('/api/worlds/w1/villages/v1').set(...AUTH);
  assert.equal(res.status, 204);
  assert.equal(pool.calls.filter((c) => /DELETE FROM villages/i.test(c.sql)).length, 1);
  const guardWipe = pool.calls.find((c) => /DELETE FROM world_creatures/i.test(c.sql));
  assert.match(guardWipe.sql, /type\s*=\s*\$2/i, 'deleting a village must wipe the world\'s guard rows');
  assert.ok(guardWipe.params.includes('Village Guard'));
  const guardInserts = pool.calls.filter((c) => /INSERT INTO world_creatures/i.test(c.sql));
  assert.equal(guardInserts.length, 2, 'guards are re-derived for the surviving village');
});

test('DELETE the only village leaves zero guards (no surviving villages)', async () => {
  const pool = mockPool([
    [/DELETE FROM villages WHERE id = \$1/i, () => ({ rows: [], rowCount: 1 })],
    [/DELETE FROM world_creatures WHERE world_id = \$1 AND type = \$2/i, () => ({ rows: [], rowCount: 2 })],
    [/FROM villages WHERE world_id = \$1/i, () => ({ rows: [] })],
    [/DELETE FROM world_chunks/i, () => ({ rows: [], rowCount: 0 })],
  ]);
  __setPool(pool);
  const res = await request(app).delete('/api/worlds/w1/villages/v1').set(...AUTH);
  assert.equal(res.status, 204);
  const guardInserts = pool.calls.filter((c) => /INSERT INTO world_creatures/i.test(c.sql));
  assert.equal(guardInserts.length, 0, 'no surviving villages means no guard inserts');
});
