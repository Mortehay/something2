// backend/migrations/1714440790000_seed_sync_plan2.js
//
// SOMET-639 (Seed/Export plan 2, data groups). Gives the data-group tables a
// travelling sync_uuid, same shape as 1714440780000_seed_sync.js: nullable add
// -> deterministic backfill md5('s2sync:<table>:<key>')::uuid -> NOT NULL +
// default gen_random_uuid() -> unique. Composite keys use the REFERENCED rows'
// natural keys joined with '|' (never local ids, which differ between PCs).
//
// Also adds the unique composite keys the exporter relies on for
// creature_drops, behavior_drops and chest_loot. The migration never deletes:
// if duplicates exist it throws and lists them so the operator dedupes.
//
// Timestamp note: re-check `ls backend/migrations | sort | tail` before merging.
exports.shorthands = undefined;

// [table, SQL expression of the backfill key, FROM-joins for that expression]
// `t` is the target table alias.
const TABLES = [
  ['item_types', 't.name', ''],
  ['affix_types', 't.key', ''],
  ['vfx_effects', 't.name', ''],
  ['creature_skills', 't.name', ''],
  ['aura_effects', 't.name', ''],
  ['creature_behaviors', 't.name', ''],
  ['creature_abilities', "b.name || '|' || t.slot", 'JOIN creature_behaviors b ON b.id = t.behavior_id'],
  ['creature_behavior_skills', "b.name || '|' || t.slot", 'JOIN creature_behaviors b ON b.id = t.behavior_id'],
  ['behavior_drops', "b.name || '|' || i.name",
    'JOIN creature_behaviors b ON b.id = t.behavior_id JOIN item_types i ON i.id = t.item_type_id'],
  ['chest_loot', "t.level_min || '|' || t.level_max || '|' || i.name", 'JOIN item_types i ON i.id = t.item_type_id'],
  ['entity_types', 't.name', ''],
  ['creature_drops', "e.name || '|' || i.name",
    'JOIN entity_types e ON e.id = t.entity_type_id JOIN item_types i ON i.id = t.item_type_id'],
  ['class_loadouts', "e.name || '|' || i.name",
    'JOIN entity_types e ON e.id = t.entity_type_id JOIN item_types i ON i.id = t.item_type_id'],
  ['biomes', 't.name', ''],
  ['passive_nodes', 't.key', ''],
  ['passive_edges', "a.key || '|' || b.key",
    'JOIN passive_nodes a ON a.id = t.a_id JOIN passive_nodes b ON b.id = t.b_id'],
  ['game_settings', 't.key', ''],
];

// [table, constraint name, columns]
const UNIQUES = [
  ['creature_drops', 'creature_drops_entity_item_key', ['entity_type_id', 'item_type_id']],
  ['behavior_drops', 'behavior_drops_behavior_item_key', ['behavior_id', 'item_type_id']],
  ['chest_loot', 'chest_loot_level_item_key', ['level_min', 'level_max', 'item_type_id']],
];

exports.up = async (pgm) => {
  // Fail before touching anything if a unique key cannot be added.
  const problems = [];
  for (const [table, , cols] of UNIQUES) {
    const list = cols.join(', ');
    const { rows } = await pgm.db.query(
      `SELECT ${list}, count(*)::int AS n FROM ${table} GROUP BY ${list} HAVING count(*) > 1 ORDER BY ${list}`);
    for (const r of rows) {
      problems.push(`${table} (${cols.map((c) => `${c}=${r[c]}`).join(', ')}) x${r.n}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `seed_sync_plan2: duplicate rows block the new unique keys -- dedupe them deliberately, then re-run:\n  ${problems.join('\n  ')}`);
  }

  for (const [table, keyExpr, joins] of TABLES) {
    pgm.addColumns(table, { sync_uuid: { type: 'uuid' } });
    pgm.sql(`UPDATE ${table} t SET sync_uuid = md5('s2sync:' || '${table}' || ':' || sub.k)::uuid
      FROM (SELECT ${table === 'game_settings' || table === 'passive_edges' ? '' : 't.id AS id, '}${keyExpr} AS k${
  table === 'passive_edges' ? ', t.a_id AS a_id, t.b_id AS b_id' : ''}${table === 'game_settings' ? ', t.key AS pk' : ''}
        FROM ${table} t ${joins}) sub
      WHERE ${table === 'passive_edges' ? 't.a_id = sub.a_id AND t.b_id = sub.b_id'
    : table === 'game_settings' ? 't.key = sub.pk' : 't.id = sub.id'}`);
    pgm.alterColumn(table, 'sync_uuid', { notNull: true, default: pgm.func('gen_random_uuid()') });
    pgm.addConstraint(table, `${table}_sync_uuid_key`, { unique: ['sync_uuid'] });
  }

  for (const [table, name, cols] of UNIQUES) {
    pgm.addConstraint(table, name, { unique: cols });
  }
};

exports.down = (pgm) => {
  for (const [table, name] of [...UNIQUES].reverse()) {
    pgm.dropConstraint(table, name);
  }
  for (const [table] of [...TABLES].reverse()) {
    pgm.dropConstraint(table, `${table}_sync_uuid_key`);
    pgm.dropColumns(table, ['sync_uuid']);
  }
};
