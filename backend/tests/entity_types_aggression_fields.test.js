// SOMET-493 -- /api/map/config must carry the three facts the client's inspect
// card derives a creature's aggression badge from. The banding rule itself
// lives on the client (frontend/.../systems/inspect.js); what ships over the
// wire is the raw catalog, so the two sides cannot drift into two different
// definitions of "Ferocious".
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, __setPool } = require('../src/index.js');

// Captures the SQL as well as answering it: the behaviour columns arrive on the
// entity row only because of a JOIN, and a mock that ignored the query would
// happily "pass" against a SELECT that never joined anything.
function poolCapturing(entityRows) {
  const seen = [];
  return {
    seen,
    query: async (sql) => {
      seen.push(String(sql));
      if (/FROM entity_types/i.test(sql)) return { rows: entityRows };
      return { rows: [] };
    },
  };
}

const WOLF = {
  id: 1, name: 'Wolf', color: '#777', walkable: true, is_creature: true,
  faction: 'hostile', prompt: 'a grey wolf',
  behavior_name: 'Brute', chase_style: 'charge', aggro_radius: 380,
};

test('GET /api/map/config exposes faction and the joined behaviour columns', async () => {
  const pool = poolCapturing([WOLF]);
  __setPool(pool);
  const res = await request(app).get('/api/map/config');
  assert.strictEqual(res.status, 200);
  const wolf = res.body.entityTypes.Wolf;
  assert.strictEqual(wolf.faction, 'hostile');
  assert.strictEqual(wolf.behaviorName, 'Brute');
  assert.strictEqual(wolf.chaseStyle, 'charge');
  assert.strictEqual(wolf.aggroRadius, 380);
  // The description the card shows for a non-creature and a creature alike.
  assert.strictEqual(wolf.prompt, 'a grey wolf');
});

test('the entity-type query LEFT JOINs the behaviour catalog', async () => {
  // entity_types.behavior_id is nullable and several seeded types carry no
  // behaviour row at all. An INNER JOIN would drop those types out of the map
  // the client renders with entirely -- a blank creature, not a blank tooltip.
  const pool = poolCapturing([]);
  __setPool(pool);
  await request(app).get('/api/map/config');
  const sql = pool.seen.find((s) => /FROM entity_types/i.test(s));
  assert.ok(sql, 'no entity_types query was issued');
  assert.match(sql, /LEFT JOIN\s+creature_behaviors/i);
  assert.doesNotMatch(sql, /INNER JOIN\s+creature_behaviors/i);
});

test('a type with no behaviour row still serializes, with nulls', async () => {
  // What the LEFT JOIN produces for the ~half of the catalog that is scenery:
  // the row is present, the behaviour columns are null. The client's
  // aggressionOf() is written to cope with exactly this.
  __setPool(poolCapturing([{
    id: 2, name: 'Tree', color: '#3a5', walkable: false, is_creature: false,
    faction: 'hostile', prompt: 'a tall pine tree',
    behavior_name: null, chase_style: null, aggro_radius: null,
  }]));
  const res = await request(app).get('/api/map/config');
  const tree = res.body.entityTypes.Tree;
  assert.strictEqual(tree.behaviorName, null);
  assert.strictEqual(tree.chaseStyle, null);
  assert.strictEqual(tree.aggroRadius, null);
  assert.strictEqual(tree.prompt, 'a tall pine tree');
});
