const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const q = require('../src/services/artJobQueue.js');

// SOMET-540. The durable art queue, against a REAL Postgres.
//
// These cannot be unit tests with a fake db. The two properties that matter --
// that two workers never claim the same subject, and that a duplicate enqueue
// is refused by a partial unique index -- are properties of the DATABASE, not
// of this JavaScript. A mock would assert the SQL I wrote, not the behaviour
// Postgres gives it, which is exactly the shape of test this repo keeps
// finding green over broken code.
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
  const pool = new Pool({ connectionString: DB_URL, max: 6, connectionTimeoutMillis: 3000 });
  await pool.query('DELETE FROM art_jobs');
  t.after(async () => {
    await pool.query('DELETE FROM art_jobs').catch(() => {});
    await pool.end().catch(() => {});
  });
  return pool;
}

const S = (n) => ({ kind: 'skill', key: `sk_${n}` });

test('seedFor is stable per subject and different between subjects', () => {
  assert.equal(q.seedFor('skill', 'war_crushing_blow'), q.seedFor('skill', 'war_crushing_blow'),
    'the same subject must reproduce the same seed, or a regeneration is a dice roll');
  assert.notEqual(q.seedFor('skill', 'war_crushing_blow'), q.seedFor('skill', 'mag_fireball'),
    'different subjects must not share a seed -- that is how 50 tiles became one composition');
  // The salt is the escape hatch for "this subject came out badly, try again".
  assert.notEqual(q.seedFor('skill', 'x'), q.seedFor('skill', 'x', 1));
  // Kind participates, so the same key under two kinds is not the same image.
  assert.notEqual(q.seedFor('skill', 'focus'), q.seedFor('passive_label', 'focus'));
});

test('seeds stay inside the signed 32-bit range backends accept', () => {
  for (let i = 0; i < 500; i++) {
    const s = q.seedFor('item', `it_${i}`);
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 0x7fffffff, `seed ${s} out of range`);
  }
});

test('enqueue inserts one job per subject and records the derived seed', async (t) => {
  if (!requireTestDb(t, 'writes art_jobs')) return;
  const pool = await freshPool(t);
  const rows = await q.enqueue(pool, [S(1), S(2), S(3)], { backend: 'connector', providerId: null });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.subject_key).sort(), ['sk_1', 'sk_2', 'sk_3']);
  for (const r of rows) {
    assert.equal(r.state, 'queued');
    assert.equal(r.attempts, 0);
    assert.equal(Number(r.seed), q.seedFor(r.subject_kind, r.subject_key),
      'the stored seed must be the derived one, or a re-run draws something else');
  }
});

// THE IDEMPOTENCY GUARANTEE. Written as an application check this is a
// check-then-act race; the partial unique index makes it the database's
// problem. Asserted through the real index, not by reading the SQL.
test('enqueueing a subject that is already live does NOT create a second job', async (t) => {
  if (!requireTestDb(t, 'writes art_jobs')) return;
  const pool = await freshPool(t);
  const first = await q.enqueue(pool, [S(1), S(2)], { backend: 'connector' });
  assert.equal(first.length, 2);

  // Overlapping selection, exactly what two admins on overlapping pages send.
  const second = await q.enqueue(pool, [S(2), S(3)], { backend: 'connector' });
  assert.deepEqual(second.map((r) => r.subject_key), ['sk_3'],
    'only the genuinely new subject may be created');

  const { rows } = await pool.query('SELECT count(*)::int n FROM art_jobs');
  assert.equal(rows[0].n, 3, 'sk_2 must not have been queued twice');
});

test('a job that is running also blocks a duplicate enqueue', async (t) => {
  if (!requireTestDb(t, 'writes art_jobs')) return;
  const pool = await freshPool(t);
  await q.enqueue(pool, [S(1)], { backend: 'connector' });
  await q.claim(pool, 1); // now running, not queued
  const again = await q.enqueue(pool, [S(1)], { backend: 'connector' });
  assert.deepEqual(again, [], 'a subject already in flight must not be re-queued');
});

// The counterpart: the index is PARTIAL on purpose. If it covered every state,
// a failed subject could never be retried -- permanently unfixable art.
test('a subject may be enqueued again once its job is done or failed', async (t) => {
  if (!requireTestDb(t, 'writes art_jobs')) return;
  const pool = await freshPool(t);
  const [a] = await q.enqueue(pool, [S(1)], { backend: 'connector' });
  await q.claim(pool, 1);
  await q.complete(pool, a.id);
  const retry = await q.enqueue(pool, [S(1)], { backend: 'connector' });
  assert.equal(retry.length, 1, 'a completed subject must be re-generatable');
});

