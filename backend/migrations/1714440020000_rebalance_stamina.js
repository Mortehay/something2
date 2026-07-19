// The original stamina costs (from 1714440016000/1714440019000) were all
// smaller than PLAYER_STAMINA_REGEN(12) * cooldown, so the stamina gate could
// never fire through legal play — every swing regenerated more than it spent.
// PLAYER_STAMINA_REGEN drops to 10/s alongside this migration (see
// backend/src/authority/world.js); these new costs push every affected
// weapon's stamina_cost above regen(10) * cooldown so the pool actually
// throttles sustained heavy-weapon spam.
//
// knife, stick, dagger and all staves are untouched — they are intentionally
// free (staves cost mana instead).
exports.up = (pgm) => {
  pgm.sql(`UPDATE item_types SET stamina_cost = 6 WHERE name = 'club'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 6 WHERE name = 'short sword'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 9 WHERE name = 'mid club'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 9 WHERE name = 'long sword'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 12 WHERE name = 'morning star'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 18 WHERE name = 'two-handed sword'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 16 WHERE name = 'scythe'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 14 WHERE name = 'pike'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 15 WHERE name = 'halberd'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 4 WHERE name = 'darts'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 6 WHERE name = 'sling'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 8 WHERE name = 'bow'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 15 WHERE name = 'arbalest'`);
};

exports.down = (pgm) => {
  pgm.sql(`UPDATE item_types SET stamina_cost = 2 WHERE name = 'club'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 2 WHERE name = 'short sword'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 4 WHERE name = 'mid club'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 4 WHERE name = 'long sword'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 6 WHERE name = 'morning star'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 9 WHERE name = 'two-handed sword'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 8 WHERE name = 'scythe'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 7 WHERE name = 'pike'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 8 WHERE name = 'halberd'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 1 WHERE name = 'darts'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 1 WHERE name = 'sling'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 3 WHERE name = 'bow'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 5 WHERE name = 'arbalest'`);
};
