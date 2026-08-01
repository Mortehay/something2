const test = require('node:test');
const assert = require('node:assert');

test('the villages service exposes the full creation sequence', () => {
  const svc = require('../src/services/villages.js');
  assert.equal(typeof svc.createVillage, 'function');
  assert.equal(typeof svc.insertVillageGuards, 'function');
});

test('createVillage inserts the row, then guards, then merchant stock', async () => {
  // A fake client records the order of the statements. A seeded village that
  // skips guards or merchant stock looks fine in the database and only shows
  // up in play as an undefended gate and an empty shop -- so assert the
  // SEQUENCE, not merely that a row was written.
  const svc = require('../src/services/villages.js');
  const seen = [];
  const client = {
    query: async (sql, params) => {
      seen.push(String(sql).replace(/\s+/g, ' ').trim().slice(0, 40));
      if (/INSERT INTO villages/i.test(sql)) {
        return { rows: [{ id: 'v1', world_id: params[0], min_row: params[1], min_col: params[2],
                           width: params[3], height: params[4], gate_edge: params[5] }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const row = await svc.createVillage(client, 'w1', {
    min_row: 4, min_col: 4, width: 5, height: 4,
    gate_edge: 'S', spawn_x: 450, spawn_y: 500,
  });

  assert.equal(row.id, 'v1');
  // Assert the SEQUENCE, not merely presence: a seeded village whose steps
  // run out of order (or drop a step) still passes an "each ran somewhere"
  // check but ships broken -- an undefended gate or an empty shop.
  const kinds = seen.map((s) => {
    if (/INSERT INTO villages/i.test(s)) return 'row';
    if (/INSERT INTO world_creatures/i.test(s)) return 'guards';
    if (/INSERT INTO merchant_stock/i.test(s)) return 'stock';
    return 'other';
  });
  assert.deepEqual(kinds, ['row', 'guards', 'guards', 'stock'],
    'createVillage must insert the row, then both gate guards, then merchant stock, in that order');
});
