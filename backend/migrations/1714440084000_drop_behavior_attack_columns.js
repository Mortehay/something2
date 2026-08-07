exports.shorthands = undefined;

// The cutover. Task 1's backfill copied these six columns into slot-1
// ability rows and Task 2 moved every reader onto that table, so these are
// now dead. Dropping them is what makes creature_abilities the single source
// of truth for what a creature does -- leaving them would leave two, and a
// future edit to the wrong one would fail silently.
//
// `down` restores the columns AND repopulates them from slot 1, so the pair
// round-trips. A behaviour whose slot-1 ability was deleted after the up
// migration gets the Line defaults rather than a NOT NULL violation.
//
// `up`'s dropColumns cascade-drops THREE constraints, not just
// creature_behaviors_attack_kind_check -- migration 1714440082000 added two
// more on top of the original one (creature_behaviors_guard_melee_check,
// creature_behaviors_projectile_speed_check), and both reference attack_kind
// too, so Postgres drops them the same way. pg-migrate will not re-run
// 1714440082000 on a `down` of THIS migration (it's still marked applied),
// so if `down` here only restored the first constraint, the other two would
// be gone permanently after a down/up round-trip -- a silent, real
// data-integrity regression on the rollback path. All three are restored
// below, verbatim from 1714440082000's `up`, so the round-trip is actually
// lossless.
exports.up = (pgm) => {
  pgm.dropColumns('creature_behaviors', [
    'attack_kind', 'attack_range', 'attack_cooldown',
    'projectile_speed', 'projectile_radius',
  ]);
};

exports.down = (pgm) => {
  pgm.addColumns('creature_behaviors', {
    attack_kind: { type: 'text', notNull: true, default: 'melee' },
    attack_range: { type: 'real', notNull: true, default: 60 },
    attack_cooldown: { type: 'real', notNull: true, default: 1 },
    projectile_speed: { type: 'real', notNull: true, default: 0 },
    projectile_radius: { type: 'real', notNull: true, default: 0 },
  });
  pgm.sql(`
    UPDATE creature_behaviors b SET
      attack_kind = a.attack_kind, attack_range = a.attack_range,
      attack_cooldown = a.attack_cooldown, projectile_speed = a.projectile_speed,
      projectile_radius = a.projectile_radius
    FROM creature_abilities a
    WHERE a.behavior_id = b.id AND a.slot = 1
  `);
  pgm.addConstraint('creature_behaviors', 'creature_behaviors_attack_kind_check',
    "CHECK (attack_kind IN ('melee','ranged','cast'))");
  // The two 1714440082000 constraints, restored verbatim from that
  // migration's `up` -- see the header comment above.
  pgm.addConstraint('creature_behaviors', 'creature_behaviors_projectile_speed_check',
    "CHECK (NOT (attack_kind IN ('ranged','cast') AND projectile_speed <= 0))");
  pgm.addConstraint('creature_behaviors', 'creature_behaviors_guard_melee_check',
    "CHECK (NOT (chase_style = 'guard' AND attack_kind <> 'melee'))");
};
