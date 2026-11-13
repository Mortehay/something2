// Image shrink Task 5: batch runner + admin routes. Private test DB, fake object store,
// mini express app. Never the dev DB or a real store.
require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');
const { Pool } = require('pg');
const { signToken } = require('../src/auth/tokens.js');
const imageVariantRoutes = require('../src/api/imageVariantRoutes.js');
const runner = require('../src/services/imageShrinkRun.js');
const { invalidateServeMap } = require('../src/services/imageVariants.js');
const { privateTestDb } = require('./helpers/privateTestDb.js');

const { url: DB_URL, skip: SKIP } = privateTestDb();
const PREFIX = 'imgshrink-t5-';
const NAMES = [1, 2, 3].map((i) => `${PREFIX}e${i}`);

function fakeStore(objects) {
  const store = {
    objects: new Map(objects),
    gate: null, // { key, promise }: readObject(key) waits for it
    async statObject(key) {
      const b = store.objects.get(key);
      return b ? { size: b.length, etag: crypto.createHash('md5').update(b).digest('hex') } : null;
    },
    async readObject(key) {
      if (store.gate && store.gate.key === key) await store.gate.promise;
      if (!store.objects.has(key)) { const e = new Error(`no key ${key}`); e.code = 'NoSuchKey'; throw e; }
      return store.objects.get(key);
    },
    async putObject(key, buffer) { store.objects.set(key, buffer); return key; },
    async objectExists(key) { return store.objects.has(key); },
  };
  return store;
}
const noisePng = (w, h) => sharp(crypto.randomBytes(w * h * 4), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();

let pool; let admin; let player; let store;
const users = [];

async function makeUser(role) {
  const username = `t5-${role}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version', [username, 'x', role]);
  users.push(r.rows[0].id);
  return { id: r.rows[0].id, auth: `Bearer ${signToken({ userId: r.rows[0].id, username, role, tokenVersion: r.rows[0].token_version })}` };
}
const app = () => { const a = express(); a.use(express.json()); a.use('/api/admin/images', imageVariantRoutes(pool, { store })); return a; };
const subj = (i) => ({ table: 'entity_types', key: NAMES[i], column: 'image' });

async function cleanup() {
  await pool.query('DELETE FROM image_operations WHERE subject_key LIKE $1', [`${PREFIX}%`]);
  await pool.query('DELETE FROM image_variants WHERE subject_key LIKE $1', [`${PREFIX}%`]);
  await pool.query('DELETE FROM entity_types WHERE name LIKE $1', [`${PREFIX}%`]);
}
// 3 entity rows; the middle one's original is absent from the store when `missingMiddle`.
async function fixture({ missingMiddle = false } = {}) {
  await cleanup();
  runner.resetForTests();
  invalidateServeMap();
  store = fakeStore([]);
  for (let i = 0; i < 3; i++) {
    const key = `t5/${i}.png`;
    if (!(missingMiddle && i === 1)) store.objects.set(key, await noisePng(500, 400));
    await pool.query(`INSERT INTO entity_types (name, color, image) VALUES ($1, '#000000', $2)`, [NAMES[i], key]);
  }
}
async function waitDone() {
  for (let i = 0; i < 200; i++) {
    const v = runner.getRun();
    if (v && v.status !== 'running') return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('run did not finish');
}

test.before(async () => {
  if (!DB_URL) return;
  pool = new Pool({ connectionString: DB_URL, max: 3 });
  admin = await makeUser('admin');
  player = await makeUser('player');
});
test.after(async () => {
  if (!pool) return;
  await cleanup();
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [users]);
  await pool.end();
});
const needDb = (name, fn) => test(name, async (t) => { if (SKIP) return t.skip(SKIP); return fn(t); });

needDb('non-admin gets 403 on every route', async () => {
  const a = app();
  const calls = [
    ['get', '/api/admin/images'], ['get', '/api/admin/images/kinds'], ['post', '/api/admin/images/runs'],
    ['get', '/api/admin/images/runs/current'], ['post', '/api/admin/images/runs/current/cancel'],
    ['post', '/api/admin/images/reactivate'], ['get', '/api/admin/images/operations'],
  ];
  for (const [m, p] of calls) {
    assert.equal((await request(a)[m](p).set('Authorization', player.auth)).status, 403, `${m} ${p}`);
  }
});

needDb('GET /kinds lists kinds with defaults', async () => {
  const r = await request(app()).get('/api/admin/images/kinds').set('Authorization', admin.auth);
  assert.equal(r.status, 200);
  const e = r.body.find((k) => k.kind === 'entity');
  assert.deepEqual(e.defaults, { maxEdge: 256, quality: 85 });
});

needDb('batch continues past a bad row', async () => {
  await fixture({ missingMiddle: true });
  const a = app();
  const r = await request(a).post('/api/admin/images/runs').set('Authorization', admin.auth)
    .send({ op: 'shrink', subjects: [0, 1, 2].map(subj) });
  assert.equal(r.status, 201);
  const batch = r.body.id;
  const v = await waitDone();
  assert.equal(v.status, 'done');
  assert.equal(v.done, 3);
  assert.equal(v.failed, 1);
  const ops = (await request(a).get(`/api/admin/images/operations?batch_id=${batch}`).set('Authorization', admin.auth)).body;
  assert.equal(ops.length, 3);
  assert.equal(ops.filter((o) => o.status === 'ok').length, 2);
  assert.equal(ops.filter((o) => o.status === 'failed').length, 1);
  assert.ok(ops.every((o) => o.batch_id === batch && o.actor === admin.id));
});

needDb('second run while running is 409; cancel stops before the next subject', async () => {
  await fixture();
  let release;
  store.gate = { key: 't5/0.png', promise: new Promise((r) => { release = r; }) };
  const a = app();
  const first = await request(a).post('/api/admin/images/runs').set('Authorization', admin.auth)
    .send({ op: 'shrink', subjects: [0, 1, 2].map(subj) });
  assert.equal(first.status, 201);
  const second = await request(a).post('/api/admin/images/runs').set('Authorization', admin.auth)
    .send({ op: 'shrink', subjects: [subj(2)] });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'run in progress');
  const cur = await request(a).get('/api/admin/images/runs/current').set('Authorization', admin.auth);
  assert.equal(cur.body.status, 'running');
  assert.equal((await request(a).post('/api/admin/images/runs/current/cancel').set('Authorization', admin.auth)).status, 200);
  release();
  const v = await waitDone();
  assert.equal(v.status, 'cancelled');
  assert.equal(v.done, 1);
  const ops = (await request(a).get(`/api/admin/images/operations?batch_id=${first.body.id}`).set('Authorization', admin.auth)).body;
  assert.equal(ops.length, 1);
});

needDb('POST /runs rejects empty subjects with 400', async () => {
  const r = await request(app()).post('/api/admin/images/runs').set('Authorization', admin.auth).send({ op: 'shrink', subjects: [] });
  assert.equal(r.status, 400);
});

needDb('GET /operations returns only that batch, newest first', async () => {
  await fixture();
  const a = app();
  const H = { Authorization: admin.auth };
  const b1 = (await request(a).post('/api/admin/images/runs').set(H).send({ op: 'shrink', subjects: [subj(0)] })).body.id;
  await waitDone();
  const b2 = (await request(a).post('/api/admin/images/runs').set(H).send({ op: 'undo', subjects: [subj(0), subj(1)] })).body.id;
  await waitDone();
  const only1 = (await request(a).get(`/api/admin/images/operations?batch_id=${b1}`).set(H)).body;
  assert.ok(only1.length === 1 && only1.every((o) => o.batch_id === b1));
  const only2 = (await request(a).get(`/api/admin/images/operations?batch_id=${b2}`).set(H)).body;
  assert.equal(only2.length, 2);
  assert.ok(only2[0].id > only2[1].id);
  const all = (await request(a).get('/api/admin/images/operations?limit=2').set(H)).body;
  assert.equal(all.length, 2);
  assert.equal((await request(a).get('/api/admin/images/operations?batch_id=nope').set(H)).status, 400);
});

needDb('undo then reactivate serves the web copy again; stale is refused', async () => {
  await fixture();
  const a = app();
  const H = { Authorization: admin.auth };
  await request(a).post('/api/admin/images/runs').set(H).send({ op: 'shrink', subjects: [subj(0), subj(1)] });
  await waitDone();
  const stateOf = async (i) => (await request(a).get('/api/admin/images?kind=entity').set(H)).body
    .find((x) => x.subject.key === NAMES[i] && x.subject.column === 'image').state;
  assert.equal(await stateOf(0), 'shrunk');
  await request(a).post('/api/admin/images/runs').set(H).send({ op: 'undo', subjects: [subj(0), subj(1)] });
  await waitDone();
  assert.equal(await stateOf(0), 'undone');
  const re = await request(a).post('/api/admin/images/reactivate').set(H).send({ subject: subj(0) });
  assert.equal(re.status, 200);
  assert.equal(re.body.op, 'reactivate');
  assert.equal(re.body.status, 'ok');
  assert.equal(await stateOf(0), 'shrunk');

  // Rewrite subject 1's original under the same key: its web copy is stale.
  store.objects.set('t5/1.png', await noisePng(510, 410));
  assert.equal(await stateOf(1), 'stale');
  const bad = await request(a).post('/api/admin/images/reactivate').set(H).send({ subject: subj(1) });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.error, 'stale');
  assert.equal(bad.body.op.status, 'failed');
  assert.equal((await request(a).post('/api/admin/images/reactivate').set(H).send({})).status, 400);
});
