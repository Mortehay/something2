exports.shorthands = undefined;

// An integer FK, deliberately NOT a name reference.
//
// biomes.creature_types and biomes.flora_types reference entity_types by NAME
// with no FK, which is exactly why index.js has to guard entity-type renames
// with a 409. P4 will author 288 creatures against these profiles; a profile
// rename must not be able to orphan all of them. The default ON DELETE
// (RESTRICT) is also wanted: a profile still in use cannot be deleted out from
// under its creatures.
//
// behavior_id is NULLABLE and the backfill below is deliberately narrow. A
// creature type with no profile resolves to the Line fallback in
// services/creatureBehaviors.js, so a hand-authored creature keeps working.
exports.up = (pgm) => {
  pgm.addColumns('entity_types', {
    behavior_id: {
      type: 'integer',
      notNull: false,
      references: 'creature_behaviors',
    },
    attack_element: { type: 'text', notNull: true, default: 'physical' },
  });

  pgm.addConstraint('entity_types', 'entity_types_attack_element_check',
    "CHECK (attack_element IN ('physical','fire','ice','lightning'))");

  pgm.createIndex('entity_types', 'behavior_id');

  // Guard-faction creatures take Guard; every other creature takes Line. Both
  // profiles reproduce today's constants, so this backfill changes nothing.
  pgm.sql(`
    UPDATE entity_types SET behavior_id = (SELECT id FROM creature_behaviors WHERE name = 'Guard')
    WHERE is_creature = true AND faction = 'guard'
  `);
  pgm.sql(`
    UPDATE entity_types SET behavior_id = (SELECT id FROM creature_behaviors WHERE name = 'Line')
    WHERE is_creature = true AND faction <> 'guard'
  `);
};

exports.down = (pgm) => {
  pgm.dropIndex('entity_types', 'behavior_id');
  pgm.dropConstraint('entity_types', 'entity_types_attack_element_check');
  pgm.dropColumns('entity_types', ['behavior_id', 'attack_element']);
};
