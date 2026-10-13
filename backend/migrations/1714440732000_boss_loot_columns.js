// backend/migrations/1714440732000_boss_loot_columns.js
//
// SOMET-611 (S10, spec §3.7). Four nullable entity_types columns that
// override a boss's tier loot default; NULL means "use the tier default",
// resolved at death time by backend/src/authority/bossLoot.js. Non-boss
// entities get NULL on all four and are never read by that path (it only
// runs off boss_tier IS NOT NULL).
//
// Timestamp note: picked 1714440732000, clear of 1714440730000/731000 which
// SOMET-610 (S7, a sibling slice) already occupies on its own unmerged
// branch -- avoids a collision when the two merge in either order. Re-check
// `ls backend/migrations | sort -n | tail` for anything landed since before
// merging this one.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('entity_types', {
    // Extra item rolls on death, ON TOP of the entity's own creature_drops/
    // behavior_drops rows -- not a replacement for them.
    loot_rolls: { type: 'integer' },
    // Floor: a rolled rarity below this grade is raised to it. Text, not an
    // enum, matching world_items.rarity's own column type (no enum type
    // exists in this schema for rarity grades).
    loot_min_rarity: { type: 'text' },
    // Maps the rarity roll's rng into [bias, 1) before the existing
    // cumulative-weight walk (rarity.js's rollRarity) runs on it -- skews the
    // roll upward while keeping it monotonic (a higher bias can only raise,
    // never lower, the rarity a given raw rng produces). 0..0.9 so a bias
    // can never pin the roll to a single grade regardless of rng.
    loot_rarity_bias: { type: 'numeric' },
    loot_chest: { type: 'boolean' },
  });
  pgm.addConstraint('entity_types', 'entity_types_loot_rolls_check', 'CHECK (loot_rolls IS NULL OR loot_rolls >= 0)');
  pgm.addConstraint(
    'entity_types',
    'entity_types_loot_min_rarity_check',
    "CHECK (loot_min_rarity IS NULL OR loot_min_rarity IN ('white','blue','yellow','foxy'))",
  );
  pgm.addConstraint(
    'entity_types',
    'entity_types_loot_rarity_bias_check',
    'CHECK (loot_rarity_bias IS NULL OR (loot_rarity_bias >= 0 AND loot_rarity_bias <= 0.9))',
  );
};

exports.down = (pgm) => {
  pgm.dropConstraint('entity_types', 'entity_types_loot_rarity_bias_check');
  pgm.dropConstraint('entity_types', 'entity_types_loot_min_rarity_check');
  pgm.dropConstraint('entity_types', 'entity_types_loot_rolls_check');
  pgm.dropColumns('entity_types', ['loot_rolls', 'loot_min_rarity', 'loot_rarity_bias', 'loot_chest']);
};
