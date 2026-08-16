// SOMET-343 part 3: make `detonate_at = 'max_range'` real.
//
// SOMET-329 created the column accepting 'contact' and 'max_range' but seeded
// only 'contact', because the engine detonated an AoE shot on its FIRST
// contact of ANY kind -- including running out of range -- and so could not
// tell the two apart. Seeding it then would have put a value in the catalog
// that the engine silently ignored.
//
// authority/projectiles.js now gates the CONTACT detonation on the mode, so a
// 'max_range' shot flies through what it touches (taking the ordinary
// direct-hit path) and detonates only when its distance runs out. That is the
// "magic that explodes when the distance ends" from the original request.
//
// The guard test in backend/tests/weapon_option_catalogs.test.js which asserted
// that no row used 'max_range' is updated by this slice, not deleted -- it now
// asserts the engine gate exists alongside the row.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO impact_behaviors (name, detonates, detonate_at, pierce_default, sort_order)
    VALUES ('detonate_at_max_range', true, 'max_range', 1, 4)
    ON CONFLICT (name) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  // RESTRICT on item_types.impact_behavior_id means this fails loudly if a
  // weapon is still using it, which is the correct outcome: silently deleting
  // it would leave that weapon with no behaviour and a NULL FK.
  pgm.sql(`DELETE FROM impact_behaviors WHERE name = 'detonate_at_max_range'`);
};
