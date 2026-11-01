exports.shorthands = undefined;

// The village blacksmith: a new kind of world point (a village post) that stands inside the
// village's cottage and opens the weapon-enchanting menu.
//
//  * `blacksmith` joins world_point_kinds, so an admin can bind art to it like every other
//    post (until then it draws the placeholder shape).
//  * villages.blacksmith_entity_type_id is that per-village art binding, NULL = the kind's
//    default -- the same shape as the other four posts' columns (1714440548000).
//
// The post's POSITION is not stored: like the bank, the skill merchant and the quest giver
// it is derived from the village box (mapService.villageBlacksmithPost), so every village
// that already exists has a smith without a backfill.

const REF = { type: 'integer', notNull: false, references: 'entity_types', onDelete: 'SET NULL' };

exports.up = (pgm) => {
  pgm.sql(`INSERT INTO world_point_kinds (kind) VALUES ('blacksmith') ON CONFLICT (kind) DO NOTHING`);
  pgm.addColumns('villages', { blacksmith_entity_type_id: REF });
};

exports.down = (pgm) => {
  pgm.dropColumns('villages', ['blacksmith_entity_type_id']);
  // entity_types.point_kind is ON DELETE SET NULL, so any art bound to the kind survives as
  // an unbound entity type rather than blocking the rollback.
  pgm.sql(`DELETE FROM world_point_kinds WHERE kind = 'blacksmith'`);
};
