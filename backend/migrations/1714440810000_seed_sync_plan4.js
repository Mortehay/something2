// backend/migrations/1714440810000_seed_sync_plan4.js
//
// SOMET-641 (Seed/Export plan 4a, maps through spec files).
//  - map_spec_state: per-PC bookkeeping for .map.json spec files (what was last
//    applied / exported / pushed to the box). Machine-local, never synced.
//  - world_point_kinds.sync_uuid: travelling identity, same shape as plan 2/3:
//    nullable add -> deterministic backfill md5('s2sync:world_point_kinds:'||kind)
//    -> NOT NULL + random default for new rows -> unique.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('map_spec_state', {
    spec_name: { type: 'text', primaryKey: true },
    applied_sha256: { type: 'text' },
    applied_at: { type: 'timestamptz' },
    exported_sha256: { type: 'text' },
    exported_at: { type: 'timestamptz' },
    box_pushed_sha256: { type: 'text' },
    box_error: { type: 'text' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addColumns('world_point_kinds', { sync_uuid: { type: 'uuid' } });
  pgm.sql(`UPDATE world_point_kinds SET sync_uuid = md5('s2sync:world_point_kinds:' || kind)::uuid`);
  pgm.alterColumn('world_point_kinds', 'sync_uuid', { notNull: true, default: pgm.func('gen_random_uuid()') });
  pgm.addConstraint('world_point_kinds', 'world_point_kinds_sync_uuid_key', { unique: ['sync_uuid'] });
};

exports.down = (pgm) => {
  pgm.dropConstraint('world_point_kinds', 'world_point_kinds_sync_uuid_key');
  pgm.dropColumns('world_point_kinds', ['sync_uuid']);
  pgm.dropTable('map_spec_state');
};
