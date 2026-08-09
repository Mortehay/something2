const test = require('node:test');
const assert = require('node:assert');

// Same no-DB pgm-mock pattern as migration_vfx_effects.test.js, but also
// records call ORDER: the down() fix must delete world_chunks before
// worlds.biomes is dropped, since the DELETE's WHERE clause reads that column.
function fakePgm() {
  const order = [];
  return {
    order,
    sql: (s) => order.push({ op: 'sql', s }),
    dropColumns: (name, cols) => order.push({ op: 'dropColumns', name, cols }),
    dropTable: (name) => order.push({ op: 'dropTable', name }),
  };
}

const mig = require('../migrations/1714440043000_biomes.js');

test('down deletes biome-tainted world_chunks before dropping worlds.biomes', () => {
  const pgm = fakePgm();
  mig.down(pgm);

  const deleteIdx = pgm.order.findIndex((c) => c.op === 'sql' && /DELETE FROM world_chunks/i.test(c.s));
  const dropColsIdx = pgm.order.findIndex((c) => c.op === 'dropColumns' && c.name === 'worlds');
  const dropTableIdx = pgm.order.findIndex((c) => c.op === 'dropTable' && c.name === 'biomes');

  assert.ok(deleteIdx !== -1, 'down() must delete stale world_chunks rows');
  assert.ok(dropColsIdx !== -1, 'down() must still drop worlds.biomes / biome_cell');
  assert.ok(dropTableIdx !== -1, 'down() must still drop the biomes table');
  assert.ok(deleteIdx < dropColsIdx, 'DELETE must run before worlds.biomes is dropped — its WHERE clause reads that column');
  assert.ok(dropColsIdx < dropTableIdx, 'columns must drop before the biomes table');
});

test('the delete is scoped to worlds that actually had biomes', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  const del = pgm.order.find((c) => c.op === 'sql' && /DELETE FROM world_chunks/i.test(c.s));
  assert.match(del.s, /world_chunks\.world_id\s*=\s*worlds\.id/, 'must join world_chunks to worlds');
  assert.match(del.s, /jsonb_array_length\(worlds\.biomes\)\s*>\s*0/, 'must scope to worlds with a non-empty biomes array, not a blanket delete');
});

test('down still drops the biomes-specific worlds columns and the biomes table', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  const dropCols = pgm.order.find((c) => c.op === 'dropColumns' && c.name === 'worlds');
  assert.deepEqual(dropCols.cols, ['biomes', 'biome_cell']);
  const dropTable = pgm.order.find((c) => c.op === 'dropTable');
  assert.equal(dropTable.name, 'biomes');
});
