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
