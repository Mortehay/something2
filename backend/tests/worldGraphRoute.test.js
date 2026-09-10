const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');

// SOMET-555: /api/world-graph is adminGuard'd now, so every call needs a token.
const AUTH = ['Authorization', `Bearer ${adminToken()}`];
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
  const res = await request(app).get('/api/world-graph').set(...AUTH);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.worlds, WORLDS);
  assert.deepEqual(res.body.links, LINKS);
});

// The client collapses mirrored pairs itself, because detecting a MISSING
// mirror is a lint check — impossible if the server has already collapsed
// them and thrown the evidence away.
test('returns BOTH directions, uncollapsed', async () => {
  __setPool(poolFor());
  const res = await request(app).get('/api/world-graph').set(...AUTH);
  assert.equal(res.body.links.length, 2);
  assert.ok(res.body.links.some((l) => l.from_world_id === 'a' && l.edge === 'E'));
  assert.ok(res.body.links.some((l) => l.from_world_id === 'b' && l.edge === 'W'));
});

test('a one-way (unmirrored) row survives to the client', async () => {
  __setPool(poolFor([{ from_world_id: 'a', edge: 'N', to_world_id: 'b' }]));
  const res = await request(app).get('/api/world-graph').set(...AUTH);
  assert.deepEqual(res.body.links, [{ from_world_id: 'a', edge: 'N', to_world_id: 'b' }]);
});

test('carries the position columns, including nulls', async () => {
  __setPool(poolFor());
  const res = await request(app).get('/api/world-graph').set(...AUTH);
  const b = res.body.worlds.find((w) => w.id === 'b');
  assert.equal(b.graph_x, null);
  assert.equal(b.graph_y, null);
});

test('includes unbounded worlds — the client decides they are unlinkable', async () => {
  __setPool(poolFor());
  const res = await request(app).get('/api/world-graph').set(...AUTH);
  assert.ok(res.body.worlds.some((w) => w.id === 'u' && w.width === null));
});

test('is two queries, not one per world', async () => {
  const pool = poolFor();
  __setPool(pool);
  await request(app).get('/api/world-graph').set(...AUTH);
  assert.equal(pool.calls.length, 2);
});

test('both queries are deterministically ordered', async () => {
  const pool = poolFor();
  __setPool(pool);
  await request(app).get('/api/world-graph').set(...AUTH);
  for (const c of pool.calls) assert.match(c.sql, /ORDER BY/i);
});

// `ORDER BY from_world_id, edge` alone is NOT a stable order once portals
// exist: every 'PORTAL' row out of one world ties on both columns, and
// Postgres is free to return ties differently per request. The client's
// placePortalClusters assigns sibling branch columns in receipt order, so an
// unstable tie makes a two-branch dungeon swap columns on every refetch.
// (from_world_id, from_x, from_y) is unique for PORTAL rows by partial index
// -- see migrations/1714440060000_map_link_portals.js's
// map_links_portal_source_unique -- so these four columns are a total order.
test('the links query breaks the (from_world_id, edge) tie two PORTAL rows create', async () => {
  const pool = poolFor();
  __setPool(pool);
  await request(app).get('/api/world-graph').set(...AUTH);
  const linksCall = pool.calls.find((c) => /FROM map_links/i.test(c.sql));
  assert.ok(linksCall, 'expected a query against map_links');
  assert.match(linksCall.sql, /ORDER BY\s+from_world_id\s*,\s*edge\s*,\s*from_x\s*,\s*from_y/i);
});

// The order the route hands the client is whatever the driver returned, so
// this asserts the pass-through, not the sort itself: two branches out of one
// hub must both arrive, distinguishable by their source tile.
test('two PORTAL rows out of one world both survive to the client, source tiles intact', async () => {
  const portals = [
    { from_world_id: 'a', edge: 'PORTAL', to_world_id: 'b', from_x: 100, from_y: 100, to_x: 50, to_y: 50 },
    { from_world_id: 'a', edge: 'PORTAL', to_world_id: 'u', from_x: 900, from_y: 100, to_x: 50, to_y: 50 },
  ];
  __setPool(poolFor(portals));
  const res = await request(app).get('/api/world-graph').set(...AUTH);
  assert.deepEqual(res.body.links, portals);
  const tiles = res.body.links.map((l) => `${l.from_x},${l.from_y}`);
  assert.equal(new Set(tiles).size, 2, 'each portal must be identifiable by its own source tile');
});

// The mock handlers above match on /FROM worlds/i and return the canned
// WORLDS rows whatever columns are actually requested, so nothing pins the
// SELECT's column list -- dropping `biomes` or `graph_x` from the route would
// break the client silently while every test above kept passing. All eight
// columns are consumed client-side (id/name for labels and lookups,
// width/height for the linkable/unbounded split, is_entry for layout
// anchoring, biomes for the ring, graph_x/graph_y for seedPositions), so none
// is dead weight worth trimming.
test('the worlds query selects every column the client depends on', async () => {
  const pool = poolFor();
  __setPool(pool);
  await request(app).get('/api/world-graph').set(...AUTH);
  const worldsCall = pool.calls.find((c) => /FROM worlds/i.test(c.sql));
  assert.ok(worldsCall, 'expected a query against worlds');
  for (const col of ['id', 'name', 'width', 'height', 'is_entry', 'biomes', 'graph_x', 'graph_y']) {
    assert.match(worldsCall.sql, new RegExp(`\\b${col}\\b`), `worlds SELECT must name ${col}`);
  }
});

// SOMET-555. The structural walk in auth_protection.test.js proves a guard is
// ATTACHED to this route; it cannot prove the guard actually rejects, which is
// the property that matters. Exercise it for real.
//
// Why it mattered here: this route returns every world and every map link, and
// it answered that to an unauthenticated caller for as long as it existed --
// while GET /api/worlds went to the trouble of projecting the same data per
// player through projectWorldForPlayer. The projection was defeated by a
// sibling route, not by a hole in the projection itself.
test('GET /api/world-graph rejects a caller with no token', async () => {
  __setPool(mockPool([[/FROM worlds/i, () => ({ rows: [] })], [/FROM map_links/i, () => ({ rows: [] })]]));
  const res = await request(app).get('/api/world-graph');
  assert.equal(res.status, 401);
});

test('GET /api/world-graph rejects a non-admin player', async () => {
  // A player must not be able to read the full topology either: they get their
  // own character-scoped view from GET /api/player/world-map.
  const pool = mockPool([[/FROM worlds/i, () => ({ rows: [] })], [/FROM map_links/i, () => ({ rows: [] })]]);
  __setPool({
    ...pool,
    query: async (sql, params) => {
      if (isUserLookup(sql)) return { rows: [{ token_version: 1, role: 'player' }] };
      return pool.query(sql, params);
    },
  });
  const res = await request(app).get('/api/world-graph').set(...AUTH);
  assert.equal(res.status, 403);
});
