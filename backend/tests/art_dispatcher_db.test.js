const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const queue = require('../src/services/artJobQueue.js');
const remote = require('../src/services/remoteImageProvider.js');
const { dispatch } = require('../src/services/artDispatcher.js');
const { withAdvisoryLock, ART_JOBS_LOCK_KEY } = require('./helpers/advisoryLock.js');

// SOMET-540. The dispatcher, against a real Postgres and a stubbed generator.
//
// The generator is stubbed on purpose: remoteImageProvider's own tests already
// cover the provider call, and re-driving it here would test that code twice
// while testing the dispatcher's actual job -- claim, run, record -- not at
// all. What is NOT stubbed is the queue: the state transitions are the thing
// under test and they are the database's behaviour.
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

// Same shared-table reasoning as art_job_queue_db.test.js: this file and that
// one both write art_jobs, and `claim()` is global, so both hold
// ART_JOBS_LOCK_KEY for the whole of every case.
//
// A real ai_providers row, because art_jobs.provider_id is a foreign key and
// a fixture id would only prove the FK is missing. Created per test and torn
// down with the jobs -- and the jobs go first, since the FK protects the
// provider from being deleted out from under them.
async function freshPool(t) {
  const pool = new Pool({ connectionString: DB_URL, max: 6, connectionTimeoutMillis: 3000 });
  const { rows } = await pool.query(
    `INSERT INTO ai_providers (name, base_url, request_template)
     VALUES ($1, 'http://stub.invalid/sdapi/v1/txt2img', '{}'::jsonb) RETURNING id`,
    [`zzTestProvider ${process.pid} ${Date.now()}`],
  );
  const providerId = rows[0].id;
  t.after(async () => {
    // NOT 'DELETE FROM art_jobs' here. t.after runs AFTER the advisory lock is
    // released, so a blanket delete at this point wipes a PEER FILE's in-flight
    // jobs -- three files now share ART_JOBS_LOCK_KEY and all three claim
    // globally. Measured: peers reported claimed:0 and failed on a job they had
    // just enqueued. This file's own rows are already cleaned inside the lock,
    // by lockedTest's finally.
    // The dispatcher now writes through to the subject's catalog on success
    // (SOMET-540), so these runs leave catalog_art rows for their fake skills.
    await pool.query("DELETE FROM catalog_art WHERE subject_key LIKE 'sk_%'").catch(() => {});
    await pool.query('DELETE FROM ai_providers WHERE id = $1', [providerId]).catch(() => {});
    await pool.end().catch(() => {});
  });
  return { pool, providerId };
}

function lockedTest(name, body) {
  test(name, async (t) => {
    if (!requireTestDb(t, 'writes art_jobs')) return;
    const { pool, providerId } = await freshPool(t);
    await withAdvisoryLock(pool, ART_JOBS_LOCK_KEY, async () => {
      await pool.query('DELETE FROM art_jobs');
      try {
        await body(t, pool, providerId);
      } finally {
        await pool.query('DELETE FROM art_jobs').catch(() => {});
      }
    });
  });
}

// A FUNCTION of the real row's id, not a hardcoded 5. The dispatcher now
// records which provider drew each image (catalog_art.provider_id), so a made
// -up id is a foreign-key violation rather than an unused decoration.
const PROVIDER = (id) => ({ id, name: 'stub gpu', base_url: 'http://stub/sdapi/v1/txt2img' });
const buildRequest = (job) => ({
  subject: job.subject_key, kind: 'object', prompt: `a ${job.subject_key}`, seed: Number(job.seed),
});
const S = (n) => ({ kind: 'skill', key: `sk_${n}` });

// A stub standing in for runGeneration: it reports through the SAME registry
// the real one uses, so the dispatcher's reading of the outcome is exercised
// exactly as it will be in production.
const succeed = (key = 'sprites/objects/x/1/static.png') => async (registryId) => {
  remote.setJob(registryId, { status: 'done', result: { image_key: key, frames: 1 } });
};
const failWith = (message) => async (registryId) => {
  remote.setJob(registryId, { status: 'error', error: message });
};

lockedTest('a successful generation marks the job done', async (t, pool, providerId) => {
  await queue.enqueue(pool, [S(1)], { backend: 'connector', providerId });

  const out = await dispatch(pool, { provider: PROVIDER(providerId), generate: succeed(), buildRequest });
  assert.equal(out.claimed, 1);
  assert.equal(out.done, 1);
  assert.equal(out.failed, 0);

  const { rows } = await pool.query('SELECT state, last_error FROM art_jobs');
  assert.equal(rows[0].state, 'done');
  assert.equal(rows[0].last_error, null);
});

