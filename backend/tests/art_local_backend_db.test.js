const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');
const request = require('supertest');
const { Pool } = require('pg');
const { adminToken, withAuth } = require('./helpers/auth.js');
const { app, __setPool, __setSpriteGen } = require('../src/index.js');
const queue = require('../src/services/artJobQueue.js');
const dispatcher = require('../src/services/artDispatcher.js');
const cs = require('../src/services/catalogSubjects.js');
const remote = require('../src/services/remoteImageProvider.js');
const { withAdvisoryLock, ART_JOBS_LOCK_KEY } = require('./helpers/advisoryLock.js');

// SOMET-535 rework, AC2: "every subject can be run local or via the connector,
// selected per run". The validator's repro: Backend=Local stored
// {backend:'local', provider_id:<the remote>} and the dispatcher drew it on the
// remote, because nothing read art_jobs.backend. These tests drive the real
// route and the real dispatcher and assert WHERE the job went.
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

// A PNG header saying RGBA, so the cutout header guard passes; the full-image
// transparency guard skips what it cannot decode.
const rgbaStore = {
  getObjectStream: async () => {
    const b = Buffer.alloc(32);
    b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47; b[25] = 6;
    return Readable.from([b]);
  },
};

async function freshPool(t) {
  const pool = new Pool({ connectionString: DB_URL, max: 6, connectionTimeoutMillis: 3000 });
  const { rows } = await pool.query(
    `INSERT INTO ai_providers (name, base_url, request_template, model)
     VALUES ($1, 'http://stub.invalid/sdapi/v1/txt2img',
             '{"width":512,"height":512,"prompt":"{{prompt}}"}'::jsonb, 'stub')
     RETURNING id`,
    [`zzTestLocalProvider ${process.pid} ${Date.now()}`],
  );
  const providerId = rows[0].id;
  __setPool({ query: withAuth((sql, params) => pool.query(sql, params)) });
  t.after(async () => {
    dispatcher.__resetRun();
    await pool.query("DELETE FROM catalog_art WHERE image LIKE 'zzTest%'").catch(() => {});
    await pool.query('DELETE FROM ai_providers WHERE id = $1', [providerId]).catch(() => {});
    await pool.end().catch(() => {});
  });
  return { pool, providerId };
}

// An ACTIVE remote provider for the duration of the body, restored in a
// finally (inside the lock, before the pool ends) -- the validator's repro
// depended on there being one, since that is what the old fallback picked.
async function withActive(pool, providerId, body) {
  const prev = await pool.query("SELECT id FROM ai_providers WHERE is_active AND modality = 'image'");
  await pool.query("UPDATE ai_providers SET is_active = false WHERE is_active AND modality = 'image'");
  await pool.query('UPDATE ai_providers SET is_active = true WHERE id = $1', [providerId]);
  try {
    await body();
  } finally {
    await pool.query('UPDATE ai_providers SET is_active = false WHERE id = $1', [providerId]);
    for (const r of prev.rows) {
      await pool.query('UPDATE ai_providers SET is_active = true WHERE id = $1', [r.id]);
    }
  }
}

// NO active image provider for the duration of the body. An unpinned tile
// resolves to the ACTIVE provider before the batch's, so a test that asserts
// the batch provider went red on any DB that had one (the dev DB has
// provider 5). Restored in a finally, inside the lock.
async function withNoActive(pool, body) {
  const prev = await pool.query("SELECT id FROM ai_providers WHERE is_active AND modality = 'image'");
  await pool.query("UPDATE ai_providers SET is_active = false WHERE is_active AND modality = 'image'");
  try {
    return await body();
  } finally {
    for (const r of prev.rows) {
      await pool.query('UPDATE ai_providers SET is_active = true WHERE id = $1', [r.id]);
    }
  }
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
        dispatcher.stopDrain();
        await pool.query('DELETE FROM art_jobs').catch(() => {});
      }
    });
  });
}

// --- Enqueue --------------------------------------------------------------

lockedTest('Backend=Local does not record the active remote provider on the job',
  async (t, pool, providerId) => {
    await withActive(pool, providerId, async () => {
      const [skill] = await cs.SUBJECTS.skill.list();
      // Exactly what the console sends under Local.
      const res = await request(app).post('/api/art-jobs').set(...AUTH)
        .send({ kind: 'skill', keys: [skill.key], backend: 'local', provider_id: null });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.queued, 1);

      const { rows } = await pool.query('SELECT backend, provider_id FROM art_jobs');
      assert.deepEqual(rows, [{ backend: 'local', provider_id: null }],
        'a local job must not carry a remote provider -- that is how it got drawn remotely');
    });
  });

