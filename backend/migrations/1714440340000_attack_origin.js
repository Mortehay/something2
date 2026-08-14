// SOMET-326 slice A: where an attack's visuals launch from, vertically, on the
// actor's body.
//
// NULL means "use the kind default" (resolved in authority/attackOrigin.js),
// which is `middle` for both kinds -- i.e. exactly what every weapon renders as
// today. So this migration changes the appearance of nothing until an admin
// authors a value, which is the point: the slice fixes the ANCHOR MATH without
// restyling existing content.
//
// A CHECK rather than an FK to a catalog table deliberately: slice B
// (SOMET-329) introduces `attack_origins` and converts this column to an FK.
// The value is stored as a NAME, not a fraction or an index, precisely so that
// conversion is a constraint swap and not a data rewrite.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('item_types', {
    attack_origin: { type: 'text' },
  });

  // `attack_origin IS NULL OR ...` is required, not redundant. A CHECK rejects
  // a row only when its expression is FALSE -- NULL passes -- so the bare
  // `attack_origin IN (...)` form would already admit NULL. Written explicitly
  // anyway so the intent ("NULL is a legal value meaning 'default'") is stated
  // rather than inferred from Postgres' three-valued logic, which is exactly
  // the reasoning that produced a vacuous constraint on this table once before
  // (see 1714440021000_aoe_ammo.js's note on item_types_ammo_ref_check).
  pgm.addConstraint('item_types', 'item_types_attack_origin_check',
    "CHECK (attack_origin IS NULL OR attack_origin IN ('feet','middle','head'))");

  // One seeded value, so the feature is observable in a running world without
  // an admin authoring anything first. Darts are the game's thrown weapon and
  // the brief calls for thrown attacks to leave from the top.
  pgm.sql(`UPDATE item_types SET attack_origin = 'head' WHERE name = 'darts'`);
};

exports.down = (pgm) => {
  pgm.dropConstraint('item_types', 'item_types_attack_origin_check');
  pgm.dropColumn('item_types', 'attack_origin');
};
