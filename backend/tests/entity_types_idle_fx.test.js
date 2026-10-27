// Props v2 -- entity_types.idle_fx ('none' | 'sway' | 'shine') is the
// procedural idle effect the renderer gives a static-image prop. /api/map/config
// must carry it (decorations and world points both spread the catalog def; see
// RenderSystem.collectDecorations / pointBodyRef), and the entity editor saves
// it through the ordinary entity-type routes, validated server-side.
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { adminToken, withAuth } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

function poolWith(entityRows) {
  return {
    query: async (sql) => (/FROM entity_types/i.test(sql) ? { rows: entityRows } : { rows: [] }),
  };
}

test('GET /api/map/config exposes idle_fx, defaulting anything unknown to none', async () => {
  __setPool(poolWith([
    { id: 1, name: 'Pine', is_creature: false, render_mode: 'static', image: 'a.png', idle_fx: 'sway' },
    { id: 2, name: 'Crystal', is_creature: false, render_mode: 'static', image: 'b.png', idle_fx: 'shine' },
    { id: 3, name: 'Rock', is_creature: false, render_mode: 'static', image: 'c.png', idle_fx: 'none' },
    { id: 4, name: 'Old', is_creature: false, render_mode: 'static', image: 'd.png' },
  ]));
  const res = await request(app).get('/api/map/config');
  assert.strictEqual(res.status, 200);
  const t = res.body.entityTypes;
  assert.strictEqual(t.Pine.idle_fx, 'sway');
  assert.strictEqual(t.Crystal.idle_fx, 'shine');
  assert.strictEqual(t.Rock.idle_fx, 'none');
  assert.strictEqual(t.Old.idle_fx, 'none');
  assert.ok(!('sway' in t.Pine), 'the boolean sway field is gone');
});

function putMock(bodyName, onUpdate) {
  const client = {
    query: async (s, p) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(s.trim())) return { rows: [] };
      if (/SELECT name FROM entity_types WHERE id/i.test(s)) return { rows: [{ name: bodyName }] };
      return onUpdate(s, p);
    },
    release: () => {},
  };
  return {
    query: withAuth(async (s) => { throw new Error(`unexpected pool.query: ${s}`); }),
    connect: async () => client,
  };
}

function caseParams(sql, params, column) {
  const m = new RegExp(`\\b${column}\\s*=\\s*CASE WHEN \\$(\\d+)::boolean THEN \\$(\\d+)`, 'i').exec(sql);
  assert.ok(m, `UPDATE does not guard '${column}' with a was-it-sent flag`);
  return { sent: params[Number(m[1]) - 1], value: params[Number(m[2]) - 1] };
}

for (const bad of ['wobble', '', 'SWAY', 1, true]) {
  test(`PUT /api/entity-types/:id 400s an unknown idle_fx ${JSON.stringify(bad)}`, async () => {
    __setPool(putMock('Pine', async () => { throw new Error('must not write'); }));
    const res = await request(app).put('/api/entity-types/5').set(...AUTH)
      .send({ name: 'Pine', color: '#0f0', idle_fx: bad });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /idle_fx must be one of none, sway, shine/);
  });
}

test('PUT /api/entity-types/:id writes a sent idle_fx and keeps id last', async () => {
  for (const fx of ['none', 'sway', 'shine']) {
    let sql = null, params = null;
    __setPool(putMock('Pine', async (s, p) => { sql = s; params = p; return { rows: [{ id: 5 }] }; }));
    // eslint-disable-next-line no-await-in-loop
    const res = await request(app).put('/api/entity-types/5').set(...AUTH)
      .send({ name: 'Pine', color: '#0f0', idle_fx: fx });
    assert.strictEqual(res.status, 200, fx);
    assert.deepStrictEqual(caseParams(sql, params, 'idle_fx'), { sent: true, value: fx });
    assert.strictEqual(params[params.length - 1], '5');
  }
});

test('PUT /api/entity-types/:id leaves idle_fx alone when it is not sent', async () => {
  let sql = null, params = null;
  __setPool(putMock('Pine', async (s, p) => { sql = s; params = p; return { rows: [{ id: 5 }] }; }));
  const res = await request(app).put('/api/entity-types/5').set(...AUTH).send({ name: 'Pine', color: '#0f0' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(caseParams(sql, params, 'idle_fx').sent, false);
});

test('POST /api/entity-types binds idle_fx (default none) and 400s an unknown one', async () => {
  for (const [body, want] of [[{}, 'none'], [{ idle_fx: 'shine' }, 'shine']]) {
    let sql = null, params = null;
    __setPool({ query: withAuth(async (s, p) => { sql = s; params = p; return { rows: [{ id: 1 }] }; }) });
    // eslint-disable-next-line no-await-in-loop
    const res = await request(app).post('/api/entity-types').set(...AUTH).send({ name: 'Gem', color: '#0f0', ...body });
    assert.strictEqual(res.status, 201);
    const cols = /INSERT INTO\s+\w+\s*\(([\s\S]*?)\)\s*VALUES/i.exec(sql)[1].split(',').map((c) => c.trim());
    assert.strictEqual(params[cols.indexOf('idle_fx')], want);
  }
  __setPool({ query: withAuth(async () => { throw new Error('must not insert'); }) });
  const bad = await request(app).post('/api/entity-types').set(...AUTH).send({ name: 'Gem', color: '#0f0', idle_fx: 'glow' });
  assert.strictEqual(bad.status, 400);
});
