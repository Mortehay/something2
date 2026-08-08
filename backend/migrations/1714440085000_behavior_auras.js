exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('creature_behaviors', {
    // 0 = not a leader. Every existing profile stays 0, so this migration is
    // behaviour-neutral and the golden trace must stay green across it.
    aura_radius: { type: 'real', notNull: true, default: 0 },
    aura_damage_mult: { type: 'real', notNull: true, default: 1 },
    aura_defense_mult: { type: 'real', notNull: true, default: 1 },
    aura_speed_mult: { type: 'real', notNull: true, default: 1 },
    // Per-rung gold, used as a FALLBACK when the entity type's own range is
    // absent or zero -- see loot.js. Lets P4 author 288 creatures with no
    // gold authoring at all.
    gold_min: { type: 'integer', notNull: true, default: 0 },
    gold_max: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addConstraint('creature_behaviors', 'creature_behaviors_aura_check',
    'CHECK (aura_radius >= 0 AND aura_damage_mult > 0 AND aura_defense_mult > 0 AND aura_speed_mult > 0)');
  pgm.addConstraint('creature_behaviors', 'creature_behaviors_gold_check',
    'CHECK (gold_min >= 0 AND gold_max >= gold_min)');

  // Champion is the rung the umbrella describes as a pack leader, so it is
  // the profile that gets a real aura. Without one, the aura code Task 5
  // builds has no live consumer and cannot be browser-verified.
  pgm.sql(`
    UPDATE creature_behaviors
    SET aura_radius = 260, aura_damage_mult = 1.25, aura_defense_mult = 1.2, aura_speed_mult = 1.1
    WHERE name = 'Champion'
  `);

  // Per-rung gold, ascending with the rung. Guard gets none: a village guard
  // is not a purse.
  pgm.sql(`
    UPDATE creature_behaviors SET gold_min = v.lo, gold_max = v.hi
    FROM (VALUES
      ('Swarm', 0, 3), ('Skirmisher', 1, 6), ('Line', 1, 5), ('Ranged', 2, 8),
      ('Caster', 3, 12), ('Brute', 4, 14), ('Heavy', 5, 18), ('Champion', 10, 30),
      ('Apex', 25, 80), ('Sentry', 2, 9), ('Lurker', 2, 7)
    ) AS v(name, lo, hi)
    WHERE creature_behaviors.name = v.name
  `);
};

exports.down = (pgm) => {
  pgm.dropColumns('creature_behaviors',
    ['aura_radius', 'aura_damage_mult', 'aura_defense_mult', 'aura_speed_mult', 'gold_min', 'gold_max']);
};
