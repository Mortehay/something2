const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { withAdvisoryLock, AUDIO_JOBS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const { restoringForeignJobs, parkingForeignQueued } = require('./helpers/foreignAudioJobs.js');
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
    try {
      await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}%`]);
      await pool.query('DELETE FROM audio_jobs WHERE subject_key = $1', [`foreign-${tag}`]);
    } finally { await pool.end(); }
  });

  await withAdvisoryLock(pool, AUDIO_JOBS_LOCK_KEY, async () => {
    // A stand-in for ANOTHER file's failed row (keyed outside `${tag}%`):
    // retryFailed below must not leave it re-queued.
    await pool.query(
      `INSERT INTO audio_jobs (batch_id, subject_kind, subject_key, slot, clip_kind, drain_group, state, attempts, last_error)
       VALUES (gen_random_uuid(), 'world', $1, 'music', 'music', 'music', 'failed', 3, 'foreign failure')`,
      [`foreign-${tag}`],
    );
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
    // retryFailed is database-wide: foreign failed rows are put back after.
    const { result: requeued, foreignTouched } = await restoringForeignJobs(pool, `${tag}%`, ['failed'], () => q.retryFailed(pool));
    assert.equal(requeued - foreignTouched, 1, 'exactly this file\'s one failed row was re-queued');
    const retried = (await pool.query('SELECT state, attempts, not_before FROM audio_jobs WHERE id = $1', [first.id])).rows[0];
    assert.deepEqual(retried, { state: 'queued', attempts: 0, not_before: null });
    const foreign = (await pool.query('SELECT state, attempts, last_error FROM audio_jobs WHERE subject_key = $1', [`foreign-${tag}`])).rows[0];
    assert.deepEqual(foreign, { state: 'failed', attempts: 3, last_error: 'foreign failure' }, "another file's failed row is left failed");
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
    try { await pool.query('DELETE FROM audio_jobs WHERE subject_key IN ($1, $2)', [tag, `foreign-${tag}`]); }
    finally { await pool.end(); }
  });

  await withAdvisoryLock(pool, AUDIO_JOBS_LOCK_KEY, async () => {
    // A stand-in for ANOTHER file's failed row, as in the test above.
    await pool.query(
      `INSERT INTO audio_jobs (batch_id, subject_kind, subject_key, slot, clip_kind, drain_group, state, attempts, last_error)
       VALUES (gen_random_uuid(), 'world', $1, 'music', 'music', 'music', 'failed', 3, 'foreign failure')`,
      [`foreign-${tag}`],
    );
    const ins = async () => (await pool.query(
      `INSERT INTO audio_jobs (batch_id, subject_kind, subject_key, slot, clip_kind, drain_group, state)
       VALUES (gen_random_uuid(), 'world', $1, 'music', 'music', 'music', 'failed') RETURNING id`,
      [tag],
    )).rows[0].id;

    const older = await ins();
    const newer = await ins();
    // retryFailed is database-wide: foreign failed rows are put back after,
    // and only this file's share of the count is asserted on.
    const { result: requeued, foreignTouched } = await restoringForeignJobs(pool, tag, ['failed'], () => q.retryFailed(pool));
    assert.equal(requeued - foreignTouched, 1, 'only the newest duplicate is resurrected');

    const olderRow = (await pool.query('SELECT state FROM audio_jobs WHERE id = $1', [older])).rows[0];
    assert.equal(olderRow, undefined, 'the older failed duplicate was deleted, not resurrected');

    const newerRow = (await pool.query('SELECT state, attempts, not_before FROM audio_jobs WHERE id = $1', [newer])).rows[0];
    assert.deepEqual(newerRow, { state: 'queued', attempts: 0, not_before: null });
    const foreign = (await pool.query('SELECT state, attempts, last_error FROM audio_jobs WHERE subject_key = $1', [`foreign-${tag}`])).rows[0];
    assert.deepEqual(foreign, { state: 'failed', attempts: 3, last_error: 'foreign failure' }, "another file's failed row is left failed");
  });
});

// enqueue's unnest INSERT casts slots through ::jsonb and seed through
// ::bigint[] -- a null slots/seed item (every other test's fixtures) never
// exercises either cast. This proves both: a non-null `slots` object
// survives the text->jsonb round trip, and a non-null integer `seed`
// survives the text->bigint round trip (bigint comes back from pg as a
// string, hence the Number() wrap on the assertion below).
test('audio job queue: enqueue carries slots and seed through their casts', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `jobqslots-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try { await pool.query('DELETE FROM audio_jobs WHERE subject_key = $1', [tag]); }
    finally { await pool.end(); }
  });

  await withAdvisoryLock(pool, AUDIO_JOBS_LOCK_KEY, async () => {
    const r = await q.enqueue(pool, [
      {
        subject_kind: 'world', subject_key: tag, slot: 'music', clip_kind: 'music', slots: { mood: 'x' }, seed: 123,
      },
    ], {});
    assert.equal(r.queued.length, 1);

    const row = (await pool.query('SELECT slots, seed FROM audio_jobs WHERE subject_key = $1', [tag])).rows[0];
    assert.equal(row.slots.mood, 'x');
    assert.equal(Number(row.seed), 123);
  });
});

