exports.shorthands = undefined;

// SOMET-183 (F-003): POST/PUT /api/item-types never wrote item_types.value, so
// every item type created through the admin UI since the 1714440032000
// migration landed took the column default of 0 and could never be sold to
// (or bought from) a merchant. The API route is fixed separately; this
// backfills existing rows using the exact same category-derived expressions
// the original migration used, scoped to `value = 0` so it only touches rows
// that were never legitimately priced (currency stays 0 either way).
exports.up = (pgm) => {
  pgm.sql(`UPDATE item_types SET value = 10 + (damage * 2)::int WHERE category = 'weapon' AND value = 0`);
  pgm.sql(`UPDATE item_types SET value = 10 + (COALESCE(defense,0) * 3)::int WHERE category = 'armor' AND value = 0`);
  pgm.sql(`UPDATE item_types SET value = 2 WHERE category = 'ammo' AND value = 0`);
};

// Not reversible: we can't distinguish a value that was 0 because it was
// never backfilled from one an admin has since legitimately set to 0.
exports.down = false;
