const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const { Readable } = require('node:stream');
const spriteBatchRoutes = require('../src/api/spriteBatchRoutes.js');

const ID = '123e4567-e89b-42d3-a456-426614174000';
const ROWS = ['idle', 'walk'].flatMap((action) => ['s', 'e', 'w'].map((direction, i) => ({ action, direction, frames: 6 })))
  .map((r, row) => ({ ...r, row }));
const MANIFEST = {
  rows: ROWS,
  frames_per_action: 6,
  frames: Object.fromEntries(ROWS.flatMap((r) => Array.from({ length: 6 }, (_, i) => [`${r.action}/${r.direction}/${i}`, [0, 0, 8, 8]]))),
};
const SOURCE = {
  id: ID, entity_type_id: 4, appearance_variant: null, generation_kind: 'creature', backend: 'gpu-box',
  status: 'done', atlas_key: 'a.png', manifest_key: 'm.json', box_job_id: 'box-1', created_at: new Date('2026-10-01'),
  redraw_of: null,
};

function build({ source = SOURCE, newer = false, created = { id: 'new-row' }, running = false, manifest = MANIFEST, storeError, discard } = {}) {
  const calls = [];
  const pool = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/SELECT \* FROM sprite_sets WHERE id/i.test(sql)) return { rows: source ? [source] : [] };
      if (/atlas_key IS NOT NULL AND created_at >/i.test(sql)) return { rows: newer ? [{}] : [] };
      if (/INSERT INTO sprite_sets/i.test(sql)) return { rows: created ? [created] : [] };
      if (/DELETE FROM sprite_sets/i.test(sql)) return { rows: discard === 'deleted' ? [{ id: ID }] : [] };
      if (/SELECT 1 FROM sprite_sets/i.test(sql)) return { rows: discard === 'not_discardable' ? [{}] : [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const started = { n: 0 };
  const dispatcher = { status: () => ({ running }), start: () => { started.n += 1; return Promise.resolve(); } };
  const store = {
    getObjectStream: async () => {
      if (storeError) throw new Error(storeError);
      return Readable.from([Buffer.from(JSON.stringify(manifest))]);
    },
  };
  const a = express();
  a.use(express.json());
  a.use('/api/sprite-admin', spriteBatchRoutes(pool, (_q, _s, next) => next(), dispatcher, { store }));
  return { app: a, calls, started };
}

const post = (ctx, body) => request(ctx.app).post('/api/sprite-admin/jobs/redraw').send(body);
const f = (action, direction, frame) => ({ action, direction, frame });

test('redraw queues frames in manifest order and starts the dispatcher', async () => {
  const ctx = build();
  const res = await post(ctx, { job_id: ID, frames: [f('walk', 'e', 2), f('idle', 'e', 3), f('idle', 'e', 1), f('idle', 's', 5)] });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { id: 'new-row', started: true });
  const insert = ctx.calls.find((c) => /INSERT INTO sprite_sets/i.test(c.sql));
  assert.deepEqual(JSON.parse(insert.params[15]), [f('idle', 's', 5), f('idle', 'e', 1), f('idle', 'e', 3), f('walk', 'e', 2)]);
  assert.equal(insert.params[14], ID);
  assert.equal(ctx.started.n, 1);
});

test('redraw does not start a running dispatcher', async () => {
  const ctx = build({ running: true });
  const res = await post(ctx, { job_id: ID, frames: [f('idle', 's', 0)] });
  assert.equal(res.status, 201);
  assert.equal(res.body.started, false);
  assert.equal(ctx.started.n, 0);
});

test('redraw rejects western directions with 400', async () => {
  for (const d of ['w', 'nw', 'sw']) {
    const ctx = build();
    const res = await post(ctx, { job_id: ID, frames: [f('idle', d, 0)] });
    assert.equal(res.status, 400, d);
    assert.match(res.body.error, new RegExp(`idle/${d}/0`));
  }
});

test('redraw rejects malformed bodies, stale frames and duplicates with 400 naming the entry', async () => {
  const bad = [
    { job_id: 'nope', frames: [f('idle', 's', 0)] },
    { job_id: ID, frames: [] },
    { job_id: ID, frames: [{ action: 'idle', direction: 's', frame: '1' }] },
    { job_id: ID, frames: [f('idle', 's', 6)] },
    { job_id: ID, frames: [f('swim', 's', 0)] },
    { job_id: ID, frames: [f('idle', 's', 1), f('idle', 's', 1)] },
  ];
  const named = [null, null, null, 'idle/s/6', 'swim/s/0', 'idle/s/1'];
  for (const [i, body] of bad.entries()) {
    const ctx = build();
    const res = await post(ctx, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    if (named[i]) assert.ok(res.body.error.includes(named[i]), res.body.error);
    assert.ok(!ctx.calls.some((c) => /INSERT/i.test(c.sql)));
  }
});

test('redraw 404s for an unknown job', async () => {
  const res = await post(build({ source: null }), { job_id: ID, frames: [f('idle', 's', 0)] });
  assert.equal(res.status, 404);
});

test('redraw 409s for a prop, a local-backend row and a running row', async () => {
  for (const patch of [{ generation_kind: 'object' }, { backend: 'local' }, { status: 'running' }, { status: 'failed' }]) {
    const ctx = build({ source: { ...SOURCE, ...patch } });
    const res = await post(ctx, { job_id: ID, frames: [f('idle', 's', 0)] });
    assert.equal(res.status, 409, JSON.stringify(patch));
    assert.ok(!ctx.calls.some((c) => /INSERT/i.test(c.sql)));
  }
});

test('redraw accepts a failed redraw that kept a sheet', async () => {
  const ctx = build({ source: { ...SOURCE, status: 'failed', redraw_of: 'x' } });
  assert.equal((await post(ctx, { job_id: ID, frames: [f('idle', 's', 0)] })).status, 201);
});

test('redraw 409s when a newer row with a sheet exists, queuing nothing', async () => {
  const ctx = build({ newer: true });
  const res = await post(ctx, { job_id: ID, frames: [f('idle', 's', 0)] });
  assert.equal(res.status, 409);
  assert.ok(!ctx.calls.some((c) => /INSERT/i.test(c.sql)));
});

test('redraw 409s when a live job exists (createRedraw returns null)', async () => {
  const ctx = build({ created: null });
  const res = await post(ctx, { job_id: ID, frames: [f('idle', 's', 0)] });
  assert.equal(res.status, 409);
  assert.equal(ctx.started.n, 0);
});

test('redraw answers 500 with a readable error when the manifest cannot be read', async () => {
  const res = await post(build({ storeError: 'bucket offline' }), { job_id: ID, frames: [f('idle', 's', 0)] });
  assert.equal(res.status, 500);
  assert.match(res.body.error, /bucket offline/);
});

test('DELETE redraw maps discardRedraw results', async () => {
  const del = (discard) => request(build({ discard }).app).delete(`/api/sprite-admin/jobs/${ID}/redraw`);
  const ok = await del('deleted');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { deleted: true });
  assert.equal((await del('none')).status, 404);
  const busy = await del('not_discardable');
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error, 'a redraw the box already worked on cannot be discarded');
});
