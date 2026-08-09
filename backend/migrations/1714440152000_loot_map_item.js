exports.shorthands = undefined;

// 'consumable' is a new item_types category — a use-once item that triggers
// a server-side effect rather than being equipped. Widen the check
// constraint before seeding the loot_map row, same pattern as
// 1714440031000_gold_economy.js adding 'currency'.
exports.up = (pgm) => {
  pgm.dropConstraint('item_types', 'item_types_category_check');
  pgm.addConstraint('item_types', 'item_types_category_check', {
    check: "category IN ('weapon','armor','ammo','currency','consumable')",
  });
  pgm.sql(
    `INSERT INTO item_types (name, category, damage, cooldown, stackable)
     VALUES ('loot_map', 'consumable', 0, 0, true)
     ON CONFLICT (name) DO NOTHING`
  );
};

exports.down = (pgm) => {
  pgm.sql("DELETE FROM item_types WHERE name = 'loot_map'");
  pgm.dropConstraint('item_types', 'item_types_category_check');
  pgm.addConstraint('item_types', 'item_types_category_check', {
    check: "category IN ('weapon','armor','ammo','currency')",
  });
};
