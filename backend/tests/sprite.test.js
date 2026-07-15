const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

// The app must be exported from index.js for testing (see spriteGen admin bridge).
process.env.SPRITE_GEN_URL = 'http://sprite-gen.test';
const { app, __setSpriteGen, __setPool } = require('../src/index.js');

test('POST /api/sprite-jobs proxies to sprite-gen and records a row', async () => {
  __setSpriteGen({
    postGenerate: async () => ({ job_id: 'job-123' }),
    getJob: async () => ({ id: 'job-123', status: 'running' }),
  });
  __setPool({
    query: async () => ({
      rows: [{ id: 'row-1', creature: 'goblin', backend: 'stub', seed: 1, frames: 4, job_id: 'job-123', status: 'queued' }],
    }),
  });

  const res = await request(app)
    .post('/api/sprite-jobs')
    .send({ entity_type: 'goblin', base_prompt: 'a goblin', backend: 'stub', frames: 4, seed: 1 });

  assert.equal(res.status, 201);
  assert.ok(res.body.job_id === 'job-123');
  assert.ok(res.body.id === 'row-1');
});

test('GET /api/sprite-capability proxies the detected capability', async () => {
  __setSpriteGen({
    postGenerate: async () => ({}),
    getJob: async () => ({}),
    getCapability: async () => ({ device: 'cpu', cuda: false, tier: 'cpu', recommended_backend: 'sd-turbo' }),
  });
  __setPool({ query: async () => ({ rows: [] }) });

  const res = await request(app).get('/api/sprite-capability');
  assert.equal(res.status, 200);
  assert.equal(res.body.tier, 'cpu');
  assert.equal(res.body.recommended_backend, 'sd-turbo');
});

test('GET /api/sprite-capability returns 502 when the service is down', async () => {
  __setSpriteGen({
    postGenerate: async () => ({}),
    getJob: async () => ({}),
    getCapability: async () => { throw new Error('unreachable'); },
  });
  __setPool({ query: async () => ({ rows: [] }) });

  const res = await request(app).get('/api/sprite-capability');
  assert.equal(res.status, 502);
});

test('POST /api/sprite-jobs without backend auto-selects tier and records recipe backend', async () => {
  let sentBody = null;
  __setSpriteGen({
    getCapability: async () => ({ tier: 'gpu' }),
    postGenerate: async (body) => { sentBody = body; return { job_id: 'job-9', recipe: { tier: 'gpu', backend: 'sdxl', frames: 4 } }; },
    getJob: async () => ({}),
  });
  let insertedBackend = null;
  __setPool({
    query: async (_sql, params) => { insertedBackend = params[1]; return { rows: [{ id: 'row-9', job_id: 'job-9' }] }; },
  });

  const res = await request(app)
    .post('/api/sprite-jobs')
    .send({ entity_type: 'goblin', base_prompt: 'a goblin', seed: 3 });

  assert.equal(res.status, 201);
  assert.equal(sentBody.tier, 'gpu');        // tier auto-filled from capability
  assert.equal(insertedBackend, 'sdxl');     // DB row records the recipe backend
  assert.equal(res.body.recipe.backend, 'sdxl');
});

test('GET /api/sprite-jobs/:id proxies status', async () => {
  __setSpriteGen({ postGenerate: async () => ({}), getJob: async () => ({ status: 'done' }) });
  __setPool({ query: async () => ({ rows: [] }) });

  const res = await request(app).get('/api/sprite-jobs/job-123');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'done');
});

test('POST /api/entity-types/:id/sprite approves a sprite set and links it', async () => {
  __setSpriteGen({ postGenerate: async () => ({}), getJob: async () => ({}) });
  __setPool({
    query: async () => ({
      rows: [{ id: 'row-1', entity_type_id: 5, status: 'approved', atlas_key: 'atlas.png', manifest_key: 'manifest.json' }],
    }),
  });

  const res = await request(app)
    .post('/api/entity-types/5/sprite')
    .send({ atlas_key: 'atlas.png', manifest_key: 'manifest.json', backend: 'stub', seed: 1, job_id: 'job-123' });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'approved');
  assert.equal(res.body.entity_type_id, 5);
});

test('POST /api/entity-types/:id/sprite returns 404 when no row matches', async () => {
  __setSpriteGen({ postGenerate: async () => ({}), getJob: async () => ({}) });
  __setPool({ query: async () => ({ rows: [] }) });

  const res = await request(app)
    .post('/api/entity-types/5/sprite')
    .send({ atlas_key: 'atlas.png', manifest_key: 'manifest.json', backend: 'stub', seed: 1, job_id: 'missing' });

  assert.equal(res.status, 404);
});
