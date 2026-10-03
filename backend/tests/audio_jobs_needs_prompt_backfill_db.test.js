// Migration 1714440630000: jobs queued before needs_prompt existed are
// backfilled with enqueue's own rule. Runs the migration's SQL against real
// rows inside a transaction that is always rolled back, so the database ends
// as it started.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { BACKFILL_SQL } = require('../migrations/1714440630000_audio_jobs_needs_prompt_backfill');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

test('backfill marks only prompt-less unfinished jobs', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  const tag = `backfill-${process.pid}-${Date.now()}`;
  try {
    await client.query('BEGIN');
    const ins = async (key, extra = {}) => (await client.query(
      `INSERT INTO audio_jobs (batch_id, subject_kind, subject_key, slot, clip_kind, drain_group, style, prompt, state, prompt_only)
       VALUES (gen_random_uuid(), 'world', $1, 'music', 'music', 'music', $2, $3, $4, $5) RETURNING id`,
      [`${tag}-${key}`, extra.style || null, extra.prompt || null, extra.state || 'queued', Boolean(extra.promptOnly)],
    )).rows[0].id;
    const ids = {
      bare: await ins('bare'),
      failedBare: await ins('failed', { state: 'failed' }),
      styled: await ins('styled', { style: 'tavern' }),
      prompted: await ins('prompted', { prompt: 'lute and drum' }),
      stored: await ins('stored'),
      cleared: await ins('cleared'),
      done: await ins('done', { state: 'done' }),
      promptOnly: await ins('ponly', { state: 'failed', promptOnly: true }),
    };
    await client.query(
      `INSERT INTO audio_prompts (subject_kind, subject_key, slot, style, text) VALUES
         ('world', $1, 'music', 'village', 'warm lute'), ('world', $2, 'music', NULL, '')`,
      [`${tag}-stored`, `${tag}-cleared`],
    );

    await client.query(BACKFILL_SQL);

    const { rows } = await client.query('SELECT id, needs_prompt FROM audio_jobs WHERE id = ANY($1::bigint[])', [Object.values(ids)]);
    const got = Object.fromEntries(rows.map((r) => [String(r.id), r.needs_prompt]));
    const want = {
      bare: true, failedBare: true, cleared: true, styled: false, prompted: false, stored: false, done: false, promptOnly: false,
    };
    for (const [name, expected] of Object.entries(want)) assert.equal(got[String(ids[name])], expected, name);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
