const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const spriteBatchRoutes = require('../src/api/spriteBatchRoutes.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/gpuBox/action-catalog.json'), 'utf8'));

function build(pool, { current = null, files = {} } = {}) {
  const cancels = [];
  const removed = [];
  const a = express();
  a.use(express.json());
  a.use('/api/sprite-admin', spriteBatchRoutes(pool, (_q, _s, next) => next(), { status: () => ({ running: Boolean(current), current }) }, {
    box: { actionCatalog: async () => ({ ok: true, catalog: CATALOG }), cancelSheetJob: async () => ({ ok: true }) },
    loadProvider: async () => ({ id: 'p' }),
    boxCancels: { request: async (_db, _p, item) => { cancels.push(item); return { ok: true }; } },
    store: {
      BUCKET: () => 'sprites',
      listObjectKeys: async (prefix) => Object.keys(files).filter((k) => k.startsWith(prefix)),
      removeObject: async (k) => { removed.push(k); },
    },
  }));
  return { app: a, cancels, removed };
}

// A real entity of its own, removed again (with its rows) afterwards.
async function withEntity(fn) {
  const pool = new Pool({ connectionString: url });
  const { rows: [e] } = await pool.query(
    "INSERT INTO entity_types (name, prompt, color, is_creature) VALUES ($1, 'a test wolf', '#888888', true) RETURNING id, name",
    [`force-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`],
  );
  try {
    await fn(pool, e);
  } finally {
    await pool.query('DELETE FROM sprite_sets WHERE entity_type_id = $1', [e.id]);
    await pool.query('DELETE FROM sprite_concepts WHERE entity_type_id = $1', [e.id]);
    await pool.query('DELETE FROM entity_types WHERE id = $1', [e.id]);
    await pool.end();
  }
}

const insertSet = (pool, e, over = {}) => {
  const r = { status: 'done', box_job_id: null, box_task_id: null, redraw_of: null, atlas_key: null, ...over };
  return pool.query(
    `INSERT INTO sprite_sets (entity_type_id, creature, generation_kind, base_prompt, backend, seed, frames, status,
                              box_job_id, box_task_id, redraw_of, atlas_key, actions, directions)
     VALUES ($1, $2, 'creature', 'a wolf', 'gpu-box', 1, 4, $3, $4, $5, $6, $7, '{idle}', '{s}') RETURNING *`,
    [e.id, e.name, r.status, r.box_job_id, r.box_task_id, r.redraw_of, r.atlas_key],
  ).then((x) => x.rows[0]);
};
const insertConcept = (pool, e) => pool.query(
  `INSERT INTO sprite_concepts (entity_type_id, concept_key, box_concept_path, box_origin)
   VALUES ($1, 'sprites/x/concept.png', '/p/c.png', 'http://box:1')`, [e.id],
);
const force = (ctx, body) => request(ctx.app).post('/api/sprite-admin/jobs/force').send(body);
const BODY = (e, over = {}) => ({ targets: [{ entity_id: e.id }], actions: ['idle'], frames: 2, directions: ['s', 'w'], ...over });
const settle = () => new Promise((r) => setTimeout(r, 50));

test('force keeps an approved set, deletes done sets with redraw children, drops the kept concept, queues fresh', { skip }, async () => {
  await withEntity(async (pool, e) => {
    const approved = await insertSet(pool, e, { status: 'approved' });
    const done = await insertSet(pool, e, { status: 'done', atlas_key: `sprites/x/${'0'.repeat(8)}/a.png` });
    const child = await insertSet(pool, e, { status: 'done', redraw_of: done.id });
    await insertConcept(pool, e);
    const ctx = build(pool);
    const res = await force(ctx, BODY(e));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.selected, 1);
    assert.equal(res.body.queued, 1);
    assert.deepEqual(res.body.refused, []);
    const { rows } = await pool.query('SELECT id, status, directions, actions, frames_per_action FROM sprite_sets WHERE entity_type_id = $1', [e.id]);
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes(approved.id), 'approved survives');
    assert.ok(!ids.includes(done.id) && !ids.includes(child.id), 'done set and redraw child deleted');
    const fresh = rows.find((r) => r.status === 'queued');
    assert.deepEqual(fresh.directions, ['s', 'w']);
    assert.deepEqual(fresh.actions, ['idle']);
    assert.equal(fresh.frames_per_action, 2);
    assert.equal((await pool.query('SELECT 1 FROM sprite_concepts WHERE entity_type_id = $1', [e.id])).rowCount, 0);
  });
});