lockedTest('a Local enqueue ignores a provider_id sent alongside it', async (t, pool, providerId) => {
  const [skill] = await cs.SUBJECTS.skill.list();
  const res = await request(app).post('/api/art-jobs').set(...AUTH)
    .send({ kind: 'skill', keys: [skill.key], backend: 'local', provider_id: providerId });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { rows } = await pool.query('SELECT backend, provider_id FROM art_jobs');
  assert.deepEqual(rows, [{ backend: 'local', provider_id: null }]);
});

// A tile pinned to ai_provider_mode='local' asked for sprite-gen by name. In a
// connector batch it used to be queued as {backend:'connector', provider_id:
// null} and then resolved to the batch's remote provider.
lockedTest('a tile pinned to local is queued as a local job inside a connector batch',
  async (t, pool, providerId) => {
    const [a, b] = await cs.SUBJECTS.tile.list(pool);
    const { rows: before } = await pool.query(
      'SELECT name, ai_provider_mode, ai_provider_id FROM tile_types WHERE name = $1', [a.key]);
    await pool.query(
      "UPDATE tile_types SET ai_provider_mode = 'local', ai_provider_id = NULL WHERE name = $1",
      [a.key]);
    try {
      const res = await withNoActive(pool, () => request(app).post('/api/art-jobs').set(...AUTH)
        .send({ kind: 'tile', keys: [a.key, b.key], backend: 'connector', provider_id: providerId }));
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const { rows } = await pool.query(
        'SELECT subject_key, backend, provider_id FROM art_jobs ORDER BY subject_key');
      const byKey = new Map(rows.map((r) => [r.subject_key, r]));
      assert.equal(byKey.get(a.key).backend, 'local',
        'the local pin must survive into the queue as a local job');
      assert.equal(byKey.get(a.key).provider_id, null);
      assert.equal(byKey.get(b.key).backend, 'connector');
      assert.equal(byKey.get(b.key).provider_id, providerId);
    } finally {
      await pool.query(
        'UPDATE tile_types SET ai_provider_mode = $1, ai_provider_id = $2 WHERE name = $3',
        [before[0].ai_provider_mode, before[0].ai_provider_id, a.key]);
    }
  });

// --- Dispatch -------------------------------------------------------------

lockedTest('a local job is drawn by the local generator, never by the remote provider',
  async (t, pool, providerId) => {
    const [skill] = await cs.SUBJECTS.skill.list();
    await queue.enqueue(pool, [{ kind: 'skill', key: skill.key }],
      { backend: 'local', providerId: null });

    const remoteCalls = [];
    const localCalls = [];
    const out = await dispatcher.dispatch(pool, {
      provider: { id: providerId, name: 'remote gpu', request_template: { width: 1024, height: 1024 } },
      generate: async (id, provider) => {
        remoteCalls.push(provider.id);
        remote.setJob(id, { status: 'done', result: { image_key: 'zzTest/remote.png' } });
      },
      localGenerate: async (id, provider, req) => {
        localCalls.push({ provider, req });
        remote.setJob(id, { status: 'done', result: { image_key: 'zzTest/local/static.png' } });
      },
      deps: { store: rgbaStore },
    });

    assert.equal(out.done, 1, JSON.stringify(out.results));
    assert.deepEqual(remoteCalls, [], 'the remote provider must not be called for a local job');
    assert.equal(localCalls.length, 1, 'the local generator must draw it');
    assert.equal(localCalls[0].provider.id, null);
    // sprite-gen wraps the subject itself (build_object_prompt); sending the
    // remote magenta-backdrop wrapper too would double-frame it.
    assert.doesNotMatch(localCalls[0].req.prompt, /magenta/i,
      'the local prompt is the plain subject, not the remote framing');
    assert.ok(localCalls[0].req.prompt.length > 0);

    const { rows } = await pool.query(
      'SELECT image, provider_id FROM catalog_art WHERE subject_kind = $1 AND subject_key = $2',
      ['skill', skill.key]);
    assert.deepEqual(rows, [{ image: 'zzTest/local/static.png', provider_id: null }],
      'the art must be recorded as locally drawn, not attributed to a remote provider');
  });

// The 1024px refusal is an SDXL rule for the REMOTE provider. sprite-gen picks
// its own size (and caps at 512), so a local row must neither be refused nor
// listed as blocked against the batch's provider.
lockedTest('local object jobs are not refused for the batch provider\'s size',
  async (t, pool, providerId) => {
    const skills = (await cs.SUBJECTS.skill.list()).slice(0, 2);
    await queue.enqueue(pool, skills.map((s) => ({ kind: 'skill', key: s.key })),
      { backend: 'local', providerId: null });
    const small = { id: providerId, name: 'terrain', request_template: { width: 512, height: 512 } };
    assert.equal(await dispatcher.objectSizeRefusal(pool, small), null);
  });

