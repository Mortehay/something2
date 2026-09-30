const test = require('node:test');
const assert = require('node:assert');

// Set the secret before requiring the app / signing any token.
require('./helpers/auth.js');
const request = require('supertest');

const { app } = require('../src/index.js');
const { buildGameArtIndex, loadGameArtIndex } = require('../src/services/gameArt.js');

// ---------------------------------------------------------------------------
// GET /api/game-art (SOMET-598): the icon pointers the game draws.
// ---------------------------------------------------------------------------

test('the route is behind a player auth guard, not an admin one', () => {
  const layer = app._router.stack.find((l) => l.route && l.route.path === '/api/game-art');
  assert.ok(layer, 'GET /api/game-art is not registered');
  assert.ok(layer.route.stack.some((h) => h.handle && h.handle.isAuthGuard),
    'the art index must not be reachable without a token');
  // adminGuard would 403 every real player -- the whole point of this route.
  assert.ok(!layer.route.stack.some((h) => h.handle && h.handle.isAdminGuard),
    'the art index must not require an admin role');
});

test('an unauthenticated request is refused', async () => {
  const res = await request(app).get('/api/game-art');
  assert.equal(res.status, 401);
});

test('buildGameArtIndex keys skills by id, labels by label text, items by type id', () => {
  const t = new Date('2026-09-30T10:00:00Z');
  const index = buildGameArtIndex(
    [
      { subject_kind: 'skill', subject_key: 'arc_tumble', image: 'sprites/objects/arc_tumble/seeded/static.png', updated_at: t },
      { subject_kind: 'passive_label', subject_key: 'Afterimage', image: 'sprites/objects/Afterimage/seeded/static.png', updated_at: t },
    ],
    [{ id: 217, icon: 'sprites/objects/mythic-wand/seeded/static.png' }],
  );
  assert.deepEqual(index, {
    skill: { arc_tumble: { image: 'sprites/objects/arc_tumble/seeded/static.png', v: t.toISOString() } },
    passive_label: { Afterimage: { image: 'sprites/objects/Afterimage/seeded/static.png', v: t.toISOString() } },
    item: { 217: { image: 'sprites/objects/mythic-wand/seeded/static.png', v: null } },
  });
});

test('buildGameArtIndex drops blank keys and kinds the game does not draw', () => {
  const index = buildGameArtIndex(
    [
      { subject_kind: 'skill', subject_key: 'a', image: '', updated_at: null },
      { subject_kind: 'skill', subject_key: 'b', image: '   ', updated_at: null },
      { subject_kind: 'skill', subject_key: 'c', image: null, updated_at: null },
      { subject_kind: 'entity', subject_key: 'Wolf', image: 'sprites/Wolf/x.png', updated_at: null },
      { subject_kind: 'skill', subject_key: 'kept', image: 'k.png', updated_at: 'not a date' },
    ],
    [{ id: 1, icon: '' }, { id: 2, icon: null }, { id: 3, icon: 'i.png' }],
  );
  assert.deepEqual(index, {
    skill: { kept: { image: 'k.png', v: null } },
    passive_label: {},
    item: { 3: { image: 'i.png', v: null } },
  });
});

test('loadGameArtIndex asks catalog_art only for the kinds the game draws', async () => {
  const seen = [];
  const pool = {
    query: async (sql, params) => {
      seen.push({ sql, params });
      if (/FROM catalog_art/.test(sql)) {
        // Honour the filter like Postgres would, so a query that forgot it
        // (and returned the entity row) fails the assertion below.
        const rows = [
          { subject_kind: 'skill', subject_key: 's', image: 's.png', updated_at: null },
          { subject_kind: 'entity', subject_key: 'e', image: 'e.png', updated_at: null },
        ];
        return { rows: params ? rows.filter((r) => params[0].includes(r.subject_kind)) : rows };
      }
      if (/FROM item_types/.test(sql)) return { rows: [{ id: 9, icon: 'n.png' }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const index = await loadGameArtIndex(pool);
  assert.deepEqual(index.skill, { s: { image: 's.png', v: null } });
  assert.deepEqual(index.item, { 9: { image: 'n.png', v: null } });
  const artQuery = seen.find((q) => /FROM catalog_art/.test(q.sql));
  assert.deepEqual(artQuery.params, [['skill', 'passive_label']]);
});
