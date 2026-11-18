/* eslint-disable camelcase */
// SOMET-774: ruin points of interest. A ruin's chest is guarded by a PACK, so
// the chest remembers how many guards to bring back on respawn, and which ruin
// it belongs to (structure_key "<minRow>,<minCol>") so it can be reconciled
// with the world's stored ruins: one chest per POI ruin, removed with it.
// Every pre-existing chest (vault, loot map, boss) keeps guard_count 1 and a
// NULL structure_key, i.e. today's behaviour.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('world_chests', {
    guard_count: { type: 'integer', notNull: true, default: 1 },
    structure_key: { type: 'text' },
  });
  pgm.addConstraint('world_chests', 'world_chests_guard_count_check', { check: 'guard_count >= 1' });
  pgm.createIndex('world_chests', ['world_id', 'structure_key'], {
    name: 'world_chests_ruin_unique', unique: true, where: 'structure_key IS NOT NULL',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('world_chests', ['world_id', 'structure_key'], { name: 'world_chests_ruin_unique' });
  pgm.dropConstraint('world_chests', 'world_chests_guard_count_check');
  pgm.dropColumns('world_chests', ['guard_count', 'structure_key']);
};
