// backend/seeds/data/passiveTree.js
//
// The AUTHORED half of the passive tree, as checked-in seed data.
//
// WHY THIS FILE EXISTS. The tree is ~1800 nodes. Hand-authoring 1800 rows is
// not reviewable and not re-tunable: a balance pass would be 1800 edits. So
// the repo authors ~40 archetypes plus the 30 keystones that actually change a
// rule, and backend/seeds/generatePassiveTree.js expands them deterministically
// into rows. Retuning the tree is an edit HERE plus `make seed-passive-tree`.
//
// It follows the same rule as biomes.js and entityTypes.js: this file is a
// FLOOR, not a replacement for the admin UI. scripts/seed-passive-tree.js
// upserts by `key` and preserves an admin's edited label/kind/grants unless
// --force is passed, so a reseed can never cost an admin a hand-tuned node.
//
// NOTHING HERE IS LOGIC. Every value is data the generator reads. `@sector` is
// the one piece of indirection: a minor/notable template written for "the
// sector's own stat" writes `stat: '@sector'`, and the generator substitutes
// the sector key. That is what lets one template serve all six sectors, which
// is the whole reason 40 templates cover 1770 sector nodes.

// Element names are NOT re-declared here. They are read from the damage
// authority so this file can never drift from the five elements the combat
// code actually mitigates (backend/src/authority/damage.js:10).
const { ELEMENTS } = require('../../src/authority/damage.js');

const STAT_KEYS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
const RESOURCE_POOLS = ['hp', 'mana', 'stamina'];
// The three statuses effects.js defines (BURN/CHILL/SHOCK at effects.js:52-54).
const STATUSES = ['burn', 'chill', 'shock'];

// A grant's `type` picks the row; the row lists every other field it may carry
// and the allowed values. The generator does not read this — the guard test
// does, which is exactly the point: a typo'd stat name grants nothing at
// runtime and is invisible in the UI, so it has to fail the build instead.
const GRANT_TYPES = {
  stat: { stat: STAT_KEYS },
  resource: { pool: RESOURCE_POOLS },
  damage: { element: ELEMENTS },
  resist: { element: ELEMENTS },
  status: { status: STATUSES },
  rule: { rule: null },   // validated against RULE_KEYS below
};

// A `rule` grant is the only grant type that changes a formula rather than a
// number, so each one records WHICH module reads it and HOW two copies of the
// same rule combine. A rule with no consumer is an inert node the player
// cannot tell apart from a working one, so `consumer` is mandatory and the
// guard test checks it.
const RULE_KEYS = {
  lifeCostMultiplier: {
    combine: 'product',
    consumer: 'backend/src/services/lifeCost.js — lifeCostFor() (contract §2, Group B T4)',
  },
  treeCharmBonus: {
    combine: 'sum',
    consumer: 'backend/src/services/charm.js — charmBudget() (contract §2, Group B T5)',
  },
  cooldownFloor: {
    combine: 'min',
    consumer: 'backend/src/services/playerStats.js — MIN_COOLDOWN_MULT (wiring is a follow-up: playerStats.js belongs to Group A T2 under the contract)',
  },
  regenLifeShare: {
    combine: 'sum',
    consumer: 'backend/src/authority/world.js — the mana-regen tick (wiring is a follow-up)',
  },
};

// Clockwise from straight up, matching the spec §5.2 diagram exactly. ORDER IS
// LOAD-BEARING: the generator derives each sector's axis angle and its core
// attachment point from the array index, so reordering this list moves every
// node in the tree and re-keys nothing — the same "order is the banding order"
// hazard biomes.js documents for terrain_tiles.
const SECTORS = [
  { key: 'wisdom', className: 'Monk', identity: 'mana regeneration' },
  { key: 'intelligence', className: 'Mage', identity: 'maximum mana and spell damage' },
  { key: 'dexterity', className: 'Archer', identity: 'attack speed' },
  { key: 'strength', className: 'Warrior', identity: 'melee damage' },
  { key: 'constitution', className: 'Cultist', identity: 'maximum life, which is also their casting resource' },
  { key: 'charisma', className: 'Druid', identity: 'merchant prices and charm power' },
];

