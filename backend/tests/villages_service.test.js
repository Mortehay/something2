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
    // SOMET-279: guard placement is preceded by a read of the Village Guard
    // base stats, which is what makes a guard scale. Named here rather than
    // lumped into 'other' so this sequence still fails loudly if it ever moves
    // or disappears.
    //
    // SOMET-285 removed the SECOND read that used to sit beside it -- the
    // world's level band -- because a guard's level is now the fixed 150
    // regardless of world. 'band' is still mapped, and the expectation below
    // still lists every statement in order, so a band read reappearing (or the
    // catalog read vanishing) fails here rather than passing quietly.
    if (/FROM worlds WHERE id/i.test(s)) return 'band';
    // `seen` truncates each statement to 40 chars, so match on the table only.
    if (/FROM entity_types/i.test(s)) return 'guard-base';
    return 'other';
  });
  assert.deepEqual(kinds, ['row', 'guard-base', 'guards', 'guards', 'stock'],
    'createVillage must insert the row, read the guard base stats, then insert '
    + 'both gate guards, then merchant stock, in that order');
});
