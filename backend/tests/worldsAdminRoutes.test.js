const test = require('node:test');
const assert = require('node:assert');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const request = require('supertest');
const { app, __setPool } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      calls.push({ sql, params });
      for (const [re, fn] of handlers) {
        if (re.test(sql)) return fn(params);
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('PUT /api/worlds/:id requires a non-empty name', async () => {
  __setPool(mockPool([]));
  const res = await request(app).put('/api/worlds/w1').set(...AUTH).send({ name: '   ' });
  assert.equal(res.status, 400);
});

test('PUT /api/worlds/:id rejects width without height', async () => {
  __setPool(mockPool([]));
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'A', width: 24, height: null });
  assert.equal(res.status, 400);
});

test('PUT /api/worlds/:id rejects out-of-range bounds', async () => {
  __setPool(mockPool([]));
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'A', width: 4, height: 4 });
  assert.equal(res.status, 400);
});

test('PUT /api/worlds/:id updates and returns the row', async () => {
  const pool = mockPool([
    // current row (to detect bounds change)
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', width: 24, height: 24 }] })],
    [/UPDATE worlds SET/i, (p) => ({ rows: [{ id: 'w1', name: p[0] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'Renamed', width: 24, height: 24, creature_count: 5, allowed_creature_types: ['goblin'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Renamed');
});

test('PUT /api/worlds/:id 404 when the row is absent', async () => {
  __setPool(mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [] })],
  ]));
  const res = await request(app).put('/api/worlds/nope').set(...AUTH).send({ name: 'X' });
  assert.equal(res.status, 404);
});

test('PUT /api/worlds/:id with is_entry clears the previous entry first', async () => {
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', width: 24, height: 24 }] })],
    [/UPDATE worlds SET is_entry = false/i, () => ({ rows: [], rowCount: 1 })],
    [/UPDATE worlds SET/i, (p) => ({ rows: [{ id: 'w1', name: p[0], is_entry: true }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'Entry', is_entry: true, entry_spawn: { x: 1200, y: 1200 } });
  assert.equal(res.status, 200);
  const clearedFirst = pool.calls.some(c => /UPDATE worlds SET is_entry = false/i.test(c.sql));
  assert.ok(clearedFirst, 'previous entry cleared');
});

test('PUT /api/worlds/:id deletes chunks + clears cache when bounds change', async () => {
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', width: 24, height: 24 }] })],
    [/DELETE FROM world_chunks WHERE world_id/i, () => ({ rows: [], rowCount: 3 })],
    [/UPDATE worlds SET/i, (p) => ({ rows: [{ id: 'w1', name: p[0] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'Bigger', width: 32, height: 32 });
  assert.equal(res.status, 200);
  const deleted = pool.calls.some(c => /DELETE FROM world_chunks WHERE world_id/i.test(c.sql));
  assert.ok(deleted, 'chunks invalidated on bounds change');
});
