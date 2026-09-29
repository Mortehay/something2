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
    if (Date.now() - t0 > timeoutMs) {
      // Stop the drain before failing the test -- otherwise a timed-out
      // sub-test leaves its drain running in the background (this file's own
      // __resetRun() only forgets the tracking object, it does not stop the
      // loop), and that zombie drain keeps claiming and mutating rows for
      // every subtest that runs after this one.
      d.stopDrain();
      throw new Error('drain did not finish');
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return d.runStatus();
}

async function waitForCurrent(subjectKey, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!(d.runStatus().current && d.runStatus().current.subject_key === subjectKey)) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`never saw ${subjectKey} as current`);
    await new Promise((r) => setTimeout(r, 5));
  }
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
    // Foreign queued jobs (another file) would be claimed too -- including
    // ones whose backoff already passed (not_before <= now()), not only
    // never-backed-off ones. Parked for the duration by pushing not_before an
    // hour out, and restored to their EXACT previous value afterwards (which
    // may itself have been a past timestamp, not only NULL).
    const foreignRows = (await pool.query(
      `SELECT id, not_before FROM audio_jobs
        WHERE state = 'queued' AND (not_before IS NULL OR not_before <= now())
          AND subject_key NOT LIKE $1`, [`${tag}%`])).rows;
    if (foreignRows.length) {
      await pool.query(
        `UPDATE audio_jobs SET not_before = now() + interval '1 hour' WHERE id = ANY($1)`,
        [foreignRows.map((r) => r.id)],
      );
    }

    try {
      const provider = { id: null, modality: 'audio' };
      const seen = [];
      const seeds = {};
      const baseDeps = {
        resolveAudioProvider: async () => provider,
        // These jobs use tagged, made-up subject keys; the real catalogue
        // check (F2) has its own subtest below that leaves this default out.
        subjectExists: async () => true,
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

      await t.test('three consecutive RETRYABLE, non-busy failures trip the breaker; nothing is lost', async () => {
        d.__resetRun();
        seen.length = 0;
        await q.enqueue(pool, [1, 2, 3, 4].map((i) => (
          { subject_kind: 'biome', subject_key: `${tag}-f${i}`, slot: 'ambience', clip_kind: 'ambience' }
        )), {});
        const failing = {
          ...baseDeps,
          generateForSlot: async () => ({ ok: false, error: 'box asleep', retryable: true }), // no status -> not busy
        };
        d.startDrain(pool, { deps: failing });
        const s = await waitIdle();
        assert.equal(s.stopped_reason, 'breaker');
        assert.match(s.error, /box asleep/);
        const rows = (await pool.query('SELECT state FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}-f%`])).rows;
        assert.equal(rows.length, 4, 'no job deleted');
        assert.ok(rows.every((r) => r.state === 'queued'), 'retryable failures went back to the queue with backoff');
      });

      // Runs immediately after the breaker test and clears (then fully
      // resolves) every `-f*` row's backoff. Left any later, the `-f*` rows
      // sit with a FUTURE not_before from the breaker test above, and every
      // subtest here reuses the same instant fake `sleep` -- a later drain
      // computing its idle wait against that stale future timestamp would
      // livelock (the fake sleep never advances real wall-clock time, so the
      // loop just spins claim/nextClaimableAt until real time genuinely
      // catches up, which blew past this suite's 10s waitIdle budget when
      // this ran out of order during review).
      await t.test('an orphaned running row is re-queued (with its attempt refunded) at start', async () => {
        d.__resetRun();
        await pool.query('UPDATE audio_jobs SET not_before = NULL WHERE subject_key LIKE $1', [`${tag}-f%`]);
        await pool.query("UPDATE audio_jobs SET state = 'running', attempts = 1 WHERE subject_key = $1", [`${tag}-f1`]);
        d.startDrain(pool, { deps: baseDeps });
        const s = await waitIdle();
        assert.ok(s.requeued_orphans >= 1);
        const f1 = (await pool.query('SELECT state, attempts FROM audio_jobs WHERE subject_key = $1', [`${tag}-f1`])).rows[0];
        assert.equal(f1.state, 'done');
        // requeueOrphans refunds the orphaned attempt (1 -> 0), then the
        // drain's own successful reclaim brings it back to exactly 1. If the
        // refund had not happened this would read 2.
        assert.equal(f1.attempts, 1, "requeueOrphans refunded the orphan's running attempt before the successful reclaim");
      });

      // The stop must land only after all three jobs have gone through the
      // busy path -- not merely after the fake `sleep` has been called once.
      // A busy pause is ~30 one-second fake slices resolved as microtasks, so
      // "sleeps.length >= 1" was satisfied after the FIRST job's pause began,
      // well before the 3rd job (the one that would trip a breaker if busy
      // wrongly counted) had even been claimed -- a mutation that made busy
      // count toward the breaker still passed that version of this test 4 of
      // 5 runs. Counting `generateForSlot` calls instead pins the assertion
      // to "all three jobs actually went through busy handling".
      await t.test('three consecutive BUSY (409) responses do not trip the breaker; jobs are requeued without spending an attempt, and the drain pauses before claiming again', async () => {
        d.__resetRun();
        await q.enqueue(pool, [1, 2, 3].map((i) => (
          { subject_kind: 'biome', subject_key: `${tag}-busy${i}`, slot: 'ambience', clip_kind: 'ambience' }
        )), {});
        const sleeps = [];
        let calls = 0;
        const busyDeps = {
          ...baseDeps,
          sleep: async (ms) => { sleeps.push(ms); },
          generateForSlot: async () => {
            calls += 1;
            return { ok: false, error: 'switch pending', retryable: true, status: 409 };
          },
        };
        d.startDrain(pool, { deps: busyDeps });
        const t0 = Date.now();
        while (calls < 3) {
          if (Date.now() - t0 > 5000) throw new Error('generateForSlot was not called for all three busy jobs in time');
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 5));
        }
        d.stopDrain();
        const s = await waitIdle();
        assert.equal(s.stopped_reason, 'stopped', 'busy responses must never trip the breaker');
        assert.notEqual(s.stopped_reason, 'breaker');
        const rows = (await pool.query('SELECT state, attempts FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}-busy%`])).rows;
        assert.equal(rows.length, 3);
        assert.ok(
          rows.every((r) => r.state === 'queued' && r.attempts === 0),
          'busy responses refund the claimed attempt and requeue rather than spending it',
        );
        assert.ok(sleeps.length >= 1, 'the drain paused before claiming again after a busy response');
        // These rows were deliberately left mid-backoff (busy never resolves
        // them). Deleted immediately rather than at t.after so they cannot
        // starve a LATER subtest's drain the same way the comment above
        // describes for `-f*`.
        await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}-busy%`]);
      });

      await t.test('three consecutive PROVIDER-FAULT (status 500) failures trip the breaker even though retryable is false', async () => {
        d.__resetRun();
        await q.enqueue(pool, [1, 2, 3, 4].map((i) => (
          { subject_kind: 'biome', subject_key: `${tag}-fault5xx${i}`, slot: 'ambience', clip_kind: 'ambience' }
        )), {});
        const faulting = {
          ...baseDeps,
          generateForSlot: async () => ({ ok: false, error: 'internal server error', retryable: false, status: 500 }),
        };
        d.startDrain(pool, { deps: faulting });
        const s = await waitIdle();
        assert.equal(s.stopped_reason, 'breaker', 'a 5xx other than 503 is a provider fault even when retryable is false');
        assert.match(s.error, /internal server error/);
        const rows = (await pool.query('SELECT state FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}-fault5xx%`])).rows;
        assert.equal(rows.length, 4, 'no job deleted');
        await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}-fault5xx%`]);
      });

      await t.test('three consecutive explicit providerFault failures trip the breaker', async () => {
        d.__resetRun();
        await q.enqueue(pool, [1, 2, 3, 4].map((i) => (
          { subject_kind: 'biome', subject_key: `${tag}-faultflag${i}`, slot: 'ambience', clip_kind: 'ambience' }
        )), {});
        const faulting = {
          ...baseDeps,
          generateForSlot: async () => ({
            ok: false, error: 'audio service did not answer with usable JSON', retryable: false, providerFault: true,
          }),
        };
        d.startDrain(pool, { deps: faulting });
        const s = await waitIdle();
        assert.equal(s.stopped_reason, 'breaker', 'an explicit providerFault trips the breaker with no status and retryable false');
        const rows = (await pool.query('SELECT state FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}-faultflag%`])).rows;
        assert.equal(rows.length, 4, 'no job deleted');
        await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}-faultflag%`]);
      });

      await t.test('three consecutive NON-RETRYABLE subject failures do not trip the breaker; the jobs end failed', async () => {
        d.__resetRun();
        await q.enqueue(pool, [1, 2, 3, 4].map((i) => (
          { subject_kind: 'biome', subject_key: `${tag}-bad${i}`, slot: 'ambience', clip_kind: 'ambience' }
        )), {});
        const badSubject = {
          ...baseDeps,
          generateForSlot: async () => ({ ok: false, error: 'unknown style for this subject', retryable: false }),
        };
        d.startDrain(pool, { deps: badSubject });
        const s = await waitIdle();
        assert.equal(s.stopped_reason, 'empty', 'non-retryable failures must not trip the breaker either');
        assert.equal(s.failed, 4);
        const rows = (await pool.query('SELECT state FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}-bad%`])).rows;
        assert.equal(rows.length, 4);
        assert.ok(rows.every((r) => r.state === 'failed'), 'a non-retryable failure lands in failed, not queued');
      });

      await t.test('a job whose subject no longer exists fails without calling the box or counting toward the breaker', async () => {
        d.__resetRun();
        await q.enqueue(pool, [1, 2, 3, 4].map((i) => (
          { subject_kind: 'biome', subject_key: `${tag}-gone${i}`, slot: 'ambience', clip_kind: 'ambience' }
        )), {});
        let calls = 0;
        // No subjectExists override: the REAL catalogue check runs, and none
        // of these tagged biome names exist.
        const { subjectExists: _unused, ...realCatalogue } = baseDeps;
        const goneDeps = {
          ...realCatalogue,
          generateForSlot: async () => { calls += 1; return { ok: true, clip: { id: null } }; },
        };
        d.startDrain(pool, { deps: goneDeps });
        const s = await waitIdle();
        assert.equal(calls, 0, 'the box is never called for a missing subject');
        assert.equal(s.stopped_reason, 'empty', 'missing subjects do not trip the breaker');
        assert.equal(s.failed, 4);
        const rows = (await pool.query('SELECT state, last_error FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}-gone%`])).rows;
        assert.equal(rows.length, 4);
        assert.ok(rows.every((r) => r.state === 'failed' && /subject no longer exists/.test(r.last_error)), JSON.stringify(rows));
      });

      await t.test('stopDrain lets the in-flight job finish but claims nothing further', async () => {
        d.__resetRun();
        await q.enqueue(pool, [
          { subject_kind: 'world', subject_key: `${tag}-stop1`, slot: 'music', clip_kind: 'music' },
          { subject_kind: 'world', subject_key: `${tag}-stop2`, slot: 'music', clip_kind: 'music' },
        ], {});
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const stopDeps = {
          ...baseDeps,
          generateForSlot: async (db, p, spec) => {
            if (spec.subjectKey === `${tag}-stop1`) await gate;
            return { ok: true, clip: { id: null } };
          },
        };
        d.startDrain(pool, { deps: stopDeps });
        await waitForCurrent(`${tag}-stop1`);
        d.stopDrain();
        release();
        const s = await waitIdle();
        assert.equal(s.stopped_reason, 'stopped');
        assert.equal(s.done, 1);
        const rows = (await pool.query(
          'SELECT subject_key, state FROM audio_jobs WHERE subject_key IN ($1, $2)',
          [`${tag}-stop1`, `${tag}-stop2`],
        )).rows;
        const byKey = Object.fromEntries(rows.map((r) => [r.subject_key, r.state]));
        assert.equal(byKey[`${tag}-stop1`], 'done', 'the in-flight job finished');
        assert.equal(byKey[`${tag}-stop2`], 'queued', 'no further job was claimed after stop');
        // stop2 is left queued (never claimed) on purpose -- cleaned up here
        // rather than at t.after so it cannot be claimed by a later subtest.
        await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}-stop%`]);
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
      for (const r of foreignRows) {
        // eslint-disable-next-line no-await-in-loop
        await pool.query('UPDATE audio_jobs SET not_before = $2 WHERE id = $1', [r.id, r.not_before]);
      }
    }
  });
});
