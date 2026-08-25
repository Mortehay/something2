// The authored base-gear ladder (SOMET-479, progression epic T11).
//
// DATA ONLY. generateGearLadder.js turns this into item_types rows; nothing
// here computes anything, so a rebalance is an edit to two tables rather than
// an edit to 150 rows.
//
// The live catalog before this file existed held 24 equippable items: 22
// weapons, all main_hand, one chest armor and one head armor. off_hand, hands,
// feet, ring1 and ring2 had ZERO items -- five of the eight slots the paper
// doll draws could never be filled.
//
// SPRITES ARE OUT OF SCOPE (spec's "explicitly out of scope" list). These 150
// rows render as placeholder colour boxes, exactly as a new decoration type
// does until someone generates art for it.

// Ten rungs. `req_level` is the ladder the spec fixes; `power` is the single
// scalar every damage/defense number is multiplied by, so a rebalance of the
// whole curve is ten numbers, not 150. `stat_req` is what the tier demands of
// its family's own stat -- tier 1 demands nothing so a brand-new character can
// equip the whole bottom rung.
//
// Every stat_req is affordable from the passive tree at that level: points are
// granted 1 per level (gameSettings DEFAULTS.passive_points_per_level), so a
// level-L character holds L-1 of them, and gear_ladder.test.js walks the REAL
// generated tree from each class start node to prove the rung is buyable.
const GEAR_TIERS = [
  { tier: 1,  req_level: 1,   item_level: 1,   prefix: 'crude',    stat_req: 0,   power: 1.0,  value: 10 },
  { tier: 2,  req_level: 10,  item_level: 10,  prefix: 'iron',     stat_req: 8,   power: 1.6,  value: 40 },
  { tier: 3,  req_level: 25,  item_level: 25,  prefix: 'steel',    stat_req: 16,  power: 2.4,  value: 110 },
  { tier: 4,  req_level: 40,  item_level: 40,  prefix: 'tempered', stat_req: 26,  power: 3.4,  value: 240 },
  { tier: 5,  req_level: 55,  item_level: 55,  prefix: 'runed',    stat_req: 36,  power: 4.6,  value: 430 },
  { tier: 6,  req_level: 70,  item_level: 70,  prefix: 'obsidian', stat_req: 48,  power: 6.0,  value: 700 },
  { tier: 7,  req_level: 90,  item_level: 90,  prefix: 'astral',   stat_req: 62,  power: 7.8,  value: 1100 },
  { tier: 8,  req_level: 110, item_level: 110, prefix: 'void',     stat_req: 78,  power: 9.8,  value: 1650 },
  { tier: 9,  req_level: 130, item_level: 130, prefix: 'dragon',   stat_req: 96,  power: 12.0, value: 2400 },
  { tier: 10, req_level: 150, item_level: 150, prefix: 'mythic',   stat_req: 116, power: 14.5, value: 3400 },
];

// Fifteen families, chosen so every slot has at least one and every one of the
// six stats gates at least one family -- a Monk (wisdom) and a Druid (charisma)
// must both have gear their own stat unlocks, or the requirement system reads
// as a strength tax.
//
// TWO RING FAMILIES, ON PURPOSE. canEquip's armor branch is
// `if (type.slot !== slot) return {ok:false}` (authority/items.js:357), so a
// row authored with slot 'ring1' can NEVER be put in ring2. One ring family
// would leave ring2 permanently empty -- exactly the hole this task exists to
// close. Do not "simplify" these two into one.
//
// `damage`/`defense` here are the TIER-1 values; the generator multiplies by
// the tier's `power`. `req_stat` names which stat the family gates on.
const GEAR_FAMILIES = [
  // main_hand -- three, because the weapon slot is the one that decides how a
  // class actually plays.
  { key: 'blade',  slot: 'main_hand', category: 'weapon', kind: 'melee',      req_stat: 'strength',
    two_handed: false, damage: 6, cooldown: 0.55, reach: 80,  arc_width: 1.2 },
  { key: 'spear',  slot: 'main_hand', category: 'weapon', kind: 'melee',      req_stat: 'dexterity',
    two_handed: true,  damage: 8, cooldown: 0.8,  reach: 150, arc_width: 0.7 },
  { key: 'wand',   slot: 'main_hand', category: 'weapon', kind: 'projectile', req_stat: 'intelligence',
    two_handed: false, damage: 5, cooldown: 0.7,  range: 420, projectile_speed: 520, projectile_radius: 6 },

  // off_hand -- armor, not weapons: canEquip already refuses a two-handed
  // weapon's off hand and a second weapon has no combat meaning today.
  { key: 'buckler', slot: 'off_hand', category: 'armor', req_stat: 'strength', defense: 1.5 },
  { key: 'focus',   slot: 'off_hand', category: 'armor', req_stat: 'wisdom',   defense: 0.5 },

  { key: 'helm',    slot: 'head',  category: 'armor', req_stat: 'strength',     defense: 1.5 },
  { key: 'hood',    slot: 'head',  category: 'armor', req_stat: 'dexterity',    defense: 1.0 },

  { key: 'plate',   slot: 'chest', category: 'armor', req_stat: 'strength',     defense: 3.0 },
  { key: 'robe',    slot: 'chest', category: 'armor', req_stat: 'intelligence', defense: 1.5 },

  { key: 'gauntlets', slot: 'hands', category: 'armor', req_stat: 'strength',  defense: 1.0 },
  { key: 'gloves',    slot: 'hands', category: 'armor', req_stat: 'dexterity', defense: 0.7 },

  { key: 'greaves', slot: 'feet', category: 'armor', req_stat: 'constitution', defense: 1.2 },
  { key: 'boots',   slot: 'feet', category: 'armor', req_stat: 'dexterity',    defense: 0.7 },

  { key: 'band',    slot: 'ring1', category: 'armor', req_stat: 'charisma', defense: 0.2 },
  { key: 'signet',  slot: 'ring2', category: 'armor', req_stat: 'charisma', defense: 0.2 },
];

module.exports = { GEAR_TIERS, GEAR_FAMILIES };
