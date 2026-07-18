exports.up = (pgm) => {
  pgm.createTable('weapon_types', {
    id: { type: 'serial', primaryKey: true },
    name: { type: 'text', notNull: true, unique: true },
    kind: { type: 'text', notNull: true }, // 'melee' | 'projectile'
    damage: { type: 'real', notNull: true },
    cooldown: { type: 'real', notNull: true },
    reach: { type: 'real' },
    arc_width: { type: 'real' },
    range: { type: 'real' },
    projectile_speed: { type: 'real' },
    projectile_radius: { type: 'real' },
    pierce: { type: 'integer' },
    mana_cost: { type: 'real', notNull: true, default: 0 },
    element: { type: 'text' },
    icon: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('weapon_types', 'weapon_types_kind_check',
    "CHECK (kind IN ('melee','projectile'))");

  // Seed the 4 representative weapons (idempotent).
  pgm.sql(`
    INSERT INTO weapon_types
      (name, kind, damage, cooldown, reach, arc_width, range, projectile_speed, projectile_radius, pierce, mana_cost, element)
    VALUES
      ('dagger',     'melee',      8, 0.30,  80, 0.6, NULL, NULL, NULL, NULL,  0, NULL),
      ('halberd',    'melee',     18, 0.90, 190, 1.8, NULL, NULL, NULL, NULL,  0, NULL),
      ('bow',        'projectile',12, 0.60, NULL, NULL, 700, 900,  8, 1,  0, NULL),
      ('magic-bolt', 'projectile',14, 0.70, NULL, NULL, 600, 700, 12, 1, 15, 'arcane')
    ON CONFLICT (name) DO NOTHING;
  `);
};

exports.down = (pgm) => pgm.dropTable('weapon_types');
