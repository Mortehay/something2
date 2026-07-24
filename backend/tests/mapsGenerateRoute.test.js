// F-008 (SOMET-188): POST /api/maps/generate defaulted rows/cols to 100 but
// never validated them. This route eagerly builds a full rows*cols array
// in-memory and JSON.stringifies the whole thing into one row -- unlike the
// chunked worlds generator, so an unbounded {"rows":100000,"cols":100000}
// exhausts the heap. Confirm the route now rejects out-of-range dimensions
// with 400 instead of attempting the allocation.
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
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

test('POST /api/maps/generate rejects an oversized rows/cols request', async () => {
  __setPool(mockPool([
    [/FROM tile_types/i, () => ({ rows: [] })],
  ]));
  const res = await request(app).post('/api/maps/generate').set(...AUTH)
    .send({ name: 'huge', rows: 100000, cols: 100000 });
  assert.equal(res.status, 400);
});

test('POST /api/maps/generate rejects non-integer rows/cols', async () => {
  __setPool(mockPool([
    [/FROM tile_types/i, () => ({ rows: [] })],
  ]));
  const res = await request(app).post('/api/maps/generate').set(...AUTH)
    .send({ name: 'nan', rows: 'oops', cols: 50 });
  assert.equal(res.status, 400);
});

test('POST /api/maps/generate accepts default rows/cols', async () => {
  const pool = mockPool([
    [/FROM tile_types/i, () => ({ rows: [
      { id: 1, name: 'grass', color: '#0a0', walkable: true, speed: 1, image: null, valid_neighbors: [] },
    ] })],
    [/INSERT INTO maps/i, (p) => ({ rows: [{ id: 'm1', name: p[0], created_at: new Date().toISOString() }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/maps/generate').set(...AUTH).send({ name: 'ok' });
  assert.equal(res.status, 201);
});
