const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const q = require('../src/services/artJobQueue.js');
const { withAdvisoryLock, ART_JOBS_LOCK_KEY } = require('./helpers/advisoryLock.js');

// SOMET-543. A failed job must WAIT before it is claimable again.
//
// THE INCIDENT THIS ENCODES. On 2026-09-04 the image provider faulted for 24
// seconds. In that window the queue spent 150 provider calls and marked 50
// subjects permanently `failed`; all 50 generated fine two minutes later. The
// cause was that fail() returned a job to `queued` with nothing marking it as
// not-yet-ready, so the drain re-claimed it on the very next pass and burned
// all three attempts inside the outage.
//
// WHY THESE ARE DB TESTS. The property under test is "claim() does not return
// this row", which is a property of the SQL and of Postgres's now(), not of
// any JavaScript. A fake db would assert the query I wrote rather than what
// the database does with it -- the exact shape of test this repo keeps finding
// green over broken code.
//
// WHAT WOULD MAKE THESE VACUOUS. Asserting only that a subject "eventually
// reaches done" passes against the old no-delay code, because the old code
// also eventually succeeded whenever the provider recovered inside three
// instant attempts. Every case below therefore asserts on the DELAY itself --
// that a retry is refused NOW, and permitted only once the clock has moved.
const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

