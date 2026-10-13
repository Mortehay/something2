const test = require('node:test');
const assert = require('node:assert/strict');

const migration = require('../migrations/1714440750000_sprite_appearance_variant.js');

function fakePgm() {
  const calls = { addColumns: [], addConstraint: [], dropIndex: [], createIndex: [], sql: [], dropConstraint: [], dropColumns: [] };
  return {
    calls,
    addColumns: (table, columns) => calls.addColumns.push({ table, columns }),
    addConstraint: (table, name, check) => calls.addConstraint.push({ table, name, check }),
    dropIndex: (table, columns, options) => calls.dropIndex.push({ table, columns, options }),
    createIndex: (table, columns, options) => calls.createIndex.push({ table, columns, options }),
    sql: (text) => calls.sql.push(text),
    dropConstraint: (table, name) => calls.dropConstraint.push({ table, name }),
    dropColumns: (table, columns) => calls.dropColumns.push({ table, columns }),
  };
}

test('adds a nullable appearance_variant column constrained to 1-5', () => {
  const pgm = fakePgm();
  migration.up(pgm);
  const columns = pgm.calls.addColumns[0].columns;
  assert.ok(columns.appearance_variant);
  assert.equal(columns.appearance_variant.notNull, undefined);
  const check = pgm.calls.addConstraint.find((c) => c.name === 'sprite_sets_appearance_variant_check');
  assert.match(check.check, /BETWEEN 1 AND 5/);
});

test('replaces the one-live-job-per-entity index with one keyed on (entity, variant)', () => {
  const pgm = fakePgm();
  migration.up(pgm);
  const dropped = pgm.calls.dropIndex.find((c) => c.options?.name === 'sprite_sets_one_live_per_entity');
  assert.ok(dropped, 'expected the old index to be dropped');
  const created = pgm.calls.sql.find((s) => /CREATE UNIQUE INDEX sprite_sets_one_live_per_entity_variant/.test(s));
  assert.ok(created, 'expected the new per-variant unique index');
  assert.match(created, /COALESCE\(appearance_variant, 0\)/);
  assert.match(created, /queued.*running/s);
});

test('down restores the old index and drops the column', () => {
  const pgm = fakePgm();
  migration.down(pgm);
  assert.ok(pgm.calls.sql.some((s) => /DROP INDEX sprite_sets_one_live_per_entity_variant/.test(s)));
  const restored = pgm.calls.createIndex.find((c) => c.options?.name === 'sprite_sets_one_live_per_entity');
  assert.equal(restored.options.unique, true);
  assert.ok(pgm.calls.dropColumns[0].columns.includes('appearance_variant'));
});
