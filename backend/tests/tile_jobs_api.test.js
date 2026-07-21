const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool, __setSpriteGen } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

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

test('POST /api/tile-jobs passes kind:tile to sprite-gen and records a queued row', async () => {
  let sentBody = null;
  __setSpriteGen({
    postGenerate: async (body) => { sentBody = body; return { job_id: 'job1', recipe: { backend: 'stub', frames: 1 } }; },
    getCapability: async () => ({ tier: 'cpu' }),
  });
  const pool = mockPool([
    [/INSERT INTO sprite_sets/i, (p) => ({ rows: [{ id: 1, creature: p[0], job_id: p[4], status: 'queued' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/tile-jobs').set(...AUTH)
    .send({ tile_type: 'grass', base_prompt: 'green grass', frames: 1, seed: 0 });
  assert.equal(res.status, 201);
  assert.equal(sentBody.kind, 'tile', 'must tell sprite-gen this is a tile job');
  assert.equal(sentBody.creature, 'grass');
  assert.equal(res.body.job_id, 'job1');
  const insert = pool.calls.find((c) => /INSERT INTO sprite_sets/i.test(c.sql));
  assert.equal(insert.params[0], 'grass');
  assert.equal(insert.params[4], 'job1');
});

test('POST /api/tile-types/:id/image sets image and flips render_mode to image', async () => {
  const pool = mockPool([
    [/UPDATE sprite_sets/i, () => ({ rows: [{ job_id: 'job1' }] })],
    [/UPDATE tile_types SET image/i, (p) => ({ rows: [{ id: Number(p[1]), image: p[0], render_mode: 'image' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/tile-types/5/image').set(...AUTH)
    .send({ image_key: 'sprites/tiles/grass/static.png', job_id: 'job1' });
  assert.equal(res.status, 200);
  const upd = pool.calls.find((c) => /UPDATE tile_types SET image/i.test(c.sql));
  assert.equal(upd.params[0], 'sprites/tiles/grass/static.png');
  assert.equal(String(upd.params[1]), '5');
  assert.match(upd.sql, /render_mode = 'image'/);
  assert.equal(res.body.render_mode, 'image');
});

test('POST /api/tile-types/:id/sprite sets sprite jsonb and flips render_mode to animated', async () => {
  const pool = mockPool([
    [/UPDATE sprite_sets/i, () => ({ rows: [{ job_id: 'job1' }] })],
    [/UPDATE tile_types SET sprite/i, (p) => ({ rows: [{ id: Number(p[1]), sprite: JSON.parse(p[0]), render_mode: 'animated' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/tile-types/5/sprite').set(...AUTH)
    .send({ atlas_key: 'sprites/tiles/water/atlas.png', manifest_key: 'sprites/tiles/water/atlas.json', frames: 4, job_id: 'job1' });
  assert.equal(res.status, 200);
  const upd = pool.calls.find((c) => /UPDATE tile_types SET sprite/i.test(c.sql));
  const stored = JSON.parse(upd.params[0]);
  assert.deepEqual(stored, { atlas_key: 'sprites/tiles/water/atlas.png', manifest_key: 'sprites/tiles/water/atlas.json', frames: 4 });
  assert.match(upd.sql, /render_mode = 'animated'/);
  assert.equal(res.body.render_mode, 'animated');
});

test('tile mutating routes reject a missing token', async () => {
  __setPool(mockPool([]));
  for (const path of ['/api/tile-jobs', '/api/tile-types/5/image', '/api/tile-types/5/sprite']) {
    const res = await request(app).post(path).send({});
    assert.equal(res.status, 401, `${path} must require auth`);
  }
});
