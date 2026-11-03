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
      if (/FROM ai_providers WHERE id = \$1/i.test(sql)) return { rows: params[0] === 12 ? [{ id: 12 }] : [] };
      if (/count\(\*\).*FROM sprite_sets/is.test(sql)) return { rows: [] };
      if (/UPDATE sprite_sets/i.test(sql)) return { rows: [] };
      if (/DELETE FROM sprite_sets/i.test(sql)) return { rows: [] };
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
      if (/DELETE FROM sprite_sets/i.test(sql)) return { rows: [] };
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
    assert.deepEqual(update.params, [[4], [null], [6], ['idle,walk,attack'], [null], ['s,e,n'], [false], [null], [false], [null]]);
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
      if (/DELETE FROM sprite_sets/i.test(sql)) return { rows: [] };
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

test('jobs stores prop_fx on prop rows only, defaulting to drift', async () => {
  for (const [sent, want] of [[undefined, 'drift'], ['shine', 'shine'], ['sway', 'sway'], ['drift', 'drift'], ['none', 'none']]) {
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
    assert.match(res.body.error, /prop_fx must be one of none, sway, shine, drift/);
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

test('POST /api/sprite-admin/jobs validates cell and stores NULL for 48x64 or omitted (SOMET-706)', async () => {
  const body = { targets: [{ entity_id: 4 }], actions: ['idle'], frames: 4 };
  for (const bad of ['32x32', '96X128', 96, '']) {
    const res = await request(routerApp(enqueuePool([]))).post('/api/sprite-admin/jobs').send({ ...body, cell: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.body.error, 'cell must be one of 48x64, 96x128');
  }
  const insertCell = async (cellBody, path = '/api/sprite-admin/jobs') => {
    const calls = [];
    const res = await request(routerApp(enqueuePool(calls))).post(path).send({ ...body, ...cellBody });
    assert.equal(res.status, 201);
    return calls.find((c) => /INSERT INTO sprite_sets/i.test(c.sql)).params[11];
  };
  assert.deepEqual(await insertCell({}), [null]);
  assert.deepEqual(await insertCell({ cell: '48x64' }), [null]);
  assert.deepEqual(await insertCell({ cell: '96x128' }), ['96x128']);
});

test('POST /api/sprite-admin/jobs validates and normalizes directions (SOMET-686)', async () => {
  const body = { targets: [{ entity_id: 4 }], actions: ['idle'], frames: 4 };
  const msg = 'directions must be a non-empty list of: s, se, e, ne, n, nw, w, sw';
  for (const bad of [['up'], [], 's']) {
    const res = await request(routerApp(enqueuePool([]))).post('/api/sprite-admin/jobs').send({ ...body, directions: bad });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, msg);
  }
  const calls = [];
  const ok = await request(routerApp(enqueuePool(calls))).post('/api/sprite-admin/jobs').send({ ...body, directions: ['E', 's', 'e'] });
  assert.equal(ok.status, 201);
  const insert = calls.find((c) => /INSERT INTO sprite_sets/i.test(c.sql));
  assert.deepEqual(insert.params[8], ['s,e']);
  assert.deepEqual(insert.params[10], [false], 'real_western stays false for s,e (SOMET-700)');
  const callsW = [];
  const west = await request(routerApp(enqueuePool(callsW))).post('/api/sprite-admin/jobs').send({ ...body, directions: ['s', 'w'] });
  assert.equal(west.status, 201);
  assert.deepEqual(callsW.find((c) => /INSERT INTO sprite_sets/i.test(c.sql)).params[10], [true], 'a western facing sets real_western');
  const calls2 = [];
  const dflt = await request(routerApp(enqueuePool(calls2))).post('/api/sprite-admin/jobs').send(body);
  assert.equal(dflt.status, 201);
  assert.deepEqual(calls2.find((c) => /INSERT INTO sprite_sets/i.test(c.sql)).params[8], ['s,e,n']);
});

// --- GPU-box cancel tracking (SOMET-695) ---

const OPEN_CANCEL = {
  id: '5', box_job_id: 'bj-5', sprite_set_id: null, subject: 'Wolf', source: 'halt', state: 'still_drawing',
  requested_at: '2026-11-02T12:00:00.000Z', last_progress: 'cell 4', last_box_updated_at: 'u2',
  last_change_at: null, checked_at: null, stopped_at: null,
};

// Answers by SQL shape; `recorded` collects the sprite_box_cancels upserts.
function cancelPool({ cleared = [], open = [OPEN_CANCEL] } = {}) {
  const recorded = [];
  const base = enqueuePool([]);
  return {
    recorded,
    query: async (sql, params = []) => {
      if (/INSERT INTO sprite_box_cancels/i.test(sql)) { recorded.push(params); return { rows: [] }; }
      if (/FROM sprite_box_cancels WHERE id = \$1/i.test(sql)) return { rows: open.filter((r) => r.id === String(params[0])) };
      if (/FROM sprite_box_cancels/i.test(sql)) return { rows: open };
      if (/^\s*DELETE FROM sprite_sets/i.test(sql)) return { rows: cleared };
      if (/FROM sprite_sets s\s+WHERE s.entity_type_id IS NOT NULL/i.test(sql)) return { rows: [] };
      if (/SELECT status, count/i.test(sql)) return { rows: [] };
      return base.query(sql, params);
    },
  };
}

test('jobs/clear cancels the cleared rows box jobs and records them (SOMET-695)', async () => {
  const pool = cancelPool({ cleared: [
    { id: 'r1', creature: 'Wolf', box_job_id: 'bj-9' },
    { id: 'r2', creature: 'Bat', box_job_id: null },
  ] });
  const cancelled = [];
  let done;
  const finished = new Promise((r) => { done = r; });
  const a = routerApp(pool, { box: { cancelSheetJob: async (_p, id) => { cancelled.push(id); done(); return { ok: true }; } } });
  const res = await request(a).post('/api/sprite-admin/jobs/clear').send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.cleared, 2);
  await finished;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(cancelled, ['bj-9']);
  assert.equal(pool.recorded.length, 1);
  assert.equal(pool.recorded[0][0], 'bj-9');
  assert.equal(pool.recorded[0][3], 'clear');
});

test('GET jobs includes box_cancels (SOMET-695)', async () => {
  const prev = process.env.SPRITE_CANCEL_VERIFY_MS;
  process.env.SPRITE_CANCEL_VERIFY_MS = '999999999';
  try {
    const res = await request(routerApp(cancelPool())).get('/api/sprite-admin/jobs');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.box_cancels, [{
      id: '5', box_job_id: 'bj-5', subject: 'Wolf', source: 'halt', state: 'still_drawing',
      requested_at: '2026-11-02T12:00:00.000Z', last_progress: 'cell 4',
    }]);
  } finally {
    if (prev === undefined) delete process.env.SPRITE_CANCEL_VERIFY_MS; else process.env.SPRITE_CANCEL_VERIFY_MS = prev;
  }
});

test('GET jobs and POST jobs/dispatch answer promptly when the box never answers the cancel check (SOMET-695)', async () => {
  const prev = process.env.SPRITE_CANCEL_VERIFY_MS;
  process.env.SPRITE_CANCEL_VERIFY_MS = '1';
  try {
    let asked = 0;
    let tick = 0;
    const box = { getSheetJob: () => { asked += 1; return new Promise(() => {}); } };
    const a = express();
    a.use(express.json());
    const stubDispatcher = { status: () => ({ running: true }), start: () => new Promise(() => {}) };
    a.use('/api/sprite-admin', spriteBatchRoutes(cancelPool(), (_q, _s, next) => next(), stubDispatcher, {
      box, loadProvider: async () => PROVIDER, now: () => Date.parse('2026-11-02T12:01:00Z') + (tick += 1),
    }));
    const timed = (p) => Promise.race([p, new Promise((_r, rej) => setTimeout(() => rej(new Error('request hung')), 2000))]);
    const got = await timed(request(a).get('/api/sprite-admin/jobs'));
    assert.equal(got.status, 200);
    assert.equal(got.body.box_cancels.length, 1);
    await new Promise((r) => setTimeout(r, 20));
    const dispatched = await timed(request(a).post('/api/sprite-admin/jobs/dispatch').send({}));
    assert.equal(dispatched.status, 202);
    assert.equal(dispatched.body.box_cancels.length, 1);
    assert.equal(asked, 1, 'only one verify in flight at a time');
  } finally {
    if (prev === undefined) delete process.env.SPRITE_CANCEL_VERIFY_MS; else process.env.SPRITE_CANCEL_VERIFY_MS = prev;
  }
});

test('GET jobs still answers when the box cancel check fails (SOMET-695)', async () => {
  const boxCancels = {
    verify: async () => { throw new Error('box down'); },
    open: async () => { throw new Error('db down'); },
    view: (r) => r,
  };
  const res = await request(routerApp(cancelPool(), { boxCancels, box: { getSheetJob: async () => ({ ok: false }) } }))
    .get('/api/sprite-admin/jobs');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.box_cancels, []);
});

