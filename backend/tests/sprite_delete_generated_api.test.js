const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const spriteBatchRoutes = require('../src/api/spriteBatchRoutes.js');

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const row = (id, over = {}) => ({
  id, entity_type_id: 7, appearance_variant: null, creature: 'Cultist 1', generation_kind: 'creature',
  status: 'done', atlas_key: `sprites/Cultist_1/${id}/atlas.png`, manifest_key: `sprites/Cultist_1/${id}/m.json`,
  concept_key: null, image_key: null, box_job_id: null, ...over,
});

// A client whose queries answer by shape; `deleted` is what the DELETE returns.
function build({ deleted = [row(ID_A)], running = false, files = {}, protectedKeys = [], removeFail = [], failDelete = false,
  listFail = false, clearKept } = {}) {
  const calls = [];
  const log = [];
  const client = {
    query: async (sql, params = []) => {
      const s = String(sql).trim();
      log.push(s.split(/\s+/).slice(0, 4).join(' '));
      calls.push({ sql: s, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return { rows: [] };
      if (/FOR UPDATE/.test(s)) return { rows: [{ id: 'x' }] };
      if (/SELECT 1 FROM sprite_sets/.test(s)) return { rows: running ? [{}] : [] };
      if (/^DELETE FROM sprite_sets/.test(s)) { if (failDelete) throw new Error('db down'); return { rows: deleted }; }
      if (/^UPDATE/.test(s)) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected client query: ${s}`);
    },
    release: () => { calls.push({ sql: 'RELEASE', params: [] }); },
  };
  const pool = {
    connect: async () => client,
    query: async (sql, params = []) => {
      const s = String(sql).trim();
      calls.push({ sql: s, params, pool: true });
      if (/FROM sprite_concepts/.test(s) && /UNION/.test(s)) return { rows: protectedKeys.map((k) => ({ k })) };
      if (/^DELETE FROM sprite_concepts/.test(s)) return { rowCount: 2, rows: [] };
      if (/^SELECT 1 FROM sprite_sets/.test(s)) return { rows: running ? [{}] : [] };
      throw new Error(`unexpected pool query: ${s}`);
    },
  };
  const listed = [];
  const removed = [];
  const store = {
    BUCKET: () => 'sprites',
    listObjectKeys: async (prefix) => {
      listed.push(prefix);
      if (listFail) throw new Error('minio down');
      return Object.keys(files).filter((k) => k.startsWith(prefix));
    },
    removeObject: async (key) => {
      if (removeFail.includes(key)) throw new Error('nope');
      removed.push(key);
    },
  };
  const cancelled = [];
  const box = { cancelSheetJob: async (_p, id) => { cancelled.push(id); return { ok: true }; } };
  const a = express();
  a.use(express.json());
  a.use('/api/sprite-admin', spriteBatchRoutes(pool, (_q, _s, next) => next(), { status: () => ({}) },
    { store, box, loadProvider: async () => ({ id: 'p' }) }));
  return { app: a, calls, log, listed, removed, cancelled };
}

const del = (ctx, body) => request(ctx.app).post('/api/sprite-admin/jobs/delete-generated').send(body);
const T = { targets: [{ entity_id: 7 }] };

test('delete-generated deletes and reports counts', async () => {
  const files = { [`sprites/Cultist_1/${ID_A}/atlas.png`]: 1, [`sprites/Cultist_1/${ID_A}/m.json`]: 1, [`sprites/Cultist_1/${ID_A}/f0.png`]: 1 };
  const ctx = build({ files });
  const res = await del(ctx, T);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { deleted_jobs: 1, subjects: 1, skipped_running: [], files_deleted: 3, files_failed: [] });
  assert.equal(ctx.log[0], 'BEGIN');
  assert.ok(ctx.log.includes('COMMIT'));
});

test('delete-generated rejects bad targets with 400 and touches nothing', async () => {
  const ctx = build();
  assert.equal((await del(ctx, { targets: [] })).status, 400);
  assert.equal((await del(ctx, { targets: [{ entity_id: 0 }] })).status, 400);
  assert.equal(ctx.calls.length, 0);
});

test('delete-generated skips running subjects and lists no folders', async () => {
  const ctx = build({ running: true });
  const res = await del(ctx, T);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.skipped_running, ['7']);
  assert.equal(res.body.deleted_jobs, 0);
  assert.deepEqual(ctx.listed, []);
});

test('the sprite_sets rows are locked before the running check', async () => {
  const ctx = build();
  await del(ctx, T);
  const lock = ctx.calls.findIndex((c) => /FOR UPDATE/.test(c.sql));
  const check = ctx.calls.findIndex((c) => /SELECT 1 FROM sprite_sets/.test(c.sql));
  const del_ = ctx.calls.findIndex((c) => /^DELETE FROM sprite_sets/.test(c.sql));
  assert.ok(lock >= 0 && lock < check && check < del_, `order ${lock} ${check} ${del_}`);
});

test('Cultist:1 delete lists only its row-id folders, never sprites/Cultist_1/ alone', async () => {
  const ctx = build({
    deleted: [row(ID_A), row(ID_B, { atlas_key: null, manifest_key: null })],
    files: { [`sprites/Cultist_10/${ID_A}/x.png`]: 1, [`sprites/Cultist_1/${ID_A}/atlas.png`]: 1, [`sprites/Cultist_1/${ID_B}/y.png`]: 1 },
  });
  const res = await del(ctx, T);
  assert.equal(res.status, 200);
  assert.deepEqual(ctx.listed.sort(), [`sprites/Cultist_1/${ID_A}/`, `sprites/Cultist_1/${ID_B}/`]);
  for (const p of ctx.listed) assert.ok(/\/[0-9a-f-]{36}\/$/.test(p), p);
  assert.ok(!ctx.removed.some((k) => k.startsWith('sprites/Cultist_10/')));
});

test('a key whose folder is not the row-id folder is never used as a prefix', async () => {
  const ctx = build({ deleted: [row(ID_A, { atlas_key: 'sprites/Cultist_1/atlas.png', manifest_key: null, concept_key: `sprites/Cultist_1/${ID_B}/concept.png` })] });
  await del(ctx, T);
  assert.deepEqual(ctx.listed, [`sprites/Cultist_1/${ID_A}/`], 'fallback folder, not the shared one nor another row\'s');
});

test('a prop\'s entity image and a kept concept inside a deleted folder are not removed', async () => {
  const img = `sprites/Cultist_1/${ID_A}/prop.png`;
  const con = `sprites/Cultist_1/${ID_A}/concept.png`;
  const other = `sprites/Cultist_1/${ID_A}/atlas.png`;
  const ctx = build({ files: { [img]: 1, [con]: 1, [other]: 1 }, protectedKeys: [img, con] });
  const res = await del(ctx, T);
  assert.deepEqual(ctx.removed, [other]);
  assert.equal(res.body.files_deleted, 1);
});

test('protected keys are read after COMMIT', async () => {
  const ctx = build({ files: { [`sprites/Cultist_1/${ID_A}/atlas.png`]: 1 } });
  await del(ctx, T);
  const commit = ctx.calls.findIndex((c) => c.sql === 'COMMIT');
  const prot = ctx.calls.findIndex((c) => c.pool && /UNION/.test(c.sql));
  assert.ok(commit >= 0 && prot > commit);
});

test('a removeObject failure lands in files_failed with a 200, capped at 50', async () => {
  const keys = Array.from({ length: 60 }, (_, i) => `sprites/Cultist_1/${ID_A}/f${i}.png`);
  const ctx = build({ files: Object.fromEntries(keys.map((k) => [k, 1])), removeFail: keys });
  const res = await del(ctx, T);
  assert.equal(res.status, 200);
  assert.equal(res.body.files_deleted, 0);
  assert.equal(res.body.files_failed.length, 50);
  assert.equal(res.body.files_failed[0], keys[0]);
});

test('a listing failure is reported, not a 500', async () => {
  const ctx = build({ listFail: true });
  const res = await del(ctx, T);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.files_failed, [`sprites/Cultist_1/${ID_A}/`]);
});

test('a DB failure rolls back, returns 500 and makes no file calls', async () => {
  const ctx = build({ failDelete: true, files: { [`sprites/Cultist_1/${ID_A}/atlas.png`]: 1 } });
  const res = await del(ctx, T);
  assert.equal(res.status, 500);
  assert.ok(ctx.log.includes('ROLLBACK'));
  assert.ok(!ctx.log.includes('COMMIT'));
  assert.deepEqual(ctx.listed, []);
  assert.deepEqual(ctx.removed, []);
  assert.ok(ctx.calls.some((c) => c.sql === 'RELEASE'));
});

test('queued rows\' box jobs are cancelled after commit', async () => {
  const ctx = build({ deleted: [row(ID_A, { status: 'queued', box_job_id: 'box-9' })] });
  const res = await del(ctx, T);
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ctx.cancelled, ['box-9']);
});

test('concepts/clear returns counts and rejects bad targets', async () => {
  const ctx = build();
  const res = await request(ctx.app).post('/api/sprite-admin/concepts/clear').send(T);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { cleared: 2, skipped_running: [] });
  const bad = await request(ctx.app).post('/api/sprite-admin/concepts/clear').send({ targets: 'x' });
  assert.equal(bad.status, 400);
});
