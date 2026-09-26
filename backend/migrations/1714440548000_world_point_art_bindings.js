exports.shorthands = undefined;

// Per-instance art binding (spec D1). NULL = "use the kind default". SET NULL
// on delete so removing an art type degrades a portal to the default rather
// than deleting the portal.
const REF = { type: 'integer', notNull: false, references: 'entity_types', onDelete: 'SET NULL' };

exports.up = (pgm) => {
  pgm.addColumn('map_links', { entity_type_id: REF });
  pgm.addColumn('waypoints', { entity_type_id: REF });
  pgm.addColumn('world_chests', { entity_type_id: REF });
  pgm.addColumns('villages', {
    merchant_entity_type_id: REF,
    bank_entity_type_id: REF,
    gem_merchant_entity_type_id: REF,
    skill_merchant_entity_type_id: REF,
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('villages', [
    'merchant_entity_type_id', 'bank_entity_type_id',
    'gem_merchant_entity_type_id', 'skill_merchant_entity_type_id',
  ]);
  pgm.dropColumn('world_chests', 'entity_type_id');
  pgm.dropColumn('waypoints', 'entity_type_id');
  pgm.dropColumn('map_links', 'entity_type_id');
};
