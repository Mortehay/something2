exports.shorthands = undefined;

// One row per attack. Slot order is PRIORITY order, and the read path's
// json_agg orders by it -- see the note in authority/creatures.js.
//
// The backfill below is what makes this migration behaviour-neutral: every
// existing behaviour gets exactly one ability carrying the values it already
// had, so a creature's attack is byte-identical before and after. The frozen
// golden trace (tests/fixtures/creature_tick_golden.json) proves that once
// Task 2 moves the read path onto this table.
exports.up = (pgm) => {
  pgm.createTable('creature_abilities', {
    id: 'id',
    behavior_id: {
      type: 'integer', notNull: true, references: 'creature_behaviors', onDelete: 'CASCADE',
    },
    slot: { type: 'integer', notNull: true },
    name: { type: 'text', notNull: true },
    attack_kind: { type: 'text', notNull: true },
    attack_range: { type: 'real', notNull: true },
    attack_cooldown: { type: 'real', notNull: true },
    projectile_speed: { type: 'real', notNull: true, default: 0 },
    projectile_radius: { type: 'real', notNull: true, default: 0 },
    // NULL means "use the creature type's attack_element". A per-ability
    // element is what lets one Apex pair a fire breath with a physical slam.
    element: { type: 'text', notNull: false },
    damage_mult: { type: 'real', notNull: true, default: 1 },
    knockback: { type: 'real', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('creature_abilities', 'creature_abilities_slot_unique',
    'UNIQUE (behavior_id, slot)');
  pgm.addConstraint('creature_abilities', 'creature_abilities_slot_check',
    'CHECK (slot >= 1)');
  pgm.addConstraint('creature_abilities', 'creature_abilities_attack_kind_check',
    "CHECK (attack_kind IN ('melee','ranged','cast'))");
  pgm.addConstraint('creature_abilities', 'creature_abilities_element_check',
    "CHECK (element IS NULL OR element IN ('physical','fire','ice','lightning'))");
  pgm.addConstraint('creature_abilities', 'creature_abilities_positive_check',
    'CHECK (attack_range > 0 AND attack_cooldown > 0)');
  pgm.addConstraint('creature_abilities', 'creature_abilities_nonneg_check',
    'CHECK (projectile_speed >= 0 AND projectile_radius >= 0 AND damage_mult >= 0 AND knockback >= 0)');
  pgm.createIndex('creature_abilities', 'behavior_id');

  // Backfill: every existing behaviour becomes its own slot-1 ability.
  // element NULL and damage_mult 1 reproduce today's semantics exactly --
  // today a creature's shot carries its type's attack_element for `cast` and
  // physical otherwise, and its damage is unscaled.
  pgm.sql(`
    INSERT INTO creature_abilities
      (behavior_id, slot, name, attack_kind, attack_range, attack_cooldown,
       projectile_speed, projectile_radius, element, damage_mult, knockback)
    SELECT b.id, 1, b.name, b.attack_kind, b.attack_range, b.attack_cooldown,
           b.projectile_speed, b.projectile_radius, NULL, 1, 0
    FROM creature_behaviors b
  `);

  // Apex is the rung the umbrella describes as having a repertoire, so it is
  // the one profile seeded with a second ability. Slot 2 is a shorter-range
  // physical slam on a faster cooldown, with the knockback that makes closing
  // on an Apex a mistake. Without at least one real multi-ability profile the
  // selection logic Task 2 builds has no live consumer and cannot be
  // browser-verified.
  pgm.sql(`
    INSERT INTO creature_abilities
      (behavior_id, slot, name, attack_kind, attack_range, attack_cooldown,
       projectile_speed, projectile_radius, element, damage_mult, knockback)
    SELECT b.id, 2, 'Slam', 'melee', 90, 1.2, 0, 0, 'physical', 1.4, 120
    FROM creature_behaviors b WHERE b.name = 'Apex'
    ON CONFLICT (behavior_id, slot) DO NOTHING
  `);

  // The Brute's shove. Applied here rather than left to the seed file so the
  // migration and seeds/data/creatureAbilities.js agree row-for-row --
  // catalog_seed_data.test.js pins the seed file as a superset of what
  // migrations insert, and a divergence between the two is a defect this
  // project has shipped before, not a documented exception.
  //
  // Behaviour-neutral: no creature type references Brute (see "Which
  // profiles are live").
  pgm.sql(`
    UPDATE creature_abilities a SET knockback = 140
    FROM creature_behaviors b
    WHERE b.id = a.behavior_id AND b.name = 'Brute' AND a.slot = 1
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('creature_abilities');
};
