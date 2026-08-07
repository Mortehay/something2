exports.shorthands = undefined;

// Two more CHECK constraints on creature_behaviors, carried from Task 9's
// review of the /api/creature-behaviors route (Task 10). Both close a gap
// where a creature can pass every gate in CreatureSim and then simply never
// do anything -- with nothing logged and nothing rendered -- rather than
// failing loudly. Same belt-and-braces reasoning as
// creature_behaviors_attack_kind_check / creature_behaviors_chase_style_check
// in migration 1714440080000: a value rejected only in the route's JS is a
// value that still reaches the simulation from a row written before the
// validation existed, or by any future writer that bypasses the route.
//
// 1) attack_kind IN ('ranged','cast') with projectile_speed <= 0: the shot is
//    pushed and the cooldown is stamped, but the projectile simulation treats
//    zero speed as dead-on-arrival and destroys it before it moves a pixel.
// 2) chase_style = 'guard' with attack_kind <> 'melee': the guard branch of
//    the simulation is not attack-kind aware -- it always applies CONTACT
//    damage at attack_range with no line-of-sight check, so a
//    'ranged'/'cast' guard profile would instant-damage through walls.
exports.up = (pgm) => {
  pgm.addConstraint('creature_behaviors', 'creature_behaviors_projectile_speed_check',
    "CHECK (NOT (attack_kind IN ('ranged','cast') AND projectile_speed <= 0))");
  pgm.addConstraint('creature_behaviors', 'creature_behaviors_guard_melee_check',
    "CHECK (NOT (chase_style = 'guard' AND attack_kind <> 'melee'))");
};

exports.down = (pgm) => {
  pgm.dropConstraint('creature_behaviors', 'creature_behaviors_guard_melee_check');
  pgm.dropConstraint('creature_behaviors', 'creature_behaviors_projectile_speed_check');
};