// THE CONCURRENCY GUARANTEE, exercised concurrently. A sequential test would
// pass against a plain SELECT-then-UPDATE, which is the bug this is for.
test('two concurrent claimers never take the same job', async (t) => {
  if (!requireTestDb(t, 'writes art_jobs')) return;
  const pool = await freshPool(t);
  const subjects = Array.from({ length: 40 }, (_, i) => S(i));
  await q.enqueue(pool, subjects, { backend: 'connector' });

  // Six claimers, in parallel, each asking for more than a fair share so they
  // genuinely contend for the same rows.
  const results = await Promise.all(
    Array.from({ length: 6 }, () => q.claim(pool, 20)),
  );
  const claimed = results.flat().map((r) => r.id);
  const unique = new Set(claimed);
  assert.equal(claimed.length, unique.size,
    `a job was claimed twice (${claimed.length} claims, ${unique.size} distinct)`);
  assert.equal(claimed.length, 40, 'every queued job should be claimed exactly once');

  const { rows } = await pool.query("SELECT count(*)::int n FROM art_jobs WHERE state='running'");
  assert.equal(rows[0].n, 40);
});

test('claim marks running, stamps claimed_at and counts the attempt', async (t) => {
  if (!requireTestDb(t, 'writes art_jobs')) return;
  const pool = await freshPool(t);
  await q.enqueue(pool, [S(1)], { backend: 'connector' });
  const [job] = await q.claim(pool, 1);
  assert.equal(job.state, 'running');
  assert.equal(job.attempts, 1, 'attempts counts at CLAIM time, so a worker that dies still burns one');
  assert.ok(job.claimed_at, 'claimed_at must be stamped, or requeueStale cannot find a lost job');
  assert.deepEqual(await q.claim(pool, 5), [], 'a running job must not be claimable again');
});

test('fail returns a job to the queue while attempts remain, then gives up', async (t) => {
  if (!requireTestDb(t, 'writes art_jobs')) return;
  const pool = await freshPool(t);
  const [a] = await q.enqueue(pool, [S(1)], { backend: 'connector' });
  const max = q.MAX_ATTEMPTS();

  for (let i = 1; i < max; i++) {
    await q.claim(pool, 1);
    const r = await q.fail(pool, a.id, new Error(`attempt ${i} exploded`));
    assert.equal(r.state, 'queued', `attempt ${i} of ${max} should still retry`);
    assert.match(r.last_error, /exploded/, 'the provider error must be recorded, not swallowed');
    assert.equal(r.claimed_at, null, 'a requeued job must not look claimed');
  }
  await q.claim(pool, 1);
  const last = await q.fail(pool, a.id, new Error('final'));
  assert.equal(last.state, 'failed', 'retries must be bounded');
  assert.equal(last.attempts, max);
});

// What makes a batch survive OUR restart: rows left 'running' by a process
// that died are returned to the queue.
test('requeueStale rescues jobs whose worker died holding them', async (t) => {
  if (!requireTestDb(t, 'writes art_jobs')) return;
  const pool = await freshPool(t);
  await q.enqueue(pool, [S(1), S(2)], { backend: 'connector' });
  await q.claim(pool, 2);

  // Nothing is stale yet -- the guard against a requeue that steals jobs from
  // a worker that is simply still working.
  assert.deepEqual(await q.requeueStale(pool, 60_000), [],
    'a freshly claimed job must not be rescued out from under a live worker');

  // Backdate the claim rather than sleeping.
  await pool.query("UPDATE art_jobs SET claimed_at = now() - interval '1 hour'");
  const rescued = await q.requeueStale(pool, 60_000);
  assert.equal(rescued.length, 2);
  for (const r of rescued) {
    assert.equal(r.state, 'queued');
    assert.match(r.last_error, /worker presumed lost/);
  }
  assert.equal((await q.claim(pool, 5)).length, 2, 'rescued jobs must be claimable again');
});

test('stats reports the queue by state', async (t) => {
  if (!requireTestDb(t, 'writes art_jobs')) return;
  const pool = await freshPool(t);
  const rows = await q.enqueue(pool, [S(1), S(2), S(3)], { backend: 'connector' });
  await q.claim(pool, 1);
  await q.complete(pool, rows[0].id);
  const s = await q.stats(pool);
  assert.equal(s.queued, 2);
  assert.equal(s.done, 1);
});
