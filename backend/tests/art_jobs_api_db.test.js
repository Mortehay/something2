const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Pool } = require('pg');
const { adminToken, withAuth } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');
const queue = require('../src/services/artJobQueue.js');
const dispatcher = require('../src/services/artDispatcher.js');
const cs = require('../src/services/catalogSubjects.js');
const { withAdvisoryLock, ART_JOBS_LOCK_KEY } = require('./helpers/advisoryLock.js');

// SOMET-540. The admin surface SOMET-538's table will drive.
//
// A REAL pool, not a mock. Nearly everything these routes do is a database
// behaviour -- pagination over the live catalogue, the partial unique index
// refusing a duplicate enqueue, has_art coming from committed rows. A mocked
// pool would assert the SQL strings in index.js and prove nothing about any of
// that, which is the exact shape of test this repo keeps finding green over
// broken code.
const AUTH = ['Authorization', `Bearer ${adminToken()}`];
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
  const { rows } = await pool.query(
    `INSERT INTO ai_providers (name, base_url, request_template, model)
     VALUES ($1, 'http://stub.invalid/sdapi/v1/txt2img',
             '{"width":1024,"height":1024,"prompt":"{{prompt}}"}'::jsonb, 'stub')
     RETURNING id`,
    [`zzTestApiProvider ${process.pid} ${Date.now()}`],
  );
  const providerId = rows[0].id;
  // The app gets a WRAPPED pool: guardPool forwards to whatever __setPool holds,
  // and the guard's `SELECT token_version, role FROM users` has no answer in a
  // scratch database. withAuth answers that one lookup and passes everything
  // else through to the real connection, so the routes still run real SQL.
  __setPool({ query: withAuth((sql, params) => pool.query(sql, params)) });
  t.after(async () => {
    // Not a blanket DELETE FROM art_jobs: t.after runs outside the advisory
    // lock, so it would wipe a peer file's in-flight jobs.
    dispatcher.__resetRun();
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
      dispatcher.__resetRun();
      try {
        await body(t, pool, providerId);
      } finally {
        await pool.query('DELETE FROM art_jobs').catch(() => {});
      }
    });
  });
}

// --- Listing --------------------------------------------------------------

lockedTest('GET /api/art-subjects pages the catalogue 100 at a time', async (t) => {
  const res = await request(app).get('/api/art-subjects/skill?page=1&per_page=100').set(...AUTH);
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 300, 'all 300 class skills must be pageable');
  assert.equal(res.body.subjects.length, 100);
  assert.equal(res.body.page, 1);

  const p2 = await request(app).get('/api/art-subjects/skill?page=2&per_page=100').set(...AUTH);
  assert.equal(p2.body.subjects.length, 100);
  assert.notEqual(p2.body.subjects[0].key, res.body.subjects[0].key,
    'page 2 must be different subjects, or paging is decorative');

  const p4 = await request(app).get('/api/art-subjects/skill?page=4&per_page=100').set(...AUTH);
  assert.equal(p4.body.subjects.length, 0, 'past the end is empty, not an error');
});

// The response carries `row` internally -- the whole catalogue row. Shipping it
// would send the catalog twice on every page.
lockedTest('a page carries only the named fields, not the whole catalogue row', async (t) => {
  const res = await request(app).get('/api/art-subjects/item?per_page=1').set(...AUTH);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body.subjects[0]).sort(),
    ['base_prompt', 'has_art', 'image', 'job_error', 'job_state', 'key', 'kind',
      'name', 'render_mode', 'updated_at']);
  assert.equal(res.body.subjects[0].row, undefined,
    'the catalogue row must never be shipped -- it doubles every page');
});

lockedTest('an unknown subject kind is a 400 that names the valid ones', async (t) => {
  const res = await request(app).get('/api/art-subjects/nonsense').set(...AUTH);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.kinds.sort(),
    ['entity', 'item', 'passive_label', 'skill', 'tile']);
});

