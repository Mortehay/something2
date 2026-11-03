const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const { Readable } = require('node:stream');
const spriteBatchRoutes = require('../src/api/spriteBatchRoutes.js');
const { encodeRGBA } = require('../src/services/pngTrim.js');
const { decodeRGBA } = require('../src/services/pngAlpha.js');

const ID = '123e4567-e89b-42d3-a456-426614174000';
const N = 4;
const frames = Object.fromEntries(Array.from({ length: N }, (_, i) => [`walk/e/${i}`, [i * 2, 0, 2, 2]]));
const px = Buffer.alloc(N * 2 * 2 * 4);
for (let i = 0; i < N; i += 1) for (let y = 0; y < 2; y += 1) for (let x = 0; x < 2; x += 1) {
  const o = (y * N * 2 + i * 2 + x) * 4; px[o] = 40 * (i + 1); px[o + 3] = 255;
}
const SHEET = encodeRGBA(N * 2, 2, px);
const MANIFEST = {
  rows: [{ row: 0, action: 'walk', direction: 'e', frames: N }], frames_per_action: N, frames,
  quality: [{ action: 'walk', direction: 'e', frame: 1, attempts: 2, passed: false, failed_checks: ['facing'] }],
};
const ROW = {
  id: ID, backend: 'gpu-box', generation_kind: 'creature', status: 'done', atlas_key: 'p/sheet.png', manifest_key: 'p/sheet.json',
};

function build({ row = ROW, lockedRow, redraw = false, failPut, dbFail } = {}) {
  const calls = [];
  const puts = {};
  const putLog = [];
  const files = { 'p/sheet.png': SHEET, 'p/sheet.json': Buffer.from(JSON.stringify(MANIFEST)) };
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [] };
    if (/FROM sprite_sets WHERE id = \$1 FOR UPDATE/i.test(sql)) return { rows: (lockedRow || row) ? [lockedRow || row] : [] };
    if (/redraw_of = \$1/i.test(sql)) return { rows: redraw ? [{}] : [] };
    if (/UPDATE sprite_sets SET updated_at/i.test(sql)) { if (dbFail) throw new Error('db down'); return { rows: [] }; }
    throw new Error(`unexpected query: ${sql}`);
  };
  const pool = { connect: async () => ({ query, release: () => { calls.push({ sql: 'RELEASE', params: [] }); } }) };
  const store = {
    getObjectStream: async (k) => Readable.from([files[k]]),
    putObject: async (k, buf, type) => {
      putLog.push(k);
      if (failPut && failPut(k, putLog.filter((x) => x === k).length)) throw new Error('put failed');
      puts[k] = { buf, type };
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/sprite-admin', spriteBatchRoutes(pool, (_q, _s, next) => next(), { status: () => ({}) }, { store }));
  return { app, calls, puts };
}
const post = (ctx, id, body) => request(ctx.app).post(`/api/sprite-admin/jobs/${id}/use-good-frames`).send(body);

test('default targets are the failed entries; files written to the same keys; updated_at bumped', async () => {
  const ctx = build();
  const res = await post(ctx, ID);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { replaced: [{ frame: 'walk/e/1', from: 'walk/e/0' }], skipped: [] });
  assert.deepEqual(Object.keys(ctx.puts).sort(), ['p/sheet.json', 'p/sheet.png']);
  assert.equal(ctx.puts['p/sheet.png'].type, 'image/png');
  const img = decodeRGBA(ctx.puts['p/sheet.png'].buf);
  assert.equal(img.px[(1 * 2) * 4], 40); // frame 1 now carries frame 0's red
  const m = JSON.parse(ctx.puts['p/sheet.json'].buf.toString());
  assert.equal(m.quality[0].passed, true);
  assert.equal(m.quality[0].replaced_from, 'walk/e/0');
  assert.equal(m.quality[0].attempts, 2);
  assert.ok(ctx.calls.some((c) => /UPDATE sprite_sets SET updated_at/i.test(c.sql)));
  assert.ok(ctx.calls.some((c) => c.sql === 'COMMIT'));
  assert.ok(ctx.calls.some((c) => c.sql === 'RELEASE'));
});

test('explicit frames body is honoured; unreplaceable frames come back skipped', async () => {
  const ctx = build();
  const res = await post(ctx, ID, { frames: [{ action: 'walk', direction: 'e', frame: 3 }, { action: 'walk', direction: 's', frame: 0 }] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.replaced, [{ frame: 'walk/e/3', from: 'walk/e/2' }]);
  assert.equal(res.body.skipped.length, 1);
});

test('nothing replaced writes nothing', async () => {
  const ctx = build();
  const res = await post(ctx, ID, { frames: [{ action: 'walk', direction: 's', frame: 0 }] });
  assert.equal(res.status, 200);
  assert.deepEqual(ctx.puts, {});
});

test('approved -> 409, other statuses -> 409, unknown -> 404, bad body -> 400', async () => {
  const approved = await post(build({ row: { ...ROW, status: 'approved' } }), ID);
  assert.equal(approved.status, 409);
  assert.equal(approved.body.error, 'approved art is live — force regenerate instead');
  for (const status of ['queued', 'running', 'failed']) {
    const r = await post(build({ row: { ...ROW, status } }), ID);
    assert.equal(r.status, 409, status);
    assert.equal(r.body.error, 'only a finished sheet can be edited');
  }
  assert.equal((await post(build({ row: null }), ID)).status, 404);
  assert.equal((await post(build(), 'not-a-uuid')).status, 404);
  assert.equal((await post(build(), ID, { frames: [{ action: 'walk' }] })).status, 400);
  assert.equal((await post(build(), ID, { frames: [] })).status, 400);
});

test('the row is locked and the status re-checked after the lock (approved in between -> 409)', async () => {
  const ctx = build({ lockedRow: { ...ROW, status: 'approved' } });
  const res = await post(ctx, ID);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'approved art is live — force regenerate instead');
  assert.deepEqual(ctx.puts, {});
  assert.ok(ctx.calls.some((c) => /FOR UPDATE/i.test(c.sql)));
  assert.ok(ctx.calls.some((c) => c.sql === 'ROLLBACK'));
});

test('a queued or running redraw of this sheet -> 409, nothing written', async () => {
  const ctx = build({ redraw: true });
  const res = await post(ctx, ID);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'a redraw of this sheet is in progress — wait for it to finish');
  assert.deepEqual(ctx.puts, {});
});

test('manifest write failure restores the original sheet.png and says so', async () => {
  const ctx = build({ failPut: (k) => k === 'p/sheet.json' });
  const res = await post(ctx, ID);
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'could not save the sheet manifest; the image was restored');
  assert.deepEqual(ctx.puts['p/sheet.png'].buf, SHEET);
  assert.ok(ctx.calls.some((c) => c.sql === 'ROLLBACK'));
});

test('manifest write failure and restore failure -> NOT restored', async () => {
  const ctx = build({ failPut: (k, n) => k === 'p/sheet.json' || (k === 'p/sheet.png' && n === 2) });
  const res = await post(ctx, ID);
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'could not save the sheet manifest; the image could NOT be restored');
});

test('database failure after both writes -> 500 naming that the files were updated', async () => {
  const ctx = build({ dbFail: true });
  const res = await post(ctx, ID);
  assert.equal(res.status, 500);
  assert.match(res.body.error, /files were updated/);
});
