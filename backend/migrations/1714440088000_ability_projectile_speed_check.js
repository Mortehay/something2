exports.shorthands = undefined;

// Final whole-branch review, Fix 1: the equivalent of
// creature_behaviors_projectile_speed_check (1714440082000, restored on the
// down path by 1714440084000) never got a counterpart on creature_abilities
// (1714440083000). That invariant -- a ranged/cast attack needs a projectile
// that actually moves -- has lived ONLY in abilityFieldError/
// behaviorAbilitiesError (backend/src/index.js) ever since Task 1 created
// this table. A row written outside the admin route (backend/scripts/
// seed-catalogs.js's seedOneAbility does zero validation, and P4's 288-row
// authoring pass will very likely write via seed/SQL, not the admin form)
// could carry { attack_kind: 'ranged', projectile_speed: 0 } with nothing in
// the database to stop it: the creature would select the ability, stamp its
// cooldown, and ProjectileSim would destroy the zero-speed shot before it
// moves a pixel -- a creature that silently never damages anyone.
//
// Verified against both seed sources before adding this: every ranged/cast
// row in backend/seeds/data/creatureAbilities.js's CREATURE_ABILITIES and in
// this migration's own ABILITY_OVERRIDES/backfill carries a positive
// projectile_speed (Ranged 520, Caster 420, Apex slot 1 460, Sentry 500) --
// no existing data violates this constraint.
exports.up = (pgm) => {
  pgm.addConstraint('creature_abilities', 'creature_abilities_projectile_speed_check',
    "CHECK (NOT (attack_kind IN ('ranged','cast') AND projectile_speed <= 0))");
};

exports.down = (pgm) => {
  pgm.dropConstraint('creature_abilities', 'creature_abilities_projectile_speed_check');
};
