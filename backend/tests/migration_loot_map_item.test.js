const test = require('node:test');
const assert = require('node:assert');

function fakePgm() {
  const calls = { dropConstraint: [], addConstraint: [], sql: [] };
  return {
    calls,
    dropConstraint: (name, cname) => calls.dropConstraint.push({ name, cname }),
    addConstraint: (name, cname, opts) => calls.addConstraint.push({ name, cname, opts }),
    sql: (s) => calls.sql.push(s),
  };
}

const mig = require('../migrations/1714440152000_loot_map_item.js');

test('up widens item_types_category_check to add consumable, keeping every existing category', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const add = pgm.calls.addConstraint.find((c) => c.cname === 'item_types_category_check');
  assert.ok(add);
  for (const cat of ['weapon', 'armor', 'ammo', 'currency', 'consumable']) {
    assert.match(add.opts.check, new RegExp(`'${cat}'`), `category CHECK omits ${cat}`);
  }
});

test('up seeds exactly one loot_map row, ON CONFLICT DO NOTHING', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const insert = pgm.calls.sql.find((s) => /INSERT INTO item_types/i.test(s));
  assert.ok(insert);
  assert.match(insert, /'loot_map'/);
  assert.match(insert, /'consumable'/);
  assert.match(insert, /ON CONFLICT \(name\) DO NOTHING/i);
});

test('down removes the loot_map row and reverts the constraint to pre-consumable', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  const del = pgm.calls.sql.find((s) => /DELETE FROM item_types/i.test(s));
  assert.match(del, /'loot_map'/);
  const add = pgm.calls.addConstraint.find((c) => c.cname === 'item_types_category_check');
  assert.doesNotMatch(add.opts.check, /'consumable'/);
});
