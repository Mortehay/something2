const test = require('node:test');
const assert = require('node:assert');

function fakePgm() {
  const calls = {
    dropConstraint: [], addConstraint: [], addColumns: [], dropColumns: [], sql: [],
  };
  return {
    calls,
    dropConstraint: (name, cname) => calls.dropConstraint.push({ name, cname }),
    addConstraint: (name, cname, opts) => calls.addConstraint.push({ name, cname, opts }),
    addColumns: (name, cols) => calls.addColumns.push({ name, cols }),
    dropColumns: (name, cols) => calls.dropColumns.push({ name, cols }),
    sql: (s) => calls.sql.push(s),
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

// Important #5 fix (SOMET-245 final review). fakePgm-level pin: down() must
// issue its remaining-stone-rows guard as raw SQL BEFORE any of the
// destructive DDL (dropColumns / the narrowed addConstraint) -- checking
// after would be pointless, and checking via dropColumns/addConstraint
// call-order alone couldn't prove the guard exists at all. The real
// refuse-vs-succeed behavior of the guard's SQL itself is proven against a
// live database in migration_stone_item_type_down_guard_db.test.js (a
// fakePgm can't execute a DO block, only record that pgm.sql was called).
test('down issues a remaining-stone-rows guard, as SQL, before the destructive DDL', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  assert.equal(pgm.calls.sql.length, 1, 'down must issue exactly one guard SQL statement');
  assert.match(pgm.calls.sql[0], /category\s*=\s*'stone'/, 'the guard must check for remaining category=stone rows');
  assert.match(pgm.calls.sql[0], /RAISE EXCEPTION/i, 'the guard must refuse loudly, not silently pass through');
  // pgm.sql/dropColumns/addConstraint are pushed onto SEPARATE arrays by
  // fakePgm, so "before" can only be proven via a single call log ordered by
  // when each pgm.* method fired -- reconstruct one here rather than
  // widening fakePgm's shape just for this one test.
  const order = [];
  const pgm2 = fakePgm();
  const origSql = pgm2.sql; const origDropColumns = pgm2.dropColumns; const origAddConstraint = pgm2.addConstraint;
  pgm2.sql = (s) => { order.push('sql'); return origSql(s); };
  pgm2.dropColumns = (n, c) => { order.push('dropColumns'); return origDropColumns(n, c); };
  pgm2.addConstraint = (n, c, o) => { order.push('addConstraint'); return origAddConstraint(n, c, o); };
  mig.down(pgm2);
  assert.equal(order[0], 'sql', 'the guard must run before dropColumns/addConstraint, not after');
  assert.ok(order.indexOf('sql') < order.indexOf('dropColumns'));
});
