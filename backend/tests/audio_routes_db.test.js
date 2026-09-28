// backend/tests/audio_routes_db.test.js
//
// Real-HTTP, real-DB coverage for the audio routes (SOMET-590, game audio
// slice 1). The box is a local http.createServer that serves the fixture, so
// the real safeFetch -> generateTrack path is exercised end to end: the box
// token is only ever sent server-side and never appears in a JSON response.
require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');
const assetStore = require('../src/services/assetStore');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;
const OGG = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.ogg'));

async function makeUser(pool, role, tag) {
  const username = `audio-${role}-${tag}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version',
    [username, 'x', role]);
  return { id: r.rows[0].id, username, role, tokenVersion: r.rows[0].token_version };
}
const bearer = (u) => `Bearer ${signToken({ userId: u.id, username: u.username, role: u.role, tokenVersion: u.tokenVersion })}`;

test('audio routes', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  assetStore.__setAssetClient({ bucketExists: async () => true, putObject: async () => {} });
  const tag = `${process.pid}-${Date.now()}`;
  const worldName = `audio-route-world-${tag}`;
  const made = { users: [], providers: [], worlds: [] };
  const seen = [];
  const box = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.method === 'POST' && req.url === '/api/audio') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ audio: [OGG.toString('base64')], info: { sample_rate: 44100, loop_start: 0, loop_end: 88200, prompt: 'forest', seed: 11 } }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => box.listen(0, '127.0.0.1', r));
  const boxUrl = `http://127.0.0.1:${box.address().port}`;

  t.after(async () => {
    try {
      await pool.query(`DELETE FROM audio_clips WHERE id IN (SELECT clip_id FROM audio_bindings WHERE subject_key = $1)`, [worldName]);
      await pool.query('DELETE FROM audio_misses WHERE subject_key = $1', [worldName]);
      if (made.worlds.length) await pool.query('DELETE FROM worlds WHERE id = ANY($1)', [made.worlds]);
      if (made.providers.length) await pool.query('DELETE FROM ai_providers WHERE id = ANY($1)', [made.providers]);
      if (made.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users]);
    } finally { box.close(); await pool.end(); }
  });

  const admin = await makeUser(pool, 'admin', tag);
  const player = await makeUser(pool, 'player', tag);
  made.users.push(admin.id, player.id);
  const worldId = (await pool.query(`INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING id`, [worldName])).rows[0].id;
  made.worlds.push(worldId);
  const prov = (await pool.query(
    `INSERT INTO ai_providers (name, base_url, request_template, modality, auth_token)
     VALUES ($1, $2, '{}'::jsonb, 'audio', 'sk_route_test') RETURNING id`, [`audio-route-${tag}`, boxUrl])).rows[0].id;
  made.providers.push(prov);

  await t.test('admin routes reject a player (403) and anonymous (401)', async () => {
    assert.equal((await request(app).get('/api/audio/admin/subjects').set('Authorization', bearer(player))).status, 403);
    assert.equal((await request(app).get('/api/audio/admin/subjects')).status, 401);
  });

  await t.test('generate stores, binds, and uses the provider token', async () => {
    const res = await request(app).post('/api/audio/admin/generate').set('Authorization', bearer(admin))
      .send({ subject_kind: 'world', subject_key: worldName, slot: 'music', style: 'village', provider_id: prov });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.clip.kind, 'music');
    assert.equal(res.body.clip.loop_end_ms, 2000);
    const sent = seen.find((s) => s.url === '/api/audio');
    assert.equal(sent.auth, 'Bearer sk_route_test');
    assert.ok(Number.isInteger(JSON.parse(sent.body).seed), 'a seed is always sent');
    assert.equal(JSON.stringify(res.body).includes('sk_route_test'), false, 'the token never leaves the server');
  });

  await t.test('generate rejects a slot the subject does not have', async () => {
    const res = await request(app).post('/api/audio/admin/generate').set('Authorization', bearer(admin))
      .send({ subject_kind: 'biome', subject_key: 'x', slot: 'music', provider_id: prov });
    assert.equal(res.status, 400);
  });

  await t.test('upload accepts OGG and rejects anything else', async () => {
    const q = `subject_kind=world&subject_key=${encodeURIComponent(worldName)}&slot=ambience&label=up`;
    const ok = await request(app).post(`/api/audio/admin/upload?${q}`).set('Authorization', bearer(admin))
      .set('Content-Type', 'audio/ogg').send(OGG);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const bad = await request(app).post(`/api/audio/admin/upload?${q}`).set('Authorization', bearer(admin))
      .set('Content-Type', 'audio/ogg').send(Buffer.from('RIFF....WAVEfmt '));
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /not an OGG/i);
  });

  await t.test('player bundle + misses', async () => {
    const b = await request(app).get(`/api/audio/world/${worldId}`).set('Authorization', bearer(player));
    assert.equal(b.status, 200);
    assert.equal(b.body.world, worldName);
    assert.equal(b.body.bindings[`world/${worldName}/music`].length, 1);
    assert.equal(b.body.bindings[`world/${worldName}/ambience`].length, 1);
    const m = await request(app).post('/api/audio/misses').set('Authorization', bearer(player))
      .send({ misses: [{ subject_kind: 'biome', subject_key: worldName, slot: 'ambience', world: worldName }] });
    assert.equal(m.status, 200);
    assert.equal(m.body.accepted, 1);
  });

  await t.test('.ogg assets are served as audio/ogg', async () => {
    const { Readable } = require('node:stream');
    assetStore.__setAssetClient({ getObject: async () => Readable.from([OGG]) });
    const res = await request(app).get('/api/assets/audio/music/x.ogg');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /audio\/ogg/);
  });
});
