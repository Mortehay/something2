const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { app, __setPool } = require('../src/index.js');
const spriteBatchRoutes = require('../src/api/spriteBatchRoutes.js');

const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/gpuBox/action-catalog.json'), 'utf8'));
const PROVIDER = { id: 'p1', base_url: 'http://box.test', auth_token: 'secret-token' };
const dispatcher = { status: () => ({ running: false }) };

// The router on its own, with the box and provider loader injected, so the
// catalog behaviour is tested without reaching a real box or the shared app.
function routerApp(pool, deps = {}) {
  const a = express();
  a.use(express.json());
  a.use('/api/sprite-admin', spriteBatchRoutes(pool, (_q, _s, next) => next(), dispatcher, {
    box: { actionCatalog: async () => ({ ok: true, catalog: CATALOG }) },
    loadProvider: async () => PROVIDER,
    ...deps,
  }));
  return a;
}

function enqueuePool(calls, { spc = null } = {}) {
  return {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/sheet_seconds/i.test(sql) && /spc/i.test(sql)) return { rows: spc == null ? [] : [{ spc }] };
      if (/FROM entity_types WHERE id = ANY/i.test(sql)) {
        return { rows: [{ id: 4, name: 'Wolf', prompt: 'grey wolf', render_mode: 'static', is_creature: true, is_playable: false }] };
      }
      if (/count\(\*\).*FROM sprite_sets/is.test(sql)) return { rows: [] };
      if (/UPDATE sprite_sets/i.test(sql)) return { rows: [] };
      if (/INSERT INTO sprite_sets/i.test(sql)) return { rows: [{ id: 'job-row', status: 'queued' }] };
      if (/SELECT status, count/i.test(sql)) return { rows: [{ status: 'queued', n: 1 }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

test('POST /api/sprite-admin/jobs derives queue options from entity rows', async () => {
  const calls = [];
  const res = await request(routerApp(enqueuePool(calls))).post('/api/sprite-admin/jobs')
    .send({ targets: [{ entity_id: 4 }], actions: ['idle', 'walk'], frames: 4 });

  assert.equal(res.status, 201);
  assert.equal(res.body.queued, 1);
  const insert = calls.find((call) => /INSERT INTO sprite_sets/i.test(call.sql));
  assert.deepEqual(insert.params[1], [null]);
  assert.deepEqual(insert.params[2], ['Wolf']);
  assert.deepEqual(insert.params[3], ['creature']);
  assert.deepEqual(insert.params[4], ['grey wolf']);
  assert.deepEqual(insert.params[6], [4]);
});

test('POST /api/sprite-admin/jobs targets an appearance variant instead of the class itself', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/FROM character_appearances ca JOIN entity_types/i.test(sql)) {
        return { rows: [{ entity_type_id: 3, variant: 2, class_name: 'Mage', class_prompt: 'a spell-flinging mage' }] };
      }
      if (/count\(\*\).*FROM sprite_sets/is.test(sql)) return { rows: [] };
      if (/UPDATE sprite_sets/i.test(sql)) return { rows: [] };
      if (/INSERT INTO sprite_sets/i.test(sql)) return { rows: [{ id: 'job-row', status: 'queued' }] };
      if (/SELECT status, count/i.test(sql)) return { rows: [{ status: 'queued', n: 1 }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const res = await request(routerApp(pool)).post('/api/sprite-admin/jobs')
    .send({ targets: [{ entity_id: 3, variant: 2 }], actions: ['idle'], frames: 2 });

  assert.equal(res.status, 201);
  assert.equal(res.body.queued, 1);
  const insert = calls.find((call) => /INSERT INTO sprite_sets/i.test(call.sql));
  assert.deepEqual(insert.params[0], [3]);
  assert.deepEqual(insert.params[1], [2]);
  assert.deepEqual(insert.params[2], ['Mage:2']);
});

test('catalog proxies the box with seconds_per_cell', async () => {
  let fetches = 0;
  const calls = [];
  const a = routerApp(enqueuePool(calls, { spc: 12.5 }), {
    box: { actionCatalog: async () => { fetches += 1; return { ok: true, catalog: CATALOG }; } },
  });
  const res = await request(a).get('/api/sprite-admin/action-catalog');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.actions, CATALOG.actions);
  assert.deepEqual(res.body.directions, CATALOG.directions);
  assert.equal(res.body.max_frames, 6);
  assert.deepEqual(res.body.engine, CATALOG.engine);
  assert.equal(res.body.seconds_per_cell, 12.5);
  assert.ok(!JSON.stringify(res.body).includes('secret-token'));
  await request(a).get('/api/sprite-admin/action-catalog');
  assert.equal(fetches, 1, 'second call within 60 s is served from the cache');
});

test('catalog seeds seconds_per_cell at 57 when nothing has been measured', async () => {
  const res = await request(routerApp(enqueuePool([]))).get('/api/sprite-admin/action-catalog');
  assert.equal(res.body.seconds_per_cell, 57);
});

test('catalog cache expires after 60 s', async () => {
  let t = 1000;
  let fetches = 0;
  const a = routerApp(enqueuePool([]), {
    now: () => t,
    box: { actionCatalog: async () => { fetches += 1; return { ok: true, catalog: CATALOG }; } },
  });
  await request(a).get('/api/sprite-admin/action-catalog');
  t += 61000;
  await request(a).get('/api/sprite-admin/action-catalog');
  assert.equal(fetches, 2);
});

test('catalog 503 when box down, and the failure is not cached', async () => {
  let up = false;
  const a = routerApp(enqueuePool([]), {
    box: { actionCatalog: async () => (up ? { ok: true, catalog: CATALOG } : { ok: false, error: 'connection refused' }) },
  });
  const down = await request(a).get('/api/sprite-admin/action-catalog');
  assert.equal(down.status, 503);
  assert.match(down.body.error, /connection refused/);
  up = true;
  assert.equal((await request(a).get('/api/sprite-admin/action-catalog')).status, 200);
});

test('catalog 503 with the settings hint when no sprite provider is active', async () => {
  const res = await request(routerApp(enqueuePool([]), { loadProvider: async () => null }))
    .get('/api/sprite-admin/action-catalog');
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'no sprite provider configured — add one in Settings → AI Providers (modality Sprite)');
});

test('jobs 400 on unknown action', async () => {
  const calls = [];
  const res = await request(routerApp(enqueuePool(calls))).post('/api/sprite-admin/jobs')
    .send({ targets: [{ entity_id: 4 }], actions: ['idle', 'moonwalk'], frames: 2 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /moonwalk/);
  assert.ok(!calls.some((c) => /INSERT/i.test(c.sql)));
});

test('jobs 400 when actions is empty or missing', async () => {
  for (const body of [{ frames: 2 }, { actions: [], frames: 2 }, { actions: [3], frames: 2 }]) {
    const res = await request(routerApp(enqueuePool([]))).post('/api/sprite-admin/jobs')
      .send({ targets: [{ entity_id: 4 }], ...body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test("jobs 400 when frames exceed the selected actions' cap", async () => {
  const catalog = { ...CATALOG, actions: CATALOG.actions.map((a) => (a.id === 'attack' ? { ...a, max_frames: 3 } : a)) };
  const a = routerApp(enqueuePool([]), { box: { actionCatalog: async () => ({ ok: true, catalog }) } });
  const over = await request(a).post('/api/sprite-admin/jobs')
    .send({ targets: [{ entity_id: 4 }], actions: ['idle', 'attack'], frames: 4 });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /1 to 3/);
  for (const frames of [0, 1.5, '2', undefined]) {
    const res = await request(a).post('/api/sprite-admin/jobs')
      .send({ targets: [{ entity_id: 4 }], actions: ['idle'], frames });
    assert.equal(res.status, 400, `frames=${frames}`);
  }
  // idle alone allows 6: the cap follows the selection.
  const ok = await request(a).post('/api/sprite-admin/jobs')
    .send({ targets: [{ entity_id: 4 }], actions: ['idle'], frames: 6 });
  assert.equal(ok.status, 201);
});

test('jobs 503 when the catalog is unreachable', async () => {
  const a = routerApp(enqueuePool([]), { box: { actionCatalog: async () => ({ ok: false, error: 'timeout' }) } });
  const res = await request(a).post('/api/sprite-admin/jobs')
    .send({ targets: [{ entity_id: 4 }], actions: ['idle'], frames: 2 });
  assert.equal(res.status, 503);
});

test('jobs 201 queues with actions and frames', async () => {
  const calls = [];
  const res = await request(routerApp(enqueuePool(calls))).post('/api/sprite-admin/jobs')
    .send({ targets: [{ entity_id: 4 }], actions: ['idle', 'walk', 'idle'], frames: 4 });
  assert.equal(res.status, 201);
  const insert = calls.find((c) => /INSERT INTO sprite_sets/i.test(c.sql));
  assert.deepEqual(insert.params[6], [4], 'frames per row');
  assert.deepEqual(insert.params[7], ['idle,walk'], 'duplicates collapsed, comma-joined');
});

// A mistaken queue (idle only, 4 frames) is fixed by queuing the row again:
// the queued job takes the new options, a running one is reported skipped.
test('jobs 201 updates an already-queued target and skips a running one', async () => {
  for (const [updatedRows, expected] of [
    [[{ id: 'job-row', status: 'queued' }], { queued: 0, updated: 1, skipped: 0 }],
    [[], { queued: 0, updated: 0, skipped: 1 }],
  ]) {
    const calls = [];
    const base = enqueuePool(calls);
    const pool = {
      query: async (sql, params) => {
        if (/UPDATE sprite_sets/i.test(sql)) { calls.push({ sql, params }); return { rows: updatedRows }; }
        if (/INSERT INTO sprite_sets/i.test(sql)) { calls.push({ sql, params }); return { rows: [] }; }
        return base.query(sql, params);
      },
    };
    const res = await request(routerApp(pool)).post('/api/sprite-admin/jobs')
      .send({ targets: [{ entity_id: 4 }], actions: ['idle', 'walk', 'attack'], frames: 6 });
    assert.equal(res.status, 201);
    assert.deepEqual({ queued: res.body.queued, updated: res.body.updated, skipped: res.body.skipped }, expected);
    const update = calls.find((c) => /UPDATE sprite_sets/i.test(c.sql));
    assert.match(update.sql, /status = 'queued'/);
    assert.deepEqual(update.params, [[4], [null], [6], ['idle,walk,attack'], [null]]);
  }
});

test('POST /api/sprite-admin/jobs rejects an out-of-range variant', async () => {
  __setPool({ query: async (sql) => { if (isUserLookup(sql)) return ADMIN_USER_ROW; throw new Error(`unexpected query: ${sql}`); } });
  const res = await request(app).post('/api/sprite-admin/jobs').set(...AUTH)
    .send({ targets: [{ entity_id: 3, variant: 6 }] });
  assert.equal(res.status, 400);
});


// A null/primitive element used to coerce to entity_id 0 and pass validation
// (201 with unknown:[0]) instead of being rejected as malformed.
for (const bad of [null, 7, 'x', [], { entity_id: 0 }, { entity_id: '' }, { entity_id: -1 }]) {
  test(`POST /api/sprite-admin/jobs rejects a malformed target ${JSON.stringify(bad)}`, async () => {
    __setPool({ query: async (sql) => { if (isUserLookup(sql)) return ADMIN_USER_ROW; throw new Error(`unexpected query: ${sql}`); } });
    const res = await request(app).post('/api/sprite-admin/jobs').set(...AUTH)
      .send({ targets: [bad] });
    assert.equal(res.status, 400);
  });
}

test('jobs: an action without a finite max_frames falls back to the catalog max_frames', async () => {
  const catalog = { ...CATALOG, actions: CATALOG.actions.map((a) => (a.id === 'attack' ? { ...a, max_frames: undefined } : a)) };
  const a = routerApp(enqueuePool([]), { box: { actionCatalog: async () => ({ ok: true, catalog }) } });
  const send = (frames) => request(a).post('/api/sprite-admin/jobs')
    .send({ targets: [{ entity_id: 4 }], actions: ['idle', 'attack'], frames });
  assert.equal((await send(CATALOG.max_frames)).status, 201);
  const over = await send(CATALOG.max_frames + 1);
  assert.equal(over.status, 400);
  assert.match(over.body.error, new RegExp(`1 to ${CATALOG.max_frames}`));
});

test('jobs 400 "catalog has no frame limit" when neither action nor catalog has one', async () => {
  const catalog = { ...CATALOG, max_frames: undefined, actions: CATALOG.actions.map((a) => ({ ...a, max_frames: undefined })) };
  const a = routerApp(enqueuePool([]), { box: { actionCatalog: async () => ({ ok: true, catalog }) } });
  const res = await request(a).post('/api/sprite-admin/jobs')
    .send({ targets: [{ entity_id: 4 }], actions: ['idle'], frames: 2 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /catalog has no frame limit/);
});

// Props v2: the prop's idle effect is chosen explicitly at queue time
// (prop_fx), stored per row; creature rows carry none (NULL).
function mixedPool(calls) {
  return {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/FROM entity_types WHERE id = ANY/i.test(sql)) {
        return { rows: [
          { id: 4, name: 'Wolf', prompt: 'grey wolf', render_mode: 'static', is_creature: true, is_playable: false },
          { id: 12, name: 'Crystal', prompt: 'a crystal', render_mode: 'static', is_creature: false, is_playable: false },
        ] };
      }
      if (/count\(\*\).*FROM sprite_sets/is.test(sql)) return { rows: [] };
      if (/UPDATE sprite_sets/i.test(sql)) return { rows: [] };
      if (/INSERT INTO sprite_sets/i.test(sql)) return { rows: [{ id: 'a' }, { id: 'b' }] };
      if (/SELECT status, count/i.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}
// prop_fx is the INSERT's last unnest column ($10).
const propFxParam = (insert) => {
  assert.match(insert.sql, /\bprop_fx\b/, 'INSERT writes prop_fx');
  assert.match(insert.sql, /\$10::text\[\]/);
  return insert.params[9];
};

test('jobs stores prop_fx on prop rows only, defaulting to none', async () => {
  for (const [sent, want] of [[undefined, 'none'], ['shine', 'shine'], ['sway', 'sway'], ['none', 'none']]) {
    const calls = [];
    // eslint-disable-next-line no-await-in-loop
    const res = await request(routerApp(mixedPool(calls))).post('/api/sprite-admin/jobs')
      .send({ targets: [{ entity_id: 4 }, { entity_id: 12 }], actions: ['idle'], frames: 1, prop_fx: sent });
    assert.equal(res.status, 201, String(sent));
    const insert = calls.find((c) => /INSERT INTO sprite_sets/i.test(c.sql));
    const kinds = insert.params[3];
    const fx = propFxParam(insert);
    assert.deepEqual(kinds, ['creature', 'object']);
    assert.deepEqual(fx, [null, want], String(sent));
  }
});

for (const bad of ['glow', '', 'SHINE', 3, null]) {
  test(`jobs 400 on prop_fx ${JSON.stringify(bad)}`, async () => {
    const calls = [];
    const res = await request(routerApp(mixedPool(calls))).post('/api/sprite-admin/jobs')
      .send({ targets: [{ entity_id: 12 }], actions: ['idle'], frames: 1, prop_fx: bad });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /prop_fx must be one of none, sway, shine/);
    assert.ok(!calls.some((c) => /INSERT/i.test(c.sql)));
  });
}

test('GET /api/sprite-admin/subjects shows an appearance variant its own art without counting it as a sprite', async () => {
  const pool = {
    query: async (sql) => {
      if (/FROM character_appearances ca/i.test(sql)) {
        return { rows: [{ entity_type_id: 3, variant: 2, render_mode: 'static', sprite: null, image: 'sprites/mage/appearance-2.png',
          class_name: 'Mage', class_prompt: 'a spell-flinging mage' }] };
      }
      if (/FROM entity_types e/i.test(sql)) {
        return { rows: [{ id: 3, name: 'Mage', prompt: 'a spell-flinging mage', render_mode: 'static', is_creature: false, is_playable: true, image: null, sprite: null }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const res = await request(routerApp(pool)).get('/api/sprite-admin/subjects');
  assert.equal(res.status, 200);
  const variant = res.body.subjects.find((s) => s.id === '3:2');
  assert.equal(variant.appearance_image, 'sprites/mage/appearance-2.png');
  // A portrait is not a sprite sheet: the row must stay "missing visual" until it gets one.
  assert.equal(variant.image, null);
});

test('GET /jobs returns the run with live progress and batch totals', async () => {
  const run = {
    running: true, completed: 1, failed: 0, totalCells: 40, doneCells: 16, secondsPerCell: 12.5,
    current: { id: 'row-2', entity_type_id: 4, creature: 'Bat', phase: 'running', pct: 37, message: 'cell 3/8', cells: 8 },
  };
  const pool = { query: async (sql) => (/GROUP BY status/i.test(sql) ? { rows: [{ status: 'running', n: 1 }] } : { rows: [] }) };
  const live = { status: () => run };
  const b = express();
  b.use(express.json());
  b.use('/api/sprite-admin', spriteBatchRoutes(pool, (_q, _s, next) => next(), live, {
    box: {}, loadProvider: async () => PROVIDER,
  }));
  const res = await request(b).get('/api/sprite-admin/jobs');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.run, run);
});

test('POST /jobs/halt halts the dispatcher and returns its run', async () => {
  let halted = 0;
  const d = { status: () => ({ running: true, halting: halted > 0 }), halt: () => { halted += 1; return true; } };
  const a = express();
  a.use(express.json());
  a.use('/api/sprite-admin', spriteBatchRoutes(enqueuePool([]), (_q, _s, next) => next(), d, {}));
  const res = await request(a).post('/api/sprite-admin/jobs/halt').send({});
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { halting: true, run: { running: true, halting: true } });
  assert.equal(halted, 1);
});

// Updating a rescued row's options detaches its box job (that job draws the
// old sheet); the route then asks the box to cancel it.
test('jobs: a box job detached by an update is cancelled on the box', async () => {
  const base = enqueuePool([]);
  const pool = {
    query: async (sql, params) => {
      if (/UPDATE sprite_sets/i.test(sql)) return { rows: [{ id: 'r', status: 'queued', dropped_box_job_id: 'old-box-job' }] };
      if (/INSERT INTO sprite_sets/i.test(sql)) return { rows: [] };
      return base.query(sql, params);
    },
  };
  const cancelled = [];
  let done;
  const finished = new Promise((r) => { done = r; });
  const a = routerApp(pool, {
    box: {
      actionCatalog: async () => ({ ok: true, catalog: CATALOG }),
      cancelSheetJob: async (provider, id) => { cancelled.push([provider.id, id]); done(); return { ok: true }; },
    },
  });
  const res = await request(a).post('/api/sprite-admin/jobs')
    .send({ targets: [{ entity_id: 4 }], actions: ['idle', 'walk'], frames: 6 });
  assert.equal(res.status, 201);
  assert.equal(res.body.updated, 1);
  await finished;
  assert.deepEqual(cancelled, [['p1', 'old-box-job']]);
});