test('force leaves the entity\'s live sprite alone when an approved set exists', { skip }, async () => {
  await withEntity(async (pool, e) => {
    await insertSet(pool, e, { status: 'approved' });
    await pool.query(`UPDATE entity_types SET sprite = '{"atlas_key":"k"}'::jsonb, render_mode = 'sprite' WHERE id = $1`, [e.id]);
    await insertSet(pool, e, { status: 'done' });
    assert.equal((await force(build(pool), BODY(e))).status, 201);
    const { rows: [r] } = await pool.query('SELECT sprite FROM entity_types WHERE id = $1', [e.id]);
    assert.deepEqual(r.sprite, { atlas_key: 'k' });
  });
});

test('force refuses a subject whose concept is still being drawn and changes nothing', { skip }, async () => {
  await withEntity(async (pool, e) => {
    const live = await insertSet(pool, e, { status: 'running', box_task_id: 'task-1' });
    const done = await insertSet(pool, e, { status: 'done' });
    await insertConcept(pool, e);
    const res = await force(build(pool), BODY(e));
    assert.equal(res.status, 201);
    assert.equal(res.body.queued, 0);
    assert.deepEqual(res.body.refused, [{ entity_id: e.id, variant: null, reason: 'concept is still being drawn, try again in a minute' }]);
    const { rows } = await pool.query('SELECT id FROM sprite_sets WHERE entity_type_id = $1', [e.id]);
    assert.deepEqual(rows.map((r) => r.id).sort(), [live.id, done.id].sort());
    assert.equal((await pool.query('SELECT 1 FROM sprite_concepts WHERE entity_type_id = $1', [e.id])).rowCount, 1);
  });
});

test('force replaces a queued sheet-stage set and cancels its box job with source force', { skip }, async () => {
  await withEntity(async (pool, e) => {
    const live = await insertSet(pool, e, { status: 'queued', box_job_id: 'box-77' });
    const ctx = build(pool);
    const res = await force(ctx, BODY(e));
    assert.equal(res.status, 201);
    assert.equal(res.body.queued, 1);
    await settle();
    assert.deepEqual(ctx.cancels, [{ boxJobId: 'box-77', spriteSetId: live.id, subject: e.name, source: 'force' }]);
    const { rows } = await pool.query('SELECT id, status FROM sprite_sets WHERE entity_type_id = $1', [e.id]);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].id, live.id);
  });
});

test('force replaces a running sheet-stage set the dispatcher is not drawing', { skip }, async () => {
  await withEntity(async (pool, e) => {
    const live = await insertSet(pool, e, { status: 'running', box_task_id: 't', box_job_id: 'box-5' });
    const ctx = build(pool, { current: { id: 'some-other-row' } });
    const res = await force(ctx, BODY(e));
    assert.equal(res.body.queued, 1);
    await settle();
    assert.equal(ctx.cancels[0].boxJobId, 'box-5');
    assert.equal((await pool.query('SELECT 1 FROM sprite_sets WHERE id = $1', [live.id])).rowCount, 0);
  });
});

test('force refuses a running set the dispatcher is drawing right now', { skip }, async () => {
  await withEntity(async (pool, e) => {
    const live = await insertSet(pool, e, { status: 'running', box_task_id: 't', box_job_id: 'box-5' });
    const ctx = build(pool, { current: { id: live.id, entity_type_id: e.id } });
    const res = await force(ctx, BODY(e));
    assert.equal(res.body.queued, 0);
    assert.equal(res.body.refused[0].reason, 'the batch is drawing this subject right now — halt the batch first');
    assert.equal((await pool.query('SELECT 1 FROM sprite_sets WHERE id = $1', [live.id])).rowCount, 1);
    assert.deepEqual(ctx.cancels, []);
  });
});

test('force deletes the stored files of deleted rows after commit, in row-id folders', { skip }, async () => {
  await withEntity(async (pool, e) => {
    const done = await insertSet(pool, e, { status: 'done' });
    const key = `sprites/${e.name.replace(/[^A-Za-z0-9_-]/g, '_')}/${done.id}/atlas.png`;
    const ctx = build(pool, { files: { [key]: 1 } });
    await force(ctx, BODY(e));
    await settle();
    assert.deepEqual(ctx.removed, [key]);
  });
});

test('force rejects what POST /jobs rejects, with the same status and message', { skip }, async () => {
  await withEntity(async (pool, e) => {
    const ctx = build(pool);
    const bad = [
      { targets: [] , actions: ['idle'], frames: 2 },
      { targets: [{ entity_id: e.id }], actions: [], frames: 2 },
      { targets: [{ entity_id: e.id }], actions: ['idle'], frames: 2, prop_fx: 'nope' },
      { targets: [{ entity_id: e.id }], actions: ['idle'], frames: 2, directions: ['up'] },
      { targets: [{ entity_id: e.id }], actions: ['zzz'], frames: 2 },
      { targets: [{ entity_id: e.id }], actions: ['idle'], frames: 999 },
    ];
    for (const body of bad) {
      const a = await request(ctx.app).post('/api/sprite-admin/jobs').send(body);
      const b = await force(ctx, body);
      assert.equal(a.status, 400);
      assert.equal(b.status, a.status);
      assert.deepEqual(b.body, a.body);
    }
  });
});

