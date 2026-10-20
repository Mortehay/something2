require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');
const aiProviders = require('../src/services/aiProviders.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;

test('sprite modality providers', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  const tag = `spr-${process.pid}-${Date.now()}`;
  const seen = [];
  const boxKey = { current: 'k' };
  const box = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    // Like the real box: the catalog is public, /api/jobs checks the key.
    if (req.url.startsWith('/api/jobs')) {
      if (req.headers.authorization !== `Bearer ${boxKey.current}`) { res.statusCode = 401; return res.end('{"detail":"bad key"}'); }
      return res.end('[]');
    }
    if (req.url === '/api/action-catalog') {
      return res.end(JSON.stringify({ actions: Array.from({ length: 7 }, (_, i) => ({ name: `a${i}` })) }));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => box.listen(0, '127.0.0.1', r));
  const u = (await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id, username, role, token_version", [tag])).rows[0];
  const auth = `Bearer ${signToken({ userId: u.id, username: u.username, role: u.role, tokenVersion: u.token_version })}`;
  t.after(async () => {
    box.close();
    try {
      await pool.query('DELETE FROM ai_providers WHERE name LIKE $1', [`${tag}%`]);
      await pool.query('DELETE FROM users WHERE id = $1', [u.id]);
    } finally { await pool.end(); }
  });

  const base = `http://127.0.0.1:${box.address().port}`;
  const created = await request(app).post('/api/ai-providers').set('Authorization', auth)
    .send({ name: tag, base_url: base, modality: 'sprite', auth_token: 'k' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.modality, 'sprite');
  assert.equal(JSON.stringify(created.body).includes('"k"'), false);

  const bad = await request(app).post('/api/ai-providers').set('Authorization', auth)
    .send({ name: `${tag}-bad`, base_url: 'http://x', modality: 'video' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /'image', 'audio', 'text' or 'sprite'/);

  const tested = await request(app).post(`/api/ai-providers/${created.body.id}/test`).set('Authorization', auth);
  assert.equal(tested.body.ok, true, JSON.stringify(tested.body));
  assert.match(tested.body.detail, /7 actions/);
  assert.ok(seen.some((c) => c.url === '/api/action-catalog' && c.auth === 'Bearer k'));
  assert.ok(seen.some((c) => c.url.startsWith('/api/jobs') && c.auth === 'Bearer k'), 'an authenticated read was made');
  assert.equal(JSON.stringify(tested.body).includes('"k"'), false);

  // The catalog is served without auth, so a stale key must still fail Test.
  boxKey.current = 'rotated';
  const stale = await request(app).post(`/api/ai-providers/${created.body.id}/test`).set('Authorization', auth);
  assert.equal(stale.body.ok, false, JSON.stringify(stale.body));
  assert.match(stale.body.error, /box rejected the key \(401\)/);
  assert.equal(JSON.stringify(stale.body).includes('"k"'), false);
  boxKey.current = 'k';

  const refreshed = await request(app).post(`/api/ai-providers/${created.body.id}/refresh-models`).set('Authorization', auth);
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.ok, false);
  assert.match(refreshed.body.error, /no model list/);

  // single active per modality: a second sprite provider takes over, image untouched.
  const second = await request(app).post('/api/ai-providers').set('Authorization', auth)
    .send({ name: `${tag}-2`, base_url: base, modality: 'sprite' });
  assert.equal(second.status, 201);
  assert.equal((await request(app).post(`/api/ai-providers/${created.body.id}/activate`).set('Authorization', auth)).status, 200);
  assert.equal((await aiProviders.loadActiveProviderWithSecret(pool, 'sprite')).id, created.body.id);
  assert.equal((await request(app).post(`/api/ai-providers/${second.body.id}/activate`).set('Authorization', auth)).status, 200);
  assert.equal((await aiProviders.loadActiveProviderWithSecret(pool, 'sprite')).id, second.body.id);
  const firstRow = (await pool.query('SELECT is_active FROM ai_providers WHERE id = $1', [created.body.id])).rows[0];
  assert.equal(firstRow.is_active, false);
});
