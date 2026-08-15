// SOMET-329 slice B: four bounded catalogs for weapon options that were
// previously free text (element, attack_origin) or raw tuned numbers
// (projectile_radius, and the aoe_radius/pierce pair).
//
// Each table is seeded from values ALREADY LIVE, and each conversion leaves
// existing rows behaving identically -- this slice bounds what can be authored
// next, it does not restyle or rebalance anything that exists.
//
// Names, not surrogate ids, are the primary keys for `attack_origins` and
// `elements`. Both are already stored as names on item_types (slice A chose
// that deliberately for exactly this conversion), and both travel as names in
// code and on the wire, so a name PK makes this a constraint change rather
// than a data rewrite. ON UPDATE CASCADE lets a rename propagate instead of
// being blocked.

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ---------------------------------------------------------------------
  // attack_origins -- replaces slice A's CHECK constraint and the fraction
  // table that lived in authority/attackOrigin.js.
  // ---------------------------------------------------------------------
  pgm.createTable('attack_origins', {
    name: { type: 'text', primaryKey: true },
    height_fraction: { type: 'real', notNull: true },
    label: { type: 'text', notNull: true },
    sort_order: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addConstraint('attack_origins', 'attack_origins_fraction_check',
    'CHECK (height_fraction >= 0 AND height_fraction <= 1)');

  // The same three values, and the same fractions, slice A hardcoded.
  pgm.sql(`
    INSERT INTO attack_origins (name, height_fraction, label, sort_order) VALUES
      ('feet',   0.0,  'Feet — ground level',        1),
      ('middle', 0.5,  'Middle — mid-body',          2),
      ('head',   0.85, 'Head — top of the figure',   3)
    ON CONFLICT (name) DO NOTHING;
  `);

  // Defensive: null out anything the FK would reject. Only 'head' (darts) and
  // NULL exist today, both fine -- but a hand-edited row would otherwise abort
  // the whole migration, and losing one unauthored origin is a far better
  // outcome than a migration that cannot run.
  pgm.sql(`
    UPDATE item_types SET attack_origin = NULL
    WHERE attack_origin IS NOT NULL
      AND attack_origin NOT IN (SELECT name FROM attack_origins);
  `);
  pgm.dropConstraint('item_types', 'item_types_attack_origin_check');
  pgm.addConstraint('item_types', 'item_types_attack_origin_fkey', {
    foreignKeys: {
      columns: 'attack_origin',
      references: 'attack_origins(name)',
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    },
  });

  // ---------------------------------------------------------------------
  // elements -- the one the client needs. Two colour columns, not one.
  // ---------------------------------------------------------------------
  //
  // `color` and `tint_color` are DIFFERENT ROLES, not drift, and the seeds
  // below preserve both exactly as they are on screen today:
  //   * color      -- the body of the thing: projectile dot, trail, blast
  //                   ring, status tint (frontend core/blasts.js ELEMENT_COLORS)
  //   * tint_color -- the lighter impact/particle tint layered over an effect's
  //                   own colour (frontend RenderSystem.ELEMENT_TINT)
  // Collapsing them into one column would have been tidier and would have
  // visibly changed every impact burst in the game. `physical` deliberately
  // has NULL tint_color -- RenderSystem's table maps it to null so the
  // effect's own colour wins, and that must survive the move to data.
  pgm.createTable('elements', {
    name: { type: 'text', primaryKey: true },
    color: { type: 'text', notNull: true },
    tint_color: { type: 'text' },
    damage_type: { type: 'text', notNull: true },
    on_hit_effect: { type: 'text' },
    sort_order: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addConstraint('elements', 'elements_damage_type_check',
    "CHECK (damage_type IN ('physical','magical'))");
  // Six-digit hex only. The client drops these straight into canvas
  // fillStyle/strokeStyle, where an invalid string is silently ignored and the
  // previous colour is reused -- an authoring mistake would show up as "that
  // effect is the wrong colour sometimes", which is near-impossible to trace.
  pgm.addConstraint('elements', 'elements_color_check',
    "CHECK (color ~ '^#[0-9a-fA-F]{6}$' AND (tint_color IS NULL OR tint_color ~ '^#[0-9a-fA-F]{6}$'))");

  // `on_hit_effect` names the status rider in authority/effects.js. Stored as
  // data here; the runtime still reads its own ELEMENT_EFFECTS table this
  // slice (see the guard test, which fails if the two ever disagree). Wiring
  // the runtime to this column is deliberately left to a later slice -- it
  // would mean threading the catalog through every damage path, which is a
  // behaviour change with no acceptance criterion asking for it.
  pgm.sql(`
    INSERT INTO elements (name, color, tint_color, damage_type, on_hit_effect, sort_order) VALUES
      ('physical',  '#f4d35e', NULL,      'physical', NULL,       1),
      ('arcane',    '#9b5de5', '#c08cff', 'magical',  NULL,       2),
      ('fire',      '#f4763b', '#ff9a4d', 'magical',  'burn',     3),
      ('ice',       '#5bc0f8', '#8fdcff', 'magical',  'chill',    4),
      ('lightning', '#f4d35e', '#ffe66b', 'magical',  'shock',    5)
    ON CONFLICT (name) DO NOTHING;
  `);

  pgm.sql(`
    UPDATE item_types SET element = NULL
    WHERE element IS NOT NULL
      AND element NOT IN (SELECT name FROM elements);
  `);

  // DROP the old CHECK. This is load-bearing and was nearly missed: element
  // was NOT free text -- 1714440017000_items_inventory.js already constrained
  // it to a hardcoded five-name list. Leaving that in place alongside the FK
  // would mean an admin could add a row to `elements` and still be unable to
  // use it, because the CHECK would reject the write. The catalog would be
  // decorative for exactly the case it exists to serve.
  //
  // Caught by trying it against the live schema rather than by reading: the
  // FK was added and working, and the rejection came from the constraint
  // nobody had looked for.
  pgm.dropConstraint('item_types', 'item_types_element_check');
  pgm.addConstraint('item_types', 'item_types_element_fkey', {
    foreignKeys: {
      columns: 'element',
      references: 'elements(name)',
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    },
  });

  // ---------------------------------------------------------------------
  // projectile_shapes -- names the radii that were tuned by hand.
  // ---------------------------------------------------------------------
  pgm.createTable('projectile_shapes', {
    id: { type: 'serial', primaryKey: true },
    name: { type: 'text', notNull: true, unique: true },
    radius: { type: 'real', notNull: true },
    vfx_effect: { type: 'text' },
    sort_order: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addConstraint('projectile_shapes', 'projectile_shapes_radius_check', 'CHECK (radius > 0)');
  // The four distinct radii actually in the live catalog, named.
  pgm.sql(`
    INSERT INTO projectile_shapes (name, radius, sort_order) VALUES
      ('dart',      6,  1),
      ('bolt',      8,  2),
      ('orb',      12,  3),
      ('fireball', 14,  4)
    ON CONFLICT (name) DO NOTHING;
  `);
  pgm.addColumns('item_types', {
    projectile_shape_id: { type: 'integer', references: 'projectile_shapes', onDelete: 'RESTRICT' },
  });

  // ---------------------------------------------------------------------
  // impact_behaviors -- names what happens when a shot stops.
  // ---------------------------------------------------------------------
  //
  // SCOPE NOTE, deliberately narrower than the ticket's sketch. The ticket
  // asked for 'impact' and 'max_range' as separate behaviours. The ENGINE
  // cannot currently tell them apart: authority/projectiles.js detonates an
  // AoE shot on its FIRST contact of ANY kind -- terrain, creature, player, or
  // running out of range -- so both would behave identically.
  //
  // Seeding a 'max_range' row would therefore put a value in the catalog that
  // the engine silently ignores, which is the precise failure mode this whole
  // epic exists to remove. The COLUMN accepts it (slice C, explosive ammo,
  // is what makes the distinction real); no row uses it yet, and a guard test
  // asserts that stays true until the engine can honour it.
  pgm.createTable('impact_behaviors', {
    id: { type: 'serial', primaryKey: true },
    name: { type: 'text', notNull: true, unique: true },
    detonates: { type: 'boolean', notNull: true, default: false },
    detonate_at: { type: 'text' },
    pierce_default: { type: 'integer' },
    sort_order: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addConstraint('impact_behaviors', 'impact_behaviors_detonate_at_check',
    "CHECK (detonate_at IS NULL OR detonate_at IN ('contact','max_range'))");
  // A behaviour that detonates must say where, and one that does not must not.
  pgm.addConstraint('impact_behaviors', 'impact_behaviors_shape_check',
    'CHECK ((detonates = false AND detonate_at IS NULL) OR (detonates = true AND detonate_at IS NOT NULL))');
  pgm.sql(`
    INSERT INTO impact_behaviors (name, detonates, detonate_at, pierce_default, sort_order) VALUES
      ('single_hit',          false, NULL,      1, 1),
      ('pierce',              false, NULL,      2, 2),
      ('detonate_on_contact', true,  'contact', 1, 3)
    ON CONFLICT (name) DO NOTHING;
  `);
  pgm.addColumns('item_types', {
    impact_behavior_id: { type: 'integer', references: 'impact_behaviors', onDelete: 'RESTRICT' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('item_types', ['impact_behavior_id']);
  pgm.dropTable('impact_behaviors');
  pgm.dropColumns('item_types', ['projectile_shape_id']);
  pgm.dropTable('projectile_shapes');

  pgm.dropConstraint('item_types', 'item_types_element_fkey');
  // Restore the hardcoded CHECK 1714440017000 owned, so a rollback lands on
  // the schema that migration built rather than on an unconstrained column.
  pgm.addConstraint('item_types', 'item_types_element_check',
    "CHECK (element IS NULL OR element IN ('physical','arcane','fire','ice','lightning'))");
  pgm.dropTable('elements');

  pgm.dropConstraint('item_types', 'item_types_attack_origin_fkey');
  pgm.dropTable('attack_origins');
  // Restore slice A's CHECK, so a down-migration lands on exactly the schema
  // 1714440340000 left rather than on an unconstrained column.
  pgm.addConstraint('item_types', 'item_types_attack_origin_check',
    "CHECK (attack_origin IS NULL OR attack_origin IN ('feet','middle','head'))");
};
