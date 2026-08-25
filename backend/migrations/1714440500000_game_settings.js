exports.shorthands = undefined;

// Admin-tunable game constants, one jsonb row per key (design doc section 3.1).
//
// The four rows are seeded here so an admin opening the editor sees real
// values rather than an empty table. gameSettings.DEFAULTS still supplies the
// fallback in code, because a row can be deleted and a fresh key can be added
// by a later migration that this one knows nothing about.
//
// NOTE FOR THE EPIC: the timestamp block reserved in the shared contract
// (1714440400000-1714440430000) was already occupied on main by
// biome_path_tile / invite_codes / inventory_slots. The whole block is shifted
// +100000; this file takes the shifted T1 slot.
exports.up = (pgm) => {
  pgm.createTable('game_settings', {
    key: { type: 'text', primaryKey: true },
    value: { type: 'jsonb', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.sql(`
    INSERT INTO game_settings (key, value) VALUES
      ('passive_points_per_level', '1'::jsonb),
      ('ground_item_ttl_seconds',  '180'::jsonb),
      ('respec_base_gold',         '50'::jsonb),
      ('rarity_weights', '[
         {"item_level": 1,   "white": 90, "blue": 9,  "yellow": 1,  "foxy": 0},
         {"item_level": 50,  "white": 70, "blue": 21, "yellow": 8,  "foxy": 1},
         {"item_level": 150, "white": 45, "blue": 30, "yellow": 20, "foxy": 5}
       ]'::jsonb)
    ON CONFLICT (key) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('game_settings');
};
