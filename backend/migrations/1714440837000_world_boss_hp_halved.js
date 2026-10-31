// backend/migrations/1714440837000_world_boss_hp_halved.js
//
// 1714440836000 made the world bosses very large; this halves their HP (the
// rest of that rebalance - defense, resistances, damage, shields - stands).
// services/bossBalance.js carries the same numbers and boss_balance.test.js
// checks the seed data against them.
exports.shorthands = undefined;

const HP = [
  ['Ignis, the Magma Colossus', 440000, 880000],
  ['Glacius, the Frost Leviathan', 390000, 780000],
  ['Gorgon, the Thunder Titan', 450000, 900000],
  ['Abyssor, the Voidreaver', 500000, 1000000],
];

exports.up = (pgm) => {
  for (const [name, hp] of HP) {
    pgm.sql(`UPDATE entity_types SET hp = ${hp}, max_hp = ${hp}, updated_at = NOW()
              WHERE name = '${name.replace(/'/g, "''")}' AND boss_tier = 'world'`);
  }
};

exports.down = (pgm) => {
  for (const [name, , old] of HP) {
    pgm.sql(`UPDATE entity_types SET hp = ${old}, max_hp = ${old}, updated_at = NOW()
              WHERE name = '${name.replace(/'/g, "''")}' AND boss_tier = 'world'`);
  }
};
