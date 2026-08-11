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
  // Important #5 fix (SOMET-245 final review). down() runs in REVERSE
  // timestamp order, so 1714440167000_convert_magic_weapons_to_stones.js's
  // own down() (which deletes every 'stone_of_%' item_types row -- its own
  // conversion-migration naming convention, see that file's header comment)
  // has already run by the time this down() executes. That leaves this
  // down() with no equivalent guard: if ANY category='stone' row still
  // exists -- i.e. any real, hand-authored buff/spell stone content added
  // after this shipped, which by construction can never be named
  // 'stone_of_%' the way a converted one is -- the addConstraint call below
  // (re-narrowing item_types_category_check to exclude 'stone') fails hard
  // with a raw constraint-violation error, because pgm.addConstraint
  // validates existing rows by default and a remaining category='stone' row
  // violates the narrowed check immediately. Refuse explicitly instead, with
  // a clear message naming the actual cause, matching this migration set's
  // own cautious, non-silent posture (see 1714440167000_convert_magic_
  // weapons_to_stones.js's down() header comment for the same "fail loud,
  // not silently corrupt" stance). This down() is therefore only valid in
  // the window before any non-converted stone type has ever been created --
  // exactly the same window 1714440167000.down() already documents itself
  // as being limited to.
  pgm.sql(`
    DO $do$
    DECLARE remaining int;
    BEGIN
      SELECT count(*) INTO remaining FROM item_types WHERE category = 'stone';
      IF remaining > 0 THEN
        RAISE EXCEPTION 'stone_item_type down(): % row(s) with category=stone still exist -- refusing to drop stat_bonus_stat/stat_bonus_amount and narrow item_types_category_check back to exclude stone. 1714440167000.down() (which runs before this one) only removes its OWN stone_of_-prefixed rows, so this means at least one real, hand-authored stone type exists. This down() is only safe on a database with ZERO stone rows -- before any stone content beyond the one-time conversion migration has ever been created.', remaining;
      END IF;
    END
    $do$;
  `);

  pgm.dropConstraint('item_types', 'item_types_stat_bonus_stat_check');
  pgm.dropConstraint('item_types', 'item_types_stone_kind_check');
  pgm.dropColumns('item_types', ['stat_bonus_stat', 'stat_bonus_amount']);
  pgm.dropConstraint('item_types', 'item_types_category_check');
  pgm.addConstraint('item_types', 'item_types_category_check', {
    check: "category IN ('weapon','armor','ammo','currency','consumable')",
  });
};
