require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;

test('text modality providers', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  const tag = `txt-${process.pid}-${Date.now()}`;
  const seen = [];
  const box = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/text/models') return res.end(JSON.stringify([{ value: 'qwen-instruct', label: 'Qwen', loaded: false }]));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => box.listen(0, '127.0.0.1', r));
  const u = (await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id, username, role, token_version", [tag])).rows[0];
  const auth = `Bearer ${signToken({ userId: u.id, username: u.username, role: u.role, tokenVersion: u.token_version })}`;
  t.after(async () => {
    box.close();
    try {
      await pool.query('DELETE FROM ai_providers WHERE name = $1', [tag]);
      await pool.query('DELETE FROM users WHERE id = $1', [u.id]);
    } finally { await pool.end(); }
  });

  const created = await request(app).post('/api/ai-providers').set('Authorization', auth)
    .send({ name: tag, base_url: `http://127.0.0.1:${box.address().port}`, modality: 'text', auth_token: 'k' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.modality, 'text');

  const bad = await request(app).post('/api/ai-providers').set('Authorization', auth)
    .send({ name: `${tag}-bad`, base_url: 'http://x', modality: 'video' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /'image', 'audio' or 'text'/);

  const refreshed = await request(app).post(`/api/ai-providers/${created.body.id}/refresh-models`).set('Authorization', auth);
  assert.deepEqual({ ok: refreshed.body.ok, models: refreshed.body.models }, { ok: true, models: ['qwen-instruct'] });
  assert.equal(seen.at(-1).url, '/api/text/models');
  assert.equal(seen.at(-1).auth, 'Bearer k', 'refresh must hit the authenticated text endpoint');

  const tested = await request(app).post(`/api/ai-providers/${created.body.id}/test`).set('Authorization', auth);
  assert.equal(tested.body.ok, true);
  assert.equal(seen.at(-1).url, '/api/text/models', 'test must not certify the unauthenticated root');
  assert.equal(JSON.stringify(tested.body).includes('"k"'), false);
});
