const test = require('node:test');
const assert = require('node:assert');

// Records the DDL/SQL calls node-pg-migrate would make, so the migration's
// shape is asserted without a live database (same pattern as
// migration_backfill_item_type_value.test.js).
function fakePgm() {
  const calls = { sql: [], addConstraint: [], dropConstraint: [] };
  return {
    calls,
    sql: (s) => calls.sql.push(s),
    addConstraint: (...args) => calls.addConstraint.push(args),
    dropConstraint: (...args) => calls.dropConstraint.push(args),
  };
}

const mig = require('../migrations/1714440037000_worlds_name_unique.js');

// F-044 (SOMET-224): worlds.name has no unique constraint, unlike
// tile_types/entity_types/item_types. A straight unique constraint would
// fail against the dev DB's existing duplicate-named rows, so the migration
// must rename duplicates (keeping the oldest bare) before adding the
// constraint.
test('up renames every duplicate-but-the-first before adding the unique constraint', () => {
  const pgm = fakePgm();
  mig.up(pgm);

  const dedup = pgm.calls.sql.find((s) => /ROW_NUMBER/i.test(s));
  assert.ok(dedup, 'expected a dedup UPDATE using ROW_NUMBER before the constraint is added');
  assert.match(dedup, /PARTITION BY name/i);
  assert.match(dedup, /ORDER BY created_at ASC, id ASC/i, 'oldest row (by created_at) must keep its bare name');
  assert.match(dedup, /rn > 1/i, 'only duplicates past the first must be renamed');

  assert.equal(pgm.calls.addConstraint.length, 1);
  const [table, name, opts] = pgm.calls.addConstraint[0];
  assert.equal(table, 'worlds');
  assert.equal(name, 'worlds_name_unique');
  assert.deepEqual(opts, { unique: 'name' });

  // The dedup rename must run BEFORE the constraint is added, or the
  // constraint would fail against the very duplicates it's meant to fix.
  const dedupIndex = pgm.calls.sql.indexOf(dedup);
  assert.equal(dedupIndex, 0, 'dedup must be the first statement');
});

test('down drops the unique constraint', () => {
  const pgm = fakePgm();
  mig.down(pgm);
  assert.equal(pgm.calls.dropConstraint.length, 1);
  const [table, name] = pgm.calls.dropConstraint[0];
  assert.equal(table, 'worlds');
  assert.equal(name, 'worlds_name_unique');
});