// Game audio slice 3, Task 4: sfx drain groups. An sfx job's engine picks
// its group (realistic -> sfx_realistic, retro -> sfx_retro) and is stored
// on the row; claimBatch claims up to n jobs of ONE group -- the first
// claimable group in DRAIN_ORDER -- and never more than one music/ambience.
test('audio job queue: sfx drain groups and claimBatch', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `jobqsfx-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try { await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}%`]); }
    finally { await pool.end(); }
  });

  assert.deepEqual(q.DRAIN_ORDER, ['music', 'ambience', 'sfx_realistic', 'sfx_retro']);
  assert.equal(q.drainGroupFor('music'), 'music');
  assert.equal(q.drainGroupFor('ambience'), 'ambience');
  assert.equal(q.drainGroupFor('sfx'), 'sfx_realistic', 'realistic is the default engine');
  assert.equal(q.drainGroupFor('sfx', 'realistic'), 'sfx_realistic');
  assert.equal(q.drainGroupFor('sfx', 'retro'), 'sfx_retro');

  await withAdvisoryLock(pool, AUDIO_JOBS_LOCK_KEY, async () => {
    await parkingForeignQueued(pool, `${tag}%`, async () => {
      const sfx = (key, slot, engine) => ({
        subject_kind: 'creature', subject_key: `${tag}-${key}`, slot, clip_kind: 'sfx', engine,
      });
      // Enqueued retro first, realistic second, music/ambience last: the
      // claim order must come from DRAIN_ORDER, not insertion order.
      const r = await q.enqueue(pool, [
        sfx('r1', 'hurt', 'retro'), sfx('r2', 'hurt', 'retro'), sfx('r3', 'hurt', 'retro'),
        sfx('s1', 'hurt', 'realistic'), sfx('s2', 'death', undefined),
        { subject_kind: 'biome', subject_key: `${tag}-a`, slot: 'ambience', clip_kind: 'ambience' },
        { subject_kind: 'world', subject_key: `${tag}-m1`, slot: 'music', clip_kind: 'music' },
        { subject_kind: 'world', subject_key: `${tag}-m2`, slot: 'music', clip_kind: 'music' },
      ], {});
      assert.equal(r.queued.length, 8);
      const rows = (await pool.query(
        'SELECT subject_key, drain_group, engine FROM audio_jobs WHERE subject_key LIKE $1 ORDER BY subject_key', [`${tag}%`],
      )).rows;
      const by = Object.fromEntries(rows.map((x) => [x.subject_key.slice(tag.length + 1), x]));
      assert.deepEqual([by.r1.drain_group, by.r1.engine], ['sfx_retro', 'retro']);
      assert.deepEqual([by.s1.drain_group, by.s1.engine], ['sfx_realistic', 'realistic']);
      assert.deepEqual([by.s2.drain_group, by.s2.engine], ['sfx_realistic', 'realistic'], 'no engine -> realistic, stored');
      assert.equal(by.m1.engine, null, 'music carries no engine');

      const groupOf = (jobs) => [...new Set(jobs.map((j) => j.drain_group))];
      const b1 = await q.claimBatch(pool, 12);
      assert.deepEqual(groupOf(b1), ['music']);
      assert.equal(b1.length, 1, 'music is claimed one at a time even when n is larger');
      assert.ok(b1.every((j) => j.state === 'running' && j.attempts === 1));
      const b2 = await q.claimBatch(pool, 12);
      assert.deepEqual([groupOf(b2), b2.length], [['music'], 1]);
      const b3 = await q.claimBatch(pool, 12);
      assert.deepEqual([groupOf(b3), b3.length], [['ambience'], 1]);
      const b4 = await q.claimBatch(pool, 12);
      assert.deepEqual([groupOf(b4), b4.length], [['sfx_realistic'], 2], 'every realistic job, and no retro one');
      const b5 = await q.claimBatch(pool, 2);
      assert.deepEqual([groupOf(b5), b5.length], [['sfx_retro'], 2], 'n caps an sfx batch');
      assert.ok(b5[0].id < b5[1].id, 'a batch comes back in id order');
      const b6 = await q.claimBatch(pool, 2);
      assert.deepEqual([groupOf(b6), b6.length], [['sfx_retro'], 1]);
      assert.deepEqual(await q.claimBatch(pool, 12), [], 'nothing left');

      // release: the claimed jobs go straight back to claimable with their
      // attempt refunded and no backoff (used for an sfx pack's innocent
      // bystanders when one unknown cue fails the whole request).
      await q.release(pool, b5.map((j) => j.id));
      const released = (await pool.query(
        'SELECT state, attempts, not_before FROM audio_jobs WHERE id = ANY($1)', [b5.map((j) => j.id)],
      )).rows;
      assert.deepEqual(released, [
        { state: 'queued', attempts: 0, not_before: null },
        { state: 'queued', attempts: 0, not_before: null },
      ]);
      assert.equal((await q.claimBatch(pool, 12)).length, 2, 'released jobs are claimable at once');

      // A batch never mixes provider pins: the box a pack goes to is one
      // provider, so a pinned job and an unpinned job are separate batches.
      await pool.query("UPDATE audio_jobs SET state = 'queued', attempts = 0 WHERE subject_key LIKE $1 AND drain_group = 'sfx_retro'", [`${tag}%`]);
      const prov = (await pool.query(
        `INSERT INTO ai_providers (name, base_url, request_template, modality, auth_token)
         VALUES ($1, 'http://127.0.0.1:1', '{}'::jsonb, 'audio', 'sk') RETURNING id`, [`jobq-prov-${tag}`],
      )).rows[0].id;
      try {
        await pool.query('UPDATE audio_jobs SET provider_id = $2 WHERE subject_key = $1', [`${tag}-r3`, prov]);
        const p1 = await q.claimBatch(pool, 12);
        const p2 = await q.claimBatch(pool, 12);
        assert.deepEqual([p1.length, p2.length], [2, 1]);
        assert.ok(p1.every((j) => j.provider_id === null));
        assert.deepEqual(p2.map((j) => j.provider_id), [prov]);
      } finally {
        await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}%`]);
        await pool.query('DELETE FROM ai_providers WHERE id = $1', [prov]);
      }
    });
  });
});