// THE RESUME MECHANISM. A batch is resumable because the filter reads the
// catalog, so a subject generated an hour ago simply stops appearing -- no
// progress counter to drift.
lockedTest('missing_only drops a subject the moment it has art', async (t, pool) => {
  const before = await request(app)
    .get('/api/art-subjects/skill?missing_only=true&per_page=500').set(...AUTH);
  const target = before.body.subjects[0];
  assert.ok(target, 'expected at least one skill without art');

  // Cleaned up INSIDE the lock, not in t.after. t.after runs after the advisory
  // lock is released, so the row would outlive this file's exclusive window --
  // and a peer file asserting "this skill has no art" would see it and fail.
  // Measured: that is exactly what made art_dispatcher_catalog_db's
  // transparency test fail intermittently in full-suite runs.
  await cs.writeCatalogArt(pool, 'skill', target.key, 'zzTest/resume.png');
  try {
    const after = await request(app)
      .get('/api/art-subjects/skill?missing_only=true&per_page=500').set(...AUTH);
    assert.equal(after.body.total, before.body.total - 1);
    assert.ok(!after.body.subjects.some((s) => s.key === target.key),
      'a subject with art must leave the missing list, or a resumed batch redraws it');
  } finally {
    await pool.query('DELETE FROM catalog_art WHERE image = $1', ['zzTest/resume.png'])
      .catch(() => {});
  }
});

// --- Queueing -------------------------------------------------------------

lockedTest('POST /api/art-jobs queues a selection and reports what was already live',
  async (t, pool, providerId) => {
    const keys = (await cs.SUBJECTS.skill.list()).slice(0, 5).map((s) => s.key);

    const first = await request(app).post('/api/art-jobs').set(...AUTH)
      .send({ kind: 'skill', keys: keys.slice(0, 3), provider_id: providerId });
    assert.equal(first.status, 201);
    assert.equal(first.body.queued, 3);
    assert.equal(first.body.already_live, 0);

    // Overlapping selection -- two admins on overlapping pages, or a double
    // click. The index refuses the duplicates; the route says so plainly.
    const second = await request(app).post('/api/art-jobs').set(...AUTH)
      .send({ kind: 'skill', keys, provider_id: providerId });
    assert.equal(second.body.requested, 5);
    assert.equal(second.body.queued, 2, 'only the genuinely new subjects');
    assert.equal(second.body.already_live, 3);

    const { rows } = await pool.query('SELECT count(*)::int n FROM art_jobs');
    assert.equal(rows[0].n, 5, 'a duplicate enqueue must not double the batch');
  });

lockedTest('queueing rejects an empty selection and an unknown kind', async (t, pool, providerId) => {
  const empty = await request(app).post('/api/art-jobs').set(...AUTH)
    .send({ kind: 'skill', keys: [], provider_id: providerId });
  assert.equal(empty.status, 400);

  const bad = await request(app).post('/api/art-jobs').set(...AUTH)
    .send({ kind: 'nonsense', keys: ['x'], provider_id: providerId });
  assert.equal(bad.status, 400);

  const noProvider = await request(app).post('/api/art-jobs').set(...AUTH)
    .send({ kind: 'skill', keys: ['x'] });
  assert.equal(noProvider.status, 400,
    'the connector backend with no provider AND no active one would queue work nothing can run');
  assert.match(noProvider.body.error, /no active provider/,
    'the message must say WHICH thing is missing -- "provider_id is required" sends '
    + 'the admin looking for a field they deliberately left on its default');
});

// Omitting provider_id means "the active provider", which is what the console's
// default option says. Asserted with an active provider present, because the
// case above only proves the refusal when there is none -- and a fallback that
// never fires would pass that test while the default button silently 400'd.
// That is exactly what the browser showed before this was fixed.
lockedTest('omitting provider_id falls back to the ACTIVE provider', async (t, pool, providerId) => {
  const prev = await pool.query('SELECT id FROM ai_providers WHERE is_active');
  await pool.query('UPDATE ai_providers SET is_active = false WHERE is_active');
  await pool.query('UPDATE ai_providers SET is_active = true WHERE id = $1', [providerId]);
  t.after(async () => {
    await pool.query('UPDATE ai_providers SET is_active = false WHERE id = $1', [providerId])
      .catch(() => {});
    for (const r of prev.rows) {
      await pool.query('UPDATE ai_providers SET is_active = true WHERE id = $1', [r.id])
        .catch(() => {});
    }
  });

  const keys = (await cs.SUBJECTS.skill.list()).slice(0, 2).map((s) => s.key);
  const res = await request(app).post('/api/art-jobs').set(...AUTH)
    .send({ kind: 'skill', keys });          // no provider_id at all
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.queued, 2);

  const { rows } = await pool.query('SELECT DISTINCT provider_id FROM art_jobs');
  assert.deepEqual(rows.map((r) => r.provider_id), [providerId],
    'the jobs must carry the active provider, not null');
});

