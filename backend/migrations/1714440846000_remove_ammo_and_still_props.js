/* eslint-disable camelcase */

exports.shorthands = undefined;

// Two gameplay trims:
//  1. Ammunition is gone. Weapons that used it (bow, arbalest, sling) now
//     shoot without it. Every FK onto item_types cascades except
//     item_types.ammo_type_id (RESTRICT), so detach the weapons first, then
//     the ammo rows (and any held stacks, drops, chest loot, stock) go.
//  2. Only trees move. Chests, portals, posts and bushes lose their idle
//     effect; any prop whose name contains "tree" keeps its own.
exports.up = (pgm) => {
  pgm.sql(`UPDATE item_types SET ammo_type_id = NULL WHERE ammo_type_id IS NOT NULL`);
  pgm.sql(`DELETE FROM item_types WHERE category = 'ammo'`);
  pgm.sql(`UPDATE entity_types SET idle_fx = 'none'
            WHERE idle_fx <> 'none' AND name !~* 'tree'`);
};

// Deleted ammo cannot be restored.
exports.down = () => {};
