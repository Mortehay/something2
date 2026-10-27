// backend/migrations/1714440760000_boss_loot_columns.js
//
// SOMET-611 (S10, spec §3.7). Four nullable entity_types columns that
// override a boss's tier loot default; NULL means "use the tier default",
// resolved at death time by backend/src/authority/bossLoot.js. Non-boss
// entities get NULL on all four and are never read by that path (it only
// runs off boss_tier IS NOT NULL).
//
// Timestamp note: first written as 1714440732000, renumbered to sort after
// 1714440750000_sprite_appearance_variant -- main shipped 740000/750000 while
// this slice sat in review, and node-pg-migrate's checkOrder refuses a
// not-yet-run file that sorts below an already-run one (see
// repair-migration-order.js). Re-check `ls backend/migrations | sort | tail`
// before merging.
//
// Also adds world_chests.expires_at (SOMET-611 rework): a boss-death chest
// is transient, and its lifetime used to live only in an in-memory
// setTimeout + an in-memory isBossChest flag -- both lost on a restart or
// world reload, orphaning the row forever, and dungeon-boss chests had no
// cleanup at all (one more row per respawn cycle). A durable deadline the
// item sweep purges survives both. NULL = permanent (every authored vault
// and field chest).
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
  // Upper bound mirrors bossLoot.js's MAX_LOOT_ROLLS: every roll is a
  // synchronous rollItemInstance on the authority loop plus a world_items
  // row (per participant, for a world boss), so an unbounded admin value is
  // a self-inflicted stall, not a balance knob.
  pgm.addConstraint('entity_types', 'entity_types_loot_rolls_check', 'CHECK (loot_rolls IS NULL OR (loot_rolls >= 0 AND loot_rolls <= 20))');
  pgm.addColumns('world_chests', { expires_at: { type: 'timestamptz' } });
  pgm.createIndex('world_chests', 'expires_at', { where: 'expires_at IS NOT NULL' });
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
  pgm.dropIndex('world_chests', 'expires_at', { where: 'expires_at IS NOT NULL' });
  pgm.dropColumns('world_chests', ['expires_at']);
  pgm.dropConstraint('entity_types', 'entity_types_loot_rarity_bias_check');
  pgm.dropConstraint('entity_types', 'entity_types_loot_min_rarity_check');
  pgm.dropConstraint('entity_types', 'entity_types_loot_rolls_check');
  pgm.dropColumns('entity_types', ['loot_rolls', 'loot_min_rarity', 'loot_rarity_bias', 'loot_chest']);
};
