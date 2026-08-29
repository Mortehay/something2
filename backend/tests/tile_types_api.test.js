const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

// SQL-text-dispatch pool mock; auth's user lookup answered with an admin row.
function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      calls.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(params, sql);
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('POST /api/tile-types sends prompt as INSERT param $7 and echoes it', async () => {
  const pool = mockPool([
    [/INSERT INTO tile_types/i, (p) => ({ rows: [{ id: 1, name: 'lava', prompt: p[6] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/tile-types').set(...AUTH).send({
    name: 'lava', color: '#f00', walkable: false, speed: 0,
    valid_neighbors: [], prompt: 'molten glowing lava',
  });
  assert.equal(res.status, 201);
  const call = pool.calls.find((c) => /INSERT INTO tile_types/i.test(c.sql));
  assert.equal(call.params[6], 'molten glowing lava', 'prompt must be INSERT $7');
  assert.equal(res.body.prompt, 'molten glowing lava');
});

test('PUT /api/tile-types/:id sends prompt, wall_height and place_order, and points WHERE at the id', async () => {
  const pool = mockPool([
    // name is unchanged ('grass' -> 'grass'), so the rename guard's reference
    // checks are skipped entirely.
    [/SELECT name FROM tile_types WHERE id/i, () => ({ rows: [{ name: 'grass' }] })],
    // Echoes the row the way the real UPDATE ... RETURNING * would, locating
    // prompt by its placeholder rather than by a memorised index -- a fixture
    // pinned to a column position goes quietly wrong the moment one is added.
    [/UPDATE tile_types/i, (p, sql) => ({
      rows: [{
        id: Number(p[p.length - 1]),
        name: p[0],
        prompt: p[Number(/prompt\s*=\s*\$(\d+)/.exec(sql)[1]) - 1],
      }],
    })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/tile-types/9').set(...AUTH).send({
    name: 'grass', color: '#0f0', walkable: true, speed: 1,
    image: '', valid_neighbors: ['grass'], prompt: 'edited meadow grass',
    wall_height: 40, place_order: 1,
  });
  assert.equal(res.status, 200);
  const call = pool.calls.find((c) => /UPDATE tile_types/i.test(c.sql));
  // Read each column's placeholder out of the SET clause instead of hardcoding
  // an index, for exactly the reason the WHERE assertion below already gives:
  // a fixed index asserts the right thing only by coincidence and breaks every
  // time a column is added or removed. What matters is that the value lands in
  // ITS OWN column, which is what this now checks.
  const paramFor = (col) => {
    const m = new RegExp(`${col}\\s*=\\s*\\$(\\d+)`).exec(call.sql);
    assert.ok(m, `${col} must still be written by this UPDATE`);
    return call.params[Number(m[1]) - 1];
  };
  assert.equal(paramFor('prompt'), 'edited meadow grass');
  assert.equal(paramFor('wall_height'), 40);
  assert.equal(paramFor('place_order'), 1);
  // The id is read out of the WHERE clause rather than pinned to a fixed
  // position. SOMET-342 added the two pin columns and moved it from $10 to
  // $13, and the ONLY thing that assertion ever needed to protect is that the
  // row this UPDATE matches is the one in the URL -- a hardcoded index says
  // that by coincidence, and fails whenever a column is added.
  const wherePlaceholder = Number(/WHERE id = \$(\d+)/.exec(call.sql)[1]);
  assert.equal(String(call.params[wherePlaceholder - 1]), '9', 'WHERE id must carry the id from the URL');
  assert.equal(wherePlaceholder, call.params.length, 'the id stays the last param');
  assert.equal(res.body.prompt, 'edited meadow grass');
});

test('PUT /api/tile-types/:id does not write image, so Save Changes cannot undo an Approve', async () => {
  // The reported failure: generate a texture, Approve it, press Save Changes,
  // and the tile silently goes back to the previous picture -- both requests
  // answering 200, so it reads as the generator having failed.
  //
  // The form has no image input. It snapshots `image` when the modal opens and
  // sends it back untouched, so after an Approve that snapshot is the PREVIOUS
  // key. The route used to write `image = COALESCE(NULLIF($5, ''), image)`,
  // which only protected the empty case -- i.e. a tile getting its FIRST
  // texture. For a tile that already had one, the stale key sailed through.
  const pool = mockPool([
    [/SELECT name FROM tile_types WHERE id/i, () => ({ rows: [{ name: 'rocks' }] })],
    [/UPDATE tile_types/i, (p) => ({ rows: [{ id: Number(p[p.length - 1]) }] })],
  ]);
  __setPool(pool);
  const stale = 'sprites/tiles/rocks/rmt_OLDJOB/static.png';
  const res = await request(app).put('/api/tile-types/5').set(...AUTH).send({
    name: 'rocks', color: '#888', walkable: true, speed: 0.8,
    image: stale, valid_neighbors: [], prompt: 'grey rocky stone ground',
    wall_height: 0, place_order: 0,
  });
  assert.equal(res.status, 200);
  const call = pool.calls.find((c) => /UPDATE tile_types/i.test(c.sql));
  // Two independent checks: the column is not in the SET clause at all, and
  // the key never reaches the parameter list. Either alone could pass while
  // the other leaked -- a column assigned from a literal, or a parameter
  // carried for some other purpose.
  assert.doesNotMatch(call.sql, /\bimage\s*=/,
    'image is owned by POST /:id/image; this route must not assign it');
  assert.ok(!call.params.includes(stale),
    'a stale image key from the form must not reach the UPDATE at all');
});

test('POST defaults prompt to empty string when omitted', async () => {
  const pool = mockPool([
    [/INSERT INTO tile_types/i, (p) => ({ rows: [{ id: 2, prompt: p[6] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/tile-types').set(...AUTH).send({
    name: 'plain', color: '#111',
  });
  assert.equal(res.status, 201);
  const call = pool.calls.find((c) => /INSERT INTO tile_types/i.test(c.sql));
  assert.equal(call.params[6], '', 'missing prompt must default to empty string');
});

// SOMET-238: DELETE had no reference guard at all, though the PUT rename
// guard right above already refuses exactly this (see also
// biomesApi.test.js's "renaming a tile type is refused while a biome still
// lists it"). Same two reference sites, same 409 shape, now on DELETE too. No
// /DELETE FROM tile_types/i handler is registered in the refused cases below
// on purpose: if the guard regressed away, that query would hit the mock's
// throw-on-unexpected-query guard instead of silently deleting a
// still-referenced row.
test('DELETE /api/tile-types/:id 409s when still referenced by an entity type\'s spawn tiles', async () => {
  __setPool(mockPool([
    [/SELECT name FROM tile_types WHERE id/i, () => ({ rows: [{ name: 'grass' }] })],
    [/FROM entity_types WHERE spawn_tiles/i, () => ({ rows: [{ id: 3, name: 'Bush' }] })],
    [/FROM biomes WHERE terrain_tiles/i, () => ({ rows: [] })],
  ]));
  const res = await request(app).delete('/api/tile-types/1').set(...AUTH);
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.referencing_entity_types, [{ id: 3, name: 'Bush' }]);
});

test('DELETE /api/tile-types/:id 409s when still referenced by a biome\'s terrain_tiles', async () => {
  __setPool(mockPool([
    [/SELECT name FROM tile_types WHERE id/i, () => ({ rows: [{ name: 'grass' }] })],
    [/FROM entity_types WHERE spawn_tiles/i, () => ({ rows: [] })],
    [/FROM biomes WHERE terrain_tiles/i, () => ({ rows: [{ id: 1, name: 'Meadow' }] })],
  ]));
  const res = await request(app).delete('/api/tile-types/1').set(...AUTH);
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.referencing_biomes, [{ id: 1, name: 'Meadow' }]);
});

test('DELETE /api/tile-types/:id succeeds when nothing references it (no regression)', async () => {
  const pool = mockPool([
    [/SELECT name FROM tile_types WHERE id/i, () => ({ rows: [{ name: 'grass' }] })],
    [/FROM entity_types WHERE spawn_tiles/i, () => ({ rows: [] })],
    [/FROM biomes WHERE terrain_tiles/i, () => ({ rows: [] })],
    [/DELETE FROM tile_types WHERE id/i, () => ({ rows: [{ id: 1 }] })],
  ]);
  __setPool(pool);
  const res = await request(app).delete('/api/tile-types/1').set(...AUTH);
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.id, 1);
});

test('DELETE /api/tile-types/:id 404s when the row does not exist', async () => {
  __setPool(mockPool([
    [/SELECT name FROM tile_types WHERE id/i, () => ({ rows: [] })],
  ]));
  const res = await request(app).delete('/api/tile-types/999').set(...AUTH);
  assert.equal(res.status, 404);
});
