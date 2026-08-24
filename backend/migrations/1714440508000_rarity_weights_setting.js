/* eslint-disable camelcase */
exports.shorthands = undefined;

// SOMET-481 (progression epic, Group D / T13). The default rarity weight
// table, as a game_settings row so an admin can retune drop rates without a
// deploy.
//
// THIS SLOT IS A BACKSTOP, NOT THE PRIMARY SEED. When this task's plan was
// written, T1's migration (1714440500000_game_settings) did not yet exist on
// main; it does now, and it already seeds this exact key alongside the other
// three. Re-inserting it here unconditionally would be a second writer for one
// row -- so the statement below is INSERT ... ON CONFLICT DO NOTHING, which is
// a true no-op on every database T1 has touched, and only does real work on a
// database whose game_settings row for this key is somehow missing (a
// hand-deleted row, a partially applied migration set).
//
// The DO NOTHING is load-bearing for a second reason: gameSettings.setSetting
// writes an admin's edit to this same row. A migration that overwrote it would
// cost an admin their tuning on the next deploy -- the exact failure
// scripts/seed-catalogs.js's "UPSERT BY NAME, NEVER DELETE" header forbids.
const RARITY_WEIGHTS = [
  { item_level: 1, white: 90, blue: 9, yellow: 1, foxy: 0 },
  { item_level: 50, white: 70, blue: 21, yellow: 8, foxy: 1 },
  { item_level: 150, white: 45, blue: 30, yellow: 20, foxy: 5 },
];

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO game_settings (key, value)
    VALUES ('rarity_weights', '${JSON.stringify(RARITY_WEIGHTS)}'::jsonb)
    ON CONFLICT (key) DO NOTHING
  `);

  // Verify rather than assume. authority/rarity.js falls back to all-white for
  // a missing/broken table, which is a SILENT degradation: every drop in the
  // game would be white and nothing would fail. Assert here, where a failure
  // stops the deploy, instead of discovering it in play.
  pgm.sql(`
    DO $$
    DECLARE n integer;
    BEGIN
      SELECT count(*) INTO n
        FROM game_settings
       WHERE key = 'rarity_weights' AND jsonb_typeof(value) = 'array'
         AND jsonb_array_length(value) > 0;
      IF n <> 1 THEN
        RAISE EXCEPTION 'game_settings.rarity_weights is missing or is not a non-empty array';
      END IF;
    END $$;
  `);
};

// Deliberately a NO-OP. This migration inserts nothing on any database T1 has
// run against, so deleting the row on the way down would destroy a row THIS
// migration did not create -- and would leave a database that is "down one
// step" with the rarity feature silently disabled. 1714440500000's own down
// drops the whole game_settings table, which is where this row's teardown
// belongs.
exports.down = () => {};

// Exported so a test can assert the seeded table without a database.
exports.RARITY_WEIGHTS = RARITY_WEIGHTS;
