const test = require('node:test');
const assert = require('node:assert');

// Records the DDL/SQL calls node-pg-migrate would make, so the migration's
// shape is asserted without a live database (same pattern as
// migration_vfx_effects.test.js).
function fakePgm() {
  const calls = { sql: [] };
  return { calls, sql: (s) => calls.sql.push(s) };
}

const mig = require('../migrations/1714440036000_backfill_item_type_value.js');

// F-003 (SOMET-183): every item type created through the admin UI landed with
// value = 0 because POST/PUT /api/item-types never wrote the column. The API
// fix only affects rows created going forward; this backfill migration must
// repair existing rows using the same category-derived formula the original
// 1714440032000 migration used, scoped to value = 0 so it never clobbers a
// value an admin has legitimately set since the API fix landed.
test('up backfills weapon/armor/ammo rows still at value = 0, scoped by category', () => {
  const pgm = fakePgm();
  mig.up(pgm);

  const weapon = pgm.calls.sql.find((s) => /category = 'weapon'/.test(s));
  assert.ok(weapon, 'expected a weapon UPDATE');
  assert.match(weapon, /UPDATE item_types SET value/);
  assert.match(weapon, /damage \* 2/);
  assert.match(weapon, /AND value = 0/);

  const armor = pgm.calls.sql.find((s) => /category = 'armor'/.test(s));
  assert.ok(armor, 'expected an armor UPDATE');
  assert.match(armor, /COALESCE\(defense,\s*0\)\s*\*\s*3/);
  assert.match(armor, /AND value = 0/);

  const ammo = pgm.calls.sql.find((s) => /category = 'ammo'/.test(s));
  assert.ok(ammo, 'expected an ammo UPDATE');
  assert.match(ammo, /value = 2/);
  assert.match(ammo, /AND value = 0/);
});

test('down is marked irreversible', () => {
  assert.strictEqual(mig.down, false);
});
