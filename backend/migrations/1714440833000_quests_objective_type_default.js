// backend/migrations/1714440833000_quests_objective_type_default.js
//
// 1714440829000 dropped quests.objective_type's DEFAULT so a forgotten value
// would fail loudly. That also broke a legitimate path: seeds/sync/quests.json
// predates the column, so importing it into a fresh database inserts quest rows
// with no objective_type and violated NOT NULL.
//
// 'kill_any' is the fail-SAFE default: such a quest needs real kills to finish
// (it can never complete itself, unlike the original 'manual' default that made
// every old row auto-complete). `node scripts/seed-quests.js` then writes the
// authored type, and a Seed Export refreshes quests.json.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql("ALTER TABLE quests ALTER COLUMN objective_type SET DEFAULT 'kill_any'");
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE quests ALTER COLUMN objective_type DROP DEFAULT');
};
