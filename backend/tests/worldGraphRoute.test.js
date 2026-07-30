const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      calls.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const WORLDS = [
  { id: 'a', name: 'Arena', width: 30, height: 30, is_entry: true, biomes: ['Meadow'], graph_x: 0, graph_y: 0 },
  { id: 'b', name: 'test2', width: 24, height: 24, is_entry: false, biomes: [], graph_x: null, graph_y: null },
  { id: 'u', name: 'unbounded', width: null, height: null, is_entry: false, biomes: [], graph_x: null, graph_y: null },
];
// Both directions of one logical link.
const LINKS = [
  { from_world_id: 'a', edge: 'E', to_world_id: 'b' },
  { from_world_id: 'b', edge: 'W', to_world_id: 'a' },
];

function poolFor(links = LINKS) {
  return mockPool([
    [/FROM worlds/i, () => ({ rows: WORLDS })],
    [/FROM map_links/i, () => ({ rows: links })],
  ]);
}

test('returns worlds and links in one snapshot', async () => {
  __setPool(poolFor());
  const res = await request(app).get('/api/world-graph');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.worlds, WORLDS);
  assert.deepEqual(res.body.links, LINKS);
});

// The client collapses mirrored pairs itself, because detecting a MISSING
// mirror is a lint check — impossible if the server has already collapsed
// them and thrown the evidence away.
test('returns BOTH directions, uncollapsed', async () => {
  __setPool(poolFor());
  const res = await request(app).get('/api/world-graph');
  assert.equal(res.body.links.length, 2);
  assert.ok(res.body.links.some((l) => l.from_world_id === 'a' && l.edge === 'E'));
  assert.ok(res.body.links.some((l) => l.from_world_id === 'b' && l.edge === 'W'));
});

test('a one-way (unmirrored) row survives to the client', async () => {
  __setPool(poolFor([{ from_world_id: 'a', edge: 'N', to_world_id: 'b' }]));
  const res = await request(app).get('/api/world-graph');
  assert.deepEqual(res.body.links, [{ from_world_id: 'a', edge: 'N', to_world_id: 'b' }]);
});

test('carries the position columns, including nulls', async () => {
  __setPool(poolFor());
  const res = await request(app).get('/api/world-graph');
  const b = res.body.worlds.find((w) => w.id === 'b');
  assert.equal(b.graph_x, null);
  assert.equal(b.graph_y, null);
});

test('includes unbounded worlds — the client decides they are unlinkable', async () => {
  __setPool(poolFor());
  const res = await request(app).get('/api/world-graph');
  assert.ok(res.body.worlds.some((w) => w.id === 'u' && w.width === null));
});

test('is two queries, not one per world', async () => {
  const pool = poolFor();
  __setPool(pool);
  await request(app).get('/api/world-graph');
  assert.equal(pool.calls.length, 2);
});

test('both queries are deterministically ordered', async () => {
  const pool = poolFor();
  __setPool(pool);
  await request(app).get('/api/world-graph');
  for (const c of pool.calls) assert.match(c.sql, /ORDER BY/i);
});
