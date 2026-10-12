// backend/tests/audio_scoped_generate_db.test.js
//
// SOMET-592 defect 2: a single-slot card's Generate click posted ONE item but
// started an UNSCOPED drain. For the packed sfx groups (claimBatch takes up
// to AUDIO_SFX_PACK_SIZE jobs of the same drain_group in one claim) that let
// one click's pack call scoop up OTHER already-queued jobs and send them in
// the same box request -- reported harm: clicking Generate on one creature's
// hurt sound swept in 2 unrelated queued jobs.
//
// The fix threads the enqueue's own batch_id into claimBatch/hasClaimable/
// nextClaimableAt (audioJobQueue.js) and into startDrain (audioDispatcher.js)
// as an opt-in `batchIds` scope: a scoped claim only ever sees rows of that
// one batch, however many other batches sit in the same drain_group.
//
// This file proves three things, test-first:
//   1. claimBatch itself never crosses batch_id when scoped (the queue layer
//      that stops the pack-sweep).
//   2. startDrain(db, { batchId }) end to end only touches its own batch's
//      rows even while a different batch is queued in the very same run.
//   3. the concurrency edge case design intent flagged explicitly: a second
//      scoped start while a scoped drain is already running must not claim
//      success it cannot deliver (runCovers tells the caller the truth), and
//      the "stranded" batch is NOT lost -- a later explicit retry completes
//      it once the first drain is out of the way.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { withAdvisoryLock, AUDIO_JOBS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const { parkingForeignQueued } = require('./helpers/foreignAudioJobs.js');
const { promptPhaseStub } = require('./helpers/audioPromptPhaseStub.js');
const q = require('../src/services/audioJobQueue');
const d = require('../src/services/audioDispatcher');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

async function waitIdle(timeoutMs = 10000) {
  const t0 = Date.now();
  while (d.runStatus().running) {
    if (Date.now() - t0 > timeoutMs) {
      d.stopDrain();
      throw new Error('drain did not finish');
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 20); });
  }
  return d.runStatus();
}

test('audio job queue: claimBatch(batchIds) never crosses batches, even inside one packed sfx group', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `scopedq-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try { await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}%`]); }
    finally { await pool.end(); }
  });

  await withAdvisoryLock(pool, AUDIO_JOBS_LOCK_KEY, async () => {
    await parkingForeignQueued(pool, `${tag}%`, async () => {
      // An explicit style/prompt keeps needs_prompt false, so a direct
      // phase:'audio' claim (no prompt phase run first) actually sees these
      // rows -- this test is about claimBatch's own batchIds scope, not the
      // prompt/audio phase split.
      const sfx = (key) => ({
        subject_kind: 'creature', subject_key: `${tag}-${key}`, slot: 'hurt', clip_kind: 'sfx', engine: 'realistic', prompt: 'x',
      });
      // Batch B enqueued FIRST (it is the "already queued" work a single
      // slot's click must never sweep in), batch A SECOND (the click).
      const b = await q.enqueue(pool, [sfx('b1'), sfx('b2')], {});
      const a = await q.enqueue(pool, [sfx('a1')], {});
      assert.equal(b.queued.length, 2);
      assert.equal(a.queued.length, 1);
      assert.notEqual(a.batch_id, b.batch_id);

      // Unscoped (today's full-drain behaviour): one claim takes EVERY
      // realistic sfx job in the group, both batches together.
      const unscoped = await q.claimBatch(pool, 12, { phase: 'audio', group: 'sfx_realistic' });
      assert.equal(unscoped.length, 3, 'sanity: an unscoped claim packs across batches');
      await q.release(pool, unscoped.map((j) => j.id));

      // Scoped to batch A: must take ONLY batch A's one job, never batch B's
      // two, even though they sit in the exact same drain_group and would
      // otherwise fit in the same pack.
      const scoped = await q.claimBatch(pool, 12, { phase: 'audio', group: 'sfx_realistic', batchIds: [a.batch_id] });
      assert.equal(scoped.length, 1, 'a scoped claim must not sweep in another batch');
      assert.equal(scoped[0].subject_key, `${tag}-a1`);
      // Batch B's rows are untouched -- still queued, not claimed.
      const bRows = (await pool.query(
        "SELECT state FROM audio_jobs WHERE subject_key IN ($1, $2)", [`${tag}-b1`, `${tag}-b2`],
      )).rows;
      assert.ok(bRows.every((r) => r.state === 'queued'), 'the other batch was left alone');

      // hasClaimable and nextClaimableAt take the same scope: once batch A's
      // only job is claimed/running, a batch-A-scoped check sees nothing left
      // even though batch B's two jobs are still queued in the same group.
      const hasA = await q.hasClaimable(pool, { phase: 'audio', group: 'sfx_realistic', batchIds: [a.batch_id] });
      assert.equal(hasA, false, 'batch A has nothing left claimable once its one job is running');
      const hasB = await q.hasClaimable(pool, { phase: 'audio', group: 'sfx_realistic', batchIds: [b.batch_id] });
      assert.equal(hasB, true, "batch B's jobs are unaffected and still claimable");
      const nextA = await q.nextClaimableAt(pool, { phase: 'audio', group: 'sfx_realistic', batchIds: [a.batch_id] });
      assert.equal(nextA, null, 'batch A is exhausted');
      const nextB = await q.nextClaimableAt(pool, { phase: 'audio', group: 'sfx_realistic', batchIds: [b.batch_id] });
      assert.ok(nextB, "batch B's own next-claimable time is independent of batch A");
    });
  });
});

