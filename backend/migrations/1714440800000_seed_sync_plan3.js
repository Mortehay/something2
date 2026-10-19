// backend/migrations/1714440800000_seed_sync_plan3.js
//
// SOMET-640 (Seed/Export plan 3, art and audio groups). Gives the art/audio
// tables a travelling sync_uuid, same shape as 1714440790000_seed_sync_plan2.js:
// nullable add -> deterministic backfill md5('s2sync:<table>:<key>')::uuid ->
// NOT NULL -> unique. Composite keys join with '|' and reference other rows by
// THEIR natural key (never a local id, which differs between PCs); the one
// exception is audio_bindings, keyed by its clip's sync_uuid (= audio_clips.id).
//
// Versioned tables (art_prompt_descriptions, audio_prompts): the app
// deactivates the old active row, then inserts the new one. A BEFORE INSERT
// trigger gives the new row the sync_uuid of the highest-id row with the same
// natural key (active or not), so a subject keeps ONE identity across versions;
// uniqueness is only WHERE active. They carry no column default for that
// reason: the trigger fills NULL.
//
// Also adds seed_asset_hashes, the per-PC cache of content hashes of MinIO
// objects. The migration never deletes: duplicates / uuid collisions throw and
// list the offenders.
exports.shorthands = undefined;

const uuidOf = (table, keyExpr) => `md5('s2sync:${table}:' || (${keyExpr}))::uuid`;

// [table, key SQL (alias t), FROM-joins, WHERE filter for the pre-check]
const KEYED = [
  ['catalog_art', "t.subject_kind || '|' || t.subject_key", '', 'true'],
  ['character_appearances', "e.name || '|' || t.variant", 'JOIN entity_types e ON e.id = t.entity_type_id', 'true'],
  ['audio_bindings', "t.subject_kind || '|' || t.subject_key || '|' || t.slot || '|' || c.id::text",
    'JOIN audio_clips c ON c.id = t.clip_id', 'true'],
  // Active rows get the plain key; inactive history gets '|id' so duplicate
  // history cannot collide. Duplicates among ACTIVE rows are what the pre-check
  // exists to catch.
  ['art_prompt_notes',
    "t.subject_kind || '|' || t.subject_key || '|' || t.kind || '|' || t.note || CASE WHEN t.active THEN '' ELSE '|' || t.id END",
    '', 'true'],
];
const VERSIONED = [
  ['art_prompt_descriptions', "t.subject_kind || '|' || t.subject_key"],
  ['audio_prompts', "t.subject_kind || '|' || t.subject_key || '|' || t.slot"],
];

async function uuidCollisions(db) {
  const out = [];
  const check = async (table, keyExpr, joins, where) => {
    const { rows } = await db.query(
      `SELECT ${uuidOf(table, 'k')}::text AS u, count(*)::int AS n, array_agg(k ORDER BY k) AS keys
         FROM (SELECT ${keyExpr} AS k FROM ${table} t ${joins} WHERE ${where}) sub
        GROUP BY 1 HAVING count(*) > 1 ORDER BY 1`);
    for (const r of rows) out.push(`${table} keys ${JSON.stringify(r.keys)} -> one sync_uuid x${r.n}`);
  };
  for (const [table, keyExpr, joins, where] of KEYED) await check(table, keyExpr, joins, where);
  for (const [table, keyExpr] of VERSIONED) await check(table, keyExpr, '', 't.active');
  return out;
}
exports._uuidCollisions = uuidCollisions;

exports.up = async (pgm) => {
  const collisions = await uuidCollisions(pgm.db);
  if (collisions.length > 0) {
    throw new Error(
      `seed_sync_plan3: duplicate rows / natural keys that give the same sync_uuid block the unique sync_uuid -- dedupe or rename them deliberately, then re-run:\n  ${collisions.join('\n  ')}`);
  }

  // audio_clips: the identity IS the id.
  pgm.addColumns('audio_clips', { sync_uuid: { type: 'uuid' } });
  pgm.sql('UPDATE audio_clips SET sync_uuid = id');
  pgm.alterColumn('audio_clips', 'sync_uuid', { notNull: true, default: pgm.func('gen_random_uuid()') });
  pgm.addConstraint('audio_clips', 'audio_clips_sync_uuid_key', { unique: ['sync_uuid'] });

  for (const [table, keyExpr, joins] of KEYED) {
    pgm.addColumns(table, { sync_uuid: { type: 'uuid' } });
    // Correlated join through a subselect on ctid: these tables have composite
    // or no usable single-column pk (catalog_art, character_appearances).
    pgm.sql(`UPDATE ${table} u SET sync_uuid = sub.u
      FROM (SELECT t.ctid AS rid, ${uuidOf(table, keyExpr)} AS u FROM ${table} t ${joins}) sub
      WHERE u.ctid = sub.rid`);
    pgm.alterColumn(table, 'sync_uuid', { notNull: true, default: pgm.func('gen_random_uuid()') });
    pgm.addConstraint(table, `${table}_sync_uuid_key`, { unique: ['sync_uuid'] });
  }

  for (const [table, keyExpr] of VERSIONED) {
    pgm.addColumns(table, { sync_uuid: { type: 'uuid' } });
    // Every version of a subject (active or history) shares one uuid.
    pgm.sql(`UPDATE ${table} u SET sync_uuid = ${uuidOf(table, keyExpr.replace(/\bt\./g, 'u.'))}`);
    pgm.alterColumn(table, 'sync_uuid', { notNull: true });
    pgm.createIndex(table, 'sync_uuid', { name: `${table}_sync_uuid_active_key`, unique: true, where: 'active' });
    const newKey = keyExpr.replace(/\bt\./g, 'NEW.');
    const sameKey = table === 'audio_prompts'
      ? 'p.subject_kind = NEW.subject_kind AND p.subject_key = NEW.subject_key AND p.slot = NEW.slot'
      : 'p.subject_kind = NEW.subject_kind AND p.subject_key = NEW.subject_key';
    pgm.sql(`CREATE FUNCTION ${table}_sync_uuid_fill() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.sync_uuid IS NULL THEN
          NEW.sync_uuid := COALESCE(
            (SELECT p.sync_uuid FROM ${table} p WHERE ${sameKey} ORDER BY p.id DESC LIMIT 1),
            ${uuidOf(table, newKey)});
        END IF;
        RETURN NEW;
      END
    $f$`);
    pgm.sql(`CREATE TRIGGER ${table}_sync_uuid_fill BEFORE INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ${table}_sync_uuid_fill()`);
  }

  pgm.createTable('seed_asset_hashes', {
    object_key: { type: 'text', primaryKey: true },
    sha256: { type: 'text', notNull: true },
    file: { type: 'text', notNull: true },
    bytes: { type: 'integer', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('seed_asset_hashes');
  for (const [table] of [...VERSIONED].reverse()) {
    pgm.sql(`DROP TRIGGER ${table}_sync_uuid_fill ON ${table}`);
    pgm.sql(`DROP FUNCTION ${table}_sync_uuid_fill()`);
    pgm.dropIndex(table, 'sync_uuid', { name: `${table}_sync_uuid_active_key` });
    pgm.dropColumns(table, ['sync_uuid']);
  }
  for (const [table] of [...KEYED].reverse()) {
    pgm.dropConstraint(table, `${table}_sync_uuid_key`);
    pgm.dropColumns(table, ['sync_uuid']);
  }
  pgm.dropConstraint('audio_clips', 'audio_clips_sync_uuid_key');
  pgm.dropColumns('audio_clips', ['sync_uuid']);
};