lockedTest('GET /api/art-jobs reports the queue by state', async (t, pool, providerId) => {
  const keys = (await cs.SUBJECTS.skill.list()).slice(0, 3).map((s) => s.key);
  await queue.enqueue(pool, keys.map((key) => ({ kind: 'skill', key })),
    { backend: 'connector', providerId });

  const res = await request(app).get('/api/art-jobs').set(...AUTH);
  assert.equal(res.status, 200);
  assert.equal(res.body.stats.queued, 3);
  assert.equal(res.body.run.running, false);
});

// --- Dispatch -------------------------------------------------------------

// THE PRECONDITION, at the surface an admin actually touches. A 512 provider
// silently returns sprite sheets that pass every automated check.
lockedTest('dispatch refuses a below-native provider with an actionable 400',
  async (t, pool, providerId) => {
    await pool.query(
      `UPDATE ai_providers SET request_template = '{"width":512,"height":512}'::jsonb
        WHERE id = $1`, [providerId],
    );
    const res = await request(app).post('/api/art-jobs/dispatch').set(...AUTH)
      .send({ provider_id: providerId });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /1024px minimum/);
    assert.match(res.body.error, /request_template/, 'the message must say how to fix it');
    assert.equal(dispatcher.runStatus().running, false, 'nothing may have started');
  });

lockedTest('dispatch requires a provider that exists', async (t) => {
  assert.equal((await request(app).post('/api/art-jobs/dispatch').set(...AUTH).send({})).status, 400);
  const missing = await request(app).post('/api/art-jobs/dispatch').set(...AUTH)
    .send({ provider_id: 2147483600 });
  assert.equal(missing.status, 404);
});

// A second drain is not a speed-up: SKIP LOCKED keeps it safe, but two drains
// against one remote make the concurrency cap a lie.
lockedTest('a second dispatch while one runs is a 409, not a second drain',
  async (t, pool, providerId) => {
    // Real queued work, or the drain finds an empty queue and exits before the
    // request below is even sent -- which is what made the first version of
    // this test pass a 202 and prove nothing.
    const keys = (await cs.SUBJECTS.skill.list()).slice(0, 6).map((s) => s.key);
    await queue.enqueue(pool, keys.map((key) => ({ kind: 'skill', key })),
      { backend: 'connector', providerId });

    dispatcher.__resetRun();
    dispatcher.startDrain(pool, {
      provider: { id: providerId, request_template: { width: 1024, height: 1024 } },
      generate: async () => new Promise((r) => { setTimeout(r, 400); }),
      concurrency: 1,
    });
    t.after(() => { dispatcher.stopDrain(); dispatcher.__resetRun(); });

    const res = await request(app).post('/api/art-jobs/dispatch').set(...AUTH)
      .send({ provider_id: providerId });
    assert.equal(res.status, 409);
    assert.equal(res.body.run.running, true);
  });

lockedTest('stop is idempotent and answers honestly when nothing is running', async (t) => {
  dispatcher.__resetRun();
  const res = await request(app).post('/api/art-jobs/stop').set(...AUTH).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.stopping, false, 'stopping nothing must not claim it stopped something');
});

// --- Stale rescue ---------------------------------------------------------

lockedTest('requeue-stale rescues a job whose worker died, and spares a live one',
  async (t, pool, providerId) => {
    const keys = (await cs.SUBJECTS.skill.list()).slice(0, 2).map((s) => s.key);
    await queue.enqueue(pool, keys.map((key) => ({ kind: 'skill', key })),
      { backend: 'connector', providerId });
    await queue.claim(pool, 2);

    const live = await request(app).post('/api/art-jobs/requeue-stale').set(...AUTH)
      .send({ older_than_ms: 3600000 });
    assert.equal(live.body.requeued, 0, 'a freshly claimed job must not be taken from a live worker');

    await pool.query("UPDATE art_jobs SET claimed_at = now() - interval '2 hours'");
    const dead = await request(app).post('/api/art-jobs/requeue-stale').set(...AUTH)
      .send({ older_than_ms: 3600000 });
    assert.equal(dead.body.requeued, 2);
    assert.equal(dead.body.stats.queued, 2);
  });

// --- The guard ------------------------------------------------------------

