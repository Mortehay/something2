const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, __setPool } = require('../src/index.js');

// A pool mock whose query() dispatches on the SQL text. `handlers` is an array
// of [regex, (params) => ({ rows }|Promise)] pairs, tried in order.
function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const [re, fn] of handlers) {
        if (re.test(sql)) return fn(params);
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const VALID_MELEE = {
  name: 'shortsword', category: 'weapon', kind: 'melee', reach: 60, arc_width: 0.5,
};

test('GET /api/item-types returns the catalog', async () => {
  __setPool(mockPool([
    [/FROM item_types/i, () => ({ rows: [{ id: 1, name: 'dagger', category: 'weapon' }] })],
  ]));
  const res = await request(app).get('/api/item-types');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].name, 'dagger');
});

test('POST /api/item-types creates a valid weapon (happy path)', async () => {
  __setPool(mockPool([
    [/INSERT INTO item_types/i, (p) => ({ rows: [{ id: 10, name: p[0], category: p[1] }] })],
  ]));
  const res = await request(app).post('/api/item-types').send(VALID_MELEE);
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 10);
  assert.equal(res.body.name, 'shortsword');
});

test('POST /api/item-types rejects an unknown element', async () => {
  __setPool(mockPool([]));
  const res = await request(app).post('/api/item-types').send({
    name: 'x', category: 'weapon', kind: 'melee', reach: 10, arc_width: 1, element: 'plasma',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /element/i);
});

test('POST /api/item-types rejects a melee weapon missing reach/arc_width', async () => {
  __setPool(mockPool([]));
  const res = await request(app).post('/api/item-types').send({
    name: 'x', category: 'weapon', kind: 'melee',
  });
  assert.equal(res.status, 400);
});

test('POST /api/item-types rejects armor missing slot/defense', async () => {
  __setPool(mockPool([]));
  const res = await request(app).post('/api/item-types').send({
    name: 'x', category: 'armor',
  });
  assert.equal(res.status, 400);
});

test('POST /api/item-types rejects resistances with an unknown element key', async () => {
  __setPool(mockPool([]));
  const res = await request(app).post('/api/item-types').send({
    name: 'x', category: 'armor', slot: 'chest', defense: 1, resistances: { plasma: 0.5 },
  });
  assert.equal(res.status, 400);
});

test('POST /api/players/:userId/items grants an item instance', async () => {
  const pool = mockPool([
    [/INSERT INTO player_items/i, (p) => ({ rows: [{ id: 'pi1', user_id: p[0], item_type_id: p[1] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/players/user-1/items').send({ item_type_id: 3 });
  assert.equal(res.status, 201);
  assert.equal(res.body.item_type_id, 3);
  assert.ok(pool.calls.some((c) => /INSERT INTO player_items/i.test(c.sql)));
});