lockedTest('a local-only queue can be started without a provider', async (t, pool) => {
  const [skill] = await cs.SUBJECTS.skill.list();
  await queue.enqueue(pool, [{ kind: 'skill', key: skill.key }],
    { backend: 'local', providerId: null });

  const posted = [];
  __setSpriteGen({
    postGenerate: async (body) => { posted.push(body); return { job_id: 'deadbeef' }; },
    getJob: async () => ({ id: 'deadbeef', status: 'error', error: 'stub stop' }),
    getCapability: async () => ({ tier: 'cpu' }),
  });
  t.after(() => __setSpriteGen(require('../src/services/spriteGen.js')));

  const res = await request(app).post('/api/art-jobs/dispatch').set(...AUTH).send({});
  assert.equal(res.status, 202, JSON.stringify(res.body));
  // The drain runs in the background; wait for it to reach sprite-gen.
  for (let i = 0; i < 100 && posted.length === 0; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 20); });
  }
  dispatcher.stopDrain();
  assert.equal(posted.length, 1, 'the drain must send the local job to sprite-gen');
  for (let i = 0; i < 100 && dispatcher.runStatus().running; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 20); });
  }
});

lockedTest('connector jobs still need a provider to start', async (t, pool, providerId) => {
  const [skill] = await cs.SUBJECTS.skill.list();
  await queue.enqueue(pool, [{ kind: 'skill', key: skill.key }],
    { backend: 'connector', providerId });
  const res = await request(app).post('/api/art-jobs/dispatch').set(...AUTH).send({});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /provider_id is required/);
});

// The validator's mutation: dropping the connector check let a MIXED queue
// start provider-less, and nothing went red. A mixed queue must be refused,
// and refused for the right reason.
lockedTest('a mixed local + connector queue cannot start without a provider',
  async (t, pool, providerId) => {
    const [s1, s2] = await cs.SUBJECTS.skill.list();
    await queue.enqueue(pool, [{ kind: 'skill', key: s1.key }], { backend: 'local', providerId: null });
    await queue.enqueue(pool, [{ kind: 'skill', key: s2.key }], { backend: 'connector', providerId });
    const res = await request(app).post('/api/art-jobs/dispatch').set(...AUTH).send({});
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /holds 1 connector job/);
    assert.equal(dispatcher.runStatus().running, false, 'no drain may start');
  });

// An empty queue is refused with the TRUE reason, not "the queue holds
// connector jobs" (Start is enabled under Local, so this is reachable).
lockedTest('a provider-less start on an empty queue says nothing is queued', async () => {
  const res = await request(app).post('/api/art-jobs/dispatch').set(...AUTH).send({});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /nothing is queued/);
  assert.doesNotMatch(res.body.error, /connector/);
});

// A double-click on Start under Local: the running drain has already claimed
// the only local job, so the queue looks empty. The answer is the 409 the
// provider path gives, not a provider-less 400.
lockedTest('a provider-less start while a batch runs is a 409', async (t, pool) => {
  const [skill] = await cs.SUBJECTS.skill.list();
  await queue.enqueue(pool, [{ kind: 'skill', key: skill.key }], { backend: 'local', providerId: null });
  dispatcher.startDrain(pool, {
    provider: null,
    localGenerate: async () => new Promise((r) => { setTimeout(r, 400); }),
    writePromptForJob: async () => new Promise((r) => { setTimeout(r, 400); }),
    concurrency: 1,
  });
  t.after(() => { dispatcher.stopDrain(); dispatcher.__resetRun(); });
  // Wait until the drain has claimed the job, the state the second click saw.
  for (let i = 0; i < 100; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM art_jobs WHERE state = 'queued'");
    if (rows[0].n === 0) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 20); });
  }
  const res = await request(app).post('/api/art-jobs/dispatch').set(...AUTH).send({});
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error, /already running/);
  assert.equal(res.body.run.running, true);
});

// --- Unknown kinds ---------------------------------------------------------

// Defect 3: registryFor read SUBJECTS[kind] with no own-property check, so a
// prototype name resolved to a function and the route 500'd.
lockedTest('prototype-property kind names are a 400, not a 500', async () => {
  for (const kind of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const list = await request(app).get(`/api/art-subjects/${kind}`).set(...AUTH);
    assert.equal(list.status, 400, `GET ${kind}: ${JSON.stringify(list.body)}`);
    const queued = await request(app).post('/api/art-jobs').set(...AUTH)
      .send({ kind, keys: ['x'], backend: 'local' });
    assert.equal(queued.status, 400, `POST ${kind}: ${JSON.stringify(queued.body)}`);
  }
  assert.equal(cs.registryFor('constructor'), null);
  assert.equal(cs.registryFor('__proto__'), null);
});
