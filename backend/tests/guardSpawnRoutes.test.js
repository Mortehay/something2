const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, __setPool } = require('../src/index.js');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];
function mockPool(handlers) {
  const calls = [];
  return { calls, query: async (sql, params) => {
    if (isUserLookup(sql)) return ADMIN_USER_ROW;
    calls.push({ sql, params });
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
    throw new Error(`unexpected query: ${sql}`);
  } };
}

test('creating a village inserts two Village Guard creatures at the gate posts', async () => {
  const pool = mockPool([
    [/SELECT id, width, height FROM worlds WHERE id = \$1/i, (p) => ({ rows: [{ id: p[0], width: 30, height: 30 }] })],
    [/SELECT min_row, min_col, width, height FROM villages WHERE world_id/i, () => ({ rows: [] })],
    [/INSERT INTO villages/i, () => ({ rows: [{ id: 'v1', min_row: 5, min_col: 5, width: 8, height: 6, gate_edge: 'S' }] })],
    [/INSERT INTO world_creatures/i, () => ({ rows: [] })],
    [/DELETE FROM world_chunks/i, () => ({ rows: [], rowCount: 0 })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/worlds/w1/villages').set(...AUTH)
    .send({ min_row: 5, min_col: 5, width: 8, height: 6, gate_edge: 'S', spawn_x: 850, spawn_y: 750 });
  assert.equal(res.status, 200);
  const guardInserts = pool.calls.filter((c) => /INSERT INTO world_creatures/i.test(c.sql));
  assert.equal(guardInserts.length, 2, 'exactly two guards per village');
  for (const g of guardInserts) {
    assert.ok(g.params.includes('Village Guard'), 'guard rows must use the Village Guard type');
  }
});

test('creature re-roll deletes only hostiles and re-adds guards', async () => {
  const pool = mockPool([
    [/SELECT \* FROM worlds WHERE id = \$1/i, (p) => ({ rows: [{ id: p[0], seed: 1, chunk_size: 64, width: 30, height: 30, creature_count: 5, allowed_creature_types: ['Slime'] }] })],
    [/FROM tile_types/i, () => ({ rows: [{ name: 'grass', walkable: true, speed: 1 }] })],
    [/FROM entity_types/i, () => ({ rows: [{ name: 'Slime', hp: 10, defense: 0, resistances: {}, faction: 'hostile' }] })],
    [/FROM map_links/i, () => ({ rows: [] })],
    // One real village, so the guard-refresh step has somewhere to place guards.
    // fetchVillages reads snake_case columns and maps them to camelCase.
    [/FROM villages WHERE world_id/i, () => ({ rows: [{
      id: 'v1', min_row: 5, min_col: 5, width: 8, height: 6,
      gate_edge: 'S', spawn_x: 850, spawn_y: 750,
    }] })],
    [/DELETE FROM world_creatures/i, (p) => ({ rows: [], rowCount: 0 })],
    [/INSERT INTO world_creatures/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/worlds/w1/creatures').set(...AUTH);
  assert.equal(res.status, 200);
  // Assert the SCOPING itself, not a comment or an interpolated literal: the
  // re-roll's first DELETE must exclude a type, and the excluded type must be
  // the guard. A bound parameter is the correct implementation, so the oracle
  // is (predicate in SQL) + (guard name in params).
  const del = pool.calls.find((c) => /DELETE FROM world_creatures/i.test(c.sql));
  assert.match(del.sql, /type\s*<>\s*\$2/i,
    'the re-roll DELETE must exclude a type — otherwise it wipes the gate guards');
  assert.ok(del.params.includes('Village Guard'),
    'the excluded type must be Village Guard');

  // And the guards must be re-established afterwards: exactly two inserts, both
  // Village Guard rows.
  const guardInserts = pool.calls.filter((c) => /INSERT INTO world_creatures/i.test(c.sql)
    && c.params.includes('Village Guard'));
  assert.equal(guardInserts.length, 2, 'each village ends the re-roll with exactly two guards');
});
