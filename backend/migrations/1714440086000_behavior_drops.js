exports.shorthands = undefined;

// P2b Task 7: per-rung loot. `behavior_drops` mirrors `creature_drops`
// (1714440018000_create_loot.js) column-for-column and constraint-for-
// constraint, with the FK swapped from entity_type_id to behavior_id --
// this table is a fallback pool ANY creature of a given rung rolls against,
// on top of (never instead of) whatever the creature's own type-level
// creature_drops rows grant. See loot.js's spawnDrops for the read side:
// the two tables are queried separately and rolled independently, so a
// creature with rows in only one of the two still gets that one, and a
// creature with rows in both gets BOTH.
//
// This is what lets P4 ship up to 288 creatures with zero per-creature drop
// authoring: give every creature a behavior_id (already required for combat
// stats) and it inherits its rung's baseline loot for free. creature_drops
// stays the place to author a creature-specific rule that stands out from
// its rung (see 1714440024000_elements_creature_drops.js's per-creature
// flavor).
exports.up = (pgm) => {
  pgm.createTable('behavior_drops', {
    id: 'id',
    behavior_id: { type: 'integer', notNull: true, references: 'creature_behaviors', onDelete: 'CASCADE' },
    item_type_id: { type: 'integer', notNull: true, references: 'item_types', onDelete: 'CASCADE' },
    chance: { type: 'numeric', notNull: true },
    min_qty: { type: 'integer', notNull: true, default: 1 },
    max_qty: { type: 'integer', notNull: true, default: 1 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('behavior_drops', 'behavior_drops_chance_check', 'CHECK (chance > 0 AND chance <= 1)');
  pgm.addConstraint('behavior_drops', 'behavior_drops_qty_check', 'CHECK (min_qty >= 1 AND max_qty >= min_qty)');
  pgm.createIndex('behavior_drops', 'behavior_id');

  // Modest per-rung baseline, one row per rung, against item types that
  // exist today. Guarded the same way create_loot.js's Wolf row is: each
  // INSERT selects from creature_behaviors x item_types BY NAME, so a
  // renamed/missing rung or item inserts zero rows rather than failing the
  // migration. Guard gets none -- a village guard is not a purse, same call
  // as its gold_min/gold_max both staying 0 in 1714440085000_behavior_auras.
  //
  // Chances stay modest (this is a FALLBACK pool that fires for every
  // creature of the rung, not a per-creature rule) and quantities stay at 1,
  // matching every existing creature_drops row's posture.
  const DROPS = [
    { behavior: 'Swarm', item: 'stone', chance: 0.3 },
    { behavior: 'Skirmisher', item: 'dagger', chance: 0.25 },
    { behavior: 'Line', item: 'short sword', chance: 0.2 },
    { behavior: 'Ranged', item: 'bow', chance: 0.2 },
    { behavior: 'Caster', item: 'apprentice staff', chance: 0.15 },
    { behavior: 'Brute', item: 'club', chance: 0.2 },
    { behavior: 'Heavy', item: 'morning star', chance: 0.15 },
    { behavior: 'Champion', item: 'long sword', chance: 0.15 },
    { behavior: 'Apex', item: 'two-handed sword', chance: 0.1 },
    { behavior: 'Sentry', item: 'arrow', chance: 0.25 },
    { behavior: 'Lurker', item: 'knife', chance: 0.2 },
  ];
  for (const d of DROPS) {
    pgm.sql(`
      INSERT INTO behavior_drops (behavior_id, item_type_id, chance, min_qty, max_qty)
      SELECT b.id, it.id, ${d.chance}, 1, 1
      FROM creature_behaviors b, item_types it
      WHERE b.name = '${d.behavior}' AND it.name = '${d.item}'
    `);
  }
};

exports.down = (pgm) => {
  pgm.dropTable('behavior_drops');
};
