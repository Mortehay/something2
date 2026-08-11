const test = require('node:test');
const assert = require('node:assert');

function fakePgm() {
  const calls = { createTable: [], dropTable: [], addConstraint: [], createIndex: [] };
  return {
    calls,
    createTable: (name, cols, opts) => calls.createTable.push({ name, cols, opts }),
    dropTable: (name) => calls.dropTable.push(name),
    addConstraint: (name, cname, expr) => calls.addConstraint.push({ name, cname, expr }),
    createIndex: (name, cols) => calls.createIndex.push({ name, cols }),
  };
}

const mig = require('../migrations/1714440151000_chest_loot.js');

test('up creates chest_loot with the same shape as creature_drops, banded by level', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const t = pgm.calls.createTable.find((c) => c.name === 'chest_loot');
  assert.ok(t);
  assert.equal(t.cols.item_type_id.references, 'item_types');
  assert.equal(t.cols.chance.type, 'numeric');
  assert.equal(t.cols.min_qty.default, 1);
  assert.equal(t.cols.max_qty.default, 1);
});

test('level_max >= level_min and level_min >= 1 are enforced', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const c = pgm.calls.addConstraint.find((x) => /level/.test(x.cname));
  assert.match(c.expr, /level_max >= level_min/);
  assert.match(c.expr, /level_min >= 1/);
});

test('chance and quantity constraints match creature_drops exactly', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const chance = pgm.calls.addConstraint.find((x) => /chance/.test(x.cname));
  assert.match(chance.expr, /chance > 0 AND chance <= 1/);
  const qty = pgm.calls.addConstraint.find((x) => /qty/.test(x.cname));
  assert.match(qty.expr, /min_qty >= 1 AND max_qty >= min_qty/);
});

test('indexes (level_min, level_max) for the by-level lookup', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const idx = pgm.calls.createIndex.find((c) => c.name === 'chest_loot');
  assert.deepEqual(idx.cols, ['level_min', 'level_max']);
});

test('down drops the table', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  assert.deepEqual(pgm.calls.dropTable, ['chest_loot']);
});
