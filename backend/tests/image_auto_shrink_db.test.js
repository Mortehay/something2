// Image shrink Task 10: auto-shrink of new and regenerated art. Private test DB
// (TEST_DATABASE_URL only -- never the dev DB), in-memory fake object store with
// real sharp PNGs. Every sweep is scoped to this file's rows (`only`), so the
// rest of the catalog -- and test files running beside this one -- are never touched.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { Pool } = require('pg');
const { privateTestDb } = require('./helpers/privateTestDb.js');

const auto = require('../src/services/imageAutoShrink.js');
const runner = require('../src/services/imageShrinkRun.js');
const { shrinkSubject, undoSubject, invalidateServeMap, getServeMap } = require('../src/services/imageVariants.js');
const { setSetting, getSetting } = require('../src/services/gameSettings.js');

const { url: DB_URL, skip: SKIP } = privateTestDb();
const PREFIX = 'imgshrink-t10-';
const A = `${PREFIX}a`;
const B = `${PREFIX}b`;
const SHEET = `${PREFIX}sheet`;
const only = (s) => s.key.startsWith(PREFIX);
const MANIFEST = { cell: [96, 128], frames: { 'idle/s/0': [0, 0, 96, 128], 'idle/s/1': [96, 0, 96, 128] } };

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
const solidPng = (w, h) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 9, g: 99, b: 199, alpha: 1 } } }).png().toBuffer();

let pool;
const subj = (key, column = 'image') => ({ table: 'entity_types', key, column });
const opsOf = async (key) => (await pool.query('SELECT * FROM image_operations WHERE subject_key = $1 ORDER BY id', [key])).rows;
const variantOf = async (key, column = 'image') => (await pool.query(
  'SELECT * FROM image_variants WHERE subject_table = $1 AND subject_key = $2 AND subject_column = $3',
  ['entity_types', key, column])).rows[0];

async function cleanup() {
  await pool.query('DELETE FROM image_operations WHERE subject_key LIKE $1', [`${PREFIX}%`]);
  await pool.query('DELETE FROM image_variants WHERE subject_key LIKE $1', [`${PREFIX}%`]);
  await pool.query('DELETE FROM entity_types WHERE name LIKE $1', [`${PREFIX}%`]);
}
// The setting as found before this file ran; restored (never deleted) at the end so a
// settings round-trip running beside this file is not broken.
let settingBefore;
async function fixture() {
  await cleanup();
  // Explicitly on: a sweep returning null must never pass because the setting was off.
  await setSetting(pool, 'image_auto_shrink', true);
  runner.resetForTests();
  invalidateServeMap();
  const store = fakeStore([['t10/a.png', await noisePng(600, 400)]]);
  await pool.query(`INSERT INTO entity_types (name, color, image) VALUES ($1, '#000000', 't10/a.png')`, [A]);
  return store;
}
async function waitDone() {
  for (let i = 0; i < 400; i++) {
    const v = runner.getRun();
    if (v && v.status !== 'running') return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('run did not finish');
}
const sweep = async (store, checkEtags) => {
  const v = await auto.runAutoShrinkSweep(pool, store, { checkEtags, only });
  if (v) await waitDone();
  return v;
};

test.before(async () => {
  if (!DB_URL) return;
  pool = new Pool({ connectionString: DB_URL, max: 4 });
  settingBefore = await getSetting(pool, 'image_auto_shrink');
});
test.after(async () => {
  if (!pool) return;
  await cleanup().catch(() => {});
  await setSetting(pool, 'image_auto_shrink', settingBefore).catch(() => {});
  await pool.end();
});
const needDb = (name, fn) => test(name, async (t) => { if (SKIP) return t.skip(SKIP); return fn(t); });

needDb('new art gets a web copy', async () => {
  const store = await fixture();
  const work = await auto.findAutoShrinkWork(pool, store, { checkEtags: false, only });
  assert.deepEqual(work, [{ subject: subj(A), params: null }]);
  const view = await sweep(store, false);
  assert.ok(view, 'a run started');
  const v = await variantOf(A);
  assert.ok(v && v.active, 'variant active');
  assert.equal(v.original_key, 't10/a.png');
  assert.deepEqual(v.params, { maxEdge: 256, quality: 85 }, 'kind default, no auto flag on the variant');
  const ops = await opsOf(A);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].status, 'ok');
  assert.equal(ops[0].params.auto, true);
  assert.equal(ops[0].actor, null);
  assert.ok(ops[0].batch_id, 'logged as a batch row');
  assert.deepEqual(await auto.findAutoShrinkWork(pool, store, { checkEtags: true, only }), [], 'nothing left');
});

