// backend/migrations/1714440780000_seed_sync.js
//
// SOMET-632 (Seed/Export admin tab, plan 1). Three things:
//   * seed_export_runs  -- history of export/seed/git actions per group.
//   * seed_row_hashes   -- per-row baseline hashes, so a seed can tell "changed
//     locally" from "changed in git".
//   * sync_uuid on quests, tile_types, ai_providers -- the tables whose serial
//     id differs between PCs. It is the identity that travels in exported
//     files. Existing rows are backfilled with md5('s2sync:<table>:<key>')::uuid
//     (key = quests.key, else name) so two PCs holding the same row agree
//     without talking; the backend's deterministicUuid mirrors this formula.
//     New rows get gen_random_uuid().
//
// Timestamp note: re-check `ls backend/migrations | sort | tail` before merging
// (see 1714440760000_boss_loot_columns.js for why a stale number breaks
// node-pg-migrate's checkOrder).
exports.shorthands = undefined;

const TABLES = [
  ['quests', 'key'],
  ['tile_types', 'name'],
  ['ai_providers', 'name'],
];

exports.up = (pgm) => {
  for (const [table, keyCol] of TABLES) {
    pgm.addColumns(table, { sync_uuid: { type: 'uuid' } });
    pgm.sql(`UPDATE ${table} SET sync_uuid = md5('s2sync:' || '${table}' || ':' || ${keyCol})::uuid`);
    pgm.alterColumn(table, 'sync_uuid', { notNull: true, default: pgm.func('gen_random_uuid()') });
    pgm.addConstraint(table, `${table}_sync_uuid_key`, { unique: ['sync_uuid'] });
  }

  pgm.createTable('seed_export_runs', {
    id: 'id',
    group_id: { type: 'text', notNull: true },
    action: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true },
    started_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    finished_at: { type: 'timestamptz' },
    pc_label: { type: 'text', notNull: true },
    git_commit: { type: 'text' },
    summary: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    error: { type: 'text' },
  });
  pgm.addConstraint('seed_export_runs', 'seed_export_runs_action_check', {
    check: "action IN ('export','seed','git_pull','git_commit','git_push')",
  });
  pgm.addConstraint('seed_export_runs', 'seed_export_runs_status_check', {
    check: "status IN ('running','ok','failed','cancelled')",
  });
  pgm.sql('CREATE INDEX seed_export_runs_group_action_started_idx ON seed_export_runs (group_id, action, started_at DESC)');

  pgm.createTable('seed_row_hashes', {
    group_id: { type: 'text', notNull: true },
    sync_uuid: { type: 'uuid', notNull: true },
    hash: { type: 'text', notNull: true },
    updated_at: { type: 'timestamptz', default: pgm.func('now()') },
  });
  pgm.addConstraint('seed_row_hashes', 'seed_row_hashes_pkey', { primaryKey: ['group_id', 'sync_uuid'] });
};

exports.down = (pgm) => {
  pgm.dropTable('seed_row_hashes');
  pgm.dropTable('seed_export_runs');
  for (const [table] of [...TABLES].reverse()) {
    pgm.dropConstraint(table, `${table}_sync_uuid_key`);
    pgm.dropColumns(table, ['sync_uuid']);
  }
};
