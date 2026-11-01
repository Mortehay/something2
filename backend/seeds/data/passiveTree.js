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
// is the whole reason ~50 templates cover 1770 sector nodes. SOMET-516 added
// `@other`, which resolves to one of the five stats a sector is NOT named
// after -- see generatePassiveTree.js's nextOtherStat.

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
  // SOMET-514 WIRED THESE TWO. Both previously said "wiring is a follow-up"
  // here and had no consumer at all, which made the Archer and Monk start
  // nodes -- whose only grants these are -- grant nothing whatsoever. The
  // `consumer` field below is now true, and passive_rules.test.js's source
  // gate reads backend/src/ to keep it true.
  cooldownFloor: {
    combine: 'min',
    consumer: 'backend/src/services/playerStats.js — cooldownFloorOf(), floors cooldownMult',
  },
  regenLifeShare: {
    combine: 'sum',
    consumer: 'backend/src/authority/world.js — tick()\'s mana-regen line, heals a share of the mana actually regenerated',
  },
  // SOMET-519. Two rules, not one, so the weapon KIND decides which applies:
  // a Warrior's attack-speed nodes must not accelerate a socketed spell stone.
  attackSpeedMult: {
    combine: 'product',
    consumer: 'backend/src/authority/world.js — applyAttackCooldown(), melee branch',
  },
  castSpeedMult: {
    combine: 'product',
    consumer: 'backend/src/authority/world.js — applyAttackCooldown(), projectile branch',
  },
  // SOMET-520. Resolved ONCE at the top of attack()'s melee branch and passed
  // to all four sites that need it -- including the attack descriptor, so the
  // client draws the same arc the server hit-tested.
  meleeReachBonus: {
    combine: 'sum',
    consumer: 'backend/src/authority/world.js — attack(), melee branch `reach` (pixels); castSkill(), melee skills',
  },
  meleeArcBonus: {
    combine: 'sum',
    consumer: 'backend/src/authority/world.js — attack(), melee branch `arc` (radians, clamped at TAU); castSkill(), melee skills',
  },
  // SOMET-521. The volley. Cost and cooldown are paid once per volley, not per
  // projectile -- see attack()'s projectile branch.
  projectileCount: {
    combine: 'sum',
    consumer: 'backend/src/authority/world.js — attack(), projectile branch spawns 1 + this, fanned; castSkill(), extra hits for skill.projectile skills',
  },
  projectileSpeedMult: {
    combine: 'product',
    consumer: 'backend/src/authority/world.js — attack(), scales shotWeapon.projectile_speed',
  },
  pierceBonus: {
    combine: 'sum',
    consumer: 'backend/src/authority/world.js — attack(), shotWeapon.pierce, applied BEFORE spawn\'s aoe clamp',
  },
  // SOMET-522. The Cultist's leech aura, resolved once a second in tick().
  auraLeech: {
    combine: 'sum',
    consumer: 'backend/src/authority/world.js — tick()\'s aura pass, life per hostile per second',
  },
  auraRadius: {
    combine: 'sum',
    consumer: 'backend/src/authority/world.js — tick()\'s aura pass, pixels on top of AURA_BASE_RADIUS',
  },
  // SOMET-527. The price a wide swing pays.
  meleeDamageMult: {
    combine: 'product',
    consumer: 'backend/src/authority/world.js — weaponDamage(), melee branch; castSkill(), melee skills',
  },
  // SOMET-528. Above zero means a swing leaves a lingering wave.
  meleeWaveShare: {
    combine: 'sum',
    consumer: 'backend/src/authority/world.js — attack() and castSkill() (melee skills) spawn the wave, tick() damages through it',
  },
  hpRegen: {
    combine: 'sum',
    consumer: "backend/src/authority/world.js — tick()'s hp-regen line / playerStats.js hpRegen",
  },
  manaRegen: {
    combine: 'sum',
    consumer: "backend/src/services/playerStats.js — derivePlayerStats()'s manaRegen",
  },
  staminaRegen: {
    combine: 'sum',
    consumer: "backend/src/authority/world.js — tick()'s stamina-regen line / playerStats.js staminaRegen",
  },
  // The Druid's shapeshift nodes. Every form's own bonus (bear's life and
  // damage cut, hawk's speed and dodge, wolf's attack and crit) is scaled by
  // 1 + this, so a node can make a form stronger rather than only granting
  // stats beside it. Capped at +100% where it is applied.
  formPower: {
    combine: 'sum',
    consumer: 'backend/src/authority/skillBalance.js — resolveEffects(), scales the bonuses of a druid form at cast time',
  },

  // --- Skill rules (the second wave: skills are the main way to fight) --------
  // Damage a SKILL deals, by the attribute the skill names (skill.attribute).
  // One rule per attribute, `sum`: +0.04 is +4% for every skill on that
  // attribute, added to the others and multiplied against the skill.
  strengthSkillDamage: { combine: 'sum', consumer: 'backend/src/authority/world.js — castSkill(), skills whose attribute is strength' },
  dexteritySkillDamage: { combine: 'sum', consumer: 'backend/src/authority/world.js — castSkill(), skills whose attribute is dexterity' },
  constitutionSkillDamage: { combine: 'sum', consumer: 'backend/src/authority/world.js — castSkill(), skills whose attribute is constitution' },
  intelligenceSkillDamage: { combine: 'sum', consumer: 'backend/src/authority/world.js — castSkill(), skills whose attribute is intelligence' },
  wisdomSkillDamage: { combine: 'sum', consumer: 'backend/src/authority/world.js — castSkill(), skills whose attribute is wisdom' },
  charismaSkillDamage: { combine: 'sum', consumer: 'backend/src/authority/world.js — castSkill(), skills whose attribute is charisma' },
  // A flat multiplier on every skill's damage. `product`, and the keystones that
  // raise it also pay for it (a cost multiplier or lost life).
  skillDamageMult: { combine: 'product', consumer: 'backend/src/authority/world.js — castSkill(), every damaging skill' },
  // Extra skill damage while the caster is under 35% life / holds 80%+ of their mana.
  lowLifeDamage: { combine: 'sum', consumer: 'backend/src/authority/world.js — castSkill(), skill damage while hp < 35% of max' },
  fullManaDamage: { combine: 'sum', consumer: 'backend/src/authority/world.js — castSkill(), skill damage while mana >= 80% of max' },
  // Critical strikes. critChance is a fraction added to the weapon family's and
  // the buffs'; critDamage is added to the 1.5 base multiplier.
  critChance: { combine: 'sum', consumer: 'backend/src/authority/skillBalance.js — rollCrit(), weapon attacks and skills' },
  critDamage: { combine: 'sum', consumer: 'backend/src/authority/skillBalance.js — rollCrit(), weapon attacks and skills' },
  // What a skill costs and how fast it recharges. `product`; below 1 is cheaper / faster.
  manaCostMult: { combine: 'product', consumer: 'backend/src/authority/world.js — castSkill(), mana-cost skills' },
  staminaCostMult: { combine: 'product', consumer: 'backend/src/authority/world.js — castSkill(), stamina-cost skills' },
  skillCooldownMult: { combine: 'product', consumer: 'backend/src/services/playerStats.js — skillCooldownMults(), damaging skills (floored)' },
  // Sustain and control.
  skillLeech: { combine: 'sum', consumer: 'backend/src/authority/skillBalance.js — leechHeal(), share of a skill\'s damage healed' },
  killHeal: { combine: 'sum', consumer: 'backend/src/authority/world.js — castSkill(), share of max life restored per creature killed' },
  stunChance: { combine: 'sum', consumer: 'backend/src/authority/world.js — attack() and castSkill(), stun rider on every hit' },
  dodgeChance: { combine: 'sum', consumer: 'backend/src/authority/skillBalance.js — mitigateIncoming(), capped at 50%' },
  reflectShare: { combine: 'sum', consumer: 'backend/src/authority/skillBalance.js — mitigateIncoming(), share of a blow sent back' },
  aoeRadiusMult: { combine: 'product', consumer: 'backend/src/authority/world.js — castSkill(), area skills' },
  manaPerWisdom: { combine: 'sum', consumer: 'backend/src/services/playerStats.js — derivePlayerStats(), max mana per point of wisdom above base' },
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
  // Charisma is the Druid's main attribute: her skills scale with it and her
  // gems are gated by it. `ownStats` is the rotation `@sector` follows: 8/13
  // CHA, and one each of CON, WIS, STR, DEX and INT for the survivability and
  // casting her kit also leans on.
  {
    key: 'charisma', className: 'Druid', identity: 'shapeshifting and skill power through charisma',
    ownStats: ['charisma', 'charisma', 'charisma', 'charisma', 'charisma', 'charisma', 'charisma', 'charisma', 'constitution', 'wisdom', 'strength', 'dexterity', 'intelligence'],
  },
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
  // SOMET-517. Same idea for the `greater` tier, with different constants so
  // greaters and keystones do not land on each other's nudged positions.
  greaterOffset: 11,
  greaterStagger: 3,
  // SOMET-518. Epic clusters sit OUTSIDE ring 3 (whose outermost row is at
  // 700 + 2*70 = 840), far enough out that a hub and its satellites cannot
  // overlap the grid they hang off.
  clusterRadius: 2350,
  clusterSatelliteRadius: 90,
  rings: [
    null, // index 0 is the core + the start nodes, which are not laid out on a grid
    { rows: 4, cols: 17, baseRadius: 320, rowStep: 65, minor: 60, notable: 8, keystone: 0 },
    { rows: 4, cols: 29, baseRadius: 720, rowStep: 85, minor: 100, notable: 14, keystone: 2 },
    { rows: 3, cols: 37, baseRadius: 1200, rowStep: 105, minor: 84, notable: 18, keystone: 3, greater: 6 },
    { rows: 3, cols: 25, baseRadius: 1750, rowStep: 105, minor: 56, notable: 14, keystone: 0, greater: 5 },
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

  // --- minors (the connective tissue) ---
  //
  // SOMET-516. THE 70/30 SPLIT. Before this ticket every one of these granted
  // `@sector`, so the constitution sector held ZERO intelligence -- while a
  // Cultist casts with spellMult, which derives from INTELLIGENCE. Building a
  // caster meant leaving your own sector on the first node.
  //
  // `@other` rotates through the five stats that are not this sector's own, so
  // ~30% of a sector's stat grants are off-stat, spread evenly across the five.
  // Sector identity survives on the remaining 70%: walking the strength sector
  // still makes you mostly stronger.
  //
  // WEIGHTS ARE WHAT SET THE RATIO. templatePool expands by weight before the
  // `pool[i % length]` pick, so the mix is stated here rather than being an
  // accident of how many objects sit in this array. The guard test in
  // passive_tree_generator.test.js measures the realized ratio per sector.
  //
  // Off-stat variants carry the SAME magnitudes as their own-stat twins. The
  // six stats are symmetric in progressionConstants.js -- each buys exactly one
  // derived number -- so discounting off-stat nodes would be a balance claim
  // nothing supports.
  { key: 'min_sinew', kind: 'minor', sectors: '*', rings: [1, 2, 3], weight: 7, label: 'Sinew', grants: [{ type: 'stat', stat: '@sector', value: 2 }] },
  { key: 'min_focus', kind: 'minor', sectors: '*', rings: [1, 2, 3], weight: 7, label: 'Focus', grants: [{ type: 'stat', stat: '@sector', value: 3 }] },
  { key: 'min_vigour', kind: 'minor', sectors: '*', rings: [1, 2, 3], weight: 5, label: 'Vigour', grants: [{ type: 'stat', stat: '@sector', value: 2 }, { type: 'resource', pool: 'hp', value: 8 }] },
  { key: 'min_insight', kind: 'minor', sectors: '*', rings: [1, 2, 3], weight: 5, label: 'Insight', grants: [{ type: 'stat', stat: '@sector', value: 2 }, { type: 'resource', pool: 'mana', value: 6 }] },
  { key: 'min_wind', kind: 'minor', sectors: '*', rings: [1, 2, 3], weight: 5, label: 'Wind', grants: [{ type: 'stat', stat: '@sector', value: 2 }, { type: 'resource', pool: 'stamina', value: 5 }] },
  // The off-stat connective tissue. Labels are distinct from their own-stat
  // twins on purpose: two nodes both called "Sinew" granting different stats
  // is a tooltip that lies.
  { key: 'min_versatility', kind: 'minor', sectors: '*', rings: [1, 2, 3], weight: 5, label: 'Versatility', grants: [{ type: 'stat', stat: '@other', value: 2 }] },
  { key: 'min_breadth', kind: 'minor', sectors: '*', rings: [1, 2, 3], weight: 4, label: 'Breadth', grants: [{ type: 'stat', stat: '@other', value: 3 }] },
  { key: 'min_crosstrain', kind: 'minor', sectors: '*', rings: [1, 2, 3], weight: 3, label: 'Cross-Training', grants: [{ type: 'stat', stat: '@other', value: 2 }, { type: 'resource', pool: 'hp', value: 8 }] },
  { key: 'min_dabbler', kind: 'minor', sectors: '*', rings: [1, 2, 3], weight: 3, label: 'Dabbler', grants: [{ type: 'stat', stat: '@other', value: 2 }, { type: 'resource', pool: 'mana', value: 6 }] },
  { key: 'min_hardy', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Hardy', grants: [{ type: 'resource', pool: 'hp', value: 15 }] },
  { key: 'min_reserve', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Reserve', grants: [{ type: 'resource', pool: 'mana', value: 12 }] },
  { key: 'min_callus', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Callus', grants: [{ type: 'resist', element: 'physical', value: 2 }] },
  { key: 'min_edge', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Edge', grants: [{ type: 'damage', element: 'physical', value: 3 }] },
  { key: 'min_temper', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Temper', grants: [{ type: 'stat', stat: '@sector', value: 2 }, { type: 'resist', element: 'physical', value: 1 }] },
  { key: 'min_second_wind', kind: 'minor', sectors: '*', rings: [1, 2, 3], label: 'Second Wind', grants: [{ type: 'resource', pool: 'stamina', value: 10 }] },
  { key: 'min_discipline', kind: 'minor', sectors: '*', rings: [2, 3], weight: 5, label: 'Discipline', grants: [{ type: 'stat', stat: '@sector', value: 4 }] },
  { key: 'min_polymath', kind: 'minor', sectors: '*', rings: [2, 3], weight: 2, label: 'Polymath', grants: [{ type: 'stat', stat: '@other', value: 4 }] },

  // Class/sector themed sustain & regeneration:
  // Constitution (Cultist) - HP Regen & Blood Siphon
  { key: 'min_mending', kind: 'minor', sectors: ['constitution'], rings: [1, 2, 3], weight: 2, label: 'Mending', grants: [{ type: 'rule', rule: 'hpRegen', value: 1.5 }, { type: 'resource', pool: 'hp', value: 20 }] },
  { key: 'min_bloodflow', kind: 'minor', sectors: ['constitution'], rings: [1, 2, 3], weight: 2, label: 'Bloodflow', grants: [{ type: 'rule', rule: 'hpRegen', value: 1.5 }, { type: 'rule', rule: 'lifeCostMultiplier', value: 0.98 }] },
  // Strength (Warrior) - HP Regen & Melee Fortitude
  { key: 'min_regrowth', kind: 'minor', sectors: ['strength'], rings: [1, 2, 3], weight: 2, label: 'Regrowth', grants: [{ type: 'rule', rule: 'hpRegen', value: 1.0 }, { type: 'resource', pool: 'hp', value: 15 }] },
  { key: 'min_enduring_flesh', kind: 'minor', sectors: ['strength'], rings: [1, 2, 3], weight: 2, label: 'Enduring Flesh', grants: [{ type: 'rule', rule: 'hpRegen', value: 1.5 }, { type: 'resist', element: 'physical', value: 2 }] },
  // 41 of the Warrior's 50 skills cost stamina, yet this sector had no stamina
  // regeneration of its own -- only the Archer's did.
  { key: 'min_battle_breath', kind: 'minor', sectors: ['strength'], rings: [1, 2, 3], weight: 2, label: 'Battle Breath', grants: [{ type: 'rule', rule: 'staminaRegen', value: 3.0 }, { type: 'resource', pool: 'stamina', value: 10 }] },
  // Intelligence (Mage) - Mana Regen & Elemental Spark
  { key: 'min_arcane_recovery', kind: 'minor', sectors: ['intelligence'], rings: [1, 2, 3], weight: 2, label: 'Arcane Recovery', grants: [{ type: 'rule', rule: 'manaRegen', value: 3.0 }, { type: 'resource', pool: 'mana', value: 15 }] },
  { key: 'min_meditation_spark', kind: 'minor', sectors: ['intelligence'], rings: [1, 2, 3], weight: 2, label: 'Meditation Spark', grants: [{ type: 'rule', rule: 'manaRegen', value: 2.5 }, { type: 'damage', element: 'arcane', value: 4 }] },
  // Wisdom (Monk) - Hybrid HP + Mana Regen
  { key: 'min_inner_harmony', kind: 'minor', sectors: ['wisdom'], rings: [1, 2, 3], weight: 2, label: 'Inner Harmony', grants: [{ type: 'rule', rule: 'hpRegen', value: 0.8 }, { type: 'rule', rule: 'manaRegen', value: 2.0 }] },
  { key: 'min_serenity', kind: 'minor', sectors: ['wisdom'], rings: [1, 2, 3], weight: 2, label: 'Serenity', grants: [{ type: 'rule', rule: 'hpRegen', value: 0.8 }, { type: 'rule', rule: 'manaRegen', value: 2.0 }, { type: 'resist', element: 'arcane', value: 2 }] },
  // Dexterity (Archer) - Agility & Stamina Regen
  { key: 'min_quick_recovery', kind: 'minor', sectors: ['dexterity'], rings: [1, 2, 3], weight: 2, label: 'Quick Recovery', grants: [{ type: 'rule', rule: 'staminaRegen', value: 3.0 }, { type: 'resource', pool: 'stamina', value: 10 }] },
  { key: 'min_nimble_flow', kind: 'minor', sectors: ['dexterity'], rings: [1, 2, 3], weight: 2, label: 'Nimble Flow', grants: [{ type: 'rule', rule: 'staminaRegen', value: 4.0 }, { type: 'rule', rule: 'hpRegen', value: 0.5 }] },
  // Charisma (Druid) - Nature Mixed Rejuvenation
  { key: 'min_wild_bloom', kind: 'minor', sectors: ['charisma'], rings: [1, 2, 3], weight: 2, label: 'Wild Bloom', grants: [{ type: 'rule', rule: 'hpRegen', value: 0.8 }, { type: 'rule', rule: 'manaRegen', value: 1.5 }, { type: 'rule', rule: 'staminaRegen', value: 2.0 }] },
  { key: 'min_natural_vigour', kind: 'minor', sectors: ['charisma'], rings: [1, 2, 3], weight: 2, label: 'Natural Vigour', grants: [{ type: 'rule', rule: 'hpRegen', value: 1.0 }, { type: 'rule', rule: 'staminaRegen', value: 2.5 }] },

  // --- notables ---
  { key: 'not_great_sinew', kind: 'notable', sectors: '*', rings: [1, 2, 3], weight: 5, label: 'Great Sinew', grants: [{ type: 'stat', stat: '@sector', value: 6 }] },
  { key: 'not_mastery', kind: 'notable', sectors: '*', rings: [2, 3], weight: 4, label: 'Mastery', grants: [{ type: 'stat', stat: '@sector', value: 8 }] },
  { key: 'not_apotheosis', kind: 'notable', sectors: '*', rings: [3], weight: 3, label: 'Apotheosis', grants: [{ type: 'stat', stat: '@sector', value: 12 }] },
  // SOMET-516: the off-stat notables. An 8/12/16 off-stat notable is what lets
  // a Cultist reach real INT, or a Monk real STR, without leaving home.
  { key: 'not_broad_study', kind: 'notable', sectors: '*', rings: [1, 2, 3], weight: 2, label: 'Broad Study', grants: [{ type: 'stat', stat: '@other', value: 6 }] },
  { key: 'not_second_discipline', kind: 'notable', sectors: '*', rings: [2, 3], weight: 2, label: 'Second Discipline', grants: [{ type: 'stat', stat: '@other', value: 8 }] },
  { key: 'not_renaissance', kind: 'notable', sectors: '*', rings: [3], weight: 1, label: 'Renaissance', grants: [{ type: 'stat', stat: '@other', value: 12 }] },
  { key: 'not_deep_reserve', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Deep Reserve', grants: [{ type: 'resource', pool: 'mana', value: 15 }] },
  { key: 'not_thick_skin', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Thick Skin', grants: [{ type: 'resource', pool: 'hp', value: 25 }] },
  { key: 'not_endurance', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Endurance', grants: [{ type: 'resource', pool: 'stamina', value: 20 }] },
  { key: 'not_brutality', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Brutality', grants: [{ type: 'damage', element: 'physical', value: 8 }] },
  // Sector-themed notables:
  { key: 'not_sanguine_spring', kind: 'notable', sectors: ['constitution'], rings: [1, 2, 3], label: 'Sanguine Spring', grants: [{ type: 'rule', rule: 'hpRegen', value: 2.5 }, { type: 'resource', pool: 'hp', value: 35 }] },
  { key: 'not_iron_recovery', kind: 'notable', sectors: ['strength'], rings: [1, 2, 3], label: 'Iron Recovery', grants: [{ type: 'rule', rule: 'hpRegen', value: 2.0 }, { type: 'resource', pool: 'hp', value: 30 }] },
  { key: 'not_unflagging', kind: 'notable', sectors: ['strength'], rings: [1, 2, 3], label: 'Unflagging', grants: [{ type: 'rule', rule: 'staminaRegen', value: 5.0 }, { type: 'resource', pool: 'stamina', value: 20 }] },
  { key: 'not_font_of_power', kind: 'notable', sectors: ['intelligence'], rings: [1, 2, 3], label: 'Font of Power', grants: [{ type: 'rule', rule: 'manaRegen', value: 4.0 }, { type: 'resource', pool: 'mana', value: 25 }] },
  { key: 'not_tranquil_flow', kind: 'notable', sectors: ['wisdom'], rings: [1, 2, 3], label: 'Tranquil Flow', grants: [{ type: 'rule', rule: 'hpRegen', value: 1.5 }, { type: 'rule', rule: 'manaRegen', value: 3.0 }, { type: 'resist', element: 'arcane', value: 5 }] },
  { key: 'not_fleeting_rest', kind: 'notable', sectors: ['dexterity'], rings: [1, 2, 3], label: 'Fleeting Rest', grants: [{ type: 'rule', rule: 'staminaRegen', value: 5.0 }, { type: 'resource', pool: 'stamina', value: 15 }, { type: 'rule', rule: 'hpRegen', value: 0.8 }] },
  // Shapeshifting: the Druid's own tier of nodes. formPower scales every form's
  // bonus (see RULE_KEYS).
  { key: 'min_feral_edge', kind: 'minor', sectors: ['charisma'], rings: [1, 2, 3], weight: 2, label: 'Feral Edge', grants: [{ type: 'rule', rule: 'formPower', value: 0.02 }, { type: 'resource', pool: 'hp', value: 8 }] },
  { key: 'not_primal_instinct', kind: 'notable', sectors: ['charisma'], rings: [1, 2, 3], weight: 3, label: 'Primal Instinct', grants: [{ type: 'rule', rule: 'formPower', value: 0.05 }, { type: 'resource', pool: 'hp', value: 20 }] },
  { key: 'not_thorn_hide', kind: 'notable', sectors: ['charisma'], rings: [2, 3], weight: 2, label: 'Thorn Hide', grants: [{ type: 'resist', element: 'physical', value: 5 }, { type: 'resource', pool: 'hp', value: 20 }] },
  { key: 'not_rejuvenation', kind: 'notable', sectors: ['charisma'], rings: [1, 2, 3], label: 'Rejuvenation', grants: [{ type: 'rule', rule: 'hpRegen', value: 1.5 }, { type: 'rule', rule: 'manaRegen', value: 2.0 }, { type: 'rule', rule: 'staminaRegen', value: 3.0 }] },
  { key: 'not_kindling', kind: 'notable', sectors: '*', rings: [1, 2, 3], skipSectors: ['charisma'], label: 'Kindling', grants: [{ type: 'damage', element: 'fire', value: 8 }] },
  { key: 'not_frostbite', kind: 'notable', sectors: '*', rings: [1, 2, 3], skipSectors: ['charisma'], label: 'Frostbite', grants: [{ type: 'damage', element: 'ice', value: 8 }] },
  { key: 'not_charge', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Charge', grants: [{ type: 'damage', element: 'lightning', value: 8 }] },
  { key: 'not_resonance', kind: 'notable', sectors: '*', rings: [1, 2, 3], skipSectors: ['charisma'], label: 'Resonance', grants: [{ type: 'damage', element: 'arcane', value: 8 }] },
  { key: 'not_plating', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Plating', grants: [{ type: 'resist', element: 'physical', value: 5 }] },
  { key: 'not_fireproof', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Fireproof', grants: [{ type: 'resist', element: 'fire', value: 5 }] },
  { key: 'not_warm_blood', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Warm Blood', grants: [{ type: 'resist', element: 'ice', value: 5 }] },
  { key: 'not_grounding', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Grounding', grants: [{ type: 'resist', element: 'lightning', value: 5 }] },
  { key: 'not_null_field', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Null Field', grants: [{ type: 'resist', element: 'arcane', value: 5 }] },
  { key: 'not_ox_blood', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Ox Blood', grants: [{ type: 'stat', stat: '@sector', value: 6 }, { type: 'resource', pool: 'hp', value: 18 }] },
  { key: 'not_wellspring', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Wellspring', grants: [{ type: 'stat', stat: '@sector', value: 6 }, { type: 'resource', pool: 'mana', value: 14 }] },
  { key: 'not_honed', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Honed', grants: [{ type: 'stat', stat: '@sector', value: 6 }, { type: 'damage', element: 'physical', value: 4 }] },
  { key: 'not_quickening', kind: 'notable', sectors: '*', rings: [1, 2, 3], label: 'Quickening', grants: [{ type: 'stat', stat: 'dexterity', value: 4 }] },
  { key: 'not_ward', kind: 'notable', sectors: '*', rings: [2, 3], label: 'Ward', grants: [{ type: 'resist', element: 'arcane', value: 4 }, { type: 'resist', element: 'fire', value: 4 }] },
  { key: 'not_searing_blows', kind: 'notable', sectors: '*', rings: [3], label: 'Searing Blows', grants: [{ type: 'status', status: 'burn', value: 1 }] },
  { key: 'not_numbing_blows', kind: 'notable', sectors: '*', rings: [3], label: 'Numbing Blows', grants: [{ type: 'status', status: 'chill', value: 1 }] },
  { key: 'not_jarring_blows', kind: 'notable', sectors: '*', rings: [3], label: 'Jarring Blows', grants: [{ type: 'status', status: 'shock', value: 1 }] },

  // --- greaters (SOMET-517) -------------------------------------------------
  { key: 'grt_ascendance', kind: 'greater', sectors: '*', rings: [3], weight: 3, label: 'Ascendance', grants: [{ type: 'stat', stat: '@sector', value: 18 }] },
  { key: 'grt_paragon', kind: 'greater', sectors: '*', rings: [3], weight: 2, label: 'Paragon', grants: [{ type: 'stat', stat: '@sector', value: 20 }] },
  { key: 'grt_wanderers_gift', kind: 'greater', sectors: '*', rings: [3], weight: 2, label: "Wanderer's Gift", grants: [{ type: 'stat', stat: '@other', value: 18 }] },
  { key: 'grt_apostasy', kind: 'greater', sectors: '*', rings: [3], weight: 1, label: 'Apostasy', grants: [{ type: 'stat', stat: '@other', value: 20 }] },

  // --- skill nodes (skills are the main way to fight) --------------------------
  //
  // ATTRIBUTE FOCUS. Every skill names the attribute its damage grows with, so a
  // sector can pay out in damage for the skills of ITS attribute, not only in the
  // attribute itself. One notable and one greater per attribute; they are
  // sector-locked because the rule they grant is named after the attribute.
  { key: 'not_martial_focus', kind: 'notable', sectors: ['strength'], rings: [1, 2, 3], weight: 2, label: 'Martial Focus', grants: [{ type: 'rule', rule: 'strengthSkillDamage', value: 0.04 }] },
  { key: 'not_marksmans_focus', kind: 'notable', sectors: ['dexterity'], rings: [1, 2, 3], weight: 2, label: "Marksman's Focus", grants: [{ type: 'rule', rule: 'dexteritySkillDamage', value: 0.04 }] },
  { key: 'not_sanguine_focus', kind: 'notable', sectors: ['constitution'], rings: [1, 2, 3], weight: 2, label: 'Sanguine Focus', grants: [{ type: 'rule', rule: 'constitutionSkillDamage', value: 0.04 }] },
  { key: 'not_arcane_focus', kind: 'notable', sectors: ['intelligence'], rings: [1, 2, 3], weight: 2, label: 'Arcane Focus', grants: [{ type: 'rule', rule: 'intelligenceSkillDamage', value: 0.04 }] },
  { key: 'not_inner_focus', kind: 'notable', sectors: ['wisdom'], rings: [1, 2, 3], weight: 2, label: 'Inner Focus', grants: [{ type: 'rule', rule: 'wisdomSkillDamage', value: 0.04 }] },
  { key: 'not_wild_focus', kind: 'notable', sectors: ['charisma'], rings: [1, 2, 3], weight: 2, label: 'Wild Focus', grants: [{ type: 'rule', rule: 'charismaSkillDamage', value: 0.04 }] },
  { key: 'grt_martial_mastery', kind: 'greater', sectors: ['strength'], rings: [3], label: 'Martial Mastery', grants: [{ type: 'rule', rule: 'strengthSkillDamage', value: 0.10 }] },
  { key: 'grt_marksmans_mastery', kind: 'greater', sectors: ['dexterity'], rings: [3], label: "Marksman's Mastery", grants: [{ type: 'rule', rule: 'dexteritySkillDamage', value: 0.10 }] },
  { key: 'grt_sanguine_mastery', kind: 'greater', sectors: ['constitution'], rings: [3], label: 'Sanguine Mastery', grants: [{ type: 'rule', rule: 'constitutionSkillDamage', value: 0.10 }] },
  { key: 'grt_arcane_mastery', kind: 'greater', sectors: ['intelligence'], rings: [3], label: 'Arcane Mastery', grants: [{ type: 'rule', rule: 'intelligenceSkillDamage', value: 0.10 }] },
  { key: 'grt_inner_mastery', kind: 'greater', sectors: ['wisdom'], rings: [3], label: 'Inner Mastery', grants: [{ type: 'rule', rule: 'wisdomSkillDamage', value: 0.10 }] },
  { key: 'grt_wild_mastery', kind: 'greater', sectors: ['charisma'], rings: [3], label: 'Wild Mastery', grants: [{ type: 'rule', rule: 'charismaSkillDamage', value: 0.10 }] },

  // Archer: critical strikes. critChance is a fraction added to the weapon family's
  // (a bow already has 10%); critDamage is added to the 1.5 base multiplier.
  { key: 'min_keen_eye', kind: 'minor', sectors: ['dexterity'], rings: [1, 2, 3], weight: 4, label: 'Keen Eye', grants: [{ type: 'rule', rule: 'critChance', value: 0.01 }] },
  { key: 'not_deadly_aim', kind: 'notable', sectors: ['dexterity'], rings: [1, 2, 3], label: 'Deadly Aim', grants: [{ type: 'rule', rule: 'critChance', value: 0.03 }, { type: 'rule', rule: 'critDamage', value: 0.1 }] },
  { key: 'not_hunters_reflexes', kind: 'notable', sectors: ['dexterity'], rings: [2, 3], label: "Hunter's Reflexes", grants: [{ type: 'rule', rule: 'dodgeChance', value: 0.03 }] },
  // Stamina skills: the Warrior's and the Archer's whole kit.
  { key: 'min_light_step', kind: 'minor', sectors: ['strength', 'dexterity'], rings: [1, 2, 3], weight: 2, label: 'Light Step', grants: [{ type: 'rule', rule: 'staminaCostMult', value: 0.97 }] },

  // Warrior: control and bite-back.
  { key: 'min_heavy_hand', kind: 'minor', sectors: ['strength'], rings: [1, 2, 3], weight: 2, label: 'Heavy Hand', grants: [{ type: 'rule', rule: 'stunChance', value: 0.01 }] },
  { key: 'not_concussive_force', kind: 'notable', sectors: ['strength'], rings: [1, 2, 3], label: 'Concussive Force', grants: [{ type: 'rule', rule: 'stunChance', value: 0.04 }] },
  { key: 'not_spiked_hide', kind: 'notable', sectors: ['strength'], rings: [2, 3], label: 'Spiked Hide', grants: [{ type: 'rule', rule: 'reflectShare', value: 0.05 }, { type: 'resist', element: 'physical', value: 3 }] },
  { key: 'not_berserkers_fury', kind: 'notable', sectors: ['strength'], rings: [2, 3], label: "Berserker's Fury", grants: [{ type: 'rule', rule: 'lowLifeDamage', value: 0.15 }] },

  // Mage: reach of area spells and the cost of casting.
  { key: 'min_efficient_casting', kind: 'minor', sectors: ['intelligence'], rings: [1, 2, 3], weight: 2, label: 'Efficient Casting', grants: [{ type: 'rule', rule: 'manaCostMult', value: 0.97 }] },
  { key: 'not_wide_casting', kind: 'notable', sectors: ['intelligence'], rings: [1, 2, 3], label: 'Wide Casting', grants: [{ type: 'rule', rule: 'aoeRadiusMult', value: 1.08 }] },

  // Monk: wisdom as a pool, a thrifty cost, and power while the mana is full.
  { key: 'min_ki_flow', kind: 'minor', sectors: ['wisdom'], rings: [1, 2, 3], weight: 2, label: 'Ki Flow', grants: [{ type: 'rule', rule: 'manaPerWisdom', value: 0.5 }] },
  { key: 'min_economy_of_motion', kind: 'minor', sectors: ['wisdom'], rings: [1, 2, 3], weight: 2, label: 'Economy of Motion', grants: [{ type: 'rule', rule: 'manaCostMult', value: 0.97 }] },
  { key: 'not_overflowing_spirit', kind: 'notable', sectors: ['wisdom'], rings: [1, 2, 3], label: 'Overflowing Spirit', grants: [{ type: 'rule', rule: 'fullManaDamage', value: 0.08 }] },

  // Cultist: life as a weapon.
  { key: 'min_open_wounds', kind: 'minor', sectors: ['constitution'], rings: [1, 2, 3], weight: 2, label: 'Open Wounds', grants: [{ type: 'rule', rule: 'killHeal', value: 0.005 }] },
  { key: 'not_blood_hunger', kind: 'notable', sectors: ['constitution'], rings: [1, 2, 3], label: 'Blood Hunger', grants: [{ type: 'rule', rule: 'skillLeech', value: 0.04 }] },
  { key: 'not_gallows_humour', kind: 'notable', sectors: ['constitution'], rings: [2, 3], label: 'Gallows Humour', grants: [{ type: 'rule', rule: 'lowLifeDamage', value: 0.15 }] },

  // Every sector: a little recharge speed for the skills it casts.
  { key: 'not_quick_hands', kind: 'notable', sectors: '*', rings: [2, 3], label: 'Quick Hands', grants: [{ type: 'rule', rule: 'skillCooldownMult', value: 0.97 }] },
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
    { key: 'ks_wis_inner_flame', label: 'Inner Flame — +20 WIS', grants: [{ type: 'stat', stat: 'wisdom', value: 20 }] },
    { key: 'ks_wis_meditation', label: 'Meditation — +70 max mana, +2.0 mana regen/s, +5% life share from mana regen', grants: [{ type: 'resource', pool: 'mana', value: 70 }, { type: 'rule', rule: 'manaRegen', value: 2 }, { type: 'rule', rule: 'regenLifeShare', value: 0.05 }] },
    { key: 'ks_wis_spirit_ward', label: 'Spirit Ward — +12% arcane resistance, +0.8 HP regen/s', grants: [{ type: 'resist', element: 'arcane', value: 12 }, { type: 'rule', rule: 'hpRegen', value: 0.8 }] },
    { key: 'ks_wis_ki_overflow', label: 'Ki Overflow — +30% skill damage while mana is nearly full, +2 max mana per WIS, skills cost 15% more mana', grants: [{ type: 'rule', rule: 'fullManaDamage', value: 0.3 }, { type: 'rule', rule: 'manaPerWisdom', value: 2 }, { type: 'rule', rule: 'manaCostMult', value: 1.15 }] },
    { key: 'ks_wis_transcendence', label: 'Transcendence — +25 WIS and +18 INT', grants: [{ type: 'stat', stat: 'wisdom', value: 25 }, { type: 'stat', stat: 'intelligence', value: 18 }] },
  ],
  intelligence: [
    { key: 'ks_int_pyromancy', label: 'Pyromancy — +20% fire damage, and your hits burn', grants: [{ type: 'damage', element: 'fire', value: 20 }, { type: 'status', status: 'burn', value: 1 }] },
    { key: 'ks_int_storm_caller', label: 'Storm Caller — +20% lightning damage, and your hits shock', grants: [{ type: 'damage', element: 'lightning', value: 20 }, { type: 'status', status: 'shock', value: 1 }] },
    { key: 'ks_int_cryomancy', label: 'Cryomancy — +20% ice damage, and your hits chill', grants: [{ type: 'damage', element: 'ice', value: 20 }, { type: 'status', status: 'chill', value: 1 }] },
    { key: 'ks_int_glass_cannon', label: 'Glass Cannon — every skill hits 35% harder and costs 25% more mana, -80 max life', grants: [{ type: 'rule', rule: 'skillDamageMult', value: 1.35 }, { type: 'rule', rule: 'manaCostMult', value: 1.25 }, { type: 'resource', pool: 'hp', value: -80 }] },
    { key: 'ks_int_arcane_conduit', label: 'Arcane Conduit — +15 INT, +35 max mana, +3.0 mana regen/s', grants: [{ type: 'stat', stat: 'intelligence', value: 15 }, { type: 'resource', pool: 'mana', value: 35 }, { type: 'rule', rule: 'manaRegen', value: 3 }] },
  ],
  dexterity: [
    { key: 'ks_dex_deadeye', label: 'Deadeye — +20 DEX and +1 Extra Arrow', grants: [{ type: 'stat', stat: 'dexterity', value: 20 }, { type: 'rule', rule: 'projectileCount', value: 1 }] },
    { key: 'ks_dex_windrunner', label: 'Windrunner — +15 DEX, +40 max stamina, +5 stamina regen/s', grants: [{ type: 'stat', stat: 'dexterity', value: 15 }, { type: 'resource', pool: 'stamina', value: 40 }, { type: 'rule', rule: 'staminaRegen', value: 5 }] },
    { key: 'ks_dex_deadly_precision', label: 'Deadly Precision — +12% crit chance and +35% crit damage, -50 max life', grants: [{ type: 'rule', rule: 'critChance', value: 0.12 }, { type: 'rule', rule: 'critDamage', value: 0.35 }, { type: 'resource', pool: 'hp', value: -50 }] },
    { key: 'ks_dex_phantom_step', label: 'Phantom Step — 15% chance to dodge a blow outright, +20 max stamina', grants: [{ type: 'rule', rule: 'dodgeChance', value: 0.15 }, { type: 'resource', pool: 'stamina', value: 20 }] },
    { key: 'ks_dex_fleet', label: 'Fleet — your cooldown floor drops from 0.40 to 0.35', grants: [{ type: 'rule', rule: 'cooldownFloor', value: 0.35 }] },
  ],
  strength: [
    { key: 'ks_str_executioner', label: 'Executioner — +15% physical damage and +12 melee reach', grants: [{ type: 'damage', element: 'physical', value: 15 }, { type: 'rule', rule: 'meleeReachBonus', value: 12 }] },
    { key: 'ks_str_iron_hide', label: 'Iron Hide — +140 maximum life and +1.2 HP regen/s', grants: [{ type: 'resource', pool: 'hp', value: 140 }, { type: 'rule', rule: 'hpRegen', value: 1.2 }] },
    { key: 'ks_str_berserker', label: 'Berserker — +30% skill damage while below 35% life, +8% stun chance, -60 max life', grants: [{ type: 'rule', rule: 'lowLifeDamage', value: 0.3 }, { type: 'rule', rule: 'stunChance', value: 0.08 }, { type: 'resource', pool: 'hp', value: -60 }] },
    { key: 'ks_str_reckless_swing', label: 'Reckless Swing — +25% physical damage, -10% ice resistance', grants: [{ type: 'damage', element: 'physical', value: 25 }, { type: 'resist', element: 'ice', value: -10 }] },
    { key: 'ks_str_unbreakable', label: 'Unbreakable — +20 STR and +100 maximum life', grants: [{ type: 'stat', stat: 'strength', value: 20 }, { type: 'resource', pool: 'hp', value: 100 }] },
  ],
  constitution: [
    { key: 'ks_con_pain_ward', label: 'Pain Ward — +10% physical and +10% fire resistance, +1.2 HP regen/s', grants: [{ type: 'resist', element: 'physical', value: 10 }, { type: 'resist', element: 'fire', value: 10 }, { type: 'rule', rule: 'hpRegen', value: 1.2 }] },
    { key: 'ks_con_crimson_bargain', label: 'Crimson Bargain — every skill hits 40% harder, but costs 30% more life', grants: [{ type: 'rule', rule: 'skillDamageMult', value: 1.4 }, { type: 'rule', rule: 'lifeCostMultiplier', value: 1.3 }] },
    { key: 'ks_con_vampiric_rite', label: 'Vampiric Rite — skills heal 12% of the damage they deal, +2% max life per kill', grants: [{ type: 'rule', rule: 'skillLeech', value: 0.12 }, { type: 'rule', rule: 'killHeal', value: 0.02 }] },
    { key: 'ks_con_sanguine_rite', label: 'Sanguine Rite — life costs are reduced a further 12%', grants: [{ type: 'rule', rule: 'lifeCostMultiplier', value: 0.88 }] },
    { key: 'ks_con_blood_pact', label: 'Blood Pact — life costs are reduced 15%', grants: [{ type: 'rule', rule: 'lifeCostMultiplier', value: 0.85 }] },
  ],
  charisma: [
    { key: 'ks_cha_eternal_bear', label: 'Bear Aspect — +20 STR, +120 HP, +1.5 HP regen/s, +5% physical resistance, forms 12% stronger', grants: [{ type: 'stat', stat: 'strength', value: 20 }, { type: 'resource', pool: 'hp', value: 120 }, { type: 'rule', rule: 'hpRegen', value: 1.5 }, { type: 'resist', element: 'physical', value: 5 }, { type: 'rule', rule: 'formPower', value: 0.12 }] },
    { key: 'ks_cha_eternal_hawk', label: 'Hawk Aspect — +20 DEX, +40 max stamina, +4 stamina regen/s, +8% attack speed, forms 12% stronger', grants: [{ type: 'stat', stat: 'dexterity', value: 20 }, { type: 'resource', pool: 'stamina', value: 40 }, { type: 'rule', rule: 'staminaRegen', value: 4 }, { type: 'rule', rule: 'attackSpeedMult', value: 1.08 }, { type: 'rule', rule: 'formPower', value: 0.12 }] },
    { key: 'ks_cha_eternal_wolf', label: 'Wolf Aspect — +15 STR, +15 CHA, +12% physical damage, forms 12% stronger', grants: [{ type: 'stat', stat: 'strength', value: 15 }, { type: 'stat', stat: 'charisma', value: 15 }, { type: 'damage', element: 'physical', value: 12 }, { type: 'rule', rule: 'formPower', value: 0.12 }] },
    { key: 'ks_cha_primal_mastery', label: 'Primal Form Mastery — +30 CHA, +10 WIS, +1.5 HP regen/s, +3.0 stamina regen/s, forms 25% stronger', grants: [{ type: 'stat', stat: 'charisma', value: 30 }, { type: 'stat', stat: 'wisdom', value: 10 }, { type: 'rule', rule: 'hpRegen', value: 1.5 }, { type: 'rule', rule: 'staminaRegen', value: 3 }, { type: 'rule', rule: 'formPower', value: 0.25 }] },
    { key: 'ks_cha_menagerie', label: 'Menagerie — Aspect of the Wild (+25 CHA, +15 CON, +30 max mana, +2.0 mana regen/s, forms 15% stronger)', grants: [{ type: 'stat', stat: 'charisma', value: 25 }, { type: 'stat', stat: 'constitution', value: 15 }, { type: 'resource', pool: 'mana', value: 30 }, { type: 'rule', rule: 'manaRegen', value: 2 }, { type: 'rule', rule: 'formPower', value: 0.15 }] },
  ],
};

const CLUSTERS = [
  {
    key: 'clu_str_cleaving', sector: 'strength', hubLabel: 'Cleaving Reach',
    hubGrants: [{ type: 'rule', rule: 'meleeReachBonus', value: 20 }],
    satellites: [
      { label: 'Long Guard', grants: [{ type: 'rule', rule: 'meleeReachBonus', value: 10 }] },
      { label: 'Extended Guard', grants: [{ type: 'rule', rule: 'meleeReachBonus', value: 10 }] },
    ],
  },
  {
    key: 'clu_str_whirlwind', sector: 'strength', hubLabel: 'Whirlwind',
    hubGrants: [
      { type: 'rule', rule: 'meleeArcBonus', value: 3.5 },
      { type: 'rule', rule: 'meleeDamageMult', value: 0.8 },
    ],
    satellites: [
      { label: 'Momentum', grants: [{ type: 'rule', rule: 'attackSpeedMult', value: 1.08 }] },
      { label: 'Follow-Through', grants: [{ type: 'rule', rule: 'attackSpeedMult', value: 1.08 }] },
      { label: 'Whirling Step', grants: [{ type: 'rule', rule: 'attackSpeedMult', value: 1.08 }] },
      { label: 'Unending Swing', grants: [{ type: 'rule', rule: 'attackSpeedMult', value: 1.08 }] },
    ],
  },
  {
    key: 'clu_str_spearpoint', sector: 'strength', hubLabel: 'Spearpoint',
    hubGrants: [
      { type: 'rule', rule: 'meleeReachBonus', value: 32 },
      { type: 'rule', rule: 'meleeArcBonus', value: -0.5 },
    ],
    satellites: [
      { label: 'Lunge', grants: [{ type: 'rule', rule: 'meleeReachBonus', value: 16 }] },
      { label: 'Pike Drill', grants: [{ type: 'rule', rule: 'meleeReachBonus', value: 16 }] },
    ],
  },
  {
    key: 'clu_str_afterimage', sector: 'strength', hubLabel: 'Afterimage',
    hubGrants: [{ type: 'rule', rule: 'meleeWaveShare', value: 0.15 }],
    satellites: [
      { label: 'Lingering Edge', grants: [{ type: 'rule', rule: 'meleeWaveShare', value: 0.05 }] },
      { label: 'Slow Burn', grants: [{ type: 'rule', rule: 'meleeWaveShare', value: 0.05 }] },
    ],
  },
  {
    key: 'clu_str_sweep', sector: 'strength', hubLabel: 'Sweep',
    hubGrants: [
      { type: 'rule', rule: 'meleeArcBonus', value: 1.2 },
      { type: 'rule', rule: 'meleeReachBonus', value: -12 },
    ],
    satellites: [
      { label: 'Wide Stance', grants: [{ type: 'rule', rule: 'meleeArcBonus', value: 0.3 }] },
      { label: 'Scything Blow', grants: [{ type: 'rule', rule: 'meleeArcBonus', value: 0.3 }] },
    ],
  },
  {
    key: 'clu_dex_volley', sector: 'dexterity', hubLabel: 'Volley',
    hubGrants: [{ type: 'rule', rule: 'projectileCount', value: 1 }],
    satellites: [
      { label: 'Split Arrow', grants: [{ type: 'rule', rule: 'projectileSpeedMult', value: 1.05 }] },
      { label: 'Scattershot', grants: [{ type: 'rule', rule: 'projectileSpeedMult', value: 1.05 }] },
    ],
  },
  {
    key: 'clu_dex_swiftshot', sector: 'dexterity', hubLabel: 'Swiftshot',
    hubGrants: [{ type: 'rule', rule: 'projectileSpeedMult', value: 1.15 }],
    satellites: [
      { label: 'Taut String', grants: [{ type: 'rule', rule: 'projectileSpeedMult', value: 1.05 }] },
      { label: 'Fletching', grants: [{ type: 'rule', rule: 'projectileSpeedMult', value: 1.05 }] },
      { label: 'Draw Weight', grants: [{ type: 'rule', rule: 'projectileSpeedMult', value: 1.05 }] },
      { label: 'Loosed Wind', grants: [{ type: 'rule', rule: 'projectileSpeedMult', value: 1.05 }] },
    ],
  },
  {
    key: 'clu_int_quickcast', sector: 'intelligence', hubLabel: 'Quickcast',
    hubGrants: [{ type: 'rule', rule: 'castSpeedMult', value: 1.12 }],
    satellites: [
      { label: 'Swift Incant', grants: [{ type: 'rule', rule: 'castSpeedMult', value: 1.04 }] },
      { label: 'Practised Cadence', grants: [{ type: 'rule', rule: 'castSpeedMult', value: 1.04 }] },
      { label: 'Sharp Syllables', grants: [{ type: 'rule', rule: 'castSpeedMult', value: 1.04 }] },
      { label: 'Thoughtform', grants: [{ type: 'rule', rule: 'castSpeedMult', value: 1.04 }] },
    ],
  },
  {
    key: 'clu_int_spellpierce', sector: 'intelligence', hubLabel: 'Spellpierce',
    hubGrants: [{ type: 'rule', rule: 'pierceBonus', value: 1 }],
    satellites: [
      { label: 'Rending Bolt', grants: [{ type: 'rule', rule: 'castSpeedMult', value: 1.04 }] },
      { label: 'Unspent Force', grants: [{ type: 'rule', rule: 'castSpeedMult', value: 1.04 }] },
    ],
  },
  {
    key: 'clu_con_sanguine', sector: 'constitution', hubLabel: 'Sanguine Aura',
    hubGrants: [{ type: 'rule', rule: 'auraLeech', value: 1 }],
    satellites: [
      { label: 'Crimson Thirst', grants: [{ type: 'rule', rule: 'auraLeech', value: 0.5 }] },
      { label: 'Deepening Thirst', grants: [{ type: 'rule', rule: 'auraLeech', value: 0.5 }] },
      { label: 'Spreading Stain', grants: [{ type: 'rule', rule: 'auraRadius', value: 20 }] },
      { label: 'Wide Communion', grants: [{ type: 'rule', rule: 'auraRadius', value: 20 }] },
    ],
  },
  {
    key: 'clu_wis_clarity', sector: 'wisdom', hubLabel: 'Clarity',
    hubGrants: [{ type: 'rule', rule: 'regenLifeShare', value: 0.1 }],
    satellites: [
      { label: 'Still Water', grants: [{ type: 'rule', rule: 'regenLifeShare', value: 0.02 }] },
      { label: 'Even Breath', grants: [{ type: 'rule', rule: 'regenLifeShare', value: 0.02 }] },
      { label: 'Quiet Mind', grants: [{ type: 'rule', rule: 'regenLifeShare', value: 0.02 }] },
      { label: 'Open Palm', grants: [{ type: 'rule', rule: 'regenLifeShare', value: 0.02 }] },
    ],
  },
  // --- skill clusters: the five sectors that had one cluster or none of their own ---
  {
    key: 'clu_str_concussion', sector: 'strength', hubLabel: 'Concussion',
    hubGrants: [{ type: 'rule', rule: 'stunChance', value: 0.05 }],
    satellites: [
      { label: 'Ringing Blow', grants: [{ type: 'rule', rule: 'stunChance', value: 0.015 }] },
      { label: 'Dazed Foe', grants: [{ type: 'rule', rule: 'stunChance', value: 0.015 }] },
      { label: 'Stagger', grants: [{ type: 'rule', rule: 'stunChance', value: 0.015 }] },
    ],
  },
  {
    key: 'clu_dex_deadeye', sector: 'dexterity', hubLabel: 'Deadeye Focus',
    hubGrants: [{ type: 'rule', rule: 'critChance', value: 0.04 }],
    satellites: [
      { label: 'Steady Breath', grants: [{ type: 'rule', rule: 'critDamage', value: 0.06 }] },
      { label: 'Vital Mark', grants: [{ type: 'rule', rule: 'critDamage', value: 0.06 }] },
      { label: 'Killing Line', grants: [{ type: 'rule', rule: 'critDamage', value: 0.06 }] },
    ],
  },
  {
    key: 'clu_int_wide_arcana', sector: 'intelligence', hubLabel: 'Wide Arcana',
    hubGrants: [{ type: 'rule', rule: 'aoeRadiusMult', value: 1.10 }],
    satellites: [
      { label: 'Spreading Light', grants: [{ type: 'rule', rule: 'aoeRadiusMult', value: 1.04 }] },
      { label: 'Rolling Thunder', grants: [{ type: 'rule', rule: 'aoeRadiusMult', value: 1.04 }] },
      { label: 'Unbound Frost', grants: [{ type: 'rule', rule: 'aoeRadiusMult', value: 1.04 }] },
    ],
  },
  {
    key: 'clu_wis_overflow', sector: 'wisdom', hubLabel: 'Overflow',
    hubGrants: [{ type: 'rule', rule: 'fullManaDamage', value: 0.06 }],
    satellites: [
      { label: 'Deep Reservoir', grants: [{ type: 'rule', rule: 'manaPerWisdom', value: 0.5 }] },
      { label: 'Brimming Cup', grants: [{ type: 'rule', rule: 'manaPerWisdom', value: 0.5 }] },
      { label: 'Frugal Hands', grants: [{ type: 'rule', rule: 'manaCostMult', value: 0.96 }] },
    ],
  },
  {
    key: 'clu_con_bloodletting', sector: 'constitution', hubLabel: 'Bloodletting',
    hubGrants: [{ type: 'rule', rule: 'killHeal', value: 0.01 }],
    satellites: [
      { label: 'Red Harvest', grants: [{ type: 'rule', rule: 'skillLeech', value: 0.02 }] },
      { label: 'Feeding Frenzy', grants: [{ type: 'rule', rule: 'skillLeech', value: 0.02 }] },
      { label: 'Last Gasp', grants: [{ type: 'rule', rule: 'lowLifeDamage', value: 0.08 }] },
    ],
  },
  {
    key: 'clu_cha_beast_bond', sector: 'charisma', hubLabel: 'Wild Heart',
    hubGrants: [{ type: 'rule', rule: 'formPower', value: 0.10 }],
    satellites: [
      { label: 'Feral Surge', grants: [{ type: 'rule', rule: 'formPower', value: 0.04 }] },
      { label: 'Thick Pelt', grants: [{ type: 'rule', rule: 'hpRegen', value: 1.5 }] },
    ],
  },
];

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
//   Archer   dexterity     cooldownFloor 0.40->0.38   (ks_dex_fleet goes 0.35)
//   Monk     wisdom        regenLifeShare 0.1         (clu_wis_clarity adds 0.18, ks_wis_meditation 0.05)
//   Cultist  constitution  lifeCostMultiplier 0.9     (ks_con_blood_pact 0.85, ks_con_sanguine_rite 0.88)
//   Druid    charisma      formPower +0.03            (clu_cha_beast_bond adds 0.18, the keystones 0.12-0.25)
//
// Each grant is the SECTOR'S OWN identity as declared in SECTORS above:
// Warrior melee damage, Mage spell damage, Archer attack speed, Monk mana
// regeneration, Cultist life-cost casting, Druid shapeshifting. The Mage's other
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
  { sector: 'charisma', start_class: 'Druid', label: 'Druid', grants: [{ type: 'rule', rule: 'formPower', value: 0.03 }] },
];

const PASSIVE_TREE_SPEC = {
  sectors: SECTORS,
  layout: LAYOUT,
  templates: TEMPLATES,
  keystones: KEYSTONES,
  startNodes: START_NODES,
  clusters: CLUSTERS,
};

module.exports = {
  PASSIVE_TREE_SPEC, SECTORS, LAYOUT, TEMPLATES, KEYSTONES, START_NODES, CLUSTERS,
  GRANT_TYPES, RULE_KEYS, STAT_KEYS, RESOURCE_POOLS, STATUSES,
};
