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
