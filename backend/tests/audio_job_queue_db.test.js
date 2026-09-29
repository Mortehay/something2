const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { withAdvisoryLock, AUDIO_JOBS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const q = require('../src/services/audioJobQueue');

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

// QUEUE TEST ISOLATION: enqueue/claim/drain all run inside AUDIO_JOBS_LOCK_KEY
// per common.md -- node --test runs files in parallel and a claim in this
// file is not scoped to this file's own jobs. The lock is held for the whole
// body. claimMine still skips past any foreign row it claims (rows from a
// crashed prior run, or another key entirely, could still exist) even though
// the lock rules out a truly concurrent peer.
test('audio job queue', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `jobq-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try { await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}%`]); }
    finally { await pool.end(); }
  });

  await withAdvisoryLock(pool, AUDIO_JOBS_LOCK_KEY, async () => {
    const claimMine = async () => {
      for (let i = 0; i < 50; i++) {
        const j = await q.claimNext(pool);
        if (!j) return null;
        if (j.subject_key.startsWith(tag)) return j;
        await pool.query("UPDATE audio_jobs SET state = 'queued', attempts = attempts - 1, claimed_at = NULL WHERE id = $1", [j.id]);
      }
      return null;
    };

    const r = await q.enqueue(pool, [
      { subject_kind: 'biome', subject_key: `${tag}-b`, slot: 'ambience', clip_kind: 'ambience' },
      { subject_kind: 'world', subject_key: `${tag}-w`, slot: 'music', clip_kind: 'music' },
      { subject_kind: 'world', subject_key: `${tag}-w`, slot: 'ambience', clip_kind: 'ambience' },
    ], { providerId: null });
    assert.equal(r.queued.length, 3);
    const again = await q.enqueue(pool, [{ subject_kind: 'world', subject_key: `${tag}-w`, slot: 'music', clip_kind: 'music' }], {});
    assert.equal(again.queued.length, 0);
    assert.deepEqual(again.already_live, [{ subject_kind: 'world', subject_key: `${tag}-w`, slot: 'music' }]);
    assert.throws(() => q.drainGroupFor('sfx'), /slice 3/);

    const first = await claimMine();
    assert.equal(first.drain_group, 'music', 'music drains before ambience even though it was enqueued second');
    assert.equal(first.attempts, 1);

    assert.equal(await q.fail(pool, first.id, 'box busy', { retryable: true }), 'retry');
    const row = (await pool.query('SELECT state, not_before FROM audio_jobs WHERE id = $1', [first.id])).rows[0];
    assert.equal(row.state, 'queued');
    assert.ok(row.not_before > new Date(), 'backoff pushes not_before into the future');

    const second = await claimMine();
    assert.equal(second.drain_group, 'ambience', 'the backed-off music job is not claimable yet');
    await q.complete(pool, second.id, null);

    const third = await claimMine();
    assert.equal(third.state, 'running');
    assert.equal(await q.requeueOrphans(pool) >= 1, true);
    const orphan = (await pool.query('SELECT state, attempts FROM audio_jobs WHERE id = $1', [third.id])).rows[0];
    assert.deepEqual(orphan, { state: 'queued', attempts: 0 }, 'orphaned running row re-queued with its attempt refunded');

    await pool.query("UPDATE audio_jobs SET attempts = $2 WHERE id = $1", [first.id, q.MAX_ATTEMPTS]);
    await pool.query("UPDATE audio_jobs SET state = 'running' WHERE id = $1", [first.id]);
    assert.equal(await q.fail(pool, first.id, 'still busy', { retryable: true }), 'failed', 'attempts exhausted → failed');
    assert.equal(await q.retryFailed(pool) >= 1, true);
    const retried = (await pool.query('SELECT state, attempts, not_before FROM audio_jobs WHERE id = $1', [first.id])).rows[0];
    assert.deepEqual(retried, { state: 'queued', attempts: 0, not_before: null });
  });
});

// retryFailed must not leave older failed duplicates for the same slot
// stuck: a slot that failed twice (e.g. an earlier bug re-enqueued it after
// the first failure rather than reusing the row) has two 'failed' rows once
// the second attempt also fails. Resurrecting BOTH would collide on
// audio_jobs_one_live_per_slot the instant the second flips to 'queued' --
// retryFailed must drop the older one(s) and keep only the newest.
test('audio job queue: retryFailed drops older failed duplicates for the same slot', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `jobqdup-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try { await pool.query('DELETE FROM audio_jobs WHERE subject_key = $1', [tag]); }
    finally { await pool.end(); }
  });

  await withAdvisoryLock(pool, AUDIO_JOBS_LOCK_KEY, async () => {
    const ins = async () => (await pool.query(
      `INSERT INTO audio_jobs (batch_id, subject_kind, subject_key, slot, clip_kind, drain_group, state)
       VALUES (gen_random_uuid(), 'world', $1, 'music', 'music', 'music', 'failed') RETURNING id`,
      [tag],
    )).rows[0].id;

    const older = await ins();
    const newer = await ins();
    assert.equal(await q.retryFailed(pool), 1, 'only the newest duplicate is resurrected');

    const olderRow = (await pool.query('SELECT state FROM audio_jobs WHERE id = $1', [older])).rows[0];
    assert.equal(olderRow, undefined, 'the older failed duplicate was deleted, not resurrected');

    const newerRow = (await pool.query('SELECT state, attempts, not_before FROM audio_jobs WHERE id = $1', [newer])).rows[0];
    assert.deepEqual(newerRow, { state: 'queued', attempts: 0, not_before: null });
  });
});
