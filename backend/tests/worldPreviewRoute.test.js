const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, __setPool } = require('../src/index.js');

function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}
const tileRows = { rows: [
  { name: 'grass', color: '#3a3', walkable: true, speed: 1 },
  { name: 'water', color: '#36f', walkable: false, speed: 1 },
  { name: 'path', color: '#ca8', walkable: true, speed: 1 },
] };

test('GET /preview returns a 64x64 grid for a known world', async () => {
  __setPool(mockPool([
    [/FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', seed: '7', chunk_size: 64 }] })],
    [/FROM tile_types/i, () => tileRows],
  ]));
  const res = await request(app).get('/api/worlds/w1/preview');
  assert.equal(res.status, 200);
  assert.equal(res.body.world_id, 'w1');
  assert.equal(res.body.data.length, 64);
  assert.ok(res.body.data.every((row) => row.length === 64));
});

test('GET /preview 404s for an unknown world', async () => {
  __setPool(mockPool([
    [/FROM worlds WHERE id/i, () => ({ rows: [] })],
  ]));
  const res = await request(app).get('/api/worlds/nope/preview');
  assert.equal(res.status, 404);
});

test('GET /preview memoizes: a second request does not re-query the world', async () => {
  const pool = mockPool([
    [/FROM worlds WHERE id/i, () => ({ rows: [{ id: 'memo1', seed: '9', chunk_size: 64 }] })],
    [/FROM tile_types/i, () => tileRows],
  ]);
  __setPool(pool);
  const a = await request(app).get('/api/worlds/memo1/preview');
  const b = await request(app).get('/api/worlds/memo1/preview');
  assert.deepEqual(a.body.data, b.body.data);
  const worldQueries = pool.calls.filter((c) => /FROM worlds WHERE id/i.test(c.sql)).length;
  assert.equal(worldQueries, 1, 'second request should hit the memo, not the DB');
});