test('force refuses a subject with a running redraw child, touching nothing', { skip }, async () => {
  await withEntity(async (pool, e) => {
    const done = await insertSet(pool, e, { status: 'done' });
    const child = await insertSet(pool, e, { status: 'running', redraw_of: done.id });
    await insertConcept(pool, e);
    const res = await force(build(pool), BODY(e));
    assert.equal(res.status, 201);
    assert.equal(res.body.queued, 0);
    assert.deepEqual(res.body.refused, [{ entity_id: e.id, variant: null, reason: 'a redraw of this subject is running — wait for it or halt the batch' }]);
    const { rows } = await pool.query('SELECT id FROM sprite_sets WHERE entity_type_id = $1', [e.id]);
    assert.deepEqual(rows.map((r) => r.id).sort(), [done.id, child.id].sort());
    assert.equal((await pool.query('SELECT 1 FROM sprite_concepts WHERE entity_type_id = $1', [e.id])).rowCount, 1);
  });
});

test('force refuses a running set with neither box task nor box job (just claimed)', { skip }, async () => {
  await withEntity(async (pool, e) => {
    const live = await insertSet(pool, e, { status: 'running' });
    const res = await force(build(pool), BODY(e));
    assert.equal(res.body.queued, 0);
    assert.equal(res.body.refused[0].reason, 'the batch just picked this subject up — try again in a minute');
    assert.equal((await pool.query('SELECT 1 FROM sprite_sets WHERE id = $1', [live.id])).rowCount, 1);
  });
});

test('one failing target is rolled back and listed; the others are regenerated and their cancels and file removal still run', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  const mk = async (n) => (await pool.query(
    "INSERT INTO entity_types (name, prompt, color, is_creature) VALUES ($1, 'a test wolf', '#888888', true) RETURNING id, name",
    [`force-multi-${n}-${Date.now()}`],
  )).rows[0];
  const ents = [await mk(1), await mk(2), await mk(3)];
  try {
    const lives = [];
    for (const [i, e] of ents.entries()) lives.push(await insertSet(pool, e, { status: 'queued', box_job_id: `box-${i}` }));
    const doneOld = await insertSet(pool, ents[0], { status: 'done' });
    const failId = ents[1].id;
    // A pool whose transactions fail on the second subject's concept step.
    const failing = {
      query: (...a) => pool.query(...a),
      connect: async () => {
        const c = await pool.connect();
        const q = c.query.bind(c);
        // Forwards every argument: pool.query() passes a callback through here.
        c.query = (sql, params, ...rest) => {
          if (/DELETE FROM sprite_concepts/.test(String(sql)) && Array.isArray(params) && params[0] === failId) return Promise.reject(new Error('boom'));
          return q(sql, params, ...rest);
        };
        return c;
      },
    };
    const files = { [`sprites/${ents[0].name.replace(/[^A-Za-z0-9_-]/g, "_")}/${doneOld.id}/atlas.png`]: 1 };
    const ctx = build(failing, { files });
    const res = await request(ctx.app).post('/api/sprite-admin/jobs/force')
      .send({ targets: ents.map((e) => ({ entity_id: e.id })), actions: ['idle'], frames: 2, directions: ['s'] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.queued, 2);
    assert.equal(res.body.refused.length, 1);
    assert.equal(res.body.refused[0].entity_id, failId);
    assert.match(res.body.refused[0].reason, /^failed: boom/);
    await settle();
    assert.deepEqual(ctx.cancels.map((c) => c.boxJobId).sort(), ['box-0', 'box-2']);
    const { rows: [mid] } = await pool.query('SELECT id FROM sprite_sets WHERE id = $1', [lives[1].id]);
    assert.ok(mid, 'failed target rolled back: its live set is intact');
    for (const i of [0, 2]) assert.equal((await pool.query('SELECT 1 FROM sprite_sets WHERE id = $1', [lives[i].id])).rowCount, 0);
    assert.equal(ctx.removed.length, 1, 'stored files of the committed targets were removed');
  } finally {
    for (const e of ents) {
      await pool.query('DELETE FROM sprite_sets WHERE entity_type_id = $1', [e.id]);
      await pool.query('DELETE FROM entity_types WHERE id = $1', [e.id]);
    }
    await pool.end();
  }
});
