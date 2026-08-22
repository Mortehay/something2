// What a chest actually contains, as checked-in seed data (SOMET-438).
//
// chest_loot has existed since migration 1714440151000 and has never held a
// row, so every chest in the game granted XP and nothing else. rollChestLoot
// over an empty row set returns [] — a legitimate outcome for a real loot
// table — so nothing failed; the content was simply absent.
//
// Here rather than in a migration, for the SOMET-335 reason: this is BALANCE,
// and balance gets re-tuned. A migration writes it once and is undone by the
// next re-seed; a catalog seeded by `make seed-catalogs` converges on every
// run. Same call as the creature catalog and BEHAVIOR_DROPS.
//
// THE SHAPE
//
// Bands are read against the chest's GUARD level, which sits on the same
// scale as a creature's level (xpForChest is xpForKill applied to that guard),
// and live worlds currently carry creatures from level 1 to 150. Bands cover
// that whole range with no gap and no overlap: a chest at any level a world
// can produce has something to give, which is the property chest_loot_bands
// in the tests pins.
//
// Every row rolls INDEPENDENTLY in rollDrops, so the chances in a band sum to
// the expected number of items rather than to 1. Each band sums to roughly
// 1.6–2.0, i.e. a typical chest yields one or two things and occasionally
// nothing — the empty chest stays possible, it just stops being certain.
//
// Items are referenced BY NAME and resolved against item_types at seed time
// (the behavior_drops pattern), so this file never carries an id that a
// catalog rebuild would invalidate.
//
// Weapons climb with the band because a chest guarded by a level-40 creature
// should not be paying out sticks; ammo stays common at every level because it
// is consumed; armour is the reliable mid-weight reward; socket stones start
// at the third band, where a player plausibly has something to socket them
// into. GOLD IS DELIBERATELY ABSENT: gold is currency and reaches a player
// through rollGold and the gold column, not through player_items — putting the
// `gold` item type in here would grant an inventory item that spends like
// nothing.
const CHEST_LOOT = [
  // --- 1-4: a first chest. Ammo and a starter weapon. ------------------
  { level_min: 1, level_max: 4, item: 'stone', chance: 0.55, min_qty: 3, max_qty: 8 },
  { level_min: 1, level_max: 4, item: 'arrow', chance: 0.45, min_qty: 3, max_qty: 8 },
  { level_min: 1, level_max: 4, item: 'knife', chance: 0.30, min_qty: 1, max_qty: 1 },
  { level_min: 1, level_max: 4, item: 'dagger', chance: 0.20, min_qty: 1, max_qty: 1 },
  { level_min: 1, level_max: 4, item: 'leather-vest', chance: 0.15, min_qty: 1, max_qty: 1 },

  // --- 5-9: the first real weapon tier. --------------------------------
  { level_min: 5, level_max: 9, item: 'arrow', chance: 0.50, min_qty: 4, max_qty: 10 },
  { level_min: 5, level_max: 9, item: 'bolt', chance: 0.35, min_qty: 4, max_qty: 10 },
  { level_min: 5, level_max: 9, item: 'short sword', chance: 0.25, min_qty: 1, max_qty: 1 },
  { level_min: 5, level_max: 9, item: 'sling', chance: 0.20, min_qty: 1, max_qty: 1 },
  { level_min: 5, level_max: 9, item: 'leather-vest', chance: 0.25, min_qty: 1, max_qty: 1 },
  { level_min: 5, level_max: 9, item: 'club', chance: 0.20, min_qty: 1, max_qty: 1 },

  // --- 10-19: sockets become useful; staves appear. ---------------------
  { level_min: 10, level_max: 19, item: 'bolt', chance: 0.45, min_qty: 5, max_qty: 12 },
  { level_min: 10, level_max: 19, item: 'long sword', chance: 0.22, min_qty: 1, max_qty: 1 },
  { level_min: 10, level_max: 19, item: 'bow', chance: 0.22, min_qty: 1, max_qty: 1 },
  { level_min: 10, level_max: 19, item: 'apprentice staff', chance: 0.18, min_qty: 1, max_qty: 1 },
  { level_min: 10, level_max: 19, item: 'arcane-ward', chance: 0.18, min_qty: 1, max_qty: 1 },
  { level_min: 10, level_max: 19, item: 'stone_of_apprentice staff', chance: 0.15, min_qty: 1, max_qty: 1 },
  { level_min: 10, level_max: 19, item: 'loot_map', chance: 0.08, min_qty: 1, max_qty: 1 },

  // --- 20-39: heavy weapons and elemental sockets. ----------------------
  { level_min: 20, level_max: 39, item: 'bolt', chance: 0.40, min_qty: 6, max_qty: 14 },
  { level_min: 20, level_max: 39, item: 'morning star', chance: 0.20, min_qty: 1, max_qty: 1 },
  { level_min: 20, level_max: 39, item: 'halberd', chance: 0.18, min_qty: 1, max_qty: 1 },
  { level_min: 20, level_max: 39, item: 'frost staff', chance: 0.15, min_qty: 1, max_qty: 1 },
  { level_min: 20, level_max: 39, item: 'arcane-ward', chance: 0.22, min_qty: 1, max_qty: 1 },
  { level_min: 20, level_max: 39, item: 'stone_of_frost_edge', chance: 0.15, min_qty: 1, max_qty: 1 },
  { level_min: 20, level_max: 39, item: 'stone_of_ember_edge', chance: 0.15, min_qty: 1, max_qty: 1 },
  { level_min: 20, level_max: 39, item: 'loot_map', chance: 0.10, min_qty: 1, max_qty: 1 },

  // --- 40-79: top of the authored weapon ladder. ------------------------
  { level_min: 40, level_max: 79, item: 'bolt', chance: 0.35, min_qty: 8, max_qty: 16 },
  { level_min: 40, level_max: 79, item: 'two-handed sword', chance: 0.18, min_qty: 1, max_qty: 1 },
  { level_min: 40, level_max: 79, item: 'scythe', chance: 0.16, min_qty: 1, max_qty: 1 },
  { level_min: 40, level_max: 79, item: 'arbalest', chance: 0.16, min_qty: 1, max_qty: 1 },
  { level_min: 40, level_max: 79, item: 'flame staff', chance: 0.15, min_qty: 1, max_qty: 1 },
  { level_min: 40, level_max: 79, item: 'stone_of_flame staff', chance: 0.15, min_qty: 1, max_qty: 1 },
  { level_min: 40, level_max: 79, item: 'arcane-ward', chance: 0.25, min_qty: 1, max_qty: 1 },
  { level_min: 40, level_max: 79, item: 'loot_map', chance: 0.12, min_qty: 1, max_qty: 1 },

  // --- 80-150: the deepest guards in any authored world. ----------------
  //
  // 150 is the ceiling because it is the highest level a live world produces
  // today (world_creatures max). If a spec ever authors deeper, the band test
  // fails rather than silently handing those chests an empty table.
  { level_min: 80, level_max: 150, item: 'bolt', chance: 0.35, min_qty: 10, max_qty: 20 },
  { level_min: 80, level_max: 150, item: 'archmage staff', chance: 0.16, min_qty: 1, max_qty: 1 },
  { level_min: 80, level_max: 150, item: 'two-handed sword', chance: 0.16, min_qty: 1, max_qty: 1 },
  { level_min: 80, level_max: 150, item: 'stone_of_archmage staff', chance: 0.14, min_qty: 1, max_qty: 1 },
  { level_min: 80, level_max: 150, item: 'stone_of_storm staff', chance: 0.14, min_qty: 1, max_qty: 1 },
  { level_min: 80, level_max: 150, item: 'arcane-ward', chance: 0.28, min_qty: 1, max_qty: 1 },
  { level_min: 80, level_max: 150, item: 'loot_map', chance: 0.15, min_qty: 1, max_qty: 1 },
];

// The level range the bands above are required to cover without a gap. Read
// by the catalog test rather than re-derived there, so widening the game's
// level range is one edit and a failing test, not a silent hole.
const CHEST_LOOT_LEVEL_RANGE = { min: 1, max: 150 };

module.exports = { CHEST_LOOT, CHEST_LOOT_LEVEL_RANGE };
