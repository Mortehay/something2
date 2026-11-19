// backend/migrations/1714440899800_dungeon_boss_level_curve.js
//
// SOMET-630. Dungeon Elite and End bosses move onto the boss level curve
// (src/services/bossLevelCurve.js): their hp / defense / base_damage become LEVEL-1
// values that scaleBoss grows to the boss's post level. ignis_inferno's DoT goes from
// 6/s to 90/s.
//
// The numbers are written out here on purpose (a migration is a record of what was
// applied then); boss_level_curve.test.js checks they still equal
// bossLevelCurve.referenceBase and seeds/data, so the two cannot drift apart silently.
//
// GUARDED: a row is only touched while it still holds the values it shipped with. A row
// an admin has retuned in the Entities / Auras tab is theirs, and is left alone.
exports.shorthands = undefined;

const END = { hp: 1141, defense: 2.36, base_damage: 19.51 };
const ELITE = { hp: 637, defense: 2.36, base_damage: 20.04 };

// [name, tier values, shipped hp, shipped defense, shipped base_damage]
const BOSSES = [
  ['The Bone Regent', END, 2000, 16, 24],
  ['Ossuary Warden', ELITE, 850, 15, 14],
  ['The Ember Queen', END, 5000, 25, 52],
  ['Cinder Matriarch', ELITE, 2200, 23, 31],
  ['The Umbral Gatekeeper', END, 8700, 37, 88],
  ['Shade Herald', ELITE, 4100, 36, 56],
];

const q = (s) => `'${s.replace(/'/g, "''")}'`;

exports.up = (pgm) => {
  for (const [name, v, hp, defense, damage] of BOSSES) {
    pgm.sql(`
      UPDATE entity_types
         SET hp = ${v.hp}, max_hp = ${v.hp}, defense = ${v.defense}, base_damage = ${v.base_damage},
             updated_at = NOW()
       WHERE name = ${q(name)} AND boss_tier IN ('dungeon_end', 'dungeon_elite')
         AND hp = ${hp} AND max_hp = ${hp} AND defense = ${defense} AND base_damage = ${damage}
    `);
  }
  pgm.sql(`UPDATE aura_effects SET dot_dps = 90 WHERE name = 'ignis_inferno' AND dot_dps = 6`);
};

exports.down = (pgm) => {
  for (const [name, v, hp, defense, damage] of BOSSES) {
    pgm.sql(`
      UPDATE entity_types
         SET hp = ${hp}, max_hp = ${hp}, defense = ${defense}, base_damage = ${damage}, updated_at = NOW()
       WHERE name = ${q(name)} AND boss_tier IN ('dungeon_end', 'dungeon_elite')
         AND hp = ${v.hp} AND max_hp = ${v.hp}
         AND abs(defense - ${v.defense}) < 0.001 AND abs(base_damage - ${v.base_damage}) < 0.001
    `);
  }
  pgm.sql(`UPDATE aura_effects SET dot_dps = 6 WHERE name = 'ignis_inferno' AND dot_dps = 90`);
};

// Exported for boss_level_curve.test.js.
exports.BOSSES = BOSSES;
exports.TIER_VALUES = { dungeon_end: END, dungeon_elite: ELITE };
