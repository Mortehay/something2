const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const spritePromptRoutes = require('../src/api/spritePromptRoutes.js');
const desc = require('../src/services/artPromptDescriptions.js');

// The Sprite tab's per-row prompt actions: Regenerate (one text-model call),
// an edit, and Revert. A fake describer only; never the box's /api/text.

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

const WOLF = 'sx_spr_wolf';
const FOX = 'sx_spr_fox';
const CRATE = 'sx_spr_crate';

let pool;
const wipe = () => pool.query("DELETE FROM art_prompt_descriptions WHERE subject_key LIKE 'sx_spr_%'");
test.before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: url, max: 4 });
  await wipe();
  await pool.query("DELETE FROM entity_types WHERE name LIKE 'sx_spr_%'");
  await pool.query(
    `INSERT INTO entity_types (name, color, is_creature, is_playable, prompt) VALUES
       ($1, '#123456', true, false, 'grey wolf'), ($2, '#123456', true, false, 'red fox'),
       ($3, '#123456', false, false, 'wooden crate')`,
    [WOLF, FOX, CRATE],
  );
});
test.after(async () => {
  if (skip) return;
  await wipe();
  await pool.query("DELETE FROM entity_types WHERE name LIKE 'sx_spr_%'");
  await pool.end();
});

function fakeDescriber({ busy = false, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    describeSubject: async (_db, subject, opts) => {
      calls.push({ subject, opts });
      if (busy) throw Object.assign(new Error('text service answered 503'), { busy: true });
      if (fail) throw new Error(fail);
      return { text: `lean ${subject.name} mid-stride`, model: 'fake-qwen' };
    },
  };
}

const allow = (_req, _res, next) => next();
function appWith({ describer = fakeDescriber(), guard = allow } = {}) {
  const app = express();
  app.use('/p', spritePromptRoutes(pool, guard, { describer }));
  return { app, describer };
}

test('POST regenerate writes a Sprite-tab version and answers the new prompt', { skip }, async () => {
  await wipe();
  const { app, describer } = appWith();
  const before = (await desc.listAll(pool, 'entity', WOLF)).length;
  const r = await request(app).post(`/p/entity/${WOLF}/regenerate`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, {
    kind: 'entity', key: WOLF, prompt: `lean ${WOLF} mid-stride`, source: 'description', model: 'fake-qwen',
  });
  assert.equal(describer.calls.length, 1, 'one attempt');
  assert.equal(describer.calls[0].opts.boxOnly, true);
  const all = await desc.listAll(pool, 'entity', WOLF);
  assert.equal(all.length, before + 1);
  assert.equal(all[0].origin, 'sprite');
  assert.equal(all[0].active, true);
});

test('a busy text model answers 409 "text model busy" and writes nothing', { skip }, async () => {
  await wipe();
  const { app, describer } = appWith({ describer: fakeDescriber({ busy: true }) });
  const r = await request(app).post(`/p/entity/${WOLF}/regenerate`);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'text model busy: text service answered 503');
  assert.equal(describer.calls.length, 1, 'no waiting, no retry');
  assert.equal((await desc.listAll(pool, 'entity', WOLF)).length, 0);
  const other = await request(appWith({ describer: fakeDescriber({ fail: 'describer returned nothing usable' }) }).app)
    .post(`/p/entity/${WOLF}/regenerate`);
  assert.equal(other.status, 502);
  assert.equal(other.body.error, 'describer returned nothing usable');
  assert.equal((await desc.listAll(pool, 'entity', WOLF)).length, 0);
});

test('PUT saves an edit as a new version; DELETE reverts to the template', { skip }, async () => {
  await wipe();
  const { app } = appWith();
  const put = await request(app).put(`/p/entity/${WOLF}`).send({ text: '  a hunched grey wolf  ' });
  assert.equal(put.status, 201, JSON.stringify(put.body));
  assert.deepEqual(put.body, { prompt: 'a hunched grey wolf', source: 'description' });
  const second = await request(app).put(`/p/entity/${WOLF}`).send({ text: 'a howling grey wolf' });
  assert.equal(second.status, 201);
  const all = await desc.listAll(pool, 'entity', WOLF);
  assert.equal(all.length, 2);
  assert.ok(all.every((d) => d.origin === 'sprite'));
  assert.equal((await desc.getActive(pool, 'entity', WOLF)).text, 'a howling grey wolf');

  const del = await request(app).delete(`/p/entity/${WOLF}`);
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, { cleared: true, prompt: 'grey wolf', source: 'template' });
  assert.equal(await desc.getActive(pool, 'entity', WOLF), null);
  assert.equal((await desc.listAll(pool, 'entity', WOLF)).length, 2, 'older versions stay readable');
  const again = await request(app).delete(`/p/entity/${WOLF}`);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { cleared: false, prompt: 'grey wolf', source: 'template' });
});

