// backend/seeds/data/minibosses.js
// SOMET-624 (S11, spec grilled 2026-10-11). Minibosses are GENERATED, not
// hand-authored like backend/seeds/data/dungeonBosses.js's 6 entries --
// derived from the bestiary's own 32 LINES (backend/scripts/bestiary/
// template.js), the same source every "{Line} Swarm/Skirmisher/Line" creature
// already comes from. One miniboss per line (32), plus a second, tougher
// "Elite Miniboss" variant in the 9 lines whose tier includes 'IV' (the
// toughest band: Umbral, Void, Demonic, Chaos, Fallen, Nightmare, Titan,
// Plague, Eldritch) -- 41 total, not the "40" floated in grilling (an
// honest miscount there missed Void; 41 is what the real tier data gives).
// Naming follows the bestiary's own convention, so "Beast Swarm/Skirmisher/
// Line" gains "Beast Miniboss".
//
// Stats are a first-pass multiplier over the "Line" rung's flat baseline
// (every line's own Line creature has the same hp/defense regardless of
// tier -- the tier shows up in level_min/level_max instead, which minibosses
// don't carry). Real balance is SOMET-613's tuning follow-up, not this
// ticket's job -- these numbers only need to exist and be sane-shaped.
//
// drops: tests/creature_drops_db.test.js enforces a real invariant -- every
// hostile creature needs an explicit creature_drops row, or it kills
// silently yielding nothing (SOMET-624/S11 found this the hard way). Every
// miniboss gets TWO rows (SOMET-625/S12):
//  1. the floor: its rung's own BEHAVIOR_DROPS item (morning star / long
//     sword), same as any other Heavy/Champion creature -- not new curation.
//  2. the upgrade: a rarer, element-matched weapon from the SAME catalog
//     dungeon bosses already draw from (flame/frost/storm/archmage staff,
//     or two-handed sword for a physical/elementless line) -- this is the
//     actual reason to hunt one down, not just a tougher reskin of its line.
const { LINES, RUNGS } = require('../../scripts/bestiary/template.js');
const { BEHAVIOR_DROPS } = require('./behaviorDrops.js');

const LINE_RUNG = RUNGS.find((r) => r.name === 'Line');
const dropItemFor = (behaviorName) => BEHAVIOR_DROPS.find((d) => d.behavior === behaviorName).item;

const TIER_IV = 'IV';

// Same element -> weapon mapping backend/seeds/data/dungeonBosses.js already
// uses for fire/arcane (flame staff / archmage staff); extended to the two
// elements no dungeon boss happens to carry (ice, lightning), both already
// real rows in migration 1714440019000_weapon_catalog.js.
const UPGRADE_ITEM_BY_ELEMENT = {
  fire: 'flame staff', ice: 'frost staff', lightning: 'storm staff', arcane: 'archmage staff',
};
const upgradeItemFor = (element) => UPGRADE_ITEM_BY_ELEMENT[element] || 'two-handed sword';

const BASE = {
  hpMult: 10, defMult: 4, baseDamage: 18, size: 56, xpReward: 80, goldMin: 6, goldMax: 18,
  behaviorName: 'Heavy', upgradeChance: 0.25,
};
const ELITE = {
  hpMult: 18, defMult: 7, baseDamage: 40, size: 72, xpReward: 200, goldMin: 14, goldMax: 42,
  behaviorName: 'Champion', upgradeChance: 0.5,
};

function colorFor(biomeName, biomes) {
  const biome = biomes.find((b) => b.name === biomeName);
  return (biome && biome.color) || '#7a2e2e';
}

function buildOne(line, variant, biomes) {
  const stats = variant === 'elite' ? ELITE : BASE;
  const suffix = variant === 'elite' ? 'Elite Miniboss' : 'Miniboss';
  return {
    name: `${line.name} ${suffix}`,
    boss_tier: 'miniboss',
    // element (the boss's elemental identity, nullable) vs. attack_element
    // (entity_types' pre-existing NOT NULL column every creature has) --
    // several lines (Beast, Woodland) carry no element at all, so the two
    // must not collapse to the same value the way dungeon bosses' always-set
    // element lets them.
    element: line.element,
    attack_element: line.element || 'physical',
    color: colorFor(line.biome, biomes),
    hp: LINE_RUNG.hp * stats.hpMult,
    defense: LINE_RUNG.defense * stats.defMult,
    base_damage: stats.baseDamage,
    size: stats.size,
    xp_reward: stats.xpReward,
    gold_min: stats.goldMin,
    gold_max: stats.goldMax,
    behavior_name: stats.behaviorName,
    auras: [],
    resistances: {},
    prompt: `pixel art boss creature, a ${variant === 'elite' ? 'fearsome elite' : 'powerful'} ${line.name.toLowerCase()}-themed miniboss, single object, solid transparent background`,
    biome: line.biome,
    drops: [
      { item: dropItemFor(stats.behaviorName), chance: 1, min_qty: 1, max_qty: 1 },
      { item: upgradeItemFor(line.element), chance: stats.upgradeChance, min_qty: 1, max_qty: 1 },
    ],
  };
}

// biomes: STARTER_BIOMES (or an equivalent list), only used to pull each
// line's biome color as a render fallback before S8's content run gives it
// real art.
function buildMinibosses(biomes) {
  const rows = [];
  for (const line of LINES) {
    rows.push(buildOne(line, 'base', biomes));
    if (line.tier.includes(TIER_IV)) rows.push(buildOne(line, 'elite', biomes));
  }
  return rows;
}

// biome name -> [miniboss names to add to that biome's creature_types], so
// the seeder can wire minibosses into the ordinary population/spawn path
// without hand-editing biomes.js.
function minibossSpawnsByBiome(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.biome)) map.set(r.biome, []);
    map.get(r.biome).push(r.name);
  }
  return map;
}

module.exports = { buildMinibosses, minibossSpawnsByBiome };
