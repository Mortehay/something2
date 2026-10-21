// Props v2 -- /api/map/config must carry entity_types.sway so the renderer can
// sway an approved prop's static image (decorations and world points both
// spread the catalog def; see RenderSystem.collectDecorations / pointBodyRef).
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, __setPool } = require('../src/index.js');

function poolWith(entityRows) {
  return {
    query: async (sql) => (/FROM entity_types/i.test(sql) ? { rows: entityRows } : { rows: [] }),
  };
}

test('GET /api/map/config exposes sway as a strict boolean', async () => {
  __setPool(poolWith([
    { id: 1, name: 'Pine', is_creature: false, render_mode: 'static', image: 'a.png', sway: true },
    { id: 2, name: 'Rock', is_creature: false, render_mode: 'static', image: 'b.png', sway: false },
    { id: 3, name: 'Old', is_creature: false, render_mode: 'static', image: 'c.png' },
  ]));
  const res = await request(app).get('/api/map/config');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.entityTypes.Pine.sway, true);
  assert.strictEqual(res.body.entityTypes.Rock.sway, false);
  assert.strictEqual(res.body.entityTypes.Old.sway, false);
});
