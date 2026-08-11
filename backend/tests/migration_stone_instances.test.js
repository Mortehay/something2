const test = require('node:test');
const assert = require('node:assert');

function fakePgm() {
  const calls = { createTable: [], dropTable: [], addConstraint: [], createIndex: [] };
  return {
    calls,
    createTable: (name, cols, opts) => calls.createTable.push({ name, cols, opts }),
    dropTable: (name) => calls.dropTable.push(name),
    addConstraint: (name, cname, expr) => calls.addConstraint.push({ name, cname, expr }),
    createIndex: (name, col, opts) => calls.createIndex.push({ name, col, opts }),
    func: (x) => ({ raw: x }),
  };
}

const mig = require('../migrations/1714440166000_stone_instances.js');

test('up creates stone_instances with player_item_id as the primary key', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const t = pgm.calls.createTable.find((c) => c.name === 'stone_instances');
  assert.ok(t);
  assert.equal(t.cols.player_item_id.primaryKey, true);
  assert.equal(t.cols.player_item_id.references, 'player_items');
  assert.equal(t.cols.player_item_id.onDelete, 'CASCADE');
  assert.equal(t.cols.socketed_into_id.onDelete, 'SET NULL');
  assert.equal(t.cols.socketed_into_id.notNull, false);
});

test('xp and level are CHECK-constrained', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const xp = pgm.calls.addConstraint.find((c) => /xp/.test(c.cname));
  assert.match(xp.expr, /xp >= 0/);
  const lvl = pgm.calls.addConstraint.find((c) => /level/.test(c.cname));
  assert.match(lvl.expr, /level >= 1/);
});

test('socketed_into_id has a partial unique index excluding NULLs', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const idx = pgm.calls.createIndex.find((c) => c.name === 'stone_instances');
  assert.equal(idx.col, 'socketed_into_id');
  assert.equal(idx.opts.unique, true);
  assert.match(idx.opts.where, /IS NOT NULL/);
});

test('down drops the table', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  assert.deepEqual(pgm.calls.dropTable, ['stone_instances']);
});