needDb('regenerated art is re-shrunk with previous params', async () => {
  const store = await fixture();
  assert.equal((await shrinkSubject(pool, store, subj(A), { maxEdge: 200 }, {})).status, 'ok');
  store.objects.set('t10/a2.png', await noisePng(500, 500));
  await pool.query(`UPDATE entity_types SET image = 't10/a2.png' WHERE name = $1`, [A]);
  const work = await auto.findAutoShrinkWork(pool, store, { checkEtags: false, only });
  assert.deepEqual(work, [{ subject: subj(A), params: { maxEdge: 200, quality: 85 } }]);
  assert.ok(await sweep(store, false));
  const v = await variantOf(A);
  assert.equal(v.original_key, 't10/a2.png');
  assert.equal(v.params.maxEdge, 200);
  assert.ok(v.web_width <= 200 && v.web_height <= 200);
  assert.ok(v.active);
  const last = (await opsOf(A)).at(-1);
  assert.equal(last.params.auto, true);
  assert.equal(last.params.maxEdge, 200);
});

needDb('same-key rewrite needs the etag pass', async () => {
  const store = await fixture();
  assert.equal((await shrinkSubject(pool, store, subj(A), null, {})).status, 'ok');
  store.objects.set('t10/a.png', await noisePng(300, 300));
  assert.deepEqual(await auto.findAutoShrinkWork(pool, store, { checkEtags: false, only }), []);
  assert.equal(await sweep(store, false), null, 'db-only sweep sees nothing');
  assert.equal((await opsOf(A)).length, 1);
  assert.ok(await sweep(store, true), 'etag sweep re-shrinks');
  const v = await variantOf(A);
  assert.equal(v.original_etag, (await store.statObject('t10/a.png')).etag);
  assert.equal(v.original_width, 300);
  assert.equal((await opsOf(A)).length, 2);
});

needDb('undone is never auto-shrunk', async () => {
  const store = await fixture();
  assert.equal((await shrinkSubject(pool, store, subj(A), null, {})).status, 'ok');
  assert.equal((await undoSubject(pool, subj(A), {})).status, 'ok');
  assert.equal(await sweep(store, true), null);
  assert.equal((await variantOf(A)).active, false);
  assert.equal((await opsOf(A)).length, 2);
});

needDb('setting off does nothing', async () => {
  const store = await fixture();
  await setSetting(pool, 'image_auto_shrink', false);
  assert.equal(await sweep(store, true), null);
  assert.equal((await opsOf(A)).length, 0);
  await setSetting(pool, 'image_auto_shrink', true);
  assert.ok(await sweep(store, true), 'back on: picked up');
});

needDb('undone stays undone when the art is regenerated under a new key', async () => {
  const store = await fixture();
  assert.equal((await shrinkSubject(pool, store, subj(A), null, {})).status, 'ok');
  assert.equal((await undoSubject(pool, subj(A), {})).status, 'ok');
  store.objects.set('t10/a4.png', await noisePng(300, 300));
  await pool.query(`UPDATE entity_types SET image = 't10/a4.png' WHERE name = $1`, [A]);
  assert.deepEqual(await auto.findAutoShrinkWork(pool, store, { checkEtags: true, only }), []);
  assert.equal(await sweep(store, true), null);
  assert.equal((await variantOf(A)).active, false);
  assert.equal((await opsOf(A)).length, 2);
});

needDb('undone stays undone when the art is rewritten under the same key', async () => {
  const store = await fixture();
  assert.equal((await shrinkSubject(pool, store, subj(A), null, {})).status, 'ok');
  assert.equal((await undoSubject(pool, subj(A), {})).status, 'ok');
  store.objects.set('t10/a.png', await noisePng(300, 300));
  assert.deepEqual(await auto.findAutoShrinkWork(pool, store, { checkEtags: true, only }), []);
  assert.equal(await sweep(store, true), null);
  assert.equal((await variantOf(A)).active, false);
  assert.equal((await opsOf(A)).length, 2);
});

needDb('failed auto retries after a same-key rewrite (etag pass only)', async () => {
  const store = await fixture();
  store.objects.set('t10/a.png', Buffer.from('not a png'));
  assert.ok(await sweep(store, true));
  const [failed] = await opsOf(A);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.params.auto_src.etag, (await store.statObject('t10/a.png')).etag);
  assert.equal(await sweep(store, true), null, 'same bytes: no retry');
  store.objects.set('t10/a.png', await noisePng(200, 200));
  assert.equal(await sweep(store, false), null, 'db-only pass cannot see new bytes');
  assert.ok(await sweep(store, true), 'new bytes: retried');
  const ops = await opsOf(A);
  assert.equal(ops.length, 2);
  assert.equal(ops[1].status, 'ok');
});

needDb('failed auto of a sheet retries when the manifest changes', async () => {
  const store = await fixture();
  await pool.query('DELETE FROM entity_types WHERE name = $1', [A]);
  store.objects.set('t10/s.png', await solidPng(192, 128));
  store.objects.set('t10/s.json', Buffer.from('{not json'));
  const sprite = { atlas_key: 't10/s.png', manifest_key: 't10/s.json', fps: 8 };
  await pool.query(`INSERT INTO entity_types (name, color, sprite) VALUES ($1, '#000000', $2::jsonb)`, [SHEET, JSON.stringify(sprite)]);
  assert.ok(await sweep(store, true));
  assert.equal((await opsOf(SHEET))[0].status, 'failed');
  assert.equal(await sweep(store, true), null, 'no retry storm');
  // Same manifest key, new bytes.
  store.objects.set('t10/s.json', Buffer.from(JSON.stringify(MANIFEST)));
  assert.ok(await sweep(store, true), 'manifest bytes changed: retried');
  assert.equal((await opsOf(SHEET))[1].status, 'ok');
});

