exports.shorthands = undefined;

// 'stone' is a new item_types category; widen the check constraint before
// adding the buff-stone columns. Same drop-and-recreate pattern
// 1714440152000_loot_map_item.js used to add 'consumable'.
exports.up = (pgm) => {
  pgm.dropConstraint('item_types', 'item_types_category_check');
  pgm.addConstraint('item_types', 'item_types_category_check', {
    check: "category IN ('weapon','armor','ammo','currency','consumable','stone')",
  });

  pgm.addColumns('item_types', {
    stat_bonus_stat: { type: 'text', notNull: false },
    stat_bonus_amount: { type: 'integer', notNull: false },
  });

  // A stone is exactly one kind: a spell stone (element set, no stat bonus)
  // XOR a buff stone (no element, stat bonus set). Non-stone rows are
  // unconstrained by this check.
  pgm.addConstraint('item_types', 'item_types_stone_kind_check', {
    check: `category <> 'stone' OR (
      (element IS NOT NULL AND stat_bonus_stat IS NULL)
      OR (element IS NULL AND stat_bonus_stat IS NOT NULL AND stat_bonus_amount IS NOT NULL)
    )`,
  });
  pgm.addConstraint('item_types', 'item_types_stat_bonus_stat_check', {
    check: `stat_bonus_stat IS NULL OR stat_bonus_stat IN
      ('strength','dexterity','constitution','intelligence','wisdom','charisma')`,
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('item_types', 'item_types_stat_bonus_stat_check');
  pgm.dropConstraint('item_types', 'item_types_stone_kind_check');
  pgm.dropColumns('item_types', ['stat_bonus_stat', 'stat_bonus_amount']);
  pgm.dropConstraint('item_types', 'item_types_category_check');
  pgm.addConstraint('item_types', 'item_types_category_check', {
    check: "category IN ('weapon','armor','ammo','currency','consumable')",
  });
};
