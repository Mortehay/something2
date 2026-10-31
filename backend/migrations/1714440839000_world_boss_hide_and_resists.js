// backend/migrations/1714440839000_world_boss_hide_and_resists.js
//
// 1714440836000 gave the world bosses defense in the thousands and arcane
// resistance. Both break authority_elements_invariants.test.js: arcane is never
// resisted, and a resistance must visibly move a catalog-level hit, which a flat
// defense that large makes impossible. Toughness now comes from HP, elemental
// resistance and the in-engine hide (bossBalance.DAMAGE_TAKEN), so the rows go
// back to a low defense and invariant-safe resistances. HP stays as halved by
// 1714440837000. boss_balance.test.js checks the seed data against the same table.
exports.shorthands = undefined;

const BOSSES = [
  ['Ignis, the Magma Colossus', 10,
    { physical: 0.3, lightning: 0.3, fire: 0.6, ice: 0, arcane: 0 }],
  ['Glacius, the Frost Leviathan', 10,
    { physical: 0.3, lightning: 0.3, ice: 0.6, fire: 0, arcane: 0 }],
  ['Gorgon, the Thunder Titan', 10,
    { physical: 0.3, fire: 0.3, ice: 0.3, lightning: 0.6, arcane: 0 }],
  ['Abyssor, the Voidreaver', 10,
    { physical: 0.3, fire: 0.3, ice: 0.3, lightning: 0, arcane: 0 }],
];

exports.up = (pgm) => {
  for (const [name, defense, resistances] of BOSSES) {
    pgm.sql(`UPDATE entity_types
                SET defense = ${defense}, resistances = '${JSON.stringify(resistances)}'::jsonb, updated_at = NOW()
              WHERE name = '${name.replace(/'/g, "''")}' AND boss_tier = 'world'`);
  }
};

exports.down = () => {
  // The previous values broke an invariant test; there is nothing worth restoring.
};
