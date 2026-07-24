// F-043 (SOMET-223): none of the four admin-catalog create routes (and their
// PUT counterparts) validated name length. A 10,000-character name either
// raw-500s the generic catch-all on a varchar(255) column (tile_types,
// entity_types) or is silently accepted with no limit on a text column
// (item_types, worlds) -- confirmed live for all four. Every route should
// now reject an over-length name with 400 before the query ever runs.
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { adminToken, withAuth } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];
const HUGE_NAME = 'a'.repeat(10000);

// A pool whose query() throws on anything but the auth guard's user lookup --
// used to prove the route 400s before ever touching the DB.
function noQueryPool() {
  return { query: withAuth(async (sql) => {
    throw new Error(`must not query the DB for an over-length name: ${sql}`);
  }) };
}

test('POST /api/tile-types rejects a 10,000-character name', async () => {
  __setPool(noQueryPool());
  const res = await request(app).post('/api/tile-types').set(...AUTH)
    .send({ name: HUGE_NAME, color: '#fff' });
  assert.equal(res.status, 400);
});

test('PUT /api/tile-types/:id rejects a 10,000-character name', async () => {
  __setPool(noQueryPool());
  const res = await request(app).put('/api/tile-types/1').set(...AUTH)
    .send({ name: HUGE_NAME, color: '#fff' });
  assert.equal(res.status, 400);
});

test('POST /api/entity-types rejects a 10,000-character name', async () => {
  __setPool(noQueryPool());
  const res = await request(app).post('/api/entity-types').set(...AUTH)
    .send({ name: HUGE_NAME, color: '#fff' });
  assert.equal(res.status, 400);
});

test('PUT /api/entity-types/:id rejects a 10,000-character name', async () => {
  __setPool(noQueryPool());
  const res = await request(app).put('/api/entity-types/1').set(...AUTH)
    .send({ name: HUGE_NAME, color: '#fff' });
  assert.equal(res.status, 400);
});

test('POST /api/item-types rejects a 10,000-character name', async () => {
  __setPool(noQueryPool());
  const res = await request(app).post('/api/item-types').set(...AUTH)
    .send({ name: HUGE_NAME, category: 'armor', slot: 'head', defense: 1 });
  assert.equal(res.status, 400);
});

test('PUT /api/item-types/:id rejects a 10,000-character name', async () => {
  __setPool(noQueryPool());
  const res = await request(app).put('/api/item-types/1').set(...AUTH)
    .send({ name: HUGE_NAME, category: 'armor', slot: 'head', defense: 1 });
  assert.equal(res.status, 400);
});

test('POST /api/worlds rejects a 10,000-character name', async () => {
  __setPool(noQueryPool());
  const res = await request(app).post('/api/worlds').set(...AUTH)
    .send({ name: HUGE_NAME, seed: 1 });
  assert.equal(res.status, 400);
});

test('PUT /api/worlds/:id rejects a 10,000-character name', async () => {
  __setPool(noQueryPool());
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: HUGE_NAME });
  assert.equal(res.status, 400);
});

// A name right at the cap must still be accepted -- this is a length cap, not
// a de facto ban on long-but-reasonable names.
test('POST /api/tile-types accepts a name exactly at the 200-char cap', async () => {
  const okName = 'a'.repeat(200);
  __setPool({ query: withAuth(async (sql, params) => {
    if (/INSERT INTO tile_types/i.test(sql)) return { rows: [{ id: 1, name: params[0] }] };
    throw new Error(`unexpected query: ${sql}`);
  }) });
  const res = await request(app).post('/api/tile-types').set(...AUTH)
    .send({ name: okName, color: '#fff' });
  assert.equal(res.status, 201);
  assert.equal(res.body.name.length, 200);
});
