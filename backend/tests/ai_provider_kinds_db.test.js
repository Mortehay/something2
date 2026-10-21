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
    // Scoped to this test's own row: the real statement, minus other audio rows.
    await pool.query(`${BACKFILL_AUDIO_SQL} AND id = $1`, [audio.id]);
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
    // image_edit: refresh + Test run against /api/edit-capabilities; a 401 fails Test.
    let editStatus = 200;
    const editBox = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url.split('?')[0] === '/api/text/models') return res.end(JSON.stringify([{ value: 'm1' }]));
      if (req.url === '/api/edit-capabilities') {
        if (editStatus !== 200 || req.headers.authorization !== 'Bearer secret-k') {
          res.statusCode = editStatus === 200 ? 401 : editStatus; return res.end('{"error":"nope"}');
        }
        return res.end(JSON.stringify([null, 'pixelate']));
      }
      res.statusCode = 404; res.end('{}');
    });
    await new Promise((r) => editBox.listen(0, '127.0.0.1', r));
    try {
      await pool.query('UPDATE ai_providers SET base_url = $1 WHERE id = $2', [`http://127.0.0.1:${editBox.address().port}`, edit.body.id]);
      const er = await request(app).post(`/api/ai-providers/${edit.body.id}/refresh-models`).set('Authorization', auth);
      assert.equal(er.body.ok, true, JSON.stringify(er.body));
      assert.deepEqual(er.body.models, ['', 'pixelate']);
      const erow = (await pool.query('SELECT models_cache, discovery_cache FROM ai_providers WHERE id = $1', [edit.body.id])).rows[0];
      assert.deepEqual(erow.models_cache, ['', 'pixelate']);
      assert.deepEqual(erow.discovery_cache.entries.map((e) => e.id), ['', 'pixelate']);
      const et = await request(app).post(`/api/ai-providers/${edit.body.id}/test`).set('Authorization', auth);
      assert.equal(et.body.ok, true, JSON.stringify(et.body));
      assert.equal(JSON.stringify(et.body).includes('secret-k'), false);
      // a model the box no longer offers fails Test
      await pool.query("UPDATE ai_providers SET model = 'gone' WHERE id = $1", [edit.body.id]);
      const gone = await request(app).post(`/api/ai-providers/${edit.body.id}/test`).set('Authorization', auth);
      assert.equal(gone.body.ok, false);
      assert.match(gone.body.error, /provider no longer offers: gone/);
      await pool.query("UPDATE ai_providers SET model = '' WHERE id = $1", [edit.body.id]);
      editStatus = 401;
      const e401 = await request(app).post(`/api/ai-providers/${edit.body.id}/test`).set('Authorization', auth);
      assert.equal(e401.body.ok, false);
      assert.equal(e401.body.status, 401);
      // A failing edit-capabilities read must not wipe the previously cached list,
      // even though other box sources (/api/text/models) still answer.
      editStatus = 401;
      const before = (await pool.query('SELECT models_cache, discovery_cache FROM ai_providers WHERE id = $1', [edit.body.id])).rows[0];
      const fail = await request(app).post(`/api/ai-providers/${edit.body.id}/refresh-models`).set('Authorization', auth);
      assert.equal(fail.body.ok, false, JSON.stringify(fail.body));
      assert.equal(fail.body.status, 401);
      const afterFail = (await pool.query('SELECT models_cache, discovery_cache FROM ai_providers WHERE id = $1', [edit.body.id])).rows[0];
      assert.deepEqual(afterFail.models_cache, before.models_cache);
      assert.deepEqual(afterFail.discovery_cache, before.discovery_cache);
      assert.deepEqual(afterFail.models_cache, ['', 'pixelate']);
    } finally { editBox.close(); }
  });
});
