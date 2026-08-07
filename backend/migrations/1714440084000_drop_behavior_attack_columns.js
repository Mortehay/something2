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
};
