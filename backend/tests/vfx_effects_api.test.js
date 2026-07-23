const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

function mockPool(handlers) {
  return {
    query: async (sql, params) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const ROW = {
  id: 1, name: 'sweep_arc', shape: 'arc', color: '#e8e8f0', width: 3,
  duration_ms: 180, ease: 'out', fade: true, follows_weapon: true,
};

test('GET /api/vfx-effects returns the effect library', async () => {
  __setPool(mockPool([[/FROM vfx_effects/i, () => ({ rows: [ROW] })]]));
  const res = await request(app).get('/api/vfx-effects');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].name, 'sweep_arc');
  // The client indexes by name and reads geometry straight off the row, so
  // every field the renderer uses must survive the round trip.
  for (const k of ['shape', 'color', 'width', 'duration_ms', 'ease', 'fade', 'follows_weapon']) {
    assert.ok(k in res.body[0], `response drops ${k}`);
  }
});

test('the effect library is readable without a token', async () => {
  // Every player's client needs it to draw a frame; only WRITES are admin
  // (slice E). A 401 here would leave signed-out spectators with no effects.
  __setPool(mockPool([[/FROM vfx_effects/i, () => ({ rows: [ROW] })]]));
  const res = await request(app).get('/api/vfx-effects');
  assert.equal(res.status, 200);
});

test('a query failure is a 500, not a crash', async () => {
  __setPool({ query: async () => { throw new Error('boom'); } });
  const res = await request(app).get('/api/vfx-effects');
  assert.equal(res.status, 500);
});
