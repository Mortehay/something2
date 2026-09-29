const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { withAdvisoryLock, AUDIO_JOBS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const q = require('../src/services/audioJobQueue');
const d = require('../src/services/audioDispatcher');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

async function waitIdle(timeoutMs = 10000) {
  const t0 = Date.now();
  while (d.runStatus().running) {
    if (Date.now() - t0 > timeoutMs) throw new Error('drain did not finish');
    await new Promise((r) => setTimeout(r, 20));
  }
  return d.runStatus();
}

// QUEUE TEST ISOLATION (game audio slice 2 common.md): the whole body runs
// inside AUDIO_JOBS_LOCK_KEY, the same key audio_job_queue_db.test.js uses --
// node --test runs files in parallel, and a drain here claims ANY queued job,
// not just this file's own. The lock is released (withAdvisoryLock's finally)
// before the pool is ended in t.after.
test('audio dispatcher', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `disp-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try { await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}%`]); }
    finally { d.__resetRun(); await pool.end(); }
  });

  await withAdvisoryLock(pool, AUDIO_JOBS_LOCK_KEY, async () => {
    // Foreign queued jobs (another file) would be claimed too; park them for
    // the duration and restore after, touching only their not_before.
    const foreign = (await pool.query(
      `UPDATE audio_jobs SET not_before = now() + interval '1 hour' WHERE state = 'queued' AND not_before IS NULL
         AND subject_key NOT LIKE $1 RETURNING id`, [`${tag}%`])).rows.map((r) => r.id);

    try {
      const provider = { id: null, modality: 'audio' };
      const seen = [];
      const seeds = {};
      const baseDeps = {
        resolveAudioProvider: async () => provider,
        sleep: async () => {},
        generateForSlot: async (db, p, spec) => {
          seen.push(`${spec.clipKind}:${spec.subjectKey}`);
          seeds[spec.subjectKey] = spec.seed;
          return { ok: true, clip: { id: null } };
        },
      };

      await t.test('drains music before ambience, finishes empty, and passes seed through as a number', async () => {
        await q.enqueue(pool, [
          { subject_kind: 'biome', subject_key: `${tag}-a1`, slot: 'ambience', clip_kind: 'ambience' },
          { subject_kind: 'world', subject_key: `${tag}-m1`, slot: 'music', clip_kind: 'music' },
          { subject_kind: 'biome', subject_key: `${tag}-a2`, slot: 'ambience', clip_kind: 'ambience' },
          {
            subject_kind: 'world', subject_key: `${tag}-m2`, slot: 'music', clip_kind: 'music', seed: 123,
          },
        ], {});
        d.startDrain(pool, { deps: baseDeps });
        assert.throws(() => d.startDrain(pool, { deps: baseDeps }), (e) => e.code === 'ALREADY_RUNNING');
        const s = await waitIdle();
        assert.deepEqual(seen.map((x) => x.split(':')[0]), ['music', 'music', 'ambience', 'ambience']);
        assert.equal(s.done, 4);
        assert.equal(s.stopped_reason, 'empty');
        // audio_jobs.seed is bigint; pg returns it as a string on the row, so
        // this proves the dispatcher's Number(job.seed) wrap actually ran --
        // a job enqueued with seed 123 must reach generateForSlot as the
        // NUMBER 123, not the string "123".
        assert.strictEqual(seeds[`${tag}-m2`], 123);
      });

      await t.test('three consecutive failures trip the breaker; nothing is lost', async () => {
        d.__resetRun();
        seen.length = 0;
        await q.enqueue(pool, [1, 2, 3, 4].map((i) => (
          { subject_kind: 'biome', subject_key: `${tag}-f${i}`, slot: 'ambience', clip_kind: 'ambience' }
        )), {});
        const failing = { ...baseDeps, generateForSlot: async () => ({ ok: false, error: 'box asleep', retryable: true }) };
        d.startDrain(pool, { deps: failing });
        const s = await waitIdle();
        assert.equal(s.stopped_reason, 'breaker');
        assert.match(s.error, /box asleep/);
        const rows = (await pool.query('SELECT state FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}-f%`])).rows;
        assert.equal(rows.length, 4, 'no job deleted');
        assert.ok(rows.every((r) => r.state === 'queued'), 'retryable failures went back to the queue with backoff');
      });

      await t.test('an orphaned running row is re-queued at start', async () => {
        d.__resetRun();
        await pool.query('UPDATE audio_jobs SET not_before = NULL WHERE subject_key LIKE $1', [`${tag}-f%`]);
        await pool.query("UPDATE audio_jobs SET state = 'running', attempts = 1 WHERE subject_key = $1", [`${tag}-f1`]);
        d.startDrain(pool, { deps: baseDeps });
        const s = await waitIdle();
        assert.ok(s.requeued_orphans >= 1);
        const f1 = (await pool.query('SELECT state FROM audio_jobs WHERE subject_key = $1', [`${tag}-f1`])).rows[0];
        assert.equal(f1.state, 'done');
      });

      await t.test('no resolvable provider anywhere stops the drain without burning an attempt', async () => {
        d.__resetRun();
        await q.enqueue(pool, [
          { subject_kind: 'world', subject_key: `${tag}-np1`, slot: 'music', clip_kind: 'music' },
        ], {});
        const noProvider = { ...baseDeps, resolveAudioProvider: async () => null };
        d.startDrain(pool, { deps: noProvider });
        const s = await waitIdle();
        assert.equal(s.stopped_reason, 'no_provider');
        assert.match(s.error, /no audio provider/);
        const row = (await pool.query('SELECT state, attempts FROM audio_jobs WHERE subject_key = $1', [`${tag}-np1`])).rows[0];
        assert.deepEqual(row, { state: 'queued', attempts: 0 }, 'the job was never claimed, so it burned no attempt');
      });
    } finally {
      if (foreign.length) await pool.query('UPDATE audio_jobs SET not_before = NULL WHERE id = ANY($1)', [foreign]);
    }
  });
});
