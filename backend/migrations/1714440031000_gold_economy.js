exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('users', {
    gold: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addColumns('entity_types', {
    gold_min: { type: 'integer', notNull: true, default: 0 },
    gold_max: { type: 'integer', notNull: true, default: 0 },
  });
  // 'currency' is a new item_types category; widen the check constraint
  // before seeding the gold row below.
  pgm.dropConstraint('item_types', 'item_types_category_check');
  pgm.addConstraint('item_types', 'item_types_category_check', {
    check: "category IN ('weapon','armor','ammo','currency')",
  });
  // The reserved currency item type. damage/category/cooldown are NOT NULL
  // with no usable default, so they're set explicitly. Rendered by name
  // client-side.
  pgm.sql(
    `INSERT INTO item_types (name, category, damage, cooldown, stackable)
     VALUES ('gold', 'currency', 0, 0, true)
     ON CONFLICT (name) DO NOTHING`
  );
  // Starting, toughness-scaled gold range for existing HOSTILE creatures; then
  // designer-tunable. Guards (faction='guard') and non-creatures stay 0.
  pgm.sql(
    `UPDATE entity_types
        SET gold_min = GREATEST(1, floor(hp / 10.0))::int,
            gold_max = GREATEST(GREATEST(1, floor(hp / 10.0))::int, floor(hp / 4.0)::int)
      WHERE is_creature = true AND faction = 'hostile'`
  );
};

exports.down = (pgm) => {
  pgm.sql("DELETE FROM item_types WHERE name = 'gold'");
  pgm.dropConstraint('item_types', 'item_types_category_check');
  pgm.addConstraint('item_types', 'item_types_category_check', {
    check: "category IN ('weapon','armor','ammo')",
  });
  pgm.dropColumns('entity_types', ['gold_min', 'gold_max']);
  pgm.dropColumns('users', ['gold']);
};
