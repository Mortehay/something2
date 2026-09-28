// backend/tests/audio_catalog_db.test.js
// Schema guards for the audio catalog (spec §1). Gated on TEST_DATABASE_URL:
// this file inserts rows, so it must never touch the shared dev DB.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

test('audio catalog schema', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const providers = [];
  const clips = [];
  t.after(async () => {
    try {
      if (clips.length) await pool.query('DELETE FROM audio_clips WHERE id = ANY($1)', [clips]);
      if (providers.length) await pool.query('DELETE FROM ai_providers WHERE id = ANY($1)', [providers]);
      await pool.query("DELETE FROM audio_misses WHERE subject_key LIKE 'schema-test-%'");
    } finally { await pool.end(); }
  });
  const tag = `${process.pid}-${Date.now()}`;
  const insertProvider = async (name, modality) => {
    const r = await pool.query(
      `INSERT INTO ai_providers (name, base_url, request_template, modality)
       VALUES ($1, 'http://127.0.0.1:9/', '{}'::jsonb, $2) RETURNING id`, [name, modality]);
    providers.push(r.rows[0].id);
    return r.rows[0].id;
  };

  await t.test('existing rows default to image, bad modality rejected', async () => {
    const id = await insertProvider(`schema-img-${tag}`, 'image');
    const r = await pool.query('SELECT modality FROM ai_providers WHERE id = $1', [id]);
    assert.equal(r.rows[0].modality, 'image');
    await assert.rejects(insertProvider(`schema-bad-${tag}`, 'video'), /check constraint/i);
  });

  await t.test('one active per modality, not one active overall', async () => {
    // Clear only OUR rows' activity; never touch rows this test did not make.
    const img = await insertProvider(`schema-a-img-${tag}`, 'image');
    const aud = await insertProvider(`schema-a-aud-${tag}`, 'audio');
    const aud2 = await insertProvider(`schema-a-aud2-${tag}`, 'audio');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE ai_providers SET is_active = false WHERE is_active');
      await client.query('UPDATE ai_providers SET is_active = true WHERE id = ANY($1)', [[img, aud]]);
      await assert.rejects(
        client.query('UPDATE ai_providers SET is_active = true WHERE id = $1', [aud2]),
        /duplicate key/i,
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  await t.test('clips: kind check, bindings unique + cascade', async () => {
    const c = await pool.query(
      `INSERT INTO audio_clips (kind, label, storage_key, bytes, duration_ms, source)
       VALUES ('ambience', 'schema test', $1, 10, 1000, 'uploaded') RETURNING id`,
      [`audio/ambience/schema-${tag}.ogg`]);
    const clipId = c.rows[0].id;
    clips.push(clipId);
    await assert.rejects(pool.query(
      `INSERT INTO audio_clips (kind, label, storage_key, bytes, duration_ms, source)
       VALUES ('noise', 'x', $1, 1, 1, 'uploaded')`, [`audio/x/${tag}.ogg`]), /check constraint/i);

    const bind = () => pool.query(
      `INSERT INTO audio_bindings (subject_kind, subject_key, slot, clip_id)
       VALUES ('biome', $1, 'ambience', $2)`, [`schema-test-${tag}`, clipId]);
    await bind();
    await assert.rejects(bind(), /duplicate key/i);

    await pool.query('DELETE FROM audio_clips WHERE id = $1', [clipId]);
    const left = await pool.query('SELECT 1 FROM audio_bindings WHERE clip_id = $1', [clipId]);
    assert.equal(left.rowCount, 0, 'deleting a clip removes its bindings');
  });

  await t.test('misses keyed by subject + slot', async () => {
    const ins = () => pool.query(
      `INSERT INTO audio_misses (subject_kind, subject_key, slot, world)
       VALUES ('biome', $1, 'ambience', 'w') ON CONFLICT (subject_kind, subject_key, slot)
       DO UPDATE SET count = audio_misses.count + 1 RETURNING count`, [`schema-test-${tag}`]);
    assert.equal((await ins()).rows[0].count, 1);
    assert.equal((await ins()).rows[0].count, 2);
  });
});
