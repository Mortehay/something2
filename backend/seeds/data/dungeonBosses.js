// backend/seeds/data/dungeonBosses.js
// SOMET-609 (S9, spec §3.8). The six dungeon bosses, as checked-in seed data.
// Two consumers: seed-catalogs restores any that are missing (never updates an
// existing row -- the Entities tab owns them after the first insert), and
// map_spec_fixtures/p5_gen_map_content read boss tiers from here so the map
// spec's `boss` blocks are validated offline against the same truth the DB has.
// Migration 1714440701000 holds a frozen copy; dungeon_boss_data_parity.test.js
// keeps the two equal until someone deliberately changes both.
const DUNGEON_BOSSES = [
  { name: 'The Bone Regent', boss_tier: 'dungeon_end', element: 'physical', color: '#d8d2c0',
    hp: 2000, defense: 16, base_damage: 24, size: 96, xp_reward: 300, gold_min: 20, gold_max: 40,
    behavior_name: 'Apex', auras: [], resistances: { physical: 0.3 }, drop_item: 'long sword',
    prompt: 'A crowned skeletal monarch on a throne of fused bones, ruling the deepest crypt of the Catacombs.' },
  { name: 'Ossuary Warden', boss_tier: 'dungeon_elite', element: 'physical', color: '#b8b09a',
    hp: 850, defense: 15, base_damage: 14, size: 72, xp_reward: 120, gold_min: 8, gold_max: 15,
    behavior_name: 'Champion', auras: ['ossuary_dread'], resistances: { physical: 0.2 }, drop_item: 'short sword',
    prompt: 'A towering armoured skeleton keeper wrapped in burial chains, guarding the ossuary.' },
  { name: 'The Ember Queen', boss_tier: 'dungeon_end', element: 'fire', color: '#ff6b1a',
    hp: 5000, defense: 25, base_damage: 52, size: 96, xp_reward: 1200, gold_min: 75, gold_max: 150,
    behavior_name: 'Apex', auras: [], resistances: { physical: 0.3 }, drop_item: 'flame staff',
    prompt: 'A vast molten hive queen with a glowing ember abdomen and wings of smouldering ash.' },
  { name: 'Cinder Matriarch', boss_tier: 'dungeon_elite', element: 'fire', color: '#c2410c',
    hp: 2200, defense: 23, base_damage: 31, size: 72, xp_reward: 500, gold_min: 30, gold_max: 60,
    behavior_name: 'Champion', auras: ['cinder_brood'], resistances: { physical: 0.2 }, drop_item: 'flame staff',
    prompt: 'A scorched brood mother insect trailing cinders, tending the burning hive cells.' },
  { name: 'The Umbral Gatekeeper', boss_tier: 'dungeon_end', element: 'arcane', color: '#4c1d95',
    hp: 8700, defense: 37, base_damage: 88, size: 112, xp_reward: 2500, gold_min: 175, gold_max: 350,
    behavior_name: 'Apex', auras: [], resistances: { physical: 0.4 }, drop_item: 'archmage staff',
    prompt: 'A colossal void sentinel of living shadow, its body a doorway into starless dark.' },
  { name: 'Shade Herald', boss_tier: 'dungeon_elite', element: 'arcane', color: '#6d28d9',
    hp: 4100, defense: 36, base_damage: 56, size: 80, xp_reward: 1100, gold_min: 75, gold_max: 150,
    behavior_name: 'Champion', auras: ['shade_veil'], resistances: { physical: 0.3 }, drop_item: 'archmage staff',
    prompt: 'A hooded wraith herald with a tattered banner of shadow, announcing the Gatekeeper.' },
];

module.exports = { DUNGEON_BOSSES };
