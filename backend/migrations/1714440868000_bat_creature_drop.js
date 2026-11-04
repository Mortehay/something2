// backend/migrations/1714440868000_bat_creature_drop.js
//
// Bat's only drop rule was the `stone` ammo. 1714440846000_remove_ammo_and_still_props
// deleted that item and the rule cascaded away with it, so a killed Bat has
// yielded nothing since. Same chance the old rule had; a knife because it is what
// the lowest chest band already hands out at a Bat's level.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO creature_drops (entity_type_id, item_type_id, chance, min_qty, max_qty, sync_uuid)
    SELECT e.id, i.id, 0.35, 1, 1, '033e4bb6-d3db-c33f-d2a6-16eac5b04b70'::uuid
      FROM entity_types e CROSS JOIN item_types i
     WHERE e.name = 'Bat' AND i.name = 'knife'
    ON CONFLICT (entity_type_id, item_type_id) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM creature_drops WHERE sync_uuid = '033e4bb6-d3db-c33f-d2a6-16eac5b04b70'::uuid`);
};