lockedTest('a provider failure requeues the job and records the reason', async (t, pool, providerId) => {
  await queue.enqueue(pool, [S(1)], { backend: 'connector', providerId });

  const out = await dispatch(pool, {
    provider: PROVIDER(providerId), generate: failWith('provider answered 500: out of memory'), buildRequest,
  });
  assert.equal(out.failed, 1);

  const { rows } = await pool.query('SELECT state, attempts, last_error FROM art_jobs');
  assert.equal(rows[0].state, 'queued', 'one failure must not end the job while attempts remain');
  assert.equal(rows[0].attempts, 1);
  assert.match(rows[0].last_error, /out of memory/,
    'the provider message must survive to the row -- a swallowed error is unfixable');
});

lockedTest('a job that keeps failing eventually stops rather than cycling', async (t, pool, providerId) => {
  await queue.enqueue(pool, [S(1)], { backend: 'connector', providerId });
  const max = queue.MAX_ATTEMPTS();
  for (let i = 0; i < max; i++) {
    await dispatch(pool, { provider: PROVIDER(providerId), generate: failWith('nope'), buildRequest });
  }
  const { rows } = await pool.query('SELECT state, attempts FROM art_jobs');
  assert.equal(rows[0].state, 'failed');
  assert.equal(rows[0].attempts, max);
  assert.equal((await dispatch(pool, { provider: PROVIDER(providerId), generate: succeed(), buildRequest })).claimed, 0,
    'a failed job must not be picked up again on its own');
});

// An exception escaping the generator must not take the loop down and leave
// the row wedged in `running` until requeueStale notices it an hour later.
lockedTest('an unexpected throw is recorded as a failure, not left running', async (t, pool, providerId) => {
  await queue.enqueue(pool, [S(1), S(2)], { backend: 'connector', providerId });

  let calls = 0;
  const explodeOnce = async (registryId) => {
    calls += 1;
    if (calls === 1) throw new Error('socket exploded');
    remote.setJob(registryId, { status: 'done', result: { image_key: 'k', frames: 1 } });
  };
  const out = await dispatch(pool, {
    provider: PROVIDER(providerId), generate: explodeOnce, buildRequest, concurrency: 1,
  });
  assert.equal(out.claimed, 2);
  assert.equal(out.done, 1, 'the second job must still run after the first threw');
  assert.equal(out.failed, 1);

  const { rows } = await pool.query("SELECT count(*)::int n FROM art_jobs WHERE state='running'");
  assert.equal(rows[0].n, 0, 'no row may be left claimed after the loop returns');
});

// The dispatcher must not mark a job done on no evidence. The registry is TTL-
// and size-bounded, so its entry can vanish mid-run; "I cannot see a result"
// is a failure, not a success.
lockedTest('an evicted registry result is a failure, never a silent success', async (t, pool, providerId) => {
  await queue.enqueue(pool, [S(1)], { backend: 'connector', providerId });

  const evict = async () => { remote.__resetJobs(); };
  const out = await dispatch(pool, { provider: PROVIDER(providerId), generate: evict, buildRequest });
  assert.equal(out.done, 0);
  assert.equal(out.failed, 1);
  const { rows } = await pool.query('SELECT last_error FROM art_jobs');
  assert.match(rows[0].last_error, /evicted/);
});

lockedTest('concurrency runs several at once and every claimed job is resolved', async (t, pool, providerId) => {
  await queue.enqueue(pool, Array.from({ length: 12 }, (_, i) => S(i)),
    { backend: 'connector', providerId });

  let inFlight = 0;
  let peak = 0;
  const slow = async (registryId) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => { setTimeout(r, 20); });
    inFlight -= 1;
    remote.setJob(registryId, { status: 'done', result: { image_key: 'k', frames: 1 } });
  };

  const out = await dispatch(pool, {
    provider: PROVIDER(providerId), generate: slow, buildRequest, limit: 12, concurrency: 4,
  });
  assert.equal(out.claimed, 12);
  assert.equal(out.done, 12);
  assert.ok(peak > 1, `expected real parallelism, peak in-flight was ${peak}`);
  assert.ok(peak <= 4, `concurrency cap breached: peak in-flight was ${peak}`);

  const { rows } = await pool.query(
    "SELECT count(*)::int n FROM art_jobs WHERE state <> 'done'");
  assert.equal(rows[0].n, 0, 'every claimed job must reach a terminal state');
});

lockedTest('dispatch on an empty queue is a no-op, not an error', async (t, pool, providerId) => {
  const out = await dispatch(pool, { provider: PROVIDER(providerId), generate: succeed(), buildRequest });
  assert.deepEqual(out, { claimed: 0, done: 0, failed: 0, results: [] });
});
