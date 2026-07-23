const test = require('node:test');
const assert = require('node:assert');

// Records the DDL calls node-pg-migrate would make, so the migration's shape
// is asserted without a live database (same pattern as
// migration_tile_prompts.test.js).
function fakePgm() {
  const calls = { createTable: [], dropTable: [], addColumns: [], dropColumns: [], addConstraint: [], sql: [] };
  return {
    calls,
    createTable: (name, cols, opts) => calls.createTable.push({ name, cols, opts }),
    dropTable: (name) => calls.dropTable.push(name),
    addColumns: (name, cols) => calls.addColumns.push({ name, cols }),
    addColumn: (name, cols) => calls.addColumns.push({ name, cols }),
    dropColumns: (name, cols) => calls.dropColumns.push({ name, cols }),
    addConstraint: (name, cname, expr) => calls.addConstraint.push({ name, cname, expr }),
    sql: (s) => calls.sql.push(s),
    func: (x) => ({ raw: x }),
  };
}

const mig = require('../migrations/1714440034000_vfx_effects.js');

test('up creates vfx_effects with the slice A geometry columns', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const t = pgm.calls.createTable.find((c) => c.name === 'vfx_effects');
  assert.ok(t, 'vfx_effects table not created');
  const c = t.cols;
  assert.equal(c.name.type, 'text');
  assert.equal(c.name.notNull, true);
  assert.equal(c.name.unique, true);
  assert.equal(c.shape.type, 'text');
  assert.equal(c.shape.notNull, true);
  assert.equal(c.color.type, 'text');
  assert.equal(c.width.type, 'real');
  assert.equal(c.duration_ms.type, 'integer');
  assert.equal(c.ease.type, 'text');
  assert.equal(c.ease.default, 'out');
  assert.equal(c.fade.type, 'boolean');
  assert.equal(c.fade.default, true);
  assert.equal(c.follows_weapon.type, 'boolean');
  assert.equal(c.follows_weapon.default, false);
});

test('particle columns are NOT in this migration (they are slice C)', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const c = pgm.calls.createTable.find((t) => t.name === 'vfx_effects').cols;
  for (const k of Object.keys(c)) {
    assert.ok(!k.startsWith('particle_'), `${k} belongs to slice C, not slice A`);
  }
});

test('shape and ease are CHECK-constrained to the full spec vocabulary', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const shape = pgm.calls.addConstraint.find((c) => /shape/.test(c.cname));
  assert.ok(shape, 'no shape CHECK constraint');
  // All five are admitted now so slice B adds shapes without a migration,
  // even though slice A only DRAWS 'arc'.
  for (const s of ['arc', 'line', 'ring', 'burst', 'bolt']) {
    assert.match(shape.expr, new RegExp(`'${s}'`), `shape CHECK omits ${s}`);
  }
  const ease = pgm.calls.addConstraint.find((c) => /ease/.test(c.cname));
  assert.ok(ease, 'no ease CHECK constraint');
  for (const e of ['linear', 'out', 'in']) {
    assert.match(ease.expr, new RegExp(`'${e}'`), `ease CHECK omits ${e}`);
  }
});

test('up adds a nullable jsonb vfx column to item_types only', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  const add = pgm.calls.addColumns.find((a) => a.name === 'item_types');
  assert.ok(add, 'item_types.vfx not added');
  assert.equal(add.cols.vfx.type, 'jsonb');
  assert.notEqual(add.cols.vfx.notNull, true, 'vfx must be nullable — an unbound weapon is legal');
  // entity_types.vfx is slice D.
  assert.ok(!pgm.calls.addColumns.some((a) => a.name === 'entity_types'),
    'entity_types.vfx belongs to slice D');
});

test('seeds exactly one effect and binds every melee weapon to it', () => {
  const pgm = fakePgm();
  mig.up(pgm);
  assert.equal(mig.SEED_EFFECT.name, 'sweep_arc');
  assert.equal(mig.SEED_EFFECT.shape, 'arc');
  assert.equal(mig.SEED_EFFECT.follows_weapon, true,
    'the arc must size itself from the weapon reach/arc, or every weapon looks identical');

  const insert = pgm.calls.sql.find((s) => /INSERT INTO vfx_effects/i.test(s));
  assert.ok(insert, 'no seed insert');
  assert.match(insert, /'sweep_arc'/);

  const bind = pgm.calls.sql.find((s) => /UPDATE item_types/i.test(s));
  assert.ok(bind, 'no melee binding');
  assert.match(bind, /"attack"\s*:\s*"sweep_arc"/, 'binding must set the attack moment');
  assert.match(bind, /kind\s*=\s*'melee'/, 'only melee weapons are bound in slice A');
});

test('down reverses both the column and the table', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  assert.deepEqual(pgm.calls.dropColumns, [{ name: 'item_types', cols: ['vfx'] }]);
  assert.deepEqual(pgm.calls.dropTable, ['vfx_effects']);
});
