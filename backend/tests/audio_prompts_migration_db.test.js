const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

test('audio_prompts migration', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `mig-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try {
      await pool.query('DELETE FROM audio_prompts WHERE subject_key = $1', [tag]);
      await pool.query('DELETE FROM ai_providers WHERE name = $1', [tag]);
    } finally { await pool.end(); }
  });

  const p = await pool.query(
    "INSERT INTO ai_providers (name, base_url, request_template, modality) VALUES ($1, 'http://x', '{}', 'text') RETURNING modality",
    [tag]);
  assert.equal(p.rows[0].modality, 'text');

  await pool.query(
    "INSERT INTO audio_prompts (subject_kind, subject_key, slot, text) VALUES ('world', $1, 'music', 'a')", [tag]);
  await assert.rejects(
    pool.query("INSERT INTO audio_prompts (subject_kind, subject_key, slot, text) VALUES ('world', $1, 'music', 'b')", [tag]),
    (err) => err.code === '23505', 'two active rows for one slot must be refused');
  await pool.query("UPDATE audio_prompts SET active = false WHERE subject_key = $1", [tag]);
  await pool.query(
    "INSERT INTO audio_prompts (subject_kind, subject_key, slot, text) VALUES ('world', $1, 'music', 'b')", [tag]);
  const n = await pool.query('SELECT count(*)::int AS n FROM audio_prompts WHERE subject_key = $1', [tag]);
  assert.equal(n.rows[0].n, 2, 'inactive history rows are kept');
});
