exports.shorthands = undefined;

// SOMET-486 -- the three playable classes' BASE POOLS, re-authored.
//
// Background. Since SOMET-242 the authority has set a joining player's pools
// from derivePlayerStats, which was class-blind: HP_BASE 100 / MANA_BASE 100
// for everybody, while character select advertised Warrior 100 / Ranger 85 /
// Mage 75. This migration is the data half of making the advertisement true;
// the code half is playerStats.js's new `classPools` argument, sourced from
// these two columns via characters.js's classPoolsFromRow.
//
// RE-AUTHORED, NOT ADOPTED. entity_types read Warrior 50 / Ranger 50 / Mage 70
// mana before this. Those numbers have never run: nothing in src/ has ever
// consulted them, and every live character has 100 mana. "Restoring" them
// would not be restoring anything -- it would activate dead code and HALVE
// every existing character's mana pool. They are therefore replaced outright.
//
// THE NUMBERS AND WHY.
//
//   Warrior  100 hp / 100 mana   (was 100 / 50)
//   Ranger    85 hp / 115 mana   (was  85 / 50)
//   Mage      75 hp / 150 mana   (was  75 / 70)
//
// * Warrior is FROZEN at 100/100 and is not a balance decision at all. Every
//   character that exists today is a Warrior (all 8 at the time of writing),
//   and 100/100 is exactly what they have. Moving it by one point would move
//   a live player's pools, which A2's guard forbids and which this migration
//   is written specifically to avoid. HP was already 100; only mana moves, and
//   it moves TO the value the game has actually been giving out.
//
// * HP keeps the advertised ladder 100 / 85 / 75 unchanged. Those three
//   numbers are what the character-select screen has been showing since
//   SOMET-258; a player who picked Ranger because it said 85 should not now
//   find the number was re-tuned as a side effect of making it real.
//
// * Mana is authored against a 100-mana Warrior, not against the dead 50.
//   Ranger 115 keeps Ranger's TOTAL pool budget identical to Warrior's (200):
//   it trades exactly the 15 HP it gives up for 15 mana, because Ranger's
//   identity is DEX and range, not casting -- it should not be paid twice for
//   being squishy.
//
//   Mage 150 is 1.5x Warrior's mana against 0.75x its HP, for a total of 225 --
//   deliberately 25 above the others' budget. A straight 1:1 trade would
//   under-pay it: mana is SPENT TO ACT, so a Mage burns its pool every fight
//   whether or not anything hits it, while HP is only lost on being hit. A
//   pool you must spend to function is worth less per point than a pool you
//   only lose under pressure. The premise a Mage must satisfy is that it has
//   MORE mana than a Warrior; 70 (the old dead value) had less, which is the
//   clearest evidence those numbers were never played.
//
// The four classes B1 adds are NOT here, and neither are start-node grants
// (contract 6.11 splits them: pools are this ticket, rules are B1's).
//
// `hp`/`mana` are written alongside `max_hp`/`max_mana` because these rows are
// TEMPLATES -- a template whose current pool disagrees with its max is a trap
// for the next reader even though nothing reads the current pool today.
const CLASS_POOLS = [
  { name: 'Warrior', hp: 100, mana: 100 },
  { name: 'Ranger', hp: 85, mana: 115 },
  { name: 'Mage', hp: 75, mana: 150 },
];

// The values these rows must hold BEFORE this migration runs, i.e. what
// 1714440091000 and seeds/data/entityTypes.js put there. Checked rather than
// assumed: if a database has already been hand-edited to different pools, the
// re-author below would silently overwrite somebody's deliberate change, and
// on the live database it would be the difference between "mana was always
// 100 in practice" and "mana really was 50 and I am about to double it".
const EXPECTED_BEFORE = [
  { name: 'Warrior', hp: 100, mana: 50 },
  { name: 'Ranger', hp: 85, mana: 50 },
  { name: 'Mage', hp: 75, mana: 70 },
];

function guard(rows, label) {
  const checks = rows
    .map((c) => `(name = '${c.name}' AND max_hp = ${c.hp} AND max_mana = ${c.mana})`)
    .join(' OR ');
  return `
    DO $$
    DECLARE n integer;
    BEGIN
      SELECT count(*) INTO n FROM entity_types WHERE ${checks};
      IF n <> ${rows.length} THEN
        RAISE EXCEPTION '${label}: expected ${rows.length} class rows to match, found %', n;
      END IF;
    END $$;
  `;
}

exports.up = (pgm) => {
  pgm.sql(guard(EXPECTED_BEFORE, 'SOMET-486 up precondition'));
  for (const c of CLASS_POOLS) {
    pgm.sql(`
      UPDATE entity_types
         SET hp = ${c.hp}, max_hp = ${c.hp}, mana = ${c.mana}, max_mana = ${c.mana}
       WHERE name = '${c.name}'
    `);
  }
  pgm.sql(guard(CLASS_POOLS, 'SOMET-486 up postcondition'));
};

// Reverses to the pre-486 numbers exactly, including the dead mana values --
// a down migration restores the previous STATE, it does not get to keep the
// half of this change it likes.
exports.down = (pgm) => {
  for (const c of EXPECTED_BEFORE) {
    pgm.sql(`
      UPDATE entity_types
         SET hp = ${c.hp}, max_hp = ${c.hp}, mana = ${c.mana}, max_mana = ${c.mana}
       WHERE name = '${c.name}'
    `);
  }
};

exports.CLASS_POOLS = CLASS_POOLS;