test('POST jobs/box-cancels/:id/retry re-sends the cancel; unknown id is 404 (SOMET-695)', async () => {
  const pool = cancelPool();
  const cancelled = [];
  const a = routerApp(pool, { box: { cancelSheetJob: async (_p, id) => { cancelled.push(id); return { ok: true }; } } });
  const ok = await request(a).post('/api/sprite-admin/jobs/box-cancels/5/retry').send({});
  assert.equal(ok.status, 200);
  assert.equal(ok.body.box_cancel.box_job_id, 'bj-5');
  assert.deepEqual(cancelled, ['bj-5']);
  assert.equal(pool.recorded[0][3], 'retry');
  const missing = await request(a).post('/api/sprite-admin/jobs/box-cancels/77/retry').send({});
  assert.equal(missing.status, 404);
  const junk = await request(a).post('/api/sprite-admin/jobs/box-cancels/abc/retry').send({});
  assert.equal(junk.status, 404);
  assert.deepEqual(cancelled, ['bj-5']);
});

test('POST /api/sprite-admin/jobs validates redraw_actions and stores it (SOMET-711)', async () => {
  const body = { targets: [{ entity_id: 4 }], actions: ['idle'], frames: 4 };
  for (const bad of ['yes', 1, 0, 'true']) {
    const res = await request(routerApp(enqueuePool([]))).post('/api/sprite-admin/jobs').send({ ...body, redraw_actions: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.body.error, 'redraw_actions must be true or false');
  }
  const insertFlag = async (extra) => {
    const calls = [];
    const res = await request(routerApp(enqueuePool(calls))).post('/api/sprite-admin/jobs').send({ ...body, ...extra });
    assert.equal(res.status, 201);
    return calls.find((c) => /INSERT INTO sprite_sets/i.test(c.sql)).params[12];
  };
  assert.deepEqual(await insertFlag({}), [false]);
  assert.deepEqual(await insertFlag({ redraw_actions: false }), [false]);
  assert.deepEqual(await insertFlag({ redraw_actions: true }), [true]);
});

test('GET /api/sprite-admin/connectors lists enabled sprite connectors with engine and per-connector seconds (HQ lane)', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/FROM ai_providers/i.test(sql)) {
        return { rows: [
          { id: 8, name: 'GPU box', is_active: true, request_template: {} },
          { id: 12, name: 'GPU box HQ', is_active: false, request_template: { engine: 'comfyui-hq' } },
        ] };
      }
      if (/sheet_seconds/i.test(sql) && /spc/i.test(sql)) return { rows: params[0] === 8 ? [{ spc: 40 }] : [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const res = await request(routerApp(pool)).get('/api/sprite-admin/connectors');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [
    { id: 8, name: 'GPU box', engine: 'diffusers', is_active: true, seconds_per_cell: 40 },
    { id: 12, name: 'GPU box HQ', engine: 'comfyui-hq', is_active: false, seconds_per_cell: 70 },
  ]);
  const listSql = calls.find((c) => /FROM ai_providers/i.test(c.sql)).sql;
  assert.match(listSql, /enabled/i);
  assert.match(listSql, /modality = 'sprite'/i);
});

test('POST /api/sprite-admin/jobs validates provider_id against enabled sprite connectors and stores it (HQ lane)', async () => {
  const body = { targets: [{ entity_id: 4 }], actions: ['idle'], frames: 4 };
  for (const bad of ['x', 0, -1, 1.5, 99]) {
    const res = await request(routerApp(enqueuePool([]))).post('/api/sprite-admin/jobs').send({ ...body, provider_id: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.body.error, 'provider_id must be an enabled sprite connector');
  }
  const insertProvider = async (extra) => {
    const calls = [];
    const res = await request(routerApp(enqueuePool(calls))).post('/api/sprite-admin/jobs').send({ ...body, ...extra });
    assert.equal(res.status, 201);
    return calls.find((c) => /INSERT INTO sprite_sets/i.test(c.sql)).params[13];
  };
  assert.deepEqual(await insertProvider({}), [null]);
  assert.deepEqual(await insertProvider({ provider_id: 12 }), [12]);
});
