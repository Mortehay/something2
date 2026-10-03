const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { withAdvisoryLock, AUDIO_JOBS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const q = require('../src/services/audioJobQueue');
const d = require('../src/services/audioDispatcher');
const gen = require('../src/services/audioGeneration');

const { promptPhaseStub } = require('./helpers/audioPromptPhaseStub.js');

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
        // The prompt phase and the model switch (plan 2026-10-03) have their
        // own file, audio_two_phase_drain_db.test.js. Here every prompt job
        // "writes" at once and no switch reaches a box, so these cases keep
        // testing what they were written for: the audio phase.
        ...promptPhaseStub,
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

      // F5: a bookkeeping write failing (e.g. complete() hitting FK 23503
      // because the clip was deleted in between) must cost ONE job, not the
      // whole drain, and must not leave that job stuck in 'running'.
      await t.test('complete() throwing once fails that job and the drain carries on to empty', async () => {
        d.__resetRun();
        await q.enqueue(pool, [1, 2].map((i) => (
          { subject_kind: 'world', subject_key: `${tag}-bk${i}`, slot: 'music', clip_kind: 'music' }
        )), {});
        let thrown = false;
        const flakyQueue = {
          ...q,
          complete: async (...args) => {
            if (!thrown) {
              thrown = true;
              const err = new Error('insert or update on table "audio_jobs" violates foreign key constraint');
              err.code = '23503';
              throw err;
            }
            return q.complete(...args);
          },
        };
        const errors = [];
        const origError = console.error;
        console.error = (...a) => { errors.push(a); };
        let s;
        try {
          d.startDrain(pool, { deps: { ...baseDeps, queue: flakyQueue } });
          s = await waitIdle();
        } finally { console.error = origError; }
        assert.equal(s.stopped_reason, 'empty', `the drain survived the bookkeeping error (error: ${s.error})`);
        assert.equal(s.done, 1);
        assert.equal(s.failed, 1);
        const rows = (await pool.query(
          'SELECT subject_key, state FROM audio_jobs WHERE subject_key LIKE $1 ORDER BY subject_key', [`${tag}-bk%`])).rows;
        assert.deepEqual(rows.map((r) => r.state).sort(), ['done', 'failed'], 'neither job is left running');
        assert.ok(errors.length >= 1, 'the bookkeeping error was logged');
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

      // --- sfx packs (game audio slice 3, Task 4) --------------------------
      //
      // Creature subjects with tagged, made-up keys (subjectExists is faked):
      // creature cues are fixed per slot (hurt->hit, death->death, nearby ->
      // none, upload only). The fake box is the ADAPTER-level
      // generateSfxPack; everything between it and the job rows -- cue
      // checks, entity text, mapping rows back, bookkeeping -- is real.
      const sfxProvider = { id: null, modality: 'audio', models_cache: ['cue:hit', 'cue:death'] };
      const fakeLib = { bindClip: async () => ({}), storeAndBindClip: async () => ({ clip: { id: null }, binding: { id: null } }) };
      const okRow = (it) => ({
        ok: true, cue: it.cue, entity: it.entity, clips: [{ buffer: Buffer.alloc(1), durationMs: 500 }], prompt: 'p', seed: 1, cached: false,
      });
      const sfxDeps = (generateSfxPack, extra = {}) => ({
        ...baseDeps,
        resolveAudioProvider: async () => sfxProvider,
        generateSfxPackForJobs: (db, p, jobs, opts) => gen.generateSfxPackForJobs(db, p, jobs, {
          ...opts, rap: { generateSfxPack }, lib: fakeLib,
        }),
        ...extra,
      });
      const sfxJob = (key, slot = 'hurt', engine = 'realistic') => ({
        subject_kind: 'creature', subject_key: `${tag}-${key}`, slot, clip_kind: 'sfx', engine,
      });
      const rowsLike = async (like) => (await pool.query(
        'SELECT subject_key, slot, state, attempts, last_error FROM audio_jobs WHERE subject_key LIKE $1 ORDER BY id', [like])).rows;

      await t.test('sfx: drain order is music, ambience, sfx_realistic, sfx_retro -- one pack call per sfx group', async () => {
        d.__resetRun();
        // The no-provider subtest above leaves its job queued on purpose.
        await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}-np%`]);
        const order = [];
        await q.enqueue(pool, [
          sfxJob('ord-retro', 'hurt', 'retro'),
          sfxJob('ord-real', 'hurt', 'realistic'),
          { subject_kind: 'biome', subject_key: `${tag}-ord-amb`, slot: 'ambience', clip_kind: 'ambience' },
          { subject_kind: 'world', subject_key: `${tag}-ord-mus`, slot: 'music', clip_kind: 'music' },
        ], {});
        const deps = sfxDeps(async (p, body) => {
          order.push(`pack:${[...new Set(body.items.map((i) => i.engine))].join('+')}`);
          return { ok: true, items: body.items.map(okRow) };
        }, {
          generateForSlot: async (db, p, spec) => { order.push(spec.clipKind); return { ok: true, clip: { id: null } }; },
        });
        d.startDrain(pool, { deps });
        const st = await waitIdle();
        assert.deepEqual(order, ['music', 'ambience', 'pack:realistic', 'pack:retro']);
        assert.equal(st.done, 4);
        assert.equal(st.stopped_reason, 'empty');
      });

      await t.test('sfx: 14 queued realistic jobs go out as two pack calls (12 + 2); the retro job gets its own', async () => {
        d.__resetRun();
        const calls = [];
        await q.enqueue(pool, [
          ...Array.from({ length: 14 }, (_, i) => sfxJob(`p14-${String(i).padStart(2, '0')}`)),
          sfxJob('p14-retro', 'death', 'retro'),
        ], {});
        d.startDrain(pool, {
          deps: sfxDeps(async (p, body) => { calls.push(body); return { ok: true, items: body.items.map(okRow) }; }),
        });
        const st = await waitIdle();
        assert.deepEqual(calls.map((c) => c.items.length), [12, 2, 1]);
        assert.deepEqual(calls.map((c) => [...new Set(c.items.map((i) => i.engine))]), [['realistic'], ['realistic'], ['retro']],
          'each call carries one group only');
        assert.ok(calls.every((c) => Number.isInteger(c.seed)), 'every pack sends an explicit integer seed');
        assert.equal(st.done, 15);
        const rows = await rowsLike(`${tag}-p14-%`);
        assert.ok(rows.every((r) => r.state === 'done' && r.attempts === 1), JSON.stringify(rows));
      });

      await t.test('sfx: one failed item fails only its own job; the retry re-sends it alone', async () => {
        d.__resetRun();
        // A near-zero retry backoff so the retried item is claimable again
        // within this subtest (fail() reads it per call).
        const prevBase = process.env.AUDIO_JOB_RETRY_BASE_MS;
        process.env.AUDIO_JOB_RETRY_BASE_MS = '1';
        try {
          await q.enqueue(pool, [sfxJob('item-a'), sfxJob('item-b'), sfxJob('item-c')], {});
          const calls = [];
          d.startDrain(pool, {
            deps: sfxDeps(async (p, body) => {
              calls.push(body.items.map((it) => it.entity.slice(-6)));
              return {
                ok: true,
                items: body.items.map((it) => (calls.length === 1 && it.entity === `${tag}-item-b`.toLowerCase()
                  ? { ok: false, cue: it.cue, entity: it.entity, error: 'cuda oom', providerFault: true }
                  : okRow(it))),
              };
            }),
          });
          const st = await waitIdle();
          assert.deepEqual(calls, [['item-a', 'item-b', 'item-c'], ['item-b']], 'only the failed item is sent again');
          assert.equal(st.done, 3);
          assert.equal(st.retried, 1);
          assert.equal(st.stopped_reason, 'empty');
          const rows = await rowsLike(`${tag}-item-%`);
          assert.deepEqual(rows.map((r) => [r.subject_key.slice(-6), r.state, r.attempts]), [
            ['item-a', 'done', 1], ['item-b', 'done', 2], ['item-c', 'done', 1],
          ]);
        } finally {
          if (prevBase === undefined) delete process.env.AUDIO_JOB_RETRY_BASE_MS; else process.env.AUDIO_JOB_RETRY_BASE_MS = prevBase;
          await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}-item-%`]);
        }
      });

      await t.test('sfx: a busy pack (409) refunds every job in it, pauses, and never trips the breaker', async () => {
        d.__resetRun();
        await q.enqueue(pool, [sfxJob('busy-a'), sfxJob('busy-b'), sfxJob('busy-c')], {});
        let calls = 0;
        const sleeps = [];
        d.startDrain(pool, {
          deps: sfxDeps(async () => {
            calls += 1;
            return { ok: false, status: 409, retryable: true, error: 'switch pending' };
          }, { sleep: async (ms) => { sleeps.push(ms); } }),
        });
        const t0 = Date.now();
        while (calls < 1 || sleeps.length < 1) {
          if (Date.now() - t0 > 5000) throw new Error('no busy pack seen');
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 5));
        }
        d.stopDrain();
        const st = await waitIdle();
        assert.equal(st.stopped_reason, 'stopped');
        assert.equal(st.retried, 3, 'all three jobs of the pack were requeued');
        assert.equal(st.failed, 0);
        const rows = await rowsLike(`${tag}-busy-%`);
        assert.ok(rows.every((r) => r.state === 'queued' && r.attempts === 0), JSON.stringify(rows));
        await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}-busy-%`]);
      });

      await t.test('sfx: an upload-only job never reaches the box and fails without counting', async () => {
        d.__resetRun();
        const sentItems = [];
        await q.enqueue(pool, [sfxJob('up-near', 'nearby'), sfxJob('up-hurt', 'hurt')], {});
        d.startDrain(pool, {
          deps: sfxDeps(async (p, body) => { sentItems.push(...body.items); return { ok: true, items: body.items.map(okRow) }; }),
        });
        const st = await waitIdle();
        assert.deepEqual(sentItems.map((i) => [i.cue, i.entity]), [['hit', `${tag}-up-hurt`.toLowerCase()]]);
        assert.equal(st.stopped_reason, 'empty');
        const rows = await rowsLike(`${tag}-up-%`);
        assert.equal(rows[0].state, 'failed');
        assert.match(rows[0].last_error, /upload only/);
        assert.equal(rows[1].state, 'done');
      });

      await t.test('sfx: an unknown-cue refusal fails only that cue\'s jobs; the rest are re-sent without it, attempt refunded', async () => {
        d.__resetRun();
        const calls = [];
        await q.enqueue(pool, [sfxJob('uc-a', 'hurt'), sfxJob('uc-b', 'death'), sfxJob('uc-c', 'hurt')], {});
        d.startDrain(pool, {
          deps: sfxDeps(async (p, body) => {
            calls.push(body.items.map((i) => i.cue));
            if (body.items.some((i) => i.cue === 'death')) {
              return {
                ok: false, status: 422, retryable: false, providerFault: false, unknownCue: 'death',
                error: "audio service answered 422 for POST /api/audio/sfx-pack: unknown cue 'death'; see GET /api/audio/styles?kind=sfx",
              };
            }
            return { ok: true, items: body.items.map(okRow) };
          }),
        });
        const st = await waitIdle();
        assert.deepEqual(calls, [['hit', 'death', 'hit'], ['hit', 'hit']]);
        assert.equal(st.stopped_reason, 'empty');
        const rows = await rowsLike(`${tag}-uc-%`);
        assert.deepEqual(rows.map((r) => [r.subject_key.slice(-4), r.state, r.attempts]), [
          ['uc-a', 'done', 1], ['uc-b', 'failed', 1], ['uc-c', 'done', 1],
        ], 'bystanders were released with their attempt refunded, then done on the next pack');
        assert.match(rows[1].last_error, /unknown cue 'death'/);
      });

      await t.test('sfx: a faulting pack counts ONCE toward the breaker, however many jobs it held', async () => {
        d.__resetRun();
        const prev = process.env.AUDIO_SFX_PACK_SIZE;
        process.env.AUDIO_SFX_PACK_SIZE = '2';
        try {
          await q.enqueue(pool, Array.from({ length: 8 }, (_, i) => sfxJob(`brk-${i}`)), {});
          let calls = 0;
          d.startDrain(pool, {
            deps: sfxDeps(async () => { calls += 1; return { ok: false, status: 500, retryable: false, error: 'internal' }; }),
          });
          const st = await waitIdle();
          assert.equal(st.stopped_reason, 'breaker');
          assert.equal(calls, 3, 'three packs (six jobs), not three jobs, trip it');
          assert.equal(st.failed, 6);
          const rows = await rowsLike(`${tag}-brk-%`);
          assert.equal(rows.filter((r) => r.state === 'queued').length, 2, 'the fourth pack was never sent');
        } finally {
          if (prev === undefined) delete process.env.AUDIO_SFX_PACK_SIZE; else process.env.AUDIO_SFX_PACK_SIZE = prev;
          await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}-brk-%`]);
        }
      });
    } finally {
      for (const r of foreignRows) {
        // eslint-disable-next-line no-await-in-loop
        await pool.query('UPDATE audio_jobs SET not_before = $2 WHERE id = $1', [r.id, r.not_before]);
      }
    }
  });
});