const LAYOUT = {
  // Straight up. Sector s sits at sectorAxisDeg0 + s * 60.
  sectorAxisDeg0: -90,
  // A sector wedge is 60 degrees wide; nodes use 56 of them so two adjacent
  // sectors never touch and the seam stays legible at low zoom.
  sectorSpanDeg: 56,
  core: {
    rowA: { count: 6, radius: 70 },
    rowB: { count: 24, radius: 140 },
  },
  startRadius: 195,
  // A rung joins row i to row i+1 every rungStride columns, starting at column
  // 0. Starting at 0 is what makes every row reachable from row 0.
  rungStride: 4,
  // Keystones are nudged off the spread positions so they do not all land in
  // the same column: total/count divides evenly for both rings that have them,
  // which would otherwise stack every keystone in a sector on one radial line.
  keystoneOffset: 7,
  keystoneStagger: 5,
  rings: [
    null, // index 0 is the core + the start nodes, which are not laid out on a grid
    { rows: 4, cols: 17, baseRadius: 260, rowStep: 45, minor: 60, notable: 8, keystone: 0 },
    { rows: 4, cols: 29, baseRadius: 460, rowStep: 55, minor: 100, notable: 14, keystone: 2 },
    { rows: 3, cols: 37, baseRadius: 700, rowStep: 70, minor: 90, notable: 18, keystone: 3 },
  ],
};

