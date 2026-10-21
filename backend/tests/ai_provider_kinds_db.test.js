require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');
const { withAdvisoryLock, AI_PROVIDERS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const { BACKFILL_AUDIO_MODELS, BACKFILL_AUDIO_SQL } = require('../migrations/1714440823000_ai_provider_kinds_templates.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;

test('unified provider kinds', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  const tag = `kinds-${process.pid}-${Date.now()}`;
  const u = (await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id, username, role, token_version", [tag])).rows[0];
  const auth = `Bearer ${signToken({ userId: u.id, username: u.username, role: u.role, tokenVersion: u.token_version })}`;
  t.after(async () => {
    try {
      await pool.query('DELETE FROM ai_providers WHERE name LIKE $1', [`${tag}%`]);
      await pool.query('DELETE FROM users WHERE id = $1', [u.id]);
    } finally { await pool.end(); }
  });

  await withAdvisoryLock(pool, AI_PROVIDERS_LOCK_KEY, async () => {
    const edit = await request(app).post('/api/ai-providers').set('Authorization', auth)
      .send({ name: `${tag}-edit`, base_url: 'http://127.0.0.1:1', modality: 'image_edit', adapter: 'box', auth_token: 'secret-k' });
    assert.equal(edit.status, 201, JSON.stringify(edit.body));
    assert.equal(edit.body.modality, 'image_edit');
    assert.equal(edit.body.adapter, 'box');
    assert.equal('auth_token' in edit.body, false);

    const noModel = await request(app).post('/api/ai-providers').set('Authorization', auth)
      .send({ name: `${tag}-txt`, base_url: 'http://127.0.0.1:1', modality: 'text' });
    assert.equal(noModel.status, 400);
    assert.match(noModel.body.error, /needs a model/);

    const list = await request(app).get('/api/ai-providers').set('Authorization', auth);
    assert.equal(list.status, 200);
    assert.equal(JSON.stringify(list.body).includes('secret-k'), false);
    assert.equal(JSON.stringify(list.body).includes('auth_token'), false);

    // The migration's own backfill statement, on an audio row with NULL models.
    const audio = (await pool.query(
      `INSERT INTO ai_providers (name, base_url, request_template, modality, models_by_group)
       VALUES ($1, 'http://127.0.0.1:1', '{}', 'audio', NULL) RETURNING id`, [`${tag}-aud`])).rows[0];
    await pool.query(BACKFILL_AUDIO_SQL);
    const after = (await pool.query('SELECT models_by_group FROM ai_providers WHERE id = $1', [audio.id])).rows[0];
    assert.deepEqual(after.models_by_group, BACKFILL_AUDIO_MODELS);

    // Refresh writes discovery_cache; the legacy models_cache stays flat strings.
    const box = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      const path = req.url.split('?')[0];
      if (req.url === '/api/audio/styles') return res.end(JSON.stringify([{ value: 'orchestral', label: 'Orchestral' }]));
      if (req.url === '/api/audio/styles?kind=sfx') return res.end(JSON.stringify([{ value: 'hit', label: 'Hit' }]));
      if (path === '/api/model-gateway') return res.end(JSON.stringify({ choices: ['brain:q', 'audio:ace-step'] }));
      res.statusCode = 404; res.end('{}');
    });
    await new Promise((r) => box.listen(0, '127.0.0.1', r));
    try {
      await pool.query('UPDATE ai_providers SET base_url = $1 WHERE id = $2', [`http://127.0.0.1:${box.address().port}`, audio.id]);
      const refreshed = await request(app).post(`/api/ai-providers/${audio.id}/refresh-models`).set('Authorization', auth);
      assert.equal(refreshed.body.ok, true, JSON.stringify(refreshed.body));
      assert.deepEqual(refreshed.body.models, ['orchestral', 'cue:hit']);
      assert.deepEqual(refreshed.body.discovery.entries.filter((e) => e.kind === 'audio').map((e) => e.id), ['audio:ace-step']);
      const row = (await pool.query('SELECT models_cache, discovery_cache, discovery_fetched_at FROM ai_providers WHERE id = $1', [audio.id])).rows[0];
      assert.deepEqual(row.models_cache, ['orchestral', 'cue:hit']);
      assert.deepEqual(row.discovery_cache, refreshed.body.discovery);
      assert.ok(row.discovery_fetched_at);
    } finally { box.close(); }
  });
});
