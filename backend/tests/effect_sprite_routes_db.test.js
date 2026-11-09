const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const effectSpriteRoutes = require('../src/api/effectSpriteRoutes.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;
const LOCK = 8472001; // shared with the other effect test files

let pool; let lockClient;
test.before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: url });
  lockClient = await pool.connect();
  await lockClient.query('SELECT pg_advisory_lock($1)', [LOCK]);
});
test.after(async () => {
  if (skip) return;
  await pool.query('DELETE FROM effect_sprite_jobs');
  await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK]);
  lockClient.release();
  await pool.end();
});

const allow = (_req, _res, next) => next();
function appWith(guard = allow) {
  const d = { kicks: 0, kick() { this.kicks += 1; return Promise.resolve(); }, status: () => ({ running: false, currentId: null }) };
  const app = express();
  app.use('/fx', effectSpriteRoutes(pool, guard, d));
  return { app, d };
}
const clean = () => pool.query('DELETE FROM effect_sprite_jobs');

test('GET / lists the 21 batch-1 subjects with default prompts and the box-measured eta', { skip }, async () => {
  await clean();
  const { app } = appWith();
  const r = await request(app).get('/fx');
  assert.equal(r.status, 200);
  assert.equal(r.body.subjects.length, 21);
  const pl = r.body.subjects.find((s) => s.name === 'pack_leader');
  assert.equal(pl.default_prompt, 'pack leader, gold');
  assert.deepEqual(r.body.eta.aura, { low: 35.2, typical: 35.2, high: 114.2 });
  assert.deepEqual(r.body.eta.burst, { low: 46.2, typical: 46.2, high: 114.2 });
  assert.deepEqual(r.body.dispatcher, { running: false, currentId: null });
});

test('POST /jobs queues one row per target and kicks the dispatcher once', { skip }, async () => {
  await clean();
  const { app, d } = appWith();
  const r = await request(app).post('/fx/jobs').send({ targets: [
    { subject_kind: 'aura', name: 'pack_leader' }, { subject_kind: 'vfx', name: 'bolt_fire', prompt: 'a fire bolt' }] });
  assert.equal(r.status, 202);
  assert.equal(r.body.queued.length, 2);
  assert.equal(d.kicks, 1);
  const { rows } = await pool.query('SELECT subject_name, prompt FROM effect_sprite_jobs ORDER BY subject_name');
  assert.deepEqual(rows, [{ subject_name: 'bolt_fire', prompt: 'a fire bolt' }, { subject_name: 'pack_leader', prompt: 'pack leader, gold' }]);
});

test('POST /jobs twice for one subject: the second answers skipped already queued and no second row exists', { skip }, async () => {
  await clean();
  const { app } = appWith();
  const body = { targets: [{ subject_kind: 'vfx', name: 'bolt_ice' }] };
  await request(app).post('/fx/jobs').send(body);
  const r = await request(app).post('/fx/jobs').send(body);
  assert.equal(r.status, 202);
  assert.equal(r.body.queued.length, 0);
  assert.equal(r.body.skipped[0].reason, 'already queued');
  assert.equal((await pool.query('SELECT 1 FROM effect_sprite_jobs')).rowCount, 1);
});

test('POST /jobs rejects a non-batch-1 name (400) and a 1001-char prompt (400)', { skip }, async () => {
  await clean();
  const { app, d } = appWith();
  const a = await request(app).post('/fx').send({});
  assert.equal(a.status, 404);
  const empty = await request(app).post('/fx/jobs').send({ targets: [] });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, 'targets must be a non-empty list');
  const bad = await request(app).post('/fx/jobs').send({ targets: [{ subject_kind: 'vfx', name: 'nope' }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'nope is not a batch-1 effect');
  const long = await request(app).post('/fx/jobs').send({ targets: [{ subject_kind: 'vfx', name: 'bolt_fire', prompt: 'x'.repeat(1001) }] });
  assert.equal(long.status, 400);
  assert.equal(long.body.error, 'prompt must be 1-1000 characters');
  assert.equal((await pool.query('SELECT 1 FROM effect_sprite_jobs')).rowCount, 0);
  assert.equal(d.kicks, 0);
});

test('approve -> GET / shows the sprite on the subject', { skip }, async () => {
  await clean();
  const { app } = appWith();
  const q = await request(app).post('/fx/jobs').send({ targets: [{ subject_kind: 'aura', name: 'shade_veil' }] });
  const id = q.body.queued[0].id;
  assert.equal((await request(app).post('/fx/jobs/abc/approve')).status, 400);
  assert.equal((await request(app).post(`/fx/jobs/${id}/approve`)).status, 409); // still queued
  await pool.query(`UPDATE effect_sprite_jobs SET status='done', image_key='fx/shade_veil.png',
    atlas='{"frames":8,"fps_hint":10}'::jsonb WHERE id=$1`, [id]);
  const ok = await request(app).post(`/fx/jobs/${id}/approve`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.sprite.image, 'fx/shade_veil.png');
  const g = await request(app).get('/fx');
  const s = g.body.subjects.find((x) => x.name === 'shade_veil');
  assert.equal(s.sprite.image, 'fx/shade_veil.png');
  assert.equal(s.sprite.frames, 8);
  assert.equal(s.job.status, 'approved');
  await pool.query(`UPDATE aura_effects SET sprite_image=NULL, sprite_frames=1, sprite_additive=false, sprite_fps=NULL WHERE name='shade_veil'`);
});

test('POST /dispatch kicks; routes are admin-only', { skip }, async () => {
  const { app, d } = appWith();
  assert.deepEqual((await request(app).post('/fx/dispatch')).body, { running: true });
  assert.equal(d.kicks, 1);
  const deny = appWith((_req, res) => res.status(403).json({ error: 'admin only' }));
  for (const [m, p] of [['get', '/fx'], ['post', '/fx/jobs'], ['post', '/fx/jobs/1/approve'], ['post', '/fx/dispatch']]) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await request(deny.app)[m](p)).status, 403, `${m} ${p}`);
  }
  assert.equal(deny.d.kicks, 0);
});