needDb('a cancelled auto run backs off further sweeps', async () => {
  const store = await fixture();
  let release;
  store.gate = { key: 't10/a.png', promise: new Promise((r) => { release = r; }) };
  const view = await auto.runAutoShrinkSweep(pool, store, { checkEtags: true, only });
  assert.ok(view && view.auto);
  runner.cancelRun();
  release();
  assert.equal((await waitDone()).status, 'cancelled');
  store.gate = null;
  await pool.query('DELETE FROM image_operations WHERE subject_key = $1', [A]);
  await pool.query('DELETE FROM image_variants WHERE subject_key = $1', [A]);
  assert.equal(await auto.runAutoShrinkSweep(pool, store, { checkEtags: true, only }), null, 'backing off');
  runner.resetForTests();
  assert.ok(await sweep(store, true), 'a fresh runner: picked up again');
});

needDb('busy runner skips', async () => {
  const store = await fixture();
  store.objects.set('t10/b.png', await noisePng(400, 400));
  await pool.query(`INSERT INTO entity_types (name, color, image) VALUES ($1, '#000000', 't10/b.png')`, [B]);
  let release;
  store.gate = { key: 't10/b.png', promise: new Promise((r) => { release = r; }) };
  await runner.startRun(pool, store, { op: 'shrink', subjects: [subj(B)], actor: null });
  assert.equal(await auto.runAutoShrinkSweep(pool, store, { checkEtags: true, only }), null);
  assert.equal((await opsOf(A)).length, 0, 'sweep logged nothing');
  release();
  await waitDone();
  assert.equal((await opsOf(B))[0].params.auto, undefined, 'manual run is not auto');
});

needDb('failed auto is not retried until the original changes', async () => {
  const store = await fixture();
  store.objects.set('t10/a.png', Buffer.from('not a png'));
  assert.ok(await sweep(store, true));
  let ops = await opsOf(A);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].status, 'failed');
  assert.equal(ops[0].params.auto, true);
  assert.equal(await sweep(store, true), null, 'no retry storm');
  assert.equal((await opsOf(A)).length, 1);
  store.objects.set('t10/a3.png', await noisePng(300, 200));
  await pool.query(`UPDATE entity_types SET image = 't10/a3.png' WHERE name = $1`, [A]);
  assert.ok(await sweep(store, false));
  ops = await opsOf(A);
  assert.equal(ops.length, 2);
  assert.equal(ops[1].status, 'ok');
});

needDb('sheet is built from original then shrunk', async () => {
  const store = await fixture();
  await pool.query('DELETE FROM entity_types WHERE name = $1', [A]);
  const atlas = await solidPng(192, 128);
  store.objects.set('t10/sheet.png', atlas);
  store.objects.set('t10/sheet.json', Buffer.from(JSON.stringify(MANIFEST)));
  const sprite = { atlas_key: 't10/sheet.png', manifest_key: 't10/sheet.json', fps: 8 };
  await pool.query(`INSERT INTO entity_types (name, color, sprite) VALUES ($1, '#000000', $2::jsonb)`, [SHEET, JSON.stringify(sprite)]);
  assert.ok(await sweep(store, true));
  const v = await variantOf(SHEET, 'sprite');
  assert.ok(v && v.active);
  assert.ok(v.web_sprite && v.web_sprite.atlas_key.endsWith('.webp'));
  assert.equal(v.original_key, 't10/sheet.png');
  assert.ok(store.objects.get('t10/sheet.png').equals(atlas), 'original atlas untouched');
  const row = (await pool.query('SELECT sprite FROM entity_types WHERE name = $1', [SHEET])).rows[0];
  assert.equal(row.sprite.atlas_key, 't10/sheet.png', 'column still holds the original');
});

needDb('requestAutoShrink is a no-op until the timer starts, and never throws', async () => {
  auto.stopAutoShrinkTimer();
  assert.doesNotThrow(() => auto.requestAutoShrink());
  assert.equal(auto.isTimerRunning(), false);
  auto.startAutoShrinkTimer(pool, fakeStore([]), { intervalMs: 3_600_000 });
  assert.equal(auto.isTimerRunning(), true);
  auto.stopAutoShrinkTimer();
  assert.equal(auto.isTimerRunning(), false);
});

test('runner: a crash in drive still invalidates the serve map and records the error', async () => {
  runner.resetForTests();
  invalidateServeMap();
  const fakePool = { query: async () => ({ rows: [] }) };
  const store = fakeStore([]);
  const p1 = getServeMap(fakePool, store);
  assert.equal(getServeMap(fakePool, store), p1, 'cached');
  await p1;
  await runner.startRun(fakePool, store, { op: 'shrink', subjects: [null] });
  const v = await waitDone();
  assert.ok(v.error, 'crash recorded on the view');
  assert.ok(['done', 'cancelled'].includes(v.status));
  assert.notEqual(getServeMap(fakePool, store), p1, 'serve map invalidated');
  runner.resetForTests();
});

