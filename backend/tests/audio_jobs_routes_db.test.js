// backend/tests/audio_jobs_routes_db.test.js
//
// Real-HTTP, real-DB coverage for the batch job routes (SOMET-591, game
// audio slice 2): POST/GET /api/audio/admin/jobs, dispatch, stop,
// retry-failed and clear. Every route-started drain runs with whatever
// audioDispatcher.__setDeps() last set (Task 3's test seam), so this file
// never reaches the real GPU box for generation -- only resolveAudioProvider
// stays real (a genuine DB lookup against a provider row this file creates
// and owns), which is what lets the 503/no_provider preflight and a
// route-started drain both resolve without touching anything else's
// "active" provider.
require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');
const { withAdvisoryLock, AUDIO_JOBS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const { restoringForeignJobs } = require('./helpers/foreignAudioJobs.js');
const audioDispatcher = require('../src/services/audioDispatcher');
const { promptPhaseStub } = require('./helpers/audioPromptPhaseStub.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;

async function makeUser(pool, role, tag) {
  const username = `audio-jobs-${role}-${tag}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version',
    [username, 'x', role]);
  return { id: r.rows[0].id, username, role, tokenVersion: r.rows[0].token_version };
}
const bearer = (u) => `Bearer ${signToken({ userId: u.id, username: u.username, role: u.role, tokenVersion: u.tokenVersion })}`;

async function waitIdle(admin, timeoutMs = 10000) {
  const t0 = Date.now();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request(app).get('/api/audio/admin/jobs').set('Authorization', bearer(admin));
    if (!res.body.run.running) return res.body;
    if (Date.now() - t0 > timeoutMs) {
      // Stop the drain before failing -- a zombie drain left running would
      // keep claiming and mutating rows for every subtest that runs after.
      audioDispatcher.stopDrain();
      throw new Error('drain did not finish in time');
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 20); });
  }
}

async function waitForCurrent(admin, subjectKey, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request(app).get('/api/audio/admin/jobs').set('Authorization', bearer(admin));
    if (res.body.run.current && res.body.run.current.subject_key === subjectKey) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`never saw ${subjectKey} as current`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 10); });
  }
}

// QUEUE TEST ISOLATION (game audio slice 2 common.md): the whole body runs
// inside AUDIO_JOBS_LOCK_KEY, shared with audio_job_queue_db.test.js and
// audio_dispatcher_db.test.js -- node --test runs files in parallel and a
// drain claims ANY queued job, not only this file's own.
test('audio job routes', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  const tag = `jobsrt-${process.pid}-${Date.now()}`;
  const worldName = `audio-jobs-${tag}`;
  const worldName2 = `audio-jobs2-${tag}`;
  const ghostWorld = `audio-jobs-ghost-${tag}`;
  const made = { users: [], providers: [], worlds: [] };

  t.after(async () => {
    audioDispatcher.stopDrain();
    audioDispatcher.__resetRun();
    audioDispatcher.__setDeps(null);
    try {
      await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`audio-jobs%${tag}%`]);
      await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`foreign-sentinel-%${tag}`]);
      if (made.worlds.length) await pool.query('DELETE FROM worlds WHERE id = ANY($1)', [made.worlds]);
      if (made.providers.length) await pool.query('DELETE FROM ai_providers WHERE id = ANY($1)', [made.providers]);
      if (made.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users]);
    } finally { await pool.end(); }
  });

  const admin = await makeUser(pool, 'admin', tag); made.users.push(admin.id);
  const player = await makeUser(pool, 'player', tag); made.users.push(player.id);
  const w1 = (await pool.query('INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING id', [worldName])).rows[0].id;
  made.worlds.push(w1);
  const w2 = (await pool.query('INSERT INTO worlds (name, seed) VALUES ($1, 2) RETURNING id', [worldName2])).rows[0].id;
  made.worlds.push(w2);
  const providerId = (await pool.query(
    `INSERT INTO ai_providers (name, base_url, request_template, modality, auth_token)
     VALUES ($1, 'http://127.0.0.1:1', '{}'::jsonb, 'audio', 'sk_jobs_test') RETURNING id`,
    [`audio-jobs-provider-${tag}`],
  )).rows[0].id;
  made.providers.push(providerId);

  await withAdvisoryLock(pool, AUDIO_JOBS_LOCK_KEY, async () => {
    // Park any foreign queued rows (another file's leftovers) for the
    // duration -- a drain here claims ANY queued job, and this file must not
    // process work it does not own. Restored exactly as found, in `finally`.
    const foreign = (await pool.query(
      `SELECT id, not_before FROM audio_jobs
        WHERE state = 'queued' AND (not_before IS NULL OR not_before <= now())
          AND subject_key NOT LIKE $1`, [`audio-jobs%${tag}%`],
    )).rows;
    if (foreign.length) {
      await pool.query(
        `UPDATE audio_jobs SET not_before = now() + interval '1 hour' WHERE id = ANY($1)`,
        [foreign.map((r) => r.id)],
      );
    }

    // Stand-ins for ANOTHER file's rows: keyed outside this file's own
    // `audio-jobs%` pattern, a failed row and a done row. clear and
    // retry-failed below must leave both exactly as they are.
    const sentinelFailed = `foreign-sentinel-failed-${tag}`;
    const sentinelDone = `foreign-sentinel-done-${tag}`;
    await pool.query(
      `INSERT INTO audio_jobs (batch_id, subject_kind, subject_key, slot, clip_kind, drain_group, state, attempts, last_error)
       VALUES (gen_random_uuid(), 'world', $1, 'music', 'music', 'music', 'failed', 3, 'foreign failure'),
              (gen_random_uuid(), 'world', $2, 'music', 'music', 'music', 'done', 1, NULL)`,
      [sentinelFailed, sentinelDone],
    );
    const sentinels = async () => (await pool.query(
      'SELECT subject_key, state, attempts, last_error FROM audio_jobs WHERE subject_key IN ($1, $2) ORDER BY subject_key',
      [sentinelDone, sentinelFailed],
    )).rows;
    const sentinelsBefore = await sentinels();

    try {
      await t.test('every jobs route rejects a player (403) and anonymous (401)', async () => {
        const calls = [
          ['get', '/api/audio/admin/jobs'],
          ['post', '/api/audio/admin/jobs'],
          ['post', '/api/audio/admin/jobs/dispatch'],
          ['post', '/api/audio/admin/jobs/stop'],
          ['post', '/api/audio/admin/jobs/retry-failed'],
          ['post', '/api/audio/admin/jobs/clear'],
        ];
        for (const [method, path] of calls) {
          // eslint-disable-next-line no-await-in-loop
          const asPlayer = await request(app)[method](path).set('Authorization', bearer(player)).send({});
          assert.equal(asPlayer.status, 403, `${method} ${path} (player)`);
          // eslint-disable-next-line no-await-in-loop
          const anon = await request(app)[method](path).send({});
          assert.equal(anon.status, 401, `${method} ${path} (anon)`);
        }
      });

      await t.test('enqueue: one valid item queued, one unknown subject rejected', async () => {
        const res = await request(app).post('/api/audio/admin/jobs').set('Authorization', bearer(admin)).send({
          items: [
            { subject_kind: 'world', subject_key: worldName, slot: 'music' },
            { subject_kind: 'world', subject_key: ghostWorld, slot: 'music' },
          ],
        });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.queued.length, 1);
        assert.equal(res.body.rejected.length, 1);
        assert.equal(res.body.rejected[0].error, 'unknown subject');
        assert.equal(res.body.already_live.length, 0);
        assert.equal(res.body.started, undefined, 'start was not requested, so it is not reported');
      });

      await t.test('enqueue: the same item again is already_live, not queued twice', async () => {
        const res = await request(app).post('/api/audio/admin/jobs').set('Authorization', bearer(admin)).send({
          items: [{ subject_kind: 'world', subject_key: worldName, slot: 'music' }],
        });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.queued.length, 0);
        assert.equal(res.body.already_live.length, 1);
        assert.equal(res.body.rejected.length, 0);
      });

      // Game audio slice 3, Task 4: sfx slots are queued (the slice-2
      // "sfx batches arrive in slice 3" refusal is gone), an upload-only slot
      // (no cue on the box) is rejected, and the optional per-item engine
      // picks the drain group. attack_type is a fixed catalog (melee/ranged/
      // magic) needing no row of its own; the jobs made here are deleted by
      // id straight after.
      await t.test('enqueue: sfx slots queue by engine; an upload-only slot and a bad engine are rejected', async () => {
        const res = await request(app).post('/api/audio/admin/jobs').set('Authorization', bearer(admin)).send({
          items: [
            { subject_kind: 'attack_type', subject_key: 'melee', slot: 'use', engine: 'retro' },
            { subject_kind: 'attack_type', subject_key: 'magic', slot: 'hit' },
            { subject_kind: 'attack_type', subject_key: 'ranged', slot: 'use' },
            { subject_kind: 'attack_type', subject_key: 'ranged', slot: 'hit', engine: 'lofi' },
          ],
        });
        try {
          assert.equal(res.status, 201, JSON.stringify(res.body));
          const byKey = Object.fromEntries(res.body.queued.map((j) => [`${j.subject_key}/${j.slot}`, j]));
          // Strict: no other test file enqueues attack_type jobs, and this
          // body holds AUDIO_JOBS_LOCK_KEY.
          assert.deepEqual(Object.keys(byKey).sort(), ['magic/hit', 'melee/use'], JSON.stringify(res.body));
          assert.deepEqual(
            [byKey['melee/use'].clip_kind, byKey['melee/use'].drain_group, byKey['melee/use'].engine],
            ['sfx', 'sfx_retro', 'retro'],
          );
          assert.deepEqual(
            [byKey['magic/hit'].drain_group, byKey['magic/hit'].engine],
            ['sfx_realistic', 'realistic'], 'no engine -> realistic',
          );
          assert.deepEqual(res.body.rejected.map((r) => [r.item.subject_key, r.item.slot, r.error]), [
            ['ranged', 'use', 'upload only: no cue on the provider'],
            ['ranged', 'hit', "engine must be 'realistic' or 'retro'"],
          ]);
        } finally {
          const ids = (res.body.queued || []).map((j) => j.id);
          if (ids.length) await pool.query('DELETE FROM audio_jobs WHERE id = ANY($1)', [ids]);
        }
      });

      await t.test('a provider_id that does not resolve to an active audio provider is a 400', async () => {
        const res = await request(app).post('/api/audio/admin/jobs').set('Authorization', bearer(admin)).send({
          items: [{ subject_kind: 'world', subject_key: worldName, slot: 'ambience' }],
          provider_id: 999999999,
        });
        assert.equal(res.status, 400, JSON.stringify(res.body));
        const row = await pool.query(
          "SELECT 1 FROM audio_jobs WHERE subject_key = $1 AND slot = 'ambience'", [worldName],
        );
        assert.equal(row.rowCount, 0, 'a bad provider_id must not enqueue anything');
      });

      await t.test('start:true drains the queue and the job finishes done', async () => {
        audioDispatcher.__resetRun();
        audioDispatcher.__setDeps({ ...promptPhaseStub, generateForSlot: async () => ({ ok: true, clip: { id: null } }) });
        const res = await request(app).post('/api/audio/admin/jobs').set('Authorization', bearer(admin)).send({
          items: [{ subject_kind: 'world', subject_key: worldName, slot: 'ambience' }],
          provider_id: providerId,
          start: true,
        });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.started, true, JSON.stringify(res.body));
        const status = await waitIdle(admin);
        assert.equal(status.run.running, false);
        const row = (await pool.query(
          "SELECT state FROM audio_jobs WHERE subject_key = $1 AND slot = 'ambience'", [worldName],
        )).rows[0];
        assert.equal(row.state, 'done');
      });

      await t.test('clear refuses 409 while a drain is running, then clears once it finishes', async () => {
        audioDispatcher.__resetRun();
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        audioDispatcher.__setDeps({
          ...promptPhaseStub,
          generateForSlot: async (db, provider, spec) => {
            if (spec.subjectKey === worldName2 && spec.slot === 'music') await gate;
            return { ok: true, clip: { id: null } };
          },
        });
        const enq = await request(app).post('/api/audio/admin/jobs').set('Authorization', bearer(admin)).send({
          items: [
            { subject_kind: 'world', subject_key: worldName2, slot: 'music' },
            { subject_kind: 'world', subject_key: worldName2, slot: 'ambience' },
          ],
          provider_id: providerId,
          start: true,
        });
        assert.equal(enq.status, 201, JSON.stringify(enq.body));
        assert.equal(enq.body.started, true, JSON.stringify(enq.body));
        await waitForCurrent(admin, worldName2);

        const busy = await request(app).post('/api/audio/admin/jobs/clear').set('Authorization', bearer(admin)).send({ states: ['done'] });
        assert.equal(busy.status, 409, JSON.stringify(busy.body));

        release();
        await waitIdle(admin);
        const before = (await pool.query('SELECT 1 FROM audio_jobs WHERE subject_key = $1', [worldName2])).rowCount;
        assert.equal(before, 2, 'precondition: both jobs still on record before clearing');

        // Explicit states -- the {} default also clears 'queued', which would
        // delete other files' parked rows. clear is database-wide, so any
        // foreign 'done' rows it deletes are put back afterwards.
        const ownDone = (await pool.query(
          "SELECT 1 FROM audio_jobs WHERE state = 'done' AND subject_key LIKE $1", [`audio-jobs%${tag}%`])).rowCount;
        const { result: cleared, foreignTouched } = await restoringForeignJobs(pool, `audio-jobs%${tag}%`, ['done'], () => (
          request(app).post('/api/audio/admin/jobs/clear').set('Authorization', bearer(admin)).send({ states: ['done'] })));
        assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
        assert.equal(cleared.body.cleared - foreignTouched, ownDone, JSON.stringify(cleared.body));
        const after = (await pool.query('SELECT 1 FROM audio_jobs WHERE subject_key = $1', [worldName2])).rowCount;
        assert.equal(after, 0, 'both worldName2 rows were cleared');
        assert.deepEqual(await sentinels(), sentinelsBefore, "another file's rows were not cleared");
      });

      await t.test('retry-failed re-queues a failed row', async () => {
        const failKey = `audio-jobs-fail-${tag}`;
        await pool.query(
          `INSERT INTO audio_jobs (batch_id, subject_kind, subject_key, slot, clip_kind, drain_group, state, attempts, last_error)
           VALUES (gen_random_uuid(), 'world', $1, 'ambience', 'ambience', 'ambience', 'failed', 3, 'test failure')`,
          [failKey],
        );
        // retry-failed is database-wide; foreign failed rows it re-queues are
        // put back afterwards, and only this file's share is asserted on.
        const ownFailed = (await pool.query(
          "SELECT 1 FROM audio_jobs WHERE state = 'failed' AND subject_key LIKE $1", [`audio-jobs%${tag}%`])).rowCount;
        const { result: res, foreignTouched } = await restoringForeignJobs(pool, `audio-jobs%${tag}%`, ['failed'], () => (
          request(app).post('/api/audio/admin/jobs/retry-failed').set('Authorization', bearer(admin)).send({})));
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.requeued - foreignTouched, ownFailed, JSON.stringify(res.body));
        const row = (await pool.query('SELECT state, attempts FROM audio_jobs WHERE subject_key = $1', [failKey])).rows[0];
        assert.equal(row.state, 'queued');
        assert.equal(row.attempts, 0);
        assert.deepEqual(await sentinels(), sentinelsBefore, "another file's failed row was not re-queued");
        await pool.query('DELETE FROM audio_jobs WHERE subject_key = $1', [failKey]);
      });
      // Plan 2026-10-03: "Force regenerate prompt" and "Write with model"
      // ride on the item. Both are strict booleans -- a truthy string must
      // not quietly force a rewrite over someone's hand-written prompt.
      await t.test('enqueue: force_prompt and prompt_only are stored when boolean and rejected otherwise', async () => {
        const w3 = `audio-jobs3-${tag}`;
        made.worlds.push((await pool.query('INSERT INTO worlds (name, seed) VALUES ($1, 3) RETURNING id', [w3])).rows[0].id);
        const res = await request(app).post('/api/audio/admin/jobs').set('Authorization', bearer(admin)).send({
          items: [
            { subject_kind: 'world', subject_key: w3, slot: 'music', force_prompt: true, prompt_only: true },
            { subject_kind: 'world', subject_key: w3, slot: 'ambience', force_prompt: false },
            { subject_kind: 'world', subject_key: worldName, slot: 'music', force_prompt: 'yes' },
            { subject_kind: 'world', subject_key: worldName2, slot: 'music', prompt_only: 1 },
          ],
        });
        try {
          assert.equal(res.status, 201, JSON.stringify(res.body));
          const by = Object.fromEntries(res.body.queued.map((j) => [`${j.subject_key}/${j.slot}`,
            [j.force_prompt, j.prompt_only, j.needs_prompt]]));
          assert.deepEqual(by, {
            [`${w3}/music`]: [true, true, true],
            [`${w3}/ambience`]: [false, false, true],
          });
          assert.deepEqual(res.body.rejected.map((r) => [r.item.subject_key, r.error]), [
            [worldName, 'force_prompt must be a boolean'],
            [worldName2, 'prompt_only must be a boolean'],
          ]);
        } finally {
          const ids = (res.body.queued || []).map((j) => j.id);
          if (ids.length) await pool.query('DELETE FROM audio_jobs WHERE id = ANY($1)', [ids]);
        }
      });
      // The slot card's Generate and Write with model go through the queue,
      // so an item carries what their synchronous calls sent: sfx variants,
      // music/ambience slots, the writer's hint, and a seed. Each is checked
      // per item; a bad one rejects only that item.
      await t.test('enqueue: variants, slots, hint and seed are validated per item and stored', async () => {
        const w4 = `audio-jobs4-${tag}`;
        made.worlds.push((await pool.query('INSERT INTO worlds (name, seed) VALUES ($1, 4) RETURNING id', [w4])).rows[0].id);
        const long = 'x'.repeat(300);
        const res = await request(app).post('/api/audio/admin/jobs').set('Authorization', bearer(admin)).send({
          items: [
            { subject_kind: 'attack_type', subject_key: 'magic', slot: 'hit', variants: 5, hint: '  a crackling bolt  ' },
            { subject_kind: 'attack_type', subject_key: 'melee', slot: 'use', variants: 6 },
            { subject_kind: 'attack_type', subject_key: 'melee', slot: 'hit', variants: 2.5 },
            { subject_kind: 'attack_type', subject_key: 'ranged', slot: 'hit', slots: { mood: 'calm' } },
            { subject_kind: 'world', subject_key: w4, slot: 'music', slots: { mood: 'calm' }, hint: '', seed: 42 },
            { subject_kind: 'world', subject_key: w4, slot: 'ambience', hint: long },
            { subject_kind: 'world', subject_key: worldName, slot: 'music', variants: 3 },
            { subject_kind: 'world', subject_key: worldName2, slot: 'music', slots: ['calm'] },
            { subject_kind: 'world', subject_key: worldName2, slot: 'ambience', hint: 7 },
            { subject_kind: 'world', subject_key: worldName, slot: 'ambience', seed: 'x' },
          ],
        });
        try {
          assert.equal(res.status, 201, JSON.stringify(res.body));
          const by = Object.fromEntries(res.body.queued.map((j) => [`${j.subject_key}/${j.slot}`,
            [j.variants, j.slots, j.hint, j.seed == null ? null : Number(j.seed)]]));
          assert.deepEqual(by, {
            'magic/hit': [5, null, 'a crackling bolt', null],
            [`${w4}/music`]: [null, { mood: 'calm' }, null, 42],
            [`${w4}/ambience`]: [null, null, 'x'.repeat(200), null],
          });
          assert.deepEqual(res.body.rejected.map((r) => [r.item.subject_key, r.item.slot, r.error]), [
            ['melee', 'use', 'variants must be an integer 1-5'],
            ['melee', 'hit', 'variants must be an integer 1-5'],
            ['ranged', 'hit', 'slots are for music and ambience only'],
            [worldName, 'music', 'variants are for sfx only'],
            [worldName2, 'music', 'slots must be an object'],
            [worldName2, 'ambience', 'hint must be a string'],
            [worldName, 'ambience', 'seed must be an integer'],
          ]);
        } finally {
          const ids = (res.body.queued || []).map((j) => j.id);
          if (ids.length) await pool.query('DELETE FROM audio_jobs WHERE id = ANY($1)', [ids]);
        }
      });
    } finally {
      for (const r of foreign) {
        // eslint-disable-next-line no-await-in-loop
        await pool.query('UPDATE audio_jobs SET not_before = $2 WHERE id = $1', [r.id, r.not_before]);
      }
    }
  });
});