test('PUT refuses a 401-char prompt with 400 and stores nothing', { skip }, async () => {
  await wipe();
  const { app } = appWith();
  for (const text of ['x'.repeat(401), '   ', undefined]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await request(app).put(`/p/entity/${WOLF}`).send(text === undefined ? {} : { text });
    assert.equal(r.status, 400, JSON.stringify(text));
    assert.equal(r.body.error, 'prompt must be 1-400 characters');
  }
  assert.equal((await desc.listAll(pool, 'entity', WOLF)).length, 0);
  assert.equal((await request(app).put(`/p/entity/${WOLF}`).send({ text: 'y'.repeat(400) })).status, 201);
});

test('DELETE clears an opted-in subject\'s art-console description; a never-opted-in subject\'s is left alone', { skip }, async () => {
  await wipe();
  const { app } = appWith();
  // FOX was never touched from the Sprite tab: its sprite prompt is the template,
  // so Revert has nothing to revert and must not delete the art console's text.
  await desc.replace(pool, 'entity', FOX, { text: 'console fox', model: 'm' });
  const untouched = await request(app).delete(`/p/entity/${FOX}`);
  assert.equal(untouched.status, 200);
  assert.deepEqual(untouched.body, { cleared: false, prompt: 'red fox', source: 'template' });
  assert.equal((await desc.getActive(pool, 'entity', FOX)).text, 'console fox');
  // WOLF is opted in (a Sprite-tab version), and the art console wrote the active one since.
  await request(app).put(`/p/entity/${WOLF}`).send({ text: 'sprite wolf' });
  await desc.replace(pool, 'entity', WOLF, { text: 'console wolf', model: 'm' });
  const del = await request(app).delete(`/p/entity/${WOLF}`);
  assert.deepEqual(del.body, { cleared: true, prompt: 'grey wolf', source: 'template' });
  assert.equal(await desc.getActive(pool, 'entity', WOLF), null);
});

test('unknown kind 400, unknown subject 404, a prop entity 400', { skip }, async () => {
  await wipe();
  const { app, describer } = appWith();
  const kind = await request(app).post(`/p/item/${WOLF}/regenerate`);
  assert.equal(kind.status, 400);
  assert.equal(kind.body.error, 'unknown prompt kind');
  const missing = await request(app).post('/p/entity/sx_spr_nobody/regenerate');
  assert.equal(missing.status, 404);
  assert.equal((await request(app).put('/p/entity/sx_spr_nobody').send({ text: 'x' })).status, 404);
  assert.equal((await request(app).delete('/p/entity/sx_spr_nobody')).status, 404);
  assert.equal((await request(app).post('/p/vfx/not_an_effect/regenerate')).status, 404);
  for (const [m, body] of [['post', null], ['put', { text: 'a crate' }], ['delete', null]]) {
    const path = m === 'post' ? `/p/entity/${CRATE}/regenerate` : `/p/entity/${CRATE}`;
    // eslint-disable-next-line no-await-in-loop
    const r = await request(app)[m](path).send(body || undefined);
    assert.equal(r.status, 400, `${m} ${path}`);
    assert.equal(r.body.error, 'prompt regeneration is for creatures, heroes and effects');
  }
  assert.equal(describer.calls.length, 0);
  assert.equal((await desc.listAll(pool, 'entity', CRATE)).length, 0);
});

test('routes are admin-only', { skip }, async () => {
  await wipe();
  const { app, describer } = appWith({ guard: (_req, res) => res.status(403).json({ error: 'admin only' }) });
  for (const [m, p] of [['post', `/p/entity/${WOLF}/regenerate`], ['put', `/p/entity/${WOLF}`], ['delete', `/p/entity/${WOLF}`]]) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await request(app)[m](p).send({ text: 'x' })).status, 403, `${m} ${p}`);
  }
  assert.equal(describer.calls.length, 0);
  assert.equal((await desc.listAll(pool, 'entity', WOLF)).length, 0);
});
