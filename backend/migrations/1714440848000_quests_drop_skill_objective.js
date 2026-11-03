/* eslint-disable camelcase */
// The 'skill' objective type is gone. The four quests that used it are
// retargeted to other objective kinds (matching seeds/data/questsData.js);
// progress made on the old objective is reset, since it counted something else.
exports.shorthands = undefined;

const RETARGET = [
  ['daily_spellwork', 'Daily: Field Drills', 'Keep your edge. Defeat 30 creatures of any kind.', 'Defeat 30 creatures', 'kill_any', null, 30],
  ['class_mage_practice', "Mage's Practice", 'Magic is a muscle. Test your spells on 25 slimes.', 'Slay 25 Slimes', 'kill', 'Slime', 25],
  ['class_cultist_rite', "Cultist's Rite", 'The rite demands offerings from forgotten caches. Open four chests.', 'Open 4 chests', 'chest', null, 4],
  ['class_monk_discipline', "Monk's Discipline", 'A monk wastes nothing. Gather 15 items from the ground.', 'Pick up 15 items', 'collect', '*', 15],
];
const lit = (v) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

exports.up = (pgm) => {
  for (const [key, title, description, objective, type, targetKey, count] of RETARGET) {
    pgm.sql(`UPDATE character_quests SET progress_count = 0
              WHERE status = 'active' AND quest_id IN (SELECT id FROM quests WHERE key = ${lit(key)} AND objective_type = 'skill')`);
    pgm.sql(`UPDATE quests SET title = ${lit(title)}, description = ${lit(description)}, objective = ${lit(objective)},
                    objective_type = ${lit(type)}, target_key = ${lit(targetKey)}, target_count = ${count}
              WHERE key = ${lit(key)} AND objective_type = 'skill'`);
  }
};

exports.down = () => {};