// --- Archetype templates ---------------------------------------------------
//
// `sectors: '*'` means "every one of the six stat sectors" and never the core.
// The core has its own four templates with `sectors: ['core']`, because a core
// node has no sector stat to point `@sector` at.
//
// `rings` gates a template to the bands where its power level belongs: the
// +4 minor and the +16 notable are outer-ring only, the three status notables
// are ring-3 only.
const TEMPLATES = [
  // --- core (ring 0) — generic, no sector stat ---
  { key: 'core_life', kind: 'minor', sectors: ['core'], rings: [0], label: 'Constitution', grants: [{ type: 'resource', pool: 'hp', value: 10 }] },
  { key: 'core_mana', kind: 'minor', sectors: ['core'], rings: [0], label: 'Attunement', grants: [{ type: 'resource', pool: 'mana', value: 10 }] },
  { key: 'core_stam', kind: 'minor', sectors: ['core'], rings: [0], label: 'Stamina', grants: [{ type: 'resource', pool: 'stamina', value: 8 }] },
  { key: 'core_res', kind: 'minor', sectors: ['core'], rings: [0], label: 'Toughness', grants: [{ type: 'resist', element: 'physical', value: 1 }] },

  // --- minors (the connective tissue: +2 to the sector's own stat) ---
  { key: 'min_sinew', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Sinew', grants: [{ type: 'stat', stat: '@sector', value: 2 }] },
  { key: 'min_focus', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Focus', grants: [{ type: 'stat', stat: '@sector', value: 3 }] },
  { key: 'min_vigour', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Vigour', grants: [{ type: 'stat', stat: '@sector', value: 2 }, { type: 'resource', pool: 'hp', value: 8 }] },
  { key: 'min_insight', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Insight', grants: [{ type: 'stat', stat: '@sector', value: 2 }, { type: 'resource', pool: 'mana', value: 6 }] },
  { key: 'min_wind', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Wind', grants: [{ type: 'stat', stat: '@sector', value: 2 }, { type: 'resource', pool: 'stamina', value: 5 }] },
  { key: 'min_hardy', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Hardy', grants: [{ type: 'resource', pool: 'hp', value: 15 }] },
  { key: 'min_reserve', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Reserve', grants: [{ type: 'resource', pool: 'mana', value: 12 }] },
  { key: 'min_callus', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Callus', grants: [{ type: 'resist', element: 'physical', value: 2 }] },
  { key: 'min_edge', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Edge', grants: [{ type: 'damage', element: 'physical', value: 3 }] },
  { key: 'min_temper', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Temper', grants: [{ type: 'stat', stat: '@sector', value: 2 }, { type: 'resist', element: 'physical', value: 1 }] },
  { key: 'min_second_wind', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Second Wind', grants: [{ type: 'resource', pool: 'stamina', value: 10 }] },
  { key: 'min_discipline', kind: 'minor', sectors: '*', rings: [2, 3], label: 'Discipline', grants: [{ type: 'stat', stat: '@sector', value: 4 }] },

  // --- notables ---
  { key: 'not_great_sinew', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Great Sinew', grants: [{ type: 'stat', stat: '@sector', value: 8 }] },
  { key: 'not_mastery', kind: 'notable', sectors: '*', rings: [2, 3], label: 'Mastery', grants: [{ type: 'stat', stat: '@sector', value: 12 }] },
  { key: 'not_apotheosis', kind: 'notable', sectors: '*', rings: [3], label: 'Apotheosis', grants: [{ type: 'stat', stat: '@sector', value: 16 }] },
  { key: 'not_deep_reserve', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Deep Reserve', grants: [{ type: 'resource', pool: 'mana', value: 15 }] },
  { key: 'not_thick_skin', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Thick Skin', grants: [{ type: 'resource', pool: 'hp', value: 40 }] },
  { key: 'not_endurance', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Endurance', grants: [{ type: 'resource', pool: 'stamina', value: 30 }] },
  { key: 'not_brutality', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Brutality', grants: [{ type: 'damage', element: 'physical', value: 12 }] },
  { key: 'not_kindling', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Kindling', grants: [{ type: 'damage', element: 'fire', value: 12 }] },
  { key: 'not_frostbite', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Frostbite', grants: [{ type: 'damage', element: 'ice', value: 12 }] },
  { key: 'not_charge', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Charge', grants: [{ type: 'damage', element: 'lightning', value: 12 }] },
  { key: 'not_resonance', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Resonance', grants: [{ type: 'damage', element: 'arcane', value: 12 }] },
  { key: 'not_plating', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Plating', grants: [{ type: 'resist', element: 'physical', value: 8 }] },
  { key: 'not_fireproof', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Fireproof', grants: [{ type: 'resist', element: 'fire', value: 8 }] },
  { key: 'not_warm_blood', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Warm Blood', grants: [{ type: 'resist', element: 'ice', value: 8 }] },
  { key: 'not_grounding', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Grounding', grants: [{ type: 'resist', element: 'lightning', value: 8 }] },
  { key: 'not_null_field', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Null Field', grants: [{ type: 'resist', element: 'arcane', value: 8 }] },
  { key: 'not_ox_blood', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Ox Blood', grants: [{ type: 'stat', stat: '@sector', value: 8 }, { type: 'resource', pool: 'hp', value: 25 }] },
  { key: 'not_wellspring', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Wellspring', grants: [{ type: 'stat', stat: '@sector', value: 8 }, { type: 'resource', pool: 'mana', value: 20 }] },
  { key: 'not_honed', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Honed', grants: [{ type: 'stat', stat: '@sector', value: 8 }, { type: 'damage', element: 'physical', value: 5 }] },
  { key: 'not_quickening', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Quickening', grants: [{ type: 'stat', stat: 'dexterity', value: 6 }] },
  { key: 'not_ward', kind: 'notable', sectors: '*', rings: [2, 3], label: 'Ward', grants: [{ type: 'resist', element: 'arcane', value: 6 }, { type: 'resist', element: 'fire', value: 6 }] },
  { key: 'not_searing_blows', kind: 'notable', sectors: '*', rings: [3], label: 'Searing Blows', grants: [{ type: 'status', status: 'burn', value: 1 }] },
  { key: 'not_numbing_blows', kind: 'notable', sectors: '*', rings: [3], label: 'Numbing Blows', grants: [{ type: 'status', status: 'chill', value: 1 }] },
  { key: 'not_jarring_blows', kind: 'notable', sectors: '*', rings: [3], label: 'Jarring Blows', grants: [{ type: 'status', status: 'shock', value: 1 }] },
];

// --- Keystones -------------------------------------------------------------
//
// Five per sector, hand-authored rather than templated: a keystone is the one
// node kind whose point is to be UNIQUE, so generating them from an archetype
// would defeat the purpose. Order within a sector is the order the generator
// places them: the two ring-2 keystones first, then the three ring-3 ones, so
// the strongest of the five should be authored last.
const KEYSTONES = {
  wisdom: [
    { key: 'ks_wis_inner_flame', label: 'Inner Flame — +30 WIS', grants: [{ type: 'stat', stat: 'wisdom', value: 30 }] },
    { key: 'ks_wis_meditation', label: 'Meditation — +120 maximum mana', grants: [{ type: 'resource', pool: 'mana', value: 120 }] },
    { key: 'ks_wis_spirit_ward', label: 'Spirit Ward — +20% arcane resistance', grants: [{ type: 'resist', element: 'arcane', value: 20 }] },
    { key: 'ks_wis_iron_body', label: 'Iron Body — +20 WIS and +20 CON', grants: [{ type: 'stat', stat: 'wisdom', value: 20 }, { type: 'stat', stat: 'constitution', value: 20 }] },
    { key: 'ks_wis_clarity', label: 'Clarity — mana regeneration also restores 20% as much life', grants: [{ type: 'rule', rule: 'regenLifeShare', value: 0.2 }] },
  ],
  intelligence: [
    { key: 'ks_int_pyromancy', label: 'Pyromancy — +35% fire damage', grants: [{ type: 'damage', element: 'fire', value: 35 }] },
    { key: 'ks_int_storm_caller', label: 'Storm Caller — +35% lightning damage', grants: [{ type: 'damage', element: 'lightning', value: 35 }] },
    { key: 'ks_int_cryomancy', label: 'Cryomancy — +35% ice damage, and your hits chill', grants: [{ type: 'damage', element: 'ice', value: 35 }, { type: 'status', status: 'chill', value: 1 }] },
    { key: 'ks_int_deep_well', label: 'Deep Well — +40 INT', grants: [{ type: 'stat', stat: 'intelligence', value: 40 }] },
    { key: 'ks_int_arcane_conduit', label: 'Arcane Conduit — +20 INT and +60 maximum mana', grants: [{ type: 'stat', stat: 'intelligence', value: 20 }, { type: 'resource', pool: 'mana', value: 60 }] },
  ],
  dexterity: [
    { key: 'ks_dex_deadeye', label: 'Deadeye — +30 DEX', grants: [{ type: 'stat', stat: 'dexterity', value: 30 }] },
    { key: 'ks_dex_windrunner', label: 'Windrunner — +20 DEX and +80 maximum stamina', grants: [{ type: 'stat', stat: 'dexterity', value: 20 }, { type: 'resource', pool: 'stamina', value: 80 }] },
    { key: 'ks_dex_piercing_shot', label: 'Piercing Shot — +30% physical damage', grants: [{ type: 'damage', element: 'physical', value: 30 }] },
    { key: 'ks_dex_evasion', label: 'Evasion — +12% resistance to every element', grants: [{ type: 'resist', element: 'physical', value: 12 }, { type: 'resist', element: 'arcane', value: 12 }, { type: 'resist', element: 'fire', value: 12 }, { type: 'resist', element: 'ice', value: 12 }, { type: 'resist', element: 'lightning', value: 12 }] },
    { key: 'ks_dex_fleet', label: 'Fleet — your cooldown floor drops from 0.40 to 0.32', grants: [{ type: 'rule', rule: 'cooldownFloor', value: 0.32 }] },
  ],
  strength: [
    { key: 'ks_str_executioner', label: 'Executioner — +25% physical damage', grants: [{ type: 'damage', element: 'physical', value: 25 }] },
    { key: 'ks_str_iron_hide', label: 'Iron Hide — +250 maximum life', grants: [{ type: 'resource', pool: 'hp', value: 250 }] },
    { key: 'ks_str_bulwark', label: 'Bulwark — +20 CON and +10% physical resistance', grants: [{ type: 'stat', stat: 'constitution', value: 20 }, { type: 'resist', element: 'physical', value: 10 }] },
    { key: 'ks_str_reckless_swing', label: 'Reckless Swing — +40% physical damage, -15% ice resistance', grants: [{ type: 'damage', element: 'physical', value: 40 }, { type: 'resist', element: 'ice', value: -15 }] },
    { key: 'ks_str_unbreakable', label: 'Unbreakable — +30 STR and +150 maximum life', grants: [{ type: 'stat', stat: 'strength', value: 30 }, { type: 'resource', pool: 'hp', value: 150 }] },
  ],
  constitution: [
    { key: 'ks_con_pain_ward', label: 'Pain Ward — +15% physical and +15% fire resistance', grants: [{ type: 'resist', element: 'physical', value: 15 }, { type: 'resist', element: 'fire', value: 15 }] },
    { key: 'ks_con_undying', label: 'Undying — +40 CON', grants: [{ type: 'stat', stat: 'constitution', value: 40 }] },
    { key: 'ks_con_vital_surge', label: 'Vital Surge — +300 maximum life', grants: [{ type: 'resource', pool: 'hp', value: 300 }] },
    { key: 'ks_con_sanguine_rite', label: 'Sanguine Rite — life costs are reduced a further 20%', grants: [{ type: 'rule', rule: 'lifeCostMultiplier', value: 0.8 }] },
    { key: 'ks_con_blood_pact', label: 'Blood Pact — life costs are reduced 25%', grants: [{ type: 'rule', rule: 'lifeCostMultiplier', value: 0.75 }] },
  ],
  charisma: [
    { key: 'ks_cha_silver_tongue', label: 'Silver Tongue — +40 CHA', grants: [{ type: 'stat', stat: 'charisma', value: 40 }] },
    { key: 'ks_cha_wild_growth', label: 'Wild Growth — +25 CHA and +150 maximum life', grants: [{ type: 'stat', stat: 'charisma', value: 25 }, { type: 'resource', pool: 'hp', value: 150 }] },
    { key: 'ks_cha_venomous_bond', label: 'Venomous Bond — your hits burn', grants: [{ type: 'status', status: 'burn', value: 1 }] },
    { key: 'ks_cha_pack_leader', label: 'Pack Leader — +3 to your charm budget', grants: [{ type: 'rule', rule: 'treeCharmBonus', value: 3 }] },
    { key: 'ks_cha_beast_bond', label: 'Beast Bond — +5 to your charm budget', grants: [{ type: 'rule', rule: 'treeCharmBonus', value: 5 }] },
  ],
};

// The six rim start positions. A start node is GRANTED, never allocated: it
// costs no point, never appears in character_passives, and is the seed the
// allocatability walk starts from. `start_class` matches entity_types.name,
// NOT entity_types.main_stat -- main_stat is Group B's column and Group C must
// not depend on it. All six classes exist as entity_types rows as of
// SOMET-471; before that, four of these start nodes sat unreachable.
//
// ================= WHY A START NODE NOW GRANTS SOMETHING =================
//
// C1 shipped these with `grants: []` and a test asserting "a start node grants
// nothing -- it is free, so it must also be inert". SOMET-471 REVERSES that,
// under contract 6.11, which splits class identity in two and keeps the split
// strict:
//
//   OPTION 1 -- NUMBERS. A class's max_hp/max_mana live in entity_types and
//               reach the game through characters.js's classPoolsFromRow.
//   OPTION 3 -- RULES.   A class's MECHANICAL identity lives HERE, on its
//               start node.
//
// The whole point of the split is that class identity is paid for ONCE. So:
//
//   *** A START NODE MUST NEVER GRANT A RAW POOL BONUS. ***
//
// No `{ type: 'resource', pool: 'hp' | 'mana' | 'stamina' }` may appear below,
// ever. Pools are option 1's job, and granting one here would pay a class
// twice for being what it is. passive_tree_generator.test.js asserts this
// directly rather than leaving it to a reader.
//
// WHAT THEY GRANT, AND WHY IT IS BALANCED. A start node is FREE -- every
// character gets exactly one, at no point cost -- so the six must be worth
// roughly the same as each other, and each must be worth roughly one ring-1
// minor, the cheapest thing a point can buy. `min_edge` (+3 physical damage)
// is the yardstick, and the two damage grants below match it exactly. The four
// rule grants are each the SMALLEST STEP of the rule their own sector's
// keystones later deepen, so their magnitude is anchored to numbers that were
// already balanced against a keystone's cost:
//
//   Warrior  strength      +3 physical damage       == min_edge, the yardstick
//   Mage     intelligence  +3 arcane damage         == min_edge, other element
//   Archer   dexterity     cooldownFloor 0.40->0.38   (ks_dex_fleet goes 0.32)
//   Monk     wisdom        regenLifeShare 0.1         (ks_wis_clarity gives 0.2)
//   Cultist  constitution  lifeCostMultiplier 0.9     (ks_con_blood_pact 0.75)
//   Druid    charisma      treeCharmBonus +1          (ks_cha_pack_leader +3)
//
// Each grant is the SECTOR'S OWN identity as declared in SECTORS above:
// Warrior melee damage, Mage spell damage, Archer attack speed, Monk mana
// regeneration, Cultist life-cost casting, Druid charm power. The Mage's other
// declared identity is "maximum mana" -- deliberately NOT granted here,
// because that is a pool, and pools are option 1's.
//
// A NOTE ON THE MONK. Its identity is mana regeneration, and the obvious way
// to express that is doubling entity_types.mana_regen_rate. That column is
// DEAD: playerStats.js derives a player's manaRegen from MANA_REGEN_BASE and
// wisdom and has never read it (see migration 1714440510000's header).
// `regenLifeShare` is the closest LIVE rule in the vocabulary and it is the
// wisdom sector's own keystone rule, so the Monk starts with a tenth of
// Clarity rather than with a number nothing consumes.
//
// Every `rule` key below is declared in RULE_KEYS above WITH ITS CONSUMER, and
// the generator test cross-checks that. A start-node grant naming a rule
// nobody reads would be a node the player cannot tell apart from a working one
// -- the failure mode RULE_KEYS' mandatory `consumer` field exists to prevent.
const START_NODES = [
  { sector: 'wisdom', start_class: 'Monk', label: 'Monk', grants: [{ type: 'rule', rule: 'regenLifeShare', value: 0.1 }] },
  { sector: 'intelligence', start_class: 'Mage', label: 'Mage', grants: [{ type: 'damage', element: 'arcane', value: 3 }] },
  { sector: 'dexterity', start_class: 'Archer', label: 'Archer', grants: [{ type: 'rule', rule: 'cooldownFloor', value: 0.38 }] },
  { sector: 'strength', start_class: 'Warrior', label: 'Warrior', grants: [{ type: 'damage', element: 'physical', value: 3 }] },
  { sector: 'constitution', start_class: 'Cultist', label: 'Cultist', grants: [{ type: 'rule', rule: 'lifeCostMultiplier', value: 0.9 }] },
  { sector: 'charisma', start_class: 'Druid', label: 'Druid', grants: [{ type: 'rule', rule: 'treeCharmBonus', value: 1 }] },
];

const PASSIVE_TREE_SPEC = {
  sectors: SECTORS,
  layout: LAYOUT,
  templates: TEMPLATES,
  keystones: KEYSTONES,
  startNodes: START_NODES,
};

module.exports = {
  PASSIVE_TREE_SPEC, SECTORS, LAYOUT, TEMPLATES, KEYSTONES, START_NODES,
  GRANT_TYPES, RULE_KEYS, STAT_KEYS, RESOURCE_POOLS, STATUSES,
};
