const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { withAdvisoryLock, AUDIO_JOBS_LOCK_KEY } = require('./helpers/advisoryLock.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

// QUEUE TEST ISOLATION (game audio slice 2 common.md): every test that
// enqueues, claims or drains audio_jobs runs inside AUDIO_JOBS_LOCK_KEY --
// node --test runs files in parallel, and a later task's drain would
// otherwise process another file's jobs mid-test. This file only asserts
// schema (constraints/indexes), scoped to its own subject_key tag, but takes
// the same shared key up front so later tasks that extend this file inherit
// a body that is already guarded.
test('audio_jobs schema', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `jobschema-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try { await pool.query('DELETE FROM audio_jobs WHERE subject_key = $1', [tag]); }
    finally { await pool.end(); }
  });

  await withAdvisoryLock(pool, AUDIO_JOBS_LOCK_KEY, async () => {
    const ins = (state = 'queued', group = 'ambience') => pool.query(
      `INSERT INTO audio_jobs (batch_id, subject_kind, subject_key, slot, clip_kind, drain_group, state)
       VALUES (gen_random_uuid(), 'biome', $1, 'ambience', 'ambience', $2, $3) RETURNING id`, [tag, group, state]);

    await ins('queued');
    await assert.rejects(ins('queued'), /duplicate key/i, 'one live job per slot');
    await ins('done');
    await ins('failed');                       // finished jobs do not block
    await assert.rejects(ins('queued', 'drums'), /check constraint/i);
    await assert.rejects(ins('paused'), /check constraint/i);
  });
});