test('audio dispatcher: startDrain({ batchId }) only ever touches its own batch, end to end', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `scopedd-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try { await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}%`]); }
    finally { d.__resetRun(); await pool.end(); }
  });

  await withAdvisoryLock(pool, AUDIO_JOBS_LOCK_KEY, async () => {
    await parkingForeignQueued(pool, `${tag}%`, async () => {
      const provider = { id: null, modality: 'audio' };
      const seen = [];
      const baseDeps = {
        resolveAudioProvider: async () => provider,
        subjectExists: async () => true,
        sleep: async () => {},
        ...promptPhaseStub,
        generateForSlot: async (db, p, spec) => { seen.push(spec.subjectKey); return { ok: true, clip: { id: null } }; },
      };

      // Batch OTHER is queued first (a different click's job that is already
      // sitting in the queue), batch MINE is the one this drain is scoped to.
      const other = await q.enqueue(pool, [
        { subject_kind: 'world', subject_key: `${tag}-other`, slot: 'music', clip_kind: 'music' },
      ], {});
      const mine = await q.enqueue(pool, [
        { subject_kind: 'world', subject_key: `${tag}-mine`, slot: 'ambience', clip_kind: 'ambience' },
      ], {});

      const status = d.startDrain(pool, { batchId: mine.batch_id, deps: baseDeps });
      assert.deepEqual(status.scope, [mine.batch_id], 'runStatus reports the scope synchronously on start');

      const s = await waitIdle();
      assert.deepEqual(seen, [`${tag}-mine`], 'only the scoped batch was ever generated');
      assert.equal(s.stopped_reason, 'empty', 'a scoped drain ends once ITS batch is exhausted');

      const rows = (await pool.query(
        'SELECT subject_key, state FROM audio_jobs WHERE subject_key IN ($1, $2)',
        [`${tag}-mine`, `${tag}-other`],
      )).rows;
      const byKey = Object.fromEntries(rows.map((r) => [r.subject_key, r.state]));
      assert.equal(byKey[`${tag}-mine`], 'done');
      assert.equal(byKey[`${tag}-other`], 'queued', 'the unrelated already-queued batch was never claimed');

      // Cleanup for the left-behind queued row (not asserted on further).
      await pool.query('DELETE FROM audio_jobs WHERE subject_key = $1', [`${tag}-other`]);
      assert.deepEqual(other.queued.length, 1);
    });
  });
});