function requireTestDb(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

async function freshPool(t) {
  const pool = new Pool({ connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000 });
  t.after(async () => { await pool.end().catch(() => {}); });
  return pool;
}

// Shares art_jobs with the other art tests, and claim() takes ANY queued job
// rather than only this file's -- so the lock wraps the whole body, for the
// reason art_job_queue_db.test.js documents.
function lockedTest(name, body) {
  test(name, async (t) => {
    if (!requireTestDb(t, 'writes art_jobs')) return;
    const pool = await freshPool(t);
    const prevBase = process.env.ART_JOB_RETRY_BASE_MS;
    await withAdvisoryLock(pool, ART_JOBS_LOCK_KEY, async () => {
      await pool.query('DELETE FROM art_jobs');
      try {
        await body(t, pool);
      } finally {
        if (prevBase === undefined) delete process.env.ART_JOB_RETRY_BASE_MS;
        else process.env.ART_JOB_RETRY_BASE_MS = prevBase;
        await pool.query('DELETE FROM art_jobs').catch(() => {});
      }
    });
  });
}

const SUBJ = (n) => ({ kind: 'skill', key: `bk_${n}` });

async function enqueueOne(pool, n) {
  const rows = await q.enqueue(pool, [SUBJ(n)], { backend: 'local', providerId: null });
  assert.equal(rows.length, 1, 'setup: the subject should have been queued');
  return rows[0];
}

lockedTest('a failed job is NOT immediately claimable -- the 50-subject bug', async (t, pool) => {
  process.env.ART_JOB_RETRY_BASE_MS = '30000';
  await enqueueOne(pool, 1);

  const [claimed] = await q.claim(pool, 10);
  assert.ok(claimed, 'setup: the queued job should be claimable');

  await q.fail(pool, claimed.id, new Error('provider answered 500'));

  // The whole point. Under the old code this returned the row instantly, and
  // three attempts were spent inside a 24-second outage.
  const again = await q.claim(pool, 10);
  assert.equal(again.length, 0,
    'a job that just failed must not be claimable again in the same instant');

  const { rows } = await pool.query('SELECT state, attempts, not_before FROM art_jobs WHERE id = $1',
    [claimed.id]);
  assert.equal(rows[0].state, 'queued', 'it is still queued -- it is waiting, not dead');
  assert.ok(rows[0].not_before > new Date(), 'not_before must be in the future');
});

lockedTest('the wait actually expires -- a delayed job is claimable once its time passes',
  async (t, pool) => {
    // Milliseconds, so the test measures the mechanism rather than sleeping 30s.
    process.env.ART_JOB_RETRY_BASE_MS = '150';
    await enqueueOne(pool, 2);

    const [claimed] = await q.claim(pool, 10);
    const failed = await q.fail(pool, claimed.id, new Error('transient'));

    assert.equal((await q.claim(pool, 10)).length, 0, 'refused while the backoff is unexpired');

    const waitMs = new Date(failed.not_before).getTime() - Date.now();
    assert.ok(waitMs > 0, 'setup: the delay should still be in the future');
    await new Promise((r) => { setTimeout(r, Math.max(waitMs, 0) + 250); });

    const after = await q.claim(pool, 10);
    assert.equal(after.length, 1, 'once not_before has passed the job must be claimable again');
    assert.equal(after[0].attempts, 2, 'and the retry counts as the second attempt');
  });

lockedTest('the delay grows with attempts rather than staying flat', async (t, pool) => {
  process.env.ART_JOB_RETRY_BASE_MS = '30000';
  await enqueueOne(pool, 3);

  const [first] = await q.claim(pool, 10);
  const afterOne = await q.fail(pool, first.id, new Error('boom'));
  const waitOne = new Date(afterOne.not_before).getTime() - Date.now();

  // Make it claimable again without waiting the real backoff.
  await pool.query('UPDATE art_jobs SET not_before = now() - interval \'1 second\' WHERE id = $1',
    [first.id]);
  const [second] = await q.claim(pool, 10);
  assert.equal(second.attempts, 2, 'setup: this is the second attempt');
  const afterTwo = await q.fail(pool, second.id, new Error('boom again'));
  const waitTwo = new Date(afterTwo.not_before).getTime() - Date.now();

  // Jitter is +/-25%, so doubling cannot be asserted exactly -- but the second
  // wait must clear the first's upper bound, which flat delays never would.
  // A hardcoded delay (the bug this guards) makes waitTwo ~= waitOne.
  assert.ok(waitTwo > waitOne * 1.3,
    `the second wait (${waitTwo}ms) must be materially longer than the first (${waitOne}ms)`);
});

lockedTest('a terminally failed job carries no leftover delay', async (t, pool) => {
  process.env.ART_JOB_RETRY_BASE_MS = '10';
  await enqueueOne(pool, 4);

  // Exhaust the attempt cap.
  for (let i = 0; i < q.MAX_ATTEMPTS(); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await pool.query("UPDATE art_jobs SET not_before = NULL WHERE state = 'queued'");
    // eslint-disable-next-line no-await-in-loop
    const [job] = await q.claim(pool, 10);
    assert.ok(job, `setup: attempt ${i + 1} should have claimed the job`);
    // eslint-disable-next-line no-await-in-loop
    await q.fail(pool, job.id, new Error('always fails'));
  }

  const { rows } = await pool.query('SELECT state, not_before FROM art_jobs');
  assert.equal(rows[0].state, 'failed', 'the attempt cap still terminates a poison subject');
  // A stale future timestamp here would make a manual requeue silently
  // unclaimable -- the operator sets state='queued' and nothing ever runs.
  assert.equal(rows[0].not_before, null, 'a failed row must not keep a pending delay');
});

lockedTest('nextClaimableAt separates an empty queue from a fully delayed one',
  async (t, pool) => {
    process.env.ART_JOB_RETRY_BASE_MS = '30000';

    assert.equal(await q.nextClaimableAt(pool), null, 'an empty queue has nothing to wait for');

    await enqueueOne(pool, 5);
    assert.equal(await q.nextClaimableAt(pool), null,
      'a job that is ready NOW must not report a wait -- that would idle a live batch');

    const [claimed] = await q.claim(pool, 10);
    await q.fail(pool, claimed.id, new Error('transient'));

    const next = await q.nextClaimableAt(pool);
    assert.ok(next, 'a fully delayed queue must report WHEN it becomes claimable');
    assert.ok(new Date(next) > new Date(), 'and that time must be in the future');
    // This is what stops startDrain ending a batch that still has work: without
    // it, claim() returning zero rows reads as "the queue is empty".
  });
