// backend/migrations/1714440836000_world_boss_rebalance.js
//
// World bosses become endurance fights: top-end gear needs at least five
// minutes to kill one (the model and its test live in services/bossBalance.js).
// HP, flat defense, elemental resistance and base damage are raised; every boss
// keeps one weak element at 0 resistance.
//
// The numbers are written out here on purpose (a migration is a record of what
// was applied then); boss_balance.test.js checks they still match
// bossBalance.WORLD_BOSSES, so the two cannot drift apart silently.
exports.shorthands = undefined;

const BOSSES = [
  ['Ignis, the Magma Colossus', 880000, 1500, 420,
    { physical: 0.3, arcane: 0.3, lightning: 0.3, fire: 0.6, ice: 0 }],
  ['Glacius, the Frost Leviathan', 780000, 1800, 350,
    { physical: 0.3, arcane: 0.3, lightning: 0.3, ice: 0.6, fire: 0 }],
  ['Gorgon, the Thunder Titan', 900000, 1400, 450,
    { physical: 0.3, fire: 0.3, ice: 0.3, lightning: 0.6, arcane: 0 }],
  ['Abyssor, the Voidreaver', 1000000, 1500, 520,
    { physical: 0.3, fire: 0.3, ice: 0.3, arcane: 0.6, lightning: 0 }],
];

exports.up = (pgm) => {
  for (const [name, hp, defense, baseDamage, resistances] of BOSSES) {
    pgm.sql(`
      UPDATE entity_types
         SET hp = ${hp}, max_hp = ${hp}, defense = ${defense}, base_damage = ${baseDamage},
             resistances = '${JSON.stringify(resistances)}'::jsonb,
             updated_at = NOW()
       WHERE name = '${name.replace(/'/g, "''")}' AND boss_tier = 'world'
    `);
  }
};

exports.down = (pgm) => {
  const OLD = [
    ['Ignis, the Magma Colossus', 12000, 25, 42],
    ['Glacius, the Frost Leviathan', 14000, 32, 35],
    ['Gorgon, the Thunder Titan', 13000, 24, 45],
    ['Abyssor, the Voidreaver', 10000, 18, 55],
  ];
  for (const [name, hp, defense, baseDamage] of OLD) {
    pgm.sql(`
      UPDATE entity_types
         SET hp = ${hp}, max_hp = ${hp}, defense = ${defense}, base_damage = ${baseDamage},
             resistances = '{}'::jsonb, updated_at = NOW()
       WHERE name = '${name.replace(/'/g, "''")}' AND boss_tier = 'world'
    `);
  }
};