// The concurrency edge case called out explicitly in the ticket: a running
// SCOPED drain must not silently claim a job it will never reach. runCovers
// is the decision audioRoutes.js's ALREADY_RUNNING handling is built on.
test('audio dispatcher: runCovers tells a caller whether an already-running drain will reach a batch, and a scoped batch is never stranded forever', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `scopedc-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try { await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}%`]); }
    finally { d.__resetRun(); await pool.end(); }
  });

  await withAdvisoryLock(pool, AUDIO_JOBS_LOCK_KEY, async () => {
    await parkingForeignQueued(pool, `${tag}%`, async () => {
      const provider = { id: null, modality: 'audio' };
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const blockingDeps = {
        resolveAudioProvider: async () => provider,
        subjectExists: async () => true,
        sleep: async () => {},
        ...promptPhaseStub,
        generateForSlot: async () => { await gate; return { ok: true, clip: { id: null } }; },
      };

      const a = await q.enqueue(pool, [
        { subject_kind: 'world', subject_key: `${tag}-a`, slot: 'music', clip_kind: 'music' },
      ], {});
      const b = await q.enqueue(pool, [
        { subject_kind: 'world', subject_key: `${tag}-b`, slot: 'music', clip_kind: 'music' },
      ], {});

      d.startDrain(pool, { batchId: a.batch_id, deps: blockingDeps });
      // Give the drain a moment to actually claim batch A's job (so it is
      // genuinely mid-flight, not merely "started").
      const t0 = Date.now();
      while (!d.runStatus().current) {
        if (Date.now() - t0 > 5000) throw new Error('drain never claimed its job');
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => { setTimeout(r, 5); });
      }

      // A second scoped start for a DIFFERENT batch while A is running must
      // throw ALREADY_RUNNING (unchanged contract) ...
      assert.throws(() => d.startDrain(pool, { batchId: b.batch_id, deps: blockingDeps }), (e) => e.code === 'ALREADY_RUNNING');
      // ... and runCovers must say the running (scoped-to-A) drain will NOT
      // reach batch B on its own -- the honest answer the route needs so it
      // does not report started:true and silently strand batch B's job.
      assert.equal(d.runCovers(b.batch_id), false, 'a drain scoped to A does not cover B');
      // It DOES cover its own batch, and an unscoped-needs (null) request is
      // correctly refused too -- a scoped drain never covers "everything".
      assert.equal(d.runCovers(a.batch_id), true);
      assert.equal(d.runCovers(null), false, 'a scoped drain does not cover an unscoped request either');

      release();
      await waitIdle();

      // Batch B's job was never swept in and never silently claimed success
      // -- it is still sitting queued, untouched, exactly where the honest
      // "not covered" answer said it would be.
      const bRow = (await pool.query('SELECT state, attempts FROM audio_jobs WHERE subject_key = $1', [`${tag}-b`])).rows[0];
      assert.deepEqual(bRow, { state: 'queued', attempts: 0 }, "batch B was not touched while A's drain ran");

      // Not stranded FOREVER though: once A's drain is out of the way, an
      // explicit retry for B (what the UI does on "drain_busy") completes it.
      d.__resetRun();
      const retryDeps = { ...blockingDeps, generateForSlot: async () => ({ ok: true, clip: { id: null } }) };
      d.startDrain(pool, { batchId: b.batch_id, deps: retryDeps });
      await waitIdle();
      const bRowAfter = (await pool.query('SELECT state FROM audio_jobs WHERE subject_key = $1', [`${tag}-b`])).rows[0];
      assert.equal(bRowAfter.state, 'done', 'the retried batch completes once the blocking drain is gone');

      // And the symmetric, unchanged case: an UNSCOPED running drain covers
      // everything, exactly like every drain did before this fix.
      d.__resetRun();
      const c = await q.enqueue(pool, [
        { subject_kind: 'world', subject_key: `${tag}-c`, slot: 'music', clip_kind: 'music' },
      ], {});
      let release2;
      const gate2 = new Promise((resolve) => { release2 = resolve; });
      d.startDrain(pool, {
        deps: { ...blockingDeps, generateForSlot: async () => { await gate2; return { ok: true, clip: { id: null } }; } },
      });
      const t1 = Date.now();
      while (!d.runStatus().current) {
        if (Date.now() - t1 > 5000) throw new Error('unscoped drain never claimed its job');
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => { setTimeout(r, 5); });
      }
      assert.equal(d.runCovers(c.batch_id), true, 'an unscoped drain covers any batch');
      assert.equal(d.runCovers(null), true, 'an unscoped drain covers an unscoped request too');
      release2();
      await waitIdle();
    });
  });
});
