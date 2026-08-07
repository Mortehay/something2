exports.shorthands = undefined;

// The behaviour catalog. Rows are inserted HERE as well as living in
// seeds/data/creatureBehaviors.js, matching how tile_types works: a fresh
// database gets a working catalog from migrations alone, and the seed file is
// a superset that `make seed-catalogs` can re-apply. catalog_seed_data.test.js
// pins that superset relationship.
//
// The two CHECK constraints duplicate the JS value sets in
// services/creatureBehaviors.js on purpose, for the same reason
// worlds_density_check duplicates DENSITY_TIERS: a value rejected only in JS
// is a value that reaches the database.
const BEHAVIORS = [
  // name, kind, range, cooldown, projSpeed, projRadius, aggro, leash, style, preferred, speedMult, dmgOverride
  ['Swarm',      'melee',   60, 0.7,   0,  0, 400,  800, 'charge',   0,   1.2,  null],
  ['Skirmisher', 'melee',   60, 0.9,   0,  0, 450,  800, 'skirmish', 150, 1.5,  null],
  ['Line',       'melee',   60, 1.0,   0,  0, 400,  800, 'charge',   0,   1.0,  null],
  ['Ranged',     'ranged', 340, 1.8, 520,  6, 460,  800, 'kite',     240, 1.0,  null],
  ['Caster',     'cast',   300, 2.4, 420,  8, 460,  800, 'kite',     220, 0.9,  null],
  ['Brute',      'melee',   70, 1.8,   0,  0, 380,  800, 'charge',   0,   0.7,  null],
  ['Heavy',      'melee',   65, 1.5,   0,  0, 300,  500, 'charge',   0,   0.6,  null],
  ['Champion',   'melee',   65, 1.1,   0,  0, 480,  900, 'charge',   0,   1.05, null],
  ['Apex',       'cast',   260, 2.0, 460, 10, 600, 1200, 'charge',   0,   0.95, null],
  ['Guard',      'melee',   60, 1.0,   0,  0, 400,  300, 'guard',    0,   1.0,    25],
  ['Sentry',     'ranged', 380, 2.0, 500,  6, 400,  800, 'hold',     0,   1.0,  null],
  ['Lurker',     'melee',   60, 0.9,   0,  0, 180,  700, 'ambush',   0,   1.6,  null],
];

exports.up = (pgm) => {
  pgm.createTable('creature_behaviors', {
    id: 'id',
    name: { type: 'text', notNull: true, unique: true },
    attack_kind: { type: 'text', notNull: true },
    attack_range: { type: 'real', notNull: true },
    attack_cooldown: { type: 'real', notNull: true },
    projectile_speed: { type: 'real', notNull: true, default: 0 },
    projectile_radius: { type: 'real', notNull: true, default: 0 },
    aggro_radius: { type: 'real', notNull: true },
    leash_radius: { type: 'real', notNull: true },
    chase_style: { type: 'text', notNull: true },
    preferred_range: { type: 'real', notNull: true, default: 0 },
    move_speed_mult: { type: 'real', notNull: true, default: 1 },
    damage_override: { type: 'real', notNull: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('creature_behaviors', 'creature_behaviors_attack_kind_check',
    "CHECK (attack_kind IN ('melee','ranged','cast'))");
  pgm.addConstraint('creature_behaviors', 'creature_behaviors_chase_style_check',
    "CHECK (chase_style IN ('charge','kite','skirmish','hold','ambush','guard'))");

  const values = BEHAVIORS
    .map((b) => `(${[
      `'${b[0]}'`, `'${b[1]}'`, b[2], b[3], b[4], b[5], b[6], b[7], `'${b[8]}'`, b[9], b[10],
      b[11] === null ? 'NULL' : b[11],
    ].join(',')})`)
    .join(',');

  pgm.sql(`
    INSERT INTO creature_behaviors
      (name, attack_kind, attack_range, attack_cooldown, projectile_speed,
       projectile_radius, aggro_radius, leash_radius, chase_style,
       preferred_range, move_speed_mult, damage_override)
    VALUES ${values}
    ON CONFLICT (name) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('creature_behaviors');
};

// Exposed so creature_behaviors_invariants.test.js can pin the seed file
// (seeds/data/creatureBehaviors.js) to this array field-for-field, without a
// database -- the same pattern 1714440042000_decoration_types.js already uses
// for NEW_DECORATIONS/SIZE_FIXES.
exports.BEHAVIORS = BEHAVIORS;
