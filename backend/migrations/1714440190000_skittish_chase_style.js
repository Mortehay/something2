exports.shorthands = undefined;

// The first non-aggressive creature behaviour in the game (SOMET-290).
//
// Every chase style before this one acquires a player and closes. `skittish`
// backs away instead, and only fights once it has been damaged or cornered --
// which is what makes a starting-zone pen a place to practise rather than a
// place to die.
//
// The CHECK is widened rather than replaced piecewise because a CHECK is one
// value: services/creatureBehaviors.js carries the same list in JS, and that
// duplication is deliberate and documented there -- a value rejected only in
// JS reaches the database, and a value rejected only in SQL reaches the sim
// from a row written before the constraint existed.
exports.up = (pgm) => {
  pgm.dropConstraint('creature_behaviors', 'creature_behaviors_chase_style_check');
  pgm.addConstraint('creature_behaviors', 'creature_behaviors_chase_style_check',
    "CHECK (chase_style IN ('charge','kite','skirmish','hold','ambush','guard','skittish'))");

  // Byte-for-byte the row in seeds/data/creatureBehaviors.js. The seed file
  // makes a fresh database work; this makes the live one work without a
  // re-seed. Same arrangement tile_types uses.
  //
  // preferred_range IS the flee radius for this style -- 0 would be a
  // creature that never backs away, i.e. the behaviour silently inert.
  pgm.sql(`
    INSERT INTO creature_behaviors
      (name, attack_kind, attack_range, attack_cooldown, projectile_speed,
       projectile_radius, aggro_radius, leash_radius, chase_style,
       preferred_range, move_speed_mult, gold_min, gold_max)
    VALUES
      ('Skittish', 'melee', 60, 1.2, 0, 0, 300, 500, 'skittish', 150, 1.15, 0, 2)
    ON CONFLICT (name) DO NOTHING
  `);
};

exports.down = (pgm) => {
  // The row goes first: the narrowed CHECK below would reject it.
  pgm.sql("DELETE FROM creature_behaviors WHERE name = 'Skittish'");
  pgm.dropConstraint('creature_behaviors', 'creature_behaviors_chase_style_check');
  pgm.addConstraint('creature_behaviors', 'creature_behaviors_chase_style_check',
    "CHECK (chase_style IN ('charge','kite','skirmish','hold','ambush','guard'))");
};
