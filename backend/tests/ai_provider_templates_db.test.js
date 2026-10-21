require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');
const { withAdvisoryLock, AI_PROVIDERS_LOCK_KEY } = require('./helpers/advisoryLock.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;

test('provider templates CRUD and save-as-template', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  const tag = `tpl-${process.pid}-${Date.now()}`;
  const u = (await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id, username, role, token_version", [tag])).rows[0];
  const auth = `Bearer ${signToken({ userId: u.id, username: u.username, role: u.role, tokenVersion: u.token_version })}`;
  t.after(async () => {
    try {
      await pool.query('DELETE FROM ai_provider_templates WHERE name LIKE $1', [`${tag}%`]);
      await pool.query('DELETE FROM ai_providers WHERE name LIKE $1', [`${tag}%`]);
      await pool.query('DELETE FROM users WHERE id = $1', [u.id]);
    } finally { await pool.end(); }
  });

  await withAdvisoryLock(pool, AI_PROVIDERS_LOCK_KEY, async () => {
    const create = await request(app).post('/api/ai-provider-templates').set('Authorization', auth)
      .send({ name: `${tag}-a`, modality: 'image', adapter: 'a1111', defaults: { base_url: 'http://127.0.0.1:1', model: 'm' } });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    assert.equal(create.body.builtin, false);

    const dup = await request(app).post('/api/ai-provider-templates').set('Authorization', auth)
      .send({ name: `${tag}-a`, modality: 'image' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, 'a template with that name exists');

    const tok = await request(app).post('/api/ai-provider-templates').set('Authorization', auth)
      .send({ name: `${tag}-t`, modality: 'image', defaults: { request_template: { auth_token: 'z' } } });
    assert.equal(tok.status, 400);

    const list = await request(app).get('/api/ai-provider-templates').set('Authorization', auth);
    assert.equal(list.status, 200);
    assert.ok(list.body.some((r) => r.id === create.body.id));

    const before = create.body.updated_at;
    await new Promise((r) => setTimeout(r, 15));
    const patch = await request(app).patch(`/api/ai-provider-templates/${create.body.id}`).set('Authorization', auth)
      .send({ description: 'edited' });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.description, 'edited');
    assert.ok(new Date(patch.body.updated_at) > new Date(before));
    assert.equal((await request(app).patch('/api/ai-provider-templates/99999999').set('Authorization', auth)
      .send({ description: 'x' })).status, 404);

    const secret = `secret-${tag}`;
    const prov = (await pool.query(
      `INSERT INTO ai_providers (name, base_url, request_template, modality, adapter, model, auth_token)
       VALUES ($1, 'http://127.0.0.1:1', '{}', 'image', 'a1111', 'mm', $2) RETURNING id`,
      [`${tag}-prov`, secret])).rows[0];
    const saved = await request(app).post(`/api/ai-providers/${prov.id}/save-as-template`).set('Authorization', auth)
      .send({ name: `${tag}-saved` });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.defaults.model, 'mm');
    assert.equal(JSON.stringify(saved.body).includes(secret), false);
    const stored = (await pool.query('SELECT * FROM ai_provider_templates WHERE id = $1', [saved.body.id])).rows[0];
    assert.equal(JSON.stringify(stored).includes(secret), false);

    assert.equal((await request(app).post(`/api/ai-providers/${prov.id}/save-as-template`).set('Authorization', auth)
      .send({ name: `${tag}-saved` })).status, 409);
    assert.equal((await request(app).post('/api/ai-providers/99999999/save-as-template').set('Authorization', auth)
      .send({ name: `${tag}-nope` })).status, 404);

    assert.equal((await request(app).delete(`/api/ai-provider-templates/${create.body.id}`).set('Authorization', auth)).status, 204);
    assert.equal((await request(app).delete(`/api/ai-provider-templates/${create.body.id}`).set('Authorization', auth)).status, 404);
  });
});
