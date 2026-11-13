// Real-DB guards for the image_variants / image_operations migration. Gated on
// TEST_DATABASE_URL (never the dev DB). Every statement runs in a transaction
// that is always ROLLED BACK.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to touch a real database' : false;

const INSERT = `INSERT INTO image_variants (subject_table, subject_key, subject_column, web_key, web_sprite, params)
                VALUES ($1, $2, $3, $4, $5, '{}'::jsonb)`;

async function inTxn(pool, fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await fn(c); } finally { await c.query('ROLLBACK'); c.release(); }
}

test('image_variants schema', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 2 });
  t.after(() => pool.end());

  await t.test('web_key and web_sprite both null is a check violation', () => inTxn(pool, async (c) => {
    await assert.rejects(c.query(INSERT, ['t', 'k', 'c', null, null]), (e) => e.code === '23514');
  }));

  await t.test('web_key and web_sprite both set is a check violation', () => inTxn(pool, async (c) => {
    await assert.rejects(c.query(INSERT, ['t', 'k', 'c', 'a.webp', '{"atlas_key":"a","manifest_key":"m"}']),
      (e) => e.code === '23514');
  }));

  await t.test('duplicate subject triple is a unique violation', () => inTxn(pool, async (c) => {
    await c.query(INSERT, ['t', 'k', 'c', 'a.webp', null]);
    await assert.rejects(c.query(INSERT, ['t', 'k', 'c', 'b.webp', null]), (e) => e.code === '23505');
  }));

  await t.test('defaults: active true, sync_uuid generated, updated_at set', () => inTxn(pool, async (c) => {
    const r = await c.query(`${INSERT} RETURNING active, sync_uuid, updated_at`, ['t', 'k2', 'c', 'a.webp', null]);
    assert.equal(r.rows[0].active, true);
    assert.ok(r.rows[0].sync_uuid);
    assert.ok(r.rows[0].updated_at);
  }));

  await t.test('image_operations rejects an unknown op', () => inTxn(pool, async (c) => {
    await assert.rejects(c.query(
      "INSERT INTO image_operations (op, subject_table, subject_key, subject_column, status) VALUES ('bogus','t','k','c','ok')"),
    (e) => e.code === '23514');
  }));

  await t.test('both tables have a primary key on id', async () => {
    const r = await pool.query(
      `SELECT conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE contype = 'p' AND conrelid IN ('image_variants'::regclass, 'image_operations'::regclass)`);
    const byTable = Object.fromEntries(r.rows.map((x) => [x.tbl, x.def]));
    assert.equal(byTable.image_variants, 'PRIMARY KEY (id)');
    assert.equal(byTable.image_operations, 'PRIMARY KEY (id)');
  });

  await t.test('image_variants records the original manifest key and etag (nullable text)', async () => {
    const r = await pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'image_variants'
          AND column_name IN ('original_manifest_key', 'original_manifest_etag') ORDER BY column_name`);
    assert.deepEqual(r.rows.map((x) => [x.column_name, x.data_type, x.is_nullable]),
      [['original_manifest_etag', 'text', 'YES'], ['original_manifest_key', 'text', 'YES']]);
  });

  await t.test('image_variants has the stale mark and the seeded source sha (nullable)', async () => {
    const r = await pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'image_variants'
          AND column_name IN ('stale_at', 'source_asset_sha256') ORDER BY column_name`);
    assert.deepEqual(r.rows.map((x) => [x.column_name, x.data_type, x.is_nullable]),
      [['source_asset_sha256', 'text', 'YES'], ['stale_at', 'timestamp with time zone', 'YES']]);
  });

  await t.test('image_operations has the last-op-per-subject index', async () => {
    const r = await pool.query(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'image_operations' AND indexname = 'image_operations_subject_id_idx'");
    assert.match(r.rows[0].indexdef, /\(subject_table, subject_key, subject_column, id DESC\)/);
  });

  await t.test('image_operations accepts a valid row', () => inTxn(pool, async (c) => {
    const r = await c.query(
      "INSERT INTO image_operations (op, subject_table, subject_key, subject_column, status) VALUES ('shrink','t','k','c','ok') RETURNING id, created_at");
    assert.ok(r.rows[0].id);
  }));
});
