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
  const ghostWorld = `audio-route-ghost-${tag}`;
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
      if (req.method === 'POST' && req.url === '/api/audio/propose') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ kind: 'music', style: 'village', slots: { mood: 'calm and sunny' }, prompt: 'p' }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => box.listen(0, '127.0.0.1', r));
  const boxUrl = `http://127.0.0.1:${box.address().port}`;

  t.after(async () => {
    try {
      await pool.query(`DELETE FROM audio_clips WHERE id IN (SELECT clip_id FROM audio_bindings WHERE subject_key IN ($1, $2))`, [worldName, ghostWorld]);
      await pool.query('DELETE FROM audio_misses WHERE subject_key IN ($1, $2)', [worldName, ghostWorld]);
      if (made.worlds.length) await pool.query('DELETE FROM worlds WHERE id = ANY($1)', [made.worlds]);
      if (made.providers.length) await pool.query('DELETE FROM ai_providers WHERE id = ANY($1)', [made.providers]);
      if (made.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users]);
    } finally { box.close(); await pool.end(); }
  });

  const admin = await makeUser(pool, 'admin', tag);
  made.users.push(admin.id);
  const player = await makeUser(pool, 'player', tag);
  made.users.push(player.id);
  const worldId = (await pool.query(`INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING id`, [worldName])).rows[0].id;
  made.worlds.push(worldId);
  const prov = (await pool.query(
    `INSERT INTO ai_providers (name, base_url, request_template, modality, auth_token)
     VALUES ($1, $2, '{}'::jsonb, 'audio', 'sk_route_test') RETURNING id`, [`audio-route-${tag}`, boxUrl])).rows[0].id;
  made.providers.push(prov);
  const imageProv = (await pool.query(
    `INSERT INTO ai_providers (name, base_url, request_template, modality, auth_token)
     VALUES ($1, $2, '{}'::jsonb, 'image', 'sk_route_image') RETURNING id`, [`image-route-${tag}`, boxUrl])).rows[0].id;
  made.providers.push(imageProv);

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

  await t.test('generate/propose/upload refuse a subject that does not exist (400, box never called)', async () => {
    const before = seen.length;
    const gen = await request(app).post('/api/audio/admin/generate').set('Authorization', bearer(admin))
      .send({ subject_kind: 'world', subject_key: ghostWorld, slot: 'music', provider_id: prov });
    assert.equal(gen.status, 400, JSON.stringify(gen.body));
    assert.equal(gen.body.error, 'unknown subject');
    const prop = await request(app).post('/api/audio/admin/propose').set('Authorization', bearer(admin))
      .send({ subject_kind: 'world', subject_key: ghostWorld, slot: 'music', provider_id: prov });
    assert.equal(prop.status, 400, JSON.stringify(prop.body));
    assert.equal(prop.body.error, 'unknown subject');
    const up = await request(app)
      .post(`/api/audio/admin/upload?subject_kind=world&subject_key=${encodeURIComponent(ghostWorld)}&slot=music`)
      .set('Authorization', bearer(admin)).set('Content-Type', 'audio/ogg').send(OGG);
    assert.equal(up.status, 400, JSON.stringify(up.body));
    assert.equal(up.body.error, 'unknown subject');
    assert.equal(seen.length, before, 'no box call for an unknown subject');
    const rows = await pool.query('SELECT 1 FROM audio_bindings WHERE subject_key = $1', [ghostWorld]);
    assert.equal(rows.rowCount, 0);
  });

  await t.test('non-string / repeated / over-long subject fields are 400, not a crash', async () => {
    const q = `subject_kind=world&subject_key=${encodeURIComponent(worldName)}&slot=music&slot=music`;
    const dup = await request(app).post(`/api/audio/admin/upload?${q}`).set('Authorization', bearer(admin))
      .set('Content-Type', 'audio/ogg').send(OGG).timeout(5000);
    assert.equal(dup.status, 400, JSON.stringify(dup.body));
    const arr = await request(app).post('/api/audio/admin/generate').set('Authorization', bearer(admin))
      .send({ subject_kind: ['world'], subject_key: worldName, slot: 'music', provider_id: prov }).timeout(5000);
    assert.equal(arr.status, 400, JSON.stringify(arr.body));
    const long = await request(app).post('/api/audio/admin/generate').set('Authorization', bearer(admin))
      .send({ subject_kind: 'world', subject_key: 'w'.repeat(201), slot: 'music', provider_id: prov }).timeout(5000);
    assert.equal(long.status, 400, JSON.stringify(long.body));
  });

  await t.test('prototype-key subject kinds are 400, not a hung request', async () => {
    for (const route of ['generate', 'propose']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).post(`/api/audio/admin/${route}`).set('Authorization', bearer(admin))
        .send({ subject_kind: 'constructor', subject_key: worldName, slot: 'music', provider_id: prov }).timeout(5000);
      assert.equal(res.status, 400, `${route}: ${JSON.stringify(res.body)}`);
    }
    const up = await request(app)
      .post(`/api/audio/admin/upload?subject_kind=__proto__&subject_key=x&slot=constructor`)
      .set('Authorization', bearer(admin)).set('Content-Type', 'audio/ogg').send(OGG).timeout(5000);
    assert.equal(up.status, 400, JSON.stringify(up.body));
  });

  await t.test('generate with an IMAGE provider id is 503 -- audio never uses an image provider', async () => {
    const before = seen.length;
    const res = await request(app).post('/api/audio/admin/generate').set('Authorization', bearer(admin))
      .send({ subject_kind: 'world', subject_key: worldName, slot: 'music', provider_id: imageProv });
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(seen.length, before, 'the image provider was never called');
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

  await t.test('admin/subjects reports filled slot counts per subject', async () => {
    // The world has one bound clip in `music` (the generate test above) and
    // one in `ambience` (the upload test above). Bind a SECOND music clip so
    // the world holds three clips in two DISTINCT slots: a naive COUNT(*)
    // would report 3 here, COUNT(DISTINCT slot) reports 2.
    const second = await request(app)
      .post(`/api/audio/admin/upload?subject_kind=world&subject_key=${encodeURIComponent(worldName)}&slot=music&label=second`)
      .set('Authorization', bearer(admin)).set('Content-Type', 'audio/ogg').send(OGG);
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const clips = await pool.query('SELECT 1 FROM audio_bindings WHERE subject_kind = $1 AND subject_key = $2', ['world', worldName]);
    assert.equal(clips.rowCount, 3, 'precondition: three clips bound across two slots');
    const res = await request(app).get('/api/audio/admin/subjects').set('Authorization', bearer(admin));
    assert.equal(res.status, 200);
    const worldGroup = res.body.find((g) => g.kind === 'world');
    assert.ok(worldGroup, 'no world group in the response');
    assert.ok(worldGroup.subjects.includes(worldName), 'subjects must still be a plain array of names');
    assert.equal(worldGroup.filled[worldName], 2);
  });

  // Game audio slice 3, Task 2 review round 2: every group's `cues` field
  // (when present) is read the SAME way by the route -- def.subjectCues(pool)
  // -- with no per-kind switch (see audioRoutes.js's comment above the
  // handler). This asserts the actual response shape rather than just the
  // registry function directly, so a route-level regression (wrong field
  // name, wrong kind switched on, a kind silently dropped) would be caught
  // here even if audioSubjects.js's own unit coverage stayed green.
  await t.test('admin/subjects cues: uniform shape, one field, no per-kind switch', async () => {
    const res = await request(app).get('/api/audio/admin/subjects').set('Authorization', bearer(admin));
    assert.equal(res.status, 200);
    const byKind = Object.fromEntries(res.body.map((g) => [g.kind, g]));

    assert.equal(byKind.world.cues, undefined, 'world has no sfx slots -- no cues field at all');
    assert.equal(byKind.biome.cues, undefined, 'biome has no sfx slots -- no cues field at all');

    assert.ok(byKind.creature.cues, 'creature group is missing cues');
    assert.deepEqual(byKind.creature.cues.Slime, {
      nearby: null, attack: null, hurt: 'hit', death: 'death',
    });

    assert.ok(byKind.attack_type.cues, 'attack_type group is missing cues');
    assert.deepEqual(byKind.attack_type.cues.ranged, { use: null, hit: 'hit' });

    assert.ok(byKind.item.cues, 'item group is missing cues');
    assert.deepEqual(byKind.item.cues['crude-bow'], { use: null, hit: 'hit' },
      'a gear-ladder bow (no ammo_type_id on the row) still resolves ranged via the name fallback');

    assert.ok(byKind.skill.cues, 'skill group is missing cues');
    assert.equal(byKind.skill.cues.war_crushing_blow.use, 'slash');
  });

  await t.test('player bundle + misses', async () => {
    const b = await request(app).get(`/api/audio/world/${worldId}`).set('Authorization', bearer(player));
    assert.equal(b.status, 200);
    assert.equal(b.body.world, worldName);
    assert.equal(b.body.bindings[`world/${worldName}/music`].length, 2);
    assert.equal(b.body.bindings[`world/${worldName}/ambience`].length, 1);
    const m = await request(app).post('/api/audio/misses').set('Authorization', bearer(player))
      .send({ misses: [{ subject_kind: 'world', subject_key: worldName, slot: 'ambience', world: worldName }] });
    assert.equal(m.status, 200);
    assert.equal(m.body.accepted, 1);
  });

  await t.test('generate with no style and no prompt proposes first, then generates with the proposed style', async () => {
    const before = seen.length;
    const res = await request(app).post('/api/audio/admin/generate').set('Authorization', bearer(admin))
      .send({ subject_kind: 'world', subject_key: worldName, slot: 'music', provider_id: prov });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const calls = seen.slice(before).filter((s) => s.method === 'POST' && (s.url === '/api/audio/propose' || s.url === '/api/audio'));
    assert.deepEqual(calls.map((c) => c.url), ['/api/audio/propose', '/api/audio'], 'propose is called before generate');
    assert.equal(JSON.parse(calls[1].body).style, 'village', 'the generate call carries the proposed style');
    assert.equal(res.body.clip.style_or_cue, 'village');
    assert.match(res.body.clip.label, /\(village\)$/, 'the stored label carries the proposed style');
  });

  await t.test('a miss for a world that does not exist is dropped (accepted 0, no row)', async () => {
    const m = await request(app).post('/api/audio/misses').set('Authorization', bearer(player))
      .send({ misses: [{ subject_kind: 'world', subject_key: ghostWorld, slot: 'music', world: ghostWorld }] });
    assert.equal(m.status, 200);
    assert.equal(m.body.accepted, 0);
    const rows = await pool.query('SELECT 1 FROM audio_misses WHERE subject_key = $1', [ghostWorld]);
    assert.equal(rows.rowCount, 0);
  });

  await t.test('.ogg assets are served as audio/ogg', async () => {
    const { Readable } = require('node:stream');
    assetStore.__setAssetClient({ getObject: async () => Readable.from([OGG]) });
    const res = await request(app).get('/api/assets/audio/music/x.ogg');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /audio\/ogg/);
  });
});
