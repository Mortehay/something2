// Sprite-tab prompt opt-in table (1714440882000).
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const migration = require('../migrations/1714440882000_sprite_prompt_optins.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;

// Runs `body` on one client inside a transaction that is always rolled back.
async function rolledBack(body) {
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await body(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

// The migration's own SQL statements, captured from a recording pgm.
function migrationSql() {
  const sql = [];
  const noop = () => {};
  migration.up({ createTable: noop, addConstraint: noop, func: (s) => s, sql: (s) => sql.push(s) });
  return sql;
}

test('an inserted opt-in gets the deterministic sync_uuid; kind is checked; one row per subject', { skip }, async () => {
  await rolledBack(async (client) => {
    const key = `zz_optin_${process.pid}`;
    const { rows: [r] } = await client.query(
      "INSERT INTO sprite_prompt_optins (subject_kind, subject_key) VALUES ('entity', $1) RETURNING sync_uuid::text, created_at", [key]);
    const { rows: [want] } = await client.query(
      "SELECT md5('s2sync:sprite_prompt_optins:entity|' || $1::text)::uuid::text AS u", [key]);
    assert.strictEqual(r.sync_uuid, want.u);
    assert.ok(r.created_at instanceof Date);
    // An explicit sync_uuid (seed sync) is kept.
    const { rows: [e] } = await client.query(
      `INSERT INTO sprite_prompt_optins (subject_kind, subject_key, sync_uuid)
       VALUES ('vfx', $1, '00000000-0000-4000-8000-000000000001') RETURNING sync_uuid::text`, [key]);
    assert.strictEqual(e.sync_uuid, '00000000-0000-4000-8000-000000000001');
    await client.query('SAVEPOINT s');
    await assert.rejects(client.query(
      "INSERT INTO sprite_prompt_optins (subject_kind, subject_key) VALUES ('entity', $1)", [key]), (err) => err.code === '23505');
    await client.query('ROLLBACK TO s');
    await assert.rejects(client.query(
      "INSERT INTO sprite_prompt_optins (subject_kind, subject_key) VALUES ('item', $1)", [key]), (err) => err.code === '23514');
    await client.query('ROLLBACK TO s');
  });
});

test('the backfill opts in every subject with a Sprite-tab version, active or not, and nothing else', { skip }, async () => {
  const backfill = migrationSql().find((s) => /INSERT INTO sprite_prompt_optins/.test(s));
  assert.ok(backfill, 'the migration has a backfill');
  await rolledBack(async (client) => {
    const k = (n) => `zz_optbf_${n}_${process.pid}`;
    await client.query(
      `INSERT INTO art_prompt_descriptions (subject_kind, subject_key, text, active, origin) VALUES
         ('entity', $1, 'sprite, then rewritten', false, 'sprite'),
         ('entity', $1, 'console text', true, NULL),
         ('character_appearance', $2, 'sprite active', true, 'sprite'),
         ('entity', $3, 'console only', true, NULL)`, [k('a'), k('b'), k('c')]);
    await client.query(backfill);
    const { rows } = await client.query(
      "SELECT subject_kind, subject_key FROM sprite_prompt_optins WHERE subject_key LIKE 'zz\\_optbf\\_%' ORDER BY subject_key");
    assert.deepStrictEqual(rows.map((r) => [r.subject_kind, r.subject_key]),
      [['entity', k('a')], ['character_appearance', k('b')]]);
    // Re-running is harmless.
    await client.query(backfill);
  });
});
