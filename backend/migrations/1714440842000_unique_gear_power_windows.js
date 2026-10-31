// backend/migrations/1714440842000_unique_gear_power_windows.js
//
// Three more pieces of unique gear built like power-tinders (1714440841000): each
// is strong for the levels around its requirement, ordinary about thirty levels
// later, and weak at the top, because the boots/greaves/plate ladder simply
// outgrows a flat number. Nothing scales with the player; tests/unique_gear.test.js
// pins each item's window against the live ladder.
//
//   warbound-circlet   head    req 25   defense 6.0   from quest_zahir_astrolabe
//   gilded-fists       hands   req 40   defense 5.5   from act3_void_rift
//   stormlight-mantle  chest   req 50   defense 17.0  from act4_primordial_cleansing
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO item_types (name, damage, cooldown, category, slot, defense, value,
                            req_level, item_level, tier, sync_uuid)
    VALUES
    ('warbound-circlet', 0, 0, 'armor', 'head', 6, 220, 25, 25, 3, '5717774b-88aa-5f4c-84be-03e4b404b562'),
    ('gilded-fists', 0, 0, 'armor', 'hands', 5.5, 360, 40, 40, 4, '24a2ab28-2fdc-5783-a45d-b9507b8eac23'),
    ('stormlight-mantle', 0, 0, 'armor', 'chest', 17, 700, 50, 50, 4, '765b105d-1d06-5a7d-8673-858fd7da0716')
    ON CONFLICT (name) DO NOTHING
  `);
  pgm.sql("UPDATE quests SET item_reward = 'warbound-circlet' WHERE key = 'quest_zahir_astrolabe'");
  pgm.sql("UPDATE quests SET item_reward = 'gilded-fists' WHERE key = 'act3_void_rift'");
  pgm.sql("UPDATE quests SET item_reward = 'stormlight-mantle' WHERE key = 'act4_primordial_cleansing'");
};

exports.down = (pgm) => {
  pgm.sql("UPDATE quests SET item_reward = NULL WHERE item_reward IN ('warbound-circlet', 'gilded-fists', 'stormlight-mantle')");
  pgm.sql("DELETE FROM item_types WHERE name IN ('warbound-circlet', 'gilded-fists', 'stormlight-mantle')");
};
