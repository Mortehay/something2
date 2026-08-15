// SOMET-332 slice C: a second socket MODE, so a stone can enhance the weapon
// it sits in instead of replacing that weapon's spell.
//
// Today socketing is replace-only: authority/items.js's activeWeaponType
// overwrites the host's element, damage, cooldown and mana_cost with the
// stone's, so a fire stone in a long sword makes the sword fire the stone's
// spell. `augment` is the additive mode -- a flaming sword rather than a sword
// that casts fire.
//
// NOT NULL DEFAULT 'replace' is what makes this a zero-content-migration
// change: every stone that exists keeps its exact behaviour, and no backfill
// can get it wrong.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('item_types', {
    stone_mode: { type: 'text', notNull: true, default: 'replace' },
    bonus_damage: { type: 'real' },
  });

  pgm.addConstraint('item_types', 'item_types_stone_mode_check',
    "CHECK (stone_mode IN ('replace','augment'))");

  // `augment` is meaningless on anything that is not a stone. Without this a
  // WEAPON row could carry stone_mode='augment' and read as an augment source
  // to any future code that checks the mode before checking the category.
  pgm.addConstraint('item_types', 'item_types_stone_mode_category_check',
    "CHECK (category = 'stone' OR stone_mode = 'replace')");

  // Tighten the kind check to cover the new mode.
  //
  // The ORIGINAL constraint (1714440165000) reads: a stone is a spell stone
  // (element set, no stat bonus) XOR a buff stone (no element, stat bonus set).
  // An augment stone carrying an element and no stat_bonus_stat already
  // satisfied its spell branch, so it was never BLOCKED -- but it was also
  // never required to carry the bonus_damage that makes it do anything, which
  // is the failure mode worth closing: an augment stone with a NULL bonus is a
  // stone that visibly socketets and silently adds nothing.
  //
  // Written as one expression per mode rather than bolted onto the existing
  // OR-chain: `stone_mode = 'augment' AND ...` is FALSE (not NULL) for every
  // replace-mode row, so the two branches cannot leak into each other. The
  // NULL-passing trap that produced a vacuous constraint on this table before
  // (see 1714440021000_aoe_ammo.js on item_types_ammo_ref_check) is avoided by
  // every branch testing stone_mode explicitly, which is NOT NULL.
  pgm.dropConstraint('item_types', 'item_types_stone_kind_check');
  pgm.addConstraint('item_types', 'item_types_stone_kind_check', {
    check: `category <> 'stone' OR (
      (stone_mode = 'replace' AND (
        (element IS NOT NULL AND stat_bonus_stat IS NULL)
        OR (element IS NULL AND stat_bonus_stat IS NOT NULL AND stat_bonus_amount IS NOT NULL)
      ))
      OR (stone_mode = 'augment'
          AND element IS NOT NULL
          AND stat_bonus_stat IS NULL
          AND bonus_damage IS NOT NULL
          AND bonus_damage > 0)
    )`,
  });

  // Two augment stones, so the mode is observable without an admin authoring
  // one first. Elements are FK'd to slice B's `elements` table, so these names
  // must exist there -- ice and fire both do.
  //
  // damage/cooldown/mana_cost are deliberately ZERO: an augment stone does not
  // supply a spell, and activeWeaponType's augment branch never reads them.
  // Leaving them at a spell stone's values would make an augment stone look
  // like a half-configured spell stone to anyone reading the table.
  pgm.sql(`
    INSERT INTO item_types
      (name, category, stone_mode, element, bonus_damage, damage, cooldown, mana_cost, stamina_cost, value)
    VALUES
      ('stone_of_frost_edge', 'stone', 'augment', 'ice',  4, 0, 0, 0, 0, 0),
      ('stone_of_ember_edge', 'stone', 'augment', 'fire', 5, 0, 0, 0, 0, 0)
    ON CONFLICT (name) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM item_types WHERE name IN ('stone_of_frost_edge','stone_of_ember_edge')`);

  pgm.dropConstraint('item_types', 'item_types_stone_kind_check');
  pgm.addConstraint('item_types', 'item_types_stone_kind_check', {
    check: `category <> 'stone' OR (
      (element IS NOT NULL AND stat_bonus_stat IS NULL)
      OR (element IS NULL AND stat_bonus_stat IS NOT NULL AND stat_bonus_amount IS NOT NULL)
    )`,
  });

  pgm.dropConstraint('item_types', 'item_types_stone_mode_category_check');
  pgm.dropConstraint('item_types', 'item_types_stone_mode_check');
  pgm.dropColumns('item_types', ['stone_mode', 'bonus_damage']);
};
