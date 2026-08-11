const test = require('node:test');
const assert = require('node:assert');

function fakePgm() {
  const calls = { dropConstraint: [], addConstraint: [], addColumns: [], dropColumns: [] };
  return {
    calls,
    dropConstraint: (name, cname) => calls.dropConstraint.push({ name, cname }),
    addConstraint: (name, cname, opts) => calls.addConstraint.push({ name, cname, opts }),
    addColumns: (name, cols) => calls.addColumns.push({ name, cols }),
    dropColumns: (name, cols) => calls.dropColumns.push({ name, cols }),
  };
}

const mig = require('../migrations/1714440165000_stone_item_type.js');

test('up widens item_types_category_check to add stone, keeping every existing category', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const add = pgm.calls.addConstraint.find((c) => c.cname === 'item_types_category_check');
  for (const cat of ['weapon', 'armor', 'ammo', 'currency', 'consumable', 'stone']) {
    assert.match(add.opts.check, new RegExp(`'${cat}'`), `category CHECK omits ${cat}`);
  }
});

test('up adds nullable stat_bonus_stat/stat_bonus_amount', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const add = pgm.calls.addColumns.find((c) => c.name === 'item_types');
  assert.equal(add.cols.stat_bonus_stat.type, 'text');
  assert.notEqual(add.cols.stat_bonus_stat.notNull, true);
  assert.equal(add.cols.stat_bonus_amount.type, 'integer');
  assert.notEqual(add.cols.stat_bonus_amount.notNull, true);
});

test('stone_kind_check enforces spell XOR buff for stone rows only', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const c = pgm.calls.addConstraint.find((x) => x.cname === 'item_types_stone_kind_check');
  assert.match(c.opts.check, /category <> 'stone'/);
  assert.match(c.opts.check, /element IS NOT NULL AND stat_bonus_stat IS NULL/);
  assert.match(c.opts.check, /element IS NULL AND stat_bonus_stat IS NOT NULL AND stat_bonus_amount IS NOT NULL/);
});

test('stat_bonus_stat_check only accepts the six base stats', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const c = pgm.calls.addConstraint.find((x) => x.cname === 'item_types_stat_bonus_stat_check');
  for (const stat of ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']) {
    assert.match(c.opts.check, new RegExp(stat));
  }
});

test('down reverses columns and constraint back to pre-stone', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  assert.deepEqual(pgm.calls.dropColumns, [{ name: 'item_types', cols: ['stat_bonus_stat', 'stat_bonus_amount'] }]);
  const add = pgm.calls.addConstraint.find((c) => c.cname === 'item_types_category_check');
  assert.doesNotMatch(add.opts.check, /'stone'/);
});
