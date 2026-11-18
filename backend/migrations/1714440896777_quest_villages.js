/* eslint-disable camelcase */

// The quest catalogue now names the villages the world really has. It used to name five that no map
// builds (sunspire, emberfall, sylvan_haven, abyssal_tideport, ashen_oasis), so the quest marker, the
// route tracker and the minimap pointed at nothing. Standing is saved per village_key, so what a
// character earned under an old name moves to the new one (summed where two old names meet).
//
// The quests themselves are re-keyed by `make seed-quests` (seeds/data/questsData.js).

const RENAMES = [
  ['sunspire', 'vale-crossing'],
  ['emberfall', 'sunscar'],
  ['ashen_oasis', 'sunscar'],
  ['sylvan_haven', 'thornbriar'],
  ['abyssal_tideport', 'blackfen'],
];

exports.up = async (pgm) => {
  for (const [from, to] of RENAMES) {
    pgm.sql(`
      INSERT INTO character_reputation (character_id, village_key, points)
      SELECT character_id, '${to}', points FROM character_reputation WHERE village_key = '${from}'
      ON CONFLICT (character_id, village_key)
        DO UPDATE SET points = character_reputation.points + EXCLUDED.points;
      DELETE FROM character_reputation WHERE village_key = '${from}';
    `);
  }
};

// The merge cannot be undone (two names became one); down() restores the names for the ordinary case
// of one old name per new one.
exports.down = async (pgm) => {
  for (const [from, to] of [['sunspire', 'vale-crossing'], ['emberfall', 'sunscar'], ['sylvan_haven', 'thornbriar'], ['abyssal_tideport', 'blackfen']]) {
    pgm.sql(`UPDATE character_reputation SET village_key = '${from}' WHERE village_key = '${to}';`);
  }
};