test('every art route is behind the admin guard', async (t) => {
  for (const [method, path] of [
    ['get', '/api/art-subjects/skill'], ['get', '/api/art-jobs'],
    ['post', '/api/art-jobs'], ['post', '/api/art-jobs/dispatch'],
    ['post', '/api/art-jobs/stop'], ['post', '/api/art-jobs/requeue-stale'],
  ]) {
    const res = await request(app)[method](path).send({});
    assert.ok(res.status === 401 || res.status === 403,
      `${method.toUpperCase()} ${path} answered ${res.status} without a token`);
  }
});

// --- SOMET-544: requeue is scoped by CAUSE, and refuses pointless retries ---
//
// The rule is enforced SERVER-SIDE on purpose. Hiding the button would leave
// it unenforced for anything calling the API directly, and the reason it must
// not be retried is a property of the data model (seedFor derives the seed
// from the subject), not of the UI.
lockedTest('a plain requeue of a content failure is refused, with the reason', async (t, pool) => {
  const [job] = await queue.enqueue(pool, [{ kind: 'skill', key: 'rq_content' }],
    { backend: 'connector' });
  await pool.query(
    `UPDATE art_jobs SET state='failed', attempts=3,
        last_error='provider answered 422: {"detail":"cutout removed 97.9% of the image"}'
      WHERE id=$1`, [job.id],
  );

  const refused = await request(app).post('/api/art-jobs/requeue')
    .set(...AUTH).send({ kind: 'content_cutout' });
  assert.equal(refused.status, 409, 'a retry that cannot work must be refused, not accepted');
  assert.match(refused.body.error, /same image/i, 'and it must say WHY');
  assert.equal(refused.body.action, 'reseed');

  const still = await pool.query('SELECT state FROM art_jobs WHERE id=$1', [job.id]);
  assert.equal(still.rows[0].state, 'failed', 'the refusal must not have queued it anyway');

  // The same call WITH reseed is allowed, and must change the seed -- a
  // requeue that kept the seed would be the refused operation wearing a flag.
  const before = await pool.query('SELECT seed FROM art_jobs WHERE id=$1', [job.id]);
  const ok = await request(app).post('/api/art-jobs/requeue')
    .set(...AUTH).send({ kind: 'content_cutout', reseed: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.requeued, 1);
  const after = await pool.query('SELECT state, seed FROM art_jobs WHERE id=$1', [job.id]);
  assert.equal(after.rows[0].state, 'queued');
  assert.notEqual(String(after.rows[0].seed), String(before.rows[0].seed),
    'reseed must actually change the seed, or the retry reproduces the same image');
});

lockedTest('a new seed is refused for a CONFIG failure -- it cannot help', async (t, pool) => {
  const [job] = await queue.enqueue(pool, [{ kind: 'skill', key: 'rq_config' }],
    { backend: 'connector' });
  await pool.query(
    `UPDATE art_jobs SET state='failed', attempts=3,
        last_error='provider "x" renders at 512x512, below the 1024px minimum for an isolated object'
      WHERE id=$1`, [job.id],
  );
  const res = await request(app).post('/api/art-jobs/requeue')
    .set(...AUTH).send({ kind: 'config', reseed: true });
  assert.equal(res.status, 409, 'a different seed does not fix a misconfigured provider');
  assert.equal(res.body.action, 'fix_config');
});

lockedTest('a provider failure requeues plainly, keeping its seed', async (t, pool) => {
  const [job] = await queue.enqueue(pool, [{ kind: 'skill', key: 'rq_prov' }],
    { backend: 'connector' });
  await pool.query(
    `UPDATE art_jobs SET state='failed', attempts=3,
        last_error='provider answered 500: {"detail":"!handles_.at(i) INTERNAL ASSERT FAILED"}'
      WHERE id=$1`, [job.id],
  );
  const before = await pool.query('SELECT seed FROM art_jobs WHERE id=$1', [job.id]);
  const res = await request(app).post('/api/art-jobs/requeue').set(...AUTH)
    .send({ kind: 'provider_fault' });
  assert.equal(res.status, 200);
  assert.equal(res.body.requeued, 1);
  const after = await pool.query('SELECT state, attempts, seed FROM art_jobs WHERE id=$1', [job.id]);
  assert.equal(after.rows[0].state, 'queued');
  assert.equal(after.rows[0].attempts, 0, 'a provider fault should not count against the subject');
  assert.equal(String(after.rows[0].seed), String(before.rows[0].seed),
    'a provider failure keeps its seed -- the image was never the problem');
});
