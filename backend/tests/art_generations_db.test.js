const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const history = require('../src/services/artGenerations.js');
const { withAdvisoryLock, ART_JOBS_LOCK_KEY } = require('./helpers/advisoryLock.js');

// SOMET-547. The record of what was actually sent.
//
// THE TEST THAT MATTERS IS THE FAILURE ONE. Asserting that a successful
// generation is recorded would pass against an implementation that only
// records successes -- which is exactly the implementation that would be
// useless, because the prompts worth reading are the ones that failed. Every
// case below is therefore weighted toward failure and toward the guarantee
// that bookkeeping cannot break generation.
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

function lockedTest(name, body) {
  test(name, async (t) => {
    if (!requireTestDb(t, 'writes art_generations')) return;
    const pool = new Pool({ connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000 });
    t.after(async () => { await pool.end().catch(() => {}); });
    await withAdvisoryLock(pool, ART_JOBS_LOCK_KEY, async () => {
      await pool.query("DELETE FROM art_generations WHERE subject_kind = 'skill'");
      try {
        await body(t, pool);
      } finally {
        await pool.query("DELETE FROM art_generations WHERE subject_kind = 'skill'").catch(() => {});
      }
    });
  });
}

const JOB = (key, extra = {}) => ({
  id: null, subject_kind: 'skill', subject_key: key, seed: 424242, ...extra,
});
const PROVIDER = { id: 5, model: 'sdxl+pixel-art-xl' };
const REQ = { prompt: 'only a wand and nothing else, flat solid neutral grey background',
  width: 1024, height: 1024, steps: 24, cfg_scale: 7 };

lockedTest('a FAILED attempt is recorded, with its prompt and its reason', async (t, pool) => {
  await history.record(pool, {
    job: JOB('h_fail'), provider: PROVIDER, req: REQ,
    outcome: 'failed', error: 'provider answered 422: cutout removed 97.9%',
  });

  const rows = await history.list(pool, 'skill', 'h_fail');
  assert.equal(rows.length, 1, 'a failure must be recorded -- it is the case this exists for');
  assert.equal(rows[0].outcome, 'failed');
  assert.match(rows[0].error, /cutout removed/);
  // The prompt is the point: without it a failure cannot be diagnosed later.
  assert.match(rows[0].composed_prompt, /neutral grey background/);
  assert.equal(String(rows[0].seed), '424242');
  assert.equal(rows[0].image_key, null);
});

lockedTest('every ATTEMPT is a row, so three failures are distinguishable', async (t, pool) => {
  for (const err of ['first reason', 'second reason', 'third reason']) {
    // eslint-disable-next-line no-await-in-loop
    await history.record(pool, {
      job: JOB('h_three'), provider: PROVIDER, req: REQ, outcome: 'failed', error: err,
    });
  }
  const rows = await history.list(pool, 'skill', 'h_three');
  assert.equal(rows.length, 3,
    'one row per attempt -- collapsing them loses "failed three DIFFERENT ways"');
  assert.deepEqual(rows.map((r) => r.error).sort(),
    ['first reason', 'second reason', 'third reason']);
});

lockedTest('a successful attempt records the image it produced', async (t, pool) => {
  await history.record(pool, {
    job: JOB('h_ok'), provider: PROVIDER, req: REQ, outcome: 'done', imageKey: 'sprites/x/y.png',
  });
  const [row] = await history.list(pool, 'skill', 'h_ok');
  assert.equal(row.outcome, 'done');
  assert.equal(row.image_key, 'sprites/x/y.png');
  assert.equal(row.params.width, 1024, 'the generation parameters travel with the record');
  assert.equal(row.params.steps, 24);
});

// THE GUARANTEE THIS MODULE EXISTS TO KEEP. An image that was generated, cut
// out and written to the catalogue has SUCCEEDED; a bookkeeping error must not
// turn that into a failure and send the subject round the retry loop again.
lockedTest('a broken history write never throws at its caller', async (t) => {
  const exploding = { query: async () => { throw new Error('table is gone'); } };
  await assert.doesNotReject(
    () => history.record(exploding, {
      job: JOB('h_boom'), provider: PROVIDER, req: REQ, outcome: 'done',
    }),
    'recording history must never fail the generation it is describing',
  );
});

// Credentials can ride along in a provider request's override blocks, and this
// table is read back into a browser. Parameters are whitelisted, not copied.
test('params are whitelisted, so a request cannot leak a secret into history', () => {
  const out = history.paramsFrom({
    width: 512, steps: 8, prompt: 'x',
    override_settings: { sd_model_checkpoint: 'm', api_key: 'sk-secret' },
    auth_token: 'sk-also-secret',
  });
  assert.deepEqual(out, { width: 512, steps: 8 });
  assert.equal(JSON.stringify(out).includes('secret'), false,
    'nothing outside the whitelist may reach a column the admin UI reads back');
});

test('paramsFrom tolerates a missing or malformed request', () => {
  assert.deepEqual(history.paramsFrom(null), {});
  assert.deepEqual(history.paramsFrom('nonsense'), {});
});
