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

test('POST /api/entity-jobs passes kind:object to sprite-gen and records a queued row', async () => {
  let sentBody = null;
  __setSpriteGen({
    postGenerate: async (body) => { sentBody = body; return { job_id: 'job7', recipe: { backend: 'stub', frames: 1 } }; },
    getCapability: async () => ({ tier: 'cpu' }),
  });
  const pool = mockPool([
    [/INSERT INTO sprite_sets/i, (p) => ({ rows: [{ id: 1, creature: p[0], job_id: p[4], status: 'queued' }] })],
  ]);
  __setPool(pool);

  const res = await request(app).post('/api/entity-jobs').set(...AUTH)
    .send({ entity_type: 'Tree', base_prompt: 'a tall oak', frames: 1, seed: 0 });

  assert.equal(res.status, 201);
  // 'object' is what makes this the cheap flat path; 'creature' would generate
  // one image per direction per frame instead of one image per frame.
  assert.equal(sentBody.kind, 'object');
  assert.equal(sentBody.creature, 'Tree');
  assert.equal(sentBody.base_prompt, 'a tall oak');
  assert.equal(res.body.job_id, 'job7');
  const insert = pool.calls.find((c) => /INSERT INTO sprite_sets/i.test(c.sql));
  assert.equal(insert.params[0], 'Tree');
  assert.equal(insert.params[4], 'job7');
});

test('POST /api/entity-types/:id/image sets image, clears sprite, flips render_mode to static', async () => {
  const pool = mockPool([
    [/UPDATE sprite_sets/i, () => ({ rows: [{ job_id: 'job7' }] })],
    [/UPDATE entity_types SET image/i, (p) => ({ rows: [{ id: Number(p[1]), image: p[0], render_mode: 'static' }] })],
  ]);
  __setPool(pool);

  const res = await request(app).post('/api/entity-types/5/image').set(...AUTH)
    .send({ image_key: 'sprites/objects/Tree/static.png', job_id: 'job7' });

  assert.equal(res.status, 200);
  const upd = pool.calls.find((c) => /UPDATE entity_types SET image/i.test(c.sql));
  assert.equal(upd.params[0], 'sprites/objects/Tree/static.png');
  assert.equal(String(upd.params[1]), '5');
  assert.match(upd.sql, /render_mode = 'static'/);
  // A leftover atlas would keep winning: RenderSystem tries the sprite path
  // before the plain-image fallback, so approving an image must clear it.
  assert.match(upd.sql, /sprite = NULL/);
  assert.equal(res.body.render_mode, 'static');
});

test('POST /api/entity-types/:id/sprite with animated stores a flat sprite and render_mode animated', async () => {
  const pool = mockPool([
    [/UPDATE sprite_sets/i, () => ({ rows: [{ job_id: 'job7' }] })],
    [/UPDATE entity_types SET sprite/i, () => ({ rows: [{ id: 5 }] })],
  ]);
  __setPool(pool);

  const res = await request(app).post('/api/entity-types/5/sprite').set(...AUTH)
    .send({
      atlas_key: 'sprites/objects/Torch/atlas.png',
      manifest_key: 'sprites/objects/Torch/atlas.json',
      frames: 4, job_id: 'job7', animated: true,
    });

  assert.equal(res.status, 200);
  const upd = pool.calls.find((c) => /UPDATE entity_types SET sprite/i.test(c.sql));
  const stored = JSON.parse(upd.params[0]);
  // Flat atlases key frames "0","1",… — claiming a static_frame of 'S/0' would
  // point the renderer at a frame this manifest does not contain.
  assert.deepEqual(stored, {
    atlas_key: 'sprites/objects/Torch/atlas.png',
    manifest_key: 'sprites/objects/Torch/atlas.json',
    frames: 4,
  });
  assert.equal(upd.params[1], 'animated');
});

test('POST /api/entity-types/:id/sprite without animated keeps the directional static behaviour', async () => {
  const pool = mockPool([
    [/UPDATE sprite_sets/i, () => ({ rows: [{ job_id: 'job7' }] })],
    [/UPDATE entity_types SET sprite/i, () => ({ rows: [{ id: 5 }] })],
  ]);
  __setPool(pool);

  const res = await request(app).post('/api/entity-types/5/sprite').set(...AUTH)
    .send({
      atlas_key: 'sprites/Wolf/atlas.png',
      manifest_key: 'sprites/Wolf/atlas.json',
      job_id: 'job7',
    });

  assert.equal(res.status, 200);
  const upd = pool.calls.find((c) => /UPDATE entity_types SET sprite/i.test(c.sql));
  const stored = JSON.parse(upd.params[0]);
  assert.equal(stored.static_frame, 'S/0');
  assert.equal(upd.params[1], 'static');
});

test('entity generation routes reject a missing token', async () => {
  __setPool(mockPool([]));
  for (const path of ['/api/entity-jobs', '/api/entity-types/5/image']) {
    const res = await request(app).post(path).send({});
    assert.equal(res.status, 401, `${path} must require auth`);
  }
});
