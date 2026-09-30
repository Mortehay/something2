require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');
// The same singleton audioRoutes.js and audioPromptWriter.js both
// `require('../services/audioPrompts')` -- used below to force the
// conflict->409 mapping deterministically (see that test's own comment).
const audioPromptsSvc = require('../src/services/audioPrompts');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;

test('audio prompt routes', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  const tag = `apr-${process.pid}-${Date.now()}`;
  const seen = [];
  let textStatus = 200;
  const box = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/text') {
        res.statusCode = textStatus;
        if (textStatus !== 200) return res.end('{"detail":"nope"}');
        return res.end(JSON.stringify({ text: '', json: { style: 'village', prompt: 'gentle lute' }, model: 'qwen-instruct', ms: 5 }));
      }
      if (req.url.startsWith('/api/audio/styles')) {
        // Both a music and an ambience style: the ambience/write case below
        // exercises the text-model-failure path (textStatus flipped to
        // 400), which needs loadStyles() to find an ambience style to allow
        // through to that model call in the first place -- an ambience-less
        // fixture would fail earlier, on "no ambience styles known", with no
        // `via` at all.
        return res.end(JSON.stringify(req.url.includes('kind=sfx') ? [] : [
          { value: 'village', label: 'Village', kind: 'music', slots: {} },
          { value: 'wind', label: 'Wind', kind: 'ambience', slots: {} },
        ]));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => box.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${box.address().port}`;

  // Park any active audio/text providers for the test, restore after.
  const parked = (await pool.query(
    "UPDATE ai_providers SET is_active = false WHERE is_active AND modality IN ('audio', 'text') RETURNING id")).rows.map((r) => r.id);
  const provIds = (await pool.query(
    `INSERT INTO ai_providers (name, base_url, request_template, modality, is_active, auth_token, models_cache)
     VALUES ($1, $2, '{}', 'text', true, 'k', '[]'::jsonb), ($3, $2, '{}', 'audio', true, 'k', '["village"]'::jsonb) RETURNING id`,
    [`${tag}-t`, base, `${tag}-a`])).rows.map((r) => r.id);
  const worldId = (await pool.query('INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING id', [tag])).rows[0].id;
  const u = (await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id, username, role, token_version", [tag])).rows[0];
  const auth = `Bearer ${signToken({ userId: u.id, username: u.username, role: u.role, tokenVersion: u.token_version })}`;
  const pu = (await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id, username, role, token_version", [`${tag}-p`])).rows[0];
  const playerAuth = `Bearer ${signToken({ userId: pu.id, username: pu.username, role: pu.role, tokenVersion: pu.token_version })}`;
  // ONE cleanup hook: node:test runs t.after hooks in registration order, so
  // a second hook registered later would run against a closed pool.
  t.after(async () => {
    box.close();
    try {
      await pool.query('DELETE FROM audio_prompts WHERE subject_key = $1', [tag]);
      await pool.query('DELETE FROM ai_providers WHERE id = ANY($1)', [provIds]);
      if (parked.length) await pool.query('UPDATE ai_providers SET is_active = true WHERE id = ANY($1)', [parked]);
      await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [[u.id, pu.id]]);
    } finally { await pool.end(); }
  });
  const P = `/api/audio/admin/prompts/world/${encodeURIComponent(tag)}`;

  // write with the model
  const w = await request(app).post(`${P}/music/write`).set('Authorization', auth).send({ hint: 'sleepy' });
  assert.equal(w.status, 201, JSON.stringify(w.body));
  assert.deepEqual([w.body.style, w.body.text, w.body.via, w.body.hint], ['village', 'gentle lute', 'box', 'sleepy']);
  const sent = seen.find((s) => s.url === '/api/text').body;
  assert.match(sent.prompt, new RegExp(`world "${tag}"`));

  // read back: not stale
  let g = await request(app).get(P).set('Authorization', auth);
  assert.equal(g.body.music.active.id, w.body.id);
  assert.equal(g.body.music.stale, false);

  // hand edit with a style the box does not know -> 400
  const badStyle = await request(app).put(`${P}/music`).set('Authorization', auth)
    .send({ style: 'forrest', text: 'x', expect_active_id: w.body.id });
  assert.equal(badStyle.status, 400);
  assert.match(badStyle.body.error, /style/);

  // hand edit ok
  const put = await request(app).put(`${P}/music`).set('Authorization', auth)
    .send({ style: 'village', text: 'my own', expect_active_id: w.body.id });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual([put.body.text, put.body.model, put.body.via, put.body.source_input], ['my own', null, null, null]);

  // stale edit -> 409
  const stale = await request(app).put(`${P}/music`).set('Authorization', auth)
    .send({ style: 'village', text: 'late', expect_active_id: w.body.id });
  assert.equal(stale.status, 409);

  // subjects carries prompt state
  const subj = await request(app).get('/api/audio/admin/subjects').set('Authorization', auth);
  const worldGroup = subj.body.find((gr) => gr.kind === 'world');
  assert.equal(worldGroup.promptStates[tag].music, 'written');

  // model failure -> 502 with via, nothing stored
  textStatus = 400;
  const before = (await pool.query('SELECT count(*)::int n FROM audio_prompts WHERE subject_key = $1', [tag])).rows[0].n;
  const fail = await request(app).post(`${P}/ambience/write`).set('Authorization', auth).send({});
  assert.equal(fail.status, 502);
  assert.equal(fail.body.via, 'box');
  assert.equal((await pool.query('SELECT count(*)::int n FROM audio_prompts WHERE subject_key = $1', [tag])).rows[0].n, before);

  // write route conflict -> 409 (controller ruling, Task 6). Racing two real
  // concurrent writes to prove this would be flaky (timing-dependent on
  // whether both SELECT ... FOR UPDATE land before either COMMIT); instead
  // this forces writeSlotPrompt's store.save to hit the exact 409-throwing
  // path deterministically, by monkey-patching the shared audioPrompts
  // module object that audioRoutes.js and audioPromptWriter.js both hold a
  // reference to (CommonJS caches the module, so mutating the property here
  // is visible to both). textStatus is reset first so the model call itself
  // succeeds and save() is actually reached.
  textStatus = 200;
  const origSave = audioPromptsSvc.save;
  audioPromptsSvc.save = async () => {
    const e = new Error('this prompt was changed by someone else; reload it');
    e.status = 409;
    throw e;
  };
  try {
    const conflictWrite = await request(app).post(`${P}/music/write`).set('Authorization', auth).send({});
    assert.equal(conflictWrite.status, 409, JSON.stringify(conflictWrite.body));
    assert.match(conflictWrite.body.error, /changed by someone else/);
  } finally {
    audioPromptsSvc.save = origSave;
  }

  // unknown slot -> 400; non-admin -> 403
  assert.equal((await request(app).put(`${P}/nope`).set('Authorization', auth).send({ text: 'x' })).status, 400);
  assert.equal((await request(app).get(P).set('Authorization', playerAuth)).status, 403);
});
